/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Language Models Bridge
 * ----------------------
 *
 * Bridges the upstream VS Code Chat Provider proposed API (`vscode.lm.registerLanguageModelChatProvider`)
 * into Agent Studio's IAgentOSService.registerModelProvider() slot.
 *
 * Data flow:
 *
 *   3rd-party extension (ExtHost)
 *     └─ vscode.lm.registerLanguageModelChatProvider("acme", { ... })
 *           │   (proposed API: chatProvider, already wired upstream)
 *           ▼
 *   ILanguageModelsService (renderer)  ──── this bridge ────►  IAgentOSService
 *     └─ onDidChangeLanguageModels                                └─ registerModelProvider(IModelProvider)
 *
 * Strategy: group by `vendor` (one extension contributes one vendor with N models),
 * each vendor becomes a single IModelProvider whose `listModels()` enumerates
 * the vendor's current models. Vendor disappearance triggers dispose().
 */

import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { decodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILanguageModelsService, IChatMessage, IChatMessagePart, IChatMessageToolResultPart, IChatResponsePart, IChatResponseToolUsePart, IChatResponseStepPart, ChatMessageRole, ILanguageModelChatMetadata, ChatImageMimeType } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IAgentOSService } from '../common/agentOS.js';
import { ensureTrailingUserBoundary, normalizeMessages } from '../common/agentRunState.js';
import { ContextManager } from '../common/contextManager.js';
import { AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING, AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING } from '../common/constants.js';
import { join } from '../../../../base/common/path.js';
import { inferImageGen, inferVideoGen, inferModelGen, inferAudioGen } from '../common/llmBridge.js';
import {
	IModelProvider,
	IModelInfo,
	IModelAgentInfo,
	IModelDelta,
	IModelUsage,
	IModelOptions,
	IChatContext,
	IChatMessage as IAgentChatMessage,
	IImageGenParams,
	IImageGenResult,
	IVideoGenParams,
	IVideoGenResult,
	IModel3DGenParams,
	IModel3DGenResult,
	IAudioGenParams,
	IAudioGenResult,
	ModelAuthStatus,
	ModelCapability,
} from '../common/providers.js';

/**
 * Saros 约定 MIME：标识由 provider 扩展经 `LanguageModelDataPart.json(usage, MIME)`
 * 透传的「末块 usage」数据 part。
 *
 * 背景：provider 扩展（如 codebuddy-provider）运行在 ExtHost，无法直接 emit `step` part
 * （extHostLanguageModels 仅转换 Text/ToolCall/Data/Thinking）。因此末块 OpenAI `usage`
 * 借道 Data part 透传，由本 bridge 的 `_toModelDelta` `case 'data'` 识别此 MIME 并解码。
 *
 * ⚠️ 同步约定：此字符串与 `extensions/codebuddy-provider/src/extension.ts` 中
 * 上报 usage 时使用的 MIME 必须**逐字一致**（跨 npm 包无法共享常量，双方各自硬编码）。
 */
export const VSSAROS_USAGE_MIME = 'application/vnd.saros.usage+json';

/**
 * MIME for tunneling `finish_reason` from the provider extension through the
 * ExtHost progress layer to the renderer bridge. Same pattern as VSSAROS_USAGE_MIME.
 *
 * ⚠️ 同步约定：与 `extensions/codebuddy-provider/src/extension.ts` 中的 MIME 逐字一致。
 */
export const VSSAROS_FINISH_REASON_MIME = 'application/vnd.saros.finish-reason+json';

/**
 * 工具参数生成进度 DataPart MIME（2026-07-26 治本，与 provider 扩展约定）。
 * provider 在 tool_calls arguments 流式期间以 1s 节流上报 {name, bytes}；
 * 本桥识别后转 tool_progress delta——超大参数（file_write 写大文件，10k+
 * tokens 需 200s+）生成期间为 resilience/P4/subagent 看门狗的 idle 计时器
 * 续命，杜绝误判死流（事故日志 1785049332701）。
 */
export const VSSAROS_TOOL_CALL_PROGRESS_MIME = 'application/vnd.saros.tool-call-progress+json';

// ── P4: 死流检测 + 有限重试（2026-07-26，对齐 MiMo-Code persistent retry）──────
// provider 扩展的 fetchWithRetry 只覆盖「等待响应头」阶段（fetch 返回即
// clearTimeout）；SSE 流迭代期间 TCP 静默死亡（无 FIN）会让 for-await 永远
// 挂起——主 agent 没有子代理那种看门狗兜底，整个 turn 卡死。
// 这里给流迭代加 chunk 间隔超时（任一 part 到达即重置，对齐 MiMo wrapSSE），
// 超时/瞬时网络错误 → 指数退避重试（500ms→1000ms，最多 3 次尝试）。
// 防重复防线：已产出内容 delta 的 attempt 失败后不重试（避免消费者看到重复
// 文本）；用户取消（AbortError / 生成器 return）不重试。

/** chunk 间隔超时：5 分钟。推理模型多分钟思考窗口内仍持续发 reasoning chunk
 * （网关 keep-alive 也算活动），仅连接真死才触发。量级对齐 MiMo headerTimeout。 */
export const LM_BRIDGE_CHUNK_TIMEOUT_MS = 300_000;
/** 最大尝试次数（1 次首发 + 2 次重试）。MiMo 用 11 次持久重试，聊天场景收敛到 3。 */
export const LM_BRIDGE_RETRY_MAX_ATTEMPTS = 3;
/** raceIteratorNext 的超时哨兵返回值。 */
export const CHUNK_TIMEOUT_SENTINEL: unique symbol = Symbol('lmBridgeChunkTimeout');

/**
 * iterator.next() 与超时赛跑（对齐 MiMo wrapSSE 的 per-read 重武装）。
 * 超时时不取消 iterator（由调用方中止底层请求后统一收尾），只返回哨兵。
 */
export async function raceIteratorNext<T>(
	iterator: AsyncIterator<T>,
	timeoutMs: number,
): Promise<IteratorResult<T> | typeof CHUNK_TIMEOUT_SENTINEL> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			iterator.next(),
			new Promise<typeof CHUNK_TIMEOUT_SENTINEL>(r => {
				timer = setTimeout(() => r(CHUNK_TIMEOUT_SENTINEL), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
	}
}

/**
 * 可重试的瞬时流错误分类（对齐 MiMo isRetryableTransientError，收敛版）：
 * - 可重试：SSE 读超时、网络层错误（fetch failed/ECONNRESET/socket hang up）、
 *   网关 5xx/429；
 * - 不可重试：用户取消（abort/cancel）、4xx 参数/权限错误（重试必然同样失败）。
 */
export function isRetryableStreamError(msg: string): boolean {
	if (/abort|cancel/i.test(msg)) { return false; }
	// 429（限流）是 4xx 中唯一可重试的特例——先豁免再做 4xx 守卫。
	if (/HTTP 4(?!29)\d\d|invalid_parameter|Unauthorized|Forbidden/i.test(msg)) { return false; }
	return /SSE read timed out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network(?:\s|error)|HTTP 429|HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Timeout|timed? ?out/i.test(msg);
}

/**
 * One IModelProvider instance per LM vendor.
 *
 * - id:    `lm:<vendor>` so it's distinguishable from BYOK / built-in providers
 * - name:  derived from vendor (capitalized)
 * - listModels(): pulls current models from ILanguageModelsService whose vendor matches
 * - chat():       packs IChatMessage[] and calls ILanguageModelsService.sendChatRequest(modelId, ...)
 *
 * Agent-aware vendors:
 *   When a vendor wants to expose a hierarchical "agent → models" picker (e.g. Knot AG-UI),
 *   each LanguageModelChatInformation must set `family` to the agent id and (optionally)
 *   `tooltip` to the agent display name. Two-or-more distinct families on a single vendor
 *   automatically activates `supportsAgents` on the bridged IModelProvider, surfacing an
 *   agent picker in the chat box. Vendors that don't care about agents continue to ship a
 *   single family equal to the vendor id (default), and the bridge stays single-level.
 */
class LanguageModelVendorProvider extends Disposable implements IModelProvider {

	readonly id: string;
	readonly name: string;
	readonly priority: number = 50; // between built-in BYOK (default ~100) and pure user (~10)

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = this._onDidChangeAuthStatus.event;

	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

	get supportsAgents(): boolean {
		// True iff at least one model declares a family different from the vendor — the
		// extension-side opt-in for the hierarchical agent picker.
		for (const { metadata } of this._collectVendorModels()) {
			if (metadata.family && metadata.family !== this.vendor) {
				return true;
			}
		}
		return false;
	}

	readonly isServerSideProvider: boolean;

	constructor(
		readonly vendor: string,
		private readonly _lmService: ILanguageModelsService,
		private readonly _logService: ILogService,
		private readonly _environmentService: IEnvironmentService,
		private readonly _configurationService: IConfigurationService,
		private readonly _fileService: IFileService,
		private readonly _commandService: ICommandService,
	) {
		super();
		this.id = `lm:${vendor}`;
		this.name = vendor.charAt(0).toUpperCase() + vendor.slice(1);
		// isServerSideProvider 由各 vendor 扩展在自身 configuration 中声明。
		// 例如 codebuddy-provider 的 package.json 设 codebuddy.isServerSideProvider 默认 false。
		this.isServerSideProvider = this._configurationService.getValue<boolean>(`${vendor}.isServerSideProvider`) === true;
	}

	getAuthStatus(): ModelAuthStatus {
		// LM vendors are registered by extensions via vscode.lm.registerLanguageModelChatProvider.
		// Their model list is populated asynchronously (selectLanguageModels resolves after the
		// extension activates).  During startup, _collectVendorModels() may return empty even
		// though the vendor IS registered — it just hasn't resolved its models yet.
		//
		// Policy:
		//   - If we have models → Authenticated (fully ready)
		//   - If the vendor is known to ILanguageModelsService (either via extension point
		//     declaration or because it was previously seen) → Validating (pending resolution)
		//   - Only return NotConfigured if the vendor truly disappeared
		const hasModels = this._collectVendorModels().length > 0;
		if (hasModels) {
			return ModelAuthStatus.Authenticated;
		}
		// Check whether the vendor still exists in the LM service registry.
		// If it does, the models are probably still being resolved asynchronously.
		for (const v of this._lmService.getVendors()) {
			if (v.vendor === this.vendor) {
				return ModelAuthStatus.Validating;
			}
		}
		return ModelAuthStatus.NotConfigured;
	}

	async listModels(): Promise<IModelInfo[]> {
		const result: IModelInfo[] = [];
		for (const { id, metadata } of this._collectVendorModels()) {
			const bareId = this._bareModelId(id);
			// `ILanguageModelChatMetadata` (VSCode standard type) carries no reasoning flag,
			// and extensions registering via vscode.lm.registerLanguageModelChatProvider
			// (e.g. codebuddy) drop the `supportsReasoning` field on the way through
			// `createModelInfo` → `LanguageModelChatInformation.capabilities` (always `{}`).
			// So the thinking toggle never lights up for these models. We recover the
			// capability by inferring it from the model id. Policy (per product decision):
			// any model recognised as reasoning-capable surfaces a plain switch — we set
			// `supportsReasoning: true` and leave `reasoningType` unset so the webview's
			// `reasoningUIType` falls through to the `'switch'` branch.
			const supportsReasoning = this._inferSupportsReasoning(bareId, metadata);
			const supportsImages = this._inferSupportsImages(bareId, metadata);
			// `ILanguageModelChatMetadata` carries no text→image flag either, so provider
			// extensions registering via `vscode.lm` cannot declare image generation.
			// Recover it with the shared `inferImageGen` heuristic (same one used by the
			// BYOK / built-in providers) so image models show up in the image-gen node —
			// that node filters on `models.some(m => m.supportsImageGen)`.
			const supportsImageGen = inferImageGen({ id: bareId, name: metadata.name, description: metadata.detail ?? metadata.tooltip });
			// 视频 / 3D 能力同款启发式推断（编排域 `video_*` / `model_*` 前缀 +
			// 常见模型家族名），供画布视频 / 3D 节点按 supportsVideoGen /
			// supportsModelGen 过滤模型下拉。
			const supportsVideoGen = inferVideoGen({ id: bareId, name: metadata.name, description: metadata.detail ?? metadata.tooltip });
			const supportsModelGen = inferModelGen({ id: bareId, name: metadata.name, description: metadata.detail ?? metadata.tooltip });
			const supportsAudioGen = inferAudioGen({ id: bareId, name: metadata.name, description: metadata.detail ?? metadata.tooltip });
			const maxInput = metadata.maxInputTokens || 128000;
		const maxOutput = metadata.maxOutputTokens || 4096;
		// IOA 网关模型（如 hy3-ioa）的 context window 必须预留输出空间：
		// 网关按 total = input + output 校验，prompt 172K + maxTokens 32K 超出网关限制
		// → 用 maxInput - maxOutput 作压缩目标窗口，确保压缩在 prompt 填满前触发
		const contextWin = Math.max(4096, maxInput - maxOutput);
		result.push({
			id: bareId,                               // strip `vendor/` and `vendor-` prefixes; provider expects bare model id
			name: this._friendlyModelName(id, metadata),
			description: metadata.detail ?? metadata.tooltip,
			contextWindow: contextWin,
			maxInputTokens: maxInput,
			maxOutputTokens: maxOutput,
			maxAllowedSize: maxInput,
			capabilities: [ModelCapability.Chat],
			...(supportsReasoning ? { supportsReasoning: true } : {}),
			...(supportsImages ? { supportsImages: true } : {}),
			...(supportsImageGen ? { supportsImageGen: true } : {}),
			...(supportsVideoGen ? { supportsVideoGen: true } : {}),
			...(supportsModelGen ? { supportsModelGen: true } : {}),
			...(supportsAudioGen ? { supportsAudioGen: true } : {}),
		});
		}
		return result;
	}

	/**
	 * Strip the `vendor/` prefix and any `agentId::` encoding from a qualified id to
	 * recover the bare model id used by the provider extension (e.g. codebuddy).
	 * Mirrors the id-decoding done in `_friendlyModelName`, but returns the raw model id
	 * (not a display name) for capability matching.
	 */
	private _bareModelId(qualifiedId: string): string {
		const slashIdx = qualifiedId.indexOf('/');
		const rest = slashIdx === -1 ? qualifiedId : qualifiedId.slice(slashIdx + 1);
		const sepIdx = rest.indexOf('::');
		let bare = (sepIdx > -1 ? rest.slice(sepIdx + 2) : rest) || qualifiedId;
		// Some extensions (e.g. codebuddy) additionally prefix every model name with their
		// own vendor tag (`codebuddy-claude-opus-4.7`). That extra `<vendor>-` segment breaks
		// the anchored `/^claude-/`, `/^gpt-/`, … heuristics below, so strip it as well.
		const vendorPrefix = `${this.vendor}-`;
		if (bare.toLowerCase().startsWith(vendorPrefix.toLowerCase())) {
			bare = bare.slice(vendorPrefix.length) || bare;
		}
		return bare;
	}

	/**
	 * Infer whether a bridged LM model supports reasoning/thinking from its id.
	 *
	 * Rationale: the VSCode LM API metadata (`ILanguageModelChatMetadata`) has no field
	 * to carry reasoning capability, and provider extensions (codebuddy etc.) lose the
	 * flag when they build `LanguageModelChatInformation`. Rather than patch every
	 * extension + the VSCode standard type, we reconstruct the capability here using id
	 * heuristics derived from `extensions/codebuddy-provider/model.json` (validated to
	 * match all 68 declared models exactly).
	 *
	 * Returns `true` only for families known to support thinking; conservatively `false`
	 * otherwise (so non-reasoning models like gpt-5 plain / deepseek-v3-1 / gemini-2.5-flash
	 * never show a stray toggle).
	 */
	private _inferSupportsReasoning(qualifiedId: string, _metadata: ILanguageModelChatMetadata): boolean {
		const s = this._bareModelId(qualifiedId).toLowerCase();

		// Image / completion / non-chat families — never reasoning.
		if (s.includes('image')) { return false; }
		if (/(completion|codewise)/.test(s)) { return false; }
		if (/^o4-mini/.test(s)) { return false; }

		// GPT-5: plain `gpt-5` and its codex/mini/nano variants do NOT reason;
		// minor-versioned gpt-5.1 ~ gpt-5.5 (and their codex variants) DO.
		if (/^gpt-5(-codex|-mini|-nano)?$/.test(s)) { return false; }
		if (/^gpt-5\.\d/.test(s)) { return true; }

		// DeepSeek: only v3-2 reasons; v3-1 / v3-0324 / r1 do not.
		if (/^deepseek-v3-2/.test(s)) { return true; }
		if (/^deepseek-/.test(s)) { return false; }

		// Gemini: 3.x reasons, 2.5-pro reasons, 2.5-flash does not.
		if (/^gemini-3/.test(s)) { return true; }
		if (/^gemini-2\.5-pro/.test(s)) { return true; }
		if (/^gemini-/.test(s)) { return false; }

		// Claude: all currently-shipped families reason.
		if (/^claude-/.test(s)) { return true; }

		// GLM 4.6 / 4.7 / 5.x / 5v.
		if (/^glm-(4\.[67]|5)/.test(s)) { return true; }

		// Kimi K2 thinking / minor versions.
		if (/^kimi-k2(\.\d|-thinking)/.test(s)) { return true; }

		// MiniMax M-series.
		if (/^minimax-m\d/.test(s)) { return true; }

		// Hunyuan 2.x thinking / instruct (plain hunyuan-chat does not reason).
		if (/^hunyuan-2\.\d-(thinking|instruct)/.test(s)) { return true; }
		if (/^hunyuan-/.test(s)) { return false; }

		// Hunyuan hy3 previews / dev builds.
		if (/^hy3-/.test(s)) { return true; }

		// Internal default reasoning model.
		if (/^default-1\.2/.test(s)) { return true; }

		return false;
	}

	/**
	 * Infer whether a bridged LM model supports images/vision from its id.
	 *
	 * Rationale: the VSCode LM API metadata (`ILanguageModelChatMetadata`) has no field
	 * to carry image/vision capability, and provider extensions (codebuddy etc.) lose the
	 * `supportsImages` flag when they build `LanguageModelChatInformation`. We recover the
	 * capability by inferring it from the model id, validated against
	 * `extensions/codebuddy-provider/model.json` (which declares `supportsImages` per model).
	 *
	 * Returns `true` for families known to support vision; conservatively `false` otherwise.
	 */
	private _inferSupportsImages(qualifiedId: string, metadata: ILanguageModelChatMetadata): boolean {
		// Prefer the authoritative capability flag carried in the LM metadata.
		// Provider extensions (e.g. codebuddy) now propagate the real `supportsImages`
		// switch from model.json into `LanguageModelChatInformation.capabilities.imageInput`,
		// which the exthost converts to `metadata.capabilities.vision`. When present, trust
		// it directly; the regex heuristics below are only a fallback for providers that
		// still omit the capability metadata.
		const vision = metadata.capabilities?.vision;
		if (typeof vision === 'boolean') {
			return vision;
		}

		const s = this._bareModelId(qualifiedId).toLowerCase();

		// Image-generation / non-chat families never accept image *input* — disable.
		if (/image/.test(s)) { return false; }

		// Known non-vision models — explicitly disable.
		if (/^hy3-preview/.test(s)) { return false; }

		// Claude: all shipped families support vision.
		if (/^claude-/.test(s)) { return true; }

		// GPT-4 / GPT-4o / GPT-4.1 / GPT-4.5 / GPT-5 / Codex families support vision.
		if (/^gpt-4/.test(s)) { return true; }
		if (/^gpt-5/.test(s)) { return true; }
		if (/^gpt-codex/.test(s)) { return true; }

		// Gemini: all shipped chat families support vision.
		if (/^gemini-/.test(s)) { return true; }

		// DeepSeek: v3-2 supports vision; older v3-1 / r1 do not.
		if (/^deepseek-v3-2/.test(s)) { return true; }
		if (/^deepseek-/.test(s)) { return false; }

		// GLM 4.6 / 4.7 / 5.x support vision.
		if (/^glm-(4\.[67]|5)/.test(s)) { return true; }

		// Kimi K2 supports vision.
		if (/^kimi-k2/.test(s)) { return true; }

		// MiniMax M-series supports vision.
		if (/^minimax-m\d/.test(s)) { return true; }

		// Hunyuan 2.x supports vision.
		if (/^hunyuan-2/.test(s)) { return true; }

		// Default: conservatively false for unknown models.
		return false;
	}

	/**
	 * Pick a human-readable display name for a model entry. Order of preference:
	 *   1. `metadata.name` from the extension's LanguageModelChatInformation (what the
	 *      provider author intended);
	 *   2. the trailing path component of the qualified id (`vendor/<group>/<modelId>` →
	 *      `<modelId>`), useful when an extension uses the id alone to convey the friendly
	 *      label and leaves `name` blank;
	 *   3. for hierarchical (agent×model) ids encoded as `agentId::modelName`, the right-hand
	 *      side after `::` — purely a defensive fallback for vendors that follow the bridge's
	 *      encoding contract but forget to set `name`.
	 * The qualified id (with the `vendor/...` prefix) is never returned verbatim; it makes the
	 * picker unreadable.
	 */
	private _friendlyModelName(qualifiedId: string, metadata: ILanguageModelChatMetadata): string {
		const intended = metadata.name?.trim();
		if (intended) {
			return intended;
		}
		// strip the `vendor/` prefix — qualifiedId is always `vendor/<rest>` per toModelIdentifier
		const slashIdx = qualifiedId.indexOf('/');
		const rest = slashIdx === -1 ? qualifiedId : qualifiedId.slice(slashIdx + 1);
		const sepIdx = rest.indexOf('::');
		if (sepIdx > -1) {
			const tail = rest.slice(sepIdx + 2);
			if (tail) {
				return tail;
			}
		}
		return rest || qualifiedId;
	}

	/**
	 * List agents grouped by `family`. Only meaningful for vendors that opted into the
	 * hierarchical picker (i.e. supportsAgents === true). Returns an empty array otherwise
	 * so callers that always invoke listAgents() don't have to special-case the flag.
	 */
	async listAgents(): Promise<IModelAgentInfo[]> {
		if (!this.supportsAgents) {
			return [];
		}
		const buckets = new Map<string, { name: string; description?: string; modelIds: string[] }>();
		for (const { id, metadata } of this._collectVendorModels()) {
			const agentId = metadata.family || this.vendor;
			let entry = buckets.get(agentId);
			if (!entry) {
				// Use tooltip as the human-readable agent name (the LM `name` field is reserved for the
				// model display name in agent-mode); fall back to detail / family / agent-id.
				entry = {
					name: metadata.tooltip || metadata.detail || agentId,
					description: metadata.detail,
					modelIds: [],
				};
				buckets.set(agentId, entry);
			}
			entry.modelIds.push(id);
		}
		return Array.from(buckets.entries()).map(([id, v]) => ({
			id,
			name: v.name,
			description: v.description,
			models: v.modelIds,
		}));
	}

	/** Re-fire onDidChangeModels — called by the bridge whenever LM service signals a change for this vendor. */
	notifyModelsChanged(): void {
		this._onDidChangeModels.fire();
		this._onDidChangeAgents.fire();
	}

	/**
	 * 文生图：通用分发到 `${vendor}.generateImage` 命令。
	 *
	 * vscode.lm 注册的 vendor 扩展（如 lightai-provider）本身只承诺 chat 模型能力，
	 * 没有 `vscode.lm.generateImage` 这种 API。因此文生图走「扩展显式注册命令」
	 * 的方式：若 vendor 扩展注册了 `${vendor}.generateImage` 命令（参数为
	 * `IImageGenParams` + 可选 `IChatContext`，返回 `IImageGenResult`），
	 * 桥接就转发调用；否则抛出清晰错误。
	 *
	 * 现有已支持文生图能力的 BYOK provider（OpenAI 兼容 `builtInBYOKModelProvider`）不走此路径。
	 */
	async generateImage(params: IImageGenParams, context?: IChatContext): Promise<IImageGenResult> {
		const commandId = `${this.vendor}.generateImage`;
		try {
			const result = await this._commandService.executeCommand<IImageGenResult>(commandId, params, context);
			if (!result || !Array.isArray(result.images)) {
				throw new Error(`Provider ${this.name} 文生图命令 ${commandId} 返回值缺少 images 数组`);
			}
			return result;
		} 		catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('not found')) {
				throw new Error(`Provider ${this.name} 不支持文生图（扩展未实现 ${commandId} 命令）`);
			}
			throw err;
		}
	}

	/**
	 * 文生视频：与 generateImage 同模式，分发到 `${vendor}.generateVideo` 命令。
	 * 扩展侧（如 lightai-provider 的 floodGen）注册该命令即可接入视频生成节点。
	 */
	async generateVideo(params: IVideoGenParams, context?: IChatContext): Promise<IVideoGenResult> {
		const commandId = `${this.vendor}.generateVideo`;
		try {
			const result = await this._commandService.executeCommand<IVideoGenResult>(commandId, params, context);
			if (!result || !Array.isArray(result.videos)) {
				throw new Error(`Provider ${this.name} 视频生成命令 ${commandId} 返回值缺少 videos 数组`);
			}
			return result;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('not found')) {
				throw new Error(`Provider ${this.name} 不支持视频生成（扩展未实现 ${commandId} 命令）`);
			}
			throw err;
		}
	}

	/**
	 * 3D 模型生成：与 generateImage 同模式，分发到 `${vendor}.generateModel3D` 命令。
	 */
	async generateModel3D(params: IModel3DGenParams, context?: IChatContext): Promise<IModel3DGenResult> {
		const commandId = `${this.vendor}.generateModel3D`;
		try {
			const result = await this._commandService.executeCommand<IModel3DGenResult>(commandId, params, context);
			if (!result || !Array.isArray(result.models)) {
				throw new Error(`Provider ${this.name} 3D 生成命令 ${commandId} 返回值缺少 models 数组`);
			}
			return result;
		} 		catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('not found')) {
				throw new Error(`Provider ${this.name} 不支持 3D 模型生成（扩展未实现 ${commandId} 命令）`);
			}
			throw err;
		}
	}

	/**
	 * 音频生成（TTS/音乐）：与 generateImage 同模式，分发到 `${vendor}.generateAudio` 命令。
	 */
	async generateAudio(params: IAudioGenParams, context?: IChatContext): Promise<IAudioGenResult> {
		const commandId = `${this.vendor}.generateAudio`;
		try {
			const result = await this._commandService.executeCommand<IAudioGenResult>(commandId, params, context);
			if (!result || !Array.isArray(result.audios)) {
				throw new Error(`Provider ${this.name} 音频生成命令 ${commandId} 返回值缺少 audios 数组`);
			}
			return result;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('not found')) {
				throw new Error(`Provider ${this.name} 不支持音频生成（扩展未实现 ${commandId} 命令）`);
			}
			throw err;
		}
	}

	/** Collect all language models that belong to this vendor, with their resolved metadata. */
	private _collectVendorModels(): { id: string; metadata: ILanguageModelChatMetadata }[] {
		const out: { id: string; metadata: ILanguageModelChatMetadata }[] = [];
		for (const id of this._lmService.getLanguageModelIds()) {
			const metadata = this._lmService.lookupLanguageModel(id);
			if (metadata && metadata.vendor === this.vendor) {
				out.push({ id, metadata });
			}
		}
		return out;
	}

	async *chat(
		modelId: string,
		messages: IAgentChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		let meta = this._lmService.lookupLanguageModel(modelId);

		// ── Reverse-resolve bare model IDs ──
		// When a selection is persisted (agent.yaml / settings.json), the model ID
		// is normalised to a bare name (e.g. "deepseek-v3.1") by stripping the
		// qualified prefix ("knot/<agentId>::deepseek-v3.1").  At runtime, however,
		// the language-model cache keys use the full qualified identifier.
		// If the direct lookup fails, scan this vendor's models for a suffix match.
		if (!meta) {
			for (const entry of this._collectVendorModels()) {
				// Strip vendor/ prefix AND vendor- prefix from the cached id,
				// then compare against the bare modelId.  The cached identifier
				// may be "codebuddy/codebuddy-deepseek-v4-pro-ioa" while the
				// persisted selection is "deepseek-v4-pro-ioa".
				const candidate = this._bareModelId(entry.id);
				if (candidate === modelId) {
					this._logService.trace(
						`[LMBridge] Resolved bare modelId "${modelId}" → qualified "${entry.id}"`,
					);
					modelId = entry.id;
					meta = entry.metadata;
					break;
				}
			}
		}

		if (!meta) {
			yield { type: 'error', error: `Model ${modelId} not found in vendor ${this.vendor}` };
			return;
		}

		this._logService.info(`[LMBridge] chat() called — vendor=${this.vendor} model=${modelId}, tools=${options.tools?.length ?? 0}`);

		// ── 归一化消息顺序（OpenAI 兼容网关收口）──────────────────────
		// 修复 agentloop 注入的 system-reminder 等造成的连续 user / orphaned tool_calls，
		// 否则网关返回 HTTP 400 invalid_parameter。
		const normalizedMessages = normalizeMessages(messages as any[]);
		if (normalizedMessages.length !== messages.length) {
			this._logService.info(
				`[LMBridge] normalizeMessages: ${messages.length} → ${normalizedMessages.length} ` +
				`(merged consecutive user / added orphaned-tool or trailing-user-boundary placeholders)`,
			);
		}
		// ── 发送前 tool 配对守卫（2026-08-11，日志 1786432061200 HTTP 400 code 11133）──
		// normalizeMessages 只补孤儿 tool 占位，不清理「assistant.tool_calls 无应答」或
		// 「孤立 tool 消息引用不存在 toolCallId」的失配——IOA 网关强制
		// assistant.tool_calls 必须被对应 tool 结果应答，任一失配即 400 invalid_parameter_value。
		// 压缩产物经 _prePruneMessages 截断 / _enforceWindowCeiling 兜底后可能重新产生失配，
		// 故发送前必须再跑一次 sanitizeToolPairs（静态方法注释即声明"供发送前守卫复用"）。
		const sanitizedMessages = ContextManager.sanitizeToolPairs(normalizedMessages as any[]);
		if (sanitizedMessages.length !== normalizedMessages.length) {
			this._logService.warn(
				`[LMBridge] sanitizeToolPairs: ${normalizedMessages.length} → ${sanitizedMessages.length} ` +
				`(stripped ${normalizedMessages.length - sanitizedMessages.length} orphaned tool_call/tool_result pairs)`,
			);
			// ── 清理结果回写调用方历史（2026-08-18，日志 1787021037798 断崖1）──
			// normalize/sanitize 若只改发送副本，本地历史中的孤儿消息每轮都会在
			// 同一位置被重新裁剪 → prompt cache 前缀每轮断在固定点（61→58 连续
			// 4 轮仅 ~4.7k 命中，~180k miss tokens）。这里原地回写调用方 messages，
			// 使本地历史与已发送历史一致——孤儿只裁剪一次，对齐 Hermes「持久
			// transcript 与请求视图 byte-stable」纪律。
			if (Array.isArray(messages) && sanitizedMessages.length < messages.length) {
				try {
					messages.splice(0, messages.length, ...(sanitizedMessages as unknown as IAgentChatMessage[]));
					this._logService.info(
						`[LMBridge] sanitize write-back: caller history rewritten to ${sanitizedMessages.length} messages ` +
						`(orphan fix persisted — no re-trim / no fixed cache breakpoint next turn)`
					);
				} catch (writeBackErr) {
					this._logService.warn(`[LMBridge] sanitize write-back failed (non-fatal): ${writeBackErr}`);
				}
			}
		}
		// ── 末尾 user 边界守卫（2026-08-19，日志 1787104763200 HTTP 400 code 11133）──
		// 必须在 sanitizeToolPairs + 回写**之后**：sanitize 移除失配 tool 消息后，
		// 末尾可能重新暴露出 assistant，而 IOA 网关要求最后一条为 user/tool，
		// 否则 400 invalid_parameter_value（param 为空）。
		// continuation 标记 synthetic:true 且**只进发送副本**（不参与上面的回写），
		// 避免污染干净 transcript / 每轮累积 / 破坏 prompt cache 前缀。
		const guardedMessages = ensureTrailingUserBoundary(sanitizedMessages as any[]);
		if (guardedMessages.length !== sanitizedMessages.length) {
			this._logService.warn(
				`[LMBridge] ensureTrailingUserBoundary: messages ended with assistant (no tool_calls) — ` +
				`appended continuation user boundary for gateway compatibility (${sanitizedMessages.length} → ${guardedMessages.length}, send-copy only)`,
			);
		}
		const lmMessages = this._toLanguageModelMessages(guardedMessages as any, options);

		// Debug: write request payload to local file if switch is enabled
		this._debugWriteRequest(modelId, messages, options, context);

		// 将 options 传递给 sendChatRequest，以便扩展可以访问 tools 等配置
		// 注意：systemPrompt 已经在 _toLanguageModelMessages 中处理，不应重复传递
		const requestOptions: any = {
			requestInitiator: 'sessions.agentStudio',
			modelOptions: {},
		};

		// 传递 tools 定义给扩展（通过 modelOptions）
		if (options.tools && options.tools.length > 0) {
			requestOptions.modelOptions.tools = options.tools;
			this._logService.trace(`[LMBridge] Passing ${options.tools.length} tools to extension via modelOptions.tools`);
		}

		// 透传 tool_choice（2026-08-20）。此前完全未透传 —— agent loop 的收尾轮
		// （toolChoice:'none'，对齐 MiMo-Code）与续跑兜底（'required'）在扩展 provider
		// 路径上全部失效，只有 BYOK provider 生效。扩展若不认识该字段会忽略，无副作用。
		if (options.toolChoice) {
			requestOptions.modelOptions.toolChoice = options.toolChoice;
			this._logService.info(`[LMBridge] Passing toolChoice='${options.toolChoice}' to extension (tools=${options.tools?.length ?? 0})`);
		}

		// 传递其他 modelOptions（如 temperature, maxTokens）
		if (options.temperature !== undefined) {
			requestOptions.modelOptions.temperature = options.temperature;
		}
		if (options.maxTokens !== undefined) {
			requestOptions.modelOptions.maxTokens = options.maxTokens;
		}

		// 透传推理/思考配置给扩展（通过 modelOptions.reasoning）。
		// 聊天输入框的 thinking 开关 → IModelOptions.reasoning → 这里 → provider 扩展
		// 映射为 OpenAI 风格 body 的 reasoning_effort / reasoning_summary。
		//
		// ★ 2026-08-21 修复三态透传断裂（事故 1787282838177：LLM 永久「正在思考中」）
		// reasoning.enabled 是**三态**语义，必须原样透传：
		//   true      → 强制开思考
		//   false     → **显式关闭**（如 contextManager 的上下文压缩摘要请求）
		//   undefined → 不表态，由 provider 按模型能力字段决定
		// 旧代码 `if (options.reasoning?.enabled)` 把三态压成两态：`false` 是 falsy →
		// 整个 reasoning 对象被丢弃 → codebuddy-provider 收到 undefined → 落进
		// 「按模型能力自动开」分支（hy3-ioa 判定为 reasoning 模型）→ effort=high。
		// 后果：contextManager.ts:1028 明明写了 `reasoning: { enabled: false }`，
		// 压缩摘要请求仍以 effort=high 发出，耗时从 48s 涨到 167s 直至永久挂起，
		// 主 agent loop 阻塞在 await 上，UI 永久显示「正在思考中」。
		// 与 MEMORY.md 记录的 toolChoice 三处断裂是同一 bug 模式（显式关闭值被 falsy 吞掉）。
		//
		// 各 provider 对「显式 false」的处理（已逐一核对，本改动对它们都是正确的）：
		//   codebuddy-provider → uiReasoningEnabled===false 强制关（本次受害者，修复目标）
		//   geminiNative       → else 分支显式 thinkingConfig.thinkingBudget=0（正确关闭）
		//   builtInBYOK        → `if (reasoning?.enabled)` 仍为 false → 不注入参数（行为不变）
		if (options.reasoning && (
			options.reasoning.enabled !== undefined ||
			options.reasoning.effort !== undefined ||
			options.reasoning.budget !== undefined
		)) {
			requestOptions.modelOptions.reasoning = options.reasoning;
			this._logService.trace(`[LMBridge] Passing reasoning to extension: enabled=${options.reasoning.enabled} effort=${options.reasoning.effort ?? '(none)'} budget=${options.reasoning.budget ?? '(none)'}`);
		}

		// ── 透传抓包对齐的三个独立会话 id 给扩展（通过 modelOptions）──────────
		// 抓包证据（CodeBuddy IDE /v2/chat/completions）：三个 id 粒度不同、不可混用：
		//   conversationId     → X-Conversation-ID（会话级稳定）
		//   requestId          → X-Conversation-Request-ID（请求级，每轮新）
		//   previousResponseId → 请求体 previous_response_id（上轮响应 id，链式衔接）
		// 历史串台 bug：仅用单一 sessionId 当所有 id，服务端 KV 缓存按 conversation-id
		// 跨会话碰撞。这里把 agentOS 分配好的三 id 分别透传，扩展侧据此设置 header/body。
		// sessionId 保留透传以兼容旧扩展（等同 conversationId 语义）。
		const conversationId = context?.conversationId ?? context?.sessionId;
		if (conversationId) {
			requestOptions.modelOptions.sessionId = conversationId;       // 兼容旧扩展：当 X-Conversation-Id
			requestOptions.modelOptions.conversationId = conversationId;  // 新：X-Conversation-ID
		}
		if (context?.requestId) {
			requestOptions.modelOptions.requestId = context.requestId;    // X-Conversation-Request-ID
		}
		if (context?.previousResponseId) {
			requestOptions.modelOptions.previousResponseId = context.previousResponseId; // 请求体 previous_response_id
		}
		if (conversationId || context?.requestId || context?.previousResponseId) {
			this._logService.trace(`[LMBridge] Passing ids to extension: convId=${conversationId ?? '(none)'} reqId=${context?.requestId ?? '(none)'} prevRespId=${context?.previousResponseId ?? '(none)'}`);
		}

		// P4: 死流重试循环（每次 attempt 独立 CancellationTokenSource——
		// chunk 超时时会 cancel 以中止悬挂的 fetch，下一次 attempt 需要新 token）。
		for (let attempt = 1; attempt <= LM_BRIDGE_RETRY_MAX_ATTEMPTS; attempt++) {
			const attemptCts = new CancellationTokenSource();
			// 防重复防线：本 attempt 已向下游产出内容 delta 后失败 → 不重试，
			// 否则消费者会看到重复文本（pre-content 死亡才透明重试）。
			let yieldedContent = false;
			try {
				this._logService.trace(`[LMBridge] sendChatRequest: sending (modelId=${modelId}, msgCount=${lmMessages.length})${attempt > 1 ? ` attempt=${attempt}/${LM_BRIDGE_RETRY_MAX_ATTEMPTS}` : ''}`);
				const t0_sendRequest = Date.now();
				const response = await this._lmService.sendChatRequest(
					modelId,
					meta.extension,                   // initiating extension = the provider extension itself
					lmMessages,
					requestOptions,
					attemptCts.token,
				);
				this._logService.trace(`[LMBridge] sendChatRequest: response received in ${Date.now() - t0_sendRequest}ms, starting stream iteration`);

				let capturedResponseId: string | undefined;
				let capturedFinishReason: string | undefined;
				let _firstPartReceived = false;
				const streamIterator = response.stream[Symbol.asyncIterator]();
				while (true) {
					const next = await raceIteratorNext(streamIterator, LM_BRIDGE_CHUNK_TIMEOUT_MS);
					if (next === CHUNK_TIMEOUT_SENTINEL) {
						attemptCts.cancel(); // 中止悬挂的 fetch，释放底层连接
						throw new Error('SSE read timed out');
					}
					if (next.done) { break; }
					const part = next.value;
					if (!_firstPartReceived) {
						_firstPartReceived = true;
						this._logService.info(`[LMBridge] sendChatRequest: first stream part received in ${Date.now() - t0_sendRequest}ms`);
					}
					const parts = Array.isArray(part) ? part : [part];
					for (const p of parts) {
						// 尝试从 part 上捕获响应流 id（部分扩展会在 part 上挂 id/responseId）。
						// 抓包证据：响应流 chunk 的 id = 下一次请求的 previous_response_id。
						const pid = (p as { id?: unknown; responseId?: unknown })?.responseId
							?? (p as { id?: unknown })?.id;
						if (typeof pid === 'string' && pid) {
							capturedResponseId = pid;
						}
						// ── 捕获 finish_reason（经 DataPart 透传，同 usage 模式）──
						// provider 扩展在 SSE choice.finish_reason 到达时，通过
						// LanguageModelDataPart.json({finish_reason}, VSSAROS_FINISH_REASON_MIME)
						// 透传。这里截获并存储，在 stream 结束时随 done delta 一起发出，
						// 使 agentOSService 的 classifyIncompleteTurn 能检测 length 截断。
					const _frDataPart = p as { mimeType?: string; data?: { toString(): string } };
					if (_frDataPart.mimeType === VSSAROS_FINISH_REASON_MIME && _frDataPart.data) {
						try {
							const _frRaw = JSON.parse(_frDataPart.data.toString());
							if (typeof _frRaw.finish_reason === 'string') {
								capturedFinishReason = _frRaw.finish_reason;
							}
						} catch { /* 解码失败 — 忽略 */ }
						continue; // 不传给 _toModelDelta（它不认识此 MIME）
					}
					// ── 工具参数生成进度（2026-07-26 治本，同 finish_reason 模式）──
					// provider 在 tool_calls arguments 流式期间以 1s 节流上报进度；
					// 转 tool_progress delta 使 resilience/P4/subagent 看门狗的 idle
					// 计时器续命——超大参数生成期不再误判死流（事故 1785049332701）。
					if (_frDataPart.mimeType === VSSAROS_TOOL_CALL_PROGRESS_MIME && _frDataPart.data) {
						let _tpStage = '正在生成工具调用参数…';
						let _tpName: string | undefined;
						let _tpBytes: number | undefined;
						let _tpPartialArgs: string | undefined;
						try {
							const _tp = JSON.parse(_frDataPart.data.toString());
							const _kb = Math.max(1, Math.round((Number(_tp?.bytes) || 0) / 1024));
							_tpName = typeof _tp?.name === 'string' && _tp.name ? _tp.name : undefined;
							_tpBytes = Number.isFinite(Number(_tp?.bytes)) ? Number(_tp.bytes) : undefined;
							_tpPartialArgs = typeof _tp?.partialArgs === 'string' && _tp.partialArgs ? _tp.partialArgs : undefined;
							const _nm = _tpName ? ` ${_tpName}` : '';
							_tpStage = `正在生成工具调用参数${_nm}… 已 ${_kb} KB`;
						} catch { /* 解码失败 — 用默认 stage */ }
						yieldedContent = true; // 流确证存活；此后失败不走 P4 重试（避免重复正文）
						// 2026-09-06 v2：结构化 toolName/bytes/partialArgs 透传（参数预览，
						// doc/tool-args-streaming-preview-design.md）；stage/content 兼容旧消费者。
						yield {
							type: 'tool_progress',
							content: _tpStage,
							...(_tpName ? { toolName: _tpName } : {}),
							...(_tpBytes !== undefined ? { bytes: _tpBytes } : {}),
							...(_tpPartialArgs ? { partialArgs: _tpPartialArgs } : {}),
						};
						continue; // 不传给 _toModelDelta（它不认识此 MIME）
					}
						const delta = this._toModelDelta(p, modelId);
						if (delta) {
							yieldedContent = true;
							yield delta;
						}
					}
				}

				// 把捕获到的响应 id + finish_reason 随 done 回传给 agentOS。
				const doneDelta: IModelDelta = {
					type: 'done',
					...(capturedResponseId ? { responseId: capturedResponseId } : {}),
					...(capturedFinishReason ? { finishReason: capturedFinishReason } : {}),
				};
				yield doneDelta;
				return; // 成功 — 结束生成器
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const canRetry = attempt < LM_BRIDGE_RETRY_MAX_ATTEMPTS
					&& !yieldedContent
					&& isRetryableStreamError(msg);
				if (canRetry) {
					const backoffMs = 500 * Math.pow(2, attempt - 1); // 500ms → 1000ms（MiMo 500ms×2 指数）
					this._logService.warn(`[LMBridge] chat attempt ${attempt}/${LM_BRIDGE_RETRY_MAX_ATTEMPTS} failed (${msg}) — retrying in ${backoffMs}ms`);
					await new Promise(r => setTimeout(r, backoffMs));
					continue;
				}
				this._logService.error(`[LMBridge] chat() failed for vendor=${this.vendor} model=${modelId}`, err);
				yield { type: 'error', error: msg };
				return;
			} finally {
				attemptCts.dispose();
			}
		}

		// silence unused-var warnings for context — reserved for future use (agentId routing etc.)
		void context;
	}

	/**
	 * Debug: write the request payload (messages + options) to a local file
	 * if the debug switch is enabled.
	 * Writes to: <logsHome>/chat-streams/<vendor>_<sessionId>_<timestamp>_lm_request.json
	 */
	private async _debugWriteRequest(modelId: string, messages: IAgentChatMessage[], options: IModelOptions, context?: IChatContext): Promise<void> {
		try {
			const enabled = this._configurationService.getValue<boolean>(AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING);
			if (!enabled) { return; }
			const dumpTools = this._configurationService.getValue<boolean>(AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING);

			const logsHome = this._environmentService.logsHome;
			if (!logsHome) { return; }

			const dirPath = join(logsHome.fsPath, 'chat-streams');
			const dirUri = URI.file(dirPath);
			try {
				await this._fileService.resolve(dirUri);
			} catch {
				await this._fileService.createFolder(dirUri);
			}

			const timestamp = Date.now();
			const suffix = Math.random().toString(36).slice(2, 7);
			const sessionId = context?.sessionId || 'nosession';
			const fileName = `lm_${this.vendor}_${suffix}_${timestamp}_request.json`;
			const filePath = join(dirPath, fileName);
			const fileUri = URI.file(filePath);

			const debugObj = {
				vendor: this.vendor,
				model: modelId,
				sessionId,
				timestamp: new Date(timestamp).toISOString(),
				messageCount: messages.length,
				options: {
					temperature: options.temperature,
					maxTokens: options.maxTokens,
					toolChoice: options.toolChoice,
					reasoning: options.reasoning,
					// 🔧 dumpTools=true → 完整 tools schema；false → 摘要避免 log 膨胀
					tools: options.tools
						? (dumpTools ? options.tools : `(${options.tools.length} tools)`)
						: '(none)',
				},
				messages: messages.map(m => ({
					role: m.role,
					content: typeof m.content === 'string' ? m.content : `[${Array.isArray(m.content) ? 'contentParts' : 'unknown'}]`,
					toolCalls: m.toolCalls,
					toolCallId: m.toolCallId,
				})),
			};

			const content = VSBuffer.fromString(JSON.stringify(debugObj, null, 2));
			await this._fileService.writeFile(fileUri, content);
			this._logService.info(`[LMBridge] Debug request written to: ${filePath}`);
		} catch (err) {
			this._logService.warn(`[LMBridge] _debugWriteRequest failed:`, err);
		}
	}

	private _toLanguageModelMessages(messages: IAgentChatMessage[], options: IModelOptions): IChatMessage[] {
		const out: IChatMessage[] = [];

		if (options.systemPrompt) {
			out.push({
				role: ChatMessageRole.System,
				content: [{ type: 'text', value: options.systemPrompt }],
			});
		}

		for (const m of messages) {
			// ── tool result 消息 ──────────────────────────────────────────────
			// VS Code LanguageModelChatMessage 没有 Tool role，tool result 作为
			// content 中的 tool_result part，挂在 User role 下。
			if (m.role === 'tool') {
				out.push({
					role: ChatMessageRole.User,
					content: [{
						type: 'tool_result',
						toolCallId: m.toolCallId ?? '',
						value: [{ type: 'text', value: m.content ?? '' }],
					} satisfies IChatMessageToolResultPart],
				});
				continue;
			}

			const role = m.role === 'user' ? ChatMessageRole.User
				: m.role === 'assistant' ? ChatMessageRole.Assistant
					: m.role === 'system' ? ChatMessageRole.System
						: ChatMessageRole.User;

			const content: IChatMessagePart[] = this._toMessageParts(m);

			// ── assistant tool_calls ──────────────────────────────────────────
			// IAgentChatMessage.toolCalls → IChatResponseToolUsePart (type:'tool_use')
			if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
				for (const tc of m.toolCalls) {
					// arguments 是 JSON 字符串，直接作为 parameters 传递
					// 扩展端通过 typeof part.input === 'string' 识别并原样使用
					let params: unknown;
					try {
						params = JSON.parse(tc.arguments);
					} catch {
						params = tc.arguments;
					}
					content.push({
						type: 'tool_use',
						name: tc.name,
						toolCallId: tc.id,
						parameters: params,
					} satisfies IChatResponseToolUsePart);
				}
			}

			out.push({ role, content });
		}
		return out;
	}

	/**
	 * Convert an Agent Studio chat message into VS Code's native multimodal
	 * `IChatMessagePart[]`.
	 *
	 * When `contentParts` is present (built upstream in agentDriverService from
	 * user attachments), each part is mapped to the corresponding native part:
	 *   • text  → IChatMessageTextPart  ({ type: 'text', value })
	 *   • image → IChatMessageImagePart ({ type: 'image_url', value: { mimeType, data: VSBuffer } })
	 *
	 * Image data in `contentParts` is base64 (no `data:` prefix per providers.ts
	 * contract). VS Code's IChatImageURLPart explicitly requires raw binary
	 * (VSBuffer), NOT base64 — so we decode here. A stray `data:<mime>;base64,`
	 * prefix is stripped defensively before decoding.
	 *
	 * Falls back to a single text part (legacy `content` string) when no
	 * contentParts exist, preserving behaviour for text-only messages.
	 */
	private _toMessageParts(m: IAgentChatMessage): IChatMessage['content'] {
		const parts = m.contentParts;
		if (!parts || parts.length === 0) {
			return [{ type: 'text', value: m.content ?? '' }];
		}

		const out: IChatMessage['content'] = [];
		for (const p of parts) {
			if (p.type === 'text') {
				if (p.text) {
					out.push({ type: 'text', value: p.text });
				}
				continue;
			}
			if (p.type === 'image') {
				try {
					const raw = p.data || '';
					// Defensive: strip a data-URL prefix if one slipped through.
					const base64 = raw.startsWith('data:')
						? raw.slice(raw.indexOf(',') + 1)
						: raw;
					out.push({
						type: 'image_url',
						value: {
							mimeType: p.mimeType as unknown as ChatImageMimeType,
							data: decodeBase64(base64),
						},
					});
				} catch (err) {
					this._logService.warn(`[LMBridge] failed to decode image attachment, skipping: ${err}`);
				}
			}
		}

		// Guard: a message must never end up with an empty content array (some
		// providers reject that). Fall back to the legacy text content.
		if (out.length === 0) {
			out.push({ type: 'text', value: m.content ?? '' });
		}
		return out;
	}

	private _toModelDelta(part: IChatResponsePart, modelId: string): IModelDelta | undefined {
		// ── 防御性 string-coercion ────────────────────────────────────────
		// IChatResponsePart 来自第三方 LM 扩展（Copilot / Knot / 自研 vendor 等），
		// 协议未对 `value` 字段强制做 string 校验。实测中：
		//  • 部分 reasoning 模型在思考阶段会发出 type='text' 但 value=undefined 的
		//    占位 part（仅作为 stream keep-alive 信号）；
		//  • 某些 Knot AG-UI 流转层在 chunk 拆分边界会产生 value 为 null 的尾包。
		// 若直接 return { content: part.value } 透传，下游虽然在 += 累积处用了
		// `?? ''` 但 webview 端的 ${chunk.content} 模板字面量会把 undefined 渲染成
		// 字符串 "undefined"，导致 assistant 消息被海量 "undefinedundefined…" 污染。
		// 这里在桥接层统一做 coercion，保证 IModelDelta.content 永远是 string。
		const safeStr = (v: unknown): string => (typeof v === 'string' ? v : '');

		switch (part.type) {
			case 'text':
				return { type: 'text', content: safeStr(part.value) };
			case 'thinking':
				return { type: 'thinking', content: safeStr((part as { value?: unknown }).value) };
			case 'tool_use': {
				const toolPart = part as IChatResponseToolUsePart;
				const rawParams = toolPart.parameters;
				let argsStr: string;
				let displayName: string | undefined;
				let renderType: string | undefined;
				let defaultShow: boolean | undefined;

				// Extract _meta from parameters if present (set by Knot AG-UI extension)
				if (rawParams && typeof rawParams === 'object' && '_meta' in (rawParams as object)) {
					const meta = (rawParams as { _meta?: Record<string, unknown> })._meta;
					if (meta) {
						displayName = meta.display_name as string | undefined;
						renderType = meta.render_type as string | undefined;
						defaultShow = meta.default_show as boolean | undefined;
					}
					// Strip _meta from the parameters before passing to tool
					const cleanParams = { ...(rawParams as Record<string, unknown>) };
					delete cleanParams._meta;
					argsStr = JSON.stringify(cleanParams);
				} else if (typeof rawParams === 'string') {
					argsStr = rawParams;
				} else {
					argsStr = JSON.stringify(rawParams ?? {});
				}

				return {
					type: 'tool_call',
					toolCall: {
						id: toolPart.toolCallId,
						name: toolPart.name,
						arguments: argsStr,
						displayName,
						renderType,
						defaultShow,
					},
				};
			}
			case 'data': {
				// ── CodeBuddy 末块 usage 透传 ──────────────────────────────────────
				// CodeBuddy provider 扩展无法 emit `step` part（extHost 仅转换
				// Text/ToolCall/Data/Thinking），因此它把 OpenAI 末块的 `usage` 对象
				// 经 `LanguageModelDataPart.json(usage, VSSAROS_USAGE_MIME)` 透传过来。
				// 这里识别约定 MIME、解码 JSON、转成 IModelDelta usage，使 Token/计费
				// 指标贯通到 agentChatService 累积与 webview footer。
				const dataPart = part as { mimeType?: string; data?: { toString(): string } };
				if (dataPart.mimeType !== VSSAROS_USAGE_MIME || !dataPart.data) {
					return undefined; // 非 usage data part — 忽略
				}
				try {
					const raw = JSON.parse(dataPart.data.toString());
					// OpenAI 风格 usage 字段：prompt_tokens / completion_tokens / total_tokens；
					// 缓存细分在 prompt_tokens_details.cached_tokens；计费在 credit（CodeBuddy 扩展）。
					const usage: IModelUsage = {
						inputTokens: typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : undefined,
						outputTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : undefined,
						totalTokens: typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined,
						cachedTokens: raw.prompt_tokens_details?.cached_tokens != null
							? raw.prompt_tokens_details.cached_tokens
							: undefined,
						cacheWriteTokens: raw.prompt_tokens_details?.cache_write_tokens ?? undefined,
						credit: typeof raw.credit === 'number' ? raw.credit : undefined,
						// 真实使用的 provider/model（与面板「选择」可能不同——用户选 A 但实际用 B，
						// 例如 defaultModel 兜底。Token 明细 UI 用此字段展示真实命中，避免误导）
						providerId: this.vendor,
						modelId: modelId,
					};
					// 诊断（2026-07-27）：积分 pill 排查——渡海到 renderer 侧后 credit 是否
					// 仍在。若此处 usage.credit 为 undefined 但下方 keys 里有形似字段
					// （credits/cost/price/...），说明字段名在网关侧被改了，未在此同步更新。
					//
					// 降噪（2026-09-04，日志 vscode-app-1788504108364 分析）：原为 INFO 且
					// 每个 usage data part 都打一次——长会话上千条、占整份日志 26%+，
					// credit 正常时毫无信息量。降为 debug；仅当 credit 字段 MISSING
					// （诊断价值真正存在：网关侧字段名变更）时保留 INFO。
					const _usageDiag =
						`[LMBridge] usage decoded | credit=${usage.credit ?? 'MISSING'} ` +
						`raw keys=[${Object.keys(raw).join(',')}] raw.credit=${raw.credit ?? 'n/a'} ` +
						`raw.credits=${raw.credits ?? 'n/a'} raw.cost=${raw.cost ?? 'n/a'}`;
					if (typeof raw.credit !== 'number') {
						this._logService.info(_usageDiag);
					} else {
						this._logService.debug(_usageDiag);
					}
					if (
						usage.inputTokens !== undefined ||
						usage.outputTokens !== undefined ||
						usage.totalTokens !== undefined ||
						usage.cachedTokens !== undefined ||
						usage.cacheWriteTokens !== undefined ||
						usage.credit !== undefined
					) {
						return { type: 'usage', usage };
					}
				} catch {
					// 解码失败 — 当作普通 data part 忽略
				}
				return undefined;
			}
			case 'step': {
				// ── KnotBridge prompt-cache metric 透传 ──────────────────────────────
				// Knot AG-UI 扩展在每个 LLM call_llm step 结束时（phase='end'）随
				// tokenUsage 一起上报 prompt_tokens_details.cached_tokens 和
				// cache_write_tokens。
				// 若不在这里解析并转为 IModelDelta usage，这些指标会被 default 分支
				// 丢弃，导致走 Knot 路由时 UI 始终看不到 KV Cache 命中数。
				const stepPart = part as IChatResponseStepPart;
				if (stepPart.phase === 'end' && stepPart.tokenUsage) {
					const tu = stepPart.tokenUsage;
					const usage: IModelUsage = {
						inputTokens: tu.prompt_tokens ?? undefined,
						outputTokens: tu.completion_tokens ?? undefined,
						// cached_tokens 的类型是 number | null（Knot AG-UI 协议），
						// IModelUsage 期望 number | undefined，null 需显式转为 undefined
						cachedTokens: tu.prompt_tokens_details?.cached_tokens != null
							? tu.prompt_tokens_details.cached_tokens
							: undefined,
						cacheWriteTokens: tu.prompt_tokens_details?.cache_write_tokens ?? undefined,
						// 真实使用的 provider/model（与面板「选择」可能不同——用户选 A 但实际用 B）
						providerId: this.vendor,
						modelId: modelId,
					};
					// 仅当至少有一项指标时才 yield，避免发出全 undefined 的噪音 delta
					if (
						usage.inputTokens !== undefined ||
						usage.outputTokens !== undefined ||
						usage.cachedTokens !== undefined ||
						usage.cacheWriteTokens !== undefined
					) {
						return { type: 'usage', usage };
					}
				}
				return undefined; // step start / no usage — skip
			}
			default:
				return undefined; // data parts and others — ignored for now
		}
	}
}

/**
 * Workbench contribution that owns the bridge lifecycle.
 *
 * Subscribes to ILanguageModelsService.onDidChangeLanguageModels (fires per modelId change)
 * and reconciles the vendor → IModelProvider registrations on every change.
 */
export class LanguageModelsToAgentOSBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.agentStudio.languageModelsBridge';

	/** vendor → { provider, disposable returned by registerModelProvider } */
	private readonly _registered = new Map<string, { provider: LanguageModelVendorProvider; registration: IDisposable }>();

	/** Debounce reconciliation — onDidChangeLanguageModels can fire many times during startup. */
	private readonly _pendingReconcile = this._register(new MutableDisposable());

	constructor(
		@ILanguageModelsService private readonly _lmService: ILanguageModelsService,
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		this._register(this._lmService.onDidChangeLanguageModels(() => this._scheduleReconcile()));
		this._register(this._lmService.onDidChangeLanguageModelVendors(() => this._scheduleReconcile()));

		// Initial pass — covers any provider registered before this contribution started.
		this._scheduleReconcile();

		this._register(toDisposable(() => {
			for (const { registration, provider } of this._registered.values()) {
				registration.dispose();
				provider.dispose();
			}
			this._registered.clear();
		}));
	}

	private _scheduleReconcile(): void {
		const handle = setTimeout(() => this._reconcile(), 0);
		this._pendingReconcile.value = toDisposable(() => clearTimeout(handle));
	}

	private _reconcile(): void {
		// Vendors come in two flavors and we must accept both:
		//   (a) declared via the `contributes.languageModelChatProviders` extension point — they show up
		//       in `getVendors()` immediately on extension scan, even before the extension has activated;
		//   (b) discovered via `_modelCache` — only populated AFTER `provideLanguageModelChatInformation`
		//       has been resolved at least once by `_resolveAllLanguageModels`.
		// Earlier we only used (b), which meant a freshly-installed provider that had not yet been
		// queried (e.g. the chat box never opened a model picker) would be invisible to the picker.
		// We now seed the live set with (a) and additionally pull in any vendors already in (b).
		const liveVendors = new Set<string>();
		for (const v of this._lmService.getVendors()) {
			if (v.vendor) {
				liveVendors.add(v.vendor);
			}
		}
		for (const id of this._lmService.getLanguageModelIds()) {
			const meta = this._lmService.lookupLanguageModel(id);
			if (meta?.vendor) {
				liveVendors.add(meta.vendor);
			}
		}

		// 1. Remove vendors that disappeared.
		for (const [vendor, entry] of Array.from(this._registered.entries())) {
			if (!liveVendors.has(vendor)) {
				this._logService.trace(`[LMBridge] Vendor disappeared, unregistering: ${vendor}`);
				entry.registration.dispose();
				entry.provider.dispose();
				this._registered.delete(vendor);
			}
		}

		// 2. Add vendors that appeared.
		//     Filter out vendors that should not appear in the model selector
		//     (e.g. 'copilotcli' is a session type, not a model provider).
		const excludedVendors = new Set(['copilotcli']);
		for (const vendor of liveVendors) {
			if (excludedVendors.has(vendor)) {
				this._logService.info(`[LMBridge] Skipping excluded vendor: ${vendor}`);
				continue;
			}
			if (this._registered.has(vendor)) {
				// Existing — just notify model list may have changed.
				this._registered.get(vendor)!.provider.notifyModelsChanged();
				continue;
			}
			const provider = new LanguageModelVendorProvider(vendor, this._lmService, this._logService, this._environmentService, this._configurationService, this._fileService, this._commandService);
			const registration = this._agentOS.registerModelProvider(provider);
			this._registered.set(vendor, { provider, registration });
			this._logService.info(`[LMBridge] Registered vendor as IModelProvider: ${vendor} (id=${provider.id})`);

			// Kick off a non-blocking resolve so the vendor's models populate the LM cache.
			// Without this, a vendor declared via `contributes.languageModelChatProviders` would
			// stay model-less until the user (or some other code path) calls selectLanguageModels.
			this._lmService.selectLanguageModels({ vendor }).then(ids => {
				this._logService.trace(`[LMBridge] Resolved ${ids.length} model(s) for vendor=${vendor}`);
				// _modelCache is now populated; _onLanguageModelChange will fire from inside
				// _resolveAllLanguageModels and our onDidChangeLanguageModels listener will
				// drive notifyModelsChanged for us — but fire one explicitly as a safety net.
				this._registered.get(vendor)?.provider.notifyModelsChanged();
			}).catch(err => {
				this._logService.warn(`[LMBridge] Initial model resolve failed for vendor=${vendor}: ${err}`);
			});
		}
	}
}
