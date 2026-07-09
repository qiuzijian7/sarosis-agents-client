/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbLute.ts — SiYuan Lute Markdown 引擎的共享单例加载器。
 *
 *  复用 SiYuan app/src/protyle/render/setLute.ts 的配置逻辑，但适配为独立运行时
 *  （不依赖 window.siyuan 全局）。通过动态 script 标签加载 vendored lute.min.js，
 *  与 SiYuan 自身的加载方式一致（app/src/window/index.ts 从 CDN 加载）。
 *
 *  设计要点：
 *   - 单例模式，首次调用 getLute() 时创建，后续返回缓存实例
 *   - 支持 `#标签#`、`[[双链]]`、`((块引用))`、超级块、callout 等全语法
 *   - 块级 WYSIWYG 模式（SetProtyleWYSIWYG(true)）对齐 Protyle 编辑器渲染
 *--------------------------------------------------------------------------------------------*/

import { createTrustedTypesPolicy } from '../../../../../../base/browser/trustedTypes.js';

/** 用于设置 <script>.src 的 Trusted Types 策略（vendored lute.min.js 为本地可信文件） */
const luteScriptUrlPolicy = createTrustedTypesPolicy('kbLuteScript', {
	createScriptURL: (value: string) => value,
});

// ---------------------------------------------------------------------------
// Type declarations for window.Lute (vendored from SiYuan stage/protyle/js/lute/lute.min.js)
// ---------------------------------------------------------------------------

export interface ILuteOptions {
	emojis?: Record<string, string>;
	emojiSite?: string;
	headingAnchor?: boolean;
	paragraphBeginningSpace?: boolean;
	sanitize?: boolean;
	listStyle?: boolean;
	lazyLoadImage?: string;
}

export interface ILute {
	/** 创建一个新的 Lute 实例 */
	New(): ILute;

	// -- 配置方法（对齐 SiYuan setLute.ts） --

	SetProtyleWYSIWYG(value: boolean): void;
	SetProtyleMarkNetImg(value: boolean): void;
	SetFileAnnotationRef(value: boolean): void;
	SetHTMLTag2TextMark(value: boolean): void;
	SetTextMark(value: boolean): void;
	SetHeadingID(value: boolean): void;
	SetYamlFrontMatter(value: boolean): void;
	SetHeadingAnchor(value: boolean): void;
	SetInlineMathAllowDigitAfterOpenMarker(value: boolean): void;
	SetToC(value: boolean): void;
	SetIndentCodeBlock(value: boolean): void;
	SetParagraphBeginningSpace(value: boolean): void;
	SetSetext(value: boolean): void;
	SetFootnotes(value: boolean): void;
	SetLinkRef(value: boolean): void;
	SetSanitize(value: boolean): void;
	SetChineseParagraphBeginningSpace(value: boolean): void;
	SetRenderListStyle(value: boolean): void;
	SetImgPathAllowSpace(value: boolean): void;
	SetKramdownIAL(value: boolean): void;
	SetTag(value: boolean): void;
	SetSuperBlock(value: boolean): void;
	SetCallout(value: boolean): void;
	SetInlineAsterisk(value: boolean): void;
	SetInlineUnderscore(value: boolean): void;
	SetSup(value: boolean): void;
	SetSub(value: boolean): void;
	SetInlineMath(value: boolean): void;
	SetGFMStrikethrough1(value: boolean): void;
	SetGFMStrikethrough(value: boolean): void;
	SetMark(value: boolean): void;
	SetSpin(value: boolean): void;
	SetBlockRef(value: boolean): void;
	SetDataTask(value: boolean): void;
	SetExportNormalizeTaskListMarker(value: boolean): void;
	SetArbitraryTaskListItemMarker(value: boolean): void;
	SetEnsureListItemParagraph(value: boolean): void;
	SetUnorderedListMarker(marker: string): void;
	SetSpellcheck(value: boolean): void;
	SetImageLazyLoading(value: string): void;
	PutEmojis(emojis: Record<string, string>): void;
	SetEmojiSite(site: string): void;

	// -- 渲染方法 --

	/** Markdown → Block DOM HTML（块级渲染，含 .protyle-wysiwyg） */
	SpinBlockDOM(dom: string): string;
	/** Block DOM → Markdown */
	BlockDOM2Content(dom: Element): string;
	/** HTML → Block DOM */
	HTML2BlockDOM(html: string): string;
	/** Block DOM → HTML */
	BlockDOM2HTML(dom: string): string;
	/** Markdown → 块级 DOM（核心渲染） */
	Markdown2BlockDOM(markdown: string, lutemd: boolean, options?: unknown): string;
	/** Protyle 预览 */
	ProtylePreview(markdown: string, options?: unknown): string;
}

/** window.Lute 的构造函数签名 */
export interface ILuteConstructor {
	New(): ILute;
}

// ---------------------------------------------------------------------------
// 共享 Lute 单例
// ---------------------------------------------------------------------------

let luteInstance: ILute | undefined;
let luteLoadPromise: Promise<void> | undefined;

/** Lute 加载标记，避免重复注入 script */
let luteScriptInjected = false;

/**
 * 注入 Lute script 标签（从 vendored SiYuan 源加载）。
 * 应在 KB View renderBody 初期调用一次，并 await 返回的 Promise 以确保加载完成。
 *
 * 注意：输入必须是可被 Electron CSP 允许的绝对 URL（如通过
 * `FileAccess.asBrowserUri('vs/.../media/lute/lute.min.js')` 得到），
 * 不要用 './media/...' 相对路径——在 Workbench ViewPane 中相对路径
 * 会解析到 workbench 页面而非扩展 media 目录，导致脚本永远加载不到。
 *
 * @param scriptUrl — 绝对 lute.min.js URL（vscode-file:// 形式）
 * @returns Promise，脚本 onload 时 resolve，onerror 时 reject
 */
export function injectLuteScript(scriptUrl: string): Promise<void> {
	if (typeof (window as unknown as Record<string, unknown>).Lute !== 'undefined') {
		return Promise.resolve();
	}
	if (luteScriptInjected && luteLoadPromise) {
		return luteLoadPromise;
	}
	luteScriptInjected = true;

	luteLoadPromise = new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		// 受文档 CSP 的 trusted-types 指令约束，script.src 必须赋 TrustedScriptURL
		const trustedSrc = luteScriptUrlPolicy
			? (luteScriptUrlPolicy.createScriptURL(scriptUrl) as unknown as string)
			: scriptUrl;
		script.src = trustedSrc;
		script.async = false;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('[KB Lute] failed to load ' + scriptUrl));
		document.head.appendChild(script);
	});
	return luteLoadPromise;
}

/**
 * 等待 Lute 引擎就绪（脚本加载完成且单例已创建），返回 Lute 实例。
 * 在调用任何渲染方法前 await 此函数，避免 window.Lute 尚未就绪导致的渲染失败。
 */
export async function whenLuteReady(options: ILuteOptions = {}): Promise<ILute> {
	if (luteInstance) { return luteInstance; }
	if (luteLoadPromise) { await luteLoadPromise; }
	return getLute(options);
}

/**
 * 获取（首次调用时创建并缓存）共享 Lute 实例。
 *
 * 对齐 SiYuan getLute() → setLute() 的单例模式：
 * 仅在首次创建时应用 options，后续调用直接返回已缓存的实例。
 *
 * @param options — 配置选项（仅在首次创建时生效）
 */
export function getLute(options: ILuteOptions = {}): ILute {
	if (luteInstance) { return luteInstance; }
	luteInstance = createLute(options);
	return luteInstance;
}

/**
 * 异步获取 Lute（等待 script 加载完成）。
 */
export function getLuteAsync(options: ILuteOptions = {}): Promise<ILute> {
	if (luteInstance) { return Promise.resolve(luteInstance); }
	const p = luteLoadPromise ?? Promise.resolve();
	return p.then(() => getLute(options));
}

/**
 * 获取已初始化的 Lute 单例（未创建时返回 undefined）。
 * 对齐 SiYuan getLuteInstance()。
 */
export function getLuteInstance(): ILute | undefined {
	return luteInstance;
}

// ---------------------------------------------------------------------------
// 内部：创建并配置 Lute 实例（对齐 SiYuan setLute.ts 逻辑）
// ---------------------------------------------------------------------------

function createLute(options: ILuteOptions): ILute {
	const Lute = (window as unknown as Record<string, ILuteConstructor>).Lute;
	if (!Lute || !Lute.New) {
		throw new Error('[KB Lute] window.Lute not available — ensure lute.min.js is loaded');
	}

	const lute = Lute.New();

	// 核心配置（对齐 SiYuan setLute.ts，移除 window.siyuan 依赖）
	lute.SetProtyleWYSIWYG(true);
	lute.SetFileAnnotationRef(true);
	lute.SetHTMLTag2TextMark(true);
	lute.SetTextMark(true);
	lute.SetHeadingID(false);
	lute.SetYamlFrontMatter(false);
	lute.SetHeadingAnchor(options.headingAnchor ?? false);
	lute.SetInlineMathAllowDigitAfterOpenMarker(true);
	lute.SetToC(false);
	lute.SetIndentCodeBlock(false);
	lute.SetParagraphBeginningSpace(true);
	lute.SetSetext(false);
	lute.SetFootnotes(false);
	lute.SetLinkRef(false);
	lute.SetSanitize(options.sanitize ?? false);
	lute.SetChineseParagraphBeginningSpace(options.paragraphBeginningSpace ?? true);
	lute.SetRenderListStyle(options.listStyle ?? true);
	lute.SetImgPathAllowSpace(true);
	lute.SetKramdownIAL(true);
	lute.SetTag(true);
	lute.SetSuperBlock(true);
	lute.SetCallout(true);
	lute.SetGFMStrikethrough1(false);
	lute.SetGFMStrikethrough(true);
	lute.SetSpin(true);
	lute.SetBlockRef(true);
	lute.SetUnorderedListMarker('-');
	lute.SetDataTask(true);
	lute.SetExportNormalizeTaskListMarker(true);
	lute.SetArbitraryTaskListItemMarker(true);
	lute.SetEnsureListItemParagraph(true);

	// 可选配置
	if (options.lazyLoadImage) {
		lute.SetImageLazyLoading(options.lazyLoadImage);
	}
	if (options.emojis) {
		lute.PutEmojis(options.emojis);
	}
	if (options.emojiSite) {
		lute.SetEmojiSite(options.emojiSite);
	}

	return lute;
}
