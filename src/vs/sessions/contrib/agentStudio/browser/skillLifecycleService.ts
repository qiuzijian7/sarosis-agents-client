/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import {
	ISkillLifecycleService,
	ISkillLifecycleCommandHook,
	ISkillLifecyclePayload,
	ISkillBatchLifecyclePayload,
	SkillLifecycleEvent,
} from '../common/skillLifecycle.js';

/**
 * ISkillLifecycleService 默认实现。
 *
 * 同时注册全局命令 `agentStudio.skillLifecycle.register` / `unregister` / `list`，
 * 以便扩展端用 `commands.executeCommand(...)` 注册自己的命令钩子。
 */
export class SkillLifecycleService extends Disposable implements ISkillLifecycleService {

	declare readonly _serviceBrand: undefined;

	private readonly _commandHooks = new Map<string /* hook.id */, ISkillLifecycleCommandHook>();

	private readonly _onDidFireSkillEvent = this._register(new Emitter<{ event: SkillLifecycleEvent; payload: ISkillLifecyclePayload | ISkillBatchLifecyclePayload }>());
	readonly onDidFireSkillEvent: Event<{ event: SkillLifecycleEvent; payload: ISkillLifecyclePayload | ISkillBatchLifecyclePayload }> = this._onDidFireSkillEvent.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._registerExtensionFacingCommands();
	}

	registerCommandHook(hook: ISkillLifecycleCommandHook): IDisposable {
		if (!hook || typeof hook.id !== 'string' || !hook.id) {
			throw new Error('[SkillLifecycle] command hook.id is required');
		}
		this._commandHooks.set(hook.id, hook);
		this.logService.info(
			`[SkillLifecycle] command hook registered: id=${hook.id} `
			+ `onAdded=${hook.onAdded ?? '<none>'} onRemoved=${hook.onRemoved ?? '<none>'} onSynced=${hook.onSynced ?? '<none>'}`,
		);
		return {
			dispose: () => {
				if (this._commandHooks.delete(hook.id)) {
					this.logService.info(`[SkillLifecycle] command hook unregistered: ${hook.id}`);
				}
			},
		};
	}

	async fireSkillEvent(event: SkillLifecycleEvent.Added | SkillLifecycleEvent.Removed, payload: ISkillLifecyclePayload): Promise<void> {
		this._onDidFireSkillEvent.fire({ event, payload });

		const commandHooks = Array.from(this._commandHooks.values());
		this.logService.info(
			`[SkillLifecycle] fireSkillEvent event="${event}" agentId=${payload.agentId} skillId=${payload.skillId} commandHooks=${commandHooks.length}`,
		);

		const tasks: Promise<unknown>[] = [];
		for (const cmdHook of commandHooks) {
			tasks.push(this._invokeCommandHook(cmdHook, event, payload));
		}
		await Promise.allSettled(tasks);
	}

	async fireBatchEvent(payload: ISkillBatchLifecyclePayload): Promise<void> {
		this._onDidFireSkillEvent.fire({ event: SkillLifecycleEvent.Synced, payload });

		const commandHooks = Array.from(this._commandHooks.values());
		this.logService.info(
			`[SkillLifecycle] fireBatchEvent agentId=${payload.agentId} skillCount=${payload.skillIds.length} commandHooks=${commandHooks.length}`,
		);

		const tasks: Promise<unknown>[] = [];
		for (const cmdHook of commandHooks) {
			tasks.push(this._invokeCommandHook(cmdHook, SkillLifecycleEvent.Synced, payload));
		}
		await Promise.allSettled(tasks);
	}

	private async _invokeCommandHook(
		hook: ISkillLifecycleCommandHook,
		event: SkillLifecycleEvent,
		payload: ISkillLifecyclePayload | ISkillBatchLifecyclePayload,
	): Promise<void> {
		const commandId = event === SkillLifecycleEvent.Added
			? hook.onAdded
			: event === SkillLifecycleEvent.Removed
				? hook.onRemoved
				: hook.onSynced;
		if (!commandId) { return; }
		try {
			await this.commandService.executeCommand(commandId, payload);
		} catch (err) {
			this.logService.warn(
				`[SkillLifecycle] command hook "${hook.id}" -> "${commandId}" failed on "${event}": `
				+ `${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private _registerExtensionFacingCommands(): void {
		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.skillLifecycle.register',
			handler: (_accessor, spec?: ISkillLifecycleCommandHook) => {
				if (!spec || typeof spec.id !== 'string') {
					this.logService.warn('[SkillLifecycle] register command called with invalid spec');
					return false;
				}
				this.registerCommandHook(spec);
				return true;
			},
		}));

		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.skillLifecycle.unregister',
			handler: (_accessor, idOrSpec?: string | { id: string }) => {
				const id = typeof idOrSpec === 'string'
					? idOrSpec
					: (idOrSpec && typeof idOrSpec.id === 'string' ? idOrSpec.id : '');
				if (!id) {
					this.logService.warn('[SkillLifecycle] unregister command called without id');
					return false;
				}
				const removed = this._commandHooks.delete(id);
				if (removed) {
					this.logService.info(`[SkillLifecycle] command hook unregistered (via cmd): ${id}`);
				}
				return removed;
			},
		}));

		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.skillLifecycle.list',
			handler: () => Array.from(this._commandHooks.values()).map(h => ({ ...h })),
		}));
	}

	override dispose(): void {
		this._commandHooks.clear();
		super.dispose();
	}
}
