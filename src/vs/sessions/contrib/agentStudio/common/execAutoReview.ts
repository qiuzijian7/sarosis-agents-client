/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * execAutoReview — `execute_code` / `terminal` 的**模型辅助**命令审查（纯逻辑，无 IO / 无 VS Code 依赖）。
 *
 * ── 为什么需要（P2，2026-09-12）──────────────────────────────────────────────
 *
 * `shellCommandSafety` 是**规则式**白名单：只放行「已知只读」与「验证/构建」，其余
 * 一律弹审批。这条 fail-closed 路线本身正确，但代价是**灰色地带**——「既不已知只读、
 * 也看不出危险」的命令（如 `git log --stat HEAD~5` 之外的项目自有脚本、只读的
 * 项目工具链 CLI）每次都要打断用户。
 *
 * 本模块把这类判断交给一次**廉价模型调用**，产出 `allow` / `ask` 二值结论。
 *
 * ── 与 openclaw 的取舍（2026-09-12 调研）─────────────────────────────────────
 *
 * 抄 openclaw `src/agents/exec-auto-reviewer.ts` 的骨架：
 *   · **只回答 allow | ask**（没有 deny —— 审查器无权否决，只能决定「是否值得打扰用户」）；
 *   · **风险分级** risk ∈ {low, medium, high, unknown}（仅用于展示/统计，不参与决策）；
 *   · **严格 JSON 输出**（zod `.strict()` → 我们用显式字段校验）；
 *   · **fail-safe**：超时 / 调用异常 / 输出不可解析 → 一律 `ask`（宁可多问）。
 *
 * 与之的差异：
 *   · openclaw 的审查器**直接持有模型**（`completeWithPreparedSimpleCompletionModel`）；
 *     本模块只做**纯逻辑**，模型调用由调用方经 {@link ExecReviewer} 注入 ——
 *     这样核心判据（prompt 构造 / 响应解析 / fail-safe）可独立单测，
 *     且 common 层不被拉进 platform 依赖（与本仓 `shellCommandSafety` 同纪律）。
 *   · openclaw 会把 `sessionId` 等标识送进 prompt；我们**只送命令本身与必要上下文**
 *     （命令内容与 cwd 已足够判断，标识既不参与判断又是多余的信息暴露面）。
 *
 * ── 定位：只能放宽「灰色地带」，不能绕过任何硬拦 ─────────────────────────────
 *
 * 本模块的 `allow` 只表示「**不必为此打扰用户**」，它**不**：
 *   · 绕过 `commandSafety` 的 HARDLINE 地板（删根目录 / fork bomb 等，在 handler 最前置抛错）；
 *   · 绕过 `executeCodeGuards` 的源码写入护栏与 Unix-only 探测；
 *   · 覆盖规则层的显式拒绝（调用方应只在「规则未命中」时送审）。
 * 换言之它是**第三层宽松通道**，与 `shellCommandSafety` 的定位一致：
 * 只会让审批变宽，且硬拦层独立生效。
 */

/** 送审输入。字段刻意最小化 —— 只保留判断所需，避免把会话标识等无关信息送进模型。 */
export interface IExecReviewInput {
	/** 模型传入的原始命令。 */
	readonly command: string;
	/** 解析出的参数数组（可选；由调用方尽力提供）。 */
	readonly argv?: readonly string[];
	/** 命令将运行的工作目录（可选）。 */
	readonly cwd?: string;
	/** 规则层为何没放行（可读理由，帮助模型聚焦）。 */
	readonly ruleReason?: string;
}

/** 审查结论。 */
export interface IExecReviewDecision {
	/** `allow` = 免确认执行；`ask` = 照常弹审批。 */
	readonly decision: 'allow' | 'ask';
	/** 风险分级（仅展示 / 统计用，不参与决策）。 */
	readonly risk: 'low' | 'medium' | 'high' | 'unknown';
	/** 一句话理由（可选，用于日志与审批卡片）。 */
	readonly rationale?: string;
	/**
	 * 是否因审查**失败**而回退（超时 / 异常 / 输出不可解析）。
	 * 用于把「模型说 ask」与「审查没跑成」在日志里区分开 —— 后者是可靠性问题，
	 * 长期高频出现说明该通道没在起作用。
	 */
	readonly degraded?: boolean;
}

/** 审查器签名：由调用方注入实际模型调用（common 层不依赖任何模型服务）。 */
export type ExecReviewer = (input: IExecReviewInput) => Promise<IExecReviewDecision>;

/** 审查超时（ms）。超时按 `ask` 处理 —— fail-safe。 */
export const EXEC_REVIEW_TIMEOUT_MS = 30_000;

/** 审查输出 token 上限（对齐 openclaw 的 360：结论很短，不需要更多）。 */
export const EXEC_REVIEW_MAX_TOKENS = 360;

/** 送审输入字符上限（防把超长命令/脚本灌进上下文）。 */
export const EXEC_REVIEW_MAX_INPUT_CHARS = 16_000;

/**
 * 审查器系统提示词。
 *
 * 取向与 openclaw 的 `DEFAULT_EXEC_REVIEWER_SYSTEM_PROMPT` 一致：**保守**。
 * 三条关键约束写进提示词而不是只靠解析兜底：
 *   · 只输出 JSON（解析失败即 ask，但让模型知道格式要求能显著降低失败率）；
 *   · **不确定一律 ask**（审查器的价值在于减少打扰，不在于冒险放行）；
 *   · 明确「allow 不等于安全许可」—— 它只表示「无需打扰用户」，硬拦层仍在。
 */
export const EXEC_REVIEW_SYSTEM_PROMPT = [
	'You review a single shell command that an AI coding agent wants to run in the user\'s workspace.',
	'Decide ONLY whether the user must be asked before it runs.',
	'',
	'Reply with a single JSON object, no prose, no markdown fence:',
	'{"decision":"allow"|"ask","risk":"low"|"medium"|"high"|"unknown","rationale":"<=140 chars"}',
	'',
	'Choose "allow" ONLY when the command is clearly read-only, or clearly a build/test/lint/typecheck',
	'step that acts on the project itself. Choose "ask" for ANY of these:',
	'  - it can modify or delete files outside build output dirs, change git history/remote state,',
	'    install or publish packages, touch credentials/secrets, or make network requests;',
	'  - it runs an interpreter, evaluator, or inline code (python -c, node -e, sh -c, ...);',
	'  - it spawns a shell, an editor, a browser, or any long-running/blocking process;',
	'  - you are not confident what it does. UNCERTAINTY ALWAYS MEANS "ask".',
	'',
	'"allow" means "no need to interrupt the user" — it is NOT a safety guarantee, and it never',
	'bypasses the hardline guards (destructive commands are blocked before reaching you).',
	'Keep "rationale" short and concrete.',
].join('\n');

/**
 * 构造送审内容（用户消息）。
 *
 * 只序列化判断所需的字段；`cwd` 有助于判断「命令作用于项目内还是项目外」。
 * 超长时**截断并显式标注**（而非静默丢尾部）—— 静默截断会让模型在缺失上下文时
 * 给出看似合理的错误结论，标注后它会倾向于 `ask`。
 */
export function buildExecReviewPrompt(input: IExecReviewInput): string {
	const payload: Record<string, unknown> = { command: input.command };
	if (input.argv && input.argv.length > 0) { payload.argv = input.argv; }
	if (input.cwd) { payload.cwd = input.cwd; }
	if (input.ruleReason) { payload.ruleReason = input.ruleReason; }

	let text = JSON.stringify(payload, null, 2);
	if (text.length > EXEC_REVIEW_MAX_INPUT_CHARS) {
		text = `${text.slice(0, EXEC_REVIEW_MAX_INPUT_CHARS)}\n… [TRUNCATED — the command was longer than the review budget. If the visible part is not enough to be certain, answer "ask".]`;
	}
	return text;
}

/** 审查失败时的保守结论（fail-safe：一律 ask，并标记 degraded 便于统计）。 */
function askFallback(rationale: string): IExecReviewDecision {
	return { decision: 'ask', risk: 'unknown', rationale, degraded: true };
}

const VALID_RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'unknown']);

/**
 * 解析审查器输出。
 *
 * **严格**（对齐 openclaw 的 zod `.strict()` 精神）：
 *   · 容忍 markdown 代码围栏（模型常自发包裹）与前后空白；
 *   · 但 `decision` 必须是 `allow` / `ask` 之一，否则整体判为不可解析 → `ask`；
 *   · `risk` 非法时**不**整体失败，降级为 `unknown`（它不参与决策，不必因此丢弃结论）；
 *   · `rationale` 截断到 200 字符（防模型啰嗦污染日志/审批卡片）。
 *
 * 任何异常 → `ask` + `degraded`（fail-safe，绝不因解析问题放行）。
 */
export function parseExecReviewResponse(text: string): IExecReviewDecision {
	const raw = (text ?? '').trim();
	if (!raw) { return askFallback('reviewer returned empty output'); }

	// 剥掉可能存在的 markdown 围栏
	const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
	// 宽容取第一个 JSON 对象（模型偶尔在 JSON 前后加一句话）
	const start = unfenced.indexOf('{');
	const end = unfenced.lastIndexOf('}');
	if (start < 0 || end <= start) { return askFallback('reviewer output contained no JSON object'); }

	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced.slice(start, end + 1));
	} catch {
		return askFallback('reviewer output was not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return askFallback('reviewer output was not a JSON object');
	}

	const obj = parsed as Record<string, unknown>;
	const decision = obj['decision'];
	if (decision !== 'allow' && decision !== 'ask') {
		// 缺字段或取值非法 → 不可解析（**不**默认成 allow）
		return askFallback(`reviewer returned an invalid "decision": ${JSON.stringify(decision)}`);
	}

	const rawRisk = typeof obj['risk'] === 'string' ? obj['risk'].toLowerCase() : '';
	const risk = (VALID_RISKS.has(rawRisk) ? rawRisk : 'unknown') as IExecReviewDecision['risk'];
	const rawRationale = typeof obj['rationale'] === 'string' ? obj['rationale'].trim() : '';
	const rationale = rawRationale ? (rawRationale.length > 200 ? `${rawRationale.slice(0, 200)}…` : rawRationale) : undefined;

	return rationale ? { decision, risk, rationale } : { decision, risk };
}

/**
 * 带超时与 fail-safe 的审查决策入口。
 *
 * 三重保护（任一触发都回到 `ask`）：
 *   ① 超时（`timeoutMs`，默认 {@link EXEC_REVIEW_TIMEOUT_MS}）；
 *   ② 审查器抛错；
 *   ③ 审查器返回了结构非法的对象（此处再校验一次 —— 注入方可能绕过
 *      {@link parseExecReviewResponse} 直接构造结果）。
 *
 * @param input      送审输入。
 * @param reviewer   注入的审查器（实际模型调用）。
 * @param timeoutMs  超时上限。
 */
export async function decideExecAutoReview(
	input: IExecReviewInput,
	reviewer: ExecReviewer,
	timeoutMs: number = EXEC_REVIEW_TIMEOUT_MS,
): Promise<IExecReviewDecision> {
	if (!input.command.trim()) { return askFallback('empty command'); }

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<IExecReviewDecision>((resolve) => {
		timer = setTimeout(
			() => resolve(askFallback(`reviewer timed out after ${Math.round(timeoutMs / 1000)}s`)),
			timeoutMs,
		);
	});

	try {
		const result = await Promise.race([reviewer(input), timeout]);
		// 注入方可能绕过解析器 → 此处兜底校验
		if (!result || (result.decision !== 'allow' && result.decision !== 'ask')) {
			return askFallback('reviewer returned a malformed decision');
		}
		const risk = VALID_RISKS.has(result.risk) ? result.risk : 'unknown';
		return { ...result, risk };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return askFallback(`reviewer threw: ${msg.slice(0, 120)}`);
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
	}
}
