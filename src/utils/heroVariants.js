/**
 * Naming scheme for hero photos uploaded from the admin panel.
 *
 * An upload is resized in the browser into a set of widths and stored as
 *
 *   hero/<name>-<unique>/<width>.<ext>
 *
 * and the event row keeps only the URL of the widest file. Which widths exist
 * and where each one lives are derived from that URL, so the public page can
 * build a srcset without a column listing them.
 */

export const VARIANT_WIDTHS = [640, 960, 1280, 1920, 2560];
export const HERO_FOLDER = 'hero';

/** Widths an upload whose widest file is `largest` px carries, ascending. */
export function variantWidthsFor(largest) {
  return [...VARIANT_WIDTHS.filter(w => w < largest), largest];
}

// Only our own bucket's hero folder: a bare number is never a filename the
// ordinary uploader produces, but a pasted URL elsewhere could be one.
const UPLOADED_HERO = new RegExp(
  `^(.+/storage/v1/object/public/[^/]+/${HERO_FOLDER}/[^/?#]+/)(\\d+)\\.(webp|jpg)$`
);

/**
 * Recognise an uploaded hero set from the URL stored on the event row.
 * Returns { widths, urlFor(width) }, or null for any other URL.
 */
export function parseUploadedHero(url) {
  const match = UPLOADED_HERO.exec(url || '');
  if (!match) return null;
  const [, base, largest, ext] = match;
  return {
    widths: variantWidthsFor(Number(largest)),
    urlFor: (width) => `${base}${width}.${ext}`,
  };
}
