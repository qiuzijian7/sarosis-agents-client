/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { IFeedbackWindowService, ipcFeedbackWindowChannelName } from '../common/feedbackWindow.js';

/**
 * 渲染层拿到主进程 {@link IFeedbackWindowService} 的入口。
 *
 * ⚠ 必须被 `sessions.desktop.main.ts` import 才会注册（本文件没有 UI 贡献点，
 *   光放在目录里不会被打包进任何 bundle）。
 */
registerMainProcessRemoteService(IFeedbackWindowService, ipcFeedbackWindowChannelName);
