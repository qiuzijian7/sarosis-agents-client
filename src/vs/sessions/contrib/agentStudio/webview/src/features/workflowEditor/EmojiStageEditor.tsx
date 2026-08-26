/**
 * EmojiStageEditor — ComfyTV EmojiStage 的内嵌编辑器。
 *
 * 功能：生成 m×n 个动态表情包（透明背景循环贴纸）。每个格子可独立编辑
 * prompt / seed 并单独重新生成；网格用棋盘格底纹实时展示透明通道。
 *
 * 交互组成：
 *  - 预设（2×2 / 3×3 / 4×4 / 2×3 / 3×2）一键设定 rows/cols；
 *  - Rows / Cols 步进器（1–6）；
 *  - m×n 网格预览：已生成格显示缩略图（透明底棋盘格），空位显示占位虚线框；
 *    点击选中（蓝框高亮）；hover 出现「⟳ 重新生成」；
 *  - 选中格编辑面板：独立 prompt（留空回退全局）+ seed 重掷 + 「生成此表情」；
 *  - 全局 prompt + 视频时长（生成全部走节点卡片外部 RUN 按钮）。
 *
 * 数据流（对齐 GridSplitEditor 的 onCommit 约定）：
 *   rows / cols / duration_s / prompt / selected_index / cells
 * cells 是 JSON 字符串（数组 [{prompt, seed}]），长度 = rows*cols，由本组件
 * 负责序列化/反序列化；onCommit 以 patch 形式写回（nodeCard → wf-node-control）。
 */
import * as React from 'react';
import { MentionTextarea, type MentionCandidate } from './comfyHost/MentionTextarea';

export interface EmojiStageCell {
  prompt: string;
  seed: number;
}

export interface EmojiStageInit {
  rows: number;
  cols: number;
  /** 动态表情视频时长（秒，MiniMax H3 驱动帧数；fps 固定 24）。 */
  duration_s: number;
  /** 全局 prompt（所有格子默认值） */
  prompt: string;
  /** 每格独立状态，JSON 字符串（数组 [{prompt, seed}]） */
  cells: string;
  selectedIndex: number;
  /** 当前 workflow 模板名（静态贴纸 / 动态表情 / fallback）。 */
  workflow?: string;
}

export interface EmojiStageEditorProps {
  initial: EmojiStageInit;
  /** 每格已生成图 ref（可选，按 cell index 对齐；空则显示占位）。 */
  /**
   * 每格已生成图的引用 + 配文。
   * - `ref`：图 URL（动画 webp 或静态贴纸）。
   * - `kind`：`'image'`（PNG/JPG/WebP 等静态图，渲染 `<img>`）或 `'video'`（mp4/webm 等动态图，渲染 `<video>`）。
   *   缺省 `image` 兼容旧传法（无 kind 字段时按图片渲染）。
   * - `caption`：归档时写进 `media.meta.caption` 的配文（见 workflowRun.ts）。
   *   动画图不做 Canvas 烘焙（保动画），配文只存在于 meta；预览层优先读
   *   `caption` 以保证「图与描述一致」——即使重启后 `cells` 内存态丢失也能显示。
   * 兼容旧 `string[]` 传法（无 caption 时回退到编辑器 `c.text`）。
   */
  cellRefs?: Array<string | { ref: string; caption?: string; kind?: 'image' | 'video' } | undefined>;
  /**
   * 可选 workflow 模板名列表（`workflowOptionsFor('emoji')`）。
   *
   * ★ 必须由本编辑器自己渲染：nodeCard 的通用控件网格有 `!hasInlineEditor` 门禁
   *   （第 ~1941 行），只要 stage 有内嵌编辑器，**所有** widget 通用控件都不渲染。
   *   曾因此导致 workflow 下拉完全不可见 → 用户无法切到「动态表情」，
   *   一直在跑默认的静态贴纸却以为是动态的。
   */
  workflowOptions?: string[];
  onCommit: (patch: Record<string, unknown>) => void;
  /** 触发运行（cellIndex 传入 = 只重生成该格）。 */
  onRunRequest?: (cellIndex?: number) => void;
  /** @ 提及候选（节点 + 文件），由 NodeCard 注入；缺省时输入框仍可用但无 @ 面板。 */
  mentionCandidates?: MentionCandidate[];
  /** @ 选中文件时钉成资产引用。 */
  onPinAsset?: (c: MentionCandidate) => void;
  }

/**
 * 模板名是否为动态（MiniMax H3 视频 / AnimateDiff）。
 *
 * 用名字判定而非维护一张映射表：模板名来自 `EMOJI_BUILTIN_WORKFLOWS` 的键
 * （见 `builtinWorkflows/emojiWorkflows.ts`），新增动态模板时只要名字带「动态」
 * 或 minimax / animatediff 就会被自动识别，不需要改这里。
 */
function isAnimatedWorkflow(label: string | undefined): boolean {
  return !!label && (label.includes('动态') || /animatediff|minimax/i.test(label));
}

const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×2', rows: 3, cols: 2 },
];

/**
 * 动作词快捷面板（点击把视觉动词描述插入选中格 prompt）。
 *
 * 视觉动词体系对齐开源 MiniMax-AI/skills `gif-sticker-maker`（MIT）：
 * 前 4 个（挥手/大笑/大哭/比心）直接取自其 video-prompt-template.txt 的
 * `Action reference`（hi/laugh/cry/love）；其余为常见表情包动作的合理扩展。
 * 用「视觉动词描述」而非单词，比裸 "waving" 更可控、出图更一致。
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

/** 动作词 chips：点击即把视觉动词插入选中格 prompt。 */
function ActionChips({ onPick }: { onPick: (text: string) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
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

const MAX_CELLS = 36;

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

export function EmojiStageEditor({ initial, cellRefs, workflowOptions, onCommit, onRunRequest, mentionCandidates, onPinAsset }: EmojiStageEditorProps): React.ReactElement {
  const [rows, setRows] = React.useState<number>(Math.max(1, Math.min(6, initial.rows || 3)));
  const [cols, setCols] = React.useState<number>(Math.max(1, Math.min(6, initial.cols || 3)));
  const [durationS, setDurationS] = React.useState<number>(initial.duration_s || 3);
  const [globalPrompt, setGlobalPrompt] = React.useState<string>(initial.prompt || '');
  const [selectedIndex, setSelectedIndex] = React.useState<number>(initial.selectedIndex ?? 0);

  // ── 动态开关 ──────────────────────────────────────────────────────────────
  // 交互模型：**开关是主控**，`workflow` 是派生值。
  // 若让开关与模板下拉各持一份 state，两者会互相覆盖（切开关重置下拉、
  // 选下拉又与开关不符）。故这里只存「开关状态」+「静态模式下选的模板」，
  // 生效的 workflow 由二者算出，天然不会打架。
  const animatedOption = React.useMemo(
    () => (workflowOptions ?? []).find(isAnimatedWorkflow), [workflowOptions]);
  const staticOptions = React.useMemo(
    () => (workflowOptions ?? []).filter(o => !isAnimatedWorkflow(o)), [workflowOptions]);

  const [animated, setAnimated] = React.useState<boolean>(() => isAnimatedWorkflow(initial.workflow));
  // 记住静态模式下选的是哪个模板，这样「关→开→关」能回到原来的选择
  const [staticWorkflow, setStaticWorkflow] = React.useState<string>(() =>
    (initial.workflow && !isAnimatedWorkflow(initial.workflow)) ? initial.workflow : (staticOptions[0] ?? ''));

  // 开关 ON 但没有可用的动态模板（理论上不该发生）→ 退回静态，避免写出空 workflow
  const canAnimate = !!animatedOption;
  const workflow = (animated && animatedOption) ? animatedOption : staticWorkflow;

  // staticOptions 晚到（首帧 workflowOptions 可能为 undefined）或模板表变更时，
  // 把失效的 staticWorkflow 纠正到第一个可用值 —— 否则会一直是空串，
  // commit 时被 `&& workflow` 跳过、静默落回执行器默认模板。
  React.useEffect(() => {
    if (staticOptions.length === 0) { return; }
    if (!staticWorkflow || !staticOptions.includes(staticWorkflow)) {
      setStaticWorkflow(staticOptions[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticOptions]);

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
      duration_s: durationS,
      prompt: globalPrompt,
      selected_index: selectedIndex,
      cells: JSON.stringify(cells),
    };
    // workflow 仅在本编辑器真的提供了选项时才写回，避免在无选项场景把
    // node.properties.workflow 覆写成空串（会让 runStageWorkflow 落回默认模板）。
    if (workflowOptions && workflowOptions.length > 0 && workflow) { patch.workflow = workflow; }
    onCommit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, durationS, globalPrompt, selectedIndex, cells, workflow]);

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
      {/* label 不设 minWidth：卡片固定 280px，双列 stepper 横排时固定 minWidth 会
          撑破容器（visual R2 horizontal-overflow，实测溢出 22~33px）。 */}
      <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>{label}</span>
      <button style={btn(false)} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 18, textAlign: 'center' }}>{value}</span>
      <button style={btn(false)} onClick={() => onChange(Math.min(max, value + 1))}>＋</button>
    </div>
  );

  const selCell = cells[selectedIndex];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 预设 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', marginRight: 2 }}>预设</span>
        {PRESETS.map((p) => {
          const active = p.rows === rows && p.cols === cols;
          return (
            <button key={p.label} style={btn(active)} onClick={() => { setRows(p.rows); setCols(p.cols); }}>
              {p.label}
            </button>
          );
        })}
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
          const caption = typeof cellRef === 'string' ? undefined : cellRef?.caption;
          // ★ 视频产物（MiniMax H3 mp4）必须用 <video> 渲染，<img> 不能播 mp4（显示 broken image）。
          //  缺省 image 兼容旧调用方。
          const kind = typeof cellRef === 'string' ? 'image' : (cellRef?.kind ?? 'image');
          const isSel = i === selectedIndex;
          return (
            <div
              key={i}
              onClick={() => { setSelectedIndex(clampIdx(i)); }}
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
              {ref ? (kind === 'video' ? (
                <video
                  src={ref}
                  muted
                  loop
                  autoPlay
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <img src={ref} alt={`cell-${i}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              )) : (
                <span style={{ color: '#6b6b6b', fontSize: 18 }}>＋</span>
              )}
              {/* hover 重生成（仅当有运行回调） */}
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
            编辑 <b style={{ color: '#4a9eff' }}>#{selectedIndex}</b> · 独立 prompt（留空则用全局）
          </span>
          <button style={btn(false)} onClick={() => setCell(selectedIndex, { prompt: '' })}>↩ 用全局</button>
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
            <button
              onClick={() => { /* eslint-disable-next-line no-console */ console.warn(`[EmojiStage] click ⟳ 生成此表情 selectedIndex=${selectedIndex}`); onRunRequest(selectedIndex); }}
              style={{ ...btn(false), background: 'linear-gradient(180deg,#d05ee0,#b44cc4)', borderColor: 'transparent', color: '#fff', fontWeight: 600 }}
            >
              ⟳ 生成此表情
            </button>
          )}
        </div>
      </div>

      {/* 全局 prompt + 生成选中表情 */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>全局 prompt（所有格默认）</div>
        <MentionTextarea
          value={globalPrompt}
          onChange={setGlobalPrompt}
          candidates={mentionCandidates ?? []}
          onPinAsset={onPinAsset}
          placeholder={animated
            ? '卡通表情包贴纸，透明背景，循环动画（输入 @ 引用节点或选择文件）'
            : '卡通表情包贴纸，透明背景（输入 @ 引用节点或选择文件）'}
          style={{
            minHeight: 40, background: '#17181c', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 6, fontSize: 11, padding: 6, lineHeight: 1.5, maxHeight: 120,
          }}
        />
        {/* 动态表情开关 + 静态模板下拉。
            移到视频参数正上方 —— 开关是「是否动画」的主控，与视频参数（动画的
            具体配置）语义相邻，开完开关立刻能调参数，无需跨过预设/行/列/网格/
            编辑面板/全局 prompt 一堆无关控件。 */}
        {workflowOptions && workflowOptions.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              onClick={() => { if (canAnimate) { setAnimated(v => !v); } }}
              title={canAnimate
                ? (animated
                  ? `动态表情：MiniMax H3 生成 ${durationS} 秒 mp4 动画（较慢，约 2-4 分钟/格）`
                  : '静态贴纸：单张 PNG（约 45 秒/格）')
                : '当前没有可用的动态模板'}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 8px', borderRadius: 6,
                cursor: canAnimate ? 'pointer' : 'not-allowed',
                opacity: canAnimate ? 1 : 0.5,
                userSelect: 'none',
                background: animated ? 'rgba(168,85,247,.13)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${animated ? 'rgba(168,85,247,.4)' : 'rgba(255,255,255,.1)'}`,
              }}
            >
              {/* 轨道 + 滑块 */}
              <span style={{
                position: 'relative', width: 30, height: 16, borderRadius: 8, flexShrink: 0,
                background: animated ? '#a855f7' : 'rgba(255,255,255,.18)',
                transition: 'background .15s ease',
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: animated ? 16 : 2,
                  width: 12, height: 12, borderRadius: '50%', background: '#fff',
                  transition: 'left .15s ease',
                }} />
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600,
                color: animated ? '#c084fc' : 'var(--vscode-foreground, #e8e8e8)',
              }}>
                动态表情
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
                {animated ? `${durationS} 秒 · 24 fps` : '单张 PNG'}
              </span>
            </div>

            {/* 静态模式下才需要选具体静态模板（透明贴纸 / 无 LoRA 回退）；
                动态模式只有一个模板，无需下拉。仅在有 2 个以上静态模板时显示。 */}
            {!animated && staticOptions.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>模板</span>
                <select
                  value={staticWorkflow}
                  onChange={(e) => setStaticWorkflow(e.target.value)}
                  style={{
                    flex: 1, minWidth: 0, fontSize: 10, padding: '3px 6px', borderRadius: 5,
                    background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)',
                    border: '1px solid rgba(255,255,255,.14)', fontFamily: 'inherit',
                  }}
                >
                  {staticOptions.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        {/* 视频参数**仅动态模板消费**（时长→ComfyMathExpression 帧数、fps 固定 24，
            见 emojiWorkflows.ts EMOJI_ANIMATED_MINIMAX）。静态模式下直接不渲染 ——
            摆着不可用的控件本身就是误导来源。 */}
        {animated && (
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              border: '1px solid rgba(168,85,247,.28)', borderRadius: 8,
              padding: 8, background: 'rgba(168,85,247,.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#c084fc' }}>🎬 视频参数</span>
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', fontFamily: 'monospace' }}>
                24 fps
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {stepper('时长 秒', durationS, 2, 15, setDurationS)}
            </div>
            <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
              MiniMax H3 生成 mp4 动画；微信表情包 GIF 请连接「视频转 GIF」工具节点截取 ≤3s 转换
            </div>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'monospace' }}>
            {MAX_CELLS >= cellCount ? `${cellCount} 格 · 选中 #${selectedIndex}` : '格数超限'}
          </span>
        </div>
        {/* 动态生成代价高（MiniMax H3 文生视频，实测 2-4 分钟/格），点之前先给出预估，
            避免用户以为卡死。系数取自 RTX 4070 实测：静态 ~45s、动态视频更长。 */}
        {animated && cellCount > 1 && (
          <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
            预计约 {Math.round(cellCount * 140 / 60)} 分钟（{cellCount} 格 × ~140 秒），可先用「⟳ 生成此表情」试单格
          </div>
        )}
      </div>
    </div>
  );
}
