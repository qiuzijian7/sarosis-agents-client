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
	{
		plugin: 'vssaros-codebase', module: 'lib/store.js', cases: [
			{ fn: 'workspaceRootOf', chain: 'workspace', key: 'workspaceRoot' },
			// 2026-10-17：工作区根的**运行期优先级**（切工作区后图谱要跟着换根，不重启 Host ✓）
			{ fn: 'workspaceRootOf', chain: 'workspaceContext', key: 'workspaceRoot', absent: null },
		],
	},
	// memory 的**分区键**（2026-10-17）：这是**写路径**（分区认错 = 记忆静默写进旧工作区的分区 ✗）⇒
	// 断言必须落在生产用的那个函数上。`partitionKeyOf` 就是 `agentIdOf` 的对外形态（导出只为可断言 ✓）。
	{ plugin: 'vssaros-memory', module: 'lib/index.js', cases: [{ fn: 'partitionKeyOf', chain: 'partition' }] },
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
	const EXPECTED_FOUNDATIONREF_COPIES = 13; // kanban/codebase/dashboard/kb/media/memory/sessions/skills/web-content-import/workflow + scheduler（2.1）+ pocket（2.4）+ market（工作台商城 2026-10-21）
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
{
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
	const stray = violationsB2.filter(v => !agentsLegacy.some(a => v.startsWith(a)));
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
	if (violationsB2.length !== stray.length) {
		console.log(`  ℹ  vssaros-agents 遗留拷贝 ${violationsB2.length - stray.length} 份（豁免期，2026-10-16 起）`);
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
