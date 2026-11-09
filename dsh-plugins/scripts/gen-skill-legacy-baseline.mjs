#!/usr/bin/env node
/*
 * 重生成「技能正文里的 IDE 退役工具名」技术债基线。
 *
 * 为什么需要基线：随包技能里有 60+ 份从外部迁来的文档，正文仍在教模型调
 * `terminal(...)` / `file_read(...)` 这类 dsh 会话里不存在的名字。一次性改写
 * 会破坏第三方文档原意，所以采用「只许减不许增」的冻结策略：
 *   · 新增一处旧名 ⇒ check-skill-tool-refs.mjs 判红；
 *   · 修掉一处旧名 ⇒ 也要重跑本脚本销账（守卫会提示基线漂移）。
 * 9 个 QA/浏览器技能是零容忍区，不进基线（它们必须一个旧名都没有）。
 *
 * 用法：node dsh-plugins/scripts/gen-skill-legacy-baseline.mjs
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLED_SKILL_ROOT } from './skill-bundle-paths.mjs';
import { scanLegacyIdeToolRefs } from './skill-tool-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'skill-legacy-tool-refs.baseline.json');
const ZERO_TOLERANCE = new Set([
	'qa-context-profiling', 'qa-risk-analysis', 'qa-case-design',
	'qa-script-generation', 'qa-execution-repair', 'qa-quality-review',
	'qa-acceptance-report', 'qa-core', 'dogfood',
]);

const rows = {};
for (const entry of readdirSync(BUNDLED_SKILL_ROOT, { withFileTypes: true })) {
	if (!entry.isDirectory() || ZERO_TOLERANCE.has(entry.name)) { continue; }
	const file = join(BUNDLED_SKILL_ROOT, entry.name, 'SKILL.md');
	if (!existsSync(file)) { continue; }
	const hits = scanLegacyIdeToolRefs(readFileSync(file, 'utf8'));
	if (hits.length) { rows[`${entry.name}/SKILL.md`] = hits; }
}

writeFileSync(OUT, JSON.stringify({
	note: '已知技术债：正文里的 IDE 退役工具名。只许减不许增；修掉后重跑 gen-skill-legacy-baseline.mjs 销账。',
	rows,
}, null, 2) + '\n', 'utf8');

const total = Object.values(rows).reduce((n, list) => n + list.length, 0);
console.log(`[gen-skill-legacy-baseline] ${Object.keys(rows).length} 份技能 / ${total} 个旧名已登记 → ${OUT}`);
