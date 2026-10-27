// Audio output routing helpers. Browsers expose output devices only via enumerateDevices()+setSinkId(),
// and Android Chrome frequently lists a single "default" output. We therefore classify what is really
// available and let the UI say honestly whether switching is possible.

export interface OutputInfo { deviceId: string; label: string }
export interface OutputClassification {
  speaker: OutputInfo | null
  earpiece: OutputInfo | null
  others: OutputInfo[]
  canSwitch: boolean
}
const SPEAKER = /speaker|loudspeaker|lautsprecher|haut-parleur|altavoz/i
const EARPIECE = /earpiece|receiver|handset|hörer|écouteur|auricular/i

export function classifyOutputs(devices: OutputInfo[]): OutputClassification {
  const uniq = devices.filter((d, i, a) => a.findIndex((x) => x.deviceId === d.deviceId) === i)
  const speaker = uniq.find((d) => SPEAKER.test(d.label) && !EARPIECE.test(d.label)) ?? null
  const earpiece = uniq.find((d) => EARPIECE.test(d.label) && d.deviceId !== speaker?.deviceId) ?? null
  const others = uniq.filter((d) => d !== speaker && d !== earpiece)
  // Switching is only meaningful when there are at least two distinct routes to choose between.
  return { speaker, earpiece, others, canSwitch: uniq.length >= 2 }
}
export const supportsSetSinkId = (): boolean =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
