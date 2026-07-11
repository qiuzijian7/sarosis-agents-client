/*---------------------------------------------------------------------------------------------
 *  IKbNativeKernelService — shared KB native kernel accessor.
 *
 *  `KbNativeKernel` lives inside `KnowledgeBaseView` as an instance field and
 *  is expensive to build (it scans the whole vault). The BlockSuite KB note
 *  editor (`KbBlocksEditorPane`) needs the same backlink/mention data, but it
 *  cannot construct its own kernel without re-scanning the vault.
 *
 *  This service lets `KnowledgeBaseView` register its already-built kernel (and
 *  the roots used to build it) so the editor pane can share it — one index, one
 *  scan, fresh data for both surfaces. If the editor pane opens a note before
 *  the KB view has ever built the kernel, the service can lazily build from the
 *  recorded roots (no-op if no context was ever recorded).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { KbNativeKernel, INativeBacklinkResult } from './views/knowledgeBase/kbNativeKernel.js';
import { KbSection } from './views/knowledgeBase/kbTypes.js';

export interface IKbBuildRoot {
	uri: URI;
	section: KbSection;
}

export const IKbNativeKernelService = createDecorator<IKbNativeKernelService>('kbNativeKernelService');

export interface IKbNativeKernelService {
	readonly _serviceBrand: undefined;

	/** KnowledgeBaseView registers its kernel here so other surfaces can share it. */
	setKernel(kernel: KbNativeKernel): void;

	/** KnowledgeBaseView records the roots + cache URI used to build, for lazy build. */
	setBuildContext(roots: IKbBuildRoot[], persistUri?: URI): void;

	/** Ensure the shared kernel is built (no-op if already built or no context). */
	ensureBuilt(): Promise<void>;

	/**
	 * Drop the kernel index (e.g. after this editor writes a `.md` so the next
	 * backlink fetch rebuilds from the freshly written file). Safe no-op if no
	 * kernel is registered yet.
	 */
	invalidate(): void;

	/** Fetch backlinks + mentions for a doc URI. Safe before/without the KB view. */
	getBacklinks(docId: string): Promise<INativeBacklinkResult>;

	/** Enumerate all notes in the vault (for the webview wikilink resolver). */
	getWorkspaceFiles(): Promise<{ uri: string; name: string }[]>;
}

export class KbNativeKernelService extends Disposable implements IKbNativeKernelService {
	readonly _serviceBrand: undefined;

	private _kernel: KbNativeKernel | undefined;
	private _roots: IKbBuildRoot[] = [];
	private _persistUri: URI | undefined;
	private _building: Promise<void> | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	setKernel(kernel: KbNativeKernel): void {
		this._kernel = kernel;
	}

	setBuildContext(roots: IKbBuildRoot[], persistUri?: URI): void {
		this._roots = roots;
		this._persistUri = persistUri;
	}

	async ensureBuilt(): Promise<void> {
		if (!this._kernel) {
			this._kernel = new KbNativeKernel(this._fileService);
		}
		if (this._kernel.isBuilt) {
			return;
		}
		if (this._roots.length === 0) {
			return;
		}
		if (!this._building) {
			this._building = this._kernel
				.build(this._roots, this._persistUri)
				.finally(() => { this._building = undefined; });
		}
		return this._building;
	}

	async getBacklinks(docId: string): Promise<INativeBacklinkResult> {
		// Limitation ①: if the KB view never registered build context (user opened
		// a note before the KB view was ever instantiated), infer the vault root
		// from the note URI so we can still lazily build + return real backlinks.
		if (this._roots.length === 0) {
			await this._inferBuildContext(docId);
		}
		await this.ensureBuilt();
		if (!this._kernel) {
			return { backlinks: [], backmentions: [], backlinksBlockCount: 0, backmentionsBlockCount: 0 };
		}
		return this._kernel.getBacklink2(docId);
	}

	async getWorkspaceFiles(): Promise<{ uri: string; name: string }[]> {
		if (this._roots.length === 0) {
			// No build context recorded yet — try to infer from any open note.
			// getBacklinks infers lazily; mirror that by ensuring a built kernel.
			await this.ensureBuilt();
		} else {
			await this.ensureBuilt();
		}
		if (!this._kernel) {
			return [];
		}
		return this._kernel.listNotes();
	}

	/**
	 * Walk up from a note URI to locate the vault root via the `.kbkernel.json`
	 * cache marker that `KnowledgeBaseView.rebuildSearchAssets` writes under the
	 * vault root. When found, record the `库`/`笔记` section roots + cache URI so
	 * the shared kernel can build without the KB view having run first.
	 *
	 * This is best-effort: if no marker exists (cold start, KB view never built),
	 * we silently leave `_roots` empty and `getBacklinks` returns an empty result.
	 */
	private async _inferBuildContext(docId: string): Promise<void> {
		if (this._roots.length > 0) {
			return;
		}
		let start: URI;
		try {
			start = URI.parse(docId);
		} catch {
			return;
		}
		const KB_CACHE = '.kbkernel.json';
		const SECTION_FOLDERS: ReadonlyArray<readonly [string, KbSection]> = [
			['库', 'library'],
			['笔记', 'notes'],
		];
		let cur: URI | undefined = dirname(start);
		for (let depth = 0; depth < 12 && cur; depth++) {
			try {
				if (await this._fileService.exists(URI.joinPath(cur, KB_CACHE))) {
					this._roots = SECTION_FOLDERS.map(([name, section]) => ({
						uri: URI.joinPath(cur!, name),
						section,
					}));
					this._persistUri = URI.joinPath(cur, KB_CACHE);
					return;
				}
			} catch {
				// ignore stat error and climb further up
			}
			const parent = dirname(cur);
			if (parent.toString() === cur.toString()) {
				break; // reached filesystem root
			}
			cur = parent;
		}
	}

	invalidate(): void {
		// Mark the shared kernel stale so the next `getBacklinks` triggers an
		// incremental reconcile that picks up the just-written `.md`. Any in-flight
		// build is left to finish; the subsequent build() reconciles fresh data.
		this._kernel?.invalidate();
	}
}
