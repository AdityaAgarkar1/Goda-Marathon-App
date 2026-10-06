import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Flag, Mountain, Users } from 'lucide-react';
import { resolveImageUrl } from '../utils/mediaUrl';
import { formatDisplayDate, formatMonthYear, toInputDate } from '../utils/dates';

// The homepage is not the archive: past this, the oldest editions drop off
// and the "Explore past editions" link carries the rest.
const MAX_PAST_STOPS = 3;

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];

/**
 * Sort key, oldest first. event_date is free text, so it is read as a date
 * where it clearly is one and falls back to the year otherwise.
 */
function chronologicalKey(edition) {
  return toInputDate(edition.event_date) || String(edition.year || '');
}

/** "500+" → "500+ runners"; a value that already says what it counts is left alone. */
function runnersLabel(participants) {
  const text = String(participants || '').trim();
  if (!text) return '';
  return /[a-z]/i.test(text) ? text : `${text} runners`;
}

/** Cover photo, or a placeholder tile when there is none or it fails to load. */
function EditionCover({ src }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <span className="story-cover story-cover--empty" aria-hidden="true">
        <Mountain size={28} />
      </span>
    );
  }

  return (
    <img
      className="story-cover"
      src={resolveImageUrl(src, 600)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Past editions as a timeline that ends at the upcoming one, so the event is
 * introduced as the next chapter of something that already happened rather
 * than behind a "View Past Events" button. Renders nothing until at least one
 * past edition is published.
 */
export function StorySoFar({ editions, event, registrationOpen }) {
  if (editions.length === 0) return null;

  const past = [...editions]
    .sort((a, b) => chronologicalKey(a).localeCompare(chronologicalKey(b)))
    .slice(-MAX_PAST_STOPS);

  const count = editions.length;
  const countText = `${NUMBER_WORDS[count] || count} edition${count === 1 ? '' : 's'} so far.`;
  const nextName = event.edition ? `${event.edition} edition` : 'next edition';
  const nextText = event.date
    ? ` The ${nextName} runs on ${formatDisplayDate(event.date)}.`
    : '';

  return (
    <section className="section story-section" aria-labelledby="story-heading">
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="container"
      >
        <div className="text-center story-head">
          <h2 id="story-heading">The Story <span className="accent-text">So Far</span></h2>
          <p className="text-muted">{countText}{nextText}</p>
        </div>

        <ol className="story-timeline" style={{ '--stops': past.length + 1 }}>
          {past.map(edition => (
            <li key={edition.id} className="story-stop">
              <Link to={`/past-events?edition=${edition.id}`} className="story-card">
                <EditionCover src={edition.cover_image} />
                <div className="story-card-body">
                  <span className="story-when">
                    {formatMonthYear(edition.event_date) || edition.year}
                  </span>
                  <h3 className="story-title">{edition.title}</h3>
                  {edition.participants && (
                    <span className="story-meta">
                      <Users size={15} aria-hidden="true" /> {runnersLabel(edition.participants)}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}

          <li className="story-stop is-next">
            <div className="story-card story-card--next">
              <span className="story-cover story-cover--next" aria-hidden="true">
                <Flag size={28} />
              </span>
              <div className="story-card-body">
                <span className="story-when">{formatMonthYear(event.date) || 'Coming up'}</span>
                <h3 className="story-title">
                  {event.edition ? `${event.edition} Edition` : 'Next Edition'}
                </h3>
                <span className="story-meta story-meta--next">Your turn.</span>
                <Link to={registrationOpen ? '/register' : '/event'} className="story-next-link">
                  {registrationOpen ? 'Register now' : 'Event details'}
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </li>
        </ol>

        <p className="story-more">
          <Link to="/past-events">
            Explore past editions <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </p>
      </motion.div>
    </section>
  );
}
