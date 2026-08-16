/**
 * ColorGradeEditor — 对齐 ComfyTV ColorGradeStageCard 的内嵌调色编辑器。
 *
 * 交互组成（与 ComfyTV 一致）：
 *  - 效果下拉（brightness_contrast / color_adjustment / color_balance /
 *    hue_saturation / color_curves / image_levels）；
 *  - 标量参数：带渐变轨道的滑杆（温度=蓝→橙、饱和度=灰→彩、亮度=黑→白…）；
 *  - 整型参数：下拉（mode / colorspace / channel）；
 *  - 布尔参数：开关（preserve_luminosity）；
 *  - 曲线参数：内置 CurveEditor（拖拽控制点、双击空白加点、双击点删除、重置为 identity）；
 *  - 重置按钮（重置当前效果全部参数为默认值）。
 *
 * 序列化结构（与 ComfyTV 的 serializeGradeState 完全一致）：
 *   { effect: <effectId>, all: { [effectId]: { [uniformKey]: value } } }
 * 通过 onCommit 以 JSON 字符串写回 grade_state（nodeCard → wf-node-control）。
 */
import * as React from 'react';

// ---------- 调色效果定义（裁剪自 ComfyTV effects.ts，仅保留 UI 所需字段） ----------
type Kind = 'float' | 'int' | 'bool' | 'curve';
interface UniformDef {
  key: string;
  label: string;
  kind: Kind;
  min?: number;
  max?: number;
  step?: number;
  default: number | boolean | CurveData;
  options?: { label: string; value: number }[];
  gradient?: string; // CSS linear-gradient，用于滑杆轨道
  curveColor?: string;
}
interface EffectDef {
  id: string;
  label: string;
  uniforms: UniformDef[];
}

interface CurvePoint { x: number; y: number; }
interface CurveData { points: CurvePoint[]; interpolation: 'monotone_cubic' | 'linear'; }

const C = (x: number, y: number): CurvePoint => ({ x, y });
const identityCurve = (): CurveData => ({ points: [C(0, 0), C(1, 1)], interpolation: 'monotone_cubic' });

const EFFECTS: EffectDef[] = [
  {
    id: 'brightness_contrast',
    label: '亮度 / 对比度',
    uniforms: [
      { key: 'brightness', label: '亮度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#1a1a1a,#ffffff)' },
      { key: 'contrast', label: '对比度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#555,#ffffff)' },
    ],
  },
  {
    id: 'color_adjustment',
    label: '色彩调整',
    uniforms: [
      { key: 'temperature', label: '色温', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#3b6bff,#ffb35c)' },
      { key: 'tint', label: '色调', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#37d67a,#e85bd0)' },
      { key: 'vibrance', label: '自然饱和度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#8a8a8a,#39d353)' },
      { key: 'saturation', label: '饱和度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#8a8a8a,#39d353)' },
    ],
  },
  {
    id: 'color_balance',
    label: '色彩平衡',
    uniforms: [
      { key: 'shadows_r', label: '阴影 R', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#ff5b5b)' },
      { key: 'shadows_g', label: '阴影 G', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#51cf66)' },
      { key: 'shadows_b', label: '阴影 B', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#4d8cff)' },
      { key: 'midtones_r', label: '中间调 R', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#ff5b5b)' },
      { key: 'midtones_g', label: '中间调 G', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#51cf66)' },
      { key: 'midtones_b', label: '中间调 B', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#4d8cff)' },
      { key: 'highlights_r', label: '高光 R', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#ff5b5b)' },
      { key: 'highlights_g', label: '高光 G', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#51cf66)' },
      { key: 'highlights_b', label: '高光 B', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#4d8cff)' },
      { key: 'preserve_luminosity', label: '保持亮度', kind: 'bool', default: true },
    ],
  },
  {
    id: 'hue_saturation',
    label: '色相 / 饱和度',
    uniforms: [
      { key: 'mode', label: '模式', kind: 'int', default: 0, options: [
        { label: '主通道', value: 0 }, { label: '红', value: 1 }, { label: '黄', value: 2 }, { label: '绿', value: 3 },
        { label: '青', value: 4 }, { label: '蓝', value: 5 }, { label: '品红', value: 6 }, { label: '着色', value: 7 },
      ] },
      { key: 'colorspace', label: '色彩空间', kind: 'int', default: 0, options: [
        { label: 'HSL', value: 0 }, { label: 'HSV', value: 1 },
      ] },
      { key: 'hue', label: '色相', kind: 'float', min: -180, max: 180, step: 1, default: 0, gradient: 'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)' },
      { key: 'saturation', label: '饱和度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#8a8a8a,#39d353)' },
      { key: 'lightness', label: '明度', kind: 'float', min: -100, max: 100, step: 1, default: 0, gradient: 'linear-gradient(90deg,#1a1a1a,#ffffff)' },
      { key: 'overlap', label: '重叠', kind: 'float', min: 0, max: 100, step: 1, default: 0 },
    ],
  },
  {
    id: 'color_curves',
    label: '色彩曲线',
    uniforms: [
      { key: 'curve_master', label: '主曲线', kind: 'curve', default: identityCurve(), curveColor: '#ffffff' },
      { key: 'curve_r', label: '红', kind: 'curve', default: identityCurve(), curveColor: '#ff6b6b' },
      { key: 'curve_g', label: '绿', kind: 'curve', default: identityCurve(), curveColor: '#51cf66' },
      { key: 'curve_b', label: '蓝', kind: 'curve', default: identityCurve(), curveColor: '#4d8cff' },
    ],
  },
  {
    id: 'image_levels',
    label: '色阶',
    uniforms: [
      { key: 'channel', label: '通道', kind: 'int', default: 0, options: [
        { label: 'RGB', value: 0 }, { label: 'R', value: 1 }, { label: 'G', value: 2 }, { label: 'B', value: 3 },
      ] },
      { key: 'input_black', label: '输入黑', kind: 'float', min: 0, max: 255, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#fff)' },
      { key: 'input_white', label: '输入白', kind: 'float', min: 0, max: 255, step: 1, default: 255, gradient: 'linear-gradient(90deg,#000,#fff)' },
      { key: 'gamma', label: '伽马', kind: 'float', min: 0.01, max: 9.99, step: 0.01, default: 1, gradient: 'linear-gradient(90deg,#222,#fff)' },
      { key: 'output_black', label: '输出黑', kind: 'float', min: 0, max: 255, step: 1, default: 0, gradient: 'linear-gradient(90deg,#000,#fff)' },
      { key: 'output_white', label: '输出白', kind: 'float', min: 0, max: 255, step: 1, default: 255, gradient: 'linear-gradient(90deg,#000,#fff)' },
    ],
  },
];

const getEffect = (id?: string): EffectDef => EFFECTS.find((e) => e.id === id) ?? EFFECTS[0];
const cloneVal = (v: number | boolean | CurveData): number | boolean | CurveData =>
  typeof v === 'object' ? { points: v.points.map((p) => ({ x: p.x, y: p.y })), interpolation: v.interpolation } : v;
const defaultValues = (e: EffectDef): Record<string, number | boolean | CurveData> => {
  const o: Record<string, number | boolean | CurveData> = {};
  for (const u of e.uniforms) { o[u.key] = cloneVal(u.default); }
  return o;
};

export interface ColorGradeInit {
  effect: string;
  all: Record<string, Record<string, number | boolean | CurveData>>;
}
export interface ColorGradeEditorProps {
  initial: ColorGradeInit;
  onCommit: (gradeStateJson: string) => void;
}

// ---------- 曲线编辑器 ----------
function CurveEditor({ value, color, onChange }: {
  value: CurveData;
  color: string;
  onChange: (v: CurveData) => void;
}): React.ReactElement {
  const W = 220; const H = 140;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const dragIdx = React.useRef<number>(-1);

  const draw = React.useCallback(() => {
    const cv = canvasRef.current; if (!cv) { return; }
    const ctx = cv.getContext('2d'); if (!ctx) { return; }
    cv.width = W; cv.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f1014'; ctx.fillRect(0, 0, W, H);
    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = (W * i) / 4; const gy = (H * i) / 4;
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    const toPx = (p: CurvePoint) => ({ x: p.x * W, y: (1 - p.y) * H });
    // 曲线
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    value.points.forEach((p, i) => {
      const { x, y } = toPx(p);
      if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();
    // 控制点
    value.points.forEach((p) => {
      const { x, y } = toPx(p);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }, [value, color]);

  React.useEffect(() => { draw(); }, [draw]);

  const findPoint = (mx: number, my: number): number => {
    let best = -1; let bestD = 12;
    value.points.forEach((p, i) => {
      const x = p.x * W; const y = (1 - p.y) * H;
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const localPos = (e: React.PointerEvent): { x: number; y: number } => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / W)), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / H)) };
  };
  const onDown = (e: React.PointerEvent) => {
    const { x, y } = localPos(e);
    const idx = findPoint(x * W, (1 - y) * H);
    if (idx >= 0) {
      dragIdx.current = idx;
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    } else {
      // 双击空白加点
      const pts = value.points.map((p) => ({ x: p.x, y: p.y }));
      pts.push({ x, y });
      pts.sort((a, b) => a.x - b.x);
      onChange({ points: pts, interpolation: value.interpolation });
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragIdx.current < 0) { return; }
    const { x, y } = localPos(e);
    const pts = value.points.map((p, i) => (i === dragIdx.current ? { x, y } : { x: p.x, y: p.y }));
    onChange({ points: pts, interpolation: value.interpolation });
  };
  const onUp = (e: React.PointerEvent) => {
    dragIdx.current = -1;
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onDouble = (e: React.PointerEvent) => {
    const { x, y } = localPos(e);
    const idx = findPoint(x * W, (1 - y) * H);
    if (idx > 0 && idx < value.points.length - 1) {
      const pts = value.points.filter((_, i) => i !== idx);
      onChange({ points: pts, interpolation: value.interpolation });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(255,255,255,.12)', touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        onDoubleClick={onDouble}
      />
      <div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>
        拖拽控制点 · 双击空白加点 · 双击中间点删除
      </div>
    </div>
  );
}

// ---------- 主编辑器 ----------
export function ColorGradeEditor({ initial, onCommit }: ColorGradeEditorProps): React.ReactElement {
  const [effectId, setEffectId] = React.useState<string>(getEffect(initial.effect).id);
  const [all, setAll] = React.useState<Record<string, Record<string, number | boolean | CurveData>>>(
    () => {
      const a: Record<string, Record<string, number | boolean | CurveData>> = {};
      for (const e of EFFECTS) {
        const def = defaultValues(e);
        const stored = initial.all?.[e.id];
        if (stored) { for (const k of Object.keys(def)) { if (k in stored) { def[k] = cloneVal(stored[k]); } } }
        a[e.id] = def;
      }
      return a;
    },
  );
  const [activeCurveKey, setActiveCurveKey] = React.useState<string>('');

  const effect = getEffect(effectId);
  const values = all[effectId];
  const curves = effect.uniforms.filter((u) => u.kind === 'curve');
  React.useEffect(() => {
    if (curves.length && !curves.some((u) => u.key === activeCurveKey)) {
      setActiveCurveKey(curves[0].key);
    }
  }, [effectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const serialize = (effId: string, allVals: Record<string, Record<string, number | boolean | CurveData>>): string =>
    JSON.stringify({ effect: effId, all: allVals });

  const commit = (nextAll: Record<string, Record<string, number | boolean | CurveData>>, effId = effectId) => {
    setAll(nextAll);
    onCommit(serialize(effId, nextAll));
  };

  const setUniform = (key: string, v: number | boolean | CurveData) => {
    const next = { ...all, [effectId]: { ...all[effectId], [key]: v } };
    commit(next);
  };

  const onEffectChange = (id: string) => {
    setEffectId(id);
    setActiveCurveKey('');
    onCommit(serialize(id, all));
  };

  const resetEffect = () => {
    const next = { ...all, [effectId]: defaultValues(effect) };
    commit(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 效果下拉 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', minWidth: 40 }}>效果</span>
        <select
          value={effectId}
          onChange={(e) => onEffectChange(e.target.value)}
          style={{
            flex: 1, fontSize: 11, padding: '3px 6px', borderRadius: 5,
            background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
            border: '1px solid var(--vscode-input-border)',
          }}
        >
          {EFFECTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        <button
          onClick={resetEffect}
          title="重置当前效果"
          style={{
            fontSize: 10, padding: '3px 7px', borderRadius: 5, cursor: 'pointer',
            border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
          }}
        >重置</button>
      </div>

      {/* 参数 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {effect.uniforms.map((u) => {
          if (u.kind === 'float') {
            const val = Number(values[u.key]);
            return (
              <div key={u.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10 }}>
                  <span style={{ color: 'var(--vscode-descriptionForeground)' }}>{u.label}</span>
                  <span style={{ fontFamily: 'monospace' }}>{val}</span>
                </div>
                <input
                  type="range"
                  min={u.min}
                  max={u.max}
                  step={u.step ?? 1}
                  value={val}
                  onChange={(e) => setUniform(u.key, Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#4a9eff', background: u.gradient, height: 6, borderRadius: 3 }}
                />
              </div>
            );
          }
          if (u.kind === 'int') {
            return (
              <div key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', minWidth: 56 }}>{u.label}</span>
                <select
                  value={Number(values[u.key])}
                  onChange={(e) => setUniform(u.key, Number(e.target.value))}
                  style={{
                    flex: 1, fontSize: 11, padding: '2px 5px', borderRadius: 5,
                    background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
                    border: '1px solid var(--vscode-input-border)',
                  }}
                >
                  {u.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            );
          }
          if (u.kind === 'bool') {
            return (
              <label key={u.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={Boolean(values[u.key])}
                  onChange={(e) => setUniform(u.key, e.target.checked)}
                  style={{ accentColor: '#4a9eff' }}
                />
                {u.label}
              </label>
            );
          }
          return null;
        })}
      </div>

      {/* 曲线 */}
      {curves.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 8 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {curves.map((u) => {
              const active = u.key === activeCurveKey;
              return (
                <button
                  key={u.key}
                  onClick={() => setActiveCurveKey(u.key)}
                  style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,.14)',
                    background: active ? 'rgba(74,158,255,.22)' : 'rgba(255,255,255,.05)',
                    color: active ? '#9cc6ff' : 'var(--vscode-foreground)',
                  }}
                >{u.label}</button>
              );
            })}
          </div>
          {(() => {
            const cu = curves.find((u) => u.key === activeCurveKey) ?? curves[0];
            const cv = values[cu.key] as CurveData;
            return (
              <CurveEditor
                value={cv}
                color={cu.curveColor ?? '#fff'}
                onChange={(v) => setUniform(cu.key, v)}
              />
            );
          })()}
          <button
            onClick={() => {
              const cu = curves.find((u) => u.key === activeCurveKey) ?? curves[0];
              setUniform(cu.key, identityCurve());
            }}
            style={{
              alignSelf: 'flex-start', fontSize: 10, padding: '2px 8px', borderRadius: 5, cursor: 'pointer',
              border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.05)', color: 'var(--vscode-foreground)',
            }}
          >重置曲线</button>
        </div>
      )}
    </div>
  );
}
