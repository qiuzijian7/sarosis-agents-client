// @vssaros/dsh-agents — 从 DeepSeekBot（DSB / BotHarness）的 PersonaBot 导入成我们的 agent。
//
// 为什么需要这层：DSB 的"agent"= PersonaBot，实体是**一个记忆仓库**（`SOUL.md` + `MEMORY.md` + 其他
// 记忆文件 + `.botharness/bot.json`），没有 `.agent.md` 概念；我们的 agent 是「一份 frontmatter +
// 正文人设 + memory 目录」。两者语义高度重合，但**形状不同**，所以要一个明确的映射器（而不是让用户
// 手工抄）。
//
// 映射口径（DSB → 本项目）：
//   SOUL.md（或旧名 PERSONA.md）      → `.agent.md` **正文**（人设）
//   MEMORY.md                        → `memory/MEMORY.md`（常驻注入；`memory-chars` 设 3000 装得下）
//   其他 *.md / *.txt                → `memory/<拍平名>`（我们只支持平铺，见 `safeMemoryFileName`）
//   .botharness/bot.json `name`      → frontmatter `name`
//   .botharness/bot.json `bio`       → `description`
//   .botharness/bot.json `tags[0]`   → `role`（其余 tag 丢弃并记 warning —— 不发明字段）
//   .botharness/git-history.bundle   → **不导入**（我们的 memory git 是可选快照，语义不同）
//
// ⚠ 三个硬差异（都在这里处理，调用方不用管）：
//   ① 子目录：DSB 允许 `people/小王.md`，我们只认单层 ⇒ 拍平成 `people-小王.md`，并**改写
//      `MEMORY.md` 里的引用**（否则索引指向不存在的文件）；
//   ② 上限：DSB CORE_MEMORY 默认 3000 字符，我们 `memory-chars` 默认 2048 ⇒ 导入时显式写 3000；
//   ③ id：DSB 的 slug 是 Host 生成的、不在包里 ⇒ 用 `--id` / `bot.json.name` / 目录名生成。
//
// 安全口径与 `pack.js` 一致：绝对路径、`..`、非法文件名字符一律拒绝或清洗；`--dry-run` 只算不写。

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { slugify } from './core/agents.js';
import { normalizeDraft, serializeAgentMd } from './core/create.js';
import { zipRead } from './core/zip.js';
import { safeMemoryFileName } from './memory.js';
import { agentsRootOf } from './store.js';

export const DSB_DESCRIPTOR = '.botharness/bot.json';
export const DSB_SOUL = 'SOUL.md';
export const DSB_LEGACY_SOUL = 'PERSONA.md';
export const DSB_CORE_MEMORY = 'MEMORY.md';
/** DSB 的 CORE_MEMORY 默认上限（字符）；导入时对齐，避免"导进来就少一截"。 */
export const DSB_MEMORY_CHARS = 3000;

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 1024 * 1024;

const httpError = (status, message) => Object.assign(new Error(message), { httpStatus: status });

/** 统一成 `/` 分隔的相对路径；越界路径直接拒。 */
function normalizePath(name) {
	const norm = String(name ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
	if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').some((seg) => seg === '..')) {
		throw httpError(400, `源包里有不安全的路径：${JSON.stringify(String(name ?? ''))}`);
	}
	return norm;
}

/** `people/小王.md` → `people-小王.md`（拍平 + 清洗成我们的白名单形状）。 */
function flattenMemoryName(path, used) {
	const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')).replace(/\//g, '-') : '';
	const base = basename(path);
	const ext = extname(base).toLowerCase();
	const rawStem = dir ? `${dir}-${base.slice(0, base.length - extname(base).length)}` : base.slice(0, base.length - extname(base).length);
	const stem = rawStem.replace(/[^A-Za-z0-9._一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'memory';
	let name = `${stem}${ext}`;
	let n = 2;
	while (used.has(name.toLowerCase())) {
		name = `${stem}-${n}${ext}`;
		n += 1;
	}
	used.add(name.toLowerCase());
	return name;
}

/** 从目录读（递归，跳过 `.git`；浅层即可——DSB 记忆仓库是平铺 + 少量子目录）。 */
async function readDirEntries(dir, prefix = '', depth = 0) {
	if (depth > 4) {
		return [];
	}
	const out = [];
	let items;
	try {
		items = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		throw httpError(400, `读目录失败：${String(e?.message ?? e)}`);
	}
	for (const item of items) {
		if (item.name === '.git' || item.name === 'node_modules') {
			continue;
		}
		const rel = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.isDirectory()) {
			out.push(...await readDirEntries(join(dir, item.name), rel, depth + 1));
		} else if (item.isFile()) {
			const full = join(dir, item.name);
			const info = await stat(full);
			if (info.size > MAX_ENTRY_BYTES) {
				continue;
			}
			out.push({ name: rel, data: await readFile(full) });
		}
	}
	return out;
}

/**
 * 读取一个 DSB Bot（zip 或目录）→ 结构化内容。
 * @returns `{ descriptor, soul, coreMemory, memoryEntries, skipped }`
 */
/**
 * 从**纯 markdown 人设**造一个 bot 结构（2026-10-19）。
 *
 * 为什么需要这条：不少"agent"没有 zip/dir，只有一段 SOUL/人设 markdown——比如 DSB 内置的 Tob
 * （persona 是源码里的字符串），或者用户从别处复制来的一段人设。把它当成"只有 SOUL.md 的 bot"
 * 走同一条映射（`draftFromDsb`）即可，避免再造一条分支。
 *
 * 名称：`options.name` > 首个 `# ` 标题 > 文件名（去扩展名）。
 */
export function botFromSoulText(text, options = {}) {
	const soul = String(text ?? '').replace(/\r\n/g, '\n').trim();
	if (!soul) {
		throw httpError(400, '人设文件是空的');
	}
	const heading = /^#\s+(.+)$/m.exec(soul)?.[1]?.trim();
	const fallback = String(options.fileName ?? '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
	const name = String(options.name ?? '').trim() || heading || fallback || 'Imported Agent';
	return {
		descriptor: { name },
		soul,
		coreMemory: '',
		memoryEntries: [],
		skipped: [],
	};
}

/** 解 JS/TS 字符串字面量里的转义（只处理 SOUL 里真会出现的几种）。 */
function unescapeJs(text) {
	return String(text ?? '')
		.replace(/\\n/g, '\n')
		.replace(/\\r/g, '\r')
		.replace(/\\t/g, '\t')
		.replace(/\\`/g, '`')
		.replace(/\\'/g, "'")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, '\\');
}

/**
 * 从 **DSB 源码**里抽 Tob 的 persona（`--from-tob` 用）。
 *
 * ⚠ 这是**一次性迁移便利**，不是稳定 API：它靠正则认 `persona:` 字段，DSB 若改了写法就会失败。
 *   失败时给的是"怎么办"（把 persona 存成 .md 再 `import-bot`），不是一句"解析失败"。
 *   认两种写法：模板字符串（`` `…` ``）与单/双引号（含 `'a' + 'b'` 跨行拼接）。
 */
export function botFromTobSource(sourceText) {
	const text = String(sourceText ?? '');
	const idx = text.search(/persona\s*:/);
	if (idx < 0) {
		throw httpError(400, '这份源码里没找到 `persona:` 字段（DSB 版本可能变了）：把 persona 复制成 .md 再 `import-bot`');
	}
	const rest = text.slice(idx);

	// ⚠ 模板里可能有转义反引号（`` \` ``）⇒ 不能简单"到下一个反引号为止"，
	//   要放行所有 `\\.` 转义序列（p3-139 的 B1 就是拿这个咬出来的）。
	const tpl = /persona\s*:\s*`((?:[^`\\]|\\.)*)`\s*,?/.exec(rest);
	if (tpl) {
		return botFromSoulText(unescapeJs(tpl[1]), { name: 'Tob' });
	}
	const quoted = /persona\s*:\s*((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*)/.exec(rest);
	if (quoted) {
		const parts = [...quoted[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]);
		const joined = parts.map(unescapeJs).join('');
		if (joined.trim()) {
			return botFromSoulText(joined, { name: 'Tob' });
		}
	}
	throw httpError(400, '找到了 `persona:` 但格式认不出来：把 persona 复制成 .md 再 `import-bot`');
}

export async function readDsbBot(source) {
	// 已经是"解析好的 bot 结构"（markdown 人设 / 调用方自组）⇒ 直接穿过，不再当 zip/dir 解
	if (source && typeof source === 'object' && !Buffer.isBuffer(source) && typeof source.soul === 'string') {
		return {
			descriptor: source.descriptor ?? {},
			soul: source.soul,
			coreMemory: source.coreMemory ?? '',
			memoryEntries: Array.isArray(source.memoryEntries) ? source.memoryEntries : [],
			skipped: Array.isArray(source.skipped) ? source.skipped : [],
		};
	}
	let entries;
	if (Buffer.isBuffer(source)) {
		try {
			entries = await zipRead(source);
		} catch (e) {
			throw httpError(400, `不是有效的 zip：${String(e?.message ?? e)}`);
		}
	} else if (typeof source === 'string' && source.trim()) {
		const dir = source.trim();
		const info = await stat(dir).catch(() => null);
		if (!info || !info.isDirectory()) {
			throw httpError(400, `目录不存在：${dir}`);
		}
		entries = await readDirEntries(dir);
	} else {
		throw httpError(400, '需要 zip Buffer 或目录路径');
	}
	if (entries.length > MAX_ENTRIES) {
		throw httpError(400, `源里条目太多（${entries.length} > ${MAX_ENTRIES}）`);
	}

	let descriptor = {};
	let soul = '';
	let coreMemory = '';
	const others = [];
	const skipped = [];
	for (const entry of entries) {
		const path = normalizePath(entry.name);
		if (path === '.botharness/git-history.bundle' || path.startsWith('.git/')) {
			skipped.push({ path, reason: '不导入 git 历史' });
			continue;
		}
		if (entry.data.length > MAX_ENTRY_BYTES) {
			skipped.push({ path, reason: `文件过大（>${MAX_ENTRY_BYTES}B）` });
			continue;
		}
		const text = entry.data.toString('utf8');
		if (path === DSB_DESCRIPTOR) {
			try {
				descriptor = JSON.parse(text);
			} catch {
				throw httpError(400, `${DSB_DESCRIPTOR} 不是合法 JSON`);
			}
			continue;
		}
		if (path === DSB_SOUL || path === DSB_LEGACY_SOUL) {
			soul = text;
			continue;
		}
		if (path === DSB_CORE_MEMORY) {
			coreMemory = text;
			continue;
		}
		if (/\.(md|txt)$/i.test(path) && !path.startsWith('.botharness/')) {
			others.push({ path, text });
			continue;
		}
		skipped.push({ path, reason: '不是记忆文件' });
	}
	if (!soul.trim() && !descriptor?.name) {
		throw httpError(400, '这个包里既没有 SOUL.md 也没有 bot.json 的 name —— 不像是 DSB Bot 包');
	}
	return { descriptor, soul, coreMemory, memoryEntries: others, skipped };
}

/** 把 DSB Bot 转成我们的草稿（`serializeAgentMd` 的输入）。 */
export function draftFromDsb(bot, options = {}) {
	const descriptor = bot.descriptor ?? {};
	const name = String(options.name ?? descriptor.name ?? '').trim() || 'Imported Bot';
	const tags = Array.isArray(descriptor.tags) ? descriptor.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
	const description = String(descriptor.bio ?? '').trim();
	const warnings = [];
	if (tags.length > 1) {
		warnings.push(`bot.json 里的其余标签被忽略（我们的 .agent.md 只有一个 role）：${tags.slice(1).join('、')}`);
	}
	if (!bot.soul.trim()) {
		warnings.push('这个 Bot 没有 SOUL.md：导进来的人设是空的，需要你补 .agent.md 正文');
	}
	if (!bot.coreMemory.trim()) {
		warnings.push('这个 Bot 没有 MEMORY.md：不会注入常驻记忆');
	}
	return {
		draft: normalizeDraft({
			name,
			id: options.id ?? slugify(name),
			description,
			role: tags[0] ?? '',
			model: options.model ?? '',
			modelAssignment: options.modelAssignment ?? '',
			memoryChars: DSB_MEMORY_CHARS,
			memoryMode: 'session',
			skills: [],
			tools: [],
			persona: bot.soul.trim(),
		}),
		warnings,
	};
}

/**
 * 导入：写 `.agent.md` + `memory/`。
 * @param config 本行 config（`agentsRoot`）
 * @param source zip Buffer 或目录
 * @param options `{ id?, name?, overwrite?, dryRun?, model?, modelAssignment? }`
 */
export async function importDsbBot(config, source, options = {}) {
	const bot = await readDsbBot(source);
	const { draft, warnings } = draftFromDsb(bot, options);
	const id = draft.id;
	if (!id) {
		throw httpError(400, '算不出合法的 agent id（用 --id 指定一个英文 id）');
	}
	const agentMd = serializeAgentMd(draft);

	// 记忆文件：MEMORY.md 固定，其余拍平
	const used = new Set(['memory.md']);
	const planned = [];
	if (bot.coreMemory.trim()) {
		planned.push({ name: 'MEMORY.md', text: bot.coreMemory, from: DSB_CORE_MEMORY });
	}
	for (const entry of bot.memoryEntries) {
		const flat = flattenMemoryName(entry.path, used);
		planned.push({ name: flat, text: entry.text, from: entry.path });
	}

	// 引用改写：拍平会改路径，`MEMORY.md` 里指向 `people/小王.md` 的索引必须同步（否则索引是死的）
	const renames = planned.filter((p) => p.from !== p.name && p.from !== DSB_CORE_MEMORY);
	for (const item of planned) {
		let text = item.text;
		for (const rename of renames) {
			if (text.includes(rename.from)) {
				text = text.split(rename.from).join(rename.name);
			}
		}
		item.text = text;
	}

	const dir = join(agentsRootOf(config), id);
	const already = await stat(dir).then(() => true, () => false);

	// ⚠ `dryRun` 必须在重名闸**之前**：预览的职责就是"告诉你会不会覆盖"。
	//   （2026-10-19 被 p3-136 的 C1 抓到：原来先抛 409 ⇒ 页面拿到的是"导入失败"，
	//    用户永远看不到「覆盖导入」那个按钮，只能靠改 id 撞大运。）
	if (options.dryRun === true) {
		return {
			dryRun: true,
			id,
			name: draft.name,
			mode: already ? 'overwritten' : 'created',
			agentMd,
			memoryFiles: planned.map((p) => ({ name: p.name, from: p.from, bytes: Buffer.byteLength(p.text, 'utf8') })),
			skipped: bot.skipped,
			warnings,
		};
	}
	if (already && options.overwrite !== true) {
		throw httpError(409, `已存在同名 agent：${id}（用 --overwrite 覆盖，或 --id 换一个）`);
	}

	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, '.agent.md'), agentMd, 'utf8');
	const written = [];
	if (planned.length) {
		const memDir = join(dir, 'memory');
		await mkdir(memDir, { recursive: true });
		for (const item of planned) {
			if (!safeMemoryFileName(item.name)) {
				warnings.push(`记忆文件名不合规，已跳过：${item.name}`);
				continue;
			}
			await writeFile(join(memDir, item.name), item.text, 'utf8');
			written.push(item.name);
		}
	}
	return {
		id,
		name: draft.name,
		mode: already ? 'overwritten' : 'created',
		memoryFiles: written,
		renamed: renames.map((r) => `${r.from} → ${r.name}`),
		skipped: bot.skipped,
		warnings,
	};
}
