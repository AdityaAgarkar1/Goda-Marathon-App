-- 0012_cancel_reservation.sql
--
-- Run after 0011. Lets a runner release their own unpaid online reservation.
--
-- Until now the only way out of the payment step was to wait for the hold to
-- lapse. A runner who spotted a mistake -- wrong category, a typo in their
-- name -- could not fix it: going back to the form and resubmitting was
-- refused with "already registered", because their own reservation still held
-- the email address for up to half an hour.
--
-- cancel_reservation() releases it immediately: status CANCELLED,
-- cancelled_reason RUNNER_CANCELLED, coupon use handed back. The place, the
-- bib's category slot and the email are free again at once.
--
-- Who may cancel: whoever holds the reservation's id. That is the same
-- bearer-token model razorpay-order already uses -- the id is an unguessable
-- UUID returned only to the person who made the reservation -- and the
-- function can do nothing worse than what waiting would do anyway. It never
-- touches a paid entry, and never an offline PENDING entry (no deadline):
-- those are the organisers' to cancel, as the refund policy says.
--
-- A payment that lands after a runner cancelled -- they paid by UPI, then
-- pressed cancel before the bank confirmed -- is handled like a payment after
-- the hold lapsed: the entry is reinstated if its email is still free, and
-- flagged REFUND_REQUIRED otherwise. The two settlement helpers from 0011 are
-- replaced below to treat both reasons alike.
--
-- Safe to re-run.

-- ── 1. Release a reservation ────────────────────────────────────────────────
create or replace function public.cancel_reservation(p_registration_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row   public.registrations%rowtype;
  v_group public.registration_groups%rowtype;
begin
  if (p_registration_id is null) = (p_group_id is null) then
    return jsonb_build_object('status', 'BAD_REQUEST');
  end if;

  if p_registration_id is not null then
    select * into v_row from public.registrations where id = p_registration_id for update;

    if not found then
      return jsonb_build_object('status', 'NOT_FOUND');
    end if;

    -- A group is released as a whole, by its coordinator. Pulling one member
    -- out would leave the group total describing people who are not in it.
    if v_row.group_id is not null then
      return jsonb_build_object('status', 'CANCEL_AS_GROUP');
    end if;

    -- The payment beat the cancel. The caller shows the confirmation instead.
    if v_row.payment_status = 'PAID' then
      return jsonb_build_object('status', 'PAID', 'payment_ref', v_row.payment_ref);
    end if;

    -- Pressed twice, or the sweeper got there first: either way it is gone.
    if v_row.payment_status = 'CANCELLED' then
      return jsonb_build_object('status', 'CANCELLED');
    end if;

    if v_row.payment_status is distinct from 'PENDING' or v_row.payment_due_at is null then
      return jsonb_build_object('status', 'NOT_CANCELLABLE');
    end if;

    update public.registrations
       set payment_status = 'CANCELLED', cancelled_reason = 'RUNNER_CANCELLED'
     where id = p_registration_id;

    -- As in expire_unpaid_holds(): a solo row carries a code only when it paid
    -- out, so a code here is a claimed use to return.
    if v_row.coupon_code is not null then
      update public.coupons
         set uses = greatest(uses - 1, 0), updated_at = now()
       where event_id = v_row.event_id and upper(code) = upper(v_row.coupon_code);
    end if;

    return jsonb_build_object('status', 'CANCELLED');
  end if;

  select * into v_group from public.registration_groups where id = p_group_id for update;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if v_group.payment_status = 'PAID' then
    return jsonb_build_object('status', 'PAID', 'payment_ref', v_group.payment_ref);
  end if;

  if v_group.payment_status = 'CANCELLED' then
    return jsonb_build_object('status', 'CANCELLED');
  end if;

  if v_group.payment_status is distinct from 'PENDING' or v_group.payment_due_at is null then
    return jsonb_build_object('status', 'NOT_CANCELLABLE');
  end if;

  update public.registration_groups
     set payment_status = 'CANCELLED', cancelled_reason = 'RUNNER_CANCELLED'
   where id = p_group_id;

  update public.registrations
     set payment_status = 'CANCELLED', cancelled_reason = 'RUNNER_CANCELLED'
   where group_id = p_group_id
     and payment_status = 'PENDING';

  -- One redemption for the whole group, returned once.
  if v_group.coupon_id is not null then
    update public.coupons
       set uses = greatest(uses - 1, 0), updated_at = now()
     where id = v_group.coupon_id;
  end if;

  return jsonb_build_object('status', 'CANCELLED');
end $$;

comment on function public.cancel_reservation(uuid, uuid) is
  'Release an unpaid online reservation (solo, or a whole group) at the runner''s request: CANCELLED / RUNNER_CANCELLED, coupon use returned. Never touches a paid entry or an offline PENDING one. Answers with a status rather than raising.';

-- A public entry point, like create_registration(): the reservation id is the
-- credential. Revoked from everyone first so the grant below is the whole list.
revoke all on function public.cancel_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_reservation(uuid, uuid) to anon, authenticated, service_role;

comment on column public.registrations.cancelled_reason is
  'Why the entry is CANCELLED when it was not an admin. PAYMENT_TIMEOUT = an online reservation whose hold lapsed unpaid. RUNNER_CANCELLED = the runner released their unpaid reservation. NULL for cancellations made by an admin.';

-- ── 2. Settlement: a runner-cancelled reservation is treated like a lapsed one ─
-- Replaces the 0011 versions. The only change is the reinstate condition,
-- which now accepts RUNNER_CANCELLED alongside PAYMENT_TIMEOUT.
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

  if v_row.payment_status = 'CANCELLED'
     and v_row.cancelled_reason in ('PAYMENT_TIMEOUT', 'RUNNER_CANCELLED') then
    -- Paid after the reservation lapsed or was released -- a slow UPI
    -- approval, typically, or cancel pressed while the bank was still
    -- confirming. The runner has paid, so the entry comes back rather than the
    -- money going back. The category may now be one over its limit; that is
    -- the lesser problem, and far rarer than the slow approval itself.
    begin
      update public.registrations
         set payment_status = 'PAID', cancelled_reason = null,
             payment_ref = p_payment_id, paid_at = now()
       where id = p_id;
    exception when unique_violation then
      return format('Paid after the reservation (bib %s) had expired, and the same email has entered again since.',
                    coalesce(v_row.bib, '?'));
    end;

    -- expire_unpaid_holds() / cancel_reservation() handed the coupon use back; the price paid still
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

  if v_group.payment_status = 'CANCELLED'
     and v_group.cancelled_reason in ('PAYMENT_TIMEOUT', 'RUNNER_CANCELLED') then
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
         and cancelled_reason in ('PAYMENT_TIMEOUT', 'RUNNER_CANCELLED');
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

revoke all on function public._settle_registration(uuid, text) from public, anon, authenticated;
revoke all on function public._settle_group(uuid, text)        from public, anon, authenticated;

-- ── 3. Assert the result ────────────────────────────────────────────────────
do $$
begin
  if not has_function_privilege('anon', 'public.cancel_reservation(uuid, uuid)', 'execute') then
    raise exception 'Migration 0012: anon cannot execute cancel_reservation(), so runners cannot cancel.';
  end if;

  if has_function_privilege('anon', 'public._settle_registration(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public._settle_group(uuid, text)', 'execute') then
    raise exception 'Migration 0012: a settlement helper is callable with the public key.';
  end if;

  raise notice '0012 OK: runners can release their own unpaid reservations; settlement treats runner-cancelled like lapsed.';
end $$;
