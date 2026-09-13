/**
 * 表情包图集「一键去背景」流水线（从 nodeCard.tsx L1662-1881 原样迁出，2026-09-09）。
 * 行为不变原则：逻辑逐行保留；deps 显式注入原闭包捕获（setter/store/ctl 等）。
 * nodeCard 侧保留同名薄委托（见 handleSheetRemoveBg 调用点 onSheetRemoveBg）。
 */
import { getFullyTransparentRatio, refToPngDataUrl, rembgRemoveDataUrl } from '../miniEditorAi.js';
import { removeBgDataUrlLocal } from './emojiSheetUtils.js';
import { META_SHEET_FLAG, sheetDimsMeta } from './mediaSnapshotStore.js';
import { splitStickerSheet, EMOJI_SHEET_MARGIN_RATIO } from './workflowRun.js';
import type { CellCropRect } from '../MiniImageEditor';
import type { MediaSnapshotStore } from './mediaSnapshotStore.js';

/** 与 nodeCard.tsx:1293 同源的私有副本（纯函数，避免 nodeCard ↔ 本模块反向依赖）。 */
async function sha256Hex(text: string): Promise<string> {
	const buf = new TextEncoder().encode(text);
	const d = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 显式依赖注入：原闭包捕获集合。第一期迁移以「行为逐行不变」为首要目标，
 * 快照条目类型暂用 any（与 nodeCard 内派生值同构）；类型收紧列入后续批次。
 */
export interface SheetRemoveBgDeps {
	sheetFullEntry: any;
	localSheetFull: any;
	ownSnapshots: any[];
	sheetFullEntryIsPassthrough: boolean;
	nodeId?: string;
	snapKey?: string;
	snapshotStore: MediaSnapshotStore | undefined;
	sheetRemovingBg: boolean;
	ctl: <T>(name: string, fallback: T) => T;
	setSheetRemoveBgError: (v: string | null) => void;
	setSheetRemoveBgDoneTick: (updater: (t: number) => number) => void;
	setSheetRemovingBg: (v: boolean) => void;
	setSheetRemoveBgStage: (v: { text: string; percent?: number } | null) => void;
}

export async function runSheetRemoveBg(
	deps: SheetRemoveBgDeps,
	algo: 'ai' | 'chroma' | 'flood' = 'ai',
	chromaParams?: { similarity: number; smoothness: number; greenDominance: number },
): Promise<void> {
	const {
		sheetFullEntry, localSheetFull, ownSnapshots, sheetFullEntryIsPassthrough,
		nodeId, snapKey, snapshotStore, sheetRemovingBg, ctl,
		setSheetRemoveBgError, setSheetRemoveBgDoneTick, setSheetRemovingBg, setSheetRemoveBgStage,
	} = deps;
	// ★ 需求（2026-09-07）：去背景须**以原始图集为源**，在副本上抠图，抠图结果
	//   作为行列分割基底。故源恒取「未抠图的原始基底」——sheetFullEntry 可能已
	//   指向上一轮去背景产物（尾部最新 sheet='1'），再抠一次零变化。
	const entry = (() => {
		const candidates = [sheetFullEntry, localSheetFull, ...ownSnapshots]
			.filter((e): e is NonNullable<typeof e> => Boolean(e));
		const images = candidates.filter(e => e.media?.kind === 'image');
		return images.find(e => e.media.meta?.removeBg !== '1') ?? images[0] ?? sheetFullEntry;
	})();
	// ★ 诊断日志：只有 console.warn 能进生产 bundle（esbuild 摇掉 log/info/debug），沿用 [EmojiSheet] 约定。
	// eslint-disable-next-line no-console
	console.warn(
		`[RemoveBg] click node=${nodeId ?? '—'} snapKey=${snapKey ?? '—'}` +
		` entry=${entry ? (entry === localSheetFull ? 'LOCAL-FULL' : (sheetFullEntryIsPassthrough ? 'PASSTHROUGH' : 'LOCAL')) : 'NONE'}` +
		` srcRemoveBg='${entry?.media.meta?.removeBg ?? ''}'` +
		`${entry ? ` ref=${(entry.media?.ref ?? '').slice(0, 48)}` : ''}` +
		` rows=${entry?.media.meta?.rows ?? '—'} cols=${entry?.media.meta?.cols ?? '—'}`
	);
	if (sheetRemovingBg) {
		// eslint-disable-next-line no-console
		console.warn('[RemoveBg] ignored：上一轮去背景仍在执行（sheetRemovingBg=true）');
		return;
	}
	// 入口守卫不静默返回（2026-09-06）：无整版图/无快照存储 → 红条明示原因。
	if (!entry || !snapshotStore) {
		setSheetRemoveBgError(!entry
			? '没有可去背景的整版图：请先在本节点生成原图归档（或连线 sheet 口载入上游图集）。'
			: '快照存储未就绪，无法写入去背景结果。请重新打开面板后重试。');
		return;
	}
	// ★ 幂等判重（2026-09-07/08）：meta.sourceSha=sha256(源 ref)；按「算法+参数」区分，改参重试不被跳过。
	const removeBgProducts = ownSnapshots.filter(e =>
		e.media?.kind === 'image' && e.media?.meta?.removeBg === '1' && e.media?.meta?.sourceSha);
	const paramsKey = algo === 'chroma' && chromaParams
		? JSON.stringify([chromaParams.similarity, chromaParams.smoothness, chromaParams.greenDominance])
		: '';
	if (removeBgProducts.length > 0) {
		const sourceSha = await sha256Hex(entry.media.ref);
		if (removeBgProducts.some(e =>
			(e.media?.meta?.removeBgAlgo ?? 'ai') === algo
			&& (e.media?.meta?.removeBgParams ?? '') === paramsKey
			&& e.media?.meta?.sourceSha === sourceSha)) {
			// eslint-disable-next-line no-console
			console.warn('[RemoveBg] skip：同源产物已存在（sourceSha 匹配），不重复执行模型');
			// 跳过时切到「🧩 调整后」页签直示既有产物（任何 return 不得静默）。
			setSheetRemoveBgDoneTick(t => t + 1);
			return;
		}
	}
	setSheetRemovingBg(true);
	setSheetRemoveBgError(null);
	setSheetRemoveBgStage({ text: '读取图像…' });
	try {
		const dataUrl = await refToPngDataUrl(entry.media.ref);
		// ★ 守卫语义（2026-09-07）：只拦「上一次去背景的产物」（meta.removeBg='1'），
		//   透明底原始归档属合法输入不拦。
		const isAlreadyRemoved = entry.media.meta?.removeBg === '1';
		const transparentRatio = await getFullyTransparentRatio(dataUrl);
		// eslint-disable-next-line no-console
		console.warn(`[RemoveBg] source=${dataUrl.length}B transparentRatio=${transparentRatio.toFixed(3)} removeBg='${entry.media.meta?.removeBg ?? ''}'（仅对去背景产物拦截）`);
		if (isAlreadyRemoved) {
			throw new Error('当前基底已是去背景产物，再抠一次不会有变化。请在「原图」页签选回原始图集后重试。');
		}
		// ★ 算法分发（2026-09-08）：ai=ComfyUI saros_cutout；chroma/flood=本地 canvas 零依赖毫秒级。
		let out: string;
		if (algo === 'ai') {
			out = await rembgRemoveDataUrl(dataUrl, undefined, (text, percent) => {
				// ★ percent 贯通（2026-09-07）：ComfyUI 各阶段/推理进度 → 进度条 fill 实时增长。
				setSheetRemoveBgStage({ text, percent });
			});
		} else {
			setSheetRemoveBgStage({ text: algo === 'chroma' ? '本地绿幕抠图…' : '本地白底抠图…' });
			out = await removeBgDataUrlLocal(dataUrl, algo, algo === 'chroma' ? chromaParams : undefined);
		}
		// eslint-disable-next-line no-console
		console.warn(`[RemoveBg] model done in=${dataUrl.length}B out=${out.length}B${Math.abs(out.length - dataUrl.length) < 512 ? '（⚠ 输出≈输入：模型可能未抠除任何背景）' : ''}`);
		// ★ 副本语义（2026-09-06）：结果**追加**为新条目（put 自动分配递增 index），
		//   绝不覆写既有条目；读取方都取尾部最新 sheet='1' → 追加副本自然成为下游所见。
		// ★ 行列兜底（2026-09-07）：直通图 meta 缺 rows/cols → 取「首个 >0 候选」：
		//   entry.meta → 本节点 rows/cols 控件值 → 本地图集归档行列。
		const firstPositive = (...cands: number[]): number =>
			cands.find(v => Number.isFinite(v) && Number(v) > 0) ?? 0;
		const rawRows = firstPositive(
			Number(entry.media.meta?.rows ?? 0),
			Number(ctl('rows', 0)),
			Number(localSheetFull?.media.meta?.rows ?? 0),
		);
		const rawCols = firstPositive(
			Number(entry.media.meta?.cols ?? 0),
			Number(ctl('cols', 0)),
			Number(localSheetFull?.media.meta?.cols ?? 0),
		);
		// 指纹取**源 entry.ref**（与入口判重同一字符串；ref 直取省一次全量哈希且天然一致）。
		const sourceSha = await sha256Hex(entry.media.ref);
		// eslint-disable-next-line no-console
		console.warn(`[RemoveBg] put → node=${snapKey ?? nodeId ?? ''} port=image key=''（追加副本） sheet=1 removeBg=1 rows=${rawRows} cols=${rawCols} sha=${sourceSha.slice(0, 8)}`);
		snapshotStore.put({
			nodeId: snapKey ?? nodeId ?? '',
			port: 'image',
			key: '',
			media: {
				kind: 'image',
				ref: out,
				meta: {
					mime: 'image/png',
					sheet: META_SHEET_FLAG,
					...sheetDimsMeta(rawRows, rawCols),
					removeBg: '1',
					removeBgAlgo: algo,
					removeBgParams: paramsKey,
					sourceSha,
				},
			},
			index: 0,
		}, true /* skipImport：对已有产物的本地加工，不重复导出媒体库 */);
		// eslint-disable-next-line no-console
		console.warn('[RemoveBg] put ok → 「调整后」副本已追加（doneTick++ 触发编辑器自动切页）');
		// ★ 联动重切（2026-09-07）：按行列切单格写入 output 口；既有格按 cellIndex
		//   replaceByKey 原地更新（cellPrompt 保留），缺失追加；**不放 clearNode**。
		if (rawRows > 0 && rawCols > 0) {
			try {
				let cropsBg: CellCropRect[] = [];
				try {
					const arrBg = JSON.parse(String(ctl('cell_crops', '') || 'null')) as unknown;
					if (Array.isArray(arrBg) && arrBg.length === rawRows * rawCols) {
						const allNum = arrBg.every(it => {
							const o = it as Partial<CellCropRect>;
							return [o.x, o.y, o.w, o.h].every(v => typeof v === 'number' && Number.isFinite(v));
						});
						if (allNum) { cropsBg = arrBg as CellCropRect[]; }
					}
				} catch { /* 无自定义裁剪 → 等分 */ }
				const cellsBg = await splitStickerSheet(out, rawRows, rawCols, { marginRatio: EMOJI_SHEET_MARGIN_RATIO, cutoutBg: false, cellCrops: cropsBg.length ? cropsBg : undefined }, globalThis.fetch);
				const nodeKey = snapKey ?? nodeId ?? '';
				const oldCellByKey = new Map<string, { key: string; meta: any }>();
				for (const e of snapshotStore.byNode(nodeKey)) {
					if (e.port !== 'output' || e.media?.kind !== 'image') { continue; }
					const ci = e.media.meta?.cellIndex;
					if (typeof ci === 'number') { oldCellByKey.set(String(ci), { key: e.key, meta: e.media.meta ?? {} }); }
				}
				let replacedN = 0;
				let addedN = 0;
				for (let ci = 0; ci < cellsBg.length; ci++) {
					const cellMeta: any = {
						mime: 'image/png',
						sheetMode: '1',
						cellIndex: ci,
						cellSize: `${cellsBg[ci].w}x${cellsBg[ci].h}`,
						...(cropsBg[ci] ? { cellRect: JSON.stringify(cropsBg[ci]) } : {}),
					};
					const oldC = oldCellByKey.get(String(ci));
					if (oldC) {
						const merged: any = { ...cellMeta };
						if (typeof oldC.meta?.cellPrompt === 'string' && oldC.meta.cellPrompt) { merged.cellPrompt = oldC.meta.cellPrompt; }
						if (snapshotStore.replaceByKey(oldC.key, { kind: 'image', ref: cellsBg[ci].dataUrl, meta: merged })) { replacedN++; continue; }
					}
					snapshotStore.put({ nodeId: nodeKey, port: 'output', key: '', media: { kind: 'image', ref: cellsBg[ci].dataUrl, meta: cellMeta } }, true);
					addedN++;
				}
				// eslint-disable-next-line no-console
				console.warn(`[RemoveBg] 联动重切完成 rows=${rawRows} cols=${rawCols} cells=${cellsBg.length} replaced=${replacedN} added=${addedN}`);
			} catch (sliceErr) {
				// 切分失败不回滚整图口（去背景产物已就位）；引导手动重切。
				// eslint-disable-next-line no-console
				console.warn('[RemoveBg] 联动重切失败（整图口已更新，可点「生成」按行列重切）：', sliceErr instanceof Error ? sliceErr.message : String(sliceErr));
			}
		}
		// 通知编辑器自动切到「🧩 调整后」页签（完成计数器驱动）
		setSheetRemoveBgDoneTick(t => t + 1);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn('[RemoveBg] FAILED:', err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err));
		// webview 环境会静默忽略 window.alert（无 allow-modals）→ 失败必须 UI 红条呈现。
		setSheetRemoveBgError(err instanceof Error ? err.message : String(err));
	} finally {
		setSheetRemovingBg(false);
		setSheetRemoveBgStage(null);
	}
}
