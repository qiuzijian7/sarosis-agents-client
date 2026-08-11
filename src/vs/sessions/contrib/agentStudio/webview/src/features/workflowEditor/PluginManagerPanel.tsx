/*---------------------------------------------------------------------------------------------
 *  Plugin Manager Panel — install / uninstall / reload URL plugins (P2).
 *
 *  Docs: docs/Agent-画布编排设计方案.md P2 → 5.1 URL 动态插件节点.
 *
 *  Persistence: the installed-plugin manifest list lives in localStorage
 *  (`saros.canvasPlugins.v1`). On mount the panel re-loads every stored plugin
 *  (idempotent — loadPlugin replaces on same pluginId). Install validates the
 *  manifest URL by fetching it (the module's register() defines nodes).
 *--------------------------------------------------------------------------------------------*/
import { useEffect, useState } from 'react';
import {
	loadPlugin,
	unloadPlugin,
	isPluginLoaded,
	getLoadedPluginIds,
	validatePluginManifest,
	type PluginManifest,
} from './comfyHost/pluginLoader';

const STORAGE_KEY = 'saros.canvasPlugins.v1';

export interface PluginManagerPanelProps {
	onClose: () => void;
	/** Overridable loader (tests) — defaults to loadPlugin. */
	loader?: (m: PluginManifest) => Promise<{ registered: string[]; replaced: boolean }>;
	/** Overridable storage (tests) — defaults to localStorage. */
	storage?: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
	};
}

function readStoredManifests(storage: PluginManagerPanelProps['storage']): PluginManifest[] {
	const raw = storage?.getItem(STORAGE_KEY);
	if (!raw) { return []; }
	try {
		const arr = JSON.parse(raw) as PluginManifest[];
		return Array.isArray(arr) ? arr.filter(m => validatePluginManifest(m) === null) : [];
	} catch {
		return [];
	}
}

export function PluginManagerPanel(props: PluginManagerPanelProps) {
	const { onClose } = props;
	const storage = props.storage ?? {
		getItem: (k: string) => localStorage.getItem(k),
		setItem: (k: string, v: string) => localStorage.setItem(k, v),
	};
	const loader = props.loader ?? ((m) => loadPlugin(m));

	const [url, setUrl] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [manifests, setManifests] = useState<PluginManifest[]>(() => readStoredManifests(storage));
	const [loadedIds, setLoadedIds] = useState<string[]>(() => getLoadedPluginIds());

	// On mount: re-load every stored plugin (idempotent reload).
	useEffect(() => {
		void (async () => {
			for (const m of readStoredManifests(storage)) {
				try { await loader(m); } catch { /* keep going; error surfaces in list */ }
			}
			setLoadedIds(getLoadedPluginIds());
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const persist = (list: PluginManifest[]) => {
		storage.setItem(STORAGE_KEY, JSON.stringify(list));
		setManifests(list);
	};

	const handleInstall = async () => {
		const trimmed = url.trim();
		if (!/^https?:\/\//.test(trimmed)) {
			setError('请输入以 http(s):// 开头的插件 URL');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			// The manifest is derived from the URL's plugin script — the module
			// register() calls defineNode and we synthesize a manifest. A robust
			// install flow would fetch a manifest.json; here we keep the pluginId
			// convention of "<hostname>-<basename>".
			const id = pluginIdFromUrl(trimmed);
			const manifest: PluginManifest = {
				pluginId: id,
				name: id,
				version: '1.0.0',
				scriptURL: trimmed,
			};
			const err = validatePluginManifest(manifest);
			if (err) { setError(err); return; }
			const r = await loader(manifest);
			const existing = manifests.filter(m => m.pluginId !== id);
			persist([...existing, manifest]);
			setUrl('');
			setLoadedIds(getLoadedPluginIds());
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			void r;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleUninstall = async (manifest: PluginManifest) => {
		unloadPlugin(manifest.pluginId);
		persist(manifests.filter(m => m.pluginId !== manifest.pluginId));
		setLoadedIds(getLoadedPluginIds());
	};

	return (
		<div style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
			<div style={{
				width: 460, maxHeight: '70vh', overflowY: 'auto',
				backgroundColor: 'var(--vscode-editor-background)', border: '1px solid #333',
				borderRadius: '8px', padding: 16,
			}}>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
					<h3 style={{ margin: 0, fontSize: 14, color: 'var(--vscode-foreground)' }}>画布插件</h3>
					<button onClick={onClose} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16 }}>✕</button>
				</div>

				<div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
					<input
						value={url}
						onChange={e => setUrl(e.target.value)}
						placeholder="https://example.com/plugin.js"
						style={{ flex: 1, padding: '6px 8px', border: '1px solid #444', borderRadius: 4, background: 'transparent', color: 'var(--vscode-foreground)', fontSize: 12 }}
					/>
					<button
						onClick={() => void handleInstall()}
						disabled={busy}
						style={{ padding: '6px 12px', border: '1px solid #3b82f6', borderRadius: 4, background: 'transparent', color: '#60a5fa', cursor: 'pointer', fontSize: 12 }}>
						{busy ? '加载中…' : '安装'}
					</button>
				</div>

				{error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>{error}</div>}

				{manifests.length === 0 ? (
					<div style={{ color: '#888', fontSize: 12 }}>暂无已安装插件。输入插件脚本 URL 后点击「安装」。</div>
				) : (
					<ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
						{manifests.map(m => {
							const loaded = loadedIds.includes(m.pluginId);
							return (
								<li key={m.pluginId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #2a2a2a' }}>
									<div>
										<div style={{ fontSize: 12, color: 'var(--vscode-foreground)' }}>{m.name}</div>
										<div style={{ fontSize: 11, color: '#777' }}>{m.pluginId} · v{m.version}</div>
										<div style={{ fontSize: 11, color: '#555' }}>{m.scriptURL}</div>
									</div>
									<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
										<span style={{ fontSize: 11, color: loaded ? '#22c55e' : '#888' }}>{loaded ? '已加载' : '未加载'}</span>
										<button
											onClick={() => void handleUninstall(m)}
											style={{ padding: '4px 8px', border: '1px solid #dc2626', borderRadius: 4, background: 'transparent', color: '#ef4444', cursor: 'pointer', fontSize: 11 }}>
											卸载
										</button>
									</div>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}

/** Derive a pluginId from a script URL: `<hostname>-<basename>` (sanitized). */
export function pluginIdFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const base = (u.pathname.split('/').pop() ?? 'plugin')
			.replace(/\.(js|mjs)$/i, '')
			.replace(/[^a-z0-9-]/gi, '-')
			.replace(/^-+|-+$/g, '')
			.toLowerCase();
		const host = u.hostname.replace(/[^a-z0-9-]/gi, '-');
		let id = `${host}-${base || 'plugin'}`;
		// Clamp to 64 chars, keep leading letter.
		id = id.slice(0, 64).replace(/^[^a-z]/i, 'p');
		return id;
	} catch {
		return 'plugin-' + url.length;
	}
}
