/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Image Gen Tools — `image_generate` 的真实实现（2026-09-10）。
 *
 * 背景：`image_generate` 一直存在于 bundled-tools 定义库（category `image_gen`），
 * 但**没有真实 handler** → 被 `registerBundledTools` 注册为 stub（`isStub: true`，
 * `listTools` 会跳过）→ LLM 根本看不到它，聊天框无法直接生成图片。
 *
 * 本模块把它实现为真实工具：prompt → `provider.generateImage()` → 返回 image
 * 内容项（base64）→ 聊天框按工具结果渲染图片。
 *
 * 模型选择优先级：
 *   ① 调用参数 `provider_id` / `model_id`（LLM 显式指定）
 *   ② 当前 agent 配置（`.agent.md` 的 `imageProviderId` / `imageModel`）——
 *      即 agent 设置页「图片生成模型」与聊天框「图片模型」选择器写入的同一份配置
 *   ③ 自动：第一个声明 `supportsImageGen` 模型的 provider
 */

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { IAgentOSService } from '../../../common/agentOS.js';
import type { IAgentStudioService } from '../../../../../common/agentStudioService.js';
import type { IModelProvider } from '../../../common/providers.js';
import type { IMediaBackend } from '../../../common/mediaStoreChannel.js';
import { AGENT_STUDIO_IMAGE_GEN_PROVIDER, AGENT_STUDIO_IMAGE_GEN_MODEL } from '../../../common/constants.js';

export interface ImageGenToolContext {
	register(definition: { definition: any; handler: any }): void;
	agentOS: IAgentOSService;
	studioService: IAgentStudioService;
	logService: ILogService;
	/** 用户级配置：图片模型的全局默认（agent 配置缺失时的回退，见 constants 注释）。 */
	configurationService?: IConfigurationService;
	/**
	 * 媒体资产库后端（renderer → 主进程 IPC）。
	 *
	 * 生成结果**必须落盘**而非把 base64 塞进工具结果字符串：tool_result 的 content
	 * 会随对话进入 LLM 上下文，一张 1MP PNG 的 base64 ≈ 1–2MB，直接爆掉上下文。
	 * 落盘后结果里只放 `saros-media://<assetId>` 短引用（UI 侧据此取图渲染）。
	 */
	mediaBackend?: IMediaBackend;
}

/**
 * 规整图片载荷：provider 可能返回 data URL（`data:image/png;base64,xxx`）
 * 或裸 base64。工具结果内容项要求 `data` 为纯 base64 + 独立 `mimeType`。
 */
function normalizeImagePayload(b64: string): { data: string; mimeType: string } {
	const m = /^data:([^;]+);base64,(.*)$/s.exec(b64);
	if (m) { return { mimeType: m[1], data: m[2] }; }
	return { mimeType: 'image/png', data: b64 };
}

export function registerImageGenTools(ctx: ImageGenToolContext): void {
	ctx.register({
		definition: {
			name: 'image_generate',
			description: 'Generate an image from a text prompt using the configured image generation model. ' +
				'The generated image is shown inline in the chat. ' +
				'Model selection: explicit provider_id/model_id > the current agent\'s configured image model > auto (first provider supporting image generation).',
			inputSchema: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: 'Image generation prompt' },
					negative_prompt: { type: 'string', description: 'What to avoid in the generated image' },
					width: { type: 'number', description: 'Image width in pixels (default: 1024)' },
					height: { type: 'number', description: 'Image height in pixels (default: 1024)' },
					num_images: { type: 'number', description: 'Number of images to generate (default: 1)' },
					image_url: { type: 'string', description: 'Reference image URL for image-to-image generation (optional)' },
					provider_id: { type: 'string', description: 'Optional explicit image provider id (overrides agent config)' },
					model_id: { type: 'string', description: 'Optional explicit image model id (overrides agent config)' },
				},
				required: ['prompt'],
			},
			category: 'image_gen',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, _signal?: AbortSignal, agentId?: string) => {
			const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
			if (!prompt) {
				return [{ type: 'text', text: 'image_generate error: prompt is required.' }];
			}

			// ── 模型选择 ①/②/③：显式参数 > agent 配置 > 用户级全局配置 ──
			let providerId = typeof args.provider_id === 'string' ? args.provider_id : undefined;
			let modelId = typeof args.model_id === 'string' ? args.model_id : undefined;

			if ((!providerId || !modelId) && agentId) {
				try {
					const agent = await ctx.studioService.getAgent(agentId);
					if (!providerId && agent?.imageProviderId) { providerId = agent.imageProviderId; }
					if (!modelId && agent?.imageModel) { modelId = agent.imageModel; }
				} catch { /* 读取失败继续下一级 */ }
			}

			// ③ 用户级全局配置（2026-09-10）：**内置 agent 只读**时 agent 配置永远为空，
			// 用户在聊天框/设置页的选择只能落到这里，否则会掉进下面的自动路由 →
			// 取 customProviders 里第一个 supportsImageGen 的 provider（实测 grnexus，
			// 其网关不开放 Images API → 404）。日志 1789050110889 即此现象。
			if ((!providerId || !modelId) && ctx.configurationService) {
				try {
					const gProvider = ctx.configurationService.getValue<string>(AGENT_STUDIO_IMAGE_GEN_PROVIDER);
					const gModel = ctx.configurationService.getValue<string>(AGENT_STUDIO_IMAGE_GEN_MODEL);
					if (!providerId && gProvider) { providerId = gProvider; }
					if (!modelId && gModel) { modelId = gModel; }
					if (gProvider || gModel) {
						ctx.logService.info(`[image_generate] using user-level image model default: provider=${gProvider ?? '(none)'} model=${gModel ?? '(none)'}`);
					}
				} catch { /* 读取失败继续自动路由 */ }
			}

			// ── 模型选择 ③：自动路由 ──
			const providers = ctx.agentOS.getModelProviders();
			let provider: IModelProvider | undefined = providerId
				? providers.find(p => p.id === providerId)
				: undefined;

			if (!provider) {
				for (const p of providers) {
					if (typeof p.generateImage !== 'function') { continue; }
					const models = await p.listModels().catch(() => []);
					const imgModel = models.find(m => m.supportsImageGen);
					if (imgModel) {
						provider = p;
						if (!modelId) { modelId = imgModel.id; }
						break;
					}
				}
			}
			if (!provider || typeof provider.generateImage !== 'function') {
				return [{
					type: 'text',
					text: 'image_generate error: no image generation provider available. ' +
						'Configure an image model in the agent settings («图片生成模型») or the chat image-model selector.',
				}];
			}
			if (!modelId) {
				const models = await provider.listModels().catch(() => []);
				modelId = models.find(m => m.supportsImageGen)?.id;
			}
			if (!modelId) {
				return [{ type: 'text', text: `image_generate error: provider "${provider.id}" exposes no image generation model.` }];
			}

			// ── 生成 ──
			try {
				ctx.logService.info(
					`[image_generate] provider=${provider.id} model=${modelId} ` +
					`prompt.len=${prompt.length} agentId=${agentId ?? '(none)'}`
				);
				const result = await provider.generateImage({
					modelId,
					prompt,
					negativePrompt: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
					width: typeof args.width === 'number' ? args.width : undefined,
					height: typeof args.height === 'number' ? args.height : undefined,
					numImages: typeof args.num_images === 'number' ? args.num_images : undefined,
					imageInput: typeof args.image_url === 'string' ? args.image_url : undefined,
				});

				const items: Array<Record<string, unknown>> = [];
				const refs: string[] = [];
				// ★ 2026-09-25（断点③修复 ✓）：落盘失败的兜底计数 + 原因 —— 内联图会被执行层
				//   `splitToolResultImages` 剥离、单独发给模型（不进 UI 文本 ✓）⇒ 聊天框看不到它 ✗，
				//   文案若只说「已生成 N 张」用户必然困惑 ✗✓ ⇒ 必须明说「聊天框无法显示」✓。
				let unstored = 0;
				let lastStoreErr = '';
				for (const img of result?.images ?? []) {
					let ref: string | undefined;
					if (img.b64 && ctx.mediaBackend) {
						// 落盘到媒体资产库，结果里只留短引用（见 ctx.mediaBackend 注释）
						const norm = normalizeImagePayload(img.b64);
						try {
							const asset = await ctx.mediaBackend.importAsset({
								base64: norm.data,
								ext: norm.mimeType === 'image/jpeg' ? 'jpg' : (norm.mimeType.split('/')[1] || 'png'),
								kind: 'image',
								mime: norm.mimeType,
								provider: `byok:${provider.id}`,
								metaJson: JSON.stringify({ prompt, model: modelId, negativePrompt: args.negative_prompt ?? null }),
							});
							ref = `saros-media://${asset.id}`;
						} catch (e) {
							lastStoreErr = e instanceof Error ? e.message : String(e);
							ctx.logService.warn(`[image_generate] importAsset failed: ${lastStoreErr}`);
						}
					}
					if (!ref && img.b64) {
						// 落盘失败时的兜底：返回 image 内容项（会被剥离发给**模型** ✓ UI 不显示 ✗ ⇒ 文案说清 ✓）
						const norm = normalizeImagePayload(img.b64);
						items.push({ type: 'image', data: norm.data, mimeType: norm.mimeType });
						unstored++;
						continue;
					}
					if (!ref && img.url) { ref = img.url; }
					if (ref) { refs.push(ref); }
				}
				if (refs.length === 0 && items.length === 0) {
					return [{ type: 'text', text: 'image_generate: provider returned no image.' }];
				}
				const lines = refs.map(r => `  - ${r}`).join('\n');
				items.push({
					type: 'text',
					text: `已生成 ${refs.length + unstored} 张图片（provider=${provider.id}, model=${modelId}）。\n` +
						(refs.length > 0 ? `图片引用（聊天框据此渲染）：\n${lines}\n` : '') +
						(unstored > 0
							? `⚠ 其中 ${unstored} 张媒体库存储失败（${lastStoreErr}）：图片已提供给模型，但聊天框无法显示。`
							: ''),
				});
				return items;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.warn(`[image_generate] failed: ${msg}`);
				// ★ 2026-09-10：网关不支持 Images API（如 grnexus 返回 404 +
				// "Images API is not supported for this platform"）时，裸 404 对用户
				// 毫无指导意义——补一句可操作的引导（选别的 provider），LLM 会转述。
				const notSupported = /not supported|images api/i.test(msg) || /\b404\b/.test(msg);
				const hint = notSupported
					? `\n\n提示：provider "${provider.id}" 的网关未开放 Images API（模型本身支持文生图，但该网关没有对应端点）。` +
						`请在 agent 设置页「图片生成模型」或聊天框「图片模型」下拉中改选其他支持文生图的 provider 后重试。`
					: '';
				return [{ type: 'text', text: `image_generate error: ${msg}${hint}` }];
			}
		},
	});
}
