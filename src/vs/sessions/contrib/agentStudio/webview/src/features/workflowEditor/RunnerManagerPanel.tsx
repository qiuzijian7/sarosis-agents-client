/*---------------------------------------------------------------------------------------------
 *  RunnerManagerPanel — ComfyUI Runner 管理面板（对齐 ComfyTV ServersPanel）。
 *
 *  Lists runners from the ComfyRunnerRegistry, runs connection tests, and lets
 *  the user add a remote runner (host/port/token). The registry instance is
 *  provided by the caller (created once in the editor).
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import {
	ComfyRunnerRegistry,
	createRemoteComfyRunner,
	createDefaultLocalRunner,
	collectRunnerRows,
	type RunnerRow,
} from './comfyHost/comfyRunner';
import { loadObjectInfoNodes } from './comfyHost/comfyObjectInfoLoader';
import { useRunnerStatus } from './comfyHost/runnerStatusStore';
import { createComfyFetch, getComfyCorsMode, reprobeComfyCors, subscribeComfyCors, sendRequest } from '../../bridge/messageClient';

interface RunnerManagerPanelProps {
	registry: ComfyRunnerRegistry;
	onRunnerResolved?: (preference: string) => void;
}

export function RunnerManagerPanel({ registry, onRunnerResolved }: RunnerManagerPanelProps): React.JSX.Element {
	const [rows, setRows] = React.useState<RunnerRow[]>([]);
	const [testing, setTesting] = React.useState(false);
	const [host, setHost] = React.useState('');
	const [port, setPort] = React.useState('8188');
	const [token, setToken] = React.useState('');
	const [preference, setPreference] = React.useState('auto');
	const [error, setError] = React.useState<string | null>(null);
	const [loadMsg, setLoadMsg] = React.useState<string | null>(null);
	const [, setCorsTick] = React.useState(0);
	const [launching, setLaunching] = React.useState(false);
	const [launchMsg, setLaunchMsg] = React.useState<string | null>(null);
	const [showPathConfig, setShowPathConfig] = React.useState(false);
	const [resolvedPaths, setResolvedPaths] = React.useState<{ pythonPath?: string; mainPyPath?: string; source?: string } | null>(null);
	const [editPy, setEditPy] = React.useState('');
	const [editMain, setEditMain] = React.useState('');

	// 方案A：直连优先/代理兜底（createComfyFetch 按 origin 探测 CORS 后路由）。
	const comfyFetchRef = React.useRef<typeof fetch | null>(null);
	if (!comfyFetchRef.current) { comfyFetchRef.current = createComfyFetch('http://127.0.0.1:8188'); }

	// Auto-load object_info from a healthy runner, once.
	// 完全不依赖 ComfyTV 后端 API：stage 节点/表单/出图模板已内置，无需 /comfytv/stages、/comfytv/caps。
	const loadCapabilities = React.useCallback(async (baseUrl: string) => {
		setLoadMsg('正在加载 ComfyUI 节点能力…');
		try {
			const obj = await loadObjectInfoNodes(baseUrl, comfyFetchRef.current as never);
			const parts: string[] = [];
			if (obj.registered.length) { parts.push(`object_info ${obj.registered.length} 个原生节点`); }
			const issues: string[] = [];
			if (obj.error) { issues.push(`object_info: ${obj.error}`); }
			setLoadMsg(parts.length ? `已加载 · ${parts.join(' / ')}` : (issues.length ? issues.join('；') : 'runner 无可用能力接口'));
		} catch (err) {
			setLoadMsg(`加载失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, []);

	const refresh = React.useCallback(async () => {
		setTesting(true);
		setError(null);
		try {
			const r = await collectRunnerRows(registry.list());
			setRows(r);
			const healthy = r.find(x => x.ok);
			if (healthy) {
				void loadCapabilities(healthy.baseUrl);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTesting(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loadCapabilities]);

	React.useEffect(() => { void refresh(); }, [refresh]);

	// ★ 状态同步（修「Runner 面板在线 / 节点 UI 未连接」不一致）：
	// 面板只在 mount 时探测一次，运行中 ComfyUI 掉线后 `runSingleSchemaNode` 探测
	// 失败会 `getRunnerStatusStore().setReady(false)`，但面板不订阅这个 store →
	// 绿点仍「在线」，误导用户。这里订阅全局 ready，ready true→false 时自动重新
	// 检测，让「在线」立即变「离线」。
	const runnerStatus = useRunnerStatus();
	const prevReadyRef = React.useRef<boolean | undefined>(undefined);
	React.useEffect(() => {
		if (prevReadyRef.current === true && runnerStatus.ready === false) {
			void refresh();
		}
		prevReadyRef.current = runnerStatus.ready;
	}, [runnerStatus.ready, refresh]);

	const addRemote = React.useCallback(() => {
		if (!host.trim()) { setError('host 必填'); return; }
		const baseUrl = `http://${host.trim()}:${port.trim() || '8188'}`;
		const runner = createRemoteComfyRunner(`remote:${host.trim()}`, baseUrl, comfyFetchRef.current as never, {
			token: token.trim() || undefined,
		});
		registry.register(runner);
		setHost(''); setToken(''); setError(null);
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registry, host, port, token, refresh]);

	// Ensure a local runner exists for 'auto' fallback.
	React.useEffect(() => {
		if (!registry.get('local')) {
			registry.register(createDefaultLocalRunner(comfyFetchRef.current as never));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registry]);

	// 订阅各 runner 的 CORS 模式变化 → 刷新连接模式徽标与引导。
	React.useEffect(() => {
		const unsubs = rows.map(r => subscribeComfyCors(runnerOrigin(r.baseUrl), () => setCorsTick(t => t + 1)));
		return () => { for (const u of unsubs) { u(); } };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rows]);

	const copyCorsCommand = React.useCallback(async () => {
		const cmd = 'python main.py --enable-cors-header';
		try {
			await navigator.clipboard.writeText(cmd);
			setError(`已复制启动命令：${cmd}`);
		} catch {
			setError(`复制失败，请手动复制：${cmd}`);
		}
	}, []);

	const reProbe = React.useCallback(async (baseUrl: string) => {
		await reprobeComfyCors(runnerOrigin(baseUrl));
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	// 一键启动 ComfyUI（--enable-cors-header，方案A 直连前置）。主进程 comfy:launch。
	const launchComfy = React.useCallback(async () => {
		setLaunching(true);
		setLaunchMsg(null);
		try {
			const r = await sendRequest('comfy.launch', {}, 150_000) as {
				ok: boolean;
				alreadyRunning?: boolean;
				starting?: boolean;
				pid?: number;
				version?: string;
				error?: string;
				pythonPath?: string;
				mainPyPath?: string;
			};
			if (r.ok) {
				if (r.alreadyRunning) {
					setLaunchMsg(`ComfyUI 已在运行${r.version ? `（${r.version}）` : ''}。若仍显示「代理」模式，请在 ComfyUI 启动参数中开启 --enable-cors-header 后重启。`);
				} else if (r.starting) {
					setLaunchMsg(`ComfyUI 正在后台启动${r.pid ? `（PID ${r.pid}）` : ''}。首次加载 torch + 模型可能需要 1-3 分钟，就绪后点击「⟳ 重新检测」即可。`);
				} else {
					setLaunchMsg(`已启动 ComfyUI${r.pid ? `（PID ${r.pid}）` : ''}${r.version ? ` · ${r.version}` : ''}，正在探测直连…`);
				}
				// 把后端实际使用的路径回填设置（自动探测成功时也持久化，下次零延迟）
				if (r.pythonPath || r.mainPyPath) {
					void sendRequest('comfy.setLaunchPaths', { pythonPath: r.pythonPath, mainPyPath: r.mainPyPath }, 5000);
				}
				void refresh();
			} else {
				setLaunchMsg(`启动失败：${r.error ?? '未知错误'}`);
			}
		} catch (err) {
			setLaunchMsg(`启动失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setLaunching(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	// 获取主进程解析的当前路径（含 overrides 来源）。用于 UI 显示与编辑入口。
	const fetchResolvedPaths = React.useCallback(async () => {
		try {
			const r = await sendRequest('comfy.getLaunchPaths', {}, 5000) as { ok: boolean; pythonPath?: string; mainPyPath?: string; source?: string; overrides?: { pythonPath: string; mainPyPath: string } };
			if (r.ok) {
				setResolvedPaths({ pythonPath: r.pythonPath, mainPyPath: r.mainPyPath, source: r.source });
				setEditPy(r.overrides?.pythonPath ?? '');
				setEditMain(r.overrides?.mainPyPath ?? '');
			}
		} catch { /* 忽略 */ }
	}, []);

	React.useEffect(() => {
		if (showPathConfig) { void fetchResolvedPaths(); }
	}, [showPathConfig, fetchResolvedPaths]);

	const savePaths = React.useCallback(async () => {
		await sendRequest('comfy.setLaunchPaths', { pythonPath: editPy, mainPyPath: editMain }, 5000);
		setShowPathConfig(false);
		void fetchResolvedPaths();
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editPy, editMain, fetchResolvedPaths, refresh]);

	const clearPaths = React.useCallback(async () => {
		setEditPy('');
		setEditMain('');
		await sendRequest('comfy.setLaunchPaths', { pythonPath: '', mainPyPath: '' }, 5000);
		void fetchResolvedPaths();
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetchResolvedPaths, refresh]);

	const resolve = React.useCallback(() => {
		const target = registry.resolve(preference);
		if (target) {
			setError(null);
			onRunnerResolved?.(target.id);
		} else {
			setError(`无法解析 runner: ${preference}（请先添加）`);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registry, preference, onRunnerResolved]);

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, fontSize: 12 }}>
			<div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)' }}>
				ComfyUI Runners
			</div>

			{rows.length === 0 && !testing && (
				<div style={{ color: 'var(--vscode-descriptionForeground)' }}>未发现 runner。检测本地 localhost:8188 或添加远程。</div>
			)}

			{rows.map(r => {
				const mode = getComfyCorsMode(runnerOrigin(r.baseUrl));
				const modeInfo = mode === 'direct'
					? { label: '直连', color: '#22c55e' }
					: mode === 'proxied'
						? { label: '代理', color: '#eab308' }
						: { label: '探测中', color: 'var(--vscode-descriptionForeground)' };
				return (
					<div key={r.id}>
						<div style={{
							display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6,
							border: `1px solid ${r.ok ? 'rgba(34,197,94,.4)' : 'var(--vscode-panel-border)'}`,
							background: r.ok ? 'rgba(34,197,94,.05)' : 'transparent',
						}}>
							<span style={{ width: 8, height: 8, borderRadius: '50%', background: r.ok ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
							<div style={{ flex: 1, minWidth: 0 }}>
								<div style={{ fontWeight: 600 }}>{r.kind === 'local' ? '本地 ComfyUI' : r.id}</div>
								<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}>{r.baseUrl}</div>
							</div>
							<span style={{ fontSize: 9, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 3, border: `1px solid ${modeInfo.color}`, color: modeInfo.color, whiteSpace: 'nowrap' }}>
								{modeInfo.label}
							</span>
							<div style={{ fontSize: 10, color: r.ok ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>
								{r.ok ? (r.version ?? '✓') : (r.error ?? '✗')}
							</div>
						</div>
						{mode === 'proxied' && r.ok && (
							<div style={{ marginTop: 4, padding: '6px 8px', fontSize: 10, color: 'var(--vscode-descriptionForeground)', background: 'rgba(234,179,8,.08)', border: '1px solid rgba(234,179,8,.3)', borderRadius: 4 }}>
								<div>当前走主进程代理。开启 ComfyUI 跨源后切换直连（更快、支持大图直读）：</div>
								<div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
									<code style={{ flex: 1, fontSize: 10, fontFamily: 'Consolas, monospace', background: 'rgba(0,0,0,.25)', padding: '2px 4px', borderRadius: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
										python main.py --enable-cors-header
									</code>
									<button onClick={() => void copyCorsCommand()} style={smallBtnStyle} title="复制启动命令">复制</button>
									<button onClick={() => void reProbe(r.baseUrl)} style={smallBtnStyle} title="重新探测直连">重新探测</button>
								</div>
							</div>
						)}
					</div>
				);
			})}

			<div style={{ display: 'flex', gap: 6 }}>
				<input
					value={host}
					onChange={e => setHost(e.target.value)}
					placeholder="远程 host"
					style={{ flex: 1, padding: '5px 8px', fontSize: 11, background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 4 }}
				/>
				<input
					value={port}
					onChange={e => setPort(e.target.value)}
					placeholder="端口"
					style={{ width: 64, padding: '5px 8px', fontSize: 11, background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 4 }}
				/>
			</div>
			<input
				value={token}
				onChange={e => setToken(e.target.value)}
				placeholder="Bearer token（可选）"
				style={{ padding: '5px 8px', fontSize: 11, background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: 4 }}
			/>
			<button onClick={addRemote} style={btnStyle}>＋ 添加远程 Runner</button>

			<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
				<select
					value={preference}
					onChange={e => setPreference(e.target.value)}
					style={{ flex: 1, padding: '5px 8px', fontSize: 11, background: 'var(--vscode-dropdown-background)', color: 'var(--vscode-foreground)', border: '1px solid var(--vscode-dropdown-border)', borderRadius: 4 }}
				>
					<option value="auto">auto（本地优先）</option>
					{rows.map(r => <option key={r.id} value={r.kind === 'local' ? 'local' : r.id}>{r.id}</option>)}
				</select>
				<button onClick={resolve} style={{ ...btnStyle, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}>
					使用
				</button>
			</div>

			<div style={{ display: 'flex', gap: 6 }}>
				<button onClick={() => void refresh()} style={btnStyle} disabled={testing}>
					{testing ? '检测中…' : '⟳ 重新检测'}
				</button>
				<button onClick={() => void launchComfy()} style={{ ...btnStyle, flex: 1, borderColor: 'rgba(34,197,94,.4)' }} disabled={launching}>
					{launching ? '启动中…' : '▶ 启动 ComfyUI（--enable-cors-header）'}
				</button>
			</div>

			{launchMsg && (
				<div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11, padding: '4px 6px', background: 'rgba(34,197,94,.06)', border: '1px solid rgba(34,197,94,.3)', borderRadius: 4 }}>
					{launchMsg}
				</div>
			)}

			<div style={{ marginTop: 4 }}>
				<button onClick={() => setShowPathConfig(v => !v)} style={{ ...smallBtnStyle, width: '100%' }}>
					{showPathConfig ? '× 收起' : '⚙ EXE 路径（自动解析，已支持配置）'}
				</button>
				{showPathConfig && (
					<div style={{ marginTop: 6, padding: 8, background: 'rgba(0,0,0,.15)', border: '1px solid var(--vscode-panel-border)', borderRadius: 4 }}>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 6 }}>
							来源：<span style={{ color: resolvedPaths?.source === 'auto' ? '#22c55e' : 'var(--vscode-textLink-foreground)' }}>
								{resolvedPaths?.source === 'auto' ? '自动解析' : resolvedPaths?.source === 'override' ? '用户配置' : resolvedPaths?.source ?? '未解析'}
							</span>
							{resolvedPaths?.source === 'auto' && <span>（无设置/环境变量覆盖）</span>}
						</div>
						<div style={{ fontSize: 10, fontFamily: 'Consolas, monospace', color: 'var(--vscode-descriptionForeground)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={resolvedPaths?.pythonPath ?? ''}>
							py: {resolvedPaths?.pythonPath ?? '—'}
						</div>
						<div style={{ fontSize: 10, fontFamily: 'Consolas, monospace', color: 'var(--vscode-descriptionForeground)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={resolvedPaths?.mainPyPath ?? ''}>
							main.py: {resolvedPaths?.mainPyPath ?? '—'}
						</div>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>python.exe（留空=自动解析）</div>
						<input value={editPy} onChange={e => setEditPy(e.target.value)} placeholder="C:\\Python311\\python.exe" style={pathInputStyle} />
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', margin: '6px 0 2px' }}>main.py（留空=自动解析）</div>
						<input value={editMain} onChange={e => setEditMain(e.target.value)} placeholder="D:\\ComfyUI\\main.py" style={pathInputStyle} />
						<div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
							<button onClick={() => void savePaths()} style={{ ...smallBtnStyle, flex: 1, borderColor: 'rgba(34,197,94,.4)' }}>保存</button>
							<button onClick={() => void clearPaths()} style={smallBtnStyle} title="清空配置回到自动解析">清除</button>
						</div>
						<div style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', marginTop: 6, lineHeight: 1.4 }}>
							优先级：环境变量 SAROS_COMFYUI_PYTHON/MAIN → 此处配置 → 自动解析。也可在设置中搜索 sarosis.comfyui 直接编辑。
						</div>
					</div>
				)}
			</div>

			{loadMsg && (
				<div style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 11, padding: '4px 6px', background: 'rgba(255,255,255,.04)', borderRadius: 4 }}>
					{loadMsg}
				</div>
			)}

			{error && <div style={{ color: '#ef4444', fontSize: 11 }}>{error}</div>}
		</div>
	);
}

const btnStyle: React.CSSProperties = {
	padding: '5px 10px', fontSize: 11, cursor: 'pointer',
	background: 'var(--vscode-button-secondaryBackground)',
	color: 'var(--vscode-button-secondaryForeground)',
	border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 4,
	fontFamily: 'inherit',
};

/** baseUrl → origin（CORS 缓存键）。 */
function runnerOrigin(baseUrl: string): string {
	try { return new URL(baseUrl).origin; } catch { return baseUrl; }
}

const smallBtnStyle: React.CSSProperties = {
	padding: '2px 6px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit',
	background: 'var(--vscode-button-secondaryBackground)',
	color: 'var(--vscode-button-secondaryForeground)',
	border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3,
};

const pathInputStyle: React.CSSProperties = {
	width: '100%', fontSize: 10, fontFamily: 'Consolas, monospace',
	padding: '3px 5px', background: 'var(--vscode-input-background)',
	color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border, transparent)', borderRadius: 3,
	boxSizing: 'border-box',
};
