/*---------------------------------------------------------------------------------------------
 *  MentionTextarea — 支持 `@` 提及的 Stage 输入框（所有 stage 节点复用）。
 *
 *  在任意位置键入 `@` 弹出候选面板，分两组：
 *    - **节点**：插入 `@[node:label]` 引用语法（由 nodeMentions.ts 在执行时解析：
 *      被引用节点的最新文本注入 prompt、图像进参考图 slot）；
 *    - **文件**：工作流内已生成的媒体资产。选中后通过 `onPinAsset` 钉成
 *      「资产引用」（见 assetRefs.ts / AssetReferences.tsx），不往文本里插 token；
 *      未提供 `onPinAsset` 时回退为插入 `@[node:label]`。
 *
 *  键盘：↑/↓ 移动、Enter/Tab 选中、Esc 关闭。输入 `@` 后继续键入即为过滤词
 *  （空格或换行会自动关闭面板）。
 *--------------------------------------------------------------------------------------------*/
import * as React from 'react';

export interface MentionCandidate {
	/** 'node' → 插入 @[node:label]；'file' → 钉成资产引用。 */
	group: 'node' | 'file';
	/** 展示名（也是 @[node:label] 里的 label）。 */
	label: string;
	/** 媒体类型（file 组用于图标/缩略图）。 */
	kind?: string;
	/** 媒体引用（file 组必填，用于钉资产）。 */
	ref?: string;
}

export interface MentionTextareaProps {
	value: string;
	onChange: (next: string) => void;
	candidates: MentionCandidate[];
	/** 选中 file 组候选时的回调（钉成资产引用）。 */
	onPinAsset?: (c: MentionCandidate) => void;
	placeholder?: string;
	rows?: number;
	style?: React.CSSProperties;
	/** 附加到 textarea 的 onKeyDown（面板未消费时透传）。 */
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** 从光标回溯定位正在输入的 `@词`；返回 null 表示当前不在提及上下文。 */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | null {
	for (let i = caret - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === '@') {
			const query = text.slice(i + 1, caret);
			// 已闭合的 @[node:x] 或含空白 → 不再是输入中的提及
			if (/[\s\][]/.test(query)) { return null; }
			return { start: i, query };
		}
		if (/[\s\][]/.test(ch)) { return null; }
	}
	return null;
}

const panelStyle: React.CSSProperties = {
	position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 40,
	maxHeight: 180, overflowY: 'auto', marginTop: 2, padding: 3, borderRadius: 5,
	pointerEvents: 'auto',
	background: 'var(--vscode-editorWidget-background, #252526)',
	border: '1px solid var(--vscode-widget-border, rgba(255,255,255,.18))',
	boxShadow: '0 6px 20px rgba(0,0,0,.5)',
};

export function MentionTextarea({
	value, onChange, candidates, onPinAsset, placeholder, rows = 1, style, onKeyDown,
}: MentionTextareaProps): React.JSX.Element {
	const ref = React.useRef<HTMLTextAreaElement | null>(null);
	const [mention, setMention] = React.useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = React.useState(0);

	const matches = React.useMemo(() => {
		if (!mention) { return []; }
		const q = mention.query.toLowerCase();
		const hit = q ? candidates.filter(c => c.label.toLowerCase().includes(q)) : candidates;
		return hit.slice(0, 30);
	}, [mention, candidates]);

	React.useEffect(() => { setActive(0); }, [mention?.query]);

	const syncMention = (text: string, caret: number): void => {
		setMention(findMentionQuery(text, caret));
	};

	const pick = (c: MentionCandidate): void => {
		const m = mention;
		setMention(null);
		if (!m) { return; }
		const el = ref.current;
		const caret = el?.selectionStart ?? value.length;
		// 文件组：钉成资产引用，仅把输入中的 `@词` 去掉（不插 token）。
		if (c.group === 'file' && onPinAsset) {
			onPinAsset(c);
			onChange(value.slice(0, m.start) + value.slice(caret));
			return;
		}
		const token = `@[node:${c.label}]`;
		const next = value.slice(0, m.start) + token + value.slice(caret);
		onChange(next);
		// 光标移到 token 之后
		requestAnimationFrame(() => {
			const pos = m.start + token.length;
			el?.setSelectionRange(pos, pos);
			el?.focus();
		});
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
		if (mention && matches.length > 0) {
			if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); return; }
			if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); return; }
			if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]); return; }
			if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
		}
		onKeyDown?.(e);
	};

	return (
		<div style={{ position: 'relative', pointerEvents: 'auto' }}>
			<textarea
				ref={ref}
				value={value}
				rows={rows}
				spellCheck={false}
				placeholder={placeholder}
				onChange={(e) => { onChange(e.target.value); syncMention(e.target.value, e.target.selectionStart ?? 0); }}
				onKeyUp={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
				onClick={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
				onBlur={() => { setTimeout(() => setMention(null), 120); }}
				style={{
					pointerEvents: 'auto', resize: 'none', boxSizing: 'border-box', width: '100%',
					padding: '3px 5px', borderRadius: 3,
					background: 'var(--vscode-input-background, rgba(255,255,255,.06))',
					color: 'var(--vscode-foreground, #e8e8e8)',
					border: '1px solid var(--vscode-input-border, rgba(255,255,255,.14))',
					fontSize: 10, lineHeight: 1.4, fontFamily: 'inherit', minHeight: 28, maxHeight: 80,
					overflowY: 'auto',
					...style,
				}}
			/>
			{mention && matches.length > 0 && (
				<div style={panelStyle}>
					{(['node', 'file'] as const).map((group) => {
						const list = matches.filter(c => c.group === group);
						if (list.length === 0) { return null; }
						return (
							<div key={group}>
								<div style={{ padding: '2px 5px', fontSize: 8, fontWeight: 700, letterSpacing: .4, color: 'var(--vscode-descriptionForeground, #858585)' }}>
									{group === 'node' ? '节点' : '文件'}
								</div>
								{list.map((c) => {
									const idx = matches.indexOf(c);
									const isActive = idx === active;
									return (
										<button
											key={`${c.group}:${c.label}:${c.ref ?? ''}`}
											type="button"
											onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); pick(c); }}
											onMouseEnter={() => setActive(idx)}
											style={{
												display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '3px 5px',
												borderRadius: 3, border: 'none', cursor: 'pointer', textAlign: 'left',
												background: isActive ? 'var(--vscode-list-activeSelectionBackground, rgba(74,158,255,.24))' : 'transparent',
												color: 'var(--vscode-foreground, #e8e8e8)', fontSize: 10, fontFamily: 'inherit',
												pointerEvents: 'auto',
											}}
										>
											{c.group === 'file' && c.kind === 'image' && c.ref ? (
												<img src={c.ref} alt="" style={{ width: 18, height: 18, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} />
											) : (
												<span style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>
													{c.group === 'node' ? '⬡' : c.kind === 'video' ? '🎬' : c.kind === 'audio' ? '🔊' : '🖼'}
												</span>
											)}
											<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
										</button>
									);
								})}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
