/*
 * 守卫：`resources/office-skills`（本仓副本）与上游 `@deepseek-ai/dsh-skill-office/assets` 的差异必须**全部登记**。
 *
 * 为什么需要：这 7 个技能是上游随包资产，本仓只做**少量有意改写**（sidecar 下载指引 → 随包附带、
 * 路由技能追加"本部署运行时"一节）。升级 dsh 时我们会重新复制一份 assets ⇒ **改写会被覆盖掉**，
 * 而现象是"模型又去 npm 装引擎"—— 没有守卫时只能靠人记得。反过来，如果有人误把上游某段删了 /
 * 改了（例如 2026-11-02 那次误删 `present` 交付句），这里也会红。
 *
 * 判据（三句话）：
 *   ① assets 里的文件在副本里**缺失** ⇒ 必须在 ALLOWED 且理由写清（本仓有意删除）；
 *   ② 副本内容与 assets **不同** ⇒ 必须在 ALLOWED 且理由写清（本仓有意改写）；
 *   ③ 副本里有 assets 没有的文件 ⇒ 一律报错（我们的副本不该自造文件）。
 *
 * 官方 assets 从仓库内 `dsh-runtime/<bundled>/…` 取（`build/prepack-dsh-runtime.mjs` 的产物）。
 * 干净检出里没有它 ⇒ 打印 ⚠ 并**跳过**（不是失败）：这是"依赖缺失"，不是"判据失效"。
 * 跑法：node dsh-plugins/check-office-skills.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COPY = join(ROOT, 'resources', 'office-skills');

/**
 * 有意差异登记：相对 assets 的路径 → 理由。
 * ⚠ 只登记"我们主动做的改动"；上游新增的改动**不该**出现在这里（那说明我们漏同步）。
 */
const ALLOWED = new Map([
	['office/SKILL.md', '追加「本部署的运行时」一节：Python 只认 load_workspace_dependencies、Kit 随包附带、交付用 present 并附绝对路径（预览侧栏禁用）、禁止 Compress-Archive 拼 OOXML、Word 模板走 office-template 技能'],
	['office-render/SKILL.md', 'sidecar 下载指引 → 「Kit 随包附带，失败如实报告」（present 交付句保持上游原文）'],
	['office-recalculate/SKILL.md', '同上'],
	['office-export-pdf/SKILL.md', '同上'],
	['office/references/sidecar.md', '本仓删除：Kit 随包附带，且 payload 无 node/pnpm —— 保留它会诱导模型联网安装 182MB 引擎'],
	// ⚠ 2026-11-02 更正：office-docx / office-pptx / office-xlsx **不再登记** —— 它们已恢复为上游原文。
	//   当初把它们的 `present` 交付改成"存工作区 + 回路径"，依据是"本仓没有 present 工具"，那是查错了包
	//   （看的是 dsh-agent-tool-presentation）；真正提供 `present` 的是 `@deepseek-ai/dsh-tool-present`，
	//   rc.2 / alpha.3 都在，真机工具面里也在。⇒ 若再有人改它们，这里会红（这正是我们要的）。
]);

function bundledVersion() {
	try {
		const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh-plugins', 'dsh-compat.json'), 'utf8'));
		return String(manifest.bundled ?? '').trim();
	} catch {
		return '';
	}
}

const version = bundledVersion();
const assets = version
	? join(ROOT, 'dsh-runtime', version, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets')
	: '';

console.log('[check-office-skills] 本仓 office 技能副本 ↔ 上游 assets 的差异对账');

// ─── 接线对账（2026-11-02）────────────────────────────────────────────────────
// 这条**放在 assets 检查之前**：干净检出里没有 `dsh-runtime/`（下面会跳过差异对账），
// 但接线三处照样能查 ⇒ 不能因为"依赖缺失"就把接线检查一起跳过（那是假绿）。
//
// 模板插件要真正可用，四处必须同时成立；少任何一处，现象都是"插件装了但工具不出现"：
//   ① 伴生安装清单把它装进 profile（纯 host 工具插件没有 `vssaros.module`，模块自发现收不到）；
//   ② channel 把源码目录交给 supervisor；
//   ③ overlay 按 id 覆盖它的 config（`runtimePath` → Office 负载基目录）；
//   ④ 插件自带 `cordis.patch.yml` 用同 id 建行（否则 ③ 打空且静默）。
// 2026-11-02 实际踩过：先只改了 overlay，插件没装 ⇒ Host 打印 entry not found。
{
	const readSrc = rel => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
	const supervisorSrc = readSrc('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
	const channelSrc = readSrc('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts');
	const cliSrc = readSrc('src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
	const pluginPatch = readSrc('dsh-plugins/vssaros-office-template/cordis.patch.yml');
	let pluginPkg = {};
	try { pluginPkg = JSON.parse(readFileSync(join(ROOT, 'dsh-plugins/vssaros-office-template/package.json'), 'utf8')); } catch { /* 下面报 */ }

	const wiring = [
		['插件包名是 @vssaros/dsh-office-template', pluginPkg.name === '@vssaros/dsh-office-template',
			'package.json 的 name 变了 ⇒ 伴生清单与 overlay 都要跟着改'],
		['伴生清单含 DSH_OFFICE_TEMPLATE_PLUGIN_NAME（否则 profile 里没有它 ⇒ overlay 报 entry not found）',
			supervisorSrc.includes('[DSH_OFFICE_TEMPLATE_PLUGIN_NAME,'),
			'在 dshHostSupervisor 的 `const plugins` 里补一行'],
		['channel 传 officeTemplatePluginDir', channelSrc.includes('officeTemplatePluginDir:'),
			'在 dshHarnessChannel 构造 supervisor 时补该字段（照 browserPluginDir 的样子）'],
		['overlay 按 id 覆盖 config（- id: vssaros-office-template）', cliSrc.includes('- id: vssaros-office-template'),
			'renderOfficeOverlay 里补这一行；⚠ 不能用 `- insert:`（插件自带 patch 已 insert，同 id 会撞行）'],
		['overlay 传 runtimePath', cliSrc.includes('runtimePath:'),
			'renderOfficeOverlay 里给该行 config.runtimePath = officeBase'],
		['插件自带 patch 行（cordis.patch.yml）', pluginPatch.includes('id: vssaros-office-template'),
			'否则 overlay 的 `- id:` 打空且静默'],
		// ★ 2026-11-02 真机事故：这**不是**可选加固 —— 少这两行时 7 个 Office 技能会静默消失
		//   （cordis 从 profile 的 node_modules 解析包名，而这两个包不在 dsh 默认依赖树里）。
		['伴生清单装官方两个 Office 包（否则 profile 解析不到 ⇒ 技能静默缺失）',
			supervisorSrc.includes("'@deepseek-ai/dsh-skill-office'") && supervisorSrc.includes("'@deepseek-ai/dsh-tool-workspace-dependencies'"),
			'在 dshHostSupervisor 的 `const plugins` 里补两行（用 resolveSiblingPackage 取 runtime 里那份）'],
		// ★ 2026-11-02 真机事故（"模型看不到任何技能"）：host 平面 tool-skill 被重新启用 ⇒ 与 preset 里那份
		//   形成两实例，host 那份在 waterfall 外层把 preset 发出的 skill-catalog 删掉（详见 vssaros-skills/cordis.patch.yml）。
		['host 平面不重新启用 tool-skill（否则技能目录被删 ⇒ Office 技能对模型不可见）',
			!readdirSync(join(ROOT, 'dsh-plugins'), { withFileTypes: true })
				.filter(entry => entry.isDirectory())
				.some(entry => /^\s*-\s*id:\s*tool-skill\s*$[\s\S]{0,80}?disabled:\s*false/m.test(readSrc(`dsh-plugins/${entry.name}/cordis.patch.yml`))),
			'删掉插件 cordis.patch.yml 里的 `- id: tool-skill / disabled: false`；技能机制只在 preset 里'],
	];
	const brokenWiring = wiring.filter(([, ok]) => !ok);
	if (brokenWiring.length) {
		console.error('  ❌ Office 模板插件接线不完整 ⇒ 工具不会出现在会话里：');
		for (const [label, , hint] of brokenWiring) {
			console.error(`     · ${label}`);
			console.error(`       修法：${hint}`);
		}
		process.exit(1);
	}
	console.log(`  ✓ 模板插件接线完整（${wiring.length} 处：安装清单 / channel / overlay / 自带 patch）`);
}

if (!existsSync(COPY)) {
	console.error(`  ❌ 副本不存在：${COPY}（resources/office-skills 是本仓源文件，必须入库）`);
	process.exit(1);
}
if (!assets || !existsSync(assets)) {
	console.log(`  ⚠ 找不到官方 assets（${assets || '<dsh-compat.json 缺 bundled>'}）`);
	console.log('     ⇒ 跳过对账。这是"依赖缺失"而不是判据失效：跑过 `node build/prepack-dsh-runtime.mjs` 后再跑本守卫。');
	process.exit(0);
}

const walk = dir => {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
};

const upstreamFiles = walk(assets).map(file => relative(assets, file).replace(/\\/g, '/')).sort();
const copyFiles = walk(COPY).map(file => relative(COPY, file).replace(/\\/g, '/')).sort();
const copySet = new Set(copyFiles);

const changed = [];
const removed = [];
for (const rel of upstreamFiles) {
	if (!copySet.has(rel)) {
		removed.push(rel);
		continue;
	}
	if (readFileSync(join(assets, rel)).compare(readFileSync(join(COPY, rel))) !== 0) {
		changed.push(rel);
	}
}
const upstreamSet = new Set(upstreamFiles);
const added = copyFiles.filter(rel => !upstreamSet.has(rel));

const unregistered = [
	...changed.filter(rel => !ALLOWED.has(rel)).map(rel => `改写未登记：${rel}`),
	...removed.filter(rel => !ALLOWED.has(rel)).map(rel => `删除未登记：${rel}`),
	...added.map(rel => `本仓多出上游没有的文件：${rel}`),
];

console.log(`  上游 ${upstreamFiles.length} 个文件 / 副本 ${copyFiles.length} 个`);
console.log(`  有意改写 ${changed.length} · 有意删除 ${removed.length} · 多余 ${added.length}`);

// 反向检查：登记了但我们其实**没改**（说明上游已同步，这条登记该删）
const staleRegistrations = [...ALLOWED.keys()].filter(rel => !changed.includes(rel) && !removed.includes(rel));
if (staleRegistrations.length) {
	console.log(`  ⚠ 以下登记已过期（上游就是这份内容，或本仓文件已不存在）：${staleRegistrations.join(', ')}`);
	console.log('     ⇒ 从 check-office-skills.mjs 的 ALLOWED 里删掉这些条目，否则它会把"真的漂移"掩盖掉。');
}

if (unregistered.length) {
	console.error('  ❌ 存在未登记差异 ⇒ 升级 dsh 后改写可能被覆盖，或有人误改了上游文本：');
	for (const item of unregistered) {
		console.error(`     · ${item}`);
	}
	console.error('    处理：确认是"本仓有意改动"就登记进 ALLOWED（写清理由）；否则把副本恢复成上游内容。');
	process.exit(1);
}

console.log(`  ✓ 所有差异都已登记（改写 ${changed.length} 处 + 删除 ${removed.length} 处；其余与上游逐字节一致）`);
