/*---------------------------------------------------------------------------------------------
 *  ModelsAutoUpdateService — 仿 opencode models.dev 自动维护机制
 *  启动时对所有已配置 provider（自定义）调用 {baseUrl}/v1/models，
 *  合并到 cp.models，避免手动维护。
 *  - 失败静默，不阻塞启动
 *  - 1 小时 TTL 缓存，避免频繁请求
 *  - 自定义 provider 通过更新 cp.models 触发 reconcile
 *  - 内置 provider 当前仅记录日志（built-in staticModels 硬编码，下次启动再拉）
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from './llmBridge.js';
import { AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING } from './constants.js';
import { buildModelsUrl, type CustomProviderData } from '../browser/views/providerView.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时，仿 opencode
const STORAGE_KEY = 'sessions.agentStudio.provider.lastModelsUpdate';

export const IModelsAutoUpdateService = createDecorator<IModelsAutoUpdateService>('modelsAutoUpdateService');

interface IProviderModelsSnapshot {
	lastFetch: number;
	models: string[];
}

export interface IProviderHint {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiType: 'openai' | 'anthropic';
	isBuiltin: boolean;
}

export interface IModelsAutoUpdateService {
	readonly _serviceBrand: undefined;
	triggerNow(): Promise<void>;
	registerProviderResolver(resolver: () => IProviderHint[]): void;
}

export class ModelsAutoUpdateService extends Disposable implements IModelsAutoUpdateService {

	declare readonly _serviceBrand: undefined;

	private readonly _configurationService: IConfigurationService;
	private readonly _logService: ILogService;
	private readonly _mainProcessService: IMainProcessService;
	private _providerResolver: (() => IProviderHint[]) | undefined;
	private _scanInFlight: Promise<void> | null = null;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this._configurationService = configurationService;
		this._logService = logService;
		this._mainProcessService = mainProcessService;
	}

	registerProviderResolver(resolver: () => IProviderHint[]): void {
		this._providerResolver = resolver;
	}

	async triggerNow(): Promise<void> {
		if (this._scanInFlight) {
			return this._scanInFlight;
		}
		this._scanInFlight = this._doScan().finally(() => {
			this._scanInFlight = null;
		});
		return this._scanInFlight;
	}

	private async _doScan(): Promise<void> {
		if (!this._providerResolver) {
			return;
		}
		const hints = this._providerResolver();
		const now = Date.now();
		const cache = this._readCache();

		for (const hint of hints) {
			try {
				if (!hint.baseUrl) { continue; }
				if (!hint.apiKey && hint.apiType !== 'anthropic') {
					// 没配 apiKey 跳过（避免无谓请求 + 401）
					continue;
				}
				const cached = cache[hint.id];
				if (cached && now - cached.lastFetch < CACHE_TTL_MS) {
					continue; // 1 小时 TTL
				}
				const url = buildModelsUrl(hint.baseUrl);
				const headers: Record<string, string> = { 'Accept': 'application/json' };
				if (hint.apiType === 'anthropic') {
					if (hint.apiKey) { headers['x-api-key'] = hint.apiKey; }
					headers['anthropic-version'] = '2023-06-01';
				} else {
					headers['Authorization'] = `Bearer ${hint.apiKey}`;
				}
				const channel = this._mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
				const result = await channel.call<IHttpRequestResult>('httpRequest', { url, method: 'GET', headers });
				if (!result.ok) { continue; }
				const models = this._parseModels(JSON.parse(result.body));
				if (models.length === 0) { continue; }

				cache[hint.id] = { lastFetch: now, models };
				this._applyToProvider(hint, models);
				this._logService.info(`[ModelsAutoUpdate] ${hint.id}: ${models.length} models`);
			} catch (err: any) {
				this._logService.warn(`[ModelsAutoUpdate] ${hint.id} scan failed: ${err.message || err}`);
			}
		}

		this._writeCache(cache);
	}

	private _applyToProvider(hint: IProviderHint, models: string[]): void {
		if (hint.isBuiltin) {
			// 内置 provider 不写盘，仅触发一次内存更新由 registerModelProvider 拉取
			// （实际目前内置 provider 的 staticModels 是 hard-coded，下次启动再自动拉一次）
			// 这里留给后续 hook：BYOKProviderContribution 监听 onDidChangeModelProviders 时，
			// 如果是 auto-updated 则合并到内存 staticModels。
			return;
		}
		const customProviders = this._configurationService.getValue<CustomProviderData[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) || [];
		const idx = customProviders.findIndex(cp => cp.id === hint.id);
		if (idx === -1) { return; }
		// 合并：保留用户已勾选的，新拉到的加进去
		const existing = new Set(customProviders[idx].models || []);
		const merged = Array.from(new Set([...models, ...existing]));
		customProviders[idx] = { ...customProviders[idx], models: merged };
		this._configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, customProviders);
	}

	private _readCache(): Record<string, IProviderModelsSnapshot> {
		try {
			const raw = this._configurationService.getValue<Record<string, IProviderModelsSnapshot>>(STORAGE_KEY);
			return raw ?? {};
		} catch {
			return {};
		}
	}

	private _writeCache(cache: Record<string, IProviderModelsSnapshot>): void {
		try {
			this._configurationService.updateValue(STORAGE_KEY, cache);
		} catch {
			// 配置不支持该类型，忽略
		}
	}

	private _parseModels(data: any): string[] {
		if (Array.isArray(data?.data)) {
			return data.data.map((m: any) => m.id || m.name).filter((s: unknown): s is string => typeof s === 'string' && !!s);
		}
		if (Array.isArray(data)) {
			return data.map((m: any) => typeof m === 'string' ? m : (m.id || m.name)).filter((s: unknown): s is string => typeof s === 'string' && !!s);
		}
		return [];
	}
}