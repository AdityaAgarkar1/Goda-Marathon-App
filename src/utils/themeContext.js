import { createContext, useContext } from 'react';

/**
 * The current theme and how to change it; provided by ThemeProvider.
 * `isForced` is true where the theme is fixed (the admin panel), which hides
 * the header switch.
 */
export const ThemeContext = createContext({
  theme: 'light',
  isForced: false,
  toggleTheme: () => {},
  setSiteDefault: () => {},
});

export const useTheme = () => useContext(ThemeContext);
