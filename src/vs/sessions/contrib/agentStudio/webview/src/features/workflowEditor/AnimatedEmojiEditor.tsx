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
  /** m×n 网格切分：1×1 = 单表情（整图模式）；>1 = 输入拼贴图逐帧切格。 */
  gridRows: number;
  gridCols: number;
  /** 切格内缩比例（0-0.2，吸收邻格渗入/全局抖动）。 */
  gridMargin: number;
  chromaColor: string;
  chromaSimilarity: number;
  chromaSmoothness: number;
  /** ★ 绿幕抠像开关（默认 true）：非透明背景图像（照片/带底插画）关闭后
   *  不合成绿底、抠像容差归零，产出保留原背景的逐格 GIF。 */
  chromaEnable?: boolean;
}

export interface AnimatedEmojiEditorProps {
  initial: AnimatedEmojiInit;
  /** 已生成的绿幕视频 / GIF 引用（预览；kind='video' 为抠像前绿幕原片）。 */
  cellRefs?: Array<{ ref: string; kind?: 'image' | 'video' } | undefined>;
  /** 上游输入的参考图/图集（静态表情包 image 口整版图等）——图集预览展示对象。
   *  注意区别于 sheetRef（本节点输出的整版图，供「调整裁剪」recrop 使用）。 */
  inputSheetRef?: string;
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

const selectStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, height: 24, fontSize: 10, padding: '0 4px',
  background: '#17181c', color: 'var(--vscode-foreground, #e8e8e8)',
  border: '1px solid rgba(255,255,255,.14)', borderRadius: 4,
};

export function AnimatedEmojiEditor({
  initial, cellRefs, inputSheetRef, sheetGrid, workflowOptions, upstreamCount, onCommit, onRunRequest, running, onCancelRequest,
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
  const [maxKb, setMaxKb] = React.useState<number>(initial.max_kb || 100);
  const [gridRows, setGridRows] = React.useState<number>(initial.gridRows || 1);
  const [gridCols, setGridCols] = React.useState<number>(initial.gridCols || 1);
  const [gridMargin, setGridMargin] = React.useState<number>(
    typeof initial.gridMargin === 'number' ? initial.gridMargin : 0.1);
  const [chromaColor, setChromaColor] = React.useState<string>(initial.chromaColor || '#00FF00');
  // ★ 绿幕抠像开关：关闭 = 支持非透明背景图像（不合成绿底、产出带原背景 GIF）
  const [chromaEnable, setChromaEnable] = React.useState<boolean>(initial.chromaEnable !== false);
  const [chromaSimilarity, setChromaSimilarity] = React.useState<number>(
    typeof initial.chromaSimilarity === 'number' ? initial.chromaSimilarity : 0.4);
  const [chromaSmoothness, setChromaSmoothness] = React.useState<number>(
    typeof initial.chromaSmoothness === 'number' ? initial.chromaSmoothness : 0.1);
  // 参数页签（2026-09-02）：GIF 输出 / 网格切分 / 绿幕抠像 三页切换。
  const [tab, setTab] = React.useState<'gif' | 'grid' | 'chroma'>('gif');
  // ★ 图集预览模式（2026-09-03）：生成成功后默认显示「逐格 GIF 拼贴动图」
  //   （9 张 GIF 按 rows×cols 拼回图集位置同步循环 = 图集动图效果）；可切回
  //   静帧（调 margin/网格时看静态对齐更清楚）。
  const [animPreview, setAnimPreview] = React.useState<boolean>(true);
  /** 本节点产出的逐格 GIF refs（行主序，与 grid 切分顺序一致；排除绿幕原片）。 */
  const gridGifRefs = React.useMemo(
    () => (cellRefs ?? []).flatMap(c => (c && c.kind !== 'video' ? [c.ref] : [])),
    [cellRefs],
  );

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
      grid_rows: gridRows,
      grid_cols: gridCols,
      grid_margin: gridMargin,
      chroma_color: chromaColor,
      chroma_enable: chromaEnable,
      chroma_similarity: chromaSimilarity,
      chroma_smoothness: chromaSmoothness,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, workflow, seed, providerId, modelId, durationS, fps, maxKb, gridRows, gridCols, gridMargin, chromaEnable, chromaColor, chromaSimilarity, chromaSmoothness]);

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

  const previewVideo = cellRefs?.find(m => m?.kind === 'video');
  const previewGif = cellRefs?.find(m => m && m.kind !== 'video');
  /** 预览图集的真实像素比例（onLoad 记录）——网格叠加层与图像区 1:1 对齐用。 */
  const [sheetNatural, setSheetNatural] = React.useState<{ w: number; h: number } | null>(null);

  // ── 图集预览（2026-09-02）：上游参考图/图集 + 拆分网格叠加，参数实时生效。
  // 生效行列 = 用户显式设置（>1）> 上游图集 meta（sheetGrid）> 1×1；
  // ★ 装不下自动扩：与执行器 runAnimatedEmoji 的行列决策**严格一致**——
  //   显式 grid 的 rows*cols 装不下 upstreamCount 张时，执行器会按张数近似
  //   方形重算（cols=ceil(sqrt(n))，rows=ceil(n/cols)，上限 6）。预览若不
  //   同步扩，网格叠加仍按旧行列 → 格子与图集内容错位（「网格切分不正确」）。
  let effRows = gridRows > 1 ? gridRows : (sheetGrid?.rows ?? 1);
  let effCols = gridCols > 1 ? gridCols : (sheetGrid?.cols ?? 1);
  // ★ 生效 margin：消费上游图集时**跟随图集 meta**（图集 gap 是拼装时的既成
  //   事实——静态节点 image 口恒 margin=0 无缝等分；slider 默认 0.03 若强行
  //   用于切分，每格内缩 3% 且越往右/下累积偏移 = 「图集切分不正确」）。
  //   slider 仅在「执行时自动拼贴独立格」场景生效（upstreamSheetRef 为空）。
  const effMargin = inputSheetRef && sheetGrid?.margin !== undefined ? sheetGrid.margin : gridMargin;
  const nUp = upstreamCount ?? 0;
  if (nUp > 1 && effRows * effCols < nUp) {
    effCols = Math.min(6, Math.ceil(Math.sqrt(nUp)));
    effRows = Math.min(6, Math.ceil(nUp / effCols));
  }
  const effGrid = effRows > 1 || effCols > 1;
  // 网格几何（对齐执行器拼贴：gap=margin×cell，cell 归一化 1，近似 cellW≈cellH）：
  // T = cols + (cols+1)*margin；第 i 格内容区 x = (margin + i*(1+margin)) / T，宽 1/T。
  const gridT = Math.max(0.0001, effCols + (effCols + 1) * effMargin);
  // 纵向 margin 以 cellH 为基准（执行器 gap 统一用 margin×cellW；表情贴纸
  // cellW≈cellH，此处近似同比例——预览误差可忽略）。
  const gridTh = Math.max(0.0001, effRows + (effRows + 1) * effMargin);
  const cells: Array<{ x: number; y: number; w: number; h: number; n: number; ix: number; iy: number; iw: number; ih: number }> = [];
  if (effGrid && inputSheetRef) {
    // ★ 内缩（gridMargin slider）＝执行器切格的实际裁切范围（吸收邻格渗入），
    //   预览中以内缩框可视化——slider 拖动即见 GIF 内容边界变化。
    const inset = Math.max(0, Math.min(0.45, gridMargin));
    for (let r = 0; r < effRows; r++) {
      for (let c = 0; c < effCols; c++) {
        const x = (effMargin + c * (1 + effMargin)) / gridT;
        const y = (effMargin + r * (1 + effMargin)) / gridTh;
        const w = 1 / gridT;
        const h = 1 / gridTh;
        cells.push({
          x, y, w, h, n: r * effCols + c + 1,
          ix: x + w * inset, iy: y + h * inset, iw: w * (1 - inset * 2), ih: h * (1 - inset * 2),
        });
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 绿幕原片预览（诊断用：抠像效果差时回看是生成问题还是抠像问题） */}
      {previewVideo?.ref && (
        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.12)', background: '#000' }}>
          <video src={previewVideo.ref} muted loop autoPlay playsInline controls
            style={{ display: 'block', width: '100%', maxHeight: 200, objectFit: 'contain' }} />
        </div>
      )}

      {/* 透明 GIF 预览（棋盘格底） */}
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
          <img src={previewGif.ref} alt="animated-emoji" style={{ display: 'block', width: '100%', maxHeight: 200, objectFit: 'contain' }} />
        </div>
      )}

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

      {/* 参数页签（2026-09-02）：GIF 输出 / 网格切分 / 绿幕抠像 三页切换 */}
      <div style={{ border: '1px solid rgba(168,85,247,.28)', borderRadius: 8, background: 'rgba(168,85,247,.05)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(168,85,247,.28)' }}>
          {([
            { id: 'gif', label: '🎞 GIF 输出' },
            { id: 'grid', label: '✂️ 网格切分' },
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', fontFamily: 'monospace' }}>单格 240×240 · 循环 · 共 {gridRows * gridCols} 张</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {stepper('时长 秒', durationS, 2, 5, 1, setDurationS)}
                {stepper('帧率 fps', fps, 6, 15, 1, setFps)}
                {stepper('单图上限 KB', maxKb, 100, 2000, 50, setMaxKb)}
              </div>
              {maxKb > 100 && (
                <div style={{ fontSize: 9, color: '#fbbf24' }}>
                  ⚠ 当前单图上限 {maxKb}KB 超过微信主图规范 100KB——按规范上传请调回 ≤100
                </div>
              )}
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
                上限针对**单个 GIF**（每格各自 ≤上限，不是图集总量）：超限自动降级
                （色数→帧率→尺寸，尺寸不降保 240×240）。微信规范：主图 GIF 240×240
                ≤100KB；每格自动附带缩略图 PNG 240×240 ≤60KB（随条目 meta.thumb）
              </div>
            </>
          )}
          {tab === 'grid' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ marginLeft: 'auto', fontSize: 9, fontFamily: 'monospace', color: (gridRows > 1 || gridCols > 1) ? '#c084fc' : 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
                  {gridRows * gridCols > 1 ? `${gridRows}×${gridCols} → ${gridRows * gridCols} 个 GIF` : '单表情'}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {([
                  { label: '1×1 单表情', r: 1, c: 1 },
                  { label: '2×2', r: 2, c: 2 },
                  { label: '3×3', r: 3, c: 3 },
                  { label: '2×3', r: 2, c: 3 },
                  { label: '3×2', r: 3, c: 2 },
                ] as const).map(p => (
                  <button key={p.label} style={btn(gridRows === p.r && gridCols === p.c)}
                    onClick={() => { setGridRows(p.r); setGridCols(p.c); }}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                {stepper('行', gridRows, 1, 6, 1, setGridRows)}
                {stepper('列', gridCols, 1, 6, 1, setGridCols)}
                {stepper('边距', Math.round(gridMargin * 100) / 100, 0, 0.2, 0.01, (v) => setGridMargin(Math.max(0, Math.min(0.2, v))))}
              </div>
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.5 }}>
                输入 m×n <b>等分拼贴</b>贴纸图，整图一次生成动图后逐帧切格（1 次视频调用出全部表情，画风天然统一）。
                边距=拼贴隔离带+切格内缩（双重防串格）：模型动图元素（泪滴/星星/肢体）
                越过格边界时会落在隔离带上被绿幕抠掉。默认 0.1；仍串格再调大，主体被裁则调小。
              </div>
            </>
          )}
          {tab === 'chroma' && (
            <>
              {/* ★ 抠像开关（默认开）：非透明背景图像（照片/带底插画）关闭后
                  不合成绿底、不抠像，产出保留原背景的逐格 GIF。 */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={chromaEnable}
                  onChange={(e) => setChromaEnable(e.target.checked)}
                  style={{ accentColor: '#8a3fd0' }}
                />
                <span style={{ fontSize: 10, color: 'var(--vscode-foreground, #e8e8e8)' }}>启用绿幕抠像（透明背景图像）</span>
              </label>
              {!chromaEnable && (
                <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)', lineHeight: 1.6 }}>
                  已关闭：适用于**非透明背景**的图像（照片/带底插画）——直接保留原背景
                  生成动图，不做绿幕合成与抠像，产出带背景的逐格 GIF。
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: chromaEnable ? 1 : 0.4, pointerEvents: chromaEnable ? 'auto' : 'none' }}>
                <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground, #9a9a9a)', whiteSpace: 'nowrap' }}>绿幕色</span>
                <input type="color" value={chromaColor} onChange={(e) => setChromaColor(e.target.value)}
                  style={{ width: 28, height: 22, padding: 0, border: '1px solid rgba(255,255,255,.14)', borderRadius: 4, background: 'transparent' }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--vscode-foreground, #e8e8e8)' }}>{chromaColor}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, opacity: chromaEnable ? 1 : 0.4, pointerEvents: chromaEnable ? 'auto' : 'none' }}>
                {stepper('相似度', Math.round(chromaSimilarity * 100) / 100, 0.05, 1, 0.05, (v) => setChromaSimilarity(Math.max(0.05, Math.min(1, v))))}
                {stepper('去绿边', Math.round(chromaSmoothness * 100) / 100, 0, 1, 0.05, (v) => setChromaSmoothness(Math.max(0, Math.min(1, v))))}
              </div>
              <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
                相似度越高抠得越干净（误伤风险↑）；去绿边控制主体边缘 despill 带宽；默认 0.4 / 0.1
              </div>
            </>
          )}
        </div>
      </div>

      {/* 图集预览：上游参考图/图集 + 拆分网格叠加（行列/间距参数实时生效，位于参数页签下方） */}
      {inputSheetRef && (
        <div style={{
          borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,.12)',
          position: 'relative',
          // ★ 容器宽高比 = 图像真实比例（onLoad 读 natural 尺寸）：此前 img 用
          //   objectFit:'contain' + maxHeight，图像在元素盒内 letterbox——SVG
          //   网格/编号却按**容器**百分比定位 → 分割线与原图错位（「分割背景
          //   大小与原图大小不匹配」）。容器比例锁定后 fill 绘制无变形、
          //   叠加层与图像像素区 1:1 重合；未加载前退回 100% 宽。
          width: sheetNatural ? 'auto' : '100%',
          aspectRatio: sheetNatural ? `${sheetNatural.w} / ${sheetNatural.h}` : undefined,
          maxHeight: 220,
          margin: '0 auto',
          backgroundImage:
            'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
            'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
            'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
            'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
          backgroundSize: '12px 12px',
          backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
          backgroundColor: '#232428',
        }}>
          {/* ★ 绿幕合成预演：执行时第一步就是把图集合成为 chromaColor 底再喂视频
              模型——透明区直接显示绿幕色，调色即见「模型的输入长什么样」。
              抠像关闭（非透明背景模式）/动图模式时不预演绿底。 */}
          {chromaEnable && !animPreview && (
            <div style={{ position: 'absolute', inset: 0, background: chromaColor, opacity: 0.92, pointerEvents: 'none' }} />
          )}
          {/* 静帧（恒渲染：撑起容器 aspectRatio + 静帧模式显示；动图模式被
              GIF 拼贴层覆盖）。onLoad 读 natural 比例供容器锁定。 */}
          <img
            src={inputSheetRef}
            alt="sheet-preview"
            onLoad={(e) => {
              const im = e.currentTarget;
              setSheetNatural({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
            }}
            style={{ display: 'block', width: '100%', height: '100%', position: 'relative' }}
          />
          {/* ★ 动图模式（生成成功后默认）：逐格 GIF 按切分顺序拼回图集位置，
              同步循环播放 = 整版图集的动图效果（GIF 本就切自图集，拼回即无缝
              覆盖原位）。网格叠加坐标系不变，两模式都精确对齐。 */}
          {animPreview && gridGifRefs.length > 0 && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'grid',
              gridTemplateColumns: `repeat(${effCols}, 1fr)`,
              gridTemplateRows: `repeat(${effRows}, 1fr)`,
            }}>
              {Array.from({ length: effRows * effCols }).map((_, i) => (
                <div key={i} style={{ overflow: 'hidden' }}>
                  {gridGifRefs[i]
                    ? <img src={gridGifRefs[i]} alt={`cell-${i + 1}`} style={{ display: 'block', width: '100%', height: '100%' }} />
                    : null}
                </div>
              ))}
            </div>
          )}
          {effGrid && cells.length > 0 && (
            <>
              <svg
                viewBox="0 0 1 1" preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                {/* 外框（紫虚线）＝等分格区域；内框（青实线）＝边距内缩后的
                    实际 GIF 裁切范围——「边距」slider 拖动即见。 */}
                {cells.map(c => (
                  <rect
                    key={c.n}
                    x={c.x} y={c.y} width={c.w} height={c.h} fill="none"
                    stroke="rgba(168,85,247,.85)" strokeWidth={0.003}
                    strokeDasharray="0.012 0.008"
                  />
                ))}
                {cells.map(c => (
                  <rect
                    key={`i${c.n}`}
                    x={c.ix} y={c.iy} width={c.iw} height={c.ih} fill="none"
                    stroke="rgba(34,211,238,.9)" strokeWidth={0.0025}
                  />
                ))}
              </svg>
              {cells.map(c => (
                <div
                  key={`n${c.n}`}
                  style={{
                    position: 'absolute',
                    left: `${c.x * 100}%`, top: `${c.y * 100}%`,
                    width: `${c.w * 100}%`, height: `${c.h * 100}%`,
                    display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start',
                    pointerEvents: 'none',
                  }}
                >
                  <span style={{
                    fontSize: 8, lineHeight: 1, color: '#e9d5ff', background: 'rgba(88,28,135,.55)',
                    borderRadius: 3, padding: '1px 3px', margin: 2, fontFamily: 'monospace',
                  }}>{c.n}</span>
                </div>
              ))}
            </>
          )}
          {/* 动图/静帧切换（有逐格 GIF 时显示；默认动图） */}
          {gridGifRefs.length > 0 && (
            <button
              onClick={() => setAnimPreview(v => !v)}
              title={animPreview ? '切换为静帧（便于查看网格对齐）' : '切换为动图（图集动图效果）'}
              style={{
                position: 'absolute', top: 6, right: 6, zIndex: 5,
                padding: '2px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 9, fontWeight: 600,
                fontFamily: 'inherit', border: '1px solid rgba(233,213,255,.45)',
                background: 'rgba(20,10,30,.72)', color: '#e9d5ff',
              }}
            >
              {animPreview ? '🎬 动图' : '🖼 静帧'}
            </button>
          )}
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            fontSize: 9, color: '#e9d5ff', background: 'rgba(20,10,30,.72)',
            padding: '3px 8px', fontFamily: 'monospace',
          }}>
            {upstreamCount && upstreamCount > 1
              ? `输入 ${upstreamCount} 张 → 执行时自动拼贴 ${effRows}×${effCols} 图集（紫框=格子 · 青框=边距内缩后 GIF 范围）`
              : effGrid
                ? `图集预览 · 拆分 ${effRows}×${effCols} · 底色=绿幕合成 · 紫框=格子 · 青框=内缩后 GIF 范围`
                : '图集预览 · 单表情模式'}
          </div>
        </div>
      )}

      {/* 运行按钮（running → 取消，与卡片取消同链路 wf-node-abort） */}
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
            onClick={() => onRunRequest()}
            style={{
              padding: '7px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600,
              border: 'none', color: '#fff', background: 'linear-gradient(180deg,#a855f7,#8b3fd0)',
            }}
          >
            ▶ 生成动态表情（视频模型 → 抠像 → GIF）
          </button>
        )
      )}
    </div>
  );
}
