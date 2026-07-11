/*---------------------------------------------------------------------------------------------
 *  ConfigHtmlPanel
 *
 *  Renders an agent's `config.html` as a live preview inside an iframe. The
 *  iframe content is wrapped with an injected `AgentConfigHtml` SDK so the page
 *  can call back into the agent (chatSend / sendEvent / notify) and receive
 *  host-pushed commands/messages — without any Markdown editor or MD parser UI.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
	bindIframeChannel,
	getHtml,
	onCommand,
	onHtmlRendered,
	postCommandToIframe,
} from './configHtmlBridge';
import { useConfigHtmlStore } from '../../store/useConfigHtmlStore';

interface ConfigHtmlPanelProps {
	agentId: string;
	className?: string;
}

/**
 * Inline SDK injected into the preview iframe. Exposes `window.AgentConfigHtml`
 * and relays sdk.* requests to the parent (this panel → host).
 */
const SDK_INLINE = `
(function(g){
	var listeners={message:[],command:[],connected:[]};
	var pending=new Map();
	var connected=false;
	function id(){return 'sdk_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);}
	function send(t,e){
		var rid=id();
		return new Promise(function(res,rej){
			pending.set(rid,{resolve:res,reject:rej});
			window.parent.postMessage(Object.assign({type:t,requestId:rid},e||{}),'*');
			setTimeout(function(){if(pending.has(rid)){pending.delete(rid);rej(new Error('timeout '+t));}},30000);
		});
	}
	window.addEventListener('message',function(e){
		var m=e.data;
		if(!m||typeof m!=='object')return;
		if(m.type==='sdk.reply'&&m.requestId&&pending.has(m.requestId)){
			var p=pending.get(m.requestId);pending.delete(m.requestId);
			if(m.ok)p.resolve(m.data);else p.reject(new Error(m.error||'err'));
			return;
		}
		if(m.type==='host.command')listeners.command.forEach(function(fn){try{fn(m.command);}catch(_){}});
		else if(m.type==='host.message')listeners.message.forEach(function(fn){try{fn(m);}catch(_){}});
	});
	var api={
		on:function(ev,fn){listeners[ev]=listeners[ev]||[];listeners[ev].push(fn);return api;},
		sendEvent:function(n,p){return send('sdk.event',{eventName:n,payload:p});},
		chatSend:function(msg,o){o=o||{};return send('sdk.chatSend',{message:msg,context:o.context,showInChat:o.showInChat!==false});},
		notify:function(m,l){return send('sdk.notify',{message:m,level:l||'info'});}
	};
	g.AgentConfigHtml={
		connect:function(){return send('sdk.ready',{}).then(function(d){connected=true;listeners.connected.forEach(function(fn){try{fn(d);}catch(_){}});return api;});},
		isConnected:function(){return connected;},
		on:function(ev,fn){return api.on(ev,fn);},
		sendEvent:function(n,p){return api.sendEvent(n,p);},
		chatSend:function(msg,o){return api.chatSend(msg,o);},
		notify:function(m,l){return api.notify(m,l);}
	};
	g.AgentConfigHtml.create=function(){return api;};
})(window);
`;

function buildPreviewDoc(html: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:; font-src data: https:;">
</head>
<body>
${html}
<script>${SDK_INLINE}</script>
<script>(function(){if(window.AgentConfigHtml&&typeof window.AgentConfigHtml.connect==='function'){window.AgentConfigHtml.connect().then(function(api){window.agent=api;}).catch(function(){});}})();</script>
</body>
</html>`;
}

const sandboxAttr = 'allow-scripts allow-forms allow-popups';

export const ConfigHtmlPanel: React.FC<ConfigHtmlPanelProps> = ({ agentId, className }) => {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const agentState = useConfigHtmlStore((s) => s.byAgent[agentId]);
	const setAgentState = useConfigHtmlStore((s) => s.setState);
	const setLoading = useConfigHtmlStore((s) => s.setLoading);
	const setError = useConfigHtmlStore((s) => s.setError);

	const [ready, setReady] = useState(false);

	// ─── Initial load ────────────────────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		setLoading(agentId, true);
		setError(agentId, undefined);
		getHtml(agentId)
			.then((s) => {
				if (cancelled) { return; }
				setAgentState(agentId, {
					html: s.html,
					version: s.version,
					loaded: true,
				});
				setLoading(agentId, false);
			})
			.catch((err) => {
				if (cancelled) { return; }
				setError(agentId, err instanceof Error ? err.message : String(err));
				setLoading(agentId, false);
			});
		return () => { cancelled = true; };
	}, [agentId, setAgentState, setError, setLoading]);

	// ─── Subscribe to host pushes (model-generated HTML) ─────────────────
	useEffect(() => {
		const offHtml = onHtmlRendered(agentId, (evt) => {
			setAgentState(agentId, {
				html: evt.html,
				version: evt.version,
				loaded: true,
			});
		});
		const offCmd = onCommand(agentId, (cmd) => {
			postCommandToIframe(iframeRef.current, cmd);
		});
		return () => { offHtml(); offCmd(); };
	}, [agentId, setAgentState]);

	// ─── Bind iframe channel ─────────────────────────────────────────────
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) { return; }
		const unbind = bindIframeChannel(iframe, agentId, () => setReady(true));
		return () => unbind();
	}, [agentId, agentState?.loaded]);

	const previewSrcDoc = agentState?.html ? buildPreviewDoc(agentState.html) : '';

	if (agentState?.loading) {
		return <div className={`confightml-panel ${className || ''}`}><div className="confightml-loading">加载 config.html…</div></div>;
	}
	if (agentState?.error) {
		return (
			<div className={`confightml-panel ${className || ''}`}>
				<div className="confightml-error">
					<div>无法加载 config.html</div>
					<pre>{agentState.error}</pre>
				</div>
			</div>
		);
	}

	return (
		<div className={`confightml-panel ${className || ''}`}>
			<iframe
				ref={iframeRef}
				sandbox={sandboxAttr}
				srcDoc={previewSrcDoc}
				title={`ConfigHtml-${agentId}`}
				className="confightml-iframe"
			/>
		</div>
	);
};
