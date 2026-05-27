/*---------------------------------------------------------------------------------------------
 *  Agent Extension Registry
 *
 *  Allows VS Code extensions to contribute agent templates (presets) to Agent Studio.
 *  Extensions register their templates via the IAgentExtensionRegistry service,
 *  and the gallery/preset view automatically includes them alongside built-in presets.
 *
 *  This mirrors VS Code's PromptsStorage.extension pattern where extensions can
 *  contribute .agent.md files to the native Custom Agent system.
 *
 *  Usage from an extension:
 *    const registry = agentExtensionRegistry;
 *    registry.registerPreset({
 *      id: 'my-extension.my-agent',
 *      name: 'My Custom Agent',
 *      role: 'Specialist',
 *      ...
 *    });
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IAgentHandOff, IAgentHooks, IAgentVisibility } from '../../../common/agentStudioTypes.js';
import type { AgentBootstrapTemplates } from '../../../common/agentStudioTypes.js';

export const IAgentExtensionRegistry = createDecorator<IAgentExtensionRegistry>('agentExtensionRegistry');

/**
 * An agent template contributed by a VS Code extension.
 * Structurally similar to AgentPreset but with additional source tracking.
 */
export interface IExtensionAgentTemplate {
	/** Unique template ID. Convention: "{extensionId}.{templateName}" */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Agent role */
	readonly role: string;
	/** Description shown in the gallery */
	readonly description: string;
	/** Icon (emoji or codicon reference) */
	readonly icon?: string;
	/** Model ID */
	readonly model?: string;
	/** Descriptive skill labels */
	readonly skills?: string[];
	/** Real tool references (qualified tool names) */
	readonly tools?: string[];
	/** Category for filtering */
	readonly category?: string;
	/** System prompt */
	readonly systemPrompt?: string;
	/** Temperature (0-2) */
	readonly temperature?: number;
	/** Bootstrap templates for agent instance directory files */
	readonly bootstrapTemplates?: AgentBootstrapTemplates;
	/** Declarative hand-offs */
	readonly handOffs?: IAgentHandOff[];
	/** Lifecycle hooks */
	readonly hooks?: IAgentHooks;
	/** Visibility control */
	readonly visibility?: IAgentVisibility;
	/** Sub-agent allowlist */
	readonly agents?: string[];

	// ─── Extension-specific fields ──────────────────────────────────────

	/** The extension that contributed this template */
	readonly extensionId: string;
	/** Optional path to the extension's agent definition directory */
	readonly extensionAgentDir?: string;
	/** Priority for ordering (lower = higher priority, default 100) */
	readonly priority?: number;
}

export interface IAgentExtensionRegistry {
	readonly _serviceBrand: undefined;

	/** Fired when templates are added or removed */
	readonly onDidChangeTemplates: Event<void>;

	/**
	 * Register an agent template from an extension.
	 * @param template The template to register
	 * @returns A disposable to unregister the template
	 */
	registerTemplate(template: IExtensionAgentTemplate): IDisposable;

	/**
	 * Get all extension-contributed templates.
	 */
	getTemplates(): ReadonlyArray<IExtensionAgentTemplate>;

	/**
	 * Get templates contributed by a specific extension.
	 */
	getTemplatesByExtension(extensionId: string): ReadonlyArray<IExtensionAgentTemplate>;

	/**
	 * Get a specific template by ID.
	 */
	getTemplate(id: string): IExtensionAgentTemplate | undefined;
}

// ─── Import IDisposable from lifecycle ─────────────────────────────────────────

import { IDisposable, Disposable } from '../../../../base/common/lifecycle.js';

// ═══════════════════════════════════════════════════════════════════════════════

export class AgentExtensionRegistry extends Disposable implements IAgentExtensionRegistry {
	declare readonly _serviceBrand: undefined;

	private readonly _templates = new Map<string, IExtensionAgentTemplate>();
	private readonly _onDidChangeTemplates = this._register(new Emitter<void>());
	readonly onDidChangeTemplates: Event<void> = this._onDidChangeTemplates.event;

	registerTemplate(template: IExtensionAgentTemplate): IDisposable {
		const existing = this._templates.get(template.id);
		if (existing) {
			// Overwrite with newer registration
			this._templates.delete(template.id);
		}

		this._templates.set(template.id, template);
		this._onDidChangeTemplates.fire();

		return toDisposable(() => {
			this._templates.delete(template.id);
			this._onDidChangeTemplates.fire();
		});
	}

	getTemplates(): ReadonlyArray<IExtensionAgentTemplate> {
		return Array.from(this._templates.values())
			.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
	}

	getTemplatesByExtension(extensionId: string): ReadonlyArray<IExtensionAgentTemplate> {
		return this.getTemplates().filter(t => t.extensionId === extensionId);
	}

	getTemplate(id: string): IExtensionAgentTemplate | undefined {
		return this._templates.get(id);
	}
}
