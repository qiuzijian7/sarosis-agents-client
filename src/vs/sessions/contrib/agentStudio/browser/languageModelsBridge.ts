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
import { ILanguageModelsService, IChatMessage, IChatResponsePart, ChatMessageRole, ILanguageModelChatMetadata } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { IAgentOSService } from '../common/agentOS.js';
import {
	IModelProvider,
	IModelInfo,
	IModelAgentInfo,
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
 *
 * Agent-aware vendors:
 *   When a vendor wants to expose a hierarchical "agent → models" picker (e.g. Knot AG-UI),
 *   each LanguageModelChatInformation must set `family` to the agent id and (optionally)
 *   `tooltip` to the agent display name. Two-or-more distinct families on a single vendor
 *   automatically activates `supportsAgents` on the bridged IModelProvider, surfacing an
 *   agent picker in the chat box. Vendors that don't care about agents continue to ship a
 *   single family equal to the vendor id (default), and the bridge stays single-level.
 */
class LanguageModelVendorProvider extends Disposable implements IModelProvider {

	readonly id: string;
	readonly name: string;
	readonly priority: number = 50; // between built-in BYOK (default ~100) and pure user (~10)

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ModelAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ModelAuthStatus> = this._onDidChangeAuthStatus.event;

	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

	get supportsAgents(): boolean {
		// True iff at least one model declares a family different from the vendor — the
		// extension-side opt-in for the hierarchical agent picker.
		for (const { metadata } of this._collectVendorModels()) {
			if (metadata.family && metadata.family !== this.vendor) {
				return true;
			}
		}
		return false;
	}

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
		const hasModels = this._collectVendorModels().length > 0;
		return hasModels ? ModelAuthStatus.Authenticated : ModelAuthStatus.NotConfigured;
	}

	async listModels(): Promise<IModelInfo[]> {
		const result: IModelInfo[] = [];
		for (const { id, metadata } of this._collectVendorModels()) {
			result.push({
				id,                                       // qualified id, ready for sendChatRequest
				name: this._friendlyModelName(id, metadata),
				description: metadata.detail ?? metadata.tooltip,
				contextWindow: metadata.maxInputTokens,
				capabilities: [ModelCapability.Chat],
			});
		}
		return result;
	}

	/**
	 * Pick a human-readable display name for a model entry. Order of preference:
	 *   1. `metadata.name` from the extension's LanguageModelChatInformation (what the
	 *      provider author intended);
	 *   2. the trailing path component of the qualified id (`vendor/<group>/<modelId>` →
	 *      `<modelId>`), useful when an extension uses the id alone to convey the friendly
	 *      label and leaves `name` blank;
	 *   3. for hierarchical (agent×model) ids encoded as `agentId::modelName`, the right-hand
	 *      side after `::` — purely a defensive fallback for vendors that follow the bridge's
	 *      encoding contract but forget to set `name`.
	 * The qualified id (with the `vendor/...` prefix) is never returned verbatim; it makes the
	 * picker unreadable.
	 */
	private _friendlyModelName(qualifiedId: string, metadata: ILanguageModelChatMetadata): string {
		const intended = metadata.name?.trim();
		if (intended) {
			return intended;
		}
		// strip the `vendor/` prefix — qualifiedId is always `vendor/<rest>` per toModelIdentifier
		const slashIdx = qualifiedId.indexOf('/');
		const rest = slashIdx === -1 ? qualifiedId : qualifiedId.slice(slashIdx + 1);
		const sepIdx = rest.indexOf('::');
		if (sepIdx > -1) {
			const tail = rest.slice(sepIdx + 2);
			if (tail) {
				return tail;
			}
		}
		return rest || qualifiedId;
	}

	/**
	 * List agents grouped by `family`. Only meaningful for vendors that opted into the
	 * hierarchical picker (i.e. supportsAgents === true). Returns an empty array otherwise
	 * so callers that always invoke listAgents() don't have to special-case the flag.
	 */
	async listAgents(): Promise<IModelAgentInfo[]> {
		if (!this.supportsAgents) {
			return [];
		}
		const buckets = new Map<string, { name: string; description?: string; modelIds: string[] }>();
		for (const { id, metadata } of this._collectVendorModels()) {
			const agentId = metadata.family || this.vendor;
			let entry = buckets.get(agentId);
			if (!entry) {
				// Use tooltip as the human-readable agent name (the LM `name` field is reserved for the
				// model display name in agent-mode); fall back to detail / family / agent-id.
				entry = {
					name: metadata.tooltip || metadata.detail || agentId,
					description: metadata.detail,
					modelIds: [],
				};
				buckets.set(agentId, entry);
			}
			entry.modelIds.push(id);
		}
		return Array.from(buckets.entries()).map(([id, v]) => ({
			id,
			name: v.name,
			description: v.description,
			models: v.modelIds,
		}));
	}

	/** Re-fire onDidChangeModels — called by the bridge whenever LM service signals a change for this vendor. */
	notifyModelsChanged(): void {
		this._onDidChangeModels.fire();
		this._onDidChangeAgents.fire();
	}

	/** Collect all language models that belong to this vendor, with their resolved metadata. */
	private _collectVendorModels(): { id: string; metadata: ILanguageModelChatMetadata }[] {
		const out: { id: string; metadata: ILanguageModelChatMetadata }[] = [];
		for (const id of this._lmService.getLanguageModelIds()) {
			const metadata = this._lmService.lookupLanguageModel(id);
			if (metadata && metadata.vendor === this.vendor) {
				out.push({ id, metadata });
			}
		}
		return out;
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
		// Vendors come in two flavors and we must accept both:
		//   (a) declared via the `contributes.languageModelChatProviders` extension point — they show up
		//       in `getVendors()` immediately on extension scan, even before the extension has activated;
		//   (b) discovered via `_modelCache` — only populated AFTER `provideLanguageModelChatInformation`
		//       has been resolved at least once by `_resolveAllLanguageModels`.
		// Earlier we only used (b), which meant a freshly-installed provider that had not yet been
		// queried (e.g. the chat box never opened a model picker) would be invisible to the picker.
		// We now seed the live set with (a) and additionally pull in any vendors already in (b).
		const liveVendors = new Set<string>();
		for (const v of this._lmService.getVendors()) {
			if (v.vendor) {
				liveVendors.add(v.vendor);
			}
		}
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
		//     Filter out vendors that should not appear in the model selector
		//     (e.g. 'copilotcli' is a session type, not a model provider).
		const excludedVendors = new Set(['copilotcli']);
		for (const vendor of liveVendors) {
			if (excludedVendors.has(vendor)) {
				this._logService.info(`[LMBridge] Skipping excluded vendor: ${vendor}`);
				continue;
			}
			if (this._registered.has(vendor)) {
				// Existing — just notify model list may have changed.
				this._registered.get(vendor)!.provider.notifyModelsChanged();
				continue;
			}
			const provider = new LanguageModelVendorProvider(vendor, this._lmService, this._logService);
			const registration = this._agentOS.registerModelProvider(provider);
			this._registered.set(vendor, { provider, registration });
			this._logService.info(`[LMBridge] Registered vendor as IModelProvider: ${vendor} (id=${provider.id})`);

			// Kick off a non-blocking resolve so the vendor's models populate the LM cache.
			// Without this, a vendor declared via `contributes.languageModelChatProviders` would
			// stay model-less until the user (or some other code path) calls selectLanguageModels.
			this._lmService.selectLanguageModels({ vendor }).then(ids => {
				this._logService.info(`[LMBridge] Resolved ${ids.length} model(s) for vendor=${vendor}`);
				// _modelCache is now populated; _onLanguageModelChange will fire from inside
				// _resolveAllLanguageModels and our onDidChangeLanguageModels listener will
				// drive notifyModelsChanged for us — but fire one explicitly as a safety net.
				this._registered.get(vendor)?.provider.notifyModelsChanged();
			}).catch(err => {
				this._logService.warn(`[LMBridge] Initial model resolve failed for vendor=${vendor}: ${err}`);
			});
		}
	}
}
