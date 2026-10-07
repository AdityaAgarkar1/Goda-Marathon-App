import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../utils/themeContext';

/**
 * The light / dark switch. A real switch (role="switch", aria-checked), so a
 * screen reader announces "Dark mode, on" rather than an unlabelled icon.
 * Renders nothing where the theme is fixed.
 */
export function ThemeToggle({ className = '' }) {
  const { theme, toggleTheme, isForced } = useTheme();
  if (isForced) return null;

  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`theme-toggle ${isDark ? 'is-dark' : ''} ${className}`}
      onClick={toggleTheme}
    >
      <span className="theme-toggle-thumb" aria-hidden="true">
        {isDark ? <Moon size={14} /> : <Sun size={14} />}
      </span>
    </button>
  );
}
