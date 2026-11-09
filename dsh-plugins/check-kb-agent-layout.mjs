#!/usr/bin/env node
/*
 * 知识库 agent 的「目录口径 + 单 agent 收敛」守卫（2026-11-09）。
 *
 * 背景：2026-11-02 把两个顶层目录从 `库/` + `笔记/` 改名为
 * `数据源/` + `知识库列表/`；2026-11-09 又把「内置 knowledge-base-expert +
 * 数据根 kb-expert」双轨收敛为**只用内置 agent**，且用户明确不要存量会话
 * 兼容层（不留别名 preset、不留归一化、不留 legacyClawAlias.js）。
 * 两件事都容易在注释、技能文案、宿主候选表、注册层里悄悄漂回去，故钉成一条链。
 *
 * 用户数据根是本机状态 ⇒ 只报告不判失败（与 check-agent-tools.mjs 同口径）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { USER_SKILL_ROOTS } from './scripts/skill-bundle-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));   // <repo>/dsh-plugins
const ROOT = dirname(HERE);                              // <repo>
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let problems = 0;
function t(label, ok, detail = '') {
	if (ok) { console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`); }
	else { problems += 1; console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// 旧路径字面量判据。只认「反引号/粗体 + 旧名 + /」或裸 `库/raw` / `笔记/`，
// 不误伤「笔记区」概念俗称与「`库` / `笔记` 是旧称」这类说明文字。
const hasLegacyPath = (text) => /`库\/|`笔记\/|\*\*库\/|\*\*笔记\/|库\/raw|笔记\//.test(String(text ?? ''));

// ── 0. 判据自证（防止守卫空跑）──────────────────────────────────────────
t('判据自证：旧路径能命中（含表格里的 **库/** 写法）',
	hasLegacyPath('素材 `库/raw` 与 `笔记/`') && hasLegacyPath('| **库/** |'));
t('判据自证：新名与旧称说明不误报',
	!hasLegacyPath('素材 `数据源/raw` 与 `知识库列表/`；`库` / `笔记` 是 2026-11-02 改名前旧称'));

// ── 1. 目录常量是唯一事实源，IDE 与 dsh 两侧一致 ────────────────────────
const vaultFs = read('src/vs/sessions/contrib/agentStudio/browser/knowledge/kbVaultFs.ts');
const kbCore = read('dsh-plugins/vssaros-kb/lib/core/kb.js');
const constOf = (src, name) => new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(src)?.[1];
const ideLib = constOf(vaultFs, 'KB_LIBRARY_SUBPATH');
const ideNotes = constOf(vaultFs, 'KB_NOTES_SUBPATH');
const dshLib = constOf(kbCore, 'LIBRARY_DIR');
const dshNotes = constOf(kbCore, 'NOTES_DIR');
t('IDE 侧目录常量 = 数据源 / 知识库列表',
	ideLib === '数据源' && ideNotes === '知识库列表', `${ideLib} / ${ideNotes}`);
t('dsh 侧目录常量与 IDE 一致',
	dshLib === ideLib && dshNotes === ideNotes, `${dshLib} / ${dshNotes}`);
t('旧名只以 *_LEGACY 存在',
	/LIBRARY_DIR_LEGACY\s*=\s*'库'/.test(kbCore) && /NOTES_DIR_LEGACY\s*=\s*'笔记'/.test(kbCore));

// ── 2. 内置 prompt 与三份技能文案零残留 ────────────────────────────────
const builtin = read('src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts');
const kbStart = builtin.indexOf("id: 'knowledge-base-expert'");
const kbEnd = builtin.indexOf("\n\t\t\tid: '", kbStart + 10);
const kbPrompt = kbStart >= 0 && kbEnd > kbStart ? builtin.slice(kbStart, kbEnd) : '';
t('抓到 knowledge-base-expert 的提示词段（守卫不能空跑）', kbPrompt.length > 1000, `${kbPrompt.length} 字符`);
t('内置 prompt 的目录表用新名',
	kbPrompt.includes('| **数据源/**') && kbPrompt.includes('| **知识库列表/**'));
t('内置 prompt 没有旧路径', !hasLegacyPath(kbPrompt));

for (const rel of ['kb-build', 'kb-game-teardown', 'web-content-import']) {
	const text = read(`dsh-plugins/vssaros-skill-bundle/skills/${rel}/SKILL.md`);
	t(`${rel}/SKILL.md 没有旧路径字面量`, !hasLegacyPath(text));
}

// ── 3. 单 agent 收敛：真源 / 候选表 / 落盘 / 无兼容层 ──────────────────
const workbenches = read('dsh-plugins/vssaros-workbenches/lib/client.js');
const kbIndex = read('dsh-plugins/vssaros-kb/lib/index.js');
const agentsIndex = read('dsh-plugins/vssaros-agents/lib/index.js');
const agentsCore = read('dsh-plugins/vssaros-agents/lib/core/agents.js');
const agentsPkg = read('dsh-plugins/vssaros-agents/package.json');

t('宿主候选表是单值内置 knowledge-base-expert',
	/'vssaros\/kb':\s*'vssaros-knowledge-base-expert'/.test(workbenches)
		&& !/'vssaros\/kb':\s*\[/.test(workbenches));
t('kb 插件不再落盘/迁移 kb-expert',
	!/ensureKbAgent\(/.test(kbIndex) && !/kbAgent\.js/.test(kbIndex));
t('kb 插件不再注册自己的 preset',
	!/KB_PRESET\b/.test(kbIndex));
// 用户决策：不要兼容层。别名 preset / 归一化 / 模块文件任何一处复现都判红。
t('注册层没有隐藏别名 preset 与旧 id 归一化',
	!agentsIndex.includes('__legacy:')
		&& !agentsIndex.includes('legacyAliasDefinition')
		&& !agentsIndex.includes('resolveLegacyPresetId')
		&& !agentsIndex.includes('legacyClawAlias'));
t('legacyClawAlias.js 已删除且不在随包清单里',
	!existsSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/core/legacyClawAlias.js'))
		&& !agentsPkg.includes('legacyClawAlias.js')
		&& !agentsCore.includes('legacyClawAlias'));
t('HIDDEN_AGENT_IDS 只保留 saros-claw 的独立隐藏需求',
	/HIDDEN_AGENT_IDS = new Set\(\['saros-claw'\]\)/.test(agentsCore)
		&& !/'kb-expert'/.test(agentsCore));
t('工作台守卫不再把 kb-expert 当当前候选',
	!read('dsh-plugins/check-assistant-collapse.mjs').includes('vssaros-kb-expert'));

// ── 4. 数据根副本：只报告（删文件是真机不可逆操作，留给人确认）────────
let staleCopies = 0;
for (const skillRoot of USER_SKILL_ROOTS) {
	const file = join(dirname(skillRoot), 'agents', 'kb-expert', '.agent.md');
	try {
		readFileSync(file, 'utf8');
		staleCopies += 1;
		console.log(`  提示（用户数据根，不判失败）${file} 仍在；无兼容层，建议备份后移除`);
	} catch { /* 已移除，正是目标状态 */ }
}
console.log(`  ℹ 数据根残留副本：${staleCopies} 份（只报告）`);

console.log(problems === 0
	? '\n[check-kb-agent-layout] ✓ 目录口径 / 单 agent 收敛 / 无兼容层全部通过'
	: `\n[check-kb-agent-layout] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
