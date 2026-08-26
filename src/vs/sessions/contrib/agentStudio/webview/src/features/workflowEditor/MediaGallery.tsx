/*---------------------------------------------------------------------------------------------
 *  MediaGallery.tsx — 生成图片媒体库（P1）。
 *
 *  经 mediaAssets 客户端（host → ProxyChannel → 主进程 media.db）读取资产，
 *  展示可筛选网格：文本搜索 / 收藏 / 回收站。操作：下载、收藏、删除（软删）/恢复。
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import {
	mediaList, mediaGetAsDataUrl, mediaImport, mediaRemove, mediaRestore, mediaSetFavorite, mediaSetBoard,
	mediaStats, mediaPurgeDeleted, mediaCleanOrphaned, mediaEnforceQuota, mediaGetRootDir, mediaSetRootDir, type MediaStats,
	type MediaAsset,
} from './mediaAssets';
import { formatBytes, assetFileName } from './mediaGalleryUtils';
import { ASSET_DRAG_MIME } from './comfyHost/actionSpawn';
import { pickFolderDialog } from '../../bridge/messageClient';

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const data = String(reader.result ?? '');
			const comma = data.indexOf(',');
			resolve(comma >= 0 ? data.slice(comma + 1) : data);
		};
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(file);
	});
}

const THUMB = 96;

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 下载资产：URL 引用 fetch → blob → a[download]。 */
async function downloadAsset(a: MediaAsset, url: string | null): Promise<void> {
	if (!url) { return; }
	try {
		const res = await fetch(url);
		if (!res.ok) { return; }
		const blob = await res.blob();
		const objectUrl = URL.createObjectURL(blob);
		const el = document.createElement('a');
		el.href = objectUrl;
		el.download = assetFileName(a);
		el.click();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
	} catch { /* ignore */ }
}

export function MediaGallery({ workflowId, onClose }: { workflowId: string; onClose: () => void }): React.JSX.Element {
	const [items, setItems] = React.useState<MediaAsset[]>([]);
	const [total, setTotal] = React.useState(0);
	const [loading, setLoading] = React.useState(true);
	const [query, setQuery] = React.useState('');
	const [favoriteOnly, setFavoriteOnly] = React.useState(false);
	const [showDeleted, setShowDeleted] = React.useState(false);
	const [scopeWorkflow, setScopeWorkflow] = React.useState(true);
	const [boardFilter, setBoardFilter] = React.useState('');
	const [stats, setStats] = React.useState<MediaStats | null>(null);
	// 资产 id → webview 可加载 URL（懒解析并缓存）
	const [urls, setUrls] = React.useState<Record<string, string | null>>({});
	const [busy, setBusy] = React.useState<Set<string>>(new Set());
	// 正在编辑 board 的资产 id
	const [editingBoard, setEditingBoard] = React.useState<string | null>(null);
	const [boardDraft, setBoardDraft] = React.useState('');
	// 破坏性操作两段确认 + 提示（沙箱 webview 的 alert/confirm 可能被拦截）
	const [confirmPurge, setConfirmPurge] = React.useState(false);
	const [confirmCleanup, setConfirmCleanup] = React.useState(false);
	const [confirmCleanOrphan, setConfirmCleanOrphan] = React.useState(false);
	const [notice, setNotice] = React.useState('');
	// 媒体库存储路径（仅显示；修改走系统文件夹选择器，不允许手敲）
	const [rootDir, setRootDir] = React.useState('');
	const fileInputRef = React.useRef<HTMLInputElement | null>(null);

	const load = React.useCallback(async () => {
		setLoading(true);
		try {
			const res = await mediaList({
				workflowId: scopeWorkflow ? workflowId : undefined,
				query: query || undefined,
				favorite: favoriteOnly || undefined,
				board: boardFilter || undefined,
				includeDeleted: showDeleted || undefined,
				limit: 200,
			});
			setItems(res.items);
			setTotal(res.total);
		} catch {
			setItems([]);
			setTotal(0);
		} finally {
			setLoading(false);
		}
	}, [workflowId, scopeWorkflow, query, favoriteOnly, boardFilter, showDeleted]);

	const refreshStats = React.useCallback(async () => {
		try { setStats(await mediaStats()); } catch { setStats(null); }
	}, []);

	React.useEffect(() => {
		void load();
		void refreshStats();
	}, [load, refreshStats]);

	// 当前列表里出现过的 board（用于分组过滤下拉）
	const boardOptions = React.useMemo(() => {
		const s = new Set<string>();
		for (const a of items) { if (a.board) { s.add(a.board); } }
		return Array.from(s).sort();
	}, [items]);

	const commitBoard = async (a: MediaAsset) => {
		setEditingBoard(null);
		const next = boardDraft.trim() || null;
		setBusy(prev => new Set(prev).add(a.id));
		try { await mediaSetBoard(a.id, next); } finally {
			setBusy(prev => { const s = new Set(prev); s.delete(a.id); return s; });
		}
		setItems(prev => prev.map(x => x.id === a.id ? { ...x, board: next ?? undefined } : x));
	};

	const purgeAll = async () => {
		if (!confirmPurge) { setConfirmPurge(true); setTimeout(() => setConfirmPurge(false), 2500); return; }
		setConfirmPurge(false);
		setLoading(true);
		try {
			const r = await mediaPurgeDeleted();
			await load();
			await refreshStats();
			setNotice(`已永久删除 ${r.count} 项，释放 ${formatBytes(r.freedBytes)}`);
		} catch {
			setNotice('永久删除失败');
		} finally {
			setLoading(false);
		}
	};

	const importFiles = async (files: FileList | null) => {
		if (!files?.length) { return; }
		const list = Array.from(files);
		setLoading(true);
		let ok = 0;
		try {
			for (const f of list) {
				const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'image';
				const ext = (f.name.split('.').pop() || (kind === 'image' ? 'png' : 'bin')).toLowerCase().replace(/[^a-z0-9]/g, '');
				const b64 = await readFileAsBase64(f);
				await mediaImport({
					base64: b64,
					ext: ext || 'png',
					kind,
					mime: f.type || undefined,
					workflowId: scopeWorkflow ? workflowId : undefined,
					provider: 'upload',
					metaJson: JSON.stringify({ sourceName: f.name }),
				});
				ok++;
			}
		} catch {
			// 部分失败也在 notice 中体现
		} finally {
			setLoading(false);
		}
		setNotice(`已导入 ${ok}/${list.length} 个文件到媒体库`);
		await load();
		await refreshStats();
	};

	const runCleanup = async () => {
		if (!confirmCleanup) { setConfirmCleanup(true); setTimeout(() => setConfirmCleanup(false), 2500); return; }
		setConfirmCleanup(false);
		setLoading(true);
		try {
			const r = await mediaEnforceQuota({ maxDays: 90 });
			await load();
			await refreshStats();
			setNotice(`已清理 ${r.removed} 项，释放 ${formatBytes(r.freedBytes)}（90 天前的未收藏/未分组）`);
		} catch {
			setNotice('清理失败');
		} finally {
			setLoading(false);
		}
	};

	const runCleanOrphan = async () => {
		if (!confirmCleanOrphan) { setConfirmCleanOrphan(true); setTimeout(() => setConfirmCleanOrphan(false), 2500); return; }
		setConfirmCleanOrphan(false);
		setLoading(true);
		try {
			const r = await mediaCleanOrphaned();
			await load();
			await refreshStats();
			setNotice(`已清理 ${r.count} 项不可用资产（磁盘文件缺失），释放 ${formatBytes(r.freedBytes)}`);
		} catch {
			setNotice('清理不可用失败');
		} finally {
			setLoading(false);
		}
	};

	React.useEffect(() => {
		mediaGetRootDir().then(d => setRootDir(d)).catch(() => {});
	}, []);

	const saveRootDir = async (path: string) => {
		if (!path) { setNotice('路径不能为空'); return; }
		setLoading(true);
		try {
			const r = await mediaSetRootDir(path);
			setRootDir(r.rootDir);
			setNotice(`媒体库路径已改为 ${r.rootDir}`);
			await load();
			await refreshStats();
		} catch (e) {
			setNotice(`修改失败：${(e as Error).message}`);
		} finally {
			setLoading(false);
		}
	};

	// ★ 弹系统文件夹选择器（vscode.window.showOpenDialog）→ 选中后写入 mediaSetRootDir。
	// 不允许手敲路径：避免拼写错误、跨盘符引用、越权访问；并阻止在 webview 文本框里
	// 输入任意绝对路径绕过沙箱审查。
	const pickAndSetRootDir = async () => {
		const picked = await pickFolderDialog({ title: '选择媒体库存储目录', openLabel: '选择此目录' });
		if (!picked) { return; }
		await saveRootDir(picked);
	};

	// 懒解析本地镜像的 webview URL（http/data URL 直接可用）
	React.useEffect(() => {
		let cancelled = false;
		(async () => {
			const pending: Array<[MediaAsset, string | null]> = [];
			for (const a of items) {
				if (a.id in urls) { continue; }
				if (/^(https?|data):/i.test(a.ref)) { pending.push([a, a.ref]); continue; }
				if (a.filePath) {
					try {
						const u = await mediaGetAsDataUrl(a.id);
						pending.push([a, u]);
					} catch {
						pending.push([a, null]);
					}
				} else {
					pending.push([a, null]);
				}
			}
			if (cancelled) { return; }
			if (pending.length) {
				setUrls(prev => {
					const next = { ...prev };
					for (const [a, u] of pending) { next[a.id] = u; }
					return next;
				});
			}
		})();
		return () => { cancelled = true; };
	}, [items, urls]);

	const toggleFavorite = async (a: MediaAsset) => {
		const next = !a.favorite;
		setBusy(prev => new Set(prev).add(a.id));
		try { await mediaSetFavorite(a.id, next); } finally {
			setBusy(prev => { const s = new Set(prev); s.delete(a.id); return s; });
		}
		setItems(prev => prev.map(x => x.id === a.id ? { ...x, favorite: next } : x));
	};

	const toggleDeleted = async (a: MediaAsset) => {
		setBusy(prev => new Set(prev).add(a.id));
		try {
			if (a.isDeleted) { await mediaRestore(a.id); }
			else { await mediaRemove(a.id); }
		} finally {
			setBusy(prev => { const s = new Set(prev); s.delete(a.id); return s; });
		}
		await load();
	};

	const inputStyle: React.CSSProperties = {
		background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: 4,
		padding: '4px 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none',
	};

	return (
		<div style={{
			position: 'absolute', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
		}} onMouseDown={e => { if (e.target === e.currentTarget) { onClose(); } }}>
			<div style={{
				width: 820, maxWidth: '92%', height: '82%', display: 'flex', flexDirection: 'column',
				background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-panel-border)',
				borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,.5)', overflow: 'hidden',
			}}>
				{/* header */}
				<div style={{
					display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)', flexWrap: 'wrap',
				}}>
					<span style={{ fontWeight: 600, fontSize: 13 }}>🖼 媒体库</span>
					<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>{total} 项{stats ? ` · ${formatBytes(stats.dirSizeBytes)}` : ''}</span>
					<input
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder="搜索文件名 / 引用…"
						style={{ ...inputStyle, flex: 1, minWidth: 140 }}
					/>
					<select value={boardFilter} onChange={e => setBoardFilter(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
						<option value="">全部分组</option>
						{boardOptions.map(b => <option key={b} value={b}>{b}</option>)}
					</select>
					<label style={{ fontSize: 11, color: 'var(--vscode-foreground)', display: 'flex', alignItems: 'center', gap: 4 }}>
						<input type="checkbox" checked={scopeWorkflow} onChange={e => setScopeWorkflow(e.target.checked)} /> 当前工作流
					</label>
					<label style={{ fontSize: 11, color: 'var(--vscode-foreground)', display: 'flex', alignItems: 'center', gap: 4 }}>
						<input type="checkbox" checked={favoriteOnly} onChange={e => setFavoriteOnly(e.target.checked)} /> 仅收藏
					</label>
					<label style={{ fontSize: 11, color: 'var(--vscode-foreground)', display: 'flex', alignItems: 'center', gap: 4 }}>
						<input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> 回收站
					</label>
					<button onClick={runCleanup} title="删除超过 90 天且未收藏/未分组的资产（进回收站可恢复）" style={{ ...inputStyle, cursor: 'pointer', fontSize: 11 }}>
						{confirmCleanup ? '确认清理？' : '🧹 清理'}
					</button>
					<button onClick={runCleanOrphan} title="清理「不可用」项：硬删 DB 有 file_path 但磁盘文件已缺失的行（app 重装/rootDir 变化残留）" style={{ ...inputStyle, cursor: 'pointer', fontSize: 11 }}>
						{confirmCleanOrphan ? '再次点击确认' : '🧽 清理不可用'}
					</button>
					{showDeleted && (
						<button onClick={purgeAll} title="物理删除回收站资产（不可恢复）" style={{ ...inputStyle, cursor: 'pointer', fontSize: 11, color: '#ff5b5b' }}>
							{confirmPurge ? '再次点击确认' : '🗑 永久删除'}
						</button>
					)}
					<button onClick={() => fileInputRef.current?.click()} title="导入本地图片/视频/音频到媒体库" style={{ ...inputStyle, cursor: 'pointer', fontSize: 11 }}>
						⬆ 导入文件
					</button>
					<span style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', display: 'flex', alignItems: 'center', gap: 4 }}>
						<span>📁 路径</span>
												<span style={{ fontFamily: 'monospace', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rootDir || '点击右侧按钮选择目录'}>{rootDir || '（加载中…）'}</span>
												<button onClick={() => void pickAndSetRootDir()} title="选择媒体库存储目录（弹系统文件夹选择器，不允许手敲路径）" style={{ ...inputStyle, cursor: 'pointer', fontSize: 11 }}>📂 选择…</button>
											</span>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept="image/*,video/*,audio/*"
						style={{ display: 'none' }}
						onChange={e => {
							void importFiles(e.target.files);
							e.target.value = '';
						}}
					/>
					<button onClick={onClose} style={{ ...inputStyle, cursor: 'pointer', borderColor: 'var(--vscode-panel-border)' }}>✕ 关闭</button>
				</div>
				{notice && (
					<div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--vscode-foreground)', background: 'rgba(99,102,241,.12)', borderBottom: '1px solid var(--vscode-panel-border)' }}>
						{notice}
					</div>
				)}
				{/* grid */}
				<div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
					{loading ? (
						<div style={{ textAlign: 'center', padding: 40, color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>加载中…</div>
					) : items.length === 0 ? (
						<div style={{ textAlign: 'center', padding: 40, color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>
							暂无资产。运行工作流生成图片后会自动收录；也可把 ComfyUI 输出"保存到媒体库"。
						</div>
					) : (
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
							{items.map(a => {
								const url = urls[a.id] ?? null;
								return (
									<div
										key={a.id}
										draggable
										onDragStart={e => {
											// 拖拽媒体库资产到画布（对齐 ComfyTV handleAssetDrop）。
											// 写入自定义 MIME 供画布 drop 读取；延迟关闭媒体库 modal
											// 让画布露出来（HTML5 拖拽由浏览器接管，源移除不中断）。
											e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify({ id: a.id, kind: a.kind, ref: a.ref }));
											e.dataTransfer.setData('text/plain', assetFileName(a));
											e.dataTransfer.effectAllowed = 'copy';
											const close = onClose;
											setTimeout(() => close(), 0);
										}}
										title={`拖到画布创建加载节点 · ${assetFileName(a)}`}
										style={{
											width: THUMB + 20, display: 'flex', flexDirection: 'column', gap: 4,
											border: '1px solid var(--vscode-panel-border)', borderRadius: 6, padding: 6,
											background: 'var(--vscode-sideBar-background)', cursor: 'grab',
										}}>
										<div style={{ position: 'relative', width: THUMB, height: THUMB, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,.04)' }}>
											{url ? (
												a.kind === 'video' ? (
													// ★ 视频缩略图：<img> 对视频 URL 不会解码（显示破损图标）。
													// 用 <video preload="metadata" muted playsInline> 让浏览器解码首帧；
													// onLoadedMetadata 后 currentTime=0.1 强制 seek 到非黑帧（部分视频首帧是黑帧）。
													<video
														src={url}
														muted
														playsInline
														preload="metadata"
														onLoadedMetadata={(e) => { try { e.currentTarget.currentTime = 0.1; } catch { /* 某些 codec 不支持 seek，no-op */ } }}
														style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', background: '#000' }}
													/>
												) : a.kind === 'audio' ? (
													// ★ 音频无视觉缩略图，显示图标占位（保持网格视觉一致）
													<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 32, color: 'var(--vscode-descriptionForeground)' }}>🎵</div>
												) : (
													<img src={url} alt={assetFileName(a)} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
												)
											) : (
												<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>不可用</div>
											)}
											<div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
												<a
													href="#"
													title={a.favorite ? '取消收藏' : '收藏'}
													onClick={ev => { ev.preventDefault(); void toggleFavorite(a); }}
													style={{ textDecoration: 'none', fontSize: 13, color: a.favorite ? '#fbbf24' : 'rgba(255,255,255,.75)', background: 'rgba(0,0,0,.5)', borderRadius: 3, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
												>{a.favorite ? '★' : '☆'}</a>
												<a
													href="#"
													title={a.isDeleted ? '恢复' : '删除（进回收站）'}
													onClick={ev => { ev.preventDefault(); void toggleDeleted(a); }}
													style={{ textDecoration: 'none', fontSize: 11, color: 'rgba(255,255,255,.75)', background: 'rgba(0,0,0,.5)', borderRadius: 3, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
												>{a.isDeleted ? '↺' : '🗑'}</a>
											</div>
										</div>
										<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={assetFileName(a)}>
											{assetFileName(a)}
										</div>
										<div style={{ minHeight: 14 }}>
											{editingBoard === a.id ? (
												<input
													autoFocus
													value={boardDraft}
													onChange={e => setBoardDraft(e.target.value)}
													onKeyDown={e => {
														if (e.key === 'Enter') { void commitBoard(a); }
														if (e.key === 'Escape') { setEditingBoard(null); }
													}}
													onBlur={() => void commitBoard(a)}
													placeholder="分组名…"
													style={{ width: '100%', boxSizing: 'border-box', fontSize: 9, padding: '1px 4px', fontFamily: 'inherit', background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 3, outline: 'none' }}
												/>
											) : (
												<button
													title={a.board ? `分组：${a.board}（点击修改）` : '添加到分组（点击）'}
													onClick={() => { setEditingBoard(a.id); setBoardDraft(a.board ?? ''); }}
													style={{
														fontSize: 9, cursor: 'pointer', border: '1px solid rgba(99,102,241,.5)', borderRadius: 8,
														background: a.board ? 'rgba(99,102,241,.15)' : 'transparent',
														color: a.board ? '#a5b4fc' : 'var(--vscode-descriptionForeground)',
														padding: '1px 6px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit',
													}}
												>{a.board ? `# ${a.board}` : '+ 分组'}</button>
											)}
										</div>
										<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
											<span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)' }}>{formatTime(a.createdAt)}</span>
											<button
												title="下载"
												disabled={!url || busy.has(a.id)}
												onClick={() => void downloadAsset(a, url)}
												style={{ fontSize: 10, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', borderRadius: 3, background: 'transparent', color: 'var(--vscode-foreground)', padding: '1px 6px', fontFamily: 'inherit' }}
											>⤓</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
