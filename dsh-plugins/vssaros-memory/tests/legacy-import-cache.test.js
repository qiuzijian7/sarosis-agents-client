/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacyAgentMemory, isSupportedLegacyCacheFileSystem, LEGACY_LEDGER_FILE } from '../lib/legacy-import.js'

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vssaros-memory-cache-'))
  const source = join(root, 'data', 'agent-memory', 'coder', 'MEMORY.md')
  const memoryDir = join(root, 'memory')
  const destination = join(memoryDir, 'bots', 'coder', 'MEMORY.md')
  const ledgerPath = join(memoryDir, LEGACY_LEDGER_FILE)
  mkdirSync(join(root, 'data', 'agent-memory', 'coder'), { recursive: true })
  writeFileSync(source, '- [2026-10-01] AA\n')
  let reads = 0
  const options = {
    metadataCache: true,
    now: () => Date.now() + 10_000,
    readSource: path => { reads++; return readFileSync(path, 'utf8') },
  }
  const config = { memoryDir, legacyAgentDataRoot: join(root, 'data') }
  try {
    run({ source, destination, ledgerPath, config, options, reads: () => reads })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('unknown, network and virtual filesystem types are not automatically trusted', () => {
  for (const type of [0n, 0x6969n, 0x794c7630n, 0xff534d42n]) {
    assert.equal(isSupportedLegacyCacheFileSystem(type, 'linux'), false)
  }
  assert.equal(isSupportedLegacyCacheFileSystem(0xef53n, 'linux'), true)
  assert.equal(isSupportedLegacyCacheFileSystem(0xef53n, 'win32'), false)
})

test('disabled metadata caching ignores a previously valid stamp and rereads content', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const strict = importLegacyAgentMemory(f.config, { ...f.options, metadataCache: false })
  assert.equal(strict.cached, 0)
  assert.equal(strict.skipped, 1)
  assert.equal(f.reads(), 2)
}))

test('unknown Windows filesystem defaults to content verification even with historical stamps', { skip: process.platform !== 'win32' }, () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const conservative = importLegacyAgentMemory(f.config, { ...f.options, metadataCache: undefined })
  assert.equal(conservative.cached, 0)
  assert.equal(f.reads(), 2)
}))

test('unchanged content-verified migration skips source bytes and remains synchronous', () => fixture(f => {
  const first = importLegacyAgentMemory(f.config, f.options)
  assert.equal(first.imported, 1)
  assert.ok(readFileSync(f.destination, 'utf8').includes('AA'))
  const second = importLegacyAgentMemory(f.config, f.options)
  assert.equal(second.cached, 1)
  assert.equal(second.skipped, 1)
  assert.equal(second.imported, 0)
  assert.equal(f.reads(), 1)
}))

test('recently changed files are rehashed rather than trusting coarse or racing timestamps', () => fixture(f => {
  importLegacyAgentMemory(f.config, { ...f.options, now: Date.now })
  const second = importLegacyAgentMemory(f.config, { ...f.options, now: Date.now })
  assert.equal(second.cached, 0)
  assert.equal(f.reads(), 2)
}))

test('same-size edit with restored mtime still imports new content', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const before = statSync(f.source)
  writeFileSync(f.source, '- [2026-10-01] BB\n')
  utimesSync(f.source, before.atime, before.mtime)
  const changed = importLegacyAgentMemory(f.config, f.options)
  assert.equal(changed.cached, 0)
  assert.equal(changed.imported, 1)
  assert.equal(f.reads(), 2)
  const memory = readFileSync(f.destination, 'utf8')
  assert.ok(memory.includes('AA') && memory.includes('BB'))
}))

test('replacement file with restored mtime invalidates the recorded identity', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const before = statSync(f.source)
  renameSync(f.source, f.source + '.old')
  writeFileSync(f.source, '- [2026-10-01] CC\n')
  utimesSync(f.source, before.atime, before.mtime)
  const changed = importLegacyAgentMemory(f.config, f.options)
  assert.equal(changed.cached, 0)
  assert.equal(changed.imported, 1)
  assert.ok(readFileSync(f.destination, 'utf8').includes('CC'))
}))

test('destination edits invalidate fast path without overwriting user memory', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const edited = readFileSync(f.destination, 'utf8') + '\nUSER-EDIT\n'
  writeFileSync(f.destination, edited)
  const changed = importLegacyAgentMemory(f.config, f.options)
  assert.equal(changed.cached, 0)
  assert.equal(changed.skipped, 1)
  assert.equal(readFileSync(f.destination, 'utf8'), edited)
  assert.equal(importLegacyAgentMemory(f.config, f.options).cached, 1)
  assert.equal(f.reads(), 2)
}))

test('removed destination is not trusted or silently resurrected from unchanged legacy content', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  rmSync(f.destination)
  const second = importLegacyAgentMemory(f.config, f.options)
  assert.equal(second.cached, 0)
  assert.equal(second.skipped, 1)
  assert.equal(f.reads(), 2)
  assert.equal(existsSync(f.destination), false)
}))

test('old ledger is promoted only after reading and hashing source content', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const ledger = JSON.parse(readFileSync(f.ledgerPath, 'utf8'))
  delete ledger.sources[f.source].sourceStamp
  delete ledger.sources[f.source].destinationStamp
  writeFileSync(f.ledgerPath, JSON.stringify(ledger))
  assert.equal(importLegacyAgentMemory(f.config, f.options).cached, 0)
  assert.equal(f.reads(), 2)
  assert.equal(importLegacyAgentMemory(f.config, f.options).cached, 1)
  assert.equal(f.reads(), 2)
}))

test('force performs content verification even for a valid cached migration', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const forced = importLegacyAgentMemory(f.config, { ...f.options, force: true })
  assert.equal(forced.cached, 0)
  assert.equal(forced.skipped, 1)
  assert.equal(f.reads(), 2)
}))

test('changes during source read are never stamped as an unchanged source', () => fixture(f => {
  const first = importLegacyAgentMemory(f.config, {
    ...f.options,
    readSource: path => {
      const text = f.options.readSource(path)
      writeFileSync(path, '- [2026-10-01] CHANGED-DURING-READ\n')
      return text
    },
  })
  assert.equal(first.imported, 1)
  const ledger = JSON.parse(readFileSync(f.ledgerPath, 'utf8'))
  assert.equal(ledger.sources[f.source].sourceStamp, null)
  const second = importLegacyAgentMemory(f.config, f.options)
  assert.equal(second.cached, 0)
  assert.equal(second.imported, 1)
  assert.equal(f.reads(), 2)
}))

test('read failure is reported and cannot be mistaken for a cached migration', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  const failed = importLegacyAgentMemory(f.config, { ...f.options, force: true, readSource: () => { throw new Error('locked') } })
  assert.equal(failed.cached, 0)
  assert.equal(failed.failed, 1)
  assert.equal(failed.skipped, 0)
}))

test('malformed ledger sources are recovered without duplicate memory', () => fixture(f => {
  importLegacyAgentMemory(f.config, f.options)
  for (const sources of [null, []]) {
    writeFileSync(f.ledgerPath, JSON.stringify({ version: 1, sources }))
    const recovered = importLegacyAgentMemory(f.config, f.options)
    assert.equal(recovered.cached, 0)
    assert.equal(recovered.failed, 0)
    assert.equal(recovered.imported, 0)
    assert.equal(readFileSync(f.destination, 'utf8').split('AA').length - 1, 1)
  }
}))
