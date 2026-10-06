import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search, Filter, RefreshCw, Send, History, Play, MailPlus, AlertTriangle, CheckCircle, AlertCircle,
} from 'lucide-react';
import {
  getEmailDeliveries, getEmailEvents, getEmailDispatchStatus, processEmailQueue,
  resendEmail, countMissingConfirmations, queueMissingConfirmations,
  DeliveryStatus, PROBLEM_STATUSES,
} from '../../utils/services/email';

/**
 * The delivery log for automatic registration emails: who was sent what, and
 * whether it reached their inbox. One row per recipient. Statuses come from
 * Resend's delivery webhooks, so "Delivered" means the runner's mail server
 * accepted it, not merely that we sent it.
 */

const KIND_LABELS = {
  REGISTRATION_CONFIRMED: 'Confirmation',
  REGISTRATION_RECEIVED: 'Received, payment pending',
  GROUP_CONFIRMED: 'Group confirmation',
  GROUP_RECEIVED: 'Group received, payment pending',
};

const STATUS_BADGES = {
  QUEUED: { cls: 'admin-badge-pending', label: 'Queued' },
  SENDING: { cls: 'admin-badge-pending', label: 'Sending' },
  SENT: { cls: 'admin-badge-neutral', label: 'Sent' },
  DELAYED: { cls: 'admin-badge-pending', label: 'Delayed' },
  DELIVERED: { cls: 'admin-badge-paid', label: 'Delivered' },
  BOUNCED: { cls: 'admin-badge-cancelled', label: 'Bounced' },
  COMPLAINED: { cls: 'admin-badge-cancelled', label: 'Spam report' },
  SUPPRESSED: { cls: 'admin-badge-cancelled', label: 'Suppressed' },
  FAILED: { cls: 'admin-badge-cancelled', label: 'Failed' },
  CANCELLED: { cls: 'admin-badge-neutral', label: 'Not sent' },
};

const EVENT_LABELS = {
  'email.sent': 'Accepted by Resend',
  'email.delivered': 'Delivered to the inbox server',
  'email.delivery_delayed': 'Delivery delayed',
  'email.bounced': 'Bounced',
  'email.complained': 'Marked as spam',
  'email.failed': 'Failed',
  'email.suppressed': 'Suppressed',
  'email.opened': 'Opened',
  'email.clicked': 'Link clicked',
};

const IN_FLIGHT = ['QUEUED', 'SENDING'];
const WAITING = ['QUEUED', 'SENDING', 'DELAYED'];

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'delivered', label: 'Delivered', test: r => r.status === DeliveryStatus.DELIVERED },
  { id: 'sent', label: 'Awaiting report', test: r => r.status === DeliveryStatus.SENT },
  { id: 'waiting', label: 'Waiting', test: r => WAITING.includes(r.status) },
  { id: 'problems', label: 'Problems', test: r => PROBLEM_STATUSES.includes(r.status) },
  { id: 'cancelled', label: 'Not sent', test: r => r.status === DeliveryStatus.CANCELLED },
];

const PAGE = 50;

const when = (iso) => iso
  ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '';

/** The one timestamp that explains the row's current state. */
function statusLine(row) {
  switch (row.status) {
    case 'DELIVERED': return `Delivered ${when(row.delivered_at)}${row.opened_at ? ` · opened ${when(row.opened_at)}` : ''}`;
    case 'SENT': return `Sent ${when(row.sent_at)}, waiting for the delivery report`;
    case 'DELAYED': return `Sent ${when(row.sent_at)}, delivery delayed`;
    case 'QUEUED':
      return new Date(row.next_attempt_at) > new Date()
        ? `Queued ${when(row.created_at)} · next try ${when(row.next_attempt_at)}`
        : `Queued ${when(row.created_at)}`;
    case 'SENDING': return 'Sending now';
    case 'CANCELLED': return `Queued ${when(row.created_at)}, not sent`;
    default: return `${STATUS_BADGES[row.status]?.label || row.status} ${when(row.failed_at || row.sent_at || row.created_at)}`;
  }
}

function Timeline({ row }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getEmailEvents(row.id)
      .then(list => { if (!cancelled) setEvents(list); })
      .catch(err => { if (!cancelled) setError(err.message || 'Could not load the history.'); });
    return () => { cancelled = true; };
  }, [row.id]);

  if (error) return <div className="admin-delivery-timeline admin-cell-muted">{error}</div>;
  if (!events) return <div className="admin-delivery-timeline admin-cell-muted">Loading history…</div>;

  return (
    <ol className="admin-delivery-timeline">
      <li><span>{when(row.created_at)}</span> Queued{row.queued_by === 'admin' ? ' by an organiser' : ' automatically'}</li>
      {row.sent_at && events.every(e => e.type !== 'email.sent') && (
        <li><span>{when(row.sent_at)}</span> Handed to Resend</li>
      )}
      {events.map(e => (
        <li key={e.id}>
          <span>{when(e.occurred_at || e.received_at)}</span> {EVENT_LABELS[e.type] || e.type}
          {e.detail && <em> — {e.detail}</em>}
        </li>
      ))}
      {row.attempts > 1 && <li className="admin-cell-muted">{row.attempts} send attempts</li>}
    </ol>
  );
}

export default function EmailDeliveryLog({ eventId }) {
  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [connected, setConnected] = useState(true);
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');       // 'process' | 'missing' | <row id>
  const [notice, setNotice] = useState(null); // { type, message }

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setIsLoading(true);
    try {
      const [list, dispatch] = await Promise.all([getEmailDeliveries(eventId), getEmailDispatchStatus()]);
      setRows(list);
      setConnected(dispatch.connected);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'Could not load the delivery log.');
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  // While anything is on its way out, keep the list current without a click.
  const inFlight = rows.some(r => IN_FLIGHT.includes(r.status));
  useEffect(() => {
    if (!inFlight) return undefined;
    const timer = setInterval(() => load({ quiet: true }), 15000);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(f => [f.id, rows.filter(f.test).length])),
    [rows]
  );

  const visible = useMemo(() => {
    const test = FILTERS.find(f => f.id === filter)?.test || (() => true);
    const q = search.trim().toLowerCase();
    return rows.filter(r =>
      test(r) &&
      (!kind || r.kind === kind) &&
      (!q || [r.to_email, r.to_name, r.registrations?.bib, r.registration_groups?.group_code]
        .some(v => String(v || '').toLowerCase().includes(q)))
    );
  }, [rows, filter, kind, search]);

  // The most recent reason something is held up, if it is the same for all of
  // them (the daily limit, a bad key) -- worth a banner, not a hunt.
  const holdUp = useMemo(() => {
    const waiting = rows.filter(r => r.status === 'QUEUED' && r.last_error);
    return waiting.length ? waiting[0].last_error : '';
  }, [rows]);

  // Everything sent long ago is still "Sent": the webhook is not reporting back.
  const noReports = useMemo(() => {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const settled = rows.filter(r => ['DELIVERED', 'BOUNCED', 'COMPLAINED', 'DELAYED', 'SUPPRESSED'].includes(r.status));
    const stale = rows.filter(r => r.status === 'SENT' && r.sent_at && new Date(r.sent_at).getTime() < hourAgo);
    return settled.length === 0 && stale.length > 0;
  }, [rows]);

  const sentTotal = rows.filter(r => r.sent_at).length;
  const deliveredPct = sentTotal ? Math.round((counts.delivered / sentTotal) * 100) : null;

  const handleProcess = async () => {
    setBusy('process');
    setNotice(null);
    try {
      const r = await processEmailQueue();
      const parts = [
        r?.sent ? `${r.sent} sent` : '',
        r?.deferred ? `${r.deferred} will retry` : '',
        r?.failed ? `${r.failed} failed` : '',
        r?.cancelled ? `${r.cancelled} no longer needed` : '',
      ].filter(Boolean);
      setNotice({
        type: r?.stopped || r?.failed ? 'error' : 'success',
        message: (parts.length ? parts.join(', ') + '.' : 'Nothing was waiting to be sent.') + (r?.stopped ? ` ${r.stopped}` : ''),
      });
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setBusy('');
      await load({ quiet: true });
    }
  };

  const handleMissing = async () => {
    setBusy('missing');
    setNotice(null);
    try {
      const n = await countMissingConfirmations(eventId);
      if (n === 0) {
        setNotice({ type: 'success', message: 'Every paid entry has already been sent a confirmation.' });
        return;
      }
      const ok = window.confirm(
        `${n} paid ${n === 1 ? 'entry has' : 'entries have'} never been sent a confirmation email ` +
        '(for example, everyone who paid before automatic emails were switched on).\n\n' +
        `Send ${n === 1 ? 'it' : 'them'} now? On Resend's free plan at most 100 emails go out per day; ` +
        'any beyond that are sent automatically over the following days.'
      );
      if (!ok) return;
      const queued = await queueMissingConfirmations(eventId);
      setNotice({
        type: 'success',
        message: `Queued ${queued} confirmation ${queued === 1 ? 'email' : 'emails'}.` +
          (connected ? ' They go out within a minute.' : ' Press "Process queue now" to send them.'),
      });
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setBusy('');
      await load({ quiet: true });
    }
  };

  const handleResend = async (row) => {
    const already = ['DELIVERED', 'SENT'].includes(row.status);
    const ok = window.confirm(already
      ? `This email was already ${row.status === 'DELIVERED' ? 'delivered' : 'sent'} to ${row.to_email}. Send another copy?\n\nIt goes to the address on the entry now; correct it in the Registrations tab first if it was wrong.`
      : `Send this email again? It goes to the address on the entry now${row.to_email ? ` (currently recorded as ${row.to_email})` : ''}. Correct it in the Registrations tab first if it was wrong.`);
    if (!ok) return;

    setBusy(row.id);
    setNotice(null);
    try {
      await resendEmail(row.id);
      setNotice({ type: 'success', message: connected ? 'Queued. It goes out within a minute.' : 'Queued. Press "Process queue now" to send it.' });
    } catch (err) {
      setNotice({ type: 'error', message: err.message });
    } finally {
      setBusy('');
      await load({ quiet: true });
    }
  };

  if (loadError) {
    return (
      <div className="glass" style={{ padding: '1.5rem', borderRadius: '14px' }}>
        <div className="admin-save-msg error"><AlertCircle size={16} /> {loadError}</div>
      </div>
    );
  }

  return (
    <div className="glass" style={{ padding: '1.5rem', borderRadius: '14px' }}>
      <p className="admin-field-hint" style={{ marginTop: 0 }}>
        Runners are emailed automatically when their entry is confirmed, and coordinators get a summary
        for their group. With online payment off, whoever registered is also emailed straight away
        with their bib and the amount due. Switch it off or add race-day details under Settings.
      </p>

      {!connected && (
        <div className="admin-save-msg error">
          <AlertTriangle size={16} />
          <span>
            Automatic sending is not connected yet. Once the send-emails function is deployed, press
            &ldquo;Process queue now&rdquo; once to connect it.
          </span>
        </div>
      )}
      {holdUp && (
        <div className="admin-save-msg error">
          <AlertTriangle size={16} /> <span>Some emails are waiting: {holdUp}</span>
        </div>
      )}
      {noReports && (
        <div className="admin-save-msg error">
          <AlertTriangle size={16} />
          <span>
            No delivery reports have come back from Resend, so nothing can show as Delivered or Bounced.
            Check the resend-webhook setup.
          </span>
        </div>
      )}
      {notice && (
        <div className={`admin-save-msg ${notice.type}`}>
          {notice.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
          <span>{notice.message}</span>
        </div>
      )}

      <div className="admin-delivery-toolbar">
        <button className="btn btn-outline admin-action-btn" onClick={handleProcess} disabled={!!busy} style={{ gap: '6px' }}>
          {busy === 'process' ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
          <span>Process queue now</span>
        </button>
        <button className="btn btn-outline admin-action-btn" onClick={handleMissing} disabled={!!busy} style={{ gap: '6px' }}>
          {busy === 'missing' ? <RefreshCw size={16} className="spin" /> : <MailPlus size={16} />}
          <span>Send missing confirmations</span>
        </button>
        <button className="btn btn-outline admin-action-btn" onClick={() => load()} disabled={isLoading} style={{ gap: '6px' }} aria-label="Refresh">
          <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
          <span className="admin-action-label">Refresh</span>
        </button>
      </div>

      <div className="admin-chip-row" role="tablist" aria-label="Filter by status">
        {FILTERS.map(f => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            className={`admin-chip ${filter === f.id ? 'is-on' : ''} ${f.id === 'problems' && counts.problems ? 'admin-chip-alert' : ''}`}
            onClick={() => { setFilter(f.id); setShown(PAGE); }}
          >
            {f.label} {counts[f.id]}
          </button>
        ))}
      </div>
      {deliveredPct !== null && (
        <p className="admin-field-hint" style={{ margin: '0 0 0.75rem' }}>
          {deliveredPct}% of the {sentTotal} sent so far confirmed delivered.
        </p>
      )}

      <div className="admin-delivery-filters">
        <div className="admin-search-wrap">
          <Search size={16} className="admin-filter-icon" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setShown(PAGE); }}
            placeholder="Search name, email, bib or group code"
            aria-label="Search the delivery log"
          />
        </div>
        <div className="admin-select-wrap">
          <Filter size={16} className="admin-filter-icon" />
          <select value={kind} onChange={e => { setKind(e.target.value); setShown(PAGE); }} aria-label="Filter by email type">
            <option value="">All email types</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="admin-empty-state">Loading delivery log…</div>
      ) : rows.length === 0 ? (
        <div className="admin-empty-state" style={{ padding: '3rem 1rem' }}>
          <p>No registration emails yet. The first one is queued when an entry is confirmed.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="admin-empty-state">No emails match these filters.</div>
      ) : (
        <div className="admin-email-log">
          {visible.slice(0, shown).map(row => {
            const badge = STATUS_BADGES[row.status] || STATUS_BADGES.QUEUED;
            const isProblem = PROBLEM_STATUSES.includes(row.status);
            const reg = row.registrations;
            const group = row.registration_groups;
            return (
              <div key={row.id} className="admin-email-log-item">
                <div className="admin-email-log-header">
                  <span className="admin-email-log-subject">
                    {row.to_name || row.to_email}
                    {row.to_name && <span className="admin-delivery-address"> {row.to_email}</span>}
                  </span>
                  <span className={`admin-badge ${badge.cls}`}>{badge.label}</span>
                </div>
                <div className="admin-email-log-meta admin-delivery-meta">
                  <span>{KIND_LABELS[row.kind] || row.kind}</span>
                  {reg?.bib && <span>Bib {reg.bib}</span>}
                  {reg?.category && <span>{reg.category}</span>}
                  {group?.group_code && <span>Group {group.group_code}</span>}
                  <span>{statusLine(row)}</span>
                </div>
                {row.last_error && (
                  <div className={`admin-delivery-error ${isProblem ? '' : 'is-info'}`}>{row.last_error}</div>
                )}
                <div className="admin-delivery-actions">
                  <button className="admin-cat-action-btn" onClick={() => setOpenId(openId === row.id ? null : row.id)} aria-expanded={openId === row.id}>
                    <History size={12} /> {openId === row.id ? 'Hide history' : 'History'}
                  </button>
                  {!IN_FLIGHT.includes(row.status) && (
                    <button className="admin-cat-action-btn" onClick={() => handleResend(row)} disabled={!!busy}>
                      {busy === row.id ? <RefreshCw size={12} className="spin" /> : <Send size={12} />} Send again
                    </button>
                  )}
                </div>
                {openId === row.id && <Timeline row={row} />}
              </div>
            );
          })}
          {visible.length > shown && (
            <button className="btn btn-outline admin-page-btn" onClick={() => setShown(shown + PAGE)} style={{ alignSelf: 'center' }}>
              Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
