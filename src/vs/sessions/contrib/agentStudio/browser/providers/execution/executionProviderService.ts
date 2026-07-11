/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExecutionProvider } from './executionProvider.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../../../workbench/common/contributions.js';

/**
 * Execution Provider 服务注册
 *
 * 注册 ExecutionProvider 到 IAgentOSService。
 * 作为 workbench contribution 启动时执行，将真正的（不是 example stub 的）
 * ExecutionProvider 注册到 SlotRegistry，避免 extensions/execution-example
 * 抢占（它的 priority=50 且只是 echo 用户 prompt，导致 task 立刻 "完成"）。
 */
export class ExecutionProviderContribution extends Disposable implements IWorkbenchContribution {

	public static readonly ID = 'workbench.contrib.executionProvider';

	constructor(
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerExecutionProviders();
	}

	private _registerExecutionProviders(): void {
		// 注册默认 Execution Provider
		const executionProvider = new ExecutionProvider(this.logService);
		this._register(this.agentOSService.registerExecutionProvider(executionProvider));
		this.logService.info('[ExecutionProviderContribution] Registered ExecutionProvider');
	}
}
