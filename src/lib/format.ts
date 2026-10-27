export const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const dateLong = (iso: string, tz?: string) =>
  new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })
export const dateTime = (iso: string, tz?: string) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: tz })
export function dayLabel(iso: string): string {
  const d = new Date(iso), n = new Date()
  const diff = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5)
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}
export const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`
export const uuid = () => crypto.randomUUID()
export const fileExt = (name: string) => (name.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
