function blobABase64(blob) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onloadend = () => resolve(lector.result.split(',')[1]);
    lector.onerror = reject;
    lector.readAsDataURL(blob);
  });
}

/* Evita abrir dos diálogos de guardado a la vez */
let guardandoArchivo = false;

async function descargarArchivo(nombre, urlOBlob) {
  if (guardandoArchivo) return;
  guardandoArchivo = true;
  try {
    if (window.pywebview && window.pywebview.api) {
      const base64 = typeof urlOBlob === 'string' ? urlOBlob.split(',')[1] : await blobABase64(urlOBlob);
      const resultado = await window.pywebview.api.guardar_archivo(nombre, base64);
      if (resultado && !resultado.ok && resultado.motivo !== 'cancelado') {
        alert('No se pudo guardar el archivo: ' + resultado.motivo);
      }
    } else {
      const url = typeof urlOBlob === 'string' ? urlOBlob : URL.createObjectURL(urlOBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = nombre;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } finally {
    guardandoArchivo = false;
  }
}

/* ---------- Esperar a que la app termine de arrancar ---------- */
/* Los controles se habilitan recién cuando:
   1) la ventana nativa de pywebview terminó de asentarse, y
   2) los codificadores WASM (JPG/WebP) terminaron de cargar. */
let codecsListos = false;

function habilitarControles() {
  document.querySelectorAll('input[type="file"]').forEach(i => { i.disabled = false; });
  document.querySelectorAll('.boton-archivo').forEach(l => l.classList.remove('deshabilitado'));
}

document.querySelectorAll('.boton-archivo').forEach(l => l.classList.add('deshabilitado'));

function esperarEntorno() {
  return new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) {
      // la API de Python ya está lista (el evento pudo haber pasado antes de cargar este script)
      setTimeout(resolve, 600);
    } else if (window.pywebview) {
      // corriendo dentro de la app de escritorio: esperar la señal de pywebview
      // más un margen extra para que la ventana nativa termine de asentarse
      window.addEventListener('pywebviewready', () => setTimeout(resolve, 600), { once: true });
    } else {
      // navegador normal (pruebas): no hace falta esperar nada
      resolve();
    }
  });
}

function cargarCodecs() {
  const carga = window.CodecsM
    ? window.CodecsM.precargar()
    : Promise.reject(new Error('No se cargó js/vendor/codecs.js'));
  const limite = new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('Tiempo agotado cargando los codificadores')), 20000));
  return Promise.race([carga, limite])
    .then(() => { codecsListos = true; })
    .catch((error) => { console.error('No se pudieron cargar los codificadores JPG/WebP:', error); });
}

Promise.all([esperarEntorno(), cargarCodecs()]).then(habilitarControles);

/* ---------- Utilidades comunes ---------- */
const lienzoVideo = document.querySelector('#lienzo_video');
const ctxVideo = lienzoVideo.getContext('2d');

function cargarImagen(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------- Conversión de una imagen (cada llamada usa su PROPIO canvas) ---------- */
async function convertirImagen(archivo, formato, op) {
  const url = URL.createObjectURL(archivo);
  try {
    const imagen = await cargarImagen(url);
    const ancho = imagen.naturalWidth || imagen.width;
    const alto = imagen.naturalHeight || imagen.height;

    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });

    if (formato === 'jpg') {
      // JPG no tiene transparencia: fondo blanco para que no quede negro
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, ancho, alto);
    }
    ctx.drawImage(imagen, 0, 0);
    const pixeles = ctx.getImageData(0, 0, ancho, alto);

    if (formato === 'png') {
      return codificarPNG(pixeles, { nivel: op.nivel, filtro: op.filtro, entrelazado: op.entrelazado });
    }

    if (!codecsListos) {
      throw new Error('Los codificadores JPG/WebP no se cargaron (revisá la carpeta js/vendor)');
    }

    if (formato === 'jpg') {
      const datos = await window.CodecsM.jpeg(pixeles, {
        quality: op.quality,
        baseline: false,
        progressive: op.progressive,
        optimize_coding: op.optimize,
        auto_subsample: false,
        chroma_subsample: op.subsampling === '444' ? 1 : 2,
        quant_table: 0
      });
      return new Blob([datos], { type: 'image/jpeg' });
    }

    // webp
    const opcionesWebp = op.lossless
      ? { lossless: 1, exact: 1, quality: op.quality, method: op.method }
      : {
          lossless: 0, quality: op.quality, method: op.method,
          alpha_quality: op.alpha_quality, pass: op.pass, sns_strength: op.sns_strength
        };
    const datos = await window.CodecsM.webp(pixeles, opcionesWebp);
    return new Blob([datos], { type: 'image/webp' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Lee todos los campos [data-opcion] de una tarjeta: números (acotados a min/max), casillas y listas */
function leerOpciones(tarjeta) {
  const op = {};
  tarjeta.querySelectorAll('[data-opcion]').forEach((campo) => {
    const nombre = campo.dataset.opcion;
    if (campo.type === 'checkbox') {
      op[nombre] = campo.checked;
    } else if (campo.type === 'number') {
      const min = Number(campo.min), max = Number(campo.max);
      let valor = parseInt(campo.value, 10);
      if (!Number.isFinite(valor)) valor = Number(campo.defaultValue);
      valor = Math.max(min, Math.min(max, valor));
      campo.value = valor;
      op[nombre] = valor;
    } else {
      op[nombre] = campo.value;
    }
  });
  return op;
}

function nombreUnico(nombre, usados) {
  if (!usados.has(nombre)) { usados.add(nombre); return nombre; }
  const punto = nombre.lastIndexOf('.');
  const base = nombre.slice(0, punto);
  const ext = nombre.slice(punto);
  let n = 2;
  while (usados.has(`${base} (${n})${ext}`)) n++;
  const final = `${base} (${n})${ext}`;
  usados.add(final);
  return final;
}

/* ---------- Tarjetas de conversión (JPG / PNG / WebP) ---------- */
function iniciarConversor(tarjeta) {
  const formato = tarjeta.dataset.conversor; // 'jpg' | 'png' | 'webp'
  const input = tarjeta.querySelector('input[type="file"]');
  const contador = tarjeta.querySelector('.contador');
  const campos = Array.from(tarjeta.querySelectorAll('[data-opcion]'));
  const btn = tarjeta.querySelector('.btn-convertir');
  const estado = tarjeta.querySelector('.estado');
  const casillaLossless = tarjeta.querySelector('[data-opcion="lossless"]');

  let archivos = [];
  let ocupado = false;

  // en WebP sin pérdida, alpha_quality / pass / sns_strength no se usan
  function actualizarDependencias() {
    if (!casillaLossless) return;
    tarjeta.querySelectorAll('[data-solo-lossy]').forEach((campo) => {
      campo.disabled = casillaLossless.checked;
      campo.closest('.opcion').classList.toggle('inactiva', casillaLossless.checked);
    });
  }

  function bloquearCampos(bloquear) {
    campos.forEach((campo) => { campo.disabled = bloquear; });
    if (!bloquear) actualizarDependencias();
  }

  if (casillaLossless) casillaLossless.addEventListener('change', actualizarDependencias);
  actualizarDependencias();

  input.addEventListener('change', () => {
    if (ocupado) return;
    archivos = Array.from(input.files);
    contador.textContent = `Imágenes seleccionadas: ${archivos.length}`;
    btn.disabled = archivos.length === 0;
    estado.textContent = '';
  });

  btn.addEventListener('click', async () => {
    if (ocupado || archivos.length === 0) return;
    ocupado = true;

    // las opciones se leen ACÁ, así siempre se usan los valores actuales
    const opciones = leerOpciones(tarjeta);
    btn.disabled = true;
    input.disabled = true;
    bloquearCampos(true);

    try {
      const zip = new JSZip();
      const usados = new Set();
      const fallidos = [];
      let convertidas = 0;

      for (let i = 0; i < archivos.length; i++) {
        const archivo = archivos[i];
        estado.textContent = `Convirtiendo ${i + 1} de ${archivos.length}...`;
        try {
          const blob = await convertirImagen(archivo, formato, opciones);
          const nuevoNombre = archivo.name.replace(/\.[^.]+$/, '') + '.' + formato;
          zip.file(nombreUnico(nuevoNombre, usados), blob);
          convertidas++;
        } catch (error) {
          console.error('Error procesando:', archivo.name, error);
          fallidos.push(archivo.name);
        }
        // deja respirar a la interfaz entre imagen e imagen
        await new Promise(r => setTimeout(r, 0));
      }

      if (convertidas > 0) {
        estado.textContent = 'Armando el .zip...';
        const contenidoZip = await zip.generateAsync({ type: 'blob' });
        await descargarArchivo(`imagenes_${formato}.zip`, contenidoZip);
      }

      if (fallidos.length > 0) {
        estado.textContent = `Terminado, pero no se pudieron convertir: ${fallidos.join(', ')}`;
      } else {
        estado.textContent = 'Listo.';
      }
    } catch (error) {
      console.error('Error en la conversión:', error);
      estado.textContent = 'Ocurrió un error durante la conversión.';
    } finally {
      ocupado = false;
      input.disabled = false;
      bloquearCampos(false);
      btn.disabled = archivos.length === 0;
    }
  });
}

document.querySelectorAll('[data-conversor]').forEach(iniciarConversor);

/* ---------- Video → GIF ---------- */
const inputVideo = document.querySelector('#input_video');
const zonaVideo = document.querySelector('#zona_video');
const video = document.querySelector('#video_preview');
const marco = document.querySelector('#marco_video');
const recorte = document.querySelector('#recorte');
const asa = document.querySelector('#asa');
const inputInicio = document.querySelector('#input_inicio');
const inputFin = document.querySelector('#input_fin');
const btnGenerarGif = document.querySelector('#btn_generar_gif');
const estadoGif = document.querySelector('#estado_gif');
const resultadoGif = document.querySelector('#resultado_gif');
const overlayGenerando = document.querySelector('#overlay_generando');

inputVideo.addEventListener('change', (evento) => {
  const archivo = evento.target.files[0];
  if (!archivo) return;
  video.src = URL.createObjectURL(archivo);
  zonaVideo.hidden = false;
  resultadoGif.innerHTML = '';
  estadoGif.textContent = '';
});

function ajustarTamanoMarco() {
  const anchoDisponible = zonaVideo.parentElement.clientWidth || window.innerWidth * 0.9;
  const limite = Math.min(window.innerWidth * 0.9, anchoDisponible);
  // nunca más grande que el video real, nunca más grande que el 90% de la pantalla
  const anchoFinal = Math.min(video.videoWidth, limite);
  marco.style.width = anchoFinal + 'px';
}

video.addEventListener('loadedmetadata', () => {
  inputInicio.value = 0;
  inputInicio.max = video.duration;
  inputFin.value = Math.min(3, video.duration).toFixed(1);
  inputFin.max = video.duration;
  ajustarTamanoMarco();
  recorte.style.left = '10%';
  recorte.style.top = '10%';
  recorte.style.width = '80%';
  recorte.style.height = '80%';
});

window.addEventListener('resize', () => { if (video.videoWidth) ajustarTamanoMarco(); });

/* ---------- Controles propios del video ---------- */
const btnRetroceder = document.querySelector('#btn_retroceder');
const btnReproducir = document.querySelector('#btn_reproducir');
const btnAdelantar = document.querySelector('#btn_adelantar');
const tiempoVideo = document.querySelector('#tiempo_video');

function formatoTiempo(segundos) {
  if (!isFinite(segundos)) return '0:00';
  const m = Math.floor(segundos / 60);
  const s = Math.floor(segundos % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

btnRetroceder.addEventListener('click', () => {
  video.currentTime = Math.max(0, video.currentTime - 5);
});

btnAdelantar.addEventListener('click', () => {
  video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
});

btnReproducir.addEventListener('click', () => {
  if (video.paused) video.play(); else video.pause();
});

video.addEventListener('play', () => { btnReproducir.textContent = '⏸️'; });
video.addEventListener('pause', () => { btnReproducir.textContent = '▶️'; });
video.addEventListener('timeupdate', () => {
  tiempoVideo.textContent = `${formatoTiempo(video.currentTime)} / ${formatoTiempo(video.duration)}`;
});

/* ---------- Arrastrar y redimensionar el recuadro de selección ---------- */
let arrastrando = null;
recorte.addEventListener('mousedown', (e) => {
  if (e.target === asa) return;
  arrastrando = { x: e.clientX, y: e.clientY, left: recorte.offsetLeft, top: recorte.offsetTop };
  e.preventDefault();
});

/* Arrastrar la "asa" para redimensionar */
let redimensionando = null;
asa.addEventListener('mousedown', (e) => {
  redimensionando = { x: e.clientX, y: e.clientY, w: recorte.offsetWidth, h: recorte.offsetHeight };
  e.stopPropagation();
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  const marcoRect = marco.getBoundingClientRect();
  if (arrastrando) {
    let nuevoLeft = arrastrando.left + (e.clientX - arrastrando.x);
    let nuevoTop = arrastrando.top + (e.clientY - arrastrando.y);
    nuevoLeft = Math.max(0, Math.min(nuevoLeft, marcoRect.width - recorte.offsetWidth));
    nuevoTop = Math.max(0, Math.min(nuevoTop, marcoRect.height - recorte.offsetHeight));
    recorte.style.left = nuevoLeft + 'px';
    recorte.style.top = nuevoTop + 'px';
  }
  if (redimensionando) {
    let nuevoAncho = redimensionando.w + (e.clientX - redimensionando.x);
    let nuevoAlto = redimensionando.h + (e.clientY - redimensionando.y);
    nuevoAncho = Math.max(30, Math.min(nuevoAncho, marcoRect.width - recorte.offsetLeft));
    nuevoAlto = Math.max(30, Math.min(nuevoAlto, marcoRect.height - recorte.offsetTop));
    recorte.style.width = nuevoAncho + 'px';
    recorte.style.height = nuevoAlto + 'px';
  }
});

document.addEventListener('mouseup', () => { arrastrando = null; redimensionando = null; });

function seekTo(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.01) { resolve(); return; }
    let resuelto = false;
    const terminar = () => {
      if (resuelto) return;
      resuelto = true;
      video.removeEventListener('seeked', terminar);
      resolve();
    };
    video.addEventListener('seeked', terminar);
    video.currentTime = t;
    // por si el navegador no llega a disparar 'seeked'
    setTimeout(terminar, 800);
  });
}

btnGenerarGif.addEventListener('click', async () => {
  const inicio = parseFloat(inputInicio.value) || 0;
  const fin = parseFloat(inputFin.value) || 0;
  if (fin <= inicio) { estadoGif.textContent = 'El fin debe ser mayor que el inicio.'; return; }

  // bloquear todo lo que pueda cambiar el video mientras se generan los fotogramas
  btnGenerarGif.disabled = true;
  inputVideo.disabled = true;
  resultadoGif.innerHTML = '';
  estadoGif.textContent = 'Preparando fotogramas...';

  const tiempoOriginal = video.currentTime;
  const estabaPausado = video.paused;
  video.pause();
  overlayGenerando.style.display = 'flex';

  const marcoRect = marco.getBoundingClientRect();
  const escalaX = video.videoWidth / marcoRect.width;
  const escalaY = video.videoHeight / marcoRect.height;
  const sx = recorte.offsetLeft * escalaX;
  const sy = recorte.offsetTop * escalaY;
  const sw = recorte.offsetWidth * escalaX;
  const sh = recorte.offsetHeight * escalaY;

  const anchoSalida = Math.min(480, sw);
  const altoSalida = sh * (anchoSalida / sw);
  lienzoVideo.width = anchoSalida;
  lienzoVideo.height = altoSalida;

  const fps = 10;
  const gif = new GIF({
    workers: 2,
    quality: 10,
    width: anchoSalida,
    height: altoSalida,
    workerScript: 'js/gif.worker.js'
  });

  // deja la interfaz utilizable de nuevo, pase lo que pase
  const restaurarInterfaz = () => {
    overlayGenerando.style.display = 'none';
    video.currentTime = tiempoOriginal;
    if (!estabaPausado) video.play();
    btnGenerarGif.disabled = false;
    inputVideo.disabled = false;
  };

  try {
    for (let t = inicio; t <= fin; t += 1 / fps) {
      await seekTo(t);
      ctxVideo.drawImage(video, sx, sy, sw, sh, 0, 0, anchoSalida, altoSalida);
      gif.addFrame(ctxVideo, { copy: true, delay: 1000 / fps });
    }
  } catch (error) {
    console.error('Error capturando fotogramas:', error);
    estadoGif.textContent = 'Error al capturar los fotogramas.';
    restaurarInterfaz();
    return;
  }

  estadoGif.textContent = 'Generando GIF...';
  gif.on('progress', (p) => { estadoGif.textContent = `Generando GIF... ${Math.round(p * 100)}%`; });
  gif.on('finished', (blob) => {
    const url = URL.createObjectURL(blob);
    restaurarInterfaz();

    resultadoGif.innerHTML = `<img src="${url}">`;
    const botonDescargarGif = document.createElement('button');
    botonDescargarGif.type = 'button';
    botonDescargarGif.textContent = 'Descargar GIF';
    botonDescargarGif.addEventListener('click', () => descargarArchivo('animacion.gif', blob));
    resultadoGif.appendChild(botonDescargarGif);

    estadoGif.textContent = 'Listo.';
  });
  gif.render();
});

/* =====================================================================
   Tarjeta de análisis (la lógica de lectura está en js/analisis.js)
   ===================================================================== */
async function analizarArchivo(archivo) {
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const r = Analisis.analizarBytes(bytes);
  let { ancho, alto } = r;

  // si la cabecera no dio las dimensiones, se las pedimos al navegador
  if (!ancho || !alto) {
    const url = URL.createObjectURL(archivo);
    try {
      const img = await cargarImagen(url);
      ancho = img.naturalWidth;
      alto = img.naturalHeight;
    } catch (error) {
      console.error('No se pudieron leer las dimensiones:', error);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const filas = [
    ['Archivo', archivo.name],
    ['Formato detectado', r.formato],
    ['Tamaño del archivo', Analisis.formatoBytes(bytes.length)]
  ];
  if (ancho && alto) filas.push(['Dimensiones', `${ancho} × ${alto} px`]);
  filas.push(['Tipo de compresión', r.tipo], ...r.filas);

  if (ancho && alto && r.formatoId !== 'ico') {
    const pixeles = ancho * alto;
    filas.push(
      ['Bits por píxel (archivo)', (bytes.length * 8 / pixeles).toFixed(2)],
      ['Relación vs. sin comprimir (RGB 24 bits)', `${(pixeles * 3 / bytes.length).toFixed(1)} : 1`]
    );
  }
  return filas;
}

function mostrarAnalisis(lista, filas) {
  lista.replaceChildren();
  filas.forEach(([clave, valor]) => {
    const dt = document.createElement('dt');
    dt.textContent = clave;
    const dd = document.createElement('dd');
    dd.textContent = valor;
    lista.append(dt, dd);
  });
}

const inputAnalisis = document.querySelector('#input_analisis');
const estadoAnalisis = document.querySelector('#estado_analisis');
const resultadoAnalisis = document.querySelector('#resultado_analisis');

inputAnalisis.addEventListener('change', async () => {
  const archivo = inputAnalisis.files[0];
  if (!archivo) return;
  inputAnalisis.disabled = true;
  resultadoAnalisis.replaceChildren();
  estadoAnalisis.textContent = 'Analizando...';
  try {
    mostrarAnalisis(resultadoAnalisis, await analizarArchivo(archivo));
    estadoAnalisis.textContent = '';
  } catch (error) {
    console.error('Error analizando:', error);
    estadoAnalisis.textContent = 'No se pudo analizar: formato no reconocido o archivo dañado.';
  } finally {
    inputAnalisis.value = '';
    inputAnalisis.disabled = false;
  }
});
