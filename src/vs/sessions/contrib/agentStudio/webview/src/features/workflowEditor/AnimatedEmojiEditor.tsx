/**
 * AnimatedEmojiEditor — Saros.AnimatedEmoji（转动态表情包）的内嵌编辑器。
 *
 * 流水线：参考图（透明贴纸）→ provider 视频模型图生视频（绿幕底）→ 前端
 * chroma-key 抠像 → ≤100KB 透明 GIF（微信表情开放平台规范：主图 GIF 240×240
 * ≤100KB + 缩略图 PNG 240×240 ≤60KB 随 meta.thumb 携带、≤3s、循环）。
 *
 * 与 DynEmojiStageEditor 的差异：视频生成不绑定 ComfyUI/MiniMax H3，而是
 * provider/model 双下拉（videogen.generate RPC，模型按 supportsVideoGen 过滤）；
 * 所有参数在编辑器内自绘渲染（schema 有内嵌编辑器时通用控件网格不渲染）。
 *
 * 数据流（onCommit 键名 = widget 名 = 执行器 values 键）：
 *   videoProvider / videoModel / prompt / duration_s / fps / max_kb /
 *   chroma_color / chroma_similarity / chroma_smoothness
 */
import * as React from 'react';
import { useProviderStore } from '../../store/useProviderStore';
import { CHROMA_KEY_ALGOS, type ChromaKeyAlgo } from './comfyHost/videoToGifExecutor.js';
import { dataUrlToBlob } from './comfyHost/videoToGifExecutor.js';
import { chromaKeyFrame, autoSampleChromaKeyRgba } from './comfyHost/videoToGifExecutor.js';
import { sendRequest } from '../../bridge/messageClient.js';

export interface AnimatedEmojiInit {
  /** ★ 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）。 */
  backend?: 'comfyui' | 'provider';
  /** ComfyUI 渠道：视频工作流名（workflowOptionsFor('video')）。 */
  workflow?: string;
  /** ComfyUI 渠道：seed（0=执行时随机）。 */
  seed?: number;
  videoProvider: string;
  videoModel: string;
  duration_s: number;
  fps: number;
  max_kb: number;
  chromaColor: string;
  chromaSimilarity: number;
  chromaSmoothness: number;
  /** ★ 绿幕合成开关（默认 true）：静态图叠加绿底喂视频模型；关闭后原图直喂
   *  （产出保留原背景）。抠像需要绿幕——关闭时抠像自动忽略。 */
  chromaEnable?: boolean;
  /** ★ 抠像开关（2026-09-08，默认 true）：生成后去绿幕 → 透明；关闭则保留原
   *  背景（需与绿幕合成配合——无绿幕时无绿可抠）。 */
  matteEnable?: boolean;
  /** ★ GIF 输出开关（2026-09-08，默认 true）：关闭后直接以生成的视频为产物。 */
  gifEnable?: boolean;
  /** ★ 抠像算法（2026-09-08）：'rgb'（默认）/ 'flood'（泛洪连通）/ 'ycbcr'（色度）。 */
  chromaAlgo?: string;
  /** ★ 首尾回环混合（2026-09-08，默认 true）：尾部 4 帧与首帧插值，GIF 循环无缝。 */
  loopBlend?: boolean;
}

export interface AnimatedEmojiEditorProps {
  initial: AnimatedEmojiInit;
  /** 已生成的绿幕视频 / GIF 引用（预览；kind='video' 为抠像前绿幕原片）。 */
  cellRefs?: Array<{ ref: string; kind?: 'image' | 'video' } | undefined>;
  /**
   * ★ 每格的原始绿幕视频（2026-09-08「原始视频/抠图 GIF」格级切换）：来自
   *   快照 port='video'（诊断归档），按 cellIndex 取最新。格右上角按钮在
   *   「该格 GIF」与「该格原片」之间切换显示——调参时直接对比抠像效果。
   */
  cellVideoRefs?: Array<{ cellIndex: number; ref: string }>;
  /**
   * ★ 每格的原图（2026-09-08 三态切换：原图→视频→GIF）：上游逐格静态贴纸
   *   （与 executor jobs 同序，index=格号）。三态循环对比：抠像结果 ↔ 绿幕
   *   原片 ↔ 输入原图。
   */
  cellSourceRefs?: string[];
  /** 上游图集自带行列（meta.sheet/rows/cols）：grid 未显式设置时预览按此叠加。
   *  ★ margin（拼装 gap 比例）随 meta 透传：消费图集时切分几何必须与图集实际
   *  gap 一致（静态节点恒 0），否则逐格偏移。 */
  sheetGrid?: { rows: number; cols: number; margin?: number };
  /** ComfyUI 渠道可选视频工作流列表（registry workflowOptionsFor('video')）。 */
  workflowOptions?: string[];
  /** ★ 原生整图 ref（meta.sheetFull='1'）——预留：整图模式（1×1）直接以原图为基底。 */
  sheetRef?: string;
  /** 「调整裁剪」回调：触发 recrop（nodeCard 提交 run_scope='recrop' 并重跑节点）。 */
  onApplyRecrop?: () => void;
  /** 上游输入图张数（>1 时执行器会自动拼贴成 rows×cols 图集，预览提示文案变化）。 */
  upstreamCount?: number;
  onCommit: (patch: Record<string, unknown>) => void;
  onRunRequest?: () => void;
  /** 节点运行中（2026-09-02）：生成按钮立即变「取消」。 */
  running?: boolean;
  /** 运行中点击按钮 → 中止（与卡片取消同链路 wf-node-abort）。 */
  onCancelRequest?: () => void;
  /**
   * ★ 单格重生成（2026-09-08，对齐静态表情包交互）：网格悬停 ⟳ 触发。
   * nodeCard 转发：commit run_scope='cell' + selected_index（1-based）→ wf-node-run。
   */
  onRunCellRequest?: (cellIndex: number) => void;
}

const btn = (active: boolean): React.CSSProperties => ({
	padding: '3px 8px',
	borderRadius: 5,
	cursor: 'pointer',
	fontSize: 10,
	fontFamily: 'inherit',
	border: '1px solid rgba(255,255,255,.14)',
	background: active ? 'rgba(168,85,247,.22)' : 'rgba(255,255,255,.05)',
	color: active ? '#d8b4fe' : 'var(--vscode-foreground, #e8e8e8)',
});

/** 排序索引数组 → 压缩区间文案：[0,1,2,5,8] → "0-2,5,8"（按钮 [m-n] 标签）。 */
function compressRanges(sorted: number[]): string {
	if (sorted.length === 0) { return ''; }
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (let k = 1; k <= sorted.length; k++) {
		const cur = sorted[k];
		if (cur === prev + 1) { prev = cur; continue; }
		parts.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = cur;
		prev = cur;
	}
	return parts.join(',');
}

const selectStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px',
  background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)',
  border: '1px solid rgba(255,255,255,.14)', borderRadius: 4,
};

export function AnimatedEmojiEditor({
  initial, cellRefs, cellVideoRefs, cellSourceRefs, sheetGrid, workflowOptions, upstreamCount, onCommit, onRunRequest, running, onCancelRequest, onRunCellRequest,
}: AnimatedEmojiEditorProps): React.ReactElement {
  // ── 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）──
  const [backend, setBackend] = React.useState<'comfyui' | 'provider'>(initial.backend === 'comfyui' ? 'comfyui' : 'provider');
  const [workflow, setWorkflow] = React.useState<string>(initial.workflow || workflowOptions?.[0] || '');
  /** ComfyUI seed：0=执行时随机；>0 固定（复现）。🎲 按钮随机换新。 */
  const [seed, setSeed] = React.useState<number>(typeof initial.seed === 'number' && initial.seed > 0 ? initial.seed : 0);
  const [providerId, setProviderId] = React.useState<string>(initial.videoProvider || '');
  const [modelId, setModelId] = React.useState<string>(initial.videoModel || '');
  const [durationS, setDurationS] = React.useState<number>(initial.duration_s || 3);
  const [fps, setFps] = React.useState<number>(initial.fps || 12);
  // ★ 旧默认 100 → 500 一次性迁移（2026-09-08）：微信表情规范单张动态 GIF
  //   ≤500KB——100 连 24 色 4fps 保底档（172KB）都超限。恰为 100（旧默认，用户
  //   大概率没手动调）→ 映射 500；其他值视为手动调参尊重不迁。
  const [maxKb, setMaxKb] = React.useState<number>(initial.max_kb === 100 ? 500 : (initial.max_kb || 500));
  const [chromaColor, setChromaColor] = React.useState<string>(initial.chromaColor || '#00FF00');
  // ★ 幕布色自动采样（2026-09-08）：开 = chroma_color 存 'auto'，抠像时从视频首帧
  //   四边采样实际幕布色（编码会令绿漂移，采样比 fix hex 更贴合）；绿底合成仍用
  //   纯绿 #00FF00。默认关（保持手动色，向后兼容）。
  const [chromaAuto, setChromaAuto] = React.useState<boolean>(initial.chromaColor === 'auto');
  // ★ 绿幕合成开关：关闭 = 静态图不叠绿底直喂视频模型（产出带原背景）
  const [chromaEnable, setChromaEnable] = React.useState<boolean>(initial.chromaEnable !== false);
  // ★ 抠像开关（2026-09-08，与绿幕合成解耦）：生成后去绿幕 → 透明；关闭保留原背景
  const [matteEnable, setMatteEnable] = React.useState<boolean>(initial.matteEnable !== false);
  // ★ GIF 输出开关（2026-09-08）：关闭 = 直接输出生成的视频（mp4）
  const [gifEnable, setGifEnable] = React.useState<boolean>(initial.gifEnable !== false);
  // ★ 首尾回环混合（2026-09-08）：尾部 4 帧与首帧插值——GIF 循环播放无缝
  const [loopBlend, setLoopBlend] = React.useState<boolean>(initial.loopBlend !== false);
  // ★ 默认参数对齐静态表情包（2026-09-08）：静态切分 chroma 模式用
  //   similarity=0.25 / smoothness=0.08（emojiSheetUtils.removeBgDataUrlLocal
  //   同款），效果经大量图集验证。动态旧默认 0.4/0.1 阈值大 60% → 白发/浅色
  //   边缘/内部暗区大量误抠 → 叠加形态学清理放大成边缘破损+内部破洞。
  //   ★ 旧默认值一次性迁移：initial 恰为 0.4/0.1（旧默认，用户大概率没手动
  //   调过）→ 直接映射到新默认；其他值视为用户手动调参，尊重不迁。
  const [chromaSimilarity, setChromaSimilarity] = React.useState<number>(
    typeof initial.chromaSimilarity === 'number' ? (initial.chromaSimilarity === 0.4 ? 0.25 : initial.chromaSimilarity) : 0.25);
  const [chromaSmoothness, setChromaSmoothness] = React.useState<number>(
    typeof initial.chromaSmoothness === 'number' ? (initial.chromaSmoothness === 0.1 ? 0.08 : initial.chromaSmoothness) : 0.08);
  // ★ 抠像算法（2026-09-08 调研落地）：rgb（色距）/ flood（泛洪连通）/ ycbcr（色度）。
  const [chromaAlgo, setChromaAlgo] = React.useState<ChromaKeyAlgo>(
    initial.chromaAlgo === 'flood' || initial.chromaAlgo === 'ycbcr' ? initial.chromaAlgo : 'rgb');
  // 参数页签：GIF 输出 / 绿幕抠像 两页切换。
  const [tab, setTab] = React.useState<'gif' | 'chroma'>('gif');
  // ★ 选中格多选（2026-09-08，用户需求）：点击格子 toggle 选中；按钮文字随
  //   选中集变化（单格 [x]，多格压缩区间 [m-n,...]），点击批量重生成选中格。
  //   全不选 = 生成全部（run_scope='all'）。
  const [selectedCells, setSelectedCells] = React.useState<Set<number>>(() => new Set<number>());
  // ★ 悬停格（⟳ 显示依据）：绑定在**格子**上而非按钮——按钮自身悬停显隐
  //   的缺陷是「悬停格子中央时按钮不可见」（用户不知道按钮存在）。
  const [hoverCell, setHoverCell] = React.useState<number | null>(null);
  // ★ 单格静帧/动图切换（2026-09-08）：每格右上角 🖼/🎬 按钮独立切换。
  //   「静帧」= GIF 第 0 帧（首帧一致性 = 输入静态贴纸）——createImageBitmap
  //   对 GIF 只解码首帧，按需解码后缓存（ref → 首帧 PNG dataURL）。
  const [stillCells, setStillCells] = React.useState<Set<number>>(() => new Set<number>());
  const [stillTick, setStillTick] = React.useState(0);
  const stillCache = React.useRef(new Map<string, string>());
  /** 解码 GIF 首帧为 dataURL（带缓存；失败返回 null 显示原动图）。 */
  const getStillFrame = React.useCallback(async (gifRef: string): Promise<string | null> => {
    const cached = stillCache.current.get(gifRef);
    if (cached) { return cached; }
    try {
      const blob = gifRef.startsWith('data:')
        ? new Blob([Uint8Array.from(atob(gifRef.slice(gifRef.indexOf(',') + 1)), c => c.charCodeAt(0))], { type: 'image/gif' })
        : await (await fetch(gifRef)).blob();
      const bmp = await createImageBitmap(blob);   // GIF 规范行为：返回首帧
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      const c2 = cv.getContext('2d');
      if (!c2) { bmp.close(); return null; }
      c2.drawImage(bmp, 0, 0);
      bmp.close();
      const url = cv.toDataURL('image/png');
      stillCache.current.set(gifRef, url);
      return url;
    } catch {
      return null;
    }
  }, []);
  /** 切换某格静帧/动图；切静帧时预解码首帧（完成后 bump 重渲染）。 */
  const toggleStill = React.useCallback((i: number, gifRef: string | undefined): void => {
    setStillCells(prev => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); } else { next.add(i); }
      return next;
    });
    if (gifRef && !stillCache.current.has(gifRef)) {
      void getStillFrame(gifRef).then(r => { if (r) { setStillTick(t => t + 1); } });
    }
  }, [getStillFrame]);
  /** 本节点产出的逐格产物（行主序，与 grid 切分顺序一致；排除绿幕原片）。
   *  ★ 含 video（2026-09-08）：GIF 输出开关关闭时产物是 mp4——网格用 <video> 播放。 */
  const gridCellMedia = React.useMemo(
    () => (cellRefs ?? []).flatMap(c => (c && (c.kind === 'image' || c.kind === 'video') ? [{ ref: c.ref, isVideo: c.kind === 'video' }] : [])),
    [cellRefs],
  );
  // ★ 格级三态预览（2026-09-08「原图→视频→GIF」循环切换）：默认 GIF（抠像
  //   结果）；缺失态自动跳过（无原片则 GIF↔原图 两态）。可播化 URL 缓存沿用。
  //   ★ cellIndex → 绿幕原片 ref（2026-09-08 补回：四态重构时定义被误删，
  //   esbuild 不查未定义标识符 → 运行时 ReferenceError 崩渲染）。
  const videoByCell = React.useMemo(
    () => new Map((cellVideoRefs ?? []).map(v => [v.cellIndex, v.ref])),
    [cellVideoRefs],
  );
  type CellPreviewMode = 'gif' | 'matte' | 'video' | 'source';
  const [previewModes, setPreviewModes] = React.useState<Map<number, CellPreviewMode>>(() => new Map());
  const cyclePreviewMode = (i: number, hasVideo: boolean, hasSource: boolean): void => {
    setPreviewModes(prev => {
      // 四态循环（2026-09-08 加「抠图」）：抠图 = 当前参数对原片帧实时抠像的
      // 全彩透明预览（无 GIF 色数量化损失，精确评估边缘质量）。
      const order: CellPreviewMode[] = ['gif', ...(hasVideo ? ['matte' as const, 'video' as const] : []), ...(hasSource ? ['source' as const] : [])];
      const cur = prev.get(i) ?? 'gif';
      const m = new Map(prev);
      m.set(i, order[(order.indexOf(cur) + 1) % order.length]);
      return m;
    });
  };
  // ★ 视频 ref 可播化（2026-09-08 两轮修正）：所有 <video> 的 src 一律走 blob
  //   URL——① 外网签名 URL（COS）：CSP 不放行 + 会过期 → host 代理拉取；② 固化
  //   的巨型 data: URL（localizeImageRef 产物，几 MB base64）：<video> 直喂易
  //   加载失败（黑屏空控制条）→ dataUrlToBlob + createObjectURL；③ blob:/本机
  //   http 原样。缓存 key = 原始 ref（同一 ref 多处引用共享一个 blob URL）。
  const [playableByUrl, setPlayableByUrl] = React.useState<Map<string, string>>(() => new Map());
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const wanted: string[] = [];
      for (const [i, mode] of previewModes) {
        if (mode === 'video') { const r = videoByCell.get(i); if (r) { wanted.push(r); } }
      }
      for (const c of gridCellMedia) {
        if (c.isVideo && c.ref) { wanted.push(c.ref); }
      }
      for (const raw of wanted) {
        if (playableByUrl.has(raw)) { continue; }
        let url = raw;
        if (/^data:/i.test(raw)) {
          try { url = URL.createObjectURL(dataUrlToBlob(raw)); } catch { /* 保持原样 */ }
        } else if (/^https?:/i.test(raw) && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(raw)) {
          try {
            const r = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>('net.fetchAsDataUrl', { url: raw }, 120_000);
            if (r?.dataUrl) { url = URL.createObjectURL(dataUrlToBlob(r.dataUrl)); }
          } catch { /* 代理失败 → 保持原 URL（黑屏即失败态），不阻断其他格 */ }
        }
        if (!cancelled) { setPlayableByUrl(prev => new Map(prev).set(raw, url)); }
      }
    })();
    return () => { cancelled = true; };
  }, [previewModes, videoByCell, gridCellMedia, playableByUrl]);
  // ★ 「抠图」态（2026-09-08 四态预览，序列帧版）：当前抠像参数对**原片逐帧**
  //   实时抠像 → 透明 PNG 序列（全彩 + 真透明，无 GIF 色数量化损失）——底部
  //   ‹ › 翻帧检查边缘质量随时间的变化。缓存含**参数+原片指纹**签名，任一变化
  //   自动重算；逐帧推送（算完一帧立即可看）。
  const [matteSeq, setMatteSeq] = React.useState<Map<number, { sig: string; urls: string[]; idx: number }>>(() => new Map());
  // ★ ref 镜像（2026-09-08 修复「抠像中⋯」永久卡住）：抠像进度 setMatteSeq 会
  //   触发依赖含 matteSeq 的 effect cleanup（cancelled=true）——帧循环第一帧后
  //   即被自杀。skip 判断改读 ref（最新值），matteSeq 移出依赖数组。
  const matteSeqRef = React.useRef(matteSeq);
  matteSeqRef.current = matteSeq;
  const matteParamSig = `${chromaSimilarity}|${chromaSmoothness}|${chromaAlgo}|${chromaAuto ? 'auto' : chromaColor}`;
  const stepMatteFrame = (i: number, d: number): void => {
    setMatteSeq(prev => {
      const e = prev.get(i);
      if (!e || e.urls.length === 0) { return prev; }
      const idx = (e.idx + d + e.urls.length) % e.urls.length;
      return new Map(prev).set(i, { ...e, idx });
    });
  };
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const [i, mode] of previewModes) {
        if (mode !== 'matte') { continue; }
        const raw = playableByUrl.get(videoByCell.get(i) ?? '') ?? videoByCell.get(i);
        if (!raw) { continue; }
        // 签名 = 参数 + 原片指纹（重新生成后原片变了必须重算）
        const sig = `${matteParamSig}|${raw.slice(-48)}`;
        const cached = matteSeqRef.current.get(i);
        if (cached && cached.sig === sig) { continue; }
        if (cancelled) { return; }
        // ★ 重算期间**保留旧序列帧**（2026-09-08 用户需求）：重新生成/调参后不
        //   退回「抠像中⋯」空白——旧帧继续可翻看，算完原子替换为新序列。首次
        //   计算（无旧帧）才显示空态。
        setMatteSeq(prev => {
          const e = prev.get(i);
          if (!e) { return new Map(prev).set(i, { sig: '', urls: [], idx: 0 }); }
          return new Map(prev).set(i, { ...e, idx: Math.min(e.idx, e.urls.length - 1) });
        });
        const urls: string[] = [];
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.src = raw;
        try {
          await new Promise<void>((res, rej) => {
            video.onloadeddata = () => res();
            video.onerror = () => rej(new Error('原片解码失败'));
          });
          const dur = video.duration || 1;
          // 序列帧数：~12fps 抽样、上限 16 帧（评估边缘足够，seek 开销可控）
          const n = Math.max(2, Math.min(16, Math.round(dur * 12) || 12));
          const c = document.createElement('canvas');
          c.width = video.videoWidth || 240;
          c.height = video.videoHeight || 240;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx) { throw new Error('无法创建画布'); }
          ctx.imageSmoothingQuality = 'high';
          for (let k = 0; k < n; k++) {
            if (cancelled) { return; }
            const t = dur * (k + 0.5) / n;
            await new Promise<void>((res) => {
              video.onseeked = () => res();
              video.currentTime = Math.min(t, Math.max(0, dur - 0.05));
            });
            ctx.drawImage(video, 0, 0, c.width, c.height);
            const rgba = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer.slice(0));
            let key = { r: 0, g: 255, b: 0 };
            if (!chromaAuto && /^#?[0-9a-f]{6}$/i.test(chromaColor)) {
              const h = chromaColor.replace('#', '');
              key = { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
            } else {
              key = autoSampleChromaKeyRgba(rgba, c.width, c.height);
            }
            // ★ softAlpha（2026-09-08）：抠图预览是 PNG（8-bit 灰阶透明）——启用
          //   OBS 同款连续软 alpha（跳过 choke/开运算保软边），显示即真抗锯齿；
          //   GIF 链路仍 1-bit（超采样降采样近似）。
          chromaKeyFrame(rgba, key, chromaSimilarity, chromaSmoothness, chromaAlgo, { boxFilterDistance: true, softAlpha: true });
            ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), c.width, c.height), 0, 0);
            urls.push(c.toDataURL('image/png'));
            if (!cancelled) {
              setMatteSeq(prev => {
                const e = prev.get(i);
                if (!e) { return prev; }
                return new Map(prev).set(i, { ...e, urls: [...urls], idx: Math.min(e.idx, urls.length - 1) });
              });
            }
          }
        } catch { /* 单格失败不影响其他格；显示层保持空态 */ }
        finally {
          try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
        }
      }
    })();
    return () => { cancelled = true; };
    // ★ matteSeq 不在依赖（进度写入会触发 cleanup 自杀帧循环）——skip 判断走
    //   matteSeqRef 镜像。参数/原片变化仍由 matteParamSig/previewModes 等驱动。
  }, [previewModes, matteParamSig, playableByUrl, videoByCell, chromaAuto, chromaColor, chromaSimilarity, chromaSmoothness, chromaAlgo]);
  void stillTick;   // 首帧异步解码完成后强制重渲染

  // provider store 懒加载（幂等；画布卡片不经过 NodeEditorPopup 时也需要数据）
  const providers = useProviderStore(s => s.providers);
  const loadProviders = useProviderStore(s => s.loadProviders);
  React.useEffect(() => { void loadProviders(); }, [loadProviders]);

  const videoGenProviders = React.useMemo(
    () => providers.filter(p => p.authStatus === 'authenticated' && (p.models ?? []).some(m => m.supportsVideoGen)),
    [providers],
  );
  const activeProvider = videoGenProviders.find(p => p.id === providerId) ?? (providerId ? undefined : videoGenProviders[0]);
  const modelOptions = React.useMemo(
    () => (activeProvider?.models ?? []).filter(m => m.supportsVideoGen),
    [activeProvider],
  );

  // provider 未选/失效 → 回退第一个；model 空/不属当前 provider → 联动第一个可用。
  React.useEffect(() => {
    if (!activeProvider) { return; }
    if (activeProvider.id !== providerId) { setProviderId(activeProvider.id); return; }
    if (!modelOptions.some(m => m.id === modelId)) {
      const first = modelOptions[0]?.id;
      if (first) { setModelId(first); }
    }
  }, [activeProvider, providerId, modelOptions, modelId]);

  // 参数变化 → 写回 node.properties（执行器 runAnimatedEmoji 消费）。
  // ★ 动作 prompt 不在编辑器输入（图生视频以参考图为主体）：来自上游 texts
  //   端口连线，执行器 runAnimatedEmoji 读 values.prompt / 上游 TEXT 快照。
  React.useEffect(() => {
    onCommit({
      backend,
      workflow,
      seed,
      videoProvider: providerId,
      videoModel: modelId,
      duration_s: durationS,
      fps,
      max_kb: maxKb,
      chroma_color: chromaAuto ? 'auto' : chromaColor,
      chroma_enable: chromaEnable,
      matte_enable: matteEnable,
      gif_enable: gifEnable,
      loop_blend: loopBlend,
      chroma_similarity: chromaSimilarity,
      chroma_smoothness: chromaSmoothness,
      chroma_algo: chromaAlgo,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, workflow, seed, providerId, modelId, durationS, fps, maxKb, chromaEnable, chromaAuto, chromaColor, chromaSimilarity, chromaSmoothness, chromaAlgo, matteEnable, gifEnable, loopBlend]);

  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    step = 1,
    onChange: (v: number) => void,
  ): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>{label}</span>
      <button style={btn(false)} onClick={() => onChange(Math.max(min, Math.round((value - step) / step) * step))}>−</button>
      <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 24, textAlign: 'center' }}>{value}</span>
      <button style={btn(false)} onClick={() => onChange(Math.min(max, Math.round((value + step) / step) * step))}>＋</button>
    </div>
  );

  // ★ 旧版「绿幕原片 / 首格 GIF」预览块已移除（2026-09-08）：下方表情网格
  //   （逐格 + 🎬/✂️ 原片切换 + 选中/⟳）信息量完全覆盖，顶部再放大第 0 格
  //   属双份展示冗余（用户困惑「引用下方为什么多一张大图」）。

  // ── 表情包图片网格的行列（2026-09-08）：跟随上游图集 meta（sheetGrid）。
  //   装不下自动扩（与执行器一致）：nUp 张装不下时按张数近似方形重算。
  //   ★ 图集预览块（拼贴动图+网格叠加）已移除——下方「表情包图片」网格
  //   （逐格 GIF，单格选中/重生成）信息量完全覆盖它，双份展示冗余。
  let effRows = sheetGrid?.rows ?? 1;
  let effCols = sheetGrid?.cols ?? 1;
  const nUp = upstreamCount ?? 0;
  if (nUp > 1 && effRows * effCols < nUp) {
    effCols = Math.min(6, Math.ceil(Math.sqrt(nUp)));
    effRows = Math.min(6, Math.ceil(nUp / effCols));
  }
  const effGrid = effRows > 1 || effCols > 1;
  void effGrid;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 生成渠道（2026-09-03，仿静态表情包节点）：ComfyUI（本地视频工作流 I2V）/ Provider（RPC） */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#c084fc' }}>🎬 生成渠道</span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button
              onClick={() => setBackend('comfyui')}
              style={{ padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                border: backend === 'comfyui' ? '1px solid #a855f7' : '1px solid rgba(255,255,255,.14)',
                background: backend === 'comfyui' ? 'rgba(168,85,247,.22)' : 'rgba(255,255,255,.05)',
                color: backend === 'comfyui' ? '#d8b4fe' : 'var(--vscode-foreground, #e8e8e8)' }}
            >ComfyUI</button>
            <button
              onClick={() => setBackend('provider')}
              style={{ padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                border: backend === 'provider' ? '1px solid #a855f7' : '1px solid rgba(255,255,255,.14)',
                background: backend === 'provider' ? 'rgba(168,85,247,.22)' : 'rgba(255,255,255,.05)',
                color: backend === 'provider' ? '#d8b4fe' : 'var(--vscode-foreground, #e8e8e8)' }}
            >Provider</button>
          </div>
        </div>
        {backend === 'comfyui' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>工作流</span>
              <select value={workflow} onChange={(e) => setWorkflow(e.target.value)} style={selectStyle}>
                {(workflowOptions ?? []).length === 0 && <option value="">（无可用视频工作流）</option>}
                {(workflowOptions ?? []).map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>Seed</span>
              <input
                type="number" min={0} step={1} value={seed}
                onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                title="0 = 每次执行随机；>0 固定（同 seed 可复现同一动图）"
                style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 6px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, fontFamily: 'monospace' }}
              />
              <button
                title="随机 Seed"
                onClick={() => setSeed(Math.floor(Math.random() * 0x7fffffff))}
                style={{ width: 26, height: 22, padding: 0, borderRadius: 4, cursor: 'pointer', fontSize: 11, border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground, #e8e8e8)' }}
              >🎲</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>Provider</span>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} style={selectStyle}>
                {videoGenProviders.length === 0 && <option value="">（无可用 Provider）</option>}
                {videoGenProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>Model</span>
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={selectStyle}>
                {modelOptions.length === 0 && <option value="">（无可用视频模型）</option>}
                {modelOptions.map(m => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              </select>
            </div>
          </>
        )}
      </div>

      {/* 参数页签：GIF 输出 / 绿幕抠像 两页切换（网格切分页随整图切格路线移除） */}
      <div style={{ border: '1px solid rgba(168,85,247,.28)', borderRadius: 8, background: 'rgba(168,85,247,.05)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(168,85,247,.28)' }}>
          {([
            { id: 'gif', label: '🎞 GIF 输出' },
            { id: 'chroma', label: '🟢 绿幕抠像' },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1, padding: '6px 4px', fontSize: 10, cursor: 'pointer', border: 'none',
                fontFamily: 'inherit', fontWeight: 600,
                color: tab === t.id ? '#d8b4fe' : 'var(--vscode-descriptionForeground, #9a9a9a)',
                background: tab === t.id ? 'rgba(168,85,247,.18)' : 'transparent',
                borderBottom: tab === t.id ? '2px solid #a855f7' : '2px solid transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tab === 'gif' && (
            <>
              {/* ★ GIF 输出开关（2026-09-08，默认开）：关闭 = 直接以生成的视频为产物 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={gifEnable}
                  onChange={(e) => setGifEnable(e.target.checked)}
                  style={{ accentColor: '#8a3fd0' }}
                />
                <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>转 GIF 输出（关闭则输出生成的视频）</span>
              </label>
              {!gifEnable && (
                <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
                  已关闭：产物为生成的视频（绿幕开=绿幕原片 mp4，可用于外部分析/二次处理；
                  绿幕关=原背景视频）。下方 GIF 参数不生效。
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: gifEnable ? 1 : 0.4, pointerEvents: gifEnable ? 'auto' : 'none' }}>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', fontFamily: 'monospace' }}>单格 240×240 · 循环 · 共 {Math.max(1, nUp)} 张</span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: gifEnable ? 1 : 0.4, pointerEvents: gifEnable ? 'auto' : 'none', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={loopBlend}
                  onChange={(e) => setLoopBlend(e.target.checked)}
                  style={{ accentColor: '#8a3fd0' }}
                />
                <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>首尾回环混合（尾部 4 帧渐回首帧，循环播放无缝）</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: gifEnable ? 1 : 0.4, pointerEvents: gifEnable ? 'auto' : 'none' }}>
                {stepper('时长 秒', durationS, 2, 5, 1, setDurationS)}
                {stepper('帧率 fps', fps, 6, 15, 1, setFps)}
                {stepper('单图上限 KB', maxKb, 100, 2000, 50, setMaxKb)}
              </div>
              {maxKb < 500 && (
                <div style={{ fontSize: 9, color: '#38bdf8' }}>
                  ℹ 上限 {maxKb}KB：低于微信单张动态表情上限（500KB）——会按
                  「帧率→色数」自动降级，低色数量化是颜色偏差/描边模糊主因。
                </div>
              )}
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
                上限针对**单个 GIF**（每格各自 ≤上限）：超限按「帧率→色数」降级
                （尺寸不降保 240×240）。★ 微信表情规范：动态 GIF 240×240 ≤500KB
                （8~24 为一套的张数）——默认 500KB 落点为 128 色 @ 8fps；100KB
                连 24 色 4fps 保底档都超限，且低色数量化必致颜色偏差。
                每格自动附带缩略图 PNG 240×240 ≤60KB（随条目 meta.thumb）
              </div>
            </>
          )}
          {tab === 'chroma' && (
            <>
              {/* ★ 双开关解耦（2026-09-08 用户需求）：绿幕合成（生成时叠绿底）与
                  抠像（生成后去绿幕）独立控制。抠像依赖绿幕——绿幕关时无绿可抠。 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={chromaEnable}
                  onChange={(e) => setChromaEnable(e.target.checked)}
                  style={{ accentColor: '#8a3fd0' }}
                />
                <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>启用绿幕合成（静态图叠加绿底生成）</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: chromaEnable ? 1 : 0.4 }}>
                <input
                  type="checkbox"
                  checked={matteEnable && chromaEnable}
                  disabled={!chromaEnable}
                  onChange={(e) => setMatteEnable(e.target.checked)}
                  style={{ accentColor: '#8a3fd0' }}
                />
                <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>启用抠像（生成后去绿幕 → 透明背景）</span>
              </label>
              {!chromaEnable && (
                <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
                  绿幕已关闭：静态图原样直喂视频模型（保留原背景），抠像自动忽略——
                  适用于**非透明背景**的图像（照片/带底插画），产出带背景的结果。
                </div>
              )}
              {chromaEnable && !matteEnable && (
                <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
                  抠像已关闭：视频在绿幕上生成但**不去绿幕**——产出绿幕原片/带绿背景
                  结果（可用于外部分析或二次处理）。
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: chromaEnable && matteEnable ? 1 : 0.4, pointerEvents: chromaEnable && matteEnable ? 'auto' : 'none' }}>
                <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>算法</span>
                <select
                  value={chromaAlgo}
                  onChange={(e) => setChromaAlgo(e.target.value as ChromaKeyAlgo)}
                  style={selectStyle}
                >
                  {CHROMA_KEY_ALGOS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6, opacity: chromaEnable && matteEnable ? 1 : 0.4 }}>
                {CHROMA_KEY_ALGOS.find(a => a.id === chromaAlgo)?.tip}
                {' '}（视觉对比工具：测试面板 → 抠像对比实验室，拖入绿幕视频逐帧并排对比）
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: chromaEnable && matteEnable ? 1 : 0.4, pointerEvents: chromaEnable && matteEnable ? 'auto' : 'none' }}>
                <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>绿幕色</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)', cursor: 'pointer', whiteSpace: 'nowrap' }} title="自动从视频首帧四边采样实际幕布色（推荐：视频编码会使幕布绿漂移，采样比固定色更准）。合成仍用纯绿。">
                  <input type="checkbox" checked={chromaAuto} onChange={(e) => setChromaAuto(e.target.checked)}
                    style={{ width: 12, height: 12, margin: 0, accentColor: '#e879f9' }} />
                  自动
                </label>
                <input type="color" value={chromaAuto ? '#00FF00' : chromaColor} disabled={chromaAuto} onChange={(e) => setChromaColor(e.target.value)}
                  style={{ width: 28, height: 22, padding: 0, border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, background: 'transparent', opacity: chromaAuto ? 0.4 : 1 }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--vscode-foreground, #e8e8e8)' }}>{chromaAuto ? 'auto（首帧采样）' : chromaColor}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: chromaEnable && matteEnable ? 1 : 0.4, pointerEvents: chromaEnable && matteEnable ? 'auto' : 'none' }}>
                {stepper('相似度', Math.round(chromaSimilarity * 100) / 100, 0.05, 1, 0.05, (v) => setChromaSimilarity(Math.max(0.05, Math.min(1, v))))}
                {stepper('去绿边', Math.round(chromaSmoothness * 100) / 100, 0, 1, 0.05, (v) => setChromaSmoothness(Math.max(0, Math.min(1, v))))}
              </div>
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', opacity: chromaEnable && matteEnable ? 1 : 0.4 }}>
                相似度越高抠得越干净（误伤风险↑）；去绿边控制主体边缘 despill 带宽；默认 0.25 / 0.08（与静态表情包切分同款）
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 表情包图片网格（2026-09-08）：与静态表情包节点同款交互——棋盘底
          （GIF 透明通道直显）+ 序号 + 单格点击选中（蓝框）+ 悬停 ⟳ 单格重生成。
          与静态的差异只在产物：格子内容是动图 GIF 而非静帧 PNG。 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.max(1, effCols)}, 1fr)`,
          gap: 6,
          padding: 8,
          border: '1px solid rgba(255,255,255,.1)',
          borderRadius: 8,
          background: '#1b1c20',
        }}
      >
        {Array.from({ length: Math.max(1, effRows) * Math.max(1, effCols) }).map((_, i) => {
          const cell = gridCellMedia[i];
          const ref = cell?.ref;
          const isVideo = cell?.isVideo === true;
          const isSel = selectedCells.has(i);
          const isStill = stillCells.has(i) && !isVideo;   // mp4 无「首帧静帧」语义
          // 静帧 = 首帧缓存（未解码完成时先显示原动图，解码完 bump 重渲染）
          const shown = ref && isStill ? (stillCache.current.get(ref) ?? ref) : ref;
          // ★ 格级四态预览（2026-09-08）：GIF（默认）→ 抠图 → 绿幕原片 → 输入原图
          //   循环；缺失态自动跳过。按钮图标 = **下一个模式**（✂️ 抠图 / 🎬 视频 /
          //   🖼 原图 / 🎞 GIF）。
          const videoRef = videoByCell.get(i);
          const sourceRef = cellSourceRefs?.[i];
          const availVideo = !!videoRef && !!ref && !isVideo;
          const availSource = !!sourceRef;
          const rawMode = previewModes.get(i) ?? 'gif';
          const mode: 'gif' | 'matte' | 'video' | 'source' =
            rawMode === 'video' && !availVideo ? 'gif'
            : rawMode === 'matte' && !availVideo ? 'gif'
            : rawMode === 'source' && !availSource ? 'gif'
            : rawMode;
          const showVideo = mode === 'video';
          const showMatte = mode === 'matte';
          const showSource = mode === 'source';
          const matteEntry = matteSeq.get(i);
          const matteReady = showMatte && !!matteEntry && matteEntry.urls.length > 0;
          const orderNow: Array<'gif' | 'matte' | 'video' | 'source'> =
            ['gif', ...(availVideo ? ['matte', 'video'] as const : []), ...(availSource ? ['source'] as const : [])];
          const nextMode = orderNow[(orderNow.indexOf(mode) + 1) % orderNow.length];
          const nextIcon = nextMode === 'video' ? '🎬' : nextMode === 'source' ? '🖼' : nextMode === 'matte' ? '✂️' : '🎞';
          const modeLabel: Record<string, string> = { gif: '抠图 GIF', matte: '抠像预览', video: '原始视频', source: '输入原图' };
          return (
            <div
              key={i}
              onClick={() => setSelectedCells(prev => {
                const next = new Set(prev);
                if (next.has(i)) { next.delete(i); } else { next.add(i); }
                return next;
              })}
              onMouseEnter={() => setHoverCell(i)}
              onMouseLeave={() => setHoverCell(null)}
              title={ref ? '点击选中（可多选）· 右上切 原图/视频/GIF · ⟳ 重新抠图+GIF（当前参数，不重新生成视频）' : (sourceRef ? '待生成 · 当前显示该格输入原图，生成后自动替换为 GIF' : '等待生成（上游图集该格）')}
              style={{
                // 棋盘底纹（对齐静态编辑器 checkerBackground：透明通道直显）
                backgroundImage:
                  'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
                  'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
                  'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
                  'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
                backgroundSize: '10px 10px',
                backgroundPosition: '0 0, 0 5px, 5px -5px, -5px 0px',
                backgroundColor: '#232428',
                position: 'relative',
                aspectRatio: '1 / 1',
                borderRadius: 6,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: isSel ? '1.5px solid #4a9eff' : '1.5px solid rgba(255,255,255,.06)',
                boxShadow: isSel ? '0 0 0 2px rgba(74,158,255,.28)' : 'none',
                overflow: 'hidden',
              }}
            >
              <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 8, color: 'rgba(255,255,255,.6)', fontFamily: 'monospace', zIndex: 2 }}>{i}</span>
              {/* ★ 右上角（2026-09-08 四态）：抠图 GIF → 抠像预览 → 原始视频 → 输入
                  原图 循环切换——按钮显示下一模式图标；非 GIF 模式紫底高亮。 */}
              {ref && !isVideo && (availVideo || availSource) && (
                <button
                  title={`当前：${modeLabel[mode]} · 点击切换为：${modeLabel[nextMode]}`}
                  onClick={(ev) => { ev.stopPropagation(); cyclePreviewMode(i, availVideo, availSource); }}
                  style={{
                    position: 'absolute', top: 2, right: 3, height: 16, padding: '0 4px',
                    borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, lineHeight: 1,
                    background: mode === 'gif' ? 'rgba(0,0,0,.55)' : 'rgba(168,85,247,.75)', color: '#fff', zIndex: 3, opacity: 1,
                  }}
                >
                  {nextIcon}
                </button>
              )}
              {showMatte ? (
                matteReady && matteEntry ? (
                  <>
                    <img
                      src={matteEntry.urls[matteEntry.idx]} alt={`cell-matte-${i}`}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                    {/* 帧导航（抠像序列）：‹ › 翻帧 + 帧号——检查边缘随时间变化 */}
                    <div
                      onClick={(ev) => ev.stopPropagation()}
                      style={{
                        position: 'absolute', bottom: 2, left: 3, right: 3, height: 16,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
                        background: 'rgba(0,0,0,.55)', borderRadius: 4, zIndex: 3,
                      }}
                    >
                      <button
                        title="上一帧"
                        onClick={(ev) => { ev.stopPropagation(); stepMatteFrame(i, -1); }}
                        style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '0 3px' }}
                      >‹</button>
                      <span style={{ fontSize: 8, fontFamily: 'monospace', color: '#fff' }}>{matteEntry.idx + 1}/{matteEntry.urls.length}</span>
                      <button
                        title="下一帧"
                        onClick={(ev) => { ev.stopPropagation(); stepMatteFrame(i, 1); }}
                        style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '0 3px' }}
                      >›</button>
                    </div>
                  </>
                ) : (
                  <span style={{ color: '#8b8b8b', fontSize: 11 }}>抠像中⋯</span>
                )
              ) : showVideo ? (
                <video
                  src={(videoRef && playableByUrl.get(videoRef)) ?? videoRef}
                  autoPlay loop muted controls playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
                />
              ) : showSource ? (
                <img src={sourceRef} alt={`cell-src-${i}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : shown ? (
                isVideo ? (
                  <video
                    src={playableByUrl.get(shown) ?? shown}
                    autoPlay loop muted controls playsInline
                    style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
                  />
                ) : (
                  <img src={shown} alt={`cell-${i}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                )
              ) : sourceRef ? (
                // ★ 无产物时默认铺该格输入原图（2026-09-08）：引入 images 后各格
                //   即时可见将要处理的内容，生成后自动被 GIF 覆盖（不再显示 ＋）。
                //   ★ 不加白底（2026-09-08 修正）：传入的是透明背景贴纸，白底 img
                //   会把透明区涂白——透明通道直接透出格子棋盘底（与 GIF 一致）。
                <img
                  src={sourceRef} alt={`cell-src-${i}`}
                  style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 0.92 }}
                />
              ) : (
                <span style={{ color: '#6b6b6b', fontSize: 18 }}>＋</span>
              )}
              {onRunCellRequest && ref && (
                <button
                  title="重新抠图+GIF（用当前相似度/去绿边参数，不重新生成视频，秒级完成）"
                  onClick={(ev) => { ev.stopPropagation(); setSelectedCells(new Set([i])); onRunCellRequest(i); }}
                  style={{
                    position: 'absolute', right: 3, bottom: 3, width: 20, height: 20,
                    borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: 1,
                    background: 'rgba(0,0,0,.55)', color: '#fff', zIndex: 2,
                    opacity: hoverCell === i ? 1 : 0, transition: 'opacity .12s',
                  }}
                >
                  ⟳
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 运行按钮（2026-09-08 语义拆分，对应用户需求）：
          主按钮 = 跟随网格选中格「生成动态表情[x]」（选中格重生成）；
          「生成全部动态表情」= 卡片 RUN 按钮（nodeCard 点击前归位 run_scope='all'）。
          running → 取消，与卡片取消同链路 wf-node-abort。 */}
      {onRunRequest && (
        running ? (
          <button
            title="中止当前运行"
            onClick={() => onCancelRequest?.()}
            style={{
              padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              border: 'none', color: '#fff', background: '#b91c1c',
            }}
          >
            ⏹ 取消（生成中…）
          </button>
        ) : (
          <button
            title={selectedCells.size > 0
              ? `只重新生成选中的格（${[...selectedCells].sort((a, b) => a - b).join(', ')}），其余格保持不变`
              : '生成全部动态表情（未选中任何格）'}
            onClick={() => {
              if (selectedCells.size === 0) {
                // 全不选 → 生成全部（归位 run_scope='all' 再运行）
                onCommit({ run_scope: 'all' });
                onRunRequest();
                return;
              }
              // 选中格 → 批量重生成：cell_indices（0-based 排序数组）。
              // ★ 单/多格统一走 'cell'（2026-09-08 语义拆分）：onRunCellRequest
              //   已被 ⟳ 的 rematte（只抠图不生成视频）占用——主按钮必须完整
              //   重生成（视频→抠像→GIF），不得复用该通道。
              {
                const sorted = [...selectedCells].sort((a, b) => a - b);
                onCommit({ run_scope: 'cell', cell_indices: JSON.stringify(sorted) });
                onRunRequest();
              }
            }}
            style={{
              padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              border: 'none', color: '#fff', background: 'linear-gradient(180deg,#a855f7,#8b3fd0)',
            }}
          >
            ▶ {selectedCells.size === 0
              ? '生成表情包'
              : `生成表情包[${compressRanges([...selectedCells].sort((a, b) => a - b))}]`}
          </button>
        )
      )}
    </div>
  );
}
