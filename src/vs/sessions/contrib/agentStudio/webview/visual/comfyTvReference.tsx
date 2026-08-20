/*--------------------------------------------------------------------------
 * comfyTvReference —— 按 ComfyTV 源码绘制的「参考节点卡」。
 *
 * 每个可视化场景渲染两张并排：左 = 本参考卡（ComfyTV 真源 token 直出），
 * 右 = 本项目 NodeCard。__vs 对比快照供肉眼核对「完全复刻」；
 * R15 则对**参考卡自身**做 computed style 断言（保证参考卡不失真 ——
 * 参考错 = 比对基准错）。
 *
 * 结构对齐 ComfyTV StageCard.vue 模板顺序：
 *   MainPromptInput → StagePresetBar → params(SectionLabel+行) →
 *   run-btn → progress → OUTPUT
 * 样式全部走 comfyTvTruth 的 token（不写字面量）。
 *------------------------------------------------------------------------*/
import * as React from 'react';
import { CTV_COLORS, CTV_FONT, CTV_LAYOUT } from './comfyTvTruth';

export interface RefControl { name: string; type: string; value: string; }

export interface RefCardProps {
	/** 节点类型名（如 ComfyTV.ImageStage / Saros.Agent） */
	nodeType: string;
	/** 卡片标题（节点去掉前缀） */
	title: string;
	/** 参数行（来自 spec widgets + 种子值） */
	controls: RefControl[];
	/** 是否渲染 prompt 区（ComfyTV：非 loader/transform 有 MainPromptInput） */
	hasPrompt: boolean;
	/** 宽度与本项目卡一致（visual 宿主 280px） */
	width: number;
}

const S: React.CSSProperties = { boxSizing: 'border-box' };

/** SectionLabel —— StageCard sectionLabel 类的 token 直出。 */
function RefSectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div style={{ ...S, fontSize: CTV_FONT['2xs'], letterSpacing: 1, textTransform: 'uppercase', opacity: 0.6, marginBottom: CTV_LAYOUT.sectionLabelMarginBottom, color: CTV_COLORS.foreground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
			{children}
		</div>
	);
}

/** 单个参数行（label + 控件示意：COMBO→下拉样式 / 其他→输入样式）。 */
function RefControlRow({ c }: { c: RefControl }) {
	const isCombo = c.type === 'COMBO';
	return (
		<div style={{ ...S, display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
			<span style={{ ...S, fontSize: CTV_FONT['2xs'], color: CTV_COLORS.mutedForeground, width: 74, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
			<div style={{
				...S, flex: 1, minWidth: 0, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
				padding: '0 8px', borderRadius: CTV_LAYOUT.smBtnRadius,
				background: CTV_COLORS.mutedBackground,
				border: `1px solid ${CTV_COLORS.borderSubtle}`,
				color: CTV_COLORS.foreground, fontSize: CTV_FONT.xs,
			}}>
				<span style={{ ...S, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.value || '—'}</span>
				{isCombo && <span style={{ ...S, color: CTV_COLORS.mutedForeground, fontSize: 8 }}>▾</span>}
			</div>
		</div>
	);
}

/** run 按钮 —— runBtnClass（SIZE_LG + primary）token 直出。 */
function RefRunButton({ label }: { label: string }) {
	return (
		<div data-vt-ref="run-btn" style={{
			...S, height: CTV_LAYOUT.runBtnHeight, borderRadius: CTV_LAYOUT.runBtnRadius,
			padding: `0 ${CTV_LAYOUT.runBtnPaddingX}px`,
			display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
			background: CTV_COLORS.primary, color: CTV_COLORS.foreground,
			fontSize: CTV_FONT.sm, fontWeight: 500, whiteSpace: 'nowrap',
		}}>
			▶ {label}
		</div>
	);
}

/** ComfyTV 参考卡主体。 */
export function ComfyTvReferenceCard(props: RefCardProps): React.JSX.Element {
	return (
		<div data-vt-ref="card" style={{
			...S, width: props.width, display: 'flex', flexDirection: 'column',
			gap: CTV_LAYOUT.cardGap, padding: CTV_LAYOUT.cardPadding,
			background: CTV_COLORS.background, color: CTV_COLORS.foreground,
			fontSize: CTV_FONT.xs, fontFamily: 'inherit',
			border: `1px solid ${CTV_COLORS.nodeComponentBorder}`,
		}}>
			{/* MainPromptInput 语义区（非 loader/transform） */}
			{props.hasPrompt && (
				<div data-vt-ref="prompt-section" style={{ ...S, display: 'flex', flexDirection: 'column', gap: 3 }}>
					<RefSectionLabel>Prompt</RefSectionLabel>
					<div data-vt-ref="prompt-input" style={{
						...S, minHeight: 52, borderRadius: CTV_LAYOUT.smBtnRadius,
						background: CTV_COLORS.mutedBackground,
						border: `1px solid ${CTV_COLORS.borderSubtle}`,
						padding: 6, fontSize: CTV_FONT.xs, lineHeight: 1.4,
						color: CTV_COLORS.foreground,
					}}>
						a cinematic portrait of a cat, 85mm, soft light
					</div>
				</div>
			)}
			{/* StagePresetBar 语义区（SM 按钮行） */}
			<div data-vt-ref="preset-bar" style={{ ...S, display: 'flex', gap: 4 }}>
				{['2×2', '3×3', '4×4'].map(p => (
					<div key={p} data-vt-ref="preset-btn" style={{
						...S, height: CTV_LAYOUT.smBtnHeight, borderRadius: CTV_LAYOUT.smBtnRadius,
						padding: '0 8px', display: 'flex', alignItems: 'center',
						background: CTV_COLORS.secondary, color: CTV_COLORS.foreground,
						fontSize: CTV_FONT.xs, fontWeight: 500,
					}}>{p}</div>
				))}
			</div>
			{/* CustomParamsSection 语义区 */}
			{props.controls.length > 0 && (
				<div data-vt-ref="params-section" style={{ ...S, display: 'flex', flexDirection: 'column', gap: 4 }}>
					<RefSectionLabel>Params</RefSectionLabel>
					{props.controls.slice(0, 4).map(c => <RefControlRow key={c.name} c={c} />)}
				</div>
			)}
			{/* run-btn（loader/picker 不渲染 —— 与 StageCard 一致；这里统一画） */}
			<RefRunButton label={`运行 ${props.title}`} />
			{/* progress（静态参考：65%） */}
			<div data-vt-ref="progress" style={{ ...S, display: 'flex', alignItems: 'center', gap: 6 }}>
				<div style={{ ...S, position: 'relative', flex: 'auto', height: CTV_LAYOUT.progressHeight, borderRadius: CTV_LAYOUT.smBtnRadius, overflow: 'hidden', background: 'rgba(224,224,224,0.10)' }}>
					<div style={{ ...S, width: '65%', height: '100%', background: `linear-gradient(to right, ${CTV_COLORS.primary}, ${CTV_COLORS.primaryHover})` }} />
				</div>
				<span style={{ ...S, minWidth: 60, fontSize: CTV_FONT['2xs'], textAlign: 'right', fontFamily: 'Consolas, monospace', color: CTV_COLORS.mutedForeground }}>65%</span>
			</div>
			{/* OUTPUT 语义区 */}
			<div data-vt-ref="output-section" style={{ ...S, display: 'flex', flexDirection: 'column', gap: 4 }}>
				<RefSectionLabel>Output</RefSectionLabel>
				<div style={{
					...S, height: 60, borderRadius: CTV_LAYOUT.smBtnRadius,
					border: `1px dashed ${CTV_COLORS.borderDefault}`,
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					color: CTV_COLORS.mutedForeground, fontSize: CTV_FONT['2xs'],
				}}>images</div>
			</div>
		</div>
	);
}
