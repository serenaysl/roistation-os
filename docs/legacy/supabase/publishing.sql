-- Single-agency store. Existing site/admin tables are not modified.
create table if not exists public.roi_publications (id uuid primary key,version integer not null default 1 check(version>0),document jsonb not null,updated_at timestamptz not null default now());
create index if not exists roi_publications_updated_idx on public.roi_publications(updated_at desc,id desc);
create index if not exists roi_publications_document_idx on public.roi_publications using gin(document jsonb_path_ops);
create table if not exists public.roi_connections (site_id text primary key,site_url text not null,verified boolean not null default false,verified_at timestamptz not null default now(),detail text not null);
create table if not exists public.roi_submissions (id uuid primary key,publication_id uuid not null references public.roi_publications(id),site_id text not null,answers jsonb not null,consent_at timestamptz not null,consent_text text not null,created_at timestamptz not null default now());
create index if not exists roi_submissions_created_idx on public.roi_submissions(created_at desc,id desc);
create index if not exists roi_submissions_publication_idx on public.roi_submissions(publication_id,site_id);
create table if not exists public.roi_rate_buckets (key text primary key,used integer not null,expires_at timestamptz not null);
alter table public.roi_publications enable row level security;
alter table public.roi_connections enable row level security;
alter table public.roi_submissions enable row level security;
alter table public.roi_rate_buckets enable row level security;
revoke all on public.roi_publications,public.roi_connections,public.roi_submissions,public.roi_rate_buckets from anon,authenticated;
grant select,insert,update,delete on public.roi_publications,public.roi_connections,public.roi_submissions,public.roi_rate_buckets to service_role;
create or replace function public.roi_take_rate(bucket_key text,max_requests integer,window_seconds integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare total integer;
begin
  insert into public.roi_rate_buckets(key,used,expires_at) values(bucket_key,1,now()+make_interval(secs=>window_seconds))
  on conflict(key) do update set
    used=case when public.roi_rate_buckets.expires_at<=now() then 1 else public.roi_rate_buckets.used+1 end,
    expires_at=case when public.roi_rate_buckets.expires_at<=now() then now()+make_interval(secs=>window_seconds) else public.roi_rate_buckets.expires_at end
  returning used into total;
  return total<=max_requests;
end $$;
revoke all on function public.roi_take_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.roi_take_rate(text,integer,integer) to service_role;
-- Lock the publication during acceptance: a concurrent withdrawal/delete cannot accept a closed form.
create or replace function public.roi_submit_form(submission_id uuid,publication uuid,site text,values_json jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare doc jsonb; target jsonb;
begin
  select document into doc from public.roi_publications where id=publication for share;
  target=doc->'targets'->site;
  if doc->>'kind' is distinct from 'form' or target is null or target->'payload'='null'::jsonb then return false; end if;
  if not coalesce(target->>'status'='published' or (target->>'status'='scheduled' and (target->>'scheduledAt')::timestamptz<=now()),false) then return false; end if;
  insert into public.roi_submissions(id,publication_id,site_id,answers,consent_at,consent_text)
  values(submission_id,publication,site,values_json,now(),target->'payload'->>'consentText') on conflict(id) do nothing;
  return true;
end $$;
revoke all on function public.roi_submit_form(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.roi_submit_form(uuid,uuid,text,jsonb) to service_role;
