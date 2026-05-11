/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExecutionProvider } from './executionProvider.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/**
 * Execution Provider 服务注册
 *
 * 注册 ExecutionProvider 到 IAgentOSService。
 */
export class ExecutionProviderContribution extends Disposable {

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
