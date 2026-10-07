import React from 'react';
import { motion } from 'framer-motion';
import { BlockIcon } from './BlockIcon';

/**
 * "What Makes It Different": the race's selling points, edited in Admin ->
 * Content -> Homepage. Replaced two hardcoded generic claims ("zero traffic
 * disruptions", which describes a road race). Renders nothing until at least
 * one point is published.
 */
export function Highlights({ items }) {
  if (items.length === 0) return null;

  return (
    <section
      className="section"
      aria-labelledby="highlights-heading"
      style={{ borderTop: '1px solid var(--color-border)' }}
    >
      <div className="container">
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="why-grid"
        >
          <div className="why-media">
            <img
              src="/images/trail_event2.png"
              alt="Runners climbing a grass ridge on the trail course"
              loading="lazy"
              decoding="async"
            />
          </div>

          <div className="why-body">
            <h2 id="highlights-heading" className="why-title">
              What Makes It <span className="accent-text">Different</span>
            </h2>

            <ul className="why-list">
              {items.map(item => (
                <li key={item.id} className="why-item">
                  <span className="why-icon"><BlockIcon name={item.icon} size={26} /></span>
                  <div>
                    <h3>{item.title}</h3>
                    {item.body && <p>{item.body}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
