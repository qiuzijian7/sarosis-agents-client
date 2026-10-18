// @vssaros/dsh-agents — core/create（纯函数）：新建 Agent 的草稿归一 / 校验 / 序列化。
//
// 2026-10-16，方案 A（doc/agents-botmode-mockup.html v2 的「新建 Agent」向导，Q7 = ① 插件直接写）。
// 页面向导与写 API 吃**同一份**规则：页面每次输入都请求 `action: 'validate'` 拿回 errors / warnings /
// 序列化原文，写入时再跑一遍 ⇒ 预览里看到的 .agent.md 就是落盘的那份（不会两套口径漂移 ✓）。
//
// 字段 ↔ .agent.md frontmatter（与 core/agents.js 的 agentFromFile 解析口径一一对应）：
//   name / description / icon / role / model / skills / tools / workspaces-read / workspaces-write，正文 = 人格。
// 安全口径：frontmatter 只认单行标量（parseFrontmatter 按行切）⇒ 所有标量去掉换行；列表项只收安全字符集。

import { parseFrontmatter, presetIdOf, slugify, toPresetDefinition } from './agents.js';

/** agent id = 目录名。与页面桥 `openAgentSettings` 的 agent id 字符集同源（dshPageBridgeProtocol）。 */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Windows 设备名：建成目录会出各种怪问题 ⇒ 直接拒。 */
const RESERVED_IDS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

/**
 * 「改为跟随默认」：从 .agent.md 原文里**只删掉 frontmatter 的 `model:` 那一行**（以及它下面 YAML 列表写法的
 * `- xxx` 续行）。其余字节原样保留（换行符跟随原文，CRLF 不会被改成 LF）。
 * 用途：旧 Agent 写着 dsh 没有路由的裸模型名（典型 `claude-sonnet-4-20250514`，原生新建页的旧兜底）⇒
 * 页面「映射说明」里一键改掉（2026-10-17，方案 A 第 4 步遗留 ①）。
 * @returns `{ text, removed: string[], model }`；没有 frontmatter / 没有 model 行 ⇒ `{ error }`
 */
export function stripModelFromAgentMd(text) {
	const raw = String(text ?? '');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);
	let start = 0;
	while (start < lines.length && lines[start].trim() === '') {
		start++;
	}
	if (lines[start]?.trim() !== '---') {
		return { error: '开头没有 --- frontmatter' };
	}
	let end = start + 1;
	while (end < lines.length && lines[end].trim() !== '---') {
		end++;
	}
	if (end >= lines.length) {
		return { error: 'frontmatter 没有结束的 ---' };
	}
	const keep = [];
	const removed = [];
	let model = '';
	let inModel = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i > start && i < end) {
			if (/^model\s*:/.test(line)) {
				inModel = true;
				model = line.replace(/^model\s*:/, '').trim().replace(/^["']|["']$/g, '');
				removed.push(line);
				continue;
			}
			if (inModel && /^\s*-\s/.test(line)) {
				removed.push(line);
				model = model || line.replace(/^\s*-\s*/, '').trim();
				continue;
			}
			inModel = false;
		}
		keep.push(line);
	}
	if (!removed.length) {
		return { error: '没有 model 行（已经是跟随默认）' };
	}
	return { text: keep.join(eol), removed, model };
}
const LIST_ITEM_RE = /^[A-Za-z0-9._:@/-]{1,80}$/;
const LIMITS = { name: 80, description: 200, role: 40, icon: 16, model: 120, persona: 20000 };

const oneLine = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const listOf = v => (Array.isArray(v) ? v : String(v ?? '').split(','))
	.map(s => String(s ?? '').trim())
	.filter(Boolean);
const pathsOf = v => (Array.isArray(v) ? v : String(v ?? '').split(','))
	.map(s => String(s ?? '').replace(/[\r\n]+/g, '').trim())
	.filter(Boolean);

/** 名称 → 建议 id（英文名 ⇒ slug；纯中文等 slug 为空 ⇒ 空串，由页面提示用户自己起 id）。 */
export function suggestIdFromName(name) {
	return slugify(name).slice(0, 64);
}

/** 页面/API 收到的任意形状 → 归一草稿（只保留认识的字段）。 */
export function normalizeDraft(raw) {
	const d = raw && typeof raw === 'object' ? raw : {};
	return {
		name: oneLine(d.name, LIMITS.name),
		id: oneLine(d.id, 64),
		description: oneLine(d.description, LIMITS.description),
		icon: oneLine(d.icon, LIMITS.icon),
		role: oneLine(d.role, LIMITS.role),
		model: oneLine(d.model, LIMITS.model),
		skills: listOf(d.skills),
		tools: listOf(d.tools),
		workspacesRead: pathsOf(d.workspacesRead),
		workspacesWrite: pathsOf(d.workspacesWrite),
		persona: String(d.persona ?? '').replace(/\r\n/g, '\n').slice(0, LIMITS.persona),
	};
}

/**
 * 校验。
 * @param draft normalizeDraft 的结果
 * @param ctx.existingIds 数据根下已有的目录名（**含没有 .agent.md 的目录**——不许写进别人的目录）
 * @param ctx.provider config.defaultProvider（判模型能否路由，口径 = toPresetDefinition）
 * @param ctx.isAbsolute 判绝对路径（宿主侧注入 node:path 的 isAbsolute；纯函数里不 import node）
 * @returns { errors: string[], warnings: string[], presetId }
 */
export function validateDraft(draft, ctx = {}) {
	const errors = [];
	const warnings = [];
	const existing = new Set((ctx.existingIds ?? []).map(id => String(id).toLowerCase()));
	const existingPresets = new Set((ctx.existingIds ?? []).map(id => presetIdOf(id)));
	if (!draft.name) {
		errors.push('名称必填');
	}
	if (!draft.id) {
		errors.push(draft.name && !suggestIdFromName(draft.name)
			? 'id 必填：名称里没有英文字母或数字，自动生成不了，请手动起一个英文 id（如 code-reviewer）'
			: 'id 必填');
	} else if (!AGENT_ID_RE.test(draft.id) || draft.id.endsWith('.')) {
		errors.push('id 只能用字母、数字和 . _ -，以字母或数字开头，不能以 . 结尾，最长 64');
	} else if (RESERVED_IDS.has(draft.id.toLowerCase())) {
		errors.push('id 不能用系统保留名：' + draft.id);
	} else if (existing.has(draft.id.toLowerCase())) {
		errors.push('已有同名目录 ' + draft.id + '：不会覆盖，换一个 id');
	} else if (existingPresets.has(presetIdOf(draft.id))) {
		errors.push('id 和已有 Agent 撞了 preset id（' + presetIdOf(draft.id) + '）：. 与 _ 会被折成 -，换一个 id');
	}
	for (const item of draft.skills) {
		if (!LIST_ITEM_RE.test(item)) {
			errors.push('技能名不合法：' + item);
		}
	}
	for (const item of draft.tools) {
		if (!LIST_ITEM_RE.test(item)) {
			errors.push('工具名不合法：' + item);
		}
	}
	const isAbs = typeof ctx.isAbsolute === 'function' ? ctx.isAbsolute : (p => /^([A-Za-z]:[\\/]|\/)/.test(p));
	for (const p of [...draft.workspacesRead, ...draft.workspacesWrite]) {
		if (!isAbs(p)) {
			errors.push('工作区必须写绝对路径：' + p);
		}
	}
	if (draft.model) {
		const probe = toPresetDefinition({ id: draft.id || 'draft', name: draft.name || 'draft', model: draft.model, tools: [], persona: '' }, { provider: ctx.provider });
		if (probe.notes.some(n => n.startsWith('模型未映射'))) {
			errors.push('模型 ' + draft.model + ' 在 dsh 里没有路由：写成 provider/model（如 vssaros-codebuddy/hy4），或留空跟随默认模型');
		}
	}
	if (!draft.persona.trim()) {
		warnings.push('没写人格正文：只用默认人格');
	}
	if (draft.workspacesWrite.length && !draft.workspacesRead.length) {
		warnings.push('只写了可写工作区：可读会自动包含它');
	}
	return { errors, warnings, presetId: draft.id ? presetIdOf(draft.id) : '' };
}

/**
 * 向导「模型」下拉的候选：**真实跑过的会话**里出现过的 provider/model（projcache 的 modelSelection.lastUsed，
 * 一定是 dsh 能路由的）＋ 已有 Agent 里写成 provider/model 的。按出现次数降序、去重。
 * ⚠ 不是「全部可用模型」清单——dsh 没给插件暴露模型目录；页面里如实这么写，并允许手填 ✓。
 */
export function modelCandidatesOf(rows, agents) {
	const count = new Map();
	const bump = ref => {
		if (typeof ref === 'string' && /^[^/\s]+\/\S+$/.test(ref)) {
			count.set(ref, (count.get(ref) ?? 0) + 1);
		}
	};
	for (const row of rows ?? []) {
		bump(row?.model);
	}
	for (const a of agents ?? []) {
		bump(a?.model);
	}
	return [...count.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([ref]) => ref).slice(0, 30);
}

/**
 * 「导入 .agent.md」：原文 → 草稿（解析口径 = parseFrontmatter，与扫描目录时同一个解析器 ✓）。
 * id 取名称的 slug（原文里没有 id 字段——id 是目录名）。缺 frontmatter / 缺 name ⇒ { error }。
 */
export function draftFromAgentMd(text) {
	const raw = String(text ?? '').replace(/\r\n/g, '\n');
	if (!raw.trimStart().startsWith('---')) {
		return { error: '开头缺少 --- frontmatter' };
	}
	const { meta, body } = parseFrontmatter(raw.trimStart());
	if (!Object.keys(meta).length) {
		return { error: 'frontmatter 没有结束的 ---，或里面没有字段' };
	}
	if (!(meta.name || '').trim()) {
		return { error: '缺 name（preset 的 id 与展示名都靠它）' };
	}
	return {
		draft: {
			name: meta.name,
			id: suggestIdFromName(meta.name),
			description: meta.description ?? '',
			icon: meta.icon ?? '',
			role: meta.role ?? '',
			model: meta.model ?? '',
			skills: meta.skills ?? '',
			tools: meta.tools ?? '',
			workspacesRead: meta['workspaces-read'] ?? '',
			workspacesWrite: meta['workspaces-write'] ?? '',
			persona: body.trim(),
		},
	};
}

/** 草稿 → .agent.md 原文（字段顺序固定；空字段不写）。 */
export function serializeAgentMd(draft) {
	const lines = ['---', 'name: ' + draft.name];
	if (draft.description) { lines.push('description: ' + draft.description); }
	if (draft.icon) { lines.push('icon: ' + draft.icon); }
	if (draft.role) { lines.push('role: ' + draft.role); }
	if (draft.model) { lines.push('model: ' + draft.model); }
	if (draft.skills.length) { lines.push('skills: ' + draft.skills.join(', ')); }
	if (draft.tools.length) { lines.push('tools: ' + draft.tools.join(', ')); }
	if (draft.workspacesRead.length) { lines.push('workspaces-read: ' + draft.workspacesRead.join(', ')); }
	if (draft.workspacesWrite.length) { lines.push('workspaces-write: ' + draft.workspacesWrite.join(', ')); }
	lines.push('---', '');
	const body = draft.persona.trim();
	return lines.join('\n') + (body ? '\n' + body + '\n' : '');
}
