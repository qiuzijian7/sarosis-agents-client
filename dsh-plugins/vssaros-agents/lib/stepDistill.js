// @vssaros/dsh-agents — 团队步骤技能提炼的模型调用（2026-11-06）
//
// 一次性调用 DSH 的 `llm.stream()`（与 vssaros-memory 评审员 lib/advisor/runtime.js 的 streamText 同一写法）：
// 不开会话，所以不会在会话列表里留下东西，也没有要清理的；超时就中止。提示与解析在 lib/core/skillDistill.js。
//
// 用哪个模型（`route(evidence)` 依次试）：
//   ① 插件配置 `distillProvider` + `distillModel`（两个都写才算）；
//   ② 这个步骤的会话当时用的模型（证据里的 `sessionId` → `agents.get(id).options`）；
//   ③ 该 bot 在 .agent.md 里写的模型（lib/modelSelection.js 的路由表）。
//   都没有 ⇒ 抛错，调用方退回模板草稿并如实标记。

import { randomUUID } from 'node:crypto';
import { distillMessages, parseDistilled } from './core/skillDistill.js';

export const DISTILL_TIMEOUT_MS = 90_000;
const MAX_TOKENS = 1800;

/**
 * @param deps `{ llm(): LlmRuntime|undefined, route(evidence): {provider, model}|undefined, timeoutMs? }`
 * @returns `(evidence, similar) => Promise<提炼结果>`；没有模型 / 超时 / 答得不对时抛错
 */
export function makeStepDistiller({ llm, route, timeoutMs = DISTILL_TIMEOUT_MS }) {
	return async (evidence, similar = []) => {
		const runtime = llm();
		if (typeof runtime?.stream !== 'function') { throw new Error('DSH 的 llm 服务还没就绪'); }
		const target = route(evidence);
		if (!target?.provider || !target?.model) { throw new Error('没有可用的提炼模型（插件没配 distillProvider/distillModel，步骤会话与 bot 也没有模型）'); }
		const { system, user } = distillMessages(evidence, similar);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`提炼超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
		let text = '';
		try {
			const stream = runtime.stream({ provider: target.provider, model: target.model, system, maxTokens: MAX_TOKENS, signal: controller.signal,
				messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'user' } }] });
			for await (const chunk of stream) {
				if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; }
			}
		} catch (error) {
			throw new Error(controller.signal.aborted ? String(controller.signal.reason?.message ?? '提炼超时') : `提炼模型调用失败：${String(error?.message ?? error)}`);
		} finally {
			clearTimeout(timer);
		}
		return { ...parseDistilled(text), model: `${target.provider}/${target.model}` };
	};
}

/** 默认的模型选择（见文件头的三级顺序）。 */
export function distillRouteOf({ config, agents, botRoute }) {
	return (evidence) => {
		const provider = typeof config?.distillProvider === 'string' ? config.distillProvider.trim() : '';
		const model = typeof config?.distillModel === 'string' ? config.distillModel.trim() : '';
		if (provider && model) { return { provider, model }; }
		const options = evidence?.sessionId ? agents()?.get?.(evidence.sessionId)?.options : undefined;
		if (typeof options?.provider === 'string' && options.provider && typeof options?.model === 'string' && options.model) {
			return { provider: options.provider, model: options.model };
		}
		const route = botRoute(evidence?.botId);
		return route?.provider && route?.model ? { provider: route.provider, model: route.model } : undefined;
	};
}
