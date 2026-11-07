#!/usr/bin/env node
/**
 * IDE 侧技能/工具逻辑退役守卫（P3，2026-11-07）。
 *
 * 为什么需要它：这几轮摘掉的链路（内置工具 provider 注册、技能商城编辑器 +
 * 页面桥、沉淀技能 controller、生命周期事件总线）**旧代码照样能编译**，
 * 被复制粘贴/合并冲突抄回来时 `tsgo` 一点反应都没有，真机上却会变成
 * 「两份技能真源」「点了没反应」「装好了看不见」。所以用源码级字符串断言
 * 把「不许回来」钉死，并同时确认 dsh 侧的替代能力在位。
 *
 * 注意：禁串要选**代码形态**而不是光秃秃的符号名 —— 退役说明的注释里
 * 会保留这些名字，用 `includes('openSkillMarket')` 会误报 ✗。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './scripts/skill-bundle-paths.mjs';

let failed = 0;
const ok = msg => console.log(`  ✓ ${msg}`);
const fail = msg => { console.error(`  ✗ ${msg}`); failed += 1; };
const abs = rel => join(REPO_ROOT, rel);
const read = rel => readFileSync(abs(rel), 'utf8');

// ── ① 已删除的 IDE 侧文件不许重建 ────────────────────────────────────────
const REMOVED = [
	'resources/.agents/skills',
	'resources/.agents/tools',
	'src/vs/sessions/contrib/agentStudio/browser/skillMarketEditorPane.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillMarketEditorInput.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillExtractionController.ts',
	'src/vs/sessions/contrib/agentStudio/common/extractSkill.ts',
	'src/vs/sessions/contrib/agentStudio/common/skillLifecycle.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillLifecycleService.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillManagerTool.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillUsageTracker.ts',
	'src/vs/sessions/contrib/agentStudio/browser/installers/skillInstaller.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillInstallService.ts',
	'src/vs/sessions/contrib/agentStudio/browser/skillVersionService.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/knowledgeStorageTools.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/toolExecutor.ts',
	'src/vs/sessions/contrib/agentStudio/common/skillHubTypes.ts',
	'src/vs/sessions/contrib/agentStudio/common/skillGitInstall.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/handoffTools.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/planModeTools.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/workflowTool.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/coreTools.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/mermaidTools.ts',
	'src/vs/sessions/contrib/agentStudio/browser/providers/tool/processTools.ts',
];
for (const rel of REMOVED) {
	if (existsSync(abs(rel))) { fail(`已退役的 IDE 侧路径被重建：${rel}`); }
}
if (!failed) { ok(`${REMOVED.length} 个已退役的 IDE 侧技能/工具路径都不存在`); }

// ── ② 摘除的接线不许被抄回来 ────────────────────────────────────────────
const FORBIDDEN = {
	'src/vs/sessions/contrib/agentStudio/browser/resourceManagerEditorPane.ts': [
		'@ISkillRegistry', '@ISkillInstallService', '@ISkillVersionService',
		'skillVersionService.autoCommit(', 'skillInstallService.uninstallSkill(', '_renderSkillTab(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts': [
		'BuiltinToolProvider', '_registerBuiltinTools', "id: 'agentStudio.openSkillMarket'",
		'SkillInstallAutoOpenContribution', 'registerSingleton(ISkillLifecycleService',
		'SkillMarketEditorPane', 'SkillMarketEditorInput',
		'registerSingleton(ISkillRegistry', 'registerSingleton(ISkillInstallService',
		'registerSingleton(ISkillVersionService',
	],
	'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts': [
		'new SkillExtractionController(', '_skillExtract', '_currentAgentSkills',
		'_skillRegistry', '@ISkillRegistry',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioWebviewController.ts': [
		'@ISkillRegistry', 'this.skillRegistry.getSkills()',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts': [
		'@ISkillRegistry', 'this.skillRegistry.getSkill(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts': [
		'extractSkillContent', "import('../common/extractSkill.js')",
	],
	'src/vs/sessions/contrib/agentStudio/browser/views/integrationView.ts': [
		'SkillMarketEditorInput', '@ISkillRegistry', '@ISkillInstallService', '@ISkillVersionService',
		'_buildSkillsDom(', '_renderSkillsList(', "{ id: 'skill'", "'skill' | 'mcp'",
	],
	'src/vs/sessions/contrib/agentStudio/browser/packageInstallerRegistry.ts': [
		'createInstance(SkillInstaller)', 'installers/skillInstaller.js',
	],
	'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts': [
		'skillRegistry.reload()', '@ISkillRegistry',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentMarketEditorPane.ts': [
		'this.skillRegistry.getSkill(', '@ISkillRegistry',
	],
	'src/vs/sessions/contrib/chat/browser/newChatInput.ts': [
		'_handleSkillCommand(', '@ISkillRegistry', 'this.skillRegistry.getSkill(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts': [
		'@ISkillRegistry', 'this._skillRegistry.getSkills()', 'this._skillRegistry.resolveActivations(',
	],
	'src/vs/sessions/contrib/agentStudio/browser/workflowExecutionService.ts': [
		'@ISkillRegistry', '_resolveWorkflowSkill(', '_executeWorkflowAndAwait(',
	],
	'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts': [
		'openSkillMarket: ()',
	],
	'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts': [
		"case 'openSkillMarket'",
	],
	'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts': [
		"method: 'openSkillMarket'", "case 'openSkillMarket'",
	],
	'src/vs/sessions/contrib/dshHarness/common/dshIdeCapabilities.ts': [
		"case 'skills'", 'reloadSkills?:', 'env.reloadSkills', "'reloadSkills'",
	],
	'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts': [
		'@ISkillRegistry', 'FileAccess.asFileUri(\'vs/../../resources/.agents/skills\')',
	],
};
for (const [rel, needles] of Object.entries(FORBIDDEN)) {
	let src;
	try { src = read(rel); } catch { fail(`找不到要检查的文件：${rel}`); continue; }
	const back = needles.filter(n => src.includes(n));
	if (back.length) { fail(`${rel} 里旧接线被抄回来了：${back.join(' / ')}`); }
}
if (!failed) { ok(`${Object.keys(FORBIDDEN).length} 个源码文件的旧接线都没有回来`); }

// ── ③ dsh 侧替代能力必须在位（否则上面的删除就是「砍了没接」） ───────────
const REQUIRED = {
	'src/vs/sessions/contrib/agentStudio/browser/marketplaceService.ts': [
		'技能安装已迁到 dsh 侧',
	],
	'dsh-plugins/vssaros-skill-bundle/cordis.patch.yml': ['bundledSkillDir'],
	'dsh-plugins/vssaros-skills/lib/index.js': [
		'/x/skills/api/manage', '/x/skills/api/drafts', 'state.providerControl?.invalidate()',
	],
	'dsh-plugins/vssaros-marketplace/lib/dispatch.js': [
		"'installSkillContent'", "'listSkillHub'",
	],
};
for (const [rel, needles] of Object.entries(REQUIRED)) {
	let src;
	try { src = read(rel); } catch { fail(`找不到替代能力文件：${rel}`); continue; }
	const missing = needles.filter(n => !src.includes(n));
	if (missing.length) { fail(`${rel} 缺了替代能力：${missing.join(' / ')}`); }
}
if (!failed) { ok('IDE 商城的 skill 安装拒绝分支 + dsh 侧自持挂载 / 创建草稿 / 4 类来源 / Hub 列表都在位'); }

// ── ④ 注入点数量只许减不许增（把「逐步收敛」变成机器门禁） ──────────
// 与 `check-legacy-freeze.mjs` 同款：真要新增注入必须显式调上限并写明理由，
// 否则一次合并冲突/复制粘贴就能把已经摘掉的服务悄悄接回来。
const INJECTION_ROOTS = [
	'src/vs/sessions/contrib/agentStudio',
	'src/vs/sessions/contrib/chat',
];
const MAX_IDE_SKILL_REGISTRY_INJECTIONS = 0;
function countInjections(dir) {
	let n = 0;
	for (const entry of readdirSync(abs(dir), { withFileTypes: true })) {
		const rel = `${dir}/${entry.name}`;
		if (entry.isDirectory()) { n += countInjections(rel); continue; }
		if (!rel.endsWith('.ts')) { continue; }
		for (const line of readFileSync(abs(rel), 'utf8').split(/\r?\n/)) {
			// 只认**注入行**（trim 后以 @ 开头）；退役注释里提到名字不算。
			if (/^\s*@ISkillRegistry\b/.test(line)) { n += 1; }
		}
	}
	return n;
}
const injections = INJECTION_ROOTS.reduce((n, dir) => n + countInjections(dir), 0);
if (injections > MAX_IDE_SKILL_REGISTRY_INJECTIONS) {
	fail(`IDE 侧 @ISkillRegistry 注入回升到 ${injections} 个（上限 ${MAX_IDE_SKILL_REGISTRY_INJECTIONS}）⇒ 有旧接线被抄回来`);
} else {
	ok(`@ISkillRegistry 注入 ${injections} 个 ≤ 上限 ${MAX_IDE_SKILL_REGISTRY_INJECTIONS}（只许继续减）`);
}

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ IDE 侧技能/工具退役状态保持完整');
process.exit(failed ? 1 : 0);
