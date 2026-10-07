/**
 * Bib series: each category owns a range of numbers (migration 0017), coded
 * by distance by default -- 21 km runs 21001-21999 -- so a bib tells a
 * volunteer which race its wearer is in. The database issues and guards the
 * numbers; these helpers only read and display them.
 */

/** The numeric value of a bib, or null for anything that is not 1-6 digits. */
export const bibNumber = (bib) => {
  const s = String(bib ?? '').trim();
  return /^[0-9]{1,6}$/.test(s) ? Number(s) : null;
};

/** "21001–21999", or '' when the category has no series yet. */
export const formatBibSeries = (category) =>
  category?.bib_start && category?.bib_end ? `${category.bib_start}–${category.bib_end}` : '';

/** The category whose series contains `bib`, or null. */
export const categoryForBib = (bib, categories = []) => {
  const n = bibNumber(bib);
  if (n === null) return null;
  return categories.find(c => c.bib_start && c.bib_end && n >= c.bib_start && n <= c.bib_end) || null;
};

/**
 * Sort by bib as a number. Bibs are stored as text, and text order puts
 * "10001" before "3001"; entries without a bib go last.
 */
export const compareBibs = (a, b) => {
  const x = bibNumber(a);
  const y = bibNumber(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x - y;
};

/**
 * Problems with a series an organiser has typed, checked against the other
 * categories of the event. The database enforces the same rules; this is so
 * the form can say so before saving. Returns '' when the series is fine, or
 * when both fields are empty (the database then picks one).
 */
export const validateBibSeries = ({ start, end, maxSlots, others = [] }) => {
  const hasStart = String(start ?? '').trim() !== '';
  const hasEnd = String(end ?? '').trim() !== '';
  if (!hasStart && !hasEnd) return '';
  if (!hasStart || !hasEnd) return 'Enter both the first and the last bib number, or leave both empty for an automatic series.';

  const from = Number(start);
  const to = Number(end);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 999999 || to < from) {
    return 'A bib series runs from a lower whole number to a higher one, between 1 and 999999.';
  }

  const size = to - from + 1;
  const slots = Number(maxSlots);
  if (slots > 0 && size < slots) {
    return `${from}–${to} has ${size} numbers, but the category takes up to ${slots} runners.`;
  }

  const clash = others.find(c => c.bib_start && c.bib_end && from <= c.bib_end && to >= c.bib_start);
  if (clash) return `${from}–${to} overlaps ${clash.name} (${formatBibSeries(clash)}).`;

  return '';
};
