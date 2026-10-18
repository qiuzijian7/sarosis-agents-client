/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VsSaros 已配置的模型 provider → dsh 的同步器（聊天框模型选择器接入 codebuddy /
 * lightai / openrouter 等，dsh 插件形式：桥插件 `providers.sync` 写 llm-pi-ai 配置）。
 *
 * 数据源三路：
 *  1. 内置 BYOK（openrouter/nous/gemini/anthropic/main/ollama/custom）：设置项里的
 *     apiKey/baseUrl（身份目录 agentStudio/common/providerCatalog.ts）。
 *  2. 设置页自定义 provider（`sessions.agentStudio.provider.customProviders`，apiKey 内联）。
 *  3. 扩展登录态 provider（codebuddy/lightai）：经扩展暴露的内部命令取 {baseURL, token, models}；
 *     未安装/未登录时返回 undefined，静默跳过（可降级原则）。
 *
 * 模型列表统一从 AgentOS 注册表的 provider 缓存读（`listModels()`，内部有缓存）；
 * 扩展登录态源（第 3 路）取**注册表 `lm:<vendor>` 那份 ∪ 扩展命令那份**（`mergeExtensionModels`），
 * 注册表那份与原生聊天框下拉同源（实时 LM 缓存），命令那份只作补充/兜底；
 * 读不到模型的源不接入（dsh 的 profile 要求非空 models）。
 *
 * 触发：控制桥连上 / 相关设置变化 / 30 秒兜底轮询；内容 hash 一致不推送（防抖 1.5s）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { timeout } from '../../../../base/common/async.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentOSService } from '../../../common/agentStudioOS.js';
import { BUILTIN_PROVIDER_IDENTITIES } from '../../../common/agentStudioProviderCatalog.js';
import { AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING } from '../../../common/agentStudioConstants.js';
import { buildProvidersSyncArgs, IDshModelRef, IDshProviderSource, mergeExtensionModels, providerRouteFor } from '../common/dshProviderSyncPlan.js';
import { validateProvidersSyncArgs } from '../common/dshBridgeProtocol.js';
import { IDshHarnessService } from './dshHarnessService.js';

/** 扩展登录态 provider 的内部配置导出命令（扩展侧未实现/未登录 → undefined → 跳过）。
 * 注意：lightai 不在列——它是任务式媒体生成 provider（3D/图像，聊天选中即报错），不是聊天模型。
 *
 * `registryId` 是它在 **AgentOS 注册表**里的 id：VS Code LM 的各 vendor 由
 * `LanguageModelsToAgentOSBridge` 包装注册为 `lm:<vendor>`（languageModelsBridge.ts:273），
 * 所以扩展侧 id 是 `codebuddy`、注册表侧是 `lm:codebuddy` —— **两者不等**。
 * 曾经这里只写 `id`，`_modelsOf(ext.id)` 因此恒查不到（`p.id === 'codebuddy'` 永远 false），
 * 注释里承诺的"注册表兜底"是**死代码**：codebuddy 的模型完全依赖扩展命令的返回，
 * 命令返回空（未登录/接口空）时该源直接消失。用 `registryId` 明确映射后，模型清单与
 * **原生聊天框下拉同源**（同一份 `listModels()`，即 LM 缓存，实时且含新模型）。 */
const EXTENSION_PROVIDER_COMMANDS: readonly { command: string; id: string; name: string; registryId: string }[] = [
	{ command: '_codebuddy.dshProviderConfig', id: 'codebuddy', name: 'CodeBuddy', registryId: 'lm:codebuddy' },
];

/** 触发重同步的设置键（apiKey/baseUrl 全部身份键 + 自定义 provider 列表 + 扩展端点）。 */
const WATCHED_SETTINGS: readonly string[] = [
	...BUILTIN_PROVIDER_IDENTITIES.flatMap(i => [i.apiKeyConfigKey, i.baseUrlConfigKey]),
	AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING,
	'codebuddy.endpoint',
	'lightai.endpoint',
];

interface ICustomProviderSetting {
	id: string;
	name: string;
	apiKey: string;
	baseUrl: string;
	apiType?: 'openai' | 'anthropic';
	/** 字符串数组（设置 UI 写的形态）或对象数组（高级形态：可声明 reasoning 能力）。 */
	models?: (string | { id: string; name?: string; reasoning?: boolean })[];
}

interface IExtensionProviderConfig {
	baseURL: string;
	token?: string;
	/** 网关要求的额外身份头（如 codebuddy 的 X-IDE-*）。 */
	headers?: Record<string, string>;
	/** 扩展导出的模型清单：`reasoning` 能力位 + 平台推荐档位 `effort`（缺省 = 只用注册表那份）。 */
	models?: IDshModelRef[];
}

export class DshProviderSync extends Disposable {
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _running = false;
	private _again = false;
	private _lastHash = '';
	private _lastDiagHash = '';
	/** "采集偏慢"告警的节流戳（30s 兜底轮询下最多 5 分钟一条）。 */
	private _lastSlowCollectLogAt = 0;

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ICommandService private readonly _commands: ICommandService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register(this._dsh.onDidChangeStatus(s => {
			if (s.bridge === 'connected') {
				this._schedule();
			}
		}));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (WATCHED_SETTINGS.some(k => e.affectsConfiguration(k))) {
				this._schedule();
			}
		}));
		// 兜底：BYOK 模型懒拉取完成、扩展登录态变化都没有全局事件，30 秒轮询补一次（内容没变不推送）。
		const interval = setInterval(() => this._schedule(), 30_000);
		this._register({ dispose: () => clearInterval(interval) });
		this._schedule();
	}

	private _schedule(): void {
		if (this._timer !== undefined) {
			return;
		}
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this._sync();
		}, 1_500);
	}

	private async _sync(): Promise<void> {
		if (this._dsh.status.bridge !== 'connected') {
			return;
		}
		if (this._running) {
			this._again = true;
			return;
		}
		this._running = true;
		// ★ 分段计时（2026-10-15，"首启后模型清单晚 19–33s 才可用"排查）：这段此前是纯黑盒——
		//   `providers synced` 只打结果不打耗时，只能看出"慢"看不出"慢在哪个 provider"。
		//   collect（注册表 `listModels()`，逐 provider 有 8s 超时，见 `_modelsOf`）与 bridge
		//   `providers.sync`（Host 侧写 settings）分开计；collect 慢时再把**逐源耗时**打出来。
		const timings: string[] = [];
		const tCollect = Date.now();
		try {
			const { sources, notes } = await this._collect(timings);
			const collectMs = Date.now() - tCollect;
			// collect 明显偏慢时把**逐源耗时**打出来（每 5 分钟最多一条，30s 兜底轮询下不刷屏 ✓）。
			// ⚠ 必须在"内容没变就早退"**之前**：hash 不变的轮询也可能撞上某个 provider 的 8s 超时
			//   （那才是首启之后还在反复烧后台的元凶），早退掉就永远看不见了。
			//   首启时这条直接回答"模型清单为什么晚 19–33s"（大概率是某两个 provider 各撞了 8s 超时 ✓）。
			if (collectMs > 3_000 && Date.now() - this._lastSlowCollectLogAt > 300_000) {
				this._lastSlowCollectLogAt = Date.now();
				this._log.warn(`[dshHarness] provider 模型清单采集偏慢（collect=${collectMs}ms）：${timings.join(' | ') || '(无计时项)'}——首启期间聊天框模型列表晚于此才可用`);
			}
			// 详细诊断：每个源被跳过/降级的具体原因（独立 hash 防抖，变化时才打；即使 providers
			// 没变也打——这样 codebuddy 这类"一直进不了模型列表"的源在状态变化时能看到具体原因）。
			const diagHash = JSON.stringify(notes);
			if (notes.length && diagHash !== this._lastDiagHash) {
				this._lastDiagHash = diagHash;
				this._log.warn(`[dshHarness] provider 同步诊断（为何有的源没进模型列表）: ${notes.join(' | ')}`);
			}
			// 逐条**预校验**：主进程侧 `validateProvidersSyncArgs` 是**全量拒绝**——只要有一个
			// provider 不合规，整包就报「providersSync: 负载未通过校验」，于是**所有** provider
			// （含 codebuddy 这种登录态源）都进不了模型列表，且日志里只看到一句"负载未通过校验"，
			// 完全看不出是哪个源的问题（实测现场）。
			// 这里用**同一个**校验函数逐条试算（单源负载），把不合规的源单独摘掉并记名：
			// 一个坏源不再拖垮全部，坏源本身也会在诊断日志里点名。
			// 常见不合规：baseURL 只允许 `https://…` 或 `http://127.0.0.1|localhost…`（内网 http 一律拒）、
			// models 必须非空且 ≤200、route 需匹配 `PROVIDER_ROUTE_RE`。
			const accepted: IDshProviderSource[] = [];
			for (const source of sources) {
				if (validateProvidersSyncArgs(buildProvidersSyncArgs([source]))) {
					accepted.push(source);
				} else {
					// 用**路由名**（dsh 侧看到的 `vssaros-<id>`）而不是 VsSaros 侧 id 记名：日志里好对照。
					notes.push(`${providerRouteFor(source.id)}: 单源负载未通过 validateProvidersSyncArgs（见函数注释的常见不合规项），已摘除以保住其余 provider`);
				}
			}
			const args = buildProvidersSyncArgs(accepted);
			const hash = JSON.stringify({ p: args.providers, c: args.credentials.map(c => c.ref) });
			if (hash === this._lastHash) {
				return;
			}
			const tBridge = Date.now();
			const result = await this._dsh.syncProviders(args);
			const bridgeMs = Date.now() - tBridge;
			this._lastHash = hash;
			// 诊断：连同**dsh 侧实际服务**的每条路由模型数、默认模型改写结果一起打。
			// 此前只打路由名，"路由在线但模型为空/被丢"在日志里完全不可见（实测：codebuddy 的
			// 清单看起来同步成功，但选择器条数对不上，只能靠猜）。见 IBridgeProvidersSyncResult 注释。
			const counts = Object.entries(result.modelsOnline ?? {}).map(([route, value]) => `${route}=${Array.isArray(value) ? value.length : value}`);
			const emptyRoutes = Object.entries(result.modelsOnline ?? {})
				.filter(([, value]) => Array.isArray(value) && value.length === 0)
				.map(([route]) => route);
			this._log.info(`[dshHarness] providers synced: ${result.routes.join(', ') || '(none)'}${result.unchanged ? ' (unchanged)' : ''}${args.skipped.length ? `; skipped: ${args.skipped.join(', ')}` : ''}${counts.length ? `; models: ${counts.join(' ')}` : ''}${result.defaultModel ? `; default: ${result.defaultModel}` : ''}; timing: collect=${collectMs}ms bridge=${bridgeMs}ms`);
			if (emptyRoutes.length) {
				this._log.warn(`[dshHarness] 路由在线但模型为空（聊天框选择器里这些路由会没有条目）: ${emptyRoutes.join(', ')}`);
			}
		} catch (e) {
			this._log.warn(`[dshHarness] providers sync failed: ${String((e as Error)?.message ?? e)}（collect 已花 ${Date.now() - tCollect}ms）`);
			// 失败 5 秒后快重试（不等 30s 兜底轮询）：首启早期 Host 尚未组完 profile 时
			// 写 settings 会撞 "profile reload requires the root Include entry"（实测于 first-run），
			// 快重试让首启竞争自愈而不拖到用户感知。
			if (this._timer === undefined) {
				this._timer = setTimeout(() => {
					this._timer = undefined;
					void this._sync();
				}, 5_000);
			}
		} finally {
			this._running = false;
			if (this._again) {
				this._again = false;
				this._schedule();
			}
		}
	}

	/**
	 * 收集三路来源（模型列表缺失的源由 build 侧跳过）。
	 * 返回 sources + notes：notes 记录每个源被跳过/降级的具体原因（诊断日志用，定位"provider 为何没进模型列表"）。
	 */
	private async _collect(timings?: string[]): Promise<{ sources: IDshProviderSource[]; notes: string[] }> {
		const sources: IDshProviderSource[] = [];
		const notes: string[] = [];
		/** 逐源采集计时（首启慢排查用）：只记真正 `await` 了模型清单/命令的那几源。 */
		const timeOf = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
			const t = Date.now();
			const r = await fn();
			timings?.push(`${label}=${Date.now() - t}ms`);
			return r;
		};
		for (const identity of BUILTIN_PROVIDER_IDENTITIES) {
			// 门槛用注册表的认证状态（BYOK provider 自己判定"已配置"：apiKey 或免 key 的本地端点），
			// 不看设置值——避免 schema 默认值被误判成已配置（实测 gemini 默认值与身份目录漂移过）。
			const registryProvider = this._agentOS.getModelProviders().find(p => p.id === identity.id);
			if (!registryProvider || registryProvider.getAuthStatus() !== 'authenticated') {
				continue; // 未配置/未认证是正常状态，不记入诊断
			}
			const apiKey = (this._config.getValue<string>(identity.apiKeyConfigKey) ?? '').trim();
			const baseURL = (this._config.getValue<string>(identity.baseUrlConfigKey) ?? '').trim() || identity.defaultBaseUrl;
			if (!baseURL) {
				notes.push(`${identity.id}: 已认证但无 baseURL`);
				continue;
			}
			const models = await timeOf(identity.id, () => this._modelsOf(identity.id));
			if (!models.length) {
				notes.push(`${identity.id}: 已认证但 models 为空（注册表 listModels 无结果/超时，dsh profile 要求非空）`);
			}
			sources.push({
				id: identity.id,
				displayName: identity.name,
				apiType: identity.id === 'anthropic' ? 'anthropic' : 'openai',
				baseURL,
				credential: apiKey || undefined,
				models,
			});
		}
		const customs = this._config.getValue<ICustomProviderSetting[]>(AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING) ?? [];
		for (const cp of customs) {
			if (!cp?.id || !cp.baseUrl) {
				notes.push(`自定义 provider ${cp?.id ?? '(缺 id)'}: 缺 id 或 baseUrl`);
				continue;
			}
			const models = cp.models?.length
				? cp.models.map(m => typeof m === 'string' ? { id: m } : { id: m.id, name: m.name, reasoning: m.reasoning })
				: await timeOf(cp.id, () => this._modelsOf(cp.id));
			if (!models.length) {
				notes.push(`${cp.id}: models 为空（设置未声明且注册表 listModels 无结果）`);
			}
			sources.push({
				id: cp.id,
				displayName: cp.name || cp.id,
				apiType: cp.apiType,
				baseURL: cp.baseUrl,
				credential: cp.apiKey || undefined,
				models,
			});
		}
		for (const ext of EXTENSION_PROVIDER_COMMANDS) {
			// 区分三种跳过：命令未注册/执行失败（throw）、扩展返回空（未登录）、返回无 baseURL。
			// 原来 `.catch(() => undefined)` 把"命令未注册"和"返回空"混成同一个 undefined，无法定位。
			let cfg: IExtensionProviderConfig | undefined;
			let cmdError: string | undefined;
			try {
				cfg = await timeOf(`${ext.id}.cmd`, () => this._commands.executeCommand<IExtensionProviderConfig | undefined>(ext.command));
			} catch (e) {
				cmdError = String((e as Error)?.message ?? e);
			}
			if (cmdError !== undefined) {
				notes.push(`${ext.id}: 命令 ${ext.command} 未注册或执行失败（${cmdError}）——扩展未安装/版本过旧未实现该命令？`);
				continue;
			}
			if (!cfg) {
				// 产品口径（2026-10-11）：登录态过时/未登录，或平台未返回模型目录时，扩展**故意**返回空
				// ⇒ 这里不接入该 provider，桥侧随即把它的路由从 profile 摘掉（dsh 里不再显示其模型，
				// 也不回落内置 model.json —— 那是平台目录的旧快照）。
				notes.push(`${ext.id}: 命令 ${ext.command} 返回空（未登录/登录态过时，或平台未返回模型目录 ⇒ 按口径不显示其模型）`);
				continue;
			}
			if (!cfg.baseURL) {
				notes.push(`${ext.id}: 扩展返回的配置无 baseURL`);
				continue;
			}
			// 模型清单 = 注册表（`registryId`，与**原生聊天框下拉同源**的实时 LM 缓存）∪ 扩展命令返回。
			// 见 mergeExtensionModels 注释：注册表优先/并集去重、命令侧显式 reasoning 优先。
			// （此前写成 `cfg.models?.length ? cfg.models : this._modelsOf(ext.id)`，而 ext.id='codebuddy'
			//   ≠ 注册表 id 'lm:codebuddy' ⇒ 兜底恒为 [] ⇒ 扩展命令一空该源即消失。）
			const registryModels = await timeOf(`${ext.id}.registry`, () => this._modelsOf(ext.registryId));
			const models = mergeExtensionModels(registryModels, cfg.models);
			if (!models.length) {
				notes.push(`${ext.id}: models 为空（扩展返回 ${cfg.models?.length ?? 0} 个、注册表 ${ext.registryId} ${registryModels.length} 个；dsh profile 要求非空）`);
			}
			sources.push({
				id: ext.id,
				displayName: ext.name,
				baseURL: cfg.baseURL,
				credential: cfg.token || undefined,
				headers: cfg.headers,
				models,
			});
		}
		return { sources, notes };
	}

	/**
	 * 注册表里的 provider 模型（BYOK 内部有 `_models` 缓存；失败/超时给空数组）。
	 *
	 * `providerId` 必须是**注册表 id**：内置身份与注册表 id 同名，而 VS Code LM 的 vendor 是
	 * `lm:<vendor>`（例如扩展侧 `codebuddy` → 注册表 `lm:codebuddy`）。
	 * 同时带上 `reasoning`（`IModelInfo.supportsReasoning`）——原生下拉展示的也是这一位
	 * （`LanguageModelsToAgentOSBridge` 对 LM API 丢失的能力位做启发式反推后写在这里）。
	 */
	private async _modelsOf(providerId: string): Promise<IDshModelRef[]> {
		const provider = this._agentOS.getModelProviders().find(p => p.id === providerId);
		if (!provider) {
			return [];
		}
		try {
			const models = await Promise.race([provider.listModels(), timeout(8_000).then(() => { throw new Error('timeout'); })]);
			return models.map(m => ({
				id: m.id,
				name: m.name !== m.id ? m.name : undefined,
				...(m.supportsReasoning === true ? { reasoning: true } : {}),
			}));
		} catch {
			return [];
		}
	}
}
