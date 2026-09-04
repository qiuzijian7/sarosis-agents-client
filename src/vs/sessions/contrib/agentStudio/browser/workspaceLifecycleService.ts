/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import {
	IWorkspaceLifecycleService,
	IWorkspaceLifecycleHook,
	IWorkspaceLifecycleCommandHook,
	IWorkspaceLifecyclePayload,
	WorkspaceLifecycleEvent,
} from '../common/workspaceLifecycle.js';

/**
 * 默认实现：保存两个 Set（进程内钩子 + 命令钩子），并提供并发触发 + 异常隔离。
 *
 * 同时注册一个全局命令 `agentStudio.workspaceLifecycle.register`，以便扩展端
 * 用 `commands.executeCommand(...)` 注册自己的命令钩子。命令调用约定：
 *
 *   commands.executeCommand('agentStudio.workspaceLifecycle.register', {
 *       id: 'demo-agui',
 *       onCreated: 'knot.workspace.sync',     // 可选
 *       onDeleted: 'knot.workspace.unsync',   // 可选
 *       onUpdated: 'knot.workspace.update',   // 可选
 *   });
 *
 * 返回值是一个不可序列化的 IDisposable（`{ dispose: () => void }`）。
 * 由于 RPC 边界的限制，扩展端通常无法直接 `dispose()` —— 因此扩展也可以选择
 * 调用配套命令 `agentStudio.workspaceLifecycle.unregister` + id 来反注册。
 */
export class WorkspaceLifecycleService extends Disposable implements IWorkspaceLifecycleService {

	declare readonly _serviceBrand: undefined;

	private readonly _hooks = new Map<IWorkspaceLifecycleHook, true>();
	private readonly _commandHooks = new Map<string /* hook.id */, IWorkspaceLifecycleCommandHook>();

	private readonly _onDidFire = this._register(new Emitter<{ event: WorkspaceLifecycleEvent; payload: IWorkspaceLifecyclePayload }>());
	readonly onDidFire = this._onDidFire.event;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this._registerExtensionFacingCommands();
	}

	registerHook(hook: IWorkspaceLifecycleHook): IDisposable {
		if (!hook || typeof hook.id !== 'string' || !hook.id) {
			throw new Error('[WorkspaceLifecycle] hook.id is required');
		}
		this._hooks.set(hook, true);
		this.logService.info(`[WorkspaceLifecycle] in-proc hook registered: ${hook.id}`);
		return {
			dispose: () => {
				if (this._hooks.delete(hook)) {
					this.logService.info(`[WorkspaceLifecycle] in-proc hook unregistered: ${hook.id}`);
				}
			},
		};
	}

	registerCommandHook(hook: IWorkspaceLifecycleCommandHook): IDisposable {
		if (!hook || typeof hook.id !== 'string' || !hook.id) {
			throw new Error('[WorkspaceLifecycle] command hook.id is required');
		}
		// Replace any prior hook with the same id (idempotent re-register).
		this._commandHooks.set(hook.id, hook);
		this.logService.info(
			`[WorkspaceLifecycle] command hook registered: id=${hook.id} `
			+ `onCreated=${hook.onCreated ?? '<none>'} onDeleted=${hook.onDeleted ?? '<none>'} onUpdated=${hook.onUpdated ?? '<none>'}`,
		);
		return {
			dispose: () => {
				if (this._commandHooks.delete(hook.id)) {
					this.logService.info(`[WorkspaceLifecycle] command hook unregistered: ${hook.id}`);
				}
			},
		};
	}

	async fire(event: WorkspaceLifecycleEvent, payload: IWorkspaceLifecyclePayload): Promise<void> {
		this._onDidFire.fire({ event, payload });

		const hooks = Array.from(this._hooks.keys());
		const commandHooks = Array.from(this._commandHooks.values());
		this.logService.info(
			`[WorkspaceLifecycle] fire event="${event}" workspaceId=${payload.id} `
			+ `inProcHooks=${hooks.length} commandHooks=${commandHooks.length}`,
		);

		const tasks: Promise<unknown>[] = [];

		for (const hook of hooks) {
			tasks.push(this._invokeHook(hook, event, payload));
		}
		for (const cmdHook of commandHooks) {
			tasks.push(this._invokeCommandHook(cmdHook, event, payload));
		}

		// allSettled — never reject the caller (workspace lifecycle ≠ provider concerns).
		await Promise.allSettled(tasks);
	}

	private async _invokeHook(
		hook: IWorkspaceLifecycleHook,
		event: WorkspaceLifecycleEvent,
		payload: IWorkspaceLifecyclePayload,
	): Promise<void> {
		try {
			const fn = event === WorkspaceLifecycleEvent.Created
				? hook.onCreated
				: event === WorkspaceLifecycleEvent.Deleted
					? hook.onDeleted
					: hook.onUpdated;
			if (typeof fn === 'function') {
				await fn.call(hook, payload);
			}
		} catch (err) {
			this.logService.warn(
				`[WorkspaceLifecycle] in-proc hook "${hook.id}" failed on "${event}": `
				+ `${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async _invokeCommandHook(
		hook: IWorkspaceLifecycleCommandHook,
		event: WorkspaceLifecycleEvent,
		payload: IWorkspaceLifecyclePayload,
	): Promise<void> {
		const commandId = event === WorkspaceLifecycleEvent.Created
			? hook.onCreated
			: event === WorkspaceLifecycleEvent.Deleted
				? hook.onDeleted
				: hook.onUpdated;
		if (!commandId) { return; }
		try {
			await this.commandService.executeCommand(commandId, payload);
		} catch (err) {
			this.logService.warn(
				`[WorkspaceLifecycle] command hook "${hook.id}" -> "${commandId}" failed on "${event}": `
				+ `${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private _registerExtensionFacingCommands(): void {
		// Registration command — extensions call this from their activate() to subscribe.
		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.workspaceLifecycle.register',
			handler: (_accessor, spec?: IWorkspaceLifecycleCommandHook) => {
				if (!spec || typeof spec.id !== 'string') {
					this.logService.warn('[WorkspaceLifecycle] register command called with invalid spec');
					return false;
				}
				this.registerCommandHook(spec);
				return true;
			},
		}));

		// Inverse command — extensions can opt out (e.g. on deactivate or when CLI/token is revoked).
		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.workspaceLifecycle.unregister',
			handler: (_accessor, idOrSpec?: string | { id: string }) => {
				const id = typeof idOrSpec === 'string'
					? idOrSpec
					: (idOrSpec && typeof idOrSpec.id === 'string' ? idOrSpec.id : '');
				if (!id) {
					this.logService.warn('[WorkspaceLifecycle] unregister command called without id');
					return false;
				}
				const removed = this._commandHooks.delete(id);
				if (removed) {
					this.logService.info(`[WorkspaceLifecycle] command hook unregistered (via cmd): ${id}`);
				}
				return removed;
			},
		}));

		// Convenience command — let extensions list current registrations (debugging).
		this._register(CommandsRegistry.registerCommand({
			id: 'agentStudio.workspaceLifecycle.list',
			handler: () => Array.from(this._commandHooks.values()).map(h => ({ ...h })),
		}));
	}

	override dispose(): void {
		this._hooks.clear();
		this._commandHooks.clear();
		super.dispose();
	}
}
