/*---------------------------------------------------------------------------------------------
 *  dsh 插件的「宿主配置解析」一致性守卫（P0：能力归 dsh，壳只给路径）。
 *
 * 两件事：
 *   A. **解析契约**（行为断言：真 import 真调用，不是正则猜源码 ✗）
 *      · root      —— `config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`
 *      · sub       —— 显式 `config.<key>` 优先，否则**恰好** `<数据根>/<子目录>`
 *      · workspace —— 显式 `config.workspaceRoot` 优先，没配就是 `null`（不猜）
 *      · mcpPath   —— `defaultMcpPath()` 必须落在数据根下
 *      · dshHome   —— `config.dshHome` → `DSH_HOME` → `~/.dsh`（dashboard 读的是 dsh 自己的家）
 *   B. **拷贝一致性**（对应报告 R6：`dataRootOf` ×7、`pageShell.js` ×5 是"契约共享、实现各自一份"）
 *      同一份实现被拷成多份时，**任何一份被单独改动都要红** —— 而不是等它变成"页面显示与真行为不一致"
 *      （MCP 那份正是这么出过事故：`defaultMcpPath` 漏了环境变量，见 `vssaros-mcp/lib/index.js` 的注释）。
 *      ⚠ 为什么不直接抽成 `dsh-plugins/shared/`：插件是**独立安装进 profile 的包**（`dsh plugin add file:`），
 *        相对路径依赖在 stage 之后会断 ✗ ⇒ 现状只能靠"同形 + 差分/一致性守卫"约束（报告 7.3 P0 的保底做法）。
 *
 * 运行（仓库根）：node dsh-plugins/check-host-config.mjs     （或 npm run check:dsh-plugins）
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PLUGINS_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HOME_DEFAULT = path.join(os.homedir(), '.vssaros');
const DSH_HOME_DEFAULT = path.join(os.homedir(), '.dsh');
const TMP_CONFIG = path.join(os.tmpdir(), 'vssaros-cfgcheck-config');
const TMP_ENV = path.join(os.tmpdir(), 'vssaros-cfgcheck-env');
const TMP_DSH = path.join(os.tmpdir(), 'vssaros-cfgcheck-dsh');

/** 受检面：每项写清"这个函数自己的契约"。 */
const TARGETS = [
	{
		plugin: 'vssaros-skills', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'skillsRootOf', chain: 'sub', sub: 'skills', key: 'skillsRoot' },
		],
	},
	{
		plugin: 'vssaros-kanban', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			// 2026-10-14：看板读 dsh 任务镜像（只读）后，也多了一份 `dshHomeOf` 拷贝 ⇒ 必须纳入
			// 一致性检查，否则它与 dashboard/sessions/agents 那三份**静默漂移**（正是本守卫存在的理由 ✓）。
			// ⚠ `key` **必须写**：判据用它构造"显式配置优先"那一步（`{ [c.key]: TMP_DSH }`）—— 漏了它
			//   这一步会退化成 `{ undefined: … }`，函数看不到配置 ⇒ 报出一道**假红** ✓（本次实测踩到 ✓）。
			{ fn: 'dshHomeOf', chain: 'dshHome', key: 'dshHome' },
		],
	},
	{
		plugin: 'vssaros-kb', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'kbRootOf', chain: 'sub', sub: 'knowledge-base', key: 'kbRoot' },
		],
	},
	{
		plugin: 'vssaros-workflow', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'workflowsRootOf', chain: 'sub', sub: 'workflows', key: 'workflowsRoot' },
		],
	},

	{
		plugin: 'vssaros-agents', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'agentsRootOf', chain: 'sub', sub: 'agents', key: 'agentsRoot' },
		],
	},
	// memory：**本轮（2026-10-12）新引入**数据根（此前只有网关 URL）—— 审计账本落 <数据根>/memory-audit/，
	// 口径必须与上面几份逐字节同形（B2 的拷贝一致性会把它一并纳入比较 ✓）
	{ plugin: 'vssaros-memory', module: 'lib/audit.js', cases: [{ fn: 'dataRootOf', chain: 'root' }] },
	// codebase 的数据来自**工作区**（不是数据根）⇒ 按它自己的契约：给了就用，没给就是 null（不猜）
	{ plugin: 'vssaros-codebase', module: 'lib/store.js', cases: [{ fn: 'workspaceRootOf', chain: 'workspace', key: 'workspaceRoot' }] },
	// mcp：函数名是 defaultMcpPath，契约 = 默认路径必须落在数据根下（与 siblings 同口径）
	{ plugin: 'vssaros-mcp', module: 'lib/index.js', cases: [{ fn: 'defaultMcpPath', chain: 'mcpPath', file: 'mcp.json' }] },
	// dashboard 读的是 **dsh 自己的家**（`<DSH_HOME>/storages/...`），链与数据根不同（报告 R6 里唯一另一条链）
	{ plugin: 'vssaros-dashboard', module: 'lib/store.js', cases: [{ fn: 'dshHomeOf', chain: 'dshHome', key: 'dshHome' }] },
	// dashboard 的**第二条链**（2026-10-13 起）：首页布局落 `<数据根>/dashboard/layout.json`
	// ⇒ 它是本插件**第一个数据根写者**。写者归属的决定见 `dshWriteOwnership.test.ts` 的注释：
	// **故意不声明 `owns`**（那个字段只对"两侧都写"的文件有意义，而 IDE 不认 layout.json ✓）。
	// ⚠ 这份 `dataRootOf` 必须与上面几份**逐字节同形**（B2 的拷贝一致性会把它一并纳入 ✓）⇒ 这就是第 8 份。
	{ plugin: 'vssaros-dashboard', module: 'lib/layoutStore.js', cases: [{ fn: 'dataRootOf', chain: 'root' }] },
	// sessions（历史会话 sideview，2026-10-12 新增）读的是**同一个家、同一个缓存目录**
	// ⇒ 与 dashboard 一条链；两边实现必须逐字同形（改了这里就要一起改）
	{ plugin: 'vssaros-sessions', module: 'lib/store.js', cases: [{ fn: 'dshHomeOf', chain: 'dshHome', key: 'dshHome' }] },
	// agents（2026-10-13 起）为"每个 agent 的实况"读**同一个缓存目录**（花名册页的会话归属/用量
	// 来自 projcache，不另建状态文件）⇒ 同一条链、逐字同形
	{ plugin: 'vssaros-agents', module: 'lib/live.js', cases: [{ fn: 'dshHomeOf', chain: 'dshHome', key: 'dshHome' }] },
	// web-content-import（2026-10-15 新增）：数据根同形（B2 逐字节比对会纳入）+ 知识库根（写库用）
	{
		plugin: 'vssaros-web-content-import', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'kbRootOf', chain: 'sub', sub: 'knowledge-base', key: 'kbRoot' },
		],
	},
];

const results = [];
let violations = 0;

/** 临时改一个环境变量后调用。 */
const withEnv = (name, value, fn) => {
	const before = process.env[name];
	try {
		if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
		return fn();
	} finally {
		if (before === undefined) { delete process.env[name]; } else { process.env[name] = before; }
	}
};

/** 调一次解析函数：抛错/返回非字符串（或非 null）都**如实记成违规**（守卫自身绝不能因此崩 ✗）。 */
const call = (fn, config) => {
	try {
		const value = fn(config);
		return typeof value === 'string' || value === null ? { value } : { error: `返回了非字符串：${JSON.stringify(value)}` };
	} catch (e) {
		return { error: `抛错：${String(e?.message ?? e)}` };
	}
};

const step = (label, got, expected) => (got === expected
	? { ok: true, note: `${label} ✓` }
	: { ok: false, note: `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}` });

for (const target of TARGETS) {
	const file = path.join(PLUGINS_DIR, target.plugin, target.module);
	if (!fs.existsSync(file)) {
		results.push({ plugin: target.plugin, fn: '-', notes: [`模块不存在：${target.module}`] });
		violations++;
		continue;
	}
	const mod = await import(pathToFileURL(file).href);

	for (const c of target.cases) {
		const fn = mod[c.fn];
		if (typeof fn !== 'function') {
			results.push({ plugin: target.plugin, fn: c.fn, notes: ['没有这个导出（守卫只能对导出的函数做行为断言 ⇒ 请导出它）'] });
			violations++;
			continue;
		}

		const notes = [];
		const push = (r) => { if (!r.ok) { notes.push(r.note); } };

		if (c.chain === 'root') {
			push(step('配置优先', call(fn, { dataRoot: TMP_CONFIG }).value, TMP_CONFIG));
			push(step('环境次之', withEnv('VSSAROS_DATA_ROOT', TMP_ENV, () => call(fn, {}).value), TMP_ENV));
			push(step('默认兜底', withEnv('VSSAROS_DATA_ROOT', undefined, () => call(fn, {}).value), HOME_DEFAULT));
		}

		if (c.chain === 'sub') {
			push(step(`显式 ${c.key} 优先`, call(fn, { [c.key]: TMP_CONFIG }).value, TMP_CONFIG));
			push(step('<数据根>/<子目录> 拼接',
				withEnv('VSSAROS_DATA_ROOT', undefined, () => call(fn, { dataRoot: TMP_CONFIG }).value),
				path.join(TMP_CONFIG, c.sub)));
		}

		if (c.chain === 'workspace') {
			push(step(`显式 ${c.key} 优先`, call(fn, { [c.key]: TMP_CONFIG }).value, TMP_CONFIG));
			push(step('未配置 ⇒ null（不猜）', call(fn, {}).value, null));
		}

		if (c.chain === 'mcpPath') {
			push(step('环境次之', withEnv('VSSAROS_DATA_ROOT', TMP_ENV, () => call(fn, {}).value), path.join(TMP_ENV, c.file)));
			push(step('默认兜底', withEnv('VSSAROS_DATA_ROOT', undefined, () => call(fn, {}).value), path.join(HOME_DEFAULT, c.file)));
		}

		if (c.chain === 'dshHome') {
			push(step(`显式 ${c.key} 优先`, call(fn, { [c.key]: TMP_DSH }).value, TMP_DSH));
			push(step('环境次之（DSH_HOME）', withEnv('DSH_HOME', TMP_DSH, () => call(fn, {}).value), TMP_DSH));
			push(step('默认兜底（~/.dsh）', withEnv('DSH_HOME', undefined, () => call(fn, {}).value), DSH_HOME_DEFAULT));
		}

		results.push({ plugin: target.plugin, fn: c.fn, notes, contract: c.chain + (c.sub ? `/${c.sub}` : '') });
		if (notes.length) { violations++; }
	}
}

// ─── B. 拷贝一致性（报告 R6）────────────────────────────────────────────────
const walk = (dir, out = []) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { walk(full, out); } else if (full.endsWith('.js')) { out.push(full); }
	}
	return out;
};
const allJs = walk(PLUGINS_DIR).filter(f => !/[\\/]bin[\\/]/.test(f) && !/check-host-config/.test(f));
const shortHash = t => createHash('sha256').update(t).digest('hex').slice(0, 12);
const rel = f => path.relative(PLUGINS_DIR, f).replace(/\\/g, '/');

/** 把多个文件按内容哈希分组，报告"是否只有一种内容"。 */
const copyGroups = [];
function checkSame(label, entries) {
	if (!entries.length) {
		copyGroups.push({ label, notes: ['一个副本都没找到（是不是改名/删了？）'] });
		violations++;
		return;
	}
	const byHash = new Map();
	for (const e of entries) {
		if (!byHash.has(e.hash)) { byHash.set(e.hash, []); }
		byHash.get(e.hash).push(e.file);
	}
	const notes = byHash.size === 1
		? []
		: [...byHash.values()].map(list => `内容不一致：${list.join(', ')}`);
	copyGroups.push({ label, notes, detail: `${entries.length} 份，${byHash.size} 种内容，sha ${entries[0].hash}` });
	if (notes.length) { violations++; }
}

// B1 页面壳：5 份逐字节同形
checkSame('页面壳 pageShell.js（5 份同形）', allJs
	.filter(f => /lib[\\/]pageShell\.js$/.test(f))
	.map(f => ({ file: rel(f), hash: shortHash(fs.readFileSync(f, 'utf8')) })));

// B2 数据根解析：各份 `dataRootOf` 正文逐字节同形。
// ⚠ 口径是「**任何** `lib/*.js` 里定义了它的都要纳入」—— **不做文件名白名单**。2026-10-13 加第 8 份
// （dashboard 的 `lib/layoutStore.js`，首页布局落盘）时真踩过这个口子：只在 TARGETS 里登记了它，
// 这里因为白名单是 `(store|index)\.js` 而**仍然只数 7 份** ⇒ 新拷贝**静默逃逸**同形检查 ✗。
{
	const entries = [];
	for (const f of allJs.filter(f => /lib[\\/][\w.-]+\.js$/.test(f))) {
		const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
		const i = src.indexOf('export function dataRootOf(');
		if (i < 0) { continue; }
		const j = src.indexOf('\n}', i);
		entries.push({ file: rel(f), hash: shortHash(src.slice(i, j).trim()) });
	}
	checkSame(`dataRootOf 实现（${entries.length} 份同形）`, entries);
	// ⚠ 份数**写死**：新增/移除一份 dataRootOf 必须显式改这里 ⇒ 逼一次"它为什么不同形 / 为什么不在名单里"的复核 ✓
	// 8 = skills / kanban / kb / workflow / agents / memory(audit) / dashboard(store) / dashboard(layoutStore)。
	// （2026-10-15：canvas 模块已移除 ⇒ 份数 9 → 8 ✓；此后**新增插件** vssaros-web-content-import 又带来一份**逐字节同形**的 dataRootOf ⇒ 8 → 9 ✓ —— 本仓新增数据根解析就同步这里，有意不同形的要写清理由 ✓。）
	// ⚠ 放宽白名单前它数的是 7 —— 也就是说 `vssaros-memory/lib/audit.js` 与当时还没写的
	// dashboard/layoutStore.js 都**曾在这条守卫之外**（前者一直是漏网之鱼 ✓，2026-10-13 发现）。
	const EXPECTED_DATAROOTOF_COPIES = 9;
	if (entries.length !== EXPECTED_DATAROOTOF_COPIES) {
		violations++;
		console.log(`  ✗  dataRootOf 同形份数是 ${entries.length}，应为 ${EXPECTED_DATAROOTOF_COPIES}`
			+ '（新增一份数据根解析就同步这里；若它**有意**不同形，得在此写出理由并登记 ✓）');
	}
}

// ─── 输出 ───────────────────────────────────────────────────────────────────
const width = Math.max(...results.map(r => r.plugin.length));
console.log('--- A. dsh 插件宿主配置解析契约（按各自契约做行为断言）---');
for (const r of results) {
	const mark = r.notes.length ? '✗' : '✔';
	console.log(`  ${mark}  ${r.plugin.padEnd(width)}  ${String(r.fn).padEnd(16)}  ${r.notes.length ? r.notes.join('；') : `${r.contract} 契约成立`}`);
}
console.log('\n--- B. 拷贝一致性（报告 R6：同形但各存一份）---');
for (const g of copyGroups) {
	const mark = g.notes.length ? '✗' : '✔';
	console.log(`  ${mark}  ${g.label.padEnd(38)}  ${g.notes.length ? g.notes.join('；') : g.detail}`);
}
console.log(`\n受检 ${results.length} 项契约 + ${copyGroups.length} 组拷贝，违规 ${violations} 项`);
if (violations) {
	console.log('修法：① 契约——按它文档里的链取值（`config.<key>` → 环境变量 → 默认）并**导出**它；' +
		'② 拷贝——改了其中一份就要**同步改其它份**（它们必须逐字节同形；有意不同的那份要写清理由并在此登记）✓');
}
process.exit(violations ? 1 : 0);
