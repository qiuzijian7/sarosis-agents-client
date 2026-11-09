/*
 * 守卫：技能正文引用的工具名必须**在当前环境真实存在**。
 *
 * 为什么必须有：技能是给模型看的操作手册，正文里写 `` `read_file` `` 就是在教模型调它。
 * 工具名不存在时不会报错 —— 模型拿到 "unknown tool" 后开始瞎猜替代方案，
 * 比"不给提示"更糟（bunnyseek 源码注释原话）。而迁移/改名一次就会静默产生这种悬空引用。
 *
 * 判据刻意窄到零假阳性：只有**出现在工具清单里**的标识符才算工具引用
 * （清单 = dsh-runtime 官方工具名 + dsh-plugins/tools-snapshot.json + bunnyseek 的旧名表；P3 起不再含 IDE 工具别名）。
 * 所以 `main.py`、`git_commit` 这类普通标识符永不误报。
 *
 * 扫描面：随包技能（顶层 `<name>/SKILL.md`）+ 用户技能根（`<数据根>/skills`，两套数据根）。
 * ⚠ 只认顶层 —— dsh 的 skill provider 是单层 readdir（`segments.length===2`），
 *   藏在容器目录里的技能 IDE 看得见、dsh 看不见。
 *
 * 跑法：node dsh-plugins/check-skill-tool-refs.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
	BUNNYSEEK_ONLY, TOOL_MAP, dshToolNames, ROOT, scanToolRefs,
	IDE_LEGACY_TOOL_NAMES, scanLegacyIdeToolRefs, frontmatterRecommendedTools,
} from './scripts/skill-tool-map.mjs';
import { BUNDLED_SKILL_ROOT, USER_SKILL_ROOTS } from './scripts/skill-bundle-paths.mjs';
// ★ 2026-11-08 P2：技能目录相对脚本路径（cwd 是会话工作区，照抄必翻车）
import { scanScriptRefs, newScriptRefs, baselineHash } from './scripts/skill-script-refs.mjs';

// ★ P0（2026-11-06）：只扫 dsh 侧新真源；旧根由 check-skill-bundle.mjs 做迁移完整性对照。
const SKILL_ROOTS = [BUNDLED_SKILL_ROOT, ...USER_SKILL_ROOTS];

/**
 * 有意保留的旧工具名（文件相对路径 → 工具名 → 理由）。
 * 守卫纪律：**有意不同必须登记**，否则下一个人会以为又是漏改。
 */
const DELIBERATE = [
	// 例：{ file: 'dsh-plugins/vssaros-skill-bundle/skills/xxx/SKILL.md', tool: 'read_file', why: '正文是"从 bunnyseek 迁移"的对照说明' }
];

const dshTools = dshToolNames();

// ★ P3（2026-11-07）：映射表本身不许腐烂 —— 每个非 null 目标都必须是真实存在的 dsh 工具名。
//   之前 TOOL_MAP 指向 IDE 侧 file_read / terminal / skill_view 等别名；删掉 IDE 工具目录后，
//   那一版会把技能正文批量判成悬空，迁移器还会把旧名换成不存在的名字（比悬空更隐蔽 ✗）。
const badTargets = Object.entries(TOOL_MAP)
	.filter(([, target]) => target !== null && !dshTools.has(target))
	.map(([old, target]) => `${old} → ${target}`);
if (badTargets.length) {
	console.error(`[check-skill-tool-refs] ✗ TOOL_MAP 有 ${badTargets.length} 个目标不是 dsh 工具：${badTargets.join('、')}`);
	process.exit(1);
}

const problems = [];
let scanned = 0;
const danglingRows = [];
const scriptRows = [];
const baseline = JSON.parse(readFileSync(join(ROOT, 'dsh-plugins', 'scripts', 'skill-script-refs.baseline.json'), 'utf8'));

for (const root of SKILL_ROOTS) {
	if (!existsSync(root)) {
		continue;
	}
	const dirs = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
	for (const dir of dirs) {
		const file = join(root, dir, 'SKILL.md');
		if (!existsSync(file)) {
			continue;
		}
		scanned += 1;
		const text = readFileSync(file, 'utf8');
		const { referenced, dangling } = scanToolRefs(text, dshTools);
		// 用户技能根在工作区**之外** ⇒ `relative` 会给出 `../../..` 开头，用更短的 `~/<后缀>` 显示。
		const inside = relative(ROOT, file);
		const rel = (inside.startsWith('..') ? `~/${relative(root, file)}` : inside).replace(/\\/g, '/');
		// ★ P2：现有相对脚本写法登记为基线；**新增一处**就判红（不一次刷屏 173 个文件 ✓）
		//   只比对随包根（基线只覆盖它）；用户技能目录里的新写法不进基线 hash，
		//   否则用户自己装个技能就会让整个守卫假红。
		if (root === BUNDLED_SKILL_ROOT) {
			const scriptRefs = scanScriptRefs(text);
			if (scriptRefs.length) { scriptRows.push({ file: `${dir}/SKILL.md`, refs: scriptRefs }); }
		}
		const real = dangling.filter(tool => !DELIBERATE.some(d => d.file === rel && d.tool === tool));
		if (real.length) {
			danglingRows.push({ rel, tools: real, referenced: referenced.length });
		}
	}
}

// 假绿防线：一个技能都没扫到，说明路径或判据失效 —— 这种守卫"永远绿"比没有更坏。
if (scanned === 0) {
	console.error('[check-skill-tool-refs] ✗ 一个技能都没扫到（路径或顶层判据失效）');
	process.exit(1);
}

console.log('[check-skill-tool-refs] 技能正文 → 工具名 引用守卫');
console.log(`  工具清单：dsh 内建 + 插件共 ${dshTools.size} 个；可识别的旧名 ${BUNNYSEEK_ONLY.size} 个`);
console.log(`  受检技能：${scanned} 个（随包 + 用户技能根）`);
const addedScripts = newScriptRefs(scriptRows, baseline);
if (addedScripts.length) {
	console.error(`  ✗ 新增 ${addedScripts.length} 处技能目录相对脚本路径（cwd 是会话工作区 ⇒ 会找不到文件）：`);
	for (const item of addedScripts.slice(0, 8)) { console.error(`    · ${item}`); }
	console.error('    修法：用 skill_search 返回的 skillDir（绝对路径）拼，或写 <skillDir>/scripts/x.mjs；');
	console.error('    确属有意保留时，更新 dsh-plugins/scripts/skill-script-refs.baseline.json 并说明理由。');
	process.exit(1);
}
if (baselineHash(scriptRows) !== baselineHash(baseline)) {
	console.error('  ✗ 相对脚本路径基线变了（删技能/改写法后要重生基线），当前 hash=' + baselineHash(scriptRows));
	process.exit(1);
}
console.log(`  ✓ 相对脚本路径：${baseline.length} 个技能的既有写法已登记，无新增（hash ${baselineHash(scriptRows)}）`);

// ── 6. IDE 退役名：全量扫描 + 已知技术债基线（只许减不许增）──────────────
// scanToolRefs 只认「已登记在 TOOL_MAP / dshTools 里」的标识符，IDE 退役名
// 会被静默 continue 掉 ⇒ 这里用共享口径单独扫全部随包技能。
//   · frontmatter recommended_tools：全量硬判据，一个旧名都不许有；
//   · 9 个 QA/浏览器技能正文：零容忍；
//   · 其余历史技能正文：基线冻结，新增判红、修掉要重生基线销账。
const QA_SKILLS = new Set(['qa-context-profiling', 'qa-risk-analysis', 'qa-case-design',
	'qa-script-generation', 'qa-execution-repair', 'qa-quality-review',
	'qa-acceptance-report', 'qa-core', 'dogfood']);
const bundledDirs = readdirSync(BUNDLED_SKILL_ROOT, { withFileTypes: true })
	.filter((d) => d.isDirectory()).map((d) => d.name);
const legacyRows = [];
const frontmatterProblems = [];
const tracked = {};
for (const dir of bundledDirs) {
	const file = join(BUNDLED_SKILL_ROOT, dir, 'SKILL.md');
	if (!existsSync(file)) { continue; }
	const text = readFileSync(file, 'utf8');
	const hits = scanLegacyIdeToolRefs(text);
	if (hits.length) {
		if (QA_SKILLS.has(dir)) { legacyRows.push({ dir, tools: hits }); }
		else { tracked[`${dir}/SKILL.md`] = hits; }
	}
	for (const name of frontmatterRecommendedTools(text)) {
		if (IDE_LEGACY_TOOL_NAMES.includes(name)) {
			frontmatterProblems.push(`${dir}/SKILL.md: recommended_tools 里的 ${name}`);
		}
	}
}
// 采集面自检：技能数骤减说明路径/挂载漂了，守卫不能空跑。
if (bundledDirs.length < 100) {
	console.error(`[check-skill-tool-refs] ✗ 只扫到 ${bundledDirs.length} 个技能目录（路径漂移 ⇒ 守卫空跑）`);
	process.exit(1);
}
if (frontmatterProblems.length) {
	console.error('[check-skill-tool-refs] ✗ frontmatter 的 recommended_tools 仍有 IDE 退役名：');
	for (const p of frontmatterProblems.slice(0, 12)) { console.error(`    · ${p}`); }
	process.exit(1);
}
if (legacyRows.length) {
	console.error('[check-skill-tool-refs] ✗ QA/浏览器技能里还有 IDE 侧已退役的工具名：');
	for (const row of legacyRows) { console.error(`    · ${row.dir}/SKILL.md　${row.tools.join(', ')}`); }
	console.error('  修法：换成 dsh 侧真名；浏览器统一用单工具 browser 的 op= 形式。');
	process.exit(1);
}

const legacyBaselinePath = join(ROOT, 'dsh-plugins', 'scripts', 'skill-legacy-tool-refs.baseline.json');
if (!existsSync(legacyBaselinePath)) {
	console.error('[check-skill-tool-refs] ✗ 缺 IDE 退役名基线，跑 node dsh-plugins/scripts/gen-skill-legacy-baseline.mjs');
	process.exit(1);
}
let legacyBaseline = {};
try { legacyBaseline = JSON.parse(readFileSync(legacyBaselinePath, 'utf8')).rows ?? {}; }
catch (error) {
	console.error(`[check-skill-tool-refs] ✗ 基线解析失败：${String(error?.message ?? error)}`);
	process.exit(1);
}
const added = [];
const removed = [];
for (const [file, tools] of Object.entries(tracked)) {
	for (const t of tools) { if (!(legacyBaseline[file] ?? []).includes(t)) { added.push(`${file}: ${t}`); } }
}
for (const [file, tools] of Object.entries(legacyBaseline)) {
	for (const t of tools) { if (!(tracked[file] ?? []).includes(t)) { removed.push(`${file}: ${t}`); } }
	if (!tracked[file]) { removed.push(`${file}: 整份已修好`); }
}
if (added.length) {
	console.error('[check-skill-tool-refs] ✗ 技能正文新增了 IDE 退役工具名：');
	for (const a of added.slice(0, 12)) { console.error(`    · ${a}`); }
	process.exit(1);
}
if (removed.length) {
	console.error('[check-skill-tool-refs] ✗ 旧名已减少，跑 node dsh-plugins/scripts/gen-skill-legacy-baseline.mjs 销账：');
	for (const r of removed.slice(0, 12)) { console.error(`    · ${r}`); }
	process.exit(1);
}
console.log(`  ✓ IDE 退役名：frontmatter 全量 ${bundledDirs.length} 份干净 / 9 个 QA 技能零容忍 / 正文基线 ${Object.keys(legacyBaseline).length} 份无漂移`);

// ── 7. QA 链：MCP 接线 / 回归与视觉资产 / 只报不修 ────────────────────
{
	const stale = [];
	const corePath = join(BUNDLED_SKILL_ROOT, 'qa-core', 'SKILL.md');
	if (!existsSync(corePath)) {
		stale.push('qa-core/SKILL.md 缺失');
	} else {
		const core = readFileSync(corePath, 'utf8');
		if (core.includes('qa-orchestrator')) { stale.push('qa-core 仍指向不存在的 qa-orchestrator agent'); }
		if (/G:\/CustomWorkspaces|ming-qa/.test(core)) { stale.push('qa-core 仍引用未随包的本机绝对路径 / 外部仓库'); }
		if (!core.includes('已挂载') || !core.includes('mcp__playwright__')) {
			stale.push('qa-core 没有写明 Playwright MCP 已挂载与命名空间前缀');
		}
		if (!core.includes('不改产品代码')) { stale.push('qa-core 的安全边界没写「不改产品代码」'); }
		if (!core.includes('pixelDiff') || !core.includes('--record')) {
			stale.push('qa-core 没有写明 pixelDiff 判定与 --record 录制入口');
		}
	}
	for (const f of ['playwright_test_planner.toml', 'playwright_test_generator.toml', 'playwright_test_healer.toml']) {
		const p = join(BUNDLED_SKILL_ROOT, 'qa-core', 'assets', 'playwright', f);
		if (!existsSync(p)) { stale.push(`缺 ${f}`); continue; }
		if (!readFileSync(p, 'utf8').includes('MCP 已挂载')) { stale.push(`${f} 缺「MCP 已挂载」说明`); }
	}
	// MCP 声明行必须在位：tester 的 tools[] 前缀靠它对账，删了行就会静默失去整组工具。
	const mcpPatch = join(ROOT, 'dsh-plugins', 'vssaros-mcp', 'cordis.patch.yml');
	if (!existsSync(mcpPatch)) {
		stale.push('vssaros-mcp/cordis.patch.yml 缺失');
	} else {
		const patch = readFileSync(mcpPatch, 'utf8');
		if (!/serverName:\s*'playwright'/.test(patch) || !patch.includes('@playwright/mcp')) {
			stale.push('dsh 侧没有声明 playwright MCP server');
		}
	}
	// P1/P2 资产：不新增顶层技能（绕开 173 快照），但资产与接线必须在位。
	for (const rel of [
		'qa-core/references/visual-check.md',
		'qa-core/references/e2e-regression.md',
		'qa-core/assets/playwright/seed.spec.ts',
		'qa-core/assets/playwright/replay-cache.example.json',
	]) {
		if (!existsSync(join(BUNDLED_SKILL_ROOT, rel))) { stale.push(`缺 ${rel}`); }
	}
	// 资产写了但 agent 不知道 = 白写：tester 真源必须真的引用这两份参考。
	const agentsTsPath = join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'builtinAgents.ts');
	if (!existsSync(agentsTsPath)) {
		stale.push('builtinAgents.ts 缺失');
	} else {
		const agentsTs = readFileSync(agentsTsPath, 'utf8');
		for (const key of ['visual-check.md', 'e2e-regression.md']) {
			if (!agentsTs.includes(key)) { stale.push(`tester 提示词没引用 ${key}`); }
		}
	}
	// P1/P2 判定器：不只看文件在不在，还要真跑自检，防止脚本被改成空壳。
	const checkerBaseline = stale.length;
	const coreRefs = existsSync(corePath) ? readFileSync(corePath, 'utf8') : '';
	for (const [name, marker] of [
		['visual_check.py', 'visual_check self-test OK'],
		['replay_check.py', 'replay_check self-test OK'],
	]) {
		const script = join(BUNDLED_SKILL_ROOT, 'qa-core', 'scripts', name);
		if (!existsSync(script)) { stale.push(`缺 qa-core/scripts/${name}`); continue; }
		if (!coreRefs.includes(name)) { stale.push(`qa-core/SKILL.md 没引用 ${name}`); }
		let out;
		for (const bin of ['python', 'python3']) {
			try {
				// ★ 2026-11-09：dsh Host 无控制台 ⇒ 不加 windowsHide 会闪窗（check-spawn-hide 守卫）
				out = execFileSync(bin, [script, '--self-test'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
				break;
			} catch { /* 换下一个解释器名 */ }
		}
		if (out === undefined) { stale.push(`${name} 自检跑不起来（python / python3 都不可用）`); continue; }
		if (!String(out).includes(marker)) { stale.push(`${name} 自检没有返回预期结果`); }
	}
	if (stale.length === checkerBaseline) { console.log('  ✓ 判定器自检：visual_check.py / replay_check.py 真跑通过'); }
	const cliPath = join(BUNDLED_SKILL_ROOT, 'qa-core', 'scripts', 'qa_agent.py');
	if (!existsSync(cliPath)) {
		stale.push('qa_agent.py 缺失');
	} else {
		const cli = readFileSync(cliPath, 'utf8');
		for (const key of ['seed.spec.ts', 'replay-cache.example.json']) {
			if (!cli.includes(key)) { stale.push(`qa_agent.py 的模板映射没登记 ${key}`); }
		}
		// spec-task.command 从不被引擎执行、只在报告里展示 ⇒ 写错 CLI 名可以长期潜伏。
		// 钉住函数体必须指向随包 CLI 的真实子命令，且不得再出现迁移前的旧 CLI 名。
		const specCmd = /def command_for_spec_task\([\s\S]*?\n\ndef /.exec(cli);
		if (!specCmd) {
			stale.push('qa_agent.py 里找不到 command_for_spec_task 函数体');
		} else {
			if (/ming-?qa/.test(specCmd[0])) { stale.push('spec-task.command 仍引用迁移前的旧 CLI 名'); }
			for (const sub of ['run-with-env', 'run-e2e']) {
				if (!specCmd[0].includes(sub)) { stale.push(`spec-task.command 缺少真实子命令 ${sub}`); }
			}
		}
	}
	if (!coreRefs.includes('spec-task.command 契约')) {
		stale.push('qa-core 没有写明 spec-task.command 仅作展示、不供直接执行');
	}
	for (const ref of ['visual-check.md', 'e2e-regression.md']) {
		const refPath = join(BUNDLED_SKILL_ROOT, 'qa-core', 'references', ref);
		if (existsSync(refPath) && /python <SKILL_DIR>\//.test(readFileSync(refPath, 'utf8'))) {
			stale.push(`references/${ref} 仍有不带引号的 <SKILL_DIR> 调用（复制执行会触发 shell 重定向）`);
		}
	}
	const repair = join(BUNDLED_SKILL_ROOT, 'qa-execution-repair', 'SKILL.md');
	if (!existsSync(repair)) {
		stale.push('qa-execution-repair/SKILL.md 缺失');
	} else {
		const text = readFileSync(repair, 'utf8');
		if (!text.includes('不改产品代码') || /修产品代码/.test(text)) {
			stale.push('qa-execution-repair 仍在指示修改产品代码');
		}
		if (!text.includes('run-e2e')) { stale.push('qa-execution-repair 没有用 run-e2e 跑 Playwright'); }
	}
	if (stale.length) {
		console.error('[check-skill-tool-refs] ✗ QA 链口径问题：');
		for (const s of stale) { console.error(`    · ${s}`); }
		process.exit(1);
	}
	console.log('  ✓ QA 链：MCP 已挂载 / 回归与视觉资产在位 / 阶段 4 只报不修');
}

if (danglingRows.length === 0) {
	console.log('  ✓ 所有引用的工具名都在清单里');
	process.exit(0);
}

console.log(`  ✗ ${danglingRows.length} 个技能引用了不存在的工具：`);
for (const row of danglingRows) {
	problems.push(row.rel);
	console.log(`    · ${row.rel}　${row.tools.join(', ')}`);
}
console.log(`\n[check-skill-tool-refs] ✗ ${problems.length} 项问题`);
console.log('修法：把正文里的旧工具名换成本环境的（映射表见 dsh-plugins/scripts/skill-tool-map.mjs）；');
console.log('      映射为 null 的（tapd_*/p4_*/unreal_screenshot 等）要么补工具，要么删掉该技能。');
process.exit(1);
