/** 迷你图像编辑器（原表情格编辑器扩展）：**原图自定义裁剪/剪切** + 画笔/矩形/套索/
 *  橡皮/文字、色板、平滑、缩放、撤销/重做。所有绘制作用于整图 overlay 层，Save 时与
 *  底图合成上抛。
 *
 *  ★ 默认从「生成的原图」开始：viewMode='sheet' + tool='crop'，用户在原图上拖拽出
 *    自定义裁剪框 → 点「应用剪切」执行**剪切算法**（框外在 overlay 上挖成透明），
 *    再切到 'cell' 视图做细节编辑。
 *
 *  ★ AI 工具（2026-09-03）：去背景（本地 rembg）/ AI消除 / 局部重绘（蒙版 +
 *    provider img2img，imagegen.generate RPC）/ 扩图（四边外扩 + img2img）。
 *    AI 结果直接替换**工作基底**（baseRef，原图 prop 只读不动），可撤销；Save 时
 *    随裁剪一并上抛。实现细节见 miniEditorAi.ts 顶部注释。 */
import * as React from 'react';
import { sendRequest } from '../../bridge/messageClient.js';
import { useProviderStore } from '../../store/useProviderStore';
import { resolvePreferredImageGenDefaults } from './comfyHost/workflowRun.js';
import {
	composeMarkedImage,
	composeOutpaintMarked,
	buildErasePrompt,
	buildInpaintPrompt,
	buildOutpaintPrompt,
	downscaleDataUrl,
	extractFirstImageDataUrl,
	loadImage,
	rembgRemoveDataUrl,
	MARK_COLOR,
} from './miniEditorAi.js';

export interface CellCropRect { x: number; y: number; w: number; h: number; }

/** 画布视图：'sheet' = 整张原图（自定义裁剪取景）；'cell' = 裁剪框内容放大（细节编辑）。 */
type ViewMode = 'sheet' | 'cell';

export interface Props {
  /** LLM / ComfyUI 返回的**原生整图**（只读基底，永不被本编辑器改写）。 */
  sheetDataUrl: string;
  /**
   * 降级模式（旧版产物：只有切分后的单格图，无原生整图）→ **只编辑本格图片**。
   *
   * 此时整张图 = 这一格，不存在「裁剪坐标系错位」问题，但**整图裁剪失去意义**，
   * 因此：强制格内视图、隐藏 ✂/✥ 裁剪类工具与「应用剪切」「🖼 原图」按钮，
   * 仅保留画笔/矩形/套索/橡皮/文字等直接绘制工具。
   */
  sheetOnly?: boolean;
  cellKey: number;
  /** 顶部标题覆盖（缺省 = 「编辑格 {cellKey}」；整图编辑模式 nodeCard 传「编辑原图」）。 */
  heading?: string;
  /** 初始裁剪框（归一化）——组件内部维护 working state，应用时上抛。 */
  crop: CellCropRect;
  /**
   * 应用：
   *  - `crop` = 调整后的裁剪框（归一化，写回 cell_crops 供下次对齐）；
   *  - `croppedDataUrl` = **裁剪框内区域渲染出的 PNG**（底图 + 编辑层合成后裁剪），
   *    调用方用它**直接替换该格产物**（ownOutputs[cell]）。
   *
   * ★ 整图（sheetFull）本编辑器**只读**：所有编辑（剪切/画笔/橡皮/文字）只体现在
   *   裁剪产物上，原图保持不变 → 任意格可反复从原生整图重新编辑。
   */
  onApply: (crop: CellCropRect, croppedDataUrl: string) => void;
  onClose: () => void;
  /**
   * ★ AI 工具（消除/重绘/扩图）优先使用的 provider/model —— 与**打开本编辑器的
   * 节点**保持一致（节点 values 的 provider/model）。不传/无效时回落首个可用。
   * 修复：节点用 lightai 而编辑器固定取「第一个 provider」落到 grnexus（平台
   * 不支持 Images API）⇒ POST /images/generations 404。
   */
  preferredProviderId?: string;
  preferredModelId?: string;
  /**
   * ★ 锁定 provider（2026-09-03）：AI 工具**必须**使用 preferredProviderId——
   * 其不可用时**报错**而不是回落其它 provider（「节点用 A、编辑器用 B」的
   * 出图差异极难排查，宁可显式失败）。
   */
  lockProvider?: boolean;
}

type Tool = 'pan' | 'crop' | 'move' | 'brush' | 'rect' | 'lasso' | 'erase' | 'text'
  // AI 工具：aierase/aiinpaint = 蒙版涂抹（画到 maskRef，品红预览）；outpaint/rembg = 面板/即跑
  | 'aierase' | 'aiinpaint' | 'outpaint' | 'rembg';
type Corner = 'nw' | 'ne' | 'sw' | 'se';
type Drag =
  // ★ startNx/startNy = 起点**整图归一化坐标**（视图无关：pan/resize 位移一律按整图比例）
  | { mode: 'pan' | 'resize'; startNx: number; startNy: number; orig: CellCropRect }
  // ★ handle = 拖拽裁剪框四角手柄（sheet 视图）：对角固定，被拖角跟随光标
  | { mode: 'handle'; corner: Corner; orig: CellCropRect }
  // ★ view = 视图平移（放大后拖拽滚动查看，与裁剪框无关）——🤚 工具
  | { mode: 'view'; startCx: number; startCy: number; sl0: number; st0: number }
  | null;

const TOOLS: Array<{ id: Tool; label: string; icon: string; hint: string }> = [
  // 🤚 视图平移：放大后拖拽查看（全模式可用；降级模式下是唯一的「拖拽」能力）
  { id: 'pan', label: '平移', icon: '🤚', hint: '拖拽平移视图（放大后查看细节）' },
  // ★ 默认工具：在原图上拖拽出自定义裁剪框（松手即生效，可再点「应用剪切」）
  { id: 'crop', label: '剪切', icon: '✂', hint: '在原图拖拽框选裁剪区域 → 点「应用剪切」' },
  { id: 'move', label: '移动', icon: '✥', hint: '拖拽平移 · Shift+拖拽缩放裁剪框' },
  { id: 'brush', label: '画笔', icon: '🖌', hint: '按住绘制（当前颜色/笔刷）' },
  { id: 'rect', label: '矩形', icon: '▭', hint: '拖拽绘制矩形描边' },
  { id: 'lasso', label: '套索', icon: '🕸', hint: '圈选区域并擦除（透明）' },
  { id: 'erase', label: '橡皮', icon: '🧽', hint: '涂抹擦除' },
  { id: 'text', label: '文字', icon: 'T', hint: '点击位置输入文字' },
  // ── AI 工具（生成类走 provider img2img，见 miniEditorAi.ts）────────────────
  { id: 'aierase', label: 'AI消除', icon: '⌫', hint: '涂抹要消除的内容 → 执行消除（AI 填补背景）' },
  { id: 'aiinpaint', label: '重绘', icon: '✎', hint: '涂抹区域 + 输入描述 → 执行重绘' },
  { id: 'outpaint', label: '扩图', icon: '⤢', hint: '选择扩展比例 → 执行扩图（AI 延展背景）' },
  { id: 'rembg', label: '去背景', icon: '🪄', hint: '点击立即抠出主体（透明背景，需本地 rembg 服务）' },
];

const PALETTE = ['#000000', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#06b6d4', '#ec4899', '#a855f7', '#d946ef'];
const HIST_MAX = 10;

/** 撤销栈条目：overlay 画布快照（同步克隆）或裁剪框快照。 */
type Snap =
  | { kind: 'overlay'; canvas: HTMLCanvasElement; blank: boolean }
  | { kind: 'crop'; crop: CellCropRect }
  /** AI 工具回滚：整个工作基底 + overlay 换代（base 替换走新建 canvas，引用安全）。 */
  | { kind: 'ai'; base: HTMLCanvasElement; overlay: HTMLCanvasElement; edited: boolean };

export function MiniImageEditor(p: Props): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const imgRef = React.useRef<HTMLImageElement | null>(null);
  /** 编辑层（整图尺寸）：画笔/矩形/文字 source-over，橡皮/套索 destination-out。 */
  const overlayRef = React.useRef<HTMLCanvasElement | null>(null);
  /**
   * ★ 工作基底（整图尺寸 canvas）：AI 工具（去背景/消除/重绘/扩图）的**结果图**
   *   直接替换它（prop 原图只读不动）；render/buildCropped/蒙版坐标全部以它为准。
   *   尺寸可能与原图不同（扩图变大）。初始 = p.sheetDataUrl。
   */
  const baseRef = React.useRef<HTMLCanvasElement | null>(null);
  /** AI 蒙版层（= 工作基底尺寸）：白=标记区，绘制时用品红（预览 + 烙标记图同色）。 */
  const maskRef = React.useRef<HTMLCanvasElement | null>(null);
  const dragRef = React.useRef<Drag>(null);
  const drawingRef = React.useRef(false);
  /** 当前笔画点集（整图像素坐标）：画笔平滑 / 套索闭合用。 */
  const strokePtsRef = React.useRef<Array<{ x: number; y: number }>>([]);
  const rectStartRef = React.useRef<{ x: number; y: number } | null>(null);
  /** 矩形拖拽预览（整图像素）——state 触发 render 叠加虚线框。 */
  const [rectDraft, setRectDraft] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // ★ working crop（内部 state）——拖拽/缩放实时更新，应用时一次性上抛
  const [crop, setCrop] = React.useState<CellCropRect>(p.crop);
  const cropRef = React.useRef(crop);
  cropRef.current = crop;
  // ★ 默认：从生成的原图（整张图集）开始自定义裁剪；降级模式（无原图）→ 格内视图 + 🤚平移
  const [viewMode, setViewMode] = React.useState<ViewMode>(p.sheetOnly ? 'cell' : 'sheet');
  const [tool, setTool] = React.useState<Tool>(p.sheetOnly ? 'pan' : 'crop');
  /** 画布滚动容器（🤚 视图平移改写其 scrollLeft/scrollTop）。 */
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  /** 剪切框拖拽中（整图归一化 {x0,y0,x1,y1}）——松手写入 crop。 */
  const [cropDraft, setCropDraft] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const cropStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [brush, setBrush] = React.useState(18);
  const [color, setColor] = React.useState('#3b82f6');
  /** 画笔平滑度 0..1：滑动窗口平均的强度。 */
  const [smooth, setSmooth] = React.useState(0.4);
  const [zoom, setZoom] = React.useState(1);
  const [ready, setReady] = React.useState(false);
  /** 基底图加载失败（ref 失效/跨域拒绝）——给用户明确提示而非白屏。 */
  const [loadError, setLoadError] = React.useState(false);
  const [hasEdits, setHasEdits] = React.useState(false);
  /** hasEdits 的同步镜像（快照打 blank 标记用，避免闭包旧值）。 */
  const hasEditsRef = React.useRef(false);
  const setEdited = (v: boolean) => { hasEditsRef.current = v; setHasEdits(v); };
  /** 撤销/重做栈（同步快照：overlay 克隆 canvas 或 crop）。 */
  const undoRef = React.useRef<Snap[]>([]);
  const redoRef = React.useRef<Snap[]>([]);
  const [, bumpHist] = React.useReducer((n: number) => n + 1, 0);
  /** 光标归一化位置（0..1，相对画布）——画笔/橡皮/套索圆环预览；归一化避免画布尺寸变化错位。 */
  const [cursorNorm, setCursorNorm] = React.useState<{ x: number; y: number } | null>(null);
  /** hover 裁剪框手柄/框内时的光标样式（sheet 视图，crop/move 工具）。 */
  const [hoverCursor, setHoverCursor] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const img = new Image();
    // ★ 跨域 ref（provider 远程 URL）：必须 anonymous，否则 drawImage 会污染
    //   canvas → buildCropped 的 toDataURL 抛 SecurityError（Save 静默失败）。
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      // ★ 数据打点：核对「LLM 原图 vs 编辑器输入图」——src 前缀（dataURL 长度/远程 url）
      //   + 实际解码尺寸。链路上 sheetFull 归档的是生成原始整图（store.put 不改 ref，
      //   抠白底/切分只处理格子产物），若尺寸与 LLM 返回不符则上游有问题。
      // eslint-disable-next-line no-console
      console.warn(`[MiniImageEditor] load cell=${p.cellKey} src=${p.sheetDataUrl.slice(0, 48)}… len=${p.sheetDataUrl.length} decoded=${img.naturalWidth}x${img.naturalHeight}`);
      const ov = document.createElement('canvas');
      ov.width = img.naturalWidth; ov.height = img.naturalHeight;
      overlayRef.current = ov;
      // 工作基底 = 原图初始快照（AI 工具的结果会整体替换它）
      const base = document.createElement('canvas');
      base.width = img.naturalWidth; base.height = img.naturalHeight;
      base.getContext('2d')?.drawImage(img, 0, 0);
      baseRef.current = base;
      const mk = document.createElement('canvas');
      mk.width = img.naturalWidth; mk.height = img.naturalHeight;
      maskRef.current = mk;
      undoRef.current = []; redoRef.current = [];
      hasEditsRef.current = false;
      setHasEdits(false);
      setReady(true);
    };
    img.onerror = () => {
      if (cancelled) return;
      setLoadError(true);
      // eslint-disable-next-line no-console
      console.error(`[MiniImageEditor] sheet load FAILED cell=${p.cellKey} src=${p.sheetDataUrl.slice(0, 60)}…`);
    };
    img.src = p.sheetDataUrl;
    return () => { cancelled = true; };
  }, [p.sheetDataUrl]);

  // ── 撤销/重做（同步：快照 = overlay 克隆 canvas / crop 对象，恢复零延迟）──────
  const pushOverlaySnap = () => {
    const ov = overlayRef.current;
    if (!ov) return;
    const c = document.createElement('canvas');
    c.width = ov.width; c.height = ov.height;
    c.getContext('2d')?.drawImage(ov, 0, 0);
    undoRef.current.push({ kind: 'overlay', canvas: c, blank: !hasEditsRef.current });
    if (undoRef.current.length > HIST_MAX) undoRef.current.shift();
    redoRef.current = [];
    bumpHist();
  };
  const pushCropSnap = (orig: CellCropRect) => {
    undoRef.current.push({ kind: 'crop', crop: { ...orig } });
    if (undoRef.current.length > HIST_MAX) undoRef.current.shift();
    redoRef.current = [];
    bumpHist();
  };
  /**
   * AI 工具执行前快照：工作基底 + overlay 整体克隆（AI 结果会**替换**两者）。
   * base 克隆而非直接引用——防「之后某处就地改写 baseRef 内容」的隐患（与 overlay
   * 同策略，代价是一次整图内存拷贝，可接受）。
   */
  const pushAiSnap = () => {
    const base = baseRef.current, ov = overlayRef.current;
    if (!base || !ov) return;
    const bc = document.createElement('canvas');
    bc.width = base.width; bc.height = base.height;
    bc.getContext('2d')?.drawImage(base, 0, 0);
    const oc = document.createElement('canvas');
    oc.width = ov.width; oc.height = ov.height;
    oc.getContext('2d')?.drawImage(ov, 0, 0);
    undoRef.current.push({ kind: 'ai', base: bc, overlay: oc, edited: hasEditsRef.current });
    if (undoRef.current.length > HIST_MAX) undoRef.current.shift();
    redoRef.current = [];
    bumpHist();
  };
  /** AI 交互快照的对偶（undo↔redo 互推当前状态）。 */
  const pushAiSnapTo = (arr: Snap[]) => {
    const base = baseRef.current, ov = overlayRef.current;
    if (!base || !ov) return;
    const bc = document.createElement('canvas');
    bc.width = base.width; bc.height = base.height;
    bc.getContext('2d')?.drawImage(base, 0, 0);
    const oc = document.createElement('canvas');
    oc.width = ov.width; oc.height = ov.height;
    oc.getContext('2d')?.drawImage(ov, 0, 0);
    arr.push({ kind: 'ai', base: bc, overlay: oc, edited: hasEditsRef.current });
  };
  const restoreSnap = (s: Snap) => {
    if (s.kind === 'crop') {
      setCrop(s.crop);
      cropRef.current = s.crop;   // 立即同步（render 走 cropRef）
    } else if (s.kind === 'ai') {
      // AI 回滚：基底/overlay 整体换回快照（再克隆一层——之后画笔会就地改写
      // overlayRef.current，不能与快照共享同一画布，否则二次 undo 会读到污染内容）
      const bc = document.createElement('canvas');
      bc.width = s.base.width; bc.height = s.base.height;
      bc.getContext('2d')?.drawImage(s.base, 0, 0);
      baseRef.current = bc;
      const oc = document.createElement('canvas');
      oc.width = s.overlay.width; oc.height = s.overlay.height;
      oc.getContext('2d')?.drawImage(s.overlay, 0, 0);
      overlayRef.current = oc;
      setEdited(s.edited);
    } else {
      const ov = overlayRef.current;
      const ctx = ov?.getContext('2d');
      if (ov && ctx) {
        ctx.clearRect(0, 0, ov.width, ov.height);
        ctx.drawImage(s.canvas, 0, 0);
        setEdited(!s.blank);
      }
    }
    render();
  };
  const undo = () => {
    const s = undoRef.current.pop();
    if (!s) return;
    if (s.kind === 'crop') {
      redoRef.current.push({ kind: 'crop', crop: { ...cropRef.current } });
    } else if (s.kind === 'ai') {
      pushAiSnapTo(redoRef.current);
    } else {
      const ov = overlayRef.current;
      if (ov) {
        const c = document.createElement('canvas');
        c.width = ov.width; c.height = ov.height;
        c.getContext('2d')?.drawImage(ov, 0, 0);
        redoRef.current.push({ kind: 'overlay', canvas: c, blank: !hasEditsRef.current });
      }
    }
    restoreSnap(s);
    bumpHist();
  };
  const redo = () => {
    const s = redoRef.current.pop();
    if (!s) return;
    if (s.kind === 'crop') {
      undoRef.current.push({ kind: 'crop', crop: { ...cropRef.current } });
    } else if (s.kind === 'ai') {
      pushAiSnapTo(undoRef.current);
    } else {
      const ov = overlayRef.current;
      if (ov) {
        const c = document.createElement('canvas');
        c.width = ov.width; c.height = ov.height;
        c.getContext('2d')?.drawImage(ov, 0, 0);
        undoRef.current.push({ kind: 'overlay', canvas: c, blank: !hasEditsRef.current });
      }
    }
    restoreSnap(s);
    bumpHist();
  };

  const render = React.useCallback(() => {
    const canvas = canvasRef.current, base = baseRef.current;
    if (!canvas || !base || !ready) return;
    const c = cropRef.current;
    // ★ 一律画工作基底（AI 结果已替换的图），而非只读 prop 原图
    const W = base.width, H = base.height;
    // ★ 源矩形 floor/ceil（与 splitStickerSheet 裁切同款取整）：框覆盖的源像素
    //   一个不少；clamp 到图界（拖拽把 crop 推到边界时不产生透明边）。
    //   显示与裁切同矩形 → 编辑器看到什么，拆分就裁出什么。
    const sx = Math.max(0, Math.floor(c.x * W));
    const sy = Math.max(0, Math.floor(c.y * H));
    const sw = Math.max(1, Math.min(W, Math.ceil((c.x + c.w) * W)) - sx);
    const sh = Math.max(1, Math.min(H, Math.ceil((c.y + c.h) * H)) - sy);
    // sheet 视图画**整张原图**（自定义裁剪取景）；cell 视图画裁剪框内容（细节编辑）
    const vx = viewMode === 'sheet' ? 0 : sx;
    const vy = viewMode === 'sheet' ? 0 : sy;
    const vw = viewMode === 'sheet' ? W : sw;
    const vh = viewMode === 'sheet' ? H : sh;
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, vw, vh);
    ctx.drawImage(base, vx, vy, vw, vh, 0, 0, vw, vh);
    const ov = overlayRef.current;
    // ★ 走 hasEditsRef（同步镜像）：restoreSnap 同步恢复后 state 尚未生效，读 state 会画不出恢复内容
    if (ov && hasEditsRef.current) ctx.drawImage(ov, vx, vy, vw, vh, 0, 0, vw, vh);
    // ── AI 蒙版预览（品红半透明；仅蒙版类工具可见）────────────────────────
    const mask = maskRef.current;
    if (mask && (tool === 'aierase' || tool === 'aiinpaint')) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(mask, vx, vy, vw, vh, 0, 0, vw, vh);
      ctx.restore();
    }
    // ── 自定义工具光标（对齐 MaskPainter：圆圈 + 中心准星，大小 = 笔刷）───────
    const ringTool = tool === 'brush' || tool === 'erase' || tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint';
    if (ringTool && cursorNorm) {
      const px = cursorNorm.x * vw, py = cursorNorm.y * vh;
      // brush 是整图像素直径；画布内部像素与整图像素 1:1，故半径直接取 brush/2
      // （显示缩放由 CSS 宽高自动完成，此处**不可**再乘 rect/width 比值）
      const radius = Math.max(3, brush / 2);
      // ★ 双描边（深色外圈 + 工具专属色内圈）：单色细圈在浅色/深色底图上都看不清，
      //   双描边任意底色可见；工具各有专属色一眼区分
      //   （画笔白 / 橡皮橙 / 套索粉 / AI 擦除玫瑰红 / AI 补绘翠绿）。
      const ringColor = tool === 'erase' ? '#fb923c'
        : tool === 'lasso' ? '#f472b6'
          : tool === 'aierase' ? '#fb7185'
            : tool === 'aiinpaint' ? '#34d399'
              : '#ffffff';
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px, py, radius + 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.stroke();
      // 中心准星（同双描边）
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - 4, py); ctx.lineTo(px + 4, py);
      ctx.moveTo(px, py - 4); ctx.lineTo(px, py + 4);
      ctx.stroke();
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px - 4, py); ctx.lineTo(px + 4, py);
      ctx.moveTo(px, py - 4); ctx.lineTo(px, py + 4);
      ctx.stroke();
      ctx.restore();
    }
    // ── 矩形拖拽预览（虚线框）────────────────────────────────────────────
    if (tool === 'rect' && rectDraft) {
      const d = rectDraft;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, brush);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(d.x0, d.x1) - vx, Math.min(d.y0, d.y1) - vy, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.restore();
    }
    // ── 裁剪框（原图视图：框外半透明遮罩 + 蓝框 + 四角手柄）──────────────
    if (viewMode === 'sheet') {
      const cx = c.x * W, cy = c.y * H, cw = c.w * W, chh = c.h * H;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);           // 外框
      ctx.rect(cx, cy, cw, chh);      // 内框 → evenodd = 环形（框外）区域
      ctx.fill('evenodd');
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(cx, cy, cw, chh);
      ctx.setLineDash([]);
      const s = Math.max(6, Math.min(cw, chh) * 0.06);
      ctx.fillStyle = '#60a5fa';
      for (const [hx, hy] of [[cx, cy], [cx + cw, cy], [cx, cy + chh], [cx + cw, cy + chh]]) {
        ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
      }
      // ── 像素尺寸标签：框上方显示「W × H px」（贴到图顶时移到框内顶部）────
      // canvas 内部像素 = 整图像素 1:1，CSS 按 zoom 缩放显示 → 字号按整图宽度
      // 等比取值，保证任意图幅/缩放下标签都可读。
      const label = `${Math.round(cw)} × ${Math.round(chh)} px`;
      const fontSize = Math.max(13, Math.round(W * 0.022));
      ctx.font = `600 ${fontSize}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const lx = Math.max(2, Math.min(W - tw - 10, cx));
      const lyAbove = cy - fontSize - 8;
      const ly = lyAbove >= 2 ? lyAbove : cy + 4;
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.fillRect(lx - 4, ly - 2, tw + 8, fontSize + 8);
      ctx.fillStyle = '#dbeafe';
      ctx.fillText(label, lx, ly + fontSize);
      ctx.restore();
    }
    // ── 剪切框拖拽预览（黄虚线）──────────────────────────────────────────
    if (cropDraft) {
      const d = cropDraft;
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(
        Math.min(d.x0, d.x1) * W - vx, Math.min(d.y0, d.y1) * H - vy,
        Math.abs(d.x1 - d.x0) * W, Math.abs(d.y1 - d.y0) * H,
      );
      ctx.restore();
    }
  }, [ready, tool, cursorNorm, brush, color, rectDraft, viewMode, cropDraft]);

  // ★ 重绘依赖必须含 crop：拖拽走 setCrop（state）→ render 的 useCallback 依赖
  //   故意不含 crop（走 cropRef）→ 若 effect 只依赖 [render, p.crop]，拖拽期间
  //   两个依赖都不变 → 画布**永不重绘**（crop 实际在变、视觉不动 =「无法拖拽」）。
  React.useEffect(() => { render(); }, [render, p.crop, crop]);

  /**
   * 画布事件坐标 → **整图归一化坐标（0..1）**。
   * sheet 视图：画布即整图 → 直接用；cell 视图：画布是裁剪框内容 → 按 crop 反算。
   */
  const pointerToSheetNorm = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    if (viewMode === 'sheet') return { x: u, y: v };
    const c = cropRef.current;
    return { x: c.x + u * c.w, y: c.y + v * c.h };
  };

  /** 画布事件坐标 → 整图像素坐标（画笔/橡皮等编辑统一用整图坐标）。 */
  const pointerToSheet = (e: React.PointerEvent) => {
    const img = imgRef.current;
    const n = pointerToSheetNorm(e);
    if (!img || !n) return null;
    return { x: n.x * img.naturalWidth, y: n.y * img.naturalHeight };
  };

  /**
   * ★ 裁剪框 hit-test（sheet 视图）：光标是否落在**四角手柄**（±14 显示像素容差）、
   * **框内**（可拖动整体）、或**框外**（重新框选）。手柄优先于框内。
   */
  const hitCropHandle = (n: { x: number; y: number }): { kind: 'handle'; corner: Corner } | { kind: 'inside' } | { kind: 'outside' } | null => {
    if (viewMode !== 'sheet') return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const tol = 14 / rect.width;
    const c = cropRef.current;
    const corners: Array<[Corner, number, number]> = [
      ['nw', c.x, c.y], ['ne', c.x + c.w, c.y], ['sw', c.x, c.y + c.h], ['se', c.x + c.w, c.y + c.h],
    ];
    for (const [corner, hx, hy] of corners) {
      if (Math.abs(n.x - hx) <= tol && Math.abs(n.y - hy) <= tol) return { kind: 'handle', corner };
    }
    return n.x >= c.x && n.x <= c.x + c.w && n.y >= c.y && n.y <= c.y + c.h ? { kind: 'inside' } : { kind: 'outside' };
  };

  /** 手柄 hover → 光标样式（对角缩放 / 框内移动）。 */
  const CORNER_CURSOR: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

  /**
   * ★ 裁剪产物：把「底图 + 编辑层」按当前裁剪框裁出一张**新 PNG**（= 本格最终产物）。
   *
   * 与 splitStickerSheet 同源取整（floor/ceil）：编辑器看到什么就裁出什么。
   * 整图本身不被改写 → 任意格都能反复从原生整图重新裁剪/编辑。
   */
  const buildCropped = (): string => {
    const base = baseRef.current;
    if (!base) return '';
    const W = base.width, H = base.height;
    const c = cropRef.current;
    const sx = Math.max(0, Math.floor(c.x * W));
    const sy = Math.max(0, Math.floor(c.y * H));
    const sw = Math.max(1, Math.min(W, Math.ceil((c.x + c.w) * W)) - sx);
    const sh = Math.max(1, Math.min(H, Math.ceil((c.y + c.h) * H)) - sy);
    const out = document.createElement('canvas');
    out.width = sw; out.height = sh;
    const ctx = out.getContext('2d');
    if (!ctx) return '';
    const ov = overlayRef.current;
    if (ov && hasEditsRef.current) {
      // 先合成到临时整图，再按框裁出（与 render 的画面完全一致）
      const full = document.createElement('canvas');
      full.width = W; full.height = H;
      const fctx = full.getContext('2d');
      if (fctx) {
        fctx.drawImage(base, 0, 0);
        fctx.drawImage(ov, 0, 0);
        ctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
        return out.toDataURL('image/png');
      }
    }
    ctx.drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL('image/png');
  };

  /**
   * ★ 剪切算法：把裁剪框**以外**的区域在 overlay 上挖成透明（destination-out + evenodd 环形）。
   *
   * 归档契约保持不变（整图 + crop 框，下游 recrop 按 crop 切图）——所以「剪切」不是
   * 生成新尺寸图像，而是**把框外清成透明**，这样 recrop 切出的格子天然只剩框内内容。
   * 可撤销（执行前 pushOverlaySnap）。
   */
  const applyCrop = () => {
    const ov = overlayRef.current, img = imgRef.current;
    if (!ov || !img) return;
    const ctx = ov.getContext('2d');
    if (!ctx) return;
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = cropRef.current;
    const cx = Math.max(0, Math.min(W - 1, Math.round(c.x * W)));
    const cy = Math.max(0, Math.min(H - 1, Math.round(c.y * H)));
    const cw = Math.max(1, Math.min(W - cx, Math.round(c.w * W)));
    const chh = Math.max(1, Math.min(H - cy, Math.round(c.h * H)));
    pushOverlaySnap();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.rect(cx, cy, cw, chh);
    ctx.fill('evenodd');   // 环形 = 框外区域 → 从 overlay 挖掉（合成后框外透明）
    ctx.restore();
    setEdited(true);
    setViewMode('cell');   // 剪切完自动进入格内视图做细节编辑
    render();
  };

  /** 平滑：对点序做滑动窗口平均（窗口 = 2*k+1，k = smooth*6）。 */
  const smoothedTail = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
    const k = Math.round(smooth * 6);
    if (k <= 0 || pts.length < 3) return pts;
    const lo = Math.max(0, pts.length - (2 * k + 1));
    const win = pts.slice(lo);
    return win.map((pt, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(win.length - 1, i + k); j++) { sx += win[j].x; sy += win[j].y; n++; }
      return { x: sx / n, y: sy / n };
    });
  };

  /** 在 overlay 上从 strokePts 画平滑曲线（paint：'erase' 用 destination-out）。 */
  const strokeOverlay = (paint: 'draw' | 'erase', pts: Array<{ x: number; y: number }>, through = false) => {
    const ov = overlayRef.current;
    if (!ov || pts.length === 0) return;
    const ctx = ov.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = paint === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = paint === 'erase' ? '#000' : color;
    ctx.lineWidth = brush;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (through) ctx.stroke();          // 增量绘制（画笔）：整段重描，透明度不受叠加影响
    else ctx.stroke();
    ctx.restore();
    setEdited(true);
    render();
  };

  /** 橡皮：圆点擦除（整图坐标）。 */
  const eraseAt = (sx: number, sy: number) => {
    const ov = overlayRef.current;
    if (!ov) return;
    const ctx = ov.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(sx, sy, brush / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    setEdited(true);
    render();
  };

  // ── AI 蒙版绘制（aierase/aiinpaint）：品红画到 maskRef（不入撤销体系，一键清空）──
  const maskDot = (sx: number, sy: number) => {
    const ctx = maskRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.fillStyle = MARK_COLOR;
    ctx.beginPath(); ctx.arc(sx, sy, brush / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    render();
  };
  const maskStroke = (pts: Array<{ x: number; y: number }>) => {
    const ctx = maskRef.current?.getContext('2d');
    if (!ctx || pts.length === 0) return;
    ctx.save();
    ctx.strokeStyle = MARK_COLOR;
    ctx.lineWidth = brush;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
    render();
  };
  const maskFillPolygon = (pts: Array<{ x: number; y: number }>) => {
    const ctx = maskRef.current?.getContext('2d');
    if (!ctx || pts.length < 3) return;
    ctx.save();
    ctx.fillStyle = MARK_COLOR;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    render();
  };
  const clearMask = () => {
    const mask = maskRef.current;
    const ctx = mask?.getContext('2d');
    if (mask && ctx) { ctx.clearRect(0, 0, mask.width, mask.height); render(); }
  };
  /** 蒙版是否有笔迹（无笔迹时执行消除/重绘直接提示，不浪费一次 provider 调用）。 */
  const maskHasInk = (mask: HTMLCanvasElement): boolean => {
    const ctx = mask.getContext('2d');
    if (!ctx) return false;
    const d = ctx.getImageData(0, 0, mask.width, mask.height).data;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) return true; }
    return false;
  };

  // ── AI 工具执行（后端契约见 miniEditorAi.ts 顶部注释）────────────────────
  const [aiBusy, setAiBusy] = React.useState<string | null>(null);
  const [aiError, setAiError] = React.useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = React.useState('');
  const [outpaintRatio, setOutpaintRatio] = React.useState(0.25);
  const providers = useProviderStore(s => s.providers);
  const loadProviders = useProviderStore(s => s.loadProviders);
  React.useEffect(() => {
    if (providers.length === 0) { void loadProviders(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** AI 工具的 provider/model：**优先节点配置**（preferredProviderId/ModelId）。
   *  lockProvider（表情包节点=true）时**不回落**其它 provider——无效即 undefined
   *  （AI 工具执行时报错引导修复配置）。 */
  const imgGen = React.useMemo(
    () => resolvePreferredImageGenDefaults(providers, p.preferredProviderId, p.preferredModelId, { lock: p.lockProvider === true }),
    [providers, p.preferredProviderId, p.preferredModelId, p.lockProvider],
  );
  // 对账日志：诊断「AI 工具落到错误 provider」——区分 preferred 传丢 / 校验回落。
  React.useEffect(() => {
    const summary = providers.map(x =>
      `${x.id}(${x.authStatus ?? '?'},${(x.models ?? []).filter(m => m.supportsImageGen).map(m => m.id).join('|') || 'no-img-model'})`,
    ).join(', ');
    // eslint-disable-next-line no-console
    console.log(
      `[MiniImageEditor] imgGen resolve → ${imgGen?.providerId ?? 'none'}/${imgGen?.modelId ?? 'none'} ` +
      `| preferred=${p.preferredProviderId ?? '—'}/${p.preferredModelId ?? '—'} | providers=[${summary}]`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, p.preferredProviderId, p.preferredModelId]);

  /** AI 结果 → 新工作基底（pushAiSnap 须在此之前入栈）。蒙版/overlay 一并重建。 */
  const applyAiResult = (dataUrl: string): Promise<void> => new Promise((resolve, reject) => {
    loadImage(dataUrl).then((img) => {
      const base = document.createElement('canvas');
      base.width = img.naturalWidth; base.height = img.naturalHeight;
      base.getContext('2d')?.drawImage(img, 0, 0);
      const ov = document.createElement('canvas');
      ov.width = base.width; ov.height = base.height;
      const mk = document.createElement('canvas');
      mk.width = base.width; mk.height = base.height;
      baseRef.current = base;
      overlayRef.current = ov;
      maskRef.current = mk;
      setEdited(true);
      render();
      resolve();
    }).catch(reject);
  });

  /** 生成类工具（消除/重绘/扩图）：合成品红标记图 → img2img RPC → 替换基底。 */
  const runAiGen = async (kind: 'erase' | 'inpaint' | 'outpaint') => {
    const base = baseRef.current;
    if (!base) return;
    if (!imgGen) {
      // ★ 锁定模式（与节点同源）：preferred provider 不可用 ≠ 静默换一个——
      //   换了 provider 的出图结果与节点配置完全不同，且极难排查。
      setAiError(
        p.lockProvider && p.preferredProviderId
          ? `AI 工具要求使用节点配置的 provider「${p.preferredProviderId}」，但其不可用（未认证 / 无文生图模型）。请到 设置 → 模型提供方 检查，或在节点上更换 provider。`
          : '未配置文生图 Provider：请到 设置 → 模型提供方 认证一个含文生图模型的 provider。',
      );
      return;
    }
    const mask = maskRef.current;
    if (kind !== 'outpaint' && mask && !maskHasInk(mask)) {
      setAiError('请先在图上涂抹要处理的区域（品红色蒙版，画笔/套索均可）。');
      return;
    }
    if (kind === 'inpaint' && !aiPrompt.trim()) {
      setAiError('请先输入重绘内容描述。');
      return;
    }
    setAiError(null);
    setAiBusy(kind === 'erase' ? 'AI 消除中…' : kind === 'inpaint' ? '局部重绘中…' : '扩图生成中…');
    try {
      // 1) 合成品红标记图（底 + 已有编辑层 + 蒙版/扩图区）
      let marked = '';
      let outW = base.width, outH = base.height;
      if (kind === 'outpaint') {
        const r = composeOutpaintMarked(base, overlayRef.current, hasEditsRef.current, outpaintRatio);
        marked = r.dataUrl; outW = r.plan.width; outH = r.plan.height;
      } else {
        marked = composeMarkedImage(base, overlayRef.current, hasEditsRef.current, mask);
      }
      if (!marked) { throw new Error('合成标记图失败'); }
      // 2) 缩到 provider 友好尺寸 + prompt
      const imageInput = await downscaleDataUrl(marked);
      const prompt = kind === 'erase' ? buildErasePrompt()
        : kind === 'inpaint' ? buildInpaintPrompt(aiPrompt)
          : buildOutpaintPrompt();
      // 3) img2img RPC（表情包「转动态表情包」同通道；host 会把远程 url 内联为 b64）
      const resp = await sendRequest<Record<string, unknown>, { images: Array<{ url?: string; b64?: string }> }>(
        'imagegen.generate',
        {
          providerId: imgGen.providerId,
          modelId: imgGen.modelId,
          prompt,
          numImages: 1,
          imageInput,
          width: Math.min(1536, outW),
          height: Math.min(1536, outH),
        },
        180_000,
      );
      const outDataUrl = extractFirstImageDataUrl(resp);
      // 4) 成功才入撤销栈 + 替换基底（失败不影响当前图）
      pushAiSnap();
      await applyAiResult(outDataUrl);
      clearMask();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(null);
    }
  };

  /** 去背景：本地 rembg（透明 PNG）→ 替换基底。 */
  const runAiRemoveBg = async () => {
    const base = baseRef.current;
    if (!base) return;
    setAiError(null);
    setAiBusy('去背景中…');
    try {
      const composed = composeMarkedImage(base, overlayRef.current, hasEditsRef.current, null);
      const out = await rembgRemoveDataUrl(composed, undefined, setAiBusy);
      pushAiSnap();
      await applyAiResult(out);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(null);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // 🤚 视图平移：拖拽 = 改写滚动容器 scrollLeft/scrollTop（与裁剪框、图像内容无关）
    if (tool === 'pan') {
      const c = containerRef.current;
      if (!c) return;
      dragRef.current = { mode: 'view', startCx: e.clientX, startCy: e.clientY, sl0: c.scrollLeft, st0: c.scrollTop };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
    const drawingTool = tool === 'brush' || tool === 'erase' || tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint';
    if (drawingTool) e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    // ✂/✥ 在原图视图：**手柄拖拽缩放 / 框内拖动 / 框外重新框选**（hit-test 决定）
    if ((tool === 'crop' || tool === 'move') && viewMode === 'sheet') {
      const n = pointerToSheetNorm(e);
      if (!n) return;
      const hit = hitCropHandle(n);
      if (hit?.kind === 'handle') {
        pushCropSnap(cropRef.current);
        dragRef.current = { mode: 'handle', corner: hit.corner, orig: { ...cropRef.current } };
        return;
      }
      if (hit?.kind === 'inside') {
        pushCropSnap(cropRef.current);
        dragRef.current = { mode: 'pan', startNx: n.x, startNy: n.y, orig: { ...cropRef.current } };
        return;
      }
      // 框外 → 重新框选（拖拽出新裁剪框）
      pushCropSnap(cropRef.current);
      cropStartRef.current = n;
      setCropDraft({ x0: n.x, y0: n.y, x1: n.x, y1: n.y });
      return;
    }
    // 格内视图的 ✂：重新框选（坐标按 crop 反算）
    if (tool === 'crop') {
      const n = pointerToSheetNorm(e);
      if (!n) return;
      pushCropSnap(cropRef.current);
      cropStartRef.current = n;
      setCropDraft({ x0: n.x, y0: n.y, x1: n.x, y1: n.y });
      return;
    }
    if (tool === 'text') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      const text = window.prompt('输入文字（绘制到点击位置）：');
      if (text && text.trim()) {
        pushOverlaySnap();
        const ov = overlayRef.current;
        const ctx = ov?.getContext('2d');
        if (ov && ctx) {
          ctx.save();
          const fontSize = Math.max(12, Math.round(brush * 1.6));
          ctx.font = `600 ${fontSize}px sans-serif`;
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';
          // ★ 深色描边衬底：纯色文字在相近色底图上直接「隐身」，先粗描边再填充
          //   保证任意底色可读（主流贴纸文字做法）
          ctx.lineWidth = Math.max(2, Math.round(fontSize / 7));
          ctx.strokeStyle = 'rgba(0,0,0,.85)';
          ctx.strokeText(text.trim(), pt.x, pt.y);
          ctx.fillStyle = color;
          ctx.fillText(text.trim(), pt.x, pt.y);
          ctx.restore();
          setEdited(true);
          render();
        }
      }
      return;
    }
    if (tool === 'brush') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      pushOverlaySnap();
      drawingRef.current = true;
      strokePtsRef.current = [pt];
      strokeOverlay('draw', [pt]);
      return;
    }
    // AI 蒙版涂抹（品红画到 maskRef，不入 overlay/撤销体系——可一键清空重涂）
    if (tool === 'aierase' || tool === 'aiinpaint') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      drawingRef.current = true;
      strokePtsRef.current = [pt];
      maskDot(pt.x, pt.y);
      return;
    }
    if (tool === 'lasso') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      pushOverlaySnap();
      drawingRef.current = true;
      strokePtsRef.current = [pt];
      strokeOverlay('erase', [pt]);
      return;
    }
    if (tool === 'erase') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      pushOverlaySnap();
      drawingRef.current = true;
      eraseAt(pt.x, pt.y);
      return;
    }
    if (tool === 'rect') {
      const pt = pointerToSheet(e);
      if (!pt) return;
      pushOverlaySnap();
      rectStartRef.current = pt;
      setRectDraft({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
      return;
    }
    // AI 面板类工具（rembg/outpaint）：画布交互无意义 → 不落入底部裁剪框拖拽 fallback
    if (tool === 'rembg' || tool === 'outpaint') { return; }
    // 移动工具：拖拽/缩放裁剪框也纳入撤销体系（拖拽开始前快照）
    const n0 = pointerToSheetNorm(e);
    pushCropSnap(cropRef.current);
    dragRef.current = {
      mode: e.shiftKey ? 'resize' : 'pan',
      startNx: n0?.x ?? 0, startNy: n0?.y ?? 0,
      orig: { ...cropRef.current },
    };
  };

  /** 记录光标归一化位置（0..1）——圆环光标跟随（对齐 MaskPainter 的 localN）+ 裁剪框 hover 光标。 */
  const trackCursor = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (tool === 'brush' || tool === 'erase' || tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint') {
      setCursorNorm({
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      });
      return;
    }
    // crop/move 在原图视图：手柄/框内 hover 光标反馈
    if ((tool === 'crop' || tool === 'move') && viewMode === 'sheet') {
      const n = pointerToSheetNorm(e);
      const hit = n ? hitCropHandle(n) : null;
      setHoverCursor(hit?.kind === 'handle' ? CORNER_CURSOR[hit.corner] : hit?.kind === 'inside' ? 'move' : null);
    } else if (hoverCursor) {
      setHoverCursor(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    trackCursor(e);
    if (tool === 'crop' && cropStartRef.current) {
      const n = pointerToSheetNorm(e);
      if (n) setCropDraft({ x0: cropStartRef.current.x, y0: cropStartRef.current.y, x1: n.x, y1: n.y });
      return;
    }
    if (drawingRef.current && (tool === 'brush' || tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint')) {
      const pt = pointerToSheet(e);
      if (!pt) return;
      const prev = strokePtsRef.current;
      const last = prev[prev.length - 1];
      if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1.5) return; // 采样去抖
      strokePtsRef.current = [...prev, pt];
      const seg = smoothedTail(strokePtsRef.current);
      if (tool === 'aierase' || tool === 'aiinpaint') { maskStroke(seg); } else { strokeOverlay(tool === 'brush' ? 'draw' : 'erase', seg, true); }
      return;
    }
    if (drawingRef.current && tool === 'erase') {
      const pt = pointerToSheet(e);
      if (pt) eraseAt(pt.x, pt.y);
      return;
    }
    if (tool === 'rect' && rectStartRef.current) {
      const pt = pointerToSheet(e);
      if (pt) setRectDraft({ x0: rectStartRef.current.x, y0: rectStartRef.current.y, x1: pt.x, y1: pt.y });
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'view') {
      const c = containerRef.current;
      if (!c) return;
      c.scrollLeft = d.sl0 - (e.clientX - d.startCx);
      c.scrollTop = d.st0 - (e.clientY - d.startCy);
      return;
    }
    const n = pointerToSheetNorm(e);
    if (!n) return;
    if (d.mode === 'handle') {
      // ★ 四角手柄缩放：**对角固定**，被拖角跟随光标（min 2% 防翻转）
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const o = d.orig;
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (d.corner === 'nw' || d.corner === 'sw') { x0 = clamp(n.x, 0, x1 - 0.02); } else { x1 = clamp(n.x, x0 + 0.02, 1); }
      if (d.corner === 'nw' || d.corner === 'ne') { y0 = clamp(n.y, 0, y1 - 0.02); } else { y1 = clamp(n.y, y0 + 0.02, 1); }
      setCrop({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      return;
    }
    // 位移按**整图归一化**（与视图无关，两种视图下手感一致）
    const dx = n.x - d.startNx, dy = n.y - d.startNy;
    const o = d.orig;
    if (d.mode === 'pan') {
      // ★ 裁剪框整体拖动 = **跟随鼠标**（o.x + dx / o.y + dy）。此前写成减号
      //   （o.x - dx）→ 拖拽方向完全反向（向上拖方块向下跑）。减号是「视图
      //   平移」（grab 滚动条反向）的语义，框移动不该用它。
      setCrop({ x: Math.max(0, Math.min(1 - o.w, o.x + dx)), y: Math.max(0, Math.min(1 - o.h, o.y + dy)), w: o.w, h: o.h });
    } else {
      setCrop({ x: Math.max(0, Math.min(0.98, o.x)), y: Math.max(0, Math.min(0.98, o.y)), w: Math.max(0.05, Math.min(1 - o.x, o.w + dx)), h: Math.max(0.05, Math.min(1 - o.y, o.h + dy)) });
    }
  };

  const onPointerUp = () => {
    // ✂ 框选结束 → 写入 crop（过小视为误点，丢弃并回退快照）
    if (tool === 'crop' && cropStartRef.current && cropDraft) {
      const d = cropDraft;
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w > 0.02 && h > 0.02) {
        setCrop({
          x: Math.max(0, Math.min(1, Math.min(d.x0, d.x1))),
          y: Math.max(0, Math.min(1, Math.min(d.y0, d.y1))),
          w: Math.min(1, w),
          h: Math.min(1, h),
        });
      } else {
        undoRef.current.pop();   // 误点：撤销这次空快照
        bumpHist();
      }
    }
    cropStartRef.current = null;
    setCropDraft(null);
    if ((tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint') && drawingRef.current && strokePtsRef.current.length > 2) {
      // 闭合套索区域：普通套索 = overlay 整片擦除；AI 蒙版套索 = 品红填 polygon
      const pts = smoothedTail(strokePtsRef.current);
      if (tool === 'lasso') {
        const ov = overlayRef.current;
        const ctx = ov?.getContext('2d');
        if (ov && ctx) {
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = '#000';
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          render();
        }
      } else {
        maskFillPolygon(pts);
      }
    }
    if (tool === 'rect' && rectStartRef.current && rectDraft) {
      const ov = overlayRef.current;
      const ctx = ov?.getContext('2d');
      if (ov && ctx) {
        const d = rectDraft;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, brush);
        ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
        ctx.restore();
        setEdited(true);
        render();
      }
    }
    rectStartRef.current = null;
    setRectDraft(null);
    drawingRef.current = false;
    strokePtsRef.current = [];
    dragRef.current = null;
  };

  const hint = TOOLS.find(t => t.id === tool)?.hint ?? '';
  /** 降级模式（无原生整图）隐藏裁剪类工具：整图裁剪需要原图才有意义。 */
  const tools = p.sheetOnly ? TOOLS.filter(t => t.id !== 'crop' && t.id !== 'move') : TOOLS;
  // hover 裁剪框手柄/框内时光标优先（缩放/移动反馈）
  const cursorCss = hoverCursor
    ? hoverCursor
      : tool === 'brush' || tool === 'erase' || tool === 'lasso' || tool === 'aierase' || tool === 'aiinpaint' ? 'none'
        : tool === 'text' ? 'crosshair'
          : (tool === 'rect' || tool === 'crop') ? 'crosshair'
            : tool === 'pan' ? (dragRef.current?.mode === 'view' ? 'grabbing' : 'grab')
              : (dragRef.current ? 'grabbing' : 'grab');
  const viewHint = viewMode === 'sheet'
    ? '原图：拖拽框选 · 方向键微调（1px，Shift=10px）'
    : '格内：裁剪框内容放大，可画笔/橡皮/文字';

  const iconBtn = (active: boolean): React.CSSProperties => ({
    width: 26, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 5, cursor: 'pointer', fontSize: 12,
    border: `1px solid ${active ? '#a855f7' : 'rgba(255,255,255,.14)'}`,
    background: active ? 'rgba(168,85,247,.22)' : 'rgba(255,255,255,.05)',
    color: active ? '#d8b4fe' : 'var(--vscode-foreground, #e8e8e8)',
    padding: 0,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* ── 工具栏（对齐参考截图：✕ · 工具组 · 色板 · 平滑/笔刷 · 缩放 · 撤销重做 · Save）── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#c084fc' }}>{p.heading ?? `编辑格 ${p.cellKey}`}</span>
        <div style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 7, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.1)' }}>
          {tools.map(t => (
            <button key={t.id} title={t.label} onClick={() => setTool(t.id)} style={iconBtn(tool === t.id)}>{t.icon}</button>
          ))}
        </div>
        {/* 色板 */}
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          {PALETTE.map(c => (
            <button key={c} title={c} onClick={() => setColor(c)} style={{
              width: 14, height: 14, borderRadius: '50%', padding: 0, cursor: 'pointer',
              background: c, border: color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,.25)',
              boxShadow: color === c ? '0 0 0 2px rgba(59,130,246,.6)' : 'none',
            }} />
          ))}
        </div>
        {/* 平滑（波浪线）+ 笔刷 */}
        <label title="笔画平滑度" style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', display: 'flex', alignItems: 'center', gap: 3 }}>
          ∿<input type="range" min={0} max={100} value={Math.round(smooth * 100)} onChange={(e) => setSmooth(Number(e.target.value) / 100)} style={{ width: 56 }} />
        </label>
        <label title="笔刷大小" style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', display: 'flex', alignItems: 'center', gap: 3 }}>
          ⬤<input type="range" min={4} max={120} value={brush} onChange={(e) => setBrush(Number(e.target.value))} style={{ width: 70 }} />
          <span style={{ minWidth: 20, textAlign: 'right' }}>{brush}</span>
        </label>
        {/* 视图切换：原图（自定义裁剪取景） / 格内（裁剪框内容放大）——降级模式隐藏 */}
        {!p.sheetOnly && (
          <div style={{ display: 'flex', gap: 3 }}>
            <button title="整张原图（自定义裁剪）" onClick={() => setViewMode('sheet')} style={{ ...iconBtn(viewMode === 'sheet'), width: 'auto', padding: '0 7px', fontSize: 10 }}>🖼 原图</button>
            <button title="裁剪框内容（细节编辑）" onClick={() => setViewMode('cell')} style={{ ...iconBtn(viewMode === 'cell'), width: 'auto', padding: '0 7px', fontSize: 10 }}>🔍 格内</button>
          </div>
        )}
        {/* ✂ 应用剪切：把框外挖成透明（可撤销）——降级模式隐藏 */}
        {!p.sheetOnly && (
          <button
            title="按当前裁剪框剪切：框外区域变为透明"
            onClick={applyCrop}
            style={{
              padding: '3px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 10, fontWeight: 600,
              border: '1px solid rgba(251,191,36,.5)', background: 'rgba(251,191,36,.16)', color: '#fbbf24',
            }}
          >✂ 应用剪切</button>
        )}
        {/* 缩放 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10 }}>
          <button title="缩小" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} style={iconBtn(false)}>−</button>
          <span style={{ minWidth: 36, textAlign: 'center', color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>{Math.round(zoom * 100)}%</span>
          <button title="放大" onClick={() => setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))} style={iconBtn(false)}>+</button>
          <button title="重置缩放" onClick={() => setZoom(1)} style={{ ...iconBtn(false), width: 'auto', padding: '0 6px', fontSize: 10 }}>1:1</button>
        </div>
        {/* 撤销/重做 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <button title="撤销 (Ctrl+Z)" disabled={undoRef.current.length === 0} onClick={undo} style={{ ...iconBtn(false), opacity: undoRef.current.length ? 1 : 0.35 }}>↶</button>
          <button title="重做 (Ctrl+Shift+Z)" disabled={redoRef.current.length === 0} onClick={redo} style={{ ...iconBtn(false), opacity: redoRef.current.length ? 1 : 0.35 }}>↷</button>
        </div>
        <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', marginLeft: 'auto' }}>{hint} · {viewHint}</span>
        <button onClick={p.onClose} style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground, #e8e8e8)' }}>✕</button>
      </div>

      {/* ── 基底图加载失败：明确提示（ref 失效/跨域拒绝），不给白屏 ── */}
      {loadError && (
        <div style={{
          height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
          borderRadius: 8, border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.08)',
        }}>
          <span style={{ fontSize: 11, color: '#f87171' }}>⚠ 编辑基底图加载失败</span>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
            图片引用可能已失效（远程 URL 过期 / ComfyUI 文件被清理）。请重新生成表情包。
          </span>
        </div>
      )}
      {/* ── AI 工具面板：蒙版类（涂抹→执行）· 扩图（比例→执行）· 去背景（即跑）── */}
      {(tool === 'aierase' || tool === 'aiinpaint' || tool === 'outpaint' || tool === 'rembg') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 8px', borderRadius: 7, border: '1px solid rgba(236,72,153,.35)', background: 'rgba(236,72,153,.08)' }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#f472b6' }}>🪄 AI</span>
          {/* 当前生效 provider/model 徽标：与节点配置不一致时立即可见（锁定模式红底警示） */}
          <span
            title={imgGen
              ? `AI 工具将使用 ${imgGen.providerId} / ${imgGen.modelId}`
              : (p.lockProvider && p.preferredProviderId
                ? `节点配置的 provider「${p.preferredProviderId}」不可用（未认证 / 无文生图模型）`
                : '未配置文生图 provider')}
            style={{
              fontSize: 9, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 3,
              border: `1px solid ${imgGen ? 'rgba(148,163,184,.4)' : 'rgba(239,68,68,.5)'}`,
              background: imgGen ? 'rgba(148,163,184,.12)' : 'rgba(239,68,68,.12)',
              color: imgGen ? '#cbd5e1' : '#f87171',
            }}
          >
            {imgGen ? `${imgGen.providerId} · ${imgGen.modelId}` : '⚠ provider 不可用'}
          </span>
          {tool === 'aiinpaint' && (
            <input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="重绘内容描述，例：给人物戴上红色帽子"
              data-no-node-drag="true"
              style={{ flex: 1, minWidth: 170, fontSize: 10, padding: '4px 7px', borderRadius: 5, border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground, #e8e8e8)', outline: 'none' }}
            />
          )}
          {tool === 'outpaint' && (
            <label style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', display: 'flex', alignItems: 'center', gap: 4 }}>
              每边扩展
              <input type="range" min={10} max={100} value={Math.round(outpaintRatio * 100)} onChange={(e) => setOutpaintRatio(Number(e.target.value) / 100)} style={{ width: 90 }} />
              <span style={{ minWidth: 26, textAlign: 'right' }}>{Math.round(outpaintRatio * 100)}%</span>
            </label>
          )}
          {(tool === 'aierase' || tool === 'aiinpaint') && (
            <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>在图上涂抹{tool === 'aierase' ? '要消除的内容' : '要重绘的区域'}（品红 = 选区，套索可圈选）</span>
          )}
          {tool === 'rembg' && <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>抠出主体 → 透明背景 PNG（本地 rembg）</span>}
          {(tool === 'aierase' || tool === 'aiinpaint') && (
            <button
              onClick={clearMask}
              disabled={!!aiBusy}
              style={{ padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 10, border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground, #e8e8e8)' }}
            >清空蒙版</button>
          )}
          <button
            disabled={!!aiBusy}
            onClick={() => {
              if (tool === 'rembg') { void runAiRemoveBg(); }
              else { void runAiGen(tool === 'aierase' ? 'erase' : tool === 'aiinpaint' ? 'inpaint' : 'outpaint'); }
            }}
            style={{
              padding: '4px 11px', borderRadius: 5, cursor: aiBusy ? 'wait' : 'pointer', fontSize: 10, fontWeight: 600,
              border: 'none', color: '#fff',
              background: aiBusy ? 'linear-gradient(180deg,#9ca3af,#6b7280)' : 'linear-gradient(180deg,#ec4899,#db2777)',
              opacity: aiBusy ? 0.8 : 1,
            }}
          >{aiBusy
            ?? (tool === 'rembg' ? '▶ 执行去背景' : tool === 'aierase' ? '▶ 执行消除' : tool === 'aiinpaint' ? '▶ 执行重绘' : '▶ 执行扩图')}</button>
          {aiError && <span style={{ fontSize: 10, color: '#f87171', flexBasis: '100%' }}>⚠ {aiError}</span>}
        </div>
      )}

      {/* ── 画布：容器窗口固定（缩放只改变图像大小，>100% 时容器内滚动，🤚 可拖拽平移）── */}
      {!loadError && (
      <div
        ref={containerRef}
        style={{
          height: 520, overflow: 'auto', display: 'flex',
          borderRadius: 8, border: '1px solid rgba(255,255,255,.12)', background: '#17181c',
        }}
      >
        <canvas
          ref={canvasRef}
          data-no-node-drag="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerEnter={trackCursor}
          onPointerLeave={() => { setCursorNorm(null); setHoverCursor(null); }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
            // ★ 方向键微调裁剪框（原图视图 + ✂/✥ 工具）：步长 1 整图像素（像素级
            //   对齐表情包格），Shift = 10px 粗调。撤销快照只在**首次按下**记
            //   （e.repeat 长按连发不入栈——一次连续微调算一次操作，undo 直达起点）。
            if (viewMode === 'sheet' && (tool === 'crop' || tool === 'move')
              && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault();
              const img = imgRef.current;
              if (!img) { return; }
              if (!e.repeat) { pushCropSnap(cropRef.current); }
              const step = e.shiftKey ? 10 : 1;
              const dx = (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) / img.naturalWidth;
              const dy = (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) / img.naturalHeight;
              const c = cropRef.current;
              setCrop({
                x: Math.max(0, Math.min(1 - c.w, c.x + dx)),
                y: Math.max(0, Math.min(1 - c.h, c.y + dy)),
                w: c.w, h: c.h,
              });
            }
          }}
          tabIndex={0}
          style={{
            width: `${zoom * 100}%`, margin: 'auto', flex: '0 0 auto', display: 'block',
            // ★ 透明区域棋盘格（主流图像编辑器惯例）：橡皮/套索/AI 擦除是「减法」
            //   ——在深色纯色底上擦透明区域几乎不可见（尤其透明底贴纸）。棋盘格
            //   只在像素 alpha=0 处露出，不影响导出（背景是 CSS 非画布像素）。
            background: 'repeating-conic-gradient(#26282e 0% 25%, #1b1d22 0% 50%) 0 0 / 16px 16px',
            cursor: cursorCss,
            touchAction: 'none',
            outline: 'none',
          }}
        />
      </div>
      )}

      {/* ── Save：裁剪框内区域（含编辑）→ 新 PNG 上抛，调用方替换该格产物 ── */}
      <button
        onClick={() => {
          let cropped = '';
          try {
            cropped = buildCropped();
          } catch (err) {
            // canvas 被跨域图污染 → toDataURL 抛 SecurityError（crossOrigin 已缓解，
            // 但服务端无 CORS 时仍可能发生）：给出明确出口而非静默崩溃。
            // eslint-disable-next-line no-console
            console.error('[MiniImageEditor] buildCropped failed (tainted canvas?):', err);
            window.alert('导出失败：基底图来自不允许跨域读取的来源。请重新生成表情包（产物将本地化存储后再编辑）。');
            return;
          }
          if (!cropped) return;
          p.onApply(cropRef.current, cropped);
        }}
        style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 10, fontWeight: 600, border: 'none', color: '#fff', background: 'linear-gradient(180deg,#3b82f6,#2563eb)' }}
      >
        💾 保存裁剪图{hasEdits ? '（含编辑）' : ''}
      </button>
    </div>
  );
}
