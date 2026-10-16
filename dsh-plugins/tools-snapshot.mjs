// 工具面快照：把**所有** dsh 插件的工具定义（名字 / 必填参数 / 描述指纹）抽成一份机器可比的 JSON。
//
// 为什么要有它（报告 7.3 的 R4/R5：清单漂移不靠人肉报告发现）：
//   报告 `doc/dsh-tool-skill-mcp-report.html` 的 2.x 表是**手工测绘**的 ⇒ 下次重构立刻过期 ✗。
//   这份快照是那份表的**唯一真源**：新增 / 改名 / 改必填参数 / 改描述 ⇒ `--check`（默认）非零退出 ✓，
//   并被 `src/vs/sessions/contrib/dshHarness/test/common/dshToolSnapshot.test.ts` 钉住 ✓
//   ⇒ 文档可以引用它而**不会腐烂** ✓。
//
// 用法：
//   node dsh-plugins/tools-snapshot.mjs            # 与快照比对（漂移 ⇒ 非零退出 + 打印 diff）
//   node dsh-plugins/tools-snapshot.mjs --write    # 重新生成快照（改完工具后**显式**跑一次，diff 进 PR ✓）
//
// 抽取方式（与 `poc/dsh-p0/scripts/p3-26` 同一套）：给每个插件 `apply()` 一个**最小 fake ctx**，
// 捕获它 `ctx.tools.register(...)` 的调用 —— 不启 Host、不调模型、不联网 ✓。
// ⚠ 插件在 apply 期抛错 ⇒ **记成失败并让守卫红** ✗，绝不静默跳过（跳过 = 清单缺一块而没人知道 ✗）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = path.join(HERE, 'tools-snapshot.json');

/** 进程内最小 fake ctx：只实现插件真正用到的成员，并**忠实模拟"服务不存在就不激活"**。 */
function fakeContext() {
	const tools = [];
	const events = [];
	const provided = {};
	const availability = { tools: true, webServer: true, connection: true };
	const ctx = {
		effect: fn => { fn(); return () => { }; },
		// Cordis 4 的可选注入：依赖不齐就**不调** cb（真 ctx 同语义）——否则 fake 会造出真环境不存在的路径 ✗
		inject: (deps, cb) => {
			const wanted = Array.isArray(deps) ? deps : [deps];
			if (wanted.every(d => availability[d])) { cb(ctx); }
			return { dispose: () => { } };
		},
		on: (event, handler) => { events.push({ event, handler }); return () => { }; },
		// Cordis 的服务贡献面：`vssaros-browser` / `vssaros-unreal` 在 apply 期就 `ctx.provide(...)` ✗
		// ⇒ fake 少了它，这两个插件会抛 `ctx.provide is not a function`，于是它们的工具**一条都抽不到** ✓。
		// 好在守卫的"失败数组必须为空"那条会把这种**静默缺一块**变成红 ✓（2026-10-12 实测抓到 ✓）。
		provide: name => { provided[name] = true; return () => { }; },
		get: name => (provided[name] ? {} : undefined),
		set: () => { },
		logger: { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } },
		webServer: { port: 1, host: '127.0.0.1', register: () => () => { } },
		connection: { requestRejection: () => undefined },
		tools: {
			register: definition => { tools.push(definition); return () => { }; },
			get: name => tools.find(t => t.name === name),
			schemas: () => tools.map(t => ({ name: t.name })),
			on: (event, handler) => { events.push({ event, handler }); return () => { }; },
		},
	};
	return { ctx, tools };
}

/** 工具定义 → 快照条目（只留"改了就说明接口变了"的字段）。 */
function entryOf(definition) {
	const required = Array.isArray(definition?.parameters?.required) ? [...definition.parameters.required].sort() : [];
	const properties = definition?.parameters?.properties;
	// ⚠ 参数名集合也要存 ✗：只存 `required` 会漏掉"加了/删了**可选**参数"这一类改动 ✓
	// （2026-10-12 用"给 memory_search 加一个可选参数"的突变实测：只存 required 时守卫**不红** ✗，
	//  而删掉一个可选参数对调用方同样是破坏性的 ✓）。
	const params = properties && typeof properties === 'object' ? Object.keys(properties).sort() : [];
	const description = typeof definition?.description === 'string' ? definition.description : '';
	return {
		name: definition?.name,
		required,
		params,
		// 描述常达数百字 ⇒ 存指纹（前 12 位）✓：改了描述也必须显式更新快照 ✓，但 diff 不至于刷屏。
		descriptionHash: createHash('sha256').update(description).digest('hex').slice(0, 12),
	};
}

/** 抽全部插件的工具面。返回 `{ plugins, total, failures }`（失败**不吞**）。 */
export async function extractToolSnapshot() {
	const plugins = {};
	const failures = [];
	let total = 0;
	const dirs = fs.readdirSync(HERE, { withFileTypes: true })
		.filter(d => d.isDirectory() && d.name.startsWith('vssaros-'))
		.map(d => d.name)
		.sort();
	for (const dir of dirs) {
		const entry = path.join(HERE, dir, 'lib', 'index.js');
		if (!fs.existsSync(entry)) { continue; }
		try {
			const mod = await import(pathToFileURL(entry).href);
			if (typeof mod.apply !== 'function') { continue; }
			// 每个插件用自己的默认 config 跑（与真机"没写覆盖层"时的形态一致 ✓）
			const { ctx, tools } = fakeContext();
			mod.apply(ctx, {});
			const entries = tools.map(entryOf).sort((a, b) => String(a.name).localeCompare(String(b.name)));
			if (entries.length === 0) { continue; }
			plugins[dir] = entries;
			total += entries.length;
		} catch (e) {
			failures.push(`${dir}: ${String(e?.message ?? e)}`);
		}
	}
	return { plugins, total, failures };
}

/** 稳定序列化（键序固定 ⇒ diff 只反映真变化 ✓）。 */
export function serialize(snapshot) {
	const ordered = {};
	for (const dir of Object.keys(snapshot.plugins).sort()) { ordered[dir] = snapshot.plugins[dir]; }
	return JSON.stringify({
		// 手工维护的说明字段（脚本不覆盖）——见文件头"为什么要有它" ✓
		note: '由 dsh-plugins/tools-snapshot.mjs 生成；被 dshHarness/test/common/dshToolSnapshot.test.ts 钉住。不要手改，跑 --write。',
		total: snapshot.total,
		plugins: ordered,
	}, null, 2) + '\n';
}

/** 逐插件/逐条目的差异（人可读，供 CLI 与守卫复用 ✓）。 */
export function diffSnapshots(before, after) {
	const problems = [];
	const dirs = [...new Set([...Object.keys(before.plugins ?? {}), ...Object.keys(after.plugins ?? {})])].sort();
	for (const dir of dirs) {
		const a = (before.plugins?.[dir] ?? []).map(e => `${e.name}|req=${e.required.join(',')}|params=${(e.params ?? []).join(',')}|${e.descriptionHash}`);
		const b = (after.plugins?.[dir] ?? []).map(e => `${e.name}|req=${e.required.join(',')}|params=${(e.params ?? []).join(',')}|${e.descriptionHash}`);
		const removed = a.filter(x => !b.includes(x));
		const added = b.filter(x => !a.includes(x));
		if ((before.plugins?.[dir] === undefined) !== (after.plugins?.[dir] === undefined)) {
			problems.push(`${dir}: 插件在快照里${before.plugins?.[dir] ? '有' : '没有'}、现在${after.plugins?.[dir] ? '有' : '没有'}（工具数 ${a.length} → ${b.length}）`);
		}
		for (const x of removed) { problems.push(`${dir}: 少了/改了 ${x}`); }
		for (const x of added) { problems.push(`${dir}: 多了/改了 ${x}`); }
	}
	return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	const write = process.argv.includes('--write');
	const snapshot = await extractToolSnapshot();
	if (snapshot.failures.length) {
		console.error('✗ 有插件在 apply 期抛错（清单会缺一块 ⇒ 不许静默跳过）：');
		for (const f of snapshot.failures) { console.error(`   - ${f}`); }
		// ★★ 2026-10-12（实测踩到后加的）：**有失败就绝不写盘** ✗ —— 原先 `--write` 照写，
		// 于是"某个插件 apply 抛错"（本轮是 kb 的描述里引用了没导入的常量 ⇒ 整个包装载失败 ✓）
		// 会把一份**缺两块**的快照（9 插件 / 39 工具）覆盖到完整的那份上 ✗✗，接着覆盖率守卫集体
		// 报"台账腐烂 / 映射腐烂"（症状离真因很远 ✓）。⇒ 宁可**留旧快照** + 非零退出 ✓，
		// 也不许把"残缺"当成"新基线"（与本仓"守卫必须 fail-safe"同一条纪律 ✓）。
		//（⚠ 结构上写成下面的 `else if`：ESM 顶层**不许** `return` ✗ —— 第一版就是这么写的，
		//  会变成"整个脚本语法错"，连错误信息都读不到 ✓。）
		if (write) {
			console.error('⇒ 本次 **没有写快照**（有 apply 失败 ⇒ 写下去就是残缺基线 ✗）；先修好再跑 --write ✓。');
		}
		process.exitCode = 1;
	} else if (write) {
		fs.writeFileSync(SNAPSHOT_PATH, serialize(snapshot), 'utf8');
		console.log(`已写入 ${path.relative(process.cwd(), SNAPSHOT_PATH)}：${Object.keys(snapshot.plugins).length} 个插件 / ${snapshot.total} 个工具`);
	} else {
		const before = fs.existsSync(SNAPSHOT_PATH) ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) : { plugins: {} };
		const problems = [...diffSnapshots(before, snapshot), ...snapshot.failures.map(f => `apply 失败：${f}`)];
		if (problems.length) {
			console.error(`✗ 工具面与快照不一致（${problems.length} 处）—— 改过工具就显式跑一次 --write 并把 diff 进 PR：`);
			for (const p of problems) { console.error(`   - ${p}`); }
			process.exitCode = 1;
		} else {
			console.log(`✓ 工具面与快照一致：${Object.keys(snapshot.plugins).length} 个插件 / ${snapshot.total} 个工具`);
		}
	}
}
