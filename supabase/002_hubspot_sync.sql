-- Applied to the live project on 2026-11-23 through the Supabase connector
-- (migrations "hubspot_sync" and "hubspot_ingest_function"). Kept here as the record.
-- See docs/hubspot-sync.md for the rules and the daily procedure.

alter table public.visits add column if not exists hubspot_meeting_id text unique;  -- '<meeting id>:<customer id>'
alter table public.visits add column if not exists source text not null default 'app'
  check (source in ('app', 'import', 'hubspot'));

create table if not exists public.hubspot_owners (owner_id text primary key, profile_id uuid not null references public.profiles(id) on delete cascade, name text);
create table if not exists public.hubspot_deals (id text primary key, name text, pipeline_id text, stage_id text, stage_label text, is_open boolean not null default true, amount numeric, currency text, close_date date, owner_id text, url text, hs_updated_at timestamptz, synced_at timestamptz not null default now());
create table if not exists public.hubspot_deal_customers (deal_id text not null references public.hubspot_deals(id) on delete cascade, customer_id bigint not null references public.customers(id) on delete cascade, primary key (deal_id, customer_id));
create table if not exists public.hubspot_sync_log (id bigserial primary key, ran_at timestamptz not null default now(), window_start timestamptz, window_end timestamptz, meetings_seen int, visits_added int, deals_synced int, review jsonb);
-- RLS on all four; authenticated users may select; no write policies (only the sync writes).
-- public.hubspot_ingest(jsonb): see the live definition (select pg_get_functiondef('public.hubspot_ingest(jsonb)'::regprocedure)).
