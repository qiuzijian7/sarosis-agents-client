/**
 * DynEmojiStageEditor — ComfyTV DynEmojiStage（动态表情包）的内嵌编辑器。
 *
 * 流水线：参考图 → MiniMax H3 绿幕视频 → 前端 chroma-key 抠图 → 透明 GIF。
 *
 * 与静态节点不同，动态节点不再做 m×n 网格（视频生成代价高），而是单参考图驱动：
 *   - 参考图（上游 image 输入 / 直接粘贴 / 上传）；
 *   - 全局 prompt（动作/风格描述）；
 *   - 视频参数（时长、绿幕色、抠图容差/平滑度）；
 *   - 触发运行 → workflowRun.runEmojiStageGrid 走 emoji-dyn 流水线生成绿幕 mp4，
 *     再经「视频转 GIF」节点抠图成透明 GIF。
 *
 * 数据流（对齐 onCommit 约定）：
 *   prompt / duration_s / chroma_color / chroma_similarity / chroma_smoothness
 */
import * as React from 'react';
import { MentionTextarea, type MentionCandidate } from './comfyHost/MentionTextarea';

export interface DynEmojiStageInit {
  /** 动作/风格 prompt（驱动绿幕视频生成）。 */
  prompt: string;
  /** 绿幕视频时长（秒，MiniMax H3 驱动帧数；fps 固定 24）。 */
  duration_s: number;
  /** 绿幕色（chroma-key 抠图用），默认纯绿 #00FF00。 */
  chromaColor: string;
  /** 相似度（前端抠图容差，0-1）。 */
  chromaSimilarity: number;
  /** 平滑度（前端抠图边缘羽化，0-1）。 */
  chromaSmoothness: number;
  /** 当前 workflow 模板名（emoji-dyn 流水线）。 */
  workflow?: string;
}

export interface DynEmojiStageEditorProps {
  initial: DynEmojiStageInit;
  /** 已生成的绿幕视频 / 抠图 GIF 引用（用于预览）。 */
  cellRefs?: Array<{ ref: string; kind?: 'image' | 'video'; caption?: string } | undefined>;
  /** 可选 workflow 模板名列表（`workflowOptionsFor('emoji-dyn')`）。 */
  workflowOptions?: string[];
  onCommit: (patch: Record<string, unknown>) => void;
  /** 触发运行（生成绿幕视频 + GIF）。 */
  onRunRequest?: () => void;
  /** @ 提及候选（节点 + 文件），由 NodeCard 注入。 */
  mentionCandidates?: MentionCandidate[];
  /** @ 选中文件时钉成资产引用。 */
  onPinAsset?: (c: MentionCandidate) => void;
}

/**
 * 动作词快捷面板（点击把视觉动词描述插入 prompt）。对齐 MiniMax-AI/skills
 * `gif-sticker-maker`（MIT）的 Action reference（hi/laugh/cry/love 等）。
 */
const EMOJI_ACTION_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: '👋 挥手', prompt: 'waving hand cheerfully, slight head tilt' },
  { label: '😂 大笑', prompt: 'shaking with laughter, eyes squinting shut' },
  { label: '😭 大哭', prompt: 'tears streaming down, body trembling gently' },
  { label: '💗 比心', prompt: 'making a heart gesture with both hands, eyes sparkling' },
  { label: '😳 害羞', prompt: 'blushing, looking away shyly, fingers fidgeting' },
  { label: '😠 生气', prompt: 'puffing cheeks, angry brows, steam from ears' },
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

function ActionChips({ onPick }: { onPick: (text: string) => void }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {EMOJI_ACTION_CHIPS.map((c) => (
        <button key={c.label} title={c.prompt} onClick={() => onPick(c.prompt)} style={chipStyle}>
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
  background: active ? 'rgba(192,132,252,.22)' : 'rgba(255,255,255,.05)',
  color: active ? '#d8b4fe' : 'var(--vscode-foreground, #e8e8e8)',
});

export function DynEmojiStageEditor({
  initial, cellRefs, workflowOptions, onCommit, onRunRequest, mentionCandidates, onPinAsset,
}: DynEmojiStageEditorProps): React.ReactElement {
  const [prompt, setPrompt] = React.useState<string>(initial.prompt || '');
  const [durationS, setDurationS] = React.useState<number>(initial.duration_s || 3);
  const [chromaColor, setChromaColor] = React.useState<string>(initial.chromaColor || '#00FF00');
  const [chromaSimilarity, setChromaSimilarity] = React.useState<number>(
    typeof initial.chromaSimilarity === 'number' ? initial.chromaSimilarity : 0.4);
  const [chromaSmoothness, setChromaSmoothness] = React.useState<number>(
    typeof initial.chromaSmoothness === 'number' ? initial.chromaSmoothness : 0.1);

  const workflow = initial.workflow && workflowOptions && workflowOptions.length > 0
    ? initial.workflow
    : (workflowOptions?.[0] ?? '');

  // 参数变化 → 写回 node.properties（workflowRun.runEmojiStageGrid 消费）。
  React.useEffect(() => {
    const patch: Record<string, unknown> = {
      prompt,
      duration_s: durationS,
      chroma_color: chromaColor,
      chroma_similarity: chromaSimilarity,
      chroma_smoothness: chromaSmoothness,
    };
    if (workflowOptions && workflowOptions.length > 0 && workflow) { patch.workflow = workflow; }
    onCommit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, durationS, chromaColor, chromaSimilarity, chromaSmoothness, workflow]);

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

  const previewVideo = cellRefs?.find(m => m?.kind === 'video');
  const previewGif = cellRefs?.find(m => m?.kind !== 'video');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 流水线说明 */}
      <div style={{
        fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.5,
        border: '1px solid rgba(192,132,252,.28)', borderRadius: 8, padding: '6px 8px',
        background: 'rgba(192,132,252,.06)',
      }}>
        参考图 → MiniMax H3 绿幕视频 → 前端抠图 → 透明 GIF
      </div>

      {/* 绿幕视频预览 */}
      {previewVideo?.ref && (
        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.12)', background: '#000' }}>
          <video src={previewVideo.ref} muted loop autoPlay playsInline controls
            style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain' }} />
        </div>
      )}

      {/* 抠图 GIF 预览（透明底棋盘格） */}
      {previewGif?.ref && (
        <div style={{
          borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.12)',
          backgroundImage:
            'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
            'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
            'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
            'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
          backgroundSize: '12px 12px',
          backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
          backgroundColor: '#232428',
        }}>
          <img src={previewGif.ref} alt="emoji-gif" style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'contain' }} />
        </div>
      )}

      {/* 全局 prompt + 动作 */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>动作 / 风格 prompt</div>
        <MentionTextarea
          value={prompt}
          onChange={setPrompt}
          candidates={mentionCandidates ?? []}
          onPinAsset={onPinAsset}
          placeholder="卡通角色做动作，绿幕背景，循环动画（输入 @ 引用节点或选择文件）"
          style={{
            minHeight: 40, background: '#17181c', border: '1px solid rgba(255,255,255,.1)',
            borderRadius: 6, fontSize: 11, padding: 6, lineHeight: 1.5, maxHeight: 120,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>动作（点击插入到 prompt）</span>
          <ActionChips onPick={(t) => setPrompt(prev => appendToPrompt(prev, t))} />
        </div>
      </div>

      {/* 视频参数（时长） */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        border: '1px solid rgba(192,132,252,.28)', borderRadius: 8, padding: 8,
        background: 'rgba(192,132,252,.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: '#c084fc' }}>🎬 视频参数</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', fontFamily: 'monospace' }}>24 fps</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {stepper('时长 秒', durationS, 2, 15, setDurationS)}
        </div>
        <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
          MiniMax H3 生成绿幕 mp4（较慢，约 2-4 分钟）；再经「视频转 GIF」节点抠图成透明 GIF
        </div>
      </div>

      {/* 绿幕抠图参数 */}
      <div style={{ border: '1px solid rgba(255,255,255,.1)', borderRadius: 8, padding: 8, background: '#25272e', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>🟢 绿幕抠图</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>绿幕色</span>
          <input type="color" value={chromaColor} onChange={(e) => setChromaColor(e.target.value)}
            style={{ width: 28, height: 22, padding: 0, border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, background: 'transparent' }} />
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--vscode-foreground, #e8e8e8)' }}>{chromaColor}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {stepper('相似度', Math.round(chromaSimilarity * 100) / 100, 0, 1, (v) => setChromaSimilarity(Math.max(0, Math.min(1, v))))}
          {stepper('平滑度', Math.round(chromaSmoothness * 100) / 100, 0, 1, (v) => setChromaSmoothness(Math.max(0, Math.min(1, v))))}
        </div>
        <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
          相似度越高抠得越干净（边缘易硬），平滑度控制羽化；默认 0.4 / 0.1 适配纯绿 #00FF00
        </div>
      </div>

      {/* 运行按钮 */}
      {onRunRequest && (
        <button
          onClick={() => onRunRequest()}
          style={{
            padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
            border: 'none', color: '#fff', background: 'linear-gradient(180deg,#a855f7,#8b3fd0)',
          }}
        >
          ▶ 生成动态表情（绿幕视频 → GIF）
        </button>
      )}
    </div>
  );
}
