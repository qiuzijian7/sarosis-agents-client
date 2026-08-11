/*---------------------------------------------------------------------------------------------
 *  imageGenToComfyBridge — Provider 输出 → ComfyUI 原生 LoadImage 的桥接（方案 B 场景）。
 *
 *  Provider 文生图返回的 ref 是 http(s) URL 或 data URL；ComfyUI 原生 LoadImage
 *  需要的却是**服务端文件**（/view?filename=… 或上传后的文件名）。本模块提供：
 *    - 纯解析：判断 ref 类型（/view URL / 普通 http / dataURL），提取 upload 名；
 *    - 可注入上传：`uploadRefToComfy` 把 http/dataURL 上传到 ComfyUI /upload/image，
 *      返回 Comfy /view 引用，供 LoadImage 的 `image` 输入直接使用。
 *  upload 依赖注入的 fetch 与 baseUrl，保持模块可单测。
 *--------------------------------------------------------------------------------------------*/

/** 判定一个 provider 快照 ref 是否已能被 ComfyUI 原生 LoadImage 直接消费（/view 引用）。 */
export function isComfyViewRef(ref: string): boolean {
	return /\/view\?/.test(ref);
}

export type ImageRefKind = 'comfy-view' | 'http' | 'data-url' | 'unknown';

/** 纯解析：归类 provider 快照 ref。 */
export function classifyImageRef(ref: string | undefined): { kind: ImageRefKind; url?: string; dataUrl?: string } {
	if (!ref) { return { kind: 'unknown' }; }
	if (isComfyViewRef(ref)) { return { kind: 'comfy-view', url: ref }; }
	if (ref.startsWith('data:')) { return { kind: 'data-url', dataUrl: ref }; }
	if (/^https?:\/\//.test(ref)) { return { kind: 'http', url: ref }; }
	return { kind: 'unknown' };
}

/** data URL → Blob（纯逻辑：仅解析 mime/base64，不访问网络）。 */
export function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } | undefined {
	const comma = dataUrl.indexOf(',');
	if (comma < 0) { return undefined; }
	const header = dataUrl.slice(5, comma); // "data:"
	const mime = header.split(';')[0] || 'image/png';
	const isBase64 = /;base64$/i.test(header);
	const raw = dataUrl.slice(comma + 1);
	let bytes: Uint8Array;
	if (isBase64) {
		bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
	} else {
		bytes = new TextEncoder().encode(decodeURIComponent(raw));
	}
	return { blob: new Blob([bytes], { type: mime }), mime };
}

/** 从 ref 推导上传文件名（纯逻辑）。 */
export function uploadNameForRef(ref: string, index = 0): string {
	if (/^data:/.test(ref)) {
		const m = /data:image\/(\w+)/.exec(ref);
		const ext = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
		return `sarosis_upload_${index}.${ext}`;
	}
	const path = ref.split(/[?#]/)[0];
	const last = path.split('/').pop();
	return last && /\.\w+$/.test(last) ? last : `sarosis_upload_${index}.png`;
}

export interface UploadImageResponse {
	name: string;
	subfolder?: string;
	type?: string;
}

/** 供测试注入的 fetch 实现。 */
export interface BridgeFetchLike {
	(url: string, init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: FormData | string;
		signal?: AbortSignal;
	}): Promise<{ ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;
}

/**
 * 把 provider 快照 ref 上传到 ComfyUI /upload/image，返回可被 LoadImage 消费的
 * Comfy /view 引用。comfy-view 直接透传（无需上传）；http 走 fetch→blob→FormData；
 * dataURL 本地解码→FormData。
 */
export async function uploadRefToComfy(opts: {
	ref: string;
	baseUrl: string;
	fetchImpl: BridgeFetchLike;
	signal?: AbortSignal;
}): Promise<{ ok: boolean; ref?: string; error?: string }> {
	const { ref, baseUrl, fetchImpl, signal } = opts;
	const cls = classifyImageRef(ref);
	if (cls.kind === 'comfy-view') {
		return { ok: true, ref };
	}
	let blob: Blob;
	let mime = 'image/png';
	if (cls.kind === 'data-url' && cls.dataUrl) {
		const parsed = dataUrlToBlob(cls.dataUrl);
		if (!parsed) { return { ok: false, error: '无效的 data URL 图片' }; }
		blob = parsed.blob;
		mime = parsed.mime;
	} else if (cls.kind === 'http' && cls.url) {
		try {
			const resp = await fetchImpl(cls.url, { signal });
			if (!resp.ok) { return { ok: false, error: `下载图片失败：HTTP ${resp.status}` }; }
			const buf = await resp.text();
			blob = new Blob([buf], { type: mime });
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	} else {
		return { ok: false, error: '无法识别的图片引用' };
	}
	const form = new FormData();
	form.append('image', blob, uploadNameForRef(ref, 0));
	form.append('type', 'input');
	form.append('overwrite', 'true');
	try {
		const resp = await fetchImpl(`${baseUrl}/upload/image`, {
			method: 'POST',
			body: form,
			signal,
		});
		if (!resp.ok) {
			const t = await Promise.resolve(resp.text()).catch(() => '');
			return { ok: false, error: `上传图片失败：HTTP ${resp.status}${t ? ` ${t}` : ''}` };
		}
		const data = await resp.json() as UploadImageResponse;
		const name = String(data?.name ?? '');
		if (!name) { return { ok: false, error: '上传接口未返回文件名' }; }
		const subfolder = String(data?.subfolder ?? '');
		const typeOut = String(data?.type ?? 'output');
		const view = `${baseUrl}/view?filename=${encodeURIComponent(name)}${subfolder ? '&subfolder=' + encodeURIComponent(subfolder) : ''}&type=${typeOut}`;
		return { ok: true, ref: view };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 为 LoadImage 节点生成最终的 `image` 输入值：comfy-view 透传，其他 ref
 * 上传后返回 /view 引用。返回 undefined 表示应报错中止。纯编排。
 */
export async function resolveLoadImageImageRef(opts: {
	ref: string | undefined;
	baseUrl: string;
	fetchImpl: BridgeFetchLike;
	signal?: AbortSignal;
}): Promise<{ ok: boolean; image?: string; error?: string }> {
	if (!opts.ref) { return { ok: false, error: '上游没有可用的图片输出' }; }
	const up = await uploadRefToComfy(opts);
	return up.ok
		? { ok: true, image: up.ref }
		: { ok: false, error: up.error };
}
