/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from '../../../../base/common/map.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationModel } from '../../../../platform/configuration/common/configurationModels.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { WorkspaceService } from '../../../../workbench/services/configuration/browser/configurationService.js';
import { Configuration } from '../../../../workbench/services/configuration/common/configurationModels.js';
// ★ 2026-09-16：切换工作区「卡住」诊断（阶段标记 + 看门狗）。
import { wsDiagLog, wsStage } from '../../../contrib/agentStudio/browser/wsSwitchDiag.js';

/**
 * 临时诊断标签 —— `scripts/agent-layout-smoke.mjs` 按它从 `renderer.log` 里抓取。
 * 改这个名字要同步改脚本（脚本有 `--tag` 可覆盖）。
 */
const DIAG = '[Saros][zenModeDiag]';

/**
 * [Saros] 标准底座（「IDE 底座 + Agent 布局」）使用的 `WorkspaceService`。
 *
 * 它只做一件事：**把 folder 级配置模型置空** —— 也就是「不读
 * `<folder>/.vscode/settings.json`」。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 *
 * 方案 C 的配置隔离原本住在 sessions 的 `ConfigurationService` 里 —— 那是标准
 * `WorkspaceService` 之外的**一份平行实现**（同目录，注意它对标准模块只有副作用导入），
 * 它随 `SessionsMain` 的服务图一起被换掉。
 *
 * 而「IDE 底座 + Agent 布局」用的是**标准** `DesktopMain`，它会建**标准**
 * `WorkspaceService` ⇒ 隔离会**静默丢失**（那个窗口就会读 `.vscode/settings.json`）。
 *
 * 接法：`AgentLayoutDesktopMain` 覆写 `DesktopMain.createWorkspaceService()` 返回本类实例。
 * 该方法返回的**同一个**对象会被同时注册成 `IWorkspaceContextService` 与
 * `IWorkbenchConfigurationService`，所以一处覆写即同时保住两侧行为。
 *
 * ── 为什么覆写 `createConfiguration` ──────────────────────────────
 *
 * `Configuration` 的两处构造原本硬编码在 `WorkspaceService` 的方法体里，子类拦不到；
 * 已抽成 `protected createConfiguration(...)`（`workspace` 由基类补上）。本类只把
 * `folders` 换成空 `ResourceMap`：读路径上没有 folder 模型，`<folder>/.vscode/settings.json`
 * 就无从进入配置合并。
 *
 * ── 尚未承接的部分（有意，见 memory）──────────────────────────────
 *
 * ① `agentsWindow` 的**默认值覆写**（`SessionsDefaultConfiguration`）—— 需要 `WorkspaceService`
 *    再开一个 `createDefaultConfiguration` 接缝，尚未做；这是 UI 默认值差异，不是隔离。
 * ② 写侧加固（`updateValue` 对 `WORKSPACE` / `WORKSPACE_FOLDER` 抛错、`agentsWindowReadOnlyKeys`
 *    只读）—— 尚未做。用户定的规则是**读**，故先落读路径。
 */
export class AgentLayoutWorkspaceService extends WorkspaceService {

	/** zenMode 临时诊断是否已输出过（`initialize()` 可被重复调用，见该方法内说明）。 */
	private _zenModeDiagDone = false;

	protected override createConfiguration(
		defaults: ConfigurationModel,
		policy: ConfigurationModel,
		application: ConfigurationModel,
		localUser: ConfigurationModel,
		remoteUser: ConfigurationModel,
		workspaceConfiguration: ConfigurationModel,
		folders: ResourceMap<ConfigurationModel>,
		memoryConfiguration: ConfigurationModel,
		memoryConfigurationByResource: ResourceMap<ConfigurationModel>,
		logService: ILogService
	): Configuration {
		// ★ folder 模型**保留 key、清空内容** —— 两个约束同时满足：
		//
		// 1. 直接传空 `ResourceMap` 会让标准 `WorkspaceService` 的 folder 变更记账炸：
		//    `Configuration.compareAndDeleteFolderConfiguration` 找不到该 folder 的模型
		//    ⇒ 抛 `Unknown folder`（真机验证过）。
		// 2. 保留 key（folder 仍登记在册）但模型置空 ⇒ 记账正常，而
		//    `<folder>/.vscode/settings.json` 的内容**读不进来** —— 隔离与记账两全。
		const emptiedFolders = new ResourceMap<ConfigurationModel>();
		for (const [uri] of folders) {
			emptiedFolders.set(uri, ConfigurationModel.createEmptyModel(logService));
		}

		return super.createConfiguration(
			defaults,
			policy,
			application,
			localUser,
			remoteUser,
			workspaceConfiguration,
			emptiedFolders,
			memoryConfiguration,
			memoryConfigurationByResource,
			logService
		);
	}

	/**
	 * ★ [Saros] **临时诊断** —— 定位 `zenMode` 默认值读不到那个 ERR，定位完即删。
	 *
	 * 症状：`Layout.restoreParts()` 里
	 * `getZenModeConfiguration(this.configurationService).restore`（`layout.ts:1159`）
	 * 抛 `Cannot read properties of undefined (reading 'restore')`
	 * ⇒ `restoreParts()` 中断，其后的 zen mode 恢复 / 编辑器居中 /
	 * `Promises.settled(layoutReadyPromises)` 收尾全被跳过。
	 *
	 * 已排除的假设：① 放开 `layoutActions.js` 无效（它不是 `zenMode` 配置的注册处）；
	 * ② 本类的 `createConfiguration()` **原样透传 `defaults`**，没吃默认值。
	 * `zenMode` 配置的注册处在 `workbench/browser/workbench.zenMode.contribution.ts`
	 * （`registerConfiguration({ id: 'zenMode' })`），由 `workbench.common.main.ts:12` 引入。
	 *
	 * 四条输出用来区分两种根因：
	 * - ① 为空 ⇒ 该窗口**根本没注册** `zenMode`（贡献没被求值）；
	 * - ① 有、② 有值（`false`）、③ 为 `undefined` ⇒ **节点型**配置的聚合问题；
	 * - ①②③ 全空 ⇒ 默认值模型整体没进来。
	 *
	 * 放在 `initialize()` 之后：基类在此完成 `defaultConfiguration.initialize()`
	 * 与 `Configuration` 装配，而 `createWorkspaceService()` 会 `await` 它之后才返回
	 * ⇒ 打印时机**早于** `Workbench.startup()` → `restoreParts()`。
	 */
	override async initialize(arg: IAnyWorkspaceIdentifier): Promise<void> {
		// ★ 2026-09-16 诊断（用户报「每次切换工作区 app 就卡住」）：本方法在**每次**原地换工作区时
		// 被重新调用（见下方说明），而 `super.initialize()` 里要**整套重算配置模型**并
		// `fire(onDidChangeWorkspaceFolders)` ⇒ 它是「切换卡住」的头号嫌疑。
		// 打阶段标记（主线程被阻塞时日志写不出去，看门狗会**事后**补报该标记）+ 耗时。
		// ⚠ 与下方 zenModeDiag 不同：那套只跑首次，这套**每次**都要跑（否则第一次之后的卡住没有记录）。
		wsStage('config: WorkspaceService.initialize（原地换工作区，重算配置模型）');
		const tInit = Date.now();
		await super.initialize(arg);
		wsDiagLog(this._diagnosticLogService, `configurationService.initialize 完成（${Date.now() - tInit}ms）`);

		// ★ [Saros] 该诊断只在**首次**初始化时跑。
		//
		// 2026-09-15：`initialize()` 现在会在**每次切换 Agent Studio 工作区**时被重新调用
		// （`sidebarPart._enterWorkspaceFile()` 走 `configurationService.initialize()` 原地换
		// 工作区，以拿到 `.code-workspace` 的 settings）。若不守卫，下面 10 行诊断会随每次
		// 切换重复刷进 renderer.log，既淹没有效日志也让诊断本身失真（看的是"第一次"的状态）。
		if (this._zenModeDiagDone) {
			return;
		}
		this._zenModeDiagDone = true;

		try {
			const log = this._diagnosticLogService;
			const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
			const properties = registry.getConfigurationProperties();
			const keys = Array.isArray(properties)
				? properties.map(property => (property as { key?: string }).key ?? '')
				: Object.keys(properties as object);

			// ★ ① 必须带**总数与前几个样本**：只打 `filter(zenMode*)` 的话，
			// 「注册表为空 / 我的提取写错 / 注册表有几千条但真没 zenMode」三者都输出 `[]`，
			// 无法区分（上一版就是这么漏掉的）。
			log.info(`${DIAG} ① 注册表属性总数 = ${keys.length} | 前 3 个 = ${JSON.stringify(keys.slice(0, 3))}`);
			log.info(`${DIAG} ①b zenMode* = ${JSON.stringify(keys.filter(key => key.startsWith('zenMode')))}`);
			log.info(`${DIAG} ② getValue("zenMode.fullScreen") = ${JSON.stringify(this.getValue('zenMode.fullScreen'))}`);
			log.info(`${DIAG} ③ getValue("zenMode") = ${JSON.stringify(this.getValue('zenMode'))}`);
			// ④ 只打**形状**，不打整个 JSON —— 默认值模型巨大，上一版被截断到看不见 zenMode。
			const inspected = this.inspect<unknown>('zenMode') as { defaultConfiguration?: { contents?: Record<string, Record<string, unknown>> } };
			const contents = inspected?.defaultConfiguration?.contents ?? {};
			log.info(`${DIAG} ④ defaultConfiguration.contents 语言层 = ${JSON.stringify(Object.keys(contents))} | 各层设置数 = ${JSON.stringify(Object.keys(contents).map(layer => [layer, Object.keys(contents[layer] ?? {}).length]))}`);
			// ⑤ 叶子键的 inspect —— 直接回答「默认值模型里到底有没有 zenMode.fullScreen」。
			log.info(`${DIAG} ⑤ inspect("zenMode.fullScreen") = ${JSON.stringify(this.inspect('zenMode.fullScreen'))}`);

			// ★★ ⑥ / ⑦ 是**决定性判别**：①b 已经证明属性不在注册表里，现在要区分两种原因：
			//   - ⑥「节点不存在」⇒ 那个贡献模块**根本没被求值**（与静态 import 链矛盾，需另查）；
			//   - ⑥「节点存在」但属性键为空 ⇒ 属性在注册时被
			//     `configurationRegistry.ts:715` 的 `validateProperty` **静默删掉**
			//     （`delete properties[key]; continue;`）—— 它只打 console 警告、
			//     **不落 `renderer.log`**，所以冒烟脚本看不见这类失败。
			const nodes = registry.getConfigurations();
			const zenModeNode = nodes.find(node => node.id === 'zenMode');
			log.info(`${DIAG} ⑥ 配置节点总数 = ${nodes.length} | zenMode 节点 = ${zenModeNode ? '存在' : '不存在'}`);
			log.info(`${DIAG} ⑥b zenMode 节点里的属性键 = ${JSON.stringify(zenModeNode ? Object.keys(zenModeNode.properties ?? {}) : [])}`);
			const excluded = (registry as unknown as { getExcludedConfigurationProperties?: () => Record<string, unknown> }).getExcludedConfigurationProperties?.();
			log.info(`${DIAG} ⑦ excluded 属性里的 zenMode* = ${JSON.stringify(Object.keys(excluded ?? {}).filter(key => key.startsWith('zenMode')))}`);
		} catch (error) {
			this._diagnosticLogService.info(`${DIAG} 诊断本身抛错 = ${error}`);
		}
	}

	/**
	 * ★ 临时诊断用：基类的 `logService` 是 `private`（`configurationService.ts:126`），
	 * 子类在**类型**上取不到。这里用**运行时访问**拿它 —— 唯一目的是让诊断走
	 * `ILogService` 从而**落到 `renderer.log`**。
	 *
	 * 为什么必须这样：裸 `console.log` **只进 DevTools，不落 `renderer.log`**
	 * （实测：`scripts/agent-layout-smoke.mjs` 抓不到任何 `console.log` 输出）。
	 * 自动抓日志的脚本依赖文件，所以诊断必须走日志服务。
	 */
	private get _diagnosticLogService(): ILogService {
		return (this as unknown as { logService: ILogService }).logService;
	}
}
