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
import { styleTemplateOf } from './comfyHost/builtinWorkflows/emojiWorkflows.js';

export interface EmojiStageCell {
  prompt: string;
  seed: number;
}

export interface StatEmojiStageInit {
  rows: number;
  cols: number;
  /** 全局 prompt（所有格子默认值） */
  prompt: string;
  /** 主题预设（作为 prompt 后缀注入），缺省 'Q版'。 */
  stylePreset?: string;
  /** 每格独立状态，JSON 字符串（数组 [{prompt, seed}]） */
  cells: string;
  selectedIndex: number;
  /** 当前 workflow 模板名（静态贴纸，一般不切换）。 */
  workflow?: string;
}

export interface StatEmojiStageEditorProps {
  initial: StatEmojiStageInit;
  /** 每格已生成图 ref（可选，按 cell index 对齐；空则显示占位）。 */
  cellRefs?: Array<string | { ref: string; caption?: string; kind?: 'image' | 'video' } | undefined>;
  /** 可选 workflow 模板名列表（`workflowOptionsFor('emoji')`）。 */
  workflowOptions?: string[];
  /** 可选主题预设列表（缺省用内置 STYLE_PRESETS）。 */
  styleOptions?: string[];
  onCommit: (patch: Record<string, unknown>) => void;
  /** 触发运行（cellIndex 传入 = 只重生成该格）。 */
  onRunRequest?: (cellIndex?: number) => void;
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

export function StatEmojiStageEditor({
  initial, cellRefs, workflowOptions, styleOptions, onCommit, onRunRequest, mentionCandidates, onPinAsset,
}: StatEmojiStageEditorProps): React.ReactElement {
  const [rows, setRows] = React.useState<number>(Math.max(1, Math.min(6, initial.rows || 3)));
  const [cols, setCols] = React.useState<number>(Math.max(1, Math.min(6, initial.cols || 3)));
  const [stylePreset, setStylePreset] = React.useState<string>(
    initial.stylePreset ?? (styleOptions?.[0] ?? STYLE_PRESETS[0]));
  const [selectedIndex, setSelectedIndex] = React.useState<number>(initial.selectedIndex ?? 0);

  const presets = styleOptions && styleOptions.length > 0 ? styleOptions : STYLE_PRESETS;
  const workflow = initial.workflow && workflowOptions && workflowOptions.length > 0
    ? initial.workflow
    : (workflowOptions?.[0] ?? '');

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
    };
    // workflow 仅在本编辑器真的提供了选项时才写回，避免在无选项场景把
    // node.properties.workflow 覆写成空串（会让 runStageWorkflow 落回默认模板）。
    if (workflowOptions && workflowOptions.length > 0 && workflow) { patch.workflow = workflow; }
    onCommit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, stylePreset, selectedIndex, cells, workflow]);

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
            <button
              onClick={() => { onRunRequest(selectedIndex); }}
              style={{ ...btn(false), background: 'linear-gradient(180deg,#d05ee0,#b44cc4)', borderColor: 'transparent', color: '#fff', fontWeight: 600 }}
            >
              ⟳ 生成此表情
            </button>
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
