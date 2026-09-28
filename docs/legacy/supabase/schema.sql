-- LEGACY DESIGN ONLY. Not used by this release: run publishing.sql instead.
-- ROIstation OS — multi-tenant control plane schema
create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.sites (
  id text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  sector text not null,
  domain text not null,
  vercel_project_name text not null,
  vercel_project_id text,
  admin_url text,
  status text not null default 'active' check (status in ('active','paused','archived')),
  capabilities jsonb not null default '{"blog":true,"seo":true,"geo":true,"forms":true,"announcements":true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_profiles (
  site_id text primary key references public.sites(id) on delete cascade,
  brand_voice jsonb not null default '{}'::jsonb,
  seo_profile jsonb not null default '{}'::jsonb,
  geo_profile jsonb not null default '{}'::jsonb,
  entity_facts jsonb not null default '{}'::jsonb,
  forbidden_claims text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table if not exists public.site_connectors (
  site_id text primary key references public.sites(id) on delete cascade,
  endpoint text not null,
  secret_ciphertext text not null,
  version text not null default '1.0.0',
  last_seen_at timestamptz,
  status text not null default 'pending' check (status in ('pending','active','error','disabled')),
  created_at timestamptz not null default now()
);

create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('text','file','folder','template')),
  storage_path text,
  extracted_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid references public.content_sources(id) on delete set null,
  provider text not null,
  model text not null,
  purpose text not null,
  prompt_version text not null,
  status text not null check (status in ('queued','running','review','approved','failed')),
  token_usage jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  content_type text not null,
  title text not null,
  source_payload jsonb not null default '{}'::jsonb,
  approval_status text not null default 'draft' check (approval_status in ('draft','review','approved','rejected')),
  publish_mode text not null default 'manual' check (publish_mode in ('manual','scheduled')),
  scheduled_at timestamptz,
  approved_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.publication_targets (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.publications(id) on delete cascade,
  site_id text not null references public.sites(id) on delete cascade,
  localized_payload jsonb not null,
  seo_score smallint check (seo_score between 0 and 100),
  geo_score smallint check (geo_score between 0 and 100),
  status text not null default 'draft' check (status in ('draft','review','queued','publishing','published','failed','rolled_back')),
  published_at timestamptz,
  remote_content_id text,
  error_message text,
  unique(publication_id, site_id)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  resource_type text not null,
  resource_id text,
  site_id text references public.sites(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.sites enable row level security;
alter table public.site_profiles enable row level security;
alter table public.content_sources enable row level security;
alter table public.ai_runs enable row level security;
alter table public.publications enable row level security;
alter table public.publication_targets enable row level security;
alter table public.audit_logs enable row level security;

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target_org and m.user_id = auth.uid()) $$;

create policy "members can read organizations" on public.organizations for select using (public.is_org_member(id));
create policy "members can read sites" on public.sites for select using (public.is_org_member(organization_id));
create policy "editors can manage sites" on public.sites for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy "members can read sources" on public.content_sources for select using (public.is_org_member(organization_id));
create policy "members can manage sources" on public.content_sources for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy "members can read ai runs" on public.ai_runs for select using (public.is_org_member(organization_id));
create policy "members can manage ai runs" on public.ai_runs for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy "members can read publications" on public.publications for select using (public.is_org_member(organization_id));
create policy "members can manage publications" on public.publications for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy "members can read audit logs" on public.audit_logs for select using (public.is_org_member(organization_id));

create index if not exists sites_org_idx on public.sites(organization_id);
create index if not exists publications_org_status_idx on public.publications(organization_id, approval_status, scheduled_at);
create index if not exists publication_targets_status_idx on public.publication_targets(site_id, status);
create index if not exists audit_logs_org_created_idx on public.audit_logs(organization_id, created_at desc);
