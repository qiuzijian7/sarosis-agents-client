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

// 记忆口径的解析真源（零依赖叶子模块 ⇒ 不破坏本文件的"纯逻辑、零 I/O"约定）
import { parseMemoryLimits } from './memoryLimits.js';
// agent preset 的共享基座（生成物：`node dsh-plugins/preset-sync.mjs --write-agent-base`）
import { STANDARD_BASE_ROWS } from './presetBase.generated.js';

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
// 子代理（control / list-agents / subagent / fork）与压缩三件套的行**不再在这里手写**：
// 它们随共享基座（presetBase.generated.js，= 官方 standard 的全部行）一起来，见 `toPresetDefinition`。

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
	// ★★ 2026-10-19 修：**支持 YAML 块列表**（`key:` 换行后跟若干 `  - item`）。
	//
	// 为什么必须修（真机实测）：`.agent.md` 是 `agentMdFormat.buildAgentMd` 生成的，
	// 它把数组字段写成 **YAML 列表**（`fm.skills = agent.skills` ⇒
	//   `tools:` / `skills:` 下面若干行 `  - xxx`）。
	// 而旧实现只有一条**行级标量**正则（`^[A-Za-z]...`）⇒ 列表项以空格开头、匹配不上 ⇒ **整段被丢弃**：
	//   `meta.tools = ''`、`meta.skills = ''` ⇒ `listValue('')` 得 `[]`
	//   ⇒ `toPresetDefinition` 里 `agent.tools.length ? { tools } : {}` 落空
	//   ⇒ **每个 agent preset 都没有工具 allowlist**（等于全开，安全边界形同虚设 ✗）。
	//   实测 knowledge-base-expert：tools 本应 19 项、skills 本应 10 项，两者都读成 0。
	//
	// 口径：把列表项**拼成逗号分隔串** ⇒ 下游 `listValue()`（逗号口径）无需改动 ✓，
	//   同时天然兼容旧的 `skills: a, b` 一行写法 ✓（两种写法都能读）。
	// ⚠ 只认「空值键 + 紧随其后的缩进 `- ` 行」；遇到非列表行就清掉 pending，避免把 body 里的
	//   破折号行误吸进来（虽然 head 已经切掉了 body，这一层是防御）。
	let pendingKey;
	for (const line of head.split(/\r?\n/)) {
		// ★ 2026-10-20 修：块列表**中间夹注释**时不能清 pendingKey。
		//   真机案例：`docs/agents-draft/crawler.agent.md` 的
		//     tools:
		//       # ⚠ 这里只能写真实存在的工具名
		//       - pwsh
		//       - read
		//   注释行既不是列表项、也不是 `key:` ⇒ 旧逻辑 `pendingKey = undefined`
		//   ⇒ 后面 7 个 `- xxx` 全被丢掉 ⇒ `tools: []`（allowlist 静默失效，等于全开）。
		//   注释本来就不该影响"我在读哪个键的列表"。
		if (/^\s*#/.test(line)) {
			continue;
		}
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && pendingKey) {
			let entry = item[1].trim();
			if (entry.length >= 2 && ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith('\'') && entry.endsWith('\'')))) {
				entry = entry.slice(1, -1);
			}
			meta[pendingKey] = meta[pendingKey] ? `${meta[pendingKey]}, ${entry}` : entry;
			continue;
		}
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			pendingKey = undefined;
			continue;
		}
		let value = match[2].trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
			value = value.slice(1, -1);
		}
		meta[match[1]] = value;
		// 空值 ⇒ 后面可能跟块列表（YAML 的 `key:` + 缩进 `- item`）
		pendingKey = value === '' ? match[1] : undefined;
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
/**
 * **显式隐藏**的 agent（黑名单；唯一真源，页面/群聊/委派都用它）。
 *
 * 2026-10-19：原先这里是"内置白名单"（只放 knowledge-base-expert），把内置目录里另外 14 个
 * agent 全藏了 —— 用户只要求过「移除助理」⇒ 改成黑名单：默认全显示，只藏明确列出的。
 * ⚠ 隐藏只影响**展示与能否被选中**（名册/群成员/委派），**不影响 preset 注册**
 *   （`saros-claw` 仍是工作流画布 Run 的默认执行 agent）。
 */
export const HIDDEN_AGENT_IDS = new Set(['saros-claw']);

/** 这个 agent 是否被显式隐藏。 */
export function isHiddenAgent(agentId) {
	return HIDDEN_AGENT_IDS.has(String(agentId ?? ''));
}

/**
 * 展示/可选中判定（页面名册、群成员、子代理候选统一用它）。
 *
 * ★ 2026-10-20：内置 agent 从"黑名单"改成**跟 IDE 同一份白名单** —— 真源是
 *   `.agent.md` 的 `userFacing: true`（IDE 侧 `USER_FACING_BUILTIN_AGENT_IDS` 由
 *   `builtinAgentSingleSource.test.ts` ⑤ 与该字段强绑定，两边不会各写一份）。
 *   之前只看黑名单 ⇒ 内置的 15 个（coder / tester / code-reviewer …）全在 dsh 页面上可见，
 *   而 IDE 侧只展示 3 个 ⇒ 同一个 agent 在两边"存在性"不一致 ✗。
 *   · 自定义 agent 永远可见（用户的 agent 不该被产品白名单管）；
 *   · 只有 **`source === 'builtin'`** 才受白名单约束 —— `source` 缺失（某些兜底扫描路径）按
 *     "可见"处理：宁可多显示一个，也不要把整页变得空荡荡让人以为坏了。
 */
/**
 * 这个 agent 能不能出现在**子代理的可选清单**里（`allowedAgentPresets`）。
 *
 * 与 `isShownAgent`（页面可见性）**刻意分开**：
 *   · 页面是管理面 ⇒ 全显示（看不到就改不了）；
 *   · 委派是"把活派给谁"⇒ 只给**用户可挑**的角色（内置内部子代理 coder/tester 等由
 *     `userFacing` 决定，默认不进清单，免得模型把活派给一个用户从没见过的角色）。
 * 自定义 agent 永远可委派；隐藏的（助理）永远不行。
 */
export function isDelegatableAgent(agent) {
	if (!agent) { return false; }
	if (isHiddenAgent(agent.id)) { return false; }
	// ★ 2026-10-20（用户选定的方案 ①）：**显式 opt-in** —— `.agent.md` 写 `subagent: true` 才进清单。
	//
	// 为什么不按"可见就进"：清单会嵌进**每个** preset 的 `tool-subagent` 配置里，而
	// `tool-subagent` 激活时会对清单里每个 id 调 `agentPresets.readDocument()`（内部把该 preset
	// 的 plugins dump 成 YAML）⇒ 整体 O(N²)。N=20 时一次全量重挂约 1s（删除 agent 曾要等 1.1s）。
	// opt-in 后清单通常只有 3~5 个 id，更关键的是：**新建/删除普通 agent 不再改变任何 preset 的
	// 配置** ⇒ 指纹一致 ⇒ 一次注册都不发生（churn 归零）。
	// `subagents: false` 只约束"自己能不能开子代理"，与"能不能被点名"正交，故不在这里排除。
	return agent.delegatable === true;
}

export function isShownAgent(agent) {
	if (!agent) { return false; }
	// ★ 2026-10-20（用户第三次问「看不到全部 agent，是否合理」）：**这里只做黑名单**。
	//
	// 历史教训（同一条来回改过两次，别再改回去）：
	//   · 2026-10-19 曾按"内置白名单"只放 knowledge-base-expert ⇒ 用户报「内置 agent 没显示」；
	//   · 随后改成黑名单 ✓；
	//   · 2026-10-20 又按 IDE 侧的 `USER_FACING_BUILTIN_AGENT_IDS`（`userFacing: true`）收敛
	//     ⇒ 21 个 agent 只剩 5 个可见（coder / tester / code-architect … 全被藏）。
	//
	// 为什么两个面**不该**共用一个白名单：
	//   · `/x/agents` 是**管理面**：看不到就改不了记忆、改不了模型、删不掉、导不出；
	//     而且页脚写着"已注册 N"，N 是 21 而列表只有 5 行 ⇒ 数字与内容自相矛盾 ✗。
	//   · IDE 侧的内置下拉是**挑 agent 开新会话**的面：那里藏掉内部子角色（coder / tester …）
	//     是合理的（它们是 delegate 用的角色，不是用户要挑的）。
	//   ⇒ 结论：`userFacing` 只服务 IDE 侧；dsh 页面默认全显示，只藏**显式**列进
	//     `HIDDEN_AGENT_IDS` 的（目前只有「助理」saros-claw，用户 2026-10-19 明确要求移除）。
	return !isHiddenAgent(agent.id);
}

export function presetIdOf(agentId) {
	const safe = slugify(agentId);
	return `${PRESET_ID_PREFIX}${safe || 'agent'}`;
}

/**
 * 委派专用 preset 的 id（`.agent.md` 写了 `model-assignment` 时才存在）。
 *
 * 为什么必须派生一个 preset：dsh 的 `session.create` 只认 `agentPreset`，**没有** model 覆盖参数
 * ⇒ "编排用强模型、委派用便宜模型"只能靠两条 preset（同人格/同工具，只有 `default-model` 行不同）。
 * 后缀用 `-assign`（与 `presetIdOf` 同一字符集，不引入新 id 形态）；万一和某个真实 agent 撞名，
 * `syncPresets` 会忽略派生并记一条 error（不静默）。
 */
export function assignmentPresetIdOf(agentId) {
	return `${presetIdOf(agentId)}-assign`;
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
	// 委派执行模型（2026-10-19，对齐 DSB 的 orchestrator / assignment 双模型）：
	// `model-assignment: provider/model` 会让插件额外注册一条 `<preset>-assign`（同人格同工具、
	// 只有模型不同），委派开的新会话用它；主会话仍用 `model`。留空 = 委派跟随主模型（旧行为 ✓）。
	const modelAssignment = listValue(meta['model-assignment'])[0];
	// role / skills（款 A mockup：sideview 角色标签 + hero 技能 chip）。真源 = agentMdFormat 的扩展字段
	// `role` / `skills`。dsh 侧用逗号分隔口径（与 tools 一致）：`role: 检索`、`skills: anysearch, analysis`。
	// 没写就不带（role 不显示标签、skills 不显示 chip）——不伪造"assistant"这种无信息默认 ✗。
	const role = (meta.role || '').trim() || undefined;
	const skills = listValue(meta.skills);
	// 欢迎卡建议问题（★ 2026-10-26）：`.agent.md` 的 `suggestions:`（YAML 列表）⇒ 数组。
	const suggestions = listValue(meta.suggestions);
	// Workspace Grant（2026-10-16 二期；mockup doc/agents-grants-outbox-mockup.html 拍板点 ①）：
	// `workspaces-read: <路径,...>` / `workspaces-write: <路径,...>`（绝对路径，逗号分隔）。
	// **字段不写 = 收紧缺省：只允许引擎缺省 cwd（不显式给 cwd）**——显式跨工作区必须显式声明 ✓。
	// write ⊆ read 语义在 grants.js 的闸里算（写了 write 没写 read ⇒ read 自动含它）。
	const wsRead = listValue(meta['workspaces-read']);
	const wsWrite = listValue(meta['workspaces-write']);
	// 记忆注入（2026-10-19，对齐 DSB 的「SOUL + MEMORY 常驻」语义，但保留我们的轻口径）：
	//   `memory-chars` = 注入 MEMORY.md 的前 N 个**字符**（缺省 2048；0 = 关闭；夹到 512~20000）
	//   `memory-mode`  = `session`（默认，**会话内冻结**：前缀稳定 ⇒ prompt cache 可复用；
	//                             新会话才看得到改动 —— 与 DSB 的 SOUL/MEMORY 冻结同一取舍）
	//                    `live`（旧行为：每 60s 刷新，会话中途也可能变；会让缓存前缀每轮失效 ✗）
	// 非法值一律按默认处理（`session` / 2048），不让一个手写笔误把 agent 变成不注入。
	// 解析真源在 `core/memoryLimits.js`（与写入口/夹值同一条口径，2026-10-20）。
	const { chars: memoryChars, mode: memoryMode } = parseMemoryLimits(meta);
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
			// 展示白名单（`userFacing: true`）与子代理开关（`subagents: false`）：
			// 两者都由 `.agent.md` 自己声明，插件不另维护一份名单（见 isShownAgent / toPresetDefinition）。
			userFacing: String(meta.userFacing ?? '').trim().toLowerCase() === 'true',
			...(String(meta.subagents ?? '').trim().toLowerCase() === 'false' ? { subagents: false } : {}),
			// 委派目标开关（2026-10-20）：`subagent: true` 才进 `allowedAgentPresets`（见 isDelegatableAgent）。
			// ⚠ 与上面的 `subagents: false` 是**两件事**，别混：
			//   · `subagents: false` = "这个 agent 不许自己开子代理"（审查族只留一个席位）；
			//   · `subagent: true`   = "别的 agent 可以点名派活给它"（委派目标）。
			...(String(meta.subagent ?? '').trim().toLowerCase() === 'true' ? { delegatable: true } : {}),
			...(role ? { role } : {}),
			...(skills.length ? { skills } : {}),
			// 欢迎卡的「建议问题」（★ 2026-10-26）：`.agent.md` 写 YAML 列表，
			// `parseFrontmatter` 会拼成逗号串 ⇒ 这里 `listValue` 还原成数组。
			// ⚠ 文案里**不要用半角逗号**（那是分隔符）；用全角「，」或「·」。
			...(suggestions.length ? { suggestions } : {}),
			...(memoryChars !== undefined ? { memoryChars } : {}),
			memoryMode,
			...(modelAssignment ? { modelAssignment } : {}),
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
/**
 * `.agent.md` 的 `tools` 是 **VS Code 口径**（`file_read` / `file_write` / `search_files` / `terminal` / `patch`），
 * 而 dsh 的工具名完全不同 ⇒ 直接传过去会被**整批判为"不认识"**（真机日志：
 * `agent knowledge-base-expert 的 tools 里有 dsh 不认识的名字，已忽略：file_write, file_read, search_files, terminal…`）
 * ⇒ allowlist 实际变成空 ⇒ agent 可能一个工具都用不了 ✗。
 *
 * ★★ 2026-10-19：这张表只覆盖**已知口径差异**；映射后的名字**与原名一起**传给 dsh
 *   （`[...映射名, ...原名]`）—— 这样：
 *     · 认识的映射名 ⇒ 精确生效 ✓
 *     · 原生同名的（`kb_*` / `codebase` / `feishu_*` / `browser` / `unreal_*`）⇒ 原样生效 ✓
 *     · 真的不存在的（`vision_analyze` 之类 IDE 侧工具）⇒ 被 dsh 忽略，但**不影响其它名字** ✓
 *   ⇒ 最坏情况等价于"多几个被忽略的名字"，**不会**把整张 allowlist 弄空 ✗。
 */
const TOOL_ALIAS = {
	// ── VS Code 口径（内置 agent 用的）──────────────────────────────────────
	file_read: ['read'],
	file_write: ['write'],
	patch: ['edit'],
	// IDE 侧 `search_files` 一个工具管"文件名 + 内容"；dsh 拆成两个 ⇒ 都加上
	search_files: ['glob', 'grep'],
	terminal: ['bash'],

	// ── Claude / Cursor 风格（用户自建的 workflow agent 用的）──────────────
	// 真机日志：`builtin-goal-workflow` / `wf-test1` / `wf-test2` 写的是
	// `read_file, list_dir, grep_search, write_to_file, replace_in_file, use_skill` ⇒ 整批被忽略。
	read_file: ['read'],
	write_to_file: ['write'],
	replace_in_file: ['edit'],
	list_dir: ['glob'],
	grep_search: ['grep'],
	use_skill: ['skill'],

	// ── codebase 系**旧工具名**（8 个 agent 的 .agent.md 里还在用）───────────
	// 插件已改名为 `codebase_*`（见各条的 description；`query_graph` 对应
	// `codebase_deps`＝"查一个符号的依赖：出边/入边" ✓，`search_graph` 与 `search_code` 同目标）。
	search_code: ['codebase_search'],
	search_graph: ['codebase_search'],
	query_graph: ['codebase_deps'],
	trace_path: ['codebase_trace'],
	get_architecture: ['codebase_architecture'],
	get_code_snippet: ['codebase_snippet'],
	get_graph_schema: ['codebase_schema'],
	index_repository: ['codebase_index'],
	index_status: ['codebase_index_status'],

	// ⚠ **刻意不映射**（dsh / 插件里没有对等物，映射到别的东西就是撒谎 ✗）：
	//   detect_changes（插件只有 hotspots = 入度/出度最高，语义不同 ✗）
	//   manage_adr / check_index_coverage / web_search / web_extract / clarify
	//   `vision_analyze` / `video_analyze` / `extract_video_frames` 是**真存在**的（插件已注册）⇒ 不需要映射 ✓
};

/** 把 agent 的 tools 列表映射成"dsh 能认的名字 + 原名兜底"。 */
export function toDshTools(names) {
	const out = [];
	const seen = new Set();
	const push = name => {
		const key = String(name ?? '').trim();
		if (!key || seen.has(key)) { return; }
		seen.add(key);
		out.push(key);
	};
	for (const raw of Array.isArray(names) ? names : []) {
		const name = String(raw ?? '').trim();
		if (!name) { continue; }
		for (const mapped of TOOL_ALIAS[name] ?? []) { push(mapped); }
		push(name);   // 原名始终保留（原生同名的就靠它 ✓）
	}
	return out;
}

/**
 * 不论 agent 的 `tools` 写没写，都**不许**拿去 deny 的名字。
 * `skill`：host 层与基座（`tool-skill` 行）**同名**各有一份；`restrict({ deny })` 按名字筛，会把基座那份一起藏掉，
 * 而 agent 的 `skills:` 只能靠这个工具加载 ⇒ 藏了就等于技能全废。
 * （同名遮蔽在运行时还会再判一次，见 `allowlistDenyOf` 的 `shadowed`；这里是拿不到作用域视图时的兜底。）
 */
export const ALWAYS_KEEP_TOOL_NAMES = Object.freeze(['skill']);

/**
 * agent 的 `tools` allowlist → 要在 **agent 作用域** `restrict({ deny })` 的全局工具名。
 *
 * 口径（2026-10-25）：`tools` 只收窄 **host 层全局工具**（kb_* / memory_* / codebase_* / mcp__* / browser …）；
 * 基座（presetBase）在 preset 层挂的官方工具（fs / pwsh / web / skill / todo …）**始终可用**。
 * 为什么用 deny 而不是 allow：allow 一旦生效，agent 从 preset 层**继承**来的基座工具也会被筛掉
 * （dsh-tools `view()`：restriction filters what a scope inherits — global + every ancestor layer），
 * 而 preset 层的名字在 preset 作用域里又**不能**写进 allow（restrictableNames 不含本层，直接抛）。
 *
 * @param wanted       `toDshTools(agent.tools)`（声明要保留的名字）
 * @param globalNames  host 层全局工具名（`tools.schemas()` 不带 scope 的结果）
 * @param shadowed     `(name) => boolean`：该名在 agent 视图里被 preset 层 / agent 自身层的同名实现遮蔽
 * @returns 去重、排序后的 deny 名单（不含 `run_code`：PTC 保留名，restrict 点名它会抛）
 */
export function allowlistDenyOf(wanted, globalNames, shadowed = () => false) {
	const keep = new Set([...(Array.isArray(wanted) ? wanted : []), ...ALWAYS_KEEP_TOOL_NAMES]);
	const out = new Set();
	for (const raw of Array.isArray(globalNames) ? globalNames : []) {
		const name = String(raw ?? '').trim();
		if (!name || name === 'run_code' || keep.has(name)) { continue; }
		let isShadowed = false;
		try { isShadowed = shadowed(name) === true; } catch { isShadowed = false; }
		if (!isShadowed) { out.add(name); }
	}
	return [...out].sort();
}

/**
 * 每个 agent preset 都**必须**带的基座行（缺了 = agent 没有文件/命令/技能/压缩能力）。
 * 自检（`test/run-agents-check.mjs`）与诊断 notes 都按这张表判；只列"缺了就废"的那几行。
 */
export const REQUIRED_BASE_ROW_IDS = Object.freeze(['agent-instructions', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'compaction']);

/** 深拷贝基座（JsExpr 是纯对象 `{ __jsExpr }`，JSON 往返无损）——每个 preset 一份，互不共享引用。 */
function cloneBaseRows() {
	return JSON.parse(JSON.stringify(STANDARD_BASE_ROWS));
}

/** 在行树（含 `cordis:group` 的子行）里按 id 找行。 */
function findRow(rows, id) {
	for (const row of rows) {
		if (row?.id === id) { return row; }
		if (row?.group && Array.isArray(row.config)) {
			const hit = findRow(row.config, id);
			if (hit) { return hit; }
		}
	}
	return undefined;
}

/** 行树里的全部 id（含 group 子行，深度优先）——自检与诊断用。 */
export function rowIdsOf(rows) {
	const out = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (row?.id) { out.push(row.id); }
		if (row?.group && Array.isArray(row.config)) { out.push(...rowIdsOf(row.config)); }
	}
	return out;
}

export function toPresetDefinition(agent, options = {}) {
	const notes = [];
	// 先算一次（下面 length 判断与传值都要用，别调两遍）
	const dshTools = toDshTools(agent.tools);
	// ★★ 2026-10-25：从**共享基座**起步（= 官方 standard 的全部行，见 presetBase.generated.js），再叠本 agent 的差量。
	//   之前这里只有 persona / model / compaction / subagent 几行 ⇒ agent 会话里 `tool-fs` / `tool-pwsh` /
	//   `skill-filesystem` / `tool-skill` / `agent-instructions` 一行都没有（host plane 不提供它们）⇒
	//   真机：「本会话没有命令执行工具，pwsh、bash、exec 一个都没有」，技能也加载不了。
	//   缺什么补什么（compaction 10-21、subagent 10-19~21）是同一个根因反复发作 ⇒ 改成生成 + 守卫。
	const plugins = cloneBaseRows();
	// 人设行：与官方 persona 行同 id（基座里官方那行已去掉），放第一位
	plugins.unshift({
		id: 'persona',
		name: PERSONA_ROW_NAME,
		// persona / tools 走 config：本包在该 preset 作用域内被再挂一次，注册提示词 section 与工具 allowlist
		config: {
			agentId: agent.id,
			persona: agent.persona,
			// ★ 2026-10-19：`tools` 是 VS Code 口径 ⇒ 先映射成 dsh 认得的名字（见 TOOL_ALIAS 的注释）
			...(dshTools.length ? { tools: dshTools } : {}),
			// 记忆注入口径（见 `agentFromFile` 头注释）：`memory-chars` 缺省 = 2048（`readMemorySnapshot` 的默认）
			...(agent.memoryChars !== undefined ? { memoryChars: agent.memoryChars } : {}),
			memoryMode: agent.memoryMode ?? 'session',
		},
	});
	const provider = typeof options.provider === 'string' ? options.provider.trim() : '';
	// `options.modelOverride` = 派生 preset（委派版）用它自己的模型；留空就用 agent 自己的 `model`
	const modelText = typeof options.modelOverride === 'string' && options.modelOverride.trim()
		? options.modelOverride.trim()
		: agent.model;
	if (modelText) {
		// `model` 允许写成 `provider/model` 显式指定；否则用 defaultProvider
		const [maybeProvider, maybeModel] = modelText.includes('/') ? modelText.split('/', 2) : ['', modelText];
		const route = maybeProvider.trim() || provider;
		if (route && maybeModel.trim()) {
			// 紧跟人设行（行序不影响语义，放前面只是 readDocument 里好找）
			plugins.splice(1, 0, { id: 'default-model', name: DEFAULT_MODEL_ROW_NAME, config: { provider: route, model: maybeModel.trim() } });
		} else {
			notes.push(`模型未映射（agent.md 写了 model=${modelText}，但没配 config.defaultProvider 且不是 provider/model 形式）→ 该 preset 跟随默认模型`);
		}
	}
	if (agent.tools.length) {
		// tools 转 dsh 的工具 allowlist：运行时在 **agent 作用域** `restrict({ deny })`（见 lib/index.js 的
		// `installAllowlist` 与上面的 `allowlistDenyOf`）—— 只收窄 host 层全局工具，基座官方工具始终可用。
		notes.push(`tools 进 allowlist（${agent.tools.length} 个：${agent.tools.slice(0, 4).join(', ')}${agent.tools.length > 4 ? '…' : ''}）；只收窄 host 层全局工具，基座里的官方工具不受约束`);
	}
	if (!agent.persona) {
		notes.push('agent.md 正文为空 → 该 preset 没有人设提示词');
	}
	// ── 上下文压缩：基座已带官方 `compaction` 组（compaction-basic + command-compact + tool-result-pruner，
	//    group + isolate 形状、阈值与官方同值）⇒ 不再手抄（2026-10-21 那次 P0 就是手抄补上的）。
	//    派生 preset（`-assign`）同样保留：委派会话同样会长，同样需要裁剪。
	//
	// ── 子代理（2026-10-19 起）：基座的 `delegation` 组 = 官方 control → list-agents → subagent → fork
	//    + workflow-ptc / tool-workflow。这里只做差量：
	//    · 本体 preset：`tool-subagent` 补 `backgroundMode: 'continuable'` 与动态清单 `allowedAgentPresets`；
	//      `tool-subagent-fork` 补 `backgroundMode`（⚠ fork **不能**带清单：fork 继承父上下文，
	//      `assertProvider` 会拒绝"继承上下文 + 独立选 preset"，直接抛错）。
	//    · `subagents: false`（审查族"只有一个席位"）与派生 preset（`-assign`，不再 fan-out）：
	//      **整组去掉**。为什么不能靠 tools 里不写 subagent 来关：`restrict()` 拦不住本 preset 作用域内
	//      挂的行（见上）⇒ 只能在装配层不给这一组 —— 提示词里的「One Seat」是意愿，这里才是真闸。
	//    清单为空时**不带** `allowedAgentPresets` = 官方语义"继承父会话的 preset"（工具仍在，只是看不到
	//    `agent_preset` 参数）；且清单一直为空时配置不变 ⇒ 新建/删除 agent 不触发重挂（churn=0）。
	const allowed = Array.isArray(options.allowedAgentPresets)
		? [...new Set(options.allowedAgentPresets.filter(id => typeof id === 'string' && id && id !== presetIdOf(agent.id)))].sort()
		: [];
	const isDerivedPreset = typeof options.idSuffix === 'string' && options.idSuffix !== '';
	const delegationIndex = plugins.findIndex(row => row?.id === 'delegation');
	if (isDerivedPreset || agent.subagents === false) {
		if (agent.subagents === false) {
			notes.push('subagents: false → 该 agent 不挂 delegation 组（subagent / fork / workflow；审查族只有一个席位）');
		}
		if (delegationIndex >= 0) {
			plugins.splice(delegationIndex, 1);
		}
	} else {
		if (!allowed.length) {
			notes.push('没有 agent 标 `subagent: true` ⇒ 子代理只能继承当前 preset（不显示可选清单）');
		}
		const sub = findRow(plugins, 'tool-subagent');
		const fork = findRow(plugins, 'tool-subagent-fork');
		if (!sub || !fork) {
			notes.push('基座里没有 tool-subagent / tool-subagent-fork 行（官方 standard 结构变了？）⇒ 本 agent 没有子代理工具');
		}
		if (sub) {
			sub.config = { ...(sub.config ?? {}), backgroundMode: 'continuable', ...(allowed.length ? { allowedAgentPresets: allowed } : {}) };
		}
		if (fork) {
			fork.config = { ...(fork.config ?? {}), backgroundMode: 'continuable' };
		}
	}
	// 基座完整性：缺任何一行"缺了就废"的行都写进 notes（页面/日志可见，不静默）
	const presentIds = new Set(rowIdsOf(plugins));
	const missing = REQUIRED_BASE_ROW_IDS.filter(id => !presentIds.has(id));
	if (missing.length) {
		notes.push(`基座缺行：${missing.join(', ')}（跑 node dsh-plugins/preset-sync.mjs --write-agent-base）`);
	}
	const idSuffix = typeof options.idSuffix === 'string' ? options.idSuffix : '';
	const nameSuffix = typeof options.nameSuffix === 'string' ? options.nameSuffix : '';
	const definition = {
		id: presetIdOf(agent.id) + idSuffix,
		name: agent.name + nameSuffix,
		plugins,
	};
	// 人设行带上本 preset 的 id：运行时 allowlist 只认"会话 agentPreset == 本 id"的 agent（防误伤别的 preset）
	if (plugins[0]?.id === 'persona' && plugins[0].config) {
		plugins[0].config.presetId = definition.id;
	}
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
