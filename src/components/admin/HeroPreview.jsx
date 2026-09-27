import React, { useLayoutEffect, useRef, useState } from 'react';
import { Calendar, MapPin, Users } from 'lucide-react';
import { HeroImage } from '../HeroImage';
import { HeroHeadline } from '../HeroHeadline';
import { CountdownTimer } from '../CountdownTimer';

/**
 * The homepage hero as a laptop and a phone would show it, drawn at true pixel
 * size and scaled down to fit.
 *
 * The landing page picks its phone layout with a media query, which cannot
 * fire inside a box in the admin panel, so Admin.css restates both layouts
 * under .hp-hero. Keep them in step with .hero--home in index.css.
 */

const DESKTOP = { width: 1440, height: 820 };
const PHONE = { width: 390, height: 700 };

function ScaledFrame({ width, height, children }) {
  const frameRef = useRef(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / width);
    });
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={frameRef} className="hp-frame" style={{ aspectRatio: `${width} / ${height}` }}>
      <div className="hp-canvas" style={{ width, height, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

function HeroMock({ layout, image, headline, subcopy, badge, date, countdownTarget, location, registrationOpen, categoryCount }) {
  // `sizes` is roughly the width the photo is drawn at on screen after scaling.
  const sizes = layout === 'phone' ? '300px' : '720px';
  const facts = [
    // The countdown is the real one: it sets how tall the card is, and with it
    // how far up the photo the headline sits.
    {
      icon: Calendar, label: 'Date', value: date || 'To be announced',
      extra: countdownTarget && <CountdownTimer targetDate={countdownTarget} />,
    },
    { icon: MapPin, label: 'Location', value: location || 'To be announced', upper: true },
    {
      icon: Users,
      label: 'Categories',
      value: categoryCount > 0 ? `${categoryCount} Distance${categoryCount === 1 ? '' : 's'}` : 'Coming soon',
    },
  ];

  return (
    <div className={`hp-hero hp-hero--${layout}`}>
      <HeroImage src={image} className="hp-photo" sizes={sizes} />
      <div className="hp-overlay" />
      <div className="hp-copy">
        <span className="badge badge-primary hp-badge">{badge}</span>
        <div className="hp-title"><HeroHeadline text={headline} /></div>
        <p className="hp-subcopy">{subcopy}</p>
        <div className="hp-actions">
          <span className="btn btn-primary hp-btn">{registrationOpen ? 'Register Now' : 'View Event'}</span>
          <span className="btn btn-outline hp-btn">View Past Events</span>
        </div>
        <div className="glass hp-facts">
          {facts.map(({ icon: Icon, label, value, upper, extra }, i) => (
            <React.Fragment key={label}>
              {i > 0 && <div className="hp-fact-rule" />}
              <div className="hp-fact">
                <div className="hp-fact-label"><Icon size={24} /> <span>{label}</span></div>
                <p className={`hp-fact-value${upper ? ' is-upper' : ''}${extra ? ' is-flush' : ''}`}>{value}</p>
                {extra}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function HeroPreview(props) {
  return (
    <div className="hp-devices" aria-hidden="true">
      <figure className="hp-device hp-device--desktop">
        <ScaledFrame {...DESKTOP}>
          <HeroMock layout="desktop" {...props} />
        </ScaledFrame>
        <figcaption>Laptop · {DESKTOP.width} px wide</figcaption>
      </figure>
      <figure className="hp-device hp-device--phone">
        <ScaledFrame {...PHONE}>
          <HeroMock layout="phone" {...props} />
        </ScaledFrame>
        <figcaption>Phone · {PHONE.width} px wide</figcaption>
      </figure>
    </div>
  );
}
