import React from 'react';
import { getDriveFileId, resolveImageUrl } from '../utils/mediaUrl';
import { VARIANT_WIDTHS, parseUploadedHero } from '../utils/heroVariants';

export const DEFAULT_HERO_IMAGE = '/images/trail_hero.png';

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
 * /public/images/hero/ as `<name>-<width>.webp`. Photos uploaded from the
 * admin panel are resized on upload and need nothing here.
 */
const LOCAL_HEROES = {
  [DEFAULT_HERO_IMAGE]: { stem: '/images/hero/trail_hero', focus: '60% 30%' },
};

// The width served to browsers that ignore srcset.
const FALLBACK_WIDTH = 1920;

function buildSrcSet(widths, urlForWidth) {
  return widths.map(w => `${urlForWidth(w)} ${w}w`).join(', ');
}

/**
 * Full-bleed hero photo. Placement and cropping come from `className`; this
 * only decides which file to download.
 *
 * `sizes` is the width the photo is *drawn* at, which is not the width of its
 * box: a landscape photo covering a tall, phone-width box is drawn well wider
 * than the screen. Understating it makes the browser pick a file too small.
 *
 * `lazy` is for a copy further down the page, which should neither compete
 * with the real hero for bandwidth nor load before it is scrolled to.
 */
export function HeroImage({ src, className, sizes = '100vw', lazy = false }) {
  const url = src || DEFAULT_HERO_IMAGE;
  const local = LOCAL_HEROES[url];
  const uploaded = !local && parseUploadedHero(url);

  let fallback = resolveImageUrl(url);
  let srcSet;
  if (local) {
    fallback = `${local.stem}-${FALLBACK_WIDTH}.webp`;
    srcSet = buildSrcSet(VARIANT_WIDTHS, w => `${local.stem}-${w}.webp`);
  } else if (uploaded) {
    // A small upload may stop short of FALLBACK_WIDTH; take the widest it has.
    const { widths, urlFor } = uploaded;
    fallback = urlFor(widths.filter(w => w <= FALLBACK_WIDTH).pop() ?? widths[0]);
    srcSet = buildSrcSet(widths, urlFor);
  } else if (getDriveFileId(url)) {
    // Drive's CDN resizes on request, so a pasted Drive link gets a srcset too.
    fallback = resolveImageUrl(url, FALLBACK_WIDTH);
    srcSet = buildSrcSet(VARIANT_WIDTHS, w => resolveImageUrl(url, w));
  }

  return (
    <img
      src={fallback}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt=""
      className={className}
      style={local ? { objectPosition: local.focus } : undefined}
      fetchPriority={lazy ? undefined : 'high'}
      loading={lazy ? 'lazy' : undefined}
      decoding="async"
    />
  );
}
