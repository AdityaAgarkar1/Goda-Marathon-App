import React from 'react';
import { BLOCK_ICONS, FALLBACK_BLOCK_ICON } from '../utils/blockIcons';

/** A homepage block's icon (homepage_blocks.icon), decorative. */
export function BlockIcon({ name, size = 24 }) {
  const { Icon } = BLOCK_ICONS[name] || BLOCK_ICONS[FALLBACK_BLOCK_ICON];
  return <Icon size={size} aria-hidden="true" />;
}
