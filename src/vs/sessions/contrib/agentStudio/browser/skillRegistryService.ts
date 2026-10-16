/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
/**
 * Skill 注册表实现 —— 见 `common/skills.ts` 接口契约。
 *
 * 加载策略（参考 Hermes-Agent 模式）：
 *   1. 异步扫描内置技能目录 `.agents/skills/`（产品自带，文件形式）
 *      - 技能以 `SKILL.md` 文件形式存储在扩展目录下 `.agents/skills/<skill-name>/SKILL.md`
 *      - 参考 Hermes-Agent 的 `skills/` 项目目录模式
 *   2. `_scanFolder(userHome)`   —— 用户全局技能库 `~/.vssaros/skills/`
 *   3. `registerSkill(...)`     —— 运行时由扩展通过 IAgentOSService 注入
 *
 * 后注册的同名 skill 覆盖前者（运行时注入 > 用户 > 内置），
 * 这与 hermes 的 `optional-skills` < `skills` < `~/.hermes/skills` 优先级一致。
 *
 * 架构说明：
 *   - 技能统一存储于用户全局技能库（`~/.vssaros/skills/`）和内置技能目录（`.agents/skills/`）
 *   - 内置技能从 `.agents/skills/` 目录文件加载（参考 Hermes-Agent 模式）
 *   - 好处：技能以文件形式管理，便于版本控制和升级
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
// ★ 2026-10-12：生态用户级技能目录（SKILL.md 规范）清单 —— 与 dsh Host 侧**共用同一份**。
//   ⚠ 该清单现已被**刻意置空** ⇒ 下面那个循环是 no-op ✓（见 common/skillEcosystemDirs.ts 头注释）。
//   保留接线是为了"两处消费点同源"这条机制还在：将来要恢复扫描，只需往那份清单里加回目录 ✓。
import { ecosystemUserSkillDirUris } from '../common/skillEcosystemDirs.js';
// ★ 技能根清单的**单一真源**（顺序 / 来源 / trust 门控 / 去重；dsh 侧 `dshHarnessService` 读同一份 ✓）
import { SKILL_OFFICIAL_USER_ROOT_SETTING_ID, SKILL_PROJECT_ROOTS_SETTING_ID, SkillRootScope, officialUserSkillRootCandidates, resolveSkillRoots } from '../common/skillRoots.js';
// ★ 2026-10-13（P2）：**dsh 插件包自带的技能**（`<插件包>/skills`）—— IDE 侧补的来源（`ideOnly` 根 ✓）。
//   为什么只有 IDE 侧要：dsh 侧那批技能是**插件自己**注册的（插件包里的 `dsh-skill-filesystem` 行），
//   我们再注一遍就是"同一个技能名两个 provider 各报一份"✗ ⇒ 只给 IDE 补（理由见 dshPluginSkillRoots.ts）。
import { dshPluginSkillRootCandidates, dshProfileDirCandidates } from '../common/dshPluginSkillRoots.js';
import { FileOperationError, FileOperationResult, IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IEnvironmentService, INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';
import { stringHash } from '../../../../base/common/hash.js';
import {
	ISkillRegistry, ISkillDefinition, ISkillActivationContext, ISkillInjection,
	ISkillExecutor, SkillActivation, renderSkillBody,
} from '../common/skills.js';
import { ISkillLifecycleService, ISkillBatchLifecyclePayload } from '../common/skillLifecycle.js';
import * as path from '../../../../base/common/path.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
// 技能根的门控：项目级根（`<工作区>/.dsh/skills` 等）**只在受信任时**扫（提示词注入面 ✗）
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../common/workflowStorage.js';
import {
	AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING,
	AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING,
	AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING,
} from '../common/constants.js';
import {
	planSkillInjections, buildSkillBudgetNote, DEFAULT_SKILL_BUDGET, type ISkillBudget,
	type ISkillBudgetCandidate,
	SKILL_PRIORITY_REQUIRED, SKILL_PRIORITY_EXPLICIT, SKILL_PRIORITY_ALWAYS, SKILL_PRIORITY_AUTO,
} from '../common/skillInjectionBudget.js';
import { ensureNonEmptySkillId, resolveSkillId } from '../common/skillId.js';
import { skillScriptAbsolutePaths } from './providers/tool/executeCodeGuards.js';

/**
 * 判定异常是否为「文件/目录不存在」。
 *
 * 为什么不能只用 `instanceof FileOperationError`：`fileService.stat` 对缺失路径
 * 实际抛出的是 `EntryNotFound (FileSystemError): ... ENOENT`（provider 层错误未被
 * 包装成 FileOperationError），instanceof 判定落空 → 候选路径探测未命中被当成真错误
 * 记 INFO「builtin dir scan failed」，误导排查（日志 1787319805992）。
 *
 * 故三重判据取并集：FileOperationError 结果码、错误名、错误消息关键字。
 */
function _isFileNotFoundError(e: unknown): boolean {
	if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
		return true;
	}
	const name = (e as { name?: unknown } | undefined)?.name;
	if (typeof name === 'string' && /EntryNotFound|FileNotFound|ENOENT/i.test(name)) { return true; }
	const msg = e instanceof Error ? e.message : String(e ?? '');
	return /ENOENT|EntryNotFound|FileNotFound|no such file or directory/i.test(msg);
}

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
	/** 显式权威 id（Hermes `identifier` 语义）：合法时优先于 name slug */
	id?: unknown;
	name?: unknown;
	description?: unknown;
	activation?: unknown;
	match?: unknown;
	category?: unknown;
	recommended_tools?: unknown;
	recommendedTools?: unknown;
	storeId?: unknown;
	version?: unknown;
	/** Hermes-Agent 兼容：适用平台 */
	platforms?: unknown;
	/** Hermes-Agent 兼容：分类标签 */
	tags?: unknown;
	/** Hermes-Agent 兼容：关联技能 ID 列表 */
	related_skills?: unknown;
	/** 技能作者 */
	author?: unknown;
	/** 技能许可证 */
	license?: unknown;
	/** Agent Skills 规范：工具面白名单 */
	allowed_tools?: unknown;
	'allowed-tools'?: unknown;
	/** Agent Skills 规范扩展：偏好模型 */
	model?: unknown;
}

/**
 * 一组随产品发布的内置 skill。
 * 之所以用常量数组而不是物理文件，是为了在 web/electron 两端零成本可用 ——
 * 技能现在以文件形式存储在 .agents/skills/ 目录，参考 Hermes-Agent 模式。
 * 无需硬编码，通过 _scanFolder() 扫描加载。
 */

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
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
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
	/** "未信任 ⇒ 项目级技能没加载"这提醒每个窗口只弹一次（见 `_notifyUntrustedProjectSkills`）。 */
	private _untrustedSkillsNotified = false;
	readonly onDidChangeSkills: Event<void> = this._onDidChangeSkills.event;
	private readonly _readyPromise: Promise<void>;
	/** In-flight reload promise — coalesces concurrent reload() calls (single-flight). */
	private _reloadPromise: Promise<void> | undefined;
	/** In-flight workflow-skill refresh promise — coalesces concurrent auto-save triggers (single-flight). */
	private _workflowReloadPromise: Promise<void> | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IAgentStudioLogService private readonly logService: ILogService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
		@IWorkflowStorageService private readonly workflowStorageService: IWorkflowStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		// 技能根门控（P1，2026-10-13）：项目级根只在**受信任**的工作区里扫（见 `common/skillRoots.ts`）
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
		// "未信任 ⇒ 项目技能没加载"必须让**用户**看得见（只写日志 = 用户永远不知道 ✗）
		@INotificationService private readonly notificationService: INotificationService,
		) {
		super();
		this.logService.info('[SkillRegistry] constructor called');
		// 参考 Hermes-Agent 模式：技能从 skills/ 目录文件异步加载，不再同步硬编码
		// 立即填充已移除 — UI 将在异步扫描完成后可显示
		this.logService.info(`[SkillRegistry] no sync skills - will load async`);
		// workflow → skill 双向打通（A 向）：工作流变更时**增量**刷新 workflow 来源 skill。
		// ★ 性能根因修复：此前这里直接 reload() —— 每次 workflow.save（auto-save 高频）
		//   都全量递归扫描 139 个内置 skill + 13 个用户 skill 的磁盘文件。执行 ComfyUI
		//   生成期间反复触发，磁盘 IO + 事件循环抢占，是「整个电脑卡」的性能根因之一。
		//   workflow 变更只影响 source==='workflow' 的 skill，增量刷新即可。
		this._register(this.workflowStorageService.onDidChangeWorkflows(() => {
			this.reloadWorkflowSkills().catch(err => this.logService.warn('[SkillRegistry] workflow skill refresh failed', err));
		}));
		// ★ 工作区信任变化 ⇒ 项目级技能根的可见性变了 ⇒ 立刻重扫（IDE 侧不用重启，比 Host 侧简单 ✓）。
		// 两个方向都管：信任 ⇒ 项目技能出现 ✓；取消信任 ⇒ 项目技能**立刻消失** ✓（安全侧要求）。
		this._register(this.workspaceTrustService.onDidChangeTrust(() => {
			this._untrustedSkillsNotified = false;   // 状态变了 ⇒ 允许再提醒一次（例如取消信任后 ✓）
			this.reload().catch(err => this.logService.warn('[SkillRegistry] reload after trust change failed', err));
		}));

		// 异步扫描磁盘 skill —— 失败不影响内置 skill 可用性。
		this._readyPromise = this.reload().catch(err => this.logService.warn('[SkillRegistry] initial reload failed', err));
	}

	/** 等待初始加载完成 */
	async whenReady(): Promise<void> {
		await this._readyPromise;
	}

	getSkills(): readonly ISkillDefinition[] {
		this.logService.trace(`[SkillRegistry] getSkills() called, returning ${this._skills.size} skills`);
		return [...this._skills.values()];
	}

	getSkill(id: string): ISkillDefinition | undefined {
		return this._skills.get(id);
	}

	/**
	 * 读取技能支持目录（references/templates/assets/scripts）中的文件内容。
	 * 路径安全：必须位于支持目录内，拒绝 `..` 遍历与绝对路径。
	 */
	async readSkillSupportFile(skillId: string, relativePath: string): Promise<string> {
		const skill = this._skills.get(skillId);
		if (!skill || !skill.resource) {
			throw new Error(`Skill not found: "${skillId}"`);
		}
		const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
		const segments = normalized.split('/').filter(s => s.length > 0);
		const topDir = segments[0];
		if (!topDir || !SkillRegistry.SKILL_SUPPORT_DIRS.has(topDir) || segments.includes('..')) {
			throw new Error(`Invalid support file path "${relativePath}": must be inside one of [${[...SkillRegistry.SKILL_SUPPORT_DIRS].join(', ')}]`);
		}
		const fileUri = URI.joinPath(skill.resource, ...segments);
		const content = await this.fileService.readFile(fileUri);
		return content.value.toString();
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
		const explicit = new Set((context.explicit ?? []).map(s => s.toLowerCase()));
		const required = new Set((context.required ?? []).map(s => s.toLowerCase()));
		const userMsg = context.userMessage.toLowerCase();

		// ── 1. 收集候选（带**优先级**与**正文体量**）────────────────────────
		// ★ 2026-09-11：此前直接 push —— 无排序、不限量、不限字符，多 always /
		// required 技能时每轮 prompt 无界膨胀（`maxSkillsInPrompt` /
		// `maxSkillsPromptChars` 两个开关是**死常量**，从未接线）。
		const candidates: ISkillBudgetCandidate[] = [];
		for (const skill of this._skills.values()) {
			// 首先检查 skill 是否启用
			if (skill.enabled === false) { continue; }

			const id = skill.id.toLowerCase();
			let priority: number | undefined;
			if (required.has(id)) {
				// 强制加载：agent 配置中指定的技能，无论 activation 模式都必须注入
				priority = SKILL_PRIORITY_REQUIRED;
			} else if (explicit.has(id)) {
				// 用户显式 `/skill <id>`：意图最强，优先于 always
				//（always 是常驻噪音源，显式请求才应最优先占预算）
				priority = SKILL_PRIORITY_EXPLICIT;
			} else if (skill.activation === 'always') {
				priority = SKILL_PRIORITY_ALWAYS;
			} else if (skill.activation === 'auto' && skill.match
				&& skill.match.some(kw => userMsg.includes(kw.toLowerCase()))) {
				priority = SKILL_PRIORITY_AUTO;
			}
			if (priority === undefined) { continue; }
			candidates.push({ skill, priority, contentChars: renderSkillBody(skill).length });
		}

		// ── 2. 预算分配（纯函数，见 common/skillInjectionBudget.ts）────────
		const budget = this._getSkillBudget();
		const plan = planSkillInjections(candidates, budget);
		if (plan.summary.length > 0) {
			this.logService.info(
				`[SkillRegistry] skill injection budget applied: ${plan.full.length} full / ` +
				`${plan.summary.length} summary-only (maxFull=${budget.maxFullSkills}, maxChars=${budget.maxPromptChars})`,
			);
		}

		const out: ISkillInjection[] = [];

		// ── 3a. 完整正文注入 ──────────────────────────────────────────────
		// 渐进披露（Phase 1）：所有激活技能统一以 user placement 注入为独立 user message，
		// 不再内联 system prompt（避免冻结前缀失效缓存 + 符合系统提示词通用性约束）。
		// required（agent 配置强制）/ always / explicit（/skill）/ auto（关键词命中）
		// 均走同一路径，确保强制/常驻技能真正进入 LLM。
		// 注：Knot 的 background_knowledge 路径从未实现（仅历史注释），Knot 现走标准
		// messages 路径，user placement 技能可正常到达模型（见 agentDriverService L909-916）。
		// 已触发的 workflow 技能不注入文本，由 agentDriverService 转交执行引擎。
		for (const skill of plan.full) {
			out.push({
				skill,
				placement: 'user',
				content: this._renderInjection(skill),
				// 可执行型 skill（workflow 来源）携带 executor，供 ExecutionProvider 触发执行而非注入文本
				executor: skill.executor,
			});
		}

		// ── 3b. 超预算技能 → 摘要注入（**不丢弃**）────────────────────────
		// 丢弃会让预算悄悄破坏 `always` 的语义（「模型总能看到它」）；摘要保留
		// 存在性 + 定位手段（目录路径），正文由模型按需 `read_skill` 取。
		if (plan.summary.length > 0) {
			const budgetNote = buildSkillBudgetNote(plan.summary.length);
			for (const skill of plan.summary) {
				out.push({
					skill,
					placement: 'user',
					content: this._renderSummaryInjection(skill, budgetNote),
					executor: skill.executor,
				});
			}
		}

		return Promise.resolve(out);
	}

	/**
	 * 读取 skill 注入预算（2026-09-11 接线：两个开关此前是**死常量**）。
	 *
	 * 非法/非正值 → 回退默认：用户手写 settings.json 可能写出 0 / 负数 / 字符串，
	 * 若直接采信会「静默禁用全部技能正文」（比不限量更糟）。
	 */
	private _getSkillBudget(): ISkillBudget {
		const maxFull = this.configurationService.getValue<number>(AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING);
		const maxChars = this.configurationService.getValue<number>(AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING);
		return {
			maxFullSkills: typeof maxFull === 'number' && Number.isFinite(maxFull) && maxFull > 0
				? Math.floor(maxFull) : DEFAULT_SKILL_BUDGET.maxFullSkills,
			maxPromptChars: typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
				? Math.floor(maxChars) : DEFAULT_SKILL_BUDGET.maxPromptChars,
		};
	}

	/**
	 * 超预算技能的**摘要注入**（2026-09-11）：保留「技能存在」的事实与定位手段
	 * （name / description / 目录路径），丢掉正文体积。
	 */
	private _renderSummaryInjection(skill: ISkillDefinition, budgetNote: string): string {
		return [
			`### Skill available (summary — full body omitted by prompt budget): ${skill.name}`,
			skill.description ? `_${skill.description}_` : '',
			skill.resource ? `**Skill directory**: \`${skill.resource.fsPath}\`` : '',
			budgetNote,
		].filter(Boolean).join('\n');
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
		// 单飞：若已有 reload 在途（初始加载 / runtime skill 注册释放可能并发触发），
		// 直接复用同一 Promise，避免交错扫描导致同目录被扫多次。
		if (this._reloadPromise) {
			return this._reloadPromise;
		}
		this._reloadPromise = this._doReload().finally(() => {
			this._reloadPromise = undefined;
		});
		return this._reloadPromise;
	}

	/**
	 * 增量刷新 workflow 来源 skill（workflow 创建/更新/删除时调用）。
	 *
	 * 与 reload() 的区别：**不重扫磁盘 builtin/user skill**（139 + 13 个文件的
	 * 递归 stat/read），只移除旧的 `source==='workflow'` skill 并重新加载最新
	 * workflow。auto-save 高频触发下，磁盘扫描是主要性能开销。
	 *
	 * 单飞：auto-save 可能连续触发多次，复用同一 Promise。
	 * 与 reload() 并发的交错是安全的（workflow skill id 唯一 = workflow.id，
	 * `_setSkillWithPriority` 幂等），最终一致。
	 */
	async reloadWorkflowSkills(): Promise<void> {
		if (this._workflowReloadPromise) {
			return this._workflowReloadPromise;
		}
		this._workflowReloadPromise = this._doReloadWorkflowSkills().finally(() => {
			this._workflowReloadPromise = undefined;
		});
		return this._workflowReloadPromise;
	}

	private async _doReloadWorkflowSkills(): Promise<void> {
		// 1. 移除旧 workflow 来源 skill（含「includeWorkflows 开关 true→false」场景）
		for (const [id, skill] of this._skills) {
			if (skill.source === 'workflow') {
				this._skills.delete(id);
			}
		}
		// 2. 重新加载最新 workflow skills（内部 listWorkflows + _setSkillWithPriority）
		await this._loadWorkflowSkills();
		// 3. runtime skill 永远胜出（可能覆盖同 id 的 workflow skill）
		for (const [id, skill] of this._runtimeSkills) {
			this._skills.set(id, skill);
		}
		this.logService.info(`[SkillRegistry] workflow skills refreshed: total ${this._skills.size} skills`);
		this._onDidChangeSkills.fire();
		// 注意：不 fire batch Synced —— workflow skill 不参与 user skill 镜像同步
		// （_fireBatchSyncedEvent 只收集 source==='user'|'marketplace'）。
	}

	private async _doReload(): Promise<void> {
		this.logService.info(`[SkillRegistry] reload() called`);
		// 调试信息：打印 _VSCODE_FILE_ROOT 和 appRoot 帮助诊断路径问题
		try {
			this.logService.info(`[SkillRegistry] _VSCODE_FILE_ROOT: ${(globalThis as any)._VSCODE_FILE_ROOT ?? 'undefined'}`);
		} catch { /* ignore */ }
		try {
			this.logService.info(`[SkillRegistry] env.appRoot: ${(this.environmentService as INativeEnvironmentService).appRoot ?? 'undefined'}`);
		} catch { /* ignore */ }
		this._skills.clear();
		// 内置候选路径（由下面的探测段填入）；统一派发循环要用它 ⇒ 声明在 try 之外 ✓
		const builtinCandidates: string[] = [];
		// 参考 Hermes-Agent 模式：技能从 .agents/skills/ 目录扫描加载，不再硬编码
		// this._loadBuiltins(); // 已移除 - 技能现在从 .agents/skills/ 目录文件加载

		// 内置技能目录（产品自带的 resources/.agents/skills/）
		// 尝试多个候选路径以兼容不同运行环境（开发/打包、桌面/浏览器）
		try {
			const candidates: URI[] = [];

			// 候选1（最稳）：FileAccess.asFileUri —— 基于 vs 源码根目录推算 resources 兄弟目录
			// 适用所有运行模式（dev / electron-packaged / browser），与 install 路径解析保持一致
			try {
				const uri1 = FileAccess.asFileUri('vs/../../resources/.agents/skills');
				this.logService.info(`[SkillRegistry] candidate1 (FileAccess): ${uri1.toString()}`);
				candidates.push(uri1);
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate1 failed: ${e}`);
			}

			// 候选2：appRoot 直接拼 resources（Electron dev 模式 appRoot ≡ projectRoot）
			let appRoot: string | undefined;
			try {
				appRoot = (this.environmentService as INativeEnvironmentService).appRoot;
				this.logService.info(`[SkillRegistry] appRoot: ${appRoot}`);
				if (appRoot) {
					const uri2 = URI.joinPath(URI.file(appRoot), 'resources', '.agents', 'skills');
					this.logService.info(`[SkillRegistry] candidate2 (appRoot/resources): ${uri2.toString()}`);
					if (!candidates.some(c => c.toString() === uri2.toString())) {
						candidates.push(uri2);
					}
				}
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate2 failed: ${e}`);
			}

			// 候选3：打包模式下 appRoot 可能是 out/ 子目录，需要往上一级
			try {
				if (appRoot) {
					const projectRoot = path.dirname(appRoot);
					const uri3 = URI.joinPath(URI.file(projectRoot), 'resources', '.agents', 'skills');
					this.logService.info(`[SkillRegistry] candidate3 (dirname(appRoot)/resources): ${uri3.toString()}`);
					if (!candidates.some(c => c.toString() === uri3.toString())) {
						candidates.push(uri3);
					}
				}
			} catch (e) {
				this.logService.info(`[SkillRegistry] candidate3 failed: ${e}`);
			}

			// 去重（URI 字符串比较）
			const uniqueCandidates = candidates.filter((c, i, arr) =>
				arr.findIndex(c2 => c.toString() === c2.toString()) === i
			);
			this.logService.info(`[SkillRegistry] unique candidates: ${uniqueCandidates.map(c => c.toString()).join(' | ')}`);

			// 不再 break —— 所有存在的候选目录都要扫，避免漏掉错位安装的 skill
			// ★ 2026-10-13（P1）：这里**只算候选**，不再就地扫描 —— 扫描统一交到下面的"单一真源"
			//   派发循环（`resolveSkillRoots` 给出根清单 + 来源 + trust 门控 ✓）。
			//   候选的"不存在只打 debug"规矩移到了 `_scanRootIfPresent`（同一套 `_isFileNotFoundError` 判据 ✓）。
			builtinCandidates.push(...uniqueCandidates.map(c => c.fsPath));
			this.logService.info(`[SkillRegistry] builtin candidates: ${builtinCandidates.join(' | ')}`);
		} catch (err) {
			this.logService.error('[SkillRegistry] builtin skills scan failed', err);
		}

		// ── 内置 / 用户级 / 项目级 / 生态级：**统一走单一真源**（P1，2026-10-13）──────────────
		// 为什么必须统一：从前这里（用户级 + 生态级）与 dsh 侧 `dshHarnessService._skillDirs()`
		// 各自拼一份 ⇒ 任何一边单独增删就是"IDE 看得见、聊天框看不见"这类**最难查**的不一致 ✗✗
		// （方案稿 §2 不变量 1）。现在顺序 / 来源 / **trust 门控** / 去重都只有
		// `agentStudio/common/skillRoots.ts` 一处实现 ✓，本方法只负责算**基址**。
		//
		// 项目级根（`<工作区>/.dsh/skills`、`<工作区>/.agents/skills`）**只在工作区受信任时**才扫：
		// 它们会随 git clone 进来 ⇒ 是提示词注入面 ✗（`skillEcosystemDirs.ts` 从 2026-10-12 起就写着这条）。
		const resolution = resolveSkillRoots({
			// 非 file 方案（虚拟/远端工作区）没有本地路径 ⇒ 该根跳过
			workspaceFolders: this.workspaceService.getWorkspace().folders.map(f => f.uri.scheme === 'file' ? f.uri.fsPath : ''),
			dataRoot: this._userDataRootFsPath(),
			// 官方用户级 `<DSH_HOME>/skills`（rank 400）：路径公式与 Host 侧**同一份** ✓
			officialUserDirs: this._officialUserSkillDirs(),
			builtinDirs: builtinCandidates,
			// dsh 插件包自带的技能（`<插件包>/skills`）：**只给 IDE 侧**（`includeIdeOnlyRoots` 见下 ✓）
			dshPluginSkillDirs: await this._dshPluginSkillDirs(),
			extraUserDirs: this._ecosystemUserSkillDirs(),
		}, {
			trusted: this.workspaceTrustService.isWorkspaceTrusted(),
			projectRoots: this.configurationService.getValue<boolean>(SKILL_PROJECT_ROOTS_SETTING_ID) !== false,
			// 官方用户级根：用户拍板"支持"✓；与项目级是独立开关（它在用户主目录下 ⇒ 不需要 trust 门控 ✓）
			officialUserRoot: this.configurationService.getValue<boolean>(SKILL_OFFICIAL_USER_ROOT_SETTING_ID) !== false,
			// ★ IDE 侧**是**这些根的唯一消费者：dsh 侧由插件自己注册（重复注入 ⇒ 同名两份 ✗，见 skillRoots.ts 的 ideOnly）
			includeIdeOnlyRoots: true,
		});
		if (resolution.skippedUntrusted.length) {
			// 不静默：用户报"我的技能怎么少了一半"时，这行 + 那条通知就是答案 ✓
			this.logService.info(`[SkillRegistry] 工作区未受信任 ⇒ 跳过 ${resolution.skippedUntrusted.length} 个项目级技能根：${resolution.skippedUntrusted.join('、')}（信任工作区后自动重扫 ✓）`);
			void this._notifyUntrustedProjectSkills(resolution.skippedUntrusted);
		}
		for (const root of resolution.roots) {
			try {
				this.logService.info(`[SkillRegistry] scanning ${root.scope} skills: ${root.fsPath}（${root.label}）`);
				await this._scanRootIfPresent(URI.file(root.fsPath), root.scope);
				this.logService.info(`[SkillRegistry] after ${root.scope} scan: ${this._skills.size} skills`);
			} catch (err) {
				// 单个根失败不该影响已加载的部分（旧代码对用户级/生态级也是这么兜的 ✓）
				this.logService.info(`[SkillRegistry] scan failed for ${root.scope} root: ${root.fsPath}`, err);
			}
		}

		// workflow → skill 双向打通（A 向）：把工作流注册为可执行 skill
		await this._loadWorkflowSkills();

		// 运行时注入的 skill 永远胜出
		for (const [id, skill] of this._runtimeSkills) {
			this._skills.set(id, skill);
		}
		if (this._runtimeSkills.size > 0) {
			this.logService.info(`[SkillRegistry] runtime skills merged: ${this._runtimeSkills.size}`);
		}

		this.logService.info(`[SkillRegistry] reload() complete: total ${this._skills.size} skills`);
		this._onDidChangeSkills.fire();

		// Fire a batch Synced event so external consumers (e.g. demo-agui) can
		// re-sync their local skill mirrors after any reload (install, uninstall,
		// filesystem changes, etc.).
		this._fireBatchSyncedEvent();
	}

	/**
	 * Fire a batch synced event with all current user skill IDs.
	 * This triggers external consumers (like knot-cli sync) to do a full
	 * reconciliation of their skill mirror directories.
	 *
	 * Note: Skills are now stored only in user global directory (~/.vssaros/skills/),
	 * so we fire event with user skill IDs only.
	 */
	private _fireBatchSyncedEvent(): void {
		const userSkillIds = [...this._skills.values()]
			.filter(s => s.source === 'user' || s.source === 'marketplace')
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

	// _loadBuiltins() 已移除 - 技能现在从 skills/ 目录文件加载（参考 Hermes-Agent 模式）

	// ─── 技能子文件夹递归扫描（对齐 Hermes-Agent `os.walk` + `iter_skill_index_files`）────

	/**
	 * 递归扫描时永久跳过的目录名（对齐 Hermes-Agent `EXCLUDED_SKILL_DIRS`）。
	 * VCS、依赖缓存、构建产物 — 不包含技能文件。
	 */
	private static readonly EXCLUDED_SKILL_DIRS = new Set([
		'.git', '.github', '.hub', '.archive', '.venv', 'venv',
		'node_modules', 'site-packages', '__pycache__', '.tox',
		'.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
		'out', 'dist', 'build', '.vscode', '.sarosworkspace', '.codebuddy',
	]);

	/**
	 * 技能内部的辅助目录 — 当父目录已存在 SKILL.md 时跳过递扫。
	 * 对齐 Hermes-Agent `SKILL_SUPPORT_DIRS`。
	 * 这些目录包含渐进披露数据（references/templates/assets/scripts），不是独立技能。
	 */
	private static readonly SKILL_SUPPORT_DIRS = new Set([
		'references', 'templates', 'assets', 'scripts', 'tests',
	]);

	/**
	 * 递归扫描目录，发现所有嵌套子目录中的 SKILL.md 技能文件。
	 *
	 * 对齐 Hermes-Agent `iter_skill_index_files()` + `os.walk()`：
	 *   1. 从根目录递归遍历所有子目录
	 *   2. 每个目录查找 SKILL.md，找到则 parseSkill
	 *   3. 自动跳过 EXCLUDED_SKILL_DIRS 中的目录
	 *   4. 当遇到目录下有 SKILL.md 时，跳过其 SKILL_SUPPORT_DIRS 子目录
	 *   5. category 自动从相对路径提取：skills/code/review/SKILL.md → category "code"
	 *
	 * @param dir 根目录 URI
	 * @param source 来源标识（builtin / user）
	 * @param depth 当前递归深度（内部使用，外部不传）
	 * @param parentHasSkill 父目录是否已找到 SKILL.md（用于 support dirs 剪枝）
	 * @param relativePath 从根目录到当前 dir 的相对路径段（数组）
	 */
	private async _scanFolderRecursive(
		dir: URI,
		source: SkillRootScope,
		depth: number = 0,
		parentHasSkill: boolean = false,
		relativePath: string[] = [],
	): Promise<number> {
		// 深度保护：最多 10 层（防御性编程）
		if (depth > 10) {
			this.logService.warn(`[SkillRegistry] _scanFolderRecursive: max depth reached at ${dir.toString()}`);
			return 0;
		}

		// ★★ 目录级 INFO 进度日志（诊断磁盘 IO hang 用）：每进入一个目录打一行。
		//   日志实证（vscode-app-1787159667152.log）：`reload() called` 后
		//   `after builtin scan` 从未出现 —— 扫描在某个目录里挂死，但旧代码只有
		//   debug 级日志（生产 INFO 级别下不可见），无从定位挂点。
		//   builtin/user 根下的 skill 目录数量有限（~10-20），INFO 行数可控。
		//   排障：最后一行 `[SkillRegistry] scan:` 显示的目录 = 挂死目录。
		this.logService.info(`[SkillRegistry] scan: ${dir.fsPath} (depth=${depth}, src=${source})`);

		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			if (depth === 0) {
				this.logService.debug(`[SkillRegistry] _scanFolderRecursive: dir not found: ${dir.toString()}`);
			}
			return 0;
		}

		if (!stat.isDirectory || !stat.children) {
			return 0;
		}

		// ① 检查当前目录是否有 SKILL.md
		let thisDirHasSkill = false;
		const skillFile = URI.joinPath(dir, 'SKILL.md');
		try {
			const content = await this.fileService.readFile(skillFile);
			const text = content.value.toString();
			// 从路径提取 category（对齐 Hermes `_get_category_from_path`）
			// e.g. skills/code/review/ → category "code"
			if (!relativePath.length && depth === 0) {
				// 根目录本身有 SKILL.md（特殊：focal skill）
			}
			const parsedSkill = this._parseSkillFile(dir, text, source);
			if (parsedSkill) {
				// 自动从路径推断 category（如果 frontmatter 未显式设置）
				let skill = parsedSkill;
				if (!skill.category && relativePath.length > 0) {
					skill = { ...skill, category: relativePath[0] }; // 最顶层的子文件夹名作为 category
				}
				// 内置 / 插件自带技能默认分类（两者同属"随包分发、非用户编写"那一类，见 `isSkillReadOnly` ✓）
				if (!skill.category && (source === 'builtin' || source === 'plugin')) {
					skill = { ...skill, category: 'utility' };
				}
				// 索引支持目录文件（references/templates/assets/scripts），供模型按需读取（渐进披露）
				const supportFiles = await this._listSupportFiles(dir);
				if (supportFiles.length > 0) {
					skill = { ...skill, supportFiles };
				}
			this._setSkillWithPriority(skill, dir.fsPath);
				thisDirHasSkill = true;
				this.logService.debug(`[SkillRegistry] _scanFolderRecursive: loaded skill "${skill.id}" (depth=${depth}, cat="${skill.category ?? '-'}", path="${relativePath.join('/')}")`);
			}
		} catch {
			// SKILL.md 不存在 — 继续往下扫描子目录
		}

		// ② 递归扫描子目录
		let loaded = thisDirHasSkill ? 1 : 0;
		for (const child of stat.children) {
			if (!child.isDirectory) { continue; }

			const dirName = child.name;
			// 跳过排除目录
			if (SkillRegistry.EXCLUDED_SKILL_DIRS.has(dirName)) { continue; }
			// 如果当前目录有 SKILL.md，跳过其 support 子目录
			if (thisDirHasSkill && SkillRegistry.SKILL_SUPPORT_DIRS.has(dirName)) { continue; }
			// 如果父目录有 SKILL.md 且当前是 support dir，跳过
			if (parentHasSkill && SkillRegistry.SKILL_SUPPORT_DIRS.has(dirName)) { continue; }

			loaded += await this._scanFolderRecursive(
				child.resource,
				source,
				depth + 1,
				thisDirHasSkill,
				depth === 0 ? [dirName] : [...relativePath, dirName],
			);
		}

		return loaded;
	}

	/**
	 * 旧版单层扫描方法（已废弃 — 内部委托给 _scanFolderRecursive）。
	 * 保留签名兼容性，行为已改为递归扫描。
	 */
	private async _scanFolder(dir: URI, source: SkillRootScope): Promise<void> {
		const loaded = await this._scanFolderRecursive(dir, source);
		this.logService.info(`[SkillRegistry] _scanFolder(${source}): loaded ${loaded} skills from ${dir.toString()} (recursive)`);
	}

	/** 数据根（`~/.vssaros` / dev 的 `~/.vssaros-dev`）的本机路径；拿不到 ⇒ undefined（用户级根就不产出）✓。 */
	private _userDataRootFsPath(): string | undefined {
		try {
			return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome).fsPath;
		} catch {
			return undefined;
		}
	}

	/**
	 * 官方用户级技能目录候选（`<DSH_HOME>/skills`，官方 rank 400）—— 与 Host 侧**同一份路径公式** ✓。
	 *
	 * `dshHome` 的设置键是 `sessions.dshHarness.dshHome`（枚举 `DshHarnessSettings.DshHome` 定义在
	 * dshHarness 的 common 里）；这里不跨 contrib 引那个枚举，改用**字面量**，
	 * 由 `skillRoots.test.ts` 的守卫比对两处一致 ✓（改键 = 静默失效 ✗，所以必须有那条守卫）。
	 */
	private _officialUserSkillDirs(): string[] {
		try {
			return officialUserSkillRootCandidates({
				dshHome: this.configurationService.getValue<string>('sessions.dshHarness.dshHome')?.trim() || undefined,
				dataRoot: this._userDataRootFsPath(),
				userHome: (this.environmentService as INativeEnvironmentService).userHome?.fsPath,
			});
		} catch {
			return [];
		}
	}

	/**
	 * **dsh 插件包自带的技能根**（`<插件包>/skills`）—— IDE 侧技能库的补充来源（2026-10-13 P2）。
	 *
	 * 为什么要 IDE 侧自己算（而不是问 Host）：这条来源在 dsh 里是**插件自己注册**的
	 * （插件包内那行 `dsh-skill-filesystem`，`bundledSkillDir` 指到包内 `skills/`）⇒ Host 那侧问不出
	 * "IDE 该扫哪些目录"，而且 Host 没启动时技能库也得能用 ✓。所以按**同一份约定**在本地算：
	 * 读 profile 的 `package.json`（`dsh.profile.bundles` = 已启用插件的真源 ✓）→ 解析每个插件的包目录
	 * → 取其下的 `skills/`（纯函数在 `common/dshPluginSkillRoots.ts` ✓）。
	 *
	 * 路径公式的基址与 `_officialUserSkillDirs()` **同一组** DSH_HOME 候选（设置项 → dev 默认 →
	 * 打包版回落 `~/.dsh`），只是再拼 `/profiles/<profile>` ✓。`profile` 名同样用**字面量**读键
	 * （`sessions.dshHarness.profile`），由 `skillRoots.test.ts` 的守卫比对两侧一致 ✓。
	 *
	 * 容错：profile 不存在 / 读不动一律**跳过**（dev 与打包、不同机器上 profile 名都可能不同 ⇒
	 * 这是常态，不是错误 ✗ 别报错）；插件目录没有 `skills/` 也跳过（多数插件不给技能 ✓）。
	 * 不存在的根**必须在这里滤掉**：`_doReload` 在扫描**之前**就会打一行 INFO（见那个循环 ✓），
	 * 几十个插件全冒一行"scanning …"会把日志埋掉 ✗。
	 */
	private async _dshPluginSkillDirs(): Promise<string[]> {
		try {
			const profileDirs = dshProfileDirCandidates({
				dshHome: this.configurationService.getValue<string>('sessions.dshHarness.dshHome')?.trim() || undefined,
				dataRoot: this._userDataRootFsPath(),
				userHome: (this.environmentService as INativeEnvironmentService).userHome?.fsPath,
				profile: this.configurationService.getValue<string>('sessions.dshHarness.profile')?.trim() || undefined,
			});
			const roots: string[] = [];
			for (const profileDir of profileDirs) {
				let profilePackageJson: unknown;
				try {
					const raw = await this.fileService.readFile(URI.file(path.join(profileDir, 'package.json')));
					profilePackageJson = JSON.parse(raw.value.toString());
				} catch {
					continue; // 没有这个 profile（dev/打包/profile 名不同）⇒ 跳过，不算错
				}
				for (const root of dshPluginSkillRootCandidates(profilePackageJson, profileDir)) {
					try {
						if ((await this.fileService.stat(URI.file(root))).isDirectory) {
							roots.push(root);
						}
					} catch {
						// 该插件没带 `skills/`（或还没装完）⇒ 正常情况，静默跳过
					}
				}
			}
			if (roots.length) {
				this.logService.info(`[SkillRegistry] dsh 插件自带技能根 ${roots.length} 个：${roots.join(' | ')}`);
			}
			return roots;
		} catch (err) {
			this.logService.info('[SkillRegistry] dsh 插件技能根解析失败（按"没有"处理）', err);
			return [];
		}
	}

	/** 生态用户级技能目录（清单**刻意为空** ✓ ⇒ 通常空数组；保留接线以维持两处消费点同源 ✓）。 */
	private _ecosystemUserSkillDirs(): string[] {
		try {
			return ecosystemUserSkillDirUris((this.environmentService as INativeEnvironmentService).userHome).map(u => u.fsPath);
		} catch {
			return [];
		}
	}

	/**
	 * 扫一个**可能不存在**的技能根（生态目录 `~/.agents/skills`、内置候选、项目级目录多数都不存在）。
	 *
	 * 先 `stat` 再扫，且"不存在"只打 **debug** ✓ —— 直接扫再在 catch 里记 INFO 会把
	 * "候选目录没命中"报成"扫描失败"，2026-08-21 踩过同一个坑（见内置候选那段的注释）✗。
	 * 其它异常仍打 INFO（真错误要可见），但不抛出：这些根是**可选/条件性**的，
	 * 不该让它们影响已经加载好的内置/自营技能 ✓。
	 *
	 * ★ 2026-10-13（P1）：来源参数从 `'user'` 放开为 {@link SkillRootScope} —— 单一真源给出的
	 * 每条根都自带 scope（含 `'project'`），本方法只负责"存在就扫、不存在就静默" ✓。
	 */
	private async _scanRootIfPresent(dir: URI, source: SkillRootScope): Promise<void> {
		try {
			await this.fileService.stat(dir);
		} catch (e) {
			if (_isFileNotFoundError(e)) {
				this.logService.debug(`[SkillRegistry] ${source} skill dir does not exist (skipped): ${dir.toString()}`);
			} else {
				this.logService.info(`[SkillRegistry] ${source} skill dir stat failed: ${dir.toString()}, error: ${e}`);
			}
			return;
		}
		await this._scanFolder(dir, source);
	}

	/**
	 * 未信任 ⇒ 项目级技能没加载：**只在这一类目录真的存在时**提醒一次。
	 *
	 * 为什么要提醒（方案稿 P1 明确要求"含未信任时如何提示用户"）：不提醒的话用户看到的就是
	 * "我明明把技能放在 `.dsh/skills` 里，产品却说没有" ✗ —— 静默少一半是最难自查的一类问题。
	 * 为什么加两个条件：①目录不存在 ⇒ 没有东西被门控挡掉，提醒纯属噪音 ✗；
	 * ②每个窗口/工作区只提醒一次（`_untrustedSkillsNotified`）⇒ 否则每次 reload 都弹 ✗。
	 */
	private async _notifyUntrustedProjectSkills(paths: readonly string[]): Promise<void> {
		try {
			const existing: string[] = [];
			for (const p of paths) {
				try {
					await this.fileService.stat(URI.file(p));
					existing.push(p);
				} catch { /* 不存在 ⇒ 这条没什么可提醒的 ✓ */ }
			}
			if (!existing.length || this._untrustedSkillsNotified) {
				return;
			}
			this._untrustedSkillsNotified = true;
			this.notificationService.info(
				`工作区里有技能目录（${existing.join('、')}），但当前工作区未受信任，因此没有加载其中的技能。信任该工作区后会自动加载。`);
		} catch { /* 提醒失败不影响技能加载 ✓ */ }
	}

	/**
	 * 同 id 冲突时的来源优先级（对齐 Hermes `_trust_rank`：builtin < trusted < community 的显式分级思想）。
	 * 值越大优先级越高：用户/商城安装的技能覆盖同名内置技能；workflow/runtime 视图最高。
	 */
	private static readonly SKILL_SOURCE_RANK: Readonly<Record<ISkillDefinition['source'], number>> = {
		// 只比**相对**大小（值本身不落盘、不对外暴露）⇒ 为插入 project 档把后面的整体上移一位 ✓
		// ★ `plugin`（dsh 插件自带的技能）与 builtin 同档：dsh 侧它们也同为 bundled/600 ✓；
		//   IDE 侧根顺序把插件根排在最后 ⇒ 撞名时先到先得 = 内置/用户技能压得住插件技能 ✓
		//   （且它是只读来源，见 `common/skills.ts` 的 `isSkillReadOnly` ✓）。
		plugin: 1,
		builtin: 1,
		extension: 1,
		marketplace: 2,
		user: 3,
		// ★ 2026-10-13（P1）：**项目级**（工作区自带的技能）高于用户级/商城，低于 workflow/runtime ✓。
		// 依据：官方 rank 表里项目级（100/200）先于用户级（400）✓；dsh 侧的根顺序同样是
		// [项目级, 用户级, 内置]（见 `agentStudio/common/skillRoots.ts` 的 `SKILL_ROOT_SPECS` ✓）。
		project: 4,
		workflow: 5,
		memory: 6,
	};

	/**
	 * 按来源优先级写入技能表（复刻 Hermes 加载期去重：不再无条件后者覆盖前者）：
	 *   - 新来源优先级更高 → 替换并记录；
	 *   - 优先级相同 → first-wins：**内容一致则静默**，内容不同才警告（附双方来源路径）；
	 *   - 新来源优先级更低 → 保留既有者并记录。
	 *
	 * ★ 2026-10-13（决策三的降噪半边）：同级来源此前**一律警告** ✗ —— 典型现场是同一个技能在多个
	 * 用户目录里各存一份（本机实测 `~/.agents/skills` 与 `~/.claude/skills` 有 31 个同名、`SKILL.md`
	 * 逐字节相同 ⇒ 每次 reload 刷 31 行**无信息量**告警，正是当初决定停扫生态目录的两个理由之一 ✗）。
	 * 现在用同文件里那个**本来就是为此写的** `computeSkillContentHash` 判内容：一致 ⇒ 静默取先者 ✓；
	 * 不一致 ⇒ 保留**一行** WARN（这才是需要人判断的情形 ✓，消息里说清"内容不同" + 两侧路径 ✓）。
	 * 注：dsh 侧对同名是**静默 rank 裁决**（没有对应的告警面）⇒ 这条纪律由 IDE 侧负责 ✓。
	 */
	private _setSkillWithPriority(skill: ISkillDefinition, fromPath?: string): void {
		const existing = this._skills.get(skill.id);
		if (!existing) {
			this._skills.set(skill.id, skill);
			return;
		}
		const incomingRank = SkillRegistry.SKILL_SOURCE_RANK[skill.source] ?? 0;
		const existingRank = SkillRegistry.SKILL_SOURCE_RANK[existing.source] ?? 0;
		const existingPath = existing.resource?.fsPath ?? '(no path)';
		const incomingPath = fromPath ?? skill.resource?.fsPath ?? '(no path)';
		// 幂等去重：同 id + 同来源 + 同路径 = 同一技能被重复扫描（并发 reload 交错、
		// 嵌套目录被多次访问等），保留先注册者即可，静默跳过，避免无意义冲突警告。
		if (existing.source === skill.source && existingPath === incomingPath) {
			return;
		}
		if (incomingRank > existingRank) {
			this._skills.set(skill.id, skill);
			this.logService.info(`[SkillRegistry] Skill "${skill.id}" replaced by higher-priority source: ${existing.source} (${existingPath}) ← ${skill.source} (${incomingPath})`);
		} else if (incomingRank === existingRank) {
			// 同级：先比内容（只比 prompt 正文 ⇒ 与 `computeSkillContentHash` 的口径一致 ✓）
			const sameContent = computeSkillContentHash(String(existing.prompt ?? '')) === computeSkillContentHash(String(skill.prompt ?? ''));
			if (sameContent) {
				// 同一个技能在多个目录里各存一份（常见：用户把技能同时放在自营库与生态目录）
				// ⇒ 保留先扫描到的那份，**不打日志**（打了就是几十行无信息量告警 ✗）。
				return;
			}
			this.logService.warn(`[SkillRegistry] Skill id 冲突 "${skill.id}"（同级来源 ${skill.source}，内容不同）：保留 ${existingPath}，忽略 ${incomingPath}。如需共存请在 frontmatter 显式指定不同 id。`);
		} else {
			this.logService.info(`[SkillRegistry] Skill "${skill.id}" kept ${existing.source} (${existingPath}), ignored lower-priority ${skill.source} (${incomingPath})`);
		}
	}

	/**
	 * 列出技能目录下支持文件夹（references/templates/assets/scripts）中的文件，
	 * 返回相对技能根目录的路径列表（如 "references/api.md"、"scripts/tools/run.py"）。
	 * 对齐 Agent Skills 规范的渐进披露：支持目录内容在扫描时索引、按需读取。
	 */
	private async _listSupportFiles(skillDir: URI): Promise<string[]> {
		const files: string[] = [];
		const collect = async (dir: URI, prefix: string, depth: number): Promise<void> => {
			if (depth > 3) { return; } // 防御性深度限制
			let stat: IFileStat;
			try {
				stat = await this.fileService.resolve(dir);
			} catch {
				return; // 支持目录不存在 — 正常情况
			}
			if (!stat.isDirectory || !stat.children) { return; }
			for (const child of stat.children) {
				const rel = `${prefix}/${child.name}`;
				if (child.isDirectory) {
					await collect(child.resource, rel, depth + 1);
				} else {
					files.push(rel);
				}
			}
		};
		for (const dirName of SkillRegistry.SKILL_SUPPORT_DIRS) {
			await collect(URI.joinPath(skillDir, dirName), dirName, 0);
		}
		return files.sort();
	}

	private _parseSkillFile(folder: URI, text: string, source: SkillRootScope): ISkillDefinition | undefined {
		const { meta, body } = parseFrontmatter(text);
		let name = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : undefined;
		if (!name) {
			// SKILL.md 缺少 name 时回退到文件夹名：避免技能被静默丢弃，也消除告警噪声。
			const fallbackName = path.basename(folder.fsPath).trim();
			if (!fallbackName) {
				this.logService.warn(`[SkillRegistry] SKILL.md missing 'name' and folder name unusable: ${folder.toString()}`);
				return undefined;
			}
			this.logService.debug(`[SkillRegistry] SKILL.md missing 'name', falling back to folder name "${fallbackName}": ${folder.toString()}`);
			name = fallbackName;
		}
	const description = typeof meta.description === 'string' ? meta.description : '';
	// id 解析（单点真源 common/skillId.ts，对齐 Hermes identifier 语义）：
	// frontmatter 显式 `id` 合法时优先，否则从 name slug 派生；
	// slug 为空（纯非 ASCII 名）时用目录路径哈希兜底，保证 id 稳定且非空。
	const explicitId = typeof meta.id === 'string' ? meta.id : undefined;
	let id = resolveSkillId(explicitId, name);
	if (!id) {
		id = ensureNonEmptySkillId('', `${folder.fsPath}::${name}`);
		this.logService.warn(`[SkillRegistry] name "${name}" 无法 slug 出有效 id（纯非 ASCII），回退为 "${id}"；建议在 frontmatter 显式指定 id 字段: ${folder.toString()}`);
	}
	const prompt = body.trim();
		// 如果 SKILL.md frontmatter 含有 storeId，说明是商城下载的，标记为 marketplace
		const hasStoreId = typeof meta.storeId === 'string' && meta.storeId.length > 0;
		const effectiveSource = (hasStoreId && source === 'user') ? 'marketplace' : source;
		return {
			id,
			name,
			description,
			activation: normalizeActivation(meta.activation),
			match: asStringArray(meta.match),
			category: typeof meta.category === 'string' ? meta.category : undefined,
			recommendedTools: asStringArray(meta.recommended_tools) ?? asStringArray(meta.recommendedTools),
			prompt,
			source: effectiveSource,
			resource: folder,
			contentHash: computeSkillContentHash(prompt),
			enabled: true, // 默认启用
			version: typeof meta.version === 'string' ? meta.version : (source === 'builtin' ? '1.0.0' : undefined),
			storeId: typeof meta.storeId === 'string' ? meta.storeId : undefined,
			platforms: asStringArray(meta.platforms),
			tags: asStringArray(meta.tags),
			relatedSkills: asStringArray(meta.related_skills),
			author: typeof meta.author === 'string' ? meta.author : undefined,
			license: typeof meta.license === 'string' ? meta.license : undefined,
			allowedTools: asStringArray(meta.allowed_tools) ?? asStringArray(meta['allowed-tools']),
			model: typeof meta.model === 'string' ? meta.model : undefined,
		};
	}

	private _renderInjection(skill: ISkillDefinition): string {
		// 与 hermes 的 skill_commands.py 一致：明确告诉模型这是一段「skill」内容，
		// 让它把 skill body 作为本轮的执行准则。
		return [
			`### Skill activated: ${skill.name}`,
			skill.description ? `_${skill.description}_` : '',
			// skill 目录基准（借鉴 void「激活即注入绝对根路径 + 执行工具带 cwd」）：
			// 技能脚本/资源（scripts/、references/ 等）以此目录为基准执行，而非 workspace root。
			skill.resource
				? `**Skill directory**: \`${skill.resource.fsPath}\` — this skill's scripts/resources live under THIS directory. Run its CLI/scripts via execute_code with cwd set to THIS directory (not the workspace root).`
				: '',
			// 脚本绝对路径清单：模型应**默认用绝对路径调用**（python3 "<abs>/scripts/xxx.py" ...），
			// 避免相对路径依赖 cwd（子代理 cwd 可能是另一个 workspace → 相对路径解析失败 exit 2）。
			skill.resource && skill.supportFiles?.length
				? (() => {
					const scriptPaths = skillScriptAbsolutePaths(skill.resource.fsPath, skill.supportFiles);
					return scriptPaths.length > 0
						? `**Executable scripts (absolute paths — use these directly, no cwd needed):**\n${scriptPaths.map(p => `- \`${p}\``).join('\n')}`
						: '';
				})()
				: '',
			'',
			renderSkillBody(skill),
			// allowed-tools（Agent Skills 规范）：prompt 级工具面约束
			skill.allowedTools && skill.allowedTools.length > 0
				? `\n**Tool restriction**: while following this skill, only use these tools: ${skill.allowedTools.join(', ')}. Do not use any other tools.`
				: '',
		].filter(Boolean).join('\n');
	}

	// ─── workflow → skill 双向打通（A 向）──────────────────────────────

	/**
	 * 把已存储的工作流注册为「可执行型 skill」。
	 *
	 * 设计要点：
	 * - id 直接复用 workflow.id，保证 `/skill <wf-id>` 与 workflow 一一对应。
	 * - activation 默认 'manual'：避免 auto/always 误触发重型多 agent 工作流。
	 * - executor 指向 workflow，ExecutionProvider 在触发时据其运行工作流而非注入文本。
	 * - contentHash 基于节点图 JSON 计算（workflow 无 SKILL.md 正文）。
	 *
	 * 注意：本方法是「注册视图」，仅把 workflow 暴露到 skill 列表，
	 * 不移动/复制任何文件；真正的执行逻辑在 P1（ExecutionProvider 改造）接入。
	 */
	private async _loadWorkflowSkills(): Promise<void> {
		try {
			// P4: 开关控制是否把工作流暴露为 skill（缓解暴露面过大风险）。
			// 默认开启；在 settings.json 设 sessions.agentStudio.skills.includeWorkflows=false 可关闭。
			const includeWorkflows = this.configurationService.getValue<boolean>(AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING);
			if (includeWorkflows === false) {
				this.logService.info('[SkillRegistry] workflow→skill bridge disabled by setting (agentStudio.skills.includeWorkflows=false), skipping');
				return;
			}
			const workflows = await this.workflowStorageService.listWorkflows();
			this.logService.info(`[SkillRegistry] loading ${workflows.length} workflow(s) as skills`);
			for (const wf of workflows) {
				const id = wf.id;
				const description = wf.description || wf.name;
				const prompt = wf.useGuide?.trim()
					|| wf.description?.trim()
					|| `This is a workflow skill. Executing it runs the workflow "${wf.name}".`;
				const skill: ISkillDefinition = {
					id,
					name: wf.name,
					description,
					activation: 'manual',
					prompt,
					source: 'workflow',
					workflowId: wf.id,
					executor: { kind: 'workflow', workflowId: wf.id } as ISkillExecutor,
					contentHash: this._computeWorkflowContentHash(wf),
					enabled: true,
					version: wf.version,
				category: wf.category || 'workflow',
			};
			this._setSkillWithPriority(skill);
		}
		} catch (err) {
			this.logService.info('[SkillRegistry] workflow skills load failed', err);
		}
	}

	/**
	 * 基于工作流节点图生成内容指纹，用于跨重载去重/变更检测。
	 * workflow 无 SKILL.md 正文，故以 id/name/description/节点图作为指纹源。
	 */
	private _computeWorkflowContentHash(wf: IStoredWorkflow): string {
		const fingerprint = JSON.stringify({
			id: wf.id,
			name: wf.name,
			description: wf.description,
			nodes: wf.nodes ?? [],
			connections: wf.connections ?? [],
		});
		const h = stringHash(fingerprint, 0);
		return (h >>> 0).toString(16).padStart(8, '0');
	}
}
