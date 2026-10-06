import { VARIANT_WIDTHS, variantWidthsFor } from './heroVariants';

/**
 * Resize a hero photo in the browser before it is uploaded.
 *
 * Phones and cameras produce 4000-8000 px originals of several MB. Served as
 * they are, one would undo the work in HeroImage: a slow first paint, and iOS
 * Safari decoding it at reduced resolution. So an upload becomes the same
 * ladder of WebP widths the built-in photo ships with.
 */

export const MIN_HERO_WIDTH = 1200;
export const SHARP_HERO_WIDTH = 1920;
const MAX_WIDTH = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];

// Shared with resizeCover.
export const WEBP = { type: 'image/webp', ext: 'webp', quality: 0.82 };
export const JPEG = { type: 'image/jpeg', ext: 'jpg', quality: 0.85 };

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be read as an image. Try a JPG or PNG.'));
    };
    img.src = url;
  });
}

export function drawScaled(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

export function toBlob(canvas, format) {
  return new Promise(resolve => canvas.toBlob(resolve, format.type, format.quality));
}

/**
 * Returns { width, height, ext, contentType, totalBytes, variants }, where
 * `variants` is [{ width, blob }] ascending and `width` is the widest.
 *
 * Drawing an <img> (rather than an ImageBitmap) applies the EXIF rotation, so
 * a portrait phone photo does not come out on its side.
 */
export async function resizeHero(file) {
  const img = await loadImage(file);
  const { naturalWidth, naturalHeight } = img;

  if (naturalWidth < MIN_HERO_WIDTH) {
    throw new Error(
      `This photo is ${naturalWidth} px wide. The homepage hero needs at least ` +
      `${MIN_HERO_WIDTH} px, and ${SHARP_HERO_WIDTH} or more to look sharp on a laptop.`
    );
  }

  const widths = variantWidthsFor(Math.min(naturalWidth, MAX_WIDTH));
  const heightFor = (w) => Math.round((naturalHeight * w) / naturalWidth);

  let format = WEBP;
  let source = img;
  const variants = [];

  // Widest first, each drawn from the one before, so no single step shrinks
  // the photo far. One big jump lets browsers sample coarsely, and fine
  // detail such as gravel and grass turns to noise.
  for (const width of [...widths].reverse()) {
    const canvas = drawScaled(source, width, heightFor(width));

    let blob = await toBlob(canvas, format);
    // Safari cannot encode WebP from a canvas and quietly returns a PNG.
    if (blob && blob.type !== format.type && format === WEBP) {
      format = JPEG;
      blob = await toBlob(canvas, format);
    }
    if (!blob) throw new Error('This photo could not be processed. Try a JPG or PNG.');

    variants.unshift({ width, blob });
    // Release the previous canvas now; Safari caps total canvas memory.
    if (source !== img) source.width = source.height = 0;
    source = canvas;
  }
  source.width = source.height = 0;

  const widest = widths[widths.length - 1];
  return {
    width: widest,
    height: heightFor(widest),
    ext: format.ext,
    contentType: format.type,
    totalBytes: variants.reduce((sum, v) => sum + v.blob.size, 0),
    variants,
  };
}
