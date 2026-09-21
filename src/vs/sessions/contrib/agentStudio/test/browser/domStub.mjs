/*---------------------------------------------------------------------------------------------
 *  jsdom DOM stub for the agentStudio *browser* test runner.
 *
 *  为什么需要它：浏览器侧模块（如 pluginConfigView.ts）只依赖 DOM，本该能单测；
 *  但 jsdom **不能被 esbuild 打包**（它运行时用 require.resolve 读自带资源，见
 *  node_modules/jsdom/lib/jsdom/living/css/helpers/computed-style.js），
 *  所以由 runner（原生 ESM，路径落在仓库内 ⇒ 能解析到 node_modules）来装载，
 *  测试文件只用 `document` / `window` 全局，不 import jsdom。
 *
 *  惰性：直到第一次访问 `document` / `window` 才真正创建 JSDOM。不碰 DOM 的测试
 *  （占绝大多数）不会为它付任何代价。
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let dom = null;

function ensureDom() {
	if (!dom) {
		const { JSDOM } = require('jsdom');
		dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
	}
	return dom;
}

/**
 * 需要暴露成全局的 DOM 名称 ✓。
 *
 * ⚠ 为什么不能只给 `document`/`window` ✗✓（2026-09-21 实测踩到）：
 * 浏览器侧模块**在加载期**就会写 `class ConnectionObserverElement extends HTMLElement {}` ✗ —
 * 此时若 `HTMLElement` 未定义 ⇒ **模块一 require 就抛** `ReferenceError` ✓，
 * 测试根本跑不到用例（表现为"零输出 + 退出码 0"，极难定位 ✗）。
 */
const DOM_GLOBALS = [
	'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement',
	'HTMLDivElement', 'HTMLSpanElement', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLAnchorElement',
	'HTMLStyleElement', 'HTMLTemplateElement', 'HTMLFormElement', 'HTMLLabelElement',
	'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'ShadowRoot', 'SVGElement', 'Image',
	'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'InputEvent',
	'MutationObserver', 'DOMParser', 'NodeFilter', 'Range', 'DOMRect', 'CSS',
	'customElements', 'navigator',
	'localStorage', 'sessionStorage',
	'FormData', 'Blob', 'File', 'FileReader',
];

/**
 * jsdom **没有**这些（浏览器专有 ✓）—— 但模块**加载期**就会引用它们 ✗（如 `new ResizeObserver(...)`
 * 写在字段初始化里 ✓）⇒ 必须给出**无操作 shim** ✓，否则测试根本跑不到用例 ✗✓。
 */
const NOOP_OBSERVERS = ['ResizeObserver', 'IntersectionObserver', 'PerformanceObserver'];

/** 装载 DOM 全局（已有则不动：浏览器视觉 harness 里可能自带 ✓）。 */
export function installDomStub() {
	if (typeof globalThis.document !== 'undefined' && typeof globalThis.window !== 'undefined') {
		return;
	}
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		get: () => ensureDom().window.document,
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		get: () => ensureDom().window,
	});
	// ── 其余 DOM 全局：**惰性 getter** ✓（不碰 DOM 的测试零成本 ✓；jsdom 缺失的名字保持未定义 ✓）
	for (const name of DOM_GLOBALS) {
		if (globalThis[name] !== undefined) { continue; }
		Object.defineProperty(globalThis, name, {
			configurable: true,
			get: () => ensureDom().window[name],
		});
	}
	// 函数类必须**绑定到 window** ✓（jsdom 的实现依赖 this ✓，脱离调用会抛 Illegal invocation ✗）
	if (globalThis.requestAnimationFrame === undefined) {
		Object.defineProperty(globalThis, 'requestAnimationFrame', {
			configurable: true,
			get: () => ensureDom().window.requestAnimationFrame.bind(ensureDom().window),
		});
	}
	if (globalThis.cancelAnimationFrame === undefined) {
		Object.defineProperty(globalThis, 'cancelAnimationFrame', {
			configurable: true,
			get: () => ensureDom().window.cancelAnimationFrame.bind(ensureDom().window),
		});
	}
	if (globalThis.getComputedStyle === undefined) {
		Object.defineProperty(globalThis, 'getComputedStyle', {
			configurable: true,
			get: () => ensureDom().window.getComputedStyle.bind(ensureDom().window),
		});
	}
	// ── 浏览器专有 observer/matchMedia：jsdom 没有 ⇒ 无操作 shim ✓（够模块加载与基本调用不炸 ✓）
	for (const name of NOOP_OBSERVERS) {
		if (globalThis[name] !== undefined) { continue; }
		globalThis[name] = class {
			observe() { } unobserve() { } disconnect() { } takeRecords() { return []; }
		};
	}
	if (globalThis.matchMedia === undefined) {
		globalThis.matchMedia = () => ({
			matches: false, media: '', onchange: null,
			addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { }, dispatchEvent() { return false; },
		});
	}
}

/** 清空 body —— 用例之间互不干扰（每个用例自行挂载 DOM）。 */
export function resetDomBody() {
	if (!dom) { return; }
	dom.window.document.body.replaceChildren();
}
