// 本地 Agent 的 dsh 模型适配器（P0）。
//
// ★ 刻意**不** `import { LlmAdapter } from '@deepseek-ai/dsh-llm'`：
// 仓库根没有这份包，插件源码静态 import 会让 check-plugin-files 的「入口真 import」变红，
// 也会让 headless bundle 多一条硬依赖。dsh runtime 对 adapter 是 duck-typing，
// 最少方法集由 dsh-plugins/test/llm-adapter-contract.test.mjs ④ 钉住：
//   providerInfo / providerRetryPolicy / listModels / resolveModel / prepareCall / stream
// 另外补 imageRequestTarget / imageRequestPricing 两个默认实现，避免别的调用面报缺方法。
import { spawn } from 'node:child_process';
import { cleanEnv, findExecutable, searchDirs } from './discover.js';
import { linesOf, normalizeEvent, toChunks } from './ndjson.js';
import { createAcpAdapter } from './acpAdapter.js';
import { textOfContent } from './text.js';
import { imageNoticeOf, lastUserContent, supportsImages } from './images.js';

export { textOfContent };

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export class LocalAgentError extends Error {
	constructor(message, code) {
		super(message);
		this.name = 'LocalAgentError';
		this.code = code;
	}
}

/**
 * P0 的 prompt 口径：最后一条 user 消息 + system 作为**附加指令**。
 * 不覆盖 CLI 自己的系统提示；增量消息 / bounded replay 属 P1。
 */
/** 最后一条用户消息正文（不含 system）：标题、摘要这类辅助用途不该带上团队规则。 */
export function userTextOf(options) {
	const messages = Array.isArray(options?.messages) ? options.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === 'user') return textOfContent(messages[i].content);
	}
	return '';
}

export function promptOf(options) {
	const body = userTextOf(options);
	const system = typeof options?.system === 'string' ? options.system.trim() : '';
	return system ? `${system}\n\n${body}` : body;
}

async function* eventStream(child, kind) {
	for await (const line of linesOf(child.stdout)) {
		const event = normalizeEvent(line, kind);
		if (event) yield event;
	}
}

/**
 * @param deps 注入点：engineTable / findExecutable / spawnProcess / cleanEnv / now。
 *             生产用默认值；测试用 fake CLI 与假 spawn，不需要任何真实密钥。
 */
export function createLocalAgentAdapter(deps = {}) {
	const table = deps.engineTable ?? {};
	const find = deps.findExecutable ?? ((command) => findExecutable(command, searchDirs()));
	const spawnProcess = deps.spawnProcess ?? spawn;
	const envOf = deps.cleanEnv ?? cleanEnv;
	const now = deps.now ?? (() => Date.now());
	const children = new Set();
	const live = new Map();
	// P2：图片字节由插件入口从 attachments.readImage 注入；缺失时任何路由都不声明支持图片。
	const readImage = deps.readImage;
	// P1：ACP 路由走独立的多轮状态机；P0 的 NDJSON 单轮路径保持原样，互不干扰。
	const acp = createAcpAdapter({ engineTable: table, deps: { ...deps, cwdFor: deps.cwdFor, rootsFor: deps.rootsFor, sessionMap: deps.sessionMap, readImage } });

	const specOf = (route) => table[route];

	return {
		live,

		providerInfo(provider) {
			return { id: provider, name: specOf(provider)?.name ?? provider };
		},
		providerRetryPolicy() { return undefined; },
		imageRequestPricing() { return undefined; },
		imageRequestTarget(_provider, _model, image) {
			return { width: image.width, height: image.height, maxBytes: image.bytes };
		},
		async listModels(provider) {
			const spec = specOf(provider);
			if (spec?.kind === 'acp') return acp.listModels(provider);
			if (!spec) return [];
			return spec.models.map((model) => ({ provider, id: model.id, name: model.name }));
		},
		async resolveModel(provider, model) {
			// ★ 声明与实现一致：只有 ACP + 附件服务可用时才宣称能吃图片（见 images.js 顶部口径）。
			const modalities = supportsImages(specOf(provider), readImage) ? ['text', 'image'] : ['text'];
			return {
				provider, id: model, name: model,
				inputModalities: modalities,
				context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
			};
		},
		async prepareCall(provider, model, signal) {
			const info = await this.resolveModel(provider, model, signal);
			return { model: info, stream: (options) => this.stream(options) };
		},

		async *stream(options) {
			const route = options?.provider;
			const spec = specOf(route);
			if (!spec) throw new LocalAgentError(`未知本地 Agent 路由 ${route}`, 'LOCAL_AGENT_MISSING');
			// P1：ACP 路由整条交给多轮状态机（含自己的 title/compaction 处理）。
			if (spec.kind === 'acp') {
				yield* acp.stream(options);
				return;
			}

			// 标题 / 压缩这类辅助请求绝不启动 CLI：既省额度，也不污染 CLI 自己的会话。
			if (options.purpose === 'session-title' || options.purpose === 'compaction') {
				const text = options.purpose === 'session-title'
					? userTextOf(options).replace(/\s+/g, ' ').trim().slice(0, 60)
					: '[Earlier conversation, condensed]';
				yield* toChunks([{ type: 'text', text: text || 'New session' }]);
				return;
			}

			const binary = find(spec.command);
			if (!binary) {
				throw new LocalAgentError(`找不到 ${spec.command}；请先安装并登录该 CLI`, 'LOCAL_AGENT_MISSING');
			}

			const child = spawnProcess(binary, [...spec.args], {
				env: envOf(),
				stdio: ['pipe', 'pipe', 'inherit'],
				windowsHide: true,
			});
			children.add(child);
			live.set(String(options.sessionId ?? 'anonymous'), { route, binary, startedAt: now() });

			const signal = options.signal;
			const onAbort = () => { try { child.kill?.(); } catch { /* 已退出 */ } };
			signal?.addEventListener?.('abort', onAbort, { once: true });
			try {
				if (child.stdin?.write) {
					// NDJSON 引擎没声明支持图片：附一条明确提示，不静默丢弃用户上传的图。
					child.stdin.write(promptOf(options) + imageNoticeOf(lastUserContent(options)));
					child.stdin.end?.();
				}
				yield* toChunks(eventStream(child, spec.kind));
			} finally {
				signal?.removeEventListener?.('abort', onAbort);
				try { child.kill?.(); } catch { /* 已退出 */ }
				children.delete(child);
			}
		},

		dispose() {
			for (const child of children) {
				try { child.kill?.(); } catch { /* 已退出 */ }
			}
			children.clear();
			live.clear();
			acp.dispose();
		},
	};
}
