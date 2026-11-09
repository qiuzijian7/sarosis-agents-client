/**
 * @vssaros/dsh-skills — 能力库（2026-11-08，换架构第一步 / L0）。
 *
 * ★ 设计来源：参考 DS Bot 的 `state.capabilities.items`（全队共享 name→item 表）+
 *   `bot.capabilities`（名字数组）+ `expandCapabilityNames()`（pack 展开）。
 *   但**不照搬它的缺陷**：DS Bot 的 attach 只做加法、不裁剪公共目录，且 list_capabilities 无上限。
 *   我们这里的 attach 直接决定「哪些 candidate 是 modelInvocable」，由官方
 *   `dsh-tool-skill` 的 `snapshot().filter(isModelInvocable)` 天然收窄目录 ⇒ 不改官方消息、
 *   不碰 digest、不需要 prepend。
 *
 * ★ 与 P0/P2 的关系：
 *   · `.agent.md` 的 `skills[]` 仍是显式点名（绕过 tier，永远可见）；
 *   · `capabilities[]` 是能力包名，用 PACKS 展开（只加不减）；
 *   · 未声明 ⇒ 只挂 default 包（tier=core 的那 40 个），**不是全量**；
 *   · tier 从「渲染期过滤」变成「默认 attach 集」，语义更干净。
 *
 * 纯函数 + 显式注入 library ⇒ 守卫可离线 import 断言，不依赖 dsh 运行时。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 缺省挂载的包名：只有 tier=core 的技能常驻可见。 */
export const DEFAULT_CAPABILITY_PACK = 'core';

/** 内置能力包 → 技能名 / 谓词。包只做加法，永远不做减法。 */
/**
 * 技能能力包目录（2026-11-08：给 21 个内置 agent 配置时按**真实随包技能名**重建）。
 *
 * ⚠ 两条硬约束：
 *  ① 包里的名字必须真实存在于 `vssaros-skill-bundle/skills/`（旧版 office/engineering 里
 *     大半是 DS Bot 的技能名，在我们库里不存在 ⇒ 配了等于空包）；`check-agent-capabilities.mjs` 逐名校验。
 *  ② `.agent.md` 的 `capabilities:` 同时被**两套包**消费：
 *     · 工具包 `vssaros-agents/lib/core/packs.js`（core/fs/web/skills/team）
 *     · 技能包（本表）
 *     同名不同义，但键集合必须**完全一致**，否则写任一边的包名，另一边会报「未知能力包」。
 *     工具专属包在这里用 `names: []` 表示「对技能面无贡献」，反之在 packs.js 里用 `tools: []`。
 *     守卫 `check-agent-capabilities.mjs` 钉住两表键集合相等。
 */
export const CAPABILITY_PACKS = Object.freeze({
	/** 常驻核心（tier: core 的 40 个）；也是未声明 capabilities 时的缺省包 */
	core: Object.freeze({ tier: 'core' }),
	/** 全量（通用助理 / legacy 回退） */
	all: Object.freeze({ tier: null }),

	// ── 领域包：主要覆盖 extended（正是分级后要靠 attach 才可见的那 133 个）──
	code: Object.freeze({ names: Object.freeze(['architecture-diagram', 'codebase-inspection', 'codex', 'claude-code', 'opencode', 'systematic-debugging', 'debugging-hermes-tui-commands', 'node-inspect-debugger', 'python-debugpy', 'refactor', 'spike', 'skill-authoring', 'writing-skills', 'update-skills', 'workflow-node-dev']) }),
	git: Object.freeze({ names: Object.freeze(['commit', 'commit-message', 'create-draft-pr', 'create-pr', 'update-pr', 'merge', 'sync', 'sync-upstream', 'using-git-worktrees', 'finishing-a-development-branch', 'github-auth', 'github-issues', 'github-pr-workflow', 'github-repo-management', 'receiving-code-review', 'github-code-review']) }),
	qa: Object.freeze({ names: Object.freeze(['qa-core', 'qa-context-profiling', 'qa-risk-analysis', 'qa-case-design', 'qa-script-generation', 'qa-execution-repair', 'qa-quality-review', 'qa-acceptance-report', 'test-driven-development', 'verification-before-completion', 'executing-plans']) }),
	docs: Object.freeze({ names: Object.freeze(['nano-pdf', 'ocr-and-documents', 'office-template', 'gov-doc-writing', 'work-report-writer', 'research-paper-writing', 'humanizer', 'pretext', 'meeting-recap', 'summarize', 'ponytail', 'be-concise', 'writing-skills']) }),
	research: Object.freeze({ names: Object.freeze(['anysearch', 'arxiv', 'blogwatcher', 'youtube-content', 'xurl', 'research-paper-writing', 'brainstorming', 'ideation', 'dogfood', 'evaluating-llms-harness', 'maps', 'westock-data', 'llm-wiki']) }),
	design: Object.freeze({ names: Object.freeze(['figma', 'design-md', 'diagram-design', 'concept-diagrams', 'excalidraw', 'frontend-slides', 'powerpoint', 'pixel-art', 'ascii-art', 'p5js', 'sketch', 'popular-web-designs', 'claude-design', 'baoyu-comic', 'baoyu-infographic', 'architecture-diagram']) }),
	knowledge: Object.freeze({ names: Object.freeze(['obsidian', 'obsidian-markdown', 'obsidian-bases', 'obsidian-cli', 'json-canvas', 'mermaid', 'kb-build', 'kb-category-feishu', 'kb-feishu-sync', 'kb-import-message', 'web-content-import', 'kb-game-teardown', 'llm-wiki', 'workbench-authoring', 'help-me-understand']) }),
	media: Object.freeze({ names: Object.freeze(['comfyui', 'huggingface-hub', 'segment-anything-model', 'manim-video', 'hyperframes', 'ascii-video', 'audiocraft-audio-generation', 'songsee', 'songwriting-and-ai-music', 'gif-search', 'storyboard-fountain', 'baoyu-comic', 'baoyu-infographic', 'ideation']) }),
	platform: Object.freeze({ names: Object.freeze(['saroasis-platform', 'tapd-skill', 'airtable', 'notion', 'linear', 'google-workspace', 'teams-meeting-pipeline', 'webhook-subscriptions', 'vssaros-release-pipeline', 'vscode-fork-ghost-js-purge', 'workflow-node-dev', 'workbench-authoring']) }),
	planning: Object.freeze({ names: Object.freeze(['plan', 'plan-then-act', 'writing-plans', 'executing-plans', 'spike', 'dispatching-parallel-agents', 'subagent-driven-development', 'kanban-orchestrator', 'kanban-worker', 'using-superpowers']) }),

	// ── 工具专属包（在 packs.js 里展开成工具名；对技能面无贡献，但必须认识，避免误报 unknown）──
	fs: Object.freeze({ names: Object.freeze([]) }),
	web: Object.freeze({ names: Object.freeze([]) }),
	skills: Object.freeze({ names: Object.freeze([]) }),
	team: Object.freeze({ names: Object.freeze([]) }),
});

/** 工具专属包名（供守卫/文档区分两侧语义）。 */
export const TOOL_ONLY_PACKS = Object.freeze(['fs', 'web', 'skills', 'team']);

/** 能力库条目：name → { name, description, tier, path, kind }。只收随包技能的索引快照。 */
export function buildCapabilityLibrary(bundledIndex) {
	const library = new Map();
	for (const [name, entry] of bundledIndex ?? []) {
		if (!name || !entry) { continue; }
		library.set(name, {
			name,
			description: String(entry.description ?? ''),
			tier: entry.tier === 'extended' ? 'extended' : 'core',
			path: String(entry.path ?? ''),
			kind: 'skill',
		});
	}
	return library;
}

/**
 * 展开 `.agent.md` 的 `capabilities[]` + `skills[]` → 可见技能名集合。
 * @param capabilities 包名数组（未知包名进 problems，不静默忽略）
 * @param skills 显式点名的技能名（绕过 tier）
 * @param library `Map<name, item>`
 * @returns `{ names: Set<string>, problems: string[] }`
 */
export function expandAttachments(capabilities, skills, library) {
	const names = new Set();
	const problems = [];
	const caps = [...new Set((Array.isArray(capabilities) ? capabilities : []).map(String).map(s => s.trim()).filter(Boolean))];
	const explicit = [...new Set((Array.isArray(skills) ? skills : []).map(String).map(s => s.trim()).filter(Boolean))];

	for (const packName of caps) {
		const pack = CAPABILITY_PACKS[packName];
		if (!pack) { problems.push(`未知能力包：${packName}`); continue; }
		if (pack.tier !== undefined) {
			for (const [name, item] of library) {
				if (pack.tier === null || item.tier === pack.tier) { names.add(name); }
			}
		}
		for (const name of pack.names ?? []) {
			if (library.has(name)) { names.add(name); }
			else { problems.push(`能力包 ${packName} 引用了不存在的技能：${name}`); }
		}
	}
	for (const name of explicit) {
		if (!library.has(name)) { problems.push(`skills[] 点名了不存在的技能：${name}`); continue; }
		names.add(name); // 显式绑定永远可见，不受 tier 限制
	}
	return { names, problems };
}

/**
 * 由 agent 的 preset + 数据根解析 attach 集。
 * 未声明 capabilities/skills ⇒ 只挂 DEFAULT_CAPABILITY_PACK（不是全量）。
 * @returns `{ names, problems, agentId, declared }`
 */
export function attachmentsForAgent(preset, dataRoot, library, agentIdOfPreset, parseAgentMd) {
	const agentId = agentIdOfPreset(preset);
	if (!agentId) {
		// 不是我们的 agent（官方 preset / 无 preset）⇒ 不收窄，保持官方全量语义
		return { names: null, problems: [], agentId: '', declared: false };
	}
	let text = '';
	try {
		const file = join(dataRoot, 'agents', agentId, '.agent.md');
		if (existsSync(file)) { text = readFileSync(file, 'utf8'); }
	} catch { /* 读不到按未声明处理 */ }
	const parsed = parseAgentMd(text);
	// ★ 2026-11-08：与服务侧 `attachmentsFromAgentService` 对齐 —— 只写了 skills[]、
	//   没写 capabilities[] 时**仍要带 core 包**。旧写法 `caps = parsed.capabilities`（空数组）
	//   会让这类 agent 只剩显式点名的技能、丢掉 40 个 core，是两条路径的语义分叉。
	const declared = (parsed.capabilities?.length ?? 0) > 0 || (parsed.skills?.length ?? 0) > 0;
	const caps = parsed.capabilities?.length ? parsed.capabilities : [DEFAULT_CAPABILITY_PACK];
	const result = expandAttachments(caps, parsed.skills, library);
	return { names: result.names, problems: result.problems, agentId, declared };
}

/** 轻量读 `.agent.md` frontmatter 的 capabilities/skills（逗号串 + YAML 块列表都认）。 */
export function parseAgentAttachments(text) {
	const raw = String(text ?? '');
	if (!raw.startsWith('---')) { return { capabilities: [], skills: [] }; }
	const end = raw.indexOf('\n---', 3);
	if (end < 0) { return { capabilities: [], skills: [] }; }
	const head = raw.slice(raw.indexOf('\n', 3) + 1, end).split(/\r?\n/);
	const read = (key) => {
		const out = [];
		let pending = false;
		for (const line of head) {
			if (pending) {
				const item = /^\s+-\s+(.*)$/.exec(line);
				if (item) { const v = item[1].trim().replace(/^["']|["']$/g, ''); if (v) { out.push(v); } continue; }
				if (!/^\s*(?:#.*)?$/.test(line)) { pending = false; }
			}
			const scalar = new RegExp('^' + key + '\\s*:\\s*(.*)$').exec(line);
			if (!scalar) { continue; }
			const rest = scalar[1].trim().replace(/^["']|["']$/g, '');
			if (rest.startsWith('[') && rest.endsWith(']')) {
				for (const part of rest.slice(1, -1).split(',')) {
					const v = part.trim().replace(/^["']|["']$/g, ''); if (v) { out.push(v); }
				}
				pending = false;
			} else if (rest) {
				for (const part of rest.split(',')) {
					const v = part.trim().replace(/^["']|["']$/g, ''); if (v) { out.push(v); }
				}
				pending = false;
			} else { pending = true; }
		}
		return [...new Set(out)];
	};
	return { capabilities: read('capabilities'), skills: read('skills') };
}

/** 目录预算（openclaw 同款：诚实降级，不把技能说成不存在）。 */
export const CATALOG_MAX_ENTRIES = 40;
export const CATALOG_MAX_CHARS = 18_000;

/**
 * 按 attach 集给 candidate 标 invocation。
 * ★ 关键：不删 candidate ⇒ `ctx.skills.get(name)` 仍能取到全文（原生 `skill` 工具 /
 *   `/name` 手势 / 我们自己的 read_skill 都不受影响），只是官方目录
 *   `snapshot().filter(isModelInvocable)` 会把它从 `<available_skills>` 里过滤掉。
 */
export function invocationFor(name, attached, basePolicy) {
	const policy = basePolicy ?? { modelInvocable: true, userInvocable: true };
	// attached === null ⇒ 不收窄（非 vssaros agent / legacy 模式）
	const visible = attached === null || attached.has(name);
	return { modelInvocable: policy.modelInvocable === true && visible, userInvocable: policy.userInvocable };
}
