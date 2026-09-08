/**
 * HoverTip / HoverErrorBadge — 编辑器共享的 hover 提示组件（2026-09-07）：
 * 小图标 + hover 弹出浮动 tip，取代常驻占版面的长文本提示条/错误条。
 * - HoverTip：通用提示（默认 ℹ 图标，蓝紫色调），tipAlign 控制 tip 与图标对齐侧。
 * - HoverErrorBadge：错误徽标（红色「!」圆标）。
 * 注1：webview 会静默吞掉 window.alert（无 allow-modals），提示必须 UI 内可见。
 * 注2：tip 用 position: fixed（按徽标实时 rect 计算坐标 + 视口 clamp + 底部上翻），
 *      不用 absolute——面板内多处 overflow/滚动容器会裁剪 absolute 浮层（宽度错位 bug）。
 */
import * as React from 'react';

type TipVariant = 'info' | 'error';

const VARIANT_STYLE: Record<TipVariant, {
  icon: string;
  badgeCss: React.CSSProperties;
  tipBorder: string;
  tipColor: string;
}> = {
  info: {
    icon: 'ℹ',
    badgeCss: {
      background: 'rgba(96,165,250,.16)',
      color: '#93c5fd',
      border: '1px solid rgba(96,165,250,.45)',
    },
    tipBorder: 'rgba(96,165,250,.4)',
    tipColor: '#bfdbfe',
  },
  error: {
    icon: '!',
    badgeCss: { background: 'rgba(239,68,68,.9)', color: '#fff' },
    tipBorder: 'rgba(239,68,68,.4)',
    tipColor: '#f87171',
  },
};

export function HoverTip({
  tip,
  variant = 'info',
  icon,
  tipWidth = 280,
  tipAlign = 'right',
}: {
  /** 完整提示文本（支持 \n 换行，tip 内 pre-wrap 展示） */
  tip: string;
  variant?: TipVariant;
  /** 覆盖默认图标（任意 React 节点） */
  icon?: React.ReactNode;
  tipWidth?: number;
  /** tip 与图标的对齐侧：right=右缘对齐（默认），left=左缘对齐（图标靠左时用） */
  tipAlign?: 'left' | 'right';
}) {
  const [hover, setHover] = React.useState(false);
  /** 悬停时记录的徽标视口坐标（fixed 定位基准） */
  const [anchorRect, setAnchorRect] = React.useState<DOMRect | null>(null);
  const s = VARIANT_STYLE[variant];

  const showTip = (el: HTMLElement) => {
    setAnchorRect(el.getBoundingClientRect());
    setHover(true);
  };

  // 水平：按对齐侧取基准左缘，再 clamp 进视口（留 4px 边距）
  // 垂直：默认弹在下方 6px；贴近视口底部（余量 < 160px）时改为锚定徽标上方
  const computeTipStyle = (): React.CSSProperties => {
    if (!anchorRect) return {};
    const vw = window.innerWidth;
    const rawLeft = tipAlign === 'left' ? anchorRect.left : anchorRect.right - tipWidth;
    const left = Math.max(4, Math.min(rawLeft, vw - tipWidth - 4));
    const flipUp = window.innerHeight - anchorRect.bottom < 160;
    return flipUp
      ? { left, bottom: window.innerHeight - anchorRect.top + 6 }
      : { left, top: anchorRect.bottom + 6 };
  };

  return (
    <span
      onMouseEnter={(e) => showTip(e.currentTarget)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 15, height: 15, borderRadius: '50%',
        fontSize: 10, fontWeight: 700, lineHeight: 1,
        cursor: 'help', flexShrink: 0, userSelect: 'none',
        ...s.badgeCss,
      }}
    >
      {icon ?? s.icon}
      {hover && (
        <span
          style={{
            position: 'fixed', zIndex: 1000,
            width: tipWidth, padding: '6px 8px', borderRadius: 6,
            background: '#1e2027', border: `1px solid ${s.tipBorder}`,
            color: s.tipColor, fontSize: 10, lineHeight: 1.6,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: 'left',
            boxShadow: '0 4px 14px rgba(0,0,0,.45)',
            ...computeTipStyle(),
          }}
        >
          {tip}
        </span>
      )}
    </span>
  );
}

export function HoverErrorBadge({ message }: { message: string }) {
  return <HoverTip variant="error" tip={message} />;
}
