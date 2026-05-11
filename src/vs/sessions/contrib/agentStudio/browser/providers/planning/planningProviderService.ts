/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PlanningProvider } from './planningProvider.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/**
 * Planning Provider 服务注册
 *
 * 注册 PlanningProvider 到 IAgentOSService。
 */
export class PlanningProviderContribution extends Disposable {

	constructor(
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._registerPlanningProviders();
	}

	private _registerPlanningProviders(): void {
		// 注册默认 Planning Provider
		const planningProvider = new PlanningProvider(this.logService);
		this._register(this.agentOSService.registerPlanningProvider(planningProvider));
		this.logService.info('[PlanningProviderContribution] Registered PlanningProvider');
	}
}
