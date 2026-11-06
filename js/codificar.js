/* Codificación de píxeles → JPG / PNG / WebP.
   Se comparte entre la página (modo normal, uno por uno) y js/worker_conv.js (modo rápido).
   No toca el DOM ni guarda estado: solo recibe píxeles y devuelve un Blob. */
async function codificarPixeles(pixeles, formato, op) {
  if (formato === 'png') {
    return codificarPNG(pixeles, { nivel: op.nivel, filtro: op.filtro, entrelazado: op.entrelazado });
  }

  if (formato === 'jpg') {
    const datos = await globalThis.CodecsM.jpeg(pixeles, {
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
  const datos = await globalThis.CodecsM.webp(pixeles, opcionesWebp);
  return new Blob([datos], { type: 'image/webp' });
}
