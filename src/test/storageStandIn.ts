/**
 * What stands in for Supabase Storage in the database tests (PGlite has none): the two tables
 * migration 0012 touches, with row level security on the files as in the real thing. The
 * role that runs the migrations owns them, as the SQL editor's role may add a bucket and
 * policies in a real project.
 *
 * Not covered here, and checked by hand on the real project instead: the Storage service
 * itself (uploads, the size and type limits of the bucket, and that it refuses to change a
 * file when there is no update policy).
 */
export const STORAGE_STAND_IN = `
  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text not null,
    owner uuid,
    created_at timestamptz default now(),
    unique (bucket_id, name)
  );
  alter table storage.objects enable row level security;
  alter table storage.buckets owner to migration_owner;
  alter table storage.objects owner to migration_owner;
  grant usage on schema storage to anon, authenticated, migration_owner;
  grant select, insert, update, delete on storage.objects to authenticated;
`;
