// supabase/functions/razorpay-webhook/index.ts
//
// Step 4b: Razorpay's server-to-server notification. This is the path that
// does not depend on the runner's browser: if they pay and then lose signal,
// close the tab or have the in-app browser kill the page, the entry is still
// confirmed here.
//
// Events handled (tick these when creating the webhook in the Razorpay
// dashboard -- Account & Settings -> Webhooks):
//
//   payment.captured   settle the entry
//   order.paid         settle the entry (same payment, arrives alongside)
//   payment.authorized capture it, then settle -- only matters if the
//                      account's capture setting is manual
//   payment.failed     note the error; the reservation stays open for a retry
//   refund.processed   mark the payment refunded, and the entry if it was
//                      the payment that settled it
//
// Razorpay may deliver the same event more than once, and payment.captured and
// order.paid describe the same payment. Every handler is idempotent, so
// duplicates are harmless without keeping a log of event ids.
//
// Anything unexpected returns 500 so Razorpay retries; a bad signature
// returns 401 and is not retried into success.
//
// Deployed with --no-verify-jwt: Razorpay does not have a Supabase token. The
// HMAC signature over the raw body is the authentication.
//
// DEPLOY
//   npm run supabase -- functions deploy razorpay-webhook --no-verify-jwt
//
// Webhook URL to paste into the Razorpay dashboard:
//   https://<project-ref>.supabase.co/functions/v1/razorpay-webhook

import {
  ConfigError,
  json, serviceClient, settlePayment, verifyWebhookSignature,
  type RazorpayPayment,
} from '../_shared/razorpay.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Read the body exactly once, as text: the signature is over these bytes.
  const raw = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  try {
    if (!signature || !(await verifyWebhookSignature(raw, signature))) {
      console.warn('razorpay-webhook: rejected a request with a bad or missing signature');
      return json({ error: 'Invalid signature' }, 401);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('razorpay-webhook misconfigured:', err.message);
      // 503 so Razorpay keeps retrying until the secret is set.
      return json({ error: 'Webhook secret not configured' }, 503);
    }
    throw err;
  }

  let event: {
    event?: string;
    payload?: {
      payment?: { entity?: RazorpayPayment };
      refund?: { entity?: { payment_id?: string } };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Body was not JSON' }, 400);
  }

  const eventId = req.headers.get('x-razorpay-event-id') ?? '-';
  const payment = event.payload?.payment?.entity;

  try {
    const admin = serviceClient();

    switch (event.event) {
      case 'payment.authorized':
      case 'payment.captured':
      case 'order.paid': {
        if (!payment?.id || !payment.order_id) break;
        const result = await settlePayment(admin, payment);
        if (result.status === 'REFUND_REQUIRED') {
          console.warn(`razorpay-webhook ${eventId}: ${payment.id} needs a refund (see payments.note)`);
        }
        break;
      }

      case 'payment.failed': {
        if (!payment?.id || !payment.order_id) break;
        const { error } = await admin.rpc('record_payment_failure', {
          p_order_id: payment.order_id,
          p_payment_id: payment.id,
          p_error: [payment.error_code, payment.error_description].filter(Boolean).join(': ') || 'failed',
        });
        if (error) throw new Error(error.message);
        break;
      }

      case 'refund.processed': {
        const paymentId = event.payload?.refund?.entity?.payment_id ?? payment?.id;
        if (!paymentId) break;
        // amount_refunded is Razorpay's running total for the payment, so a
        // repeated delivery records the same figure rather than adding to it.
        const { error } = await admin.rpc('record_refund', {
          p_payment_id: paymentId,
          p_refunded_paise: payment?.amount_refunded ?? 0,
        });
        if (error) throw new Error(error.message);
        break;
      }

      default:
        // Subscribed to something not handled here. Acknowledge it so
        // Razorpay does not retry it forever.
        break;
    }

    return json({ ok: true });
  } catch (err) {
    console.error(`razorpay-webhook ${eventId} (${event.event}) failed:`, (err as Error).message);
    return json({ error: 'Processing failed' }, 500);
  }
});
