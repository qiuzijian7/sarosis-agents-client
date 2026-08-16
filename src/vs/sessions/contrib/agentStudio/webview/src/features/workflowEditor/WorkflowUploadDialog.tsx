/*---------------------------------------------------------------------------------------------
 *  WorkflowUploadDialog — ImageStage 的 ⬆ Upload workflow / 🔗 Link workflow 弹窗。
 *
 *  对齐 ComfyTV 的 workflowUpload.ts + openLinkWorkflow.ts：
 *    - Upload tab：本地文件选择 → 读 JSON → POST /comfytv/workflows/import
 *    - Link tab：GET /comfytv/workflows/native → 树状列表 → 点击 → POST /comfytv/workflows/link
 *  成功后 onImported(label) 回调，由调用方 addWorkflowOptionEverywhere 刷新 options。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { importWorkflow, listNativeWorkflows, linkWorkflow, type NativeWorkflow } from './comfyHost/workflowManager';

export interface WorkflowUploadDialogProps {
	baseUrl: string;
	fetchImpl: typeof fetch;
	kind: string;
	nodeType: string;
	initialTab?: Tab;
	onClose: () => void;
	onImported: (label: string) => void;
}

type Tab = 'upload' | 'link';

export function WorkflowUploadDialog({ baseUrl, fetchImpl, kind, nodeType, initialTab = 'upload', onClose, onImported }: WorkflowUploadDialogProps): React.JSX.Element {
	const [tab, setTab] = React.useState<Tab>(initialTab);
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState<string | null>(null);
	const [error, setError] = React.useState<string | null>(null);

	// Link tab state
	const [nativeList, setNativeList] = React.useState<NativeWorkflow[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [linkBusyPath, setLinkBusyPath] = React.useState<string | null>(null);

	const loadNative = React.useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const list = await listNativeWorkflows(baseUrl, fetchImpl, kind);
			setNativeList(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [baseUrl, fetchImpl, kind]);

	React.useEffect(() => {
		if (tab === 'link') { void loadNative(); }
	}, [tab, loadNative]);

	const handleUpload = React.useCallback(async (file: File) => {
		setBusy(true);
		setMsg(null);
		setError(null);
		try {
			const text = await file.text();
			// ComfyTV: 非 JSON 直接报错，不调后端。
			try { JSON.parse(text); } catch { setError('该文件不是有效 JSON'); setBusy(false); return; }
			const res = await importWorkflow(baseUrl, fetchImpl, kind, file.name, text);
			if (res.ok && res.label) {
				setMsg(`已导入 "${res.label}"`);
				onImported(res.label);
			} else {
				setError(res.error ?? 'Workflow 导入失败');
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [baseUrl, fetchImpl, kind, onImported]);

	const handleLink = React.useCallback(async (wf: NativeWorkflow) => {
		setLinkBusyPath(wf.path);
		setError(null);
		try {
			const res = await linkWorkflow(baseUrl, fetchImpl, kind, wf.path);
			if (res.ok && res.label) {
				setMsg(`已链接 "${res.label}"`);
				onImported(res.label);
				// 刷新列表，标记 linked 状态。
				await loadNative();
			} else {
				setError(res.error ?? 'Workflow 链接失败');
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLinkBusyPath(null);
		}
	}, [baseUrl, fetchImpl, kind, onImported, loadNative]);

	const inputRef = React.useRef<HTMLInputElement | null>(null);

	return (
		<div style={{
			position: 'fixed', inset: 0, zIndex: 3000,
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			background: 'rgba(0,0,0,.45)',
		}} onClick={onClose}>
			<div
				onClick={e => e.stopPropagation()}
				style={{
					width: 420, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
					borderRadius: 10, overflow: 'hidden',
					border: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e))',
					boxShadow: '0 16px 48px rgba(0,0,0,.55)',
					fontSize: 12,
				}}
			>
				{/* Header */}
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--vscode-panel-border)' }}>
					<div>
						<div style={{ fontWeight: 600 }}>Workflow</div>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>{nodeType} · kind {kind}</div>
					</div>
					<button type="button" onClick={onClose} style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--vscode-foreground)', fontSize: 16, lineHeight: 1 }}>×</button>
				</div>

				{/* Tabs */}
				<div style={{ display: 'flex', borderBottom: '1px solid var(--vscode-panel-border)' }}>
					{([
						{ key: 'upload' as Tab, label: '⬆ Upload workflow' },
						{ key: 'link' as Tab, label: '🔗 Link workflow' },
					]).map(t => (
						<button
							key={t.key}
							type="button"
							onClick={() => setTab(t.key)}
							style={{
								flex: 1, padding: '7px', cursor: 'pointer', fontSize: 11,
								border: 'none', background: tab === t.key ? 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))' : 'transparent',
								color: tab === t.key ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
								borderBottom: tab === t.key ? '2px solid #3b82f6' : '2px solid transparent',
							}}
						>
							{t.label}
						</button>
					))}
				</div>

				{/* Body */}
				<div style={{ padding: 12, overflowY: 'auto', flex: 1 }}>
					{tab === 'upload' && (
						<div>
							<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 8, lineHeight: 1.6 }}>
								上传 ComfyUI 画布 JSON（.json，含 nodes/links），导入为 {kind} 的一个新 workflow。导入后需在 ComfyTV 中打开一次才会生成 api_json（首次运行时自动准备）。
							</div>
							<button
								type="button"
								disabled={busy}
								onClick={() => inputRef.current?.click()}
								style={{
									width: '100%', padding: '10px', borderRadius: 6, cursor: busy ? 'wait' : 'pointer',
									border: '1px dashed var(--vscode-panel-border)', background: 'transparent',
									color: 'var(--vscode-foreground)', fontSize: 12, fontWeight: 600, opacity: busy ? .6 : 1,
								}}
							>
								{busy ? '导入中…' : '选择 JSON 文件'}
							</button>
							<input
								ref={inputRef}
								type="file"
								accept=".json,application/json"
								style={{ display: 'none' }}
								onChange={e => {
									const f = e.target.files?.[0];
									if (f) { void handleUpload(f); }
									e.target.value = '';
								}}
							/>
						</div>
					)}

					{tab === 'link' && (
						<div>
							<div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 8, lineHeight: 1.6 }}>
								从 ComfyUI 已保存的 workflow 列表中选择一个链接为 {kind} workflow。
							</div>
							{loading && <div style={{ padding: 12, textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>加载中…</div>}
							{!loading && nativeList.length === 0 && (
								<div style={{ padding: 12, textAlign: 'center', color: 'var(--vscode-descriptionForeground)', fontSize: 11 }}>
									没有可链接的 workflow（ComfyUI 的 user/default/workflows 目录为空）。
								</div>
							)}
							{!loading && nativeList.length > 0 && (
								<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
									{nativeList.map(wf => (
										<button
											key={wf.path}
											type="button"
											disabled={linkBusyPath === wf.path}
											onClick={() => void handleLink(wf)}
											style={{
												display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
												borderRadius: 6, cursor: linkBusyPath === wf.path ? 'wait' : 'pointer', fontSize: 11,
												border: '1px solid var(--vscode-panel-border)', background: 'transparent',
												color: 'var(--vscode-foreground)', textAlign: 'left',
											}}
										>
											<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace', fontSize: 10 }}>
												{wf.name}
											</span>
											{wf.is_linked && (
												<span style={{ flexShrink: 0, fontSize: 9, padding: '1px 6px', borderRadius: 3, background: 'rgba(34,197,94,.15)', color: '#22c55e' }}>已链接</span>
											)}
											{linkBusyPath === wf.path && (
												<span style={{ flexShrink: 0, fontSize: 10, color: '#3b82f6' }}>…</span>
											)}
										</button>
									))}
								</div>
							)}
						</div>
					)}

					{msg && <div style={{ marginTop: 10, padding: 8, borderRadius: 5, background: 'rgba(34,197,94,.12)', color: '#4ade80', fontSize: 11 }}>{msg}</div>}
					{error && <div style={{ marginTop: 10, padding: 8, borderRadius: 5, background: 'rgba(239,68,68,.12)', color: '#fca5a5', fontSize: 11 }}>{error}</div>}
				</div>

				{/* Footer */}
				<div style={{ padding: '8px 14px', borderTop: '1px solid var(--vscode-panel-border)', textAlign: 'right' }}>
					<button type="button" onClick={onClose} style={{ padding: '5px 14px', borderRadius: 5, cursor: 'pointer', fontSize: 11, border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))', color: 'var(--vscode-foreground)' }}>
						关闭
					</button>
				</div>
			</div>
		</div>
	);
}
