// supabase/functions/razorpay-verify/index.ts
//
// Step 4a: Checkout's success handler posts what Razorpay gave the browser --
// order id, payment id, signature -- and this confirms the entry.
//
// The browser's word is not taken for anything. The signature proves the
// three values came from Razorpay and belong together; the payment is then
// fetched from Razorpay's API to see its real status and amount, and captured
// if it is only authorised. Only then is confirm_payment() called.
//
// razorpay-webhook does the same job server to server. This function exists
// so the runner sees "confirmed" the moment they pay rather than whenever the
// webhook lands; the webhook exists for when they close the tab first.
//
// Deployed with --no-verify-jwt: the caller is an anonymous visitor, and the
// signature check is the authentication.
//
// DEPLOY
//   npm run supabase -- functions deploy razorpay-verify --no-verify-jwt

import {
  CORS, ConfigError, RazorpayError,
  json, razorpay, serviceClient, settlePayment, verifyCheckoutSignature,
  type RazorpayPayment,
} from '../_shared/razorpay.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Request body was not valid JSON.' }, 400);
  }

  const orderId = (body.razorpay_order_id ?? '').trim();
  const paymentId = (body.razorpay_payment_id ?? '').trim();
  const signature = (body.razorpay_signature ?? '').trim();

  if (!/^order_\w+$/.test(orderId) || !/^pay_\w+$/.test(paymentId) || !/^[0-9a-f]{64}$/i.test(signature)) {
    return json({ status: 'BAD_REQUEST', error: 'Payment details were incomplete.' }, 400);
  }

  try {
    if (!(await verifyCheckoutSignature(orderId, paymentId, signature))) {
      return json({ status: 'BAD_SIGNATURE', error: 'The payment could not be verified.' }, 400);
    }

    const payment = await razorpay<RazorpayPayment>(`/payments/${paymentId}`);
    if (payment.order_id !== orderId) {
      return json({ status: 'BAD_SIGNATURE', error: 'The payment could not be verified.' }, 400);
    }

    const result = await settlePayment(serviceClient(), payment);

    if (result.status === 'PAID') {
      return json({
        status: 'PAID',
        paymentId: result.payment_id,
        registration: result.registration ?? null,
        group: result.group ?? null,
      });
    }

    if (result.status === 'REFUND_REQUIRED') {
      // The money arrived but no entry could take it -- the reservation
      // expired and the place or email went to someone else, or it was
      // already paid. The organisers see it flagged in the admin panel.
      return json({
        status: 'REFUND_REQUIRED',
        paymentId,
        error: 'Your payment was received, but it could not be applied to this registration. The organisers have been notified and will refund it or contact you. Please keep your payment ID.',
      }, 409);
    }

    if (result.status === 'NOT_CAPTURED') {
      // Typically a UPI payment still awaiting the bank. The webhook settles
      // it when it completes; the page offers to check again.
      return json({
        status: 'PROCESSING',
        paymentId,
        error: 'Your payment is still being processed by the bank. This usually takes a minute or two.',
      }, 202);
    }

    return json({ status: result.status, paymentId, error: 'The payment could not be matched to a registration.' }, 409);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('razorpay-verify misconfigured:', err.message);
      return json({ status: 'NOT_CONFIGURED', error: 'Online payment is not configured on the server.' }, 503);
    }
    if (err instanceof RazorpayError) {
      console.error('Razorpay lookup failed:', err.status, err.code, err.message);
    } else {
      console.error('razorpay-verify failed:', (err as Error).message);
    }
    // The payment itself may well have succeeded. Saying so matters: a runner
    // told "failed" pays again.
    return json({
      status: 'UNVERIFIED',
      paymentId,
      error: 'We could not confirm your payment just now. If money was deducted, do not pay again — it will be confirmed automatically within a few minutes.',
    }, 502);
  }
});
