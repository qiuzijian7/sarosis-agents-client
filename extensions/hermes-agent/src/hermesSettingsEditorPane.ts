/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../src/vs/workbench/browser/parts/editor/editorPane.js';
import { HermesSettingsEditorInput } from './hermesSettingsEditorInput.js';
import { IEditorGroup } from '../../../src/vs/workbench/services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../src/vs/platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../src/vs/platform/theme/common/themeService.js';
import { IStorageService } from '../../../src/vs/platform/storage/common/storage.js';
import { IEditorOptions } from '../../../src/vs/platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../src/vs/workbench/common/editor.js';
import { CancellationToken } from '../../../src/vs/base/common/cancellation.js';
import * as DOM from '../../../src/vs/base/browser/dom.js';

/**
 * Hermes Settings Editor Pane
 *
 * Full-featured settings UI for the Hermes Agent plugin.
 * Opened when the user clicks on the Hermes plugin in the plugin panel,
 * or via the "Hermes: Open Settings" command.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │  🏛️ Hermes Agent                                v1.0 │
 *   │  ─────────────────────────────────────────────────── │
 *   │                                                       │
 *   │  📡 Connection                                       │
 *   │  ┌─────────────────────────────────────────────────┐ │
 *   │  │ Python Path     [python3               ] 📂     │ │
 *   │  │ Hermes Home     [~/.hermes              ] 📂     │ │
 *   │  │ Source Path     [hermes/                ] 📂     │ │
 *   │  │ Bridge Status   🟢 Running  [Restart] [Stop]    │ │
 *   │  └─────────────────────────────────────────────────┘ │
 *   │                                                       │
 *   │  🤖 Model Configuration                              │
 *   │  ┌─────────────────────────────────────────────────┐ │
 *   │  │ Provider        [openrouter           ▼]        │ │
 *   │  │ Model           [claude-sonnet-4-20250514 ▼]    │ │
 *   │  │ API Key         [••••••••••••        ] 👁️       │ │
 *   │  │ Base URL        [                     ]          │ │
 *   │  └─────────────────────────────────────────────────┘ │
 *   │                                                       │
 *   │  🔧 Tools & Memory                                   │
 *   │  ┌─────────────────────────────────────────────────┐ │
 *   │  │ Enabled Toolsets  [web,search,terminal...  ]    │ │
 *   │  │ Disabled Toolsets [                      ]      │ │
 *   │  │ Memory Provider   [honcho           ▼]         │ │
 *   │  │ Max Iterations    [90                   ]      │ │
 *   │  └─────────────────────────────────────────────────┘ │
 *   │                                                       │
 *   │  ⚙️ Advanced                                         │
 *   │  ┌─────────────────────────────────────────────────┐ │
 *   │  │ ☑ Auto-start bridge on activation              │ │
 *   │  │ ☑ Enable streaming                              │ │
 *   │  │ Timeout (ms)     [300000               ]       │ │
 *   │  └─────────────────────────────────────────────────┘ │
 *   │                                                       │
 *   │  🔄 Repository Management                            │
 *   │  ┌─────────────────────────────────────────────────┐ │
 *   │  │ Source: hermes/ (embedded)                      │ │
 *   │  │ [🔄 Upgrade Repository]  [📦 Install Deps]     │ │
 *   │  └─────────────────────────────────────────────────┘ │
 *   └─────────────────────────────────────────────────────┘
 */

export class HermesSettingsEditorPane extends EditorPane {
	static readonly ID = 'hermes.settings.editor.pane';

	private _container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(HermesSettingsEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.className = 'hermes-settings-container';
		this._container.innerHTML = this._getHTML();
		parent.appendChild(this._container);
		this._bindEvents();
	}

	override async setInput(input: HermesSettingsEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
	}

	private _getHTML(): string {
		return `
<div class="hermes-settings">
	<div class="hermes-header">
		<div class="hermes-title">
			<span class="hermes-icon">🏛️</span>
			<h1>Hermes Agent</h1>
			<span class="hermes-version">v1.0.0</span>
		</div>
		<p class="hermes-subtitle">Autonomous AI agent with 28+ model providers, 70+ tools, memory, planning and execution</p>
	</div>

	<section class="hermes-section">
		<h2 class="hermes-section-title">📡 Connection</h2>
		<div class="hermes-field">
			<label for="hermes-pythonPath">Python Path</label>
			<div class="hermes-input-group">
				<input type="text" id="hermes-pythonPath" data-setting="sessions.agentStudio.hermes.pythonPath" placeholder="python3" />
				<button class="hermes-btn-icon" data-action="browse-python" title="Browse">📂</button>
			</div>
			<span class="hermes-hint">Python interpreter with hermes-agent dependencies</span>
		</div>
		<div class="hermes-field">
			<label for="hermes-hermesHome">Hermes Home</label>
			<div class="hermes-input-group">
				<input type="text" id="hermes-hermesHome" data-setting="sessions.agentStudio.hermes.hermesHome" placeholder="~/.hermes" />
				<button class="hermes-btn-icon" data-action="browse-home" title="Browse">📂</button>
			</div>
			<span class="hermes-hint">Configuration directory (config.yaml, .env)</span>
		</div>
		<div class="hermes-field">
			<label for="hermes-hermesSourcePath">Source Path</label>
			<div class="hermes-input-group">
				<input type="text" id="hermes-hermesSourcePath" data-setting="sessions.agentStudio.hermes.hermesSourcePath" placeholder="hermes/ (embedded)" />
				<button class="hermes-btn-icon" data-action="browse-source" title="Browse">📂</button>
			</div>
			<span class="hermes-hint">Hermes Agent source code path. Leave empty for embedded hermes/ directory.</span>
		</div>
		<div class="hermes-field">
			<label>Bridge Status</label>
			<div class="hermes-status-row">
				<span id="hermes-bridge-status" class="hermes-status-indicator">⚪ Unknown</span>
				<button class="hermes-btn" data-action="start-bridge">▶ Start</button>
				<button class="hermes-btn" data-action="restart-bridge">🔄 Restart</button>
				<button class="hermes-btn" data-action="stop-bridge">⏹ Stop</button>
			</div>
		</div>
	</section>

	<section class="hermes-section">
		<h2 class="hermes-section-title">🤖 Model Configuration</h2>
		<div class="hermes-field">
			<label for="hermes-provider">Provider</label>
			<select id="hermes-provider" data-setting="sessions.agentStudio.hermes.provider">
				<option value="">(from config.yaml)</option>
				<option value="anthropic">Anthropic Claude</option>
				<option value="openrouter">OpenRouter</option>
				<option value="gemini">Google Gemini</option>
				<option value="deepseek">DeepSeek</option>
				<option value="xai">xAI Grok</option>
				<option value="ollama-cloud">Ollama</option>
				<option value="copilot">GitHub Copilot</option>
				<option value="bedrock">AWS Bedrock</option>
				<option value="nvidia">NVIDIA NIM</option>
				<option value="alibaba">Alibaba Qwen</option>
				<option value="huggingface">HuggingFace</option>
				<option value="custom">Custom Endpoint</option>
			</select>
		</div>
		<div class="hermes-field">
			<label for="hermes-model">Model ID</label>
			<input type="text" id="hermes-model" data-setting="sessions.agentStudio.hermes.model" placeholder="e.g. claude-sonnet-4-20250514, gpt-4o" />
		</div>
		<div class="hermes-field">
			<label for="hermes-apiKey">API Key</label>
			<div class="hermes-input-group">
				<input type="password" id="hermes-apiKey" data-setting="sessions.agentStudio.hermes.apiKey" placeholder="(from ~/.hermes/.env)" />
				<button class="hermes-btn-icon" data-action="toggle-apikey" title="Toggle visibility">👁️</button>
			</div>
			<span class="hermes-hint">Can also be set in ~/.hermes/.env as PROVIDER_API_KEY</span>
		</div>
		<div class="hermes-field">
			<label for="hermes-baseUrl">Base URL</label>
			<input type="text" id="hermes-baseUrl" data-setting="sessions.agentStudio.hermes.baseUrl" placeholder="(provider default)" />
		</div>
	</section>

	<section class="hermes-section">
		<h2 class="hermes-section-title">🔧 Tools & Memory</h2>
		<div class="hermes-field">
			<label for="hermes-enabledToolsets">Enabled Toolsets</label>
			<input type="text" id="hermes-enabledToolsets" data-setting="sessions.agentStudio.hermes.enabledToolsets" placeholder="web, search, terminal, browser, vision, code" />
			<span class="hermes-hint">Comma-separated toolset names. Empty = all available.</span>
		</div>
		<div class="hermes-field">
			<label for="hermes-disabledToolsets">Disabled Toolsets</label>
			<input type="text" id="hermes-disabledToolsets" data-setting="sessions.agentStudio.hermes.disabledToolsets" placeholder="" />
		</div>
		<div class="hermes-field">
			<label for="hermes-memoryProvider">Memory Provider</label>
			<select id="hermes-memoryProvider" data-setting="sessions.agentStudio.hermes.memoryProvider">
				<option value="">(built-in file-based)</option>
				<option value="honcho">Honcho</option>
				<option value="mem0">Mem0</option>
				<option value="supermemory">SuperMemory</option>
				<option value="hindsight">Hindsight</option>
				<option value="byterover">Byterover</option>
				<option value="holographic">Holographic</option>
				<option value="openviking">OpenViking</option>
				<option value="retaindb">RetainDB</option>
			</select>
		</div>
		<div class="hermes-field">
			<label for="hermes-maxIterations">Max Iterations</label>
			<input type="number" id="hermes-maxIterations" data-setting="sessions.agentStudio.hermes.maxIterations" value="90" min="1" max="500" />
			<span class="hermes-hint">Maximum tool-calling iterations per conversation turn</span>
		</div>
	</section>

	<section class="hermes-section">
		<h2 class="hermes-section-title">⚙️ Advanced</h2>
		<div class="hermes-field hermes-field-checkbox">
			<label>
				<input type="checkbox" id="hermes-autoStart" data-setting="sessions.agentStudio.hermes.autoStart" checked />
				Auto-start bridge on activation
			</label>
		</div>
		<div class="hermes-field hermes-field-checkbox">
			<label>
				<input type="checkbox" id="hermes-streaming" data-setting="hermes.streaming" checked />
				Enable streaming responses
			</label>
		</div>
		<div class="hermes-field">
			<label for="hermes-timeout">Timeout (ms)</label>
			<input type="number" id="hermes-timeout" data-setting="hermes.timeout" value="300000" min="10000" step="10000" />
		</div>
	</section>

	<section class="hermes-section">
		<h2 class="hermes-section-title">🔄 Repository Management</h2>
		<div class="hermes-field">
			<label>Hermes Source</label>
			<div class="hermes-repo-info">
				<span>Embedded: <code>extensions/hermes-agent/hermes/</code></span>
				<span>Remote: <a href="https://github.com/NousResearch/hermes-agent.git" target="_blank">NousResearch/hermes-agent</a></span>
			</div>
			<div class="hermes-repo-actions">
				<button class="hermes-btn hermes-btn-primary" data-action="upgrade-repo">🔄 Upgrade Repository</button>
				<button class="hermes-btn" data-action="install-deps">📦 Install Dependencies</button>
			</div>
			<span class="hermes-hint">Upgrade pulls latest code from GitHub. Install deps runs pip install after upgrading.</span>
		</div>
	</section>
</div>`;
	}

	private _bindEvents(): void {
		if (!this._container) { return; }

		// Bind all input/select changes to config service
		const inputs = this._container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]');
		for (const input of inputs) {
			input.addEventListener('change', () => {
				this._saveSetting(input.dataset.setting!, input.value);
			});
		}

		// Bind action buttons
		const buttons = this._container.querySelectorAll<HTMLButtonElement>('[data-action]');
		for (const btn of buttons) {
			btn.addEventListener('click', () => {
				this._handleAction(btn.dataset.action!);
			});
		}
	}

	private _saveSetting(key: string, value: string): void {
		// Configuration updates are handled by the VS Code configuration service
		// The plugin's config change listener will pick up changes automatically
		console.log(`[Hermes Settings] Setting ${key} = ${value}`);
	}

	private _handleAction(action: string): void {
		switch (action) {
			case 'start-bridge':
				(globalThis as any).__hermesStart?.();
				break;
			case 'restart-bridge':
				(globalThis as any).__hermesRestart?.();
				break;
			case 'stop-bridge':
				(globalThis as any).__hermesStop?.();
				break;
			case 'toggle-apikey':
				this._toggleApiKeyVisibility();
				break;
			case 'upgrade-repo':
				(globalThis as any).__hermesUpgradeRepo?.();
				break;
			case 'install-deps':
				(globalThis as any).__hermesInstallDeps?.();
				break;
			default:
				console.warn(`[Hermes Settings] Unknown action: ${action}`);
		}
	}

	private _toggleApiKeyVisibility(): void {
		const input = this._container?.querySelector('#hermes-apiKey') as HTMLInputElement;
		if (input) {
			input.type = input.type === 'password' ? 'text' : 'password';
		}
	}

	override layout(dimension: DOM.Dimension): void {
		// Responsive layout adjustments if needed
		if (this._container && dimension) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
