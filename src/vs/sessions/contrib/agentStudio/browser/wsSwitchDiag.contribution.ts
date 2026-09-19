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
import { WS_BLOCK_REPORT_MS, WS_DIAG_TAG, WS_HEARTBEAT_MS, startMainThreadWatchdog, wsDiagLog, wsStageText } from './wsSwitchDiag.js';
import { registerFocusStageProvider } from '../../../browser/agentChat/focusTrace.js';

class WsSwitchDiagContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wsSwitchDiag';

	constructor(@ILogService logService: ILogService) {
		super();
		// 启动行：证明看门狗真的活着（否则「没有任何阻塞日志」既可能是没卡、也可能是探针没跑）
		wsDiagLog(logService, `看门狗已启动（心跳 ${WS_HEARTBEAT_MS}ms，阻塞上报阈值 ${WS_BLOCK_REPORT_MS}ms）—— 卡住时按 "${WS_DIAG_TAG}" 过滤本日志`);
		this._register(startMainThreadWatchdog(logService));
		// ★ 2026-09-19：把「当前阶段名」注入焦点埋点（`browser/agentChat` 不能反向依赖本目录 ✗）。
		// ⚠ 这只是**双保险** ✓ —— 主路径在 `wsSwitchDiag.startMainThreadWatchdog()` 里发布**全局钩子**
		//   `globalThis.__SAROSIS_WS_STAGE__` ✓（本文件曾多次被并行会话回退 ⇒ 不能只依赖这里 ✗✗）。
		//   真机教训：注册丢失时焦点行会写「（未注册阶段提供者）」，等于白测一轮 ✓。
		// ★★ 2026-09-19：文本改用**唯一真源** `wsStageText()` —— 它会区分「进行中（已持续 Ns）」
		// 与「已结束（无进行中阶段；末个「…」结束于 Ns 前）」✓。此前两处各自拼字符串，
		// 且**都不知道阶段已结束** ⇒ 会把一个早已跑完的阶段说成"已持续 1884s" ✗✗（真机踩过）。
		const stageText = () => wsStageText();
		registerFocusStageProvider(stageText);
		try {
			(globalThis as unknown as { __SAROSIS_WS_STAGE__?: () => string }).__SAROSIS_WS_STAGE__ = stageText;
		} catch { /* 只读 globalThis 的宿主环境 ⇒ 忽略 ✓ */ }
	}
}

registerWorkbenchContribution2(
	WsSwitchDiagContribution.ID,
	WsSwitchDiagContribution as any,
	WorkbenchPhase.BlockStartup,
);
