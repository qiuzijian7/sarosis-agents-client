/*---------------------------------------------------------------------------------------------
 *  modelsDevCatalog — 仿 opencode 的 models.dev 集成
 *
 *  opencode 数据源不是 models.dev 直连，而是它自托管的镜像：
 *    https://models.opencode.ai/api.json  （整份目录，单次拉取）
 *
 *  本模块：
 *  - 通过主进程 IPC（insecure，绕过公司代理 MITM 证书拦截）拉取整份 api.json
 *  - 内存缓存（1 小时 TTL），避免逐模型重复请求
 *  - 提供按模型 id / name 的本地查表（支持 "provider/model" 前缀）
 *  - 把 models.dev 实际提供的字段映射到 IModelItemConfig
 *
 *  注意：models.dev 目录只提供有限字段（布尔能力标志 + Token 上限 + 成本 + 模态），
 *  并不提供 temperature / topP / topK / repeatPenalty 数值、厂商名、描述等。
 *  那些字段由用户手填。
 *--------------------------------------------------------------------------------------------*/

import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from '../common/llmBridge.js';
import type { IModelItemConfig } from '../common/providers.js';

/** models.dev 单模型（仅包含我们使用到的字段） */
export interface IModelsDevModel {
	id: string;
	name?: string;
	family?: string;
	release_date?: string;
	attachment?: boolean;
	reasoning?: boolean;
	temperature?: boolean;
	tool_call?: boolean;
	limit?: { context?: number; input?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
	cost?: unknown;
	status?: string;
}

export interface IModelsDevProvider {
	id: string;
	name: string;
	env?: string[];
	npm?: string;
	api?: string;
	models: Record<string, IModelsDevModel>;
}

export type IModelsDevCatalog = Record<string, IModelsDevProvider>;

const CATALOG_URL = 'https://models.opencode.ai/api.json';
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 小时

interface ICachedCatalog {
	data: IModelsDevCatalog;
	fetchedAt: number;
}

let _cache: ICachedCatalog | null = null;

/**
 * 拉取（或返回缓存的）整份 models.dev 目录。
 * 失败抛出错误，由调用方处理。
 */
export async function fetchModelsDevCatalog(mainProcessService: IMainProcessService): Promise<IModelsDevCatalog> {
	const now = Date.now();
	if (_cache && now - _cache.fetchedAt < CATALOG_TTL_MS) {
		return _cache.data;
	}
	const channel = mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
	const result = await channel.call<IHttpRequestResult>('httpRequest', {
		url: CATALOG_URL,
		method: 'GET',
		headers: { 'Accept': 'application/json' },
		insecure: true, // 公司代理 MITM 证书
	});
	if (!result.ok) {
		throw new Error(`models.dev 目录拉取失败 (${result.status}) ${result.statusText}`);
	}
	const data = JSON.parse(result.body) as IModelsDevCatalog;
	_cache = { data, fetchedAt: now };
	return data;
}

/** 强制失效缓存（供"刷新目录"使用） */
export function invalidateModelsDevCache(): void {
	_cache = null;
}

interface ILookupHit {
	providerName: string;
	model: IModelsDevModel;
}

function _norm(s: string): string {
	return s.toLowerCase().trim();
}

function _stripPrefix(s: string): string {
	const i = s.indexOf('/');
	return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 在目录中按模型 id / name 查表。
 * 支持 "provider/model" 前缀与大小写不敏感匹配。
 */
export function lookupModelsDev(catalog: IModelsDevCatalog, modelId: string): ILookupHit | null {
	const queries = [
		_norm(modelId),
		_norm(_stripPrefix(modelId)),
	];
	for (const provider of Object.values(catalog)) {
		for (const model of Object.values(provider.models)) {
			const candidates = [
				_norm(model.id),
				_norm(_stripPrefix(model.id)),
				model.name ? _norm(model.name) : '',
			];
			if (candidates.some(c => c && queries.some(q => q === c))) {
				return { providerName: provider.name, model };
			}
		}
	}
	return null;
}

/**
 * 把 models.dev 模型映射到 IModelItemConfig。
 * 仅填充 models.dev 实际提供的字段；其余保持未定义（用户手填）。
 */
export function mapModelsDevToConfig(dev: IModelsDevModel, providerName: string, fallbackId: string): IModelItemConfig {
	const imageInput = !!dev.modalities?.input?.includes('image');
	return {
		id: fallbackId,
		name: dev.name || fallbackId,
		vendor: providerName || '',
		maxOutputTokens: dev.limit?.output ?? undefined,
		maxInputTokens: dev.limit?.input ?? undefined,
		maxContextSize: dev.limit?.context ?? undefined,
		supportsToolCall: !!dev.tool_call,
		supportsImages: imageInput,
		supportsImageParams: imageInput,
		supportsReasoning: !!dev.reasoning,
		// temperature 是能力布尔，非数值；此处不覆盖用户设置
	};
}
