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
import { loadComfyTVStages } from './comfyHost/comfyTvLoader';
import { loadComfyTVCaps } from './comfyHost/capsLoader';

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

	// Auto-load object_info + ComfyTV stages from a healthy runner, once.
	const loadCapabilities = React.useCallback(async (baseUrl: string) => {
		setLoadMsg('正在加载 ComfyUI 节点能力…');
		try {
			const obj = await loadObjectInfoNodes(baseUrl);
			const tv = await loadComfyTVStages(baseUrl);
			const caps = await loadComfyTVCaps(baseUrl);
			const parts: string[] = [];
			if (obj.registered.length) { parts.push(`object_info ${obj.registered.length} 个原生节点`); }
			if (tv.registered.length) { parts.push(`ComfyTV ${tv.registered.length} 个 stage`); }
			if (caps) { parts.push('caps 表单已启用'); }
			const issues: string[] = [];
			if (obj.error) { issues.push(`object_info: ${obj.error}`); }
			if (tv.error) { issues.push(`ComfyTV: ${tv.error}`); }
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

	const addRemote = React.useCallback(() => {
		if (!host.trim()) { setError('host 必填'); return; }
		const baseUrl = `http://${host.trim()}:${port.trim() || '8188'}`;
		const runner = createRemoteComfyRunner(`remote:${host.trim()}`, baseUrl, undefined, {
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
			registry.register(createDefaultLocalRunner());
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [registry]);

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

			{rows.map(r => (
				<div key={r.id} style={{
					display: 'flex', alignItems: 'center', gap: 8, padding: 8, borderRadius: 6,
					border: `1px solid ${r.ok ? 'rgba(34,197,94,.4)' : 'var(--vscode-panel-border)'}`,
					background: r.ok ? 'rgba(34,197,94,.05)' : 'transparent',
				}}>
					<span style={{ width: 8, height: 8, borderRadius: '50%', background: r.ok ? '#22c55e' : '#ef4444', flexShrink: 0 }} />
					<div style={{ flex: 1, minWidth: 0 }}>
						<div style={{ fontWeight: 600 }}>{r.kind === 'local' ? '本地 ComfyUI' : r.id}</div>
						<div style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)', fontFamily: 'monospace' }}>{r.baseUrl}</div>
					</div>
					<div style={{ fontSize: 10, color: r.ok ? '#22c55e' : '#ef4444', fontFamily: 'monospace' }}>
						{r.ok ? (r.version ?? '✓') : (r.error ?? '✗')}
					</div>
				</div>
			))}

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
