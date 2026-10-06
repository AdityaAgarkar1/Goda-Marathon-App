import {
  Backpack, Camera, CircleHelp, Clock, Droplet, Flag, Footprints, HeartPulse,
  Leaf, MapPin, Medal, Mountain, Route, ShieldCheck, Shirt, Sparkles, Sunrise,
  Timer, Trophy, Users,
} from 'lucide-react';

/**
 * Icons an organiser can pick for a homepage block, keyed by the value stored
 * in homepage_blocks.icon. A fixed list rather than any icon name, so a typo
 * in the database cannot break the page and the set stays visually coherent.
 */
export const BLOCK_ICONS = {
  mountain: { label: 'Mountain', Icon: Mountain },
  route: { label: 'Route', Icon: Route },
  footprints: { label: 'Footprints', Icon: Footprints },
  shield: { label: 'Shield (safety)', Icon: ShieldCheck },
  medical: { label: 'Heartbeat (medical)', Icon: HeartPulse },
  droplet: { label: 'Water', Icon: Droplet },
  timer: { label: 'Timer', Icon: Timer },
  clock: { label: 'Clock', Icon: Clock },
  sunrise: { label: 'Sunrise', Icon: Sunrise },
  medal: { label: 'Medal', Icon: Medal },
  trophy: { label: 'Trophy', Icon: Trophy },
  shirt: { label: 'T-shirt', Icon: Shirt },
  backpack: { label: 'Backpack (what to carry)', Icon: Backpack },
  users: { label: 'People', Icon: Users },
  leaf: { label: 'Leaf (nature)', Icon: Leaf },
  pin: { label: 'Map pin', Icon: MapPin },
  camera: { label: 'Camera', Icon: Camera },
  flag: { label: 'Flag', Icon: Flag },
  help: { label: 'Question mark', Icon: CircleHelp },
  sparkles: { label: 'Sparkles', Icon: Sparkles },
};

/** Shown for an unknown or empty key. */
export const FALLBACK_BLOCK_ICON = 'sparkles';

/** [{ value, label }] for the admin icon picker. */
export const BLOCK_ICON_OPTIONS = Object.entries(BLOCK_ICONS).map(([value, { label }]) => ({ value, label }));
