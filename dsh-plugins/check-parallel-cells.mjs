// 守卫：`@vssaros/dsh-parallel` 的格位注册表（lib/cells.js）—— 假 PTY 真跑状态机。
//
// 钉的都是**行为**（不是读源码）：
//   ① 起格 ⇒ starting；首个字节到达 ⇒ running（不是"创建即 running"）
//   ② 输出进 backlog（新连接能回放）且订阅者能收到增量（seq 单调）
//   ③ 写入原样送到 PTY；非 running 时拒绝并说明
//   ④ ★ 关格只走 `pty.kill()`——**绝不**按 pid 杀（Windows ConPTY 下 pid 恒为 0）
//   ⑤ 上限（默认 12）与重复 id 拒绝，错误信息说明原因
//   ⑥ 进程退出 ⇒ exited（带 exitCode）；关掉后 list 里不再有
//   ⑦ 非法状态迁移被拒（不静默改状态）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'G:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-parallel';
const LIB = join(DIR, 'lib');
const problems = [];
const notes = [];

const mod = await import('file:///' + LIB.replace(/\\/g, '/') + '/cells.js');
// 只 import 不 apply ⇒ 只验纯逻辑与页面渲染，不碰网络 / 不碰 PTY。
let modIndex = null;
try {
	modIndex = await import('file:///' + LIB.replace(/\\/g, '/') + '/index.js');
} catch (e) {
	problems.push('lib/index.js: 装载失败 — ' + String((e && e.message) || e));
}

/** 假 PTY：记录收到的写入 / resize / kill，可手动触发数据与退出。 */
function makeFakePty(spec) {
	const rec = {
		spec,
		written: [],
		resizes: [],
		killed: 0,
		pid: 0,
		dataCb: null,
		exitCb: null,
		write(d) { rec.written.push(String(d)); },
		resize(c, r) { rec.resizes.push([c, r]); },
		kill() { rec.killed += 1; },
		onData(fn) { rec.dataCb = fn; },
		onExit(fn) { rec.exitCb = fn; },
		emitData(s) { if (rec.dataCb) { rec.dataCb(s); } },
		emitExit(code) { if (rec.exitCb) { rec.exitCb({ exitCode: code }); } },
	};
	return rec;
}

// ── ① 起格 / 状态机 / 回放 / 订阅 ──────────────────────────────────────────
{
	const spawned = [];
	const reg = mod.createCellRegistry({ spawnPty: (spec) => { const p = makeFakePty(spec); spawned.push(p); return p; }, now: () => 1000 });
	const created = reg.create({ id: 'A1', title: '实现 · A1', cwd: 'C:/tmp', preset: 'vssaros-standard', cols: 120, rows: 40 });
	if (!created.ok) { problems.push('起格失败：' + created.error); }
	if (created.cell && created.cell.state !== 'starting') {
		problems.push(`起格后状态应为 starting，实际 ${created.cell && created.cell.state} ✗（不能"创建即 running"）`);
	}
	if (spawned.length !== 1) { problems.push(`应起 1 个 PTY，实际 ${spawned.length} ✗`); }
	const pty = spawned[0];
	if (pty && pty.spec.preset !== 'vssaros-standard') { problems.push('preset 未传给 PTY 工厂 ✗'); }
	if (pty && (pty.spec.cols !== 120 || pty.spec.rows !== 40)) { problems.push('cols/rows 未传给 PTY 工厂 ✗'); }

	const events = [];
	const sub = reg.subscribe('A1', (e) => events.push(e));
	if (!sub || sub.backlog !== '') { problems.push('新订阅应拿到空 backlog ✗'); }
	pty.emitData('dsh-tui v0.10.0\r\n');
	const afterFirst = reg.get('A1');
	if (afterFirst.state !== 'running') { problems.push(`首个字节后状态应为 running，实际 ${afterFirst.state} ✗`); }
	if (afterFirst.bytes !== 17) { problems.push(`bytes 应为 17，实际 ${afterFirst.bytes} ✗`); }
	const dataEvents = events.filter((e) => e.type === 'data');
	if (dataEvents.length !== 1 || dataEvents[0].data !== 'dsh-tui v0.10.0\r\n') {
		problems.push(`订阅者应收到 1 个原样 data 事件（不剥 ANSI/不改字节），实际 ${JSON.stringify(dataEvents)} ✗`);
	}
	// seq 单调
	pty.emitData('a');
	pty.emitData('b');
	const seqs = events.filter((e) => e.type === 'data').map((e) => e.seq);
	if (!(seqs.length === 3 && seqs[0] < seqs[1] && seqs[1] < seqs[2])) {
		problems.push(`data 事件的 seq 必须单调递增，实际 ${JSON.stringify(seqs)} ✗`);
	}
	// 回放：后订阅者拿到累积 backlog
	const sub2 = reg.subscribe('A1', () => {});
	if (!sub2 || sub2.backlog !== 'dsh-tui v0.10.0\r\nab') {
		problems.push(`回放 backlog 应为「dsh-tui v0.10.0\\r\\nab」，实际 ${JSON.stringify(sub2 && sub2.backlog)} ✗`);
	}
	// 状态事件：starting→running 必须有
	const stateEvents = events.filter((e) => e.type === 'state').map((e) => e.state);
	if (stateEvents[0] !== 'running') { problems.push(`应广播 running 状态事件，实际 ${JSON.stringify(stateEvents)} ✗`); }

	// ── ③ 写入 ──
	const w = reg.write('A1', 'hello\r');
	if (!w.ok) { problems.push('running 时写入应成功 ✗'); }
	if (pty.written[0] !== 'hello\r') { problems.push(`PTY 应收到原样 "hello\\r"，实际 ${JSON.stringify(pty.written)} ✗`); }

	// ── ④ 关格只走 kill() ──
	const closed = reg.close('A1');
	if (!closed.ok) { problems.push('关格应成功 ✗'); }
	if (pty.killed !== 1) { problems.push(`关格必须调用 pty.kill() 一次，实际 ${pty.killed} ✗（ConPTY 下 pid=0，不能按 pid 杀）`); }
	if (reg.get('A1')) { problems.push('关格后 list 里不应再有该格 ✗'); }
	const wAfter = reg.write('A1', 'x');
	if (wAfter.ok) { problems.push('关格后写入应被拒 ✗'); }
	notes.push('起格→running / 回放 / 订阅 seq 单调 / 原样写入 / 关格只走 kill() —— 通过');
}

// ── ⑤ 上限与重复 id ────────────────────────────────────────────────────────
{
	const reg = mod.createCellRegistry({ spawnPty: () => makeFakePty({}), maxCells: 3 });
	for (const id of ['a', 'b', 'c']) {
		const r = reg.create({ id });
		if (!r.ok) { problems.push(`起格 ${id} 应成功 ✗`); }
	}
	const over = reg.create({ id: 'd' });
	if (over.ok) { problems.push('超过 maxCells 应被拒 ✗'); }
	if (!/上限/.test(String(over.error || ''))) { problems.push(`超限错误应说明"上限"，实际 ${JSON.stringify(over.error)} ✗`); }
	const dup = reg.create({ id: 'a' });
	if (dup.ok) { problems.push('重复 id 应被拒 ✗'); }
	if (!/已存在/.test(String(dup.error || ''))) { problems.push(`重复 id 错误应说明"已存在"，实际 ${JSON.stringify(dup.error)} ✗`); }
	const noId = reg.create({});
	if (noId.ok) { problems.push('缺 id 应被拒 ✗'); }
	notes.push('上限 / 重复 id / 缺 id 三种拒绝 + 错误信息可读 —— 通过');
}

// ── ⑥ 进程退出 ⇒ exited；⑦ 非法迁移 ────────────────────────────────────────
{
	const spawned = [];
	const reg = mod.createCellRegistry({ spawnPty: () => { const p = makeFakePty({}); spawned.push(p); return p; } });
	reg.create({ id: 'x' });
	spawned[0].emitData('boot');
	spawned[0].emitExit(1);
	const cell = reg.get('x');
	if (cell.state !== 'exited') { problems.push(`进程退出后状态应为 exited，实际 ${cell.state} ✗`); }
	if (cell.exitCode !== 1) { problems.push(`应记录 exitCode=1，实际 ${cell.exitCode} ✗`); }
	// exited 之后再写 ⇒ 拒
	if (reg.write('x', 'y').ok) { problems.push('exited 后写入应被拒 ✗'); }
	// exited 的格 close ⇒ 直接删（alreadyGone），不重复 kill
	const c2 = reg.close('x');
	if (!c2.ok || !c2.alreadyGone) { problems.push(`exited 的格 close 应已 alreadyGone，实际 ${JSON.stringify(c2)} ✗`); }
	if (spawned[0].killed !== 0) { problems.push('已退出的格不应再调 kill() ✗'); }
	notes.push('进程退出记 exitCode / exited 后拒写 / 已退出的格不重复 kill —— 通过');
}

// ── PTY 探测：失败时必须如实不可用（不假装能起格）──────────────────────────
{
	const fail = await mod.probePty(() => { throw new Error('nope'); });
	if (fail.ok) { problems.push('探测全失败时应返回 ok:false ✗'); }
	if (!fail.error) { problems.push('探测失败应带 error ✗'); }
	const fakeApi = { spawn: () => ({}) };
	const good = await mod.probePty(() => fakeApi);
	if (!good.ok || typeof good.spawn !== 'function') { problems.push('探测到带 spawn 的模块应返回可用 ✗'); }
	notes.push('PTY 探测：全失败 ⇒ 如实 unavailable；带 spawn ⇒ 可用 —— 通过');
}

// ── TUI 运行时探测（lib/runtime.js；2026-10-22 —— PATH 里没有 dsh + rc.1/rc.2 版本差这两个坑）──
{
	const rt = await import('file:///' + LIB.replace(/\\/g, '/') + '/runtime.js');
	// ① 版本比较（绝对期望值；相对比较型断言会恒真）
	const cases = [
		['0.2.1-rc.2', '0.2.1-rc.2', true],   // 相等
		['0.2.1-rc.3', '0.2.1-rc.2', true],   // 同标签递增
		['0.2.1-rc.1', '0.2.1-rc.2', false],  // ★ 实机就是 rc.1，必须判不够
		['0.2.1', '0.2.1-rc.2', true],        // 正式版高于同号预发布
		['0.2.0', '0.2.1-rc.2', false],       // 低一档
		['0.3.0', '0.2.1-rc.2', true],        // 次版本更高
		['1.0.0', '0.2.1-rc.2', true],
		['0.2.1-alpha.3', '0.2.1-rc.2', false], // 同号不同标签，按标签字符串比（alpha < rc）
		['garbage', '0.2.1-rc.2', false],     // 解析不了 ⇒ 不够（不假设够）
	];
	for (const [have, atLeast, want] of cases) {
		const got = rt.versionAtLeast(have, atLeast);
		if (got !== want) {
			problems.push(`runtime.versionAtLeast(${JSON.stringify(have)}, ${JSON.stringify(atLeast)}) 应为 ${want}，实际 ${got} ✗`);
		}
	}
	// ② 没找到任何 runtime ⇒ 必须如实 ok:false 且说清怎么办（**不许**退回裸 dsh 假装能用）
	{
		const r = rt.resolveTuiRuntime({
			configured: 'dsh',
			exists: () => false,
			list: () => [],
			roots: ['C:/nonexistent-runtime-root'],
		});
		if (r.ok) { problems.push('没有任何 runtime 时应返回 ok:false ✗（不许假装能起格）'); }
		if (!/DSH|tuiCommand/.test(String((r.problems || []).join(' ')))) {
			problems.push(`找不到 runtime 时应指引配 config.tuiCommand，实际 ${JSON.stringify(r.problems)} ✗`);
		}
	}
	// ③ 用户显式指定了命令 ⇒ 尊重它，但如实标"版本未检查"
	{
		const r = rt.resolveTuiRuntime({ configured: 'C:/my/dsh.cmd', exists: () => false, list: () => [], roots: [] });
		if (!r.ok || r.command !== 'C:/my/dsh.cmd') { problems.push('显式 config.tuiCommand 应被直接采用 ✗'); }
		if (!/版本未检查/.test(String((r.problems || []).join(' ')))) {
			problems.push('显式命令应如实注明"版本未检查" ✗');
		}
	}
	notes.push('TUI 运行时：版本比较 9 例（含 rc.1 < rc.2）/ 找不到如实拒绝 / 显式命令尊重 —— 通过');
}

// ── 起格参数（buildArgs；加"工作区 / preset / 模型入口"时立）────────────────
// 为什么可测：preset 曾经是**死字段**（收下 → 存下 → 传给 spawnPty → index.js 根本没用）
//   ⇒ 用户传了 preset 却毫无效果，且没有任何报错。这里用绝对期望值钉住拼参数的行为。
{
	const t = modIndex && modIndex.__test;
	if (!t || typeof t.buildArgs !== 'function') {
		problems.push('lib/index.js: 缺 __test.buildArgs（preset 拼参数必须可单测）✗');
	} else {
		const cases = [
			[['--profile', 'tui'], '', ['--profile', 'tui']],
			[['--profile', 'tui'], 'standard', ['--profile', 'tui', '--agent-preset', 'standard']],
			// 调用方已经写了 --agent-preset ⇒ 不重复追加（两个值会让 CLI 取错）
			[['--profile', 'tui', '--agent-preset', 'ptc'], 'standard', ['--profile', 'tui', '--agent-preset', 'ptc']],
			[['--profile', 'tui'], 'vssaros-standard', ['--profile', 'tui', '--agent-preset', 'vssaros-standard']],
		];
		for (const [base, preset, want] of cases) {
			const got = t.buildArgs(base, preset);
			if (JSON.stringify(got) !== JSON.stringify(want)) {
				problems.push(`buildArgs(${JSON.stringify(base)}, ${JSON.stringify(preset)}) 应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)} ✗`);
			}
		}
		const base = ['--profile', 'tui'];
		t.buildArgs(base, 'standard');
		if (base.length !== 2) {
			problems.push('buildArgs 不得修改传入的 baseArgs（会污染 config.tuiArgs，后续格位都带上 preset）✗');
		}
	}
	const idxSrc = readFileSync(join(LIB, 'index.js'), 'utf8');
	if (!/ROUTE_PREFIX \+ '\/api\/options'/.test(idxSrc)) {
		problems.push('lib/index.js: 缺 GET /api/options（起格表单要拉 cwd / preset 候选）✗');
	}
	// ★ preset 解析必须**限定 8 格缩进**：更深的 10 格是插件 id（tool-bash / vssaros-kanban…）。
	//   实测教训：用 `^\s*id:` 会把几十个插件 id 当成 preset 灌进下拉（装上 @vssaros/dsh-agents 之后立刻炸）。
	if (!/\^ \{8\}id:/.test(idxSrc)) {
		problems.push('lib/index.js: preset 解析必须用「正好 8 格缩进」的 id 正则（否则把插件 id 当 preset）✗');
	}
	if (/\^ \\s\*id:/.test(idxSrc)) {
		problems.push('lib/index.js: 不许用 ^\\s*id: 抓 preset（会连插件 id 一起抓）✗');
	}
	// ★ 会话目录名回解：必须有**磁盘存在性校验**（编码有损，纯字符串反解会得到 `sarosis\\agents\\client` 这种错路径）
	if (!/function decodeSessionDirName\(/.test(idxSrc)) {
		problems.push('lib/index.js: 缺 decodeSessionDirName（工作区候选要靠它从会话目录名还原）✗');
	}
	if (!/existsSync\(p\) && statSync\(p\)\.isDirectory\(\)/.test(idxSrc)) {
		problems.push('lib/index.js: 会话目录名回解必须用 existsSync/statSync 校验（不许纯字符串反解）✗');
	}
	if (!/hits\.length !== 1/.test(idxSrc)) {
		problems.push('lib/index.js: 回解多解时要跳过（不许挑一个可能错的路径）✗');
	}
	notes.push('preset 解析限 8 格缩进 + 会话目录名回解带存在性校验/多解跳过 —— 通过');
	notes.push('起格参数：buildArgs 4 例（含"已有 --agent-preset 不重复"）+ 不改入参 + /api/options —— 通过');
}

// ── ⑨ 新建格子的工作区 = 会话里那枚工作区 chip（用户 2026-10-23 要求）──────────
// 钉行为：候选来自 Host `workspaceRegistry`（chip 的真源）× 显示名与 chip 同口径
//   × 服务不可用时如实回落（不许假装一致、不许抛穿）。
{
	const t = modIndex && modIndex.__test;
	if (!t || typeof t.workspaceCwdOptions !== 'function' || typeof t.pickWorkspaceItems !== 'function') {
		problems.push('lib/index.js: 缺 __test.workspaceCwdOptions / pickWorkspaceItems（工作区候选必须可单测）✗');
	} else {
		// ① 顺序 = registry 顺序；label = title → 路径末段 → id；空路径条目丢掉
		const got = t.workspaceCwdOptions([
			{ id: 'w1', path: 'G:\\SarosWorkspace\\sarosis-agents-client', title: 'sarosis-agents-client', sessionIds: ['s1', 's2', 's3'] },
			{ id: 'w2', path: 'F:\\GR_qiuzijian_main\\S1Game', title: '', sessionIds: [] },
			{ id: 'w3', path: '/home/me/proj', title: '   ', sessionIds: [] },
			{ id: 'w4', path: '', title: '只有标题没有路径' },
		]);
		const want = [
			['G:\\SarosWorkspace\\sarosis-agents-client', 'sarosis-agents-client', 'w1', 3],
			['F:\\GR_qiuzijian_main\\S1Game', 'S1Game', 'w2', 0],
			['/home/me/proj', 'proj', 'w3', 0],
		];
		if (got.length !== want.length) {
			problems.push(`workspaceCwdOptions 应返回 ${want.length} 条（空路径条目要丢），实际 ${got.length} 条 ✗`);
		}
		want.forEach(([path, label, id, sessions], i) => {
			const g = got[i] || {};
			if (g.path !== path || g.label !== label || g.workspaceId !== id || g.sessions !== sessions || g.source !== 'workspace') {
				problems.push(`workspaceCwdOptions[${i}] 应为 {path:${path}, label:${label}, workspaceId:${id}, sessions:${sessions}, source:workspace}，实际 ${JSON.stringify(g)} ✗`);
			}
		});
		if (t.workspaceCwdOptions(null).length !== 0) {
			problems.push('workspaceCwdOptions(null) 应返回空数组（不许编候选）✗');
		}
		// ② 取数走 ctx.get('workspaceRegistry')；缺失 / 抛错 ⇒ null（调用方回落，不许抛穿）
		const items = [{ id: 'w1', path: 'G:\\a', title: 'a', sessionIds: [] }];
		const okCtx = { get: (name) => (name === 'workspaceRegistry' ? { list: () => items } : undefined) };
		if (JSON.stringify(t.pickWorkspaceItems(okCtx)) !== JSON.stringify(items)) {
			problems.push('pickWorkspaceItems 应从 ctx.get("workspaceRegistry").list() 取条目 ✗');
		}
		const noCtx = { get: () => undefined };
		if (t.pickWorkspaceItems(noCtx) !== null) { problems.push('注册表服务不存在时 pickWorkspaceItems 应返回 null ✗'); }
		const boom = { get: () => ({ list: () => { throw new Error('registry down'); } }) };
		if (t.pickWorkspaceItems(boom) !== null) { problems.push('registry.list() 抛错时 pickWorkspaceItems 应返回 null（不许抛穿）✗'); }
		const notArray = { get: () => ({ list: () => ({}) }) };
		if (t.pickWorkspaceItems(notArray) !== null) { problems.push('registry.list() 返回非数组时应视为不可用（null）✗'); }

		// ③ 静态：必须运行时可选取（写进静态 inject 会让 headless/tui profile 永久 pending）
		const idxSrc = readFileSync(join(LIB, 'index.js'), 'utf8');
		if (!/ctx\.get\(\s*['"]workspaceRegistry['"]\s*\)/.test(idxSrc)) {
			problems.push('lib/index.js: 工作区候选必须从 ctx.get("workspaceRegistry") 取（chip 的真源）✗');
		}
		if (/inject\s*=\s*\[[^\]]*workspaceRegistry/.test(idxSrc)) {
			problems.push('lib/index.js: workspaceRegistry 不许写进静态 inject（非 web profile 会永久 pending）✗');
		}
		if (!/workspaceSource/.test(idxSrc)) {
			problems.push('lib/index.js: /api/options 必须回报 workspaceSource（回落时要如实说明）✗');
		}
		// ④ 页面：分组渲染（组头「N 个根」）+ 提交只读一个真值 + 回落如实提示
		const pageSrc = readFileSync(join(LIB, 'pageClient.js'), 'utf8');
		if (!/g\.roots\.forEach/.test(pageSrc) || !/个根/.test(pageSrc)) {
			problems.push('lib/pageClient.js: 必须按工作区分组渲染（组内遍历 roots，组头显示「N 个根」）✗');
		}
		if (!/body\.querySelector\('#f-cwd'\)/.test(pageSrc)) {
			problems.push("lib/pageClient.js: 起格提交必须只读隐藏 input('#f-cwd') 这一个真值（否则会「看着 A 提交 B」）✗");
		}
		if (!/workspaceSource === 'workspace'/.test(pageSrc)) {
			problems.push('lib/pageClient.js: 回落候选必须如实提示（workspaceSource）✗');
		}
		// ★ 根行必须**只读**：makeRootRow 里若绑了 click，就等于"根也能选"（用户明确不允许）
		const rootRowFn = (/function makeRootRow\([\s\S]{0,1200}?\n\t\t\}/.exec(pageSrc) || [''])[0];
		if (!rootRowFn) {
			problems.push('lib/pageClient.js: 缺 makeRootRow（根行只读展示）✗');
		} else if (/addEventListener/.test(rootRowFn)) {
			problems.push('lib/pageClient.js: 根行必须只读 —— makeRootRow 里不许绑 click/事件 ✗');
		}
		notes.push('工作区候选与会话 chip 同源同口径：registry 取数 4 例 + 名字口径 3 例 + 回落如实说明 —— 通过');
	}
}

// ── ⑩ IDE 工作区记录（多根）→ 起格表单的分组（2026-10-23 用户截图要求）──────────
// 病根：dsh 的 registry 是**单目录**、宿主把多根工作区摊平成 N 条 ⇒ 只看 registry 会把
//   `VsSaros_S1Game(2 根)` 显示成两条同名工作区（截图里 S1Game/UE5EA 各出现两次）。
// 判据：分组走 IDE 的 workspaces.json（与左侧栏同一份记录），主根在前、组内去重。
{
	const t = modIndex && modIndex.__test;
	if (!t || typeof t.groupIdeWorkspaces !== 'function') {
		problems.push('lib/index.js: 缺 __test.groupIdeWorkspaces（多根工作区分组必须可单测）✗');
	} else {
		const got = t.groupIdeWorkspaces([
			{
				id: 'w1',
				name: 'VsSaros_S1Game',
				path: 'f:\\GR_qiuzijian_main\\S1Game',
				relatedFolders: [
					{ path: 'f:\\GR_qiuzijian_main\\UE5EA', name: 'UE5' },
					// 主根的大小写变体 ⇒ 必须按 pathKey 去重（否则组里出现两行 S1Game）
					{ path: 'F:\\GR_qiuzijian_main\\S1Game', name: '重复' },
				],
				codeWorkspacePath: 'f:\\GR_qiuzijian_main\\S1Game\\S1Game.code-workspace',
			},
			{ id: 'w2', name: '', path: 'G:\\x' },        // 没名字 ⇒ 整条丢
			{ id: 'w3', name: 'no-path' },                // 没主根 ⇒ 整条丢
			{ id: 'w4', name: '单根', path: 'G:\\SarosWorkspace\\vssaros-homepage' },
		]);
		if (!got || got.length !== 2) {
			problems.push(`groupIdeWorkspaces 应剩 2 组（丢无名字/无主根），实际 ${JSON.stringify(got)} ✗`);
		} else {
			const g0 = got[0];
			if (g0.name !== 'VsSaros_S1Game') { problems.push(`第一组名应为 VsSaros_S1Game，实际 ${g0.name} ✗`); }
			if (g0.roots.length !== 2) {
				problems.push(`多根组应为主根 + 1 个去重后的 related（共 2），实际 ${JSON.stringify(g0.roots)} ✗`);
			}
			if (!g0.roots[0].isPrimary || g0.roots[0].path !== 'f:\\GR_qiuzijian_main\\S1Game') {
				problems.push(`组内第一根必须是主根本身，实际 ${JSON.stringify(g0.roots[0])} ✗`);
			}
			if (g0.roots[1] && g0.roots[1].name !== 'UE5') {
				problems.push(`related 根应保留记录里的名字（UE5），实际 ${JSON.stringify(g0.roots[1])} ✗`);
			}
			if (g0.codeWorkspacePath !== 'f:\\GR_qiuzijian_main\\S1Game\\S1Game.code-workspace') {
				problems.push('.code-workspace 身份要如实带上 ✗');
			}
			if (got[1].roots.length !== 1 || got[1].roots[0].isPrimary !== true) {
				problems.push('单根工作区应只有 1 个根且标主根 ✗');
			}
		}
		if (t.groupIdeWorkspaces(null) !== null) { problems.push('没有记录时应返回 null（页面据此回落，不假装有工作区）✗'); }
		if (t.groupIdeWorkspaces([]) !== null) { problems.push('空数组应返回 null ✗'); }
		const many = [];
		for (let i = 0; i < 40; i += 1) { many.push({ id: 'w' + i, name: 'n' + i, path: 'G:\\p' + i }); }
		if (t.groupIdeWorkspaces(many).length !== 30) {
			problems.push('工作区组数上限应为 30（与宿主 DSH_WORKSPACE_OPTION_LIMIT 一致）✗');
		}

		// 静态：/api/options 的字段与来源，以及不许两套入口并存
		const idxSrc = readFileSync(join(LIB, 'index.js'), 'utf8');
		if (!/workspaces:\s*groups/.test(idxSrc)) {
			problems.push('/api/options 必须返回 workspaces（多根分组）✗');
		}
		if (!/workspaceSource:\s*groups\s*\?\s*'ide'/.test(idxSrc)) {
			problems.push("/api/options 的来源必须能区分 'ide'（读到工作区记录）✗");
		}
		if (!/join\(home,\s*'\.\.',\s*'workspaces\.json'\)/.test(idxSrc)) {
			problems.push('工作区记录必须从 DSH_HOME 上一级的 workspaces.json 读 ✗');
		}
		const pageSrc2 = readFileSync(join(LIB, 'pageClient.js'), 'utf8');
		if (/f-cwd-sel/.test(pageSrc2)) {
			problems.push('pageClient.js: 旧的 <select id="f-cwd-sel"> 必须删掉（两套入口并存 ⇒ 用户不知道哪个生效）✗');
		}

		// ★ fs 函数必须真的 import：`existsSync/statSync` 曾漏在 import 外，而调用点全在 try/catch 里
		//   ⇒ ReferenceError 被吞、会话目录回解静默返回空（按源码字符串查不出这类错）。
		const fsImport = (/import\s*\{([^}]*)\}\s*from\s*'node:fs'/.exec(idxSrc) || [])[1] || '';
		const imported = new Set(fsImport.split(',').map((s) => s.trim()).filter(Boolean));
		for (const fn of ['existsSync', 'statSync', 'readFileSync', 'readdirSync']) {
			if (new RegExp('\\b' + fn + '\\s*\\(').test(idxSrc) && !imported.has(fn)) {
				problems.push(`lib/index.js: 用了 ${fn}() 但没从 node:fs import ⇒ ReferenceError 会被 try/catch 吞掉（静默失效）✗`);
			}
		}
		notes.push('IDE 工作区记录（多根）：分组 + 主根在前 + 组内去重 + 丢脏 + 上限 30 + 来源字段 + fs import 完整性 —— 通过');
	}
}

// ── ⑪ preset 菜单 = chat-surface「模式」chip 同一口径（2026-10-23 用户要求）────────
// 病根：并行页曾经自己拼一张名字表（「标准模式（社区 TUI） · standard」）⇒ 与 chip 的
//   「标准模式（VsSaros）」并列时**同一个概念两种写法**，还漏出了内部 id。
// 判据：同白名单（4 个）、同分组标题、同文案、不显示 id；且**跨插件逐字比对**（防两边各改一半）。
{
	const t = modIndex && modIndex.__test;
	if (!t || typeof t.presetMenuItems !== 'function') {
		problems.push('lib/index.js: 缺 __test.presetMenuItems（模式菜单必须可单测）✗');
	} else {
		const raw = [
			{ id: 'standard', name: '标准模式（社区 TUI）' },   // 与 vssaros-standard 重复 ⇒ 不列
			{ id: 'ptc', name: 'PTC 模式（社区 TUI）' },        // 同上
			{ id: 'vssaros-full', name: '标准档 · 全工具（VsSaros）', description: '退役' }, // 已退役 ⇒ 不列
			{ id: 'minimal' },                                 // dsh 原生（无 roster 文案 ⇒ 用同一份硬编码）
			{ id: 'cordis' },
			{ id: 'vssaros-standard', name: '标准模式（VsSaros）', description: '带 VsSaros 能力模块的默认档' },
			{ id: 'vssaros-ptc', name: 'PTC 模式（VsSaros）', description: 'PTC 批量调用' },
			{ id: 'some-user-preset', name: '我的自定义' },     // 非模式 ⇒ 不进菜单
		];
		const items = t.presetMenuItems(raw);
		const ids = items.map((x) => x.id);
		const wantIds = ['vssaros-standard', 'vssaros-ptc', 'minimal', 'cordis'];
		if (JSON.stringify(ids) !== JSON.stringify(wantIds)) {
			problems.push(`模式菜单的项与顺序应为 ${JSON.stringify(wantIds)}，实际 ${JSON.stringify(ids)} ✗`);
		}
		const byId = {};
		items.forEach((x) => { byId[x.id] = x; });
		// 文案：dsh 原生两项用同一份硬编码；我们的两项必须取自 preset 定义（不是硬编码）
		if (!byId.minimal || byId.minimal.name !== '极简模式') { problems.push('minimal 的显示名应为「极简模式」✗'); }
		if (!byId.cordis || byId.cordis.name !== '创造模式') { problems.push('cordis 的显示名应为「创造模式」✗'); }
		if (!byId.minimal.desc || byId.minimal.desc.indexOf('只留终端与图片读取') !== 0) {
			problems.push('minimal 必须带那句说明（与 chip 同文案）✗');
		}
		if (!byId['vssaros-standard'] || byId['vssaros-standard'].name !== '标准模式（VsSaros）'
			|| byId['vssaros-standard'].desc !== '带 VsSaros 能力模块的默认档') {
			problems.push('vssaros-* 的显示名/说明必须取自 preset 定义（不许硬编码）✗');
		}
		// 分组标题与 chip 一致
		if (!byId['vssaros-standard'] || byId['vssaros-standard'].groupTitle.indexOf('VsSaros 模式') !== 0) {
			problems.push('VsSaros 组的标题应与 chip 一致（以「VsSaros 模式」开头）✗');
		}
		if (!byId.minimal || byId.minimal.groupTitle.indexOf('dsh 原生') !== 0) {
			problems.push('dsh 原生组的标题应与 chip 一致（以「dsh 原生」开头）✗');
		}
		// 磁盘上缺某个 preset ⇒ 跳过（编一个出来只会让起格失败）
		const partial = t.presetMenuItems([{ id: 'cordis' }]);
		if (partial.length !== 1 || partial[0].id !== 'cordis') {
			problems.push('缺项时应跳过（不许编出磁盘上没有的 preset）✗');
		}
		if (t.presetMenuItems(null).length !== 0) { problems.push('presetMenuItems(null) 应返回空数组 ✗'); }

		// ★ 跨插件一致性：白名单 + 两条原生文案必须与 chat-surface 的 chip **逐字相同**
		const chipPath = 'G:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-chat-surface/lib/client.preset.js';
		if (!existsSync(chipPath)) {
			problems.push('读不到 chat-surface 的 client.preset.js（跨插件一致性无法核对）✗');
		} else {
			const chipSrc = readFileSync(chipPath, 'utf8');
			if (!/OUR_MODES = \["vssaros-standard", "vssaros-ptc"\]/.test(chipSrc)) {
				problems.push('chat-surface 的 OUR_MODES 变了 ⇒ 并行页的模式白名单必须同步 ✗');
			}
			for (const id of ['minimal', 'cordis']) {
				const m = new RegExp(id + ': \\{ name: "([^"]+)", desc: "([^"]+)" \\}').exec(chipSrc);
				if (!m) {
					problems.push(`读不到 chat-surface 里 ${id} 的文案（结构变了 ⇒ 守卫要跟着改）✗`);
					continue;
				}
				const mine = t.BUILTIN_MODE_COPY[id];
				if (!mine || mine.name !== m[1] || mine.desc !== m[2]) {
					problems.push(`${id} 的文案与 chat-surface chip 不一致：`
						+ `chip=「${m[1]} / ${m[2].slice(0, 20)}…」 并行=「${(mine && mine.name) || ''} / ${String((mine && mine.desc) || '').slice(0, 20)}…」✗`);
				}
			}
		}

		// 页面：两个选择器都必须自绘（原生 select 一律不许），提交只读隐藏 input
		const pageSrc3 = readFileSync(join(LIB, 'pageClient.js'), 'utf8');
		if (/createElement\('select'\)/.test(pageSrc3)) {
			problems.push('lib/pageClient.js: 起格表单不许再用原生 select（工作区与模式都要自绘浮层）✗');
		}
		if (!/pickId: 'f-preset-pick'/.test(pageSrc3)) {
			problems.push('lib/pageClient.js: 缺模式选择触发器 #f-preset-pick ✗');
		}
		if (!/function openPresetPop\(/.test(pageSrc3)) {
			problems.push('lib/pageClient.js: 缺 openPresetPop（模式浮层）✗');
		}
		if (!/body\.querySelector\('#f-preset'\)/.test(pageSrc3)) {
			problems.push("lib/pageClient.js: 起格提交必须读隐藏 input('#f-preset') ✗");
		}
		// ★ Bot 候选必须来自 roster（`ctx.agentPresets.list()`），且排除"模式"（模式已单独一栏）
		const idxSrc2 = readFileSync(join(LIB, 'index.js'), 'utf8');
		if (!/async function listAgents\(/.test(idxSrc2)) {
			problems.push('lib/index.js: 缺 listAgents（Bot 候选必须来自 agentPresets roster）✗');
		}
		if (!/get\('agentPresets'\)/.test(idxSrc2)) {
			problems.push("lib/index.js: Bot 候选必须从 ctx.get('agentPresets') 取（运行时可选取，不进静态 inject）✗");
		}
		if (!/PRESET_MODE_IDS\.indexOf\(id\) >= 0/.test(idxSrc2)) {
			problems.push('lib/index.js: Bot 列表必须排除模式 id（否则同一个东西在「模式」和「Bot」两栏各出现一次）✗');
		}
		// ★ 默认模式必须是「标准模式（VsSaros）」（用户 2026-10-23 要求），不是"（不指定）"
		if (!/preset: \(presetMenu\.filter\(\(x\) => x\.id === 'vssaros-standard'\)/.test(idxSrc2)) {
			problems.push("lib/index.js: defaults.preset 必须选「标准模式（VsSaros）」✗");
		}
		notes.push('模式菜单与 chat-surface chip 同口径：白名单/顺序 4 项 + 文案 + 分组标题 + 缺项跳过 + 跨插件逐字比对 + 页面无原生 select —— 通过');
	}
}

// ── 清单：新文件必须在 files 白名单里（否则装出来缺文件 ⇒ 整站 404）────────
{
	const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
	const need = [
		'lib/index.js', 'lib/cells.js', 'lib/runtime.js', 'lib/pageClient.js', 'lib/page.css', 'cordis.patch.yml',
		'vendor/xterm.js', 'vendor/xterm.css', 'vendor/addon-fit.js',
		'vendor/LICENSE.xterm', 'vendor/LICENSE.addon-fit',
	];
	// ★ 关键：CSS 必须在白名单里，否则装出来 404 ⇒ 页面样式全丢（但仍"能跑"，很难发现）
	for (const f of need) {
		if (!pkg.files.includes(f)) { problems.push(`files 白名单缺 ${f} ✗（装出来会缺文件 ⇒ 页面静默退化）`); }
	}
	// 反向：白名单里列的 vendor 文件必须真的存在（列了没拷 ⇒ 装出来 404）
	for (const f of need.filter((x) => x.startsWith('vendor/'))) {
		if (!existsSync(join(DIR, f))) { problems.push(`files 列了 ${f} 但磁盘上不存在 ✗`); }
	}
	notes.push('files 白名单覆盖 lib/*(4 含 page.css) + cordis.patch.yml + vendor/*(5，且磁盘上都存在) —— 通过');
}

// ── 页面与客户端脚本（0.2.0 起格位后端已接）────────────────────────────────
{
	const page = modIndex.__test;
	if (!page || typeof page.renderPage !== 'function') {
		problems.push('lib/index.js: 缺 __test.renderPage ✗');
	} else {
		const html = page.renderPage({});
		const checks = [
			['页面锚点', /data-vssaros-page="parallel"/.test(html)],
			['引客户端脚本', /<script src="\/x\/parallel\/client\.js"><\/script>/.test(html)],
			['有网格容器', /id="grid"/.test(html)],
			['有新增按钮', /id="add-btn"/.test(html)],
			['有 PTY 状态位', /id="pty-pill"/.test(html)],
			// ★ 0.3.0：vendored xterm（颜色靠它；顺序必须是 xterm.js → addon-fit → client.js）
			['引 xterm.js', /<script src="\/x\/parallel\/vendor\/xterm\.js"><\/script>/.test(html)],
			['引 xterm.css', /<link rel="stylesheet" href="\/x\/parallel\/vendor\/xterm\.css">/.test(html)],
			['引 addon-fit', /<script src="\/x\/parallel\/vendor\/addon-fit\.js"><\/script>/.test(html)],
			['xterm.js 在 addon-fit 之前', html.indexOf('/vendor/xterm.js') < html.indexOf('/vendor/addon-fit.js')],
			['client.js 最后', html.indexOf('/vendor/addon-fit.js') < html.indexOf('/client.js')],
			// ★ 0.5.0 UI 重构：样式走独立文件（改样式不用重启 Host）+ 列数切换 + 放大入口
			['引 page.css（独立样式文件）', /<link rel="stylesheet" href="\/x\/parallel\/page\.css">/.test(html)],
			['不再内联 <style>', !/<style>[\s\S]*?<\/style>/.test(html)],
			['有列数切换', /id="cols-seg"/.test(html) && /data-cols="auto"/.test(html) && /data-cols="2"/.test(html)],
			['grid 默认 auto 列', /id="grid"[^>]*data-cols="auto"/.test(html)],
		];
		for (const [label, ok] of checks) { if (!ok) { problems.push(`页面断言失败：${label} ✗`); } }
		// ⚠ 模板串里出现反引号会提前闭合整页（本仓踩过多次）⇒ 页面 CSS 常量里不许有
		if (html.indexOf('\u0060') >= 0) { problems.push('renderPage 输出里出现反引号 ✗（模板闭合风险）'); }
	}
	if (page && typeof page.nextId === 'function') {
		const fakeReg = { list: () => [{ id: 'A1' }, { id: 'A2' }] };
		const id = page.nextId(fakeReg);
		if (id !== 'A3') { problems.push(`nextId 应跳过已用的 A1/A2 给 A3，实际 ${id} ✗`); }
	}
	// 客户端脚本：必须用 SSE + 去 ANSI + textContent（不用 innerHTML 拼 PTY 输出）
	const clientPath = join(LIB, 'pageClient.js');
	if (!existsSync(clientPath)) {
		problems.push('缺 lib/pageClient.js ✗');
	} else {
		const src = readFileSync(clientPath, 'utf8');
		const musts = [
			['SSE 订阅', /new EventSource\(/],
			['★ 主路径用 xterm 渲染（term.write 原样写）', /view\.term\.write\(|term\.write\(/],
			['键盘由 xterm 收（term.onData）', /term\.onData\(/],
			['尺寸同步 POST /resize', /\/resize/],
			['退化路径才剥 ANSI', /stripAnsi/],
			['输入走 POST /input', /\/input/],
			['关格走 DELETE', /method:\s*'DELETE'/],
			['带 token（Host 对所有路径都要凭据）', /withToken/],
			// ★ 0.5.0：列数切换与放大单格（窄格看不清的出口）
			['列数切换 applyCols', /function applyCols\(/],
			['放大单格 toggleMax', /function toggleMax\(/],
			['放大用 class（不改 DOM 结构）', /classList\.add\('is-max'\)/],
			['Esc 退出放大', /Escape/],
			['布局变化后重排', /function refitAll\(/],
			// ★ 0.6.0（对齐 mockup 的交互）：动作要有反馈、状态要说人话、放大要有焦点感
			['动作反馈 showToast', /function showToast\(/],
			['统计文案 statsText（由真实状态算）', /function statsText\(/],
			['状态中文化 stateText', /function stateText\(/],
			['放大时其余格变暗 applyDim', /function applyDim\(/],
			['关闭成功也给反馈（不静默）', /已关闭格位/],
			// ★ 0.7.0（实机"TUI 内部显示错乱"）：尺寸变化必须清旧帧 + 强制 TUI 重绘
			['尺寸变化清旧帧（ESC[2J）', /2J/],
			['强制 TUI 整屏重绘 forceRedraw', /function forceRedraw\(/],
			['重绘走"缩 1 列再复原"（同尺寸不会触发 SIGWINCH）', /cols - 1/],
			['顶部有手动重绘入口', /redraw-btn/],
			// ★ 三个入口：起格表单（cwd+preset）/ 单格菜单 / 缺一不可
			['起格表单 openAddCell', /function openAddCell\(/],
			['单格菜单 openCellMenu', /function openCellMenu\(/],
			['换参数重开 reopenCell', /function reopenCell\(/],
			['通用弹层 showModal', /function showModal\(/],
			['菜单里能叫出 /model', /\/model\\r/],
			['菜单里能叫出 /presets', /\/presets\\r/],
			// ★ 工作区必须**可选**（自绘选择器：分组 + 多根），不是让用户手打路径
			//   （用户口径 2026-10-23：与左侧「工作区」栏 / 会话 chip 一致，多根要按组展开）
			['工作区选择器（自绘触发器）', /id = 'f-ws-pick'|id="f-ws-pick"/],
			['工作区浮层 openWorkspacePop（挂 body 防裁切）', /function openWorkspacePop\(/],
			['多根分组：组头显示「N 个根」', /个根/],
			['保留自定义路径入口', /＋ 自定义路径/],
			// ★ 用户口径 2026-10-23：**只有工作区（组头）能点**，根行只读
			['根行只读（is-ro）', /is-ro/],
			['选工作区 = 取其主根', /g\.roots\[0\]/],
			// ★ 用户口径 2026-10-23：补 Bot 选择 + 修「点起格没反应」
			['Bot 选择器（#f-agent-pick）', /pickId: 'f-agent-pick'/],
			['模式与 Bot 互斥（选一个清另一个）', /applyAgent\(''\)/],
			['起格失败就地显示（不关弹层）', /function showFormError\(/],
			['请求超时（Host 不在时不许无限挂着）', /AbortController/],
			['模型入口（起格后自动打开 /model 面板）', /id = 'f-open-model'/],
			['模型说明如实（TUI 没有 --model）', /没有 --model/],
			['默认模式 = 标准档（后端给）', /defaults/],
		];
		for (const [label, re] of musts) { if (!re.test(src)) { problems.push(`pageClient.js 缺${label} ✗`); } }
		// 反向：不许把 PTY 输出写进 innerHTML
		if (/pre\.innerHTML\s*=/.test(src)) { problems.push('pageClient.js: 不许把 PTY 输出写进 pre.innerHTML（XSS/乱码）✗'); }
		// ★ 反向：主路径**不许**剥 ANSI（剥了就丢颜色 —— 那正是官方 remote.terminal 的问题）
		const writeFn = (src.match(/function writeOut[\s\S]{0,600}?\n\t\}/) || [''])[0];
		if (!/view\.term\.write\(data\)/.test(writeFn)) {
			problems.push('pageClient.js: writeOut 的主路径必须 view.term.write(data)（原样、不剥 ANSI）✗');
		}
		if (/stripAnsi\(data\)/.test(writeFn) && !/if \(view\.pre\)/.test(writeFn)) {
			problems.push('pageClient.js: stripAnsi 只能出现在退化路径（无 xterm 时）✗'); 
		}
	}
	// 样式：toast 与 dim 必须在 page.css 里（放错文件 ⇒ 改样式要重启 Host，且页面会静默少样式）
	const cssPath = join(LIB, 'page.css');
	if (!existsSync(cssPath)) {
		problems.push('缺 lib/page.css ✗');
	} else {
		const css = readFileSync(cssPath, 'utf8');
		const cssMusts = [
			['toast 容器', /\.toasts\s*\{/],
			['toast 条目', /\.toast\s*\{/],
			['放大时其余格变暗', /\.cell\.dim\s*\{/],
			['放大层', /\.cell\.is-max\s*\{/],
			['toast 宽度有上限（窄容器不溢出）', /max-width:\s*min\(420px,\s*calc\(100vw - 32px\)\)/],
			// ★ 格子必须够高：低于 ~400px 只有 20 来行，TUI 头都画不下（实机"错乱"的直接原因之一）
			['格子高度下界 ≥ 400px', /--cell-body-h:\s*clamp\((4\d\d|[5-9]\d\d|[1-9]\d{3})px/],
			// ★ 工作区选择器（2026-10-23）：浮层与组头/根行的样式必须在 page.css 里
			['工作区触发器样式', /\.wspick\s*\{/],
			['工作区浮层样式（fixed）', /\.wspop\s*\{[^}]*position:\s*fixed/],
			['工作区分组组头', /\.wsg-badge\s*\{/],
			['工作区根行', /\.wsr-path\s*\{/],
			['只读根行样式（不许有 hover/指针提示）', /\.wsrow\.is-ro\s*\{[^}]*cursor:\s*default/],
			// ★ 模式浮层（2026-10-23）：组标题 + 说明第二行
			['模式分组标题', /\.pgrp\s*\{/],
			['模式说明行（第二行小字）', /\.wsr-desc\s*\{/],
		];
		for (const [label, re] of cssMusts) { if (!re.test(css)) { problems.push(`page.css 缺${label} ✗`); } }
	}
	notes.push('页面锚点 / vendor 引用顺序 / 客户端接线（xterm + 统计 + toast + dim）/ page.css 关键规则 —— 通过');
}

// ── ⑫ 起格子的子进程环境 + 「已结束不能输入」（2026-10-23 用户报「tui 中无法输入」）──
// 病根两条：
//   ① 起格把 Host 自己的 env 原样传下去（NODE_OPTIONS=IDE 的 --import preload、NODE_CHANNEL_FD、
//      VSCODE_*…）⇒ TUI 子进程行为不可控（dsh 自己的启动器也会先 delete env.NODE_OPTIONS）。
//   ② 格子 exit 1 之后底部还写「点一下格子再打字」⇒ 用户以为键盘坏了。
{
	const t = modIndex && modIndex.__test;
	if (!t || typeof t.childEnv !== 'function') {
		problems.push('lib/index.js: 缺 __test.childEnv（子进程环境清理必须可单测）✗');
	} else {
		const base = {
			PATH: 'C:/bin', HOME: 'C:/Users/x', DSH_HOME: 'C:/h',
			NODE_OPTIONS: '--import file:///host-preload.mjs',
			NODE_CHANNEL_FD: '3',
			NODE_CHANNEL_SERIALIZATION_MODE: 'json',
			ELECTRON_RUN_AS_NODE: '1',
			VSCODE_IPC_HOOK: '\\\\.\\pipe\\x',
			VSCODE_PID: '1',
		};
		const got = t.childEnv(base, { TERM: 'xterm-256color', DSH_HOME: 'C:/tui-home' });
		for (const k of ['NODE_OPTIONS', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_PID']) {
			if (k in got) { problems.push(`childEnv 必须剔掉宿主变量 ${k}（TUI 用不到，还会干扰子进程）✗`); }
		}
		if (got.PATH !== 'C:/bin' || got.HOME !== 'C:/Users/x') {
			problems.push('childEnv 必须保留 PATH / HOME 这类基础变量（剔成空表会让 TUI 起不来）✗');
		}
		if (got.TERM !== 'xterm-256color' || got.DSH_HOME !== 'C:/tui-home') {
			problems.push('childEnv 的 extra 必须覆盖 base（TERM / DSH_HOME）✗');
		}
		if (!('NODE_OPTIONS' in base) || !('VSCODE_PID' in base)) {
			problems.push('childEnv 不许改入参（base 里的宿主变量被抓坏了）✗');
		}

		// 静态：spawnPty 必须走 childEnv，且不许再出现 `...process.env`
		const idxSrc3 = readFileSync(join(LIB, 'index.js'), 'utf8');
		if (!/childEnv\(process\.env/.test(idxSrc3)) {
			problems.push('lib/index.js: spawnPty 必须用 childEnv(process.env, …) 起格子 ✗');
		}
		if (/env:\s*\{\s*\.\.\.process\.env/.test(idxSrc3)) {
			problems.push('lib/index.js: 不许再把 process.env 直接摊进子进程 env ✗');
		}

		// 页面：已结束要说真话、不发无用输入
		const pageSrc4 = readFileSync(join(LIB, 'pageClient.js'), 'utf8');
		if (!/function hintText\(/.test(pageSrc4)) {
			problems.push('lib/pageClient.js: 缺 hintText（底部提示必须按状态说）✗');
		}
		if (!/已结束（exit /.test(pageSrc4)) {
			problems.push('lib/pageClient.js: 已结束必须明说"不能输入 + 怎么重开" ✗');
		}
		if (!/state\.cells\[i\]\.id === id/.test(pageSrc4)) {
			problems.push('lib/pageClient.js: sendInput 必须先查格位状态（已结束就不要发请求）✗');
		}
		notes.push('子进程环境清理（剔 NODE_OPTIONS / NODE_CHANNEL_* / VSCODE_* / ELECTRON_*）+ 已结束格子不给输入、提示说真话 —— 通过');
	}
}

console.log('[check-parallel-cells] 通过项：');
for (const n of notes) { console.log('  ✔ ' + n); }
if (problems.length) {
	console.error(`\n✗ 发现 ${problems.length} 处问题：`);
	for (const p of problems) { console.error('  - ' + p); }
	process.exit(1);
}
console.log('\n[check-parallel-cells] ✓ 全部通过');
