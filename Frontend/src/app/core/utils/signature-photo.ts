// A foto ocupa 186 unidades do modelo, exportado com três pixels por unidade.
export const SIGNATURE_PHOTO_EXPORT_SIZE = 558;

export function signaturePhotoWarning(width: number, height: number): string {
  const warnings: string[] = [];
  if (width / height > 1.7) {
    warnings.push('A imagem selecionada é muito larga para um retrato e pode ser uma assinatura de e-mail inteira. Confira a prévia ou envie uma foto de rosto.');
  }
  if (Math.min(width, height) < SIGNATURE_PHOTO_EXPORT_SIZE) {
    warnings.push(`A foto tem ${width} × ${height} px. Para maior nitidez na exportação, envie o arquivo original com pelo menos ${SIGNATURE_PHOTO_EXPORT_SIZE} × ${SIGNATURE_PHOTO_EXPORT_SIZE} px. Ampliar uma foto pequena não recupera os detalhes.`);
  }
  return warnings.join(' ');
}

/** Recorta a fonte original uma vez e reduz em etapas para evitar serrilhado. */
export function prepareSignaturePhoto(image: HTMLImageElement): HTMLCanvasElement {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  // A primeira etapa já limita a memória, inclusive para fotos de câmeras grandes.
  let size = SIGNATURE_PHOTO_EXPORT_SIZE;
  while (size * 2 < side && size < SIGNATURE_PHOTO_EXPORT_SIZE * 4) size *= 2;
  let canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  let context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível preparar a fotografia.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);

  while (size > SIGNATURE_PHOTO_EXPORT_SIZE) {
    size = Math.max(SIGNATURE_PHOTO_EXPORT_SIZE, size / 2);
    const next = document.createElement('canvas');
    next.width = next.height = size;
    context = next.getContext('2d');
    if (!context) throw new Error('Não foi possível redimensionar a fotografia.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(canvas, 0, 0, size, size);
    canvas = next;
  }
  return canvas;
}
