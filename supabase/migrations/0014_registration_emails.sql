-- 0014_registration_emails.sql
--
-- Run after 0013. Sends every runner an email when their entry is confirmed,
-- and keeps a per-recipient record of whether it was actually delivered.
--
-- Until now nothing emailed a runner. The success screen showed their bib, and
-- if they closed the tab that was the only record they ever had.
--
-- The design is an outbox:
--
--   1. Triggers on registrations and registration_groups queue a row in
--      public.email_messages the moment an entry becomes PAID -- by Razorpay,
--      by a 100% coupon, or by an organiser marking it paid in the admin
--      panel. Because the trigger is on the table, every path is covered,
--      including ones added later. With online payment off, the person who
--      registered also gets a "received, payment pending" email straight away.
--   2. The send-emails edge function drains the queue through Resend. The
--      database pokes it with pg_net when a row is queued, and pg_cron pokes
--      it every minute while anything is waiting -- which is what retries a
--      failed send and resumes after Resend's daily limit.
--   3. The resend-webhook edge function receives Resend's delivery events
--      (delivered, bounced, complained, ...) and moves each row on. Every event
--      is also kept in public.email_events as the raw log.
--
-- Email is never allowed to break a registration or a payment: if queueing or
-- poking fails, the entry is saved anyway and the failure is only a warning.
--
-- Safe to re-run.

-- ── 1. Per-event settings ───────────────────────────────────────────────────
alter table public.events
  add column if not exists confirmation_emails_enabled boolean not null default true,
  add column if not exists confirmation_email_note     text;

comment on column public.events.confirmation_emails_enabled is
  'When true, runners are emailed automatically when their entry is confirmed (and, with online payment off, when it is received). Turning it off stops new emails being queued; anything already queued still goes.';
comment on column public.events.confirmation_email_note is
  'Optional race-day information printed in every confirmation email: kit collection, reporting time, what to bring. Plain text; line breaks are kept.';

-- ── 2. One row per email to one person ──────────────────────────────────────
create table if not exists public.email_messages (
  id               uuid primary key default gen_random_uuid(),
  event_id         text references public.events (id) on delete cascade,

  kind             text not null
                   check (kind in ('REGISTRATION_CONFIRMED', 'REGISTRATION_RECEIVED',
                                   'GROUP_CONFIRMED', 'GROUP_RECEIVED')),

  -- What the email is about. SET NULL rather than CASCADE so the record that
  -- an email went out survives an entry being deleted.
  registration_id  uuid references public.registrations (id) on delete set null,
  group_id         uuid references public.registration_groups (id) on delete set null,

  to_email         text not null,
  to_name          text,
  subject          text,

  status           text not null default 'QUEUED'
                   check (status in ('QUEUED', 'SENDING', 'SENT', 'DELAYED', 'DELIVERED',
                                     'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED', 'CANCELLED')),
  attempts         integer not null default 0,   -- calls to Resend; each has its own idempotency key
  failures         integer not null default 0,   -- transient failures, counted towards giving up
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  last_error       text,

  provider_id      text,                  -- Resend's email id
  queued_by        text not null default 'system' check (queued_by in ('system', 'admin')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sent_at          timestamptz,
  delivered_at     timestamptz,
  opened_at        timestamptz,
  failed_at        timestamptz
);

comment on table public.email_messages is
  'Outbox and delivery log for registration emails, one row per recipient. Queued by triggers, sent by the send-emails edge function, advanced by resend-webhook. Admin-read-only.';
comment on column public.email_messages.status is
  'QUEUED = waiting to send (see next_attempt_at). SENDING = a dispatcher has it. SENT = Resend accepted it. DELAYED = the receiving server is deferring it. DELIVERED = the receiving server accepted it. BOUNCED / COMPLAINED / SUPPRESSED = it did not reach the inbox, or was reported as spam; fix the address and send again. FAILED = could not be sent; last_error says why. CANCELLED = not sent because the entry was no longer confirmed by the time it came up.';
comment on column public.email_messages.opened_at is
  'Only filled in if open tracking is switched on for the sending domain in Resend. Image blocking and Apple Mail Privacy Protection make it unreliable either way: DELIVERED is the figure to trust.';

create index if not exists email_messages_due_idx
  on public.email_messages (next_attempt_at)
  where status in ('QUEUED', 'SENDING');
create index if not exists email_messages_event_idx
  on public.email_messages (event_id, created_at desc);
create index if not exists email_messages_registration_idx
  on public.email_messages (registration_id, kind) where registration_id is not null;
create index if not exists email_messages_group_idx
  on public.email_messages (group_id, kind) where group_id is not null;
create index if not exists email_messages_provider_idx
  on public.email_messages (provider_id) where provider_id is not null;

-- ── 3. Every delivery event Resend reports, as received ─────────────────────
create table if not exists public.email_events (
  id           bigint generated always as identity primary key,
  webhook_id   text not null unique,     -- svix-id; a redelivery repeats it
  message_id   uuid references public.email_messages (id) on delete cascade,
  provider_id  text,
  type         text not null,
  detail       text,
  occurred_at  timestamptz,
  received_at  timestamptz not null default now(),
  payload      jsonb
);

comment on table public.email_events is
  'Raw Resend webhook events. message_id is NULL for events about email this table does not track, such as the admin bulk sends.';

create index if not exists email_events_message_idx
  on public.email_events (message_id, received_at);

-- ── 4. Where the dispatcher lives ───────────────────────────────────────────
-- The database cannot work out its own edge-function URL, so send-emails
-- writes it here every time it runs. Until it has run once, nothing pokes it
-- automatically; the admin Deliveries view says so, and its "Process queue
-- now" button runs it (which also registers it).
create table if not exists public.email_settings (
  id            integer primary key default 1 check (id = 1),
  dispatch_url  text,
  updated_at    timestamptz not null default now()
);

insert into public.email_settings (id) values (1) on conflict (id) do nothing;

-- ── 5. Queue on confirmation ────────────────────────────────────────────────
-- One automatic email of each kind per entry, ever. An organiser who flips an
-- entry to PENDING and back to PAID does not send the runner a second copy;
-- "Send again" in the admin panel is for that.
create or replace function public._queue_registration_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind    text;
  v_enabled boolean;
begin
  if new.payment_status = 'PAID'
     and (tg_op = 'INSERT' or old.payment_status is distinct from 'PAID') then
    v_kind := 'REGISTRATION_CONFIRMED';
  elsif tg_op = 'INSERT'
        and new.payment_status = 'PENDING'
        and new.payment_due_at is null     -- online payment off: no checkout follows
        and new.group_id is null then      -- a group's coordinator hears instead
    v_kind := 'REGISTRATION_RECEIVED';
  else
    return null;
  end if;

  if nullif(btrim(coalesce(new.email, '')), '') is null then
    return null;
  end if;

  select confirmation_emails_enabled into v_enabled
    from public.events where id = new.event_id;
  if v_enabled is false then
    return null;
  end if;

  begin
    insert into public.email_messages (event_id, kind, registration_id, group_id, to_email, to_name)
    select new.event_id, v_kind, new.id, new.group_id, lower(btrim(new.email)),
           nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), '')
     where not exists (
       select 1 from public.email_messages
        where registration_id = new.id and kind = v_kind
     );
  exception when others then
    -- The entry matters more than its email.
    raise warning 'Could not queue % email for registration %: %', v_kind, new.id, sqlerrm;
  end;

  return null;
end $$;

drop trigger if exists registrations_queue_email on public.registrations;
create trigger registrations_queue_email
  after insert or update of payment_status on public.registrations
  for each row execute function public._queue_registration_email();

create or replace function public._queue_group_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind    text;
  v_enabled boolean;
begin
  if new.payment_status = 'PAID'
     and (tg_op = 'INSERT' or old.payment_status is distinct from 'PAID') then
    v_kind := 'GROUP_CONFIRMED';
  elsif tg_op = 'INSERT'
        and new.payment_status = 'PENDING'
        and new.payment_due_at is null then
    v_kind := 'GROUP_RECEIVED';
  else
    return null;
  end if;

  if nullif(btrim(coalesce(new.captain_email, '')), '') is null then
    return null;
  end if;

  select confirmation_emails_enabled into v_enabled
    from public.events where id = new.event_id;
  if v_enabled is false then
    return null;
  end if;

  begin
    insert into public.email_messages (event_id, kind, group_id, to_email, to_name)
    select new.event_id, v_kind, new.id, lower(btrim(new.captain_email)),
           nullif(btrim(concat_ws(' ', new.captain_first_name, new.captain_last_name)), '')
     where not exists (
       select 1 from public.email_messages
        where group_id = new.id and kind = v_kind
     );
  exception when others then
    raise warning 'Could not queue % email for group %: %', v_kind, new.id, sqlerrm;
  end;

  return null;
end $$;

drop trigger if exists registration_groups_queue_email on public.registration_groups;
create trigger registration_groups_queue_email
  after insert or update of payment_status on public.registration_groups
  for each row execute function public._queue_group_email();

-- ── 6. Poking the dispatcher ────────────────────────────────────────────────
-- pg_net queues the HTTP request inside the transaction and sends it after
-- commit, so a registration that rolls back never triggers a send, and the
-- dispatcher always finds the rows it was called for.
create or replace function public.kick_email_dispatch()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
begin
  select dispatch_url into v_url from public.email_settings where id = 1;

  if v_url is null or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    return false;
  end if;

  perform net.http_post(
    url                  := v_url,
    body                 := '{}'::jsonb,
    headers              := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 5000
  );
  return true;
exception when others then
  raise warning 'Could not poke the email dispatcher: %', sqlerrm;
  return false;
end $$;

comment on function public.kick_email_dispatch() is
  'Asks the send-emails edge function to drain the queue, through pg_net. Returns false, harmlessly, when pg_net is not enabled or the dispatcher has not registered its URL yet.';

-- Once per transaction: settling a group queues a row per runner across
-- several statements, and one poke drains them all.
create or replace function public._kick_after_queue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('goda.email_kicked', true) is distinct from 'on' then
    perform set_config('goda.email_kicked', 'on', true);
    perform public.kick_email_dispatch();
  end if;
  return null;
end $$;

-- INSERT only. The dispatcher's own updates must not poke it again, or every
-- send would schedule another run.
drop trigger if exists email_messages_kick on public.email_messages;
create trigger email_messages_kick
  after insert on public.email_messages
  for each statement execute function public._kick_after_queue();

-- ── 7. The dispatcher's side (service_role only) ────────────────────────────
create or replace function public.register_email_dispatcher(p_url text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.email_settings
     set dispatch_url = p_url, updated_at = now()
   where id = 1 and dispatch_url is distinct from p_url;
$$;

-- Takes up to p_limit due rows and marks them SENDING. SKIP LOCKED lets two
-- dispatcher runs overlap without sending anything twice.
--
-- The dispatcher sends with Idempotency-Key "<id>/<attempts>", and Resend
-- answers a repeated key from the last 24 hours with the original email
-- instead of sending again. So `attempts` goes up for every genuine new try --
-- otherwise a retry after a failure would be swallowed as a duplicate -- but
-- not when a row stuck in SENDING for ten minutes is taken again: that run may
-- have crashed after Resend accepted the email, and reusing its key is what
-- stops the runner getting it twice.
create or replace function public.claim_email_messages(p_limit integer default 20)
returns setof public.email_messages
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.email_messages m
     set status     = 'SENDING',
         claimed_at = now(),
         attempts   = case when m.status = 'SENDING' then m.attempts else m.attempts + 1 end,
         updated_at = now()
   where m.id in (
     select id from public.email_messages
      where (status = 'QUEUED' and next_attempt_at <= now())
         or (status = 'SENDING' and claimed_at < now() - interval '10 minutes')
      order by next_attempt_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
      for update skip locked
   )
  returning m.*;
$$;

-- A delivery webhook can beat this call when delivery is quick, so the status
-- only moves on from SENDING; a row already DELIVERED stays DELIVERED.
create or replace function public.record_email_sent(
  p_id          uuid,
  p_provider_id text,
  p_subject     text,
  p_to_email    text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.email_messages
     set status      = case when status = 'SENDING' then 'SENT' else status end,
         provider_id = coalesce(p_provider_id, provider_id),
         subject     = p_subject,
         to_email    = coalesce(p_to_email, to_email),
         sent_at     = coalesce(sent_at, now()),
         claimed_at  = null,
         last_error  = case when status = 'SENDING' then null else last_error end,
         updated_at  = now()
   where id = p_id;
$$;

-- Back to the queue for another try at p_retry_at. A wait that is not the
-- message's fault -- Resend's daily limit, say -- is not counted as a failure.
create or replace function public.record_email_deferred(
  p_id            uuid,
  p_error         text,
  p_retry_at      timestamptz,
  p_count_failure boolean default true
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.email_messages
     set status          = 'QUEUED',
         next_attempt_at = p_retry_at,
         failures        = failures + case when p_count_failure then 1 else 0 end,
         last_error      = left(p_error, 1000),
         claimed_at      = null,
         updated_at      = now()
   where id = p_id and status = 'SENDING';
$$;

-- Give up: FAILED (could not be sent) or CANCELLED (no longer applies).
create or replace function public.record_email_closed(p_id uuid, p_status text, p_error text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.email_messages
     set status     = p_status,
         last_error = left(p_error, 1000),
         failed_at  = case when p_status = 'FAILED' then now() else failed_at end,
         claimed_at = null,
         updated_at = now()
   where id = p_id
     and status = 'SENDING'
     and p_status in ('FAILED', 'CANCELLED');
$$;

-- ── 8. Delivery events (service_role only) ──────────────────────────────────
-- Webhooks arrive out of order and more than once, so a status only ever moves
-- forward. A bounce or complaint outranks DELIVERED because it can follow it.
create or replace function public._email_status_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'QUEUED'     then 0
    when 'SENDING'    then 1
    when 'SENT'       then 2
    when 'DELAYED'    then 3
    when 'DELIVERED'  then 4
    when 'CANCELLED'  then 0
    else 5            -- BOUNCED, COMPLAINED, SUPPRESSED, FAILED
  end;
$$;

create or replace function public.apply_email_event(
  p_webhook_id  text,
  p_type        text,
  p_provider_id text,
  p_message_id  uuid,
  p_occurred_at timestamptz,
  p_detail      text,
  p_payload     jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg    public.email_messages%rowtype;
  v_status text;
  v_event  bigint;
  v_at     timestamptz := coalesce(p_occurred_at, now());
begin
  -- Matched by our own id, which every email carries as a tag, so an event that
  -- arrives before record_email_sent() still finds its row. Resend's id is the
  -- fallback.
  if p_message_id is not null then
    select * into v_msg from public.email_messages where id = p_message_id for update;
  end if;
  if v_msg.id is null and p_provider_id is not null then
    select * into v_msg from public.email_messages
     where provider_id = p_provider_id
     order by created_at desc limit 1
       for update;
  end if;

  insert into public.email_events (webhook_id, message_id, provider_id, type, detail, occurred_at, payload)
  values (p_webhook_id, v_msg.id, p_provider_id, p_type, left(p_detail, 1000), p_occurred_at, p_payload)
  on conflict (webhook_id) do nothing
  returning id into v_event;

  if v_event is null then
    return 'DUPLICATE';
  end if;
  if v_msg.id is null then
    return 'UNTRACKED';
  end if;

  -- Resend can accept an email and then fail it for being over the plan's
  -- daily quota. That is not the message's fault: queue it for later, as the
  -- dispatcher does when the API refuses outright.
  if p_type = 'email.failed' and p_detail ilike '%quota%'
     and v_msg.status in ('SENDING', 'SENT') then
    update public.email_messages
       set status = 'QUEUED', next_attempt_at = now() + interval '1 hour',
           claimed_at = null, provider_id = null,
           last_error = 'Resend''s sending limit was reached; will try again. (' || left(p_detail, 200) || ')',
           updated_at = now()
     where id = v_msg.id;
    return 'QUEUED';
  end if;

  v_status := case p_type
    when 'email.sent'             then 'SENT'
    when 'email.delivery_delayed' then 'DELAYED'
    when 'email.delivered'        then 'DELIVERED'
    when 'email.opened'           then 'DELIVERED'   -- it can only be opened if it arrived
    when 'email.clicked'          then 'DELIVERED'
    when 'email.bounced'          then 'BOUNCED'
    when 'email.complained'       then 'COMPLAINED'
    when 'email.suppressed'       then 'SUPPRESSED'
    when 'email.failed'           then 'FAILED'
  end;

  update public.email_messages
     set status       = case when v_status is not null
                              and public._email_status_rank(v_status) > public._email_status_rank(status)
                             then v_status else status end,
         provider_id  = coalesce(provider_id, p_provider_id),
         sent_at      = case when v_status in ('SENT', 'DELAYED', 'DELIVERED', 'BOUNCED', 'COMPLAINED')
                              and sent_at is null then v_at else sent_at end,
         delivered_at = case when v_status = 'DELIVERED' then coalesce(delivered_at, v_at) else delivered_at end,
         opened_at    = case when p_type in ('email.opened', 'email.clicked')
                             then coalesce(opened_at, v_at) else opened_at end,
         failed_at    = case when v_status in ('BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED')
                             then coalesce(failed_at, v_at) else failed_at end,
         last_error   = case when v_status in ('BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'FAILED', 'DELAYED')
                              and p_detail is not null
                             then left(p_detail, 1000) else last_error end,
         claimed_at   = case when v_status is not null then null else claimed_at end,
         updated_at   = now()
   where id = v_msg.id
  returning status into v_status;

  return v_status;
end $$;

comment on function public.apply_email_event(text, text, text, uuid, timestamptz, text, jsonb) is
  'Records one Resend webhook event and moves its message forward. Idempotent on the webhook id; a status never moves backwards.';

-- ── 9. Organiser actions ────────────────────────────────────────────────────
-- "Send again". A message that never went out (FAILED, CANCELLED) is put back
-- in the queue as it is; one that went out but did not land is sent as a new
-- message, so the log keeps both. Either way it goes to the address on the
-- entry now, so correcting a typo in the Registrations tab and pressing this
-- is the whole fix for a bounce.
create or replace function public.admin_resend_email(p_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_msg   public.email_messages%rowtype;
  v_email text;
  v_name  text;
  v_id    uuid;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select * into v_msg from public.email_messages where id = p_message_id for update;
  if not found then
    raise exception 'MESSAGE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_msg.status in ('QUEUED', 'SENDING') then
    raise exception 'ALREADY_QUEUED' using errcode = 'P0001';
  end if;

  if v_msg.kind like 'REGISTRATION_%' then
    select lower(btrim(email)), nullif(btrim(concat_ws(' ', first_name, last_name)), '')
      into v_email, v_name
      from public.registrations where id = v_msg.registration_id;
  else
    select lower(btrim(captain_email)), nullif(btrim(concat_ws(' ', captain_first_name, captain_last_name)), '')
      into v_email, v_name
      from public.registration_groups where id = v_msg.group_id;
  end if;

  if v_email is null then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_msg.status in ('FAILED', 'CANCELLED') then
    -- `attempts` is left alone on purpose: the next try must use a new
    -- idempotency key, or Resend would return the earlier attempt unsent.
    update public.email_messages
       set status = 'QUEUED', failures = 0, next_attempt_at = now(),
           last_error = null, failed_at = null, claimed_at = null,
           to_email = v_email, to_name = v_name, queued_by = 'admin', updated_at = now()
     where id = v_msg.id;
    v_id := v_msg.id;
    -- An UPDATE does not fire the insert-time poke.
    perform public.kick_email_dispatch();
  else
    insert into public.email_messages (event_id, kind, registration_id, group_id, to_email, to_name, queued_by)
    values (v_msg.event_id, v_msg.kind, v_msg.registration_id, v_msg.group_id, v_email, v_name, 'admin')
    returning id into v_id;
  end if;

  return v_id;
end $$;

comment on function public.admin_resend_email(uuid) is
  'Admin only. Sends a registration email again, to the address currently on the entry. Requeues a FAILED or CANCELLED message in place; otherwise queues a new message. Returns the queued message id.';

-- Confirmations for paid entries that never had one: everyone who paid before
-- this migration, and anyone confirmed while emails were switched off. With
-- p_dry_run (the default) it only counts, so the panel can say how many before
-- anything is sent.
create or replace function public.admin_queue_missing_confirmations(
  p_event_id text,
  p_dry_run  boolean default true
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_solo  integer;
  v_group integer;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if p_dry_run then
    select count(*) into v_solo
      from public.registrations r
     where r.event_id = p_event_id and r.payment_status = 'PAID'
       and nullif(btrim(coalesce(r.email, '')), '') is not null
       and not exists (select 1 from public.email_messages m
                        where m.registration_id = r.id and m.kind = 'REGISTRATION_CONFIRMED');

    select count(*) into v_group
      from public.registration_groups g
     where g.event_id = p_event_id and g.payment_status = 'PAID'
       and nullif(btrim(coalesce(g.captain_email, '')), '') is not null
       and not exists (select 1 from public.email_messages m
                        where m.group_id = g.id and m.kind = 'GROUP_CONFIRMED');

    return v_solo + v_group;
  end if;

  insert into public.email_messages (event_id, kind, registration_id, group_id, to_email, to_name, queued_by)
  select r.event_id, 'REGISTRATION_CONFIRMED', r.id, r.group_id, lower(btrim(r.email)),
         nullif(btrim(concat_ws(' ', r.first_name, r.last_name)), ''), 'admin'
    from public.registrations r
   where r.event_id = p_event_id and r.payment_status = 'PAID'
     and nullif(btrim(coalesce(r.email, '')), '') is not null
     and not exists (select 1 from public.email_messages m
                      where m.registration_id = r.id and m.kind = 'REGISTRATION_CONFIRMED')
   order by r.created_at;
  get diagnostics v_solo = row_count;

  insert into public.email_messages (event_id, kind, group_id, to_email, to_name, queued_by)
  select g.event_id, 'GROUP_CONFIRMED', g.id, lower(btrim(g.captain_email)),
         nullif(btrim(concat_ws(' ', g.captain_first_name, g.captain_last_name)), ''), 'admin'
    from public.registration_groups g
   where g.event_id = p_event_id and g.payment_status = 'PAID'
     and nullif(btrim(coalesce(g.captain_email, '')), '') is not null
     and not exists (select 1 from public.email_messages m
                      where m.group_id = g.id and m.kind = 'GROUP_CONFIRMED')
   order by g.created_at;
  get diagnostics v_group = row_count;

  return v_solo + v_group;
end $$;

comment on function public.admin_queue_missing_confirmations(text, boolean) is
  'Admin only. Counts (p_dry_run, the default) or queues confirmation emails for PAID entries and groups in the event that have never had one. Returns the number.';

-- ── 10. Who may call what ───────────────────────────────────────────────────
-- As in 0011: Supabase grants EXECUTE on new public functions to anon and
-- authenticated directly, so PUBLIC alone is not enough to revoke.
revoke all on function public._queue_registration_email()                       from public, anon, authenticated;
revoke all on function public._queue_group_email()                              from public, anon, authenticated;
revoke all on function public._kick_after_queue()                               from public, anon, authenticated;
revoke all on function public.kick_email_dispatch()                             from public, anon, authenticated;
revoke all on function public.register_email_dispatcher(text)                   from public, anon, authenticated;
revoke all on function public.claim_email_messages(integer)                     from public, anon, authenticated;
revoke all on function public.record_email_sent(uuid, text, text, text)         from public, anon, authenticated;
revoke all on function public.record_email_deferred(uuid, text, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.record_email_closed(uuid, text, text)             from public, anon, authenticated;
revoke all on function public.apply_email_event(text, text, text, uuid, timestamptz, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_resend_email(uuid)                          from public, anon, authenticated;
revoke all on function public.admin_queue_missing_confirmations(text, boolean)  from public, anon, authenticated;

grant execute on function public.register_email_dispatcher(text)                   to service_role;
grant execute on function public.claim_email_messages(integer)                     to service_role;
grant execute on function public.record_email_sent(uuid, text, text, text)         to service_role;
grant execute on function public.record_email_deferred(uuid, text, timestamptz, boolean) to service_role;
grant execute on function public.record_email_closed(uuid, text, text)             to service_role;
grant execute on function public.apply_email_event(text, text, text, uuid, timestamptz, text, jsonb) to service_role;
grant execute on function public.kick_email_dispatch()                             to service_role;

grant execute on function public.admin_resend_email(uuid)                          to authenticated;
grant execute on function public.admin_queue_missing_confirmations(text, boolean)  to authenticated;

-- ── 11. Lock the new tables down ────────────────────────────────────────────
-- Admins read; nobody writes except through the functions above. These tables
-- are deliberately left out of _managed_tables(): re-running 0009 would drop
-- their policies without rebuilding them.
alter table public.email_messages enable row level security;
alter table public.email_events   enable row level security;
alter table public.email_settings enable row level security;

do $$
declare
  t   text;
  pol record;
begin
  foreach t in array array['email_messages', 'email_events', 'email_settings'] loop
    for pol in
      select policyname from pg_policies where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_admin_read', t
    );
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;

-- ── 12. pg_net and pg_cron ──────────────────────────────────────────────────
-- Both are on Supabase's allow-list. Enabling them here saves a trip to the
-- dashboard; if the role is not allowed to, the notice says what to do and
-- everything else in this file still applies.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin
      create extension if not exists pg_net with schema extensions;
    exception when others then
      raise notice 'Could not enable pg_net (%). Enable it under Database -> Extensions and re-run this file.', sqlerrm;
    end;
  else
    raise notice 'pg_net is not available here; emails are sent when an admin presses "Process queue now".';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'Could not enable pg_cron (%). Enable it under Database -> Extensions and re-run this file.', sqlerrm;
    end;
  end if;
end $$;

-- Every minute, but an HTTP call only when something is due, so a quiet
-- queue costs no function invocations.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'goda-email-dispatch') then
      perform cron.unschedule('goda-email-dispatch');
    end if;
    perform cron.schedule(
      'goda-email-dispatch',
      '* * * * *',
      $cron$
        select public.kick_email_dispatch()
         where exists (
           select 1 from public.email_messages
            where (status = 'QUEUED' and next_attempt_at <= now())
               or (status = 'SENDING' and claimed_at < now() - interval '10 minutes')
         )
      $cron$
    );

    -- 0011 schedules this only if pg_cron was already on when it ran. It may
    -- have been switched on just now.
    if not exists (select 1 from cron.job where jobname = 'goda-expire-unpaid-holds') then
      perform cron.schedule(
        'goda-expire-unpaid-holds',
        '*/5 * * * *',
        'select public.expire_unpaid_holds()'
      );
    end if;

    raise notice 'Scheduled the email dispatcher every minute with pg_cron.';
  else
    raise notice 'pg_cron is not enabled; failed sends are retried only when the next email is queued or an admin presses "Process queue now".';
  end if;
end $$;

-- ── 13. Assert the result ───────────────────────────────────────────────────
do $$
declare
  bad      text;
  problems text := '';
begin
  for bad in
    select format('%s.%s', table_name, privilege_type)
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('email_messages', 'email_events', 'email_settings')
       and grantee = 'anon'
  loop
    problems := problems || E'\n  - anon still has ' || bad;
  end loop;

  for bad in
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('claim_email_messages', 'record_email_sent', 'record_email_deferred',
                         'record_email_closed', 'apply_email_event', 'register_email_dispatcher',
                         'kick_email_dispatch')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    problems := problems || E'\n  - callable with the public key: ' || bad || '()';
  end loop;

  if problems <> '' then
    raise exception 'Migration 0014 left these open:%', problems;
  end if;
end $$;
