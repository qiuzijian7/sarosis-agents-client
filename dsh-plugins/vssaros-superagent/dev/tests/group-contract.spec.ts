// VsSaros addition (2026-11-06): the group-run contract, read the way this panel reads it. The writer side (the agents plugin's
// real output, and chat-surface's real broadcasts) is checked against the same file in dsh-plugins/check-bots-rooms.mjs.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { GROUP_ACTIVITY_SCHEMA, groupRoundStatus, groupRunForFlow, groupRunStatusKey, normalizeGroupRuns, type GroupRun } from '../src/client/group-runs.tsx'
import { zh } from '../src/client/locales.ts'

const contract = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/group-activity.schema.json'), 'utf8')) as {
  version: number; statuses: string[]; examples: { round: GroupRun }; definitions: { round: { properties: Record<string, unknown> } }
}

it('reads the contract version and status words this panel was written for', () => {
  expect(GROUP_ACTIVITY_SCHEMA).toBe(contract.version)
  // Every status the contract allows has a label here, and the panel's state machine yields only those.
  for (const status of contract.statuses) {
    const key = groupRunStatusKey({ status } as GroupRun)
    expect(zh[key], status).toBeTruthy()
    expect(groupRoundStatus({ status } as GroupRun)).toBe(status)
  }
})

it('keeps a contract example intact and reads its status and correlation the same way the server wrote them', () => {
  const example = contract.examples.round
  const [kept] = normalizeGroupRuns([example, { bogus: true }])
  expect(kept).toEqual(example)
  expect(groupRoundStatus(kept)).toBe(example.status)
  expect(groupRunForFlow([kept!], { roomId: example.roomId!, kind: 'routed', sourceMessageId: example.sourceMessageId })).toBe(kept)
  // Fields the panel reads are fields the contract names.
  const read: (keyof GroupRun)[] = ['schema', 'callId', 'roomId', 'roomName', 'status', 'statusLabel', 'done', 'phase', 'interrupted', 'error',
    'startedAt', 'finishedAt', 'originTriggerId', 'fromSession', 'sourceMessageId', 'replies', 'events', 'speaking', 'passed', 'failed']
  expect(read.filter(field => !(field in contract.definitions.round.properties))).toEqual([])
})
