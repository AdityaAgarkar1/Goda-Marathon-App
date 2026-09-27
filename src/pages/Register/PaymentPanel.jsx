import React, { useEffect, useState } from 'react';
import { AlertCircle, Clock, Info, Loader, Lock, RefreshCw, CreditCard } from 'lucide-react';
import { Button } from '../../components/Button';

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });

/** The current time, refreshed every `ms` — enough for a minutes countdown. */
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The step between "reserved" and "confirmed", shared by the solo and group
 * flows.
 *
 * It says plainly how long the place is held, because a runner who does not
 * know there is a deadline wanders off to find their card and comes back to a
 * released place. It opens Checkout itself on first arrival (the parent calls
 * onPay straight after reserving); this panel is what they see if they close
 * the window, if a payment is declined, or if they reload the page.
 */
export default function PaymentPanel({
  amount, dueAt, summary,
  phase, message, paymentId,
  onPay, onRecheck, onStartOver, onCancel,
  formatCurrency, contactEmail, contactPhone,
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const now = useNow(15000);
  const minutesLeft = dueAt ? Math.ceil((new Date(dueAt).getTime() - now) / 60000) : null;
  const lapsed = phase === 'expired' || (minutesLeft !== null && minutesLeft <= 0
    // Once money may have moved, the countdown no longer decides anything.
    && !['verifying', 'processing', 'unverified', 'refund', 'paid'].includes(phase));

  const busy = phase === 'starting' || phase === 'paying' || phase === 'verifying' || phase === 'cancelling';
  const awaitingBank = phase === 'processing' || phase === 'unverified';
  const canPay = !lapsed && !awaitingBank && phase !== 'refund' && phase !== 'verifying';

  const contact = (contactEmail || contactPhone) && (
    <p className="reg-success-contact">
      Questions? Reach us at{' '}
      {contactEmail && <a href={`mailto:${contactEmail}`}>{contactEmail}</a>}
      {contactEmail && contactPhone && ' or '}
      {contactPhone && <a href={`tel:${contactPhone.replace(/\s+/g, '')}`}>{contactPhone}</a>}
      {paymentId ? <> and quote payment ID <strong>{paymentId}</strong>.</> : '.'}
    </p>
  );

  if (lapsed) {
    return (
      <div className="reg-success reg-pay">
        <Clock size={64} className="reg-pay-icon reg-pay-icon--warn" aria-hidden="true" />
        <h2 className="reg-success-title">Reservation expired</h2>
        <p className="reg-success-subtitle">
          Payment was not completed in time, so the place has been released for
          someone else. Your details are still filled in — you can submit again
          if places remain.
        </p>
        <div className="reg-actions reg-actions--center">
          <Button variant="primary" onClick={onStartOver}>Start again</Button>
        </div>
        {contact}
      </div>
    );
  }

  return (
    <div className="reg-success reg-pay">
      <CreditCard size={64} className="reg-pay-icon" aria-hidden="true" />
      <h2 className="reg-success-title">
        {phase === 'refund' ? 'Payment needs attention' : 'Complete your payment'}
      </h2>
      <p className="reg-success-subtitle">
        {awaitingBank || phase === 'refund'
          ? 'Your payment has reached us. Please do not pay again.'
          : dueAt
            ? <>Your place is reserved until <strong>{timeFormat.format(new Date(dueAt))}</strong>. Pay now to confirm it.</>
            : 'Pay now to confirm your place.'}
      </p>

      <div className="reg-success-card">
        <dl className="reg-summary-list">
          {summary.map(row => (
            <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
          ))}
          <div className="reg-summary-total">
            <dt>Amount payable</dt>
            <dd>{formatCurrency(amount)}</dd>
          </div>
        </dl>
      </div>

      {canPay && minutesLeft !== null && (
        <p className="reg-pay-timer" role="timer" aria-live="off">
          <Clock size={14} aria-hidden="true" />
          {minutesLeft <= 1 ? 'Less than a minute left' : `Held for another ${minutesLeft} minutes`}
        </p>
      )}

      {phase === 'verifying' && (
        <p className="reg-pay-status" role="status">
          <Loader size={16} className="spin" aria-hidden="true" /> Confirming your payment…
        </p>
      )}

      {message && (
        <div
          className={awaitingBank || phase === 'idle' ? 'reg-payment-note reg-pay-message' : 'reg-submit-error reg-pay-message'}
          role={awaitingBank || phase === 'idle' ? 'status' : 'alert'}
        >
          {awaitingBank || phase === 'idle'
            ? <Info size={18} aria-hidden="true" />
            : <AlertCircle size={18} aria-hidden="true" />}
          <span>
            {message}
            {paymentId && awaitingBank && <> Payment ID: <strong>{paymentId}</strong>.</>}
          </span>
        </div>
      )}

      {/* Cancelling is offered only while no money can be in flight. Once
          Razorpay has reported a payment (processing, unverified, refund),
          the way out is the organisers, not a button. */}
      {confirmingCancel && canPay ? (
        <div className="reg-pay-confirm" role="group" aria-labelledby="reg-pay-confirm-q">
          <p id="reg-pay-confirm-q">
            <strong>Cancel this reservation?</strong> Your place is released
            straight away and nothing is charged. You&apos;ll go back to the form,
            where you can change your details or start a new registration.
          </p>
          <div className="reg-pay-confirm-actions">
            <Button variant="primary" onClick={() => setConfirmingCancel(false)} disabled={phase === 'cancelling'}>
              Keep my reservation
            </Button>
            <Button
              variant="outline"
              onClick={async () => { await onCancel(); setConfirmingCancel(false); }}
              disabled={phase === 'cancelling'}
            >
              {phase === 'cancelling' ? 'Cancelling…' : 'Yes, cancel it'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="reg-actions reg-actions--center">
            {awaitingBank && (
              <Button variant="primary" onClick={onRecheck} disabled={busy}>
                <RefreshCw size={16} aria-hidden="true" /> Check payment status
              </Button>
            )}
            {canPay && (
              <Button variant="primary" onClick={onPay} disabled={busy}>
                {phase === 'starting' ? 'Opening secure checkout…'
                  : phase === 'paying' ? 'Waiting for payment…'
                    : `Pay ${formatCurrency(amount)}`}
              </Button>
            )}
          </div>

          {canPay && onCancel && (
            <button
              type="button"
              className="reg-pay-cancel"
              onClick={() => setConfirmingCancel(true)}
              disabled={busy}
            >
              Cancel reservation
            </button>
          )}
        </>
      )}

      {canPay && (
        <p className="reg-pay-secure">
          <Lock size={13} aria-hidden="true" />
          Payment is handled by Razorpay. Card and bank details are entered on
          Razorpay&apos;s secure page and never reach this site.
        </p>
      )}

      {(awaitingBank || phase === 'refund' || phase === 'error') && contact}
    </div>
  );
}
