-- 0015_sponsors.sql
--
-- Sponsor and partner logos for the landing page.
--
-- They appear in two places: a logo strip near the foot of the homepage, and,
-- for the few marked is_featured (a media partner, say), a credit in the hero
-- itself. Logos are uploaded from Admin -> Content -> Sponsors into the
-- existing past-events bucket under sponsors/, which 0009 already restricts to
-- admins, so no new bucket or storage policy is needed.
--
-- Site-wide rather than per edition: most sponsors return from one year to the
-- next, and retiring one is a visibility toggle rather than a re-upload.
--
-- Safe to re-run. Run after 0009.

create table if not exists public.sponsors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (btrim(name) <> ''),
  logo_url        text not null check (logo_url ~* '^(https?://|/)'),
  website_url     text check (website_url is null or website_url ~* '^https?://\S+$'),
  label           text,
  logo_background text not null default 'light' check (logo_background in ('light', 'dark')),
  is_featured     boolean not null default false,
  display_order   integer not null default 0,
  is_published    boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.sponsors is
  'Logos for the homepage sponsor strip. Site-wide, not per edition; hide a past sponsor with is_published.';
comment on column public.sponsors.name is
  'Sponsor name. Used as the logo''s alt text, so screen readers announce it.';
comment on column public.sponsors.website_url is
  'Where the logo links to, in a new tab. NULL renders the logo without a link.';
comment on column public.sponsors.label is
  'Credit shown with a featured sponsor, e.g. "Media Partner". NULL reads "In association with".';
comment on column public.sponsors.logo_background is
  'Colour of the tile behind the logo: light for dark artwork, dark for white artwork.';
comment on column public.sponsors.is_featured is
  'Also credited in the homepage hero and given a larger tile above the strip.';

drop trigger if exists sponsors_touch_updated_at on public.sponsors;
create trigger sponsors_touch_updated_at
  before update on public.sponsors
  for each row execute function public.touch_updated_at();

-- ── Row level security ──────────────────────────────────────────────────────
-- Same shape as the content tables in 0009, with one difference: a hidden
-- sponsor is not readable by the public. It may be a deal that has not been
-- announced yet, and the anon key ships in the JavaScript bundle.
alter table public.sponsors enable row level security;

drop policy if exists sponsors_public_read  on public.sponsors;
drop policy if exists sponsors_admin_insert on public.sponsors;
drop policy if exists sponsors_admin_update on public.sponsors;
drop policy if exists sponsors_admin_delete on public.sponsors;

create policy sponsors_public_read on public.sponsors
  for select using (is_published or public.is_admin());

create policy sponsors_admin_insert on public.sponsors
  for insert to authenticated with check (public.is_admin());

create policy sponsors_admin_update on public.sponsors
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy sponsors_admin_delete on public.sponsors
  for delete to authenticated using (public.is_admin());

-- Second layer, independent of the policies above.
revoke insert, update, delete, truncate on public.sponsors from anon;
grant select on public.sponsors to anon, authenticated;
grant insert, update, delete on public.sponsors to authenticated;

-- ── Assert the result ───────────────────────────────────────────────────────
do $$
declare
  bad      text;
  problems text := '';
begin
  for bad in
    select format('%s (%s)', policyname, cmd)
    from pg_policies
    where schemaname = 'public' and tablename = 'sponsors'
      and cmd <> 'SELECT'
      and (roles = '{public}' or 'anon' = any (roles))
  loop
    problems := problems || E'\n  - policy reachable by anon: ' || bad;
  end loop;

  for bad in
    select privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'sponsors'
      and grantee = 'anon'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  loop
    problems := problems || E'\n  - anon still holds ' || bad;
  end loop;

  if problems <> '' then
    raise exception E'sponsors is writable anonymously:%s', problems;
  end if;
end $$;
