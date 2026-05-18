/*---------------------------------------------------------------------------------------------
 *  ConfigMDPanel
 *
 *  Bidirectional MD ↔ HTML panel:
 *    [ Markdown editor with line numbers + syntax highlight ]  |  [ HTML preview (iframe) ]
 *
 *  Header controls:
 *    • [⚙] Settings — upload custom parser / styles
 *    • [👁] Preview toggle — toggles between split (MD + HTML) and preview-only.
 *      Each click also forces a re-render through the active parser.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	bindIframeChannel,
	fetchState,
	onCommand,
	onHtmlRendered,
	onSourceChanged,
	postCommandToIframe,
	postSyncToIframe,
	renderHtml,
	writeSource,
} from './configMdBridge';
import { useConfigMdStore } from '../../store/useConfigMdStore';
import { MarkdownEditor } from './MarkdownEditor';
import { ConfigMdSettings } from './ConfigMdSettings';
import { CONFIG_MD_DEMO } from './configMdDemo';

const DEFAULT_DEBOUNCE_MS = 300;

interface ConfigMdConfig {
	mdPath?: string;
	parserPath?: string;
	stylesPath?: string;
	displayMode?: 'side' | 'replace' | 'tab';
	defaultView?: 'preview' | 'source' | 'split';
	editable?: boolean;
	sandboxLevel?: 'strict' | 'standard' | 'permissive';
	autoShow?: boolean;
	syncDebounceMs?: number;
}

interface ConfigMDPanelProps {
	employeeId: string;
	config: ConfigMdConfig;
	className?: string;
}

const SDK_INLINE = `
(function(g){var listeners={command:[],sync:[],connected:[]};var pending=new Map();var connected=false;function id(){return 'sdk_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);}function send(t,e){var rid=id();return new Promise(function(res,rej){pending.set(rid,{resolve:res,reject:rej});window.parent.postMessage(Object.assign({type:t,requestId:rid},e||{}),'*');setTimeout(function(){if(pending.has(rid)){pending.delete(rid);rej(new Error('timeout '+t));}},30000);});}window.addEventListener('message',function(e){var m=e.data;if(!m||typeof m!=='object')return;if(m.type==='sdk.reply'&&m.requestId&&pending.has(m.requestId)){var p=pending.get(m.requestId);pending.delete(m.requestId);if(m.ok)p.resolve(m.data);else p.reject(new Error(m.error||'err'));return;}if(m.type==='host.command')listeners.command.forEach(function(fn){try{fn(m.command);}catch(_){}});else if(m.type==='host.sync')listeners.sync.forEach(function(fn){try{fn(m);}catch(_){}});});g.AgentConfigMd={connect:function(){return send('sdk.ready',{}).then(function(d){connected=true;listeners.connected.forEach(function(fn){try{fn(d);}catch(_){}});return api;});},isConnected:function(){return connected;}};var api={on:function(ev,fn){listeners[ev]=listeners[ev]||[];listeners[ev].push(fn);return api;},sendEvent:function(n,p){return send('sdk.event',{eventName:n,payload:p});},chatSend:function(msg,o){o=o||{};return send('sdk.chatSend',{message:msg,context:o.context,showInChat:o.showInChat!==false});},readMd:function(){return send('sdk.readMd',{});},writeMd:function(md){return send('sdk.writeMd',{markdown:md});},applyPatch:function(ps){return send('sdk.applyPatch',{patches:Array.isArray(ps)?ps:[ps]});},notify:function(m,l){return send('sdk.notify',{message:m,level:l||'info'});},bindTaskList:function(a){document.querySelectorAll('[data-agent-state="'+a+'"] [data-agent-task]').forEach(function(el){el.addEventListener('change',function(){var items=[];document.querySelectorAll('[data-agent-state="'+a+'"] li').forEach(function(li){var input=li.querySelector('[data-agent-task]');var text=(li.textContent||'').trim();items.push('- ['+(input&&input.checked?'x':' ')+'] '+text);});api.applyPatch([{op:'replace-anchor',anchor:a,content:items.join('\\n')}]);});});return api;}};g.AgentConfigMd.create=function(){return api;};})(window);
`;

function buildPreviewDoc(html: string, stylesContent?: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:; font-src data: https:;">
<style>
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family, system-ui, -apple-system, Segoe UI, Roboto, sans-serif); font-size: 13px; line-height: 1.5; color: var(--vscode-foreground, #ddd); background: transparent; padding: 12px 16px; margin: 0; }
h1,h2,h3,h4,h5,h6 { margin: 16px 0 8px; line-height: 1.25; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
p { margin: 8px 0; }
ul, ol { padding-left: 1.4em; }
li { margin: 2px 0; }
code { background: rgba(127,127,127,0.18); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 0.92em; }
pre.cmd-code { background: rgba(127,127,127,0.12); padding: 10px 12px; border-radius: 6px; overflow: auto; }
pre.cmd-code code { background: transparent; padding: 0; }
a { color: var(--vscode-textLink-foreground, #4ea1ff); }
.cmd-tasklist { list-style: none; padding-left: 4px; }
.cmd-tasklist .cmd-task { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
[data-agent-state] { padding: 2px 4px; border-left: 2px solid rgba(127,127,127,0.25); margin: 6px 0; }
[data-agent-bind] { background: rgba(78,161,255,0.10); padding: 0 3px; border-radius: 2px; }
button { font: inherit; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, #fff); cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground, #1a8cff); }
input[type="text"], textarea, select { font: inherit; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.4)); background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, inherit); }
${stylesContent || ''}
</style>
<script>${SDK_INLINE}</script>
</head>
<body>
${html}
<script>(function(){if(window.AgentConfigMd&&typeof window.AgentConfigMd.connect==='function'){window.AgentConfigMd.connect().then(function(api){window.agent=api;}).catch(function(){});}})();</script>
</body>
</html>`;
}

const sandboxAttr = (level: ConfigMdConfig['sandboxLevel']) => {
	switch (level) {
		case 'permissive': return 'allow-scripts allow-forms allow-popups allow-same-origin';
		case 'standard': return 'allow-scripts allow-forms allow-popups';
		case 'strict':
		default: return 'allow-scripts';
	}
};

export const ConfigMDPanel: React.FC<ConfigMDPanelProps> = ({ employeeId, config, className }) => {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const debounceRef = useRef<number | null>(null);

	const agentState = useConfigMdStore((s) => s.byAgent[employeeId]);
	const setAgentState = useConfigMdStore((s) => s.setState);
	const setLoading = useConfigMdStore((s) => s.setLoading);
	const setError = useConfigMdStore((s) => s.setError);
	const setView = useConfigMdStore((s) => s.setView);
	const updateMarkdownLocal = useConfigMdStore((s) => s.updateMarkdownLocal);

	const view = agentState?.view || config.defaultView || 'split';
	const editable = config.editable !== false;
	const debounceMs = config.syncDebounceMs ?? DEFAULT_DEBOUNCE_MS;
	const isPreviewOnly = view === 'preview';

	const [showSettings, setShowSettings] = useState(false);

	// ─── Initial load ────────────────────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		setLoading(employeeId, true);
		setError(employeeId, undefined);
		fetchState(employeeId)
			.then((s) => {
				if (cancelled) { return; }
				if (!s) {
					setError(employeeId, 'ConfigMD 资源不可用');
					setLoading(employeeId, false);
					return;
				}
				setAgentState(employeeId, {
					markdown: s.markdown,
					html: s.html,
					stylesContent: s.stylesContent,
					version: s.version,
					loaded: true,
					dirty: false,
				});
				setLoading(employeeId, false);
			})
			.catch((err) => {
				if (cancelled) { return; }
				setError(employeeId, err instanceof Error ? err.message : String(err));
				setLoading(employeeId, false);
			});
		return () => { cancelled = true; };
	}, [employeeId, setAgentState, setError, setLoading]);

	// ─── Subscribe to host pushes ────────────────────────────────────────
	useEffect(() => {
		const offSrc = onSourceChanged(employeeId, (evt) => {
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (cur && evt.markdown === cur.markdown && evt.version === cur.version) { return; }
			setAgentState(employeeId, {
				markdown: evt.markdown,
				version: evt.version,
				dirty: false,
				loaded: true,
			});
			postSyncToIframe(iframeRef.current, {
				markdown: evt.markdown,
				version: evt.version,
				origin: evt.origin,
			});
		});
		const offHtml = onHtmlRendered(employeeId, (evt) => {
			setAgentState(employeeId, {
				html: evt.html,
				version: evt.version,
				stylesContent: evt.stylesContent,
				loaded: true,
			});
			const doc = buildPreviewDoc(evt.html, evt.stylesContent);
			if (iframeRef.current) {
				iframeRef.current.srcdoc = doc;
			}
		});
		const offCmd = onCommand(employeeId, (cmd) => {
			postCommandToIframe(iframeRef.current, cmd);
		});
		return () => { offSrc(); offHtml(); offCmd(); };
	}, [employeeId, setAgentState]);

	// ─── Bind iframe channel ─────────────────────────────────────────────
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) { return; }
		const unbind = bindIframeChannel(iframe, employeeId);
		return () => unbind();
	}, [employeeId, agentState?.loaded, isPreviewOnly]);

	// ─── MD editor change handler (debounced) ────────────────────────────
	const onEditorChange = useCallback((next: string) => {
		updateMarkdownLocal(employeeId, next);
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current);
		}
		debounceRef.current = window.setTimeout(() => {
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (!cur) { return; }
			// Skip optimistic-concurrency check while not yet loaded to avoid
			// "Stale write" rejections during initial population.
			const opts: { origin: 'editor'; baseVersion?: number } = { origin: 'editor' };
			if (cur.loaded && cur.version > 0) {
				opts.baseVersion = cur.version;
			}
			writeSource(employeeId, cur.markdown, opts)
				.then((r) => {
					setAgentState(employeeId, { version: r.version, dirty: false, loaded: true });
				})
				.catch((err) => {
					setError(employeeId, err instanceof Error ? err.message : String(err));
				});
		}, debounceMs);
	}, [employeeId, debounceMs, setAgentState, setError, updateMarkdownLocal]);

	// ─── Initial iframe doc ──────────────────────────────────────────────
	// Use html availability rather than the `loaded` flag, so a fresh
	// renderHtml RPC result is reflected in the preview without waiting
	// for fetchState to complete.
	const previewSrcDoc = useMemo(() => {
		if (!agentState?.html) { return ''; }
		return buildPreviewDoc(agentState.html, agentState.stylesContent);
	}, [agentState?.html, agentState?.stylesContent]);

	// ─── Toggle preview / split + force re-render through active parser ─
	const handleTogglePreview = useCallback(() => {
		const next: 'split' | 'preview' = isPreviewOnly ? 'split' : 'preview';
		setView(employeeId, next);
		// Force re-render to ensure preview reflects current MD via the active
		// parser. Use the returned HTML directly so the iframe updates even if
		// the host event channel is delayed.
		void renderHtml(employeeId)
			.then((r) => {
				setAgentState(employeeId, {
					html: r.html,
					version: r.version,
					loaded: true,
				});
			})
			.catch((err) => {
				console.error('[ConfigMD] renderHtml failed:', err);
			});
	}, [employeeId, isPreviewOnly, setView, setAgentState]);

	const handleSettingsChanged = useCallback(() => {
		// After parser/styles change, request a re-render and reload state
		void renderHtml(employeeId).catch(() => undefined);
	}, [employeeId]);

	// ─── Load built-in demo MD into editor (two-step confirmation) ─────
	const [demoArmed, setDemoArmed] = useState(false);
	const demoArmTimer = useRef<number | null>(null);
	const handleLoadDemo = useCallback(() => {
		const cur = useConfigMdStore.getState().byAgent[employeeId];
		const hasContent = !!(cur?.markdown && cur.markdown.trim().length > 0);
		if (hasContent && !demoArmed) {
			setDemoArmed(true);
			if (demoArmTimer.current) {
				window.clearTimeout(demoArmTimer.current);
			}
			demoArmTimer.current = window.setTimeout(() => {
				setDemoArmed(false);
			}, 5000);
			return;
		}
		if (demoArmTimer.current) {
			window.clearTimeout(demoArmTimer.current);
			demoArmTimer.current = null;
		}
		setDemoArmed(false);
		onEditorChange(CONFIG_MD_DEMO);
	}, [employeeId, onEditorChange, demoArmed]);

	// ─── Header ──────────────────────────────────────────────────────────
	const renderHeader = () => (
		<div className="configmd-header">
			<div className="configmd-title">
				<span className="configmd-icon">📝</span>
				<span>ConfigMD</span>
				{agentState?.dirty && <span className="configmd-dirty-dot" title="未保存的本地修改" />}
				{agentState?.error && <span className="configmd-err" title={agentState.error}>⚠</span>}
			</div>
			<div className="configmd-toolbar">
				<div className="configmd-toolbar-left">
					<button
						className="configmd-icon-btn"
						onClick={() => setShowSettings(true)}
						title="配置：上传自定义解析器 / 样式"
						aria-label="设置"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
					</button>
					<button
						className={`configmd-icon-btn ${demoArmed ? 'demo-armed' : ''}`}
						onClick={handleLoadDemo}
						title={demoArmed ? '再次点击确认覆盖当前 Markdown' : '加载内置示例 Markdown（默认解析器即可完整渲染）'}
						aria-label="示例"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
							<path d="M14 2v6h6" />
							<path d="M16 13H8M16 17H8M10 9H8" />
						</svg>
						<span className="configmd-icon-btn-text">{demoArmed ? '⚠ 确认覆盖？' : 'Demo'}</span>
					</button>
				</div>
				<div className="configmd-toolbar-right">
					<button
						className={`configmd-icon-btn ${isPreviewOnly ? 'active' : ''}`}
						onClick={handleTogglePreview}
						title={isPreviewOnly ? '切换为并排视图' : '仅预览（重新解析）'}
						aria-label="预览"
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
						<span className="configmd-icon-btn-text">预览</span>
					</button>
				</div>
			</div>
		</div>
	);

	if (agentState?.loading) {
		return (
			<div className={`configmd-panel ${className || ''}`}>
				{renderHeader()}
				<div className="configmd-loading">加载 ConfigMD…</div>
			</div>
		);
	}
	if (agentState?.error) {
		return (
			<div className={`configmd-panel ${className || ''}`}>
				{renderHeader()}
				<div className="configmd-error">
					<div>无法加载 ConfigMD</div>
					<pre>{agentState.error}</pre>
				</div>
				{showSettings && (
					<ConfigMdSettings
						employeeId={employeeId}
						onClose={() => setShowSettings(false)}
						onChanged={handleSettingsChanged}
					/>
				)}
			</div>
		);
	}

	const showSource = !isPreviewOnly;
	const showPreview = true; // Preview is always present (split or preview-only)

	return (
		<div className={`configmd-panel ${className || ''}`}>
			{renderHeader()}
			<div className={`configmd-body view-${isPreviewOnly ? 'preview' : 'split'}`}>
				{showSource && (
					<div className="configmd-source">
						<MarkdownEditor
							value={agentState?.markdown ?? ''}
							onChange={editable ? onEditorChange : undefined}
							readOnly={!editable}
							placeholder="# Markdown 源码…"
						/>
					</div>
				)}
				{showPreview && (
					<div className="configmd-preview">
						<iframe
							ref={iframeRef}
							sandbox={sandboxAttr(config.sandboxLevel)}
							srcDoc={previewSrcDoc}
							title={`ConfigMD-${employeeId}`}
						/>
					</div>
				)}
			</div>
			{showSettings && (
				<ConfigMdSettings
					employeeId={employeeId}
					onClose={() => setShowSettings(false)}
					onChanged={handleSettingsChanged}
				/>
			)}
		</div>
	);
};
