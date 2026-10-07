-- 0017_category_bib_series.sql
--
-- Run after 0016. Bib numbers that say which race a runner is in.
--
-- Until now every entry took the next number from one counter per event
-- (0007): 1000, 1001, 1002 ... in the order people registered, whatever they
-- were running. A volunteer at kit collection, a marshal at a turn-off or the
-- timing desk could not tell a 3 km fun runner from a half-marathoner by the
-- number on their chest. Three more defects came with it:
--
--   1. ABANDONED CHECKOUTS BURNED NUMBERS. With online payment on, the bib was
--      allocated the moment the reservation was made, so every runner who
--      closed the payment window took a number with them and the printed
--      series would have been full of holes.
--   2. A CATEGORY CHANGE KEPT THE OLD NUMBER, and an admin could type any bib
--      at all into the edit form. A duplicate surfaced only as a raw
--      constraint error, which the form swallowed.
--   3. A RENAMED CATEGORY LOST ITS ENTRANTS. registrations.category holds the
--      name, so renaming a category left everyone in it pointing at a name
--      that no longer existed.
--
-- What this does:
--
--   * Every category has a bib series, event_categories.bib_start..bib_end.
--     The default is coded by distance -- 5 km is 5001-5999, 10 km is
--     10001-10999, 21 km is 21001-21999 -- so the number itself names the
--     race. An organiser can set any other range in Admin -> Categories.
--   * The database guards the series: no two in an event overlap, each holds
--     at least the category's max_slots, and none can be moved out from under
--     bibs already issued.
--   * Bibs are issued by a trigger on registrations, the one place every path
--     goes through: both registration functions, payment settlement, and an
--     admin's edit. An entry gets its number when it holds its place for good
--     -- paid, free, or an offline entry awaiting payment. An unpaid online
--     reservation gets none until its payment is confirmed. Numbers run
--     upwards through the series; gaps are filled only once the top is reached.
--   * A number is never shared. (event_id, bib) is unique across every row,
--     cancelled ones included (0007), so a cancelled runner's bib is retired,
--     not handed to someone else.
--   * A category change re-issues the bib from the new series. A bib an admin
--     types must be a number inside the runner's series and not already
--     issued; the error names the runner who holds it.
--   * A payment never fails over a bib. If a series is ever full, the entry is
--     confirmed without a number, Admin -> Categories says so, and widening
--     the series issues the missing numbers at once.
--   * Renaming a category carries its entries with it.
--
-- Existing entries of upcoming events: every entry that holds its place and
-- whose bib lies outside its category's new series is renumbered, oldest
-- entry first. An unpaid online reservation gives up its provisional number
-- and gets a real one when it is paid. Cancelled entries keep theirs. Nobody
-- is re-emailed automatically; resend from Admin -> Email -> Deliveries.
--
-- Run BEFORE deploying the matching frontend. Safe to re-run.

-- ── 1. A bib series per category ────────────────────────────────────────────
alter table public.event_categories
  add column if not exists bib_start integer,
  add column if not exists bib_end   integer;

comment on column public.event_categories.bib_start is
  'First bib number of this category''s series. Every runner in the category gets a number between bib_start and bib_end, so the bib identifies the race. Defaults from the distance: 21 km -> 21001.';
comment on column public.event_categories.bib_end is
  'Last bib number of this category''s series. bib_end - bib_start + 1 must be at least max_slots; series in one event never overlap.';

-- ── 2. Small helpers ────────────────────────────────────────────────────────
-- The numeric value of a stored bib, or NULL for anything that is not one to
-- six digits. Old rows hold text, and a cast that fails would abort the whole
-- statement it appears in, so every comparison goes through this.
create or replace function public._bib_number(p_bib text)
returns integer
language sql
immutable
as $$
  select case when btrim(p_bib) ~ '^[0-9]{1,6}$' then btrim(p_bib)::integer end;
$$;

-- Whether an entry should carry a bib: it holds its place for good. Paid, or
-- PENDING with no payment deadline -- an offline entry the organisers will
-- collect for. Not an online reservation still inside its payment window.
create or replace function public._holds_bib(p_status text, p_due timestamptz)
returns boolean
language sql
immutable
as $$
  select coalesce(p_status = 'PAID' or (p_status = 'PENDING' and p_due is null), false);
$$;

comment on function public._holds_bib(text, timestamptz) is
  'True when an entry with this status and payment deadline is issued a bib: PAID, or PENDING with no deadline (offline payment). An unpaid online reservation is not.';

-- One lock per event for everything that reads or changes who holds which
-- number. Two-key form, so it cannot collide with 0011's single-key sweeper
-- lock.
create or replace function public._lock_bibs(p_event_id text)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtext('goda.bib'), hashtext(p_event_id));
$$;

-- ── 3. The default series for a category ────────────────────────────────────
-- Coded by distance, in blocks of a thousand: "21km" -> 21001-21999. A
-- category that needs more than 999 numbers takes as many whole blocks as it
-- needs. If the block is taken (two 10 km categories) or the distance is not
-- in kilometres, the next free block upwards.
create or replace function public._suggest_bib_series(
  p_event_id    text,
  p_distance    text,
  p_max_slots   integer,
  p_category_id uuid,
  out bib_start integer,
  out bib_end   integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_km    numeric;
  v_k     integer;
  v_width integer;
  v_start integer;
  v_end   integer;
begin
  -- "21km", "5 Km", "10K", "21.1 km". Metres, miles and names get no hint.
  if coalesce(p_distance, '') ~* '^\s*[0-9]+(\.[0-9]+)?\s*k' then
    v_km := substring(p_distance from '[0-9]+(?:\.[0-9]+)?')::numeric;
  end if;

  v_k     := greatest(coalesce(floor(v_km)::integer, 1), 1);
  v_width := 1000 * greatest(ceil((coalesce(p_max_slots, 0) + 1) / 1000.0)::integer, 1);

  loop
    v_start := v_k * 1000 + 1;
    v_end   := v_k * 1000 + v_width - 1;

    if v_end > 999999 then
      raise exception 'There is no free bib series left for this category. Enter one by hand.'
        using errcode = 'P0001';
    end if;

    exit when not exists (
      select 1
      from public.event_categories c
      where c.event_id = p_event_id
        and c.id is distinct from p_category_id
        and c.bib_start is not null
        and c.bib_end is not null
        and int4range(c.bib_start, c.bib_end, '[]') && int4range(v_start, v_end, '[]')
    );

    v_k := v_k + 1;
  end loop;

  bib_start := v_start;
  bib_end   := v_end;
end $$;

-- ── 4. The next number in a series ──────────────────────────────────────────
-- Upwards from the highest number issued in the series, so numbers go out in
-- registration order and a number freed by a deleted test entry is not handed
-- straight to the next runner. Once the top is reached, the lowest number
-- nobody holds. NULL when the series is full.
--
-- The caller holds _lock_bibs() for the event. "Issued" counts every row,
-- cancelled ones included: a retired number stays retired.
create or replace function public._next_bib(p_event_id text, p_start integer, p_end integer)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_next integer;
begin
  if p_start is null or p_end is null then
    return null;
  end if;

  select coalesce(max(n), p_start - 1) + 1 into v_next
  from (
    select public._bib_number(r.bib) as n
    from public.registrations r
    where r.event_id = p_event_id and r.bib is not null
  ) issued
  where n between p_start and p_end;

  if v_next <= p_end then
    return v_next::text;
  end if;

  select min(g) into v_next
  from generate_series(p_start, p_end) g
  where not exists (
    select 1 from public.registrations r
    where r.event_id = p_event_id and r.bib = g::text
  );

  return v_next::text;
end $$;

-- ── 5. Issuing bibs: one trigger every write goes through ───────────────────
create or replace function public._assign_bib()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cat      public.event_categories%rowtype;
  v_num      integer;
  v_holder   text;
  v_in_range boolean;
begin
  new.bib := nullif(btrim(new.bib), '');

  select * into v_cat
  from public.event_categories
  where event_id = new.event_id and name = new.category;

  -- ── A number typed by an admin ──
  -- Checked, never silently replaced: if it is wrong, the admin needs to know.
  if new.bib is not null and (tg_op = 'INSERT' or new.bib is distinct from old.bib) then
    v_num := public._bib_number(new.bib);
    if v_num is null or v_num < 1 then
      raise exception 'Bib "%" is not valid. A bib is a whole number of up to six digits.', new.bib
        using errcode = 'P0001';
    end if;
    new.bib := v_num::text;

    if v_cat.bib_start is not null
       and v_num not between v_cat.bib_start and v_cat.bib_end then
      raise exception 'Bib % is outside the % series (%–%). Use a number in that range, or clear the field to issue the next one.',
        v_num, v_cat.name, v_cat.bib_start, v_cat.bib_end
        using errcode = 'P0001';
    end if;

    select trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, ''))
           || case when r.payment_status = 'CANCELLED' then ' (cancelled entry; the number stays retired)' else '' end
      into v_holder
    from public.registrations r
    where r.event_id = new.event_id and r.bib = new.bib and r.id <> new.id
    limit 1;

    if found then
      raise exception 'Bib % is already issued to %.', new.bib, v_holder
        using errcode = 'P0001';
    end if;

    return new;
  end if;

  -- ── Everything else is automatic ──
  if not public._holds_bib(new.payment_status, new.payment_due_at)
     or v_cat.bib_start is null then
    return new;
  end if;

  v_num := public._bib_number(new.bib);
  v_in_range := v_num is not null and v_num between v_cat.bib_start and v_cat.bib_end;

  -- A bib is (re)issued when the entry has none, when it moved to another
  -- category, or when it has just come to hold its place again (a lapsed
  -- reservation paid late) with a number from outside its series. An
  -- unrelated edit -- a name, a finish time -- never renumbers anyone.
  if new.bib is null
     or (tg_op = 'UPDATE' and not v_in_range
         and (new.category is distinct from old.category
              or not public._holds_bib(old.payment_status, old.payment_due_at))) then
    perform public._lock_bibs(new.event_id);
    new.bib := public._next_bib(new.event_id, v_cat.bib_start, v_cat.bib_end);
  end if;

  return new;
end $$;

drop trigger if exists registrations_assign_bib on public.registrations;
create trigger registrations_assign_bib
  before insert or update on public.registrations
  for each row execute function public._assign_bib();

comment on function public._assign_bib() is
  'Issues, re-issues and validates bibs. Automatic: the next number of the category''s series once the entry holds its place (PAID, or PENDING without a payment deadline), and a fresh one after a category change. Typed by an admin: must be 1-6 digits, inside the category''s series, and not held by any other entry of the event.';

-- Gives every entry that should hold a bib but has none its number, oldest
-- first. Used when a series is widened after filling up, and by this
-- migration.
create or replace function public._issue_missing_bibs(p_event_id text, p_category text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in
    select id
    from public.registrations
    where event_id = p_event_id
      and (p_category is null or category = p_category)
      and bib is null
      and public._holds_bib(payment_status, payment_due_at)
    order by coalesce(paid_at, created_at), id
  loop
    -- Setting NULL over NULL is enough: _assign_bib() issues the number.
    update public.registrations set bib = null where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ── 6. Series for the categories that already exist ─────────────────────────
-- In display order, so with two categories of the same distance the first one
-- listed keeps the distance-coded block.
do $$
declare
  c record;
  s record;
begin
  for c in
    select id, event_id, distance, max_slots
    from public.event_categories
    where bib_start is null or bib_end is null
    order by event_id, display_order, name, id
  loop
    select * into s
    from public._suggest_bib_series(c.event_id, c.distance, c.max_slots, c.id);

    update public.event_categories
       set bib_start = s.bib_start, bib_end = s.bib_end
     where id = c.id;

    raise notice 'Bib series % - % for category %', s.bib_start, s.bib_end, c.id;
  end loop;
end $$;

alter table public.event_categories
  alter column bib_start set not null,
  alter column bib_end   set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'event_categories_bib_series_check'
      and conrelid = 'public.event_categories'::regclass
  ) then
    alter table public.event_categories
      add constraint event_categories_bib_series_check
      check (bib_start >= 1 and bib_end >= bib_start and bib_end <= 999999);
  end if;
end $$;

-- ── 7. Bring existing entries into their series ─────────────────────────────
-- Upcoming events only: a past event's numbers are on its results board.
do $$
declare
  r          record;
  v_released integer;
  v_moved    integer := 0;
begin
  -- Unpaid online reservations: no number until they are paid.
  update public.registrations reg
     set bib = null
   where reg.bib is not null
     and reg.payment_status = 'PENDING'
     and reg.payment_due_at is not null
     and exists (select 1 from public.events e
                 where e.id = reg.event_id and (e.date is null or e.date >= current_date));
  get diagnostics v_released = row_count;

  -- Everyone holding a place with a number from outside their series.
  -- Cleared one at a time in entry order, so the trigger numbers them oldest
  -- first.
  for r in
    select reg.id
    from public.registrations reg
    join public.event_categories c
      on c.event_id = reg.event_id and c.name = reg.category
    join public.events e on e.id = reg.event_id
    where (e.date is null or e.date >= current_date)
      and public._holds_bib(reg.payment_status, reg.payment_due_at)
      and coalesce(public._bib_number(reg.bib) between c.bib_start and c.bib_end, false) = false
    order by reg.created_at, reg.id
  loop
    update public.registrations set bib = null where id = r.id;
    v_moved := v_moved + 1;
  end loop;

  raise notice 'Bibs: % reservation number(s) released, % entr(y/ies) renumbered into their category series.',
    v_released, v_moved;
end $$;

-- ── 8. Guard the series ─────────────────────────────────────────────────────
create or replace function public._guard_bib_series()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clash record;
  v_out   record;
begin
  -- Both empty: pick one. One empty: almost certainly a mistake.
  if new.bib_start is null and new.bib_end is null then
    select s.bib_start, s.bib_end into new.bib_start, new.bib_end
    from public._suggest_bib_series(new.event_id, new.distance, new.max_slots, new.id) s;
  elsif new.bib_start is null or new.bib_end is null then
    raise exception 'Give both the first and the last bib number of the series, or leave both empty for an automatic one.'
      using errcode = 'P0001';
  end if;

  -- A rename alone needs none of this, and taking the bib lock for it would
  -- let it deadlock with a payment settling in the same category.
  if tg_op = 'UPDATE'
     and new.bib_start = old.bib_start
     and new.bib_end   = old.bib_end
     and new.max_slots is not distinct from old.max_slots
     and new.event_id  = old.event_id then
    return new;
  end if;

  perform public._lock_bibs(new.event_id);

  if new.bib_start < 1 or new.bib_end > 999999 or new.bib_end < new.bib_start then
    raise exception 'A bib series runs from a lower number to a higher one, between 1 and 999999.'
      using errcode = 'P0001';
  end if;

  if new.max_slots is not null and new.bib_end - new.bib_start + 1 < new.max_slots then
    raise exception 'Bib series %–% has % numbers, but the category takes up to % runners. Widen the series or lower Max Slots.',
      new.bib_start, new.bib_end, new.bib_end - new.bib_start + 1, new.max_slots
      using errcode = 'P0001';
  end if;

  select c.name, c.bib_start, c.bib_end into v_clash
  from public.event_categories c
  where c.event_id = new.event_id
    and c.id <> new.id
    and int4range(c.bib_start, c.bib_end, '[]') && int4range(new.bib_start, new.bib_end, '[]')
  order by c.bib_start
  limit 1;

  if found then
    raise exception 'Bib series %–% overlaps "%" (%–%). Each category needs its own numbers.',
      new.bib_start, new.bib_end, v_clash.name, v_clash.bib_start, v_clash.bib_end
      using errcode = 'P0001';
  end if;

  -- Numbers already issued must stay inside the series. Moving them is a
  -- renumbering of real runners, who may have been emailed their bib; that
  -- is not something a range edit should do as a side effect.
  if tg_op = 'UPDATE' then
    select count(*) as n,
           min(public._bib_number(r.bib)) as lo,
           max(public._bib_number(r.bib)) as hi
      into v_out
    from public.registrations r
    where r.event_id = old.event_id
      and r.category = old.name
      and public._holds_bib(r.payment_status, r.payment_due_at)
      and public._bib_number(r.bib) is not null
      and public._bib_number(r.bib) not between new.bib_start and new.bib_end;

    if v_out.n > 0 then
      raise exception '% runner(s) in this category already hold bibs outside %–% (% to %). Keep the series around the numbers already issued.',
        v_out.n, new.bib_start, new.bib_end, v_out.lo, v_out.hi
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists event_categories_guard_bib_series on public.event_categories;
create trigger event_categories_guard_bib_series
  before insert or update on public.event_categories
  for each row execute function public._guard_bib_series();

create or replace function public._follow_category_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Entrants follow a rename. Their bibs are already in this series, so the
  -- trigger on registrations leaves the numbers alone.
  if new.name is distinct from old.name then
    update public.registrations
       set category = new.name
     where event_id = new.event_id and category = old.name;
  end if;

  -- A series widened after it filled up: entries confirmed in the meantime
  -- get their numbers now.
  if new.bib_start is distinct from old.bib_start or new.bib_end is distinct from old.bib_end then
    perform public._issue_missing_bibs(new.event_id, new.name);
  end if;

  return null;
end $$;

drop trigger if exists event_categories_follow_change on public.event_categories;
create trigger event_categories_follow_change
  after update on public.event_categories
  for each row execute function public._follow_category_change();

-- ── 9. Registration functions: the trigger issues the bib ───────────────────
-- Replace the 0011 versions. Identical apart from two things: neither calls
-- allocate_bib() any more, and the group function hands its rounding
-- remainder to a member by id rather than by bib -- an unpaid reservation now
-- has no bib to find it by.

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

  -- No bib here: registrations_assign_bib issues it from the category's
  -- series -- now if the entry holds its place, or when it is paid (0017).
  insert into public.registrations (
    first_name, last_name, email, phone, dob, gender,
    blood_group, emergency_contact_name, emergency_contact_number,
    has_medical_condition, allergies,
    city, state, pincode, club_name,
    category, tshirt_size, estimated_time, coupon_code,
    list_price, discount_amount, price,
    waivers_accepted, waivers_accepted_at,
    event_id, event_name, payment_status,
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
  'The public solo registration entry point. Validates event, category, capacity, age and consent, prices from event_categories, applies any valid coupon, inserts as PENDING -- a reservation with a payment deadline when online payment is on, PAID outright if nothing is owed. The bib comes from the category series via the registrations trigger (0017). Never trust the client for price or eligibility.';

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

    -- No bib here either: the registrations trigger issues it (0017).
    insert into public.registrations (
      first_name, last_name, email, phone, dob, gender,
      blood_group, emergency_contact_name, emergency_contact_number,
      has_medical_condition, allergies,
      city, state, pincode, club_name,
      category, tshirt_size, estimated_time, coupon_code,
      list_price, discount_amount, price,
      waivers_accepted, waivers_accepted_at,
      event_id, event_name, payment_status, group_id,
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
       and id = (v_results -> (v_first_elig - 1) ->> 'id')::uuid;
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

-- 0007's per-event counter is no longer used. Left in place because 0011's
-- self-check names allocate_bib(); nothing calls it.
comment on function public.allocate_bib(text) is
  'Superseded by 0017: bibs are issued from each category''s series by the registrations trigger _assign_bib(). Not called.';
comment on table public.bib_counters is
  'Superseded by 0017 (per-category bib series on event_categories). No longer read or written.';

-- ── 10. Reading bibs back ───────────────────────────────────────────────────
-- For the confirmation screen after payment. An online entry has no bib until
-- it is paid, and the paths that end in "paid" do not all bring the row back
-- with them (the webhook can settle first). Answers only for an id the
-- browser was given when it created the entry -- a random UUID -- and only
-- with the bib, category and status.
create or replace function public.get_entry_bibs(p_registration_id uuid, p_group_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',             r.id,
           'bib',            r.bib,
           'category',       r.category,
           'payment_status', r.payment_status
         ) order by public._bib_number(r.bib) nulls last, r.created_at), '[]'::jsonb)
  from public.registrations r
  where (p_registration_id is not null and r.id = p_registration_id)
     or (p_group_id is not null and r.group_id = p_group_id);
$$;

revoke all on function public.get_entry_bibs(uuid, uuid) from public;
grant execute on function public.get_entry_bibs(uuid, uuid) to anon, authenticated;

-- For Admin -> Categories: each series and how full it is.
create or replace function public.admin_bib_overview(p_event_id text)
returns table (
  category_id      uuid,
  name             text,
  bib_start        integer,
  bib_end          integer,
  issued           integer,
  retired          integer,
  awaiting_payment integer,
  missing          integer,
  numbers_left     integer,
  next_bib         text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id,
    c.name,
    c.bib_start,
    c.bib_end,
    count(*) filter (where public._holds_bib(r.payment_status, r.payment_due_at)
                       and public._bib_number(r.bib) between c.bib_start and c.bib_end)::integer,
    count(*) filter (where not public._holds_bib(r.payment_status, r.payment_due_at)
                       and public._bib_number(r.bib) between c.bib_start and c.bib_end)::integer,
    count(*) filter (where r.payment_status = 'PENDING' and r.payment_due_at is not null
                       and r.bib is null)::integer,
    count(*) filter (where public._holds_bib(r.payment_status, r.payment_due_at)
                       and r.bib is null)::integer,
    (c.bib_end - c.bib_start + 1 - (
      select count(*) from public.registrations x
      where x.event_id = c.event_id
        and public._bib_number(x.bib) between c.bib_start and c.bib_end
    ))::integer,
    public._next_bib(c.event_id, c.bib_start, c.bib_end)
  from public.event_categories c
  left join public.registrations r
    on r.event_id = c.event_id and r.category = c.name
  where c.event_id = p_event_id
    and public.is_admin()
  group by c.id
  order by c.bib_start;
$$;

revoke all on function public.admin_bib_overview(text) from public, anon;
grant execute on function public.admin_bib_overview(text) to authenticated;

comment on function public.admin_bib_overview(text) is
  'Admin only (empty for anyone else). Per category: the bib series, numbers issued to entries holding a place, numbers retired by cancelled entries, reservations awaiting payment (no bib yet), entries that should have a bib but have none because the series was full, numbers left, and the next number that will be issued.';

-- ── 11. Privileges ──────────────────────────────────────────────────────────
-- Supabase's default grants make new functions callable with the public key.
-- These change who holds which number; only the triggers should call them.
revoke all on function public._next_bib(text, integer, integer)            from public, anon, authenticated;
revoke all on function public._issue_missing_bibs(text, text)             from public, anon, authenticated;
revoke all on function public._suggest_bib_series(text, text, integer, uuid) from public, anon, authenticated;
revoke all on function public._lock_bibs(text)                            from public, anon, authenticated;

-- ── 12. Self-check ──────────────────────────────────────────────────────────
do $$
declare
  problems text := '';
  bad      record;
  v_n      integer;
begin
  for bad in
    select a.event_id, a.name as a_name, b.name as b_name
    from public.event_categories a
    join public.event_categories b
      on b.event_id = a.event_id and b.id > a.id
     and int4range(a.bib_start, a.bib_end, '[]') && int4range(b.bib_start, b.bib_end, '[]')
  loop
    problems := problems || format(E'\n  - bib series of "%s" and "%s" overlap in %s', bad.a_name, bad.b_name, bad.event_id);
  end loop;

  for bad in
    select f
    from unnest(array[
      'public._next_bib(text, integer, integer)',
      'public._issue_missing_bibs(text, text)',
      'public._suggest_bib_series(text, text, integer, uuid)',
      'public._lock_bibs(text)'
    ]) as f
    where has_function_privilege('anon', f, 'execute')
       or has_function_privilege('authenticated', f, 'execute')
  loop
    problems := problems || E'\n  - callable with a public or user key: ' || bad.f;
  end loop;

  if problems <> '' then
    raise exception 'Migration 0017 did not reach the intended state:%', problems;
  end if;

  -- Not fatal: a series that is already too small to number everyone is for
  -- the organiser to widen, and widening it issues the missing bibs.
  select count(*) into v_n
  from public.registrations reg
  join public.event_categories c on c.event_id = reg.event_id and c.name = reg.category
  join public.events e on e.id = reg.event_id
  where (e.date is null or e.date >= current_date)
    and public._holds_bib(reg.payment_status, reg.payment_due_at)
    and coalesce(public._bib_number(reg.bib) between c.bib_start and c.bib_end, false) = false;

  if v_n > 0 then
    raise warning '0017: % entr(y/ies) of upcoming events hold a place but have no bib in their series. Widen the series in Admin -> Categories.', v_n;
  end if;

  raise notice '0017 OK: every category has its own bib series and bibs are issued by the registrations trigger.';
end $$;
