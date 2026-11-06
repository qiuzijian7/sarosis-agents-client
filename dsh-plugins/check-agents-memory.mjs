/**
 * agents 插件「记忆」守卫（2026-10-20；2026-11-06「记忆收敛」S4 重写）。
 *
 * 2026-11-06 起本插件**没有自己的记忆**：Bot 记忆 / 工作区记忆并入 @vssaros/dsh-memory（bot / key 轨），
 * 注入、`memory` 工具、版本历史都由它负责；本插件只剩：
 *   · `lib/memoryFiles.js`：旧目录路径与文件名白名单（CLI / 启动早期的收件箱，统一存储启动时并入）；
 *   · `lib/core/memoryLimits.js`：`.agent.md` 的 `memory-chars` / `memory-mode` 解析（frontmatter 兼容；不再影响注入）。
 * 这里钉住两类事：
 *   1) 收敛的不变量：旧模块不许复活、没人再 import、人设段不再注入记忆、files 白名单同步；
 *   2) 仍在用的老约束：memoryLimits 口径单一真源、人设为空的 agent 也走 applyPersona、gitLanes 纯函数。
 *
 * 跑法：`node dsh-plugins/check-agents-memory.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, 'vssaros-agents');

// Windows 上动态 import 绝对路径必须走 file:// URL（直接传 `g:\...` 会 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const load = spec => import(pathToFileURL(path.join(PLUGIN, spec)).href);
const read = rel => fs.readFileSync(path.join(PLUGIN, rel), 'utf8');
const listJs = (dir, out = []) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const f = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') { listJs(f, out); } } else if (/\.(m?js)$/.test(e.name)) { out.push(f); }
	}
	return out;
};

const {
	MEMORY_CHARS_DEFAULT, MEMORY_CHARS_MAX, MEMORY_CHARS_MIN,
	clampMemoryChars, normalizeMemoryMode, parseMemoryLimits, parseMemoryModeInput,
} = await load('lib/core/memoryLimits.js');

const problems = [];
const notes = [];
const eq = (label, actual, expected) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		problems.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
	} else {
		notes.push(`ok  ${label}`);
	}
};
const truthy = (label, value, detail) => {
	if (!value) { problems.push(detail ? `${label}（${detail}）` : label); } else { notes.push(`ok  ${label}`); }
};

// ── 1. 收敛不变量（★ 2026-11-06）─────────────────────────────────────────────
const DELETED = ['lib/memory.js', 'lib/workspaceMemory.js', 'lib/memoryPrefs.js', 'lib/agentmemoryImport.js', 'lib/memoryEvoPage.js'];
for (const f of DELETED) {
	truthy(`${f} 已删（记忆并入 @vssaros/dsh-memory）`, !fs.existsSync(path.join(PLUGIN, f)));
}
const goneImport = /from '[^']*\/(memory|workspaceMemory|memoryPrefs|agentmemoryImport|memoryEvoPage)\.js'|import\('[^']*\/(memory|workspaceMemory|memoryPrefs|agentmemoryImport|memoryEvoPage)\.js'\)/;
const importers = listJs(HERE).filter((f) => goneImport.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(HERE, f));
truthy('dsh-plugins 下没有文件再 import 已删的记忆模块', importers.length === 0, importers.join(', '));

const indexSrc = read('lib/index.js');
const toolsSrc = read('lib/tools.js');
truthy('人设段不再注入 Bot 记忆（没有 readMemorySnapshot / memoryTextFor）', !/readMemorySnapshot|memoryTextFor/.test(indexSrc));
truthy('不再注册工作区记忆段', !/vssaros-workspace-memory|installWorkspaceMemorySection/.test(indexSrc));
truthy('不再有记忆备份 watcher', !/installMemoryBackupWatcher/.test(indexSrc));
truthy('旧记忆接口与演化页已删（2026-11-06 转接层随 Bots 工作台 / 旧群页一起删除）',
	!/api\/memory`|api\/workspace-memory|api\/memory-prefs|api\/agentmemory|memoryFacade|memoryMovedPage/.test(indexSrc) && !fs.existsSync(path.join(PLUGIN, 'lib/memoryFacade.js')));
truthy('不再有 workspace_memory 工具', !/workspace_memory/.test(toolsSrc));
truthy('回滚开关已删除', !/legacyAgentMemoryOn|VSSAROS_AGENTS_LEGACY_MEMORY/.test(indexSrc + toolsSrc + read('lib/core/memoryLimits.js') + read('lib/pack.js') + read('lib/stepMemory.js')));
const { ALWAYS_KEEP_TOOL_NAMES } = await load('lib/core/agents.js');
const keep = new Set(ALWAYS_KEEP_TOOL_NAMES);
truthy('写了 tools: 的 agent 也常驻统一的 memory 工具', keep.has('memory') && !keep.has('workspace_memory'), [...keep].join(','));

const pkg = JSON.parse(read('package.json'));
const files = pkg.files ?? [];
truthy('files 白名单：删掉的模块不在', DELETED.every((f) => !files.includes(f)), DELETED.filter((f) => files.includes(f)).join(','));
truthy('files 白名单：新模块在（漏了 ⇒ 装机后加载失败）', ['lib/memoryFiles.js', 'lib/core/memoryLimits.js', 'lib/core/gitLanes.js'].every((f) => files.includes(f)));

// ── 2. memoryLimits（frontmatter 兼容；单一真源）─────────────────────────────
eq('MEMORY_CHARS_DEFAULT', MEMORY_CHARS_DEFAULT, 2048);
eq('MEMORY_CHARS_MIN', MEMORY_CHARS_MIN, 512);
eq('MEMORY_CHARS_MAX', MEMORY_CHARS_MAX, 20000);
eq('clamp(undefined) → 默认', clampMemoryChars(undefined), 2048);
eq('clamp("abc") → 默认（笔误不炸）', clampMemoryChars('abc'), 2048);
eq('clamp(0) → 0（关闭）', clampMemoryChars(0), 0);
eq('clamp(100) → 夹到下限', clampMemoryChars(100), 512);
eq('clamp(99999) → 夹到上限', clampMemoryChars(99999), 20000);
eq('parseMemoryLimits({}) 没写 chars', parseMemoryLimits({}), { chars: undefined, mode: 'session' });
eq('parseMemoryLimits 显式 0 + live', parseMemoryLimits({ 'memory-chars': '0', 'memory-mode': 'live' }), { chars: 0, mode: 'live' });
eq('parseMemoryLimits 未知 mode → session', parseMemoryLimits({ 'memory-mode': 'zzz' }), { chars: undefined, mode: 'session' });
eq('normalizeMemoryMode(LIVE)', normalizeMemoryMode('LIVE'), 'live');
eq('parseMemoryModeInput(乱写) → 不写', parseMemoryModeInput('whatever'), '');

// ── 3. 人设角色判据（人设为空的 agent 也要走 applyPersona，否则工具 allowlist 失效）──
truthy('角色判定认「有 persona 键」（空正文也走 applyPersona）',
	/if \(typeof config\?\.persona === 'string'\) \{\s*\n\s*applyPersona/.test(indexSrc));
truthy('角色判定**不再**要求 persona 非空',
	!/config\?\.persona === 'string' && config\.persona\.trim\(\)/.test(indexSrc));

// ── 4. gitLanes 纯函数（模块仍在包里）──────────────────────────────────────────
const { layoutGitLanes, laneRowPaths, ROW_H } = await load('lib/core/gitLanes.js');
truthy('gitLanes：导出布局与 path 两个入口', typeof layoutGitLanes === 'function' && typeof laneRowPaths === 'function');
eq('线性历史全在第 0 轨', layoutGitLanes([
	{ full: 'c', hash: 'c', parents: ['b'] },
	{ full: 'b', hash: 'b', parents: ['a'] },
	{ full: 'a', hash: 'a', parents: [] },
]).map(r => r.lane), [0, 0, 0]);
eq('父提交不在显示列表 ⇒ 不开轨道', layoutGitLanes([{ full: 'b', hash: 'b', parents: ['missing'] }])[0].toParents, []);
eq('ROW_H 是 46', ROW_H, 46);

// ── 5. Bots 工作台下线的反向断言（2026-11-03，与记忆收敛无关，原样保留）───────────
truthy('Bots 工作台（detail.js）已下线', !fs.existsSync(path.join(PLUGIN, 'lib/detail.js')));
truthy('Bots 工作台 React（lib/client.agents.js）已下线', !fs.existsSync(path.join(PLUGIN, 'lib/client.agents.js')));

// ── 6. 真实加载（专抓新 import 引入的循环依赖 / 缺失导出）─────────────────────
const indexModule = await load('lib/index.js');
truthy('index.js 可加载（apply 是函数）', typeof indexModule.apply === 'function');
truthy('index.js 不再暴露旧的记忆自证表', !('__promptMem' in indexModule) && !('__workspaceMem' in indexModule));

// ── 结果 ─────────────────────────────────────────────────────────────────────
if (problems.length) {
	console.error(`\n✗ agents 记忆守卫失败（${problems.length} 项）：`);
	for (const p of problems) { console.error(`  · ${p}`); }
	process.exit(1);
}
console.log(`✓ agents 记忆守卫通过（${notes.length} 项）`);
