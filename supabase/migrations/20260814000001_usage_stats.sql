-- Read-only usage snapshot for the health dashboard (2026-07-23).
--
-- Returns the database size + storage bytes/objects per bucket. The nightly
-- backup (service_role) calls this and records the result in each snapshot's
-- _meta.usage, so the health dashboard can show DB + storage usage without any
-- manual SQL. No writes, no PII — only aggregate sizes.
create or replace function public.usage_stats()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'storage', coalesce((
      select jsonb_object_agg(bucket_id,
               jsonb_build_object('bytes', total_bytes, 'objects', n))
      from (
        select bucket_id,
               sum((metadata->>'size')::bigint) as total_bytes,
               count(*)                          as n
        from storage.objects
        group by bucket_id
      ) s
    ), '{}'::jsonb),
    'as_of', now()
  );
$$;

revoke all on function public.usage_stats() from public;
grant execute on function public.usage_stats() to service_role;
