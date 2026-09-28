-- 0013_admin_delete_registrations.sql
--
-- Run after 0012. Lets an organiser permanently delete entries from the admin
-- panel -- a test entry, a duplicate typed in twice, a group entered by
-- mistake -- instead of only marking them CANCELLED.
--
-- The RLS policies from 0009/0010 already let an admin DELETE rows directly,
-- but a bare DELETE leaves the bookkeeping around the row wrong:
--
--   * A claimed coupon use is never handed back, so a code with max_uses runs
--     out on entries that no longer exist.
--   * registrations.group_id is ON DELETE SET NULL, so deleting a group turns
--     its members into orphaned solo entries instead of removing them.
--   * Deleting one member of a group leaves the group's participant_count and
--     total describing someone who is not in it, and the next payment order
--     would charge for them.
--
-- The two functions below do the delete and the bookkeeping in one
-- transaction. Payment rows are deliberately kept: payments.registration_id
-- and payments.group_id are ON DELETE SET NULL, so the money trail survives,
-- and a payment that lands after the delete is flagged "no longer exists" by
-- settle_payment() and shows up in the admin refund list.
--
-- Safe to re-run.

-- ── 1. Coupon use: claimed and not yet returned? ────────────────────────────
-- A code on a solo row (or coupon_id on a group) means a use was claimed.
-- The lapsed-hold sweeper and cancel_reservation() hand it back when they
-- cancel, and record why in cancelled_reason. An admin cancellation leaves
-- cancelled_reason NULL and never returned the use. So the use is still held
-- unless the entry was cancelled with a reason.
create or replace function public._coupon_use_held(p_status text, p_reason text)
returns boolean
language sql
immutable
as $$
  select p_status is distinct from 'CANCELLED' or p_reason is null;
$$;

revoke all on function public._coupon_use_held(text, text) from public, anon, authenticated;

-- ── 2. Delete whole groups ──────────────────────────────────────────────────
-- The group row, every member, and the group's single coupon redemption.
create or replace function public.admin_delete_groups(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g   record;
  v_n integer := 0;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  -- Group before members: the order settlement and cancel_reservation() lock
  -- in, so a delete racing a payment cannot deadlock with it.
  for g in
    select * from public.registration_groups
     where id = any(p_ids)
     order by id
       for update
  loop
    delete from public.registrations where group_id = g.id;

    if g.coupon_id is not null
       and public._coupon_use_held(g.payment_status, g.cancelled_reason) then
      update public.coupons
         set uses = greatest(uses - 1, 0), updated_at = now()
       where id = g.coupon_id;
    end if;

    delete from public.registration_groups where id = g.id;
    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

comment on function public.admin_delete_groups(uuid[]) is
  'Admin only. Permanently deletes group entries with all their members, returning the group''s coupon use if it was still held. Payment rows are kept (group_id set NULL). Returns the number of groups deleted.';

revoke all on function public.admin_delete_groups(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_delete_groups(uuid[]) to authenticated;

-- ── 3. Delete individual entries ────────────────────────────────────────────
-- Solo entries go with their coupon use returned. Group members are taken out
-- of their group, whose count and money drop by exactly that member's share,
-- so the group total stays the sum of the rows in it. A group left with no
-- members is deleted too, through admin_delete_groups().
create or replace function public.admin_delete_registrations(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r         record;
  v_n       integer := 0;
  v_groups  uuid[];
  v_empty   uuid[];
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;

  select array_agg(distinct group_id) into v_groups
    from public.registrations
   where id = any(p_ids) and group_id is not null;

  -- Groups before members, as in admin_delete_groups().
  perform 1 from public.registration_groups
   where id = any(coalesce(v_groups, '{}'))
   order by id
     for update;

  for r in
    select * from public.registrations
     where id = any(p_ids)
     order by id
       for update
  loop
    if r.group_id is null then
      if r.coupon_code is not null
         and public._coupon_use_held(r.payment_status, r.cancelled_reason) then
        update public.coupons
           set uses = greatest(uses - 1, 0), updated_at = now()
         where event_id = r.event_id and upper(code) = upper(r.coupon_code);
      end if;
    else
      update public.registration_groups
         set participant_count = greatest(participant_count - 1, 0),
             subtotal = greatest(subtotal - coalesce(r.list_price, r.price, 0), 0),
             discount = greatest(discount - coalesce(r.discount_amount, 0), 0),
             total    = greatest(total    - coalesce(r.price, 0), 0)
       where id = r.group_id;
    end if;

    delete from public.registrations where id = r.id;
    v_n := v_n + 1;
  end loop;

  -- An empty group would sit on the dashboard with nobody in it and a total
  -- of zero.
  select array_agg(g.id) into v_empty
    from public.registration_groups g
   where g.id = any(coalesce(v_groups, '{}'))
     and not exists (select 1 from public.registrations m where m.group_id = g.id);

  if v_empty is not null then
    perform public.admin_delete_groups(v_empty);
  end if;

  return v_n;
end $$;

comment on function public.admin_delete_registrations(uuid[]) is
  'Admin only. Permanently deletes entries. Solo: coupon use returned if still held. Group member: the group''s participant_count, subtotal, discount and total are reduced by that member''s share, and a group left empty is deleted. Payment rows are kept (registration_id set NULL). Returns the number of entries deleted.';

revoke all on function public.admin_delete_registrations(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_delete_registrations(uuid[]) to authenticated;
