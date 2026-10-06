// supabase/functions/_shared/emailTemplates.ts
//
// The registration emails, as plain functions from data to { subject, html,
// text }. Nothing here touches the network or Deno, because the admin panel
// imports this same file to preview an email exactly as it will be sent.
//
// HTML email is not the web: layout is tables, styles are inline, and the
// palette is light because several clients invert dark backgrounds. Every
// value that came from a person is escaped.

export type EmailKind =
  | 'REGISTRATION_CONFIRMED'
  | 'REGISTRATION_RECEIVED'
  | 'GROUP_CONFIRMED'
  | 'GROUP_RECEIVED';

export interface EmailEvent {
  name: string;
  date?: string | null;              // YYYY-MM-DD
  flag_off_time?: string | null;     // free text, e.g. "06:45 AM"
  venue?: string | null;
  location?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  confirmation_email_note?: string | null;
}

export interface EmailRunner {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  bib?: string | null;
  category?: string | null;
  tshirt_size?: string | null;
  price?: number | string | null;
  list_price?: number | string | null;
  discount_amount?: number | string | null;
  coupon_code?: string | null;
  payment_ref?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_number?: string | null;
}

export interface EmailGroup {
  group_code: string;
  captain_first_name?: string | null;
  captain_last_name?: string | null;
  organisation_name?: string | null;
  participant_count?: number | null;
  subtotal?: number | string | null;
  discount?: number | string | null;
  total?: number | string | null;
  coupon_code?: string | null;
  payment_ref?: string | null;
}

export interface EmailContext {
  kind: EmailKind;
  event: EmailEvent;
  /** REGISTRATION_*: the runner the email is about. */
  runner?: EmailRunner | null;
  /** GROUP_*: the group. REGISTRATION_*: the group the runner was entered with, if any. */
  group?: EmailGroup | null;
  /** GROUP_*: everyone in the group. */
  members?: EmailRunner[];
  siteUrl: string;
  organiser: { name: string; email?: string | null; phone?: string | null };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/* ── Formatting ─────────────────────────────────────────────────────────── */

const BRAND = '#2E9E1C';      // the site's #45E52C darkened to read on white
const INK = '#1A1A1A';
const MUTED = '#5F6368';
const RULE = '#E6E6E6';
const PANEL = '#F6F7F6';

export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const clean = (value: unknown): string => String(value ?? '').trim();

const fullName = (first?: string | null, last?: string | null) =>
  [clean(first), clean(last)].filter(Boolean).join(' ');

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const formatMoney = (value: unknown): string => {
  const n = toNumber(value) ?? 0;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

/** "Sunday, 13 December 2026". The date is a calendar date, so it is read as UTC to stop it shifting a day. */
export const formatEventDate = (date?: string | null): string => {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return '';
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};

/** Hours and minutes from free text like "6:45 AM", "06.45" or "18:30". */
const parseClock = (text?: string | null): { h: number; m: number } | null => {
  const match = clean(text).match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return { h, m };
};

const compact = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * A Google Calendar "add event" link. Timed from the flag-off (India has no
 * daylight saving, so IST is a fixed +05:30) when the time can be read; a
 * whole-day entry otherwise.
 */
export const calendarLink = (event: EmailEvent): string | null => {
  if (!event.date || !/^\d{4}-\d{2}-\d{2}/.test(event.date)) return null;
  const day = event.date.slice(0, 10);
  const clock = parseClock(event.flag_off_time);

  let dates: string;
  if (clock) {
    const startUtc = new Date(`${day}T00:00:00Z`);
    startUtc.setUTCMinutes(clock.h * 60 + clock.m - 330);
    const endUtc = new Date(startUtc.getTime() + 4 * 60 * 60 * 1000);
    dates = `${compact(startUtc)}/${compact(endUtc)}`;
  } else {
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    dates = `${day.replace(/-/g, '')}/${next.toISOString().slice(0, 10).replace(/-/g, '')}`;
  }

  const where = [clean(event.venue), clean(event.location)].filter(Boolean).join(', ');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.name,
    dates,
    details: clock ? `Flag-off ${clean(event.flag_off_time)}. Carry your photo ID.` : 'Carry your photo ID.',
  });
  if (where) params.set('location', where);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

/* ── Building blocks ────────────────────────────────────────────────────── */

type Row = [label: string, valueHtml: string];

const detailTable = (title: string, rows: Row[]): string => {
  const visible = rows.filter(([, v]) => v !== '');
  if (visible.length === 0) return '';
  return `
<tr><td style="padding:24px 32px 0">
  <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:8px">${escapeHtml(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    ${visible.map(([label, value]) => `
    <tr>
      <td style="padding:8px 0;border-top:1px solid ${RULE};color:${MUTED};font-size:14px;width:40%;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 0;border-top:1px solid ${RULE};color:${INK};font-size:14px;font-weight:600;vertical-align:top">${value}</td>
    </tr>`).join('')}
  </table>
</td></tr>`;
};

const paragraph = (html: string) =>
  `<tr><td style="padding:16px 32px 0;font-size:15px;line-height:1.6;color:${INK}">${html}</td></tr>`;

const highlight = (label: string, value: string, caption: string, pending: boolean) => `
<tr><td style="padding:24px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:${PANEL};border:2px solid ${pending ? '#E0A800' : BRAND};border-radius:10px">
    <tr><td align="center" style="padding:20px 16px">
      <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700">${escapeHtml(label)}</div>
      <div style="font-size:44px;line-height:1.1;font-weight:800;color:${INK};margin:6px 0;letter-spacing:2px">${escapeHtml(value || '—')}</div>
      <div style="font-size:14px;color:${pending ? '#8A6500' : BRAND};font-weight:700">${escapeHtml(caption)}</div>
    </td></tr>
  </table>
</td></tr>`;

const noteBlock = (note?: string | null): string => {
  const text = clean(note);
  if (!text) return '';
  return `
<tr><td style="padding:24px 32px 0">
  <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:8px">Race-day information</div>
  <div style="background:${PANEL};border-left:4px solid ${BRAND};padding:12px 16px;font-size:14px;line-height:1.6;color:${INK}">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>
</td></tr>`;
};

const listBlock = (title: string, items: string[]) => `
<tr><td style="padding:24px 32px 0">
  <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:8px">${escapeHtml(title)}</div>
  <ul style="margin:0;padding:0 0 0 20px;font-size:14px;line-height:1.7;color:${INK}">
    ${items.map((i) => `<li>${i}</li>`).join('')}
  </ul>
</td></tr>`;

const rosterTable = (members: EmailRunner[]) => {
  if (members.length === 0) return '';
  return `
<tr><td style="padding:24px 32px 0">
  <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${MUTED};font-weight:700;margin-bottom:8px">Runners</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
    <tr>
      <th align="left" style="padding:8px 8px 8px 0;border-bottom:2px solid ${RULE};color:${MUTED};font-size:12px">Bib</th>
      <th align="left" style="padding:8px;border-bottom:2px solid ${RULE};color:${MUTED};font-size:12px">Runner</th>
      <th align="left" style="padding:8px 0 8px 8px;border-bottom:2px solid ${RULE};color:${MUTED};font-size:12px">Category</th>
    </tr>
    ${members.map((m) => `
    <tr>
      <td style="padding:8px 8px 8px 0;border-bottom:1px solid ${RULE};font-weight:800;color:${INK}">${escapeHtml(m.bib || '—')}</td>
      <td style="padding:8px;border-bottom:1px solid ${RULE};color:${INK}">${escapeHtml(fullName(m.first_name, m.last_name))}<br><span style="color:${MUTED};font-size:12px">${escapeHtml(m.email)}</span></td>
      <td style="padding:8px 0 8px 8px;border-bottom:1px solid ${RULE};color:${INK}">${escapeHtml(m.category)}</td>
    </tr>`).join('')}
  </table>
</td></tr>`;
};

const eventRows = (event: EmailEvent): Row[] => {
  const where = [clean(event.venue), clean(event.location)].filter(Boolean).join(', ');
  const cal = calendarLink(event);
  return [
    ['Date', escapeHtml(formatEventDate(event.date))],
    ['Flag-off', escapeHtml(clean(event.flag_off_time))],
    ['Venue', escapeHtml(where)],
    ['Calendar', cal ? `<a href="${escapeHtml(cal)}" style="color:${BRAND}">Add to Google Calendar</a>` : ''],
  ];
};

const contactLine = (ctx: EmailContext) => {
  const email = clean(ctx.event.contact_email) || clean(ctx.organiser.email);
  const phone = clean(ctx.event.contact_phone) || clean(ctx.organiser.phone);
  const parts = [
    email ? `<a href="mailto:${escapeHtml(email)}" style="color:${BRAND}">${escapeHtml(email)}</a>` : '',
    phone ? `<a href="tel:${escapeHtml(phone.replace(/\s+/g, ''))}" style="color:${BRAND}">${escapeHtml(phone)}</a>` : '',
  ].filter(Boolean);
  return parts.length ? `Questions? Reply to this email or contact us at ${parts.join(' or ')}.` : 'Questions? Reply to this email.';
};

const layout = (ctx: EmailContext, preheader: string, body: string) => {
  const site = clean(ctx.siteUrl).replace(/\/+$/, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(ctx.event.name)}</title>
</head>
<body style="margin:0;padding:0;background:#EDEFED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDEFED">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden">
      <tr><td style="background:#0B0B0B;padding:24px 32px">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#45E52C;font-weight:700">${escapeHtml(ctx.organiser.name)}</div>
        <div style="font-size:22px;line-height:1.3;color:#FFFFFF;font-weight:800;margin-top:4px">${escapeHtml(ctx.event.name)}</div>
      </td></tr>
      ${body}
      <tr><td style="padding:28px 32px 0;font-size:14px;line-height:1.6;color:${INK}">${contactLine(ctx)}</td></tr>
      <tr><td style="padding:24px 32px 28px">
        <div style="border-top:1px solid ${RULE};padding-top:16px;font-size:12px;line-height:1.6;color:${MUTED}">
          You are receiving this because you registered for ${escapeHtml(ctx.event.name)}${site ? ` at <a href="${escapeHtml(site)}" style="color:${MUTED}">${escapeHtml(site.replace(/^https?:\/\//, ''))}</a>` : ''}.
          It is a record of your entry, not a marketing email.<br>${escapeHtml(ctx.organiser.name)}
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
};

/** Plain-text twin. Mail clients that cannot show HTML, and spam filters, read this. */
const textVersion = (lines: (string | false | null | undefined)[]) =>
  lines.filter((l) => l !== false && l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

const textRows = (rows: [string, string][]) =>
  rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');

/* ── The four emails ────────────────────────────────────────────────────── */

function renderRunner(ctx: EmailContext): RenderedEmail {
  const r = ctx.runner ?? {};
  const confirmed = ctx.kind === 'REGISTRATION_CONFIRMED';
  const name = fullName(r.first_name, r.last_name);
  const first = clean(r.first_name) || 'there';
  const group = ctx.group;
  const captain = group ? fullName(group.captain_first_name, group.captain_last_name) : '';
  const eventName = ctx.event.name;
  const bib = clean(r.bib);
  const discount = toNumber(r.discount_amount) ?? 0;
  const site = clean(ctx.siteUrl).replace(/\/+$/, '');

  const subject = confirmed
    ? `You're in! ${eventName}${bib ? ` · Bib ${bib}` : ''}`
    : `Registration received (payment pending) · ${eventName}`;

  const lead = confirmed
    ? `Hi ${escapeHtml(first)},<br><br>Your place in <strong>${escapeHtml(eventName)}</strong> is confirmed. Keep this email: it is your record of entry.`
    : `Hi ${escapeHtml(first)},<br><br>We have received your registration for <strong>${escapeHtml(eventName)}</strong>. Your place is confirmed once payment is received; the organisers will contact you with payment instructions.`;

  const entryRows: Row[] = [
    ['Runner', escapeHtml(name)],
    ['Category', escapeHtml(clean(r.category))],
    ['T-shirt size', escapeHtml(clean(r.tshirt_size))],
    ['Emergency contact', escapeHtml([clean(r.emergency_contact_name), clean(r.emergency_contact_number) && `(${clean(r.emergency_contact_number)})`].filter(Boolean).join(' '))],
    ['Group', group ? escapeHtml(`${group.group_code}${captain ? `, entered by ${captain}` : ''}`) : ''],
  ];

  const paymentRows: Row[] = group
    ? [['Payment', escapeHtml(confirmed ? `Paid with group ${group.group_code}` : `Due with group ${group.group_code}`)]]
    : [
        ['Entry fee', discount > 0 ? escapeHtml(formatMoney(r.list_price ?? r.price)) : ''],
        ['Discount', discount > 0 ? escapeHtml(`− ${formatMoney(discount)}${r.coupon_code ? ` (${clean(r.coupon_code)})` : ''}`) : ''],
        [confirmed ? 'Amount paid' : 'Amount due', escapeHtml(formatMoney(r.price))],
        ['Payment ID', escapeHtml(clean(r.payment_ref))],
      ];

  const next = confirmed
    ? [
        'Check the details above. If anything is wrong, reply to this email.',
        'Carry a government photo ID when you collect your bib.',
        ...(clean(ctx.event.confirmation_email_note) ? [] : ['Bib collection details will be shared closer to race day.']),
      ]
    : [
        'Quote your bib number when you pay or contact the organisers.',
        'You will receive a confirmation email once your payment is recorded.',
      ];

  const body = [
    paragraph(lead),
    highlight('Bib number', bib, confirmed ? 'Entry confirmed' : 'Payment pending', !confirmed),
    detailTable('Event', eventRows(ctx.event)),
    detailTable('Your entry', entryRows),
    detailTable('Payment', paymentRows),
    confirmed ? noteBlock(ctx.event.confirmation_email_note) : '',
    listBlock('What happens next', next.map(escapeHtml)),
    site ? paragraph(`<a href="${escapeHtml(site)}/event" style="color:${BRAND};font-weight:700">Event details →</a>`) : '',
  ].join('');

  const preheader = [bib && `Bib ${bib}`, clean(r.category), formatEventDate(ctx.event.date)].filter(Boolean).join(' · ');

  const text = textVersion([
    `Hi ${first},`,
    '',
    confirmed
      ? `Your place in ${eventName} is confirmed. Keep this email: it is your record of entry.`
      : `We have received your registration for ${eventName}. Your place is confirmed once payment is received; the organisers will contact you with payment instructions.`,
    '',
    `BIB NUMBER: ${bib || '-'} (${confirmed ? 'entry confirmed' : 'payment pending'})`,
    '',
    textRows([
      ['Date', formatEventDate(ctx.event.date)],
      ['Flag-off', clean(ctx.event.flag_off_time)],
      ['Venue', [clean(ctx.event.venue), clean(ctx.event.location)].filter(Boolean).join(', ')],
    ]),
    '',
    textRows([
      ['Runner', name],
      ['Category', clean(r.category)],
      ['T-shirt size', clean(r.tshirt_size)],
      ['Group', group ? `${group.group_code}${captain ? `, entered by ${captain}` : ''}` : ''],
      [confirmed ? 'Amount paid' : 'Amount due', group ? '' : formatMoney(r.price)],
      ['Payment ID', clean(r.payment_ref)],
    ]),
    confirmed && clean(ctx.event.confirmation_email_note) ? `\nRACE-DAY INFORMATION\n${clean(ctx.event.confirmation_email_note)}` : '',
    '',
    'WHAT HAPPENS NEXT',
    ...next.map((n) => `- ${n}`),
    '',
    contactLine(ctx).replace(/<[^>]+>/g, ''),
    '',
    ctx.organiser.name,
  ]);

  return { subject, html: layout(ctx, preheader, body), text };
}

function renderGroup(ctx: EmailContext): RenderedEmail {
  const g = ctx.group ?? { group_code: '' };
  const members = ctx.members ?? [];
  const confirmed = ctx.kind === 'GROUP_CONFIRMED';
  const first = clean(g.captain_first_name) || 'there';
  const eventName = ctx.event.name;
  const count = members.length || toNumber(g.participant_count) || 0;
  const discount = toNumber(g.discount) ?? 0;

  const subject = confirmed
    ? `Group ${g.group_code} confirmed · ${count} runners · ${eventName}`
    : `Group ${g.group_code} received (payment pending) · ${eventName}`;

  const lead = confirmed
    ? `Hi ${escapeHtml(first)},<br><br>All <strong>${count}</strong> places in your group for <strong>${escapeHtml(eventName)}</strong> are confirmed. Each runner has been sent their own confirmation with their bib number.`
    : `Hi ${escapeHtml(first)},<br><br>We have received your group registration for <strong>${escapeHtml(eventName)}</strong>. Every place is confirmed once payment is received; the organisers will contact you with payment instructions.`;

  const paymentRows: Row[] = [
    ['Runners', escapeHtml(String(count))],
    ['Subtotal', discount > 0 ? escapeHtml(formatMoney(g.subtotal)) : ''],
    ['Discount', discount > 0 ? escapeHtml(`− ${formatMoney(discount)}${g.coupon_code ? ` (${clean(g.coupon_code)})` : ''}`) : ''],
    [confirmed ? 'Total paid' : 'Total due', escapeHtml(formatMoney(g.total))],
    ['Payment ID', escapeHtml(clean(g.payment_ref))],
  ];

  const next = confirmed
    ? [
        'Check the roster above. If a name, email or category is wrong, reply to this email.',
        'Each runner carries their own government photo ID to collect their bib.',
      ]
    : [
        `Quote your group code ${escapeHtml(g.group_code)} when you pay or contact the organisers.`,
        'You and every runner will receive a confirmation email once payment is recorded.',
      ];

  const body = [
    paragraph(lead),
    highlight('Group code', g.group_code, confirmed ? `${count} places confirmed` : 'Payment pending', !confirmed),
    detailTable('Event', eventRows(ctx.event)),
    detailTable('Payment', paymentRows),
    rosterTable(members),
    confirmed ? noteBlock(ctx.event.confirmation_email_note) : '',
    listBlock('What happens next', next),
  ].join('');

  const text = textVersion([
    `Hi ${first},`,
    '',
    confirmed
      ? `All ${count} places in your group for ${eventName} are confirmed. Each runner has been sent their own confirmation with their bib number.`
      : `We have received your group registration for ${eventName}. Every place is confirmed once payment is received; the organisers will contact you with payment instructions.`,
    '',
    `GROUP CODE: ${g.group_code} (${confirmed ? 'confirmed' : 'payment pending'})`,
    textRows([
      ['Date', formatEventDate(ctx.event.date)],
      ['Flag-off', clean(ctx.event.flag_off_time)],
      [confirmed ? 'Total paid' : 'Total due', formatMoney(g.total)],
      ['Payment ID', clean(g.payment_ref)],
    ]),
    '',
    'RUNNERS',
    ...members.map((m) => `${m.bib || '-'}  ${fullName(m.first_name, m.last_name)}  ${clean(m.category)}`),
    confirmed && clean(ctx.event.confirmation_email_note) ? `\nRACE-DAY INFORMATION\n${clean(ctx.event.confirmation_email_note)}` : '',
    '',
    contactLine(ctx).replace(/<[^>]+>/g, ''),
    '',
    ctx.organiser.name,
  ]);

  return {
    subject,
    html: layout(ctx, `${g.group_code} · ${count} runners · ${formatEventDate(ctx.event.date)}`, body),
    text,
  };
}

export function renderEmail(ctx: EmailContext): RenderedEmail {
  return ctx.kind.startsWith('GROUP_') ? renderGroup(ctx) : renderRunner(ctx);
}
