// @vssaros/dsh-agents — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源：`src/vs/sessions/contrib/agentStudio/common/agentMdFormat.ts`（`.agent.md` = YAML frontmatter +
// Markdown body；VS Code Chat 标准字段 name / description / model / tools / …；**id 回退**：先看 `id`
// 字段，否则用 `name` slug 化）与 `agentStudioService.ts` 的落盘布局
// `~/.vssaros/agents/<id>/.agent.md`（用户/覆写）与 `resources/.agents/agents/<id>/.agent.md`（内置）。
//
// 映射（v0 的能力边界，逐条写清）：
//   VsSaros agent           →  dsh agent preset
//   name / description      →  preset 的 name / description（花名册里显示）
//   body（Markdown 正文）    →  本包在**该 preset 作用域内再挂一次**（`config.persona`），
//                              注册成一条系统提示词 section（`ctx.systemPrompt.section`）
//   model                   →  `@deepseek-ai/dsh-agent-default-model` 行（provider + model）
//                              ⚠️ 需要 `config.defaultProvider`（dsh 的 provider route 名，由 VsSaros 的
//                              providers.sync 决定）。**没配就不写模型行**——宁可跟随默认，也不写一个
//                              不存在的 route 让会话创建失败。
//   tools                   →  **未映射**（v0）。dsh 侧的工具裁剪需要工具策略行的知识，本模块不猜。
//   icon                    →  **页面头像**（2026-10-13 起）：emoji 原样保留，进 api/agents 与
//                              /x/agents 页（底色按 id 哈希派生）；**不进 preset 定义**（dsh 的
//                              PresetDefinition 没有 icon 字段，别乱塞 ✗）。
//   handoffs / hooks        →  **未映射**（v0；旧引擎语义）。

/** dsh 侧读的 agent 文件名（VS Code Chat 标准）。 */
export const AGENT_FILE = '.agent.md';

/** HTML 转义（页面层 detail.js / sideview.js 共用一份，别各写各的）。 */
export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** preset id 前缀：dsh 的 preset id 必须全局唯一（重名会让声明加载失败），加前缀避免撞上 standard/ptc/minimal/cordis。 */
export const PRESET_ID_PREFIX = 'vssaros-';

/** 我们的包名——preset 里"人设行"要用它（同一包、另一份 config）。 */
export const PERSONA_ROW_NAME = '@vssaros/dsh-agents';

/** dsh 自带行：设定该 Agent 的默认模型。 */
export const DEFAULT_MODEL_ROW_NAME = '@deepseek-ai/dsh-agent-default-model';

/** 与 agentMdFormat 的 YAML 解析口径一致的轻量 frontmatter 解析（只认顶层标量 / 逗号数组）。 */
export function parseFrontmatter(text) {
	const raw = typeof text === 'string' ? text : '';
	if (!raw.startsWith('---')) {
		return { meta: {}, body: raw };
	}
	const end = raw.indexOf('\n---', 3);
	if (end < 0) {
		return { meta: {}, body: raw };
	}
	const head = raw.slice(raw.indexOf('\n', 3) + 1, end);
	const after = raw.indexOf('\n', end + 1);
	const body = after < 0 ? '' : raw.slice(after + 1);
	const meta = {};
	for (const line of head.split(/\r?\n/)) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		let value = match[2].trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		meta[match[1]] = value;
	}
	return { meta, body };
}

/** `name` → id 回退（与 agentMdFormat 的 slug 化一致：小写、非字母数字折成单个连字符）。 */
export function slugify(name) {
	return String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** preset id：`vssaros-<agentId>`，字符集收敛到 dsh 安全的 `[a-z0-9-]`。 */
export function presetIdOf(agentId) {
	const safe = slugify(agentId);
	return `${PRESET_ID_PREFIX}${safe || 'agent'}`;
}

function listValue(value) {
	if (typeof value !== 'string' || !value.trim()) {
		return [];
	}
	return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 一个 `.agent.md` → agent（或一条**带原因的**跳过记录）。
 * 缺 `name` 直接跳过：preset 的展示名与 id 回退都依赖它。
 */
export function agentFromFile(text, { id, file }) {
	const { meta, body } = parseFrontmatter(text);
	const name = (meta.name || '').trim();
	if (!name) {
		return { error: `缺 name（preset 的 id 与展示名都靠它）：${file}` };
	}
	const agentId = (meta.id || id || slugify(name)).trim();
	if (!slugify(agentId)) {
		return { error: `id 无法归一化（需要至少一个字母或数字）：${agentId}` };
	}
	const model = listValue(meta.model)[0];
	// role / skills（款 A mockup：sideview 角色标签 + hero 技能 chip）。真源 = agentMdFormat 的扩展字段
	// `role` / `skills`。dsh 侧用逗号分隔口径（与 tools 一致）：`role: 检索`、`skills: anysearch, analysis`。
	// 没写就不带（role 不显示标签、skills 不显示 chip）——不伪造"assistant"这种无信息默认 ✗。
	const role = (meta.role || '').trim() || undefined;
	const skills = listValue(meta.skills);
	// Workspace Grant（2026-10-16 二期；mockup doc/agents-grants-outbox-mockup.html 拍板点 ①）：
	// `workspaces-read: <路径,...>` / `workspaces-write: <路径,...>`（绝对路径，逗号分隔）。
	// **字段不写 = 收紧缺省：只允许引擎缺省 cwd（不显式给 cwd）**——显式跨工作区必须显式声明 ✓。
	// write ⊆ read 语义在 grants.js 的闸里算（写了 write 没写 read ⇒ read 自动含它）。
	const wsRead = listValue(meta['workspaces-read']);
	const wsWrite = listValue(meta['workspaces-write']);
	return {
		agent: {
			id: slugify(agentId),
			name,
			description: (meta.description || '').trim() || undefined,
			icon: (meta.icon || '').trim() || undefined,
			model,
			tools: listValue(meta.tools),
			persona: body.trim(),
			file,
			...(role ? { role } : {}),
			...(skills.length ? { skills } : {}),
			...((wsRead.length || wsWrite.length) ? { workspaces: { read: wsRead, write: wsWrite } } : {}),
		},
	};
}

/**
 * 头像底色：按 agent id 哈希取一个**稳定**色相（ds-bot 的 color-per-bot 同构——它没有派生需求因为
 * 定义里有 color 字段；我们的 `.agent.md` 没有 ⇒ 派生，同一个 id 永远同色 ✓）。
 */
export function avatarColorOf(id) {
	let h = 0;
	for (const ch of String(id ?? '')) {
		h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	}
	return `hsl(${h % 360} 45% 42%)`;
}

/**
 * agent → `PresetDefinition`（`ctx.agentPresets.register()` 的入参）。
 * @param agent core agent
 * @param options.provider dsh 的 provider route 名（`config.defaultProvider`）；缺省则不写模型行
 * @returns definition + notes（notes 是要在页面/日志里**可见**的映射缺口，不含敏感内容）
 */
export function toPresetDefinition(agent, options = {}) {
	const notes = [];
	const plugins = [{
		id: 'persona',
		name: PERSONA_ROW_NAME,
		// persona / tools 走 config：本包在该 preset 作用域内被再挂一次，注册提示词 section 与工具 allowlist
		config: { agentId: agent.id, persona: agent.persona, ...(agent.tools.length ? { tools: agent.tools } : {}) },
	}];
	const provider = typeof options.provider === 'string' ? options.provider.trim() : '';
	if (agent.model) {
		// `model` 允许写成 `provider/model` 显式指定；否则用 defaultProvider
		const [maybeProvider, maybeModel] = agent.model.includes('/') ? agent.model.split('/', 2) : ['', agent.model];
		const route = maybeProvider.trim() || provider;
		if (route && maybeModel.trim()) {
			plugins.push({ id: 'default-model', name: DEFAULT_MODEL_ROW_NAME, config: { provider: route, model: maybeModel.trim() } });
		} else {
			notes.push(`模型未映射（agent.md 写了 model=${agent.model}，但没配 config.defaultProvider 且不是 provider/model 形式）→ 该 preset 跟随默认模型`);
		}
	}
	if (agent.tools.length) {
		// tools 转 dsh 的工具 allowlist（`ctx.tools.restrict({ allow })`，在该 preset 作用域内生效）。
		// 名字是 VS Code 口径，dsh 侧未必同名——运行时只保留真实存在的名字，未知名字写 Host 日志。
		notes.push(`tools 进 allowlist（${agent.tools.length} 个：${agent.tools.slice(0, 4).join(', ')}${agent.tools.length > 4 ? '…' : ''}）；与 dsh 不同名的会被忽略并记日志`);
	}
	if (!agent.persona) {
		notes.push('agent.md 正文为空 → 该 preset 没有人设提示词');
	}
	const definition = {
		id: presetIdOf(agent.id),
		name: agent.name,
		plugins,
	};
	if (agent.description) {
		definition.description = agent.description;
	}
	return { definition, notes };
}

/** 花名册统计（页面自诊断用）。 */
export function summarizeAgents(agents) {
	return {
		count: agents.length,
		withModel: agents.filter(a => !!a.model).length,
		withPersona: agents.filter(a => !!a.persona).length,
		withTools: agents.filter(a => a.tools.length).length,
	};
}
