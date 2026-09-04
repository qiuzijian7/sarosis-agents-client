/**
 * canvasImageLoad — canvas 编辑器（GridSplit/Crop/Mask/Outpaint…）的上游图像加载器。
 *
 * 为什么需要代理回退：canvas 像素访问要求 `<img crossOrigin='anonymous'>`，
 * 而 provider 签名 URL（腾讯云 COS 等）响应不带 Access-Control-Allow-Origin →
 * 带 crossOrigin 的加载被浏览器直接拦（net::ERR_FAILED）。普通 `<img>`（OUTPUT
 * 区）不受限，所以「OUTPUT 显示正常但 canvas 编辑器加载失败」= CORS 问题。
 *
 * 策略：先直连（data: / 快照 ref 本地场景零开销），失败且 ref 是 http(s) 时
 * 回退 host 代理 `net.fetchAsDataUrl`（主进程 net.fetch 无 CORS）转 data URL
 * 再加载——data URL 同源，canvas 可自由读写像素。
 */
import { sendRequest } from '../../bridge/messageClient';

/** 依次尝试：直连 → （http(s) 时）host 代理。全部失败返回 null。 */
export async function loadCanvasImageWithProxy(ref: string): Promise<HTMLImageElement | null> {
	if (!ref) { return null; }
	const tryLoad = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => resolve(img.naturalWidth ? img : null);
		img.onerror = () => resolve(null);
		img.src = src;
	});
	const direct = await tryLoad(ref);
	if (direct) { return direct; }
	// 代理仅对 http(s) 有意义（data:/blob: 失败没有代理价值）
	if (!/^https?:\/\//i.test(ref)) { return null; }
	try {
		const r = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>('net.fetchAsDataUrl', { url: ref }, 60_000);
		if (!r?.dataUrl) { return null; }
		return await tryLoad(r.dataUrl);
	} catch {
		return null;
	}
}
