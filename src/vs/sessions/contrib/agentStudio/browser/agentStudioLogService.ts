/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ConsoleLogger, ILoggerService, ILogService } from '../../../../platform/log/common/log.js';
import { LogService } from '../../../../platform/log/common/logService.js';

/**
 * Dedicated log service for Agent Studio.
 *
 * Writes to an independent `agentStudio.log` file (in the logs directory)
 * instead of sharing `renderer.log`. This keeps Agent Studio diagnostics
 * isolated and always persisted — including in published (built) builds
 * where the dev-console forwarder is disabled.
 *
 * A {@link ConsoleLogger} is also attached so that, in development mode,
 * logs still appear in the DevTools / debug console (just like the default
 * renderer log service).
 */
export const IAgentStudioLogService = createDecorator<ILogService>('agentStudioLogService');

export class AgentStudioLogService extends LogService {

	constructor(
		@ILoggerService loggerService: ILoggerService,
	) {
		const disposables = new DisposableStore();

		// Independent log file → <logs>/<window>/agentStudio.log
		const fileLogger = disposables.add(
			loggerService.createLogger('agentStudio', { name: 'Agent Studio' })
		);

		// Mirror to console so logs are visible in DevTools during development
		const consoleLogger = new ConsoleLogger(fileLogger.getLevel());

		super(fileLogger, [consoleLogger]);

		this._register(disposables);
	}
}
