/*
 * 守卫：每个技能的 SKILL.md 都必须能被 DSH 加载。
 *
 * 为什么必须有（2026-11-06 真机）：`dsh-plugins/vssaros-skill-bundle/skills` 的 173 个随包技能里，57 个被 DSH 的
 * `skill-filesystem` 静默丢弃（Host 日志 `skill file … ignored`），技能目录里根本没有它们 ——
 * bot 声明的 code-review / code-gen / refactor / anysearch 全在其中，模型想用也用不了。原因两类：
 *   · 45 个 frontmatter 解析失败：description 没加引号又含「冒号 + 空格」，YAML 把它当成嵌套映射；
 *   · 12 个技能名不合法：写成了显示名（`name: Code Review`），DSH 只认小写短横线。
 * 旧守卫（check-agent-tools / check-skill-tool-refs）只查名字和正文，没查「DSH 能不能读」，所以一直是绿的。
 *
 * 判据与 DSH 逐条一致（dsh-skill-filesystem lib/index.js `parseFrontmatter` / `stringField` /
 * `parseInvocationPolicy`，dsh-skill `SKILL_NAME`）：
 *   ① 第一行是 `---`，之后有一行单独的 `---` 收尾；
 *   ② 中间用 **DSH 自带的 yaml 包**（仓库 dsh-runtime/<随包版本>/node_modules/yaml）解析成对象；
 *   ③ name、description 是非空字符串；name 符合 /^[a-z0-9]+(?:-[a-z0-9]+)*$/；
 *   ④ 不用旧键 disableModelInvocation / modelInvocable / userInvocable；
 *      disable-model-invocation / user-invocable 若写了必须是布尔（或 DSH 认的 1/0/yes/no/on/off/true/false）。
 * 另加一条 DSH 不查、但我们要的：⑤ name 与目录名一致（bot 的 `skills:` 写的是目录名，不一致就对不上）。
 *
 * 扫描面：随包技能根的顶层 `<name>/SKILL.md`（DSH 的 provider 只读一层）。用户技能根只报告、不判失败。
 * 干净检出没有 dsh-runtime/ 时，YAML 一项跳过（会说明），其余照查。
 *
 * 跑法：node dsh-plugins/check-skill-frontmatter.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, primaryBundledSkillRoot, USER_SKILL_ROOTS } from './scripts/skill-bundle-paths.mjs';

// ★ P0（2026-11-06）：随包技能真源迁到 dsh 侧 ⇒ 路径一律取单一真源模块，不再硬编码。
const ROOT = REPO_ROOT;
const BUNDLED_ROOT = primaryBundledSkillRoot();
const USER_ROOTS = USER_SKILL_ROOTS;

/** DSH 的技能名规则（dsh-skill `SKILL_NAME`）。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LEGACY_KEYS = { disableModelInvocation: 'disable-model-invocation', modelInvocable: 'disable-model-invocation', userInvocable: 'user-invocable' };
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0']);

/** 随包运行时里的 yaml 包（与 DSH 同一份）；找不到 ⇒ undefined。优先 compat 清单的 bundled 版本。 */
export function loadDshYaml(root = ROOT) {
	const base = join(root, 'dsh-runtime');
	if (!existsSync(base)) { return undefined; }
	let bundled;
	try { bundled = JSON.parse(readFileSync(join(root, 'dsh-plugins', 'dsh-compat.json'), 'utf8')).bundled; } catch { bundled = undefined; }
	const versions = readdirSync(base).filter((v) => existsSync(join(base, v, 'node_modules', 'yaml', 'package.json')));
	const pick = versions.includes(bundled) ? bundled : versions.sort().at(-1);
	if (!pick) { return undefined; }
	try { return { version: pick, yaml: createRequire(join(base, pick, 'node_modules', '_.js'))('yaml') }; } catch { return undefined; }
}

/**
 * 按 DSH 的规则检查一份 SKILL.md。
 * @param parse  yaml 的 `parse`；不给 ⇒ 跳过 YAML 解析，只做不依赖解析的检查
 * @returns 问题列表（空 = DSH 能加载）
 */
export function skillProblems(raw, dirName, parse) {
	// 逐字照搬 DSH 的切片（parseFrontmatter / findClosingFrontmatter）：块里保留收尾 `---` 前的换行。
	//   2026-11-06 踩过：自己用 split/join 切，CRLF 文件最后一行会剩个孤立的 `\r`，YAML 误报 10 个本来能读的技能。
	//   BOM 也不剥：DSH 不剥，带 BOM 的文件在 DSH 那里就是「缺 frontmatter」。
	const text = String(raw);
	const firstEnd = text.indexOf('\n');
	if (firstEnd < 0 || text.slice(0, firstEnd).replace(/\r$/, '') !== '---') { return ['缺 YAML frontmatter（第一行必须是 ---；文件不能带 BOM）']; }
	const start = firstEnd + 1;
	let closing;
	for (let lineStart = start; lineStart <= text.length;) {
		const next = text.indexOf('\n', lineStart);
		const lineEnd = next < 0 ? text.length : next;
		if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') { closing = lineStart; break; }
		if (next < 0) { break; }
		lineStart = next + 1;
	}
	if (closing === undefined) { return ['frontmatter 没有收尾的 ---']; }
	if (!parse) { return []; }
	let data;
	try { data = parse(text.slice(start, closing)); } catch (error) { return [`YAML 解析失败：${String(error?.message ?? error).split('\n')[0]}`]; }
	if (typeof data !== 'object' || data === null || Array.isArray(data)) { return ['frontmatter 不是键值对象']; }
	const problems = [];
	const name = typeof data.name === 'string' && data.name.length ? data.name : undefined;
	const description = typeof data.description === 'string' && data.description.length ? data.description : undefined;
	if (!name) { problems.push('name 缺失或不是字符串'); }
	if (!description) { problems.push('description 缺失或不是字符串'); }
	if (name && !SKILL_NAME.test(name)) { problems.push(`技能名「${name}」不合法（只能是小写字母、数字和短横线）`); }
	if (name && SKILL_NAME.test(name) && dirName && name !== dirName) { problems.push(`技能名「${name}」与目录名「${dirName}」不一致`); }
	for (const [legacy, canonical] of Object.entries(LEGACY_KEYS)) {
		if (Object.hasOwn(data, legacy)) { problems.push(`旧键 ${legacy} 不再支持，改用 ${canonical}`); }
	}
	for (const key of ['disable-model-invocation', 'user-invocable']) {
		if (!Object.hasOwn(data, key)) { continue; }
		const value = data[key];
		if (typeof value === 'boolean' || value === 0 || value === 1) { continue; }
		if (typeof value === 'string' && BOOLEAN_WORDS.has(value.toLowerCase())) { continue; }
		problems.push(`${key} 必须是布尔值`);
	}
	return problems;
}

function scan(root, parse) {
	if (!existsSync(root)) { return []; }
	const out = [];
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) { continue; }
		const file = join(root, dir.name, 'SKILL.md');
		if (!existsSync(file)) { continue; }
		out.push({ dir: dir.name, file, problems: skillProblems(readFileSync(file, 'utf8'), dir.name, parse) });
	}
	return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const loaded = loadDshYaml();
	if (!loaded) { console.log('[check-skill-frontmatter] SKIP YAML 解析：没有 dsh-runtime/*/node_modules/yaml（干净检出时正常；装上运行时后自动生效）'); }
	const bundled = scan(BUNDLED_ROOT, loaded?.yaml.parse);
	const bad = bundled.filter((item) => item.problems.length);
	for (const item of bad) { console.error(`✗ dsh-plugins/vssaros-skill-bundle/skills/${item.dir}/SKILL.md：${item.problems.join('；')}`); }
	for (const root of USER_ROOTS) {
		for (const item of scan(root, loaded?.yaml.parse).filter((entry) => entry.problems.length)) {
			console.log(`  提示（用户技能，不判失败）${item.file}：${item.problems.join('；')}`);
		}
	}
	if (bad.length) {
		console.error(`✗ check-skill-frontmatter：${bad.length}/${bundled.length} 个随包技能 DSH 读不了`);
		process.exit(1);
	}
	console.log(`[check-skill-frontmatter] ✓ ${bundled.length} 个随包技能都能被 DSH 加载${loaded ? `（yaml 取自 dsh-runtime/${loaded.version}）` : '（YAML 一项已跳过）'}`);
}
