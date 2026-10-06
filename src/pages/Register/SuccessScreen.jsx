import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/Button';
import { CheckCircle, Clock } from 'lucide-react';

/**
 * Shown after the entry is saved -- and, with online payment on, after it is
 * paid.
 *
 * `registration` is the row Supabase returned, so the bib and category are the
 * real stored values. The previous version invented a reference with
 * Math.random() — a number support could never look up — and told the runner a
 * confirmation email had been sent when nothing sent one. Migration 0014 now
 * emails them, so the screen says so — only when `emailsEnabled`, the event's
 * own switch, says an email really is on its way.
 */
export default function SuccessScreen({ registration, eventName, contactEmail, contactPhone, emailsEnabled }) {
  const bib = registration?.bib;
  const isPaid = registration?.payment_status === 'PAID';

  return (
    <div className="reg-success">
      <CheckCircle size={72} className="reg-success-icon" aria-hidden="true" />
      <h2 className="reg-success-title">{isPaid ? 'Entry confirmed' : 'Registration received'}</h2>
      <p className="reg-success-subtitle">
        {isPaid
          ? `You're in! Your place in ${eventName} is confirmed. Keep your bib number for reference.`
          : `Your entry for ${eventName} is saved. Keep your bib number for reference.`}
      </p>

      <div className="reg-success-card">
        <div className="reg-success-bib">
          <span className="reg-success-bib-label">Bib Number</span>
          <span className="reg-success-bib-value">{bib || '—'}</span>
        </div>

        <dl className="reg-summary-list">
          <div>
            <dt>Runner</dt>
            <dd>{registration?.first_name} {registration?.last_name}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{registration?.category}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              {isPaid ? (
                <span className="reg-status-paid">Confirmed</span>
              ) : (
                <span className="reg-status-pending">
                  <Clock size={14} aria-hidden="true" /> Payment pending
                </span>
              )}
            </dd>
          </div>
          {registration?.payment_ref && (
            <div>
              <dt>Payment ID</dt>
              <dd>{registration.payment_ref}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="reg-success-next">
        <h3>What happens next</h3>
        <ol>
          {emailsEnabled && registration?.email && (
            <li>
              {isPaid ? 'A confirmation' : 'A copy of this registration'} is on its way
              to <strong>{registration.email}</strong>. If it has not arrived in a few
              minutes, check your spam folder.
            </li>
          )}
          {isPaid ? (
            <li>
              Your place is confirmed. Quote your bib number
              {registration?.payment_ref ? ' or payment ID' : ''} in any
              correspondence with the organisers.
            </li>
          ) : (
            <>
              <li>
                The organisers will contact you at <strong>{registration?.email}</strong> with
                payment instructions.
              </li>
              <li>Your place is confirmed once payment is received.</li>
            </>
          )}
          <li>Bib collection details are shared closer to race day. Carry a government photo ID.</li>
        </ol>

        {(contactEmail || contactPhone) && (
          <p className="reg-success-contact">
            Questions? Reach us at{' '}
            {contactEmail && <a href={`mailto:${contactEmail}`}>{contactEmail}</a>}
            {contactEmail && contactPhone && ' or '}
            {contactPhone && <a href={`tel:${contactPhone.replace(/\s+/g, '')}`}>{contactPhone}</a>}.
          </p>
        )}
      </div>

      <div className="reg-actions reg-actions--center">
        <Link to="/"><Button variant="outline">Back to home</Button></Link>
        <Link to="/event"><Button variant="primary">Event details</Button></Link>
      </div>
    </div>
  );
}
