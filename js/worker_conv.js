/* Worker del "Modo rápido": codifica una imagen por mensaje.
   Cada worker carga SU PROPIA instancia de los codificadores WASM (no se comparte nada
   mutable con la página ni con otros workers) y procesa un trabajo a la vez. */

// codecs.js fue pensado para la página: espera `window` y `document.currentScript`
self.window = self;
self.document = { currentScript: { src: new URL('vendor/codecs.js', self.location.href).href } };

importScripts('vendor/codecs.js');
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js', 'png.js', 'codificar.js');

self.onmessage = async (ev) => {
  const { formato, op, ancho, alto, buffer } = ev.data;
  try {
    const pixeles = { data: new Uint8ClampedArray(buffer), width: ancho, height: alto };
    const blob = await codificarPixeles(pixeles, formato, op);
    postMessage({ blob });
  } catch (error) {
    postMessage({ error: error && error.message ? error.message : String(error) });
  }
};

// precarga el WASM y recién después avisa que está listo
self.CodecsM.precargar()
  .then(() => postMessage({ listo: true }))
  .catch((error) => postMessage({ falloInicio: error && error.message ? error.message : String(error) }));
