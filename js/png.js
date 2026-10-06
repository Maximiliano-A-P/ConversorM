/* Codificador PNG propio.
   Variables: nivel de compresión (0-9, zlib), filtro por fila e interlace (Adam7).
   Depende de pako (global en el navegador). */
(function (global) {
  const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunkPNG(tipo, datos) {
    const salida = new Uint8Array(12 + datos.length);
    const dv = new DataView(salida.buffer);
    dv.setUint32(0, datos.length);
    for (let i = 0; i < 4; i++) salida[4 + i] = tipo.charCodeAt(i);
    salida.set(datos, 8);
    dv.setUint32(8 + datos.length, crc32(salida.subarray(4, 8 + datos.length)));
    return salida;
  }

  /* Pasadas de Adam7: [x0, y0, dx, dy] */
  const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

  const FILTROS = { ninguno: 0, sub: 1, up: 2, promedio: 3, paeth: 4 };

  function aplicarFiltro(tipo, fila, previa, bpp, dest, o) {
    const n = fila.length;
    for (let i = 0; i < n; i++) {
      const x = fila[i];
      const a = i >= bpp ? fila[i - bpp] : 0;
      const b = previa[i];
      let p;
      switch (tipo) {
        case 0: p = x; break;
        case 1: p = x - a; break;
        case 2: p = x - b; break;
        case 3: p = x - ((a + b) >> 1); break;
        default: {
          const c = i >= bpp ? previa[i - bpp] : 0;
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          p = x - ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
        }
      }
      dest[o + 1 + i] = p & 255;
    }
    dest[o] = tipo;
  }

  /* Elige por fila el filtro con menor suma de valores absolutos (heurística de la especificación) */
  function filtroAdaptativo(fila, previa, bpp, dest, o, temporal) {
    let mejorTipo = 0, mejorSuma = Infinity;
    for (let tipo = 0; tipo < 5; tipo++) {
      aplicarFiltro(tipo, fila, previa, bpp, temporal, 0);
      let suma = 0;
      for (let i = 1; i <= fila.length; i++) {
        const v = temporal[i];
        suma += v < 128 ? v : 256 - v;
      }
      if (suma < mejorSuma) { mejorSuma = suma; mejorTipo = tipo; }
    }
    aplicarFiltro(mejorTipo, fila, previa, bpp, dest, o);
  }

  /* opciones: { nivel: 0-9, filtro: 'ninguno'|'sub'|'up'|'promedio'|'paeth'|'adaptativo', entrelazado: bool } */
  function codificarPNG(imageData, opciones) {
    const op = Object.assign({ nivel: 0, filtro: 'ninguno', entrelazado: false }, opciones);
    const { width: w, height: h, data } = imageData;

    // sin ningún píxel transparente se guarda como RGB (más liviano)
    let tieneAlfa = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) { tieneAlfa = true; break; }
    }
    const canales = tieneAlfa ? 4 : 3;
    const pasadas = op.entrelazado ? ADAM7 : [[0, 0, 1, 1]];

    const bloques = [];
    let total = 0;
    for (const [x0, y0, dx, dy] of pasadas) {
      const pw = Math.ceil((w - x0) / dx);
      const ph = Math.ceil((h - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;

      const largo = pw * canales;
      const salida = new Uint8Array((largo + 1) * ph);
      let previa = new Uint8Array(largo);
      let actual = new Uint8Array(largo);
      const temporal = new Uint8Array(largo + 1);

      for (let r = 0; r < ph; r++) {
        const y = y0 + r * dy;
        let d = 0;
        for (let c = 0; c < pw; c++) {
          const s = (y * w + x0 + c * dx) * 4;
          actual[d++] = data[s];
          actual[d++] = data[s + 1];
          actual[d++] = data[s + 2];
          if (tieneAlfa) actual[d++] = data[s + 3];
        }
        const o = r * (largo + 1);
        if (op.filtro === 'adaptativo') filtroAdaptativo(actual, previa, canales, salida, o, temporal);
        else aplicarFiltro(FILTROS[op.filtro] || 0, actual, previa, canales, salida, o);
        const t = previa; previa = actual; actual = t;
      }
      bloques.push(salida);
      total += salida.length;
    }

    const crudo = new Uint8Array(total);
    let pos = 0;
    for (const b of bloques) { crudo.set(b, pos); pos += b.length; }

    const comprimido = global.pako.deflate(crudo, { level: op.nivel });

    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w);
    dv.setUint32(4, h);
    ihdr[8] = 8;                     // profundidad de bits
    ihdr[9] = tieneAlfa ? 6 : 2;     // 6 = RGBA, 2 = RGB
    ihdr[12] = op.entrelazado ? 1 : 0;

    const firma = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    return new Blob([
      firma,
      chunkPNG('IHDR', ihdr),
      chunkPNG('IDAT', comprimido),
      chunkPNG('IEND', new Uint8Array(0))
    ], { type: 'image/png' });
  }

  global.codificarPNG = codificarPNG;
  global.ADAM7 = ADAM7;
})(typeof window !== 'undefined' ? window : globalThis);
