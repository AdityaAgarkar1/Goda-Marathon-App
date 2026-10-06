// supabase/functions/send-emails/index.ts
//
// Drains public.email_messages: the confirmation and "received" emails that
// the triggers in migration 0014 queue whenever an entry is confirmed.
//
// Who calls it:
//   * the database, through pg_net, the moment a message is queued;
//   * pg_cron, every minute while anything is due -- the retries;
//   * the admin panel's "Process queue now" button, with {"wait": true}, to
//     see the result.
// Overlapping runs are fine: claim_email_messages() hands each row to one run.
//
// It takes no input and can only send what the database queued, so it is
// deployed with --no-verify-jwt: pg_net has no user token to send. Each run
// also records its own URL in public.email_settings, which is how the
// database learns where to find it.
//
// DEPLOY
//   npm run supabase -- functions deploy send-emails --no-verify-jwt
//   (secrets: see _shared/resend.ts)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, ConfigError, env, json, serviceClient } from '../_shared/edge.ts';
import { classify, sendEmail } from '../_shared/resend.ts';
import {
  renderEmail,
  type EmailContext, type EmailEvent, type EmailGroup, type EmailKind, type EmailRunner,
} from '../_shared/emailTemplates.ts';

/** Rows taken per claim. Small, so a crashed run strands little. */
const BATCH_SIZE = 10;
/** Gap between sends. Resend allows 10 requests a second per team; this stays well under it. */
const PACE_MS = 250;
/** Stop claiming after this long. Whatever is left goes on the next run. */
const RUN_BUDGET_MS = 40_000;

// Fallbacks for when the event row has no contact details. Keep in step with
// ORGANISATION in src/utils/constants.js, which the admin preview uses.
const ORGANISER = {
  name: 'Godavari Expedition',
  email: 'godavariexpedition@gmail.com',
  phone: '+91 82085 92273',
};

// Single literals, not concatenations: supabase-js reads the column names out
// of the string's type to type the rows it returns.
const REG_COLUMNS = 'id, event_id, group_id, first_name, last_name, email, bib, category, tshirt_size, price, list_price, discount_amount, coupon_code, payment_status, payment_ref, emergency_contact_name, emergency_contact_number';
const GROUP_COLUMNS = 'id, event_id, group_code, captain_first_name, captain_last_name, captain_email, organisation_name, participant_count, subtotal, discount, total, coupon_code, payment_status, payment_ref';
const EVENT_COLUMNS = 'id, name, date, flag_off_time, venue, location, contact_email, contact_phone, confirmation_email_note';

interface Message {
  id: string;
  event_id: string | null;
  kind: EmailKind;
  registration_id: string | null;
  group_id: string | null;
  to_email: string;
  attempts: number;
  failures: number;
}

interface Config {
  apiKey: string;
  from: string;
  replyTo: string | null;
  siteUrl: string;
}

interface Summary {
  sent: number;
  deferred: number;
  failed: number;
  cancelled: number;
  stopped?: string;
}

type Prepared =
  | { ok: true; to: string; ctx: Omit<EmailContext, 'siteUrl' | 'organiser'> }
  | { ok: false; reason: string };

const clean = (v: unknown) => String(v ?? '').trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether the email still makes sense by the time it comes up. Usually it
 * goes out within seconds, but a message held back by the daily limit can
 * wait hours, and the entry may have been cancelled -- or confirmed, which
 * makes a "payment pending" email wrong -- in the meantime.
 */
function stillApplies(kind: EmailKind, status: string | null): string | null {
  const now = clean(status).toLowerCase() || 'unknown';
  if (kind.endsWith('_CONFIRMED')) {
    return status === 'PAID' ? null : `Not sent: the entry is ${now} now, not paid.`;
  }
  if (status === 'PENDING') return null;
  if (status === 'PAID') return 'Not sent: the entry was confirmed first, and the confirmation email replaces this one.';
  return `Not sent: the entry is ${now} now.`;
}

async function loadEvent(admin: SupabaseClient, cache: Map<string, EmailEvent>, id: string | null): Promise<EmailEvent> {
  if (!id) return { name: 'your event' };
  const hit = cache.get(id);
  if (hit) return hit;
  const { data, error } = await admin.from('events').select(EVENT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not load event ${id}: ${error.message}`);
  const event: EmailEvent = data ?? { name: id };
  cache.set(id, event);
  return event;
}

async function prepare(admin: SupabaseClient, msg: Message, events: Map<string, EmailEvent>): Promise<Prepared> {
  if (msg.kind.startsWith('REGISTRATION_')) {
    if (!msg.registration_id) return { ok: false, reason: 'Not sent: the entry was deleted.' };

    const { data: runner, error } = await admin
      .from('registrations').select(REG_COLUMNS).eq('id', msg.registration_id).maybeSingle();
    if (error) throw new Error(`Could not load registration: ${error.message}`);
    if (!runner) return { ok: false, reason: 'Not sent: the entry was deleted.' };

    const why = stillApplies(msg.kind, runner.payment_status);
    if (why) return { ok: false, reason: why };

    let group: EmailGroup | null = null;
    if (runner.group_id) {
      const { data } = await admin.from('registration_groups').select(GROUP_COLUMNS).eq('id', runner.group_id).maybeSingle();
      group = data;
    }

    return {
      ok: true,
      to: clean(runner.email).toLowerCase(),
      ctx: {
        kind: msg.kind,
        event: await loadEvent(admin, events, runner.event_id ?? msg.event_id),
        runner: runner as EmailRunner,
        group,
      },
    };
  }

  if (!msg.group_id) return { ok: false, reason: 'Not sent: the group was deleted.' };

  const { data: group, error } = await admin
    .from('registration_groups').select(GROUP_COLUMNS).eq('id', msg.group_id).maybeSingle();
  if (error) throw new Error(`Could not load group: ${error.message}`);
  if (!group) return { ok: false, reason: 'Not sent: the group was deleted.' };

  const why = stillApplies(msg.kind, group.payment_status);
  if (why) return { ok: false, reason: why };

  const { data: members, error: membersError } = await admin
    .from('registrations').select(REG_COLUMNS)
    .eq('group_id', group.id)
    .neq('payment_status', 'CANCELLED')
    .order('bib', { ascending: true });
  if (membersError) throw new Error(`Could not load group members: ${membersError.message}`);

  return {
    ok: true,
    to: clean(group.captain_email).toLowerCase(),
    ctx: {
      kind: msg.kind,
      event: await loadEvent(admin, events, group.event_id ?? msg.event_id),
      group: group as EmailGroup,
      members: (members ?? []) as EmailRunner[],
    },
  };
}

async function rpc(admin: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

async function drain(admin: SupabaseClient, cfg: Config): Promise<Summary> {
  const summary: Summary = { sent: 0, deferred: 0, failed: 0, cancelled: 0 };
  const events = new Map<string, EmailEvent>();
  const deadline = Date.now() + RUN_BUDGET_MS;
  let stop: { retryAt: string; error: string } | null = null;

  while (!stop && Date.now() < deadline) {
    const { data, error } = await admin.rpc('claim_email_messages', { p_limit: BATCH_SIZE });
    if (error) throw new Error(`claim_email_messages failed: ${error.message}`);
    const batch = (data ?? []) as Message[];
    if (batch.length === 0) break;

    for (const msg of batch) {
      // Something already said every send will fail the same way (the daily
      // limit, a bad key). Hand the rest back untouched.
      if (stop) {
        await rpc(admin, 'record_email_deferred', {
          p_id: msg.id, p_error: stop.error, p_retry_at: stop.retryAt, p_count_failure: false,
        });
        summary.deferred++;
        continue;
      }

      try {
        const prepared = await prepare(admin, msg, events);
        if (!prepared.ok) {
          await rpc(admin, 'record_email_closed', { p_id: msg.id, p_status: 'CANCELLED', p_error: prepared.reason });
          summary.cancelled++;
          continue;
        }

        const rendered = renderEmail({ ...prepared.ctx, siteUrl: cfg.siteUrl, organiser: ORGANISER });
        const replyTo = clean(prepared.ctx.event.contact_email) || cfg.replyTo;

        const result = await sendEmail(cfg.apiKey, {
          from: cfg.from,
          to: [prepared.to],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          ...(replyTo ? { reply_to: replyTo } : {}),
          // message_id is how resend-webhook finds this row again, even if
          // the delivery event beats record_email_sent().
          tags: [
            { name: 'message_id', value: msg.id },
            { name: 'kind', value: msg.kind.toLowerCase() },
          ],
        }, `${msg.id}/${msg.attempts}`);

        const outcome = classify(result, msg.failures);

        if (outcome.action === 'sent') {
          await rpc(admin, 'record_email_sent', {
            p_id: msg.id, p_provider_id: outcome.providerId, p_subject: rendered.subject, p_to_email: prepared.to,
          });
          summary.sent++;
        } else if (outcome.action === 'defer') {
          const retryAt = later(outcome.retryInMs);
          await rpc(admin, 'record_email_deferred', {
            p_id: msg.id, p_error: outcome.error, p_retry_at: retryAt, p_count_failure: outcome.countFailure,
          });
          summary.deferred++;
          if (outcome.stopRun) {
            stop = { retryAt, error: outcome.error };
            summary.stopped = outcome.error;
          }
        } else {
          await rpc(admin, 'record_email_closed', { p_id: msg.id, p_status: 'FAILED', p_error: outcome.error });
          summary.failed++;
        }
      } catch (err) {
        // Our side failed (a database read, a bug). Back off as for a
        // transient error rather than leave the row stuck in SENDING.
        const message = `Dispatcher error: ${(err as Error).message}`;
        console.error(`send-emails ${msg.id}:`, message);
        try {
          await rpc(admin, 'record_email_deferred', {
            p_id: msg.id, p_error: message, p_retry_at: later(5 * 60 * 1000), p_count_failure: true,
          });
          summary.deferred++;
        } catch (inner) {
          console.error(`send-emails ${msg.id}: could not record the error:`, (inner as Error).message);
        }
      }

      await sleep(PACE_MS);
    }
  }

  return summary;
}

function readConfig(): Config {
  return {
    apiKey: env('RESEND_API_KEY'),
    from: env('MAIL_FROM'),
    replyTo: Deno.env.get('MAIL_REPLY_TO') || null,
    siteUrl: Deno.env.get('SITE_URL') || 'https://godavariexpedition.in',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let wait = false;
  try {
    wait = (await req.json())?.wait === true;
  } catch {
    // pg_net and cron send an empty object or nothing at all; both mean "run".
  }

  let cfg: Config;
  let admin: SupabaseClient;
  try {
    cfg = readConfig();
    admin = serviceClient();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('send-emails misconfigured:', err.message);
      return json({ error: `Email is not configured: ${err.message}. Set it with \`supabase secrets set\`.` }, 503);
    }
    throw err;
  }

  // Tell the database where this function lives, so it can poke it. Only the
  // public URL: a local `supabase functions serve` reports an internal one.
  const selfUrl = Deno.env.get('SUPABASE_URL');
  if (selfUrl?.startsWith('https://')) {
    const { error } = await admin.rpc('register_email_dispatcher', { p_url: `${selfUrl}/functions/v1/send-emails` });
    if (error) console.warn('send-emails: could not register its URL:', error.message);
  }

  const run = drain(admin, cfg).then((summary) => {
    if (summary.sent + summary.deferred + summary.failed + summary.cancelled > 0) {
      console.log('send-emails:', JSON.stringify(summary));
    }
    return summary;
  });

  // A poke from the database should not hold its connection open for the
  // whole run; finish in the background where the runtime allows it.
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (!wait && edgeRuntime) {
    edgeRuntime.waitUntil(run.catch((err) => console.error('send-emails failed:', (err as Error).message)));
    return json({ accepted: true }, 202);
  }

  try {
    return json(await run);
  } catch (err) {
    console.error('send-emails failed:', (err as Error).message);
    return json({ error: (err as Error).message }, 500);
  }
});
