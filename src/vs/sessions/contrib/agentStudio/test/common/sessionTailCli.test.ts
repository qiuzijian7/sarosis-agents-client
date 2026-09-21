/*---------------------------------------------------------------------------------------------
 *  会话事件流 CLI（`npm run session:tail`）**跨进程**回归测试（P1-5，2026-09-21）。
 *
 *  为什么用「真进程」而不是 mock：本用例要证明的**就是跨进程能力** ✓ ——
 *  消费进程与应用进程**不共享内存**，只能靠磁盘上的追加日志 + 游标 ✓。
 *  用 `child_process` 起真 CLI（两次独立调用 = 两个独立消费进程 ✓）：
 *    ① 第一次：从头读 ⇒ 事件序列正确 ✓
 *    ② 第二次：带 `--from` 游标 ⇒ **只**返回增量 ✓✓（这就是"跟随"的等价断言 ✓）
 *
 *  另外钉一条 CLI 卫生约束：`--json` 模式的 **stdout 必须是纯 NDJSON** ✗
 *  （提示行走 stderr ✓）—— 否则消费方按行 `JSON.parse` 会直接炸 ✗✓。
 *
 *  注意：本用例依赖 `scripts/session-tail.mjs` 与 `common/sessionEventStream.ts`
 *  **语义一致**（CLI 刻意不 import TS 源以便直接 `node` 运行 ✓）⇒
 *  改动任一侧的游标/半行/压缩语义时，**必须同时改另一侧** ✗✓。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT_REL = 'scripts/session-tail.mjs';

interface IFixture {
	root: string;
	/** 追加一条消息到日志（模拟应用侧继续写 ✓）。 */
	appendLine: (id: string, content: string) => void;
	cleanup: () => void;
}

function makeFixture(): IFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sarosis-tail-test-'));
	const sessions = path.join(root, 'demo', 'sessions');
	fs.mkdirSync(sessions, { recursive: true });
	const logPath = path.join(sessions, 's1.jsonl');
	const lines = [
		{ op: 'a', msg: { id: 'm1', role: 'user', content: '第一条', agentSessionId: 's1', timestamp: '' } },
		{ op: 'a', msg: { id: 'm2', role: 'assistant', content: '回复', agentSessionId: 's1', timestamp: '' } },
		{ op: 'base', ts: 1 },
		{ op: 'a', msg: { id: 'm3', role: 'user', content: '压缩后新消息', agentSessionId: 's1', timestamp: '' } },
	];
	fs.writeFileSync(logPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
	fs.writeFileSync(path.join(sessions, 's1.json'), JSON.stringify([{ id: 'x', role: 'user', content: '快照', timestamp: '' }]));
	return {
		root,
		appendLine: (id, content) => {
			fs.appendFileSync(logPath, JSON.stringify({ op: 'a', msg: { id, role: 'assistant', content, agentSessionId: 's1', timestamp: '' } }) + '\n');
		},
		cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } },
	};
}

/**
 * 限期等待某个条件成立 ✓（**不用固定 sleep** ✗ —— 固定 sleep = flaky 测试 ✗）。
 * 到期限仍未成立 ⇒ 抛错（由断言给出可读原因 ✓）。
 */
async function waitFor(predicate: () => boolean, deadlineMs: number, what: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < deadlineMs) {
		if (predicate()) { return; }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.ok(predicate(), `等待超时（${deadlineMs}ms）：${what}`);
}

/**
 * 起**真进程**跑 CLI ✓（`spawnSync` 而不是 `execFileSync` —— 后者只回 stdout ✗，
 * 而"提示行是否走 stderr"正是本文件要钉的约束之一 ✓）。
 */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
	const script = path.join(process.cwd(), SCRIPT_REL);
	assert.ok(fs.existsSync(script), `CLI 不存在：${script}`);
	const r = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
	return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parseNdjson(stdout: string): unknown[] {
	return stdout.split('\n').filter(Boolean).map(line => {
		try {
			return JSON.parse(line);
		} catch {
			throw new Error(`stdout 不是纯 NDJSON ✗（提示行必须走 stderr ✓）：${line}`);
		}
	});
}

suite('session:tail CLI（跨进程游标消费，P1-5）', () => {

	test('★★★ 从头读 ⇒ 事件序列正确，且 stdout 是**纯 NDJSON**', () => {
		const fx = makeFixture();
		try {
			const { stdout } = runCli(['--agent', 'demo', '--session', 's1', '--root', fx.root, '--json']);
			const events = parseNdjson(stdout) as { seq: number; kind: string; reason?: string; msg?: { id: string } }[];
			assert.deepStrictEqual(
				events.map(e => `${e.kind}${e.reason ? ':' + e.reason : ''}${e.msg ? ':' + e.msg.id : ''}`),
				['message:m1', 'message:m2', 'reset:barrier', 'message:m3'],
			);
		} finally { fx.cleanup(); }
	});

	test('★★★ 带游标续读 ⇒ 只返回增量（= 第二次独立进程调用 ✓ —— 跨进程跟随的等价断言）', () => {
		const fx = makeFixture();
		try {
			const args = ['--agent', 'demo', '--session', 's1', '--root', fx.root, '--json'];
			const full = parseNdjson(runCli(args).stdout) as { seq: number }[];
			assert.strictEqual(full.length, 4);

			// 第二次**独立进程**：从游标 3 继续 ⇒ 只应拿到第 4 行 ✓
			const inc = parseNdjson(runCli([...args, '--from', '3']).stdout) as { seq: number; msg?: { id: string } }[];
			assert.deepStrictEqual(inc.map(e => e.seq), [4], '只增量 ✓（重复投递即失败 ✗）');
			assert.strictEqual(inc[0].msg?.id, 'm3');

			// 游标到底 ⇒ 空 ✓（幂等：再读一次也不会重复 ✗）
			assert.deepStrictEqual(parseNdjson(runCli([...args, '--from', '4']).stdout), []);
		} finally { fx.cleanup(); }
	});

	test('★★ 省略 --session ⇒ 列出会话（含日志行数 / 快照条数 ✓）', () => {
		const fx = makeFixture();
		try {
			const { stdout } = runCli(['--agent', 'demo', '--root', fx.root]);
			assert.ok(/s1/.test(stdout), `列表应包含 s1：\n${stdout}`);
			assert.ok(/日志行=4/.test(stdout), `应报告日志行数（4 ✓）：\n${stdout}`);
			assert.ok(/快照=1/.test(stdout), `应报告快照条数（1 ✓）：\n${stdout}`);
		} finally { fx.cleanup(); }
	});

	// ⚠ 必须用 function 表达式（而非箭头函数 ✓）才能拿到 mocha 上下文设超时 ✗ ——
	//   本用例自带两段各 8s 的限期等待，会撞上 runner 的默认 15s ✗（15000 ✓）。
	test('★★★ --follow：应用侧新写入的消息会在下一轮轮询被推出来（真跟随 ✓）', async function (this: any) {
		this.timeout(30_000);
		const fx = makeFixture();
		const script = path.join(process.cwd(), SCRIPT_REL);
		const child = cp.spawn(process.execPath, [
			script, '--agent', 'demo', '--session', 's1', '--root', fx.root,
			'--json', '--follow', '--interval', '200',
		], { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
		try {
			// ① 先确认初始 4 条已推出（说明跟随循环已启动并读到现状 ✓）
			await waitFor(() => parseNdjson(out).length >= 4, 8000, '跟随进程应先把已有事件推完');

			// ② 模拟"应用侧继续写" ✓ ⇒ 无需重启进程就应看到新事件 ✓✓
			fx.appendLine('m4', '跟随期间写入的新消息');
			await waitFor(
				() => (parseNdjson(out) as { msg?: { id?: string } }[]).some(e => e.msg?.id === 'm4'),
				8000,
				'--follow 必须推出新增事件（headless 实时观察的核心用例 ✓）',
			);
		} finally {
			child.kill();
			fx.cleanup();
		}
	});

	test('★ 缺 --agent ⇒ 明确报错且非零退出（不静默 ✗）', () => {
		const r = runCli(['--session', 's1']);
		assert.notStrictEqual(r.status, 0, '缺参必须非零退出 ✓');
		assert.ok(/agent/.test(r.stderr), `错误信息应指明缺少 --agent ✓（实际 stderr：${r.stderr}）`);
	});
});
