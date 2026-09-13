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
import { createPortal } from 'react-dom';
import { useProviderStore } from '../../store/useProviderStore';
import { CHROMA_KEY_ALGOS, type ChromaKeyAlgo } from './comfyHost/videoToGifExecutor.js';
import { dataUrlToBlob } from './comfyHost/videoToGifExecutor.js';
import { chromaKeyFrame, autoSampleChromaKeyRgba } from './comfyHost/videoToGifExecutor.js';
// ★ 绿幕原片指纹（长度+头尾，O(1)）——**与执行器同一函数**，用于判断 ③ 的 GIF /
//   ② 的抠像结果是否已被新一轮 ① 视频淘汰（勿在本文件另写一份，口径必须一致）。
import { emojiInputSig } from './comfyHost/animatedEmojiExecutor.js';
import { publicCosAlias } from './comfyHost/workflowRunShared.js';
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
  /**
   * ★ 提示词 / 动作描述（2026-09-12 用户需求「视频生成 增加提示词 字段」）。
   *
   * 对应 `node.properties.prompt` —— 执行器 `runAnimatedEmoji` **优先读它**，
   * 为空才回退上游 `texts` 端口的 TEXT 快照（见 animatedEmojiExecutor 的
   * `widgetPrompt || resolveUpstreamSnapshotText(...)`）。
   *
   * ★ 走 `meta.prompt` 直传而非 `ctl('prompt')`：`prompt` 是 TEXT widget，而
   *   `toControls` 只收 COMBO/INT/FLOAT/BOOLEAN → 不进 `meta.controls` ✗
   *   （与 chroma_color / cells 同一坑：ctl 恒 fallback '' → 用户填的提示词
   *   重开面板即丢，且 onCommit 会把空串写回覆盖 ✗✗）。
   */
  prompt?: string;
}

export interface AnimatedEmojiEditorProps {
  initial: AnimatedEmojiInit;
  /** 已生成的绿幕视频 / GIF 引用（预览；kind='video' 为抠像前绿幕原片）。
   *  ★ `cellIndex`（2026-09-12）：产物所属格号。有它时按**格号**取值（缺格不会
   *  让后续格整体错位）；老调用方不传 → 回退按数组下标（兼容）。
   *  ★ `rev`（2026-09-12）：本次产物标识（阶段③ 的 `meta.gifStamp` / 条目 index）。
   *  用作 `<img>` 的 React key —— 参数未变时 GIF 字节可能完全相同，src 不变则
   *  浏览器不重解码，用户会以为「点了生成但预览没更新」。 */
  cellRefs?: Array<{
    ref: string;
    kind?: 'image' | 'video';
    cellIndex?: number;
    rev?: string;
    /** 该 GIF 依据的抠像参数签名（阶段③ 写入）。与 `cellMatteRefs[].sig` 不等
     *  → GIF 已被 ② 的新参数淘汰 → ③ 预览回落到新抠像结果 + 「待重转 GIF」。 */
    fromMatteSig?: string;
    /** 该 GIF 依据的**绿幕原片指纹**（阶段③ 写入）：与当前原片指纹不等 → ① 重跑过
     *  → GIF 过期（即使抠像参数与输入图都没变）。 */
    fromVideoSig?: string;
  } | undefined>;
  /**
   * ★ 每格的原始绿幕视频（2026-09-08「原始视频/抠图 GIF」格级切换）：来自
   *   快照 port='video'（诊断归档），按 cellIndex 取最新。格右上角按钮在
   *   「该格 GIF」与「该格原片」之间切换显示——调参时直接对比抠像效果。
   */
  cellVideoRefs?: Array<{ cellIndex: number; ref: string }>;
  /**
   * ★ 每格的**阶段① 抠像结果**（2026-09-11 两阶段拆分）：来自快照 port='matte'
   *   （透明 PNG + 抠像参数凭据，由执行器 archiveMatteResult 写入）。阶段① 预览
   *   窗口优先显示它；缺省时回退为「对绿幕原片实时抠像」的本地序列帧预览。
   */
  cellMatteRefs?: Array<{ cellIndex: number; ref: string; sig?: string; stamp?: number }>;
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
   * ★ 换批检测结果（2026-09-12）：这些格的归档产物与**当前上游输入**不匹配
   *   （输入已更换）→ 已从 cellRefs / cellVideoRefs / cellMatteRefs 中剔除
   *   （预览自动回落到新输入原图）。此处仅用于提示用户「请重新执行 ①→②→③」。
   */
  staleCells?: number[];
}

/**
 * 提示图标 + 自绘悬浮 tip（2026-09-12）。
 *
 * 长段说明（算法原理 / 参数建议 / 角标图例 / 阶段语义…）不再占版面，收敛成一个 ❗
 * 图标，鼠标悬浮显示原文。
 *
 * ★ 为什么**不用原生 `title`**（2026-09-12 用户反馈「tip 被鼠标遮挡文字」）：
 *   原生 tooltip 的位置/延迟由浏览器（或 OS）决定，通常落在光标**右下方** —— 鼠标
 *   正好压住第一行文字 ✗，且完全无法干预。
 * ★ 现改为自绘：`position: fixed` 定位到图标**正上方**（`translateY(-100%)`）——
 *   · 鼠标在图标上，tip 在其上方 → 永不遮挡 ✓；
 *   · `fixed` 不受卡片 `overflow:hidden`（预览面板 / 阶段面板都有）裁剪 ✓
 *     （若用 absolute 会被面板裁掉 ✗ —— 这些图标多挂在面板 header 上）。
 * ★★ **必须 `createPortal` 挂到 `document.body`**（2026-09-12 用户反馈「hover 没有
 *   tip」）：卡片活在 LiteGraph 画布容器里，该容器有 `transform`（平移/缩放）→
 *   成为 `position: fixed` 的 **containing block** ⇒ 只写 `fixed` 会被按**卡片坐标系**
 *   解释（坐标来自视口 `getBoundingClientRect`）→ 落到视口外/被裁 ⇒ **看不见** ✗。
 *   同款修法见 `nodeCard.tsx` 的单元格编辑器与 `ComboPopover`（同一坑，已 portal）。
 * ★ `tone`：info（默认，青）用于说明；warn（琥珀）用于「这样做会出问题」的提醒。
 */
function HintTip({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warn' }): React.ReactElement {
  /** 图标位置（视口坐标；null = 未悬浮）。 */
  const [anchor, setAnchor] = React.useState<{ x: number; y: number; below: boolean } | null>(null);
  const color = tone === 'warn' ? '#fbbf24' : '#7dd3fc';
  return (
    <>
      <span
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // 顶部空间不足（图标贴近视口上沿）→ 改挂下方，避免 tip 被视口切掉 ✗
          setAnchor({ x: r.left + r.width / 2, y: r.top, below: r.top < 72 });
        }}
        onMouseLeave={() => setAnchor(null)}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 13, height: 13, borderRadius: '50%', flex: '0 0 auto',
          fontSize: 9, lineHeight: '13px', fontWeight: 700, fontFamily: 'monospace',
          color, background: `${color}1f`, border: `1px solid ${color}66`,
          cursor: 'help', userSelect: 'none',
        }}
      >!</span>
      {anchor && typeof document !== 'undefined' && createPortal(
        <span
          style={{
            position: 'fixed',
            // 以图标中心为基准左右居中；再夹到视口内（tip 最宽 280 → 半宽 140）
            left: Math.max(140, Math.min(anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 140)),
            top: anchor.below ? anchor.y + 20 : anchor.y - 6,
            transform: anchor.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            maxWidth: 280, width: 'max-content',
            padding: '6px 8px', borderRadius: 6,
            background: 'rgba(18,19,24,.98)', color: '#e8e8e8',
            border: `1px solid ${color}66`,
            fontSize: 10, lineHeight: 1.55, whiteSpace: 'normal', textAlign: 'left',
            boxShadow: '0 6px 20px rgba(0,0,0,.5)',
            zIndex: 99999, pointerEvents: 'none',
          }}
        >{text}</span>,
        document.body,
      )}
    </>
  );
}

/** 提示图标入口（保持原有「函数调用」写法：`{hintTip('…')}` → 内部挂载 `HintTip`）。 */
const hintTip = (text: string, tone: 'info' | 'warn' = 'info'): React.ReactElement => <HintTip text={text} tone={tone} />;

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

/**
 * 取视频**首帧**为 PNG dataURL（阶段① 预览的「图片」模式用）。
 *
 * 为什么要它：`<video>` 同时挂 9 路（每路是数 MB 的本地化 data URL / blob URL）时，
 * 浏览器会节流解码 → 多格显示黑屏（用户实测截图）；且多路 video 同时解码很吃 CPU。
 * 静帧模式一次性抽帧后走 `<img>`，稳定且轻。
 * 失败返回 null（调用方回退到视频/原图，不显示空白）。
 */
async function extractVideoPoster(url: string): Promise<string | null> {
	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	video.src = url;
	try {
		await new Promise<void>((res, rej) => {
			video.onloadeddata = () => res();
			video.onerror = () => rej(new Error('视频解码失败'));
		});
		// seek 到极早时刻，确保有可绘制帧（部分容器首帧不可直接绘制）
		const dur = Number.isFinite(video.duration) ? video.duration : 0;
		if (dur > 0.1) {
			await new Promise<void>((res) => {
				video.onseeked = () => res();
				video.currentTime = Math.min(0.05, dur * 0.1);
			});
		}
		const sw = video.videoWidth || 240;
		const sh = video.videoHeight || 240;
		const scale = Math.min(1, 240 / Math.max(sw, sh));
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round(sh * scale));
		const cv = document.createElement('canvas');
		cv.width = w;
		cv.height = h;
		const ctx = cv.getContext('2d');
		if (!ctx) { return null; }
		ctx.drawImage(video, 0, 0, w, h);
		return cv.toDataURL('image/png');
	} catch {
		return null;
	} finally {
		try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
	}
}

/** 诊断日志节流时间戳（模块级：卡片频繁重挂，组件 state 会被重置）。 */
let _emojiDiagAt = 0;

const selectStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px',
  background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)',
  border: '1px solid rgba(255,255,255,.14)', borderRadius: 4,
};

export function AnimatedEmojiEditor({
  initial, cellRefs, cellVideoRefs, cellMatteRefs, cellSourceRefs, sheetGrid, workflowOptions, upstreamCount, onCommit, onRunRequest, running, onCancelRequest, staleCells,
}: AnimatedEmojiEditorProps): React.ReactElement {
  // ── 生成渠道（2026-09-03）：comfyui（本地视频工作流 I2V）/ provider（RPC）──
  const [backend, setBackend] = React.useState<'comfyui' | 'provider'>(initial.backend === 'comfyui' ? 'comfyui' : 'provider');
  const [workflow, setWorkflow] = React.useState<string>(initial.workflow || workflowOptions?.[0] || '');
  /** ComfyUI seed：0=执行时随机；>0 固定（复现）。🎲 按钮随机换新。 */
  const [seed, setSeed] = React.useState<number>(typeof initial.seed === 'number' && initial.seed > 0 ? initial.seed : 0);
  const [providerId, setProviderId] = React.useState<string>(initial.videoProvider || '');
  const [modelId, setModelId] = React.useState<string>(initial.videoModel || '');
  const [durationS, setDurationS] = React.useState<number>(initial.duration_s || 3);
  // ★ 提示词 / 动作描述（2026-09-12 用户需求「视频生成 增加提示词 字段」）：
  //   此前 prompt 只来自上游 `texts` 连线，卡片上**没有任何输入口** ✗
  //   （nodeCard 的 inline prompt 区对 animated-emoji 刻意跳过，原注释写
  //   「prompt 由编辑器自绘」但编辑器其实没画 ✗）→ 用户无法直接写动作描述。
  const [prompt, setPrompt] = React.useState<string>(typeof initial.prompt === 'string' ? initial.prompt : '');
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
  // ★ 两阶段（2026-09-11）：① 视频抠像 / ② GIF 输出 —— 取消页签，两阶段**同时
  //   可见**（各自参数 + 各自预览窗口 + 各自按钮），见下方 Stage 区块。
  // ★ 三阶段页签（2026-09-12 用户需求）：① 生成视频 / ② 视频抠像 / ③ GIF 输出。
  //   每阶段执行完毕后**自动切到下一阶段**（见下方 autoSwitch effect）。
  const [tab, setTab] = React.useState<'video' | 'matte' | 'gif'>('video');
  /** 当前发起运行的阶段（用于把对应按钮切成「取消」，另一阶段按钮置灰）。 */
  const [activeStage, setActiveStage] = React.useState<'video' | 'matte' | 'gif' | 'all' | null>(null);
  // ★ 选中格多选（2026-09-08，用户需求）：点击格子 toggle 选中；按钮文字随
  //   选中集变化（单格 [x]，多格压缩区间 [m-n,...]），点击批量重生成选中格。
  //   全不选 = 生成全部（run_scope='all'）。
  const [selectedCells, setSelectedCells] = React.useState<Set<number>>(() => new Set<number>());
  // ★ 悬停格状态已移除（2026-09-12 用户需求「移除重新抠图+gif按钮」）：它只用于
  //   单格 ⟳ 的显隐；按钮删除后无消费方。
  // ★ 单格「静帧/动图」切换已移除（2026-09-12 用户需求：三阶段预览合并成**一个**
  //   统一预览窗口，格内不再挂切换按钮）→ stillCells/stillCache/getStillFrame 无消费方。
  /** 本节点产出的逐格产物（行主序，与 grid 切分顺序一致；排除绿幕原片）。
   *  ★ 含 video（2026-09-08）：GIF 输出开关关闭时产物是 mp4——网格用 <video> 播放。 */
  const gridCellMedia = React.useMemo(
    () => (cellRefs ?? []).flatMap(c => (c && (c.kind === 'image' || c.kind === 'video') ? [{ ref: c.ref, isVideo: c.kind === 'video' }] : [])),
    [cellRefs],
  );
  /**
   * ★ 格号 → 该格最终产物（GIF / 视频），2026-09-12。
   *
   * 为什么不能只按下标：`cellRefs` 来自 nodeCard 的 `latestOutputs` —— 那是
   * 「按 cellIndex 排序 + `slice(-batchSize)`」的**压缩序列**，只有「所有格产物
   * 齐全」时数组下标才等于格号。任一格缺失（生成失败 / 换批被剔除）下标就整体
   * 前移 → 预览第 i 格显示的是别人的产物 ✗（② 用 cellMatteRefs/cellVideoRefs
   * 是按格号取的，于是「② 与 ③ 同格不同图」）。
   * 老调用方不传 cellIndex → 映射为空，回退按数组下标（向后兼容）。
   */
  const gifByCell = React.useMemo(() => {
    const m = new Map<number, { ref: string; isVideo: boolean; rev: string; fromMatteSig: string; fromVideoSig: string }>();
    for (const c of cellRefs ?? []) {
      if (!c || (c.kind !== 'image' && c.kind !== 'video')) { continue; }
      if (typeof c.cellIndex !== 'number' || !Number.isInteger(c.cellIndex)) { continue; }
      m.set(c.cellIndex, {
        ref: c.ref, isVideo: c.kind === 'video', rev: c.rev ?? '',
        fromMatteSig: c.fromMatteSig ?? '', fromVideoSig: c.fromVideoSig ?? '',
      });
    }
    return m;
  }, [cellRefs]);
  /** 产物是否带格号（带 → 一律按格号取值，不再按下标）。 */
  const gifByCellReady = gifByCell.size > 0;
  /** 取第 i 格的最终产物（带格号按格号；否则回退下标）。 */
  const gifAt = (i: number): { ref: string; isVideo: boolean; rev: string; fromMatteSig: string; fromVideoSig: string } | undefined =>
    (gifByCellReady
      ? gifByCell.get(i)
      : (gridCellMedia[i] ? { ...gridCellMedia[i], rev: '', fromMatteSig: '', fromVideoSig: '' } : undefined));
  // ★ 过期判定放在**所有依赖映射之后**（gifByCell / matteSigByCell / matteStampByCell /
  //   videoByCell 都是 `const`，提前引用会 TS2448「used before declaration」）。

  /**
   * 阶段③ 最近一次生成时间（`meta.gifStamp` 最大值）。
   * 用于「更新于 hh:mm:ss」——参数未变时 GIF 字节可能完全相同，`<img>` 视觉上
   * 毫无变化，用户会误判「点了生成没反应」✗；时间戳是**确定可见**的更新凭据。
   * 只认 ≥2020 的毫秒时间戳（`rev` 也可能是条目 index，别把它当时间 ✗）。
   */
  const gifUpdatedAt = React.useMemo(() => {
    let max = 0;
    for (const v of gifByCell.values()) {
      const t = Number(v.rev);
      if (Number.isFinite(t) && t > 1_600_000_000_000 && t > max) { max = t; }
    }
    return max > 0 ? new Date(max).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  }, [gifByCell]);
  // ★ 格级三态预览（2026-09-08「原图→视频→GIF」循环切换）：默认 GIF（抠像
  //   结果）；缺失态自动跳过（无原片则 GIF↔原图 两态）。可播化 URL 缓存沿用。
  //   ★ cellIndex → 绿幕原片 ref（2026-09-08 补回：四态重构时定义被误删，
  //   esbuild 不查未定义标识符 → 运行时 ReferenceError 崩渲染）。
  const videoByCell = React.useMemo(
    () => new Map((cellVideoRefs ?? []).map(v => [v.cellIndex, v.ref])),
    [cellVideoRefs],
  );
  /** 阶段② 抠像结果（port='matte'，透明 PNG）按格索引。 */
  const matteByCell = React.useMemo(
    () => new Map((cellMatteRefs ?? []).map(v => [v.cellIndex, v.ref])),
    [cellMatteRefs],
  );
  /**
   * 阶段② 抠像结果的**参数签名**（按格，`meta.matteSig`）。
   *
   * 用途（2026-09-12 用户实测「执行完抠像后，gif 预览没有更新图片」）：② 用新参数
   * 重跑后，③ 的 GIF（`meta.gifFromMatteSig` = 旧签名）已经过期 —— 但 ③ 预览此前
   * 一直显示那张**旧 GIF**，把 ② 的新抠像结果盖住 ✗。两者签名不等即判定过期 →
   * ③ 预览回落到新抠像结果 + 角标「待重转 GIF」。
   */
  const matteSigByCell = React.useMemo(
    () => new Map((cellMatteRefs ?? []).filter(v => !!v.sig).map(v => [v.cellIndex, v.sig as string])),
    [cellMatteRefs],
  );
  /** 阶段② 抠像结果的归档时间戳（ms，按格）。见 gifStaleAt 的「② 比 ③ 新」判定。 */
  const matteStampByCell = React.useMemo(
    () => new Map((cellMatteRefs ?? []).filter(v => (v.stamp ?? 0) > 0).map(v => [v.cellIndex, v.stamp as number])),
    [cellMatteRefs],
  );
  /** 第 i 格当前绿幕原片的指纹（`emojiInputSig`，与执行器同函数）。 */
  const videoSigAt = (i: number): string => emojiInputSig(videoByCell.get(i));
  /**
   * 该格 GIF 是否**已过期**（三种独立原因，任一命中即过期）：
   *  ① `matteStamp > gifStamp` → **② 比 ③ 新**（用户刚跑完 ② 抠像）→ 旧 GIF 盖住了
   *     新的抠像结果 ✗（2026-09-12 用户实测：「执行完抠像后，gif 预览没有更新图片」）。
   *     这条**最普适**：参数没变也照样识别「② 又跑过一次」。
   *  ② `fromMatteSig` ≠ 当前 `matteSig` → ② 换了参数（签名兜底）。
   *  ③ `fromVideoSig` ≠ 当前原片指纹 → ① 重跑过（视频换了；参数与输入图都可能没变）。
   * 缺任一侧信息（旧数据）→ 不判过期（向后兼容）。时间戳须两侧都像真时间戳
   * （>1.6e12）才比较 —— `rev` 可能是条目 index，别拿它当时间 ✗。
   */
  const gifStaleAt = (i: number): boolean => {
    const g = gifByCell.get(i);
    if (!g) { return false; }
    const gStamp = Number(g.rev);
    const mStamp = matteStampByCell.get(i) ?? 0;
    if (gStamp > 1_600_000_000_000 && mStamp > gStamp) { return true; }
    const msig = matteSigByCell.get(i);
    if (g.fromMatteSig && msig && msig !== g.fromMatteSig) { return true; }
    const vsig = videoSigAt(i);
    if (g.fromVideoSig && vsig && vsig !== g.fromVideoSig) { return true; }
    return false;
  };
  /** 过期原因（角标文案用）：'matte' = ② 更新 / 'video' = ① 更新 / '' = 未过期。 */
  const gifStaleReason = (i: number): 'matte' | 'video' | '' => {
    if (!gifStaleAt(i)) { return ''; }
    const g = gifByCell.get(i)!;
    const vsig = videoSigAt(i);
    if (g.fromVideoSig && vsig && vsig !== g.fromVideoSig) { return 'video'; }
    return 'matte';
  };
  /** 待重转 GIF 的格（③ 头部提示 + 预览回落到新抠像结果）。 */
  const staleGifCells = React.useMemo(() => {
    const out: number[] = [];
    for (const i of gifByCell.keys()) { if (gifStaleAt(i)) { out.push(i); } }
    return out.sort((a, b) => a - b);
    // ★ 依赖含 videoByCell / matteStampByCell：`gifStaleAt` 会比原片指纹与
    //   「② 是否比 ③ 新」（见函数注释）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gifByCell, matteSigByCell, matteStampByCell, videoByCell]);
  // ★ 诊断日志（2026-09-12，2s 节流）：③ 预览「跑完不更新」类问题只能靠**数据源**
  //   定位 —— 关键问题是「产物到底有没有到达卡片」（被换批检测剔除的产物在
  //   cellRefs / cellMatteRefs / cellVideoRefs 里根本不存在）。一行 JSON 可判定：
  //   · gifCells>0 而 stale=true → 过期判定生效（③ 显示的是抠像结果）；
  //   · gifCells=0 而 staleCells 非空 → 全部被换批剔除（预览回落输入原图，看起来
  //     「怎么跑都不变」——因为原图本来就不变）；
  //   · gifCells>0 且 stale=false → 显示的就是最新 GIF（若图没变，说明产物字节相同）。
  React.useEffect(() => {
    const now = Date.now();
    if (now - _emojiDiagAt < 2000) { return; }
    _emojiDiagAt = now;
    const g0 = gifByCell.get(0);
    // eslint-disable-next-line no-console
    console.warn('[AnimatedEmoji][diag] ' + JSON.stringify({
      gifCells: gifByCell.size, matteCells: matteByCell.size, videoCells: videoByCell.size,
      sourceCells: (cellSourceRefs ?? []).length, upstream: upstreamCount ?? 0,
      staleCells: staleCells ?? [], staleGif: staleGifCells,
      cell0: {
        gif: !!g0, gifRev: g0?.rev ?? '', gifLen: g0 ? g0.ref.length : 0,
        fromMatteSig: g0?.fromMatteSig ?? '', fromVideoSig: g0?.fromVideoSig ?? '',
        matteSig: matteSigByCell.get(0) ?? '', matteStamp: matteStampByCell.get(0) ?? 0,
        videoSig: videoSigAt(0),
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellRefs, cellMatteRefs, cellVideoRefs, cellSourceRefs, staleCells]);
  // ★ 阶段① 预览目标格（2026-09-11）：**选中格优先**（点网格任一格 → 阶段① 立即
  //   预览该格的抠像结果），未选则第 0 格。只算一个格——阶段① 的用途是「调抠像
  //   参数看边缘质量」，单格放大比网格缩略图有用得多。
  const stage1Cell = React.useMemo(() => {
    const sorted = [...selectedCells].sort((a, b) => a - b);
    return sorted.length > 0 ? sorted[0] : 0;
  }, [selectedCells]);
  // ★ 逐格预览来源（2026-09-12 第三轮用户需求「预览**不分阶段**；每个格子中提供
  //   按钮切换 原图 / 视频 / 抠图 / GIF；切到没有资源的来源就给提示；任何阶段页签里
  //   重新生成都要同步更新预览格子」）。
  //   · `previewModes` = **用户手动**选择（按格）。
  //   · 没手动选过的格走 `autoPreviewMode`（= 最靠后的已生成产物，原图兜底）→
  //     任何阶段重新生成后，未手动干预的格会**自动跟着前进**（① 跑完显视频 → ② 跑完
  //     显抠图 → ③ 跑完显 GIF）。
  //   · 手动选定的格**保持**用户选择，但内容仍取实时数据 → 重新生成即同步刷新 ✓。
  type CellPreviewMode = 'source' | 'video' | 'matte' | 'gif';
  const [previewModes, setPreviewModes] = React.useState<Map<number, CellPreviewMode>>(() => new Map());
  /** 该格**自动**档：最靠后的已生成产物（全无 → 输入原图）。 */
  const autoPreviewMode = (i: number): CellPreviewMode => {
    const g = gifAt(i);
    if (g && !gifStaleAt(i)) { return 'gif'; }
    if (matteByCell.get(i)) { return 'matte'; }
    if (videoByCell.get(i)) { return 'video'; }
    return 'source';
  };
  /** 该格当前生效的预览来源（手动优先）。 */
  const previewModeOf = (i: number): CellPreviewMode => previewModes.get(i) ?? autoPreviewMode(i);
  /** 循环顺序（与用户列出的「原图/视频/抠图/gif」一致）。 */
  const PREVIEW_MODE_ORDER: CellPreviewMode[] = ['source', 'video', 'matte', 'gif'];
  /** 预览来源元信息：`icon` = 切换按钮上显示的**下一个**来源（与点按直觉一致）。 */
  const PREVIEW_MODE_META: Record<CellPreviewMode, { label: string; icon: string; empty: string }> = {
    source: { label: '原图', icon: '🖼', empty: '无原图' },
    video: { label: '视频', icon: '🎬', empty: '未生成视频' },
    matte: { label: '抠图', icon: '✂️', empty: '未抠图' },
    gif: { label: 'GIF', icon: '🎞', empty: '未生成 GIF' },
  };
  /** 循环切换某格的预览来源（原图 → 视频 → 抠图 → GIF → 原图）。 */
  const cyclePreviewMode = (i: number): void => {
    setPreviewModes(prev => {
      const m = new Map(prev);
      const cur = previewModeOf(i);
      m.set(i, PREVIEW_MODE_ORDER[(PREVIEW_MODE_ORDER.indexOf(cur) + 1) % PREVIEW_MODE_ORDER.length]);
      return m;
    });
  };
  // ★ 视频 ref 可播化（2026-09-08 两轮修正）：所有 <video> 的 src 一律走 blob
  //   URL——① 外网签名 URL（COS）：CSP 不放行 + 会过期 → host 代理拉取；② 固化
  //   的巨型 data: URL（localizeImageRef 产物，几 MB base64）：<video> 直喂易
  //   加载失败（黑屏空控制条）→ dataUrlToBlob + createObjectURL；③ blob:/本机
  //   http 原样。缓存 key = 原始 ref（同一 ref 多处引用共享一个 blob URL）。
  const [playableByUrl, setPlayableByUrl] = React.useState<Map<string, string>>(() => new Map());
  // ★★ 本文件的异步媒体管线（可播化 URL / 首帧抽帧）**必须与「依赖恒变」解耦**
  //   （2026-09-12 修用户实测「角标写着『原片』、画面却是输入贴纸」）：
  //   卡片把 `cellRefs` / `cellVideoRefs` / `cellMatteRefs` 以 **JSX 内联表达式**
  //   传入（`nodeCard.tsx` 的 `cellRefs={latestOutputs.filter(...).map(...)}`）→
  //   **每次渲染都是新数组** → 编辑器的 `videoByCell` / `gridCellMedia` useMemo
  //   恒失效 → 下面两个 effect **每渲染都重启** → 旧实现的 cleanup 一律
  //   `cancelled = true` ⇒ **在途的 fetch / 抽帧结果全被丢弃** ✗✗：
  //     · 首帧抽帧（~100ms+）几乎永远赶不上下一次渲染 → 「图片」模式永远回落
  //       显示**输入原图**（用户截图：9 格角标「原片」但画面是输入贴纸 ✗）；
  //     · 可播化 URL 每轮只提交 1 个，且重复拉取同一批数 MB 视频（N² 次 IPC）。
  //   修法（与 `matteSeq` / `videoPosters` 同款范式）：**只用 ref 判断**，且
  //   `cancelled` 仅由**卸载**置位 —— 依赖变化不再杀死在途工作；再用
  //   `inflightRef` 保证同一 ref 不会并发重复处理（重启时直接跳过）。
  const aliveRef = React.useRef(true);
  React.useEffect(() => () => { aliveRef.current = false; }, []);
  const playableByUrlRef = React.useRef(playableByUrl);
  playableByUrlRef.current = playableByUrl;
  const playableInflightRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    void (async () => {
      // ★ 统一预览窗口：**所有格**的绿幕原片都要可播化（① 视频态要逐格播放，
      //   ②/③ 的回落链也可能显示原片）→ 不再依赖「哪一格被切到了视频态」。
      const wanted: string[] = [];
      for (const r of videoByCell.values()) { wanted.push(r); }
      for (const c of gridCellMedia) {
        if (c.isVideo && c.ref) { wanted.push(c.ref); }
      }
      for (const raw of wanted) {
        // ★ 跳过判断读 **ref 镜像**（不是闭包里的 state）——否则重启后仍按旧值判断。
        if (playableByUrlRef.current.has(raw) || playableInflightRef.current.has(raw)) { continue; }
        playableInflightRef.current.add(raw);
        let url = raw;
        try {
          if (/^data:/i.test(raw)) {
            try { url = URL.createObjectURL(dataUrlToBlob(raw)); } catch { /* 保持原样 */ }
          } else if (/^https?:/i.test(raw) && !/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(raw)) {
            try {
              const r = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>('net.fetchAsDataUrl', { url: raw }, 120_000);
              let dataUrl = r?.dataUrl;
              // ★ 内网 COS 域名在用户机器上**必然**拉不到（见 publicCosAlias）→ 换公网
              //   alias 再试一次：能救回「已归档但未固化」的存量视频（用户日志实证：
              //   `mjai-….cos-internal.ap-guangzhou…` → 预览「原片加载失败」）。
              if (!dataUrl) {
                const alt = publicCosAlias(raw);
                if (alt !== raw) {
                  const r2 = await sendRequest<{ url: string }, { dataUrl?: string; error?: string }>('net.fetchAsDataUrl', { url: alt }, 120_000);
                  dataUrl = r2?.dataUrl;
                }
              }
              if (dataUrl) { url = URL.createObjectURL(dataUrlToBlob(dataUrl)); }
            } catch { /* 代理失败 → 保持原 URL（黑屏即失败态），不阻断其他格 */ }
          }
          // ★ 只认「卸载」——依赖变化（卡片每渲染换新数组）不得丢弃已到手的成果。
          if (aliveRef.current) { setPlayableByUrl(prev => new Map(prev).set(raw, url)); }
        } finally {
          playableInflightRef.current.delete(raw);
        }
      }
    })();
    // ★ 不返回 cleanup（在途工作跨依赖变化继续完成；卸载由 aliveRef 兜底）。
  }, [videoByCell, gridCellMedia, stage1Cell]);
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
  // ★ 「该 (格, 签名) 正在计算中」——依赖每渲染变化导致 effect 重启时，靠它跳过
  //   重复计算（否则同一格会被并发重算多轮，白烧 CPU ✗）。
  const matteInflightRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    // ★ 去抖 350ms（2026-09-12 用户需求「单格中，抠图状态下要能查看每帧的效果」）：
    //   现在要为**所有**处于「✂️ 抠图」档的格准备序列帧 —— 调参 stepper 连点会触发
    //   多次 effect，不去抖就会为每格重排一轮 16 帧 ⇒ CPU 风暴 ✗。去抖后连点只算一轮。
    const timer = setTimeout(() => { void (async () => {
      // ★ 需要序列帧的格 = 所有「抠图」档的格（2026-09-12 由「仅选中格」放开）：
      //   候选 = 手动选过来源的格 ∪ 有② 抠像归档的格（自动档要落回 matte 也只可能
      //   来自后者）→ 逐格算序列帧 ⇒ **逐格都能 ‹ › 翻帧** ✓。
      const candidates = new Set<number>([...previewModes.keys(), ...matteByCell.keys()]);
      const wanted = [...candidates].filter(i => previewModeOf(i) === 'matte');
      // ★ 选中格优先：调参时先看到自己正在看的那一格（其余格随后补上）。
      wanted.sort((a, b) => (a === stage1Cell ? -1 : b === stage1Cell ? 1 : a - b));
      for (const i of wanted) {
        const raw = playableByUrlRef.current.get(videoByCell.get(i) ?? '') ?? videoByCell.get(i);
        if (!raw) { continue; }
        // 签名 = 参数 + 原片指纹（重新生成后原片变了必须重算）
        const sig = `${matteParamSig}|${raw.slice(-48)}`;
        const cached = matteSeqRef.current.get(i);
        if (cached && cached.sig === sig) { continue; }
        const inflightKey = `${i}|${sig}`;
        if (matteInflightRef.current.has(inflightKey)) { continue; }
        matteInflightRef.current.add(inflightKey);
        // ★ 只认「卸载」（同可播化/抽帧 effect）：依赖变化（卡片每渲染换新数组）
        //   不得中断帧循环 —— 旧实现用 `cancelled` ⇒ 序列帧永远算不完 ✗。
        if (!aliveRef.current) { matteInflightRef.current.delete(inflightKey); return; }
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
            if (!aliveRef.current) { return; }
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
          // ★ greenDominance:90（2026-09-12 用户实测「边缘的冒泡被错误的抠图」）：
          //   缺省值 = max(18, band*0.35)（smoothness 0.25 时约 38）对**浅色/白色**
          //   元素过狠 —— 半透明泡泡/高光叠在绿幕上时像素偏绿（如 RGB(200,255,180)，
          //   gExcess=55 > 38）→ 被「绿色优势扩展清除」误删 ✗。表情包链路
          //   （GIF 编码 / 静态贴纸）早已统一传 90，预览此前漏传 → 预览看到的
          //   泡泡消失、GIF 里却有 ⇒ 预览与产物不一致 ✗✗。现与产物同参 ✓。
          chromaKeyFrame(rgba, key, chromaSimilarity, chromaSmoothness, chromaAlgo, { boxFilterDistance: true, softAlpha: true, greenDominance: 90 });
            ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), c.width, c.height), 0, 0);
            urls.push(c.toDataURL('image/png'));
            if (aliveRef.current) {
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
          matteInflightRef.current.delete(inflightKey);
        }
      }
    })(); }, 350);
    // ★ cleanup 只清**去抖定时器**（在途帧循环跨依赖变化继续完成；卸载由 aliveRef 兜底）。
    return () => clearTimeout(timer);
    // ★ matteSeq 不在依赖（进度写入会触发 cleanup 自杀帧循环）——skip 判断走
    //   matteSeqRef 镜像。参数/原片变化仍由 matteParamSig/stage1Cell 等驱动。
  }, [previewModes, stage1Cell, matteParamSig, playableByUrl, videoByCell, matteByCell, gifByCell, chromaAuto, chromaColor, chromaSimilarity, chromaSmoothness, chromaAlgo]);
  /** 视频首帧缓存（原始 ref → PNG dataURL）。 */
  const [videoPosters, setVideoPosters] = React.useState<Map<string, string>>(() => new Map());
  /**
   * ★ `<video>` 播放失败过的 ref（2026-09-12 修「角标说谎」）。
   *
   * `playableByUrl` 里**有值 ≠ 能播**：代理失败时兜底存的是**原始外网 URL** →
   * `<video>` 被 CSP 拦 → 画面空白/回落，而角标却按「有 ref」写「原片」✗。
   * 记下失败的 ref → 角标回落成「原片·首帧 / 原图」，用户能一眼区分「没生成」与
   * 「生成了但播不出来」。
   */
  const [videoPlayErrors, setVideoPlayErrors] = React.useState<Set<string>>(() => new Set());
  // ★ 新的可播化 URL 到达 → 清掉旧的播放失败记录（2026-09-12）：9 路 `<video>` 同时
  //   解码时浏览器可能节流/失败，而 `onError` 一旦置位是**永久**的 ✗（用户会看到
  //   「视频不可播」且无从重试）。blob 变化即源头变了，值得再试一次。
  React.useEffect(() => { setVideoPlayErrors(new Set()); }, [playableByUrl]);
  // ★ ref 镜像（防「effect 写入自己依赖的 state → cleanup 自杀」）：skip 判断读 ref。
  const videoPostersRef = React.useRef(videoPosters);
  videoPostersRef.current = videoPosters;
  // ★ 「已试过的源 URL」表：raw → 当时用的 URL。抽帧失败（如源还是不可播的外网
  //   原始 URL）时不缓存海报、但**记下用过哪个 URL** —— 可播化 URL 就绪后 URL 变了
  //   → 自动重试**一次**；同 URL 不重复尝试，避免「每渲染重试一次」的忙循环 ✗。
  const posterTriedRef = React.useRef(new Map<string, string>());
  const posterInflightRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    void (async () => {
      for (const raw of videoByCell.values()) {
        // ★ skip 判断全部走 **ref 镜像**（见可播化 effect 的同款注释：卡片每渲染换
        //   新数组 → 本 effect 每渲染都重启，用 state 闭包判断会重复抽帧 ✗）。
        if (videoPostersRef.current.has(raw) || posterInflightRef.current.has(raw)) { continue; }
        // 优先用可播化 URL（blob:）——data URL 直喂 video 在多路场景易解码失败
        const src = playableByUrlRef.current.get(raw) ?? raw;
        if (posterTriedRef.current.get(raw) === src) { continue; }
        posterInflightRef.current.add(raw);
        try {
          const poster = await extractVideoPoster(src);
          posterTriedRef.current.set(raw, src);
          // ★ 只认「卸载」——依赖变化不得丢弃已抽好的首帧（用户实测：9 格角标
          //   写着「原片」却显示输入贴纸，正是因为抽帧结果每轮都被丢弃 ✗）。
          if (poster && aliveRef.current) { setVideoPosters(prev => new Map(prev).set(raw, poster)); }
        } finally {
          posterInflightRef.current.delete(raw);
        }
      }
    })();
    // ★ 不返回 cleanup（理由同可播化 effect：在途抽帧跨依赖变化继续完成）。
    // ★ 两处预览都要用首帧：阶段① 的「图片」模式 + 阶段②「原片」模式的视频未就绪兜底
    //   → 不再按模式门控（抽帧一次即缓存，成本可控）。
  }, [videoByCell, playableByUrl]);

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
  // ★ 动作 prompt（2026-09-12 用户需求「视频生成 增加提示词 字段」）：**已**在
  //   编辑器内输入（阶段① 的「提示词」框）→ 写回 values.prompt；执行器优先用它，
  //   为空才回退上游 `texts` 端口的 TEXT 快照。
  //   （此前注释写「prompt 不在编辑器输入、只来自上游连线」——但 nodeCard 的
  //     inline prompt 区对 animated-emoji 刻意跳过，于是**两边都没有输入口** ✗。）
  React.useEffect(() => {
    onCommit({
      backend,
      workflow,
      seed,
      videoProvider: providerId,
      videoModel: modelId,
      prompt,
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
  }, [backend, workflow, seed, providerId, modelId, prompt, durationS, fps, maxKb, chromaEnable, chromaAuto, chromaColor, chromaSimilarity, chromaSmoothness, chromaAlgo, matteEnable, gifEnable, loopBlend]);

  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    step = 1,
    onChange: (v: number) => void,
    /** 该参数的说明（❗ 图标 + 悬浮 tip；2026-09-12 用户需求）。 */
    tip?: string,
  ): React.ReactElement => (
    // ★ 防「按钮被截断」（2026-09-12 用户反馈）：卡片窄时 `1fr` 列装不下
    //   「标签 + ⓘ + −/值/＋」→ 整行溢出，被面板 `overflow:hidden` 裁掉 ✗。
    //   两道保险：① 标签可收缩（省略号，优先保证控件可见）；② 数值控件整组可换行。
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap', rowGap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 40, flex: '1 1 auto' }}>{label}</span>
      {tip ? hintTip(tip) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto', marginLeft: 'auto' }}>
        <button style={{ ...btn(false), padding: '3px 6px' }} onClick={() => onChange(Math.max(min, Math.round((value - step) / step) * step))}>−</button>
        <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 24, textAlign: 'center' }}>{value}</span>
        <button style={{ ...btn(false), padding: '3px 6px' }} onClick={() => onChange(Math.min(max, Math.round((value + step) / step) * step))}>＋</button>
      </div>
    </div>
  );

  // ── 阶段① / ② 派生状态与动作（2026-09-11 两阶段拆分）────────────────────
  /** 阶段① 已产出视频的格数（有绿幕原片 = 阶段① 执行过）。 */
  const videoCount = videoByCell.size;
  /** 阶段② 已产出抠像结果的格数。 */
  const matteCount = matteByCell.size;
  /** 阶段③ 已产出 GIF 的格数（带格号时按格号去重计数，与网格取值同口径）。 */
  const gifCount = gifByCellReady ? gifByCell.size : gridCellMedia.length;
  // ★ 每阶段执行完毕 → **自动切到下一阶段页签**（2026-09-12 用户需求）。
  //   判据：`running` true→false 且本次发起的阶段匹配，且该阶段**确有产物**
  //   （否则「取消/失败且尚无产出」也会跳页签 ✗）。
  const prevRunningRef = React.useRef(running);
  // ★ 运行刚结束的时刻：给「本次更新过的格」加一圈高亮（见 ③ 网格）——产物字节
  //   完全相同时（参数/输入都没变，编码是确定性的）缩略图不会有任何变化，用户会
  //   判定「跑了但没更新」✗。高亮是**与内容无关的**「已刷新」凭据。
  const [justRanAt, setJustRanAt] = React.useState(0);
  React.useEffect(() => {
    const was = prevRunningRef.current;
    prevRunningRef.current = running;
    if (!was || running) { return; }
    setJustRanAt(Date.now());
    // ★ 预览是**逐格**的（与页签无关），但未手动干预的格走自动档（最靠后的已生成
    //   产物）→ 阶段跑完自动前进，无需额外同步。
    if (activeStage === 'video') {
      if (videoCount > 0) { setTab('matte'); }
      return;
    }
    if (activeStage === 'matte') {
      if (matteCount > 0) { setTab('gif'); }
      return;
    }
    if (activeStage === 'all') {
      if (gifCount > 0) { setTab('gif'); }
      else if (matteCount > 0) { setTab('matte'); }
      else if (videoCount > 0) { setTab('matte'); }
    }
  }, [running, activeStage, videoCount, matteCount, gifCount]);
  // 「已刷新」高亮 5s 后自动清除（否则绿框会一直挂着，反而误导）。
  React.useEffect(() => {
    if (!justRanAt) { return; }
    const t = setTimeout(() => setJustRanAt(0), 5000);
    return () => clearTimeout(t);
  }, [justRanAt]);
  /**
   * ★ 三阶段进度条数据（2026-09-12 用户需求「页签改为进度条上的圆点，圆点可点击」）：
   * 圆点 = 阶段、点击 = 切页签（等价原页签按钮）。`count` 决定圆点是否「已产出」
   * （实心 + ✓），因此进度条本身就是**产物进度**的可视化，而不只是页签指示器。
   */
  const stages = [
    { id: 'video' as const, label: '① 生成视频', accent: '#22d3ee', count: videoCount, status: videoCount === 0 ? '未执行' : `已生成 ${videoCount} 格` },
    { id: 'matte' as const, label: '② 视频抠像', accent: '#818cf8', count: matteCount, status: matteCount === 0 ? '待执行' : `已抠像 ${matteCount} 格` },
    { id: 'gif' as const, label: '③ GIF 输出', accent: '#a855f7', count: gifCount, status: gifCount === 0 ? '待执行' : `已生成 ${gifCount} 格` },
  ];
  /** 最远的「已产出」阶段下标（全无产出 = -1）。轨道填充到它为止 = 真实进度。 */
  const furthestDone = stages.reduce((acc, s, i) => (s.count > 0 ? i : acc), -1);
  /** 轨道填充到的段下标（无任何产出时按当前页签位置，避免空条无指示）。 */
  const filledUpTo = furthestDone >= 0 ? furthestDone : Math.max(0, stages.findIndex(s => s.id === tab));
  // ── 预览网格的行列（2026-09-08；2026-09-12 上移到统一预览窗口之前）：跟随上游图集
  //   meta（sheetGrid）；装不下自动扩（与执行器一致）：nUp 张装不下时按张数近似方形重算。
  //   ★ 必须在 `previewStages`（要用 effRows/effCols 算格数）**之前**声明。
  const nUp = upstreamCount ?? 0;
  let effRows = sheetGrid?.rows ?? 1;
  let effCols = sheetGrid?.cols ?? 1;
  if (nUp > 1 && effRows * effCols < nUp) {
    effCols = Math.min(6, Math.ceil(Math.sqrt(nUp)));
    effRows = Math.min(6, Math.ceil(nUp / effCols));
  }
  /** 预览格总数（= 网格格数）。 */
  const pvCellCount = Math.max(1, effRows) * Math.max(1, effCols);
  /** 选格标签（按钮文案后缀）：未选 = 全部。 */
  const selSuffix = selectedCells.size === 0
    ? '（全部）'
    : `[${compressRanges([...selectedCells].sort((a, b) => a - b))}]`;
  /**
   * 提交选格 + 阶段并触发运行。
   * ★ `selected_index: 0` 显式归零：清掉 ⟳（rematte 单格协议）的残留——否则
   *   阶段② 在未选格时会被解析成「只处理第 1 格」（选格协议陷阱）。
   */
  const runStage = (scope: 'video' | 'matte' | 'gif' | 'all' | 'cell', stage: 'video' | 'matte' | 'gif' | 'all'): void => {
    const sorted = [...selectedCells].sort((a, b) => a - b);
    setActiveStage(stage);
    onCommit({
      run_scope: scope,
      cell_indices: sorted.length > 0 ? JSON.stringify(sorted) : '',
      selected_index: 0,
    });
    onRunRequest?.();
  };
  /** 阶段小标题（含右侧状态槽）。 */
  const stageHeader = (num: string, title: string, accent: string, right?: React.ReactNode): React.ReactElement => (
    // ★ `flexWrap`（2026-09-12 防截断）：标题 + 右侧状态/ⓘ 在窄卡片上换行，而不是
    //   把右侧内容挤出面板被 `overflow:hidden` 裁掉 ✗。
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', flexWrap: 'wrap', rowGap: 4, borderBottom: `1px solid ${accent}44`, background: `${accent}14` }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: accent, whiteSpace: 'nowrap' }}>{num} {title}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', rowGap: 2, minWidth: 0, fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>{right}</span>
    </div>
  );
  /**
   * 阶段按钮：本阶段运行中 → 「取消」；他阶段运行中 → 置灰；
   * `disabled`（如阶段② 缺阶段① 产物）→ 置灰并保留 title 说明原因。
   */
  const stageButton = (opts: { stage: 'video' | 'matte' | 'gif' | 'all'; label: string; title: string; disabled?: boolean; accent: string }): React.ReactElement => {
    // 「一键 ①+②+③」运行中：各阶段按钮都变成「取消」（否则整卡找不到中止入口）。
    if (running && (activeStage === opts.stage || activeStage === 'all')) {
      const runningLabel = opts.stage === 'video' ? '阶段① 生成视频中…'
        : opts.stage === 'matte' ? '阶段② 抠像中…'
          : opts.stage === 'gif' ? '阶段③ 转 GIF 中…' : '生成中…';
      return (
        <button
          title="中止当前运行"
          onClick={() => onCancelRequest?.()}
          style={{ padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, border: 'none', color: '#fff', background: '#b91c1c' }}
        >
          ⏹ 取消（{runningLabel}）
        </button>
      );
    }
    const blocked = running || opts.disabled === true;
    return (
      <button
        disabled={blocked}
        title={running ? '另一阶段正在运行…' : opts.title}
        onClick={() => {
          if (blocked) { return; }
          const scope = opts.stage === 'all'
            ? (selectedCells.size > 0 ? 'cell' : 'all')
            : opts.stage;
          runStage(scope, opts.stage);
        }}
        style={{
          padding: '7px 12px', borderRadius: 6, cursor: blocked ? 'not-allowed' : 'pointer',
          fontSize: 11, fontWeight: 600, border: 'none', color: '#fff',
          opacity: blocked ? 0.45 : 1, background: opts.accent,
        }}
      >{opts.label}</button>
    );
  };

  // ★ 旧版「绿幕原片 / 首格 GIF」预览块已移除（2026-09-08）：下方表情网格
  //   （逐格 + 🎬/✂️ 原片切换 + 选中/⟳）信息量完全覆盖，顶部再放大第 0 格
  //   属双份展示冗余（用户困惑「引用下方为什么多一张大图」）。

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

      {/* ⚡ 一键 ①+②+③（2026-09-12 用户需求「一键按钮位置移到预览上方」）：
          · 位置 = 「生成渠道」下方、**预览面板上方** —— 动作（跑）在结果（看）之前，
            与「先点按钮 → 再看预览产出」的阅读/操作顺序一致 ✓。
          · 运行中 → 整行变「取消」（始终有一个与阶段无关的中止入口）。 */}
      {onRunRequest && (
        running ? (
          <button
            title="中止当前运行"
            onClick={() => onCancelRequest?.()}
            style={{ padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, border: 'none', color: '#fff', background: '#b91c1c' }}
          >⏹ 取消（生成中…）</button>
        ) : (
          <button
            title="一键跑完 ①生成视频 + ②视频抠像 + ③GIF 输出（等价于依次点三个阶段按钮）"
            onClick={() => runStage(selectedCells.size > 0 ? 'cell' : 'all', 'all')}
            style={{ padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, border: 'none', color: '#fff', background: 'linear-gradient(180deg,#7c3aed,#5b21b6)' }}
          >⚡ 一键 ①+②+③{selSuffix}</button>
        )
      )}

      {/* ═══ 统一预览窗口（2026-09-12 第三轮用户需求「预览**不分阶段**；每个格子中提供
          按钮切换 原图/视频/抠图/GIF；切到没有资源的来源就给提示；任何阶段页签里重新
          生成都要同步更新预览格子」）═══
          · 一格一来源：格内右上角按钮循环 原图 → 视频 → 抠图 → GIF（**不跳过**缺失档，
            切过去就明确提示 —— 否则会误以为「怎么切都是同一张图」✗）
          · 没手动切过的格走**自动档**（最靠后的已生成产物）→ 阶段跑完自动前进 ✓
          · 内容全部取实时数据（videoByCell / matteByCell / gifAt / cellSourceRefs）
            → 任何阶段重新生成都会同步刷新格子 ✓
          · 点格选中 → 阶段按钮只处理选中格 */}
      <div style={{ border: '1px solid rgba(56,189,248,.42)', borderRadius: 8, background: 'rgba(56,189,248,.04)', overflow: 'hidden' }}>
        {stageHeader('🔍', '预览', '#38bdf8', (
          <>
            {selectedCells.size > 0 && (
              <span style={{ color: '#4a9eff', fontWeight: 700 }}>
                已选 {compressRanges([...selectedCells].sort((a, b) => a - b))}
              </span>
            )}
            <span>① {videoCount} · ② {matteCount} · ③ {gifCount}（共 {pvCellCount} 格）</span>
            {hintTip('三个阶段共用这一个格子网格（不分阶段）。每格右上角按钮循环切换来源：🖼 原图 → 🎬 视频 → ✂️ 抠图 → 🎞 GIF；切到的来源还没生成时，格内直接显示提示文字。切到「✂️ 抠图」后，格子右下角出现 ‹ › 可逐帧查看抠像效果（每帧都是按当前抠像参数实时抠出来的软边预览，调参后自动重算）。左下角角标＝当前显示来源。没手动切过的格会自动显示「最靠后的已生成产物」——任一阶段重新生成后自动同步刷新。点格选中 → 阶段按钮只处理选中格。')}
          </>
        ))}
        <div style={{ padding: 8 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.max(1, effCols)}, 1fr)`,
              gap: 6, padding: 8, borderRadius: 6,
              border: '1px solid rgba(255,255,255,.1)', background: '#1b1c20',
            }}
          >
            {Array.from({ length: pvCellCount }).map((_, i) => {
              const vRef = videoByCell.get(i);
              const sRef = cellSourceRefs?.[i];
              const playableUrl = vRef ? playableByUrl.get(vRef) : undefined;
              const poster = vRef ? videoPosters.get(vRef) : undefined;
              // ★「可播」≠「map 里有值」：代理失败时 map 里存的是**原始外网 URL** →
              //   `<video>` 被 CSP 拦（角标会说谎 ✗）→ 用播放失败集回落静帧/原图。
              const videoPlayable = !!playableUrl && !(!!vRef && videoPlayErrors.has(vRef));
              // ② 抠像结果：选中格实时序列帧优先（调参即时可见）→ ② 归档结果
              const seq = matteSeq.get(i);
              const seqReady = !!seq && seq.urls.length > 0;
              // ★ 逐格可翻帧（2026-09-12 用户需求「单格中，抠图状态下要可以查看每帧的
              //   效果」）：只要该格算出了序列帧就显示它 + 挂 ‹ › 翻帧控件 —— 不再限定
              //   「选中格」（否则用户切到抠图档却看不到翻帧按钮 ✗）。
              const liveSeq = seqReady;
              const matteRef = liveSeq ? seq!.urls[seq!.idx] : matteByCell.get(i);
              // ③ GIF：已被 ② 的新参数淘汰 → 当它不存在（回落显示新抠像结果 + 提示重转）
              const cell = gifAt(i);
              const staleGif = gifStaleAt(i);
              const staleReason = staleGif ? gifStaleReason(i) : '';
              const gifRef = staleGif ? undefined : cell?.ref;
              const gifIsVideo = !staleGif && cell?.isVideo === true;
              const isSel = selectedCells.has(i);
              const revNum = Number(cell?.rev ?? 0);
              const justUpdated = justRanAt > 0 && revNum > 1_600_000_000_000
                && revNum <= justRanAt && justRanAt - revNum < 5000;
              const imgStyle: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'contain' };
              const vidStyle: React.CSSProperties = { ...imgStyle, background: '#000' };
              const videoEl = (src: string, controls: boolean, errRef?: string): React.ReactElement => (
                <video
                  src={src} autoPlay loop muted playsInline controls={controls}
                  onError={() => setVideoPlayErrors(prev => {
                    if (!errRef || prev.has(errRef)) { return prev; }
                    const next = new Set(prev); next.add(errRef); return next;
                  })}
                  style={vidStyle}
                />
              );
              // ── 本格当前来源（手动选择优先；否则自动档 = 最靠后的已生成产物）──
              const mode = previewModeOf(i);
              const nextMode = PREVIEW_MODE_ORDER[(PREVIEW_MODE_ORDER.indexOf(mode) + 1) % PREVIEW_MODE_ORDER.length];
              let node: React.ReactNode = null;
              let badge = '';
              let badgeColor = 'rgba(0,0,0,.55)';
              /** 该来源没有资源时的提示文字（用户 2026-09-12 需求：切过去要给提示）。 */
              let emptyText = '';
              if (mode === 'source') {
                if (sRef) { node = <img src={sRef} alt={`cell-src-${i}`} style={imgStyle} />; badge = '原图'; }
                else { emptyText = PREVIEW_MODE_META.source.empty; }
              } else if (mode === 'video') {
                // 视频：可播化 URL 播放 → 首帧静帧（仍属「视频」的内容，非回落他源）→ 提示
                if (videoPlayable && playableUrl) {
                  node = videoEl(playableUrl, false, vRef); badge = '原片'; badgeColor = 'rgba(34,211,238,.78)';
                } else if (poster) {
                  node = <img src={poster} alt={`cell-frame-${i}`} style={imgStyle} />;
                  badge = '原片·首帧'; badgeColor = 'rgba(34,211,238,.42)';
                } else {
                  // ★ 区分「**真的没生成**」与「**生成过、但原片取不到**」（2026-09-12
                  //   用户反馈「生成过视频，重启后却显示未生成视频」）：`vRef` 存在就说明
                  //   产物在快照里 ✓ —— 此时多半是**可播化 URL 还没就绪**（几 MB data URL
                  //   解码 / 外网签名 URL 走 host 代理拉取中）或**原片已失效**（签名过期、
                  //   代理失败 → `<video>` 被 CSP 拦 → onError）。原先一律写「未生成视频」
                  //   会误导用户以为白跑了 ✗。
                  emptyText = vRef
                    ? (videoPlayErrors.has(vRef) ? '原片加载失败（可重跑 ①）' : '原片加载中…')
                    : PREVIEW_MODE_META.video.empty;
                }
              } else if (mode === 'matte') {
                if (matteRef) {
                  node = <img src={matteRef} alt={`cell-matte-${i}`} style={imgStyle} />;
                  badge = liveSeq ? '抠像帧' : '抠像'; badgeColor = 'rgba(129,140,248,.85)';
                } else { emptyText = PREVIEW_MODE_META.matte.empty; }
              } else {
                if (gifRef) {
                  node = gifIsVideo
                    ? videoEl(playableByUrl.get(gifRef) ?? gifRef, true, gifRef)
                    : (
                      // ★ key 带 rev：重新生成后强制重挂 `<img>` —— 参数/输入未变时 GIF 字节
                      //   可能完全相同 → src 不变 → 浏览器沿用旧解码帧，视觉上「没更新」✗。
                      <img key={`gif-${i}-${cell?.rev ?? ''}`} src={gifRef} alt={`cell-${i}`} style={imgStyle} />
                    );
                  badge = 'GIF'; badgeColor = 'rgba(168,85,247,.85)';
                } else {
                  // 过期（② 用新参数重跑过）→ 明确提示待重转，而不是默默显示旧图 ✗
                  emptyText = staleGif
                    ? (staleReason === 'video' ? '① 已更新 · 待重转 GIF' : '② 已更新 · 待重转 GIF')
                    : PREVIEW_MODE_META.gif.empty;
                }
              }
              return (
                <div
                  key={i}
                  onClick={() => setSelectedCells(prev => {
                    const next = new Set(prev);
                    if (next.has(i)) { next.delete(i); } else { next.add(i); }
                    return next;
                  })}
                  title={(badge
                    ? `第 ${i} 格 · 当前显示「${badge}」· 右上角按钮切换来源（原图/视频/抠图/GIF）· 点击选中（可多选）`
                    : `第 ${i} 格 · ${emptyText || '无内容'} · 右上角按钮切换来源（原图/视频/抠图/GIF）· 点击选中`)
                    + (mode === 'matte' ? ' · 右下角 ‹ › 逐帧查看抠像效果' : '')}
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
                    border: isSel ? '1.5px solid #4a9eff'
                      : justUpdated ? '1.5px solid #22c55e'
                        : '1.5px solid rgba(255,255,255,.06)',
                    boxShadow: isSel ? '0 0 0 2px rgba(74,158,255,.28)'
                      : justUpdated ? '0 0 0 2px rgba(34,197,94,.35)'
                        : 'none',
                    overflow: 'hidden',
                  }}
                >
                  <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 8, color: 'rgba(255,255,255,.6)', fontFamily: 'monospace', zIndex: 2 }}>{i}</span>
                  {node ?? (
                    /* 切到的来源没有资源 → 明确提示（用户 2026-09-12 需求） */
                    <span style={{ color: 'rgba(255,255,255,.45)', fontSize: 9, textAlign: 'center', lineHeight: 1.4, padding: '0 4px' }}>{emptyText}</span>
                  )}
                  {badge && (
                    <span style={{
                      position: 'absolute', bottom: 2, left: 3, fontSize: 8, lineHeight: '12px', padding: '0 4px',
                      borderRadius: 3, color: '#fff', zIndex: 3, background: badgeColor,
                    }}>{badge}</span>
                  )}
                  {/* ★ 逐格切换预览来源（2026-09-12 用户需求）：右上角按钮循环
                      原图 → 视频 → 抠图 → GIF；图标 = **下一个**来源（点按直觉一致）。 */}
                  <button
                    title={`当前：${PREVIEW_MODE_META[mode].label} · 点击切换为：${PREVIEW_MODE_META[nextMode].label}`}
                    onClick={(ev) => { ev.stopPropagation(); cyclePreviewMode(i); }}
                    style={{
                      position: 'absolute', top: 2, right: 3, height: 16, padding: '0 4px',
                      borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, lineHeight: 1,
                      background: mode === 'gif' ? 'rgba(0,0,0,.55)' : 'rgba(56,189,248,.72)',
                      color: '#fff', zIndex: 4,
                    }}
                  >{PREVIEW_MODE_META[nextMode].icon}</button>
                  {/* 抠图档：选中格的实时序列帧导航（‹ › 翻帧，调参即时可见） */}
                  {mode === 'matte' && liveSeq && seq && (
                    <div
                      onClick={(ev) => ev.stopPropagation()}
                      style={{ position: 'absolute', bottom: 2, right: 3, height: 14, display: 'flex', alignItems: 'center', gap: 1, background: 'rgba(0,0,0,.55)', borderRadius: 3, zIndex: 4 }}
                    >
                      <button title="上一帧" onClick={() => stepMatteFrame(i, -1)} style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '0 3px' }}>‹</button>
                      <span style={{ fontSize: 8, fontFamily: 'monospace', color: '#fff' }}>{seq.idx + 1}/{seq.urls.length}</span>
                      <button title="下一帧" onClick={() => stepMatteFrame(i, 1)} style={{ border: 'none', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 10, lineHeight: 1, padding: '0 3px' }}>›</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ⚠ 产物过期提示（2026-09-12）：上游输入已更换（或产物为**旧版本生成、无输入
          指纹**，无法证明与当前输入一致）→ 已从预览剔除，回落显示新输入原图/上游产物；
          提示用户重跑 ①②③。 */}
      {staleCells && staleCells.length > 0 && (
        <div style={{ fontSize: 9, color: '#fbbf24', lineHeight: 1.6 }}>
          ⚠ {staleCells.length} 格产物与当前输入不匹配（{compressRanges([...staleCells].sort((a, b) => a - b))}）：
          输入已更换，或该产物由旧版本生成、缺少输入指纹 —— 已从预览中隐藏，请重新执行 ① → ② → ③。
        </div>
      )}

      {/* ── 三阶段进度条（2026-09-12 用户需求「页签样式改为进度条上的圆点，圆点可点击」）──
          · 圆点 = 阶段；**点击圆点切页签**（等价原页签按钮，语义/快捷键行为不变）
          · 圆点状态：该阶段**已有产物** → 实心 + ✓；当前页签 → 外环高亮；无产物 → 空心暗色
          · 轨道填充到「最远的已产出阶段」= 真实进度（不是「当前页签」）
          · 每阶段执行完仍自动切到下一阶段（见上方 autoSwitch effect），圆点会跟着走
          · 标签只留短文案（带「已生成 N 格」会折行 ✗，状态进 title 悬浮提示） */}
      <div style={{ display: 'flex', alignItems: 'flex-start', padding: '8px 4px 6px' }}>
        {stages.map((t, i) => {
          const done = t.count > 0;
          const isCur = tab === t.id;
          // 段 i（第 i-1 与第 i 个圆点之间）是否已填充
          const segFilled = i > 0 && i <= filledUpTo;
          const dotColor = done || isCur ? t.accent : 'rgba(255,255,255,.24)';
          return (
            <React.Fragment key={t.id}>
              {i > 0 && (
                <div style={{
                  flex: 1, height: 2, marginTop: 6, borderRadius: 1,
                  background: segFilled ? t.accent : 'rgba(255,255,255,.14)',
                  opacity: segFilled ? 0.8 : 1,
                }} />
              )}
              <button
                type="button"
                onClick={() => setTab(t.id)}
                title={`${t.label} · ${t.status}（点击切换）`}
                style={{
                  flex: '0 0 auto', minWidth: 58, padding: '0 2px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <span style={{
                  width: 14, height: 14, boxSizing: 'border-box', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, lineHeight: '10px', fontWeight: 700, color: '#0b0b0d',
                  background: done ? dotColor : 'transparent',
                  border: `2px solid ${dotColor}`,
                  boxShadow: isCur ? `0 0 0 3px ${t.accent}33` : 'none',
                }}>{done ? '✓' : ''}</span>
                <span style={{
                  fontSize: 9, whiteSpace: 'nowrap', fontWeight: isCur ? 700 : 500,
                  color: isCur ? t.accent : 'var(--vscode-descriptionForeground, #9a9a9a)',
                }}>{t.label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* ═══ 阶段① 生成视频（2026-09-12 三阶段拆分）═══════════════════════════
          只生成绿幕视频（provider 图生视频 / ComfyUI I2V）→ 归档 port='video'。
          **不抠像、不编码 GIF** —— 调抠像参数不必重跑视频（分钟级）。 */}
      {tab === 'video' && (
      <div style={{ border: '1px solid rgba(34,211,238,.32)', borderRadius: 8, background: 'rgba(34,211,238,.05)', overflow: 'hidden' }}>
        {stageHeader('①', '生成视频（绿幕底）', '#22d3ee', (
          <>
            <span>{videoCount === 0 ? '未执行' : `已生成 ${videoCount} 格`}</span>
          </>
        ))}
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* ── 提示词（2026-09-12 用户需求「视频生成 增加提示词 字段」）──────────
              · 写回 `values.prompt`；执行器优先用它，**为空才回退**上游 `texts`
                端口连线的文本（图生视频以参考图为主体，这里只描述「怎么动」）。
              · 用 textarea 而非单行 input：动作描述常是多段（「挥手、眨眼、转圈」），
                且该字段越长越需要复核 —— 用户要能一眼看全自己写了什么。
              · ★ 该字段会被系统追加「实心不透明 + 绿幕」约束后缀，别写发光/透明类效果
                （见右侧 ❗ 说明）。 */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>提示词</span>
              {hintTip('动作描述（可选）——图生视频以参考图为主体，这里只描述「怎么动」，如「挥手打招呼、眨眼、身体轻微左右晃动」。'
                + '★ 优先级：本字段 > 上游 texts 端口连线的文本；两者都为空时仅用系统通用约束后缀。'
                + '★ 系统会自动追加「实心不透明」与「绿幕背景」约束：半透明元素叠在绿幕上时抠像数学上欠定（一个方程两个未知数），'
                + '经典抠像算法会把它整块删掉、GIF 的 1-bit 透明也表达不了 —— 所以别在这里写「发光 / 透明 / 水花 / 气泡」这类效果，会被约束压制。')}
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder="动作描述，如：挥手打招呼、眨眼、身体轻微左右晃动"
              style={{
                width: '100%', boxSizing: 'border-box',
                // 纵向可拉伸但限高：卡片本身是固定尺寸的画布 DOM widget，
                // 拉太高会把下方「① 生成视频」按钮挤出可视区 ✗。
                resize: 'vertical', minHeight: 34, maxHeight: 120,
                fontSize: 10, lineHeight: 1.5, padding: '5px 6px',
                background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)',
                border: '1px solid rgba(255,255,255,.14)', borderRadius: 4,
                fontFamily: 'inherit',
              }}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            {/* ★ 阶段语义说明收敛成 ❗ 悬浮 tip（2026-09-12 用户需求） */}
            {stepper('时长 秒', durationS, 2, 5, 1, setDurationS,
              (chromaEnable
                ? '参考图叠加绿幕后喂视频模型 → 产出绿幕原片（供阶段② 抠像）。'
                : '绿幕合成已关闭：参考图原样直喂 → 产出保留原背景的视频（阶段② 抠像自动忽略）。')
              + ' 生成渠道 / Provider / 模型 / Seed 在节点顶部「🎬 生成渠道」选择。'
              + ' ★ 提示词会自动追加「实心不透明」约束（不要半透明效果）：半透明元素叠在绿幕上时抠像在数学上欠定'
              + '（一个方程两个未知数）→ 经典抠像算法会把它整块删掉、GIF 的 1-bit 透明也表达不了，'
              + '所以从生成源头就要求模型画成实心。上游动作描述里若写了发光/透明/水花/气泡等效果，会被该约束压制。')}
          </div>

          {/* ── 阶段① 按钮 ── */}
          {onRunRequest && (
            <div style={{ display: 'flex', gap: 6 }}>
              {stageButton({
                stage: 'video',
                label: videoCount === 0 ? `① 生成视频${selSuffix}` : `① 重新生成视频${selSuffix}`,
                title: videoCount === 0
                  ? '生成绿幕视频（不抠像、不编码 GIF）；选中的格才处理，未选=全部'
                  : '重新生成绿幕视频（会覆盖阶段② 的抠像来源，需重跑阶段②）',
                accent: 'linear-gradient(180deg,#06b6d4,#0e7490)',
              })}
            </div>
          )}
        </div>
      </div>
      )}

      {/* ═══ 阶段② 视频抠像（2026-09-12 三阶段拆分）═══════════════════════════
          读阶段① 的绿幕原片 → 抠像 → 归档抠像结果（port='matte'）。
          **不生成视频、不编码 GIF** —— 调抠像参数只需重跑本阶段（秒级）。 */}
      {tab === 'matte' && (
      <div style={{ border: '1px solid rgba(129,140,248,.32)', borderRadius: 8, background: 'rgba(129,140,248,.05)', overflow: 'hidden' }}>
        {stageHeader('②', '视频抠像（绿幕 → 透明）', '#818cf8', (
          <>
            <span>{matteCount === 0 ? '待执行' : `已抠像 ${matteCount} 格`}</span>
          </>
        ))}
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            {/* ★ 算法说明收敛成 ❗ 悬浮 tip（2026-09-12 用户需求：提示文字不再占版面） */}
            {hintTip(`${CHROMA_KEY_ALGOS.find(a => a.id === chromaAlgo)?.tip ?? ''}（视觉对比工具：测试面板 → 抠像对比实验室，拖入绿幕视频逐帧并排对比）`)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: chromaEnable && matteEnable ? 1 : 0.4, pointerEvents: chromaEnable && matteEnable ? 'auto' : 'none' }}>
            <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>绿幕色</span>
            {/* ★ 关掉「自动」时若 `chromaColor` 里存的是 `'auto'`（持久化自上次自动态 ✗）
                必须先归一成合法 hex：① `<input type="color">` 拿到 `'auto'` 会报
                「does not conform to the format #rrggbb」控制台错误 ✗；② 关掉自动却把
                `'auto'` 提交回 widget ⇒ 参数与勾选态不一致 ✗。 */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)', cursor: 'pointer', whiteSpace: 'nowrap' }} title="自动从视频首帧四边采样实际幕布色（推荐：视频编码会使幕布绿漂移，采样比固定色更准）。合成仍用纯绿。">
              <input type="checkbox" checked={chromaAuto}
                onChange={(e) => {
                  const on = e.target.checked;
                  setChromaAuto(on);
                  if (!on && !/^#[0-9a-fA-F]{6}$/.test(chromaColor)) { setChromaColor('#00FF00'); }
                }}
                style={{ width: 12, height: 12, margin: 0, accentColor: '#e879f9' }} />
              自动
            </label>
            <input type="color"
              value={chromaAuto || !/^#[0-9a-fA-F]{6}$/.test(chromaColor) ? '#00FF00' : chromaColor}
              disabled={chromaAuto} onChange={(e) => setChromaColor(e.target.value)}
              style={{ width: 28, height: 22, padding: 0, border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, background: 'transparent', opacity: chromaAuto ? 0.4 : 1 }} />
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--vscode-foreground, #e8e8e8)' }}>{chromaAuto ? 'auto（首帧采样）' : chromaColor}</span>
          </div>
          {/* ★ `auto-fit + minmax`（2026-09-12 防截断）：卡片窄时自动从两列降为一列，
              而不是把第二列挤出面板被 `overflow:hidden` 裁掉 ✗。 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, opacity: chromaEnable && matteEnable ? 1 : 0.4, pointerEvents: chromaEnable && matteEnable ? 'auto' : 'none' }}>
            {/* ★ 参数建议收敛成每个 stepper 的 ❗ 悬浮 tip（2026-09-12 用户需求） */}
            {stepper('相似度', Math.round(chromaSimilarity * 100) / 100, 0.05, 1, 0.05,
              (v) => setChromaSimilarity(Math.max(0.05, Math.min(1, v))),
              '「多像绿幕才算绿幕」：越大 → 抠得越净，但误伤浅色/半透明元素（白描边、泡泡、高光）的风险越高 ✗。'
              + '浅色元素被吃掉时请调小（0.1-0.15）；绿残留/边缘发绿时调大。默认 0.2。')}
            {stepper('去绿边', Math.round(chromaSmoothness * 100) / 100, 0, 1, 0.05,
              (v) => setChromaSmoothness(Math.max(0, Math.min(1, v))),
              '外扩清除带宽（不是「羽化」）：越大 → 从主体边缘往里吃得越多 —— 绿残留更少，但描边更细、'
              + '泡泡/高光这类浅色元素更容易整块消失 ✗。GIF 硬路径自动钳制到 0.12；② 抠图档的实时序列帧'
              + '（软边预览，可 ‹ › 翻帧）用它作过渡带宽度。浅色元素被吃掉请调小（0.05-0.1）。默认 0.08。')}
          </div>
          {/* ★ 超限警示（2026-09-12 用户反馈「各算法表现都不理想」）：0.25 这类偏大的
              「去绿边」会把白描边整圈削细、并把泡泡/高光等浅色元素整体吃掉 —— 而它是
              最容易被误当成「抠图算法不行」的参数 ✗。GIF 硬路径已自动钳制到 0.12，
              软边预览不钳制（它作过渡带宽度），故这里显式提示。 */}
          {chromaEnable && matteEnable && chromaSmoothness > 0.12 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: '#fbbf24' }}>
              {hintTip('「去绿边」= 从主体边缘往里清除的带宽：超过 0.12 会整圈削掉白描边，并让泡泡/高光这类浅色、半透明元素整块消失 ✗（GIF 硬路径已自动钳制到 0.12；② 抠图档的软边预览不钳制）。浅色元素被吃掉时先把它调回 0.08-0.12 再看。', 'warn')}
              <span>去绿边 {Math.round(chromaSmoothness * 100) / 100} 偏大（建议 0.08-0.12）：会削细描边、吃掉浅色/半透明元素</span>
            </div>
          )}

          {/* ── 阶段① 按钮 ── */}
          {onRunRequest && (
            <div style={{ display: 'flex', gap: 6 }}>
              {stageButton({
                stage: 'matte',
                label: videoCount === 0 ? `② 开始抠像${selSuffix}` : `② 重新抠像${selSuffix}`,
                title: videoCount === 0
                  ? '需要先执行阶段①（生成视频）'
                  : '用当前抠像参数对已有绿幕视频抠像（秒级；不重新生成视频、不编码 GIF）',
                disabled: videoCount === 0,
                accent: 'linear-gradient(180deg,#6366f1,#4338ca)',
              })}
            </div>
          )}
        </div>
      </div>
      )}

      {/* ═══ 阶段③ GIF 输出（2026-09-12 三阶段拆分）═══════════════════════════
          用**当前**抠像参数把阶段① 的绿幕原片编码为透明 GIF，并顺手把阶段② 的
          抠像结果刷成同一组参数（两页签同格同源；改参数后点 ③ 立即生效）。 */}
      {tab === 'gif' && (
      <div style={{ border: '1px solid rgba(168,85,247,.32)', borderRadius: 8, background: 'rgba(168,85,247,.05)', overflow: 'hidden' }}>
        {stageHeader('③', 'GIF 输出（240×240 · 循环）', '#a855f7', (
          <>
            <span>{gifCount === 0 ? '待执行' : `已生成 ${gifCount} 格`}</span>
            {/* ★ 「更新于」= 生成动作的可见凭据（2026-09-12）：参数未变时 GIF 可能
                字节完全相同，光看缩略图无法判断「到底跑了没有」。 */}
            {gifUpdatedAt && <span title="最近一次 ③ 生成 GIF 的时间">· 更新于 {gifUpdatedAt}</span>}
            {/* ★ 过期提示（2026-09-12）：② 用新参数重跑后，旧 GIF 需要重转。 */}
            {staleGifCells.length > 0 && (
              <span
                style={{ color: '#f59e0b', fontWeight: 700 }}
                title={`格 ${compressRanges(staleGifCells)} 的抠像结果已被阶段② 更新（参数已变）→ 需点 ③ 重转 GIF`}
              >· 待重转 {staleGifCells.length} 格</span>
            )}
          </>
        ))}
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            {/* ★ 时长说明收敛成 ❗ 悬浮 tip（2026-09-12 用户需求） */}
            {hintTip(`GIF 时长跟随阶段① 的「时长 秒」（当前 ${durationS}s）；改时长需回阶段① 重新生成视频。`)}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: gifEnable ? 1 : 0.4, pointerEvents: gifEnable ? 'auto' : 'none', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={loopBlend}
              onChange={(e) => setLoopBlend(e.target.checked)}
              style={{ accentColor: '#8a3fd0' }}
            />
            <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>
              首尾回环混合（尾部 4 帧渐回首帧，循环播放无缝；仅混合颜色接近的像素，动作大时可关）
            </span>
          </label>
          {/* ★ `auto-fit + minmax`（2026-09-12 防截断）：窄卡片自动降为一列 —— 原先
              「帧率 fps / 单图上限 KB」挤两列时，第二个 stepper 的「值 + ＋」被裁掉 ✗。 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, opacity: gifEnable ? 1 : 0.4, pointerEvents: gifEnable ? 'auto' : 'none' }}>
            {/* ★ 参数说明收敛成每个 stepper 的 ❗ 悬浮 tip（2026-09-12 用户需求） */}
            {stepper('帧率 fps', fps, 6, 15, 1, setFps,
              '微信规范建议 8-15fps（默认 12）。帧率越低越省体积，但动作会顿。')}
            {stepper('单图上限 KB', maxKb, 100, 2000, 50, setMaxKb,
              '上限针对单个 GIF（每格各自 ≤上限）：超限按「帧率→色数」降级（尺寸不降，保 240×240）。'
              + '★ 微信表情规范：动态 GIF 240×240 ≤500KB（8~24 为一套的张数）——默认 500KB 落点为 128 色 @ 8fps；'
              + '100KB 连 24 色 4fps 保底档都超限，且低色数量化必致颜色偏差。'
              + '每格自动附带缩略图 PNG 240×240 ≤60KB（随条目 meta.thumb）。')}
          </div>
          {maxKb < 500 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: '#38bdf8' }}>
              {hintTip(`上限 ${maxKb}KB：低于微信单张动态表情上限（500KB）——会按「帧率→色数」自动降级，低色数量化是颜色偏差/描边模糊主因。`)}
              <span>上限 {maxKb}KB 低于微信 500KB 规范，会自动降级</span>
            </div>
          )}

          {/* ── 阶段③ 按钮 ── */}
          {onRunRequest && (
            <div style={{ display: 'flex', gap: 6 }}>
              {stageButton({
                stage: 'gif',
                label: videoCount === 0 ? `③ 生成 GIF${selSuffix}` : `③ 重新生成 GIF${selSuffix}`,
                title: videoCount === 0
                  ? '需要先执行阶段①（生成视频）'
                  : '用**当前**抠像参数把绿幕原片编码成 GIF（并同步刷新阶段② 的抠像结果）',
                disabled: videoCount === 0,
                accent: 'linear-gradient(180deg,#a855f7,#8b3fd0)',
              })}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
