/*---------------------------------------------------------------------------------------------
 *  fake 后端 · chat 场景的确定性 PNG view 响应器
 *
 *  背景：networkGuard 拦截产物是 **SVG**，而 EmojiStage 的 sheet 切分要位图解码
 *  （SVG blob 经 <img> 在部分链路解码失败/二次包装），fake 后端的聊天端到端
 *  永远卡在「表情图集解码失败」。chat 场景对 /view? 请求改返回本 PNG（确定性，
 *  无随机——不破坏沙箱「离线可跑」原则；harness 像素基线不受影响——它不进 chat 场景）。
 *--------------------------------------------------------------------------------------------*/

/**
 * fake 模式专用的确定性 PNG sheet（1024²，透明底 2×2 彩色圆）。
 */
function makeFakeSheetPng(): string {
	const c = document.createElement('canvas');
	c.width = 1024;
	c.height = 1024;
	const ctx = c.getContext('2d');
	if (!ctx) { return 'data:image/png;base64,'; }
	const colors = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399'];
	for (let r = 0; r < 2; r++) {
		for (let col = 0; col < 2; col++) {
			ctx.fillStyle = colors[r * 2 + col];
			ctx.beginPath();
			ctx.arc(256 + col * 512, 256 + r * 512, 150, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	return c.toDataURL('image/png');
}

/**
 * fake+chat 场景：/view? 请求返回确定性 PNG（替代守卫的 SVG），其余照旧走守卫。
 * 由 canvasHost.main() 在 `BACKEND==='fake' && chat 场景` 时调用一次。
 */
export function installFakeViewResponder(): void {
	const realFetch = globalThis.fetch.bind(globalThis);
	let pngDataUrl: string | null = null;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
		if (url.includes('/view?')) {
			if (!pngDataUrl) { pngDataUrl = makeFakeSheetPng(); }
			const blob = await (await realFetch(pngDataUrl)).blob();
			return new Response(blob, { status: 200, headers: { 'content-type': 'image/png' } });
		}
		return realFetch(input, init);
	}) as typeof globalThis.fetch;
}
