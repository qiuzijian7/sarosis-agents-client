/*---------------------------------------------------------------------------------------------
 *  AssetReferences — Stage 卡片的「资产引用」区块（Asset References）。
 *
 *  对齐 ComfyTV `src/components/stages/ImageReferences.vue` 的信息架构：
 *
 *    ┌ 资产引用   3                              [+] ┐   ← 标题 + 计数 + 添加
 *    │  ┌──────┐┌──────┐┌──────┐                     │
 *    │  │缩略图 ││缩略图 ││ 🔊   │  76×76 tile         │
 *    │  │  #0 ✕││  #1 ✕││  A  ✕│  slot 角标（配色）   │
 *    │  └──────┘└──────┘└──────┘  hover 显示 ✕ 移除   │
 *    │  ⚠ slot #0 已有上游连线 —— 钉住的资产会覆盖它     │   ← warnings
 *    └──────────────────────────────────────────────┘
 *
 *  交互（与 ComfyTV 一致）：
 *    - [+] 打开资产选择弹窗（候选 = 工作流内所有已生成媒体快照）；
 *    - 点 tile 打开 slot 选择弹窗（改 slot，冲突项标注 已连线/已占用）；
 *    - tile hover 出 ✕ 移除；
 *    - 底部列出 slot 冲突警告（duplicate / override）。
 *--------------------------------------------------------------------------------------------*/
import * as React from 'react';
import {
	type AssetRef,
	type AssetRefType,
	refKey,
	refSlotWarnings,
	refType,
	slotBadge,
	slotColor,
	warningText,
	wiredSlots,
} from './assetRefs';

/** 可选资产候选项（由 NodeCard 从 MediaSnapshotStore 汇总传入）。 */
export interface AssetCandidate {
	ref: string;
	kind: string;
	label: string;
}

export interface AssetReferencesProps {
	refs: AssetRef[];
	/** 可钉的候选资产（工作流内所有已生成媒体）。 */
	candidates: AssetCandidate[];
	/** 宿主 LiteGraph 节点（用于探测已连线 slot）。 */
	node?: unknown;
	onChange: (next: AssetRef[]) => void;
}

const MAX_SLOT = 8;

function kindToType(kind: string): AssetRefType {
	return kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image';
}

const iconBtn: React.CSSProperties = {
	display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
	width: 18, height: 18, borderRadius: 3, cursor: 'pointer', fontSize: 11, lineHeight: 1,
	fontFamily: 'inherit', pointerEvents: 'auto',
	border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
	background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
	color: 'var(--vscode-descriptionForeground, #9a9a9a)',
};

const popup: React.CSSProperties = {
	position: 'absolute', zIndex: 30, minWidth: 190, maxWidth: 260, maxHeight: 220,
	overflowY: 'auto', padding: 4, borderRadius: 5, pointerEvents: 'auto',
	background: 'var(--vscode-editorWidget-background, #252526)',
	border: '1px solid var(--vscode-widget-border, rgba(255,255,255,.18))',
	boxShadow: '0 6px 20px rgba(0,0,0,.5)',
};

export function AssetReferences({ refs, candidates, node, onChange }: AssetReferencesProps): React.JSX.Element {
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [slotPicker, setSlotPicker] = React.useState<number | null>(null);
	const [hover, setHover] = React.useState<number | null>(null);

	const pinnedRefs = React.useMemo(() => new Set(refs.map(refKey)), [refs]);

	// 已连线 slot（按类型分别探测，用于警告 + slot 弹窗标注）。
	const wiredByType = React.useMemo(() => ({
		image: wiredSlots(node, 'image'),
		video: wiredSlots(node, 'video'),
		audio: wiredSlots(node, 'audio'),
	}), [node]);

	const warnings = React.useMemo(() => {
		const out: string[] = [];
		for (const t of ['image', 'video', 'audio'] as AssetRefType[]) {
			const list = refs.filter(r => refType(r) === t);
			out.push(...refSlotWarnings(list, wiredByType[t]).map(warningText));
		}
		return out;
	}, [refs, wiredByType]);

	const addCandidate = (c: AssetCandidate): void => {
		const type = kindToType(c.kind);
		const entry: AssetRef = { ref: c.ref, slot: 0, label: c.label, ...(type !== 'image' ? { type } : {}) };
		// 分配下一个空闲 slot（跳过已连线 + 已占用）。
		const taken = new Set<number>([
			...wiredByType[type],
			...refs.filter(r => refType(r) === type).map(r => r.slot),
		]);
		let s = 0;
		while (taken.has(s)) { s++; }
		entry.slot = s;
		onChange([...refs, entry]);
		setPickerOpen(false);
	};

	const setSlot = (index: number, slot: number): void => {
		onChange(refs.map((r, i) => (i === index ? { ...r, slot } : r)));
		setSlotPicker(null);
	};

	const available = candidates.filter(c => !pinnedRefs.has(`${kindToType(c.kind)}:${c.ref}`));

	return (
		<div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
			{/* 标题行 */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
				<span style={{ fontSize: 9, fontWeight: 700, letterSpacing: .4, color: 'var(--vscode-descriptionForeground, #9a9a9a)' }}>
					资产引用
				</span>
				{refs.length > 0 && (
					<span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--vscode-descriptionForeground, #858585)' }}>
						{refs.length}
					</span>
				)}
				<span style={{ flex: 1 }} />
				<button
					type="button"
					title={pickerOpen ? '关闭' : '添加资产引用'}
					onClick={(e) => { e.stopPropagation(); setPickerOpen(o => !o); setSlotPicker(null); }}
					style={iconBtn}
				>
					{pickerOpen ? '✕' : '＋'}
				</button>
			</div>

			{/* 资产选择弹窗 */}
			{pickerOpen && (
				<div style={{ ...popup, top: 22, right: 0 }}>
					{available.length === 0 ? (
						<div style={{ padding: '6px 8px', fontSize: 10, fontStyle: 'italic', color: 'var(--vscode-descriptionForeground, #858585)' }}>
							暂无可用资产（先运行上游节点生成）
						</div>
					) : available.map((c) => (
						<button
							key={`${c.kind}:${c.ref}`}
							type="button"
							onClick={(e) => { e.stopPropagation(); addCandidate(c); }}
							style={{
								display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '3px 5px',
								borderRadius: 3, border: 'none', cursor: 'pointer', textAlign: 'left',
								background: 'transparent', color: 'var(--vscode-foreground, #e8e8e8)',
								fontSize: 10, fontFamily: 'inherit', pointerEvents: 'auto',
							}}
							onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-list-hoverBackground, rgba(255,255,255,.08))'; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
						>
							{c.kind === 'image' ? (
								<img src={c.ref} alt="" style={{ width: 22, height: 22, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} />
							) : (
								<span style={{ width: 22, textAlign: 'center', flexShrink: 0 }}>{c.kind === 'video' ? '🎬' : '🔊'}</span>
							)}
							<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
						</button>
					))}
				</div>
			)}

			{/* tile 网格 */}
			{refs.length > 0 ? (
				<div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
					{refs.map((r, i) => {
						const color = slotColor(r.slot);
						const t = refType(r);
						return (
							<div
								key={`${refKey(r)}-${i}`}
								title={`${r.label ?? r.ref} · slot #${r.slot}（点击改 slot）`}
								onClick={(e) => { e.stopPropagation(); setSlotPicker(p => (p === i ? null : i)); setPickerOpen(false); }}
								onMouseEnter={() => setHover(i)}
								onMouseLeave={() => setHover(h => (h === i ? null : h))}
								style={{
									position: 'relative', width: 60, height: 60, borderRadius: 3, overflow: 'hidden',
									cursor: 'pointer', pointerEvents: 'auto', background: 'rgba(0,0,0,.3)',
									border: `1px solid ${color}`,
								}}
							>
								{t === 'image' ? (
									<img src={r.ref} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
								) : (
									<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 18 }}>
										{t === 'video' ? '🎬' : '🔊'}
									</div>
								)}
								{/* slot 角标 */}
								<span style={{
									position: 'absolute', bottom: 0, left: 0, right: 0, padding: '1px 3px',
									fontSize: 8, fontWeight: 700, color, pointerEvents: 'none',
									overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
									background: 'linear-gradient(to bottom, transparent, rgba(0,0,0,.78))',
								}}>
									{slotBadge(r)}
								</span>
								{/* hover 移除 */}
								{hover === i && (
									<button
										type="button"
										title="移除引用"
										onClick={(e) => { e.stopPropagation(); onChange(refs.filter((_, k) => k !== i)); setSlotPicker(null); }}
										style={{
											position: 'absolute', top: 2, right: 2, width: 14, height: 14,
											display: 'flex', alignItems: 'center', justifyContent: 'center',
											borderRadius: 2, cursor: 'pointer', fontSize: 8, lineHeight: 1, padding: 0,
											border: '1px solid rgba(255,255,255,.3)', background: 'rgba(0,0,0,.65)',
											color: '#fff', fontFamily: 'inherit', pointerEvents: 'auto',
										}}
									>
										✕
									</button>
								)}
							</div>
						);
					})}
				</div>
			) : (
				<div style={{ fontSize: 9, fontStyle: 'italic', color: 'var(--vscode-descriptionForeground, #6b6b6b)' }}>
					未钉住任何资产 —— 点 ＋ 添加参考图
				</div>
			)}

			{/* slot 选择弹窗 */}
			{slotPicker !== null && refs[slotPicker] && (
				<div style={{ ...popup, top: 46, left: 0, minWidth: 150 }}>
					<div style={{ padding: '2px 5px 4px', fontSize: 9, color: 'var(--vscode-descriptionForeground, #858585)' }}>
						选择 slot（{refType(refs[slotPicker])}）
					</div>
					{Array.from({ length: MAX_SLOT }, (_, s) => {
						const t = refType(refs[slotPicker]);
						const isWired = wiredByType[t].includes(s);
						const claimed = refs.some((r, k) => k !== slotPicker && refType(r) === t && r.slot === s);
						const current = refs[slotPicker].slot === s;
						return (
							<button
								key={s}
								type="button"
								onClick={(e) => { e.stopPropagation(); setSlot(slotPicker, s); }}
								style={{
									display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '3px 5px',
									borderRadius: 3, border: 'none', cursor: 'pointer', textAlign: 'left',
									background: current ? 'rgba(74,158,255,.2)' : 'transparent',
									color: 'var(--vscode-foreground, #e8e8e8)', fontSize: 10, fontFamily: 'inherit',
									pointerEvents: 'auto',
								}}
							>
								<span style={{ width: 8, height: 8, borderRadius: 2, background: slotColor(s), flexShrink: 0 }} />
								<span style={{ fontFamily: 'monospace' }}>#{s}</span>
								{isWired && <span style={{ fontSize: 8, color: '#fbbf24' }}>已连线</span>}
								{claimed && <span style={{ fontSize: 8, color: '#f87171' }}>已占用</span>}
								{current && <span style={{ fontSize: 8, color: '#4a9eff', marginLeft: 'auto' }}>当前</span>}
							</button>
						);
					})}
				</div>
			)}

			{/* slot 冲突警告 */}
			{warnings.length > 0 && (
				<div style={{
					display: 'flex', flexDirection: 'column', gap: 1, padding: '3px 5px', borderRadius: 3,
					fontSize: 9, background: 'rgba(251,191,36,.1)', border: '1px solid rgba(251,191,36,.35)', color: '#fbbf24',
				}}>
					{warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
				</div>
			)}
		</div>
	);
}
