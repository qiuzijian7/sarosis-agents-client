/*---------------------------------------------------------------------------------------------
 *  mediaSnapshot — extract + normalize ComfyUI runner outputs into media snapshots,
 *  and derive thumbnail sizing. Pure functions, unit-testable.
 *
 *  ComfyUI /history outputs look like:
 *    { "3": { "images": [ { "filename": "…", "subfolder": "", "type": "output" } ] },
 *      "7": { "gifs": [ … ], "audio": [ … ] } }
 *  We normalize to a compact MediaRef list for snapshot storage + card previews.
 *--------------------------------------------------------------------------------------------*/

export type MediaKind = 'image' | 'video' | 'audio' | 'text' | 'unknown';

/**
 * ComfyUI 结构化定位三元组（对齐 ComfyTV `payload_url` 的 `/view` 语义）。
 *
 * 为什么需要它：`ref` 是「展示用的引用字符串」，会随形态漂移——
 *   - 同一次输出，可能被 `materializeComfyImageRefs` 物化成 `data:image/...`
 *     （代理态无 blob() 时则保留原 `/view?filename=…` 完整 URL）；
 *   - 同一个文件在生成后可能被重新上传到不同 `subfolder` / `type`。
 *   `ref` 一旦不同，字符串去重就失效，出现「同一张图两条 ref → 重复渲染」。
 *   而 `filename/subfolder/type` 是 ComfyUI 文件系统的**真身坐标**，不受形态影响，
 *   用它做跨形态稳定去重键（见 `mediaDedupeKey`）。
 */
export interface MediaLocator {
	filename: string;
	subfolder: string;
	type: string;
}

export interface MediaRef {
	kind: MediaKind;
	/** display/original reference (URL / filename / text) */
	ref: string;
	/** optional extra metadata (e.g. subfolder/type for ComfyUI /view paths) */
	meta?: Record<string, unknown>;
	/**
	 * ComfyTV fx-chain threading: when the output is an fx-threaded video
	 * (`{"__fxvideo__": {"url", "chain"}}`), `ref` holds the underlying video
	 * URL (for previews) and `fxChain` holds the full packed value so the next
	 * fx stage re-injects it as its `video` input (single ffmpeg render at the
	 * FX Chain terminal).
	 */
	fxChain?: string;
	/**
	 * ComfyUI 结构化定位（filename/subfolder/type）。当输出是标准文件描述符或
	 * 可解析的 `/view?` URL 时填充；纯 `data:`/`blob:`/文本引用则为 undefined
	 * （去重回退到 `ref` 字符串）。用于跨物化形态的稳定去重，见 `mediaDedupeKey`。
	 */
	locator?: MediaLocator;
}

export interface MediaSnapshotEntry {
	nodeId: string;
	/** port name the output came from ('' when unknown) */
	port: string;
	/** stable key: `${nodeId}:${port}:${index}` */
	key: string;
	media: MediaRef;
	/** element index within the slot (used for ordering/thumbnail pick) */
	index?: number;
}

const KIND_BY_SLOT: Record<string, MediaKind> = {
	images: 'image',
	animated: 'image', // SaveAnimatedWEBP 往 history 写 `animated` 槽（透明循环 webp）；按 image 处理 → 走 /view 物化 + <img> 自动播动画。
	gifs: 'video',
	videos: 'video',
	audio: 'audio',
	outputs: 'unknown',
};

function kindOfListName(name: string): MediaKind {
	return KIND_BY_SLOT[name] ?? 'unknown';
}

/**
 * ComfyUI 官方 `PreviewVideo.as_dict()` 把视频文件写进 `images` 槽（见
 * `comfy_api/latest/_ui.py`：`return {"images": self.values, "animated": (True,)}`），
 * 而非独立的 `videos` 槽。因此槽名 `images` 无法区分「图片」和「视频」——
 * 必须按文件扩展名二次判定，否则 SaveVideo 产物会被误归为 image，卡片走
 * `<img>` 渲染 mp4（黑屏/不播放）。
 *
 * 判定依据：filename 的扩展名命中视频容器集合时，把 kind 修正为 `video`。
 * 仅对「当前 kind 是 image 且 filename 是视频扩展名」的条目生效，不影响
 * `gifs`/`videos`/`audio`（已正确）以及真正的图片（png/jpg/webp 等）。
 */
const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|avi|m4v|ogv|ogm|3gp|3g2|mpeg|mpg|flv|wmv|ts|mts|m2ts)$/i;

function kindForFile(kind: MediaKind, filename: string | undefined): MediaKind {
	if (kind === 'image' && filename && VIDEO_EXT_RE.test(filename)) {
		return 'video';
	}
	return kind;
}

/**
 * 从 ComfyUI 输出描述符推导结构化 locator（filename/subfolder/type）。
 * 两种形态都能解析：
 *   - 标准描述符 `{ filename, subfolder, type }`；
 *   - 完整 `/view?filename=…&subfolder=…&type=…` URL（filename 字段缺失时）。
 * 纯 `data:`/`blob:`/纯文本 ref 返回 undefined（去重回退到 ref 字符串）。
 */
export function locatorFromDescriptor(rec: Record<string, unknown>, ref: string): MediaLocator | undefined {
	const subfolder = String(rec.subfolder ?? '');
	const type = String(rec.type ?? 'output');
	const filename = rec.filename as string | undefined;
	if (filename && !/^(https?:|data:|blob:)/i.test(filename)) {
		return { filename, subfolder, type };
	}
	// filename 是完整 URL 或缺失 → 尝试从 /view? 参数解析。
	if (/\/view\?/i.test(ref)) {
		try {
			const u = new URL(ref);
			const f = u.searchParams.get('filename');
			if (f) {
				return {
					filename: f,
					subfolder: u.searchParams.get('subfolder') ?? subfolder,
					type: u.searchParams.get('type') ?? type,
				};
			}
		} catch { /* 非法 URL：放弃 locator，交给 ref 去重 */ }
	}
	return undefined;
}

/**
 * 跨形态稳定去重键：优先用 locator（ComfyUI 文件真身坐标），否则退回 ref 字符串。
 *
 * 这是 P0 引用模型升级的核心 —— 取代各处「`e.media.ref` 字符串相等」的去重。
 * `ref` 会随物化形态（data: / /view URL）漂移，locator 不会。
 */
export function mediaDedupeKey(media: MediaRef | undefined): string {
	if (!media) { return ''; }
	if (media.locator) {
		const l = media.locator;
		return `loc:${l.type}/${l.subfolder}/${l.filename}`;
	}
	return `ref:${media.ref}`;
}

/** Normalize one output slot (e.g. `images`) into MediaRef[]. */
export function normalizeOutputSlot(name: string, value: unknown): MediaRef[] {
	if (!Array.isArray(value)) {
		// text-ish output → single text ref
		if (typeof value === 'string') { return [{ kind: 'text', ref: value }]; }
		return [{ kind: 'unknown', ref: JSON.stringify(value) }];
	}
	const kind = kindOfListName(name);
	return value.flatMap((item) => {
		if (typeof item === 'string') {
			return [{ kind, ref: item }];
		}
		if (item && typeof item === 'object') {
			const rec = item as Record<string, unknown>;
			// ComfyUI's SaveImage/PreviewImage node images output mixes a real
			// file descriptor {filename, subfolder, type, ...} with **internal
			// file-blob references** `[filename, subfolder, type]` (numeric or
			// string arrays pointing at the same file from the client side).
			// The numeric blobs aren't accessible /view URLs and would render
			// as 404, so filter them out — keep only the first real descriptor.
			if (Array.isArray(item)) {
				return [];
			}
			// 多种 ref 字段名（ComfyUI 标准 + ComfyTV / Provider 兼容）：
			//   - filename/subfolder/type   ComfyUI SaveImage 标准描述符
			//   - url                       完整 URL（ComfyTV result 节点直出）
			//   - image_url / file_url      Provider / ComfyTV 自定义格式
			//   - path / name               兼容别名
			const ref = (rec.filename as string | undefined)
				?? (rec.url as string | undefined)
				?? (rec.image_url as string | undefined)
				?? (rec.file_url as string | undefined)
				?? (rec.path as string | undefined)
				?? (rec.name as string | undefined);
			if (!ref) { return []; }
			return [{
				kind: kindForFile(kind, rec.filename as string | undefined),
				ref,
				meta: { subfolder: rec.subfolder, type: rec.type },
				locator: locatorFromDescriptor(rec, ref),
			}];
		}
		// Numeric / boolean primitives in a media list are ComfyUI's internal
		// file-blob indexes (e.g. `1, 2, 25219` appended after the descriptor).
		// They have no /view URL; skip rather than render a broken image.
		return [];
	});
}

/** Extract all media entries from a ComfyUI /history outputs object. */
export function extractMediaOutputs(
	outputs: Record<string, unknown> | undefined,
	nodeId: string,
	port = '',
): MediaSnapshotEntry[] {
	if (!outputs) { return []; }
	const entries: MediaSnapshotEntry[] = [];
	for (const [slotName, value] of Object.entries(outputs)) {
		const media = normalizeOutputSlot(slotName, value);
		media.forEach((m, i) => {
			entries.push({
				nodeId,
				port: port || slotName,
				key: `${nodeId}:${port || slotName}:${i}`,
				media: m,
			});
		});
	}
	return entries;
}

/** Build a /view? URL for a ComfyUI file ref. */
export function comfyViewUrl(baseUrl: string, filename: string, subfolder = '', type = 'output'): string {
	// 幂等：ComfyTV 的 result 节点可能直接返回完整 URL（`{url: "http://…"}`，
	// 见 normalizeOutputSlot 的 rec.url 分支）。此时若再拼 /view 会得到
	// `view?filename=http%3A%2F%2F…` 的损坏 URL——绝对 URL 直接原样返回。
	if (/^(https?:|data:|blob:)/i.test(filename)) { return filename; }
	const qs = new URLSearchParams({ filename, subfolder, type });
	return `${baseUrl.replace(/\/$/, '')}/view?${qs.toString()}`;
}

/** Thumbnail sizing: keep aspect ratio, clamp to a max edge. Pure. */
export function thumbnailSize(
	naturalWidth: number,
	naturalHeight: number,
	maxEdge = 320,
): { width: number; height: number } {
	if (!naturalWidth || !naturalHeight) { return { width: maxEdge, height: maxEdge }; }
	const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
	return {
		width: Math.max(1, Math.round(naturalWidth * scale)),
		height: Math.max(1, Math.round(naturalHeight * scale)),
	};
}

/** Stable snapshot key for a node's primary output (card preview). */
export function primarySnapshotKey(nodeId: string, port = ''): string {
	return `${nodeId}:${port || 'output'}:0`;
}

/**
 * Merge a picker's candidate list into a stable "pool" (对齐 ComfyTV
 * `stageStore.mergeImagePool`):
 *   - dedup by media ref URL
 *   - freshest entries FIRST (输入通常按 index 升序 = 旧的在前，因此从后往前
 *     遍历，最新生成的排在最前)
 *   - returns a NEW array, does not mutate input
 *
 * ComfyTV 原逻辑：existing = 已有 pool，incoming = 新 batch；merged =
 * [...fresh(incoming), ...existing]，按 image_url 去重并重新编号 index 1..N。
 * 本项目 pool 由 usePickerSnapshots 实时聚合上游 entry 而来（非持久化 widget），
 * 因此这里等价于"去重 + 新图在前"，不再额外维护 index 字段（由 store.put
 * 的单调递增 index 承担排序职责）。
 */
export function mergeImagePool(entries: readonly MediaSnapshotEntry[]): MediaSnapshotEntry[] {
	const seen = new Set<string>();
	const out: MediaSnapshotEntry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		// ★ 去重键改用 mediaDedupeKey（locator 优先）：同一张图若一次被物化成
		//   data: URL、另一次保留 /view URL，ref 字符串不同却会被误判为两张。
		const key = mediaDedupeKey(e.media);
		if (!key || seen.has(key)) { continue; }
		seen.add(key);
		out.push(e);
	}
	return out;
}
