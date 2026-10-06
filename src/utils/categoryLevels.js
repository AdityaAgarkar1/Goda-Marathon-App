/**
 * Who a race category suits, as stored in event_categories.level (0016).
 * Shared by the homepage cards, the registration form and the admin form so
 * the wording is the same everywhere.
 */
export const CATEGORY_LEVELS = [
  { value: 'beginner', label: 'Beginner-friendly' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'experienced', label: 'Experienced' },
];

/** Display label for a stored level, or null when unset or unknown. */
export function levelLabel(level) {
  return CATEGORY_LEVELS.find(l => l.value === level)?.label || null;
}
