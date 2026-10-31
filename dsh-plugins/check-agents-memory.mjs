/**
 * agents 插件「记忆」两条链的守卫（2026-10-20）。
 *
 * 为什么要有它：
 *   1) **口径三处分叉**：`memory-chars` / `memory-mode` 原先在 `core/agents.js`（读 frontmatter）、
 *      `core/create.js`（校验草稿）、`lib/memory.js`（夹值）各解析一次 ⇒ 改一处忘一处时，
 *      "页面显示的上限"与"实际注入的上限"会静默不同（本次已合并到 `core/memoryLimits.js`）。
 *   2) **人设为空的 agent 记忆/工具双双失效**（真 bug）：角色判定原本要求 `persona` 非空，
 *      而 `toPresetDefinition` 无条件生成人设行 ⇒ 空正文的 agent 落到 `applyTopLevel`，
 *      记忆快照与 tools allowlist 都不生效，页签却照样显示"常驻注入 N 字符"。
 *      下面用源码断言把这个判据钉住（反向突变 = 把判据改回非空，这里必须变红）。
 *   3) **漏 files 会让插件加载即失败**：新增的 `lib/core/memoryLimits.js` 必须在 package.json 的
 *      `files` 里（真出过：漏 files ⇒ 装机后整站 404）。
 *
 * 跑法：`node dsh-plugins/check-agents-memory.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'vssaros-agents');

// Windows 上动态 import 绝对路径必须走 file:// URL（直接传 `g:\...` 会 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const load = spec => import(pathToFileURL(path.join(PLUGIN, spec)).href);

const {
	MEMORY_CHARS_DEFAULT, MEMORY_CHARS_MAX, MEMORY_CHARS_MIN,
	clampMemoryChars, normalizeMemoryMode, parseMemoryLimits, parseMemoryModeInput,
} = await load('lib/core/memoryLimits.js');
const {
	SNAPSHOT_BYTES, SNAPSHOT_CHARS, clampLogLimit, readMemorySnapshot,
} = await load('lib/memory.js');

const problems = [];
const notes = [];
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		problems.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
	} else {
		notes.push(`ok  ${label}`);
	}
};
const truthy = (label, value) => {
	if (!value) { problems.push(label); } else { notes.push(`ok  ${label}`); }
};

// ── 1. 常量与夹值（确定值，不写"条数"这类会漂的期望）────────────────────────
eq('MEMORY_CHARS_DEFAULT', MEMORY_CHARS_DEFAULT, 2048);
eq('MEMORY_CHARS_MIN', MEMORY_CHARS_MIN, 512);
eq('MEMORY_CHARS_MAX', MEMORY_CHARS_MAX, 20000);
eq('SNAPSHOT_CHARS === DEFAULT', SNAPSHOT_CHARS, MEMORY_CHARS_DEFAULT);
eq('SNAPSHOT_BYTES 兼容别名', SNAPSHOT_BYTES, SNAPSHOT_CHARS);

eq('clamp(undefined) → 默认', clampMemoryChars(undefined), 2048);
eq('clamp("") → 默认', clampMemoryChars(''), 2048);
eq('clamp("abc") → 默认（笔误不炸）', clampMemoryChars('abc'), 2048);
eq('clamp(0) → 0（关闭）', clampMemoryChars(0), 0);
eq('clamp(-5) → 0（关闭）', clampMemoryChars(-5), 0);
eq('clamp(100) → 夹到下限', clampMemoryChars(100), 512);
eq('clamp(99999) → 夹到上限', clampMemoryChars(99999), 20000);
eq('clamp("1024") → 1024', clampMemoryChars('1024'), 1024);
eq('clamp(1024.9) → 1024（截断）', clampMemoryChars(1024.9), 1024);

// ── 2. frontmatter 解析 / 输入归一（单一真源）────────────────────────────────
eq('parseMemoryLimits({}) 没写 chars', parseMemoryLimits({}), { chars: undefined, mode: 'session' });
eq('parseMemoryLimits 显式 0 + live', parseMemoryLimits({ 'memory-chars': '0', 'memory-mode': 'live' }), { chars: 0, mode: 'live' });
eq('parseMemoryLimits 空白 chars', parseMemoryLimits({ 'memory-chars': '   ' }), { chars: undefined, mode: 'session' });
eq('parseMemoryLimits 非法 chars', parseMemoryLimits({ 'memory-chars': 'abc' }), { chars: undefined, mode: 'session' });
eq('parseMemoryLimits 未知 mode → session', parseMemoryLimits({ 'memory-mode': 'zzz' }), { chars: undefined, mode: 'session' });
eq('normalizeMemoryMode(LIVE)', normalizeMemoryMode('LIVE'), 'live');
eq('parseMemoryModeInput("") → 不写', parseMemoryModeInput(''), '');
eq('parseMemoryModeInput(乱写) → 不写', parseMemoryModeInput('whatever'), '');
eq('parseMemoryModeInput(live)', parseMemoryModeInput('live'), 'live');

// ── 3. 历史条数 ───────────────────────────────────────────────────────────────
eq('clampLogLimit(undefined) → 20', clampLogLimit(undefined), 20);
eq('clampLogLimit(0) → 20', clampLogLimit(0), 20);
eq('clampLogLimit(5) → 5', clampLogLimit(5), 5);
eq('clampLogLimit(999) → 100', clampLogLimit(999), 100);

// ── 4. 快照内容（真读盘：临时 agentsRoot）────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mem-guard-'));
const memDir = path.join(tmpRoot, 'demo', 'memory');
fs.mkdirSync(memDir, { recursive: true });
const config = { agentsRoot: tmpRoot };

eq('没有 MEMORY.md → 空串（正常态）', await readMemorySnapshot(config, 'demo'), '');
eq('chars=0 → 关闭注入', await readMemorySnapshot(config, 'demo', 0), '');

fs.writeFileSync(path.join(memDir, 'MEMORY.md'), 'short index', 'utf8');
eq('短内容原样注入（无截断提示）', await readMemorySnapshot(config, 'demo', 512),
	'\n\n## 记忆索引（MEMORY.md 快照）\nshort index');

const long = 'x'.repeat(600);
fs.writeFileSync(path.join(memDir, 'MEMORY.md'), `  ${long}  `, 'utf8');
const cut = await readMemorySnapshot(config, 'demo', 512);
truthy('长内容被截到 512 字符', cut.includes(`\n${'x'.repeat(512)}\n…（截断：上限 512 字符`));
truthy('截断提示写明上限', cut.includes('上限 512 字符'));

try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 2 }); } catch { /* tmp 自清 */ }

// ── 5. 源码结构断言（防回退；反向突变：改回旧写法必须变红）──────────────────
const indexSrc = fs.readFileSync(path.join(PLUGIN, 'lib/index.js'), 'utf8');
const detailSrc = fs.readFileSync(path.join(PLUGIN, 'lib/detail.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));

truthy('角色判定认「有 persona 键」（空正文也走 applyPersona）',
	/if \(typeof config\?\.persona === 'string'\) \{\s*\n\s*applyPersona/.test(indexSrc));
truthy('角色判定**不再**要求 persona 非空',
	!/config\?\.persona === 'string' && config\.persona\.trim\(\)/.test(indexSrc));
truthy('gitLogOf 复用同一请求的 status',
	/gitLogOf\(config, agentId, git, url\.searchParams\.get\('limit'\)\)/.test(indexSrc));
truthy('记忆 API 回传运行时口径（runtime）',
	/runtime: \(\(\) => \{[\s\S]{0,200}__promptMem\.byAgent\.get\(agentId\)/.test(indexSrc));
truthy('关掉注入时不起 60s 定时器',
	/memoryChars > 0 \? setInterval\(/.test(indexSrc));
truthy('页面读 limits.runtime',
	/var R = L\.runtime \|\| null;/.test(detailSrc));
truthy('页面写清与 AgentMemory 检索库无关',
	/与 AgentMemory 检索库/.test(detailSrc));
truthy('新模块已进 package.json files',
	(pkg.files ?? []).includes('lib/core/memoryLimits.js'));

// ── 5c. 记忆演化链（2026-10-31，对齐 DeepSeekBot）────────────────────────
//   两件事：① 回合末自动提交（补上"演化链断掉"那一环）；② Git 分道图。
//   ⚠ 反向突变均已验证：删掉 autoCommitAfterTurn 调用 / 把 ROW_H 改成 44 /
//     在页面里自己算 lane / 去掉 init -b main ⇒ 对应断言必须变红。
const { layoutGitLanes, laneRowPaths, ROW_H } = await load('lib/core/gitLanes.js');
const memorySrc = fs.readFileSync(path.join(PLUGIN, 'lib/memory.js'), 'utf8');
const evoSrc = fs.readFileSync(path.join(PLUGIN, 'lib/memoryEvoPage.js'), 'utf8');
const runSrc = fs.readFileSync(path.join(PLUGIN, 'test/run-agents-check.mjs'), 'utf8');

truthy('gitLanes：导出布局与 path 两个入口',
	typeof layoutGitLanes === 'function' && typeof laneRowPaths === 'function');
eq('线性历史全在第 0 轨（不画无意义的岔路）',
	layoutGitLanes([
		{ full: 'c', hash: 'c', parents: ['b'] },
		{ full: 'b', hash: 'b', parents: ['a'] },
		{ full: 'a', hash: 'a', parents: [] },
	]).map(r => r.lane), [0, 0, 0]);
eq('★★ 父提交不在显示列表 ⇒ 不开轨道（否则图右侧凭空多一列）',
	layoutGitLanes([{ full: 'b', hash: 'b', parents: ['missing'] }])[0].toParents, []);
truthy('分叉能看出来：两条线的共同父那一行 width ≥ 2',
	layoutGitLanes([
		{ full: 'd', hash: 'd', parents: ['c'] },
		{ full: 'e', hash: 'e', parents: ['c'] },
		{ full: 'c', hash: 'c', parents: ['b'] },
		{ full: 'b', hash: 'b', parents: ['a'] },
		{ full: 'a', hash: 'a', parents: [] },
	])[2].width >= 2);
truthy('gitLanes 已进 package.json files（漏了 ⇒ 打包裁掉 ⇒ 插件加载失败白屏）',
	(pkg.files ?? []).includes('lib/core/gitLanes.js'));
eq('ROW_H 是 46（页面 CSS 行高与它必须同值）', ROW_H, 46);
truthy('页面行高与 ROW_H 一致（改一个必须改另一个）',
	/\.mp-row\{[^}]*height:46px/.test(evoSrc));

truthy('★ 回合结束：备份之后要自动提交（否则演化页上永远只有人手动按的那几次）',
	/await backupMemory\(config, agentId, 'auto-after-turn'\)[\s\S]{0,200}autoCommitAfterTurn\(config, agentId\)/.test(memorySrc));
truthy('★ 自动提交受开关控制（config.memoryAutoCommit === false 可退回"人按按钮"）',
	/if \(!memoryAutoCommitOnTurn\(config\)\)/.test(memorySrc));
truthy('自动提交全路径不抛（没 git / 没启用 ⇒ 只留说明，不拖住回合结束）',
	/autoCommitAfterTurn[\s\S]{0,600}try \{\s*\n\s*snapshot = await snapshotGit/.test(memorySrc));
truthy('★ git init 显式 -b main（否则分支名随机器全局配置漂移到 master）',
	/git\(dir, \['init', '-b', 'main'\]\)/.test(memorySrc));
/* ★★ 回滚的数据安全性（2026-10-31，对齐 DSB 的「恢复只往前追加」）：
   回滚是"覆盖文件 → 提交" ⇒ 不先把未提交改动存成一条提交，那些改动就在 Git 里**彻底消失**
   （提交时工作区已是旧内容，连"回滚前长什么样"都查不到）。真回归测试在
   `test/memory-restore.test.mjs`（已验证：去掉备份那步 ⇒ 测试退出码 1）。 */
truthy('★★ 回滚前先把未提交改动存成一条提交（回滚 ≠ 静默丢数据）',
	/回滚前备份/.test(memorySrc) && /backup = await snapshotGit\(config, agentId,/.test(memorySrc));
truthy('回滚失败时不中断（备份失败也如实回传，不假装成功）',
	/backup = \{ error: String\(e\?\.message \?\? e\) \};/.test(memorySrc));
truthy('Git 图用**全长** sha 匹配（%h 与 %(objectname:short) 缩写长度会漂 ⇒ 拼不上是静默的）',
	/'--pretty=format:%H/.test(memorySrc) && /%\(objectname\)/.test(memorySrc));
truthy('Git 图走 --branches（只看 HEAD 就永远画不出岔路）',
	/'log', '--branches', 'HEAD', '--topo-order'/.test(memorySrc));

truthy('★ 页面用服务端算好的 path（不在前端重算布局 ⇒ 禁止出现 layoutGitLanes）',
	/c\.svg\.paths/.test(evoSrc) && !/layoutGitLanes/.test(evoSrc));
truthy('页面请求带 graph=1（按需算，普通页面请求不多跑 git）',
	/graph=1/.test(evoSrc));
truthy('★ 自动提交开关回传给页面（用户要看得见"自动快照"是否开着）',
	/autoCommit: \{/.test(indexSrc) && /memoryAutoCommitOnTurn\(config\)/.test(indexSrc));
truthy('git-lanes 单测进了包内自检列表（否则新测试是孤儿，没人跑）',
	runSrc.includes("'git-lanes.test.mjs'"));

// ★ 2026-10-31 抓到的一段**死代码**：`await ensureMemoryRepo(config, agentId)` 曾被写在
//   `if (!agentId) { throw … }` 的大括号里、throw 之后 ⇒ 永远执行不到 ⇒ "首次读取即初始化"
//   从未发生过 ⇒ 从没被读过的 agent（内置尤其）记忆目录永不 git 化 ⇒ 演化/版本/分支恒空。
//   判据用**缩进层级**（与 agentId 同层）而不是正则：正则写不出"在哪个块里"。
{
	const lines = indexSrc.split(/\r?\n/);
	const iAgent = lines.findIndex((l) => l.includes("const agentId = String(url.searchParams.get('agent')"));
	// ⚠ 这句 throw 在文件里不止一处（别的路由也有同文案）⇒ 必须取 **agentId 之后** 的那一个，
	//   否则 findIndex 命中前面那处 ⇒ 条件恒假（我第一版就是这么写错的）。
	const iThrow = lines.findIndex((l, i) => i > iAgent && l.includes("throw Object.assign(new Error('需要 agent 参数')"));
	const iEnsure = lines.findIndex((l) => l.includes('await ensureMemoryRepo(config, agentId)'));
	const indent = (l) => (l.match(/^\t*/) || [''])[0].length;
	truthy('★ 首次读取即初始化不是死代码（与 agentId 同层，且在 throw 之后）',
		iAgent >= 0 && iThrow > iAgent && iEnsure > iThrow && indent(lines[iEnsure]) === indent(lines[iAgent]),
		`agent@${iAgent}:${indent(lines[iAgent] ?? '')} ensure@${iEnsure}:${indent(lines[iEnsure] ?? '')}`);
}

// ── 5d. 右栏记忆四页签（2026-10-31，按 DSB 演化面板重做）──────────────────
const agentsSrc = fs.readFileSync(path.join(PLUGIN, 'lib/client.agents.js'), 'utf8');
truthy('右栏请求带上 versions / branches / graph（不带 ⇒ 版本与分支页签拿不到数据）',
	agentsSrc.includes("'&limit=50&versions=1&branches=1&graph=1'"));
truthy('★ 演化用服务端算好的 svg.paths（前端重算布局必然分叉 ⇒ 禁止出现 layoutGitLanes）',
	/c\.svg/.test(agentsSrc) && /ag3-lane/.test(agentsSrc) && !/layoutGitLanes/.test(agentsSrc));
truthy('★ 分道图行高与 ROW_H 同值（CSS 46px + svg height 46；改一处必须改另一处）',
	/\.ag3-crow \{[^}]*height:46px/.test(agentsSrc) && /height: 46/.test(agentsSrc));
truthy('未提交改动按 kind 分组（新记忆 / 已有记忆的更新 ⇒ 后端必须给 changes）',
	/git\.changes/.test(agentsSrc) && /kindOf\(l\.slice\(0, 2\)\)/.test(memorySrc) && /dirtyFiles: changes\.map/.test(memorySrc));
truthy('版本 / 分支的写动作仍在完整页（不在 320 右栏再写一套）',
	/openModuleRoute\('\/x\/agents\/memory\//.test(agentsSrc));
/* ★ 群聊下四个记忆页签（2026-10-31 用户报「没生效」）：
   根因是数据主体用了 `curAgent`（群选中时为 null ⇒ 永远不拉数据），且群分支直接 return
   只列一遍成员。现在主体换成 `memAgent`（群 = 挑中的成员），群分支对记忆类页签不再 return。 */
truthy('★ 群聊下记忆类页签也拉数据（主体是 memAgent，不是 curAgent）',
	/const memAgent = sel\.kind === 'group'/.test(agentsSrc)
	&& /const agentId = memAgent \? memAgent\.id : ''/.test(agentsSrc)
	&& /\}, \[tab, rtab, memAgent && memAgent\.id\]\);/.test(agentsSrc));
truthy('群聊下不再只列成员（禁止回到「选一个成员查看」的死胡同文案）',
	!/群没有自己的' \+ rlabel/.test(agentsSrc));
truthy('群聊下有成员选择条（写明看的是谁 + 群没有自己的记忆库）',
	/'data-ag-gsel'/.test(agentsSrc) && /setGroupMemId/.test(agentsSrc) && /群没有自己的记忆库/.test(agentsSrc));

// ── 5b. 从记忆库导入草稿（2026-10-20，P1-1）────────────────────────────────
const {
	agentMemoryGatewayUrl, clampImportLimit, importMemoryDraft,
} = await load('lib/agentmemoryImport.js');

// 地址解析：**不猜端口**是这一块的核心纪律（猜错会读到别人的库）
eq('无任何地址来源 → null（不猜端口）', agentMemoryGatewayUrl({}, {}), null);
eq('config 优先于环境变量', agentMemoryGatewayUrl({ agentMemoryGatewayUrl: 'http://127.0.0.1:9/x/' }, { AGENTMEMORY_URL: 'http://a' }), 'http://127.0.0.1:9/x');
eq('VSSAROS_ 变量优先于 AGENTMEMORY_URL', agentMemoryGatewayUrl({}, { VSSAROS_MEMORY_GATEWAY_URL: 'http://v', AGENTMEMORY_URL: 'http://a' }), 'http://v');
eq('AGENTMEMORY_URL 去尾斜杠', agentMemoryGatewayUrl({}, { AGENTMEMORY_URL: 'http://a/' }), 'http://a');
eq('AGENTMEMORY_PORT 拼本地地址', agentMemoryGatewayUrl({}, { AGENTMEMORY_PORT: '3112' }), 'http://127.0.0.1:3112');
eq('非法端口 → null', agentMemoryGatewayUrl({}, { AGENTMEMORY_PORT: 'abc' }), null);
eq('clampImportLimit 缺省 40', clampImportLimit(undefined), 40);
eq('clampImportLimit 上限 100', clampImportLimit(999), 100);
eq('clampImportLimit 非法 → 40', clampImportLimit('x'), 40);

let importError = '';
try {
	await importMemoryDraft({}, 'demo', { env: {} });
} catch (e) {
	importError = String(e?.message ?? e);
}
truthy('网关未配置时明确报错（不返回空草稿冒充成功）', /记忆网关未配置/.test(importError));

const importSrc = fs.readFileSync(path.join(PLUGIN, 'lib/agentmemoryImport.js'), 'utf8');
truthy('记忆 API 暴露 import-draft', /action === 'import-draft' \? await importMemoryDraft/.test(indexSrc));
// ⚠ 2026-10-31 收窄口径：旧断言是 `!/writeFile/`（"导入模块只读，不写盘"），
//   后来模块加了**自己的同步游标**要落盘（`writeSyncState` → `<dataRoot>/<SYNC_FILE>`，
//   与记忆无关）⇒ 旧断言恒红，且它一旦红着就没人再看这一组 ⇒ 等于整组守卫失效。
//   真语义是「不得写**记忆**」：草稿只填进编辑框，落盘必须经人的 write-memory。
truthy('导入模块不写记忆（不得出现任何记忆写口）',
	!/writeCoreMemory|writeMemoryFile|snapshotGit\(/.test(importSrc));
truthy('导入模块对记忆目录只读（从 memory.js 只 import 读口）',
	/import \{ readMemoryFile \} from '\.\/memory\.js';/.test(importSrc));
truthy('唯一允许的写盘是它自己的同步游标，且走原子写（tmp + rename）',
	/writeFile\(state\.file \+ '\.tmp'/.test(importSrc)
	&& /renameWithRetry\(state\.file \+ '\.tmp'/.test(importSrc));
truthy('页面有「从记忆库导入草稿」入口', /memoryImportDraft/.test(detailSrc));
truthy('导入模块已进 package.json files', (pkg.files ?? []).includes('lib/agentmemoryImport.js'));

// ── 5c. IDE 侧注入总开关（P1-3，2026-10-20）──────────────────────────────
// 为什么要跨侧读源码：这条设置**只有三处对齐**才有意义（常量定义 / schema 注册 / 读取逻辑），
// 而它们分居三个文件。任何一处被改回去都是"设置 UI 里能看到但点了没用"（或反之）。
// 反向突变：把 `const enabled = configured || envEnabled` 改回只读 envValue ⇒ 这里变红。
const REPO = path.resolve(HERE, '..');
const ideStudio = path.join(REPO, 'src/vs/sessions/contrib/agentStudio');
const constantsSrc = fs.readFileSync(path.join(ideStudio, 'common/constants.ts'), 'utf8');
const contributionSrc = fs.readFileSync(path.join(ideStudio, 'browser/agentStudio.contribution.ts'), 'utf8');
const injectionSrc = fs.readFileSync(path.join(ideStudio, 'browser/agentMemoryInjection.ts'), 'utf8');

truthy('设置键只在 constants.ts 定义一次',
	(constantsSrc.match(/AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING =/g) ?? []).length === 1);
truthy('设置键已注册 schema（设置 UI 可见）',
	/\[AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING\]: \{/.test(contributionSrc));
truthy('设置项默认关闭（不覆盖环境变量）',
	/\[AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING\]: \{\s*\n\s*type: 'boolean',\s*\n\s*default: false,/.test(contributionSrc));
truthy('注入判定 = 设置 or 环境变量',
	/const enabled = configured \|\| envEnabled;/.test(injectionSrc));
truthy('设置读取失败不当作关闭（回落环境变量）',
	/configured = readConfigured\?\.\(\) === true;/.test(injectionSrc));

// ── 5d. 记忆库「侧栏摘要」的 CSS 依赖（2026-10-20 真机：整片纯黑）──────────────
// 现场：`/x/memory/?surface=sideview` 加载成功（`did-finish-load` 正常、日志零错误），
//   但内容区全黑 —— 因为 sideview 复用完整版 PAGE_CSS，而那里 `.kb-panel` 是
//   `display: none`、只有 `.kb-panel.active` 才 `display: flex`，侧栏版漏了 `active`。
//   CSS 隐藏既不报错也不进日志 ⇒ 只能靠源码级断言盯住。
const memLib = fs.readFileSync(path.join(HERE, 'vssaros-memory/lib/index.js'), 'utf8');
truthy('memory CSS：.kb-panel 默认 display:none（只有 .active 才显示）',
	/\.kb-panel\s*\{\s*display:\s*none\b/.test(memLib)
	&& /\.kb-panel\.active\s*\{\s*display:\s*flex\b/.test(memLib));

const svStart = memLib.indexOf('function renderSideviewPage');
const svEnd = memLib.indexOf('function describeWritePayload', svStart);
const svSrc = svStart >= 0 ? memLib.slice(svStart, svEnd > svStart ? svEnd : svStart + 9000) : '';
truthy('renderSideviewPage 抓得到（防空跑）', svSrc.length > 400);
truthy('侧栏版的面板必须带 active 类（漏了 ⇒ 整页 display:none ⇒ 一片黑）',
	/class="kb-panel active"/.test(svSrc));
truthy('侧栏版里不得出现不带 active 的 kb-panel（同一条规则的另一面）',
	!/class="kb-panel"/.test(svSrc));

// ── 6. 真实加载（语序无关；专抓新 import 引入的循环依赖 TDZ）─────────────────
// `core/agents.js` 被 `store.js` 依赖，而记忆口径的下游在 `lib/memory.js`
// ⇒ 真源必须是零依赖叶子；谁把它挪回 memory.js（或让 core 反向 import store）这里就炸。
const indexModule = await load('lib/index.js');
truthy('index.js 可加载（apply 是函数）', typeof indexModule.apply === 'function');
truthy('index.js 暴露记忆自证表', indexModule.__promptMem && indexModule.__promptMem.byAgent instanceof Map);
const detailModule = await load('lib/detail.js');
truthy('detail.js 可加载（renderDetailPage 是函数）', typeof detailModule.renderDetailPage === 'function');

// ── 结果 ─────────────────────────────────────────────────────────────────────
if (problems.length) {
	console.error(`\n✗ agents 记忆守卫失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log(`✓ agents 记忆守卫通过（${notes.length} 项）`);
