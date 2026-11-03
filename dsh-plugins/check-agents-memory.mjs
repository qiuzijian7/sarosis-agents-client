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
const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));

truthy('角色判定认「有 persona 键」（空正文也走 applyPersona）',
	/if \(typeof config\?\.persona === 'string'\) \{\s*\n\s*applyPersona/.test(indexSrc));
truthy('角色判定**不再**要求 persona 非空',
	!/config\?\.persona === 'string' && config\.persona\.trim\(\)/.test(indexSrc));
truthy('gitLogOf 复用同一请求的 status',
	/gitLogOf\(config, agentId, git, url\.searchParams\.get\('limit'\)\)/.test(indexSrc));
truthy('记忆 API 回传运行时口径（runtime）',
	/runtime: \(\(\) => \{/.test(indexSrc) && /const rt = __promptMem\.byAgent\.get\(agentId\)/.test(indexSrc));
// ★ 2026-11-03（工作区记忆 P2）：同一个 runtime 对工作区作用域读的是 __workspaceMem（全局 section 的计数），
//   不是 per-agent 的 __promptMem —— 两条路都要在，缺一条 ⇒ 演化页对工作区恒显示"从未挂载"。
truthy('记忆 API 对工作区作用域读 __workspaceMem（不是 __promptMem）',
	/if \(wsScope\) \{[\s\S]{0,200}__workspaceMem\.order/.test(indexSrc));
truthy('关掉注入时不起 60s 定时器',
	/memoryChars > 0 \? setInterval\(/.test(indexSrc));
truthy('Bots 工作台（detail.js）已下线', !fs.existsSync(path.join(PLUGIN, 'lib/detail.js')));
// ★ 2026-11-03：这句文案随 Bots 工作台（detail.js）一起下线，现在只在 Host 侧的导入模块里 ⇒ 断言改到那边
truthy('记忆相关文案仍区分 AgentMemory 检索库',
	/互不写入|AgentMemory 检索库/.test(fs.readFileSync(path.join(PLUGIN, 'lib/agentmemoryImport.js'), 'utf8')));
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

// ── 5d. ★ 2026-11-03：Bots 工作台（lib/client.agents.js）整体下线 —— 反向断言 ──
const agentsSrc = '';
truthy('Bots 工作台 React（lib/client.agents.js）已下线', !fs.existsSync(path.join(PLUGIN, 'lib/client.agents.js')));
// ── 6. 真实加载（语序无关；专抓新 import 引入的循环依赖 TDZ）─────────────────
// `core/agents.js` 被 `store.js` 依赖，而记忆口径的下游在 `lib/memory.js`
// ⇒ 真源必须是零依赖叶子；谁把它挪回 memory.js（或让 core 反向 import store）这里就炸。
const indexModule = await load('lib/index.js');
truthy('index.js 可加载（apply 是函数）', typeof indexModule.apply === 'function');
truthy('index.js 暴露记忆自证表', indexModule.__promptMem && indexModule.__promptMem.byAgent instanceof Map);

// ── 结果 ─────────────────────────────────────────────────────────────────────
if (problems.length) {
	console.error(`\n✗ agents 记忆守卫失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log(`✓ agents 记忆守卫通过（${notes.length} 项）`);
