/*---------------------------------------------------------------------------------------------
 *  visual/bridgeStub.mjs — nodeCard / runtime / harness **两套宿主共用**的 bridge 桩。
 *
 *  ★ 为什么是 .mjs：Node 侧 runner（run-browser-test.mjs 的 esbuild 插件只解析
 *    .js→.ts）与浏览器侧都要 import，.ts 无法直接被 Node ESM 加载。
 *  ★ 必须**先于任何 workflowEditor 模块 import** 调用 installBridgeMock——
 *    nodeExecutor.ts:24 顶层解构 globalThis.__vssarosBridge，模块求值即 throw。
 *
 *  行为契约（对齐 testing-guide「沙箱选项」）：
 *    - mode 'browser'：fetch 返回内联 SVG 假图（确定性，截图基线稳定）
 *    - mode 'node'   ：fetch 返回 404（Node 侧只验证执行逻辑，不需要图）
 *
 *  ★ 原文件在误删事故中丢失且 Local History 无快照（外部工具创建的文件不入编辑器
 *    历史）。本版本按调用契约重写，并对未知方法用 Proxy 兜底返回桩值——防止产品
 *    代码新增 bridge 方法时沙箱崩溃。如找到原文件备份，直接覆盖本文件即可。
 *--------------------------------------------------------------------------------------------*/

/** 确定性假图（内联 SVG data URL，固定尺寸/颜色，无随机——像素基线稳定）。 */
export function fakeImageSvg() {
	return 'data:image/svg+xml;utf8,' + encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
		'<rect width="512" height="512" fill="#0e2a47"/>' +
		'<circle cx="256" cy="210" r="110" fill="#3fb950" opacity="0.85"/>' +
		'<rect x="96" y="330" width="320" height="110" rx="12" fill="#d29922" opacity="0.75"/>' +
		'</svg>');
}

/** 旧导出名兼容（部分调用点引用）。 */
export const fakeImageDataUrl = fakeImageSvg;

/**
 * 构造 bridge 桩。
 * @param {'node'|'browser'} mode fetch 桩行为
 * @param {{state?: object}} opts getState 返回的宿主状态（可注入演示数据）
 */
export function createBridgeStub(mode = 'browser', opts = {}) {
	const calls = [];
	const state = opts.state ?? {};
	const stubFetch = async (input, init) => {
		const url = typeof input === 'string' ? input : String((input && input.url) || input);
		calls.push(url);
		if (mode === 'node') {
			return new Response(JSON.stringify({ error: 'bridgeStub: offline (node mode)' }), {
				status: 404, headers: { 'content-type': 'application/json' } });
		}
		// ★ body 必须是 **SVG 图像本体**，不能是 fakeImageSvg() 的 data URL 字符串：
		//   下游物化管线（view URL → blob → FileReader.readAsDataURL）会把响应体
		//   再包一层 base64 → 「data:image/svg+xml;base64,ZGF0YTpp…」双层 data URL
		//   → EmojiStage sheet 切分 <img> 解码失败（表情图集解码失败）。
		const dataUrl = fakeImageSvg();
		const body = dataUrl.startsWith('data:')
			? decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1))
			: dataUrl;
		return new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
	};
	const core = {
		__calls: calls,
		__mode: mode,
		createComfyFetch: () => stubFetch,
		createProxiedFetch: () => stubFetch,
		sendRequest: async (method, params) => {
			calls.push(String(method));
			return { ok: true, data: state };
		},
		postMessage: (msg) => { calls.push('postMessage:' + String(msg && msg.type)); return undefined; },
		getState: () => state,
	};
	// ★ Proxy 兜底：产品代码新增的 bridge 方法一律返回异步桩值（不崩、可记录）
	return new Proxy(core, {
		get(target, key) {
			if (key in target) { return target[key]; }
			calls.push('?' + String(key));
			return async () => ({ ok: true, data: null });
		},
	});
}

/**
 * 装上 nodeCard 依赖的 bridge（浏览器模式：假图、绝不出网）。
 * 返回 { calls }——calls 是桩内部数组的引用，便于断言「没有真实网络」。
 */
export function installBridgeMock(mode = 'browser') {
	const stub = createBridgeStub(mode);
	globalThis.__vssarosBridge = stub;
	return stub.__calls;
}
