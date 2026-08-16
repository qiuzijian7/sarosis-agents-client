/*---------------------------------------------------------------------------------------------
 *  DependencyGuide — ComfyUI / 模型依赖检测与安装引导（画布右上角）。
 *
 *  目标机器未安装 ComfyUI / 缺少模型时，右上角给出引导入口：
 *    - ComfyUI 未安装   → 引导下载 Comfy Desktop / 配置已有安装路径
 *    - ComfyUI 已装未运行 → 一键启动（注册 install 任务跟踪就绪进度）
 *    - 模型下载         → 粘贴直链 + 文件名 → 主进程流式下载（download 任务实时进度）
 *
 *  进度统一写入 taskStore（安装/下载/出图三类），由 TaskProgressPanel 展示。
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { sendRequest } from '../../bridge/messageClient';
import { getTaskStore } from './comfyHost/taskStore';

interface DepsState {
	comfyuiInstalled: boolean;
	comfyuiRunning: boolean;
	comfyuiVersion?: string;
	pythonPath?: string;
	mainPyPath?: string;
	modelsDir: string;
	checkpoints: string[];
}

const MODEL_TYPES: Array<{ value: string; label: string }> = [
	{ value: 'checkpoints', label: 'Checkpoint' },
	{ value: 'diffusion_models', label: 'Diffusion' },
	{ value: 'loras', label: 'LoRA' },
	{ value: 'vae', label: 'VAE' },
	{ value: 'clip_vision', label: 'CLIP Vision' },
	{ value: 'controlnet', label: 'ControlNet' },
];

export function DependencyGuide(): React.JSX.Element | null {
	const [deps, setDeps] = React.useState<DepsState | null>(null);
	const [open, setOpen] = React.useState(false);
	const [launching, setLaunching] = React.useState(false);
	const [dlOpen, setDlOpen] = React.useState(false);
	const [dlUrl, setDlUrl] = React.useState('');
	const [dlFilename, setDlFilename] = React.useState('');
	const [dlType, setDlType] = React.useState('checkpoints');
	const [guideMsg, setGuideMsg] = React.useState<string | null>(null);

	const checkDeps = React.useCallback(async () => {
		try {
			const r = await sendRequest('comfy.checkDeps', {}, 8000) as {
				ok: boolean;
				comfyui?: { installed: boolean; running: boolean; version?: string; pythonPath?: string; mainPyPath?: string; baseUrl?: string };
				models?: { dir: string; checkpoints?: string[] };
			};
			if (r.ok) {
				setDeps({
					comfyuiInstalled: !!r.comfyui?.installed,
					comfyuiRunning: !!r.comfyui?.running,
					comfyuiVersion: r.comfyui?.version,
					pythonPath: r.comfyui?.pythonPath,
					mainPyPath: r.comfyui?.mainPyPath,
					modelsDir: r.models?.dir ?? '',
					checkpoints: r.models?.checkpoints ?? [],
				});
			}
		} catch { /* 主进程 IPC 不可用（非 Electron 环境）时静默 */ }
	}, []);

	React.useEffect(() => {
		void checkDeps();
		const timer = setInterval(() => void checkDeps(), 30_000);
		return () => clearInterval(timer);
	}, [checkDeps]);

	// 一键启动 ComfyUI（已安装但未运行），并注册 install 任务跟踪就绪进度。
	const launch = React.useCallback(async () => {
		setLaunching(true);
		const taskId = getTaskStore().add('install', 'ComfyUI', { message: '启动中…' });
		getTaskStore().start(taskId, '探测引擎…');
		try {
			const r = await sendRequest('comfy.launch', {}, 150_000) as {
				ok: boolean; alreadyRunning?: boolean; starting?: boolean; version?: string; error?: string;
			};
			if (r.ok) {
				if (r.alreadyRunning) {
					getTaskStore().finish(taskId, true, r.version ? `已运行 ${r.version}` : '已在运行');
				} else if (r.starting) {
					getTaskStore().update(taskId, { progress: -1, message: '后台启动中（加载 torch + 模型，约 1-3 分钟）…' });
					setGuideMsg('ComfyUI 正在后台启动，首次加载约 1-3 分钟，就绪后任务自动完成。');
					// 轮询直到就绪或超时（最长 3 分钟）。
					for (let i = 0; i < 60; i++) {
						await new Promise(res => setTimeout(res, 3000));
						const d = await sendRequest('comfy.checkDeps', {}, 8000) as { ok: boolean; comfyui?: { running: boolean; version?: string } };
						if (d.ok && d.comfyui?.running) {
							getTaskStore().finish(taskId, true, d.comfyui.version ? `就绪 ${d.comfyui.version}` : '就绪');
							setDeps(s => (s ? { ...s, comfyuiRunning: true, comfyuiVersion: d.comfyui?.version ?? s.comfyuiVersion } : s));
							setGuideMsg(null);
							return;
						}
					}
					getTaskStore().finish(taskId, false, '启动超时');
					setGuideMsg('启动超时：请查看 ComfyUI 终端日志，或到 Runner 面板重新检测。');
				} else {
					getTaskStore().finish(taskId, true, r.version ? `就绪 ${r.version}` : '已启动');
					await checkDeps();
				}
			} else {
				getTaskStore().finish(taskId, false, r.error ?? '启动失败');
				setGuideMsg(`启动失败：${r.error ?? '未知错误'}`);
			}
		} catch (err) {
			getTaskStore().finish(taskId, false, err instanceof Error ? err.message : String(err));
			setGuideMsg(`启动失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setLaunching(false);
		}
	}, [checkDeps]);

	// 提交模型下载：主进程流式下载，register download 任务 + 轮询进度回填。
	const download = React.useCallback(async () => {
		if (!dlUrl.trim() || !dlFilename.trim()) {
			setGuideMsg('请填写下载 URL 与文件名');
			return;
		}
		setGuideMsg(null);
		const taskId = getTaskStore().add('download', dlFilename.trim(), { message: '排队中…' });
		getTaskStore().start(taskId, '开始下载…');
		try {
			const r = await sendRequest('comfy.downloadModel', { url: dlUrl.trim(), filename: dlFilename.trim(), type: dlType }, 15_000) as { ok: boolean; taskId?: string; error?: string };
			if (!r.ok) {
				getTaskStore().finish(taskId, false, r.error ?? '下载启动失败');
				setGuideMsg(`下载失败：${r.error ?? '未知错误'}`);
				return;
			}
			const dlTaskId = r.taskId!;
			// 轮询主进程下载进度（1s），回填 taskStore 的 download 任务。
			for (let i = 0; i < 7200; i++) {
				await new Promise(res => setTimeout(res, 1000));
				const p = await sendRequest('comfy.getDownloadProgress', {}, 8000) as {
					ok: boolean; downloads?: Array<{ taskId: string; status: string; downloaded: number; total: number; message?: string }>;
				};
				const d = p.downloads?.find(x => x.taskId === dlTaskId);
				if (!d) { continue; }
				if (d.status === 'success') {
					getTaskStore().finish(taskId, true, '已保存到 models');
					setGuideMsg(`模型已下载：${dlFilename.trim()}`);
					await checkDeps();
					return;
				}
				if (d.status === 'error') {
					getTaskStore().finish(taskId, false, d.message ?? '下载失败');
					setGuideMsg(`下载失败：${d.message ?? '未知错误'}`);
					return;
				}
				const prog = d.total > 0 ? Math.round((d.downloaded / d.total) * 100) : -1;
				getTaskStore().update(taskId, { progress: prog, message: d.total > 0 ? `${(d.downloaded / 1_048_576).toFixed(1)}MB / ${(d.total / 1_048_576).toFixed(1)}MB` : `${(d.downloaded / 1_048_576).toFixed(1)}MB` });
			}
			getTaskStore().finish(taskId, false, '下载超时');
		} catch (err) {
			getTaskStore().finish(taskId, false, err instanceof Error ? err.message : String(err));
			setGuideMsg(`下载失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, [dlUrl, dlFilename, dlType, checkDeps]);

	// 依赖全部就绪且无引导消息时不打扰（面板隐藏）。
	const needInstall = deps && !deps.comfyuiInstalled;
	const needRun = deps && deps.comfyuiInstalled && !deps.comfyuiRunning;
	if (!needInstall && !needRun && !guideMsg) {
		return null;
	}

	return (
		<div style={{ position: 'relative', pointerEvents: 'auto' }}>
			<button
				type="button"
				onClick={() => setOpen(o => !o)}
				title={needInstall ? '未检测到 ComfyUI' : needRun ? 'ComfyUI 未运行' : '依赖'}
				style={{
					display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px',
					borderRadius: 6, fontSize: 11, cursor: 'pointer',
					border: `1px solid ${needInstall ? '#ef4444' : needRun ? '#eab308' : 'var(--vscode-panel-border)'}`,
					background: needInstall ? 'rgba(239,68,68,.1)' : needRun ? 'rgba(234,179,8,.1)' : 'var(--vscode-button-secondaryBackground, rgba(255,255,255,.08))',
					color: 'var(--vscode-foreground)',
				}}
			>
				<span style={{ fontSize: 12, lineHeight: 1 }}>{needInstall ? '⚠' : needRun ? '▶' : '✓'}</span>
				<span>{needInstall ? '安装 ComfyUI' : needRun ? '启动 ComfyUI' : '依赖'}</span>
			</button>

			{open && (
				<div style={{
					position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 340, maxHeight: 420,
					overflowY: 'auto', borderRadius: 8, padding: 10,
					border: '1px solid var(--vscode-panel-border)',
					background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #1e1e1e))',
					boxShadow: '0 8px 24px rgba(0,0,0,.4)', zIndex: 1000, fontSize: 11,
				}}>
					<div style={{ fontWeight: 600, marginBottom: 6 }}>ComfyUI 依赖</div>

					{/* 状态概览 */}
					<div style={{ color: 'var(--vscode-descriptionForeground)', lineHeight: 1.7 }}>
						<div>ComfyUI：{deps?.comfyuiInstalled ? (deps.comfyuiRunning ? `✓ 已运行${deps.comfyuiVersion ? `（${deps.comfyuiVersion}）` : ''}` : '已安装 · 未运行') : '未安装'}</div>
						<div>模型目录：<span style={{ fontFamily: 'monospace', fontSize: 10 }}>{deps?.modelsDir ?? '—'}</span></div>
						<div>本地 checkpoint：{deps?.checkpoints.length ?? 0} 个</div>
					</div>

					{/* ComfyUI 未安装 → 引导 */}
					{needInstall && (
						<div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)' }}>
							<div style={{ fontWeight: 600, marginBottom: 4 }}>安装指引</div>
							<ol style={{ margin: 0, paddingLeft: 16, lineHeight: 1.8, color: 'var(--vscode-descriptionForeground)' }}>
								<li>推荐下载 <b>Comfy Desktop</b>（官方桌面版，含 Python 环境与模型管理）：<span style={{ fontFamily: 'monospace', fontSize: 10 }}>https://www.comfy.org/download</span></li>
								<li>或已有 ComfyUI 安装：点击工具栏「🖥 Runner」→「EXE 路径」配置 python / main.py 路径。</li>
								<li>安装完成后本面板会自动检测（或点「启动」）。</li>
							</ol>
						</div>
					)}

					{/* 已安装未运行 → 启动 */}
					{needRun && (
						<button
							type="button"
							disabled={launching}
							onClick={() => void launch()}
							style={{
								marginTop: 8, width: '100%', padding: '6px', borderRadius: 6, fontSize: 12, fontWeight: 600,
								border: '1px solid #22c55e', background: '#22c55e', color: '#fff',
								cursor: launching ? 'wait' : 'pointer', opacity: launching ? 0.6 : 1,
							}}
						>
							{launching ? '启动中…' : '▶ 启动 ComfyUI（--enable-cors-header）'}
						</button>
					)}

					{/* 模型下载 */}
					<div style={{ marginTop: 10, borderTop: '1px solid var(--vscode-panel-border)', paddingTop: 8 }}>
						<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
							<span style={{ fontWeight: 600 }}>模型下载</span>
							<button type="button" onClick={() => setDlOpen(o => !o)} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-foreground)' }}>
								{dlOpen ? '收起' : '展开'}
							</button>
						</div>
						{dlOpen && (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
								<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>从 HuggingFace / Civitai 复制模型直链（.safetensors），选择类型后下载到模型目录。</div>
								<input value={dlUrl} onChange={e => setDlUrl(e.target.value)} placeholder="下载 URL（https://…）"
									style={{ padding: '4px 6px', fontSize: 10, borderRadius: 4, border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))', background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)' }} />
								<input value={dlFilename} onChange={e => setDlFilename(e.target.value)} placeholder="文件名（如 sd_xl_base_1.0.safetensors）"
									style={{ padding: '4px 6px', fontSize: 10, borderRadius: 4, border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))', background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)' }} />
								<select value={dlType} onChange={e => setDlType(e.target.value)}
									style={{ padding: '4px 6px', fontSize: 10, borderRadius: 4, border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))', background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)' }}>
									{MODEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
								</select>
								<button type="button" onClick={() => void download()} style={{ padding: '5px', borderRadius: 6, fontSize: 11, fontWeight: 600, border: '1px solid #eab308', background: 'rgba(234,179,8,.12)', color: '#fbbf24', cursor: 'pointer' }}>
									开始下载
								</button>
							</div>
						)}
					</div>

					{guideMsg && (
						<div style={{ marginTop: 8, padding: 6, borderRadius: 4, background: 'rgba(59,130,246,.08)', color: '#93c5fd', fontSize: 10, lineHeight: 1.5 }}>
							{guideMsg}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
