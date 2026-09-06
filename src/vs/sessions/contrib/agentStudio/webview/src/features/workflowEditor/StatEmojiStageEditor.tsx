/**
 * StatEmojiStageEditor — ComfyTV StatEmojiStage（静态表情包）的内嵌编辑器。
 *
 * 功能：生成 m×n 个静态透明背景贴纸。每个格子可独立编辑 prompt / seed 并单独
 * 重新生成；网格用棋盘格底纹实时展示透明通道。主题预设（3D / Q版 / 手绘 / Meme /
 * 漫画封 / 粘土 / 像素艺术 / 可爱风）对应一组**完整的主 prompt 模板**（见
 * emojiWorkflows 的 STYLE_PROMPT_TEMPLATE 映射），作为每格 prompt 的兜底来源，
 * 不切换 workflow 模板。
 *
 * 数据流（对齐 GridSplitEditor 的 onCommit 约定）：
 *   rows / cols / selected_index / cells / style_preset
 * cells 是 JSON 字符串（数组 [{prompt, seed}]），长度 = rows*cols，由本组件
 * 负责序列化/反序列化；onCommit 以 patch 形式写回（nodeCard → wf-node-control）。
 * 注：已移除顶部「全局 prompt」——改为由主题模板兜底，避免与每格 prompt 重复叠加。
 */
import * as React from 'react';
import { MentionTextarea, type MentionCandidate } from './comfyHost/MentionTextarea';
import { styleTemplateOf, EMOJI_SHEET_SIZES, EMOJI_SHEET_SIZE_DEFAULT } from './comfyHost/builtinWorkflows/emojiWorkflows.js';
import { useRunnerStatus } from './comfyHost/runnerStatusStore';
import { useProviderStore } from '../../store/useProviderStore';

export interface EmojiStageCell {
  prompt: string;
  seed: number;
}

/** 生成渠道（backend widget 值）。 */
export type EmojiBackend = 'comfyui' | 'provider';

/**
 * 整版图集背景策略（widget `sheet_background`，与 workflowRun.EmojiSheetBackground 同构）。
 * - auto（默认）：不指定背景，由每格 prompt 决定；切图兜底抠白底 ⇒ 出透明贴纸
 * - transparent：要求模型直接出透明底，切图不二次抠图（信任原生 alpha）
 * - white：白底，切图不抠（成图保留白底）
 */

const SHEET_BG_OPTIONS: Array<{ value: EmojiSheetBackground; label: string }> = [
  { value: 'auto', label: '跟随提示词（默认）' },
  { value: 'transparent', label: '透明底' },
  { value: 'white', label: '白底' },
];



export interface StatEmojiStageInit {
  rows: number;
  cols: number;
  /** 全局 prompt（所有格子默认值） */
  prompt: string;
  /** 主题预设（作为 prompt 后缀注入），缺省 'Q版'。 */
  stylePreset?: string;
  /** 每格独立状态，JSON 字符串（数组 [{prompt, seed}]） */
  cells: string;
  /** 每格裁剪框（归一化 [{x,y,w,h}] JSON）——缺省 = 等分。 */
  selectedIndex: number;
  /** 当前 workflow 模板名（静态贴纸，一般不切换）。 */
  workflow?: string;
  /** 生成渠道（缺省 'comfyui'）。 */
  backend?: EmojiBackend;
  /** ComfyUI 渠道 checkpoint 名（qwen/sdxl 等，→ 模板 ckpt_name）。 */
  comfyModel?: string;
  /** Provider 渠道 provider/model（文生图，supportsImageGen）。 */
  providerId?: string;
  modelId?: string;
  /** 整版图集背景策略（widget sheet_background，缺省 'white'）。 */
  sheetBackground?: EmojiSheetBackground;
  /** 生成图像大小（widget size，'WxH'，缺省 '1024x1024'）。 */
  size?: string;
}

export interface StatEmojiStageEditorProps {
  initial: StatEmojiStageInit;
  /**
   * ★ LLM / ComfyUI 返回的**原生整图** ref（`meta.sheetFull==='1'` 的归档，2026-09-03）。
   * 卡片上展示缩略图 + 切分网格叠加，让用户直观看到「生成的原图长什么样、
   * 每格是怎么切的」。缺失（旧版产物）时显示引导重新生成的提示。
   */
  sheetRef?: string;
  /** 原图归档自带的 rows/cols（store.put 时写入 meta）——网格叠加用。 */
  sheetGrid?: { rows: number; cols: number };
  /**
   * ★ **调整后图集** ref（port 'image'，meta.sheet='1'——单格编辑/裁剪保存后
   * 重拼的最终图集，**下游转动态节点实际读取的就是它**；2026-09-03）。
   * 供图集卡片双视图切换：原生整图（编辑基底）↔ 调整后（下游所见）。
   */
  rebuiltSheetRef?: string;
  /** 调整后图集的行列（重建时写入 meta）。 */
  rebuiltGrid?: { rows: number; cols: number };
  /** 每格已生成图 ref（可选，按 cell index 对齐；空则显示占位）。 */
  cellRefs?: Array<string | { ref: string; caption?: string; kind?: 'image' | 'video' } | undefined>;
  /** 可选 workflow 模板名列表（`workflowOptionsFor('emoji')`）。 */
  workflowOptions?: string[];
  /** 可选主题预设列表（缺省用内置 STYLE_PRESETS）。 */
  styleOptions?: string[];
  onCommit: (patch: Record<string, unknown>) => void;
  /** 触发运行（cellIndex 传入 = 只重生成该格）。 */
  onRunRequest?: (cellIndex?: number) => void;
  /** 节点运行中（2026-09-02）：生成按钮立即变「取消」。 */
  running?: boolean;
  /** 运行中点击按钮 → 中止（与卡片取消同链路 wf-node-abort）。 */
  onCancelRequest?: () => void;
  /** ★ 双击某格 → 进入单格编辑（MiniImageEditor：裁剪框拖拽/缩放 + 画笔/矩形/套索/橡皮/文字，nodeCard 层挂载）。 */
  onCellEdit?: (cellIndex: number) => void;
  /** ★ 双击 LLM 原图 → 整图编辑（MiniImageEditor 全图模式，nodeCard 层挂载；2026-09-03）。 */
  onSheetEdit?: () => void;
  /** ★ LLM 原图「去背景」按钮：本地 rembg 抠图 → 写入「调整后」图集口（原图归档不动；nodeCard 层执行）。 */
  onSheetRemoveBg?: () => void;
  /** ★ 当前原图是 sheet 口直通的上游图集（2026-09-06）：只读预览——禁整图编辑/去背景
      （写入会落到上游节点归档），提示条说明来源。本节点生成后自动恢复可编辑。 */
  isPassthroughSheet?: boolean;
  /** 去背景执行中（按钮禁用 + 文案切换）。 */
  sheetRemovingBg?: boolean;
  /** 去背景阶段进度（文本 + 可选百分比，用于按钮下方进度条；2026-09-05）。 */
  sheetRemoveBgStage?: { text: string; percent?: number } | null;
  /** 去背景成功计数（每次成功 +1 → 编辑器自动切到「🧩 调整后」页签；2026-09-06）。 */
  sheetRemoveBgDoneTick?: number;
  /** 应用裁剪（run_scope='recrop'：跳过生成，按 cell_crops 对整图重裁）。 */
  /** @ 提及候选（节点 + 文件），由 NodeCard 注入；缺省时输入框仍可用但无 @ 面板。 */
  mentionCandidates?: MentionCandidate[];
  /** @ 选中文件时钉成资产引用。 */
  onPinAsset?: (c: MentionCandidate) => void;
}

const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '1×1', rows: 1, cols: 1 },
  { label: '1×2', rows: 1, cols: 2 },
  { label: '2×1', rows: 2, cols: 1 },
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×2', rows: 3, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '3×4', rows: 3, cols: 4 },
  { label: '4×3', rows: 4, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '4×5', rows: 4, cols: 5 },
  { label: '5×4', rows: 5, cols: 4 },
  { label: '5×5', rows: 5, cols: 5 },
  { label: '6×6', rows: 6, cols: 6 },
];

/**
 * 主题预设（作为 prompt 后缀注入）。保持与 registry.ts 中 style_preset 的 COMBO
 * options 一致；新增预设时两处需同步。
 */
export const STYLE_PRESETS: string[] = [
  'Q版', '3D', '手绘', 'Meme', '漫画封', '粘土', '像素艺术', '可爱风',
];

/**
 * 动作词快捷面板（点击把视觉动词描述插入选中格 prompt）。
 *
 * 视觉动词体系对齐开源 MiniMax-AI/skills `gif-sticker-maker`（MIT）：
 * 前 4 个（挥手/大笑/大哭/比心）直接取自其 video-prompt-template.txt 的
 * `Action reference`（hi/laugh/cry/love）；其余为常见表情包动作的合理扩展。
 */
const EMOJI_ACTION_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: '👋 挥手', prompt: 'waving hand cheerfully, slight head tilt' },
  { label: '😂 大笑', prompt: 'shaking with laughter, eyes squinting shut' },
  { label: '😭 大哭', prompt: 'tears streaming down, body trembling gently' },
  { label: '💗 比心', prompt: 'making a heart gesture with both hands, eyes sparkling' },
  { label: '😳 害羞', prompt: 'blushing, looking away shyly, fingers fidgeting' },
  { label: '😠 生气', prompt: 'puffing cheeks, angry brows, steam from ears' },
  { label: '😮 惊讶', prompt: 'mouth open in surprise, eyes wide, eyebrows raised' },
  { label: '😴 犯困', prompt: 'yawning sleepily, heavy eyelids, a small Z floating' },
  { label: '🕺 跳舞', prompt: 'dancing happily, body swaying to a beat' },
  { label: '🤔 思考', prompt: 'hand on chin, thinking, eyes looking up' },
  { label: '👍 点赞', prompt: 'thumbs up, bright smile, nodding approvingly' },
  { label: '🤝 握手', prompt: 'shaking hands firmly, friendly eye contact' },
  { label: '🙏 拜托', prompt: 'praying hands together, pleading look, slight bow' },
  { label: '💪 加油', prompt: 'flexing arm muscle, determined grin, giving a cheer' },
  { label: '🏃 奔跑', prompt: 'running fast, arms pumping, wind blowing hair' },
  { label: '🤸 翻滚', prompt: 'doing a cheerful backflip, limbs spinning' },
  { label: '😎 耍酷', prompt: 'cool smirk, pushing up sunglasses, leaning back' },
  { label: '🥳 庆祝', prompt: 'party popper, throwing confetti, jumping with joy' },
  { label: '😘 飞吻', prompt: 'blowing a kiss, winking, finger hearts' },
  { label: '🤤 流口水', prompt: 'drooling, eyes glued to food, tongue out' },
  { label: '🥺 卖萌', prompt: 'puppy eyes, pouting lip, head tilt, begging cutely' },
  { label: '😱 尖叫', prompt: 'screaming in shock, hands on cheeks, mouth wide' },
  { label: '🤯 头脑爆炸', prompt: 'mind blown, head exploding with ideas, jaw dropped' },
  { label: '🙄 翻白眼', prompt: 'rolling eyes, unimpressed sigh, looking aside' },
  { label: '😏 偷笑', prompt: 'smug smirk, side glance, covering a sly grin' },
];

const chipStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 10,
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
  border: '1px solid rgba(255,255,255,.14)',
  background: 'rgba(255,255,255,.05)',
  color: 'var(--vscode-foreground, #e8e8e8)',
};

/** 把追加片段拼到已有 prompt 后（空则直接设，非空则加逗号和空格）。 */
function appendToPrompt(base: string, add: string): string {
  const t = base.trim();
  return t ? `${t}, ${add}` : add;
}

/** 动作词 chips：点击即把视觉动词插入选中格 prompt（竖向滚动，超出高度后滚动展示）。 */
function ActionChips({ onPick }: { onPick: (text: string) => void }): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 5,
        maxHeight: 84,
        overflowY: 'auto',
        paddingRight: 4,
        scrollbarWidth: 'thin',
      }}
    >
      {EMOJI_ACTION_CHIPS.map((c) => (
        <button
          key={c.label}
          title={c.prompt}
          onClick={() => onPick(c.prompt)}
          style={chipStyle}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

const btn = (active: boolean): React.CSSProperties => ({
  padding: '3px 8px',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
  border: '1px solid rgba(255,255,255,.14)',
  background: active ? 'rgba(74,158,255,.22)' : 'rgba(255,255,255,.05)',
  color: active ? '#9cc6ff' : 'var(--vscode-foreground, #e8e8e8)',
});

const checkerBackground: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
    'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
    'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
    'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
  backgroundColor: '#232428',
};

function parseCells(raw: string, count: number): EmojiStageCell[] {
  const empty: EmojiStageCell[] = Array.from({ length: count }, () => ({ prompt: '', seed: 0 }));
  if (!raw) { return empty; }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) { return empty; }
    const out: EmojiStageCell[] = [];
    for (let i = 0; i < count; i++) {
      const it = (arr as Array<Partial<EmojiStageCell>>)[i];
      out.push({
        prompt: typeof it?.prompt === 'string' ? it.prompt : '',
        seed: typeof it?.seed === 'number' && Number.isFinite(it.seed) ? it.seed : 0,
      });
    }
    return out;
  } catch {
    return empty;
  }
}

/**
 * ComfyUI 模型下拉选项（分组）：
 *  - group 'Checkpoint'：SDXL 等传统 checkpoint（CheckpointLoaderSimple，checkpoints/）
 *  - group 'Diffusion'：Qwen-Image / Flux 等新一代 diffusion 模型（UNETLoader，
 *    diffusion_models/）——「Qwen 贴纸」模板即用此类（unet_name）。
 * ★ 2026-09-04 起执行器按 value 前缀（ckpt:/unet:）+ 文件名判族**动态组装**
 *   工作流（emojiModelAdapt），两类模型任意选择都能正确生成——本下拉不再
 *   需要与「工作流」widget 手工配对。
 */
export interface ComfyModelOption { label: string; value: string; group: string }

/** /object_info 拉取失败时的兜底列表。 */
const COMFY_MODEL_FALLBACK: ComfyModelOption[] = [
  { label: 'sd_xl_base_1.0.safetensors', value: 'ckpt:sd_xl_base_1.0.safetensors', group: 'Checkpoint 模型' },
  { label: 'qwen_image_2512_fp8_e4m3fn.safetensors', value: 'unet:qwen_image_2512_fp8_e4m3fn.safetensors', group: 'Diffusion 模型' },
  { label: 'dreamshaper_8.safetensors', value: 'ckpt:dreamshaper_8.safetensors', group: 'Checkpoint 模型' },
];

/**
 * ComfyUI checkpoint 列表拉取（`/object_info/CheckpointLoaderSimple` →
 * `input.required.ckpt_name[0]` 枚举）。模块级按 baseUrl 缓存（ComfyUI 进程内
 * 模型列表不变）；失败回退 fallback 列表（首次启动模型目录可能仍在扫描）。
 */
const comfyModelsCache = new Map<string, string[]>();

/** /object_info/<node> 响应的所需切片（具名类型：.tsx 内联泛型会被当 JSX 解析）。 */
type ComfyObjectInfo = Record<string, {
  input?: { required?: Record<string, [string[], Record<string, unknown>]> };
}>;

/** 模型列表诊断日志：console + 沙箱状态栏（canvasHost 监听 sandbox-log 事件）。 */
function sandboxModelLog(text: string): void {
  console.info('[sandbox/emoji-models]', text);
  try {
    window.dispatchEvent(new CustomEvent('sandbox-log', { detail: { text: '[模型列表] ' + text, cls: 'dim' } }));
  } catch { /* 非沙箱宿主时无状态栏，忽略 */ }
}

async function fetchComfyModels(baseUrl: string): Promise<ComfyModelOption[]> {
  const cached = comfyModelsCache.get(baseUrl);
  if (cached) {
    sandboxModelLog(`命中缓存（${cached.length} 项，baseUrl=${baseUrl}）——刷新页面才会重拉`);
    return cached;
  }
  const base = baseUrl.replace(/\/$/, '');
  const pick = (json: ComfyObjectInfo, node: string, field: string): string[] => {
    const list = json?.[node]?.input?.required?.[field]?.[0];
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  };
  // ★ 并行拉两类 loader：Checkpoint（SDXL）+ UNET（Qwen-Image/Flux 等
  //   diffusion_models）—— 此前只查 CheckpointLoaderSimple，下拉里永远没有
  //   qwen（用户实测反馈）；而默认模板「Qwen 贴纸」恰恰需要 diffusion 模型。
  const [ck, un] = await Promise.allSettled([
    fetch(`${base}/object_info/CheckpointLoaderSimple`).then(r => { if (!r.ok) { throw new Error(String(r.status)); } return r.json(); }),
    fetch(`${base}/object_info/UNETLoader`).then(r => { if (!r.ok) { throw new Error(String(r.status)); } return r.json(); }),
  ]);
  const ckOk = ck.status === 'fulfilled';
  const unOk = un.status === 'fulfilled';
  const ckList = ckOk ? pick(ck.value, 'CheckpointLoaderSimple', 'ckpt_name') : [];
  const unList = unOk ? pick(un.value, 'UNETLoader', 'unet_name') : [];
  sandboxModelLog(`baseUrl=${base}  CheckpointLoaderSimple ${ckOk ? 'ok' : 'FAILED(' + String(ck.status === 'rejected' ? ck.reason : '') + ')'} → ck=${ckList.length} 个；UNETLoader ${unOk ? 'ok' : 'FAILED'} → unet=${unList.length} 个`);
  if (ckList.length === 0 && unList.length === 0) {
    sandboxModelLog('两类都为空 → 回退内置兜底列表（3 项）');
    return COMFY_MODEL_FALLBACK;
  }
  // ★ value 带来源前缀（2026-09-04）：ckpt:xxx / unet:xxx —— 执行器据此选择
  //   CheckpointLoaderSimple 或 UNETLoader 并按文件名判族组装工作流（模型驱动，
  //   不再依赖用户手工配对「工作流模板 × 模型」）。label 保持纯文件名供展示。
  const models: ComfyModelOption[] = [
    ...ckList.map(v => ({ label: v, value: `ckpt:${v}`, group: 'Checkpoint 模型' })),
    ...unList.map(v => ({ label: v, value: `unet:${v}`, group: 'Diffusion 模型' })),
  ];
  comfyModelsCache.set(baseUrl, models);
  sandboxModelLog(`下拉共 ${models.length} 项（Checkpoint ${ckList.length} 在前 + Diffusion ${unList.length} 在后）；当前选中值若不在列表内会被自动替换`);
  return models;
}

export function StatEmojiStageEditor({
  initial, sheetRef, sheetGrid, rebuiltSheetRef, rebuiltGrid, cellRefs, workflowOptions, styleOptions, onCommit, onRunRequest, running, onCancelRequest, onCellEdit, onSheetEdit, onSheetRemoveBg, isPassthroughSheet, sheetRemovingBg, sheetRemoveBgStage, sheetRemoveBgDoneTick, mentionCandidates, onPinAsset,
}: StatEmojiStageEditorProps): React.ReactElement {
  /** 原图解码尺寸（缩略图标签显示，也用于核对「LLM 返回 vs 编辑器输入」）。 */
  const [sheetSize, setSheetSize] = React.useState<{ w: number; h: number } | null>(null);
  /** ★ 图集卡片视图：original=原生整图（编辑基底）/ rebuilt=调整后图集（下游所见）。 */
  const [sheetView, setSheetView] = React.useState<'original' | 'rebuilt'>('original');
  // 去背景成功 → 自动切到「🧩 调整后」页签直显抠图结果（计数器跳变触发，避免初始挂载误切）。
  React.useEffect(() => {
    if (!sheetRemoveBgDoneTick) { return; }
    setSheetView('rebuilt');
  }, [sheetRemoveBgDoneTick]);
  const [rows, setRows] = React.useState<number>(Math.max(1, Math.min(6, initial.rows || 3)));
  const [cols, setCols] = React.useState<number>(Math.max(1, Math.min(6, initial.cols || 3)));
  const [stylePreset, setStylePreset] = React.useState<string>(
    initial.stylePreset ?? (styleOptions?.[0] ?? STYLE_PRESETS[0]));
  const [selectedIndex, setSelectedIndex] = React.useState<number>(initial.selectedIndex ?? 0);
  // ── 生成渠道（2026-09-02）：ComfyUI / Provider 选项卡 ─────────────────────
  const [backend, setBackend] = React.useState<EmojiBackend>(initial.backend === 'provider' ? 'provider' : 'comfyui');
  const [comfyModel, setComfyModel] = React.useState<string>(initial.comfyModel || COMFY_MODEL_FALLBACK[0].value);
  const [providerId, setProviderId] = React.useState<string>(initial.providerId || '');
  const [modelId, setModelId] = React.useState<string>(initial.modelId || '');
  // ── 生成图像大小（2026-09-02）：整版图集分辨率 ───────────────────────────
  const [size, setSize] = React.useState<string>(initial.size || EMOJI_SHEET_SIZE_DEFAULT);
  // ── 整版背景策略（2026-09-02）────────────────────────────────────────────
  // 旧版整版 prompt 硬编码「flat clean white background」，用户在格描述里写
  // 「透明背景」会被它覆盖（header 在前，模型优先采纳）。默认 auto = 不追加
  // 背景子句，交回用户 prompt / 主题模板（以 transparent background 结尾），
  // 并由切图兜底抠白底（cutoutBg）得到透明贴纸。
  const [sheetBackground, setSheetBackground] = React.useState<EmojiSheetBackground>(
    initial.sheetBackground === 'white' || initial.sheetBackground === 'transparent'
      ? initial.sheetBackground
      : 'auto',
  );

  // ComfyUI checkpoint 列表：runner 就绪后拉一次（模块级缓存）
  const runner = useRunnerStatus();
  const [comfyModels, setComfyModels] = React.useState<ComfyModelOption[]>(COMFY_MODEL_FALLBACK);
  React.useEffect(() => {
    if (!runner.ready || !runner.baseUrl) { return; }
    let cancelled = false;
    void fetchComfyModels(runner.baseUrl).then((list) => {
      if (!cancelled) { setComfyModels(list); }
    });
    return () => { cancelled = true; };
  }, [runner.ready, runner.baseUrl]);
  // 选中值不在列表（首拉完成/模板默认缺失本机模型）→ 自动落到第一个本机 Checkpoint：
  // 执行器按 value 前缀判族组装工作流——选 Diffusion 模型也能正确生成（不再 400）。
  React.useEffect(() => {
    if (comfyModels.length === 0) { return; }
    const val = (m: unknown): string => (typeof m === 'string' ? m : String((m as ComfyModelOption)?.value ?? ''));
    if (!comfyModels.some(m => val(m) === comfyModel)) {
      const firstCk = comfyModels.find(m => typeof m === 'string' || (m as ComfyModelOption).group === 'Checkpoint 模型');
      setComfyModel(val(firstCk ?? comfyModels[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comfyModels]);

  // Provider 渠道：文生图 provider/model（supportsImageGen 过滤）
  const providers = useProviderStore(s => s.providers);
  const loadProviders = useProviderStore(s => s.loadProviders);
  const imageGenProviders = React.useMemo(
    () => providers.filter(p => p.authStatus === 'authenticated' && (p.models ?? []).some(m => m.supportsImageGen)),
    [providers],
  );
  const activeProvider = imageGenProviders.find(p => p.id === providerId) ?? (providerId ? undefined : imageGenProviders[0]);
  const modelOptions = React.useMemo(
    () => (activeProvider?.models ?? []).filter(m => m.supportsImageGen),
    [activeProvider],
  );
  React.useEffect(() => {
    if (!activeProvider) { return; }
    if (activeProvider.id !== providerId) { setProviderId(activeProvider.id); return; }
    if (!modelOptions.some(m => m.id === modelId)) {
      const first = modelOptions[0]?.id;
      if (first) { setModelId(first); }
    }
  }, [activeProvider, providerId, modelOptions, modelId]);

  const presets = styleOptions && styleOptions.length > 0 ? styleOptions : STYLE_PRESETS;
  const workflow = initial.workflow && workflowOptions && workflowOptions.length > 0
    ? initial.workflow
    : (workflowOptions?.[0] ?? '');

  // ★ 模型组随模板切换（2026-09-03）：Qwen 贴纸 → Diffusion 模型；SDXL 模板 →
  //   Checkpoint 模型（两类 loader 加载目录互斥，混选必报错）。当前选中模型不
  //   属于该组时自动切到组内第一个。
  // ⚠ 必须放在 workflow 定义之后：依赖数组渲染期求值，放前面会 TDZ 崩溃
  //   （曾导致整个节点富卡片渲染空白）。
  // ★ 模型自由选择（不限用途）：执行侧按所选模型的组**自动配对工作流**——
  //   Diffusion → Qwen 贴纸模板（UNETLoader）；Checkpoint → 图集/透明模板（ckpt_name）。
  //   所选模型不在本机列表时回退按 workflow 推断。
  const selectedModelGroup = comfyModels.find(m => m.value === comfyModel)?.group
    ?? (/qwen/i.test(workflow ?? '') ? 'Diffusion 模型' : 'Checkpoint 模型');
  const recGroup = selectedModelGroup;

  const cellCount = rows * cols;
  const [cells, setCells] = React.useState<EmojiStageCell[]>(() => parseCells(initial.cells, cellCount));

  // rows/cols 变化 → 重建 cells（保留已有索引，收缩时截断、扩张时补空）。
  React.useEffect(() => {
    setCells(prev => {
      const next: EmojiStageCell[] = Array.from({ length: cellCount }, (_, i) =>
        prev[i] ?? { prompt: '', seed: 0 });
      return next;
    });
    if (selectedIndex > cellCount - 1) { setSelectedIndex(cellCount - 1); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellCount]);

  // 任何参数变化 → 序列化 cells 写回（保持 node.properties 与 UI 同步）。
  React.useEffect(() => {
    const patch: Record<string, unknown> = {
      rows, cols,
      style_preset: stylePreset,
      selected_index: selectedIndex,
      cells: JSON.stringify(cells),
      backend,
      comfy_model: comfyModel,
      comfy_model_group: selectedModelGroup,
      provider: providerId,
      model: modelId,
      size,
      sheet_background: sheetBackground,
    };
    // workflow 仅在本编辑器真的提供了选项时才写回，避免在无选项场景把
    // node.properties.workflow 覆写成空串（会让 runStageWorkflow 落回默认模板）。
    if (workflowOptions && workflowOptions.length > 0 && workflow) { patch.workflow = workflow; }
    onCommit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, stylePreset, selectedIndex, cells, workflow, backend, comfyModel, providerId, modelId, size, sheetBackground]);

  const setCell = (i: number, patch: Partial<EmojiStageCell>): void => {
    setCells(prev => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };

  const clampIdx = (v: number) => Math.max(0, Math.min(cellCount - 1, v));

  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>{label}</span>
      <button style={btn(false)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 18, textAlign: 'center' }}>{value}</span>
      <button style={btn(false)} onClick={() => onChange(Math.min(max, value + 1))}>＋</button>
    </div>
  );

  const selCell = cells[selectedIndex];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 生成渠道选项卡（2026-09-02）：ComfyUI（本地模型）/ Provider（图生图 RPC）。
          scope='all'（生成表情包）走「整图图集一次生成 → 前端 m×n 切分」；
          scope='cell'（生成此表情）只重出选中格。 */}
      <div style={{
        border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8,
        background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>🖼 生成渠道</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
            整图生成 → {rows}×{cols} 切分
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...btn(backend === 'comfyui'), flex: 1 }} onClick={() => setBackend('comfyui')}>
            ComfyUI
          </button>
          <button style={{ ...btn(backend === 'provider'), flex: 1 }} onClick={() => setBackend('provider')}>
            Provider
          </button>
        </div>
        {/* 生成图像大小（2026-09-02）：整版图集分辨率，两渠道共用。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>图像大小</span>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value)}
            style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4 }}
          >
            {EMOJI_SHEET_SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {backend === 'comfyui' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>模型</span>
            <select
              value={comfyModel}
              onChange={(e) => setComfyModel(e.target.value)}
              style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4 }}
            >
              {comfyModels.length === 0 && <option value="">（ComfyUI 未连接）</option>}
              {/* ★ 全量自由选择：所选模型组决定执行侧自动配对的工作流——
                  Diffusion → Qwen 贴纸模板；Checkpoint → 图集/透明模板（不 400） */}
              {(() => {
                const ck = comfyModels.filter(m => m.group === 'Checkpoint 模型');
                const un = comfyModels.filter(m => m.group === 'Diffusion 模型');
                const grp = (id: string, label: string, list: typeof ck, top: boolean) => (list.length ? (
                  <optgroup key={id} label={(top ? '★ ' : '') + label}>
                    {list.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </optgroup>
                ) : null);
                return [
                  grp('ck', 'Checkpoint 模型（自动配 图集/透明 模板）', ck, selectedModelGroup === 'Checkpoint 模型'),
                  grp('un', 'Diffusion 模型（自动配 Qwen 贴纸 模板）', un, selectedModelGroup === 'Diffusion 模型'),
                ];
              })()}
            </select>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>Provider</span>
              <select
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4 }}
              >
                {imageGenProviders.length === 0 && <option value="">（无可用 Provider）</option>}
                {imageGenProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>Model</span>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4 }}
              >
                {modelOptions.length === 0 && <option value="">（无可用图像模型）</option>}
                {modelOptions.map(m => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* 整版背景策略（2026-09-02）：auto=不追加背景子句，由每格 prompt / 主题模板
            决定（写"透明背景"即生效）/ transparent=要求模型直接出透明 / white=白底。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>图集底</span>
          <select
            value={sheetBackground}
            onChange={(e) => setSheetBackground(e.target.value as EmojiSheetBackground)}
            title="整版生成时的背景：跟随提示词（默认）=不追加背景约束，由你的描述决定；透明底=要求模型直接出透明；白底=强制白底。生成切分不做抠图——需要透明贴纸请在图集区点「去背景」（内置 U²Net）或用迷你编辑器处理。"
            style={{ flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px', background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)', border: '1px solid rgba(255,255,255,.14)', borderRadius: 4 }}
          >
            {SHEET_BG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

      </div>

      {/* ── LLM 原图缩略图（2026-09-03）：展示生成时归档的原生整图 + m×n 切分网格叠加。
          原图是「双击单格 → MiniImageEditor」的裁剪基底，这里让用户先直观确认原图。 */}
      <div style={{
        border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8,
        background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>🖼 图集</span>
          {/* 双视图：原生整图（编辑基底）/ 调整后（单格编辑保存后重拼=下游所见） */}
          {rebuiltSheetRef && (
            <div style={{ display: 'flex', gap: 3 }}>
              {([
                { id: 'original', label: '原生整图' },
                { id: 'rebuilt', label: '🧩 调整后' },
              ] as const).map(v => (
                <button
                  key={v.id}
                  onClick={() => setSheetView(v.id)}
                  title={v.id === 'rebuilt' ? '单格编辑/裁剪保存后重拼、或整图去背景后的图集——下游转动态节点读取的就是它' : 'LLM 返回的原生整图（编辑基底，去背景不会改动它）'}
                  style={{
                    padding: '2px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit',
                    border: sheetView === v.id ? '1px solid #a855f7' : '1px solid rgba(255,255,255,.14)',
                    background: sheetView === v.id ? 'rgba(168,85,247,.2)' : 'rgba(255,255,255,.05)',
                    color: sheetView === v.id ? '#d8b4fe' : 'var(--vscode-descriptionForeground, #9a9a9a)',
                  }}
                >{v.label}</button>
              ))}
            </div>
          )}
          {sheetSize && (
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
              {sheetSize.w}×{sheetSize.h}
              {sheetView === 'original' ? ' · 双击图片整图编辑' : ' · 下游转动态读取此图集'}
            </span>
          )}
          {/* 🪄 去背景：一键本地 rembg 抠图 → 透明 PNG 写入「调整后」图集（原图归档不动，
              抠图结果在「🧩 调整后」页签棋盘底直显透明效果）。
              仅原生整图视图显示（作用对象是编辑基底整图，调整后图集是派生产物）。 */}
          {sheetRef && sheetView === 'original' && (
            <button
              onClick={onSheetRemoveBg}
              disabled={sheetRemovingBg || isPassthroughSheet}
              title={isPassthroughSheet
                ? "当前原图来自上游 sheet 口连线（直通预览，只读）。请在生成本节点的原图后再去背景。"
                : "整图去背景 → 透明 PNG（本地 rembg 服务）。原图不动，结果显示在「🧩 调整后」页签，下游转动态读取该图集。"}
              style={{
                padding: '2px 7px', borderRadius: 5, cursor: sheetRemovingBg ? 'wait' : 'pointer', fontSize: 10, fontWeight: 600,
                border: '1px solid rgba(56,189,248,.5)', background: sheetRemovingBg ? 'rgba(148,163,184,.2)' : 'rgba(56,189,248,.16)', color: sheetRemovingBg ? '#94a3b8' : '#38bdf8',
                flexShrink: 0,
              }}
            >{sheetRemovingBg ? '去背景中…' : '🪄 去背景'}</button>
          )}
        </div>
        {/* ★ sheet 直通预览（2026-09-06）：原图来自上游连线 → 只读提示条。
            本节点生成自己的原图后 nodeCard 侧 isPassthroughSheet 变 false，提示自动消失。 */}
        {isPassthroughSheet && (
          <div style={{
            fontSize: 10, lineHeight: 1.6, padding: '4px 8px', borderRadius: 6,
            background: 'rgba(168,85,247,.12)', border: '1px solid rgba(168,85,247,.35)',
            color: '#d8b4fe',
          }}>
            当前「原图」为 sheet 口直通的上游图集（只读预览）：确认内容后点「生成」即按此图集切分。
            整图编辑 / 去背景需本节点生成原图后使用（避免改写上游归档）。
          </div>
        )}
        {/* 去背景进度条：模型下载阶段显示字节级百分比，其余阶段显示阶段文本（2026-09-05）。 */}
        {sheetRemovingBg && sheetRemoveBgStage && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,.1)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.max(2, Math.min(100, sheetRemoveBgStage.percent ?? 4))}%`,
                background: sheetRemoveBgStage.percent === undefined ? '#38bdf8' : 'linear-gradient(90deg,#38bdf8,#a855f7)',
                transition: 'width .4s ease', borderRadius: 2,
              }} />
            </div>
            <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>{sheetRemoveBgStage.text}</span>
          </div>
        )}
        {(() => {
          const shownRef = sheetView === 'rebuilt' && rebuiltSheetRef ? rebuiltSheetRef : sheetRef;
          const shownGrid = sheetView === 'rebuilt' ? rebuiltGrid : sheetGrid;
          if (!shownRef) {
            return (
              <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
                暂无图集（当前是旧版产物或尚未生成）。重新生成一次表情包后，这里会展示 LLM
                返回的原生整图，双击格子即可在上面自定义裁剪。
              </div>
            );
          }
          return (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {/* inline-block 让容器紧贴图像 → 网格线按百分比叠加才不会错位
                （若用 objectFit:'contain' + 定宽，图像两侧留白会让线偏移） */}
            <div style={{
              position: 'relative', display: 'inline-block', maxWidth: '100%',
              borderRadius: 6, overflow: 'hidden',
              // 透明棋盘底：贴纸多为透明背景，深色/浅色内容都能看清边界
              background: 'repeating-conic-gradient(#2a2c33 0 25%, #202228 0 50%) 0 0 / 16px 16px',
            }}>
              <img
                src={shownRef}
                alt="llm-sheet"
                title={sheetView === 'original' ? '双击整图编辑（MiniImageEditor）' : '调整后的图集（下游转动态节点读取）'}
                onDoubleClick={sheetView === 'original' && !isPassthroughSheet ? () => onSheetEdit?.() : undefined}
                onLoad={(e) => {
                  const im = e.currentTarget;
                  setSheetSize({ w: im.naturalWidth, h: im.naturalHeight });
                }}
                onError={() => setSheetSize(null)}
                style={{ display: 'block', maxWidth: '100%', maxHeight: 170, width: 'auto', height: 'auto', cursor: sheetView === 'original' ? 'zoom-in' : 'default' }}
              />
              {/* 切分网格叠加（rows/cols 线） */}
              {shownGrid && shownGrid.cols > 1 && Array.from({ length: shownGrid.cols - 1 }).map((_, i) => (
                <div key={`v${i}`} style={{
                  position: 'absolute', left: `${(i + 1) / shownGrid.cols * 100}%`, top: 0, bottom: 0, width: 1,
                  background: 'rgba(96,165,250,.55)', pointerEvents: 'none',
                }} />
              ))}
              {shownGrid && shownGrid.rows > 1 && Array.from({ length: shownGrid.rows - 1 }).map((_, i) => (
                <div key={`h${i}`} style={{
                  position: 'absolute', top: `${(i + 1) / shownGrid.rows * 100}%`, left: 0, right: 0, height: 1,
                  background: 'rgba(96,165,250,.55)', pointerEvents: 'none',
                }} />
              ))}
            </div>
          </div>
          );
        })()}
      </div>

      {/* 预设（横向滚动，避免宽度无限制增长） */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>预设尺寸</span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            overflowX: 'auto',
            paddingBottom: 4,
            maxWidth: '100%',
            scrollbarWidth: 'thin',
          }}
        >
          {PRESETS.map((p) => {
            const active = p.rows === rows && p.cols === cols;
            return (
              <button key={p.label} style={{ ...btn(active), flex: '0 0 auto' }} onClick={() => { setRows(p.rows); setCols(p.cols); }}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 行列：grid 双列（1fr），stepper 自然宽度收进列内，杜绝横向溢出 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {stepper('行', rows, 1, 6, setRows)}
        {stepper('列', cols, 1, 6, setCols)}
      </div>

      {/* m×n 网格 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 6,
          padding: 8,
          border: '1px solid rgba(255,255,255,.1)',
          borderRadius: 8,
          background: '#1b1c20',
        }}
      >
        {cells.map((c, i) => {
          const cellRef = cellRefs?.[i];
          const ref = typeof cellRef === 'string' ? cellRef : cellRef?.ref;
          const isSel = i === selectedIndex;
          return (
            <div
              key={i}
              onClick={() => { setSelectedIndex(clampIdx(i)); }}
              onDoubleClick={(ev) => { ev.stopPropagation(); onCellEdit?.(i); }}
              title="双击进入单格编辑（拖拽/缩放/橡皮擦）"
              style={{
                ...checkerBackground,
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
              <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 8, color: 'rgba(255,255,255,.6)', fontFamily: 'monospace' }}>{i}</span>
              {ref ? (
                <img src={ref} alt={`cell-${i}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <span style={{ color: '#6b6b6b', fontSize: 18 }}>＋</span>
              )}
              {onRunRequest && (
                <button
                  title="重新生成此格"
                  onClick={(ev) => { ev.stopPropagation(); setSelectedIndex(i); onRunRequest(i); }}
                  style={{
                    position: 'absolute', right: 3, bottom: 3, width: 20, height: 20,
                    borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, lineHeight: 1,
                    background: 'rgba(0,0,0,.55)', color: '#fff', opacity: 0, transition: 'opacity .12s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; }}
                >
                  ⟳
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 选中格编辑面板 */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
            编辑 <b style={{ color: '#4a9eff' }}>#{selectedIndex}</b> · 独立 prompt（留空则用主题默认）
          </span>
          <button style={btn(false)} onClick={() => setCell(selectedIndex, { prompt: '' })}>↩ 用主题默认</button>
        </div>
        <MentionTextarea
          value={selCell?.prompt ?? ''}
          onChange={(next) => setCell(selectedIndex, { prompt: next })}
          candidates={mentionCandidates ?? []}
          onPinAsset={onPinAsset}
          placeholder="描述这个表情，例如：😹 笑哭的橘猫（@ 可引用）"
          style={{
            minHeight: 40, background: '#17181c', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 6, fontSize: 11, padding: 6, lineHeight: 1.5, maxHeight: 120,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>动作（点击插入到本格 prompt）</span>
          <ActionChips onPick={(t) => setCell(selectedIndex, { prompt: appendToPrompt(selCell?.prompt ?? '', t) })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
          <span>种子</span>
          <span style={{ fontFamily: 'monospace', color: 'var(--vscode-foreground, #e8e8e8)' }}>{selCell?.seed ?? 0}</span>
          <button style={btn(false)} onClick={() => setCell(selectedIndex, { seed: Math.floor(Math.random() * 0x7fffffff) })}>🎲 重掷</button>
          <span style={{ flex: 1 }} />
          {onRunRequest && (
            running ? (
              <button
                title="中止当前运行"
                onClick={() => onCancelRequest?.()}
                style={{ ...btn(false), background: '#b91c1c', borderColor: 'transparent', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
              >
                ⏹ 取消
              </button>
            ) : (
              <button
                onClick={() => { onRunRequest(selectedIndex); }}
                style={{ ...btn(false), background: 'linear-gradient(180deg,#d05ee0,#b44cc4)', borderColor: 'transparent', color: '#fff', fontWeight: 600 }}
              >
                ⟳ 生成此表情
              </button>
            )
          )}
        </div>
      </div>

      {/* 主题预设（完整主 prompt 模板兜底） */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>主题（每格默认 prompt）</span>
          {presets.map((p) => (
            <button key={p} style={btn(p === stylePreset)} onClick={() => setStylePreset(p)}>{p}</button>
          ))}
        </div>
        <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
          选中主题作为该格「未手填 prompt」时的完整默认 prompt；单格生成走「⟳ 生成此表情」，全部走卡片 RUN 按钮
        </div>
        {/* 当前主题的完整主 prompt 模板预览（运行时直接作为每格 prompt 兜底）。 */}
        {(() => {
          const template = styleTemplateOf(stylePreset);
          return template ? (
            <div style={{ fontSize: 9, color: '#7fd1a8', marginTop: 2, lineHeight: 1.4 }}>
              <span style={{ color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>默认 prompt · </span>
              {template}
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}
