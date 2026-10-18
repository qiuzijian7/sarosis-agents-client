// @vssaros/dsh-skills — `skill_manage` 的纯逻辑：**写**技能目录（create / edit / patch / delete）。
//
// 为什么这个文件存在（2026-10-12，报告 §R.7 的第 ① 项）：技能面要"完全归 dsh 侧" ✓，
// 而 dsh 侧此前只有"找"（`skill_search` ✓）与"取"（原生 `skill` 工具 ✓）—— **没有"写"** ✗。
// IDE 侧有 `skill_manage`（`browser/providers/tool/skillTools.ts` + `skill/SkillManagerTool` ✓），
// 本文件按**同一份契约**移植（方案 6.9 方案 C：契约共享、实现各自一份 ✓）：
//   · action：`create`（已存在则**失败** ✓）/ `edit`（全量覆盖 ✓）/ `patch`（精确替换，`old_string`
//     默认必须**唯一** ✓，`replace_all: true` 才全替换）/ `delete`（整目录删除 ✓）；
//   · 参数名沿用真源：`name` / `content` / `old_string` / `new_string` / `replace_all` / `category` ✓
//     （⚠ 与 dsh 的参数风格不同：dsh 那边是驼峰 ✓，但**这里照真源用下划线** ✗✓ —— 因为模型在
//     两个引擎里看到的是同一份文档/习惯，改名字只会让"同一个动作在两个引擎里要用不同参数" ✗）；
//   · `name` 规则照真源：小写字母/数字/连字符/下划线，≤64 ✓；单个技能正文上限 **256KB** ✓。
//
// ⚠ 本文件**不碰审批**：拦截在 `lib/index.js` 的 `tools/pre-execute` 闸里 ✓（写操作必须过闸 ✓，
//   与 kanban / kb / memory / workflow 同一把 ✓）。**纯函数**只负责"校验 + 落盘 + 围栏" ✓，
//   这样它可以在进程内直测（`p3-04` ✓），也不依赖 dsh 的任何东西 ✓。
//
// ⚠ **路径围栏**（安全关键 ✗）：`name` 拼出来的目录必须**落在技能根之内** ✓ ——
//   校验名字字符集已经挡住 `..` / 分隔符 ✓，这里再 resolve 一次做**双保险** ✓（防将来放宽名字规则 ✗）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SKILL_FILE } from './skills.js';

/** 单个技能正文上限（照 IDE 真源 ✓）。 */
export const MAX_SKILL_BYTES = 256_000;

/** 允许的 action（照 IDE 真源 ✓；`promote` 是重构 4 加的：草稿区 → 生效目录，见文件头）。 */
export const SKILL_MANAGE_ACTIONS = ['create', 'edit', 'patch', 'delete', 'promote'];

/** 草稿区目录（重构 4，2026-10-16）：`<skillsRoot>/.drafts/<name>/SKILL.md`。
 *  方案口径（持久化提示注入面，壳契约 §8 ⑤）：**新建只写草稿区**（不生效 ✓——模型新建的技能
 *  不该立刻进每轮的检索面 ✗），用户在页面上手动提升（`promote`）才进生效目录 ✓。
 *  edit/patch/delete 是"改/删已有的"（目标已在生效目录）⇒ 不是"安装" ⇒ 保持现状（审批闸已拦 ✓）。 */
export const DRAFTS_DIR = '.drafts';

/** 草稿区的技能目录（带围栏 ✓——与 skillDirOf 同一套双保险）。 */
export function draftDirOf(root, name) {
	const safe = assertSkillName(name);
	const dir = resolve(root, DRAFTS_DIR, safe);
	const fence = resolve(root, DRAFTS_DIR);
	if (dir !== fence && !dir.startsWith(fence + sep)) {
		throw new Error(`路径越界：${safe} 解析后不在草稿区之内（已拒绝）。`);
	}
	return dir;
}

/** 名字规则：小写字母/数字开头，之后可含 `-` `_`，总长 ≤64（照 IDE 真源 ✓）。 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 校验名字；不合法就抛（**不要**静默纠正 ✗ —— 静默改名的后果是"模型以为建了 A，其实建了 B" ✗）。 */
export function assertSkillName(name) {
	const value = typeof name === 'string' ? name.trim() : '';
	if (!value) { throw new Error('name 不能为空：技能名要小写字母/数字开头，可含 - 与 _（≤64 字符）。'); }
	if (!SKILL_NAME_RE.test(value)) {
		throw new Error(`name 不合法：${value} —— 只允许小写字母/数字/连字符/下划线，且 ≤64 字符（如 code-review）。`);
	}
	return value;
}

/** 技能的目录（带围栏 ✓）：解析后必须仍在技能根之内，否则抛。 */
export function skillDirOf(root, name) {
	const safe = assertSkillName(name);
	const dir = resolve(root, safe);
	const fence = resolve(root);
	if (dir !== fence && !dir.startsWith(fence + sep)) {
		throw new Error(`路径越界：${safe} 解析后不在技能根之内（已拒绝）。`);
	}
	return dir;
}

/** 正文的基本健全性：必须有 frontmatter 且含 `name:`（否则我们的扫描器读不出它 ✓，等于白写 ✗）。 */
export function assertSkillContent(content) {
	const text = typeof content === 'string' ? content : '';
	if (!text.trim()) { throw new Error('content 不能为空：要写完整的 SKILL.md（YAML frontmatter + markdown 正文）。'); }
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes > MAX_SKILL_BYTES) { throw new Error(`content 太大：${bytes} 字节 > 上限 ${MAX_SKILL_BYTES}（单个技能正文上限）。`); }
	if (!/^---\r?\n/.test(text)) { throw new Error('content 必须以 `---` 开头的 YAML frontmatter 起头（至少要写 name 与 description）。'); }
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
	if (!/^\s*name:\s*\S/m.test(fm)) { throw new Error('frontmatter 里缺 `name:` —— 没有它技能不会被扫描到（写进去也等于没写）。'); }
	if (!/^\s*description:\s*\S/m.test(fm)) { throw new Error('frontmatter 里缺 `description:` —— 它是模型"找得到它"的唯一依据（skill_search 也靠它）。'); }
	return text;
}

/** `category` 是可选的组织维度（照真源 ✓）：给了就确保 frontmatter 里有 `category:` 一行 ✓。 */
function withCategory(content, category) {
	const value = typeof category === 'string' ? category.trim() : '';
	if (!value) { return content; }
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(value)) { throw new Error(`category 不合法：${value}（只允许字母/数字/连字符/下划线，≤32）。`); }
	if (/^\s*category:\s*\S/m.test(content)) { return content.replace(/^\s*category:.*$/m, `category: ${value}`); }
	// 插在 frontmatter 的最后一行之前 ✓（`---` 之后、正文之前 ✓）
	return content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_m, fm) => `---\n${fm}\ncategory: ${value}\n---`);
}

/**
 * 执行一次 `skill_manage`。
 * @param {{ action?: string, name?: string, content?: string, oldString?: string, newString?: string, replaceAll?: boolean, category?: string }} params
 * @param {string} skillsRoot 技能根（调用方用 `skillsRootOf(config)` 取 ✓；**不要**在这里读 config ✓）
 * @returns {{ action: string, id: string, path: string, bytes: number, replaced?: number }}
 */
/**
 * 原子写：临时文件 + `renameSync`（README 5.114）。
 *
 * 为什么它与**锁**是两件事 ✗：锁保证"两个写者不交错" ✓、原子写保证"**不留半截文件**" ✗ ——
 * 后者在进程被杀 / 断电时才是唯一救命的 ✓（写到一半的 `SKILL.md` 会被下次扫描当成内容 ✓）。
 * 临时名带 pid ⇒ 两个写者不会撞同一个 tmp ✓；失败时清掉临时文件，不留垃圾 ✓。
 */
function atomicWriteSync(file, text) {
	const tmp = `${file}.${process.pid}.vssaros-tmp`;
	try {
		writeFileSync(tmp, text, 'utf8');
		renameSync(tmp, file);
	} catch (e) {
		try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
		throw e;
	}
}

export function skillManage(params, skillsRoot) {
	const action = typeof params?.action === 'string' ? params.action.trim() : '';
	if (!SKILL_MANAGE_ACTIONS.includes(action)) {
		throw new Error(`action 必须是 ${SKILL_MANAGE_ACTIONS.join(' / ')} 之一（收到 ${action || '(空)'}）。`);
	}
	const name = assertSkillName(params?.name);
	const dir = skillDirOf(skillsRoot, name);
	const file = join(dir, SKILL_FILE);
	const exists = existsSync(file);

	if (action === 'create') {
		if (exists) { throw new Error(`技能 ${name} 已存在（create 不会覆盖 ✓；要改内容用 edit 或 patch）。`); }
		// 重构 4：新建落**草稿区**（不生效 ✓——模型新建的技能不该立刻进每轮的检索面 ✗，
		// 持久化提示注入面见壳契约 §8 ⑤）；用户在页面上手动提升（promote）才进生效目录 ✓。
		const draftDir = draftDirOf(skillsRoot, name);
		const draftFile = join(draftDir, SKILL_FILE);
		if (existsSync(draftFile)) { throw new Error(`技能 ${name} 的草稿已存在（create 不会覆盖 ✓；要改内容先 promote 再 edit，或删掉草稿重建）。`); }
		const body = withCategory(assertSkillContent(params?.content), params?.category);
		mkdirSync(draftDir, { recursive: true });
		atomicWriteSync(draftFile, body);
		return { action, id: name, path: draftFile, bytes: Buffer.byteLength(body, 'utf8'), draft: true };
	}
	// 重构 4：promote——草稿区 → 生效目录（用户在页面上点"提升"才生效 ✓）。
	if (action === 'promote') {
		const draftDir = draftDirOf(skillsRoot, name);
		const draftFile = join(draftDir, SKILL_FILE);
		if (!existsSync(draftFile)) { throw new Error(`技能 ${name} 没有草稿（promote 要求草稿在 ✓——没得提升 ✗）。`); }
		if (exists) { throw new Error(`技能 ${name} 已在生效目录（promote 不会覆盖 ✓；要更新先 edit/patch，或删掉再生效的）。`); }
		// 草稿 → 生效：读草稿正文，原子写进生效目录，删草稿（一次性提升 ✓）。
		const body = readFileSync(draftFile, 'utf8');
		mkdirSync(dir, { recursive: true });
		atomicWriteSync(file, body);
		rmSync(draftDir, { recursive: true, force: true });
		return { action, id: name, path: file, bytes: Buffer.byteLength(body, 'utf8') };
	}
	if (action === 'edit') {
		if (!exists) { throw new Error(`技能 ${name} 不存在（edit 只改已有的 ✓；要新建用 create）。`); }
		const body = withCategory(assertSkillContent(params?.content), params?.category);
		atomicWriteSync(file, body);
		return { action, id: name, path: file, bytes: Buffer.byteLength(body, 'utf8') };
	}
	if (action === 'patch') {
		if (!exists) { throw new Error(`技能 ${name} 不存在（patch 只改已有的 ✓）。`); }
		const oldString = typeof params?.oldString === 'string' ? params.oldString : '';
		const newString = typeof params?.newString === 'string' ? params.newString : '';
		if (!oldString) { throw new Error('patch 需要 old_string（要替换的那段原文，空白与换行都要逐字对上）。'); }
		const before = readFileSync(file, 'utf8');
		const occurrences = before.split(oldString).length - 1;
		if (occurrences === 0) {
			// 失败要先说**为什么**：模型最常犯的是"凭记忆写原文、实际对不上" ✗
			throw new Error(`patch 失败：old_string 在 ${name}/SKILL.md 里找不到（要逐字匹配，含空白与换行）。`);
		}
		if (occurrences > 1 && params?.replaceAll !== true) {
			throw new Error(`patch 失败：old_string 在文件里出现 ${occurrences} 次（默认要求唯一 ✓；确实要全改就传 replace_all: true）。`);
		}
		const after = params?.replaceAll === true ? before.split(oldString).join(newString) : before.replace(oldString, newString);
		const size = Buffer.byteLength(after, 'utf8');
		if (size > MAX_SKILL_BYTES) { throw new Error(`patch 后太大：${size} 字节 > 上限 ${MAX_SKILL_BYTES}。`); }
		atomicWriteSync(file, after);
		return { action, id: name, path: file, bytes: size, replaced: params?.replaceAll === true ? occurrences : 1 };
	}
	// delete
	if (!exists) { throw new Error(`技能 ${name} 不存在（delete 要求目标在 ✓ —— 免得"以为删了"）。`); }
	const size = statSync(file).size;
	rmSync(dir, { recursive: true, force: true });
	return { action, id: name, path: dir, bytes: size };
}
