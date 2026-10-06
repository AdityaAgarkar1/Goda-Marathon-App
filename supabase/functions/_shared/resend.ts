// supabase/functions/_shared/resend.ts
//
// Shared by send-emails and resend-webhook.
//
// SECRETS (supabase secrets set ...)
//   RESEND_API_KEY         already set for send-bulk-email
//   MAIL_FROM              already set, e.g. "GODA Trail Run <noreply@contact.godavariexpedition.in>"
//   RESEND_WEBHOOK_SECRET  whsec_... shown when the webhook is created in Resend
//   MAIL_REPLY_TO          optional; used when the event has no contact email
//   SITE_URL               optional; defaults to https://godavariexpedition.in

import { safeEqual } from './edge.ts';

/* ── Sending ────────────────────────────────────────────────────────────── */

export interface ResendEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  tags?: { name: string; value: string }[];
}

export type ResendResult =
  | { ok: true; id: string | null }
  | { ok: false; status: number; name: string; message: string; retryAfterSec: number | null };

export async function sendEmail(apiKey: string, email: ResendEmail, idempotencyKey: string): Promise<ResendResult> {
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(email),
    });
  } catch (err) {
    return { ok: false, status: 0, name: 'network_error', message: (err as Error).message, retryAfterSec: null };
  }

  const raw = await response.text();
  let data: { id?: string; name?: string; message?: string } = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON error page */ }

  if (response.ok) return { ok: true, id: data.id ?? null };

  const retryAfter = Number(response.headers.get('retry-after'));
  return {
    ok: false,
    status: response.status,
    name: data.name ?? `http_${response.status}`,
    message: data.message ?? raw.slice(0, 300),
    retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

/* ── What to do about a failure ─────────────────────────────────────────── */

/** Transient failures before a message is given up as FAILED. With the backoff below, about four hours. */
export const MAX_FAILURES = 6;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

export type Outcome =
  | { action: 'sent'; providerId: string | null; note?: string }
  /** Try again later. `countFailure` false = not this message's fault. `stopRun` = every other message would fail the same way. */
  | { action: 'defer'; retryInMs: number; countFailure: boolean; stopRun: boolean; error: string }
  | { action: 'fail'; error: string };

export function classify(result: ResendResult, failuresSoFar: number): Outcome {
  if (result.ok) return { action: 'sent', providerId: result.id };

  const { status, name, message } = result;
  const detail = `${name}: ${message}`.slice(0, 500);
  const minutes = (m: number) => m * 60 * 1000;

  // Same idempotency key, different body: only happens when a crashed run's
  // message is taken again and its content changed meanwhile. Resend already
  // sent the first one; the tag on it still links its delivery events here.
  if (name === 'invalid_idempotent_request') {
    return { action: 'sent', providerId: null, note: 'Resend had already sent this message.' };
  }
  if (name === 'concurrent_idempotent_requests') {
    return { action: 'defer', retryInMs: minutes(1), countFailure: false, stopRun: false, error: detail };
  }

  if (name === 'daily_quota_exceeded') {
    return { action: 'defer', retryInMs: minutes(60), countFailure: false, stopRun: true,
             error: "Resend's daily sending limit was reached; will try again hourly." };
  }
  if (name === 'monthly_quota_exceeded') {
    return { action: 'defer', retryInMs: minutes(360), countFailure: false, stopRun: true,
             error: "Resend's monthly sending limit was reached. Upgrade the Resend plan, or emails resume next month." };
  }
  if (status === 429) {
    const wait = Math.min(Math.max(result.retryAfterSec ?? 2, 1), 60) * 1000;
    return { action: 'defer', retryInMs: wait, countFailure: false, stopRun: true, error: detail };
  }

  // A bad key or an unverified domain fails every message the same way. Keep
  // them queued, not FAILED, so fixing the setting is the whole fix.
  if (status === 401 || status === 403) {
    return { action: 'defer', retryInMs: minutes(30), countFailure: false, stopRun: true,
             error: `Resend refused the request (${detail}). Check RESEND_API_KEY, MAIL_FROM and the domain in Resend.` };
  }

  // The message itself is unsendable -- usually a malformed address.
  if (status === 400 || status === 422) {
    return { action: 'fail', error: detail };
  }

  // 5xx and network trouble: back off and try again.
  if (failuresSoFar + 1 >= MAX_FAILURES) {
    return { action: 'fail', error: `Gave up after ${MAX_FAILURES} attempts. Last error: ${detail}` };
  }
  const wait = BACKOFF_MINUTES[Math.min(failuresSoFar, BACKOFF_MINUTES.length - 1)];
  return { action: 'defer', retryInMs: minutes(wait), countFailure: true, stopRun: false, error: detail };
}

/* ── Webhook signatures ─────────────────────────────────────────────────── */

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Resend signs webhooks through Svix, and old events are refused to stop a captured request being replayed. */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;

/**
 * Svix's scheme: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>",
 * keyed with the base64 part of the whsec_ secret, base64-encoded. The
 * svix-signature header holds one or more space-separated "v1,<signature>"
 * entries (several while a secret is being rotated); any match will do.
 */
export async function verifyWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;

  let keyBytes: ArrayBuffer;
  try {
    keyBytes = fromBase64(secret.startsWith('whsec_') ? secret.slice(6) : secret).buffer;
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = toBase64(new Uint8Array(mac));

  return signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    return version === 'v1' && !!value && safeEqual(value, expected);
  });
}
