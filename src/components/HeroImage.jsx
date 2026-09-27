import React from 'react';
import { getDriveFileId, resolveImageUrl } from '../utils/mediaUrl';

export const DEFAULT_HERO_IMAGE = '/images/trail_hero.png';

const VARIANT_WIDTHS = [640, 960, 1280, 1920, 2560];

/**
 * Web-sized copies of the hero photos that ship in /public, keyed by the path
 * stored on the event row. The originals are camera exports -- trail_hero.png
 * is 6048x4024 and 4.8 MB -- which iOS Safari decodes at reduced resolution,
 * so the hero looked soft on iPhones before it was even cropped.
 *
 * `focus` is the photo's object-position: where to keep the frame when a
 * narrow box crops the sides away. Without it a phone showed the gap between
 * the runners. Admin-uploaded photos have no entry and stay centred.
 *
 * To add a photo, export it as WebP at each of VARIANT_WIDTHS into
 * /public/images/hero/ as `<name>-<width>.webp`.
 */
const LOCAL_HEROES = {
  [DEFAULT_HERO_IMAGE]: { stem: '/images/hero/trail_hero', focus: '60% 30%' },
};

function buildSrcSet(urlForWidth) {
  return VARIANT_WIDTHS.map(w => `${urlForWidth(w)} ${w}w`).join(', ');
}

/**
 * Full-bleed hero photo. Placement and cropping come from `className`; this
 * only decides which file to download.
 *
 * `sizes` is the width the photo is *drawn* at, which is not the width of its
 * box: a landscape photo covering a tall, phone-width box is drawn well wider
 * than the screen. Understating it makes the browser pick a file too small.
 */
export function HeroImage({ src, className, sizes = '100vw' }) {
  const url = src || DEFAULT_HERO_IMAGE;
  const local = LOCAL_HEROES[url];

  let fallback = resolveImageUrl(url);
  let srcSet;
  if (local) {
    fallback = `${local.stem}-1920.webp`;
    srcSet = buildSrcSet(w => `${local.stem}-${w}.webp`);
  } else if (getDriveFileId(url)) {
    // Drive's CDN resizes on request, so a pasted Drive link gets a srcset too.
    fallback = resolveImageUrl(url, 1920);
    srcSet = buildSrcSet(w => resolveImageUrl(url, w));
  }

  return (
    <img
      src={fallback}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt=""
      className={className}
      style={local ? { objectPosition: local.focus } : undefined}
      fetchPriority="high"
      decoding="async"
    />
  );
}
