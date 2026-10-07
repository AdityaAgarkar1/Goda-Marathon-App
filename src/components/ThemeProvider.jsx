import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ThemeContext } from '../utils/themeContext';
import { getSiteSettings } from '../utils/services/siteSettings';
import {
  applyTheme, cacheSiteDefault, readCachedSiteDefault, readThemeChoice,
  resolveSiteDefault, saveThemeChoice, systemPrefersDark,
} from '../utils/theme';

/**
 * Decides the theme and keeps <html data-theme> in step with it.
 *
 * In order of precedence: the admin panel is always dark (its stylesheet is
 * written for dark only); then the visitor's own choice from the header
 * switch; then the site default set in Admin -> Event Settings, which may be
 * "match the device". The default is fetched once per visit and cached, so a
 * returning visitor's first paint, done by the script in index.html, already
 * matches it.
 */
export default function ThemeProvider({ children }) {
  const { pathname } = useLocation();
  const forced = pathname.startsWith('/admin') ? 'dark' : null;

  const [choice, setChoice] = useState(readThemeChoice);
  const [siteDefault, setSiteDefaultState] = useState(() => readCachedSiteDefault() || 'light');
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    let cancelled = false;
    getSiteSettings().then(row => {
      if (cancelled || !row?.default_theme) return;
      setSiteDefaultState(row.default_theme);
      cacheSiteDefault(row.default_theme);
    });
    return () => { cancelled = true; };
  }, []);

  // Follow the device live, e.g. a phone switching to dark at sunset.
  useEffect(() => {
    if (siteDefault !== 'system') return undefined;
    let query;
    try { query = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return undefined; }
    const onChange = (e) => setPrefersDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [siteDefault]);

  const theme = forced || choice || resolveSiteDefault(siteDefault, prefersDark);

  // Before paint, so a route change into or out of /admin never shows a frame
  // of the wrong theme.
  useLayoutEffect(() => { applyTheme(theme); }, [theme]);

  const value = useMemo(() => ({
    theme,
    isForced: !!forced,
    toggleTheme: () => {
      const next = theme === 'dark' ? 'light' : 'dark';
      saveThemeChoice(next);
      setChoice(next);
    },
    // After the admin saves a new default, so this browser picks it up at once.
    setSiteDefault: (next) => {
      setSiteDefaultState(next);
      cacheSiteDefault(next);
    },
  }), [theme, forced]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
