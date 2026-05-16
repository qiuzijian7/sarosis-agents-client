/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionsRegistry, IExtensionPointUser } from '../../../../workbench/services/extensions/common/extensionsRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileAccess } from '../../../../base/common/network.js';
import type { IJSONSchema } from '../../../../base/common/jsonSchema.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Shape of a single capability declaration in package.json:
 *
 * ```json
 * "contributes": {
 *   "agentCapabilities": [
 *     { "capability": "model", "provider": "my-provider", "priority": 100 }
 *   ]
 * }
 * ```
 */
export interface IAgentCapabilityContribution {
	/** Capability slot: model | memory | tool | planning | execution | retrieval | kanban */
	capability: string;
	/** Provider identifier (must be unique across all installed extensions) */
	provider: string;
	/** Higher priority wins when multiple providers compete for the same slot */
	priority?: number;
}

/**
 * A resolved capability plugin descriptor — combines extension metadata
 * with the declared agentCapabilities.
 */
export interface IResolvedCapabilityPlugin {
	/** Extension identifier (e.g. 'publisher.my-agent-plugin') */
	readonly extensionId: string;
	/** Human-readable display name */
	readonly displayName: string;
	/** Extension version */
	readonly version: string;
	/** Absolute path to the extension root directory */
	readonly extensionPath: string;
	/** The main module entry point (from package.json "main") */
	readonly mainModule: string;
	/** The agentCapabilities declared in contributes */
	readonly capabilities: IAgentCapabilityContribution[];
}

// ─── Extension Point Schema ─────────────────────────────────────────────────

const agentCapabilitiesSchema: IJSONSchema = {
	description: 'Contributes Agent capability providers (model, memory, tool, planning, execution, retrieval, kanban) to Agent Studio.',
	type: 'array',
	items: {
		type: 'object',
		required: ['capability', 'provider'],
		properties: {
			capability: {
				type: 'string',
				description: 'The capability slot this provider fills.',
				enum: ['model', 'memory', 'tool', 'planning', 'execution', 'retrieval', 'kanban'],
			},
			provider: {
				type: 'string',
				description: 'Unique provider identifier.',
			},
			priority: {
				type: 'number',
				description: 'Provider priority (higher wins). Default: 0.',
				default: 0,
			},
		},
		additionalProperties: false,
	},
};

// ─── Register the Extension Point ───────────────────────────────────────────

/**
 * Register `contributes.agentCapabilities` as a VS Code Extension Point.
 *
 * This allows ANY installed extension (built-in or third-party from marketplace)
 * to declare agent capability providers in its package.json. The extension point
 * handler is called automatically when extensions are loaded/unloaded.
 */
export const agentCapabilitiesExtensionPoint = ExtensionsRegistry.registerExtensionPoint<IAgentCapabilityContribution[]>({
	extensionPoint: 'agentCapabilities',
	jsonSchema: agentCapabilitiesSchema,
	activationEventsGenerator: function* (contributions) {
		// Generate activation event for each declared capability provider
		for (const contribution of contributions) {
			if (contribution.provider) {
				yield `onAgentCapability:${contribution.capability}:${contribution.provider}`;
			}
		}
	},
});

// ─── Extension Point Registry (runtime tracker) ─────────────────────────────

/**
 * Tracks all extensions that have declared agentCapabilities via the extension point.
 * This is the **runtime** registry that replaces the build-time manifest approach
 * for discovering third-party capability plugins.
 *
 * Usage:
 * ```typescript
 * const registry = new AgentCapabilitiesExtensionPointRegistry(logService);
 * registry.onDidChange(() => {
 *   const allPlugins = registry.getAll();
 *   // activate new ones, deactivate removed ones
 * });
 * ```
 */
export class AgentCapabilitiesExtensionPointRegistry extends Disposable {

	private readonly _plugins = new Map<string, IResolvedCapabilityPlugin>();

	private readonly _onDidChange = this._register(new Emitter<{
		added: IResolvedCapabilityPlugin[];
		removed: IResolvedCapabilityPlugin[];
	}>());
	readonly onDidChange: Event<{ added: IResolvedCapabilityPlugin[]; removed: IResolvedCapabilityPlugin[] }> = this._onDidChange.event;

	constructor(
		private readonly logService: ILogService,
	) {
		super();
		this._registerHandler();
	}

	private _registerHandler(): void {
		this._register(agentCapabilitiesExtensionPoint.setHandler((extensions, delta) => {
			this.logService.info(
				`[AgentCapabilities ExtPoint][Diag] setHandler fired: `
				+ `current=${extensions.length} added=${delta.added.length} removed=${delta.removed.length}`,
			);
			const added: IResolvedCapabilityPlugin[] = [];
			const removed: IResolvedCapabilityPlugin[] = [];

			// Process removed extensions
			for (const ext of delta.removed) {
				const extId = ext.description.identifier.value;
				const existing = this._plugins.get(extId);
				if (existing) {
					this._plugins.delete(extId);
					removed.push(existing);
					this.logService.info(`[AgentCapabilities ExtPoint] Removed: ${extId}`);
				}
			}

			// Process added extensions
			for (const ext of delta.added) {
				const extId = ext.description.identifier.value;
				this.logService.info(
					`[AgentCapabilities ExtPoint][Diag] Resolving extension contribution: ${extId} `
					+ `main=${ext.description.main ?? '<none>'} browser=${ext.description.browser ?? '<none>'} `
					+ `location=${ext.description.extensionLocation.toString()}`,
				);
				const resolved = this._resolveExtension(ext);
				if (resolved) {
					this._plugins.set(resolved.extensionId, resolved);
					added.push(resolved);
					this.logService.info(
						`[AgentCapabilities ExtPoint] Discovered: ${resolved.extensionId} `
						+ `(${resolved.capabilities.map(c => c.capability).join(', ')}) `
						+ `mainModule=${resolved.mainModule || '<empty>'}`
					);
				} else {
					this.logService.warn(
						`[AgentCapabilities ExtPoint][Diag] Resolution returned null for ${extId} `
						+ `-- contribution invalid (see warnings above)`,
					);
				}
			}

			if (added.length > 0 || removed.length > 0) {
				this._onDidChange.fire({ added, removed });
			}
		}));
	}

	private _resolveExtension(ext: IExtensionPointUser<IAgentCapabilityContribution[]>): IResolvedCapabilityPlugin | null {
		const capabilities = ext.value;
		if (!Array.isArray(capabilities) || capabilities.length === 0) {
			ext.collector.warn('agentCapabilities must be a non-empty array');
			return null;
		}

		// Validate each capability entry
		const validCapabilities: IAgentCapabilityContribution[] = [];
		const validSlots = new Set(['model', 'memory', 'tool', 'planning', 'execution', 'retrieval', 'kanban']);

		for (const cap of capabilities) {
			if (!cap.capability || !cap.provider) {
				ext.collector.warn(`agentCapabilities entry missing required fields: ${JSON.stringify(cap)}`);
				continue;
			}
			if (!validSlots.has(cap.capability)) {
				ext.collector.warn(`Unknown capability slot '${cap.capability}' — expected one of: ${[...validSlots].join(', ')}`);
				continue;
			}
			validCapabilities.push({
				capability: cap.capability,
				provider: cap.provider,
				priority: typeof cap.priority === 'number' ? cap.priority : 0,
			});
		}

		if (validCapabilities.length === 0) {
			return null;
		}

		const desc = ext.description;

		// Resolve `main`/`browser` against the extension's installation
		// location so the activator can `import()` it directly. `desc.main`
		// is a path relative to the extension root (e.g. "./dist/extension.js");
		// joining it onto `extensionLocation` yields an absolute URI that the
		// ESM loader can dereference regardless of where this contribution
		// lives in `out/`.
		const rawMain = desc.main ?? desc.browser ?? '';
		let resolvedMain = '';
		if (rawMain) {
			try {
				const mainUri = URI.joinPath(desc.extensionLocation, rawMain);
				// In the renderer process, Electron forbids `file://` for
				// security reasons -- dynamic import() would fail with
				// "Not allowed to load local resource". Convert any local
				// `file://` URI into the browser-safe `vscode-file://vscode-app/...`
				// scheme via FileAccess. Remote URIs (vscode-remote://) are
				// passed through and rewritten by FileAccess as needed.
				resolvedMain = FileAccess.uriToBrowserUri(mainUri).toString(true);
			} catch {
				// Fallback to the raw value; activator will warn if it cannot resolve it.
				resolvedMain = rawMain;
			}
		}

		return {
			extensionId: desc.identifier.value,
			displayName: typeof desc.displayName === 'string'
				? desc.displayName
				: (desc.displayName as any)?.value ?? desc.identifier.value,
			version: desc.version,
			extensionPath: desc.extensionLocation.fsPath,
			mainModule: resolvedMain,
			capabilities: validCapabilities,
		};
	}

	/**
	 * Get all currently registered capability plugins.
	 */
	getAll(): IResolvedCapabilityPlugin[] {
		return [...this._plugins.values()];
	}

	/**
	 * Get capability plugins filtered by capability slot.
	 */
	getByCapability(capability: string): IResolvedCapabilityPlugin[] {
		return this.getAll().filter(p => p.capabilities.some(c => c.capability === capability));
	}

	/**
	 * Check if a specific extension has registered capabilities.
	 */
	has(extensionId: string): boolean {
		return this._plugins.has(extensionId);
	}
}
