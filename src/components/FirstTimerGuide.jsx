import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Route } from 'lucide-react';
import { BlockIcon } from './BlockIcon';

/** "Ages 7+ · 10m climb · starts 07:30 AM", from the category's own settings. */
function starterFacts(cat) {
  return [
    cat.min_age && `Ages ${cat.min_age}+`,
    cat.elevation && cat.elevation !== '0m' && `${cat.elevation} climb`,
    cat.flag_off_time && `starts ${cat.flag_off_time}`,
  ].filter(Boolean).join(' · ');
}

/**
 * The homepage's answer to "I've never run a trail race": the distances marked
 * beginner-friendly in Admin -> Categories, then tips from Admin -> Content ->
 * Homepage. The hero's second button jumps here (#first-timers). Renders
 * nothing when there are neither starter distances nor tips.
 */
export function FirstTimerGuide({ tips, starters }) {
  if (tips.length === 0 && starters.length === 0) return null;

  return (
    <section id="first-timers" className="section guide-section" aria-labelledby="guide-heading">
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="container"
      >
        <div className="text-center guide-head">
          <h2 id="guide-heading">First Trail Run? <span className="accent-text">Start Here</span></h2>
          <p className="text-muted">What to know before your first trail race.</p>
        </div>

        <div className="guide-grid">
          {starters.length > 0 && (
            <div className="guide-card guide-card--pick">
              <span className="guide-icon"><Route size={24} aria-hidden="true" /></span>
              <h3>Pick a starter distance</h3>
              <ul className="guide-starters">
                {starters.map(cat => {
                  const facts = starterFacts(cat);
                  return (
                    <li key={cat.id}>
                      <strong>{cat.name}</strong>
                      {cat.audience && <span className="guide-starter-audience">{cat.audience}</span>}
                      {facts && <span className="guide-starter-facts">{facts}</span>}
                    </li>
                  );
                })}
              </ul>
              <Link to="/#categories" className="guide-link">
                Compare all distances <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          )}

          {tips.map(tip => (
            <div key={tip.id} className="guide-card">
              <span className="guide-icon"><BlockIcon name={tip.icon} /></span>
              <h3>{tip.title}</h3>
              {tip.body && <p>{tip.body}</p>}
            </div>
          ))}
        </div>

        <p className="guide-help">
          Still unsure about something? <Link to="/contact" className="guide-link">Ask the organisers</Link>
        </p>
      </motion.div>
    </section>
  );
}
