/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IFeedbackWindowService = createDecorator<IFeedbackWindowService>('feedbackWindowService');

/** 主进程 ↔ 渲染层通道名（见 `app.ts` 的注册）。 */
export const ipcFeedbackWindowChannelName = 'vssarosFeedbackWindow';

export interface IFeedbackWindowResult {
	/** 窗口是否已打开并可用（**不代表附件一定填上了**，见 {@link filesFilled}）。 */
	readonly ok: boolean;
	/** 失败原因（`ok === false` 时有值）。 */
	readonly error?: string;
	/**
	 * 诊断文件是否已自动挂到「日志文件」题。
	 *
	 * ⚠ 为 `false` 时窗口**照样开着**（用户还能手动传），只是提示语要改成"请手动添加"。
	 */
	readonly filesFilled?: boolean;
}

/**
 * 产品**内置**的反馈窗口服务（2026-10-31）。
 *
 * 为什么不用系统浏览器：系统浏览器里我们**没有注入能力** ⇒ 日志文件只能靠用户手动传。
 * 为什么不用 `IPlaywrightService`：它把页面挂在 BrowserView 组上，而那个组绑的是
 * **IDE 主窗口** —— dsh 桌面窗口场景下 IDE 主窗口是隐藏的（只显示 desktop），
 * 用户在 dsh 里点反馈会"点了没反应"。独立 BrowserWindow 才能保证**一定看得见**。
 */
export interface IFeedbackWindowService {
	readonly _serviceBrand: undefined;

	/**
	 * 打开反馈窗口（不可见时创建，已存在则复用并聚焦），加载 `url`，
	 * 并把 `files` 填进页面里**题名含「日志」**的 `<input type=file>`。
	 *
	 * 填文件用的是 CDP `DOM.setFileInputFiles` —— 等价于用户点了「添加本地文件」选中它们，
	 * 走飞书自己的匿名上传通道（实测无 cookie 也能传），**不需要任何 token / 后端**。
	 *
	 * ⚠ 只做"预填"，**不代提交**：提交永远由本人点。
	 */
	openFeedbackWindow(url: string, files: readonly string[]): Promise<IFeedbackWindowResult>;
}
