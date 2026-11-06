// @vssaros/dsh-agents — 群执行过程「真进程被杀」重启测试（2026-11-06）
//   跑法：node dsh-plugins/vssaros-agents/test/rooms-restart.test.mjs
//
// rooms.test.mjs 里的重启都在同一进程内模拟（新建一个实例去读同一份文件）。这里是真的：
//   子进程跑一轮群聊 → Designer 已回复、Coder 正在说 → 父进程强杀子进程（不给任何 flush / dispose 机会）
//   → 父进程用新实例载入同一份 agent-rooms.json，断言：
//     · 文件是完整 JSON（原子 rename，强杀不会留下半截）；
//     · 被杀前已落盘的回复还在，本轮收口为 cut，没有「永远正在输入」；
//     · 死掉的子进程留下的租约不挡路：新实例接管并能继续写。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRooms, installRooms } from '../lib/rooms.js';

const ROSTER = [{ id: 'designer', name: 'Designer' }, { id: 'coder', name: 'Coder' }];
const CALL_ID = 'call-killed';

/** 最小假 dsh：成员会话 followup 后下一拍回一条文本；reply 返回 'hang' ⇒ 永远不回。 */
function fakeHost(reply) {
	const sessions = new Map();
	const listeners = new Map();
	let n = 0;
	const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) { fn(...args); } };
	const agentOf = (s) => ({
		id: s.id,
		session: { id: s.id, get seq() { return s.seq; }, snapshotEvents: (from, to) => s.events.filter(e => e.seq > from && e.seq <= to) },
		ctx: { tools: { register: () => () => undefined } },
		followup(message) {
			setTimeout(() => {
				const botId = /^vssaros-(.+)$/.exec(s.preset ?? '')?.[1];
				const text = reply(botId);
				if (text === 'hang') { return; }
				s.seq += 1; s.events.push({ seq: s.seq, type: 'agent/inbox/spliced', data: { inserted: [message] } });
				s.seq += 1; s.events.push({ seq: s.seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
				emit('agent/turn-stopping', { agent: { session: agentOf(s).session } });
			}, 5);
		},
	});
	return {
		sc: {
			create: async ({ agentPreset }) => {
				const id = `s${++n}`;
				sessions.set(id, { id, preset: agentPreset, events: [], seq: 0 });
				return { sessionId: id, agentPreset };
			},
			rename: async () => ({}),
			resolveAgent: async (id) => (sessions.has(id) ? { agent: agentOf(sessions.get(id)) } : { error: { code: 'session/not-found' } }),
		},
		agents: { get: (id) => (sessions.has(id) ? agentOf(sessions.get(id)) : undefined) },
		workspaces: { list: () => [{ id: 'ws1', path: 'C:/work' }], create: async (path) => ({ id: `ws:${path}` }), archiveSession: async () => undefined },
		ctx: { on: (name, fn) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => undefined; } },
	};
}
const makeRooms = (host, file) => createRooms({
	file, fallbackCwd: 'C:/fallback', roster: async () => ROSTER, presetOf: id => `vssaros-${id}`,
	sessions: () => host.sc, agents: () => host.agents, workspaces: () => host.workspaces, append: async () => null,
	warn: () => undefined,
});

// ── 子进程：跑到「Designer 已回、Coder 正在说」并确认已落盘，然后报 READY 原地挂着等被杀 ──
if (process.argv[2] === '--child') {
	const file = process.argv[3];
	const host = fakeHost(botId => (botId === 'designer' ? '我先出交互稿' : 'hang'));
	const rooms = makeRooms(host, file);
	installRooms(host.ctx, rooms);
	const room = await rooms.create({ members: ['designer', 'coder'], name: '强杀群', mode: 'everyone' });
	rooms.noteUserMessage(room.id, '大家开始做吧');
	void rooms.relayTool().execute({}, { agent: { id: room.id }, callId: CALL_ID });
	const deadline = Date.now() + 10_000;
	for (;;) {
		await new Promise(resolve => setTimeout(resolve, 20));
		let round;
		try { round = JSON.parse(readFileSync(file, 'utf8')).rounds.find(item => item.callId === CALL_ID); } catch { round = undefined; }
		if (round && round.replies.length === 1 && round.speaking.includes('Coder')) {
			process.stdout.write(`READY ${room.id}\n`);
			break;
		}
		if (Date.now() > deadline) { process.stdout.write('TIMEOUT\n'); process.exit(2); }
	}
	setInterval(() => undefined, 1000); // 挂着，等父进程强杀
} else {
	let pass = 0;
	const fails = [];
	const check = async (name, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${name} → ${String((e && e.message) || e).split('\n')[0]}`); } };
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-rooms-kill-'));
	const file = join(dir, 'agent-rooms.json');

	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	let stderr = '';
	child.stderr.on('data', (chunk) => { stderr += String(chunk); });
	const roomId = await new Promise((resolve, reject) => {
		let out = '';
		const timer = setTimeout(() => reject(new Error(`子进程 15s 内没就绪：${out} ${stderr}`)), 15_000);
		child.stdout.on('data', (chunk) => {
			out += String(chunk);
			const hit = /READY (\S+)/.exec(out);
			if (hit) { clearTimeout(timer); resolve(hit[1]); }
			if (/TIMEOUT/.test(out)) { clearTimeout(timer); reject(new Error('子进程没跑到预期状态')); }
		});
		child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`子进程提前退出 code=${code} ${stderr}`)); });
	}).catch((error) => { fails.push(`子进程准备 → ${error.message}`); return ''; });

	if (roomId) {
		const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
		const childPid = child.pid;
		child.kill('SIGKILL'); // Windows 上即 TerminateProcess：不跑任何清理代码
		const how = await exited;

		await check('强杀：子进程确实被杀掉（没有走正常退出）', () => {
			assert.ok(how.signal === 'SIGKILL' || how.code !== 0, JSON.stringify(how));
		});
		await check('强杀后文件是完整 JSON，租约还写着死掉的子进程', () => {
			const saved = JSON.parse(readFileSync(file, 'utf8'));
			assert.equal(saved.version, 2);
			const owner = JSON.parse(readFileSync(`${file}.owner`, 'utf8'));
			assert.equal(owner.pid, childPid);
		});
		const again = makeRooms(fakeHost(() => '[PASS]'), file);
		await again.load();
		await check('重启载入：被杀前已落盘的回复还在，本轮收口为 cut，不再显示正在输入', () => {
			const progress = again.progress(CALL_ID);
			assert.ok(progress, '找不到被杀那一轮');
			assert.deepEqual(progress.replies.map(r => [r.name, r.text]), [['Designer', '我先出交互稿']]);
			assert.equal(progress.status, 'cut');
			assert.equal(progress.statusLabel, '已中断');
			assert.deepEqual(progress.speaking, []);
			assert.ok(progress.events.some(e => e.kind === 'cut' && /重启中断/.test(e.text)));
			assert.ok(again.active().some(item => item.callId === CALL_ID));
		});
		await check('重启载入：死进程留下的租约不挡路，新实例接管并能继续写', async () => {
			assert.equal(again.storage().writable, true);
			const owner = JSON.parse(readFileSync(`${file}.owner`, 'utf8'));
			assert.equal(owner.pid, process.pid, '租约已换成新实例');
			await again.setFlags(roomId, { pinned: true });
			await again.flush();
			assert.equal(JSON.parse(readFileSync(file, 'utf8')).rooms.find(r => r.id === roomId).pinned, true);
			const disk = JSON.parse(readFileSync(file, 'utf8')).rounds.find(r => r.callId === CALL_ID);
			assert.equal(disk.phase, 'cut', '收口结果也写回了盘');
		});
		await again.close();
		await check('11 分钟后再重启：被打断那一轮仍可按 callId 查到（DSH 只补了英文错误结果，回复只在这里）', async () => {
			const later = createRooms({
				file, fallbackCwd: 'C:/fallback', roster: async () => ROSTER, presetOf: id => `vssaros-${id}`,
				sessions: () => fakeHost(() => '[PASS]').sc, agents: () => undefined, workspaces: () => undefined, append: async () => null,
				warn: () => undefined, now: () => Date.now() + 11 * 60_000,
			});
			await later.load();
			const progress = later.progress(CALL_ID);
			assert.ok(progress, '超过 10 分钟保留期后仍在');
			assert.equal(progress.status, 'cut');
			assert.deepEqual(progress.replies.map(r => r.text), ['我先出交互稿']);
			assert.equal(later.active().some(item => item.callId === CALL_ID), false, '只是可查，不再挂在活动列表里');
			await later.close();
		});
	}
	try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
	rmSync(dir, { recursive: true, force: true });

	console.log(`rooms-restart: ${pass} passed${fails.length ? `, ${fails.length} failed` : ''}`);
	for (const f of fails) { console.log('  ✗ ' + f); }
	process.exit(fails.length ? 1 : 0);
}
