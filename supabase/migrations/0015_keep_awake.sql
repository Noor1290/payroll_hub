-- =====================================================================
-- Keep-awake: one function the public anon key may call, for the keep-awake job
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run
-- Run once, after 0001-0014. Safe to re-run.
--
-- It only ADDS one function. No table, column, row, policy or other function is changed.
--
-- Why: a free Supabase project is paused after 7 days with little activity. The workflow
-- .github/workflows/keep-awake.yml calls this function every second day with the anon key
-- (scripts/keep-awake.mjs). Every other function in this database is closed to anon, so
-- without this one the job could only ever be refused.
--
-- public.keep_awake() takes nothing, reads no table and answers true. It runs as the caller
-- (SECURITY INVOKER) with an empty search_path, so it can reach nothing the caller cannot.
-- =====================================================================

create or replace function public.keep_awake()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select true;
$$;

revoke all on function public.keep_awake() from public;
grant execute on function public.keep_awake() to anon, authenticated;

-- ---------- verification: one row, every column true ----------
select
  (select count(*) = 1 from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'keep_awake')
    as exists_once,
  (select p.pronargs = 0 and p.prorettype = 'boolean'::regtype
   from pg_proc p where p.oid = 'public.keep_awake()'::regprocedure)
    as takes_nothing_answers_a_boolean,
  (select not p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'public.keep_awake()'::regprocedure)
    as runs_as_caller_with_empty_search_path,
  (select p.prosrc !~* '\m(from|insert|update|delete|public\.)\M'
   from pg_proc p where p.oid = 'public.keep_awake()'::regprocedure)
    as touches_no_table,
  has_function_privilege('anon', 'public.keep_awake()', 'execute')
    as anon_can_call_it,
  has_function_privilege('authenticated', 'public.keep_awake()', 'execute')
    as signed_in_can_call_it,
  (select public.keep_awake())
    as answers_true;
