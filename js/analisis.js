/* Análisis de la compresión de una imagen a partir de sus bytes.
   Lee la cabecera real de cada formato. Funciones puras: no tocan el DOM. */
(function (global) {
  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

  function formatoBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function detectarFormato(b) {
    if (b.length < 12) return null;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
    if (ascii(b, 0, 3) === 'GIF') return 'gif';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (ascii(b, 4, 4) === 'ftyp' && /avif|avis/.test(ascii(b, 8, Math.min(b.length - 8, 24)))) return 'avif';
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
    return null;
  }

  /* =====================================================================
     JPEG
     ===================================================================== */
  const SUMA_LUMINANCIA_ESTANDAR = 3578;   // tabla estándar de luminancia (calidad 50)
  const SUMA_CROMINANCIA_ESTANDAR = 5406;  // tabla estándar de crominancia (calidad 50)

  const HUFFMAN_ESTANDAR = {
    '0:0': [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    '1:0': [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125],
    '0:1': [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    '1:1': [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 119]
  };

  function estimarCalidadJPEG(tabla, sumaEstandar) {
    if (!tabla) return null;
    if (tabla.every(v => v === 1)) return 100;
    const suma = tabla.reduce((a, v) => a + v, 0);
    const escala = suma * 100 / sumaEstandar;
    const calidad = escala <= 100 ? (200 - escala) / 2 : 5000 / escala;
    return Math.max(1, Math.min(100, Math.round(calidad)));
  }

  function nombreSubmuestreo(h, v) {
    const mapa = { '1x1': '4:4:4', '2x1': '4:2:2', '2x2': '4:2:0', '1x2': '4:4:0', '4x1': '4:1:1', '4x2': '4:1:0' };
    return mapa[h + 'x' + v] || `${h}x${v}`;
  }

  function analizarJPEG(b) {
    const tablasQ = [];
    const huffman = {};
    const meta = new Set();
    let sof = null, escaneos = 0, reinicio = 0;

    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0x00 || m === 0x01 || (m >= 0xD0 && m <= 0xD8)) { i += 2; continue; }
      if (m === 0xD9) break;
      const len = (b[i + 2] << 8) | b[i + 3];
      const d = i + 4;
      const fin = i + 2 + len;

      if (m === 0xDB) {                       // tablas de cuantización
        let p = d;
        while (p < fin) {
          const precision = b[p] >> 4, id = b[p] & 15;
          p++;
          const t = [];
          for (let k = 0; k < 64; k++) {
            if (precision) { t.push((b[p] << 8) | b[p + 1]); p += 2; } else t.push(b[p++]);
          }
          tablasQ[id] = t;
        }
      } else if (m === 0xC4) {                // tablas de Huffman
        let p = d;
        while (p < fin) {
          const clase = b[p] >> 4, id = b[p] & 15;
          p++;
          const cuentas = Array.from(b.subarray(p, p + 16));
          p += 16 + cuentas.reduce((a, v) => a + v, 0);
          huffman[`${clase}:${id}`] = cuentas;
        }
      } else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        sof = {
          marcador: m, precision: b[d], alto: (b[d + 1] << 8) | b[d + 2],
          ancho: (b[d + 3] << 8) | b[d + 4], componentes: b[d + 5], hv: b[d + 7]
        };
      } else if (m === 0xDA) {
        escaneos++;
      } else if (m === 0xDD) {
        reinicio = (b[d] << 8) | b[d + 1];
      } else if (m === 0xE0 && ascii(b, d, 4) === 'JFIF') {
        meta.add('JFIF');
      } else if (m === 0xE1 && ascii(b, d, 4) === 'Exif') {
        meta.add('EXIF');
      } else if (m === 0xE1 && ascii(b, d, 4) === 'http') {
        meta.add('XMP');
      } else if (m === 0xE2 && ascii(b, d, 11) === 'ICC_PROFILE') {
        meta.add('Perfil ICC');
      } else if (m === 0xEE && ascii(b, d, 5) === 'Adobe') {
        meta.add('Adobe');
      } else if (m === 0xFE) {
        meta.add('Comentario');
      }
      i = fin;
    }
    if (!sof) throw new Error('JPEG sin cabecera SOF');

    const progresivo = [0xC2, 0xC6, 0xCA, 0xCE].includes(sof.marcador);
    const aritmetico = sof.marcador >= 0xC9;
    const sinPerdida = [0xC3, 0xC7, 0xCB, 0xCF].includes(sof.marcador);

    let entropia;
    if (aritmetico) {
      entropia = 'Aritmética';
    } else {
      const claves = Object.keys(huffman);
      const iguales = claves.filter(k => HUFFMAN_ESTANDAR[k] && HUFFMAN_ESTANDAR[k].join() === huffman[k].join()).length;
      if (claves.length > 0 && iguales === claves.length) entropia = 'Huffman con tablas estándar (optimize desactivado)';
      else if (iguales === 0) entropia = 'Huffman con tablas optimizadas (optimize activado)';
      else entropia = `Huffman con tablas parcialmente optimizadas (${claves.length - iguales} de ${claves.length} distintas de las estándar)`;
    }

    const filas = [
      ['Modo', progresivo ? 'Progresivo (progressive activado)' : 'Secuencial / baseline (progressive desactivado)'],
      ['Codificación de entropía', entropia]
    ];
    if (progresivo) filas.push(['Escaneos', String(escaneos)]);

    if (sof.componentes >= 3) {
      filas.push(['Submuestreo de color (subsampling)', nombreSubmuestreo(sof.hv >> 4, sof.hv & 15)]);
    } else {
      filas.push(['Color', 'Escala de grises (1 componente)']);
    }

    if (!sinPerdida) {
      const qL = estimarCalidadJPEG(tablasQ[0], SUMA_LUMINANCIA_ESTANDAR);
      const qC = estimarCalidadJPEG(tablasQ[1], SUMA_CROMINANCIA_ESTANDAR);
      if (qL !== null) filas.push(['Calidad estimada (quality)', `≈ ${qL} / 100 (luminancia, asumiendo tablas estándar de libjpeg)`]);
      if (qC !== null && sof.componentes >= 3) filas.push(['Calidad estimada del color', `≈ ${qC} / 100 (crominancia)`]);
    }
    filas.push(['Precisión', `${sof.precision} bits`]);
    if (reinicio) filas.push(['Intervalo de reinicio', `cada ${reinicio} bloques`]);
    if (meta.size) filas.push(['Metadatos', Array.from(meta).join(', ')]);

    return {
      formato: 'JPEG',
      tipo: sinPerdida ? 'Sin pérdida (JPEG lossless)' : 'Con pérdida',
      ancho: sof.ancho, alto: sof.alto, filas
    };
  }

  /* =====================================================================
     PNG
     ===================================================================== */
  const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const NOMBRES_FILTRO = ['Ninguno', 'Sub', 'Up', 'Promedio', 'Paeth'];

  function contarFiltros(crudo, ihdr, canales) {
    const cuentas = [0, 0, 0, 0, 0];
    const pasadas = ihdr.entrelazado ? ADAM7 : [[0, 0, 1, 1]];
    let o = 0;
    for (const [x0, y0, dx, dy] of pasadas) {
      const pw = Math.ceil((ihdr.ancho - x0) / dx);
      const ph = Math.ceil((ihdr.alto - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const bytesFila = Math.ceil(pw * canales * ihdr.prof / 8);
      for (let r = 0; r < ph; r++) {
        const f = crudo[o];
        if (f > 4) return null;
        cuentas[f]++;
        o += bytesFila + 1;
      }
    }
    return cuentas;
  }

  function analizarPNG(b) {
    const pako = global.pako || (typeof require !== 'undefined' ? require('pako') : null);
    let o = 8;
    let ihdr = null, idatBytes = 0, cabeceraZ = null, paleta = false, apng = false;
    const trozosIdat = [];
    const extras = new Set();

    while (o + 12 <= b.length) {
      const len = u32be(b, o);
      const tipo = ascii(b, o + 4, 4);
      const d = o + 8;
      if (tipo === 'IHDR') {
        ihdr = { ancho: u32be(b, d), alto: u32be(b, d + 4), prof: b[d + 8], color: b[d + 9], entrelazado: b[d + 12] };
      } else if (tipo === 'IDAT') {
        if (idatBytes === 0) cabeceraZ = b.subarray(d, d + 3);
        idatBytes += len;
        trozosIdat.push(b.subarray(d, d + len));
      } else if (tipo === 'PLTE') {
        paleta = true;
      } else if (tipo === 'acTL') {
        apng = true;
      } else if (tipo === 'IEND') {
        break;
      } else if (!['tRNS', 'fcTL', 'fdAT'].includes(tipo)) {
        extras.add(tipo);
      }
      o += 12 + len;
    }
    if (!ihdr || !cabeceraZ) throw new Error('PNG incompleto');

    const nombresColor = { 0: 'Escala de grises', 2: 'RGB', 3: 'Paleta indexada', 4: 'Grises + alfa', 6: 'RGBA' };
    const canales = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color] || 3;
    const bytesFila = Math.ceil(ihdr.ancho * canales * ihdr.prof / 8);
    const crudoEstimado = ihdr.alto * (bytesFila + 1);

    const flevel = cabeceraZ[1] >> 6;
    const almacenado = ((cabeceraZ[2] >> 1) & 3) === 0;
    const nivel = almacenado
      ? 'Nivel 0 (sin comprimir, bloques almacenados)'
      : ['Nivel 1 (más rápido)', 'Niveles 2–5 (rápido)', 'Nivel 6 (por defecto)', 'Niveles 7–9 (máximo)'][flevel];

    const filas = [
      ['Nivel de compresión (compression level, indicativo)', nivel],
      ['Entrelazado (interlace)', ihdr.entrelazado ? 'Activado (Adam7)' : 'Desactivado']
    ];

    // filtros: hay que descomprimir los datos para leer el byte de filtro de cada fila
    if (pako) {
      try {
        const unido = new Uint8Array(idatBytes);
        let p = 0;
        for (const t of trozosIdat) { unido.set(t, p); p += t.length; }
        const crudo = pako.inflate(unido);
        const cuentas = contarFiltros(crudo, ihdr, canales);
        if (cuentas) {
          const usados = cuentas.map((n, k) => [k, n]).filter(([, n]) => n > 0);
          const totalFilas = cuentas.reduce((a, n) => a + n, 0);
          if (usados.length === 1) {
            filas.push(['Filtro (filter)', `${NOMBRES_FILTRO[usados[0][0]]} (todas las filas)`]);
          } else {
            const detalle = usados.map(([k, n]) => `${NOMBRES_FILTRO[k]} ${Math.round(n * 100 / totalFilas)} %`).join(', ');
            filas.push(['Filtro (filter)', `Adaptativo por fila: ${detalle}`]);
          }
        }
      } catch (error) {
        filas.push(['Filtro (filter)', 'No se pudo leer (datos dañados)']);
      }
    }

    filas.push(
      ['Color', `${nombresColor[ihdr.color] || ihdr.color}, ${ihdr.prof} bits por canal${paleta && ihdr.color !== 3 ? ' (con paleta)' : ''}`],
      ['Datos de imagen comprimidos', `${formatoBytes(idatBytes)} (${(idatBytes * 100 / crudoEstimado).toFixed(1)} % del tamaño sin comprimir)`]
    );
    if (apng) filas.push(['Animación', 'Sí (APNG)']);
    if (extras.size) filas.push(['Bloques adicionales', Array.from(extras).join(', ')]);

    return { formato: 'PNG', tipo: 'Sin pérdida (deflate)', ancho: ihdr.ancho, alto: ihdr.alto, filas };
  }

  /* =====================================================================
     WebP
     ===================================================================== */
  /* Decodificador aritmético de VP8 (RFC 6386, sección 7), solo para leer la cabecera */
  class DecBool {
    constructor(b, inicio, fin) {
      this.b = b; this.p = inicio + 2; this.fin = fin;
      this.v = (b[inicio] << 8) | b[inicio + 1];
      this.r = 255; this.n = 0;
    }
    bool(prob) {
      const split = 1 + (((this.r - 1) * prob) >> 8);
      const S = split << 8;
      let ret;
      if (this.v >= S) { ret = 1; this.r -= split; this.v -= S; } else { ret = 0; this.r = split; }
      while (this.r < 128) {
        this.v <<= 1; this.r <<= 1;
        if (++this.n === 8) { this.n = 0; this.v |= (this.p < this.fin ? this.b[this.p++] : 0); }
      }
      return ret;
    }
    lit(n) { let v = 0; while (n--) v = (v << 1) | this.bool(128); return v; }
    firmado(n) { const v = this.lit(n); return this.lit(1) ? -v : v; }
    opcional(n) { return this.lit(1) ? this.firmado(n) : 0; }
  }

  function leerCabeceraVP8(b, d, len) {
    const tag = b[d] | (b[d + 1] << 8) | (b[d + 2] << 16);
    if (tag & 1) return null; // no es key frame
    const tam1 = (tag >> 5) & 0x7FFFF;
    const dec = new DecBool(b, d + 10, Math.min(d + 10 + tam1, d + len, b.length));
    const r = { ancho: u16le(b, d + 6) & 0x3FFF, alto: u16le(b, d + 8) & 0x3FFF, version: (tag >> 1) & 7 };

    dec.lit(1); dec.lit(1);                       // espacio de color, clamping
    r.segmentacion = !!dec.lit(1);
    r.cuantSegmentos = [];
    r.absoluto = false;
    if (r.segmentacion) {
      const actualizaMapa = dec.lit(1);
      const actualizaDatos = dec.lit(1);
      if (actualizaDatos) {
        r.absoluto = !!dec.lit(1);
        for (let s = 0; s < 4; s++) r.cuantSegmentos.push(dec.opcional(7));
        for (let s = 0; s < 4; s++) dec.opcional(6);
      }
      if (actualizaMapa) for (let s = 0; s < 3; s++) if (dec.lit(1)) dec.lit(8);
    }
    r.filtroSimple = !!dec.lit(1);
    r.nivelFiltro = dec.lit(6);
    r.nitidez = dec.lit(3);
    if (dec.lit(1)) {                              // ajustes del filtro por modo/referencia
      if (dec.lit(1)) { for (let k = 0; k < 8; k++) dec.opcional(6); }
    }
    r.particiones = 1 << dec.lit(2);
    r.yac = dec.lit(7);
    return r;
  }

  function calidadDesdeIndice(qi) {
    // inversa de la relación que usa libwebp entre calidad e índice de cuantización
    const lineal = Math.pow(1 - qi / 127, 3);
    const c = lineal < 0.5 ? lineal * 1.5 : (lineal + 1) / 2;
    return Math.max(0, Math.min(100, Math.round(c * 100)));
  }

  function analizarWebP(b) {
    let o = 12, ancho = 0, alto = 0, alfa = null, animado = false, frames = 0, flagsX = null;
    const tipos = new Set();
    let vp8 = null, alph = null, vp8l = null;

    while (o + 8 <= b.length) {
      const id = ascii(b, o, 4);
      const len = u32le(b, o + 4);
      const d = o + 8;
      if (id === 'VP8X') {
        flagsX = b[d];
        animado = !!(flagsX & 2);
        alfa = !!(flagsX & 16);
        ancho = 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16));
        alto = 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16));
      } else if (id === 'VP8 ') {
        tipos.add('lossy');
        if (!vp8) vp8 = leerCabeceraVP8(b, d, len);
        if (!ancho && vp8) { ancho = vp8.ancho; alto = vp8.alto; }
      } else if (id === 'VP8L') {
        tipos.add('lossless');
        const v = u32le(b, d + 1);
        if (!vp8l) vp8l = { alfa: !!((v >>> 28) & 1), version: v >>> 29 };
        if (!ancho) { ancho = (v & 0x3FFF) + 1; alto = ((v >>> 14) & 0x3FFF) + 1; }
      } else if (id === 'ALPH') {
        alph = { compresion: b[d] & 3, filtro: (b[d] >> 2) & 3, preproceso: (b[d] >> 4) & 3 };
      } else if (id === 'ANMF') {
        frames++;
        const sub = ascii(b, d + 16, 4);
        if (sub === 'VP8 ') tipos.add('lossy');
        if (sub === 'VP8L') tipos.add('lossless');
      }
      o = d + len + (len & 1);
    }

    let tipo = 'No determinado';
    if (tipos.size === 2) tipo = 'Mixto (cuadros con y sin pérdida)';
    else if (tipos.has('lossy')) tipo = 'Con pérdida (VP8)';
    else if (tipos.has('lossless')) tipo = 'Sin pérdida (VP8L, lossless activado)';

    const filas = [];

    if (vp8) {
      let qi = vp8.yac;
      let rango = null;
      if (vp8.absoluto && vp8.cuantSegmentos.length === 4) {
        const qs = vp8.cuantSegmentos;
        qi = Math.round(qs.reduce((a, v) => a + v, 0) / 4);
        rango = [Math.min(...qs), Math.max(...qs)];
      }
      filas.push(['Calidad estimada (quality)', `≈ ${calidadDesdeIndice(qi)} / 100 (a partir del índice de cuantización ${qi} de 127)`]);
      let textoSegmentos;
      if (!vp8.segmentacion) textoSegmentos = 'Desactivados';
      else if (!rango) textoSegmentos = 'Activados';
      else if (rango[0] === rango[1]) textoSegmentos = `Activados, todos con el mismo cuantizador (${rango[0]}): sns_strength 0`;
      else textoSegmentos = `Activados, cuantizadores entre ${rango[0]} y ${rango[1]} (cuanto mayor la diferencia, mayor sns_strength)`;
      filas.push(['Segmentos', textoSegmentos]);
      filas.push(['Filtro de bucle (filter_type)', vp8.filtroSimple ? 'Simple' : 'Fuerte (normal)']);
      filas.push(['Intensidad del filtro (filter_strength)', `${vp8.nivelFiltro} / 63`]);
      filas.push(['Nitidez del filtro (filter_sharpness)', `${vp8.nitidez} / 7`]);
      filas.push(['Particiones (partitions)', String(vp8.particiones)]);
    }

    if (vp8l) {
      filas.push(['Transparencia en el flujo', vp8l.alfa ? 'Sí' : 'No']);
      filas.push(['Versión de VP8L', String(vp8l.version)]);
    }

    if (alph) {
      const compresiones = ['Sin comprimir', 'Comprimido sin pérdida (VP8L)'];
      const filtros = ['Ninguno', 'Horizontal', 'Vertical', 'Gradiente'];
      filas.push(['Canal alfa: compresión', compresiones[alph.compresion] || `Código ${alph.compresion}`]);
      filas.push(['Canal alfa: filtro', filtros[alph.filtro]]);
      filas.push(['Canal alfa: preprocesado', alph.preproceso === 1
        ? 'Reducción de niveles (alpha_quality menor a 100)'
        : 'Ninguno (alpha_quality 100)']);
    } else if (alfa === true) {
      filas.push(['Canal alfa', 'Declarado, sin bloque ALPH (lo lleva el propio VP8L)']);
    }

    if (flagsX !== null) {
      const meta = [];
      if (flagsX & 0x20) meta.push('Perfil ICC');
      if (flagsX & 0x08) meta.push('EXIF');
      if (flagsX & 0x04) meta.push('XMP');
      if (meta.length) filas.push(['Metadatos', meta.join(', ')]);
    }
    if (alfa !== null) filas.push(['Transparencia', alfa ? 'Sí' : 'No']);
    if (animado) filas.push(['Animación', `Sí (${frames} cuadros)`]);
    filas.push(['No guardados en el archivo', 'method, pass y near_lossless solo afectan al esfuerzo del encoder y no dejan huella']);

    return { formato: 'WebP', tipo, ancho, alto, filas };
  }

  /* =====================================================================
     BMP, GIF, AVIF, ICO
     ===================================================================== */
  function analizarBMP(b) {
    const tamCabecera = u32le(b, 14);
    let ancho, alto, bits, compresion = 0;
    if (tamCabecera === 12) {
      ancho = u16le(b, 18); alto = u16le(b, 20); bits = u16le(b, 24);
    } else {
      ancho = i32le(b, 18); alto = Math.abs(i32le(b, 22)); bits = u16le(b, 28); compresion = u32le(b, 30);
    }
    const nombres = {
      0: 'Sin comprimir (BI_RGB)', 1: 'RLE de 8 bits (sin pérdida)', 2: 'RLE de 4 bits (sin pérdida)',
      3: 'Sin comprimir con máscaras de bits', 4: 'JPEG embebido', 5: 'PNG embebido'
    };
    return {
      formato: 'BMP',
      tipo: compresion === 4 ? 'Con pérdida' : 'Sin pérdida',
      ancho, alto,
      filas: [
        ['Compresión', nombres[compresion] || `Código ${compresion}`],
        ['Profundidad de color', `${bits} bits por píxel`]
      ]
    };
  }

  function analizarGIF(b) {
    const ancho = u16le(b, 6), alto = u16le(b, 8);
    const empaquetado = b[10];
    const colores = (empaquetado & 0x80) ? 2 ** ((empaquetado & 7) + 1) : null;
    return {
      formato: 'GIF',
      tipo: 'Sin pérdida (LZW), pero limitado a 256 colores',
      ancho, alto,
      filas: [['Paleta global', colores ? `${colores} colores` : 'No tiene (paletas locales)']]
    };
  }

  function analizarAVIF() {
    return {
      formato: 'AVIF',
      tipo: 'Normalmente con pérdida (AV1)',
      ancho: 0, alto: 0,
      filas: [['Nivel de calidad', 'No se puede leer de la cabecera; usá los bits por píxel como referencia']]
    };
  }

  function analizarICO(b) {
    const cantidad = u16le(b, 4);
    const filas = [['Imágenes dentro del icono', String(cantidad)]];
    for (let k = 0; k < Math.min(cantidad, 10); k++) {
      const e = 6 + 16 * k;
      if (e + 16 > b.length) break;
      const w = b[e] || 256, h = b[e + 1] || 256;
      const bits = u16le(b, e + 6);
      const tam = u32le(b, e + 8);
      const off = u32le(b, e + 12);
      const esPNG = b[off] === 0x89 && ascii(b, off + 1, 3) === 'PNG';
      filas.push([`Imagen ${k + 1}`, `${w}×${h}, ${bits || '?'} bits, ${formatoBytes(tam)}, ${esPNG ? 'PNG (comprimido sin pérdida)' : 'BMP (sin comprimir)'}`]);
    }
    return { formato: 'ICO', tipo: 'Sin pérdida (BMP sin comprimir o PNG por imagen)', ancho: 0, alto: 0, filas };
  }

  const ANALIZADORES = {
    jpeg: analizarJPEG, png: analizarPNG, gif: analizarGIF, bmp: analizarBMP,
    webp: analizarWebP, avif: analizarAVIF, ico: analizarICO
  };

  /* Devuelve { formatoId, formato, tipo, ancho, alto, filas } o lanza error si no se reconoce */
  function analizarBytes(bytes) {
    const id = detectarFormato(bytes);
    if (!id) throw new Error('Formato no reconocido');
    return Object.assign({ formatoId: id }, ANALIZADORES[id](bytes));
  }

  const api = { analizarBytes, formatoBytes };
  global.Analisis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);