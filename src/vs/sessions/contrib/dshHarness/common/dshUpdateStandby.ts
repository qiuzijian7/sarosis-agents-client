/*---------------------------------------------------------------------------------------------
 * Copyright (c) Saros. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IDesktopUpdateSnapshot } from './dshDesktopUpdate.js';

export const DSH_UPDATE_STANDBY_ACTION = 'vssaros-update-standby://open';
const escape = (value: string): string => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** Host-independent read-only fallback. The only action opens the existing native confirmation flow. */
export function updateStandbyHtml(snapshot?: IDesktopUpdateSnapshot): string {
	const phase = snapshot?.presentation.phase;
	const restartReady = phase === 'ready' && snapshot?.restartReady === true;
	const title = restartReady ? '更新已安装，等待重启' : phase === 'error' ? '更新未完成' : phase === 'idle' ? '更新已停止' : '正在准备或安装更新';
	const description = restartReady ? '会话服务已暂停以释放安装文件。未点击“立即重启”前，应用不会自动重启。'
		: phase === 'error' || phase === 'idle' ? '会话服务尚未恢复。请打开更新操作查看结果；不要将此状态视为安装成功。'
			: '会话服务暂时停止，以便安全替换文件。安装期间请勿重新启动会话服务。';
	const percent = phase === 'installing' ? snapshot?.presentation.percent : undefined;
	const progress = typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined;
	const version = snapshot?.presentation.version?.slice(0, 80);
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:#1f1f1f;color:#dedede;font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}.card{width:min(560px,100%);padding:32px;border:1px solid #6665;border-radius:12px;background:#8881}h1{font-size:22px;line-height:1.4;margin:0 0 14px}p{margin:10px 0}.hint{opacity:.7;font-size:13px}a{display:inline-block;margin-top:16px;padding:9px 18px;background:#2468d6;color:white;border-radius:6px;text-decoration:none}a:focus-visible{outline:3px solid #9bc5ff;outline-offset:3px}progress{width:100%;height:10px;accent-color:#2468d6}@media(prefers-color-scheme:light){body{background:#f4f6f9;color:#283141}.card{background:white}}
</style></head><body data-vssaros-update-standby="true"><main class="card"><h1>${title}</h1><p>${description}</p>${version ? `<p>目标版本：${escape(version)}</p>` : ''}${progress === undefined ? '' : `<p>安装进度：${progress}%</p><progress max="100" value="${progress}"></progress>`}<a href="${DSH_UPDATE_STANDBY_ACTION}">${restartReady ? '打开重启确认' : '查看更新操作'}</a><p class="hint">也可通过顶部“应用 → 检查更新”查看状态或确认重启。选择稍后重启时，此提示页会继续保留。</p></main></body></html>`;
}

export function updateStandbyUrl(snapshot?: IDesktopUpdateSnapshot): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(updateStandbyHtml(snapshot))}`;
}

/** Do not grant page-bridge authority to data: pages, subframes, or arbitrary custom URLs. */
export function isUpdateStandbyAction(input: { target: string; current: string; expected?: string; mainFrame: boolean; connected: boolean }): boolean {
	return input.target === DSH_UPDATE_STANDBY_ACTION && !!input.expected && input.current === input.expected && input.mainFrame && !input.connected;
}
