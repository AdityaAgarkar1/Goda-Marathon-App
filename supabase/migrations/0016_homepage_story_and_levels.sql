-- 0016_homepage_story_and_levels.sql
--
-- Homepage copy that tells first-time visitors why this race and where to
-- start, after a design review found the page gave facts but no story, no
-- reason to choose it, and nothing for someone who had never run a trail.
--
--   1. event_categories.level and .audience: who each distance is for,
--      shown on the homepage cards and in the registration form.
--   2. homepage_blocks: short admin-edited pieces of homepage copy --
--      the organisers' story, what makes the race different, and tips for
--      first-timers. Edited from Admin -> Content -> Homepage.
--
-- Seeded only with facts the site already publishes (category settings, the
-- event page's aid-station and medical details, the race-day schedule), so
-- the sections are not empty on day one. The story is not seeded: only the
-- organisers can write it.
--
-- Run BEFORE deploying the matching frontend: until it runs, the homepage
-- hides the new sections, and saving a category in the admin panel fails on
-- the missing columns. Safe to re-run. Run after 0015.

-- ── 1. Who each distance is for ─────────────────────────────────────────────
alter table public.event_categories
  add column if not exists level    text,
  add column if not exists audience text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'event_categories_level_check'
  ) then
    alter table public.event_categories
      add constraint event_categories_level_check
      check (level is null or level in ('beginner', 'intermediate', 'experienced'));
  end if;
end $$;

comment on column public.event_categories.level is
  'beginner | intermediate | experienced. Shown as a label on the homepage card and in the registration form. NULL shows no label.';
comment on column public.event_categories.audience is
  'One line on who the distance suits, e.g. "Families and first-timers; walking is fine". NULL hides the line.';

-- A starting point for distances written in km, by the usual convention:
-- up to 5 km for beginners, up to 10 km intermediate, longer experienced.
-- Only fills rows still unset, so re-running never overrides the admin.
update public.event_categories c
set level = case
  when d.km <= 5  then 'beginner'
  when d.km <= 10 then 'intermediate'
  else 'experienced'
end
from (
  select id, regexp_replace(lower(distance), '[^0-9.]', '', 'g')::numeric as km
  from public.event_categories
  where distance ~* '^\s*[0-9]+(\.[0-9]+)?\s*km?\s*$'
) d
where c.id = d.id
  and c.level is null;

-- ── 2. Homepage copy blocks ─────────────────────────────────────────────────
create table if not exists public.homepage_blocks (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('story', 'usp', 'tip')),
  title         text not null check (btrim(title) <> ''),
  body          text,
  icon          text,
  display_order integer not null default 0,
  is_published  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.homepage_blocks is
  'Short pieces of homepage copy. Site-wide, not per edition. story: the organisers'' story above the past-editions timeline. usp: "What makes it different". tip: the first-timer guide.';
comment on column public.homepage_blocks.title is
  'story: a single strong opening line. usp and tip: a short heading.';
comment on column public.homepage_blocks.icon is
  'Key of an icon from the fixed set in src/utils/blockIcons.js, e.g. "mountain". Unknown or NULL falls back to a default. Not used for story.';

create index if not exists homepage_blocks_kind_order_idx
  on public.homepage_blocks (kind, display_order);

drop trigger if exists homepage_blocks_touch_updated_at on public.homepage_blocks;
create trigger homepage_blocks_touch_updated_at
  before update on public.homepage_blocks
  for each row execute function public.touch_updated_at();

-- ── Seed ────────────────────────────────────────────────────────────────────
-- Each kind is seeded only while it has no rows at all, so deleting a seeded
-- block and re-running this file does not bring it back.
insert into public.homepage_blocks (kind, title, body, icon, display_order)
select v.kind, v.title, v.body, v.icon, v.display_order
from (values
  ('usp', 'Trail, not tarmac',
   'Run the trails around the Gangapur backwaters near Nashik instead of city roads, with up to 330 m of climbing on the half marathon.',
   'mountain', 0),
  ('usp', 'A distance for every runner',
   'From a 3 km fun run open to ages 7 and up, to a 21 km trail half marathon. First-timers and seasoned trail runners share the same morning.',
   'route', 1),
  ('usp', 'Looked after on the course',
   'Aid stations with water, electrolytes, glucose biscuits and fruit, plus emergency medical support, physiotherapists and mountain rescue.',
   'shield', 2),
  ('usp', 'Chip-timed results',
   'Timing chips on the 10, 15 and 21 km routes, with results published on this site after the race.',
   'timer', 3)
) as v(kind, title, body, icon, display_order)
where not exists (select 1 from public.homepage_blocks b where b.kind = 'usp');

insert into public.homepage_blocks (kind, title, body, icon, display_order)
select v.kind, v.title, v.body, v.icon, v.display_order
from (values
  ('tip', 'Carry some water',
   'Plan to run with at least 500 ml. Aid stations along the route have water, electrolytes, glucose biscuits, fruit and first aid.',
   'droplet', 0),
  ('tip', 'Arrive early',
   'Warm-up starts at 05:00 AM at Palmstays, Nagalwadi. Each distance flags off at its own time, shown on its card above.',
   'sunrise', 1)
) as v(kind, title, body, icon, display_order)
where not exists (select 1 from public.homepage_blocks b where b.kind = 'tip');

-- ── Row level security ──────────────────────────────────────────────────────
-- Same shape as sponsors (0015): the public reads published blocks only, so a
-- draft can be written ahead of time without the anon key exposing it.
alter table public.homepage_blocks enable row level security;

drop policy if exists homepage_blocks_public_read  on public.homepage_blocks;
drop policy if exists homepage_blocks_admin_insert on public.homepage_blocks;
drop policy if exists homepage_blocks_admin_update on public.homepage_blocks;
drop policy if exists homepage_blocks_admin_delete on public.homepage_blocks;

create policy homepage_blocks_public_read on public.homepage_blocks
  for select using (is_published or public.is_admin());

create policy homepage_blocks_admin_insert on public.homepage_blocks
  for insert to authenticated with check (public.is_admin());

create policy homepage_blocks_admin_update on public.homepage_blocks
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy homepage_blocks_admin_delete on public.homepage_blocks
  for delete to authenticated using (public.is_admin());

-- Second layer, independent of the policies above.
revoke insert, update, delete, truncate on public.homepage_blocks from anon;
grant select on public.homepage_blocks to anon, authenticated;
grant insert, update, delete on public.homepage_blocks to authenticated;

-- ── Assert the result ───────────────────────────────────────────────────────
do $$
declare
  bad      text;
  problems text := '';
begin
  for bad in
    select format('%s (%s)', policyname, cmd)
    from pg_policies
    where schemaname = 'public' and tablename = 'homepage_blocks'
      and cmd <> 'SELECT'
      and (roles = '{public}' or 'anon' = any (roles))
  loop
    problems := problems || E'\n  - policy reachable by anon: ' || bad;
  end loop;

  for bad in
    select privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'homepage_blocks'
      and grantee = 'anon'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  loop
    problems := problems || E'\n  - anon still holds ' || bad;
  end loop;

  if problems <> '' then
    raise exception E'homepage_blocks is writable anonymously:%s', problems;
  end if;
end $$;
