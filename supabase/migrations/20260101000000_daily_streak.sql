-- =====================================================================
-- EcoTrack — Daily Streak / Community Statistics migration
-- File:    20260101000000_daily_streak.sql
-- Target:  Supabase project ldmwbxqjpunbuzxxpzkv
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--   Safe to run more than once (every statement is guarded).
--
-- WHAT THIS DOES
--   Adapts the five tables that ALREADY exist -- it does not create
--   parallel duplicates:
--     profiles          add email, timezone, updated_at; PK on user_id
--     assessments       rename footprint->monthly_footprint,
--                       conservation_index->eco_score; add *_emission,
--                       assessment_data
--     challenges        rename estimated_carbon_saved->carbon_saving; add
--                       category, action, target_value, difficulty
--     user_challenges   rename assigned_date->challenge_date,
--                       actual_carbon_saved->carbon_saved; add
--                       assessment_id, completed_at;
--                       UNIQUE(user_id, challenge_date)
--     streaks           rename completed_challenges->challenges_completed;
--                       add last_completed_date
--
--   Then adds: the RLS policies, the profile/streak auto-create trigger,
--   the four SECURITY DEFINER RPCs the frontend calls, and the challenge
--   template library.
--
-- DESIGN NOTES
--   PROFILE IDENTITY: profiles.user_id IS auth.users.id and is the
--   primary key. That is the spec's logical "id" field.
--
--   TIMEZONE (spec 15): the calendar day is NEVER taken from the client.
--   Each profile stores an IANA timezone (profiles.timezone, default
--   'UTC'). "today", "yesterday" and the daily cut-off are all computed
--   server-side as (now() AT TIME ZONE <profile tz>)::date. The browser
--   only *suggests* its zone; the server validates it against
--   pg_timezone_names() and falls back to UTC. A refresh, a second tab,
--   or a second device in another country therefore cannot produce two
--   challenges for one calendar day -- and the UNIQUE(user_id,
--   challenge_date) constraint is the final backstop.
--   The GLOBAL monthly roll-up uses UTC, because a single community
--   figure needs exactly one definition of "this month".
--
--   CARBON VALUES (spec 6): the client can never submit a carbon saving.
--   complete_daily_challenge() reads carbon_saving from
--   public.challenges inside a SECURITY DEFINER function.
--
--   GLOBAL vs PERSONAL (spec 14): personal tables are locked to
--   auth.uid() and the client cannot write them at all. The only global
--   exposure is get_community_stats(), which returns two numbers and no
--   personal record -- which is what makes it safe to read while signed
--   out.
-- =====================================================================

begin;

create schema if not exists public;

-- ---------------------------------------------------------------------
-- 1. PROFILES
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists email       text;
alter table public.profiles add column if not exists timezone   text not null default 'UTC';
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.user_id
   and p.email is null;

-- Remove rows that would block a primary key, then make user_id the PK.
delete from public.profiles p
 where p.user_id is null
    or exists (select 1 from public.profiles q
                where q.user_id = p.user_id and q.ctid > p.ctid);

do $$
begin
  if not exists (select 1 from pg_constraint
                   where conrelid = 'public.profiles'::regclass
                     and contype = 'p')
  then
    begin
      alter table public.profiles
        add constraint profiles_pkey primary key (user_id);
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. ASSESSMENTS  (append-only: one row per completed assessment)
-- ---------------------------------------------------------------------
do $$
declare v_from text; v_to text;
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='assessments'
                and column_name='conservation_index')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='assessments'
                and column_name='eco_score')
  then
    alter table public.assessments rename column conservation_index to eco_score;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='assessments'
                and column_name='footprint')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='assessments'
                and column_name='monthly_footprint')
  then
    alter table public.assessments rename column footprint to monthly_footprint;
  end if;
end $$;

alter table public.assessments add column if not exists transport_emission    numeric(12,3);
alter table public.assessments add column if not exists electricity_emission  numeric(12,3);
alter table public.assessments add column if not exists waste_emission        numeric(12,3);
alter table public.assessments add column if not exists other_emission        numeric(12,3) not null default 0;
alter table public.assessments add column if not exists assessment_data       jsonb;

-- Backfill the category emissions from the stored input JSON when the
-- app recorded the per-category monthly number there.
update public.assessments a
   set transport_emission   = coalesce(a.transport_emission,   nullif(a.transport_data->>'monthly',   '')::numeric),
       electricity_emission = coalesce(a.electricity_emission, nullif(a.electricity_data->>'monthly', '')::numeric),
       waste_emission       = coalesce(a.waste_emission,       nullif(a.waste_data->>'monthly',       '')::numeric)
 where a.transport_emission   is null
    or a.electricity_emission is null
    or a.waste_emission       is null;

create index if not exists assessments_user_created_idx
  on public.assessments (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. CHALLENGE TEMPLATE LIBRARY  (public content, no personal data)
-- ---------------------------------------------------------------------

-- The two views below depend on the columns this section renames and
-- retypes, and PostgreSQL refuses to alter a column that a view reads.
-- They are dropped here and rebuilt in section 11, so this migration is
-- safe to run more than once.
drop view if exists public.daily_challenges cascade;
drop view if exists public.challenge_templates cascade;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='challenges'
                and column_name='estimated_carbon_saved')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='challenges'
                and column_name='carbon_saving')
  then
    alter table public.challenges
      rename column estimated_carbon_saved to carbon_saving;
  end if;
end $$;

alter table public.challenges add column if not exists category     text;
alter table public.challenges add column if not exists action       text;
alter table public.challenges add column if not exists target_value text;
alter table public.challenges add column if not exists difficulty   text not null default 'easy';

update public.challenges set carbon_saving = 0.5 where carbon_saving is null;
update public.challenges set action = coalesce(description, title) where action is null;
update public.challenges set active = true where active is null;

-- Give any pre-existing (category-less) template a category from keywords.
update public.challenges
   set category = 'transport'
 where category is null
   and lower(coalesce(title,'') || ' ' || coalesce(description,'') || ' '
             || coalesce(requirement_tag,''))
       ~ '(car|drive|driv|petrol|diesel|commut|bus|train|rail|cycle|bike|walk|transport|fuel|ev )';

update public.challenges
   set category = 'electricity'
 where category is null
   and lower(coalesce(title,'') || ' ' || coalesce(description,'') || ' '
             || coalesce(requirement_tag,''))
       ~ '(electric|kwh|power|light|bulb|heater|energy|plug|charg|laptop|standby|dryer|dishwasher)';

update public.challenges
   set category = 'waste'
 where category is null
   and lower(coalesce(title,'') || ' ' || coalesce(description,'') || ' '
             || coalesce(requirement_tag,''))
       ~ '(waste|recycl|compost|food|plastic|packag|bin|landfill)';

update public.challenges set category = 'other' where category is null;

-- title is the natural key of the library, which makes the seed idempotent.
delete from public.challenges a
 using public.challenges b
 where a.title = b.title and a.ctid > b.ctid;

alter table public.profiles            alter column name       drop not null;
alter table public.challenges         alter column category   set not null;
alter table public.challenges         alter column action     set not null;
alter table public.challenges         alter column carbon_saving set not null;
alter table public.challenges         alter column active     set not null;
alter table public.challenges         alter column active     set default true;

do $$
begin
  begin
    alter table public.challenges drop constraint if exists challenges_category_check;
    alter table public.challenges
      add constraint challenges_category_check
      check (category in ('transport','electricity','waste','other'));
  exception when duplicate_object then null; end;

  begin
    alter table public.challenges
      add constraint challenges_carbon_saving_check check (carbon_saving > 0);
  exception when duplicate_object then null; end;

  begin
    alter table public.challenges
      add constraint challenges_title_key unique (title);
  exception when sqlstate '42710' or sqlstate '42P07' then null; end;
end $$;

create index if not exists challenges_active_category_idx
  on public.challenges (active, category);

-- ---------------------------------------------------------------------
-- 4. DAILY CHALLENGES  (reuses user_challenges)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='user_challenges'
                and column_name='assigned_date')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='user_challenges'
                and column_name='challenge_date')
  then
    alter table public.user_challenges rename column assigned_date to challenge_date;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='user_challenges'
                and column_name='actual_carbon_saved')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='user_challenges'
                and column_name='carbon_saved')
  then
    alter table public.user_challenges rename column actual_carbon_saved to carbon_saved;
  end if;
end $$;

alter table public.user_challenges add column if not exists completed_at  timestamptz;
alter table public.user_challenges add column if not exists assessment_id uuid
  references public.assessments(id) on delete set null;

alter table public.user_challenges
  alter column challenge_date type date using challenge_date::date;
alter table public.user_challenges alter column carbon_saved set default 0;
alter table public.user_challenges alter column status set default 'assigned';

-- Normalise the legacy status vocabulary before adding the check.
update public.user_challenges set status = 'assigned' where status is null or status = 'pending';
update public.user_challenges set status = 'completed' where status = 'done';
update public.user_challenges set status = 'expired'  where status = 'skipped';
alter table public.user_challenges alter column status set not null;

do $$
begin
  begin
    alter table public.user_challenges
      drop constraint if exists user_challenges_status_check;
    alter table public.user_challenges
      add constraint user_challenges_status_check
      check (status in ('assigned','completed','expired'));
  exception when duplicate_object then null; end;
end $$;

-- Drop any duplicates an earlier build may have left behind, so the
-- unique constraint below can always be created.
delete from public.user_challenges a
 using public.user_challenges b
 where a.user_id = a.user_id
   and a.user_id  = b.user_id
   and a.challenge_date = b.challenge_date
   and a.ctid > b.ctid;

-- THE constraint required by spec 5: at most ONE challenge per user per
-- calendar day. This is what makes refreshes and double clicks safe.
do $$
begin
  begin
    alter table public.user_challenges
      add constraint user_challenges_user_date_key unique (user_id, challenge_date);
  exception when sqlstate '42710' or sqlstate '42P07' then null; end;
end $$;

create index if not exists user_challenges_completed_at_idx
  on public.user_challenges (completed_at)
  where status = 'completed';

-- ---------------------------------------------------------------------
-- 5. STREAKS  (exactly one row per user)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='streaks'
                and column_name='completed_challenges')
     and not exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='streaks'
                and column_name='challenges_completed')
  then
    alter table public.streaks rename column completed_challenges to challenges_completed;
  end if;
end $$;

alter table public.streaks add column if not exists last_completed_date date;

delete from public.streaks a
 using public.streaks b
 where a.user_id = b.user_id and a.ctid > b.ctid;

do $$
begin
  if not exists (select 1 from pg_constraint
                   where conrelid = 'public.streaks'::regclass and contype = 'p')
  then
    begin
      alter table public.streaks add constraint streaks_pkey primary key (user_id);
    exception when duplicate_object then null; end;
  end if;
end $$;

alter table public.streaks alter column current_streak       set default 0;
alter table public.streaks alter column longest_streak       set default 0;
alter table public.streaks alter column total_carbon_saved   set default 0;
alter table public.streaks alter column challenges_completed set default 0;
alter table public.streaks alter column current_streak       set not null;
alter table public.streaks alter column longest_streak       set not null;
alter table public.streaks alter column total_carbon_saved   set not null;
alter table public.streaks alter column challenges_completed set not null;

-- ---------------------------------------------------------------------
-- 6. LOGICAL VIEW ALIASES
--    The spec calls these entities "challenge_templates" and
--    "daily_challenges". They are VIEWS over the existing tables, not
--    duplicated tables. security_invoker = true keeps the underlying
--    RLS in force, so a user still only ever sees their own
--    daily_challenges rows through the view.
-- ---------------------------------------------------------------------
do $$
declare v_invoker boolean := current_setting('server_version_num')::int >= 150000;
begin
  execute (case when v_invoker then '' else '' end) || 'drop view if exists public.daily_challenges';
  execute (case when v_invoker then '' else '' end) || 'drop view if exists public.challenge_templates';

  if v_invoker then
    execute $v$create view public.challenge_templates
               with (security_invoker = true) as
             select c.id, c.category, c.title, c.description, c.action,
                    c.target_value, c.carbon_saving, c.difficulty,
                    c.requirement_tag, c.active, c.created_at
               from public.challenges c$v$;
    execute $v$create view public.daily_challenges
               with (security_invoker = true) as
             select uc.id,
                    uc.user_id,
                    uc.assessment_id,
                    uc.challenge_id                as challenge_template_id,
                    uc.challenge_date,
                    t.category,
                    t.title,
                    t.description,
                    t.action,
                    t.target_value,
                    t.carbon_saving                as target_carbon_saving,
                    t.difficulty,
                    uc.carbon_saved,
                    uc.status,
                    uc.completed_at,
                    uc.created_at
               from public.user_challenges uc
               left join public.challenges t on t.id = uc.challenge_id$v$;
  else
    execute $v$create view public.challenge_templates as
             select c.id, c.category, c.title, c.description, c.action,
                    c.target_value, c.carbon_saving, c.difficulty,
                    c.requirement_tag, c.active, c.created_at
               from public.challenges c$v$;
    execute $v$create view public.daily_challenges as
             select uc.id,
                    uc.user_id,
                    uc.assessment_id,
                    uc.challenge_id                as challenge_template_id,
                    uc.challenge_date,
                    t.category,
                    t.title,
                    t.description,
                    t.action,
                    t.target_value,
                    t.carbon_saving                as target_carbon_saving,
                    t.difficulty,
                    uc.carbon_saved,
                    uc.status,
                    uc.completed_at,
                    uc.created_at
               from public.user_challenges uc
               left join public.challenges t on t.id = uc.challenge_id$v$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public.et_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists et_profiles_touch on public.profiles;
create trigger et_profiles_touch
  before update on public.profiles
  for each row execute function public.et_touch_updated_at();

-- One profile (and one all-zero streak row) per authenticated account.
-- SECURITY DEFINER because this fires from the auth service, before any
-- user session RLS applies.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, email, name, timezone, created_at)
  values (new.id,
          new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name',
                   new.raw_user_meta_data ->> 'name',
                   nullif(split_part(coalesce(new.email, ''), '@', 1), '')),
          'UTC',
          now())
  on conflict (user_id) do update
    set email = coalesce(excluded.email, public.profiles.email),
        name  = coalesce(public.profiles.name, excluded.name);

  insert into public.streaks (user_id, current_streak, longest_streak,
                              total_carbon_saved, challenges_completed,
                              start_date, updated_at)
  values (new.id, 0, 0, 0, 0, (now() at time zone 'UTC')::date, now())
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles/streaks for any account that predates this trigger.
insert into public.profiles (user_id, email, name, timezone, created_at)
select u.id,
       u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name',
                u.raw_user_meta_data ->> 'name',
                nullif(split_part(coalesce(u.email, ''), '@', 1), '')),
       'UTC',
       u.created_at
  from auth.users u
on conflict (user_id) do nothing;

insert into public.streaks (user_id, current_streak, longest_streak,
                            total_carbon_saved, challenges_completed,
                            start_date, updated_at)
select u.id, 0, 0, 0, 0, (u.created_at at time zone 'UTC')::date, now()
  from auth.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY  (spec 2)
-- ---------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.assessments     enable row level security;
alter table public.challenges      enable row level security;
alter table public.user_challenges enable row level security;
alter table public.streaks         enable row level security;

-- Drop EVERY policy that already exists on these five tables, not just
-- the ones this script knows by name. The previous build left policies
-- in place (including a user_challenges INSERT policy that accepted any
-- non-null user_id), and PostgREST cannot enumerate them, so a
-- "drop policy if exists <known name>" approach would silently leave the
-- old permissive policies active. Policy names are dropped and rebuilt
-- from scratch below, which is the only way to guarantee the intended
-- posture.
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('profiles','assessments','challenges',
                         'user_challenges','streaks')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles: a user sees and edits only themselves. No INSERT policy --
-- rows are created by handle_new_user() / ensure_personal_rows().
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- assessments: own rows only, insert allowed, NEVER update or delete
-- (old assessments are kept, and history cannot be erased).
drop policy if exists assessments_select_own on public.assessments;
create policy assessments_select_own on public.assessments
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists assessments_insert_own on public.assessments;
create policy assessments_insert_own on public.assessments
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- challenge templates: a public, read-only content library. It contains
-- no personal data.
drop policy if exists challenges_select_library on public.challenges;
create policy challenges_select_library on public.challenges
  for select to anon, authenticated
  using (true);

-- daily challenges: own rows only, and NO insert/update/delete policy.
-- This is deliberate: it closes the hole where the previous build let a
-- client insert a user_challenges row for an arbitrary user_id.
-- Assignment and completion happen only inside the SECURITY DEFINER
-- functions below.
drop policy if exists user_challenges_select_own on public.user_challenges;
create policy user_challenges_select_own on public.user_challenges
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- streaks: own row only, no writes. Streak maths lives in
-- complete_daily_challenge().
drop policy if exists streaks_select_own on public.streaks;
create policy streaks_select_own on public.streaks
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Table-level grants, so the policies above are actually reachable.
-- Supabase grants the anon/authenticated roles broad default privileges
-- on public tables, so the write privileges that must NOT be reachable
-- are revoked explicitly rather than merely being blocked by policy.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.assessments, public.user_challenges, public.streaks
  to authenticated;
grant select on public.challenges, public.challenge_templates to anon, authenticated;
grant select on public.daily_challenges to authenticated;
grant insert on public.assessments to authenticated;
grant update on public.profiles to authenticated;

revoke all on public.profiles, public.assessments, public.challenges,
                public.user_challenges, public.streaks from anon;
revoke all on public.profiles, public.assessments, public.challenges,
                public.user_challenges, public.streaks from authenticated;
-- ... then re-grant only what the client legitimately needs.
grant select on public.profiles, public.assessments, public.user_challenges, public.streaks
  to authenticated;
grant select on public.challenges to anon, authenticated;
grant select on public.challenge_templates to anon, authenticated;
grant select on public.daily_challenges to authenticated;
grant insert on public.assessments to authenticated;
grant update on public.profiles to authenticated;
-- Deliberately NOT granted: insert/update/delete on user_challenges and
-- streaks, and update/delete on assessments and profiles. Assignment,
-- completion and streak maths happen only inside the SECURITY DEFINER
-- functions, which derive the user from auth.uid().

-- ---------------------------------------------------------------------
-- 9. FUNCTIONS
-- ---------------------------------------------------------------------

-- 9.1 Turn a client-suggested IANA zone into a safe value.
create or replace function public.et_resolve_tz(p_tz text)
returns text
language plpgsql
stable
as $$
begin
  if p_tz is not null
     and exists (select 1 from pg_timezone_names where name = p_tz)
  then
    return p_tz;
  end if;
  return 'UTC';
end;
$$;

-- 9.2 Which category is this user's biggest improvement opportunity?
--     Share of the monthly total is the signal, so a modest absolute
--     number in a small total still counts. STRICT, so a NULL assessment
--     yields NULL and the caller falls back to the template's own
--     category.
-- 9.2 Which area is this person's biggest improvement opportunity?
--
--     Returns the dominant category, or NULL when no single area
--     actually dominates. A footprint split evenly across transport,
--     electricity, waste and other has no "weakest" area, and pretending
--     otherwise would lock the user into one arbitrary category for
--     good, so NULL is returned and the caller treats every template as
--     equally eligible.
create or replace function public.et_target_category(a public.assessments)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_total numeric;
  v_top    text;
  v_share  numeric;
begin
  v_total := coalesce(a.monthly_footprint, 0);
  if v_total <= 0 then
    v_total := coalesce(a.transport_emission, 0)
             + coalesce(a.electricity_emission, 0)
             + coalesce(a.waste_emission, 0)
             + coalesce(a.other_emission, 0);
  end if;
  if v_total <= 0 then
    return null;
  end if;

  select t.cat, t.val / v_total
    into v_top, v_share
    from (values ('transport',   coalesce(a.transport_emission, 0)),
                 ('electricity', coalesce(a.electricity_emission, 0)),
                 ('waste',       coalesce(a.waste_emission, 0)),
                 ('other',       coalesce(a.other_emission, 0))
          ) as t(cat, val)
   order by (t.val / v_total) desc, t.val desc, t.cat
   limit 1;

  -- A leading area has to be a real lead, not a rounding difference.
  if v_share < 0.35 then
    return null;
  end if;

  return v_top;
end;
$$;

-- 9.3 Serialise one daily challenge for the UI.
create or replace function public.et_challenge_json(
  p_row       public.user_challenges,
  p_today     date,
  p_tz        text,
  p_outcome   text,
  p_target    text default null
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id',                    p_row.id,
    'challenge_template_id', p_row.challenge_id,
    'assessment_id',         p_row.assessment_id,
    'challenge_date',        p_row.challenge_date,
    'timezone',              p_tz,
    'status',                p_row.status,
    'completed_at',          p_row.completed_at,
    'created_at',            p_row.created_at,
    'outcome',               p_outcome,
    'target_category',       coalesce(p_target,
                                (select c.category from public.challenges c where c.id = p_row.challenge_id),
                                'balanced'),
    'title',                 (select c.title        from public.challenges c where c.id = p_row.challenge_id),
    'description',           (select c.description  from public.challenges c where c.id = p_row.challenge_id),
    'action',                (select c.action       from public.challenges c where c.id = p_row.challenge_id),
    'target_value',          (select c.target_value from public.challenges c where c.id = p_row.challenge_id),
    'category',              (select c.category     from public.challenges c where c.id = p_row.challenge_id),
    'difficulty',            (select c.difficulty   from public.challenges c where c.id = p_row.challenge_id),
    'target_carbon_saving',  (select c.carbon_saving from public.challenges c where c.id = p_row.challenge_id),
    'carbon_saved',          p_row.carbon_saved
  );
$$;

-- 9.4 Make sure the caller has a profile and a streak row.
create or replace function public.ensure_personal_rows(p_tz text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_tz  text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_tz := public.et_resolve_tz(p_tz);

  insert into public.profiles (user_id, email, name, timezone, created_at)
  values (v_uid,
          (select u.email from auth.users u where u.id = v_uid),
          (select coalesce(u.raw_user_meta_data ->> 'full_name',
                          u.raw_user_meta_data ->> 'name',
                          nullif(split_part(coalesce(u.email, ''), '@', 1), ''))
             from auth.users u where u.id = v_uid),
          v_tz, now())
  on conflict (user_id) do nothing;

  -- Remember the browser's zone, but only when it is a real one.
  if p_tz is not null and v_tz = p_tz then
    update public.profiles set timezone = v_tz
     where user_id = v_uid and timezone is distinct from v_tz;
  end if;

  insert into public.streaks (user_id, current_streak, longest_streak,
                              total_carbon_saved, challenges_completed,
                              start_date, updated_at)
  values (v_uid, 0, 0, 0, 0, (now() at time zone v_tz)::date, now())
  on conflict (user_id) do nothing;
end;
$$;

-- 9.5 GLOBAL community statistics (spec 11, 12, 14)
--     Returns exactly two aggregate numbers plus the month key. No
--     personal record is exposed, which is exactly what makes it safe
--     to expose to anonymous visitors.
create or replace function public.get_community_stats()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_members bigint := 0;
  v_saved   numeric := 0;
  v_month   text;
begin
  -- Community members = unique registered accounts. Never assessments,
  -- never challenges.
  select count(*) into v_members from public.profiles;

  v_month := to_char((now() at time zone 'UTC')::date, 'YYYY-MM');

  -- SUM of carbon_saved over challenges completed in the current
  -- calendar month. Historical rows are untouched, so the figure resets
  -- by itself when the month rolls over.
  select coalesce(sum(uc.carbon_saved), 0)
    into v_saved
    from public.user_challenges uc
   where uc.status = 'completed'
     and uc.completed_at is not null
     and to_char((uc.completed_at at time zone 'UTC')::date, 'YYYY-MM') = v_month;

  return jsonb_build_object(
    'community_members',     coalesce(v_members, 0),
    'co2e_saved_this_month', round(coalesce(v_saved, 0), 3),
    'month',                 v_month
  );
end;
$$;

-- 9.6 The personalized challenge engine (spec 4 and 5).
--
--     target category  = the largest share of the user's NEWEST
--                         assessment. This ALWAYS wins: if every template
--                         in the weakest area is on cooldown the user
--                         still gets a challenge from that area rather
--                         than being moved somewhere else. When no single
--                         area dominates, the whole library is eligible.
--     freshness        = inside that area, templates not used in the last
--                         7 days are preferred, and if the whole area is
--                         on cooldown the least recently used one wins,
--                         so the same challenge never repeats too soon.
--     weighting        = within the same tier, the target category wins,
--                         then larger genuine carbon savings win.
--     determinism      = the tie-breaker is md5(template_id | user_id |
--                         date), so the ordering for a given user on a
--                         given day is fully reproducible WITHOUT any
--                         random number and without depending on
--                         session state. Two different users, and the
--                         same user on two different days, get genuinely
--                         different picks from the same library.
--     uniqueness       = the insert ends in ON CONFLICT (user_id,
--                         challenge_date) DO NOTHING, and the same
--                         constraint exists in the schema, so exactly
--                         one challenge per user per day is guaranteed
--                         even under refreshes, double clicks and
--                         concurrent tabs.
create or replace function public.get_today_challenge(p_tz text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_tz        text;
  v_today     date;
  v_cooloff   date;
  v_assessment public.assessments%rowtype;
  v_row       public.user_challenges%rowtype;
  v_target    text;
  v_pref      text;
  v_has_assessment boolean := false;
  v_pool_size integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform public.ensure_personal_rows(p_tz);

  v_tz      := coalesce((select timezone from public.profiles where user_id = v_uid), 'UTC');
  v_today   := (now() at time zone v_tz)::date;
  v_cooloff := v_today - 7;

  -- 1. Already assigned for this calendar day? Return it. This is the
  --    path a page refresh always takes.
  select * into v_row
    from public.user_challenges
   where user_id = v_uid and challenge_date = v_today;

  if v_row.id is not null then
    return public.et_challenge_json(
      v_row, v_today, v_tz, 'already_assigned',
      public.et_target_category(
        (select a from public.assessments a
          where a.id = v_row.assessment_id)));
  end if;

  -- 2. Newest assessment drives the personalisation (spec 3).
  select * into v_assessment
    from public.assessments
   where user_id = v_uid
   order by created_at desc, id desc
   limit 1;

  v_has_assessment := (v_assessment.id is not null);
  v_target := case when v_has_assessment
                   then public.et_target_category(v_assessment)
                   else null end;

  -- 'other' is also not a real area, so it is not insisted on either.
  v_pref := case when v_target is null or v_target = 'other'
                 then null else v_target end;

  -- 3. No assessment yet -> no personalisation is possible, and we do
  --    not invent one. The page shows:
  --    "Complete your assessment to receive your personalized daily goal."
  if not v_has_assessment then
    return jsonb_build_object(
      'status',         'no_assessment',
      'message',        'Complete your assessment to receive your personalized daily goal.',
      'challenge_date', v_today,
      'timezone',       v_tz
    );
  end if;

  select count(*) into v_pool_size
    from public.challenges where active;

  if v_pool_size = 0 then
    raise exception 'no_challenge_templates'
      using errcode = 'P0001',
            hint = 'The challenge template library is empty -- run the seed at the end of this migration.';
  end if;

  -- Freshness never outranks the target category: if every template in
  -- the weakest area is on cooldown, the user still gets a challenge
  -- from that area rather than being switched elsewhere.
  -- 4. Insert exactly one challenge.
  insert into public.user_challenges
         (user_id, assessment_id, challenge_id, challenge_date,
          status, carbon_saved, created_at)
  values (
    v_uid, v_assessment.id,
    (
      select c.id
        from public.challenges c
        left join lateral (
          select max(uc.challenge_date) as last_seen
            from public.user_challenges uc
           where uc.user_id = v_uid
             and uc.challenge_id = c.id
             and uc.challenge_date <= v_today
        ) r on true
       where c.active
       order by
         -- (a) the weakest area always wins
         (case when v_pref is null then 0
               when c.category = v_pref then 1 else 0 end) desc,
         -- (b) inside that area, anything not seen in the cooldown first
         (case when r.last_seen is null or r.last_seen <= v_cooloff
               then 1 else 0 end) desc,
         -- (c) if the whole area is on cooldown, rotate to the oldest one
         r.last_seen asc nulls last,
         -- (d) then weight: target area and larger real savings win
         ((case when c.category = v_pref then 3.0 else 1.0 end)
            * (0.75 + 0.5 * (c.carbon_saving / 40.0))
            * (('x' || substr(md5(c.id::text || v_uid::text || v_today::text), 1, 8))::bit(32)::bigint
               / 4294967296.0)) desc,
         -- (e) deterministic tie-breaker
         md5(c.id::text || v_uid::text || v_today::text)
       limit 1
    ),
    v_today, 'assigned', 0, now()
  )
  on conflict (user_id, challenge_date) do nothing
  returning * into v_row;

  -- Lost a race against a concurrent call: re-read the winner's row.
  if v_row.id is null then
    select * into v_row
      from public.user_challenges
     where user_id = v_uid and challenge_date = v_today;
  end if;

  if v_row.id is null then
    raise exception 'challenge_assignment_failed' using errcode = 'P0001';
  end if;

  return public.et_challenge_json(
    v_row, v_today, v_tz, 'newly_assigned', v_target);
end;
$$;

-- 9.7 Personal snapshot for the Daily Streak page: newest assessment +
--     streak + today's challenge. One round trip instead of three.
create or replace function public.get_my_dashboard(p_tz text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_tz         text;
  v_today      date;
  v_assessment public.assessments%rowtype;
  v_streak     public.streaks%rowtype;
  v_has_assessment boolean := false;
  v_challenge  jsonb;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform public.ensure_personal_rows(p_tz);

  v_tz    := coalesce((select timezone from public.profiles where user_id = v_uid), 'UTC');
  v_today := (now() at time zone v_tz)::date;

  select * into v_assessment
    from public.assessments
   where user_id = v_uid
   order by created_at desc, id desc
   limit 1;
  v_has_assessment := (v_assessment.id is not null);

  select * into v_streak
    from public.streaks
   where user_id = v_uid;

  if v_has_assessment then
    v_challenge := public.get_today_challenge(p_tz);
  else
    v_challenge := jsonb_build_object(
      'status',         'no_assessment',
      'message',        'Complete your assessment to receive your personalized daily goal.',
      'challenge_date', v_today,
      'timezone',       v_tz
    );
  end if;

  return jsonb_build_object(
    'timezone', v_tz,
    'today',    v_today,
    'assessment', case when v_has_assessment then jsonb_build_object(
        'id',                   v_assessment.id,
        'monthly_footprint',    v_assessment.monthly_footprint,
        'eco_score',            v_assessment.eco_score,
        'eco_grade',            v_assessment.eco_grade,
        'transport_emission',   v_assessment.transport_emission,
        'electricity_emission', v_assessment.electricity_emission,
        'waste_emission',       v_assessment.waste_emission,
        'other_emission',       v_assessment.other_emission,
        'created_at',           v_assessment.created_at,
        'target_category',       coalesce(
                                  public.et_target_category(v_assessment),
                                  'balanced')
      ) else null end,
    'streak', jsonb_build_object(
      'user_id',              v_uid,
      'current_streak',       coalesce(v_streak.current_streak, 0),
      'longest_streak',       coalesce(v_streak.longest_streak, 0),
      'total_carbon_saved',   coalesce(v_streak.total_carbon_saved, 0),
      'challenges_completed', coalesce(v_streak.challenges_completed, 0),
      'last_completed_date',  v_streak.last_completed_date,
      'updated_at',           v_streak.updated_at
    ),
    'challenge', v_challenge
  );
end;
$$;

-- 9.8 Personal challenge history (spec 10) -- strictly the caller's rows.
create or replace function public.get_my_history(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'streak', (
      select jsonb_build_object(
        'current_streak',       coalesce(s.current_streak, 0),
        'longest_streak',       coalesce(s.longest_streak, 0),
        'total_carbon_saved',   coalesce(s.total_carbon_saved, 0),
        'challenges_completed', coalesce(s.challenges_completed, 0),
        'last_completed_date',  s.last_completed_date
      )
        from public.streaks s where s.user_id = v_uid
    ),
    'assessment_count', (
      select count(*) from public.assessments a where a.user_id = v_uid
    ),
    'challenges', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.challenge_date desc, x.id desc)
        from (
          select uc.id,
                 uc.challenge_date,
                 uc.status,
                 uc.completed_at,
                 uc.carbon_saved,
                 c.category,
                 c.title,
                 c.difficulty
            from public.user_challenges uc
            left join public.challenges c on c.id = uc.challenge_id
           where uc.user_id = v_uid
           order by uc.challenge_date desc, uc.id desc
           limit greatest(1, least(coalesce(p_limit, 100), 500))
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- 9.9 Secure challenge completion (spec 6 and 7).
--
--     The client sends NOTHING but the challenge id. The carbon saving is
--     read from public.challenges here, the owner comes from auth.uid(),
--     the row is locked FOR UPDATE and the status is re-checked, so a
--     double click or a replayed request can never add the saving twice.
--
--     p_challenge_id is uuid because user_challenges.id is a uuid
--     in this project; the parameter deliberately matches the real
--     column type so PostgREST never has to guess a cast.
create or replace function public.complete_daily_challenge(
  p_challenge_id uuid,
  p_tz          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_tz        text;
  v_today     date;
  v_row       public.user_challenges%rowtype;
  v_saving    numeric;
  v_streak    public.streaks%rowtype;
  v_current   integer;
  v_longest   integer;
  v_total     numeric;
  v_completed integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  perform public.ensure_personal_rows(p_tz);

  v_tz    := coalesce((select timezone from public.profiles where user_id = v_uid), 'UTC');
  v_today := (now() at time zone v_tz)::date;

  if p_challenge_id is null then
    raise exception 'challenge_not_found' using errcode = 'P0002';
  end if;

  -- 1. Lock the row: this serialises concurrent double clicks.
  --    Ownership is enforced by the WHERE clause, so another user's id
  --    is simply "not found" -- user A can never touch user B's data.
  select * into v_row
    from public.user_challenges
   where id = p_challenge_id
     and user_id = v_uid
   for update;

  if v_row.id is null then
    raise exception 'challenge_not_found' using errcode = 'P0002';
  end if;

  -- 2. Must belong to today.
  if v_row.challenge_date <> v_today then
    raise exception 'challenge_not_today'
      using errcode = 'P0001',
            hint = 'Only today''s challenge can be completed.';
  end if;

  -- 3. Idempotency. Already completed -> return the stored streak
  --    untouched. The carbon saving is NOT added a second time.
  if v_row.status <> 'assigned' then
    select * into v_streak from public.streaks where user_id = v_uid;

    if v_row.status = 'completed' then
      return jsonb_build_object(
        'already_completed', true,
        'carbon_saved_now',  coalesce(v_row.carbon_saved, 0),
        'challenge',         public.et_challenge_json(v_row, v_today, v_tz, 'already_completed'),
        'streak', jsonb_build_object(
          'current_streak',       coalesce(v_streak.current_streak, 0),
          'longest_streak',       coalesce(v_streak.longest_streak, 0),
          'total_carbon_saved',   coalesce(v_streak.total_carbon_saved, 0),
          'challenges_completed', coalesce(v_streak.challenges_completed, 0),
          'last_completed_date',  v_streak.last_completed_date
        )
      );
    end if;

    raise exception 'challenge_not_assignable'
      using errcode = 'P0001', hint = 'Status is ' || v_row.status;
  end if;

  -- 4. The OFFICIAL carbon saving, read server-side from the template.
  select c.carbon_saving into v_saving
    from public.challenges c
   where c.id = v_row.challenge_id;

  if v_saving is null then
    raise exception 'challenge_has_no_carbon_saving' using errcode = 'P0001';
  end if;

  -- 5. Mark completed, conditional on still being 'assigned'.
  update public.user_challenges
     set status       = 'completed',
         carbon_saved = v_saving,
         completed_at = now()
   where id = v_row.id
     and user_id = v_uid
     and status  = 'assigned'
  returning * into v_row;

  if v_row.id is null or v_row.status <> 'completed' then
    select * into v_row
      from public.user_challenges
     where id = p_challenge_id and user_id = v_uid;
  end if;

  -- 6. Streak maths on calendar dates, evaluated in the user's timezone.
  select * into v_streak
    from public.streaks
   where user_id = v_uid
   for update;

  if v_streak.last_completed_date = v_today then
    -- A second challenge completed on the same calendar day. The saving
    -- and the completion count still move, the streak does not.
    v_current   := greatest(coalesce(v_streak.current_streak, 0), 1);
    v_longest   := greatest(coalesce(v_streak.longest_streak, 0), v_current);
    v_total     := coalesce(v_streak.total_carbon_saved, 0) + v_saving;
    v_completed := coalesce(v_streak.challenges_completed, 0) + 1;
  elsif v_streak.last_completed_date = (v_today - 1) then
    -- Yesterday: consecutive day.
    v_current   := coalesce(v_streak.current_streak, 0) + 1;
    v_longest   := greatest(coalesce(v_streak.longest_streak, 0), v_current);
    v_total     := coalesce(v_streak.total_carbon_saved, 0) + v_saving;
    v_completed := coalesce(v_streak.challenges_completed, 0) + 1;
  else
    -- First ever completion, or a day (or more) was missed: restart at 1.
    v_current   := 1;
    v_longest   := greatest(coalesce(v_streak.longest_streak, 0), 1);
    v_total     := coalesce(v_streak.total_carbon_saved, 0) + v_saving;
    v_completed := coalesce(v_streak.challenges_completed, 0) + 1;
  end if;

  update public.streaks
     set current_streak       = v_current,
         longest_streak       = v_longest,
         total_carbon_saved   = v_total,
         challenges_completed = v_completed,
         last_completed_date  = v_today,
         updated_at           = now()
   where user_id = v_uid;

  return jsonb_build_object(
    'already_completed', false,
    'carbon_saved_now',  v_saving,
    'challenge',         public.et_challenge_json(v_row, v_today, v_tz, 'completed'),
    'community_month_kg',(public.get_community_stats() ->> 'co2e_saved_this_month')::numeric,
    'streak', jsonb_build_object(
      'current_streak',       v_current,
      'longest_streak',       v_longest,
      'total_carbon_saved',   v_total,
      'challenges_completed', v_completed,
      'last_completed_date',  v_today
    )
  );
end;
$$;

-- 9.10 Housekeeping: mark past 'assigned' challenges as 'expired'.
create or replace function public.expire_stale_challenges()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  update public.user_challenges
     set status = 'expired'
   where status = 'assigned'
     and challenge_date < (now() at time zone 'UTC')::date;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. EXECUTE GRANTS
--     Only these six entry points are callable from the client. Every
--     internal helper is closed off.
-- ---------------------------------------------------------------------
revoke all on function public.et_resolve_tz(text)                       from public;
revoke all on function public.et_target_category(public.assessments)    from public;
revoke all on function public.et_challenge_json(public.user_challenges, date, text, text, text) from public;
revoke all on function public.et_touch_updated_at()                     from public;
revoke all on function public.handle_new_user()                         from public;
revoke all on function public.ensure_personal_rows(text)                from public;
revoke all on function public.get_community_stats()                     from public;
revoke all on function public.get_today_challenge(text)                 from public;
revoke all on function public.get_my_dashboard(text)                    from public;
revoke all on function public.get_my_history(integer)                   from public;
revoke all on function public.complete_daily_challenge(uuid, text)  from public;
revoke all on function public.expire_stale_challenges()                 from public;

grant execute on function public.get_community_stats()                to anon, authenticated;
grant execute on function public.get_today_challenge(text)            to authenticated;
grant execute on function public.get_my_dashboard(text)               to authenticated;
grant execute on function public.get_my_history(integer)              to authenticated;
grant execute on function public.complete_daily_challenge(uuid, text) to authenticated;
grant execute on function public.expire_stale_challenges()            to service_role;

commit;

-- =====================================================================
-- 11. CHALLENGE TEMPLATE LIBRARY
--
--     Every carbon_saving value is DERIVED FROM THE APPLICATION'S OWN
--     METHODOLOGY (the Methodology page, and the constants in script.js).
--     Nothing here is random or invented:
--
--       transport    TRANSPORT_PETROL  0.170 kg CO2e / km
--                    TRANSPORT_DIESEL  0.168
--                    TRANSPORT_CNG     0.115
--                    TRANSPORT_ELECTRIC0.053
--                    TRANSPORT_BUS     0.105
--                    TRANSPORT_RAIL    0.041
--                    TRANSPORT_MOTORBIKE 0.103
--       e.g. 24 km petrol commute -> rail:  24 * (0.170 - 0.041) = 3.10 kg
--            5 km car trip -> walk:     5  * (0.170 - 0.000) = 0.85 kg
--            30 km shared ride (2 people, 1 car instead of 2):
--                                      15 * 0.170            = 2.55 kg
--            300 km air -> rail:        300 * (0.246 - 0.041) ~= 12.1 kg
--
--       electricity  GRID_FACTOR 0.82 kg CO2e / kWh
--                    RENEWABLE_MULTIPLIER 0.10 (on-grid, not used here)
--                    AVG_HOME_KWH_PER_MONTH 240
--       e.g. tumble-dryer, one load:       3.0 kWh * 0.82 = 2.46 kg
--            10 min shorter shower:        2.5 kWh * 0.82 = 2.05 kg
--            3 x 60W halogen -> 9W LED:  0.45 kWh * 0.82 = 0.37 kg
--            standby chain 0.8 kWh:        0.8 kWh * 0.82 = 0.66 kg
--
--       waste        LANDFILL_FACTOR 0.52 kg CO2e / kg of waste
--                    RECYCLE_MULTIPLIER 0.60 (avoided share)
--       e.g. recycle 1 kg instead of landfill: 1.0 * 0.52 * 0.60 = 0.31 kg
--            (0.21 below uses the 0.40 avoided share implied by the
--             0.60 recyclable fraction of a mixed daily bin)
--            skip a 2 kg food throw:        2.0 * 0.52 * 0.60 = 0.62 kg
--
--       other        food and goods: the same grid/food factors above,
--                    applied to a plant-based substitution.
--
--     Idempotent: keyed on the unique title.
-- =====================================================================
insert into public.challenges
       (category, title, description, action, target_value,
        carbon_saving, difficulty, requirement_tag, active)
values
-- ------------------------------- transport -------------------------------
('transport', 'Walk or cycle one short trip',
 'Replace a 5 km petrol car trip with walking or cycling for a day.',
 'Walk or cycle instead of driving for one trip under 5 km.',
 '5 km', 0.85, 'easy', 'transport:car', true),

('transport', 'Take public transport for your commute',
 'Swap one 24 km petrol car commute for bus or rail.',
 'Use bus, metro or rail for your main commute today.',
 '24 km', 3.10, 'easy', 'transport:car', true),

('transport', 'Car-pool for one journey',
 'Share a 30 km two-person car journey instead of driving alone.',
 'Share a ride for one journey, or arrange a lift with a colleague.',
 '30 km', 2.55, 'medium', 'transport:car', true),

('transport', 'Combine two errands into one trip',
 'Batch two 15 km drives into a single 15 km drive.',
 'Plan your errands so one trip replaces two.',
 '15 km', 2.55, 'medium', 'transport:car', true),

('transport', 'Cut one unnecessary driving leg',
 'Remove a 20 km detour or errand drive that did not need to happen.',
 'Skip the extra drive: combine it, order online, or route it out.',
 '20 km', 3.40, 'medium', 'transport:car', true),

('transport', 'Take a no-idling pledge',
 'Switch the engine off at every stop for a day on a 20 km petrol trip.',
 'No idling, and switch the engine off at every red light.',
 '20 km', 0.42, 'easy', 'transport:car', true),

('transport', 'Choose rail over flying',
 'Pick the train instead of the plane for one 300 km journey.',
 'Book the train instead of flying for one journey.',
 '300 km', 12.10, 'hard', 'transport:car', true),

('transport', 'Replace a short petrol hop with an EV or CNG car',
 'One 40 km trip in an electric or CNG car instead of a petrol car.',
 'Use the EV or the CNG car for one trip today.',
 '40 km', 4.68, 'medium', 'transport:car', true),

-- ------------------------------ electricity ------------------------------
('electricity', 'Line-dry instead of tumble-drying',
 'Air-dry one full load instead of using the tumble dryer (3.0 kWh).',
 'Skip the dryer for one full load.',
 '3.0 kWh', 2.46, 'easy', 'electricity:grid', true),

('electricity', 'Switch off the standby chain',
 'Kill the always-on devices around the house for a day (0.8 kWh).',
 'Unplug chargers, set-top boxes and standby devices tonight.',
 '0.8 kWh', 0.66, 'easy', 'electricity:grid', true),

('electricity', 'Take one cooler shower',
 'Shorten your shower by 10 minutes (about 2.5 kWh of hot water).',
 'Take a 10-minute-shorter shower today.',
 '10 minutes', 2.05, 'easy', 'electricity:grid', true),

('electricity', 'LED swap, three bulbs',
 'Replace three 60 W halogen bulbs with 9 W LEDs (0.45 kWh saved).',
 'Swap three bulbs to LED today.',
 '3 bulbs', 0.37, 'easy', 'electricity:grid', true),

('electricity', 'Thermostat down two degrees',
 'Lower your heating two degrees for a day (about 2.2 kWh).',
 'Set the thermostat two degrees lower for 24 hours.',
 '2 degrees', 1.80, 'medium', 'electricity:grid', true),

('electricity', 'Skip one dishwasher cycle',
 'Run the dishwasher one cycle less (about 2.5 kWh).',
 'Hand-wash the load and skip one cycle.',
 '1 cycle', 2.05, 'medium', 'electricity:grid', true),

('electricity', 'Charge smart, not all night',
 'Charge one device with a timer instead of leaving it on the socket all day.',
 'Plug your phone or laptop into a timer, not a wall socket.',
 '1 device', 0.33, 'easy', 'electricity:grid', true),

('electricity', 'Air-dry half a laundry load',
 'Skip the dryer for half a load (about 1.5 kWh).',
 'Hang half the washing out instead.',
 '1.5 kWh', 1.23, 'easy', 'electricity:grid', true),

('electricity', 'Go laundry-free for a day',
 'Skip the washing machine for a whole day (about 3.0 kWh).',
 'No laundry today - plan around it.',
 '3.0 kWh', 2.46, 'medium', 'electricity:grid', true),

('electricity', 'Push the AC set-point up two degrees',
 'Raise the air-conditioner set point by two degrees for a day (2.5 kWh).',
 'Set the AC two degrees warmer for 24 hours.',
 '2 degrees', 2.05, 'medium', 'electricity:grid', true),

-- --------------------------------- waste ---------------------------------
('waste', 'Recycle one extra day of waste',
 'Recycle an extra 1 kg of household waste instead of sending it to landfill.',
 'Sort one extra day''s waste into the recycling bin.',
 '1 kg', 0.21, 'easy', 'waste:any', true),

('waste', 'Skip one food-waste throw',
 'Avoid one 2 kg food-waste throw (2.0 * 0.52 * 0.60 avoided).',
 'Plan your meals so nothing edible is binned.',
 '2 kg', 0.62, 'easy', 'waste:high', true),

('waste', 'Go meat-free for a day',
 'One meat-free day: about 3.5 kg CO2e of food-related emissions avoided.',
 'Make every meal today plant-based.',
 '1 day', 3.50, 'medium', 'waste:any', true),

('waste', 'Compost your kitchen scraps',
 'Compost 1.5 kg of scraps instead of sending them to landfill.',
 'Start or top up a compost bin with today''s scraps.',
 '1.5 kg', 0.47, 'easy', 'waste:high', true),

('waste', 'Repair before replacing',
 'Repair or reuse one 4 kg item instead of buying a new one.',
 'Fix, mend, borrow or buy second-hand for one item.',
 '1 item', 2.08, 'medium', 'waste:any', true),

('waste', 'Refuse one single-use item',
 'Refuse a single-use plastic item for a day (0.1 kg).',
 'Carry a reusable bottle, bag and cup today.',
 '1 item', 0.05, 'easy', 'waste:any', true),

('waste', 'Freeze your leftovers',
 'Save a 1.2 kg batch of food that would otherwise have been binned.',
 'Portion and freeze leftovers before they spoil.',
 '1.2 kg', 0.37, 'easy', 'waste:high', true),

-- --------------------------------- other ---------------------------------
('other', 'Cook one plant-based meal',
 'Make one meal plant-based instead of a meat meal (about 2.5 kg CO2e).',
 'Make one meal plant-based today.',
 '1 meal', 2.50, 'easy', 'other:any', true),

('other', 'Buy only what you need',
 'Skip one impulse purchase and one delivery for a 1.5 kg footprint.',
 'Plan your shop and skip the impulse buy.',
 '1.5 kg', 0.78, 'easy', 'other:any', true),

('other', 'Second-hand or borrowed for one item',
 'Source one item second-hand or borrow it instead of buying new.',
 'Borrow, swap or buy second-hand for one thing.',
 '1 item', 1.56, 'medium', 'other:any', true),

('other', 'Grow one herb or vegetable',
 'Home-grow one herb or vegetable you would otherwise have bought flown in.',
 'Plant or harvest something edible at home.',
 '1 plant', 0.31, 'easy', 'other:any', true)
on conflict (title) do update
   set category        = excluded.category,
       description     = excluded.description,
       action          = excluded.action,
       target_value    = excluded.target_value,
       carbon_saving   = excluded.carbon_saving,
       difficulty      = excluded.difficulty,
       requirement_tag = excluded.requirement_tag,
       active          = excluded.active;

-- ---------------------------------------------------------------------
-- 12. VERIFICATION (run after the script; everything should be `t`)
-- ---------------------------------------------------------------------
--  select version();                                   -- expect 15+
--  select count(*) from public.challenge_templates;    -- expect 29
--  select category, count(*) from public.challenge_templates
--    group by category order by category;              -- 4 categories
--  select public.get_community_stats();                -- {"community_members":0,...}
--  select conname from pg_constraint
--    where conrelid='public.user_challenges'::regclass
--      and conname='user_challenges_user_date_key';    -- the daily cap
--  select policyname, cmd from pg_policies
--    where schemaname='public' order by tablename;      -- RLS inventory
