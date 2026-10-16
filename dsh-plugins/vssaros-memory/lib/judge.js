// @vssaros/dsh-memory — LLM 判定的 I/O 半边（调 `ctx.llm.stream` + 收集文本 + fail-open）。
//
// 已核实的契约（不必再查）：
//   · `ctx.llm.stream(options): AsyncIterable<StreamChunk>`（`dsh-llm/lib/types/index.d.ts:115` ✓）；
//   · chunk 是联合类型，我们只关心 `{ type: 'text-delta', text }`（`dsh-llm/lib/types/types.d.ts:417-425` ✓）；
//   · `options`（`GenerateOptions`）的形状照官方 `dsh-compaction-basic/lib/index.js:292-323`：
//     `{ provider, model, messages, toolHistory, tools?, maxTokens, sessionId, purpose, signal? }` ✓；
//   · `provider` / `model` 的来源优先级（compaction 的现成范例）：配置 → `session.requestHeader()?.config`
//     → `agent.options.{provider,model}` ✓。
//
// ⚠ **刻意不 import `BlockAssembler`**：那会把 `@deepseek-ai/dsh-llm` 变成插件的运行时依赖 ✗。
//   我们只需要"文本增量"这一种 chunk ⇒ 自己拼 5 行就够，依赖面保持在"零 dsh import" ✓
//（本插件的 `core/` 与 `lib/` 至今零 dsh 依赖，这个性质值得守住 —— 它让所有纯逻辑都能被探针直接测 ✓）。
//
// ⚠⚠ **失败一律 fail-open**（`kept = 全部候选`）：理由见 `core/judge.js` 文件头 ✓。
//   本文件把"超时 / 抛错 / 形状不认识 / 回答解析不了"**四种**失败都收敛到同一个出口 ✓ ——
//   它们对调用方的含义完全一样（"这次判定没能给出可信结论"⇒ 保守保留 ✓），分开处理只会
//   让某一条路径忘了 fail-open ✗。

import { buildJudgeMessages, parseJudgeReply } from './core/judge.js';

/** 判定输出的 token 上限（只要一个序号数组 ⇒ 256 足够 ✓）。 */
export const JUDGE_MAX_TOKENS = 256;
/** `purpose` 标记（写清用途，便于模型侧/日志侧区分这次调用不是普通回合 ✓）。 */
export const JUDGE_PURPOSE = 'distill-judge';
/** 默认超时（队列还有一层超时，但这一层能**真的中断请求** ✓）。 */
export const JUDGE_TIMEOUT_MS_DEFAULT = 20_000;

/**
 * 从流式 chunk 里取文本（纯函数；形状不认识 ⇒ 空串 ⇒ 最终走 fail-open ✓）。
 * @param {unknown} chunk - `StreamChunk`。
 * @returns {string} 文本增量。
 */
export function textOfChunk(chunk) {
	return chunk?.type === 'text-delta' && typeof chunk.text === 'string' ? chunk.text : '';
}

/**
 * 建一个判定器。
 *
 * @param {{llm: object, timeoutMs?: number, logger?: {warn?: Function}}} deps - 依赖（`llm` 可选 ⇒ 由调用方决定是否接线 ✓）。
 * @returns {{judge: (candidates: readonly object[], target: {provider: string, model: string, sessionId?: string}) => Promise<{kept: string[], dropped: string[], parseFailed: boolean, error?: string}>}} 判定器。
 */
export function createJudge(deps) {
	const logger = deps.logger;
	// ⚠ `llm` 允许是**函数**（getter）：本插件的 `llm` 是**可选注入**的（服务后到时才赋值 ✓）
	// ⇒ 在装配那一刻把实例抓下来的话，会永远拿到 `null`、判定永远 fail-open ✗（那等于这个功能不存在，
	// 而且失败还是"静默保守"的 ⇒ 更难发现 ✗✗）。每次调用时再取一次才正确 ✓。
	const resolveLlm = typeof deps.llm === 'function' ? deps.llm : () => deps.llm;
	const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : JUDGE_TIMEOUT_MS_DEFAULT;

	/** 全保留（fail-open 的唯一出口 ✓）。 */
	const failOpen = (candidates, error) => ({
		kept: (Array.isArray(candidates) ? candidates : []).map(candidate => String(candidate?.digest ?? '')).filter(Boolean),
		dropped: [],
		parseFailed: true,
		...(error === undefined ? {} : { error: String(error) }),
	});

	/**
	 * 判一批候选该留哪些。
	 * @param {readonly object[]} candidates - `extractCandidates` 的产物。
	 * @param {{provider: string, model: string, sessionId?: string}} target - 路由（来自 agent ✓）。
	 * @returns {Promise<{kept: string[], dropped: string[], parseFailed: boolean, error?: string}>} 判定。
	 */
	async function judge(candidates, target) {
		const list = Array.isArray(candidates) ? candidates : [];
		if (list.length === 0) { return { kept: [], dropped: [], parseFailed: false }; }
		const llm = resolveLlm();
		if (!llm || typeof llm.stream !== 'function') { return failOpen(list, 'llm 服务不可用'); }
		if (typeof target?.provider !== 'string' || typeof target?.model !== 'string') {
			return failOpen(list, '缺少 provider/model 路由');
		}
		let raw = '';
		try {
			// ⚠ 用 `AbortSignal.timeout` 让超时能**真的中断请求**（队列那层只能放弃等待 ✗）✓
			const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
			const stream = llm.stream({
				provider: target.provider,
				model: target.model,
				messages: buildJudgeMessages(list),
				maxTokens: JUDGE_MAX_TOKENS,
				sessionId: target.sessionId,
				purpose: JUDGE_PURPOSE,
				...(signal === undefined ? {} : { signal }),
			});
			for await (const chunk of stream) { raw += textOfChunk(chunk); }
		} catch (error) {
			try { logger?.warn?.(`[vssaros-memory] LLM 判定失败（保留全部候选 ✓）：${error?.message ?? error}`); } catch { /* 记录失败本身绝不再抛 ✓ */ }
			return failOpen(list, error?.message ?? error);
		}
		const verdict = parseJudgeReply(raw, list);
		// ⚠ 解析失败也**不抛** —— 调用方拿到的是"全保留"✓（`parseFailed` 让它可以如实报告 ✓）
		if (verdict.parseFailed) {
			try { logger?.warn?.('[vssaros-memory] LLM 判定的回答解析不了（保留全部候选 ✓）'); } catch { /* 同上 ✓ */ }
		}
		return verdict;
	}

	return { judge };
}
