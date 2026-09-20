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
// ★ 2026-09-20：缓存必须存**应用级存储** ✓ —— 配置服务只接受**已注册**的键 ✗
//（用未注册的键会弹：「Unable to write to User Settings because
//  sessions.agentStudio.provider.lastModelsUpdate is not a registered configuration」✗）
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
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
	private readonly _storageService: IStorageService;
	private _providerResolver: (() => IProviderHint[]) | undefined;
	private _scanInFlight: Promise<void> | null = null;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
		@IMainProcessService mainProcessService: IMainProcessService,
		// ★ 2026-09-20：缓存落点从「配置服务」改为「应用级存储」✓（见 _writeCache 注释 ✓）
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._configurationService = configurationService;
		this._logService = logService;
		this._mainProcessService = mainProcessService;
		this._storageService = storageService;
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
		// ★★★ 2026-09-20：**不可变更新** ✓ —— 原写法 `customProviders[idx] = {...}` ✗
		// 在 **dev（未构建）** 形态下会抛：`Cannot assign to read only property 'N' of
		// object '[object Array]'` ✗✓（`getValue()` 返回的值是**深度冻结**的 ✓）
		// ⇒ 异常被 `_doScan` 的 catch 吞掉 ✗ ⇒ 该 provider 的模型列表**永远更新不了** ✓
		//（此修复在 2026-09-18 已做过一次 ✓，被并行会话的覆盖保存冲掉了 ✗ ⇒ 本次重做 ✓）
		const next = customProviders.map((cp, i) => (i === idx ? { ...cp, models: merged } : cp));
		this._configurationService.updateValue(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING, next);
	}

	/**
	 * ★★★ 2026-09-20：缓存改存 **IStorageService**（应用级状态）✓
	 *
	 * 原实现用 `_configurationService.getValue/updateValue(STORAGE_KEY)` ✗ ——
	 * 而配置服务**只接受已在 `configurationRegistry` 注册过的键** ✗ ⇒ 写入时报
	 * 「Unable to write to User Settings because sessions.agentStudio.provider.lastModelsUpdate
	 *   is not a registered configuration」✗✓（用户可见弹窗 ✓）；
	 * 且 `getValue` 永远拿不到值 ✗ ⇒ **1 小时 TTL 从未生效** ✗ ⇒ 每次触发都重拉所有 provider ✓。
	 * 缓存本来就不是"用户设置" ✗ ⇒ 正确的落点是**应用级存储** ✓。
	 */
	private _readCache(): Record<string, IProviderModelsSnapshot> {
		try {
			const raw = this._storageService.get(STORAGE_KEY, StorageScope.APPLICATION);
			// 存储层可能回字符串（不同后端/旧写入）⇒ 两种形态都兼容 ✓
			if (typeof raw === 'string') { return raw ? JSON.parse(raw) : {}; }
			return (raw as Record<string, IProviderModelsSnapshot> | undefined) ?? {};
		} catch {
			return {};
		}
	}

	private _writeCache(cache: Record<string, IProviderModelsSnapshot>): void {
		try {
			this._storageService.store(STORAGE_KEY, JSON.stringify(cache), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch {
			// 存储不可用时忽略：缓存只是优化 ✓ 丢了下次重拉 ✓
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