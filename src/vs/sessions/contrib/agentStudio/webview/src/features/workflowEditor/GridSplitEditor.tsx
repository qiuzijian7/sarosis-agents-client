/**
 * GridSplitEditor — 对齐 ComfyTV GridSplitStageCard 的内嵌网格编辑器（2026-09-01
 * 按 ComfyTV 参考样式重构：大预览占位 + 预设排 + 横向 ROWS/COLS/BORDER 步进排 +
 * OUTER BORDER 勾选排；选中格改为**点击预览单元格**，不再露出 Selected 步进器）。
 *
 * 交互组成：
 *  - 大预览（整卡宽，深底）：无上游图 → 居中网格图标 + "Connect an image to split"
 *    占位（预览内 + 下方小字说明）；有图 → 源图 + 分隔带 + 网格线 + 选中格高亮，
 *    点击单元格选中（写回 selected_index）；
 *  - 预设（1×2 / 2×1 / 2×2 / 2×3 / 3×3）一键设定 rows/cols（对齐 ComfyTV 预设集）；
 *  - ROWS / COLS / BORDER 紧凑步进组（横向一排，溢出横向滚动——对齐参考样式）；
 *  - OUTER BORDER 勾选排（整宽描边药丸）。
 *
 * 所有参数通过 onCommit 写回（nodeCard → wf-node-control）：
 *   rows / cols / border / outer_border / selected_index
 * 与 ComfyTV 一致，这些字段在后端 schema 中 hidden=True（由面板驱动）。
 */
import * as React from 'react';
import { loadCanvasImageWithProxy } from './canvasImageLoad';

export interface GridSplitInit {
  rows: number;
  cols: number;
  border: number;
  outerBorder: boolean;
  selectedIndex: number;
}

export interface GridSplitEditorProps {
  initial: GridSplitInit;
  imageRef?: string; // 上游图像 URL（用于可视化预览）
  onCommit: (patch: Partial<GridSplitInit>) => void;
}

/** 预设集（对齐 ComfyTV GridSplitStageCard：label = `cols×rows`）。 */
const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '1×2', rows: 2, cols: 1 },
  { label: '2×1', rows: 1, cols: 2 },
  { label: '2×2', rows: 2, cols: 2 },
  { label: '2×3', rows: 3, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
];

const VIEW_W = 300;
const MAX_VIEW_H = 320;
const PLACEHOLDER_H = 285;

/* ── 样式常量（对齐 ComfyTV 参考截图的深色卡片质感）────────────────────────── */
const PANEL_BG = '#17181c';
const PANEL_BORDER = '1px solid rgba(255,255,255,.12)';
const PREVIEW_BG = '#0b0c0e';
const DIM = '#8a8f98';
const ACCENT = '#4a9eff';

const miniBtn: React.CSSProperties = {
  width: 16, height: 16, lineHeight: '14px', padding: 0,
  borderRadius: 4, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
  border: 'none', background: 'rgba(255,255,255,.06)', color: 'var(--vscode-foreground)',
};

export function GridSplitEditor({ initial, imageRef, onCommit }: GridSplitEditorProps): React.ReactElement {
  const [rows, setRows] = React.useState<number>(Math.max(1, initial.rows || 2));
  const [cols, setCols] = React.useState<number>(Math.max(1, initial.cols || 2));
  const [border, setBorder] = React.useState<number>(initial.border ?? 0);
  const [outerBorder, setOuterBorder] = React.useState<boolean>(initial.outerBorder ?? false);
  const [selectedIndex, setSelectedIndex] = React.useState<number>(initial.selectedIndex ?? 1);
  const [imgReady, setImgReady] = React.useState<boolean>(false);
  const imgElRef = React.useRef<HTMLImageElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // 单元格总数驱动 selected_index 上限
  const cellCount = rows * cols;
  React.useEffect(() => {
    if (selectedIndex > cellCount - 1) {
      setSelectedIndex(cellCount - 1);
    }
  }, [cellCount, selectedIndex]);

  // 加载上游图像（直连失败自动回退 host 代理转 data URL，见 canvasImageLoad）
  React.useEffect(() => {
    setImgReady(false);
    if (!imageRef) { return; }
    let cancelled = false;
    loadCanvasImageWithProxy(imageRef).then((img) => {
      if (cancelled) { return; }
      imgElRef.current = img;
      setImgReady(!!img);
    });
    return () => { cancelled = true; };
  }, [imageRef]);

  const viewH = React.useMemo(() => {
    const img = imgElRef.current;
    if (imgReady && img && img.naturalWidth && img.naturalHeight) {
      const h = Math.round((VIEW_W * img.naturalHeight) / img.naturalWidth);
      return Math.max(120, Math.min(MAX_VIEW_H, h));
    }
    return PLACEHOLDER_H;
  }, [imgReady]);

  // 绘制网格预览（有图：源图 + 分隔带 + 网格线 + 选中格高亮；无图：纯深底，
  // 占位图标与文案由 HTML 覆盖层渲染——比 canvas 文本更贴近参考样式）。
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) { return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { return; }
    canvas.width = VIEW_W;
    canvas.height = viewH;
    ctx.clearRect(0, 0, VIEW_W, viewH);
    ctx.fillStyle = PREVIEW_BG;
    ctx.fillRect(0, 0, VIEW_W, viewH);

    const img = imgElRef.current;
    if (imgReady && img && img.naturalWidth) {
      // object-contain 居中绘制
      const scale = Math.min(VIEW_W / img.naturalWidth, viewH / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (VIEW_W - dw) / 2;
      const dy = (viewH - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);

      // 单元格分隔带（border 以源像素计，这里按预览比例缩放显示）
      const bw = border > 0 ? Math.max(1, (border * scale)) : 0;
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      if (outerBorder && bw > 0) {
        // 外缘边距
        ctx.fillRect(0, 0, VIEW_W, bw);
        ctx.fillRect(0, viewH - bw, VIEW_W, bw);
        ctx.fillRect(0, 0, bw, viewH);
        ctx.fillRect(VIEW_W - bw, 0, bw, viewH);
      }
      if (bw > 0) {
        for (let c = 1; c < cols; c++) {
          const x = dx + (dw * c) / cols - bw / 2;
          ctx.fillRect(x, dy, bw, dh);
        }
        for (let r = 1; r < rows; r++) {
          const y = dy + (dh * r) / rows - bw / 2;
          ctx.fillRect(dx, y, dw, bw);
        }
      }
      // 单元格分隔线（细）
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1;
      for (let c = 0; c <= cols; c++) {
        const x = dx + (dw * c) / cols;
        ctx.beginPath(); ctx.moveTo(x, dy); ctx.lineTo(x, dy + dh); ctx.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = dy + (dh * r) / rows;
        ctx.beginPath(); ctx.moveTo(dx, y); ctx.lineTo(dx + dw, y); ctx.stroke();
      }
      // 选中单元格高亮
      const selR = Math.floor(selectedIndex / cols);
      const selC = selectedIndex % cols;
      const sx = dx + (dw * selC) / cols;
      const sy = dy + (dh * selR) / rows;
      const sw = dw / cols;
      const sh = dh / rows;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    }
  }, [rows, cols, border, outerBorder, selectedIndex, imgReady, viewH]);

  const clampIdx = (v: number) => Math.max(0, Math.min(cellCount - 1, v));

  /** 点击预览选格（替代 Selected 步进器——对齐 ComfyTV 交互）。 */
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const img = imgElRef.current;
    if (!imgReady || !img || !img.naturalWidth) { return; }
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) { return; }
    const x = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((e.clientY - rect.top) / rect.height) * viewH;
    const scale = Math.min(VIEW_W / img.naturalWidth, viewH / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = (VIEW_W - dw) / 2;
    const dy = (viewH - dh) / 2;
    if (x < dx || x > dx + dw || y < dy || y > dy + dh) { return; }
    const c = Math.min(cols - 1, Math.max(0, Math.floor(((x - dx) / dw) * cols)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(((y - dy) / dh) * rows)));
    const idx = clampIdx(r * cols + c);
    setSelectedIndex(idx);
    onCommit({ selectedIndex: idx });
  };

  /** 紧凑步进组（label + − 值 ＋，描边药丸——对齐参考样式的 ROWS/COLS/BOR 组）。 */
  const stepGroup = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    step = 1,
  ): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 7px', border: PANEL_BORDER, borderRadius: 6, background: PANEL_BG }}>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 1, color: DIM, marginRight: 2 }}>{label}</span>
      <button style={miniBtn} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span style={{ fontSize: 11, fontFamily: 'Consolas, monospace', minWidth: 16, textAlign: 'center', color: 'var(--vscode-foreground)' }}>{value}</span>
      <button style={miniBtn} onClick={() => onChange(Math.min(max, value + step))}>＋</button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {/* 大预览（无图：居中网格图标 + 占位文案；有图：源图 + 网格 + 点击选格） */}
      <div style={{ position: 'relative', width: '100%' }}>
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={viewH}
          onClick={onCanvasClick}
          style={{
            width: '100%', display: 'block', borderRadius: 8,
            background: PREVIEW_BG, border: '1px solid rgba(255,255,255,.1)',
            cursor: imgReady ? 'pointer' : 'default',
          }}
        />
        {!imgReady && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none',
          }}>
            {/* 网格图标（2×2 圆角方块，对齐参考截图的 ⊞ 占位图标） */}
            <svg width="54" height="54" viewBox="0 0 54 54" fill="none">
              {[
                [8, 8], [30, 8], [8, 30], [30, 30],
              ].map(([x, y]) => (
                <rect key={`${x}-${y}`} x={x} y={y} width={16} height={16} rx={4}
                  stroke="#4a4d55" strokeWidth={3} fill="none" />
              ))}
            </svg>
            <span style={{ fontSize: 12.5, color: '#9ba0a8' }}>Connect an image to split</span>
          </div>
        )}
      </div>
      {!imgReady && (
        <div style={{ fontSize: 11, color: DIM, textAlign: 'center', marginTop: -2 }}>
          Connect an image to split
        </div>
      )}

      {/* 预设排（等宽按钮，active = 描边高亮） */}
      <div style={{ display: 'flex', gap: 5 }}>
        {PRESETS.map((p) => {
          const active = p.rows === rows && p.cols === cols;
          return (
            <button
              key={p.label}
              style={{
                flex: 1, padding: '4px 0', borderRadius: 6, cursor: 'pointer',
                fontSize: 11, fontFamily: 'Consolas, monospace',
                border: active ? `1px solid ${ACCENT}` : '1px solid rgba(255,255,255,.12)',
                background: active ? 'rgba(74,158,255,.12)' : PANEL_BG,
                color: active ? '#7ab8ff' : 'var(--vscode-foreground)',
              }}
              onClick={() => {
                setRows(p.rows); setCols(p.cols);
                const idx = clampIdx(selectedIndex);
                setSelectedIndex(idx);
                onCommit({ rows: p.rows, cols: p.cols, selectedIndex: idx });
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* ROWS / COLS / BORDER 步进排（横向一排，溢出滚动——对齐参考样式） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
        {stepGroup('ROWS', rows, 1, 10, (v) => { setRows(v); onCommit({ rows: v }); })}
        {stepGroup('COLS', cols, 1, 10, (v) => { setCols(v); onCommit({ cols: v }); })}
        {stepGroup('BORDER', border, 0, 4096, (v) => { setBorder(v); onCommit({ border: v }); }, 2)}
      </div>

      {/* OUTER BORDER 勾选排（整宽描边药丸） */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px',
        border: PANEL_BORDER, borderRadius: 6, background: PANEL_BG,
        fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--vscode-foreground)',
        cursor: 'pointer', userSelect: 'none',
      }}>
        <input
          type="checkbox"
          checked={outerBorder}
          onChange={(e) => { setOuterBorder(e.target.checked); onCommit({ outerBorder: e.target.checked }); }}
          style={{ accentColor: ACCENT, margin: 0 }}
        />
        OUTER BORDER
      </label>
    </div>
  );
}
