/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { renderSessionSearchCompatPreload, tolerateNullSessionSearchReason } from '../../common/dshSessionSearchCompat.js';

const fixture = `export function extractSessionEventText(event) {
  return event.type === "turn/end" ? turnEndText(event.data.reason) : event.data.text;
}
function joinText(parts) { return parts.join("\\n"); }
function turnEndText(reason) {
  switch (reason.kind) {
    case "error": return joinText(["error", reason.error.message]);
    case "aborted": return "aborted";
    case "max-tokens":
    case "interrupted": return reason.kind;
    case "completed": return "";
    default: return "";
  }
}`;

suite('dshHarness / historical session search compatibility', () => {
	let root: string;
	setup(() => { root = mkdtempSync(join(tmpdir(), 'dsh-search-compat-')); });
	teardown(() => rmSync(root, { recursive: true, force: true }));

	test('精确且幂等，只兼容 null，不伪造收尾状态或吞掉其他错误', () => {
		const patched = tolerateNullSessionSearchReason(fixture);
		assert.strictEqual(tolerateNullSessionSearchReason(patched), patched);
		assert.throws(() => tolerateNullSessionSearchReason(''), /unsupported turnEndText/);
		assert.throws(() => tolerateNullSessionSearchReason(fixture + fixture), /unsupported turnEndText/);
		assert.throws(() => renderSessionSearchCompatPreload('0.2.3'), /unsupported runtime version/);
		const extract = new Function(patched.replace('export ', '') + '; return extractSessionEventText;')() as (event: object) => string;
		const event = { type: 'turn/end', data: { reason: null } };
		const before = JSON.stringify(event);
		assert.strictEqual(extract(event), '');
		assert.strictEqual(JSON.stringify(event), before);
		assert.deepStrictEqual([
			extract({ type: 'turn/end', data: { reason: { kind: 'completed' } } }),
			extract({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'legacy' } } } }),
			extract({ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'fixture-error' } } } }),
			extract({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }),
			extract({ type: 'user/message', data: { text: 'searchable message' } }),
		], ['', 'aborted', 'error\nfixture-error', 'interrupted', 'searchable message']);
		assert.throws(() => extract({ type: 'turn/end', data: {} }), TypeError);
	});

	test('真实 load hook 不改模块或日志字节，拒绝不同版本', () => {
		const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-session-query');
		mkdirSync(join(pkg, 'lib'), { recursive: true });
		const manifest = join(pkg, 'package.json');
		writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-session-query', type: 'module', version: '0.2.2-rc.2' }));
		const entry = join(pkg, 'lib', 'index.js');
		writeFileSync(entry, fixture);
		const log = join(root, 'fixture.jsonl');
		const content = JSON.stringify({ type: 'turn/end', data: { reason: null } }) + '\n';
		writeFileSync(log, content);
		const preload = join(root, 'preload.mjs');
		writeFileSync(preload, renderSessionSearchCompatPreload('0.2.2-rc.2'));
		const script = `import {readFileSync} from 'node:fs'; const {extractSessionEventText} = await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(JSON.stringify({text:extractSessionEventText(JSON.parse(readFileSync(${JSON.stringify(log)}, 'utf8')))}));`;
		const run = (withPatch: boolean) => spawnSync(process.execPath, [...withPatch ? ['--import', pathToFileURL(preload).href] : [], '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
		const baseline = run(false);
		assert.notStrictEqual(baseline.status, 0);
		assert.match(baseline.stderr, /reading 'kind'/);
		const result = run(true);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /"text":""/);
		assert.strictEqual(readFileSync(entry, 'utf8'), fixture);
		assert.strictEqual(readFileSync(log, 'utf8'), content);
		writeFileSync(manifest, JSON.stringify({ name: '@deepseek-ai/dsh-session-query', type: 'module', version: '0.2.3' }));
		assert.match(run(true).stderr, /profile\/runtime version mismatch/);
	});

	test('官方 rc.2：冷读及正文文档投影包含 null 收尾时可用，原事件不变', function () {
		const entry = join(process.cwd(), 'dsh-runtime', '0.2.2-rc.2', 'node_modules', '@deepseek-ai', 'dsh-session-query', 'lib', 'index.js');
		if (!existsSync(entry)) { this.skip(); }
		const source = readFileSync(entry, 'utf8');
		assert.notStrictEqual(tolerateNullSessionSearchReason(source), source);
		const preload = join(root, 'official-preload.mjs');
		writeFileSync(preload, renderSessionSearchCompatPreload('0.2.2-rc.2'));
		const script = `
import assert from 'node:assert/strict';
const {buildSessionEventSearchDocuments, readColdSessionLog} = await import(${JSON.stringify(pathToFileURL(entry).href)});
const events = [
  {seq:0,time:1,type:'turn/start',data:{turn:0}},
  {seq:1,time:2,type:'user/message',surfaceOp:'append',data:{turn:0,content:[{type:'text',text:'historical search fixture'}]}},
  {seq:2,time:3,type:'turn/end',data:{turn:0,reason:null}},
];
const before = JSON.stringify(events);
let closed = 0;
const header = {id:'fixture-session',version:4,createdAt:1,cwd:'/fixture'};
const persistence = {open:async(id, mode)=>{assert.equal(mode,'read');return {header,inheritedEventCount:0,read:async()=>({events,eventState:'owned'}),close:async()=>{closed++;}};}};
const log = await readColdSessionLog(persistence, 'fixture-session');
const docs = buildSessionEventSearchDocuments('fixture-session',log.events);
assert.equal(docs.length,1);
assert.equal(docs[0].text,'historical search fixture');
assert.equal(docs[0].surface,'current');
assert.equal(JSON.stringify(events),before);
assert.equal(closed,1);
console.log('cold-read and search documents preserved');`;
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.match(result.stdout, /cold-read and search documents preserved/);
		assert.strictEqual(readFileSync(entry, 'utf8'), source);
	});
});
