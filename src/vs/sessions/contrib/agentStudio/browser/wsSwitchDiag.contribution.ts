/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 看门狗贡献（见 `wsSwitchDiag.ts` 的说明）。
 *
 * 与纯诊断逻辑**分开两个文件**：`wsSwitchDiag.ts` 里的纯函数/状态可被单测直接 import，
 * 而本文件在**加载时**就会调 `registerWorkbenchContribution2()`（在 node 测试环境里没有那个
 * registry）⇒ 混在一起会让单测连模块都 import 不进来。
 *
 * 注册相位用 `BlockStartup`：切换工作区可能发生在窗口起来后的任何时刻，看门狗必须**早于**
 * 任何一次切换就位（否则第一次切换的阻塞无从记录）。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { WS_BLOCK_REPORT_MS, WS_DIAG_TAG, WS_HEARTBEAT_MS, startMainThreadWatchdog, wsDiagLog } from './wsSwitchDiag.js';

class WsSwitchDiagContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wsSwitchDiag';

	constructor(@ILogService logService: ILogService) {
		super();
		// 启动行：证明看门狗真的活着（否则「没有任何阻塞日志」既可能是没卡、也可能是探针没跑）
		wsDiagLog(logService, `看门狗已启动（心跳 ${WS_HEARTBEAT_MS}ms，阻塞上报阈值 ${WS_BLOCK_REPORT_MS}ms）—— 卡住时按 "${WS_DIAG_TAG}" 过滤本日志`);
		this._register(startMainThreadWatchdog(logService));
		// ★ 2026-09-22：**移除了 FocusTrace 的接线** ✓ —— 「当前阶段名」原先在这里注册给
		// `browser/agentChat/focusTrace.ts`（`registerFocusStageProvider` +
		// `globalThis.__SAROSIS_WS_STAGE__` 双保险 ✓）。FocusTrace 已整体移除 ⇒ 一并删除 ✓。
		// ⚠ `wsStageText()` 本身**保留** ✓ —— 它是本模块日志里「当前阶段」文案的唯一真源 ✓。
	}
}

registerWorkbenchContribution2(
	WsSwitchDiagContribution.ID,
	WsSwitchDiagContribution as any,
	WorkbenchPhase.BlockStartup,
);
