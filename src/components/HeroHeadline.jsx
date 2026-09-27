import React from 'react';

export const DEFAULT_HERO_HEADLINE = 'RUN BEYOND LIMITS';

/** Renders the headline with its final word highlighted. */
export function HeroHeadline({ text }) {
  // filter(Boolean) matters: ''.split(/\s+/) yields [''], not [].
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const last = words.pop();
  return (
    <>
      {words.length > 0 && `${words.join(' ')} `}
      <span className="gradient-text">{last}</span>
    </>
  );
}
