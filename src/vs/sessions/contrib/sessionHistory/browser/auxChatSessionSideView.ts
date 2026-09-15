/*---------------------------------------------------------------------------------------------
 *  Aux Chat Session Side View
 *
 *  Left side bar for the standalone (auxiliary) chat window that is created by
 *  the Agent Studio "Pop Out Chat to New Window" action.
 *
 *  It hosts the very same session list pane the left sidebar uses in the main
 *  window ({@link SessionHistoryViewPane}) so both surfaces stay in sync, and
 *  adds the chrome the auxiliary window needs:
 *
 *  - drag-to-resize via a vertical sash (170px - 450px, double-click resets)
 *  - collapse/expand to a narrow rail (state persisted)
 *  - width persisted across sessions
 *
 *  Layout is driven by the auxiliary editor part: it calls `layout()` with the
 *  area that is left for the side view and shifts the editor area accordingly.
 *--------------------------------------------------------------------------------------------*/

import './media/auxChatSessionSideView.css';

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Orientation, Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewPaneOptions, ViewPaneShowActions } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IAuxiliaryEditorPart, IAuxiliaryEditorSideView } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { SessionHistoryViewPane } from './sessionHistoryView.js';

/** Synthetic view id — this pane is not registered in any view container. */
const AUX_CHAT_SIDE_VIEW_PANE_ID = 'sessions.auxChatSideView.pane';
/** Dedicated (empty) title menu so the pane header shows no global view actions. */
const AUX_CHAT_SIDE_VIEW_TITLE_MENU = MenuId.for('sessions.auxChatSideView.title');

const WIDTH_KEY = 'sessions.auxChatSideView.width';
const HIDDEN_KEY = 'sessions.auxChatSideView.hidden';

const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 170;
const MAX_WIDTH = 450;

/** Width of the collapsed rail (keeps the expand affordance reachable). */
export const AUX_CHAT_SIDE_VIEW_RAIL_WIDTH = 28;

const HEADER_HEIGHT = 30;
const SASH_SIZE = 4;

export class AuxChatSessionSideView extends Disposable implements IAuxiliaryEditorSideView {

	readonly element: HTMLElement;

	private readonly bodyElement: HTMLElement;
	private readonly collapseButton: HTMLElement;
	private readonly sash: Sash;

	private readonly pane: SessionHistoryViewPane;

	private _width: number;
	private _collapsed: boolean;
	/** Width currently rendered (may be clamped by the window size). */
	private _renderedWidth = 0;
	private _height = 0;
	private _part: IAuxiliaryEditorPart | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	/** Width reserved for this side view; `0` is never reported (rail instead). */
	get width(): number {
		return this._collapsed ? AUX_CHAT_SIDE_VIEW_RAIL_WIDTH : this._width;
	}

	get collapsed(): boolean {
		return this._collapsed;
	}

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._width = this._restoreWidth();
		this._collapsed = this.storageService.getBoolean(HIDDEN_KEY, StorageScope.PROFILE, false);

		// Root: absolutely positioned so the auxiliary window can place it freely
		// (and so it paints above the editor area, which is appended before it).
		this.element = $('.saros-aux-side-view');

		const header = append(this.element, $('.saros-aux-side-view-header'));
		const title = append(header, $('span.saros-aux-side-view-title'));
		title.textContent = localize('auxChatSideView.title', "Sessions");

		this.collapseButton = append(header, $<HTMLAnchorElement>('a.saros-aux-side-view-collapse'));
		this._register(addDisposableListener(this.collapseButton, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.setCollapsed(!this._collapsed);
		}));

		this.bodyElement = append(this.element, $('.saros-aux-side-view-body'));
		// Reuse the standard pane-view styling (`.pane` sizing lives under
		// `.monaco-pane-view` in paneview.css) even though this pane is hosted
		// outside a ViewPaneContainer.
		this.bodyElement.classList.add('monaco-pane-view');

		// Reuse the exact same session list pane as the main window sidebar.
		this.pane = this._register(this.instantiationService.createInstance(SessionHistoryViewPane, {
			id: AUX_CHAT_SIDE_VIEW_PANE_ID,
			title: localize('auxChatSideView.title', "Sessions"),
			titleMenuId: AUX_CHAT_SIDE_VIEW_TITLE_MENU,
			showActions: ViewPaneShowActions.Default,
		} satisfies IViewPaneOptions));

		// The pane renders its own header; this side view provides the chrome.
		this.pane.headerVisible = false;
		this.pane.setOpenGroupResolver(() => this._part?.activeGroup);
		this.bodyElement.appendChild(this.pane.element);
		this.pane.render();
		this.pane.setVisible(true);

		// Resize sash on the right edge.
		this.sash = this._register(new Sash(this.element, {
			getVerticalSashLeft: () => this._renderedWidth - SASH_SIZE,
			getVerticalSashTop: () => 0,
			getVerticalSashHeight: () => this._height,
		}, { orientation: Orientation.VERTICAL, size: SASH_SIZE }));

		let dragStartWidth = this._width;
		this._register(this.sash.onDidStart(() => { dragStartWidth = this._width; }));
		this._register(this.sash.onDidChange(e => {
			if (this._collapsed) {
				return;
			}
			this._applyWidth(dragStartWidth + (e.currentX - e.startX));
		}));
		this._register(this.sash.onDidEnd(() => this._persistWidth()));
		this._register(this.sash.onDidReset(() => {
			this._applyWidth(DEFAULT_WIDTH);
			this._persistWidth();
		}));

		this._updateChrome();
	}

	/**
	 * Bind the auxiliary editor part this side view lives in. Called right after
	 * the window was created; used to open sessions in *this* window.
	 */
	setTargetPart(part: IAuxiliaryEditorPart): void {
		this._part = part;
	}

	layout(width: number, height: number, top: number, left: number): void {
		this._height = height;
		this._renderedWidth = width;

		this.element.style.left = `${left}px`;
		this.element.style.top = `${top}px`;
		this.element.style.height = `${height}px`;
		this.element.style.width = `${width}px`;

		this.sash.layout();
		this._layoutPane();
	}

	//#region Width / collapse

	private _applyWidth(width: number): void {
		const clamped = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
		if (clamped === this._width) {
			return;
		}

		this._width = clamped;
		this._onDidChange.fire();
	}

	private _persistWidth(): void {
		this.storageService.store(WIDTH_KEY, String(this._width), StorageScope.PROFILE, StorageTarget.USER);
	}

	private _restoreWidth(): number {
		const stored = this.storageService.get(WIDTH_KEY, StorageScope.PROFILE);
		const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
		if (Number.isFinite(parsed)) {
			return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed));
		}
		return DEFAULT_WIDTH;
	}

	setCollapsed(collapsed: boolean): void {
		if (this._collapsed === collapsed) {
			return;
		}

		this._collapsed = collapsed;
		this.storageService.store(HIDDEN_KEY, collapsed ? 'true' : 'false', StorageScope.PROFILE, StorageTarget.USER);

		this._updateChrome();
		this._onDidChange.fire();
	}

	private _updateChrome(): void {
		this.element.classList.toggle('collapsed', this._collapsed);
		this.bodyElement.style.display = this._collapsed ? 'none' : '';

		const icon = this._collapsed ? Codicon.layoutSidebarLeft : Codicon.layoutSidebarLeftOff;
		this.collapseButton.className = `saros-aux-side-view-collapse ${ThemeIcon.asClassName(icon)}`;
		this.collapseButton.title = this._collapsed
			? localize('auxChatSideView.expand', "Expand Sessions")
			: localize('auxChatSideView.collapse', "Collapse Sessions");
		this.collapseButton.setAttribute('aria-label', this.collapseButton.title);

		this.sash.state = this._collapsed ? SashState.Disabled : SashState.Enabled;
	}

	//#endregion

	private _layoutPane(): void {
		if (this._collapsed) {
			return;
		}

		const width = Math.max(0, this._renderedWidth - SASH_SIZE);
		const height = Math.max(0, this._height - HEADER_HEIGHT);
		try {
			// `Pane.layout(size)` derives the width from `orthogonalSize`.
			this.pane.orthogonalSize = width;
			this.pane.layout(height);
		} catch (err) {
			this.logService.warn('[AuxChatSessionSideView] failed to layout session pane', err);
		}
	}
}
