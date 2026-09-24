/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 多模态（vision）模型选择 —— **`vision_analyze` 与 `video_analyze` 的单一真源**（2026-09-24）。
 *
 * ## 为什么单独成模块
 *
 * 两年前（2026-09-22）把「多模态的默认模型」定成「知识库专家配置的模型」时，这套
 * 三级选择逻辑只写在 `visionAnalyzeTools` 里。`video_analyze` 需要的**完全是同一套**
 * 语义（否则会出现「看图用 A 模型、看视频用 B 模型」的诡异不一致）。
 * 复制一份必然漂移，故抽到这里共用。
 *
 * ## 优先级（不可随意调整，顺序本身是用户可见语义）
 *
 * ① Vision 辅助模型**显式**配置（设置面板「Vision（图像分析）」）—— 用户显式指定，最高优先；
 * ② **知识库专家配置的模型**（2026-09-22 起的默认）；
 * ③ 自动路由：第一个声明 `supportsImages` 的模型。
 *
 * ⚠ ②必须校验 `supportsImages`：专家可能配的是**纯文本**模型，直接发图会 400
 *   ⇒ 不满足时继续回退到 ③（fail-safe，不会因专家配置而让多模态整体不可用）。
 * ⚠ ①**不校验** `supportsImages`：设置项本身就名为「Vision 辅助模型」（语义即视觉模型），
 *   且用户显式指定优先 —— 保持与原实现一致。
 */

import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { IModelProvider } from '../../../common/providers.js';
import { AGENT_STUDIO_AUX_VISION_PROVIDER, AGENT_STUDIO_AUX_VISION_MODEL } from '../../../common/constants.js';

export interface IVisionModelSource {
	configurationService?: IConfigurationService;
	/** 取当前注册的模型 provider 列表（`IAgentOSService.getModelProviders`）。 */
	getModelProviders: () => readonly IModelProvider[];
	/** 「知识库专家」（`knowledge-base-expert`）当前配置的模型选择（可选）。 */
	getKbExpertModel?: () => { providerId: string; modelId: string } | undefined;
}

export interface ISelectedVisionModel {
	readonly provider: IModelProvider;
	readonly modelId: string;
}

/**
 * 按优先级挑一个可用于多模态的 provider/model；无可用时返回 `undefined`
 * （调用方给「去设置里配一个」的指引，而不是静默失败）。
 */
export async function selectVisionModel(src: IVisionModelSource): Promise<ISelectedVisionModel | undefined> {
	let providerId: string | undefined;
	let modelId: string | undefined;
	if (src.configurationService) {
		try {
			providerId = src.configurationService.getValue<string>(AGENT_STUDIO_AUX_VISION_PROVIDER) || undefined;
			modelId = src.configurationService.getValue<string>(AGENT_STUDIO_AUX_VISION_MODEL) || undefined;
			// 'auto' 是设置项的默认值，表示"跟随自动路由"，不是真实 provider id。
			if (providerId === 'auto') { providerId = undefined; }
		} catch { /* 配置读取失败 → 走自动路由 */ }
	}

	const providers = src.getModelProviders();
	let provider: IModelProvider | undefined = providerId
		? providers.find(p => p.id === providerId)
		: undefined;

	// ② 知识库专家配置的模型（仅当用户**没有**显式指定 Vision provider 时生效）
	if (!providerId && (!provider || !modelId)) {
		try {
			const kb = src.getKbExpertModel?.();
			if (kb?.providerId && kb.modelId) {
				const kbProvider = providers.find(p => p.id === kb.providerId);
				if (kbProvider && typeof kbProvider.chat === 'function') {
					const kbModels = await kbProvider.listModels().catch(() => []);
					if (kbModels.some(m => m.id === kb.modelId && m.supportsImages)) {
						provider = kbProvider;
						modelId = kb.modelId;
					}
				}
			}
		} catch { /* 读取专家配置失败 ⇒ 走自动路由 */ }
	}

	// ③ 自动路由：第一个 supportsImages 的模型
	if (!provider || !modelId) {
		for (const p of providers) {
			if (typeof p.chat !== 'function') { continue; }
			if (providerId && p.id !== providerId) { continue; }
			const models = await p.listModels().catch(() => []);
			const visionModel = models.find(m => m.supportsImages);
			if (visionModel) {
				provider = p;
				modelId = visionModel.id;
				break;
			}
		}
	}

	return provider && modelId ? { provider, modelId } : undefined;
}

/** 无可用模型时的统一文案（两处工具共用，避免措辞漂移导致用户找不到设置项）。 */
export const NO_VISION_MODEL_MESSAGE =
	'no vision-capable model available. Configure one in settings («Vision（图像分析）») '
	+ 'or enable a provider that exposes a model with image input support.';
