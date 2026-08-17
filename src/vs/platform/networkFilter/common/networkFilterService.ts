/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { LRUCache } from '../../../base/common/map.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { AgentSandboxSettingId } from '../../sandbox/common/settings.js';
import { ITerminalSandboxService } from '../../sandbox/common/terminalSandboxService.js';
import { extractDomainFromUri, isDomainAllowed } from './domainMatcher.js';
import { AgentNetworkDomainSettingId } from './settings.js';

/**
 * Operating mode for agent network filtering, configured via
 * {@link AgentNetworkDomainSettingId.NetworkFilterMode}.
 *
 * - `off`:     Filtering is fully disabled; all URIs are allowed (except where the
 *              terminal sandbox still restricts the fetch web tool).
 * - `filter`:  Access is restricted to the configured allowed/denied domain lists.
 * - `denyAll`: Every network URI is blocked; only `file:` URIs and URIs without an
 *              authority (e.g. local or untitled documents) pass.
 */
export const enum AgentNetworkFilterMode {
	Off = 'off',
	Filter = 'filter',
	DenyAll = 'denyAll',
}

export const IAgentNetworkFilterService = createDecorator<IAgentNetworkFilterService>('agentNetworkFilterService');

export const AgentNetworkFilterFetchWebToolName = 'fetchWebTool';

/**
 * Service that filters network requests made by agent tools (fetch tool,
 * integrated browser) based on the configured network filter mode and the
 * allowed/denied domain lists.
 *
 * The mode is controlled by `chat.agent.networkFilterMode`:
 * - `off`:     No filtering is applied (all URIs allowed, except the terminal
 *              sandbox may still restrict the fetch web tool).
 * - `filter`:  Access is restricted to the configured allowed/denied domain lists.
 * - `denyAll`: Every network URI is blocked; only `file:` URIs and URIs without an
 *              authority pass.
 *
 * The legacy boolean `chat.agent.networkFilter` is still honored as a fallback:
 * `true` maps to `filter`, `false`/`undefined` to `off`. `denyAll` is the safe
 * default (it is the schema default for the mode setting).
 *
 * For the `filter` mode: when both domain lists are empty, all domains are denied.
 * A domain on the denied list is always blocked, even if it also matches the
 * allowed list.
 */
export interface IAgentNetworkFilterService {
	readonly _serviceBrand: undefined;

	/**
	 * Checks a URI against the current network filter mode and domain lists.
	 * - `off`: always allowed (terminal sandbox may still gate the fetch web tool).
	 * - `denyAll`: only `file:` URIs and URIs without an authority pass.
	 * - `filter`: `file:` URIs and URIs without an authority always pass; other
	 *   URIs are checked against the allowed/denied domain lists.
	 * @param toolName Optional tool name for sandbox-only filtering.
	 * @returns `true` if the URI is allowed, `false` if blocked.
	 */
	isUriAllowed(uri: URI, toolName?: string): boolean;

	/**
	 * Formats an error message for a blocked URI based on the current filter configuration.
	 * @param uri The URI that was blocked.
	 * @returns A localized error message explaining that access to the URI is blocked by policy.
	 */
	formatError(uri: URI): string;

	/**
	 * Fires when the filter configuration changes.
	 */
	readonly onDidChange: Event<void>;
}

export class AgentNetworkFilterService extends Disposable implements IAgentNetworkFilterService {
	readonly _serviceBrand: undefined;

	private networkFilterMode: AgentNetworkFilterMode = AgentNetworkFilterMode.DenyAll;
	private terminalSandboxEnabled = false;
	private allowedPatterns: string[] = [];
	private deniedPatterns: string[] = [];
	private readonly domainCache = new LRUCache<string, boolean>(100);

	private readonly onDidChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITerminalSandboxService private readonly terminalSandboxService: ITerminalSandboxService,
	) {
		super();
		this.readConfiguration();
		void this.updateTerminalSandboxEnabled();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (
				e.affectsConfiguration(AgentNetworkDomainSettingId.NetworkFilter) ||
				e.affectsConfiguration(AgentNetworkDomainSettingId.NetworkFilterMode) ||
				e.affectsConfiguration(AgentNetworkDomainSettingId.AllowedNetworkDomains) ||
				e.affectsConfiguration(AgentNetworkDomainSettingId.DeniedNetworkDomains)
			) {
				this.readConfiguration();
				this.onDidChangeEmitter.fire();
			} else if (
				e.affectsConfiguration(AgentSandboxSettingId.AgentSandboxEnabled) ||
				e.affectsConfiguration(AgentSandboxSettingId.DeprecatedAgentSandboxEnabled)
			) {
				void this.updateTerminalSandboxEnabled();
			}
		}));
	}

	private readConfiguration(): void {
		this.networkFilterMode = this.resolveMode(
			this.configurationService.getValue<AgentNetworkFilterMode>(AgentNetworkDomainSettingId.NetworkFilterMode),
		);

		this.allowedPatterns = this.configurationService.getValue<string[]>(AgentNetworkDomainSettingId.AllowedNetworkDomains) ?? [];
		this.deniedPatterns = this.configurationService.getValue<string[]>(AgentNetworkDomainSettingId.DeniedNetworkDomains) ?? [];
		this.domainCache.clear();
	}

	/**
	 * Resolves the effective filter mode.
	 * Prefers the explicit `chat.agent.networkFilterMode` setting; if it is unset or
	 * invalid, falls back to the legacy boolean `chat.agent.networkFilter`
	 * (`true` -> `filter`, `false`/`undefined` -> `off`).
	 */
	private resolveMode(mode: AgentNetworkFilterMode | undefined): AgentNetworkFilterMode {
		switch (mode) {
			case AgentNetworkFilterMode.Off:
			case AgentNetworkFilterMode.Filter:
			case AgentNetworkFilterMode.DenyAll:
				return mode;
			default: {
				const legacyEnabled = this.configurationService.getValue<boolean>(AgentNetworkDomainSettingId.NetworkFilter) ?? false;
				return legacyEnabled ? AgentNetworkFilterMode.Filter : AgentNetworkFilterMode.Off;
			}
		}
	}

	private async updateTerminalSandboxEnabled(): Promise<void> {
		const [isSandboxEnabled, isSandboxAllowNetworkEnabled] = await Promise.all([
			this.terminalSandboxService.isEnabled(),
			this.terminalSandboxService.isSandboxAllowNetworkEnabled(),
		]);
		const enabled = isSandboxEnabled && !isSandboxAllowNetworkEnabled;
		if (this.terminalSandboxEnabled === enabled) {
			return;
		}
		this.terminalSandboxEnabled = enabled;
		this.readConfiguration();
		this.onDidChangeEmitter.fire();
	}

	isUriAllowed(uri: URI, toolName?: string): boolean {
		switch (this.networkFilterMode) {
			case AgentNetworkFilterMode.Off:
				// Filtering is fully disabled. The terminal sandbox may still gate the
				// fetch web tool when non-sandboxed network access is disallowed.
				if (this.terminalSandboxEnabled) {
					if (toolName === AgentNetworkFilterFetchWebToolName) {
						return this.isDomainAllowedByLists(uri);
					}
					return true;
				}
				return true;

			case AgentNetworkFilterMode.DenyAll:
				// Only local / authority-less resources pass; every network URI is blocked.
				if (uri.scheme === 'file' || !uri.authority) {
					return true;
				}
				return false;

			case AgentNetworkFilterMode.Filter:
			default:
				return this.isDomainAllowedByLists(uri);
		}
	}

	/**
	 * `filter` mode logic: `file:` URIs and URIs without an authority always pass;
	 * other URIs are checked against the configured allowed/denied domain lists.
	 */
	private isDomainAllowedByLists(uri: URI): boolean {
		// File URIs and URIs without authority always pass.
		if (uri.scheme === 'file' || !uri.authority) {
			return true;
		}

		const domain = extractDomainFromUri(uri);
		if (!domain) {
			return true;
		}

		let result = this.domainCache.get(domain);
		if (result === undefined) {
			result = isDomainAllowed(domain, this.allowedPatterns, this.deniedPatterns);
			this.domainCache.set(domain, result);
		}

		return result;
	}

	formatError(uri: URI): string {
		const domain = extractDomainFromUri(uri);
		return localize(
			'networkFilter.blockedByPolicy',
			'Access to {0} is blocked by network domain policy (see `{1}` and `{2}` settings).',
			domain ?? uri.authority,
			AgentNetworkDomainSettingId.AllowedNetworkDomains,
			AgentNetworkDomainSettingId.DeniedNetworkDomains,
		);
	}
}
