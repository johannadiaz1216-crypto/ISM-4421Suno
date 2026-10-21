-- Applied to project bfrjsojsgxaadijkfmsk on 2026-10-21.
-- Builds on the earlier create_profiles_for_auth migration (profiles table + on_auth_user_created trigger).

-- Profile fields
alter table public.profiles
  add column display_name text,
  add column username text,
  add column bio text,
  add column avatar_path text,
  add column favorite_genres text[] not null default '{}',
  add column updated_at timestamptz not null default now();

alter table public.profiles
  add constraint profiles_display_name_len check (display_name is null or char_length(btrim(display_name)) between 1 and 50),
  add constraint profiles_username_format check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  add constraint profiles_bio_len check (bio is null or char_length(bio) <= 280),
  -- avatar must live in the owner's own folder of the avatars bucket
  add constraint profiles_avatar_path_owner check (avatar_path is null or (avatar_path like id::text || '/%' and char_length(avatar_path) <= 200)),
  add constraint profiles_genres_limit check (cardinality(favorite_genres) <= 8 and char_length(array_to_string(favorite_genres, ',')) <= 300);

create unique index profiles_username_key on public.profiles (username);

-- Keep updated_at current
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Privileges: TRUNCATE bypasses RLS, so strip everything and grant only what the app needs.
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant insert (id, display_name, username, bio, avatar_path, favorite_genres) on table public.profiles to authenticated;
grant update (display_name, username, bio, avatar_path, favorite_genres) on table public.profiles to authenticated;

-- The signup trigger normally creates the row; this lets a user create it if it is ever missing.
create policy "Users can create own profile"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

-- Avatar storage: public-read bucket, each user writes only inside a folder named after their user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Users can read own avatar files"
  on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can upload own avatar files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can update own avatar files"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Users can delete own avatar files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
