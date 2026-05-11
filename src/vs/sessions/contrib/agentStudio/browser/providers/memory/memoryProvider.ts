/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LocalFileMemory } from './localFileMemory.js';
import { IAgentOSService } from '../../../common/agentOS.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

/**
 * Memory Provider 服务注册
 *
 * 注册 LocalFileMemory 到 IAgentOSService。
 */
export class MemoryProviderContribution extends Disposable {

	constructor(
		@IAgentOSService private readonly agentOSService: IAgentOSService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this._registerMemoryProviders();
	}

	private _registerMemoryProviders(): void {
		// 注册本地文件 Memory Provider
		const localFileMemory = new LocalFileMemory(
			'local-file-memory',
			'Local File Memory',
			this.fileService,
			this.logService,
		);

		this._register(this.agentOSService.registerMemoryProvider(localFileMemory));
		this.logService.info('[MemoryProviderContribution] Registered LocalFileMemory');
	}
}
