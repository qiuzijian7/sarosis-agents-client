/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * piLoop 对拍贡献点（2026-09-20）—— 安装 `window.__SAROSIS_PI_RUN(prompt)` 全局入口。
 *
 * 设计（`doc/agentloop-pi-core-redesign.md` §5 的"现场对拍"前置件）：
 *   · **独立 contribution**，不动 `agentStudio.contribution.ts`（热点文件，正被并发会话重构）；
 *   · `WorkbenchPhase.AfterRestored`（启动后再装，不阻塞启动）；
 *   · **只装一个全局函数**：不写会话、不落盘、不改任何既有行为 —— 直到你显式调用它；
 *   · 用 piLoop 内核 + 本仓 `IModelProvider`（当前激活的模型选择）+ 只读工具（`file_read`/`file_exists`）。
 *
 * 用法（重启后，devtools / CDP `Runtime.evaluate`）：
 *   await __SAROSIS_PI_RUN('帮我读 package.json 的前 20 行并总结')
 * 再把同一句发进聊天框（legacy 路径）⇒ 比对两份输出（deltas / 工具序列 / 文本 / 轮数）。
 */
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IAgentOSService } from '../common/agentOS.js';
import { installPiLoopDualRunGlobal } from './piLoop/hostBridge.js';

export class PiLoopDualRunContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'agentStudio.piLoopDualRun';

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._install();
	}

	private _install(): void {
		const log = (msg: string) => this._logService.info(msg);
		try {
			// ⚠ IAgentOSService 必须**可选解析**（2026-09-20 实证）：agents 窗口布局
			// （`agentLayout.desktop.main.ts`）刻意不引 `sessions.common.main.js` ——
			// 若该服务未注册而此处构造注入，整个 workbench 启动会被 DI 异常打爆。
			// 本仓 `ServicesAccessor.get` 无 'optional' 形参（收窄过的签名）⇒ try/catch 兜底。
			const agentOS = this._instantiationService.invokeFunction(accessor => {
				try { return accessor.get(IAgentOSService); } catch { return undefined; }
			});
			if (!agentOS) {
				log('[PiDualRun] IAgentOSService 不可用（本窗口未加载 agentStudio）⇒ __SAROSIS_PI_RUN 未安装');
				return;
			}
			const selection = agentOS.getActiveModelSelection();
			const providerId = selection?.providerId;
			const modelId = selection?.modelId;
			const provider = providerId
				? agentOS.getModelProviders().find(p => p.id === providerId)
				: undefined;
			if (!provider || !modelId) {
				log(`[PiDualRun] 暂无激活的模型选择（providerId=${providerId ?? '?'} modelId=${modelId ?? '?'}）⇒ __SAROSIS_PI_RUN 未安装（选定模型后重启即装）`);
				return;
			}
			installPiLoopDualRunGlobal({ provider, modelId, fileService: this._fileService, log });
		} catch (err) {
			// 对拍入口失败绝不能影响主功能
			this._logService.warn(`[PiDualRun] 安装失败（不影响主功能）：${(err as Error)?.message ?? String(err)}`);
		}
	}
}

registerWorkbenchContribution2(PiLoopDualRunContribution.ID, PiLoopDualRunContribution, WorkbenchPhase.AfterRestored);
