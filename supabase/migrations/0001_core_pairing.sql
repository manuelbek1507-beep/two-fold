-- 2 Fold 0001: approved emails, couples, membership, profiles, pairing, devices
create extension if not exists pgcrypto with schema extensions;

-- ---------- approved emails (server-side allowlist; no client policies => no client access)
create table public.allowed_emails (
  email text primary key check (email = lower(email))
);
alter table public.allowed_emails enable row level security;

-- ---------- couples & membership
create table public.couples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table public.couple_members (
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade, -- one couple per user
  joined_at timestamptz not null default now(),
  primary key (couple_id, user_id)
);
alter table public.couples enable row level security;
alter table public.couple_members enable row level security;

-- hard cap: at most 2 members per couple (row lock prevents races)
create function public.enforce_member_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.couples where id = new.couple_id for update;
  if (select count(*) from public.couple_members where couple_id = new.couple_id) >= 2 then
    raise exception 'A couple can have at most two members' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger couple_member_cap before insert on public.couple_members
  for each row execute function public.enforce_member_cap();

-- ---------- profiles
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  timezone text not null default 'UTC' check (char_length(timezone) <= 64),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ---------- signup gate: only allowed_emails may create an account
create function public.enforce_allowed_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_emails where email = lower(new.email)) then
    raise exception 'This email is not approved for 2 Fold' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger enforce_allowed_signup before insert on auth.users
  for each row execute function public.enforce_allowed_signup();

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, display_name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)), 40));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- helpers used by every RLS policy
create function public.my_couple_id() returns uuid
language sql stable security definer set search_path = public as $$
  select couple_id from public.couple_members where user_id = auth.uid() limit 1 $$;

create function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.couple_members where couple_id = c and user_id = auth.uid()) $$;

create function public.partner_id() returns uuid
language sql stable security definer set search_path = public as $$
  select user_id from public.couple_members
  where couple_id = public.my_couple_id() and user_id <> auth.uid() limit 1 $$;

-- ---------- RLS: membership / profiles / couples (read-only for clients)
create policy couples_select on public.couples for select to authenticated using (public.is_member(id));
create policy members_select on public.couple_members for select to authenticated
  using (couple_id = public.my_couple_id());
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or user_id in (select user_id from public.couple_members where couple_id = public.my_couple_id()));
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke update on public.profiles from authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;

-- ---------- invites (hashed, single-use, expiring, rate-limited)
create table public.couple_invites (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  code_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.couple_invites enable row level security;  -- no policies: RPC only

create table public.invite_attempts (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
alter table public.invite_attempts enable row level security; -- no policies: RPC only

create function public.create_couple() returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_email text := lower(auth.jwt() ->> 'email'); v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.allowed_emails where email = v_email) then
    raise exception 'email not approved' using errcode = '42501';
  end if;
  if public.my_couple_id() is not null then raise exception 'already in a couple'; end if;
  insert into public.couples default values returning id into v_id;
  insert into public.couple_members(couple_id, user_id) values (v_id, auth.uid());
  return v_id;
end $$;

-- returns the plaintext code ONCE; only its SHA-256 is stored
create function public.create_invite() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_couple uuid := public.my_couple_id(); v_code text;
begin
  if v_couple is null then raise exception 'not a couple member' using errcode = '42501'; end if;
  if (select count(*) from public.couple_members where couple_id = v_couple) >= 2 then
    raise exception 'couple is already complete';
  end if;
  update public.couple_invites set expires_at = now() where couple_id = v_couple and used_at is null and expires_at > now();
  v_code := upper(encode(gen_random_bytes(7), 'hex'));   -- 56 bits
  insert into public.couple_invites(couple_id, code_hash, created_by, expires_at)
  values (v_couple, encode(digest(v_code, 'sha256'), 'hex'), auth.uid(), now() + interval '24 hours');
  return v_code;
end $$;

-- returns a status string (not an exception) so that failed attempts are still counted
create function public.join_couple(p_code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_email text := lower(auth.jwt() ->> 'email'); v_inv public.couple_invites;
begin
  if auth.uid() is null then return 'unauthenticated'; end if;
  if (select count(*) from public.invite_attempts where user_id = auth.uid() and at > now() - interval '15 minutes') >= 5 then
    return 'rate_limited';
  end if;
  insert into public.invite_attempts(user_id) values (auth.uid());
  if not exists (select 1 from public.allowed_emails where email = v_email) then return 'not_allowed'; end if;
  if public.my_couple_id() is not null then return 'already_member'; end if;
  select * into v_inv from public.couple_invites
   where code_hash = encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex')
     and used_at is null and expires_at > now() for update;
  if not found then return 'invalid'; end if;
  begin
    insert into public.couple_members(couple_id, user_id) values (v_inv.couple_id, auth.uid());
  exception when others then return 'couple_full';
  end;
  update public.couple_invites set used_at = now() where id = v_inv.id;
  delete from public.invite_attempts where user_id = auth.uid();
  return 'ok';
end $$;

-- ---------- devices (E2EE public keys)
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  couple_id uuid not null references public.couples(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  public_key jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index devices_couple_idx on public.devices(couple_id) where revoked_at is null;
alter table public.devices enable row level security;
create policy devices_select on public.devices for select to authenticated using (public.is_member(couple_id));

create function public.register_device(p_label text, p_public_key jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_couple uuid := public.my_couple_id(); v_id uuid;
begin
  if v_couple is null then raise exception 'not a couple member' using errcode = '42501'; end if;
  if p_public_key ->> 'kty' <> 'EC' or p_public_key ->> 'crv' <> 'P-256' or p_public_key ->> 'x' is null or p_public_key ->> 'y' is null then
    raise exception 'invalid public key';
  end if;
  if (select count(*) from public.devices where user_id = auth.uid() and revoked_at is null) >= 10 then
    raise exception 'too many active devices; revoke one first';
  end if;
  insert into public.devices(user_id, couple_id, label, public_key)
  values (auth.uid(), v_couple, left(p_label, 80), jsonb_build_object('kty','EC','crv','P-256','x',p_public_key->>'x','y',p_public_key->>'y'))
  returning id into v_id;
  return v_id;
end $$;

create function public.revoke_device(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.devices set revoked_at = now() where id = p_id and user_id = auth.uid() and revoked_at is null $$;
