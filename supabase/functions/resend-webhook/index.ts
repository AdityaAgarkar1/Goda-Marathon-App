// supabase/functions/resend-webhook/index.ts
//
// Resend's delivery reports. This is where "sent" becomes "delivered", or
// "bounced" with the receiving server's reason, in the admin Deliveries view.
//
// Events to tick when creating the webhook (Resend -> Webhooks -> Add):
//   email.sent, email.delivered, email.delivery_delayed, email.bounced,
//   email.complained, email.failed, email.suppressed
//   and, only if open tracking is on for the domain, email.opened.
//
// Each event is matched to its row by the message_id tag send-emails puts on
// every email, and handed to apply_email_event(), which ignores repeats and
// never moves a status backwards -- Resend retries, and events can arrive out
// of order. Events for email this project does not track (the admin bulk
// sends) are logged and otherwise ignored.
//
// Deployed with --no-verify-jwt: Resend has no Supabase token. The Svix
// signature over the raw body is the authentication.
//
// DEPLOY
//   npm run supabase -- secrets set RESEND_WEBHOOK_SECRET=whsec_...
//   npm run supabase -- functions deploy resend-webhook --no-verify-jwt
//
// Webhook URL to paste into Resend:
//   https://<project-ref>.supabase.co/functions/v1/resend-webhook

import { ConfigError, UUID_RE, env, json, serviceClient } from '../_shared/edge.ts';
import { verifyWebhook } from '../_shared/resend.ts';

type Tags = Record<string, string> | { name: string; value: string }[];

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    tags?: Tags;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
    suppressed?: { message?: string; type?: string };
  };
}

/** Resend has sent tags both as an object and as a name/value list. */
function tag(tags: Tags | undefined, name: string): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) return tags.find((t) => t?.name === name)?.value ?? null;
  return tags[name] ?? null;
}

/** The sentence an organiser reads in the log. */
function detailOf(event: ResendEvent): string | null {
  const d = event.data ?? {};
  switch (event.type) {
    case 'email.bounced': {
      const kind = [d.bounce?.type, d.bounce?.subType].filter(Boolean).join(' / ');
      return [kind && `${kind}:`, d.bounce?.message].filter(Boolean).join(' ') || 'Bounced';
    }
    case 'email.complained':
      return 'The recipient marked this email as spam.';
    case 'email.failed':
      return d.failed?.reason ?? 'Resend could not send this email.';
    case 'email.suppressed':
      return d.suppressed?.message ??
        'Resend did not send this because the address is on its suppression list (an earlier bounce or spam report).';
    case 'email.delivery_delayed':
      return 'The receiving server is deferring delivery; Resend keeps retrying.';
    default:
      return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Read once, as text: the signature is over these exact bytes.
  const raw = await req.text();
  const webhookId = req.headers.get('svix-id');

  try {
    const ok = await verifyWebhook(env('RESEND_WEBHOOK_SECRET'), {
      id: webhookId,
      timestamp: req.headers.get('svix-timestamp'),
      signature: req.headers.get('svix-signature'),
    }, raw);
    if (!ok) {
      console.warn('resend-webhook: rejected a request with a bad, missing or stale signature');
      return json({ error: 'Invalid signature' }, 401);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('resend-webhook misconfigured:', err.message);
      // 503 so Resend keeps retrying until the secret is set.
      return json({ error: 'Webhook secret not configured' }, 503);
    }
    throw err;
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Body was not JSON' }, 400);
  }

  // contact.* and domain.* events, if subscribed, are not about a message.
  if (!event.type?.startsWith('email.')) return json({ ok: true, ignored: event.type ?? null });

  const messageId = tag(event.data?.tags, 'message_id');

  try {
    const { data, error } = await serviceClient().rpc('apply_email_event', {
      p_webhook_id: webhookId,
      p_type: event.type,
      p_provider_id: event.data?.email_id ?? null,
      p_message_id: messageId && UUID_RE.test(messageId) ? messageId : null,
      p_occurred_at: event.created_at ?? null,
      p_detail: detailOf(event),
      p_payload: event,
    });
    if (error) throw new Error(error.message);
    return json({ ok: true, result: data });
  } catch (err) {
    // 500 so Resend retries; apply_email_event() is idempotent on the svix id.
    console.error(`resend-webhook ${webhookId} (${event.type}) failed:`, (err as Error).message);
    return json({ error: 'Processing failed' }, 500);
  }
});
