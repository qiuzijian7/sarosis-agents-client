/*---------------------------------------------------------------------------------------------
 *  visual/mocks — 让 nodeCard 能在普通浏览器里独立渲染的最小 mock 层。
 *
 *  ★ 顺序约束：`installBridgeMock()` 必须在 **import nodeCard 之前** 调用。
 *    nodeCard.tsx 顶层就解构 `globalThis.__vssarosBridge`（模块求值即抛错），
 *    所以 harness 必须先装 mock、再 `await import('...nodeCard')`。
 *
 *  ★ 确定性约束：所有假图都是内联 SVG data URL（固定尺寸/颜色/无随机），
 *    否则截图基线每次都会 diff。
 *
 *  ★ 单一真源：bridge 的构造逻辑在 `bridgeStub.mjs`（纯 JS，Node mocha 与浏览器
 *    visual 两个宿主共用）。本文件只负责浏览器侧的组装与网络守卫。
 *--------------------------------------------------------------------------------------------*/

import { installBridgeMock as installBridgeStub } from './bridgeStub.mjs';

export { createBridgeStub, fakeImageDataUrl, fakeImageSvg } from './bridgeStub.mjs';
export type { BridgeMode } from './bridgeStub.mjs';

/**
 * 装上 nodeCard 依赖的 bridge（浏览器模式：假图、绝不出网）。
 * 返回被拦下的请求（便于断言"没有真实网络"）。
 */
export function installBridgeMock(): { calls: string[] } {
	return installBridgeStub('browser');
}

/**
 * 屏蔽真实网络：任何漏网的 fetch/Image 请求都会被替换成假图，保证离线可跑。
 *
 * @param allow URL 前缀白名单——命中的请求走真实 fetch。
 *   ★ 画布沙箱「真后端模式」用：放行本地 ComfyUI（`http://127.0.0.1:8188/`）。
 *   画廊 780 场景不传 → 行为与旧版完全一致（全拦，截图基线不受影响）。
 */
export function installNetworkGuard(allow: string[] = []): { blocked: string[] } {
	const blocked: string[] = [];
	const realFetch = globalThis.fetch?.bind(globalThis);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		// data: / blob: 是本地资源，放行
		if (url.startsWith('data:') || url.startsWith('blob:')) {
			return realFetch ? realFetch(input as RequestInfo, init) : new Response('');
		}
		// 白名单命中 → 真实请求（与真实 app 同一条 HTTP 通道）
		if (allow.some(p => url.startsWith(p))) {
			return realFetch ? realFetch(input as RequestInfo, init) : new Response('');
		}
		blocked.push(url);
		return new Response(fakeImageSvgBlocked(), {
			status: 200,
			headers: { 'content-type': 'image/svg+xml' },
		});
	}) as typeof globalThis.fetch;
	return { blocked };
}

/** 被网络守卫拦下时返回的假图（红色，一眼可辨）。 */
function fakeImageSvgBlocked(): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`,
		`<rect width="512" height="512" fill="#450a0a"/>`,
		`<circle cx="256" cy="200" r="96" fill="#f59e0b" opacity="0.85"/>`,
		`<rect x="96" y="330" width="320" height="120" rx="12" fill="#38bdf8" opacity="0.7"/>`,
		`<text x="256" y="480" font-family="monospace" font-size="34" fill="#e2e8f0" text-anchor="middle">BLOCKED</text>`,
		`</svg>`,
	].join('');
}
