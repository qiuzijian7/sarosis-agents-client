/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensions.js';

// ─── Contribution Point Types ─────────────────────────────────────────

/**
 * Supported field types for the agentStudioSettingsTab contribution point.
 *
 * Each type maps to a specific input control in the settings renderer:
 * - `text`       → <input type="text">
 * - `password`   → <input type="password">
 * - `number`     → <input type="number">
 * - `boolean`    → toggle switch
 * - `select`     → <select> dropdown
 * - `json`       → <textarea> with JSON validation
 * - `textarea`   → <textarea> plain text
 */
export type SettingsFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'json' | 'textarea';

/**
 * Describes a single settings field declared in a plugin's package.json.
 *
 * Example package.json contribution:
 * ```json
 * "fields": [
 *   {
 *     "key": "knot.auth.token",
 *     "label": "API TOKEN",
 *     "description": "个人或团队 Token",
 *     "type": "password",
 *     "placeholder": "粘贴你的 Token"
 *   }
 * ]
 * ```
 */
export interface ISettingsFieldDescriptor {
	/** VS Code configuration key (e.g. "knot.auth.token") */
	key: string;
	/** Human-readable label */
	label: string;
	/** Short description shown below the label */
	description?: string;
	/** Input type */
	type: SettingsFieldType;
	/** Placeholder text for text-like inputs */
	placeholder?: string;
	/** Default value (used when config has no value yet) */
	default?: string | number | boolean | unknown[];
	/** Options for `select` type */
	options?: string[];
	/** Rows for `json` / `textarea` type (default 6) */
	rows?: number;
	/** Minimum value for `number` type */
	min?: number;
	/** Maximum value for `number` type */
	max?: number;
	/** Optional hyperlink shown after the description text */
	link?: { label: string; href: string };
}

/**
 * Describes a custom action button in the settings tab.
 *
 * Actions are rendered as buttons at the bottom of the settings tab.
 * Built-in actions:
 * - "save" — always rendered (saves all field values to config)
 *
 * Custom actions are dispatched via the `onDidTriggerAction` event.
 * The extension can listen for its action IDs and handle them.
 */
export interface ISettingsActionDescriptor {
	/** Unique action ID within this tab (e.g. "testConnection") */
	id: string;
	/** Button label (e.g. "测试连接") */
	label: string;
	/** Optional CSS class for styling (e.g. "danger", "secondary") */
	cssClass?: string;
}

/**
 * The full descriptor for a settings tab contributed by an extension.
 *
 * Declared in `package.json` under `contributes.agentStudioSettingsTab`.
 */
export interface ISettingsTabDescriptor {
	/** Unique tab ID (e.g. "knot") — must be unique across all extensions */
	id: string;
	/** Tab label shown in the tab bar (e.g. "🔗 Knot") */
	label: string;
	/** Optional `when` clause context key expression for conditional visibility.
	 *  Example: "extensionInstalled == saros-demo-agui" */
	when?: string;
	/** Tab description shown in the section header */
	description?: string;
	/** Hint text shown below the header */
	hint?: string;
	/** The extension ID that contributed this tab (populated at runtime) */
	extensionId?: string;
	/** Settings fields */
	fields: ISettingsFieldDescriptor[];
	/** Custom action buttons */
	actions?: ISettingsActionDescriptor[];
}

/**
 * The shape of the `contributes.agentStudioSettingsTab` object in package.json.
 * Can be a single tab descriptor or an array of tab descriptors.
 */
export type AgentStudioSettingsTabContribution = ISettingsTabDescriptor | ISettingsTabDescriptor[];

// ─── Registry ─────────────────────────────────────────────────────────

export const ISettingsTabRegistry = createDecorator<ISettingsTabRegistry>('settingsTabRegistry');

export interface ISettingsTabRegistry {
	readonly _serviceBrand: undefined;

	/** All discovered settings tab descriptors */
	readonly tabs: ReadonlyArray<ISettingsTabDescriptor>;

	/** Fires when tabs are added/removed (e.g. extension installed/uninstalled) */
	onDidChangeTabs: Event<void>;

	/**
	 * Trigger a rescan of installed extensions for settings tab contributions.
	 * Called automatically on extension registration; can also be called manually.
	 */
	scanExtensions(): Promise<void>;

	/** Get a tab by its unique ID */
	getTab(id: string): ISettingsTabDescriptor | undefined;
}

export class SettingsTabRegistry extends Disposable implements ISettingsTabRegistry {
	declare readonly _serviceBrand: undefined;

	private _tabs: ISettingsTabDescriptor[] = [];
	private readonly _onDidChangeTabs: Emitter<void>;
	readonly onDidChangeTabs: Event<void>;

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();
		this._onDidChangeTabs = this._register(new Emitter<void>());
		this.onDidChangeTabs = this._onDidChangeTabs.event;
		// Auto-scan when extensions are registered
		this.extensionService.whenInstalledExtensionsRegistered().then(() => this.scanExtensions());
	}

	get tabs(): ReadonlyArray<ISettingsTabDescriptor> {
		return this._tabs;
	}

	getTab(id: string): ISettingsTabDescriptor | undefined {
		return this._tabs.find(t => t.id === id);
	}

	async scanExtensions(): Promise<void> {
		const oldCount = this._tabs.length;
		const discovered: ISettingsTabDescriptor[] = [];

		for (const ext of this.extensionService.extensions) {
			const contributes = (ext as any).contributes;
			if (!contributes) { continue; }

			const tabContribution = contributes.agentStudioSettingsTab;
			if (!tabContribution) { continue; }

			const tabs = Array.isArray(tabContribution)
				? tabContribution as ISettingsTabDescriptor[]
				: [tabContribution as ISettingsTabDescriptor];

			for (const tab of tabs) {
				if (!tab.id || !tab.fields) { continue; }

				// Check `when` clause
				if (tab.when) {
					// Simple evaluation: if the when expression is of the form "key == value",
					// check if the extension with that value is installed
					if (tab.when.includes('==')) {
						const [, expectedExtId] = tab.when.split('==').map(s => s.trim());
						const isInstalled = this.extensionService.extensions.some((e: any) =>
							e.identifier.value === expectedExtId ||
							e.identifier.value.toLowerCase() === expectedExtId.toLowerCase()
						);
						if (!isInstalled) { continue; }
					}
				}

				discovered.push({
					...tab,
					extensionId: ext.identifier.value,
				});
			}
		}

		this._tabs = discovered;

		if (this._tabs.length !== oldCount) {
			this._onDidChangeTabs.fire();
		}
	}
}
