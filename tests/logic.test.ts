import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, formatDuration } from '../src/lib/callState.ts'
import { classifyOutputs } from '../src/lib/audioOutput.ts'

test('call phases: legal and illegal transitions', () => {
  assert.ok(canTransition('idle', 'outgoing'))
  assert.ok(canTransition('incoming', 'connecting'))
  assert.ok(canTransition('active', 'reconnecting'))
  assert.ok(canTransition('reconnecting', 'active'))
  assert.ok(!canTransition('idle', 'active'))
  assert.ok(!canTransition('ended', 'active'))
  assert.ok(!canTransition('outgoing', 'active'))
})
test('duration formatting', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3725), '1:02:05')
})
test('output classification: single default output cannot be switched', () => {
  const r = classifyOutputs([{ deviceId: 'default', label: 'Default' }])
  assert.equal(r.canSwitch, false)
  assert.equal(r.speaker, null)
})
test('output classification: finds speaker and earpiece when present', () => {
  const r = classifyOutputs([
    { deviceId: 's', label: 'Speakerphone' }, { deviceId: 'e', label: 'Earpiece' }, { deviceId: 'b', label: 'Buds Pro' },
  ])
  assert.equal(r.canSwitch, true)
  assert.equal(r.speaker?.deviceId, 's')
  assert.equal(r.earpiece?.deviceId, 'e')
  assert.equal(r.others.length, 1)
})
