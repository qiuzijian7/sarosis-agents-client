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
 *      · **workspaceContext / partition**（2026-10-17）—— 运行期工作区上下文优先，且"没有上下文"时
 *        逐字回落 config（切工作区不必重启 Host 的落点；三条纪律见 foundation 的 workspaceContext.js ✓）
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
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PLUGINS_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HOME_DEFAULT = path.join(os.homedir(), '.vssaros');
const DSH_HOME_DEFAULT = path.join(os.homedir(), '.dsh');
const TMP_CONFIG = path.join(os.tmpdir(), 'vssaros-cfgcheck-config');
const TMP_ENV = path.join(os.tmpdir(), 'vssaros-cfgcheck-env');
const TMP_DSH = path.join(os.tmpdir(), 'vssaros-cfgcheck-dsh');

// ★ 2026-10-21：守卫必须**与环境解耦**。
//   codebase 的 `workspaceRootOf` 除了 config 与运行期上下文，还会兜底读 **IDE 写的 overlay**
//   （`<数据根>/dsh-run/codebase-*.yml`，2026-10-20 为修「多根工作区只返回一个目录」加的）。
//   本机装了 IDE ⇒ 那个 overlay **真的存在** ⇒ 「没配 ⇒ null（不猜）」这条断言会随环境时红时绿 ✗。
//   处置：整个守卫期间把 VSSAROS_DATA_ROOT 指向一个**空目录**（overlay 必然读不到 ⇒ 断言确定），
//   overlay 本身的正向行为另用**子进程**单独断（模块级缓存记的是第一次结果，同进程断不了两种状态）。
const EMPTY_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-cfgcheck-emptyroot-'));
process.env.VSSAROS_DATA_ROOT = EMPTY_DATA_ROOT;

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
			// 2026-10-17：工作区 id 的运行期优先级（写路径：它错 = 卡片静默进旧工作区 ✗）
			{ fn: 'workspaceIdOf', chain: 'workspaceContext', key: 'workspaceId', absent: '' },
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
	// scheduler（2026-10-31 重构后新增 `lib/store.js`）：任务落 `<数据根>/scheduler/tasks.json` ⇒
	// 它也是数据根消费者。这里登记后守卫会对 `dataRootOf` 做**行为断言**（配置优先 / 环境次之 / 默认兜底）。
	{
		plugin: 'vssaros-scheduler', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
		],
	},

	{
		plugin: 'vssaros-agents', module: 'lib/store.js', cases: [
			{ fn: 'dataRootOf', chain: 'root' },
			{ fn: 'agentsRootOf', chain: 'sub', sub: 'agents', key: 'agentsRoot' },
		],
	},
	// 2026-11-03：vssaros-memory 整套下线并归档 ⇒ 上面两条（audit.js 数据根 / index.js 分区键）已摘除，
	// 否则 TARGETS 会因「模块不存在」直接记违规。
	// codebase 的数据来自**工作区**（不是数据根）⇒ 按它自己的契约：给了就用，没给就是 null（不猜）
	{
		plugin: 'vssaros-codebase', module: 'lib/store.js', cases: [
			{ fn: 'workspaceRootOf', chain: 'workspace', key: 'workspaceRoot' },
			// 2026-10-17：工作区根的**运行期优先级**（切工作区后图谱要跟着换根，不重启 Host ✓）
			{ fn: 'workspaceRootOf', chain: 'workspaceContext', key: 'workspaceRoot', absent: null },
		],
	},
	// 看板**写路径**的打标来源（2026-10-17）：`kanban_create` / `update` / `decompose` / `swarm` / `specify`
	// 都经它决定卡片归哪个工作区。为什么要单独断它：dsh 侧的**读**路径**不按工作区过滤**（`kanban_list`
	// 缺省 = 全部工作区，过滤在 IDE 侧用它自己的活动工作区 id 做 ✓）⇒ 只断读路径会得出"运行期上下文没用"
	// 的**错误**结论 ✗。⚠ 它是生产代码（导出只为可断言 —— 与 memory 的 `partitionKeyOf` 同一做法 ✓）。
	{ plugin: 'vssaros-kanban', module: 'lib/index.js', cases: [{ fn: 'requireWorkspaceId', chain: 'writeStamp' }] },
	// 看板**自动执行 runner** 的工作目录解析（2026-10-17 重做）：它是"在哪跑任务"的唯一判据，
	// ★ 最要命的一条是"**绝不用当前工作区的目录去跑别的工作区的卡**"（在 A 的代码库里执行 B 的任务 ✗✗）。
	{ plugin: 'vssaros-kanban', module: 'lib/store.js', cases: [{ fn: 'runnerCwdOf', chain: 'runnerCwd' }] },
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

/** "如实抛错"的哨兵（它本身也是一条要断言的契约：拿不到工作区 id 时必须抛，不能猜 ✓）。 */
const THREW = '<<threw>>';
/** 调一次**可能抛**的函数：抛 ⇒ `THREW` 哨兵（`call` 那条只收字符串/`null`，不够用 ✓）。 */
const callOrThrew = fn => {
	try {
		return fn();
	} catch {
		return THREW;
	}
};

// 重构 1.3（2026-10-16）：dataRootOf / dshHomeOf 已收编进 @vssaros/dsh-foundation，
// 各插件的同名导出是**委托**（经 `lib/foundationRef.js` 拿 cordis 服务）。直接 import 目标模块时
// 服务未绑定 ⇒ 调用会抛 ⇒ 先把 foundation 的真源实现绑进去（与被测插件同进程、同模块实例）。
const { createFoundationService } = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-foundation', 'lib', 'index.js')).href);
const foundationSvc = createFoundationService();

for (const target of TARGETS) {
	const file = path.join(PLUGINS_DIR, target.plugin, target.module);
	if (!fs.existsSync(file)) {
		results.push({ plugin: target.plugin, fn: '-', notes: [`模块不存在：${target.module}`] });
		violations++;
		continue;
	}
	// 先绑委托（插件若有 foundationRef.js 就绑；没有说明它没消费共享服务，跳过）
	const refFile = path.join(PLUGINS_DIR, target.plugin, 'lib', 'foundationRef.js');
	if (fs.existsSync(refFile)) {
		const ref = await import(pathToFileURL(refFile).href);
		ref.bindFoundation(foundationSvc);
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

		// ★ 2026-10-17：运行期工作区上下文的三条纪律（真源见 foundation 的 workspaceContext.js ✓）
		if (c.chain === 'workspaceContext') {
			// ① 没有上下文 ⇒ 与"这条能力不存在"时**逐字相同**（老 Host / 探针的兼容面，最不能变的一条 ✓）
			foundationSvc.clearWorkspaceContext();
			push(step('没有上下文 ⇒ 回落 config', call(fn, { [c.key]: TMP_CONFIG }).value, TMP_CONFIG));
			// ② 有上下文 ⇒ **以它为准**（config 里放一个**不同**的值 ⇒ 认错就必红 ✓）
			foundationSvc.setWorkspaceContext({ [c.key]: TMP_ENV, relatedRoots: [] });
			push(step('有上下文 ⇒ 上下文优先', call(fn, { [c.key]: TMP_CONFIG }).value, TMP_ENV));
			// ②b 畸形载荷必须**被拒收且保留旧值**（静默丢字段 = "推了但没生效"伪装成成功 ✗✗）
			//     这条链每个消费方各跑一遍，代价可忽略（两条新契约而已 ✓）。
			const before = foundationSvc.workspaceContext();
			const badType = foundationSvc.setWorkspaceContext({ [c.key]: 123, relatedRoots: [] });
			const badRoots = foundationSvc.setWorkspaceContext({ relatedRoots: 'not-an-array' });
			const kept = foundationSvc.workspaceContext();
			// ⚠ 期望值写成 `String(...)`：`step` 是 `got === expected` 的严格比较，
			//   直接传 `undefined` 无法与"实际是 undefined"区分成有意断言（本次就先这么写错过一次 ✓）。
			push(step(`畸形 ${c.key}（数字）被拒收`, String(badType), 'undefined'));
			push(step('畸形 relatedRoots（非数组）被拒收', String(badRoots), 'undefined'));
			push(step('拒收后旧值未被清掉', JSON.stringify(kept), JSON.stringify(before)));
			push(step('拒收后消费方仍读旧值', call(fn, { [c.key]: TMP_CONFIG }).value, TMP_ENV));
			// ③ 上下文里"没有这一项" ⇒ **不**回落 config 的旧值（回落 = "切了工作区还在用旧的" ✗✗）
			foundationSvc.setWorkspaceContext({ relatedRoots: [] });
			push(step('上下文说"没有" ⇒ 不回落旧 config', call(fn, { [c.key]: TMP_CONFIG }).value, c.absent));
			// ③b 幂等推（值没变）：**不广播**（否则 runner 之类会白重算）；但来源标签照更新 ✓
			let fired = 0;
			const off = foundationSvc.onDidChangeWorkspaceContext(() => { fired++; });
			foundationSvc.setWorkspaceContext({ relatedRoots: [], windowId: 7 });
			push(step('值没变 ⇒ 不广播变更', fired, 0));
			foundationSvc.setWorkspaceContext({ [c.key]: TMP_ENV, windowId: 7, relatedRoots: [] });
			push(step('值变了 ⇒ 广播一次', fired, 1));
			off();
			foundationSvc.clearWorkspaceContext();
		}

		// 同上，但断言落在**记忆分区键**上（`ws-` 前缀与 `default` 兜底由 core/memory.js 决定 ✓）
		if (c.chain === 'partition') {
			foundationSvc.clearWorkspaceContext();
			push(step('没有上下文 ⇒ ws-<config id>', call(fn, { workspaceId: 'cfg' }).value, 'ws-cfg'));
			foundationSvc.setWorkspaceContext({ workspaceId: 'rt', relatedRoots: [] });
			push(step('有上下文 ⇒ ws-<运行期 id>', call(fn, { workspaceId: 'cfg' }).value, 'ws-rt'));
			foundationSvc.setWorkspaceContext({ relatedRoots: [] });
			push(step('上下文说"没有工作区" ⇒ 旧分区 default', call(fn, { workspaceId: 'cfg' }).value, 'default'));
			foundationSvc.clearWorkspaceContext();
		}

		// ★ 同一条纪律，但断的是看板**写路径**的打标来源（`requireWorkspaceId(config, fromArgs)`）：
		//   条件与上面 `workspaceContext` 链同源（它内部就调 `workspaceIdOf`），这里多钉两件只有它会有的：
		//   · 工具参数优先（模型显式给 workspaceId 就照它 ✓）；
		//   · ★ 上下文说"当前没有活动工作区" ⇒ **必须抛**（fail-closed）—— 若拿 config 那份旧 id 建卡，
		//     卡片会静默落进**旧**工作区（在界面上看不见，只能读 JSON 才发现 ✗✗）——这正是本刀要防的错 ✓。
		if (c.chain === 'writeStamp') {
			foundationSvc.clearWorkspaceContext();
			push(step('工具参数优先（显式给 workspaceId 就照它 ✓）',
				callOrThrew(() => fn({ workspaceId: 'cfg' }, 'arg')), 'arg'));
			foundationSvc.setWorkspaceContext({ workspaceId: 'rt', relatedRoots: [] });
			push(step('没给参数 ⇒ 运行期上下文优先', callOrThrew(() => fn({ workspaceId: 'cfg' }, undefined)), 'rt'));
			foundationSvc.clearWorkspaceContext();
			push(step('没有上下文 ⇒ 回落 config（与这条能力不存在时逐字相同 ✓）',
				callOrThrew(() => fn({ workspaceId: 'cfg' }, undefined)), 'cfg'));
			foundationSvc.setWorkspaceContext({ relatedRoots: [] });
			push(step('上下文说"没有工作区" ⇒ **如实抛错**，不拿旧 id 建卡（fail-closed ✓）',
				callOrThrew(() => fn({ workspaceId: 'cfg' }, undefined)), THREW));
			foundationSvc.clearWorkspaceContext();
		}

		// ★ 看板自动执行 runner 的目录解析（`runnerCwdOf(config, taskWorkspaceId, list)`，2026-10-17 重做）：
		//   它是"这条任务在**哪个目录**里跑"的唯一判据 ⇒ 最要命的一条是**别的工作区的卡绝不能用今天的目录跑** ✗✗。
		if (c.chain === 'runnerCwd') {
			const rc = (cfg, taskWs, list) => {
				try { return fn(cfg, taskWs, list); } catch { return THREW; }
			};
			// ① 有上下文 + 卡属于当前工作区 ⇒ 用上下文的根（**产品路径** ✓）
			foundationSvc.setWorkspaceContext({ workspaceId: 'ws-a', workspaceRoot: 'R:/a', relatedRoots: [] });
			push(step('有上下文 + 卡属于当前工作区 ⇒ 上下文的根', rc({}, 'ws-a'), 'R:/a'));
			// ② ★ 有上下文 + 卡属于**别的**工作区 ⇒ 空（绝不拿今天的目录去跑别人的卡 ✗）
			push(step('★ 别的工作区的卡 ⇒ 空（不用当前目录硬跑 ✗）', rc({}, 'ws-b'), ''));
			// ③ 有上下文但**没有根** ⇒ 空（fail-closed ⇒ 调用方跳过该卡 ✓）
			foundationSvc.setWorkspaceContext({ workspaceId: 'ws-a', relatedRoots: [] });
			push(step('上下文里没有 workspaceRoot ⇒ 空（跳过，不猜 ✓）', rc({}, 'ws-a'), ''));
			// ④ 上下文说"没有活动工作区" ⇒ 空（`''`/`undefined` 的 id 都不匹配 ✓）
			foundationSvc.setWorkspaceContext({ relatedRoots: [] });
			push(step('上下文说"没有工作区" ⇒ 空（不跑任何卡 ✓）', rc({}, ''), ''));
			// ⑤ 没有上下文（老 Host / 探针）⇒ 老口径**逐字不变**：registry 命中 → workspacePath → 空
			foundationSvc.clearWorkspaceContext();
			push(step('没有上下文 + registry 命中 ⇒ 那份 path（老口径不变 ✓）',
				rc({}, 'ws-a', [{ id: 'ws-a', path: 'R:/reg' }]), 'R:/reg'));
			push(step('没有上下文 + 没命中 ⇒ config.workspacePath（探针后门不变 ✓）',
				rc({ workspacePath: 'R:/cfg' }, 'ws-a', []), 'R:/cfg'));
			push(step('没有上下文 + 都没有 ⇒ 空（不启动，不猜 ✓）', rc({}, 'ws-a', []), ''));
		}

		results.push({ plugin: target.plugin, fn: c.fn, notes, contract: c.chain + (c.sub ? `/${c.sub}` : '') });
		if (notes.length) { violations++; }
	}
}

// ─── A2. codebase 的 overlay 兜底（**单独子进程**）────────────────────────────
//  2026-10-20：codebase 的 `workspaceRootOf` 除了 config 与运行期上下文，还会兜底读
//  **IDE 写的 overlay**（`<数据根>/dsh-run/codebase-*.yml`）—— 修的是「多根工作区只返回一个目录」。
//  ⚠ 必须单独进程：`store.js` 把 overlay 结果**模块级缓存**（第一次读到什么就一直是它），
//  同进程里断不了「有 overlay」与「无 overlay」两种状态 ⇒ 正向行为只能另起进程断。
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-cfgcheck-overlay-'));
	const dshRun = path.join(dir, 'dsh-run');
	fs.mkdirSync(dshRun, { recursive: true });
	const want = path.join(dir, 'ws-root').replace(/\\/g, '/');
	fs.writeFileSync(path.join(dshRun, 'codebase-probe.yml'), `workspaceRoot: '${want}'\nrelatedRoots:\n  - '${want}/sub'\n`);
	const probeFile = path.join(dir, 'probe.mjs');
	const storeUrl = pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-codebase', 'lib', 'store.js')).href;
	fs.writeFileSync(probeFile, [
		`import { workspaceRootOf } from ${JSON.stringify(storeUrl)};`,
		`process.stdout.write(JSON.stringify(workspaceRootOf({})));`,
	].join('\n'));
	const notes = [];
	let got;
	try {
		const out = execFileSync(process.execPath, [probeFile], {
			env: { ...process.env, VSSAROS_DATA_ROOT: dir },
			encoding: 'utf8',
			windowsHide: true,
		});
		got = JSON.parse(out);
	} catch (e) {
		notes.push(`子进程探针失败：${String(e?.message ?? e)}`);
	}
	if (!notes.length && got !== want) {
		notes.push(`overlay 兜底：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}（overlay 兜底被删 ⇒ 图谱页空态回归 ✗）`);
	}
	results.push({ plugin: 'vssaros-codebase', fn: 'workspaceRootOf(overlay)', notes, contract: 'overlay' });
	if (notes.length) { violations++; }
}

// ─── A3. P0-1 工作区根集（2026-11-10）───────────────────────────────────────
//  兼容期两条硬规矩，全部**行为断言**（真调 foundation 服务，不靠正则猜源码）：
//    ① 老载荷（不带 roots）⇒ normalize 输出逐字不变、store 的回落/幂等不变；
//    ② 所有消费方只读 deriveWorkspaceRoots() ⇒ 主根去重、保序、带根名、主根恒在首位。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const F = foundationSvc;
	F.clearWorkspaceContext();

	// ① 老载荷：输出（含键顺序）与"这条能力不存在"时逐字相同
	const legacy = { workspaceId: 'ws-a', workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b', 'R:/a'], windowId: 7, at: 123 };
	const norm = F.normalizeWorkspaceContext(legacy);
	push(step('老载荷 ⇒ 输出逐字不变（不冒出 roots 键）', JSON.stringify(norm), JSON.stringify({
		workspaceId: 'ws-a', workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b'], windowId: 7, at: 123,
	})));
	push(step('老载荷 ⇒ 主根去重/保序/首位', JSON.stringify(F.deriveWorkspaceRoots(norm)), JSON.stringify([
		{ path: 'R:/a', name: 'a', isPrimary: true },
		{ path: 'R:/b', name: 'b', isPrimary: false },
	])));

	// ② 没有 workspaceRoot ⇒ relatedRoots[0] 兜底为主根；空上下文 ⇒ []
	const noRoot = F.normalizeWorkspaceContext({ relatedRoots: ['R:/a', 'R:/b'] });
	push(step('没有 workspaceRoot ⇒ 第一根为主根',
		JSON.stringify(F.deriveWorkspaceRoots(noRoot).map(r => `${r.path}:${r.isPrimary}`)),
		JSON.stringify(['R:/a:true', 'R:/b:false'])));
	push(step('没有上下文 ⇒ []（不猜）', JSON.stringify(F.deriveWorkspaceRoots(undefined)), '[]'));
	push(step('上下文说没有根 ⇒ []', JSON.stringify(F.deriveWorkspaceRoots(F.normalizeWorkspaceContext({ relatedRoots: [] }))), '[]'));
	// ②b 调用方绕过 normalize 手工塞重复根时也必须去重（纯函数可被直接 import ✓）。
	//     这条专门钉"有序根集"本身：只断言老载荷时，`ordered` 的 filter 会掩盖掉去重实现被删 ✗。
	push(step('重复根 ⇒ 派生后仍只有 2 根', JSON.stringify(F.deriveWorkspaceRoots({
		workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b', 'R:/b'],
	})), JSON.stringify([
		{ path: 'R:/a', name: 'a', isPrimary: true },
		{ path: 'R:/b', name: 'b', isPrimary: false },
	])));

	// ③ 新载荷：去重保序 + 根名 + 主根（workspaceRoot）提到首位
	const structured = F.normalizeWorkspaceContext({
		workspaceRoot: 'R:/a', relatedRoots: [], roots: [
			{ path: 'R:/b', name: 'backend' },
			{ path: 'R:/a', name: 'frontend', isPrimary: true },
			{ path: 'R:/b', name: 'backend' },
		],
	});
	push(step('结构化 roots ⇒ 去重保序 + 保留根名', JSON.stringify(structured?.roots), JSON.stringify([
		{ path: 'R:/b', name: 'backend' },
		{ path: 'R:/a', name: 'frontend', isPrimary: true },
	])));
	push(step('结构化 roots ⇒ 主根提到首位', JSON.stringify(F.deriveWorkspaceRoots(structured)), JSON.stringify([
		{ path: 'R:/a', name: 'frontend', isPrimary: true },
		{ path: 'R:/b', name: 'backend', isPrimary: false },
	])));
	push(step('rootNameOf 取到根名', String(F.rootNameOf(structured, 'R:/b')), 'backend'));

	// ④ 畸形一律整份拒收（不是静默丢字段）
	const badPayloads = [
		['非数组', { roots: 'x' }],
		['path 非字符串', { roots: [{ path: 123 }] }],
		['path 空白', { roots: [{ path: '   ' }] }],
		['name 非字符串', { roots: [{ path: 'R:/a', name: 7 }] }],
		['name 为 null', { roots: [{ path: 'R:/a', name: null }] }],
		['isPrimary 非布尔', { roots: [{ path: 'R:/a', isPrimary: 'yes' }] }],
		['超上限', { roots: Array.from({ length: F.MAX_WORKSPACE_ROOTS + 1 }, (_, i) => ({ path: `R:/r${i}` })) }],
	];
	for (const [label, bad] of badPayloads) {
		push(step(`畸形 roots（${label}）⇒ 整份拒收`, String(F.normalizeWorkspaceContext(bad)), 'undefined'));
	}

	// ⑤ store：拒收保留旧值、读侧跟着走、根名变化要广播
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [], roots: [{ path: 'R:/a', name: 'frontend' }] });
	const before = F.workspaceContext();
	push(step('store 拒收畸形 roots', String(F.setWorkspaceContext({ roots: 'x' })), 'undefined'));
	push(step('拒收后旧值未丢', JSON.stringify(F.workspaceContext()), JSON.stringify(before)));
	push(step('读侧 workspaceRoots() 返回有序根集', JSON.stringify(F.workspaceRoots()), JSON.stringify([
		{ path: 'R:/a', name: 'frontend', isPrimary: true },
	])));
	let fired = 0;
	const off = F.onDidChangeWorkspaceContext(() => { fired++; });
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [], roots: [{ path: 'R:/a', name: 'frontend' }], windowId: 9 });
	push(step('根集没变 ⇒ 不重复广播', fired, 0));
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [], roots: [{ path: 'R:/a', name: 'backend' }] });
	push(step('根名变了 ⇒ 广播一次', fired, 1));
	off();
	push(step('roots 从无到有 ⇒ 判为变化', String(F.sameWorkspaceContext(
		F.normalizeWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [] }),
		F.normalizeWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [], roots: [] }))), 'false'));
	F.clearWorkspaceContext();

	// ⑥ 跨层上限对账：foundation 与桥协议必须同值（页面桥的 16 是 UI 展示上限，别混成一个数）
	const protocolSrc = fs.readFileSync(path.join(PLUGINS_DIR, '..', 'src', 'vs', 'sessions', 'contrib',
		'dshHarness', 'common', 'dshBridgeProtocol.ts'), 'utf8');
	push(step('foundation 根上限 = 64', String(F.MAX_WORKSPACE_ROOTS), '64'));
	push(step('桥协议导出同值常量', String(new RegExp(`export const MAX_WORKSPACE_CONTEXT_ROOTS = ${F.MAX_WORKSPACE_ROOTS};`).test(protocolSrc)), 'true'));

	results.push({ plugin: 'vssaros-foundation', fn: 'deriveWorkspaceRoots', notes, contract: 'workspaceRoots' });
	if (notes.length) { violations++; }
}

// ─── A4. P0-2 模型上下文段 + 根限定路径（2026-11-10）──────────────────────
//  两条最要紧的契约：
//   ① 单根 / 没推过上下文 ⇒ 文本为 '' ⇒ 绝大多数会话的 system prompt 逐字不变（不击穿缓存 ✓）；
//   ② systemPrompt.context 的 text() 必须是**函数**，每次装配重读真源 ⇒ 切工作区后不说谎。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const F = foundationSvc;
	F.clearWorkspaceContext();

	push(step('没有上下文 ⇒ 不注入任何文本', F.renderWorkspaceRootsText(undefined), ''));
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [] });
	push(step('单根 ⇒ 不注入任何文本（system prompt 逐字不变）', F.renderWorkspaceRootsText(F.workspaceContext()), ''));

	F.setWorkspaceContext({
		workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b'], roots: [
			{ path: 'R:/a', name: 'frontend', isPrimary: true },
			{ path: 'R:/b', name: 'backend' },
		],
	});
	const roots = F.workspaceRoots();
	const text = F.renderWorkspaceRootsText(F.workspaceContext());
	push(step('多根 ⇒ 有 heading', String(text.includes('## Workspace roots (multi-root)')), 'true'));
	push(step('多根 ⇒ primary/additional + 根名 + 路径都在',
		String(text.includes('- primary  frontend  R:/a') && text.includes('- additional  backend  R:/b')), 'true'));
	push(step('多根 ⇒ 写明相对路径只基准主根',
		String(text.includes('Relative paths resolve ONLY against the primary root')), 'true'));
	push(step('多根 ⇒ 提示绝对路径与同名消歧',
		String(text.includes('always use its absolute path') && text.includes('disambiguate with the absolute path')), 'true'));
	// ★ 文案纪律：工具还没接根限定语法 ⇒ 提示词不许提前宣传（否则模型用了会被当成普通路径 ✗）
	push(step('提示词不宣传尚未接线的 @<root> 语法', String(!text.includes('@<root-name>')), 'true'));
	push(step('cwd 非主根 ⇒ 如实提示',
		String(F.renderWorkspaceRootsText(F.workspaceContext(), { cwd: 'R:/b' }).includes('not the primary root')), 'true'));
	push(step('cwd 就是主根 ⇒ 不加多余提示',
		String(!F.renderWorkspaceRootsText(F.workspaceContext(), { cwd: 'R:/a' }).includes('not the primary root')), 'true'));

	// 动态性：接线拿到的 text 必须是函数，且切工作区后重新求值会变
	let captured;
	const fakeCtx = {
		inject: (deps, cb) => {
			if (Array.isArray(deps) && deps.includes('systemPrompt')) { cb(fakeCtx); }
			return { dispose() { } };
		},
		effect: fn => { fn(); return () => { }; },
		systemPrompt: { context: def => { captured = def; return () => { }; } },
	};
	push(step('接线发起了注册', String(F.installWorkspaceRootsPrompt(fakeCtx, F)), 'true'));
	push(step('段名/顺序正确',
		String(captured?.name === F.WORKSPACE_ROOTS_SECTION_NAME && captured?.order === F.WORKSPACE_ROOTS_SECTION_ORDER), 'true'));
	push(step('text 是函数（每次装配动态求值）', String(typeof captured?.text === 'function'), 'true'));
	const beforeSwitch = captured?.text?.({}) ?? '';
	F.setWorkspaceContext({
		workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/c'], roots: [
			{ path: 'R:/a', name: 'frontend', isPrimary: true },
			{ path: 'R:/c', name: 'contracts' },
		],
	});
	const afterSwitch = captured?.text?.({}) ?? '';
	push(step('切工作区后 text() 跟着变（不烘焙旧根）',
		String(!beforeSwitch.includes('R:/c') && afterSwitch.includes('R:/c') && !afterSwitch.includes('R:/b')), 'true'));
	push(step('text() 能读会话 cwd',
		String(captured?.text?.({ agent: { session: { header: { cwd: 'R:/c' } } } })?.includes('This session\'s cwd is R:/c')), 'true'));
	push(step('老 Host（没有 inject）⇒ 不抛、不注册', String(F.installWorkspaceRootsPrompt({}, F)), 'false'));

	// 根限定路径解析（本刀只提供函数，不改工具行为）
	push(step('非根限定语法 ⇒ 交回调用方', String(F.parseRootQualifiedPath('src/App.tsx', roots)), 'undefined'));
	push(step('根限定语法 ⇒ 解析到绝对路径',
		String(F.parseRootQualifiedPath('@backend:src/App.tsx', roots)?.absolutePath
			?? F.parseRootQualifiedPath('@backend:src/App.tsx', roots)?.error),
		path.resolve('R:/b', 'src/App.tsx')));
	push(step('大小写回退命中', String(typeof F.parseRootQualifiedPath('@BACKEND:x', roots)?.absolutePath === 'string'), 'true'));
	push(step('未知根名 ⇒ 报错', String(typeof F.parseRootQualifiedPath('@nope:x', roots)?.error === 'string'), 'true'));
	push(step('同名根 ⇒ 判为歧义', String(typeof F.parseRootQualifiedPath('@same:x', [
		{ path: 'R:/a', name: 'same' }, { path: 'R:/b', name: 'same' },
	])?.error === 'string'), 'true'));
	push(step('绝对路径 ⇒ 拒收', String(typeof F.parseRootQualifiedPath('@backend:R:/x', roots)?.error === 'string'), 'true'));
	push(step('.. 逃逸 ⇒ 拒收', String(typeof F.parseRootQualifiedPath('@backend:../x', roots)?.error === 'string'), 'true'));

	// 长度上限（畸形工作区不许撑爆 system prompt）
	const longRoots = Array.from({ length: 64 }, (_, i) => ({ path: 'R:/r' + i, name: 'x'.repeat(400) }));
	const longText = F.renderWorkspaceRootsText({ workspaceRoot: 'R:/r0', relatedRoots: longRoots.map(r => r.path), roots: longRoots });
	push(step('超长文本截断到上限', String(longText.length), String(F.MAX_WORKSPACE_PROMPT_TEXT)));

	F.clearWorkspaceContext();
	results.push({ plugin: 'vssaros-foundation', fn: 'renderWorkspaceRootsText', notes, contract: 'workspacePrompt' });
	if (notes.length) { violations++; }
}

// ─── A5. P0-3 多根写围栏（2026-11-10）─────────────────────────────────────
//  本机沙箱已降 danger-full-access ⇒ 真机看不出差别 ⇒ 用**官方形状的最小夹具**做 in-process 断言：
//  原方法只按 policy.workspaceRoot 判 containment（真实实现另有 realpath/8.3 身份回退，
//  我们刻意不重实现 ⇒ 每个根都仍交给官方 checkedTarget 判 ✓）。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const F = foundationSvc;
	F.clearWorkspaceContext();

	const DENIED = { code: 'FS_SANDBOX_DENIED' };
	let calls = 0;
	const fakeOriginal = async function (target, policy) {
		calls++;
		const p = policy ?? this.ctx.sandboxPolicy.resolve();
		if (p.mode === 'danger-full-access') { return { target, checkedWith: 'unfenced' }; }
		if (p.mode !== 'workspace-write') { throw DENIED; }
		const root = String(p.workspaceRoot).toLowerCase().replace(/\\/g, '/');
		const file = String(target.displayPath).toLowerCase().replace(/\\/g, '/');
		if (!(file === root || file.startsWith(root + '/'))) { throw DENIED; }
		return { target, checkedWith: p.workspaceRoot };
	};
	const fakeFs = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'R:/a' }) } } };
	const wrapped = F.withMultiRootCheckedTarget(fakeOriginal, () => F.workspaceRoots());
	const attempt = async (displayPath, policy) => {
		calls = 0;
		try {
			const out = await wrapped.call(fakeFs, { displayPath }, policy);
			return { ok: true, checkedWith: out.checkedWith, calls };
		} catch (e) {
			return { ok: false, sameError: e === DENIED, calls };
		}
	};

	// ① 单根 / 无上下文 ⇒ 与官方单根行为逐字一致（不放宽、不多调一次）
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [] });
	let r = await attempt('R:/a/x.txt');
	push(step('单根命中 ⇒ 一次调用即放行', String(r.ok && r.calls === 1 && r.checkedWith === 'R:/a'), 'true'));
	r = await attempt('R:/b/x.txt');
	push(step('单根 + 根外路径 ⇒ 拒且不额外试根', String(!r.ok && r.calls === 1 && r.sameError), 'true'));

	// ② 多根 ⇒ 逐个把改写过的 policy 交给官方 containment
	F.setWorkspaceContext({
		workspaceRoot: 'R:/a', relatedRoots: ['R:/a', 'R:/b', 'R:/c'], roots: [
			{ path: 'R:/a', name: 'a', isPrimary: true },
			{ path: 'R:/b', name: 'b' },
			{ path: 'R:/c', name: 'c' },
		],
	});
	r = await attempt('R:/b/src/App.tsx');
	push(step('第二根命中 ⇒ 放行且记下该根', String(r.ok && r.checkedWith === 'R:/b' && r.calls === 2), 'true'));
	r = await attempt('R:/c/pkg/x.ts');
	push(step('第三根命中 ⇒ 放行且记下该根', String(r.ok && r.checkedWith === 'R:/c' && r.calls === 3), 'true'));
	r = await attempt('R:/outside/x.txt');
	push(step('根外路径 ⇒ 全拒且重抛官方错对象', String(!r.ok && r.sameError && r.calls === 3), 'true'));

	// ③ 模式闸门：read-only 绝不放宽；danger-full-access 原方法本就直接放行
	r = await attempt('R:/b/x.txt', { mode: 'read-only', workspaceRoot: 'R:/a' });
	push(step('read-only ⇒ 绝不放宽', String(!r.ok && r.calls === 1 && r.sameError), 'true'));
	r = await attempt('R:/b/x.txt', { mode: 'danger-full-access', workspaceRoot: 'R:/a' });
	push(step('danger-full-access ⇒ 不额外试根', String(r.ok && r.calls === 1), 'true'));

	// ④ 动态根集：切工作区后立刻生效，不是快照
	F.setWorkspaceContext({ workspaceRoot: 'R:/a', relatedRoots: [] });
	r = await attempt('R:/b/x.txt');
	push(step('切到单根 ⇒ 立刻不再放宽', String(!r.ok && r.calls === 1), 'true'));

	// ⑤ 接线：替换 fs.checkedTarget、卸载恢复原型、服务不可写时 fail-closed
	const proto = { checkedTarget: fakeOriginal };
	const fsInstance = Object.create(proto);
	let disposer = () => { };
	const fakeCtx = {
		inject: (deps, cb) => {
			if (Array.isArray(deps) && deps.includes('fs')) { cb(fakeCtx); }
			return { dispose() { } };
		},
		effect: fn => { disposer = fn(); return disposer; },
		fs: fsInstance,
	};
	push(step('接线发起了注入', String(F.installMultiRootFs(fakeCtx, F)), 'true'));
	push(step('fs.checkedTarget 被替换', String(typeof fsInstance.checkedTarget === 'function' && fsInstance.checkedTarget !== fakeOriginal), 'true'));
	disposer();
	push(step('卸载后恢复原型方法', String(!Object.prototype.hasOwnProperty.call(fsInstance, 'checkedTarget')), 'true'));
	push(step('老 Host（没有 inject）⇒ false 且不抛', String(F.installMultiRootFs({}, F)), 'false'));
	const frozenFs = Object.freeze({ checkedTarget: fakeOriginal });
	const frozenCtx = {
		...fakeCtx, fs: frozenFs,
		effect: fn => { const d = fn(); return d; },
	};
	F.installMultiRootFs(frozenCtx, F);
	push(step('服务属性不可写 ⇒ 回落官方单根', String(frozenFs.checkedTarget === fakeOriginal), 'true'));

	F.clearWorkspaceContext();
	results.push({ plugin: 'vssaros-foundation', fn: 'withMultiRootCheckedTarget', notes, contract: 'fsMultiRoot' });
	if (notes.length) { violations++; }
}

// ─── A6. P1-4 Workspace Grant canonical 复核（2026-11-10）─────────────────
//  用**注入的假 realpath** 模拟别名，不碰真实文件系统；真正的改法是"词法快判 + canonical 复核"。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const G = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-agents', 'lib', 'grants.js')).href);
	const aliases = new Map([
		['R:/a', 'R:/real/a'],
		['R:/a/link', 'R:/outside'], // 词法在授权目录里，realpath 却在外面 ⇒ symlink 逃逸
		['R:/b', 'R:/real/b'],
	]);
	// 忠实模拟 realpath：别名前缀要**透传到子路径**（真实 realpath('/a/x') 会跟着 /a 的
	// symlink 一起解析），且**最长前缀优先**（/a/link 有自己的别名，不能被 /a 吃掉 ✗）。
	const aliasEntries = [...aliases.entries()].sort((a, b) => b[0].length - a[0].length);
	const fakeReal = p => {
		const key = String(p).replace(/\\/g, '/');
		for (const [from, to] of aliasEntries) {
			if (key === from || key.startsWith(from + '/')) { return to + key.slice(from.length); }
		}
		return key;
	};
	const failReal = () => { throw new Error('ENOENT'); };
	const agent = { name: 'bot', workspaces: { read: ['R:/a'] } };

	push(step('词法快判：子目录命中 / 兄弟目录不命中',
		String(G.cwdCoveredBy(['r:/a'], 'R:/a/x') && !G.cwdCoveredBy(['r:/a'], 'R:/a-backup/x')), 'true'));
	push(step('按组件比较：同名前缀的兄弟目录不算子路径',
		String(G.pathContains('R:/real/a', 'R:/real/a/x') && !G.pathContains('R:/real/a', 'R:/real/ab')), 'true'));
	push(step('canonical 命中（正常目录）', String(G.canonicalCoveredBy(['R:/a'], 'R:/a/x', fakeReal)), 'true'));
	push(step('★ symlink 逃逸 ⇒ 拒', String(!G.canonicalCoveredBy(['R:/a'], 'R:/a/link', fakeReal)), 'true'));
	push(step('★ .. 消解后越界 ⇒ 拒', String(!G.canonicalCoveredBy(['R:/a'], 'R:/a/../b', fakeReal)), 'true'));
	push(step('realpath 失败 ⇒ fail-closed', String(!G.canonicalCoveredBy(['R:/a'], 'R:/a/x', failReal)), 'true'));
	push(step('rawScopeOf 保留原始大小写（Linux 大小写敏感）',
		String(G.rawScopeOf({ workspaces: { read: ['R:/A'] } })[0] === 'R:/A'
			&& G.readScopeOf({ workspaces: { read: ['R:/A'] } })[0] === 'r:/a'), 'true'));
	push(step('checkCwdGrant：正常 ⇒ 放行', String(G.checkCwdGrant(agent, 'R:/a/x', fakeReal)), 'undefined'));
	push(step('checkCwdGrant：缺省 cwd ⇒ 放行且不查 fs', String(G.checkCwdGrant(agent, undefined, failReal)), 'undefined'));
	// ⚠ 用 `?? ''` 兜住"本该拒绝却放行"（返回 undefined）的情形 ⇒ 精确报失败项，
	//   而不是让守卫自己抛 TypeError 崩掉（反向突变要靠**精确红**证明判别力 ✓）。
	push(step('checkCwdGrant：无声明 ⇒ 旧文案',
		String((G.checkCwdGrant({ name: 'bot' }, 'R:/a/x', fakeReal) ?? '').includes('没声明 workspaces')), 'true'));
	push(step('checkCwdGrant：词法不命中 ⇒ 旧文案',
		String((G.checkCwdGrant(agent, 'R:/z/x', fakeReal) ?? '').includes('不覆盖')), 'true'));
	push(step('★ checkCwdGrant：词法命中但 canonical 失败 ⇒ 新拒绝文案',
		String((G.checkCwdGrant(agent, 'R:/a/link', fakeReal) ?? '').includes('canonical 校验不通过')), 'true'));

	results.push({ plugin: 'vssaros-agents', fn: 'checkCwdGrant', notes, contract: 'grantCanonical' });
	if (notes.length) { violations++; }
}

// ─── A7. P1-5 ACP 多根出口（2026-11-10）───────────────────────────────────
//  能力协商 gate + 参数构造（老 agent 逐字不变）+ 两根接线（行为断言在 acp-roots.test.mjs）。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const A = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'acp.js')).href);
	push(step('能力：v1 sessionCapabilities 形状',
		String(A.acpAdditionalDirectoriesCapable({ agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } } })), 'true'));
	push(step('能力：v2 capabilities.session 形状',
		String(A.acpAdditionalDirectoriesCapable({ capabilities: { session: { additionalDirectories: {} } } })), 'true'));
	push(step('能力：未声明 ⇒ false', String(A.acpAdditionalDirectoriesCapable({ agentCapabilities: {} })), 'false'));
	const plain = A.acpSessionParams({ cwd: 'G:/a', roots: ['G:/b'], capable: false });
	push(step('★ 未声明能力 ⇒ 不传字段（老 agent 逐字不变）', String(!('additionalDirectories' in plain)), 'true'));
	const multi = A.acpSessionParams({
		cwd: 'G:/a', capable: true,
		roots: ['G:/a', 'G:/b', 'G:/b', '../c', { path: 'G:/d' }],
	});
	push(step('声明能力 ⇒ 排除主根 / 去重 / 拒相对路径',
		JSON.stringify(multi.additionalDirectories), JSON.stringify(['G:/b', 'G:/d'])));
	const cap = A.acpSessionParams({
		cwd: 'G:/a', capable: true,
		roots: Array.from({ length: A.MAX_ACP_ADDITIONAL_DIRECTORIES + 20 }, (_, i) => `G:/r${i}`),
	});
	push(step('附加根条数有上限', String(cap.additionalDirectories.length), String(A.MAX_ACP_ADDITIONAL_DIRECTORIES)));

	const idxSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'index.js'), 'utf8');
	push(step('入口把 cwd/根集接到 foundation 运行期真源',
		String(idxSrc.includes('workspaceRoots?.()') && idxSrc.includes('cwdFor,') && idxSrc.includes('rootsFor,')), 'true'));
	const acpSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'acp.js'), 'utf8');
	push(step('resume 与 new 共用同一份 params（显式重传根集）',
		String(acpSrc.includes('{ ...params, sessionId: resumeId }') && acpSrc.includes('resumeMethod')), 'true'));
	const adapterSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'adapter.js'), 'utf8');
	push(step('外层适配器透传 rootsFor', String(adapterSrc.includes('rootsFor: deps.rootsFor')), 'true'));

	results.push({ plugin: 'vssaros-local-agents', fn: 'acpSessionParams', notes, contract: 'acpRoots' });
	if (notes.length) { violations++; }
}

// ─── A8. P1-6 会话根集快照（2026-11-10）───────────────────────────────────
//  ★ 快照**只作诊断、不授权**：切根集时只报出"创建于旧根集"的会话，不热改它们的权限。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const R = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-bridge', 'lib', 'sessionRoots.js')).href);
	const A = ['G:/ws/app', 'G:/ws/lib'];
	push(step('签名：字符串数组与 {path} 数组等价',
		String(R.signatureOf(A) === R.signatureOf(A.map(p => ({ path: p })))), 'true'));
	push(step('签名：大小写/分隔符/尾斜杠归一',
		String(R.signatureOf(['G:\\WS\\APP\\']) === R.signatureOf(['g:/ws/app'])), 'true'));
	push(step('签名：顺序不同 ⇒ 不同',
		String(R.signatureOf(['G:/a', 'G:/b']) !== R.signatureOf(['G:/b', 'G:/a'])), 'true'));
	push(step('sameRootSet 相等', String(R.sameRootSet(A, ['G:/WS/APP/', 'G:/ws/lib'])), 'true'));
	push(step('变更摘要：added/removed', JSON.stringify(R.describeRootChange(['G:/a'], ['G:/a', 'G:/b'])),
		JSON.stringify({ added: ['g:/b'], removed: [] })));

	const B = R.createSessionRootBindings();
	B.note(A);
	push(step('note/previous 记录最近根集', JSON.stringify(B.previous()),
		JSON.stringify(['g:/ws/app', 'g:/ws/lib'])));
	B.bind('s1', A);
	B.bind('s2', A);
	push(step('绑定两条会话', String(B.size()), '2'));
	push(step('相同根集 ⇒ 无不一致', JSON.stringify(B.mismatches(A)), '[]'));
	B.bind('s2', ['G:/other']); // 让 s2 变成"创建于另一个根集"的会话
	push(step('切根集 ⇒ 报出创建于旧根集的会话',
		JSON.stringify(B.mismatches(['G:/new'])), JSON.stringify(['s1', 's2'])));
	B.bind('s1', ['G:/new']);
	push(step('幂等接管 ⇒ 以新快照为准',
		JSON.stringify(B.mismatches(['G:/new'])), JSON.stringify(['s2'])));
	B.clear('s2');
	push(step('clear 生效', String(B.size()) + '/' + JSON.stringify(B.mismatches(['G:/new'])), '1/[]'));
	B.bind('', A);
	push(step('畸形 sessionId 不写入', String(B.size()), '1'));

	const idxSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-bridge', 'lib', 'index.js'), 'utf8');
	push(step('接线：start 绑定 / context 比对并记最近根集',
		String(idxSrc.includes('sessionRoots.bind(id,') && idxSrc.includes('sessionRoots.mismatches(roots)')
			&& idxSrc.includes('sessionRoots.note(roots)')), 'true'));
	push(step('接线：变更只 console.warn，不改会话 cwd',
		String(idxSrc.includes('Existing sessions keep their cwd')), 'true'));

	results.push({ plugin: 'vssaros-bridge', fn: 'createSessionRootBindings', notes, contract: 'sessionRoots' });
	if (notes.length) { violations++; }
}

// ─── A9. P1-7 群聊现开会话的 Workspace Grant（2026-11-10）────────────────
//  补的是最后一个绕过 `checkCwdGrant` 的 `sc.create` 点；判据抽成纯函数 ⇒ 这里全是行为断言。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const G = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-agents', 'lib', 'grants.js')).href);
	const FALL = 'G:/fallback';
	const real = p => String(p).replace(/\\/g, '/');
	const strict = { name: 'bot', workspaces: { read: ['G:/allowed'] } };
	const loose = { name: 'bot' };
	const args = (agent, place, realpath = real) => ({ agent, place, fallbackCwd: FALL, realpath });

	push(step('用户显式 cwd ⇒ 命中', String(G.explicitCwdOf({ cwd: 'G:/proj' }, FALL)), 'G:/proj'));
	push(step('系统兜底 cwd ⇒ 不算显式', String(G.explicitCwdOf({ cwd: FALL }, FALL)), 'undefined'));
	push(step('workspaceId ⇒ 不算显式', String(G.explicitCwdOf({ workspaceId: 'ws' }, FALL)), 'undefined'));
	push(step('空/畸形 place ⇒ 不算显式',
		String(G.explicitCwdOf({ cwd: '  ' }, FALL) ?? G.explicitCwdOf(undefined, FALL)), 'undefined'));
	push(step('★ 声明 workspaces + cwd 越界 ⇒ 拒',
		String((G.roomSessionGrantRefusal(args(strict, { cwd: 'G:/elsewhere' })) ?? '').includes('不覆盖')), 'true'));
	push(step('声明 workspaces + cwd 命中 ⇒ 放行',
		String(G.roomSessionGrantRefusal(args(strict, { cwd: 'G:/allowed/x' }))), 'undefined'));
	push(step('默认 bot（未声明）⇒ 行为不变（不回退群聊）',
		String(G.roomSessionGrantRefusal(args(loose, { cwd: 'G:/elsewhere' }))), 'undefined'));
	push(step('系统兜底 cwd ⇒ 放行（建群不被拒）',
		String(G.roomSessionGrantRefusal(args(strict, { cwd: FALL }))), 'undefined'));
	push(step('主会话（无 agent 定义）⇒ 放行',
		String(G.roomSessionGrantRefusal(args(undefined, { cwd: 'G:/elsewhere' }))), 'undefined'));
	const aliasReal = p => {
		const k = String(p).replace(/\\/g, '/');
		return k === 'G:/allowed/link' ? 'G:/outside' : k;
	};
	push(step('★ 群聊同样过 canonical 复核（symlink 逃逸）',
		String((G.roomSessionGrantRefusal({ agent: strict, place: { cwd: 'G:/allowed/link' }, fallbackCwd: FALL, realpath: aliasReal }) ?? '').includes('canonical')), 'true'));

	const roomsSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-agents', 'lib', 'rooms.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-agents', 'lib', 'index.js'), 'utf8');
	push(step('接线：唯一 create 点调用闸 + 按 preset 找 agent',
		String(roomsSrc.includes('roomSessionGrantRefusal({') && roomsSrc.includes('explicitCwdOf(place, deps.fallbackCwd)')
			&& roomsSrc.includes('agentOfPreset')), 'true'));
	push(step('接线：index 注入 agentOfPreset', String(idxSrc.includes('agentOfPreset: async')), 'true'));
	push(step('接线：拒绝对话返回 403', String(roomsSrc.includes('throw new RoomError(refusal, 403)')), 'true'));

	results.push({ plugin: 'vssaros-agents', fn: 'roomSessionGrantRefusal', notes, contract: 'roomGrant' });
	if (notes.length) { violations++; }
}

// ─── A10. P1-8 ACP v2 握手 / resume（2026-11-10）─────────────────────────
//  依据 ACP v2 正式规范：initialize 用 capabilities/info、版本协商 -32022、
//  capabilities.session 即含 session/resume、MCP HTTP 为 session.mcp.http。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const A = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'acp.js')).href);
	const v2 = {
		protocolVersion: 2,
		capabilities: { session: { mcp: { http: {} }, additionalDirectories: {} } },
		info: { name: 'a', version: '1' },
	};
	const v1 = {
		protocolVersion: 1,
		agentCapabilities: {
			loadSession: true, mcpCapabilities: { http: true },
			sessionCapabilities: { additionalDirectories: {} },
		},
	};
	const p2 = A.acpInitializeParams(2);
	push(step('★ v2 initialize ⇒ 请求最新版本 2 且双写 v1/v2 字段',
		String(p2.protocolVersion === 2 && 'capabilities' in p2 && 'info' in p2
			&& 'clientCapabilities' in p2 && 'clientInfo' in p2), 'true'));
	push(step('v1 回退 ⇒ 参数与改造前逐字相同', JSON.stringify(A.acpInitializeParams(1)),
		JSON.stringify({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			clientInfo: { name: 'vssaros', version: '1' },
		})));
	push(step('版本协商：回 2 ⇒ 2 / 回 1 ⇒ 1 / 老回执无字段 ⇒ 1',
		String(A.acpProtocolVersionOf(v2) === 2 && A.acpProtocolVersionOf(v1) === 1
			&& A.acpProtocolVersionOf({}) === 1), 'true'));
	push(step('★ v2 声明 session ⇒ 用 session/resume', String(A.acpResumeMethodOf(v2)), 'session/resume'));
	push(step('v2 没声明 session ⇒ 不 resume',
		String(A.acpResumeMethodOf({ protocolVersion: 2, capabilities: {} })), 'null'));
	push(step('v1 loadSession ⇒ 用 session/load', String(A.acpResumeMethodOf(v1)), 'session/load'));
	push(step('v2 MCP HTTP（session.mcp.http）',
		String(A.acpMcpHttpCapable(v2)), 'true'));
	push(step('v1 MCP HTTP（mcpCapabilities.http/sse）',
		String(A.acpMcpHttpCapable(v1)
			&& A.acpMcpHttpCapable({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { sse: true } } })), 'true'));
	push(step('v2 不再认 sse ⇒ false',
		String(A.acpMcpHttpCapable({ protocolVersion: 2, capabilities: { session: { mcp: { sse: {} } } } })), 'false'));
	const c2 = A.acpCapabilitiesOf(v2);
	push(step('能力集合：v2',
		JSON.stringify({ v: c2.protocolVersion, r: c2.resumeMethod, m: c2.mcpHttp, a: c2.additionalDirectories }),
		JSON.stringify({ v: 2, r: 'session/resume', m: true, a: true })));
	const c1 = A.acpCapabilitiesOf(v1);
	push(step('能力集合：v1',
		JSON.stringify({ v: c1.protocolVersion, r: c1.resumeMethod, m: c1.mcpHttp, a: c1.additionalDirectories, l: c1.loadSession }),
		JSON.stringify({ v: 1, r: 'session/load', m: true, a: true, l: true })));
	push(step('版本拒绝识别：-32022 / 其它错误不重试',
		String(A.acpIsVersionRejection({ code: -32022 })
			&& A.acpIsVersionRejection({ message: 'Unsupported protocol version' })
			&& !A.acpIsVersionRejection({ message: 'auth failed' })), 'true'));

	const src = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'acp.js'), 'utf8');
	push(step('接线：ensure 用 v2 参数、版本拒绝时回退 v1',
		String(src.includes('acpInitializeParams(ACP_PROTOCOL_VERSION)') && src.includes('acpInitializeParams(1)')
			&& src.includes('acpCapabilitiesOf(reply')), 'true'));
	push(step('接线：resume 方法按协商结果选，响应无 sessionId 时兜底',
		String(src.includes('peer.request(resumeMethod,') && src.includes('reply?.sessionId ?? resumeId')), 'true'));

	results.push({ plugin: 'vssaros-local-agents', fn: 'acpCapabilitiesOf', notes, contract: 'acpV2' });
	if (notes.length) { violations++; }
}

// ─── A11. P1-9 ACP resume 实际触发（2026-11-10）──────────────────────────
//  持久映射 + ensureLive 带 resumeId；★ 映射只存 id，不作授权、不隐式复活根集。
{
	const notes = [];
	const push = r => { if (!r.ok) { notes.push(r.note); } };
	const S = await import(pathToFileURL(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'sessionMap.js')).href);
	push(step('解析：畸形 JSON / 数组 ⇒ 空映射',
		JSON.stringify(S.parseAcpSessionMap('bad')) + JSON.stringify(S.parseAcpSessionMap('[]')), '{}{}'));
	push(step('解析：只留合法 id 对',
		JSON.stringify(S.parseAcpSessionMap(JSON.stringify({ a: 'x', bad: 7 }))), JSON.stringify({ a: 'x' })));
	push(step('序列化：键序稳定',
		String(S.serializeAcpSessionMap({ b: '2', a: '1' }) === JSON.stringify({ a: '1', b: '2' }, null, 2) + '\n'), 'true'));
	const many = Object.fromEntries(Array.from({ length: S.MAX_ACP_SESSION_MAP_ENTRIES + 20 }, (_, i) => [`s${i}`, `c${i}`]));
	push(step('条数上限',
		String(Object.keys(S.parseAcpSessionMap(JSON.stringify(many))).length), String(S.MAX_ACP_SESSION_MAP_ENTRIES)));
	let text = JSON.stringify({ s1: 'cli-old' });
	const map = S.createAcpSessionMap({ readText: async () => text, writeText: async t => { text = t; } });
	push(step('映射读旧 id', String(await map.get('s1')), 'cli-old'));
	await map.set('s1', 'cli-new');
	push(step('映射写回最终 id', String(JSON.parse(text).s1), 'cli-new'));
	push(step('畸形 id 不写入', String(await map.set('', 'x')), 'false'));
	await map.delete('s1');
	push(step('删除生效', String(await map.size()), '0'));

	const adapterSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'acpAdapter.js'), 'utf8');
	push(step('接线：查映射 / 传 resumeId / 写回最终 id',
		String(adapterSrc.includes('sessionMap.get(sessionId)')
			&& adapterSrc.includes('...(resumeId ? { resumeId } : {})')
			&& adapterSrc.includes('sessionMap.set(sessionId, cliSessionId)')), 'true'));
	push(step('接线：anonymous 不恢复',
		String(adapterSrc.includes("sessionId !== 'anonymous'")), 'true'));
	const outerSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'core', 'adapter.js'), 'utf8');
	const idxSrc = fs.readFileSync(path.join(PLUGINS_DIR, 'vssaros-local-agents', 'lib', 'index.js'), 'utf8');
	push(step('接线：外层透传 / 入口原子写映射',
		String(outerSrc.includes('sessionMap: deps.sessionMap') && idxSrc.includes('createAcpSessionMap({')
			&& idxSrc.includes('rename(tmp, mapPath)') && idxSrc.includes('sessionMap,')), 'true'));

	results.push({ plugin: 'vssaros-local-agents', fn: 'createAcpSessionMap', notes, contract: 'acpResume' });
	if (notes.length) { violations++; }
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

// B1/B2（重构 1.3，2026-10-16 改写）：pageShell.js / lock.js / dataRootOf / dshHomeOf 已收编进
// @vssaros/dsh-foundation。消费插件的同名文件/函数是**委托层**（经 lib/foundationRef.js 拿服务）。
// 守卫口径随之反转：
//   · 委托文件必须**逐字节同形**（含 foundationRef.js 本身——它是唯一允许复制的薄绑定层）；
//   · 真源实现只允许出现在 vssaros-foundation 里 ⇒ 委托文件里出现真实现特征（如 `process.env.VSSAROS_DATA_ROOT`
//     的真解析体、SHELL_CSS 的 CSS 文本）即红；
//   · foundationRef.js 的副本数写死 = 消费插件数，少一份说明有插件忘了接（多一份说明有新插件要登记）。

// B1a 委托层同形：pageShell.js（7 份委托 + foundation 的真源不算）
checkSame('页面壳 pageShell.js 委托层（7 份同形）', allJs
	.filter(f => /lib[\\/]pageShell\.js$/.test(f) && !/vssaros-foundation/.test(f))
	.map(f => ({ file: rel(f), hash: shortHash(fs.readFileSync(f, 'utf8')) })));

// B1b lock.js 委托层同形（4 份委托 + foundation 的真源不算）
checkSame('写锁 lock.js 委托层（4 份同形）', allJs
	.filter(f => /lib[\\/]lock\.js$/.test(f) && !/vssaros-foundation/.test(f))
	.map(f => ({ file: rel(f), hash: shortHash(fs.readFileSync(f, 'utf8')) })));

// B1c foundationRef.js 绑定层同形（份数写死：新增消费插件必须显式改这里 ⇒ 逼一次复核 ✓）
{
	const EXPECTED_FOUNDATIONREF_COPIES = 14; // kanban/codebase/dashboard/kb/media/sessions/skills/web-content-import/workflow + scheduler（2.1）+ pocket（2.4）+ market（工作台商城 2026-10-21）+ marketplace（自营商城，2026-10-22：要数据根读写台账）+ loop（无人值守循环，2026-10-30：dataRoot 读 loops/ 与 ledger）｜★ 2026-10-30 xhs-note、2026-11-03 vssaros-memory 已移除 ⇒ 各少一份
	const entries = allJs
		.filter(f => /lib[\\/]foundationRef\.js$/.test(f) && !/vssaros-foundation/.test(f))
		.map(f => ({ file: rel(f), hash: shortHash(fs.readFileSync(f, 'utf8')) }));
	checkSame(`foundationRef.js 绑定层（${entries.length} 份同形）`, entries);
	if (entries.length !== EXPECTED_FOUNDATIONREF_COPIES) {
		violations++;
		console.log(`  ✗  foundationRef.js 份数是 ${entries.length}，应为 ${EXPECTED_FOUNDATIONREF_COPIES}（新消费插件接入时同步这里）`);
	}
}

// ── B1. 记忆页「会话」页签的**读分区集合**（2026-10-21，用户拍板"两种分区口径都要显示"）─────
// 病根：页面只查工作区分区（`wa-*`/`ws-*`），而 dsh 侧的观测/会话实际落在**纯 agent 分区**
//   ⇒ 真库实测两个 profile 的工作区 scope 都是 0 条、而 `mem:obs:*` 几千条 ⇒ 页面永远"暂无会话记录"。
// 修法：读分区 = 工作区 + **所有有数据的 agent 分区** ⇒ 合并展示、每条带 `partition`、
//   观察按**会话自己的分区**查、摘要按 **分区+sessionId** 配对（否则同名会话串）。
// ⚠ 行为级断言（真渲染一次会话页）+ 源码结构断言（防回退）：探针 p3-89 在 gitignore 里
//   ⇒ 只有它的话**发布出去的包没有这道守卫** ✗ ⇒ 必须有一道入库的。
// 2026-11-03：vssaros-memory 现在是内置记忆插件（会话页记忆 Tab），已无 lib/detail.js。
// 这段只服务旧网关版记忆插件的「会话分区」守卫，改为按 detail.js 判定：只有旧目录仍在才执行，
// 否则新插件会被误判（readFileSync detail.js 抛错 ⇒ 整个 host-config 守卫崩）。
if (fs.existsSync(path.join(PLUGINS_DIR, 'vssaros-memory', 'lib', 'detail.js'))) {
	const memIndexFile = path.join(PLUGINS_DIR, 'vssaros-memory', 'lib', 'index.js');
	const memDetailFile = path.join(PLUGINS_DIR, 'vssaros-memory', 'lib', 'detail.js');
	const memIndexSrc = fs.readFileSync(memIndexFile, 'utf8').replace(/\r\n/g, '\n');
	const memDetailSrc = fs.readFileSync(memDetailFile, 'utf8').replace(/\r\n/g, '\n');
	const sessNotes = [];
	const bad = (msg) => sessNotes.push(msg);
	// ① 取数侧：必须枚举 agent 分区 + 带上分区上限 + 每条带 partition
	// ⚠ 断言要**精确到调用点**（不能只搜方法名 ⇒ 否则注释里出现那个名字就"通过"了 ✗
	//   —— 这正是 M1 突变（把调用换成 Promise.resolve([])）一度没变红的原因 ✓）
	const hasAgentPartitions = /providerCall\(\s*base,\s*'listAllAgentsWithData'/.test(memIndexSrc);
	if (!hasAgentPartitions) { bad('vssaros-memory/lib/index.js：会话取数没有枚举"有数据的 agent 分区"（listAllAgentsWithData 的 providerCall 调用）⇒ 只查工作区分区 ⇒ agent 分区的会话永远看不见 ✗'); }
	if (!/allPartitions\.slice\(0,\s*SESSION_PARTITION_LIMIT\)/.test(memIndexSrc)) { bad('vssaros-memory/lib/index.js：会话取数没有按上限截断分区（agent 多了会把页面打爆 ⇒ 整页卡死 ✗）'); }
	if (!/partition:\s*x\.p/.test(memIndexSrc)) { bad('vssaros-memory/lib/index.js：会话/摘要行没有带上来源分区（partition: x.p）⇒ 前端无法区分同名会话 ✗'); }
	// ② 观察必须按**会话自己的分区**查（用主分区查必然是空）
	if (!/observeList',\s*\[p,\s*sid\]/.test(memIndexSrc)) { bad('vssaros-memory/lib/index.js：观察不是按"会话自己的分区"查（observeList 的首参必须是该会话的分区）⇒ 点开永远是空 ✗'); }
	// ③ 渲染侧：来源分区 chip + 分区+sessionId 配对 + 选中带分区
	if (!/md-meta-chip session">🗂/.test(memDetailSrc)) { bad('vssaros-memory/lib/detail.js：会话卡没有标注来源分区 ⇒ 用户看不出这条来自工作区还是 agent ✗'); }
	if (!/sessionKeyOf/.test(memDetailSrc)) { bad('vssaros-memory/lib/detail.js：摘要与会话没有按"分区+sessionId"配对 ⇒ 不同分区的同名会话会串 ✗'); }
	if (!/params\.get\('partition'\)/.test(memDetailSrc)) { bad('vssaros-memory/lib/detail.js：选中态没有带分区（?partition=）⇒ 同名会话会同时展开多条 ✗'); }
	// ④ 行为级：真渲染一次（两个分区各一个同名会话）⇒ chip 出现、选中不串
	try {
		const detailMod = await import(pathToFileURL(memDetailFile).href);
		const SESS = [
			{ id: 'x1', firstPrompt: '工作区会话', observationCount: 5, updatedAt: '2026-10-21T10:00:00.000Z', partition: 'wa-ws1-agent-a' },
			{ id: 'x1', firstPrompt: 'agent 会话', observationCount: 7, updatedAt: '2026-10-21T09:00:00.000Z', partition: 'saros-claw' },
		];
		const SUMS = [
			{ sessionId: 'x1', partition: 'wa-ws1-agent-a', title: '工作区摘要', observationCount: 5 },
			{ sessionId: 'x1', partition: 'saros-claw', title: 'agent 摘要', observationCount: 7 },
		];
		const mk = (params) => detailMod.renderDetailPage({
			params: new URLSearchParams(params), agentId: 'wa-ws1-agent-a',
			items: [], tierCounts: { working: 0, episodic: 0, semantic: 0, procedural: 0 },
			typeCounts: {}, extStats: {}, agents: [], slotNames: [],
			sessions: SESS, summaries: SUMS,
		}).body;
		const pageA = mk('view=sessions&session=x1&partition=wa-ws1-agent-a');
		const pageB = mk('view=sessions&session=x1&partition=saros-claw');
		if (!pageA.includes('wa-ws1-agent-a') || !pageA.includes('saros-claw')) {
			problems.push('会话页没渲染来源分区 chip ⇒ 用户看不出每条会话来自哪个分区 ✗');
		}
		if (!pageA.includes('工作区摘要') || pageA.includes('agent 摘要')) {
			bad('会话页按分区选中时串了摘要（工作区那条应显示"工作区摘要"）✗');
		}
		if (!pageB.includes('agent 摘要') || pageB.includes('工作区摘要')) {
			bad('会话页按分区选中时串了摘要（agent 那条应显示"agent 摘要"）✗');
		}
	} catch (e) {
		bad(`会话页渲染断言跑不起来：${String(e?.message ?? e)}`);
	}
	results.push({ plugin: 'vssaros-memory', fn: 'sessionsView', notes: sessNotes, contract: 'session-partitions' });
	if (sessNotes.length) { violations++; }
}

// B2 数据根/首页解析：委托形态必须是"一行转发"；真解析体只允许在 foundation 里。
{
	const delegateRe = /export function (dataRootOf|dshHomeOf)\(config\) \{\s*\/\/ 委托到 @vssaros\/dsh-foundation[\s\S]*?return foundation\(\)\.\1\(config\);/;
	const realMark = /process\.env\.(VSSAROS_DATA_ROOT|DSH_HOME)/;
	const entries = [];
	const violationsB2 = [];
	for (const f of allJs.filter(f => /lib[\\/][\w.-]+\.js$/.test(f))) {
		const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
		const isFoundation = /vssaros-foundation/.test(f);
		for (const name of ['dataRootOf', 'dshHomeOf']) {
			const i = src.indexOf(`export function ${name}(`);
			if (i < 0) { continue; }
			const j = src.indexOf('\n}', i);
			const body = src.slice(i, j).trim();
			if (isFoundation) {
				entries.push({ file: rel(f), hash: 'real' });
			} else if (delegateRe.test(body)) {
				entries.push({ file: rel(f), hash: 'delegate' });
			} else {
				entries.push({ file: rel(f), hash: shortHash(body) });
				violationsB2.push(`${rel(f)} 的 ${name} 既不是委托也不是 foundation 真源 ⇒ 是**第三份实现**（1.3 后不许再有）`);
			}
		}
	}
	// ⚠ vssaros-agents 暂豁免（2026-10-16：它正被并行会话重构，它的两份拷贝等那边落地后再收编）
	const agentsLegacy = ['vssaros-agents/lib/store.js', 'vssaros-agents/lib/live.js'];
	/**
	 * ★ 2026-10-27 登记「**有意不同**」的那一份（守卫自己的纪律要求：有意不同要写清理由并在此登记）。
	 *
	 * `vssaros-marketplace/lib/marketClient.js` 的 `dataRootOf` 不是纯委托，而是三档：
	 *   ① `config.dataRoot`（IDE 覆盖层写入，最可靠）→ ② `foundation().dataRootOf` →
	 *   ③ **本地兜底**（`VSSAROS_DATA_ROOT` → `~/.vssaros`，并打日志说明走了兜底）。
	 *
	 * 为什么必须留 ③（真机 2026-10-23）：`vssarosFoundation` 明明在 bundles 里却没绑上 ⇒
	 * `foundation()` 直接抛 ⇒ 装/升/卸/发布**全部失效**，页面表现是"点安装没反应"✗。
	 * marketplace 是独立安装包，不该因为一个**可选**服务缺失就整体报废；③ 的规则与
	 * `vssaros-foundation/lib/paths.js` 逐条一致 ⇒ 不会算出不同答案。
	 *
	 * ⇒ 结论：它是**有意的保命实现**，不是漏改的拷贝。登记在此之后，**新出现的**第三份实现仍会红。
	 */
	const deliberate = [
		{
			file: 'vssaros-marketplace/lib/marketClient.js',
			fn: 'dataRootOf',
			why: 'foundation 服务可能未绑上（真机 2026-10-23 点安装没反应）；本地兜底与真源同规则',
		},
	];
	const isDeliberate = (v) => deliberate.some(d => v.startsWith(d.file) && v.includes(`的 ${d.fn} `));
	const stray = violationsB2.filter(v => !agentsLegacy.some(a => v.startsWith(a)) && !isDeliberate(v));
	const inScope = entries.filter(e => !agentsLegacy.includes(e.file));
	const delegates = inScope.filter(e => e.hash === 'delegate');
	const reals = inScope.filter(e => e.hash === 'real');
	const ok = stray.length === 0 && delegates.length > 0
		&& reals.length === 2 && reals.every(e => e.file === 'vssaros-foundation/lib/paths.js');
	copyGroups.push({
		label: `dataRootOf/dshHomeOf 收编（${delegates.length} 份委托 + 1 处真源；agents 两份遗留拷贝等并行重构落地后收编）`,
		notes: ok ? [] : [`委托 ${delegates.length} 份、真源 ${reals.length} 处、第三份实现 ${stray.length} 处`,
			...(stray.length ? stray : []),
			...(reals.length !== 2 ? [`真源应只在 vssaros-foundation/lib/paths.js：${reals.map(e => e.file).join(',')}`] : [])],
		detail: `${inScope.length} 个定义点`,
	});
	if (!ok) { violations++; }
	const excused = violationsB2.length - stray.length;
	if (excused > 0) {
		/* 豁免要**看得见**（不能悄悄吞掉）：列出被登记的每一份与理由。 */
		for (const d of deliberate) {
			if (violationsB2.some(v => v.startsWith(d.file))) {
				console.log(`  ℹ  豁免：${d.file} 的 ${d.fn} —— ${d.why}`);
			}
		}
		if (agentsLegacy.some(a => violationsB2.some(v => v.startsWith(a)))) {
			console.log('  ℹ  豁免：vssaros-agents 遗留拷贝（豁免期，2026-10-16 起）');
		}
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
