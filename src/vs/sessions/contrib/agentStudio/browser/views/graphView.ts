/*---------------------------------------------------------------------------------------------
 *  Graph View - Git Commit History
 *
 *  Displays a visual list of git commits with branch/tag annotations,
 *  author info, and relative timestamps. Replaces the native SCM graph.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { $ } from '../../../../../base/browser/dom.js';
import { IGitCommitService, IGitLogEntry } from '../gitCommitService.js';

export class GraphViewPane extends ViewPane {

	private _container!: HTMLElement;
	private _listContainer!: HTMLElement;
	private _headerInfo!: HTMLElement;
	private _isLoading = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ILogService private readonly _logService: ILogService,
		@IGitCommitService private readonly _gitCommitService: IGitCommitService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('graph-view');
		this._container = container;

		// --- Header: branch info ---
		this._headerInfo = $('div.graph-header');
		container.appendChild(this._headerInfo);

		// --- Commit list ---
		this._listContainer = $('div.graph-list');
		container.appendChild(this._listContainer);

		// Load commits
		this._loadCommits();
	}

	private async _loadCommits(): Promise<void> {
		if (this._isLoading) { return; }
		this._isLoading = true;
		this._listContainer.innerHTML = '<div class="graph-loading">Loading commit history...</div>';

		try {
			const entries = await this._gitCommitService.getLog(100);
			this._renderCommits(entries);
		} catch (err) {
			this._logService.error('[GraphView] Failed to load commits:', err);
			this._listContainer.innerHTML = '<div class="graph-error">Unable to load commit history</div>';
		} finally {
			this._isLoading = false;
		}
	}

	private _renderCommits(entries: IGitLogEntry[]): void {
		this._listContainer.innerHTML = '';

		if (entries.length === 0) {
			this._listContainer.innerHTML = '<div class="graph-empty">No commits found</div>';
			return;
		}

		// Update header with count
		this._headerInfo.innerHTML = `<span class="graph-count">${entries.length} commits</span>`;

		for (const entry of entries) {
			const row = $('div.graph-row');

			// Left: dot + branch line visual
			const left = $('div.graph-left');
			const dot = $('div.graph-dot');
			left.appendChild(dot);
			const line = $('div.graph-line');
			left.appendChild(line);
			row.appendChild(left);

			// Right: commit info
			const right = $('div.graph-right');

			// Message
			const msg = $('div.graph-message');
			msg.textContent = entry.message;
			right.appendChild(msg);

			// Meta row: hash, author, time, refs
			const meta = $('div.graph-meta');

			// Hash
			const hash = $('span.graph-hash');
			hash.textContent = entry.shortHash;
			hash.title = entry.hash;
			meta.appendChild(hash);

			// Author
			const author = $('span.graph-author');
			author.textContent = entry.author;
			meta.appendChild(author);

			// Relative time
			const time = $('span.graph-time');
			time.textContent = entry.relativeDate;
			time.title = entry.date;
			meta.appendChild(time);

			// Branch/tag refs
			if (entry.refs) {
				const refsParts = entry.refs.split(',').map(r => r.trim()).filter(r => r);
				for (const ref of refsParts) {
					const refEl = $('span.graph-ref');
					if (ref.includes('HEAD ->')) {
						refEl.classList.add('graph-ref-head');
						refEl.textContent = ref.replace('HEAD -> ', '');
					} else if (ref.includes('tag:')) {
						refEl.classList.add('graph-ref-tag');
						refEl.textContent = ref.replace('tag: ', '');
					} else if (ref.includes('origin/')) {
						refEl.classList.add('graph-ref-remote');
						refEl.textContent = ref.replace('origin/', '');
					} else {
						refEl.classList.add('graph-ref-branch');
						refEl.textContent = ref;
					}
					meta.appendChild(refEl);
				}
			}

			right.appendChild(meta);
			row.appendChild(right);
			this._listContainer.appendChild(row);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._container) {
			this._container.style.height = `${height}px`;
			this._container.style.overflow = 'auto';
		}
	}
}
