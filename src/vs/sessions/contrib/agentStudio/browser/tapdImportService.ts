/*---------------------------------------------------------------------------------------------
 *  TAPD Import Service
 *
 *  Imports a TAPD workitem (story / bug / task) into a TaskBoardRecord by
 *  extracting its content directly from the browser page's DOM via Playwright.
 *  No MCP server, no TAPD API — just reads the already-open TAPD detail page.
 *
 *  Flow:
 *    1. parse the TAPD URL → workspace_id, type, workitem id
 *    2. run a DOM extraction script inside the browser page via Playwright
 *    3. parse the extracted structured data
 *    4. download description images & attachments (direct URL fetch from page)
 *    5. convert HTML description → Markdown
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { safeSetInnerHtml } from '../../../../base/browser/domSanitize.js';

// ─── Public types ───────────────────────────────────────────────────

export interface TapdImportAttachment {
	name: string;
	mimeType: string;
	base64Content: string;
	size: number;
	downloadUrl?: string;
}

export type TapdWorkitemType = 'story' | 'bug' | 'task';

export interface TapdImportResult {
	id?: string;
	type?: TapdWorkitemType;
	title: string;
	description?: string;
	priority?: string;
	assigneeName?: string;
	status?: string;
	iteration?: string;
	attachments?: TapdImportAttachment[];
	sourceUrl?: string;
	error?: string;
}

export interface TapdImportFilter {
	url?: string;
	name?: string;
	owner?: string;
	status?: string;
	iteration?: string;
	priority?: string;
	workspaceId?: string;
}

export interface TapdImportProject {
	id: string;
	name: string;
	parentId?: string;
	children?: TapdImportProject[];
}

export interface TapdImportFilterOptions {
	statuses: string[];
	iterations: string[];
	priorities: string[];
	projects?: TapdImportProject[];
}

// ─── Internal types ─────────────────────────────────────────────────

interface ParsedTapdUrl {
	workspaceId: string;
	type: 'story' | 'bug' | 'task' | 'wiki';
	id: string;
}

/** Extracted from the page DOM by the Playwright script. */
interface TapdPageData {
	title: string;
	descriptionHtml: string;
	priority?: string;
	owner?: string;
	status?: string;
	iteration?: string;
	type?: string;
	/** Image URLs found in the description. */
	descImageUrls: string[];
	/** Attachment info: { name, url } */
	attachments: { name: string; url: string }[];
	/** Raw extra fields for debugging. */
	_debug?: Record<string, string>;
	/** Snapshot of the extracted DOM (detail container, or full document when
	 *  no container was found) — written to disk for offline debugging/tests. */
	debugHtml?: string;
}

// ─── Playwright DOM extraction script ───────────────────────────────
//
// Runs inside the TAPD workitem detail page. It tries multiple CSS
// selectors for each field so it works across TAPD UI versions.

// Runs on the Node side (Playwright page object available). We delegate the
// actual DOM reading to `page.evaluate(...)` so the code executes inside the
// browser renderer where `document` and `window` exist.
//
// The second argument, `sourceMode`, is computed on the Node side from the
// TAPD URL and tells the browser code where the workitem data lives:
//   - 'detail' : a standalone detail page (…/story/detail/<id>) → read the page
//   - 'dialog' : a list page with a preview dialog (…&dialog_preview_id=…) →
//                read the dialog popup (`.detail-container`), NOT the list.
// ==TAPD_EXTRACT_BODY_START==
// Shared browser-side extraction body. Embedded into TAPD_EXTRACT_SCRIPT for
// Playwright, and reused verbatim by test/tapd/tapdExtract.test.mjs, so the
// offline regression test runs the exact same algorithm as production.
// Receives `document` (browser global) + `sourceMode` ('detail'|'dialog').
const TAPD_EXTRACT_BODY = `
		const $ = (sel, root) => (root || document).querySelector(sel);
		const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
		const text = (sel, root) => { const el = $(sel, root); return el ? (el.textContent || '').trim() : ''; };
		const href = (sel, root) => { const el = $(sel, root); return el ? (el.getAttribute('href') || '') : '' };

		// ── Locate the TAPD detail container (modal / preview panel) ──
		const findRoot = () => (
			document.querySelector('.detail-container') ||
			document.querySelector('.workitem-detail') ||
			document.querySelector('.story-detail, .bug-detail, .task-detail') ||
			document.querySelector('.detail-panel') ||
			document.querySelector('.preview-detail') ||
			document.querySelector('.pop-detail') ||
			document.querySelector('[class*="detailContainer"]') ||
			document.querySelector('.detail-wrap') ||
			null
		);

		const sleep = (ms) => new Promise(r => setTimeout(r, ms));
		const dialogMode = sourceMode === 'dialog';

		// ── Wait for the workitem content to render ──
		// 'dialog' : a list page sits in the background and the workitem data is
		//            shown inside a preview dialog (.detail-container). Wait for
		//            that popup specifically — never read the list page.
		// 'detail' : the page itself IS the workitem detail. Wait for the title to
		//            appear anywhere on the page.
		let root = dialogMode ? findRoot() : null;
		if (dialogMode) {
			for (let i = 0; i < 25 && (!root || !text('.detail-title, h1, .title', root)); i++) {
				await sleep(200);
				root = findRoot();
			}
		} else {
			for (let i = 0; i < 25 && !text('.detail-title, h1, .title', document); i++) {
				await sleep(200);
			}
			root = findRoot();
		}

		// Scope:
		//  - dialog mode → the popup container. Fall back to the whole document
		//    only if the popup never appeared (degraded: may capture the list).
		//  - detail mode → the page's detail container if present, else the whole
		//    document (the page *is* the detail).
		const scope = root || document;

		// ── Title (TAPD: .title-wrap > .tapd-inline-label-selectable[title]) ──
		// WARNING: a bare .title matches section headers like
		// <h4 class="title">附件</h4>, so the title MUST be scoped to .title-wrap.
		const titleEl = (
			$('.title-wrap .tapd-inline-label-selectable', scope) ||
			$('.title-wrap .label-selectable__tag', scope) ||
			$('.detail-title h1', scope) ||
			$('.workitem-title', scope) ||
			$('h1', scope)
		);
		const title = titleEl
			? (titleEl.getAttribute('title') || titleEl.textContent || '').trim()
			: '';

		// ── Type (story / bug / task) ──
		const type = (
			text('.workitem-type', scope) ||
			text('.type-name', scope) ||
			text('[data-label="type"]', scope) ||
			''
		);

		// ── Description HTML (TAPD: .content-wrap > .cherry-editor-content) ──
		// Exclude the translation panel (.translate-content-wrap) which also uses
		// .cherry-editor-content but only holds a "翻译" stub.
		const descEl = (
			$('.content-wrap .cherry-editor-content', scope) ||
			$('.cherry-editor-content', scope) ||
			$('.description-content', scope) ||
			$('.rich-text-content', scope) ||
			$('.t-rich-text-editor', scope) ||
			$('[data-field="description"] .value', scope) ||
			$('.detail-description', scope)
		);
		const descriptionHtml = descEl ? (descEl.innerHTML || '') : '';

		// ── Right-panel field reader ──
		// TAPD markup is inconsistent: some fields use [field-name="x"] (status,
		// owner) and others use [field="x"] (priority). Try both.
		const fieldText = (name, attr) => {
			const el = $('[field-name="' + name + '"], [field="' + name + '"]', scope);
			if (!el) return '';
			if (attr) {
				const v = el.getAttribute(attr);
				if (v) return v.trim();
			}
			return (el.textContent || '').trim();
		};

		// ── Priority (TAPD: [field="priority"] title="Middle") ──
		const priority = fieldText('priority', 'title') || fieldText('priority');

		// ── Owner / Handler (TAPD: [field-name="owner"] title="邱子鉴;") ──
		const ownerRaw = fieldText('owner', 'title') || fieldText('owner');
		const owner = ownerRaw ? ownerRaw.replace(/;+$/, '').trim() : '';

		// ── Status (TAPD: [field-name="status"] → 未开始) ──
		const status = fieldText('status', 'title') || fieldText('status');

		// ── Iteration / Sprint (rarely present; best-effort) ──
		const iteration = fieldText('iteration_id') || fieldText('sprint') || '';

		// ── Description images ──
		const descImageUrls = descEl
			? $$('img', descEl).map(img => img.getAttribute('src') || '').filter(url => url && !url.startsWith('data:'))
			: [];

		// ── Attachments (TAPD: .entity-detail-attachment .attachment-content-detail) ──
		const attRoot = $('.entity-detail-attachment .attachment-content-detail', scope);
		const attachments = [];
		if (attRoot) {
			const items = $$('.draggable-item, .attachment-content-detail__item', attRoot);
			for (const item of items) {
				const link = $('a.link-title', item) || $('a[data-type="download"]', item);
				const name = link
					? (link.getAttribute('file-name') || (link.textContent || '').trim() || link.getAttribute('title') || '')
					: (text('.file-name', item) || '');
				const url = link ? (link.getAttribute('href') || '') : '';
				if (name || url) {
					attachments.push({ name: name || url.split('/').pop() || 'attachment', url });
				}
			}
		}

		// Also look for links inside the description that look like attachment downloads.
		if (descEl && attachments.length === 0) {
			const links = $$('a[href]', descEl);
			for (const a of links) {
				const h = a.getAttribute('href') || '';
				if (/\\.(png|jpg|jpeg|gif|pdf|docx?|xlsx?|zip|rar)$/i.test(h) ||
					(/tapd/i.test(h) && /download|attach/i.test(h))) {
					const n = (a.textContent || '').trim() || h.split('/').pop() || 'attachment';
					if (!attachments.find(x => x.url === h)) {
						attachments.push({ name: n, url: h });
					}
				}
			}
		}

		// ── Debug: capture all visible text fields inside the detail container ──
		const debugFields = {};
		$$('.property-item, .field-item, [class*="property"], .detail-field', scope).slice(0, 30).forEach(el => {
			const label = text('.label, .field-label, .name', el);
			const val = text('.value, .field-value', el);
			if (label && val) { debugFields[label] = val; }
		});
		debugFields['__sourceMode'] = dialogMode ? 'dialog' : 'detail';
		debugFields['__rootFound'] = root ? root.className || 'detail-container' : (dialogMode ? 'none(fellback-to-document)' : 'none(detail-page)');
		debugFields['__titleSource'] = title ? 'detail' : 'empty';

		return {
			title,
			descriptionHtml,
			priority: priority || undefined,
			owner: owner || undefined,
			status: status || undefined,
			iteration: iteration || undefined,
			type: type || undefined,
			descImageUrls,
			attachments,
			_debug: Object.keys(debugFields).length ? debugFields : undefined,
			debugHtml: root ? root.outerHTML : (typeof document !== 'undefined' && document.documentElement ? document.documentElement.outerHTML : ''),
		};
`;

// ==TAPD_EXTRACT_BODY_END==

// Wraps the shared body so it runs inside a real Playwright `page` (where
// `document` exists) and is driven by the URL-derived `sourceMode`.
const TAPD_EXTRACT_SCRIPT = `async (page, sourceMode) => {
	return await page.evaluate(async (sourceMode) => {
		${TAPD_EXTRACT_BODY}
	}, sourceMode);
}`;

// ─── Service ────────────────────────────────────────────────────────

export class TapdImportService {

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IPlaywrightService private readonly _playwrightService: IPlaywrightService,
		@IFileService private readonly _fileService: IFileService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) { }

	// ── Public API ────────────────────────────────────────────────

	/**
	 * Import a single TAPD workitem from the currently open browser page.
	 *
	 * @param sessionId Playwright session ID (use `'saros-claw'` for unattached pages).
	 * @param viewId    Browser view id (== Playwright page id).
	 * @param url       The TAPD workitem URL (used to parse workspace_id / id).
	 */
	async importFromBrowser(
		sessionId: string,
		viewId: string,
		url: string,
		opts?: {
			downloadAttachments?: boolean;
			/** Optional download function — when provided, used instead of
			 *  the internal native fetch().  This allows the caller to pass
			 *  a Playwright-based downloader that carries auth cookies,
			 *  eliminating the dual download path (P2-4 fix). */
			downloadFn?: (url: string) => Promise<string | undefined>;
		},
	): Promise<TapdImportResult> {
		const trimmed = (url || '').trim();
		const parsed = TapdImportService.parseTapdUrl(trimmed);
		if (!parsed) {
			return { title: '', sourceUrl: trimmed, error: '无法解析 TAPD 链接，请确认是 story/bug/task 详情页。' };
		}
		if (parsed.type === 'wiki') {
			return { title: '', sourceUrl: trimmed, error: '暂不支持 wiki 导入。' };
		}

		const download = opts?.downloadAttachments !== false;
		const externalDownloadFn = opts?.downloadFn;
		try {
			// Ensure Playwright can see this page.
			await this._playwrightService.startTrackingPage(viewId);

			// Decide where the workitem data lives based on the URL:
			//  - standalone detail page  → read the page itself
			//  - list page + dialog_preview_id → read the dialog popup
			const sourceMode = TapdImportService._resolveSourceMode(trimmed);
			this._logService.info(`[TapdImportService] Extracting TAPD page DOM via Playwright: session=${sessionId} view=${viewId} sourceMode=${sourceMode}`);

			// Retry up to 3 times with backoff — board‑link views use
			// `getOrCreateLazy` whose Playwright page pairing (FIFO via
			// _viewIdToPage / _viewIdQueue) can lag behind the renderer
			// lifecycle, and CDP Target attach/detach may transiently break
			// the mapping.
			let pageData: TapdPageData | undefined;
			let lastError: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const pd = await this._playwrightService.invokeFunctionRaw<TapdPageData>(
						sessionId,
						viewId,
						TAPD_EXTRACT_SCRIPT,
						sourceMode,
					);
					// Success — break out of retry loop
					pageData = pd;
					break;
				} catch (err) {
					lastError = err;
					const errMsg = err instanceof Error ? err.message : String(err);
					if (/not found/i.test(errMsg) && attempt < 2) {
						this._logService.warn(`[TapdImportService] Playwright page not found (attempt ${attempt + 1}/3), retrying in ${500 + attempt * 500}ms: ${errMsg}`);
						await new Promise(r => setTimeout(r, 500 + attempt * 500));
						// Re‑register tracking in case the view was re‑created
						await this._playwrightService.startTrackingPage(viewId).catch(() => {});
						continue;
					}
					throw err;
				}
			}
			if (!pageData) {
				throw lastError ?? new Error('Page extraction failed after retries');
			}
		if (!pageData || typeof pageData !== 'object') {
			return { title: '', sourceUrl: trimmed, error: '页面提取失败：未能从当前页面读取到 TAPD 数据。请确认页面已加载完毕。' };
		}

		// Dump the page HTML locally so the extraction algorithm can be verified
		// and debugged offline (see test/tapd/tapdExtract.test.mjs).
		if (pageData.debugHtml) {
			try {
				const dumpUri = URI.joinPath(this._environmentService.tmpDir, 'saros-tapd-dump.html');
				await this._fileService.writeFile(dumpUri, VSBuffer.fromString(pageData.debugHtml));
				this._logService.info(`[TapdImportService] Dumped TAPD page HTML → ${dumpUri.fsPath || dumpUri.toString()}`);
			} catch (e) {
				this._logService.warn(`[TapdImportService] Failed to dump TAPD HTML:`, e);
			}
		}

		this._logService.info(`[TapdImportService] Page extracted: title="${pageData.title}" type=${pageData.type ?? '?'} priority=${pageData.priority ?? '?'} imgs=${pageData.descImageUrls.length} atts=${pageData.attachments.length}`);
			if (pageData._debug) {
				this._logService.info(`[TapdImportService] Debug fields: ${JSON.stringify(pageData._debug)}`);
			}

			// Process attachments + description images.
			const attachments: TapdImportAttachment[] = [];
			const urlToName = new Map<string, string>();

			// Description images
			for (let i = 0; i < pageData.descImageUrls.length; i++) {
				const src = pageData.descImageUrls[i];
				const name = `tapd-img-${i + 1}.${this._guessExt(src)}`;
				if (download) {
					const base64 = await this._downloadToBase64(src, externalDownloadFn);
					if (base64) {
						attachments.push({ name, mimeType: this._mimeFromName(name), base64Content: base64, size: this._base64Size(base64), downloadUrl: src });
						urlToName.set(src, name);
					}
				} else {
					attachments.push({ name, mimeType: this._mimeFromName(name), base64Content: '', size: 0, downloadUrl: src });
				}
			}

			// File attachments
			for (const att of pageData.attachments) {
				const name = this._sanitizeName(att.name || `tapd-att-${attachments.length}`);
				if (download && att.url) {
					const base64 = await this._downloadToBase64(att.url, externalDownloadFn);
					if (base64) {
						attachments.push({ name, mimeType: this._mimeFromName(name), base64Content: base64, size: this._base64Size(base64), downloadUrl: att.url });
					}
				} else {
					attachments.push({ name, mimeType: this._mimeFromName(name), base64Content: '', size: 0, downloadUrl: att.url || undefined });
				}
			}

			// Rewrite description <img src> → local references.
			let html = pageData.descriptionHtml || '';
			if (html && download) {
				for (const [imgUrl, name] of urlToName) {
					html = html.split(imgUrl).join(name);
				}
			}
			const description = html ? this._htmlToMarkdown(html) : '';

			const rawPriority = String(pageData.priority ?? '').toLowerCase();
			const priorityLabel =
				/(high|urgent|紧急|高)/i.test(rawPriority) ? 'high' :
				/(low|lowest|低)/i.test(rawPriority) ? 'low' :
				/(mid|medium|中)/i.test(rawPriority) ? 'medium' : (pageData.priority || undefined);

			// Strip any remaining inline base64 data URIs from the description
			// and convert them to proper attachments.  This prevents MB-sized
			// base64 blobs from being stored in taskboard.json and causing regex
			// performance issues on every render/execution cycle.
			let cleanDesc = description;
			if (cleanDesc && cleanDesc.indexOf('data:') !== -1) {
				const dataUriRe = /(?:(!?\[([^\]]*)\]\())?data:([\w/+-]+);base64,([A-Za-z0-9+/=]+)\)?/gi;
				let imgIdx = 0; let fileIdx = 0;
				cleanDesc = cleanDesc.replace(dataUriRe, (_full, _prefix, _alt, mimeType, data) => {
					const isImage = mimeType?.startsWith('image/');
					const counter = isImage ? ++imgIdx : ++fileIdx;
					const name = isImage
						? `tapd-inline-img-${counter}.${mimeType.split('/').pop() || 'png'}`
						: `tapd-inline-file-${counter}`;
					attachments.push({
						name,
						mimeType,
						base64Content: data,
						size: data.length,
					});
					return isImage ? `[图片: ${counter}]` : `[文件: ${counter}]`;
				});
			}

			return {
				id: parsed.id,
				type: parsed.type as TapdWorkitemType,
				title: pageData.title || `TAPD ${parsed.type} ${parsed.id}`,
				description: cleanDesc,
				priority: priorityLabel,
				assigneeName: pageData.owner || undefined,
				status: pageData.status || undefined,
				iteration: pageData.iteration || undefined,
				attachments,
				sourceUrl: this._buildSourceUrl(parsed) || trimmed,
			};
		} catch (err) {
			this._logService.error('[TapdImportService] importFromBrowser failed:', err);
			return { title: '', sourceUrl: trimmed, error: `提取失败: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	/**
	 * Convenience: import from a URL only (backward compat, needs viewId separately).
	 * @deprecated Use `importFromBrowser(sessionId, viewId, url)` instead.
	 */
	async importFromUrl(rawUrl: string, _opts?: { downloadAttachments?: boolean }): Promise<TapdImportResult> {
		return { title: '', sourceUrl: rawUrl, error: '需要浏览器页面 viewId，请使用 importFromBrowser()。' };
	}

	/**
	 * Check whether a name matches a known TAPD MCP server — kept for API
	 * compatibility but always returns `no-server` since we don't use MCP.
	 */
	async checkConnection(): Promise<{ connected: boolean; reason?: string }> {
		return { connected: true }; // always ready (no server dependency)
	}

	async loadFilterOptions(_workspaceId?: string): Promise<TapdImportFilterOptions> {
		return { statuses: [], iterations: [], priorities: [] };
	}

	async queryItems(_filters: TapdImportFilter): Promise<TapdImportResult[]> {
		return [];
	}

	async getItemDetail(item: TapdImportResult, _workspaceId?: string): Promise<TapdImportResult> {
		return { ...item, error: '单条详情需要浏览器页面 viewId，请使用 importFromBrowser()。' };
	}

	// ── URL parsing ───────────────────────────────────────────────

	static parseTapdUrl(url: string): ParsedTapdUrl | null {
		const m = url.match(/tapd_fe\/(\d+)\/(story|bug|task|wiki)(?:\/detail\/|\/view\/|\/)(\d+)/i);
		if (m) {
			return { workspaceId: m[1], type: m[2].toLowerCase() as ParsedTapdUrl['type'], id: m[3] };
		}
		const prev = url.match(/dialog_preview_id=(story|bug|task|wiki)_(\d+)/i);
		if (prev) {
			const ws = url.match(/tapd_fe\/(\d+)/i);
			return {
				workspaceId: ws ? ws[1] : '',
				type: prev[1].toLowerCase() as ParsedTapdUrl['type'],
				id: prev[2],
			};
		}
		const typeId = url.match(/(story|bug|task|wiki)(?:\/detail\/|\/view\/|\/)(\d+)/i);
		const ws = url.match(/tapd_fe\/(\d+)/i);
		if (typeId) {
			return {
				workspaceId: ws ? ws[1] : '',
				type: typeId[1].toLowerCase() as ParsedTapdUrl['type'],
				id: typeId[2],
			};
		}
		return null;
	}

	/**
	 * Decide where the workitem data should be read from, based on the URL:
	 *   - 'dialog' : a list page with a preview dialog open
	 *                (e.g. …/story/list?…&dialog_preview_id=story_xxx) → the data
	 *                lives inside the popup (`.detail-container`).
	 *   - 'detail' : a standalone detail page
	 *                (e.g. …/story/detail/1130076258001093952) → the page itself
	 *                is the workitem detail.
	 */
	private static _resolveSourceMode(url: string): 'detail' | 'dialog' {
		if (/dialog_preview_id=/i.test(url)) {
			return 'dialog';
		}
		if (!/\/list\b/i.test(url) && /(story|bug|task|wiki)(?:\/detail\/|\/view\/|\/)\d+/i.test(url)) {
			return 'detail';
		}
		return 'detail';
	}

	// ── Download helpers ──────────────────────────────────────────

	private async _downloadToBase64(
		url: string,
		externalDownloadFn?: (url: string) => Promise<string | undefined>,
	): Promise<string | undefined> {
		try {
			// When an external download function is provided (e.g. Playwright-based
			// downloadUrlForAttachment that carries auth cookies), use it instead
			// of native fetch.  This eliminates the dual download path where TAPD
			// images were first fetched without auth (failing with 401), then
			// re-downloaded by the caller with Playwright.
			if (externalDownloadFn) {
				const localPath = await externalDownloadFn(url);
				if (!localPath) { return undefined; }
				// externalDownloadFn returns a local file path — read and encode
				const uri = URI.file(localPath);
				const content = await this._fileService.readFile(uri);
				return encodeBase64(content.value);
			}
			// Fallback: native fetch (no auth — only works for public CDN URLs)
			const res = await fetch(url, { redirect: 'follow' });
			if (!res.ok) { return undefined; }
			const buf = await res.arrayBuffer();
			return encodeBase64(VSBuffer.wrap(new Uint8Array(buf)));
		} catch (err) {
			this._logService.warn(`[TapdImportService] download failed for ${url}:`, err);
			return undefined;
		}
	}

	private _base64Size(base64: string): number {
		const padding = (base64.match(/=+$/) || [''])[0].length;
		return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
	}

	// ── HTML → Markdown ───────────────────────────────────────────

	private _htmlToMarkdown(html: string): string {
		if (!html.trim()) { return ''; }
		if (typeof document === 'undefined') {
			return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		}
		// Parse the description HTML through VS Code's sanitizer, which uses the
		// CSP-approved `dompurify` Trusted Types policy. A custom policy name is
		// blocked by the document's `trusted-types` directive, and feeding a raw
		// string into `DOMParser.parseFromString` is rejected ("requires
		// 'TrustedHTML' assignment").
		const root = document.createElement('div');
		safeSetInnerHtml(root, html);
		const md = this._nodeToMarkdown(root);
		return md.replace(/\n{3,}/g, '\n\n').trim();
	}

	private _nodeToMarkdown(node: Node): string {
		if (node.nodeType === 3) {
			return (node.textContent || '').replace(/\s+/g, ' ');
		}
		if (node.nodeType !== 1) { return ''; }
		const el = node as HTMLElement;
		const tag = el.tagName.toLowerCase();
		if (tag === 'script' || tag === 'style' || tag === 'head') { return ''; }

		const children = Array.from(el.childNodes).map(c => this._nodeToMarkdown(c)).join('');
		switch (tag) {
			case 'h1': return `# ${children}\n\n`;
			case 'h2': return `## ${children}\n\n`;
			case 'h3': return `### ${children}\n\n`;
			case 'h4': return `#### ${children}\n\n`;
			case 'h5': return `##### ${children}\n\n`;
			case 'h6': return `###### ${children}\n\n`;
			case 'strong': case 'b': return `**${children}**`;
			case 'em': case 'i': return `*${children}*`;
			case 'code': return `\`${children}\``;
			case 'pre': return `\n\`\`\`\n${children}\n\`\`\`\n\n`;
			case 'a': {
				const href = el.getAttribute('href') || '';
				return href ? `[${children}](${href})` : children;
			}
			case 'img': {
				const src = el.getAttribute('src') || '';
				return src ? `![](${src})` : '';
			}
			case 'br': return '\n';
			case 'p': return `${children}\n\n`;
			case 'div': return `${children}\n`;
			case 'li': return `- ${children}\n`;
			case 'ul': case 'ol': return `${children}\n`;
			case 'blockquote': return children.split('\n').filter(Boolean).map(l => `> ${l}`).join('\n') + '\n\n';
			case 'hr': return `\n---\n\n`;
			default: return children;
		}
	}

	// ── Misc ──────────────────────────────────────────────────────

	private _buildSourceUrl(parsed: { workspaceId: string; type: string; id: string }): string {
		if (!parsed.workspaceId || !parsed.id) { return ''; }
		return `https://www.tapd.cn/tapd_fe/${parsed.workspaceId}/${parsed.type}/detail/${parsed.id}`;
	}

	private _sanitizeName(name: string): string {
		const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
		return cleaned || `tapd-file.${Date.now()}.bin`;
	}

	private _guessExt(url: string): string {
		const m = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
		return m ? m[1].toLowerCase() : 'png';
	}

	private _mimeFromName(name: string): string {
		const ext = name.split('.').pop()?.toLowerCase() || '';
		const map: Record<string, string> = {
			png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
			webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
			pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
		};
		return map[ext] || 'application/octet-stream';
	}
}
