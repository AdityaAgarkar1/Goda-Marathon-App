-- 0011_razorpay_payments.sql
--
-- Run after 0010. Online payment through Razorpay.
--
-- Until now every entry was saved as PENDING and the organisers collected the
-- money by hand. This is the database half of a Razorpay Standard Checkout
-- integration; the other half is three edge functions in supabase/functions/
-- (razorpay-order, razorpay-verify, razorpay-webhook).
--
-- The flow:
--
--   1. create_registration() / create_group_registration() save the entry as
--      before. With online payment switched on for the event, the entry is a
--      RESERVATION: it holds its place and its bib for payment_hold_minutes
--      (default 30), recorded in payment_due_at.
--   2. razorpay-order asks prepare_payment() what is owed -- read from the
--      stored row, never from the browser -- creates a Razorpay order for that
--      amount and records it with record_payment_order().
--   3. The browser opens Razorpay Checkout for that order.
--   4. razorpay-verify (the browser's success callback) and razorpay-webhook
--      (Razorpay's server-to-server notification) both end in
--      confirm_payment(), which marks the entry PAID. Either one alone is
--      enough; both arriving is harmless, because confirm_payment() is
--      idempotent on the Razorpay payment id. The webhook is what saves the
--      entry when the runner pays and then closes the tab before the browser
--      callback runs.
--   5. A reservation nobody paid for is released by expire_unpaid_holds():
--      status CANCELLED, cancelled_reason PAYMENT_TIMEOUT, coupon use handed
--      back. Its place and its email address become free again.
--
-- Safety rails, in the same spirit as 0006-0010:
--
--   * The amount charged is the amount the database priced. The browser sends
--     a registration id; the database looks up what that entry owes.
--   * public.payments is admin-read-only. Every write comes from an edge
--     function holding the service_role key, through functions that neither
--     anon nor authenticated can execute.
--   * Money that arrives for an entry that can no longer take it -- a
--     reservation that expired and whose email has entered again since, an
--     entry an admin cancelled, a second payment for an entry already paid --
--     is never silently absorbed. The payment is recorded as REFUND_REQUIRED
--     with the reason, and the admin Registrations tab lists it.
--
-- Nothing changes for runners until an admin switches on "Online payment" in
-- Admin -> Settings. With it off, entries are PENDING with no deadline,
-- exactly as before.
--
-- If 0009 is ever re-run, re-run 0010 and then this file afterwards: 0009
-- drops every policy on the tables in _managed_tables(), which from here on
-- includes payments.
--
-- Safe to re-run.

-- ── 1. Per-event switch and hold window ─────────────────────────────────────
alter table public.events
  add column if not exists online_payment_enabled boolean not null default false,
  add column if not exists payment_hold_minutes   integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'events_payment_hold_minutes_check'
      and conrelid = 'public.events'::regclass
  ) then
    -- Ten minutes is the floor because a UPI approval on the runner's phone
    -- routinely takes several; three hours is the ceiling because a place held
    -- longer than that is a place someone else could not have.
    alter table public.events
      add constraint events_payment_hold_minutes_check
      check (payment_hold_minutes between 10 and 180);
  end if;
end $$;

comment on column public.events.online_payment_enabled is
  'When true, a new entry is a reservation held for payment_hold_minutes while the runner pays through Razorpay. When false, entries are PENDING with no deadline and the organisers collect payment themselves.';
comment on column public.events.payment_hold_minutes is
  'How long an unpaid online reservation keeps its place before expire_unpaid_holds() releases it.';

-- ── 2. Payment columns on entries and groups ────────────────────────────────
alter table public.registrations
  add column if not exists payment_due_at   timestamptz,
  add column if not exists payment_ref      text,
  add column if not exists paid_at          timestamptz,
  add column if not exists cancelled_reason text;

alter table public.registration_groups
  add column if not exists payment_due_at   timestamptz,
  add column if not exists payment_ref      text,
  add column if not exists paid_at          timestamptz,
  add column if not exists cancelled_reason text;

comment on column public.registrations.payment_due_at is
  'Set only while an online reservation is unpaid. NULL means no deadline: paid, cancelled, or an offline PENDING entry the organisers will chase themselves.';
comment on column public.registrations.payment_ref is
  'Razorpay payment id (pay_...) that settled this entry. Quote it to Razorpay support or when refunding.';
comment on column public.registrations.cancelled_reason is
  'Why the entry is CANCELLED when the system cancelled it. PAYMENT_TIMEOUT = an online reservation that was never paid. NULL for cancellations made by an admin.';
comment on column public.registration_groups.payment_ref is
  'Razorpay payment id (pay_...) that settled the whole group.';

create index if not exists registrations_payment_due_idx
  on public.registrations (payment_due_at)
  where payment_status = 'PENDING' and payment_due_at is not null;

create index if not exists registration_groups_payment_due_idx
  on public.registration_groups (payment_due_at)
  where payment_status = 'PENDING' and payment_due_at is not null;

-- A deadline only means something on an unpaid entry. Clearing it whenever the
-- status moves -- to PAID by a payment, to anything by an admin -- means an
-- admin who marks an entry paid by hand and later flips it back to PENDING by
-- mistake does not find the sweeper cancelling it a minute later.
create or replace function public._clear_payment_deadline()
returns trigger
language plpgsql
as $$
begin
  if new.payment_status is distinct from 'PENDING' then
    new.payment_due_at := null;
  end if;
  return new;
end $$;

drop trigger if exists registrations_clear_payment_deadline on public.registrations;
create trigger registrations_clear_payment_deadline
  before update of payment_status on public.registrations
  for each row execute function public._clear_payment_deadline();

drop trigger if exists registration_groups_clear_payment_deadline on public.registration_groups;
create trigger registration_groups_clear_payment_deadline
  before update of payment_status on public.registration_groups
  for each row execute function public._clear_payment_deadline();

-- ── 3. Switching online payment off keeps the reservations already made ─────
-- If the gateway goes down or the account is put under review, an organiser
-- switches online payment off. The runners who reserved in the last half hour
-- and could not pay should not then be cancelled by the sweeper: their
-- deadlines are lifted and they wait as ordinary PENDING entries for the
-- organisers to collect by hand -- which is what "off" means for new entries
-- too.
create or replace function public._lift_payment_deadlines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.registrations
     set payment_due_at = null
   where event_id = new.id
     and payment_status = 'PENDING'
     and payment_due_at is not null;

  update public.registration_groups
     set payment_due_at = null
   where event_id = new.id
     and payment_status = 'PENDING'
     and payment_due_at is not null;

  return new;
end $$;

drop trigger if exists events_lift_payment_deadlines on public.events;
create trigger events_lift_payment_deadlines
  after update of online_payment_enabled on public.events
  for each row
  when (old.online_payment_enabled and not new.online_payment_enabled)
  execute function public._lift_payment_deadlines();

-- ── 4. Payments ─────────────────────────────────────────────────────────────
-- One row per Razorpay order, plus one per stray payment (see
-- confirm_payment). Written only by the edge functions, via the functions
-- below.
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  event_id            text not null references public.events (id) on delete cascade,

  -- At most one of these. SET NULL rather than CASCADE: the record that money
  -- moved must outlive a hard-deleted entry.
  registration_id     uuid references public.registrations (id) on delete set null,
  group_id            uuid references public.registration_groups (id) on delete set null,

  razorpay_order_id   text not null,
  razorpay_payment_id text,

  amount_paise        integer not null check (amount_paise > 0),
  currency            text not null default 'INR',
  refunded_paise      integer not null default 0,

  status              text not null default 'CREATED'
                      check (status in ('CREATED', 'PAID', 'SUPERSEDED', 'REFUND_REQUIRED', 'REFUNDED')),
  method              text,
  last_error          text,
  note                text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,

  constraint payments_single_target check (registration_id is null or group_id is null)
);

comment on table public.payments is
  'Razorpay orders and payments. Admin-read-only; written by the razorpay-* edge functions through prepare_payment(), record_payment_order(), confirm_payment(), record_payment_failure() and record_refund().';
comment on column public.payments.status is
  'CREATED = order open, awaiting payment. PAID = settled an entry. SUPERSEDED = replaced by a newer order for the same entry. REFUND_REQUIRED = money arrived that no entry could take -- refund it from the Razorpay dashboard; `note` says why. REFUNDED = Razorpay reported the payment fully refunded.';
comment on column public.payments.amount_paise is
  'What the order was for, in paise. Frozen at order time, so a later price edit cannot make an honest payment look short.';

create unique index if not exists payments_razorpay_payment_key
  on public.payments (razorpay_payment_id) where razorpay_payment_id is not null;
create index if not exists payments_order_idx
  on public.payments (razorpay_order_id);
create index if not exists payments_registration_idx
  on public.payments (registration_id) where registration_id is not null;
create index if not exists payments_group_idx
  on public.payments (group_id) where group_id is not null;
create index if not exists payments_attention_idx
  on public.payments (event_id) where status = 'REFUND_REQUIRED';

alter table public.payments enable row level security;

-- ── 5. A cancelled entry no longer holds its email ──────────────────────────
-- 0007 made (event, email) unique across every row, cancelled ones included,
-- while is_email_registered() already ignored cancelled entries. The two
-- disagreed: the form told a runner whose old entry had been cancelled that
-- their email was free, and create_registration() then refused it.
--
-- With online payment that mismatch becomes routine, because every abandoned
-- checkout ends as a cancelled reservation. Someone who closed the payment
-- window and comes back an hour later must be able to enter again with the
-- same address. Uniqueness now applies to entries that are still live.
--
-- Created before the old index is dropped, so there is no moment without one.
create unique index if not exists registrations_event_email_live_key
  on public.registrations (event_id, lower(email))
  where payment_status is distinct from 'CANCELLED';

drop index if exists public.registrations_event_email_key;

-- ── 6. Which entries hold a place, and releasing the ones that do not ───────
-- A lapsed reservation stops holding its place the moment its deadline
-- passes, whether or not the sweeper has visited it yet. The read-side
-- functions below use this, so the "N places left" figure is right between
-- sweeps.
create or replace function public.holds_place(p_status text, p_due timestamptz)
returns boolean
language sql
stable
as $$
  select p_status is distinct from 'CANCELLED'
     and not (p_status = 'PENDING' and p_due is not null and p_due < now());
$$;

comment on function public.holds_place(text, timestamptz) is
  'True if an entry with this status and payment deadline occupies a place: not cancelled, and not an online reservation whose time has run out.';

create or replace function public.expire_unpaid_holds(p_event_id text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r   record;
  v_n integer := 0;
begin
  -- One sweeper at a time. Registrations already queue behind the per-event
  -- bib counter, so this costs nothing in throughput, and two sweeps can
  -- never interleave their row locks and deadlock each other.
  perform pg_advisory_xact_lock(hashtext('goda.expire_unpaid_holds'));

  -- Groups first; their members go with them.
  for r in
    update public.registration_groups
       set payment_status = 'CANCELLED', cancelled_reason = 'PAYMENT_TIMEOUT'
     where payment_status = 'PENDING'
       and payment_due_at is not null
       and payment_due_at < now()
       and (p_event_id is null or event_id = p_event_id)
    returning id, coupon_id
  loop
    update public.registrations
       set payment_status = 'CANCELLED', cancelled_reason = 'PAYMENT_TIMEOUT'
     where group_id = r.id
       and payment_status = 'PENDING';

    -- A group redemption was counted once, so it is handed back once.
    if r.coupon_id is not null then
      update public.coupons
         set uses = greatest(uses - 1, 0), updated_at = now()
       where id = r.coupon_id;
    end if;

    v_n := v_n + 1;
  end loop;

  for r in
    update public.registrations
       set payment_status = 'CANCELLED', cancelled_reason = 'PAYMENT_TIMEOUT'
     where payment_status = 'PENDING'
       and group_id is null
       and payment_due_at is not null
       and payment_due_at < now()
       and (p_event_id is null or event_id = p_event_id)
    returning event_id, coupon_code
  loop
    -- A solo row records its code only when the code paid out (0010), so a
    -- code here is a claimed use that has to be returned.
    if r.coupon_code is not null then
      update public.coupons
         set uses = greatest(uses - 1, 0), updated_at = now()
       where event_id = r.event_id and upper(code) = upper(r.coupon_code);
    end if;

    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

comment on function public.expire_unpaid_holds(text) is
  'Cancels online reservations whose payment deadline has passed (cancelled_reason PAYMENT_TIMEOUT) and returns their coupon uses. Called at the start of every registration, and every five minutes by pg_cron where it is enabled.';

-- ── 7. Read-side functions that must ignore lapsed reservations ─────────────
create or replace function public.is_email_registered(p_email text, p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.registrations r
    where r.event_id = p_event_id
      and lower(r.email) = lower(trim(p_email))
      and public.holds_place(r.payment_status, r.payment_due_at)
  );
$$;

revoke all on function public.is_email_registered(text, text) from public;
grant execute on function public.is_email_registered(text, text) to anon, authenticated;

create or replace function public.get_category_availability(p_event_id text)
returns table (
  category_id   uuid,
  name          text,
  max_slots     integer,
  taken         integer,
  slots_left    integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.name,
    c.max_slots,
    coalesce(t.taken, 0)::integer,
    case
      when c.max_slots is null then null
      else greatest(c.max_slots - coalesce(t.taken, 0), 0)::integer
    end
  from public.event_categories c
  left join (
    select r.category, count(*)::integer as taken
    from public.registrations r
    where r.event_id = p_event_id
      and public.holds_place(r.payment_status, r.payment_due_at)
    group by r.category
  ) t on t.category = c.name
  where c.event_id = p_event_id
  order by c.display_order, c.name;
$$;

revoke all on function public.get_category_availability(text) from public;
grant execute on function public.get_category_availability(text) to anon, authenticated;

-- ── 8. Solo registration, now payment-aware ─────────────────────────────────
-- Replaces the 0010 version. Same validation, same pricing, same coupon rules.
-- What changes: lapsed reservations are swept first; a cancelled entry no
-- longer blocks its email; and with online payment on, the entry carries a
-- payment deadline (or is confirmed outright when nothing is owed).
create or replace function public.create_registration(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event      public.events%rowtype;
  v_category   public.event_categories%rowtype;
  v_taken      integer;
  v_age        integer;
  v_dob        date;
  v_email      text;
  v_bib        text;
  v_row        public.registrations%rowtype;
  v_quote      jsonb;
  v_coupon_id  uuid;
  v_discount   numeric(10, 2) := 0;
  v_status     text := 'PENDING';
  v_due        timestamptz;
begin
  -- ── Event ──
  select * into v_event
  from public.events
  where id = payload->>'event_id';

  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if coalesce(v_event.registration_open, false) is not true then
    raise exception 'REGISTRATION_CLOSED' using errcode = 'P0001';
  end if;

  if v_event.last_registration_date is not null
     and current_date > v_event.last_registration_date then
    raise exception 'REGISTRATION_CLOSED' using errcode = 'P0001';
  end if;

  -- ── Lapsed reservations ──
  -- Release unpaid online reservations whose time ran out before counting
  -- places or checking the email, so an abandoned checkout neither holds a
  -- place nor locks its owner out of trying again.
  perform public.expire_unpaid_holds(v_event.id);

  -- ── Category ──
  select * into v_category
  from public.event_categories
  where event_id = v_event.id
    and name = payload->>'category';

  if not found then
    raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0001';
  end if;

  if coalesce(v_category.status, 'Open') <> 'Open' then
    raise exception 'CATEGORY_UNAVAILABLE' using errcode = 'P0001';
  end if;

  -- ── Capacity ──
  -- Counted inside the same transaction as the insert, so two runners racing
  -- for the last slot cannot both be told they got it.
  if v_category.max_slots is not null then
    select count(*) into v_taken
    from public.registrations
    where event_id = v_event.id
      and category = v_category.name
      and payment_status is distinct from 'CANCELLED';

    if v_taken >= v_category.max_slots then
      raise exception 'CATEGORY_FULL' using errcode = 'P0001';
    end if;
  end if;

  -- ── Eligibility ──
  v_dob := nullif(payload->>'dob', '')::date;
  if v_dob is null then
    raise exception 'DOB_REQUIRED' using errcode = 'P0001';
  end if;
  if v_dob > current_date then
    raise exception 'DOB_INVALID' using errcode = 'P0001';
  end if;

  v_age := date_part('year', age(current_date, v_dob))::integer;

  if v_category.min_age is not null and v_age < v_category.min_age then
    raise exception 'UNDER_MIN_AGE' using errcode = 'P0001';
  end if;

  -- ── Consent ──
  if coalesce((payload->>'waivers_accepted')::boolean, false) is not true then
    raise exception 'WAIVERS_REQUIRED' using errcode = 'P0001';
  end if;

  -- ── Identity ──
  v_email := lower(trim(payload->>'email'));
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'EMAIL_INVALID' using errcode = 'P0001';
  end if;

  -- A cancelled entry -- including a reservation that was never paid -- no
  -- longer holds its email; see section 5.
  if exists (
    select 1 from public.registrations
    where event_id = v_event.id and lower(email) = v_email
      and payment_status is distinct from 'CANCELLED'
  ) then
    raise exception 'ALREADY_REGISTERED' using errcode = '23505';
  end if;

  -- ── Coupon ──
  if nullif(trim(coalesce(payload->>'coupon_code', '')), '') is not null then
    v_quote := public.evaluate_coupon(
      v_event.id, array[v_category.name], payload->>'coupon_code', false
    );

    if (v_quote->>'valid')::boolean then
      v_coupon_id := (v_quote->>'coupon_id')::uuid;
      v_discount  := coalesce((v_quote->>'discount')::numeric, 0);

      -- Claimed before the insert: if the last use was taken in the meantime,
      -- the entry proceeds at full price rather than failing.
      if not public.claim_coupon_use(v_coupon_id) then
        v_coupon_id := null;
        v_discount  := 0;
      end if;
    end if;
  end if;

  -- ── Payment ──
  -- With online payment on, the entry is a reservation until it is paid. An
  -- entry with nothing to pay -- a 100% code -- is confirmed outright: there
  -- is no checkout to send the runner to, since Razorpay refuses a
  -- zero-amount order.
  if coalesce(v_event.online_payment_enabled, false) then
    if greatest(v_category.price - v_discount, 0) <= 0 then
      v_status := 'PAID';
    else
      v_due := now() + make_interval(mins => v_event.payment_hold_minutes);
    end if;
  end if;

  v_bib := public.allocate_bib(v_event.id);

  insert into public.registrations (
    first_name, last_name, email, phone, dob, gender,
    blood_group, emergency_contact_name, emergency_contact_number,
    has_medical_condition, allergies,
    city, state, pincode, club_name,
    category, tshirt_size, estimated_time, coupon_code,
    list_price, discount_amount, price,
    waivers_accepted, waivers_accepted_at,
    event_id, event_name, bib, payment_status,
    payment_due_at, paid_at
  ) values (
    trim(payload->>'first_name'),
    trim(payload->>'last_name'),
    v_email,
    nullif(trim(payload->>'phone'), ''),
    v_dob,
    nullif(payload->>'gender', ''),
    nullif(payload->>'blood_group', ''),
    nullif(trim(payload->>'emergency_contact_name'), ''),
    nullif(trim(payload->>'emergency_contact_number'), ''),
    coalesce((payload->>'has_medical_condition')::boolean, false),
    case when coalesce((payload->>'has_medical_condition')::boolean, false)
         then nullif(trim(payload->>'allergies'), '') end,
    nullif(trim(payload->>'city'), ''),
    nullif(payload->>'state', ''),
    nullif(trim(payload->>'pincode'), ''),
    nullif(trim(payload->>'club_name'), ''),
    v_category.name,
    nullif(payload->>'tshirt_size', ''),
    nullif(trim(payload->>'estimated_time'), ''),
    -- Only a code that actually paid out is recorded, so an organiser reading
    -- the row cannot mistake a rejected code for an honoured one.
    case when v_coupon_id is not null
         then upper(trim(payload->>'coupon_code')) end,
    v_category.price,                    -- from the database, never the browser
    v_discount,
    greatest(v_category.price - v_discount, 0),
    true,
    now(),
    v_event.id,
    v_event.name,
    v_bib,
    v_status,                            -- PENDING unless there is nothing to pay
    v_due,
    case when v_status = 'PAID' then now() end
  )
  returning * into v_row;

  return jsonb_build_object(
    'id',             v_row.id,
    'bib',            v_row.bib,
    'first_name',     v_row.first_name,
    'last_name',      v_row.last_name,
    'email',          v_row.email,
    'category',       v_row.category,
    'list_price',     v_row.list_price,
    'discount',       v_row.discount_amount,
    'price',          v_row.price,
    'coupon_code',    v_row.coupon_code,
    'payment_status', v_row.payment_status,
    'payment_due_at', v_row.payment_due_at,
    'event_name',     v_row.event_name
  );
end $$;

revoke all on function public.create_registration(jsonb) from public;
grant execute on function public.create_registration(jsonb) to anon, authenticated;

comment on function public.create_registration(jsonb) is
  'The public solo registration entry point. Validates event, category, capacity, age and consent, prices from event_categories, applies any valid coupon, allocates a collision-free bib and inserts as PENDING -- a reservation with a payment deadline when online payment is on, PAID outright if nothing is owed. Never trust the client for price or eligibility.';

-- ── 9. Group registration, now payment-aware ────────────────────────────────
-- Replaces the 0010 version, with the same three changes as the solo function.
-- The group row and every member share one deadline and are settled together.
create or replace function public.create_group_registration(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event        public.events%rowtype;
  v_category     public.event_categories%rowtype;
  v_participants jsonb;
  v_p            jsonb;
  v_count        integer;
  v_i            integer;
  v_label        text;

  v_categories   text[] := '{}';
  v_prices       numeric(10, 2)[] := '{}';
  v_eligible     boolean[] := '{}';
  v_emails       text[] := '{}';
  v_dobs         date[] := '{}';

  v_email        text;
  v_dob          date;
  v_age          integer;
  v_cat_name     text;
  v_taken        integer;
  v_wanted       integer;

  v_quote        jsonb;
  v_coupon_id    uuid;
  v_coupon_code  text;
  v_applies      text[];
  v_subtotal     numeric(10, 2) := 0;
  v_eligible_sum numeric(10, 2) := 0;
  v_discount     numeric(10, 2) := 0;
  v_allocated    numeric(10, 2) := 0;
  v_share        numeric(10, 2);
  v_first_elig   integer := null;

  v_captain_email text;
  v_group_id     uuid;
  v_group_code   text;
  v_bib          text;
  v_results      jsonb := '[]'::jsonb;
  v_row          public.registrations%rowtype;
  v_status       text := 'PENDING';
  v_due          timestamptz;
begin
  -- ── Event ──
  select * into v_event
  from public.events
  where id = payload->>'event_id';

  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if coalesce(v_event.registration_open, false) is not true then
    raise exception 'REGISTRATION_CLOSED' using errcode = 'P0001';
  end if;

  if v_event.last_registration_date is not null
     and current_date > v_event.last_registration_date then
    raise exception 'REGISTRATION_CLOSED' using errcode = 'P0001';
  end if;

  -- ── Lapsed reservations ──
  -- Release unpaid online reservations whose time ran out before counting
  -- places or checking the email, so an abandoned checkout neither holds a
  -- place nor locks its owner out of trying again.
  perform public.expire_unpaid_holds(v_event.id);

  -- ── Consent ──
  -- The captain accepts the declarations on the team's behalf and confirms
  -- they are authorised to do so. Without that the entries have no legal
  -- standing, exactly as in the solo flow.
  if coalesce((payload->>'waivers_accepted')::boolean, false) is not true then
    raise exception 'WAIVERS_REQUIRED' using errcode = 'P0001';
  end if;

  -- ── Captain ──
  if nullif(trim(coalesce(payload#>>'{captain,first_name}', '')), '') is null then
    raise exception 'CAPTAIN_NAME_REQUIRED' using errcode = 'P0001';
  end if;

  v_captain_email := lower(trim(coalesce(payload#>>'{captain,email}', '')));
  if v_captain_email = '' or v_captain_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'CAPTAIN_EMAIL_INVALID' using errcode = 'P0001';
  end if;

  if nullif(trim(coalesce(payload#>>'{captain,phone}', '')), '') is null then
    raise exception 'CAPTAIN_PHONE_REQUIRED' using errcode = 'P0001';
  end if;

  -- ── Participants ──
  v_participants := coalesce(payload->'participants', '[]'::jsonb);
  v_count := jsonb_array_length(v_participants);

  -- Two is the point at which this form exists at all; below that the solo
  -- flow is the better experience. The upper bound keeps one submission from
  -- holding row locks on every category while it inserts.
  if v_count < 2 then
    raise exception 'GROUP_TOO_SMALL' using errcode = 'P0001';
  end if;
  if v_count > 50 then
    raise exception 'GROUP_TOO_LARGE' using errcode = 'P0001';
  end if;

  -- Pass one: validate everybody and collect the basket. Nothing is written
  -- until every participant has passed, so a bad row on the twentieth entrant
  -- leaves no trace of the first nineteen.
  for v_i in 0 .. v_count - 1 loop
    v_p := v_participants -> v_i;

    -- Used in the error DETAIL so the form can point at the right row.
    v_label := trim(coalesce(v_p->>'first_name', '') || ' ' || coalesce(v_p->>'last_name', ''));
    if v_label = '' then v_label := 'Participant ' || (v_i + 1); end if;

    if nullif(trim(coalesce(v_p->>'first_name', '')), '') is null then
      raise exception 'PARTICIPANT_NAME_REQUIRED' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label)::text;
    end if;

    -- Email: each participant gets their own confirmation and results lookup,
    -- so a shared address would make two runners indistinguishable.
    v_email := lower(trim(coalesce(v_p->>'email', '')));
    if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'PARTICIPANT_EMAIL_INVALID' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label)::text;
    end if;

    -- Within the group: caught here rather than by the unique index, which
    -- would surface as an opaque 23505 naming neither runner.
    if v_email = any (v_emails) then
      raise exception 'DUPLICATE_EMAIL_IN_GROUP' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label, 'email', v_email)::text;
    end if;

    -- ...and against everyone already entered for this event, solo or group.
    if exists (
      select 1 from public.registrations
      where event_id = v_event.id and lower(email) = v_email
        and payment_status is distinct from 'CANCELLED'
    ) then
      raise exception 'ALREADY_REGISTERED' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label, 'email', v_email)::text;
    end if;

    v_dob := nullif(v_p->>'dob', '')::date;
    if v_dob is null then
      raise exception 'DOB_REQUIRED' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label)::text;
    end if;
    if v_dob > current_date then
      raise exception 'DOB_INVALID' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label)::text;
    end if;

    v_cat_name := v_p->>'category';
    select * into v_category
    from public.event_categories
    where event_id = v_event.id and name = v_cat_name;

    if not found then
      raise exception 'CATEGORY_NOT_FOUND' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label, 'category', v_cat_name)::text;
    end if;

    if coalesce(v_category.status, 'Open') <> 'Open' then
      raise exception 'CATEGORY_UNAVAILABLE' using errcode = 'P0001',
        detail = jsonb_build_object('index', v_i, 'name', v_label, 'category', v_cat_name)::text;
    end if;

    v_age := date_part('year', age(current_date, v_dob))::integer;
    if v_category.min_age is not null and v_age < v_category.min_age then
      raise exception 'UNDER_MIN_AGE' using errcode = 'P0001',
        detail = jsonb_build_object(
          'index', v_i, 'name', v_label,
          'category', v_cat_name, 'min_age', v_category.min_age)::text;
    end if;

    v_emails     := v_emails || v_email;
    v_dobs       := v_dobs || v_dob;
    v_categories := v_categories || v_category.name;
    v_prices     := v_prices || v_category.price;
    v_subtotal   := v_subtotal + v_category.price;
  end loop;

  -- ── Capacity, counted per category across the whole group ──
  -- The solo check ("is there at least one place left?") is wrong here: a
  -- category with three places left must not accept a group of ten into it.
  for v_cat_name in select distinct unnest(v_categories) loop
    select * into v_category
    from public.event_categories
    where event_id = v_event.id and name = v_cat_name;

    if v_category.max_slots is not null then
      select count(*) into v_taken
      from public.registrations
      where event_id = v_event.id
        and category = v_cat_name
        and payment_status is distinct from 'CANCELLED';

      select count(*) into v_wanted
      from unnest(v_categories) as t(cat) where t.cat = v_cat_name;

      if v_taken + v_wanted > v_category.max_slots then
        raise exception 'CATEGORY_FULL' using errcode = 'P0001',
          detail = jsonb_build_object(
            'category', v_cat_name,
            'requested', v_wanted,
            'slots_left', greatest(v_category.max_slots - v_taken, 0))::text;
      end if;
    end if;
  end loop;

  -- ── Coupon ──
  -- As in the solo flow, a code that does not apply does not fail the entry.
  -- Twenty people's details are not worth discarding over a mistyped code; the
  -- response says what happened and the confirm screen showed it beforehand.
  if nullif(trim(coalesce(payload->>'coupon_code', '')), '') is not null then
    v_quote := public.evaluate_coupon(
      v_event.id, v_categories, payload->>'coupon_code', true
    );

    if (v_quote->>'valid')::boolean then
      v_coupon_id := (v_quote->>'coupon_id')::uuid;

      if public.claim_coupon_use(v_coupon_id) then
        v_coupon_code  := v_quote->>'code';
        v_discount     := coalesce((v_quote->>'discount')::numeric, 0);
        v_eligible_sum := coalesce((v_quote->>'eligible_subtotal')::numeric, 0);
        v_applies      := case
                            when v_quote->'applies_to_categories' = 'null'::jsonb then null
                            else array(select jsonb_array_elements_text(v_quote->'applies_to_categories'))
                          end;
      else
        -- The last remaining use was taken between the quote and the commit.
        v_coupon_id := null;
        v_quote := jsonb_build_object('valid', false, 'reason', 'COUPON_EXHAUSTED');
      end if;
    end if;
  end if;

  -- Which members the discount is spread over.
  for v_i in 1 .. v_count loop
    v_eligible := v_eligible ||
      (v_applies is null or v_categories[v_i] = any (v_applies));
    if v_first_elig is null and (v_applies is null or v_categories[v_i] = any (v_applies)) then
      v_first_elig := v_i;
    end if;
  end loop;

  -- ── Payment ──
  -- As in the solo flow: a reservation with a deadline when online payment is
  -- on, confirmed outright when a code has taken the total to zero. Members
  -- carry the group's deadline too, so the read-side place counts
  -- (holds_place) treat them exactly like their group.
  if coalesce(v_event.online_payment_enabled, false) then
    if v_subtotal - v_discount <= 0 then
      v_status := 'PAID';
    else
      v_due := now() + make_interval(mins => v_event.payment_hold_minutes);
    end if;
  end if;

  -- ── Create the group ──
  v_group_code := 'GRP' || lpad(nextval('public.registration_group_seq')::text, 5, '0');

  insert into public.registration_groups (
    group_code, event_id, event_name,
    captain_first_name, captain_last_name, captain_email, captain_phone,
    organisation_name, city, state, pincode,
    emergency_contact_name, emergency_contact_number,
    participant_count, subtotal, discount, total,
    coupon_id, coupon_code,
    waivers_accepted, waivers_accepted_at,
    payment_status, payment_due_at, paid_at
  ) values (
    v_group_code, v_event.id, v_event.name,
    trim(payload#>>'{captain,first_name}'),
    nullif(trim(coalesce(payload#>>'{captain,last_name}', '')), ''),
    v_captain_email,
    nullif(trim(coalesce(payload#>>'{captain,phone}', '')), ''),
    nullif(trim(coalesce(payload#>>'{captain,organisation_name}', '')), ''),
    nullif(trim(coalesce(payload#>>'{captain,city}', '')), ''),
    nullif(coalesce(payload#>>'{captain,state}', ''), ''),
    nullif(trim(coalesce(payload#>>'{captain,pincode}', '')), ''),
    nullif(trim(coalesce(payload#>>'{captain,emergency_contact_name}', '')), ''),
    nullif(trim(coalesce(payload#>>'{captain,emergency_contact_number}', '')), ''),
    v_count, v_subtotal, v_discount, v_subtotal - v_discount,
    v_coupon_id, v_coupon_code,
    true, now(),
    v_status, v_due, case when v_status = 'PAID' then now() end
  )
  returning id into v_group_id;

  -- ── Pass two: insert the participants ──
  for v_i in 1 .. v_count loop
    v_p := v_participants -> (v_i - 1);

    -- Each member's share of the group discount, in proportion to what they
    -- are paying. Whole rupees, floored per member, with the remainder given
    -- to the first eligible one after the loop -- so the shares sum to exactly
    -- the group discount. If they did not, the sum of the member rows would
    -- disagree with the invoice by a rupee or two and every reconciliation
    -- afterwards would be wrong.
    v_share := 0;
    if v_discount > 0 and v_eligible[v_i] and v_eligible_sum > 0 then
      v_share := floor(v_discount * v_prices[v_i] / v_eligible_sum);
      v_allocated := v_allocated + v_share;
    end if;

    v_bib := public.allocate_bib(v_event.id);

    insert into public.registrations (
      first_name, last_name, email, phone, dob, gender,
      blood_group, emergency_contact_name, emergency_contact_number,
      has_medical_condition, allergies,
      city, state, pincode, club_name,
      category, tshirt_size, estimated_time, coupon_code,
      list_price, discount_amount, price,
      waivers_accepted, waivers_accepted_at,
      event_id, event_name, bib, payment_status, group_id,
      payment_due_at, paid_at
    ) values (
      trim(v_p->>'first_name'),
      nullif(trim(coalesce(v_p->>'last_name', '')), ''),
      v_emails[v_i],
      nullif(trim(coalesce(v_p->>'phone', '')), ''),
      v_dobs[v_i],
      nullif(v_p->>'gender', ''),
      nullif(v_p->>'blood_group', ''),
      -- The captain is the fallback the medical team calls. A group member who
      -- gave no next-of-kin is not left with an empty emergency field on race
      -- day; the organiser has someone to reach.
      coalesce(
        nullif(trim(coalesce(v_p->>'emergency_contact_name', '')), ''),
        nullif(trim(coalesce(payload#>>'{captain,emergency_contact_name}', '')), '')
      ),
      coalesce(
        nullif(trim(coalesce(v_p->>'emergency_contact_number', '')), ''),
        nullif(trim(coalesce(payload#>>'{captain,emergency_contact_number}', '')), ''),
        nullif(trim(coalesce(payload#>>'{captain,phone}', '')), '')
      ),
      coalesce((v_p->>'has_medical_condition')::boolean, false),
      case when coalesce((v_p->>'has_medical_condition')::boolean, false)
           then nullif(trim(coalesce(v_p->>'allergies', '')), '') end,
      -- Address follows the captain unless the member gave their own.
      coalesce(nullif(trim(coalesce(v_p->>'city', '')), ''),
               nullif(trim(coalesce(payload#>>'{captain,city}', '')), '')),
      coalesce(nullif(coalesce(v_p->>'state', ''), ''),
               nullif(coalesce(payload#>>'{captain,state}', ''), '')),
      coalesce(nullif(trim(coalesce(v_p->>'pincode', '')), ''),
               nullif(trim(coalesce(payload#>>'{captain,pincode}', '')), '')),
      coalesce(nullif(trim(coalesce(v_p->>'club_name', '')), ''),
               nullif(trim(coalesce(payload#>>'{captain,organisation_name}', '')), '')),
      v_categories[v_i],
      nullif(v_p->>'tshirt_size', ''),
      nullif(trim(coalesce(v_p->>'estimated_time', '')), ''),
      v_coupon_code,
      v_prices[v_i],
      v_share,
      greatest(v_prices[v_i] - v_share, 0),
      true,
      now(),
      v_event.id,
      v_event.name,
      v_bib,
      v_status,
      v_group_id,
      v_due,
      case when v_status = 'PAID' then now() end
    )
    returning * into v_row;

    v_results := v_results || jsonb_build_object(
      'id',         v_row.id,
      'bib',        v_row.bib,
      'first_name', v_row.first_name,
      'last_name',  v_row.last_name,
      'email',      v_row.email,
      'category',   v_row.category,
      'list_price', v_row.list_price,
      'discount',   v_row.discount_amount,
      'price',      v_row.price
    );
  end loop;

  -- Give the rounding remainder to the first eligible member, so the sum of
  -- the rows equals the group total to the rupee.
  if v_discount > 0 and v_allocated < v_discount and v_first_elig is not null then
    update public.registrations
       set discount_amount = discount_amount + (v_discount - v_allocated),
           price = greatest(price - (v_discount - v_allocated), 0)
     where group_id = v_group_id
       and bib = (v_results -> (v_first_elig - 1) ->> 'bib');
  end if;

  return jsonb_build_object(
    'group_id',          v_group_id,
    'group_code',        v_group_code,
    'payment_status',    v_status,
    'payment_due_at',    v_due,
    'event_name',        v_event.name,
    'captain_email',     v_captain_email,
    'participant_count', v_count,
    'subtotal',          v_subtotal,
    'discount',          v_discount,
    'total',             v_subtotal - v_discount,
    'coupon_code',       v_coupon_code,
    -- Says plainly whether the code was honoured. Without this the captain
    -- cannot tell a coupon that gave nothing from one that was never typed.
    'coupon_applied',    v_coupon_id is not null,
    'coupon_reason',     case when v_coupon_id is null then v_quote->>'reason' end,
    'participants',      v_results
  );
end $$;

revoke all on function public.create_group_registration(jsonb) from public;
grant execute on function public.create_group_registration(jsonb) to anon, authenticated;

comment on function public.create_group_registration(jsonb) is
  'The public bulk registration entry point. Validates every participant, checks per-category capacity for the whole group at once, prices from event_categories, applies any valid coupon across the group and inserts the group plus all members in one transaction -- as a reservation with a payment deadline when online payment is on. All-or-nothing by design.';

-- ── 10. What is owed, and the order to collect it ───────────────────────────
-- Called by razorpay-order. Answers with a status rather than raising, so the
-- edge function can tell the runner something specific ("your reservation
-- expired") instead of a generic failure.
create or replace function public.prepare_payment(p_registration_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event      public.events%rowtype;
  v_event_id   text;
  v_status     text;
  v_due        timestamptz;
  v_amount     numeric;
  v_bib        text;
  v_category   text;
  v_member_of  uuid;
  v_group_code text;
  v_count      integer;
  v_receipt    text;
  v_desc       text;
  v_paise      integer;
  v_order_id   text;
begin
  if (p_registration_id is null) = (p_group_id is null) then
    return jsonb_build_object('status', 'BAD_REQUEST');
  end if;

  if p_registration_id is not null then
    select r.event_id, r.payment_status, r.payment_due_at, r.price,
           r.bib, r.category, r.group_id
      into v_event_id, v_status, v_due, v_amount,
           v_bib, v_category, v_member_of
      from public.registrations r
     where r.id = p_registration_id;

    if not found then
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;

    -- A group pays once, as a group. Settling one member on their own would
    -- leave the group total and the member rows disagreeing.
    if v_member_of is not null then
      return jsonb_build_object('status', 'PAY_AS_GROUP');
    end if;

    v_receipt := 'bib-' || coalesce(v_bib, left(p_registration_id::text, 8));
    v_desc    := coalesce(v_category, 'Entry') || coalesce(' · Bib ' || v_bib, '');
  else
    select g.event_id, g.payment_status, g.payment_due_at, g.total,
           g.group_code, g.participant_count
      into v_event_id, v_status, v_due, v_amount,
           v_group_code, v_count
      from public.registration_groups g
     where g.id = p_group_id;

    if not found then
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;

    v_receipt := v_group_code;
    v_desc    := 'Group ' || v_group_code || ' · ' || v_count || ' runners';
  end if;

  select * into v_event from public.events where id = v_event_id;

  -- Already settled is an answer, not an error: the runner may be retrying
  -- after the webhook beat their browser to it.
  if v_status = 'PAID' then
    return jsonb_build_object('status', 'PAID');
  end if;

  if not coalesce(v_event.online_payment_enabled, false) then
    return jsonb_build_object('status', 'DISABLED');
  end if;

  if v_status is distinct from 'PENDING' then
    return jsonb_build_object('status', 'NOT_PAYABLE', 'payment_status', v_status);
  end if;

  if v_due is not null and v_due < now() then
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  -- Paise, from the stored price. Never from the request.
  v_paise := round(coalesce(v_amount, 0) * 100)::integer;
  if v_paise <= 0 then
    -- Razorpay refuses a zero-amount order. The registration functions confirm
    -- these outright when online payment is on; one still PENDING here was
    -- made before the switch and is the organisers' to confirm.
    return jsonb_build_object('status', 'NOTHING_DUE');
  end if;

  -- Reuse this entry's open order if its amount still matches. One order per
  -- entry is what lets Razorpay refuse a second successful payment against
  -- it: a runner who double-taps Pay, or retries in another tab, is not
  -- charged twice.
  select p.razorpay_order_id into v_order_id
    from public.payments p
   where p.status = 'CREATED'
     and p.razorpay_payment_id is null
     and p.amount_paise = v_paise
     and ((p_registration_id is not null and p.registration_id = p_registration_id)
       or (p_group_id is not null and p.group_id = p_group_id))
   order by p.created_at desc
   limit 1;

  return jsonb_build_object(
    'status',       'PAYABLE',
    'event_id',     v_event_id,
    'event_name',   v_event.name,
    'amount_paise', v_paise,
    'currency',     'INR',
    'receipt',      left(v_receipt, 40),           -- Razorpay's limit
    'description',  left(v_desc, 255),
    'due_at',       v_due,
    'order_id',     v_order_id
  );
end $$;

create or replace function public.record_payment_order(
  p_registration_id uuid,
  p_group_id        uuid,
  p_event_id        text,
  p_order_id        text,
  p_amount_paise    integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Any older open order for the same entry is retired. Razorpay has no call
  -- to cancel an order, so it stays payable in a stale tab -- but it is no
  -- longer offered, and if it is paid anyway confirm_payment() still finds it.
  update public.payments
     set status = 'SUPERSEDED', updated_at = now()
   where status = 'CREATED'
     and razorpay_payment_id is null
     and razorpay_order_id <> p_order_id
     and ((p_registration_id is not null and registration_id = p_registration_id)
       or (p_group_id is not null and group_id = p_group_id));

  insert into public.payments (event_id, registration_id, group_id, razorpay_order_id, amount_paise)
  select p_event_id, p_registration_id, p_group_id, p_order_id, p_amount_paise
  where not exists (
    select 1 from public.payments where razorpay_order_id = p_order_id
  );
end $$;

-- ── 11. Settling a payment ──────────────────────────────────────────────────
-- What the browser (via razorpay-verify) is told once a payment is settled.
-- The caller has proved they made the payment -- the signature or the webhook
-- secret checked out -- so returning their own entry is fine. `note`, the
-- admin-facing explanation of a REFUND_REQUIRED, is deliberately left out.
create or replace function public._payment_summary(p_payment_row uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'status',       p.status,
    'payment_id',   p.razorpay_payment_id,
    'order_id',     p.razorpay_order_id,
    'amount_paise', p.amount_paise,
    'registration', case when r.id is not null then jsonb_build_object(
      'id',             r.id,
      'bib',            r.bib,
      'first_name',     r.first_name,
      'last_name',      r.last_name,
      'email',          r.email,
      'category',       r.category,
      'list_price',     r.list_price,
      'discount',       r.discount_amount,
      'price',          r.price,
      'coupon_code',    r.coupon_code,
      'payment_status', r.payment_status,
      'payment_ref',    r.payment_ref,
      'event_name',     r.event_name
    ) end,
    'group', case when g.id is not null then jsonb_build_object(
      'group_id',          g.id,
      'group_code',        g.group_code,
      'participant_count', g.participant_count,
      'total',             g.total,
      'payment_status',    g.payment_status,
      'payment_ref',       g.payment_ref
    ) end
  )
  from public.payments p
  left join public.registrations r on r.id = p.registration_id
  left join public.registration_groups g on g.id = p.group_id
  where p.id = p_payment_row;
$$;

-- Returns NULL when the entry took the payment, otherwise the reason it could
-- not -- which becomes the REFUND_REQUIRED note an admin reads.
create or replace function public._settle_registration(p_id uuid, p_payment_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.registrations%rowtype;
begin
  select * into v_row from public.registrations where id = p_id for update;

  if not found then
    return 'The entry this payment was for no longer exists.';
  end if;

  if v_row.payment_status = 'PAID' then
    if v_row.payment_ref = p_payment_id then
      return null;
    end if;
    return format('Entry (bib %s) was already paid%s.',
                  coalesce(v_row.bib, '?'),
                  coalesce(' by ' || v_row.payment_ref, ''));
  end if;

  if v_row.payment_status = 'PENDING' then
    update public.registrations
       set payment_status = 'PAID', payment_ref = p_payment_id, paid_at = now()
     where id = p_id;
    return null;
  end if;

  if v_row.payment_status = 'CANCELLED' and v_row.cancelled_reason = 'PAYMENT_TIMEOUT' then
    -- Paid after the reservation lapsed -- a slow UPI approval, typically. The
    -- runner has paid, so the entry comes back rather than the money going
    -- back. The category may now be one over its limit; that is the lesser
    -- problem, and far rarer than the slow approval itself.
    begin
      update public.registrations
         set payment_status = 'PAID', cancelled_reason = null,
             payment_ref = p_payment_id, paid_at = now()
       where id = p_id;
    exception when unique_violation then
      return format('Paid after the reservation (bib %s) had expired, and the same email has entered again since.',
                    coalesce(v_row.bib, '?'));
    end;

    -- expire_unpaid_holds() handed the coupon use back; the price paid still
    -- carries the discount, so the use is taken again.
    if v_row.coupon_code is not null then
      update public.coupons
         set uses = uses + 1, updated_at = now()
       where event_id = v_row.event_id and upper(code) = upper(v_row.coupon_code);
    end if;
    return null;
  end if;

  return format('Entry (bib %s) was %s before the payment arrived.',
                coalesce(v_row.bib, '?'),
                lower(coalesce(v_row.payment_status, 'closed')));
end $$;

create or replace function public._settle_group(p_id uuid, p_payment_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group public.registration_groups%rowtype;
begin
  select * into v_group from public.registration_groups where id = p_id for update;

  if not found then
    return 'The group this payment was for no longer exists.';
  end if;

  if v_group.payment_status = 'PAID' then
    if v_group.payment_ref = p_payment_id then
      return null;
    end if;
    return format('Group %s was already paid%s.',
                  v_group.group_code,
                  coalesce(' by ' || v_group.payment_ref, ''));
  end if;

  if v_group.payment_status = 'PENDING' then
    update public.registration_groups
       set payment_status = 'PAID', payment_ref = p_payment_id, paid_at = now()
     where id = p_id;

    -- A member an admin cancelled individually stays cancelled.
    update public.registrations
       set payment_status = 'PAID', payment_ref = p_payment_id, paid_at = now()
     where group_id = p_id
       and payment_status = 'PENDING';
    return null;
  end if;

  if v_group.payment_status = 'CANCELLED' and v_group.cancelled_reason = 'PAYMENT_TIMEOUT' then
    -- As for a solo entry: paid late, so the group comes back.
    begin
      update public.registration_groups
         set payment_status = 'PAID', cancelled_reason = null,
             payment_ref = p_payment_id, paid_at = now()
       where id = p_id;

      update public.registrations
         set payment_status = 'PAID', cancelled_reason = null,
             payment_ref = p_payment_id, paid_at = now()
       where group_id = p_id
         and payment_status = 'CANCELLED'
         and cancelled_reason = 'PAYMENT_TIMEOUT';
    exception when unique_violation then
      return format('Paid after group %s''s reservation had expired, and at least one of its runners has entered again since.',
                    v_group.group_code);
    end;

    if v_group.coupon_id is not null then
      update public.coupons
         set uses = uses + 1, updated_at = now()
       where id = v_group.coupon_id;
    end if;
    return null;
  end if;

  return format('Group %s was %s before the payment arrived.',
                v_group.group_code,
                lower(coalesce(v_group.payment_status, 'closed')));
end $$;

-- The one place an entry becomes PAID through Razorpay. The edge functions
-- call it only after proving the payment is genuine and captured:
-- razorpay-verify checks the checkout signature and re-fetches the payment
-- from Razorpay; razorpay-webhook checks the webhook signature.
create or replace function public.confirm_payment(
  p_order_id     text,
  p_payment_id   text,
  p_amount_paise integer,
  p_method       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.payments%rowtype;
  v_pay   public.payments%rowtype;
  v_note  text;
begin
  -- Idempotent on the payment id: the browser callback and the webhook both
  -- land here for the same payment, in either order, possibly more than once.
  select * into v_pay from public.payments where razorpay_payment_id = p_payment_id;
  if found then
    return public._payment_summary(v_pay.id);
  end if;

  -- The order this payment belongs to, preferring its still-open row. Locked,
  -- so the callback and the webhook arriving together settle it once.
  select * into v_order
    from public.payments
   where razorpay_order_id = p_order_id
   order by (status = 'CREATED' and razorpay_payment_id is null) desc, created_at desc
   limit 1
   for update;

  if not found then
    -- Not an order this site created -- another integration on the same
    -- Razorpay account, or a dashboard test. Nothing here to settle.
    return jsonb_build_object('status', 'UNKNOWN_ORDER');
  end if;

  -- The other caller won the lock and already settled this very payment.
  if v_order.razorpay_payment_id = p_payment_id then
    return public._payment_summary(v_order.id);
  end if;

  if v_order.status = 'CREATED' and v_order.razorpay_payment_id is null then
    update public.payments
       set razorpay_payment_id = p_payment_id, method = p_method, updated_at = now()
     where id = v_order.id
    returning * into v_pay;
  else
    -- A second payment against an order that already has one, or a payment
    -- against a superseded order. Recorded as its own row so that neither
    -- payment is lost track of.
    insert into public.payments (
      event_id, registration_id, group_id,
      razorpay_order_id, razorpay_payment_id,
      amount_paise, currency, method
    ) values (
      v_order.event_id, v_order.registration_id, v_order.group_id,
      p_order_id, p_payment_id,
      p_amount_paise, v_order.currency, p_method
    )
    returning * into v_pay;
  end if;

  -- The order fixes the amount at Razorpay's end, so a mismatch should be
  -- impossible. If it happens anyway, it is not treated as payment in full.
  if p_amount_paise is distinct from v_order.amount_paise then
    v_note := format('Paid %s paise against an order for %s paise.',
                     p_amount_paise, v_order.amount_paise);
  elsif v_pay.registration_id is not null then
    v_note := public._settle_registration(v_pay.registration_id, p_payment_id);
  elsif v_pay.group_id is not null then
    v_note := public._settle_group(v_pay.group_id, p_payment_id);
  else
    v_note := 'The entry this payment was for no longer exists.';
  end if;

  update public.payments
     set status     = case when v_note is null then 'PAID' else 'REFUND_REQUIRED' end,
         note       = v_note,
         paid_at    = now(),
         updated_at = now()
   where id = v_pay.id;

  return public._payment_summary(v_pay.id);
end $$;

comment on function public.confirm_payment(text, text, integer, text) is
  'Settle a captured Razorpay payment against the entry its order was for. Idempotent on the payment id. Money no entry can take is recorded as REFUND_REQUIRED with the reason, never absorbed.';

-- A failed attempt does not end the reservation: the runner can try another
-- card or UPI app on the same order until the deadline. The error is kept so
-- an organiser answering "my payment failed" can see what Razorpay said.
create or replace function public.record_payment_failure(
  p_order_id   text,
  p_payment_id text,
  p_error      text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.payments
     set last_error = left(concat_ws(' ', p_payment_id || ':', p_error), 500),
         updated_at = now()
   where razorpay_order_id = p_order_id
     and status = 'CREATED';
$$;

-- Refunds are issued from the Razorpay dashboard; the webhook reports them
-- here. `p_refunded_paise` is Razorpay's running total for the payment, so a
-- repeated webhook sets the same figure again rather than adding to it.
create or replace function public.record_refund(p_payment_id text, p_refunded_paise integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay public.payments%rowtype;
begin
  select * into v_pay from public.payments where razorpay_payment_id = p_payment_id for update;
  if not found then
    return jsonb_build_object('status', 'UNKNOWN_PAYMENT');
  end if;

  update public.payments
     set refunded_paise = greatest(refunded_paise, coalesce(p_refunded_paise, 0)),
         updated_at     = now()
   where id = v_pay.id;

  if coalesce(p_refunded_paise, 0) < v_pay.amount_paise then
    return jsonb_build_object('status', 'PARTIAL');
  end if;

  update public.payments set status = 'REFUNDED', updated_at = now() where id = v_pay.id;

  -- Only the payment that settled an entry un-settles it. Refunding a
  -- duplicate leaves the entry paid by the other payment, as it should.
  update public.registrations
     set payment_status = 'REFUNDED'
   where payment_ref = p_payment_id and payment_status = 'PAID';

  update public.registration_groups
     set payment_status = 'REFUNDED'
   where payment_ref = p_payment_id and payment_status = 'PAID';

  return jsonb_build_object('status', 'REFUNDED');
end $$;

-- ── 12. Who may call what ───────────────────────────────────────────────────
-- Everything that moves money is for the edge functions (service_role) only.
--
-- The revoke names anon and authenticated as well as PUBLIC because Supabase
-- grants EXECUTE on new functions in the public schema to those roles
-- directly, so revoking from PUBLIC alone can leave them callable with the
-- key that ships in the JavaScript bundle.
revoke all on function public.expire_unpaid_holds(text)                               from public, anon, authenticated;
revoke all on function public.prepare_payment(uuid, uuid)                             from public, anon, authenticated;
revoke all on function public.record_payment_order(uuid, uuid, text, text, integer)   from public, anon, authenticated;
revoke all on function public._payment_summary(uuid)                                  from public, anon, authenticated;
revoke all on function public._settle_registration(uuid, text)                        from public, anon, authenticated;
revoke all on function public._settle_group(uuid, text)                               from public, anon, authenticated;
revoke all on function public.confirm_payment(text, text, integer, text)              from public, anon, authenticated;
revoke all on function public.record_payment_failure(text, text, text)                from public, anon, authenticated;
revoke all on function public.record_refund(text, integer)                            from public, anon, authenticated;

grant execute on function public.expire_unpaid_holds(text)                             to service_role;
grant execute on function public.prepare_payment(uuid, uuid)                           to service_role;
grant execute on function public.record_payment_order(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.confirm_payment(text, text, integer, text)            to service_role;
grant execute on function public.record_payment_failure(text, text, text)              to service_role;
grant execute on function public.record_refund(text, integer)                          to service_role;

-- The same default grant applies to the internal helpers 0007 and 0010
-- created, which their own `revoke ... from public` may not have closed.
-- Callable with the public key, claim_coupon_use() would let anyone burn a
-- coupon's remaining uses and allocate_bib() would let anyone burn bib
-- numbers. Nothing in the browser calls either; the registration functions
-- that do run as the owner and are unaffected.
revoke all on function public.allocate_bib(text)                               from public, anon, authenticated;
revoke all on function public.claim_coupon_use(uuid)                           from public, anon, authenticated;
revoke all on function public.evaluate_coupon(text, text[], text, boolean)     from public, anon, authenticated;

-- ── 13. Lock the new table down ─────────────────────────────────────────────
create or replace function public._managed_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'events', 'event_categories', 'event_schedule',
    'past_events', 'past_events_media', 'faqs', 'testimonials',
    'registrations', 'email_log', 'newsletter_subscribers',
    'bib_counters', 'admin_users',
    'coupons', 'registration_groups',
    'payments'
  ]::text[];
$$;

do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'payments'
  loop
    execute format('drop policy %I on public.payments', pol.policyname);
  end loop;
end $$;

-- Read-only even for admins. A payment is a record of what Razorpay did; the
-- dashboard has no business editing it. Refunds go through Razorpay and come
-- back by webhook.
create policy payments_admin_read on public.payments
  for select to authenticated using (public.is_admin());

revoke all on public.payments from anon;
revoke insert, update, delete, truncate on public.payments from authenticated;

-- ── 14. Sweep lapsed reservations on a timer, where pg_cron is available ────
-- Not required for correctness: every registration sweeps before it counts
-- places, and holds_place() hides a lapsed reservation from the availability
-- figures the moment its deadline passes. The timer keeps the admin list
-- tidy and returns coupon uses promptly on a quiet day.
--
-- Enable it in the Supabase dashboard (Database -> Extensions -> pg_cron) and
-- re-run this file to schedule the job.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'goda-expire-unpaid-holds') then
      perform cron.unschedule('goda-expire-unpaid-holds');
    end if;
    perform cron.schedule(
      'goda-expire-unpaid-holds',
      '*/5 * * * *',
      'select public.expire_unpaid_holds()'
    );
    raise notice 'Scheduled expire_unpaid_holds() every 5 minutes with pg_cron.';
  else
    raise notice 'pg_cron is not enabled; lapsed reservations are released when the next registration arrives. Enable pg_cron and re-run this file to sweep on a timer as well.';
  end if;
end $$;

-- ── 15. Assert the result ───────────────────────────────────────────────────
do $$
declare
  bad      text;
  problems text := '';
begin
  for bad in
    select format('%s (%s)', policyname, cmd)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'payments'
      and (roles = '{public}' or 'anon' = any (roles))
  loop
    problems := problems || E'\n  - payments policy reachable by anon: ' || bad;
  end loop;

  for bad in
    select privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'payments'
      and grantee = 'anon'
  loop
    problems := problems || E'\n  - anon still holds a grant on payments: ' || bad;
  end loop;

  for bad in
    select f
    from unnest(array[
      'public.expire_unpaid_holds(text)',
      'public.prepare_payment(uuid, uuid)',
      'public.record_payment_order(uuid, uuid, text, text, integer)',
      'public._payment_summary(uuid)',
      'public._settle_registration(uuid, text)',
      'public._settle_group(uuid, text)',
      'public.confirm_payment(text, text, integer, text)',
      'public.record_payment_failure(text, text, text)',
      'public.record_refund(text, integer)',
      'public.allocate_bib(text)',
      'public.claim_coupon_use(uuid)',
      'public.evaluate_coupon(text, text[], text, boolean)'
    ]) as f
    where has_function_privilege('anon', f, 'execute')
       or has_function_privilege('authenticated', f, 'execute')
  loop
    problems := problems || E'\n  - callable with a public or user key: ' || bad;
  end loop;

  if problems <> '' then
    raise exception 'Migration 0011 did not reach the intended state:%', problems;
  end if;

  raise notice '0011 OK: payments is admin-read-only and every payment function is service_role-only.';
end $$;
