/**
 * Light / dark theme: where the visitor's choice and the site default are kept,
 * and how a theme is applied.
 *
 * The inline script in index.html repeats the first-paint part of this before
 * any JavaScript bundle loads, so the page never flashes the wrong theme. It
 * cannot import this file: if a key or a rule changes here, change it there.
 */

/** The visitor's own pick from the header switch: 'light' | 'dark'. */
const CHOICE_KEY = 'goda-theme';
/** The admin default as last fetched, so a returning visitor's first paint matches it. */
const SITE_DEFAULT_KEY = 'goda-theme-default';

/** Values for site_settings.default_theme (migration 0018), as the admin picks them. */
export const SITE_THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: "Match the visitor's device" },
];

// The browser's toolbar colour on phones, matched to each theme's page colour.
const TOOLBAR_COLOURS = { light: '#FFFFFF', dark: '#0B1626' };

// Storage can throw in private windows or with site data blocked; the theme
// then lasts only as long as the page.
function read(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* not persisted */ }
}

export function readThemeChoice() {
  const value = read(CHOICE_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

export function saveThemeChoice(theme) {
  write(CHOICE_KEY, theme);
}

export function readCachedSiteDefault() {
  const value = read(SITE_DEFAULT_KEY);
  return SITE_THEME_OPTIONS.some(o => o.value === value) ? value : null;
}

export function cacheSiteDefault(value) {
  write(SITE_DEFAULT_KEY, value);
}

export function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

/** The site default as a concrete theme, resolving 'system' against the device. */
export function resolveSiteDefault(value, prefersDark) {
  if (value === 'system') return prefersDark ? 'dark' : 'light';
  return value === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', TOOLBAR_COLOURS[theme]);
}
