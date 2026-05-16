/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Language Models Bridge
 * ----------------------
 *
 * Bridges the upstream VS Code Chat Provider proposed API (`vscode.lm.registerLanguageModelChatProvider`)
 * into Agent Studio's IAgentOSService.registerModelProvider() slot.
 *
 * Data flow:
 *
 *   3rd-party extension (ExtHost)
 *     └─ vscode.lm.registerLanguageModelChatProvider("acme", { ... })
 *           │   (proposed API: chatProvider, already wired upstream)
 *           ▼
 *   ILanguageModelsService (renderer)  ──── this bridge ────►  IAgentOSService
 *     └─ onDidChangeLanguageModels                                └─ registerModelProvider(IModelProvider)
 *
 * Strategy: group by `vendor` (one extension contributes one vendor with N models),
 * each vendor becomes a single IModelProvider whose `listModels()` enumerates
 * the vendor's current models. Vendor disappearance triggers dispose().
 */

import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ILanguageModelsService, IChatMessage, IChatResponsePart, ChatMessageRole } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IAgentOSService } from '../common/agentOS.js';
import {
	IModelProvider,
	IModelInfo,
	IModelDelta,
	IModelOptions,
	IChatContext,
	IChatMessage as IAgentChatMessage,
	ModelAuthStatus,
	ModelCapability,
} from '../common/providers.js';

/**
 * One IModelProvider instance per LM vendor.
 *
 * - id:    `lm:<vendor>` so it's distinguishable from BYOK / built-in providers
 * - name:  derived from vendor (capitalized)
 * - listModels(): pulls current models from ILanguageModelsService whose vendor matches
 * - chat():       packs IChatMessage[] and calls ILanguageModelsService.sendChatRequest(modelId, ...)
 */
class LanguageModelVendorProvider extends Disposable implements IModelProvider {

	readonly id: string;
	readonly name: string;
	readonly priority: number = 50; // between built-in BYOK (default ~100) and pure user (~10)

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = this._onDidChangeAuthStatus.event;

	constructor(
		readonly vendor: string,
		private readonly _lmService: ILanguageModelsService,
		private readonly _logService: ILogService,
	) {
		super();
		this.id = `lm:${vendor}`;
		this.name = vendor.charAt(0).toUpperCase() + vendor.slice(1);
	}

	getAuthStatus(): ModelAuthStatus {
		// Provider extensions own their own auth flow; if any model exists for this vendor,
		// we consider it authenticated for selection purposes.
		const hasModels = this._lmService.getLanguageModelIds().some(id => {
			const meta = this._lmService.lookupLanguageModel(id);
			return !!meta && meta.vendor === this.vendor;
		});
		return hasModels ? ModelAuthStatus.Authenticated : ModelAuthStatus.NotConfigured;
	}

	async listModels(): Promise<IModelInfo[]> {
		const result: IModelInfo[] = [];
		for (const modelId of this._lmService.getLanguageModelIds()) {
			const meta = this._lmService.lookupLanguageModel(modelId);
			if (!meta || meta.vendor !== this.vendor) {
				continue;
			}
			result.push({
				id: modelId,                    // qualified id, ready for sendChatRequest
				name: meta.name,
				description: meta.detail ?? meta.tooltip,
				contextWindow: meta.maxInputTokens,
				capabilities: [ModelCapability.Chat],
			});
		}
		return result;
	}

	/** Re-fire onDidChangeModels — called by the bridge whenever LM service signals a change for this vendor. */
	notifyModelsChanged(): void {
		this._onDidChangeModels.fire();
	}

	async *chat(
		modelId: string,
		messages: IAgentChatMessage[],
		options: IModelOptions,
		context?: IChatContext,
	): AsyncIterable<IModelDelta> {
		const meta = this._lmService.lookupLanguageModel(modelId);
		if (!meta) {
			yield { type: 'error', error: `Model ${modelId} not found in vendor ${this.vendor}` };
			return;
		}

		const lmMessages = this._toLanguageModelMessages(messages, options);
		const cts = new CancellationTokenSource();

		try {
			const response = await this._lmService.sendChatRequest(
				modelId,
				meta.extension,                   // initiating extension = the provider extension itself
				lmMessages,
				{ requestInitiator: 'sessions.agentStudio' },
				cts.token,
			);

			for await (const part of response.stream) {
				const parts = Array.isArray(part) ? part : [part];
				for (const p of parts) {
					const delta = this._toModelDelta(p);
					if (delta) {
						yield delta;
					}
				}
			}

			yield { type: 'done' };
		} catch (err) {
			this._logService.error(`[LMBridge] chat() failed for vendor=${this.vendor} model=${modelId}`, err);
			yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
		} finally {
			cts.dispose();
		}

		// silence unused-var warnings for context — reserved for future use (agentId routing etc.)
		void context;
	}

	private _toLanguageModelMessages(messages: IAgentChatMessage[], options: IModelOptions): IChatMessage[] {
		const out: IChatMessage[] = [];

		if (options.systemPrompt) {
			out.push({
				role: ChatMessageRole.System,
				content: [{ type: 'text', value: options.systemPrompt }],
			});
		}

		for (const m of messages) {
			out.push({
				role: m.role === 'user' ? ChatMessageRole.User
					: m.role === 'assistant' ? ChatMessageRole.Assistant
						: m.role === 'system' ? ChatMessageRole.System
							: ChatMessageRole.User,
				content: [{ type: 'text', value: m.content ?? '' }],
			});
		}
		return out;
	}

	private _toModelDelta(part: IChatResponsePart): IModelDelta | undefined {
		switch (part.type) {
			case 'text':
				return { type: 'text', content: part.value };
			case 'thinking':
				return { type: 'thinking', content: typeof (part as { value?: unknown }).value === 'string' ? (part as { value: string }).value : '' };
			case 'tool_use':
				return {
					type: 'tool_call',
					toolCall: {
						id: (part as { toolCallId: string }).toolCallId,
						name: (part as { name: string }).name,
						arguments: typeof (part as { parameters?: unknown }).parameters === 'string'
							? (part as { parameters: string }).parameters
							: JSON.stringify((part as { parameters?: unknown }).parameters ?? {}),
					},
				};
			default:
				return undefined; // data parts and others — ignored for now
		}
	}
}

/**
 * Workbench contribution that owns the bridge lifecycle.
 *
 * Subscribes to ILanguageModelsService.onDidChangeLanguageModels (fires per modelId change)
 * and reconciles the vendor → IModelProvider registrations on every change.
 */
export class LanguageModelsToAgentOSBridge extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.agentStudio.languageModelsBridge';

	/** vendor → { provider, disposable returned by registerModelProvider } */
	private readonly _registered = new Map<string, { provider: LanguageModelVendorProvider; registration: IDisposable }>();

	/** Debounce reconciliation — onDidChangeLanguageModels can fire many times during startup. */
	private readonly _pendingReconcile = this._register(new MutableDisposable());

	constructor(
		@ILanguageModelsService private readonly _lmService: ILanguageModelsService,
		@IAgentOSService private readonly _agentOS: IAgentOSService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(this._lmService.onDidChangeLanguageModels(() => this._scheduleReconcile()));
		this._register(this._lmService.onDidChangeLanguageModelVendors(() => this._scheduleReconcile()));

		// Initial pass — covers any provider registered before this contribution started.
		this._scheduleReconcile();

		this._register(toDisposable(() => {
			for (const { registration, provider } of this._registered.values()) {
				registration.dispose();
				provider.dispose();
			}
			this._registered.clear();
		}));
	}

	private _scheduleReconcile(): void {
		const handle = setTimeout(() => this._reconcile(), 0);
		this._pendingReconcile.value = toDisposable(() => clearTimeout(handle));
	}

	private _reconcile(): void {
		// Compute current vendor set from the LM service.
		const liveVendors = new Set<string>();
		for (const id of this._lmService.getLanguageModelIds()) {
			const meta = this._lmService.lookupLanguageModel(id);
			if (meta?.vendor) {
				liveVendors.add(meta.vendor);
			}
		}

		// 1. Remove vendors that disappeared.
		for (const [vendor, entry] of Array.from(this._registered.entries())) {
			if (!liveVendors.has(vendor)) {
				this._logService.info(`[LMBridge] Vendor disappeared, unregistering: ${vendor}`);
				entry.registration.dispose();
				entry.provider.dispose();
				this._registered.delete(vendor);
			}
		}

		// 2. Add vendors that appeared.
		for (const vendor of liveVendors) {
			if (this._registered.has(vendor)) {
				// Existing — just notify model list may have changed.
				this._registered.get(vendor)!.provider.notifyModelsChanged();
				continue;
			}
			const provider = new LanguageModelVendorProvider(vendor, this._lmService, this._logService);
			const registration = this._agentOS.registerModelProvider(provider);
			this._registered.set(vendor, { provider, registration });
			this._logService.info(`[LMBridge] Registered vendor as IModelProvider: ${vendor} (id=${provider.id})`);
		}
	}
}
