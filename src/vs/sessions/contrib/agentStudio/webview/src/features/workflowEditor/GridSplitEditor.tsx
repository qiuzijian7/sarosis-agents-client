/**
 * GridSplitEditor — 对齐 ComfyTV GridSplitStageCard 的内嵌网格编辑器。
 *
 * 交互组成：
 *  - 预设（2×2 / 3×3 / 4×4 / 2×3 / 3×2）一键设定 rows/cols；
 *  - Rows / Cols 步进器（1–10）；
 *  - Border 滑杆（0–4096，源像素，切掉的间隔带宽度）；
 *  - Outer border 开关（是否在整张图外缘也切掉 border 边距）；
 *  - 可视化网格预览（画布叠加：源图 + 单元格分隔带 + 选中单元格高亮）；
 *  - selected_index 步进器（0 … rows*cols-1，对应输出 batch 中选中的那一格）。
 *
 * 所有参数通过 onCommit 写回（nodeCard → wf-node-control）：
 *   rows / cols / border / outer_border / selected_index
 * 与 ComfyTV 一致，这些字段在后端 schema 中 hidden=True（由面板驱动）。
 */
import * as React from 'react';

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

const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '2×2', rows: 2, cols: 2 },
  { label: '3×3', rows: 3, cols: 3 },
  { label: '4×4', rows: 4, cols: 4 },
  { label: '2×3', rows: 2, cols: 3 },
  { label: '3×2', rows: 3, cols: 2 },
];

const VIEW_W = 300;
const MAX_VIEW_H = 220;

const btn = (active: boolean): React.CSSProperties => ({
  padding: '3px 7px',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'inherit',
  border: '1px solid rgba(255,255,255,.14)',
  background: active ? 'rgba(74,158,255,.22)' : 'rgba(255,255,255,.05)',
  color: active ? '#9cc6ff' : 'var(--vscode-foreground)',
});

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

  // 加载上游图像
  React.useEffect(() => {
    setImgReady(false);
    if (!imageRef) { return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imgElRef.current = img; setImgReady(true); };
    img.onerror = () => { imgElRef.current = null; setImgReady(false); };
    img.src = imageRef;
  }, [imageRef]);

  const viewH = React.useMemo(() => {
    const img = imgElRef.current;
    if (imgReady && img && img.naturalWidth && img.naturalHeight) {
      const h = Math.round((VIEW_W * img.naturalHeight) / img.naturalWidth);
      return Math.max(80, Math.min(MAX_VIEW_H, h));
    }
    return 180;
  }, [imgReady]);

  // 绘制网格预览
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) { return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { return; }
    canvas.width = VIEW_W;
    canvas.height = viewH;
    ctx.clearRect(0, 0, VIEW_W, viewH);
    ctx.fillStyle = '#17181c';
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
      ctx.strokeStyle = '#4a9eff';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    } else {
      // 占位网格
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.lineWidth = 1;
      for (let c = 0; c <= cols; c++) {
        const x = (VIEW_W * c) / cols;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, viewH); ctx.stroke();
      }
      for (let r = 0; r <= rows; r++) {
        const y = (viewH * r) / rows;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(VIEW_W, y); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('无上游图像：连接图像后预览', VIEW_W / 2, viewH / 2);
    }
  }, [rows, cols, border, outerBorder, selectedIndex, imgReady, viewH]);

  const clampIdx = (v: number) => Math.max(0, Math.min(cellCount - 1, v));

  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    step = 1,
  ): React.ReactElement => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', minWidth: 54 }}>{label}</span>
      <button style={btn(false)} onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 22, textAlign: 'center' }}>{value}</span>
      <button style={btn(false)} onClick={() => onChange(Math.min(max, value + step))}>＋</button>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 预设 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginRight: 2 }}>预设</span>
        {PRESETS.map((p) => {
          const active = p.rows === rows && p.cols === cols;
          return (
            <button
              key={p.label}
              style={btn(active)}
              onClick={() => {
                setRows(p.rows); setCols(p.cols);
                onCommit({ rows: p.rows, cols: p.cols });
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* 行/列 */}
      {stepper('Rows', rows, 1, 10, (v) => { setRows(v); onCommit({ rows: v }); })}
      {stepper('Cols', cols, 1, 10, (v) => { setCols(v); onCommit({ cols: v }); })}

      {/* Border 滑杆 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', minWidth: 54 }}>Border</span>
        <input
          type="range"
          min={0}
          max={256}
          step={1}
          value={Math.min(256, border)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setBorder(v);
            onCommit({ border: v });
          }}
          style={{ flex: 1, accentColor: '#4a9eff' }}
        />
        <span style={{ fontSize: 10, fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>{border}px</span>
      </div>

      {/* Outer border 开关 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--vscode-foreground)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={outerBorder}
          onChange={(e) => { setOuterBorder(e.target.checked); onCommit({ outerBorder: e.target.checked }); }}
          style={{ accentColor: '#4a9eff' }}
        />
        外缘边距 (outer border)
      </label>

      {/* 可视化网格预览 */}
      <canvas
        ref={canvasRef}
        width={VIEW_W}
        height={viewH}
        style={{ width: '100%', borderRadius: 8, background: '#17181c', display: 'block', border: '1px solid rgba(255,255,255,.1)' }}
      />

      {/* selected_index */}
      {stepper('Selected', selectedIndex, 0, cellCount - 1, (v) => { const c = clampIdx(v); setSelectedIndex(c); onCommit({ selectedIndex: c }); })}
      <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}>
        输出 {cellCount} 格 · 选中第 {selectedIndex} 格（0 基）
      </div>
    </div>
  );
}
