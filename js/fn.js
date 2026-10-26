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
          fallidos.push(`${archivo.name} (${error && error.message ? error.message : error})`);
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

const btnRetroceder = document.querySelector('#btn_retroceder');
const btnReproducir = document.querySelector('#btn_reproducir');
const btnInicio = document.querySelector('#btn_inicio');
const btnAdelantar = document.querySelector('#btn_adelantar');
const tiempoVideo = document.querySelector('#tiempo_video');
const inputSalto = document.querySelector('#input_salto');
const inputVelocidad = document.querySelector('#input_velocidad');
const inputAncho = document.querySelector('#input_ancho');
const inputAlto = document.querySelector('#input_alto');
const inputFps = document.querySelector('#input_fps');

/* true mientras se capturan los fotogramas: nada puede tocar el video */
let generandoGif = false;
/* true mientras se mide la cantidad de fotogramas por segundo del video */
let detectandoFps = false;
let urlVideoActual = null;

const limitar = (valor, min, max) => Math.max(min, Math.min(max, valor));

function leerNumero(input, porDefecto) {
  const v = parseFloat(input.value);
  return Number.isFinite(v) ? v : porDefecto;
}

inputVideo.addEventListener('change', (evento) => {
  const archivo = evento.target.files[0];
  if (!archivo) return;
  if (urlVideoActual) URL.revokeObjectURL(urlVideoActual);
  urlVideoActual = URL.createObjectURL(archivo);
  video.src = urlVideoActual;
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

/* ---------- Tamaño del GIF (paso 3) ---------- */
/* Por defecto = tamaño real del video × fracción (0–1) que ocupa el recuadro celeste.
   Se recalcula cuando cambia el tamaño del recuadro; mover el recuadro no lo altera. */
function actualizarMedidasDesdeRecuadro() {
  if (!video.videoWidth || !video.videoHeight) return;
  const marcoRect = marco.getBoundingClientRect();
  if (!marcoRect.width || !marcoRect.height) return;
  const fraccionAncho = recorte.offsetWidth / marcoRect.width;
  const fraccionAlto = recorte.offsetHeight / marcoRect.height;
  inputAncho.value = Math.max(1, Math.round(video.videoWidth * fraccionAncho));
  inputAlto.value = Math.max(1, Math.round(video.videoHeight * fraccionAlto));
}

function normalizarMedida(input) {
  const v = Math.round(leerNumero(input, 0));
  if (v >= 1) input.value = v; else actualizarMedidasDesdeRecuadro();
}

inputAncho.addEventListener('change', () => normalizarMedida(inputAncho));
inputAlto.addEventListener('change', () => normalizarMedida(inputAlto));

/* ---------- Fotogramas por segundo (fps) del video ---------- */
/* El navegador no dice los fps del video: se miden reproduciéndolo un instante, en silencio,
   y mirando el tiempo exacto de cada fotograma que se dibuja. */
function medirFps() {
  return new Promise((resolve) => {
    if (!video.requestVideoFrameCallback) { resolve(null); return; }
    const tiempos = [];
    const silenciadoAntes = video.muted;
    let terminado = false;

    const terminar = () => {
      if (terminado) return;
      terminado = true;
      clearTimeout(limite);
      video.pause();
      video.muted = silenciadoAntes;
      const diferencias = [];
      for (let i = 1; i < tiempos.length; i++) {
        const d = tiempos[i] - tiempos[i - 1];
        if (d > 0.0005) diferencias.push(d);
      }
      if (diferencias.length < 3) { resolve(null); return; }
      diferencias.sort((a, b) => a - b);
      // los tiempos vienen redondeados al milisegundo: se estima la duración de un fotograma
      // (mediana) y se cuentan cuántos caben en todo el tramo medido, lo que promedia el error
      const duracionFotograma = diferencias[Math.floor(diferencias.length / 2)];
      const tramo = tiempos[tiempos.length - 1] - tiempos[0];
      const cuenta = Math.max(1, Math.round(tramo / duracionFotograma));
      resolve(cuenta / tramo);
    };

    const alFotograma = (_ahora, meta) => {
      if (terminado) return;
      tiempos.push(meta.mediaTime);
      if (tiempos.length >= 20) terminar(); else video.requestVideoFrameCallback(alFotograma);
    };

    const limite = setTimeout(terminar, 2500);
    video.muted = true;
    video.playbackRate = 1;
    video.requestVideoFrameCallback(alFotograma);
    video.play().catch(terminar);
  });
}

async function detectarFpsDelVideo() {
  detectandoFps = true;
  bloquearEdicion(true);
  estadoGif.textContent = 'Leyendo los fotogramas por segundo del video...';
  try {
    const fps = await medirFps();
    // si queda a menos de 0,5 % de un entero (30,04 -> 30) se usa el entero
    const entero = fps ? Math.round(fps) : 0;
    inputFps.value = !fps ? 30 : (Math.abs(fps - entero) / entero < 0.005 ? entero : Math.round(fps * 100) / 100);
  } catch (error) {
    console.error('No se pudieron medir los fps:', error);
    inputFps.value = 30;
  } finally {
    video.currentTime = 0;
    aplicarVelocidad();
    detectandoFps = false;
    bloquearEdicion(false);
    estadoGif.textContent = '';
  }
}

inputFps.addEventListener('change', () => {
  const v = leerNumero(inputFps, 30);
  inputFps.value = v >= 1 ? v : 30;
});

/* ---------- Tramo (desde X hasta Y) ---------- */
let rango = { inicio: 0, fin: 0, valido: false };

function refrescarRango() {
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) {
    rango = { inicio: 0, fin: 0, valido: false };
    return rango;
  }
  const inicio = limitar(leerNumero(inputInicio, 0), 0, dur);
  const fin = limitar(leerNumero(inputFin, dur), 0, dur);
  rango = { inicio, fin, valido: fin > inicio };
  return rango;
}

/* Límites que se usan para reproducir: el tramo elegido o, si no es válido, el video entero */
function limitesReproduccion() {
  return rango.valido ? [rango.inicio, rango.fin] : [0, video.duration || 0];
}

function llevarAlTramo() {
  const [ini, fin] = limitesReproduccion();
  if (video.currentTime < ini || video.currentTime > fin) video.currentTime = ini;
}

function alCambiarRango() {
  refrescarRango();
  llevarAlTramo();
}

inputInicio.addEventListener('input', alCambiarRango);
inputFin.addEventListener('input', alCambiarRango);

function normalizarRango() {
  const r = refrescarRango();
  if (!isFinite(video.duration)) return;
  inputInicio.value = r.inicio;
  inputFin.value = r.fin;
  estadoGif.textContent = r.valido ? '' : 'El fin debe ser mayor que el inicio (mientras tanto se reproduce el video completo).';
  llevarAlTramo();
}

inputInicio.addEventListener('change', normalizarRango);
inputFin.addEventListener('change', normalizarRango);

/* ---------- Velocidad de reproducción (100 = normal) ---------- */
function leerPorcentaje() {
  return limitar(leerNumero(inputVelocidad, 100), 10, 1000);
}

function aplicarVelocidad() {
  const factor = leerPorcentaje() / 100;
  video.defaultPlaybackRate = factor;
  video.playbackRate = factor;
}

inputVelocidad.addEventListener('input', aplicarVelocidad);
inputVelocidad.addEventListener('change', () => {
  inputVelocidad.value = leerPorcentaje();
  aplicarVelocidad();
});

/* ---------- Salto de los botones de adelantar / retroceder ---------- */
function leerSalto() {
  return Math.max(0.001, leerNumero(inputSalto, 5));
}

function actualizarEtiquetasSalto() {
  const texto = `${Number(leerSalto().toFixed(3))}s`;
  btnRetroceder.textContent = `⏪ ${texto}`;
  btnAdelantar.textContent = `${texto} ⏩`;
  btnRetroceder.title = `Retroceder ${texto}`;
  btnAdelantar.title = `Adelantar ${texto}`;
}

inputSalto.addEventListener('input', actualizarEtiquetasSalto);
inputSalto.addEventListener('change', () => {
  inputSalto.value = Number(leerSalto().toFixed(3));
  actualizarEtiquetasSalto();
});

/* ---------- Tiempo con milisegundos ---------- */
function formatoTiempo(segundos) {
  return isFinite(segundos) ? segundos.toFixed(3) : '0.000';
}

function actualizarTiempo() {
  tiempoVideo.textContent = `${formatoTiempo(video.currentTime)} / ${formatoTiempo(video.duration)} seg`;
}

/* ---------- Metadatos: valores iniciales (desde 0 hasta la duración) ---------- */
video.addEventListener('loadedmetadata', () => {
  const dur = video.duration;
  inputInicio.min = 0;
  inputInicio.max = dur;
  inputInicio.value = 0;
  inputFin.min = 0;
  inputFin.max = dur;
  inputFin.value = (Math.floor(dur * 1000) / 1000).toFixed(3);
  refrescarRango();
  aplicarVelocidad();
  actualizarEtiquetasSalto();
  actualizarTiempo();
  ajustarTamanoMarco();
  recorte.style.left = '10%';
  recorte.style.top = '10%';
  recorte.style.width = '80%';
  recorte.style.height = '80%';
  actualizarMedidasDesdeRecuadro();
  detectarFpsDelVideo();
});

window.addEventListener('resize', () => {
  if (!video.videoWidth) return;
  ajustarTamanoMarco();
  actualizarMedidasDesdeRecuadro();
});

/* ---------- Reproducción dentro del tramo ---------- */
let idBucle = null;

function bucle() {
  idBucle = null;
  if (!video.paused && !generandoGif && !detectandoFps) {
    const [ini, fin] = limitesReproduccion();
    // al llegar al final del tramo vuelve al inicio (repite)
    if (video.currentTime >= fin) video.currentTime = ini;
  }
  actualizarTiempo();
  if (!video.paused) idBucle = requestAnimationFrame(bucle);
}

function arrancarBucle() {
  if (idBucle === null) idBucle = requestAnimationFrame(bucle);
}

video.addEventListener('play', () => { btnReproducir.textContent = '⏸️'; arrancarBucle(); });
video.addEventListener('pause', () => {
  btnReproducir.textContent = '▶️';
  if (idBucle !== null) { cancelAnimationFrame(idBucle); idBucle = null; }
  actualizarTiempo();
});
video.addEventListener('timeupdate', actualizarTiempo);
video.addEventListener('seeked', actualizarTiempo);

/* si el tramo llega hasta el final del video, 'ended' también repite */
video.addEventListener('ended', () => {
  if (generandoGif || detectandoFps) return;
  const [ini] = limitesReproduccion();
  video.currentTime = ini;
  video.play().catch(() => {});
});

/* ---------- Controles propios del video ---------- */
btnRetroceder.addEventListener('click', () => {
  const [ini, fin] = limitesReproduccion();
  video.currentTime = limitar(video.currentTime - leerSalto(), ini, fin);
});

btnAdelantar.addEventListener('click', () => {
  const [ini, fin] = limitesReproduccion();
  video.currentTime = limitar(video.currentTime + leerSalto(), ini, fin);
});

btnInicio.addEventListener('click', () => {
  const [ini] = limitesReproduccion();
  video.currentTime = ini;
});

btnReproducir.addEventListener('click', () => {
  if (!video.paused) { video.pause(); return; }
  const [ini, fin] = limitesReproduccion();
  if (video.currentTime < ini || video.currentTime >= fin - 0.001) video.currentTime = ini;
  video.play().catch(() => {});
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
    actualizarMedidasDesdeRecuadro();
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

/* ---------- Generar el GIF ---------- */
const controlesEdicion = [
  btnRetroceder, btnReproducir, btnInicio, btnAdelantar,
  inputSalto, inputVelocidad, inputInicio, inputFin, inputAncho, inputAlto, inputFps
];

/* bloquea todo lo que pueda cambiar el video mientras se generan los fotogramas */
function bloquearEdicion(bloquear) {
  controlesEdicion.forEach((c) => { c.disabled = bloquear; });
  btnGenerarGif.disabled = bloquear;
  inputVideo.disabled = bloquear;
}

btnGenerarGif.addEventListener('click', async () => {
  if (generandoGif) return;

  const r = refrescarRango();
  if (!r.valido) { estadoGif.textContent = 'El fin debe ser mayor que el inicio.'; return; }
  const { inicio, fin } = r;
  const factor = leerPorcentaje() / 100;

  generandoGif = true;
  bloquearEdicion(true);
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

  // tamaño del GIF: lo que muestran los inputs; si alguno no es válido, el del recuadro
  const anchoSalida = Math.max(1, Math.round(leerNumero(inputAncho, 0)) || Math.round(sw));
  const altoSalida = Math.max(1, Math.round(leerNumero(inputAlto, 0)) || Math.round(sh));
  inputAncho.value = anchoSalida;
  inputAlto.value = altoSalida;
  lienzoVideo.width = anchoSalida;
  lienzoVideo.height = altoSalida;
  ctxVideo.imageSmoothingQuality = 'high';

  /* Fotogramas por segundo del GIF: los del input (por defecto los del video).
     Un GIF guarda cada tiempo en centésimas de segundo y los navegadores no respetan
     menos de 2 (20 ms), así que el máximo real es 50 fps.
     Velocidad: cada fotograma capturado avanza (velocidad / fps) segundos de video. */
  const fpsPedido = Math.max(1, leerNumero(inputFps, 30));
  const fpsGif = Math.min(fpsPedido, 50);
  const retardoIdeal = 1000 / fpsGif;                        // ms que debería durar cada fotograma
  const redondear10 = (ms) => Math.round(ms / 10) * 10;      // los tiempos del GIF son múltiplos de 10 ms
  const duracionTramo = fin - inicio;
  const paso = factor / fpsGif;
  const cantidad = Math.max(1, Math.round(duracionTramo / paso));
  const tiempoMaximo = Math.max(0, video.duration - 0.001);

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
    generandoGif = false;
    video.currentTime = tiempoOriginal;
    if (!estabaPausado) video.play().catch(() => {});
    bloquearEdicion(false);
  };

  try {
    for (let i = 0; i < cantidad; i++) {
      estadoGif.textContent = `Capturando fotograma ${i + 1} de ${cantidad}...`;
      const t = Math.min(inicio + i * paso, fin, tiempoMaximo);
      await seekTo(t);
      ctxVideo.drawImage(video, sx, sy, sw, sh, 0, 0, anchoSalida, altoSalida);
      // se reparte el redondeo entre fotogramas para que la duración total sea exacta (30 fps -> 30/30/40 ms)
      const retardo = Math.max(20, redondear10((i + 1) * retardoIdeal) - redondear10(i * retardoIdeal));
      gif.addFrame(ctxVideo, { copy: true, delay: retardo });
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

    estadoGif.textContent = fpsPedido > 50
      ? 'Listo. Un GIF no puede pasar de 50 fps, se usaron 50.'
      : 'Listo.';
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
  return { filas, formatoId: r.formatoId, valores: r.valores || null };
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
const btnTomarValores = document.querySelector('#btn_tomar_valores');
const estadoAnalisis = document.querySelector('#estado_analisis');
const resultadoAnalisis = document.querySelector('#resultado_analisis');

/* Muestra analizada: solo la lee la tarjeta de análisis (no se comparte con las de conversión) */
const CONVERSOR_POR_FORMATO = { jpeg: 'jpg', png: 'png', webp: 'webp' };
let muestra = null; // { conversor: 'jpg' | 'png' | 'webp', valores: {...} }

inputAnalisis.addEventListener('change', async () => {
  const archivo = inputAnalisis.files[0];
  if (!archivo) return;
  inputAnalisis.disabled = true;
  btnTomarValores.disabled = true;
  muestra = null;
  resultadoAnalisis.replaceChildren();
  estadoAnalisis.textContent = 'Analizando...';
  try {
    const r = await analizarArchivo(archivo);
    mostrarAnalisis(resultadoAnalisis, r.filas);
    estadoAnalisis.textContent = '';
    const conversor = CONVERSOR_POR_FORMATO[r.formatoId];
    if (conversor && r.valores) {
      muestra = { conversor, valores: r.valores };
      btnTomarValores.disabled = false;
    }
  } catch (error) {
    console.error('Error analizando:', error);
    estadoAnalisis.textContent = 'No se pudo analizar: formato no reconocido o archivo dañado.';
  } finally {
    inputAnalisis.value = '';
    inputAnalisis.disabled = false;
  }
});

/* Copia los valores de la muestra a las opciones de la tarjeta del mismo formato */
btnTomarValores.addEventListener('click', () => {
  if (!muestra) return;
  const tarjeta = document.querySelector(`[data-conversor="${muestra.conversor}"]`);
  if (!tarjeta) return;

  // si esa tarjeta está convirtiendo (su input queda bloqueado), no se tocan sus opciones
  if (tarjeta.querySelector('input[type="file"]').disabled) {
    estadoAnalisis.textContent = 'Esa tarjeta está convirtiendo o todavía no está lista. Probá de nuevo en un momento.';
    return;
  }

  Object.entries(muestra.valores).forEach(([nombre, valor]) => {
    const campo = tarjeta.querySelector(`[data-opcion="${nombre}"]`);
    if (!campo) return;
    if (campo.type === 'checkbox') {
      campo.checked = !!valor;
    } else if (campo.tagName === 'SELECT') {
      // solo si la lista tiene esa opción (ej: el submuestreo 4:2:2 no está en la tarjeta JPG)
      if (!Array.from(campo.options).some(o => o.value === String(valor))) return;
      campo.value = String(valor);
    } else {
      campo.value = valor;
    }
    // WebP: el cambio de "lossless" habilita o deshabilita los campos de modo con pérdida
    campo.dispatchEvent(new Event('change', { bubbles: true }));
  });

  estadoAnalisis.textContent = `Valores copiados a la tarjeta ${muestra.conversor.toUpperCase()}.`;
});
