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
 *  - 全局 prompt + fps/frames + 「生成全部」。
 *
 * 数据流（对齐 GridSplitEditor 的 onCommit 约定）：
 *   rows / cols / fps / frames / prompt / selected_index / cells
 * cells 是 JSON 字符串（数组 [{prompt, seed}]），长度 = rows*cols，由本组件
 * 负责序列化/反序列化；onCommit 以 patch 形式写回（nodeCard → wf-node-control）。
 */
import * as React from 'react';
import { MentionTextarea, type MentionCandidate } from './comfyHost/MentionTextarea';

export interface EmojiStageCell {
  prompt: string;
  seed: number;
  /** 配文：生成后叠加到贴纸底部居中（静态贴纸烘焙进图；动画贴纸预览层 CSS 叠字）。 */
  text: string;
}

export interface EmojiStageInit {
  rows: number;
  cols: number;
  fps: number;
  frames: number;
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
   * - `caption`：归档时写进 `media.meta.caption` 的配文（见 workflowRun.ts）。
   *   动画图不做 Canvas 烘焙（保动画），配文只存在于 meta；预览层优先读
   *   `caption` 以保证「图与描述一致」——即使重启后 `cells` 内存态丢失也能显示。
   * 兼容旧 `string[]` 传法（无 caption 时回退到编辑器 `c.text`）。
   */
  cellRefs?: Array<string | { ref: string; caption?: string } | undefined>;
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
  /** 触发运行（cellIndex 传入 = 只重生成该格；不传 = 生成全部）。 */
  onRunRequest?: (cellIndex?: number) => void;
  /** @ 提及候选（节点 + 文件），由 NodeCard 注入；缺省时输入框仍可用但无 @ 面板。 */
  mentionCandidates?: MentionCandidate[];
  /** @ 选中文件时钉成资产引用。 */
  onPinAsset?: (c: MentionCandidate) => void;
  }

/**
 * 模板名是否为动态（AnimateDiff）。
 *
 * 用名字判定而非维护一张映射表：模板名来自 `EMOJI_BUILTIN_WORKFLOWS` 的键
 * （见 `builtinWorkflows/emojiWorkflows.ts`），新增动态模板时只要名字带「动态」
 * 或 AnimateDiff 就会被自动识别，不需要改这里。
 */
function isAnimatedWorkflow(label: string | undefined): boolean {
  return !!label && (label.includes('动态') || /animatediff/i.test(label));
}

const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×2', rows: 3, cols: 2 },
];

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
  const empty: EmojiStageCell[] = Array.from({ length: count }, () => ({ prompt: '', seed: 0, text: '' }));
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
        text: typeof it?.text === 'string' ? it.text : '',
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
  const [fps, setFps] = React.useState<number>(initial.fps || 8);
  const [frames, setFrames] = React.useState<number>(initial.frames || 16);
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
        prev[i] ?? { prompt: '', seed: 0, text: '' });
      return next;
    });
    if (selectedIndex > cellCount - 1) { setSelectedIndex(cellCount - 1); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellCount]);

  // 任何参数变化 → 序列化 cells 写回（保持 node.properties 与 UI 同步）。
  React.useEffect(() => {
    const patch: Record<string, unknown> = {
      rows, cols, fps, frames,
      prompt: globalPrompt,
      selected_index: selectedIndex,
      cells: JSON.stringify(cells),
    };
    // workflow 仅在本编辑器真的提供了选项时才写回，避免在无选项场景把
    // node.properties.workflow 覆写成空串（会让 runStageWorkflow 落回默认模板）。
    if (workflowOptions && workflowOptions.length > 0 && workflow) { patch.workflow = workflow; }
    onCommit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, fps, frames, globalPrompt, selectedIndex, cells, workflow]);

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
      {/* 动态开关 + 静态模板下拉。
          必须画在这里 —— nodeCard 通用控件网格对有内嵌编辑器的 stage 整体不渲染
          （`!hasInlineEditor` 门禁），widget 里的 workflow 下拉永远不可见。 */}
      {workflowOptions && workflowOptions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            onClick={() => { if (canAnimate) { setAnimated(v => !v); } }}
            title={canAnimate
              ? (animated
                ? `动态表情：AnimateDiff 生成 ${frames} 帧透明循环 webp（较慢，约 2 分钟/格）`
                : '静态贴纸：单张透明 PNG（约 45 秒/格）')
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
              {animated ? `${frames} 帧 · ${fps} fps` : '单张 PNG'}
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
              {ref ? (
                <img src={ref} alt={`cell-${i}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              ) : (
                <span style={{ color: '#6b6b6b', fontSize: 18 }}>＋</span>
              )}
              {/* 配文预览层：动画贴纸不烘焙（保动画），用 CSS 叠字；静态贴纸烘焙进图，此处一致显示。
                  优先读归档 caption（meta.caption，重启不丢且与导出/分享一致），回退编辑器内存态 c.text。 */}
              {(caption ?? c.text) ? (
                <span style={{
                  position: 'absolute', left: 5, right: 5, bottom: 6,
                  textAlign: 'center', fontSize: 11, fontWeight: 700,
                  color: '#fff', lineHeight: 1.3, pointerEvents: 'none',
                  textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 3px rgba(0,0,0,.75)',
                  overflowWrap: 'anywhere',
                }}>{c.text}</span>
              ) : null}
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
        <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>配文（叠加到贴纸底部居中，支持换行）</div>
        <textarea
          value={selCell?.text ?? ''}
          onChange={(e) => setCell(selectedIndex, { text: e.target.value })}
          placeholder="例如：哈哈哈"
          rows={2}
          style={{
            background: '#17181c', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 6, fontSize: 11, padding: 6, lineHeight: 1.5, resize: 'vertical',
            color: 'var(--vscode-foreground, #e8e8e8)', fontFamily: 'inherit', maxHeight: 96,
          }}
        />
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

      {/* 全局 prompt + 生成全部 */}
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
        {/* 帧率/帧数**仅动态模板消费**（绑定到 SaveAnimatedWEBP.fps 与
            EmptyLatentImage.batch_size，见 emojiWorkflows.ts 的 inputs 声明）。
            静态模式下直接不渲染 —— 摆着不可用的控件本身就是误导来源：
            此前 workflow 下拉不可见 + 帧率/帧数常驻，用户一直以为在跑动态。 */}
        {animated && (
          <div
            title="帧率 → webp 播放速度；帧数 → 动画总帧数（帧数越大越慢）"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}
          >
            {stepper('帧率', fps, 1, 30, setFps)}
            {stepper('帧数', frames, 1, 32, setFrames)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onRunRequest && (
            <button
              onClick={() => { /* eslint-disable-next-line no-console */ console.warn(`[EmojiStage] click ▶ 生成全部 cellCount=${cellCount}`); onRunRequest(); }}
              style={{ ...btn(false), background: 'linear-gradient(180deg,#3b82f6,#2563eb)', borderColor: 'transparent', color: '#fff', fontWeight: 600, padding: '5px 12px' }}
            >
              ▶ 生成全部（{cellCount} 个）
            </button>
          )}
          <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)', fontFamily: 'monospace' }}>
            {MAX_CELLS >= cellCount ? `${cellCount} 格 · 选中 #${selectedIndex}` : '格数超限'}
          </span>
        </div>
        {/* 动态生成代价高（768² × frames，实测 ~140s/格），点之前先给出预估，
            避免用户以为卡死。系数取自 RTX 4070 实测：静态 ~45s、动态 ~140s。 */}
        {animated && cellCount > 1 && (
          <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
            预计约 {Math.round(cellCount * 140 / 60)} 分钟（{cellCount} 格 × ~140 秒），可先用「⟳ 生成此表情」试单格
          </div>
        )}
      </div>
    </div>
  );
}
