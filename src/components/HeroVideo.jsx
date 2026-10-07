import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Pause, Play } from 'lucide-react';

/**
 * Whether this visitor should be sent the video at all: not to someone who
 * has asked their browser to save data, nor on a 2G connection, where a few
 * megabytes of decoration would hold up everything else. The photo stays.
 */
function connectionAllowsVideo() {
  const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(^|-)2g$/.test(connection.effectiveType || '');
}

/**
 * The homepage hero's optional background loop (events.hero_video), laid over
 * the hero photo, which remains the poster and the fallback.
 *
 * It is mounted only after the page has loaded, so it never competes with the
 * photo for the first screen, and fades in once it is actually playing, so a
 * slow start shows the photo rather than a black box. Muted, as autoplay
 * requires, with a pause button: moving content that runs longer than five
 * seconds must be stoppable (WCAG 2.2.2). Visitors who prefer reduced motion
 * never get it.
 */
export function HeroVideo({ src, className }) {
  const reduceMotion = useReducedMotion();
  const videoRef = useRef(null);
  const [allowedByConnection] = useState(connectionAllowsVideo);
  const [mounted, setMounted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  const enabled = !!src && !reduceMotion && allowedByConnection;

  useEffect(() => {
    if (!enabled) return undefined;
    const start = () => setMounted(true);
    if (document.readyState === 'complete') {
      const id = setTimeout(start, 0);
      return () => clearTimeout(id);
    }
    window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, [enabled]);

  // React sets `muted` as a property after the element exists, which some
  // mobile browsers check too late for autoplay; set it and start explicitly.
  useEffect(() => {
    const video = videoRef.current;
    if (!mounted || !video) return;
    video.muted = true;
    video.play().catch(() => { /* autoplay refused: the photo stays */ });
  }, [mounted]);

  if (!enabled || !mounted) return null;

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  return (
    <>
      <video
        ref={videoRef}
        className={`${className} hero-video ${hasStarted ? 'is-playing' : ''}`}
        src={src}
        muted
        loop
        playsInline
        autoPlay
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        onPlaying={() => { setHasStarted(true); setIsPlaying(true); }}
        onPause={() => setIsPlaying(false)}
      />
      {hasStarted && (
        <button
          type="button"
          className="hero-video-toggle"
          onClick={toggle}
          aria-label={isPlaying ? 'Pause background video' : 'Play background video'}
        >
          {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
      )}
    </>
  );
}
