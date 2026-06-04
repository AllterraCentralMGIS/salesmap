-- SalesMap initial schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

-- ============== PROFILES (1:1 with auth.users) ==============
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  salesperson_code text,
  role text not null default 'rep' check (role in ('rep', 'admin')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user appears
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============== ZONES ==============
create table public.zones (
  id bigserial primary key,
  name text not null unique,
  color text,
  geojson jsonb not null,
  created_at timestamptz not null default now()
);

-- ============== CUSTOMERS ==============
create table public.customers (
  id bigserial primary key,
  customer_no text unique,
  company text,
  contact_name text,
  job_title text,
  salesperson_code text,
  territory_code text,
  address text,
  city text,
  state text,
  post_code text,
  phone text,
  mobile text,
  email text,
  geocode_quality text,
  lat double precision,
  lng double precision,
  zone_id bigint references public.zones(id) on delete set null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_customers_zone on public.customers(zone_id);
create index idx_customers_salesperson on public.customers(salesperson_code);
create index idx_customers_company_lower on public.customers(lower(company));

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger trg_customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ============== VISITS ==============
create table public.visits (
  id bigserial primary key,
  customer_id bigint not null references public.customers(id) on delete cascade,
  visitor_id uuid references public.profiles(id),
  visit_date date not null,
  outcome text,
  notes text,
  created_at timestamptz not null default now()
);
create index idx_visits_customer on public.visits(customer_id);
create index idx_visits_date on public.visits(visit_date);

-- ============== ROW-LEVEL SECURITY ==============
alter table public.profiles  enable row level security;
alter table public.zones     enable row level security;
alter table public.customers enable row level security;
alter table public.visits    enable row level security;

-- Profiles: any signed-in user can read; user can update their own row
create policy profiles_read_all on public.profiles
  for select using (auth.role() = 'authenticated');
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id);

-- Zones: any signed-in user can read; only admins can write
create policy zones_read_all on public.zones
  for select using (auth.role() = 'authenticated');
create policy zones_admin_write on public.zones
  for all using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Customers: any signed-in user can read, insert, and update (team-shared).
-- Only the creator (or any admin) can delete — prevents accidental wipes.
create policy customers_read_all on public.customers
  for select using (auth.role() = 'authenticated');
create policy customers_insert on public.customers
  for insert with check (auth.role() = 'authenticated');
create policy customers_update on public.customers
  for update using (auth.role() = 'authenticated');
create policy customers_delete on public.customers
  for delete using (
    auth.uid() = created_by
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Visits: any signed-in user can read; insert/update/delete only your own
create policy visits_read_all on public.visits
  for select using (auth.role() = 'authenticated');
create policy visits_insert_self on public.visits
  for insert with check (auth.uid() = visitor_id);
create policy visits_update_own on public.visits
  for update using (auth.uid() = visitor_id);
create policy visits_delete_own on public.visits
  for delete using (
    auth.uid() = visitor_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ============== REALTIME (optional but tiny) ==============
-- Enable so multiple users see each other's edits within a few seconds.
alter publication supabase_realtime add table public.customers;
alter publication supabase_realtime add table public.visits;
alter publication supabase_realtime add table public.zones;

-- ============== ADMIN BOOTSTRAP ==============
-- After your own user signs up via the invite email, promote yourself
-- to admin by running this with your email substituted:
--
-- update public.profiles set role = 'admin'
-- where id = (select id from auth.users where email = 'you@example.com');
