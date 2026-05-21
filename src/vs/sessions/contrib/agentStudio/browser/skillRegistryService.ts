/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
/**
 * Skill 注册表实现 —— 见 `common/skills.ts` 接口契约。
 *
 * 加载策略（重构后：统一技能库架构）：
 *   1. `_loadBuiltins()`        —— 内置 skill 模块（产品自带，硬编码常量数组）
 *      1a. `BUILTIN_SKILLS`     —— Sarosis 原生核心 skill（4 个，始终加载）
 *      1b. `BUNDLED_SKILLS`     —— 从 Hermes-Agent 迁移的打包 skill（87 个，始终加载）
 *   2. `_scanFolder(roaming)`   —— 用户全局技能库 `<userRoamingDataHome>/sarosis/skills-library/`
 *   3. `registerSkill(...)`     —— 运行时由扩展通过 IAgentOSService 注入
 *
 * 后注册的同名 skill 覆盖前者（运行时注入 > 用户 > 内置），
 * 这与 hermes 的 `optional-skills` < `skills` < `~/.hermes/skills` 优先级一致。
 *
 * 架构变更说明：
 *   - 原架构：技能按 agent 实例隔离存储于 `.sarosisworkspace/agents/<agentDir>/skills/`
 *   - 新架构：技能统一存储于用户全局技能库（`~/.sarosis/skills-library/`），agent 仅保存技能 ID 引用
 *   - 好处：避免技能重复存储，便于版本管理和升级
 *
 * Skill 文件格式（仿 hermes 与 Claude SKILL.md 标准）：
 *
 *   ---
 *   name: code-review
 *   description: ...
 *   activation: auto
 *   match: [review, refactor, lint]
 *   category: code
 *   recommended_tools: [file_read, terminal]
 *   ---
 *   <skill body in markdown>
 */

import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { stringHash } from '../../../../base/common/hash.js';
import {
	ISkillRegistry, ISkillDefinition, ISkillActivationContext, ISkillInjection,
	SkillActivation,
} from '../common/skills.js';
import { BUNDLED_SKILLS } from '../common/bundled-skills/bundledSkills.js';
import { ISkillLifecycleService, ISkillBatchLifecyclePayload } from '../common/skillLifecycle.js';

/**
 * 计算 skill 内容指纹：基于 prompt 正文生成 8 位十六进制哈希。
 * 用于判断不同目录下同名 skill 是否内容完全一致。
 */
function computeSkillContentHash(prompt: string): string {
	const h = stringHash(prompt.trim(), 0);
	// 转为无符号 32 位整数后输出 8 位十六进制
	return (h >>> 0).toString(16).padStart(8, '0');
}

interface IRawFrontmatter {
	name?: unknown;
	description?: unknown;
	activation?: unknown;
	match?: unknown;
	category?: unknown;
	recommended_tools?: unknown;
	recommendedTools?: unknown;
}

/**
 * 一组随产品发布的内置 skill。
 * 之所以用常量数组而不是物理文件，是为了在 web/electron 两端零成本可用 ——
 * 无需打包额外资源，也无需走 IFileService 异步加载即可参与首屏。
 */
const BUILTIN_SKILLS: ISkillDefinition[] = [
	{
		id: 'code-review',
		name: 'Code Review',
		description: '对当前 diff/文件进行快速代码评审，关注正确性、风格、可维护性。',
		activation: 'auto',
		match: ['review', 'code review', '评审', '审查代码', 'code-review'],
		category: 'code',
		recommendedTools: ['file_read', 'terminal'],
		source: 'builtin',
		enabled: true,
		prompt: [
			'You are running the **code-review** skill.',
			'',
			'Review the relevant code with the following lens, in order:',
			'1. **Correctness** — logic bugs, off-by-one, null handling, race conditions.',
			'2. **Edge cases** — empty input, unicode, large input, concurrent callers.',
			'3. **Readability** — naming, function length, comment density.',
			'4. **Maintainability** — coupling, duplication, dead code, missing tests.',
			'5. **Security & perf** — only call out concrete issues, never hand-wave.',
			'',
			'Output format: a numbered list grouped by file path. Use `path:line` citations.',
			'When you suggest a change, provide a small unified diff so the user can apply it.',
		].join('\n'),
	},
	{
		id: 'commit-message',
		name: 'Commit Message',
		description: '基于当前已暂存改动生成符合 Conventional Commits 的提交信息。',
		activation: 'manual',
		category: 'git',
		recommendedTools: ['shell_exec'],
		source: 'builtin',
			enabled: true,
		prompt: [
			'You are running the **commit-message** skill.',
			'',
			'1. Read the staged diff via `git diff --cached --stat` and `git diff --cached`.',
			'2. Pick a Conventional Commits type (feat/fix/refactor/docs/test/chore/perf/build/ci).',
			'3. Pick a scope from the most-changed top-level directory.',
			'4. Write a subject ≤ 72 chars, imperative mood, no trailing period.',
			'5. Write a body (optional) explaining *why*, not *what*.',
			'',
			'Return ONLY the final commit message in a fenced ```text block. Do not narrate.',
		].join('\n'),
	},
	{
		id: 'be-concise',
		name: 'Be Concise',
		description: '保持简短回答，避免赘述。always 类型。',
		activation: 'always',
		category: 'meta',
		source: 'builtin',
		enabled: true,
		prompt: [
			'Behavioral guidance: keep replies short. Prefer bullet lists over paragraphs.',
			'Cut filler such as "I will now…", "Let me…", "Sure!". Do not restate the question.',
		].join('\n'),
	},
	{
		id: 'plan-then-act',
		name: 'Plan then Act',
		description: '复杂任务先规划后执行 —— 给出步骤后再调用工具。',
		activation: 'auto',
		match: ['refactor', 'rewrite', 'migrate', 'redesign', '架构', '重构'],
		category: 'meta',
		source: 'builtin',
		enabled: true,
		prompt: [
			'You are running the **plan-then-act** skill.',
			'',
			'Before invoking any tool, output a short numbered plan (3-7 steps).',
			'Then mark `--- begin execution ---` on its own line and start the first tool call.',
			'After every tool result, briefly note whether the result confirms or invalidates the plan.',
		].join('\n'),
	},
	{
		id: 'configmd',
		name: 'ConfigMD',
		description: '让 agent 自主创建/编辑当前实例的 ConfigMD（含 imgui 表单 DSL）。',
		// `auto` so it kicks in when the user mentions ConfigMD-related work
		// without forcing it on every turn (ConfigMD prompts are fairly
		// chunky — we don't want them in every system message).
		activation: 'auto',
		match: [
			'configmd', 'config.md', 'config md',
			'imgui', 'imgui form', 'imgui 表单',
			'配置面板', 'agent 面板', 'agent panel',
			'agent-state', 'agent-bind',
			'修改面板', '编辑面板', '更新进度', '推送进度', 'toast',
		],
		category: 'meta',
		recommendedTools: [],
		source: 'builtin',
		enabled: true,
		prompt: [
			'You are running the **configmd** skill.',
			'',
			'## What is ConfigMD?',
			'',
			'Each agent instance owns a `config.md` file at',
			'`<workspace>/.sarosisworkspace/agents/<agentDir>/config.md`. Its contents are',
			'rendered into a webview panel inside the agent editor as an interactive UI.',
			'You — the agent — can both **read** the current panel state and **drive** the',
			'panel by emitting structured code blocks in your reply. The host parses those',
			'blocks out of your message, applies them to disk, and pushes runtime commands',
			'into the live preview.',
			'',
			'## When this skill is active you should:',
			'',
			'1. If the user asks you to *create* a panel from scratch, write the full',
			'   `config.md` body in a `configmd-patch` block (see schema below). Default to',
			'   the imgui DSL for any interactive sections.',
			'2. If the user asks you to *modify* something specific (a section, a',
			'   progress value, a status badge), prefer **targeted ops** over rewriting the',
			'   whole file: `replace-anchor`, `replace-bind`, `append`, etc.',
			'3. If the user asks you to *push live state* without rewriting the markdown',
			'   (e.g. "set progress to 60"), emit a `configmd-command` block instead — that',
			'   updates the preview in-place via the SDK without touching `config.md`.',
			'',
			'## Two block types you can emit in your replies',
			'',
			'### A) `configmd-patch` — durable edits to `config.md`',
			'',
			'Each entry in the array is one `IConfigMdPatchOp`:',
			'',
			'```configmd-patch',
			'[',
			'  { "op": "replace-all",     "content": "<full new markdown>" },',
			'  { "op": "replace-anchor",  "anchor": "tasks", "content": "- [x] step 1\\n- [ ] step 2" },',
			'  { "op": "replace-bind",    "anchor": "progress", "content": "60%" },',
			'  { "op": "append",          "content": "\\n## New section\\n…" }',
			']',
			'```',
			'',
			'`replace-anchor` rewrites the body between',
			'`<!-- agent-state:NAME -->` and `<!-- /agent-state:NAME -->` markers.',
			'',
			'`replace-bind` rewrites the body between',
			'`<!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->` (use this for inline',
			'numeric/string status, e.g. "60%", "已完成").',
			'',
			'### B) `configmd-command` — transient commands pushed to the live preview',
			'',
			'```configmd-command',
			'{ "name": "imgui.set_one", "params": { "id": "overall", "value": 80 } }',
			'```',
			'',
			'Supported names:',
			'- `imgui.set_one`   `{ id, value, max? }`            — update a single control',
			'- `imgui.set`       `{ values: { id1: v1, ... } }`   — batch update many controls',
			'- `imgui.toast`     `{ message, variant?, duration? }` — variant: success | warning | error | info',
			'- `imgui.reset`     `{ formId? }`                     — reset a form to defaults',
			'',
			'## imgui DSL — when authoring a fresh panel',
			'',
			'Wrap interactive UI in fenced ` ```imgui ` blocks; the host turns them into HTML',
			'forms. One widget per logical line, function-call syntax `widget(args)`. Lines',
			'with unbalanced brackets are joined with the next line, so multi-line button',
			'definitions are fine.',
			'',
			'### Widgets',
			'',
			'| Group | Syntax |',
			'|---|---|',
			'| Containers | `row_start()` / `row_end()` · `column_start()` / `column_end()` |',
			'| Static    | `heading("…")` · `text("…")` · `divider()` · `spacer()` |',
			'| Display   | `progress(id, label, value, max?)` · `badge("text", color="success\\|warning\\|danger\\|info\\|default")` |',
			'| Input     | `input_text(id, label, placeholder?, value?)` · `textarea(id, label, rows?)` · `number(id, label, min?, max?, value?)` |',
			'| Choice    | `select(id, label, options=[...], value?)` · `radio(id, label, options=[...], value?)` · `checkbox(id, label, value?)` |',
			'| Slider    | `slider(id, label, min, max, value?)` |',
			'| Button    | `button(id, label, action=…, template?, variant?, confirm?, anchor?, skill?, payload?, state?)` |',
			'',
			'### Button actions',
			'',
			'| Action | Required | Effect |',
			'|---|---|---|',
			'| `send_to_chat` *(default)* | — | Render `template` and send as a chat message |',
			'| `run_skill` | `skill="…"` | Same as send_to_chat but auto-prefixes `[skill:NAME]` |',
			'| `set_state` | `anchor="…"` | Replace the `<!-- agent-state:NAME -->` block with the rendered template |',
			'| `patch`     | `payload="JSON"` | Apply IConfigMdPatchOp[] from the payload |',
			'| `clear_chat` | — | Clear the chat history (always pair with `confirm="…"`) |',
			'| `noop`      | — | Trigger only client-side SDK behaviour |',
			'',
			'`state="ANCHOR"` (any action) — before the action runs, snapshot the form\'s',
			'current values into the named `agent-state` anchor as a JSON code block.',
			'`template` supports `{id}` placeholders that resolve to other controls\' values.',
			'',
			'### Anchors you can use in the markdown body',
			'',
			'```markdown',
			'<!-- agent-state:tasks -->',
			'- [ ] step 1',
			'<!-- /agent-state:tasks -->',
			'',
			'当前进度: <!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->',
			'```',
			'',
			'## Authoring guidelines',
			'',
			'- Prefer `replace-anchor` / `replace-bind` over `replace-all` whenever',
			'  possible — they preserve sections you don\'t care about.',
			'- Keep imgui forms small (≤ 8 inputs per form). Compose multiple ` ```imgui `',
			'  blocks separated by markdown headings instead of one giant form.',
			'- Always give buttons that send to chat a `template=` so the chat receives a',
			'  clear, structured message (use `{id}` placeholders to splice form values).',
			'- For destructive buttons (clear chat, reset, etc.) always set',
			'  `confirm="<warning>"` to require a two-click gesture.',
			'',
			'## Example — a small "research kickoff" panel',
			'',
			'```configmd-patch',
			'[{ "op": "replace-all", "content": "# 研究助手\\n\\n## 启动调研\\n\\n```imgui\\nheading(\\"新一轮调研\\")\\ninput_text(id=\\"topic\\", label=\\"主题\\", placeholder=\\"例：AI Agent\\")\\nslider(id=\\"depth\\", label=\\"深度\\", min=1, max=5, value=3)\\nbutton(id=\\"go\\", label=\\"开始\\", action=\\"send_to_chat\\", state=\\"snap\\", template=\\"请按主题《{topic}》以深度 {depth}/5 开始调研。\\")\\n```\\n\\n## 状态\\n\\n进度: <!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->\\n\\n## 快照\\n\\n<!-- agent-state:snap -->\\n```json\\n{}\\n```\\n<!-- /agent-state:snap -->\\n" }]',
			'```',
			'',
			'When in doubt: emit one fenced block at a time, keep the JSON compact, do not',
			'wrap the block in additional prose unless it\'s purely diagnostic for the user.',
		].join('\n'),
	},
];

/**
 * 解析极简 YAML frontmatter（不依赖第三方库，只支持我们文档中描述的子集）。
 * 支持：
 *   - `key: value`
 *   - `key: [a, b, c]` 一行内联数组
 *   - `key:` 后跟 `  - item` 缩进数组
 *   - 字符串自动 trim 并去除首尾引号
 */
function parseFrontmatter(text: string): { meta: IRawFrontmatter; body: string } {
	if (!text.startsWith('---')) {
		return { meta: {}, body: text };
	}
	const end = text.indexOf('\n---', 3);
	if (end < 0) {
		return { meta: {}, body: text };
	}
	const headerLines = text.slice(3, end).split('\n');
	const body = text.slice(end + 4).replace(/^\r?\n/, '');

	const meta: Record<string, unknown> = {};
	let pendingArrayKey: string | undefined;
	let pendingArray: string[] | undefined;
	const flushArray = () => {
		if (pendingArrayKey && pendingArray) {
			meta[pendingArrayKey] = pendingArray;
		}
		pendingArrayKey = undefined;
		pendingArray = undefined;
	};

	for (const rawLine of headerLines) {
		const line = rawLine.replace(/\r$/, '');
		if (!line.trim()) {
			continue;
		}
		const arrayItem = /^\s+-\s+(.*)$/.exec(line);
		if (arrayItem && pendingArrayKey) {
			pendingArray!.push(stripQuotes(arrayItem[1].trim()));
			continue;
		}
		const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) {
			continue;
		}
		flushArray();
		const key = kv[1];
		const rawVal = kv[2].trim();
		if (rawVal === '') {
			pendingArrayKey = key;
			pendingArray = [];
			continue;
		}
		const inlineArr = /^\[(.*)\]$/.exec(rawVal);
		if (inlineArr) {
			meta[key] = inlineArr[1].split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
			continue;
		}
		meta[key] = stripQuotes(rawVal);
	}
	flushArray();
	return { meta, body };
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
		return s.slice(1, -1);
	}
	return s;
}

function normalizeActivation(v: unknown): SkillActivation {
	if (v === 'always' || v === 'manual' || v === 'auto') {
		return v;
	}
	return 'manual';
}

function asStringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) { return undefined; }
	return v.filter((x): x is string => typeof x === 'string');
}

export class SkillRegistry extends Disposable implements ISkillRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _skills = new Map<string, ISkillDefinition>();
	private readonly _runtimeSkills = new Map<string, ISkillDefinition>();
	private readonly _onDidChangeSkills = this._register(new Emitter<void>());
	readonly onDidChangeSkills: Event<void> = this._onDidChangeSkills.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@ILogService private readonly logService: ILogService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
	) {
		super();
		this.logService.info('[SkillRegistry] constructor called');
		// 立即填充内置 skill，使 UI 在文件扫描完成前已可显示。
		this._loadBuiltins();
		this.logService.info(`[SkillRegistry] after _loadBuiltins in ctor: ${this._skills.size} skills available synchronously`);
		// 异步扫描磁盘 skill —— 失败不影响内置 skill 可用性。
		this.reload().catch(err => this.logService.warn('[SkillRegistry] initial reload failed', err));
	}

	getSkills(): readonly ISkillDefinition[] {
		this.logService.trace(`[SkillRegistry] getSkills() called, returning ${this._skills.size} skills`);
		return [...this._skills.values()];
	}

	getSkill(id: string): ISkillDefinition | undefined {
		return this._skills.get(id);
	}

	registerSkill(skill: ISkillDefinition): IDisposable {
		const id = skill.id;
		const registered: ISkillDefinition = {
			...skill,
			source: skill.source ?? 'memory',
			contentHash: skill.contentHash ?? computeSkillContentHash(skill.prompt),
		};
		this._runtimeSkills.set(id, registered);
		this._skills.set(id, registered);
		this._onDidChangeSkills.fire();
		this.logService.info(`[SkillRegistry] runtime skill registered: ${id}`);
		return toDisposable(() => {
			this._runtimeSkills.delete(id);
			// 重新加载，让被覆盖的内置 / 文件 skill 回到 _skills 表。
			this.reload().catch(() => undefined);
		});
	}

	resolveActivations(context: ISkillActivationContext): Promise<readonly ISkillInjection[]> {
		const out: ISkillInjection[] = [];
		const explicit = new Set((context.explicit ?? []).map(s => s.toLowerCase()));
		const userMsg = context.userMessage.toLowerCase();

		for (const skill of this._skills.values()) {
			// 首先检查 skill 是否启用
			if (skill.enabled === false) { continue; }

			let take = false;
			if (skill.activation === 'always') {
				take = true;
			} else if (explicit.has(skill.id.toLowerCase())) {
				take = true;
			} else if (skill.activation === 'auto' && skill.match) {
				take = skill.match.some(kw => userMsg.includes(kw.toLowerCase()));
			}
			if (!take) { continue; }

			out.push({
				skill,
				// 与 hermes 一致：以独立 user message 注入，避免 system prompt 失效缓存。
				placement: skill.activation === 'always' ? 'system' : 'user',
				content: this._renderInjection(skill),
			});
		}

		return Promise.resolve(out);
	}

	/** 启用指定 skill */
	enableSkill(id: string): void {
		const skill = this._skills.get(id);
		if (skill) {
			// 由于 ISkillDefinition.enabled 不是 readonly，我们可以直接修改
			(skill as { enabled: boolean }).enabled = true;
			this.logService.info(`[SkillRegistry] skill enabled: ${id}`);
			this._onDidChangeSkills.fire();
		}
	}

	/** 禁用指定 skill */
	disableSkill(id: string): void {
		const skill = this._skills.get(id);
		if (skill) {
			(skill as { enabled: boolean }).enabled = false;
			this.logService.info(`[SkillRegistry] skill disabled: ${id}`);
			this._onDidChangeSkills.fire();
		}
	}

	async reload(): Promise<void> {
		this.logService.info(`[SkillRegistry] reload() called`);
		this._skills.clear();
		this._loadBuiltins();
		this.logService.info(`[SkillRegistry] after _loadBuiltins: ${this._skills.size} skills`);

		// 用户全局技能库
		try {
			const userDir = URI.joinPath(this.environmentService.userRoamingDataHome, 'sarosis', 'skills-library');
			this.logService.info(`[SkillRegistry] scanning user skills-library: ${userDir.toString()}`);
			await this._scanFolder(userDir, 'user');
			this.logService.info(`[SkillRegistry] after user scan: ${this._skills.size} skills`);
		} catch (err) {
			this.logService.debug('[SkillRegistry] no user skills-library dir', err);
		}

		// 运行时注入的 skill 永远胜出
		for (const [id, skill] of this._runtimeSkills) {
			this._skills.set(id, skill);
		}
		if (this._runtimeSkills.size > 0) {
			this.logService.info(`[SkillRegistry] runtime skills merged: ${this._runtimeSkills.size}`);
		}

		this.logService.info(`[SkillRegistry] reload() complete: total ${this._skills.size} skills`);
		this._onDidChangeSkills.fire();

		// Fire a batch Synced event so external consumers (e.g. knot-agui) can
		// re-sync their local skill mirrors after any reload (install, uninstall,
		// filesystem changes, etc.).
		this._fireBatchSyncedEvent();
	}

	/**
	 * Fire a batch synced event with all current user skill IDs.
	 * This triggers external consumers (like knot-cli sync) to do a full
	 * reconciliation of their skill mirror directories.
	 *
	 * Note: Skills are now stored only in user global directory (~/.sarosis/skills-library/),
	 * so we fire event with user skill IDs only.
	 */
	private _fireBatchSyncedEvent(): void {
		const userSkillIds = [...this._skills.values()]
			.filter(s => s.source === 'user')
			.map(s => s.id);

		if (userSkillIds.length === 0) { return; }

		// Use empty workspacePath to indicate this is a user-global event
		const payload: ISkillBatchLifecyclePayload = {
			workspacePath: '',
			agentId: '',
			skillIds: userSkillIds,
			timestamp: new Date().toISOString(),
		};

		void this.skillLifecycleService.fireBatchEvent(payload).catch(err => {
			this.logService.debug(`[SkillRegistry] batch synced event failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	// ─── 内部 ────────────────────────────────────────────────

	private _loadBuiltins(): void {
		// 1a. Sarosis 原生核心 skill — 优先加载，ID 不会被覆盖
		for (const s of BUILTIN_SKILLS) {
			this._skills.set(s.id, { ...s, contentHash: computeSkillContentHash(s.prompt), enabled: true });
		}
		this.logService.info(`[SkillRegistry] _loadBuiltins: ${BUILTIN_SKILLS.length} core skills loaded`);
		// 1b. 从 Hermes-Agent 迁移的打包 skill — 同名 ID 不覆盖原生 skill
		let bundledCount = 0;
		for (const s of BUNDLED_SKILLS) {
			if (!this._skills.has(s.id)) {
				this._skills.set(s.id, { ...s, contentHash: computeSkillContentHash(s.prompt), enabled: true });
				bundledCount++;
			}
		}
		this.logService.info(`[SkillRegistry] _loadBuiltins: ${bundledCount}/${BUNDLED_SKILLS.length} bundled skills loaded (${BUNDLED_SKILLS.length - bundledCount} skipped as duplicates)`);
	}

	private async _scanFolder(dir: URI, source: 'user'): Promise<void> {
		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			this.logService.debug(`[SkillRegistry] _scanFolder: dir not found: ${dir.toString()}`);
			return; // 目录不存在
		}
		if (!stat.isDirectory || !stat.children) {
			this.logService.debug(`[SkillRegistry] _scanFolder: not a dir or no children: ${dir.toString()}`);
			return;
		}

		this.logService.info(`[SkillRegistry] _scanFolder(${source}): scanning ${dir.toString()}, ${stat.children.length} children`);
		let loaded = 0;
		for (const child of stat.children) {
			if (!child.isDirectory) { continue; }
			const skillFile = URI.joinPath(child.resource, 'SKILL.md');
			try {
				const content = await this.fileService.readFile(skillFile);
				const text = content.value.toString();
				const skill = this._parseSkillFile(child.resource, text, source);
				if (skill) {
					this._skills.set(skill.id, skill);
					loaded++;
				} else {
					this.logService.warn(`[SkillRegistry] _scanFolder: parse returned null for ${skillFile.toString()}`);
				}
			} catch {
				// SKILL.md 可缺失，忽略
			}
		}
		this.logService.info(`[SkillRegistry] _scanFolder(${source}): loaded ${loaded} skills from ${dir.toString()}`);
	}

	private _parseSkillFile(folder: URI, text: string, source: 'user'): ISkillDefinition | undefined {
		const { meta, body } = parseFrontmatter(text);
		const name = typeof meta.name === 'string' ? meta.name : undefined;
		if (!name) {
			this.logService.warn(`[SkillRegistry] SKILL.md missing 'name': ${folder.toString()}`);
			return undefined;
		}
		const description = typeof meta.description === 'string' ? meta.description : '';
		const id = name.toLowerCase().replace(/\s+/g, '-');
		const prompt = body.trim();
		return {
			id,
			name,
			description,
			activation: normalizeActivation(meta.activation),
			match: asStringArray(meta.match),
			category: typeof meta.category === 'string' ? meta.category : undefined,
			recommendedTools: asStringArray(meta.recommended_tools) ?? asStringArray(meta.recommendedTools),
			prompt,
			source,
			resource: folder,
			contentHash: computeSkillContentHash(prompt),
			enabled: true, // 默认启用
		};
	}

	private _renderInjection(skill: ISkillDefinition): string {
		// 与 hermes 的 skill_commands.py 一致：明确告诉模型这是一段「skill」内容，
		// 让它把 skill body 作为本轮的执行准则。
		return [
			`### Skill activated: ${skill.name}`,
			skill.description ? `_${skill.description}_` : '',
			'',
			skill.prompt,
		].filter(Boolean).join('\n');
	}
}
