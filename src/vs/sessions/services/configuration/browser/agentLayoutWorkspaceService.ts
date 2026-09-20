/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from '../../../../base/common/map.js';
import { ConfigurationModel } from '../../../../platform/configuration/common/configurationModels.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAnyWorkspaceIdentifier } from '../../../../platform/workspace/common/workspace.js';
import { WorkspaceService } from '../../../../workbench/services/configuration/browser/configurationService.js';
import { Configuration } from '../../../../workbench/services/configuration/common/configurationModels.js';
// ★ 2026-09-16：切换工作区「卡住」诊断（阶段标记 + 看门狗）。
import { wsDiagLog, wsStage } from '../../../contrib/agentStudio/browser/wsSwitchDiag.js';

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
		// ⚠ 这套**每次**都要跑（否则第一次之后的卡住没有记录）。
		// （原「zenModeDiag」那套临时诊断已于 2026-09-20 移除 ✗ —— 它只在首次初始化输出，
		//   排查 zenMode 属性缺失的使命已完成，留着只会淹日志 ✓）
		wsStage('config: WorkspaceService.initialize（原地换工作区，重算配置模型）');
		const tInit = Date.now();
		await super.initialize(arg);
		wsDiagLog(this._diagnosticLogService, `configurationService.initialize 完成（${Date.now() - tInit}ms）`);

		// ★ 2026-09-20：原「zenModeDiag」临时诊断已移除 ✗。
		// 它当初用于排查「zenMode.* 属性不在配置注册表里」✓，使命已完成；
		// 而 `initialize()` 现在会在**每次切换 Agent Studio 工作区**时被重新调用
		// （`sidebarPart._enterWorkspaceFile()` 走 `configurationService.initialize()` 原地换
		// 工作区），留着只会让日志随每次切换被灌一遍 ✗。
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
