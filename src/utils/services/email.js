import { supabase } from '../supabaseClient';

/**
 * Bulk email to participants.
 *
 * The edge function this calls did not exist until now -- invoking it returned
 * 404, so every attempt was logged FAILED and nobody ever received anything.
 * It lives at supabase/functions/send-bulk-email and has to be deployed, with
 * a mail-provider key set as a secret, before this does anything.
 *
 * email_log is admin-only in both directions after migration 0006; the subject
 * and body of mail sent to participants is not public information.
 */

const TABLE_NAME = 'email_log';

/** Email delivery states: QUEUED → SENDING → SENT | FAILED */
const EmailStatus = {
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
};

/**
 * Send bulk email with explicit state machine.
 * 1. Insert as QUEUED
 * 2. Mark as SENDING
 * 3. Call edge function
 * 4. Update to SENT or FAILED with error_message
 */
const describeFunctionError = (err) => {
  const message = err?.message || '';
  // A missing function and a missing secret are both common before launch and
  // need different actions, so do not collapse them into "delivery failed".
  if (/404|not found/i.test(message)) {
    return 'The send-bulk-email function is not deployed yet. Run `supabase functions deploy send-bulk-email`.';
  }
  if (/not configured|503/i.test(message)) {
    return 'Email is not configured yet. Set RESEND_API_KEY and MAIL_FROM as Supabase secrets.';
  }
  if (/permission|403/i.test(message)) {
    return 'Your account is not permitted to send email.';
  }
  return message || 'Edge function unavailable or failed';
};

export const sendBulkEmail = async ({ subject, body, recipientFilter, recipientCount, eventId }) => {
  // Step 1: Insert as QUEUED
  const { data: logData, error: logError } = await supabase
    .from(TABLE_NAME)
    .insert([{
      subject,
      body,
      recipient_count: recipientCount,
      filter_criteria: recipientFilter,
      status: EmailStatus.QUEUED,
      sent_by: 'admin'
    }])
    .select()
    .single();

  if (logError) throw logError;
  const logId = logData.id;

  // Step 2: Mark as SENDING
  await updateEmailStatus(logId, EmailStatus.SENDING);

  // Step 3: Attempt edge function
  try {
    const { data: fnData, error: fnError } = await supabase.functions.invoke('send-bulk-email', {
      body: { subject, body, recipientFilter, eventId, logId }
    });

    if (fnError) throw fnError;

    // The function reports how many actually went out, which can be fewer than
    // the number the composer predicted.
    await updateEmailStatus(logId, EmailStatus.SENT);
    return { ...logData, status: EmailStatus.SENT, sent: fnData?.sent ?? recipientCount };
  } catch (err) {
    // Step 4b: Failure — record the error, do NOT silently swallow
    const errorMessage = describeFunctionError(err);
    await updateEmailStatus(logId, EmailStatus.FAILED, errorMessage);

    // Re-throw so the UI can show the failure
    const enrichedError = new Error(errorMessage);
    enrichedError.logId = logId;
    enrichedError.status = EmailStatus.FAILED;
    throw enrichedError;
  }
};

/** Update email log status (used by state machine + retry) */
export const updateEmailStatus = async (id, status, errorMessage = null) => {
  try {
    const update = { status };
    if (errorMessage) update.error_message = errorMessage;

    const { error } = await supabase
      .from(TABLE_NAME)
      .update(update)
      .eq('id', id);
    if (error) throw error;
  } catch (error) {
    console.error('Error updating email status', error);
  }
};

/** Retry a failed email */
export const retryEmail = async (logId) => {
  try {
    // Fetch the original email data
    const { data: original, error: fetchErr } = await supabase
      .from(TABLE_NAME)
      .select('*')
      .eq('id', logId)
      .single();

    if (fetchErr) throw fetchErr;
    if (!original) throw new Error('Email log entry not found');

    // Reset to SENDING
    await updateEmailStatus(logId, EmailStatus.SENDING, null);

    // Retry the edge function
    try {
      const { error: fnError } = await supabase.functions.invoke('send-bulk-email', {
        body: {
          subject: original.subject,
          body: original.body,
          recipientFilter: original.filter_criteria,
          logId
        }
      });

      if (fnError) throw fnError;
      await updateEmailStatus(logId, EmailStatus.SENT);
      return { ...original, status: EmailStatus.SENT };
    } catch (err) {
      const errorMessage = describeFunctionError(err);
      await updateEmailStatus(logId, EmailStatus.FAILED, errorMessage);
      throw new Error(`Retry failed: ${errorMessage}`);
    }
  } catch (error) {
    console.error('Error retrying email', error);
    throw error;
  }
};

export const getEmailLog = async () => {
  try {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('*')
      .order('sent_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching email log', error);
    return [];
  }
};

export { EmailStatus };

/* ── Registration emails ──────────────────────────────────────────────────
 * The automatic confirmation emails from migration 0014: one row per person
 * in email_messages, queued by database triggers, sent by the send-emails
 * edge function and moved on by Resend's delivery webhooks. All of it is
 * admin-read-only; the actions below go through admin-only functions.
 */

/** Delivery states, in the order a healthy email moves through them. */
export const DeliveryStatus = {
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELAYED: 'DELAYED',
  DELIVERED: 'DELIVERED',
  BOUNCED: 'BOUNCED',
  COMPLAINED: 'COMPLAINED',
  SUPPRESSED: 'SUPPRESSED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

/** Did not reach the inbox, or was reported: needs an organiser to look at it. */
export const PROBLEM_STATUSES = ['BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED'];

/** PostgREST's "no such table/function": the frontend shipped before migration 0014. */
const missing0014 = (error) =>
  ['PGRST202', 'PGRST205', '42P01'].includes(error?.code) ||
  /Could not find the (table|function)|does not exist/i.test(error?.message || '');

const MIGRATION_HINT = 'Registration emails need migration supabase/migrations/0014_registration_emails.sql applied first.';

const DELIVERY_COLUMNS =
  'id, kind, status, to_email, to_name, subject, attempts, last_error, queued_by, ' +
  'created_at, sent_at, delivered_at, opened_at, failed_at, next_attempt_at, ' +
  'registration_id, group_id, ' +
  'registrations(bib, category, payment_status), registration_groups(group_code)';

/** The newest 1,000 registration emails for an event. */
export const getEmailDeliveries = async (eventId) => {
  const { data, error } = await supabase
    .from('email_messages')
    .select(DELIVERY_COLUMNS)
    .eq('event_id', eventId)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) {
    console.error('Error fetching email deliveries', error);
    throw missing0014(error) ? new Error(MIGRATION_HINT) : error;
  }
  return data || [];
};

/** Everything Resend reported about one email, oldest first. */
export const getEmailEvents = async (messageId) => {
  const { data, error } = await supabase
    .from('email_events')
    .select('id, type, detail, occurred_at, received_at')
    .eq('message_id', messageId)
    .order('received_at', { ascending: true });
  if (error) {
    console.error('Error fetching email events', error);
    throw error;
  }
  return data || [];
};

/**
 * Whether the database knows where the dispatcher is. It learns this the first
 * time send-emails runs; until then nothing is sent automatically.
 */
export const getEmailDispatchStatus = async () => {
  const { data, error } = await supabase
    .from('email_settings')
    .select('dispatch_url, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    console.error('Error fetching email settings', error);
    return { connected: false };
  }
  return { connected: !!data?.dispatch_url, updatedAt: data?.updated_at };
};

/** The JSON error body a non-2xx edge function response carried, if any. */
const functionErrorMessage = async (error) => {
  try {
    const body = await error?.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* not JSON */ }
  return error?.message || 'The email function failed.';
};

/**
 * Run the dispatcher now and wait for it. Normally the database triggers it;
 * this is for the first run after deploying (which also connects it) and for
 * anyone who does not want to wait for the next retry.
 */
export const processEmailQueue = async () => {
  const { data, error } = await supabase.functions.invoke('send-emails', { body: { wait: true } });
  if (error) {
    const message = await functionErrorMessage(error);
    if (/404|not found/i.test(message) || error?.context?.status === 404) {
      throw new Error('The send-emails function is not deployed yet. Run `npm run supabase -- functions deploy send-emails --no-verify-jwt`.');
    }
    throw new Error(message);
  }
  return data;
};

const RESEND_ERRORS = {
  ALREADY_QUEUED: 'That email is already waiting to be sent.',
  ENTRY_NOT_FOUND: 'The entry this email was about no longer exists.',
  MESSAGE_NOT_FOUND: 'That email is no longer in the log.',
  NOT_AUTHORIZED: 'Your account is not permitted to send email.',
};

const describeRpcError = (error) => {
  if (missing0014(error)) return new Error(MIGRATION_HINT);
  const code = Object.keys(RESEND_ERRORS).find(k => error?.message?.includes(k));
  return new Error(code ? RESEND_ERRORS[code] : (error?.message || 'Something went wrong.'));
};

/**
 * Send an email again, to the address on the entry now. Fix a typo in the
 * Registrations tab first, then press this, and the bounce is dealt with.
 */
export const resendEmail = async (messageId) => {
  const { data, error } = await supabase.rpc('admin_resend_email', { p_message_id: messageId });
  if (error) {
    console.error('Error resending email', error);
    throw describeRpcError(error);
  }
  return data;
};

/** How many paid entries have never been sent a confirmation. Sends nothing. */
export const countMissingConfirmations = async (eventId) => {
  const { data, error } = await supabase.rpc('admin_queue_missing_confirmations', {
    p_event_id: eventId,
    p_dry_run: true,
  });
  if (error) {
    console.error('Error counting missing confirmations', error);
    throw describeRpcError(error);
  }
  return data ?? 0;
};

/** Queue a confirmation for every paid entry that has never had one. Returns how many. */
export const queueMissingConfirmations = async (eventId) => {
  const { data, error } = await supabase.rpc('admin_queue_missing_confirmations', {
    p_event_id: eventId,
    p_dry_run: false,
  });
  if (error) {
    console.error('Error queueing missing confirmations', error);
    throw describeRpcError(error);
  }
  return data ?? 0;
};
