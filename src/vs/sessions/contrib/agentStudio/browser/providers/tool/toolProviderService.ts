/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolProvider } from './toolProvider.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/**
 * Tool Provider 服务注册
 *
 * 注册 ToolProvider 到 IAgentOSService。
 */
export class ToolProviderContribution extends Disposable {

	constructor(
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerToolProviders();
	}

	private _registerToolProviders(): void {
		// 注册默认 Tool Provider
		const toolProvider = this._register(new ToolProvider(this.logService));
		this._register(this.agentOSService.registerToolProvider(toolProvider));
		this.logService.info('[ToolProviderContribution] Registered ToolProvider');
	}
}
