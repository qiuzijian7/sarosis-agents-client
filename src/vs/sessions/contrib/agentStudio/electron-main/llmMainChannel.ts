/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILoggerService } from '../../../../platform/log/common/log.js';
import { type IModelDelta } from '../common/providers.js';
import { VSSAROS_LLM_CHANNEL, discoverModels, streamChatCompletions, type ISarosisLlmChatRequest, type LogFn, type LogLevel } from '../common/llmBridge.js';
import type { IBYOKProviderDefinition } from '../browser/builtInBYOKModelProvider.js';

/**
 * 主进程侧的 LLM channel：在 electron-main 内执行真实的 fetch/SSE 解析，
 * 通过 IPC `listen('chat')` 把流式 `IModelDelta` 回传给 renderer，
 * 并通过 `call('abort' | 'discoverModels')` 支持中断与模型发现。
 *
 * 对齐 Void 的 `LLMMessageChannel` + `void-channel-llmMessage`。
 */
export class LlmMainChannel<TContext> extends Disposable implements IServerChannel<TContext> {

	private readonly _aborts = new Map<string, AbortController>();

	constructor(
		@ILoggerService private readonly _loggerService: ILoggerService,
	) {
		super();
	}

	listen<T>(_ctx: TContext, event: string, arg?: unknown): Event<T> {
		if (event === 'chat') {
			const req = arg as ISarosisLlmChatRequest;
			const emitter = new Emitter<IModelDelta>();
			const controller = new AbortController();
			this._aborts.set(req.requestId, controller);
			const log: LogFn = (level, msg, ...args) => this._log(level, msg, ...args);

			(async () => {
				try {
					for await (const delta of streamChatCompletions({
						url: req.url,
						apiKey: req.apiKey,
						body: req.body,
						extraHeaders: req.extraHeaders,
						signal: controller.signal,
						log,
					})) {
						emitter.fire(delta);
					}
				} catch (e) {
					emitter.fire({ type: 'error', error: `Main process stream error: ${e}` } as IModelDelta);
				} finally {
					this._aborts.delete(req.requestId);
					emitter.dispose();
				}
			})();

			return emitter.event as Event<T>;
		}
		throw new Error(`Invalid listen: ${event}`);
	}

	async call<T>(_ctx: TContext, command: string, args?: unknown): Promise<T> {
		switch (command) {
			case 'abort': {
				const { requestId } = (args as { requestId: string }) ?? { requestId: '' };
				this._aborts.get(requestId)?.abort();
				return undefined as T;
			}
			case 'discoverModels': {
				const { baseUrl, apiKey, definition } = (args as {
					baseUrl: string;
					apiKey: string;
					definition: IBYOKProviderDefinition;
				});
				const models = await discoverModels(baseUrl, apiKey, definition, (level, msg, ...a) => this._log(level, msg, ...a));
				return models as unknown as T;
			}
		}
		throw new Error(`Invalid call: ${command}`);
	}

	private _log(level: LogLevel, msg: string, ...args: unknown[]): void {
		const logger = this._loggerService.getLogger('vssaros-llm');
		if (!logger) { return; }
		if (level === 'error') { logger.error(msg, ...args); }
		else if (level === 'warn') { logger.warn(msg, ...args); }
		else { logger.info(msg, ...args); }
	}
}

export { VSSAROS_LLM_CHANNEL };
