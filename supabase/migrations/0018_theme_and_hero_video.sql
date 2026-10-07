-- 0018_theme_and_hero_video.sql
--
-- Two settings for the Sunrise redesign, both edited in Admin -> Event
-- Settings:
--
--   1. site_settings.default_theme: whether a first-time visitor sees the
--      light or the dark theme. A visitor who flips the switch in the header
--      keeps their own choice; this is only the starting point.
--   2. events.hero_video: an optional short, muted loop that plays over the
--      homepage hero photo. The photo stays as the poster and the fallback.
--
-- site_settings is a single row, for settings that belong to the site rather
-- than to one edition: a theme should not reset to light every time the next
-- edition's event row is created.
--
-- Run BEFORE deploying the matching frontend: until it runs, the site uses the
-- light theme and saving Event Settings fails on the missing hero_video
-- column. Safe to re-run. Run after 0017.

-- ── 1. Site-wide settings ───────────────────────────────────────────────────
create table if not exists public.site_settings (
  -- Always true: the primary key plus this check allow exactly one row.
  id            boolean primary key default true check (id),
  default_theme text not null default 'light'
                check (default_theme in ('light', 'dark', 'system')),
  updated_at    timestamptz not null default now()
);

comment on table public.site_settings is
  'One row of site-wide settings that outlive any single edition.';
comment on column public.site_settings.default_theme is
  'Theme a visitor gets until they choose one with the header switch: light | dark | system (follow the visitor''s device).';

insert into public.site_settings (id) values (true)
on conflict (id) do nothing;

drop trigger if exists site_settings_touch_updated_at on public.site_settings;
create trigger site_settings_touch_updated_at
  before update on public.site_settings
  for each row execute function public.touch_updated_at();

-- Everyone reads it (the theme is applied before anyone signs in); only an
-- admin may change it. There is no insert or delete policy: the one row is
-- created above and is never meant to go away.
alter table public.site_settings enable row level security;

drop policy if exists site_settings_public_read  on public.site_settings;
drop policy if exists site_settings_admin_update on public.site_settings;

create policy site_settings_public_read on public.site_settings
  for select using (true);

create policy site_settings_admin_update on public.site_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke insert, update, delete, truncate on public.site_settings from anon;
revoke insert, delete, truncate on public.site_settings from authenticated;
grant select on public.site_settings to anon, authenticated;
grant update on public.site_settings to authenticated;

-- ── 2. Homepage hero video ──────────────────────────────────────────────────
alter table public.events
  add column if not exists hero_video text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_hero_video_url_check'
  ) then
    alter table public.events
      add constraint events_hero_video_url_check
      check (hero_video is null or hero_video ~* '^(https?://|/)\S+$');
  end if;
end $$;

comment on column public.events.hero_video is
  'Optional MP4 that loops, muted, over the homepage hero photo. Uploaded from Event Settings (10 MB bucket limit) or a direct file URL. NULL shows the photo only.';

-- ── Assert the result ───────────────────────────────────────────────────────
do $$
declare
  bad      text;
  problems text := '';
begin
  for bad in
    select format('%s (%s)', policyname, cmd)
    from pg_policies
    where schemaname = 'public' and tablename = 'site_settings'
      and cmd <> 'SELECT'
      and (roles = '{public}' or 'anon' = any (roles))
  loop
    problems := problems || E'\n  - policy reachable by anon: ' || bad;
  end loop;

  for bad in
    select grantee || ' ' || privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'site_settings'
      and (
        (grantee = 'anon' and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
        or (grantee = 'authenticated' and privilege_type in ('INSERT', 'DELETE', 'TRUNCATE'))
      )
  loop
    problems := problems || E'\n  - still granted: ' || bad;
  end loop;

  if (select count(*) from public.site_settings) <> 1 then
    problems := problems || E'\n  - site_settings does not hold exactly one row';
  end if;

  if problems <> '' then
    raise exception E'site_settings is not locked down:%s', problems;
  end if;
end $$;
