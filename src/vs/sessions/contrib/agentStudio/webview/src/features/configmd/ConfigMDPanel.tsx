/*---------------------------------------------------------------------------------------------
 *  ConfigMDPanel
 *
 *  Bidirectional MD ↔ HTML panel:
 *    [ Markdown editor (textarea) ]  |  [ HTML preview (iframe) ]
 *
 *  • Editor edits are debounced and sent to host via writeSource (origin: 'editor').
 *  • Host pushes back rendered HTML via configmd.htmlRendered → updates iframe.
 *  • iframe SDK posts events / patches → bridge → host → MD updated → re-rendered → echo back.
 *  • External edits (file system, model patch) come back via configmd.sourceChanged.
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
	writeSource,
} from './configMdBridge';
import { useConfigMdStore } from '../../store/useConfigMdStore';

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
	const editorRef = useRef<HTMLTextAreaElement | null>(null);

	const agentState = useConfigMdStore((s) => s.byAgent[employeeId]);
	const setAgentState = useConfigMdStore((s) => s.setState);
	const setLoading = useConfigMdStore((s) => s.setLoading);
	const setError = useConfigMdStore((s) => s.setError);
	const setView = useConfigMdStore((s) => s.setView);
	const updateMarkdownLocal = useConfigMdStore((s) => s.updateMarkdownLocal);

	const view = agentState?.view || config.defaultView || 'split';
	const editable = config.editable !== false;
	const debounceMs = config.syncDebounceMs ?? DEFAULT_DEBOUNCE_MS;

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
			// If the change came from us (editor) and our local content matches, no-op.
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (cur && evt.markdown === cur.markdown && evt.version === cur.version) { return; }
			setAgentState(employeeId, {
				markdown: evt.markdown,
				version: evt.version,
				dirty: false,
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
			});
			// Reload iframe srcdoc with new html
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
	}, [employeeId, agentState?.loaded]);

	// ─── MD editor change handler (debounced) ────────────────────────────
	const onEditorChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const next = e.target.value;
		updateMarkdownLocal(employeeId, next);
		if (debounceRef.current) {
			window.clearTimeout(debounceRef.current);
		}
		debounceRef.current = window.setTimeout(() => {
			const cur = useConfigMdStore.getState().byAgent[employeeId];
			if (!cur) { return; }
			writeSource(employeeId, cur.markdown, { origin: 'editor', baseVersion: cur.version })
				.then((r) => {
					setAgentState(employeeId, { version: r.version, dirty: false });
				})
				.catch((err) => {
					setError(employeeId, err instanceof Error ? err.message : String(err));
				});
		}, debounceMs);
	}, [employeeId, debounceMs, setAgentState, setError, updateMarkdownLocal]);

	// ─── Initial iframe doc (when loaded) ────────────────────────────────
	const previewSrcDoc = useMemo(() => {
		if (!agentState?.loaded) { return ''; }
		return buildPreviewDoc(agentState.html, agentState.stylesContent);
	}, [agentState?.loaded, agentState?.html, agentState?.stylesContent]);

	// ─── Header / View toggle ────────────────────────────────────────────
	const renderHeader = () => (
		<div className="configmd-header">
			<div className="configmd-title">
				<span className="configmd-icon">📝</span>
				<span>ConfigMD</span>
				{agentState?.dirty && <span className="configmd-dirty-dot" title="未保存的本地修改" />}
				{agentState?.error && <span className="configmd-err" title={agentState.error}>⚠</span>}
			</div>
			<div className="configmd-view-toggle">
				<button
					className={view === 'source' ? 'active' : ''}
					onClick={() => setView(employeeId, 'source')}
					title="仅源码"
				>源码</button>
				<button
					className={view === 'split' ? 'active' : ''}
					onClick={() => setView(employeeId, 'split')}
					title="并排"
				>并排</button>
				<button
					className={view === 'preview' ? 'active' : ''}
					onClick={() => setView(employeeId, 'preview')}
					title="仅预览"
				>预览</button>
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
			</div>
		);
	}

	const showSource = view === 'source' || view === 'split';
	const showPreview = view === 'preview' || view === 'split';

	return (
		<div className={`configmd-panel ${className || ''}`}>
			{renderHeader()}
			<div className={`configmd-body view-${view}`}>
				{showSource && (
					<div className="configmd-source">
						<textarea
							ref={editorRef}
							value={agentState?.markdown ?? ''}
							onChange={onEditorChange}
							readOnly={!editable}
							spellCheck={false}
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
		</div>
	);
};
