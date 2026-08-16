/*---------------------------------------------------------------------------------------------
 *  visual/mocks — 让 nodeCard 能在普通浏览器里独立渲染的最小 mock 层。
 *
 *  ★ 顺序约束：`installBridgeMock()` 必须在 **import nodeCard 之前** 调用。
 *    nodeCard.tsx 顶层就解构 `globalThis.__vssarosBridge`（模块求值即抛错），
 *    所以 harness 必须先装 mock、再 `await import('...nodeCard')`。
 *
 *  ★ 确定性约束：所有假图都是内联 SVG data URL（固定尺寸/颜色/无随机），
 *    否则截图基线每次都会 diff。
 *--------------------------------------------------------------------------------------------*/

/** 装上 nodeCard 依赖的 bridge。返回被拦下的请求（便于断言"没有真实网络"）。 */
export function installBridgeMock(): { calls: string[] } {
	const calls: string[] = [];
	const proxiedFetch = async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		calls.push(url);
		// 任何真实网络请求都返回一张确定性假图，绝不出网。
		const svg = fakeImageSvg('PROXIED', '#334155');
		return new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
	};
	(globalThis as unknown as Record<string, unknown>).__vssarosBridge = {
		createProxiedFetch: () => proxiedFetch,
		createComfyFetch: () => proxiedFetch,
		getComfyCorsMode: () => 'direct',
		probeDirectCors: async () => true,
		reprobeComfyCors: async () => true,
		subscribeComfyCors: () => () => { /* noop */ },
		sendRequest: async () => ({}),
		postMessage: () => { /* noop */ },
		getState: () => ({}),
		setState: () => { /* noop */ },
		initMessageClient: () => { /* noop */ },
	};
	return { calls };
}

/** 确定性假图：内联 SVG，带文字标签便于人眼分辨来源。 */
export function fakeImageSvg(label: string, bg = '#1e293b'): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">`,
		`<rect width="512" height="512" fill="${bg}"/>`,
		`<circle cx="256" cy="200" r="96" fill="#f59e0b" opacity="0.85"/>`,
		`<rect x="96" y="330" width="320" height="120" rx="12" fill="#38bdf8" opacity="0.7"/>`,
		`<text x="256" y="480" font-family="monospace" font-size="34" fill="#e2e8f0" text-anchor="middle">${label}</text>`,
		`</svg>`,
	].join('');
}

/** 假图的 data URL 形式（snapshot ref 直接吃这个，无需网络）。 */
export function fakeImageDataUrl(label: string, bg?: string): string {
	// 用 encodeURIComponent 而非 base64：产物可读、diff 友好、无 unicode 坑。
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fakeImageSvg(label, bg))}`;
}

/** 屏蔽真实网络：任何漏网的 fetch/Image 请求都会被替换成假图，保证离线可跑。 */
export function installNetworkGuard(): { blocked: string[] } {
	const blocked: string[] = [];
	const realFetch = globalThis.fetch?.bind(globalThis);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		// data: / blob: 是本地资源，放行
		if (url.startsWith('data:') || url.startsWith('blob:')) {
			return realFetch ? realFetch(input as RequestInfo, init) : new Response('');
		}
		blocked.push(url);
		return new Response(fakeImageSvg('BLOCKED', '#450a0a'), {
			status: 200,
			headers: { 'content-type': 'image/svg+xml' },
		});
	}) as typeof globalThis.fetch;
	return { blocked };
}
