import type { PublicJwk } from './crypto'
export interface Profile { user_id: string; display_name: string; timezone: string }
export interface DeviceRow { id: string; user_id: string; couple_id: string; label: string; public_key: PublicJwk; created_at: string; revoked_at: string | null }
export type MessageKind = 'text' | 'image' | 'video' | 'voice'
export interface MessageRow {
  id: string; couple_id: string; sender_id: string; sender_device_id: string; client_id: string; kind: MessageKind
  ciphertext: string; iv: string; reply_to: string | null; delivered_at: string | null; read_at: string | null; created_at: string
}
export interface AttachmentMeta { path: string; key: string; mime: string; name: string; size: number; seconds?: number }
export interface MessagePayload { text?: string; attachment?: AttachmentMeta }
export interface CallRow {
  id: string; couple_id: string; caller_id: string; callee_id: string; media: 'voice' | 'video'
  state: 'ringing' | 'active' | 'ended'; end_reason: 'completed' | 'missed' | 'declined' | 'cancelled' | 'failed' | null
  created_at: string; answered_at: string | null; ended_at: string | null; duration_seconds: number | null; hidden_by: string[]
}
export interface MemoryRow {
  id: string; couple_id: string; created_by: string; caption: string; taken_on: string; media_path: string
  media_type: 'image' | 'video'; mime: string; size_bytes: number; created_at: string
}
export interface LetterRow {
  id: string; author_id: string; title: string; body: string | null; status?: 'draft' | 'sent'
  sent_at: string | null; unlock_at: string | null; read_at: string | null; is_locked?: boolean; updated_at?: string
}
export interface TrackRow {
  id: string; couple_id: string; added_by: string; title: string; artist: string; source: 'upload' | 'url' | 'link'
  url: string | null; storage_path: string | null; artwork_url: string | null; position: number
}
