export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended'

const allowed: Record<CallPhase, CallPhase[]> = {
  idle: ['outgoing', 'incoming'],
  outgoing: ['connecting', 'ended'],
  incoming: ['connecting', 'ended'],
  connecting: ['active', 'ended'],
  active: ['reconnecting', 'ended'],
  reconnecting: ['active', 'ended'],
  ended: ['idle', 'outgoing', 'incoming'],
}
export function canTransition(from: CallPhase, to: CallPhase): boolean {
  return from === to || allowed[from].includes(to)
}
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = String(m).padStart(2, '0'), rr = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${rr}` : `${m}:${rr}`
}
export const RING_TIMEOUT_MS = 45_000
