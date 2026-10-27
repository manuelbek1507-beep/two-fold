-- 2 Fold 0003: memories, letters (server-enforced unlock), playlist, push subscriptions, storage

-- ---------- storage path helper: first path segment must be a uuid couple id
create function public.path_couple(p_name text) returns uuid
language plpgsql immutable as $$
begin
  return (split_part(p_name, '/', 1))::uuid;
exception when others then
  return null;
end $$;

-- ---------- memories
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  caption text not null default '' check (char_length(caption) <= 1000),
  taken_on date not null default current_date,
  media_path text not null,
  media_type text not null check (media_type in ('image', 'video')),
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (media_path like couple_id::text || '/' || created_by::text || '/%')
);
create index memories_couple_taken_idx on public.memories(couple_id, taken_on desc, created_at desc);
alter table public.memories enable row level security;
create policy memories_select on public.memories for select to authenticated using (public.is_member(couple_id));
create policy memories_insert on public.memories for insert to authenticated
  with check (public.is_member(couple_id) and created_by = auth.uid());
create policy memories_update on public.memories for update to authenticated
  using (created_by = auth.uid() and public.is_member(couple_id)) with check (created_by = auth.uid());
create policy memories_delete on public.memories for delete to authenticated
  using (created_by = auth.uid() and public.is_member(couple_id));
revoke update on public.memories from authenticated;
grant update (caption, taken_on, updated_at) on public.memories to authenticated;

-- ---------- letters
create type public.letter_status as enum ('draft', 'sent');
create table public.letters (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  body text not null default '' check (char_length(body) <= 20000),
  status public.letter_status not null default 'draft',
  unlock_at timestamptz,                 -- absolute instant (UTC); NULL = deliver immediately when sent
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index letters_couple_idx on public.letters(couple_id, created_at desc);
alter table public.letters enable row level security;

-- the AUTHOR can always see their own letters; the RECIPIENT only through inbox_letters()
create policy letters_select_author on public.letters for select to authenticated
  using (author_id = auth.uid() and public.is_member(couple_id));
create policy letters_insert on public.letters for insert to authenticated
  with check (author_id = auth.uid() and couple_id = public.my_couple_id());
create policy letters_update_author on public.letters for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
-- drafts and still-locked scheduled letters can be deleted; delivered letters cannot
create policy letters_delete_author on public.letters for delete to authenticated
  using (author_id = auth.uid() and (status = 'draft' or (unlock_at is not null and unlock_at > now())));
revoke update on public.letters from authenticated;
grant update (title, body, status, unlock_at) on public.letters to authenticated;

create function public.letters_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'sent' then
      if new.unlock_at is not null and new.unlock_at <= now() then new.unlock_at := null; end if;
      new.sent_at := now();
    else
      new.sent_at := null;
    end if;
    return new;
  end if;
  -- UPDATE
  -- read receipts (read_at) touch no content and must stay possible after delivery
  if (old.title, old.body, old.status, old.unlock_at) is not distinct from (new.title, new.body, new.status, new.unlock_at) then
    return new;
  end if;
  if old.status = 'sent' and (old.unlock_at is null or old.unlock_at <= now()) then
    raise exception 'A delivered letter can no longer be changed' using errcode = '42501';
  end if;
  if new.status = 'sent' then
    if new.unlock_at is not null and new.unlock_at <= now() then new.unlock_at := null; end if;
    if old.status = 'draft' then new.sent_at := now(); end if;
  else
    new.sent_at := null;       -- cancelling a scheduled letter returns it to draft
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger letters_rules before insert or update on public.letters
  for each row execute function public.letters_rules();

create function public.inbox_letters() returns table (
  id uuid, author_id uuid, title text, body text, sent_at timestamptz, unlock_at timestamptz,
  read_at timestamptz, is_locked boolean)
language sql stable security definer set search_path = public as $$
  select l.id, l.author_id,
         case when locked.v then ''::text else l.title end,
         case when locked.v then null::text else l.body end,
         l.sent_at, l.unlock_at, l.read_at, locked.v
  from public.letters l
  cross join lateral (select (l.unlock_at is not null and l.unlock_at > now()) as v) locked
  where l.couple_id = public.my_couple_id() and l.author_id <> auth.uid() and l.status = 'sent'
  order by coalesce(l.unlock_at, l.sent_at) desc $$;

create function public.mark_letter_read(p_id uuid) returns void language sql security definer set search_path = public as $$
  update public.letters set read_at = now()
  where id = p_id and couple_id = public.my_couple_id() and author_id <> auth.uid() and status = 'sent'
    and read_at is null and (unlock_at is null or unlock_at <= now()) $$;

create function public.server_now() returns timestamptz language sql stable as $$ select now() $$;

-- ---------- playlist
create table public.playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  added_by uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  artist text not null default '' check (char_length(artist) <= 200),
  source text not null check (source in ('upload', 'url', 'link')),
  url text check (url is null or url ~ '^https://'),
  storage_path text,
  artwork_url text check (artwork_url is null or artwork_url ~ '^https://'),
  position double precision not null,
  created_at timestamptz not null default now(),
  check ((source = 'upload' and storage_path is not null and storage_path like couple_id::text || '/%')
      or (source in ('url', 'link') and url is not null))
);
create index playlist_couple_pos_idx on public.playlist_tracks(couple_id, position);
alter table public.playlist_tracks enable row level security;
create policy playlist_select on public.playlist_tracks for select to authenticated using (public.is_member(couple_id));
create policy playlist_insert on public.playlist_tracks for insert to authenticated
  with check (public.is_member(couple_id) and added_by = auth.uid());
create policy playlist_update on public.playlist_tracks for update to authenticated
  using (public.is_member(couple_id)) with check (public.is_member(couple_id));
create policy playlist_delete on public.playlist_tracks for delete to authenticated using (public.is_member(couple_id));
revoke update on public.playlist_tracks from authenticated;
grant update (title, artist, position) on public.playlist_tracks to authenticated;
alter publication supabase_realtime add table public.playlist_tracks;

-- ---------- web push subscriptions
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- storage buckets (all private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('memories', 'memories', false, 52428800,
   array['image/jpeg','image/png','image/webp','image/gif','image/heic','video/mp4','video/webm','video/quicktime']),
  ('chat-media', 'chat-media', false, 26214400, array['application/octet-stream']),   -- client-side encrypted blobs
  ('playlist-audio', 'playlist-audio', false, 26214400,
   array['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/webm','audio/flac','audio/x-m4a'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: <couple_id>/<user_id>/<uuid>.<ext>
do $$
declare b text;
begin
  foreach b in array array['memories', 'chat-media', 'playlist-audio'] loop
    execute format($f$create policy "%1$s read" on storage.objects for select to authenticated
      using (bucket_id = %1$L and public.is_member(public.path_couple(name)))$f$, b);
    execute format($f$create policy "%1$s insert" on storage.objects for insert to authenticated
      with check (bucket_id = %1$L and public.is_member(public.path_couple(name))
                  and split_part(name, '/', 2) = auth.uid()::text)$f$, b);
    execute format($f$create policy "%1$s delete own" on storage.objects for delete to authenticated
      using (bucket_id = %1$L and public.is_member(public.path_couple(name))
             and split_part(name, '/', 2) = auth.uid()::text)$f$, b);
  end loop;
end $$;
-- no UPDATE policy on storage.objects: uploaded objects are immutable (no overwrite/upsert)

-- ---------- least privilege: nothing for anon; RPCs only for signed-in users
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.create_couple(), public.create_invite(), public.join_couple(text),
  public.register_device(text, jsonb), public.revoke_device(uuid),
  public.send_message(uuid, public.message_kind, text, text, uuid, uuid, jsonb),
  public.mark_delivered(), public.mark_read(timestamptz),
  public.start_call(text), public.answer_call(uuid), public.end_call(uuid, text), public.hide_call(uuid),
  public.inbox_letters(), public.mark_letter_read(uuid), public.server_now(),
  public.my_couple_id(), public.is_member(uuid), public.partner_id(), public.path_couple(text)
to authenticated;
