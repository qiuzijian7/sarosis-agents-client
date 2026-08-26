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
	// `bytes.buffer` 而非 `bytes`：DOM lib 的 BlobPart 不接受
	// `Uint8Array<ArrayBufferLike>`（TS 5.7+ 起 TypedArray 带 buffer 泛型参数）→ TS2322。
	// 运行时两种写法等价（Blob 构造器都按字节读），这里取类型上合法的一种。
	return { blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }), mime };
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
	}): Promise<{
		ok: boolean;
		status?: number;
		json(): Promise<unknown>;
		text(): Promise<string>;
		/**
		 * 二进制读取（2026-08-20 新增）。下载图片**必须**走这两个之一 ——
		 * `text()` 会按 UTF-8 解码，非法字节被替换成 U+FFFD，再编码回 Blob 时
		 * 二进制彻底损坏（见 uploadRefToComfy 的注释与 400 事故）。
		 * 可选：真实 `fetch` Response 两者都有；测试 fake 至少实现其一。
		 */
		blob?(): Promise<Blob>;
		arrayBuffer?(): Promise<ArrayBuffer>;
	}>;
}

/** ComfyUI HTTP 请求默认超时（毫秒）。防止 /upload/image 无响应时永远卡死。 */
const COMFY_HTTP_TIMEOUT_MS = 30_000;

/**
 * 合并用户 signal + 超时 signal：任一触发即中止。
 *
 * 实现采用最兼容的方式（不依赖 Node18+ 的 `new AbortController({ signal })` 或
 * `AbortSignal.any`，旧版 Electron/Chrome 也可能不支持），手动桥接两个 signal：
 * 始终返回 timeoutCtrl.signal，并监听用户 signal 的 abort 事件。
 */
function withTimeout(signal?: AbortSignal, timeoutMs = COMFY_HTTP_TIMEOUT_MS): AbortSignal {
	const timeoutCtrl = new AbortController();
	const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
	if (!signal) {
		// 无用户 signal → 超时到点即 abort（自动清理 timer 在 fetch 完成后无关紧要）
		return timeoutCtrl.signal;
	}
	if (signal.aborted) {
		clearTimeout(timer);
		return signal;
	}
	signal.addEventListener('abort', () => {
		clearTimeout(timer);
		timeoutCtrl.abort();
	}, { once: true });
	return timeoutCtrl.signal;
}

/**
 * 把 provider 快照 ref 上传到 ComfyUI /upload/image，返回可被 LoadImage 消费的
 * Comfy /view 引用。comfy-view 直接透传（无需上传）；http 走 fetch→blob→FormData；
 * dataURL 本地解码→FormData。
 *
 * ★ 超时保护（2026-08-26 修复卡死）：所有 fetch 均通过 withTimeout() 注入
 *   AbortSignal，即使调用方未传 signal 也会在 30s 后自动超时，避免 ComfyUI
 *   /upload/image 无响应时整个流程永远不返回。
 */
export async function uploadRefToComfy(opts: {
	ref: string;
	baseUrl: string;
	fetchImpl: BridgeFetchLike;
	signal?: AbortSignal;
}): Promise<{ ok: boolean; ref?: string; error?: string }> {
	const { ref, baseUrl, fetchImpl, signal: userSignal } = opts;
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
			const resp = await fetchImpl(cls.url, { signal: withTimeout(userSignal, 60_000) });
			if (!resp.ok) { return { ok: false, error: `下载图片失败：HTTP ${resp.status ?? '?'}` }; }
			// ★★ 400 Bad Request 根因（2026-08-20，日志 1787224386976 line 13/14）：
			//   原实现是 `const buf = await resp.text(); blob = new Blob([buf], …)`。
			//   `text()` 按 UTF-8 解码响应体 —— PNG/JPEG 的字节流几乎必然包含非法
			//   UTF-8 序列，被逐个替换成 U+FFFD（\uFFFD 再编码为 3 字节 EF BF BD），
			//   于是 Blob 里是一份**既损坏又膨胀**的垃圾数据。ComfyUI /upload/image
			//   用 PIL 打开必然失败 → HTTP 400，且错误信息完全看不出是编码问题。
			//   二进制只能走 blob()/arrayBuffer()，且**不允许回退到 text()**
			//   （回退等于继续上传损坏数据，比明确报错更难排查）。
			if (typeof resp.blob === 'function') {
				blob = await resp.blob();
				if (blob.type) { mime = blob.type; }
			} else if (typeof resp.arrayBuffer === 'function') {
				const ab = await resp.arrayBuffer();
				blob = new Blob([ab], { type: mime });
			} else {
				return { ok: false, error: '下载图片失败：fetch 实现不支持二进制读取（需 blob() 或 arrayBuffer()）' };
			}
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
			signal: withTimeout(userSignal),
		});
		if (!resp.ok) {
			const t = await Promise.resolve(resp.text()).catch(() => '');
			return { ok: false, error: `上传图片失败：HTTP ${resp.status ?? '?'}${t ? ` ${t}` : ''}` };
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
	// 显式解构出已收窄的 ref：直接传 `opts` 时 TS 仍按声明类型（string | undefined）
	// 检查，上面的 guard 不参与推断 → TS2345。
	const up = await uploadRefToComfy({ ...opts, ref: opts.ref });
	return up.ok
		? { ok: true, image: up.ref }
		: { ok: false, error: up.error };
}
