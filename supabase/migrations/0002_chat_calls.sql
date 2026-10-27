-- 2 Fold 0002: encrypted messages, receipts, calls, realtime authorization
create type public.message_kind as enum ('text', 'image', 'video', 'voice');

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_device_id uuid not null references public.devices(id),
  client_id uuid not null,
  kind public.message_kind not null default 'text',
  ciphertext text not null check (char_length(ciphertext) <= 40000),
  iv text not null,
  reply_to uuid references public.messages(id) on delete set null,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (couple_id, client_id)
);
create index messages_couple_created_idx on public.messages(couple_id, created_at desc, id desc);
alter table public.messages enable row level security;
create policy messages_select on public.messages for select to authenticated using (public.is_member(couple_id));
create policy messages_delete_own on public.messages for delete to authenticated
  using (sender_id = auth.uid() and public.is_member(couple_id));
-- no insert/update policy: writes only through send_message / mark_* RPCs

create table public.message_keys (
  message_id uuid not null references public.messages(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  wrapped_key text not null,
  iv text not null,
  primary key (message_id, device_id)
);
alter table public.message_keys enable row level security;
create policy message_keys_select on public.message_keys for select to authenticated
  using (exists (select 1 from public.devices d where d.id = device_id and d.user_id = auth.uid()));

create function public.send_message(p_client_id uuid, p_kind public.message_kind, p_ciphertext text, p_iv text,
  p_sender_device uuid, p_reply_to uuid, p_keys jsonb) returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_couple uuid := public.my_couple_id(); v_msg public.messages; v_k jsonb;
begin
  if auth.uid() is null or v_couple is null then raise exception 'not a couple member' using errcode = '42501'; end if;
  if length(p_ciphertext) > 40000 or length(p_iv) > 64 then raise exception 'payload too large'; end if;
  if jsonb_typeof(p_keys) <> 'array' or jsonb_array_length(p_keys) not between 1 and 20 then raise exception 'invalid keys'; end if;
  if (select count(*) from public.messages where sender_id = auth.uid() and created_at > now() - interval '1 minute') >= 120 then
    raise exception 'rate limit exceeded' using errcode = '54000';
  end if;
  if not exists (select 1 from public.devices where id = p_sender_device and user_id = auth.uid() and couple_id = v_couple and revoked_at is null) then
    raise exception 'invalid sender device' using errcode = '42501';
  end if;
  if p_reply_to is not null and not exists (select 1 from public.messages where id = p_reply_to and couple_id = v_couple) then
    p_reply_to := null;
  end if;
  insert into public.messages(couple_id, sender_id, sender_device_id, client_id, kind, ciphertext, iv, reply_to)
  values (v_couple, auth.uid(), p_sender_device, p_client_id, p_kind, p_ciphertext, p_iv, p_reply_to)
  on conflict (couple_id, client_id) do nothing returning * into v_msg;
  if v_msg.id is null then   -- idempotent retry
    select * into v_msg from public.messages where couple_id = v_couple and client_id = p_client_id;
    return v_msg;
  end if;
  for v_k in select * from jsonb_array_elements(p_keys) loop
    if not exists (select 1 from public.devices where id = (v_k ->> 'device_id')::uuid and couple_id = v_couple and revoked_at is null) then
      raise exception 'unknown device';
    end if;
    insert into public.message_keys(message_id, device_id, wrapped_key, iv)
    values (v_msg.id, (v_k ->> 'device_id')::uuid, v_k ->> 'wrapped_key', v_k ->> 'iv');
  end loop;
  return v_msg;
end $$;

create function public.mark_delivered() returns void language sql security definer set search_path = public as $$
  update public.messages set delivered_at = now()
  where couple_id = public.my_couple_id() and sender_id <> auth.uid() and delivered_at is null $$;

create function public.mark_read(p_upto timestamptz) returns void language sql security definer set search_path = public as $$
  update public.messages set read_at = now(), delivered_at = coalesce(delivered_at, now())
  where couple_id = public.my_couple_id() and sender_id <> auth.uid() and read_at is null and created_at <= p_upto $$;

-- ---------- calls (metadata only; media is never recorded or stored)
create type public.call_state as enum ('ringing', 'active', 'ended');
create type public.call_end_reason as enum ('completed', 'missed', 'declined', 'cancelled', 'failed');

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  couple_id uuid not null references public.couples(id) on delete cascade,
  caller_id uuid not null references auth.users(id) on delete cascade,
  callee_id uuid not null references auth.users(id) on delete cascade,
  media text not null check (media in ('voice', 'video')),
  state public.call_state not null default 'ringing',
  end_reason public.call_end_reason,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  hidden_by uuid[] not null default '{}'
);
create index calls_couple_created_idx on public.calls(couple_id, created_at desc);
alter table public.calls enable row level security;
create policy calls_select on public.calls for select to authenticated
  using (public.is_member(couple_id) and (caller_id = auth.uid() or callee_id = auth.uid()));

create function public.start_call(p_media text) returns public.calls
language plpgsql security definer set search_path = public as $$
declare v_couple uuid := public.my_couple_id(); v_partner uuid := public.partner_id(); v_call public.calls;
begin
  if v_couple is null or v_partner is null then raise exception 'no partner to call' using errcode = '42501'; end if;
  if p_media not in ('voice','video') then raise exception 'invalid media'; end if;
  update public.calls set state='ended', end_reason='missed', ended_at=now()
   where couple_id = v_couple and state = 'ringing' and created_at < now() - interval '60 seconds';
  update public.calls set state='ended', end_reason='failed', ended_at=now(),
         duration_seconds = extract(epoch from now() - answered_at)::int
   where couple_id = v_couple and state = 'active' and answered_at < now() - interval '8 hours';
  if exists (select 1 from public.calls where couple_id = v_couple and state <> 'ended') then
    raise exception 'call_in_progress';
  end if;
  insert into public.calls(couple_id, caller_id, callee_id, media) values (v_couple, auth.uid(), v_partner, p_media)
  returning * into v_call;
  return v_call;
end $$;

create function public.answer_call(p_id uuid) returns public.calls
language plpgsql security definer set search_path = public as $$
declare v_call public.calls;
begin
  update public.calls set state = 'active', answered_at = now()
   where id = p_id and callee_id = auth.uid() and state = 'ringing' and created_at > now() - interval '90 seconds'
  returning * into v_call;
  if v_call.id is null then raise exception 'call is no longer available'; end if;
  return v_call;
end $$;

create function public.end_call(p_id uuid, p_reason text default null) returns public.calls
language plpgsql security definer set search_path = public as $$
declare c public.calls; v_reason public.call_end_reason;
begin
  select * into c from public.calls where id = p_id and (caller_id = auth.uid() or callee_id = auth.uid()) for update;
  if not found then raise exception 'call not found' using errcode = '42501'; end if;
  if c.state = 'ended' then return c; end if;
  if c.state = 'ringing' then
    v_reason := case when p_reason = 'missed' then 'missed' when auth.uid() = c.callee_id then 'declined' else 'cancelled' end;
  else
    v_reason := case when p_reason = 'failed' then 'failed' else 'completed' end;
  end if;
  update public.calls set state = 'ended', end_reason = v_reason, ended_at = now(),
         duration_seconds = case when answered_at is not null then extract(epoch from now() - answered_at)::int end
   where id = c.id returning * into c;
  return c;
end $$;

create function public.hide_call(p_id uuid) returns void language sql security definer set search_path = public as $$
  update public.calls set hidden_by = array_append(hidden_by, auth.uid())
  where id = p_id and state = 'ended' and (caller_id = auth.uid() or callee_id = auth.uid()) and not (auth.uid() = any(hidden_by)) $$;

-- ---------- Realtime authorization: only the couple's members may join/send on their private topic
-- Topic format: couple:<couple_id>   (clients must use { config: { private: true } })
create policy "couple members can receive" on realtime.messages for select to authenticated
  using (exists (select 1 from public.couple_members m
                 where m.user_id = auth.uid() and realtime.topic() = 'couple:' || m.couple_id::text));
create policy "couple members can send" on realtime.messages for insert to authenticated
  with check (exists (select 1 from public.couple_members m
                      where m.user_id = auth.uid() and realtime.topic() = 'couple:' || m.couple_id::text));

alter publication supabase_realtime add table public.messages, public.calls;
