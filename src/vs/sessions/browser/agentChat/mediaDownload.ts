/*---------------------------------------------------------------------------------------------
 *  Saros Agents — 媒体下载文件名推断
 *
 *  2026-09-11 用户需求：工作流工具卡片里的图片/视频/音频加「下载」按钮。
 *  抽成独立纯模块（无 DOM / 无服务依赖）以便单测 —— 放在 agentChatPanel.workflowCards.ts
 *  里会连带拉起整个面板类继承链，测试成本高且易受 DOM 环境影响。
 *--------------------------------------------------------------------------------------------*/

/**
 * 从媒体 src 推断下载文件名。
 *
 * 规则：
 *   · data URL（画布生成结果的主流形态）无路径可依 → `生成结果-<时间戳>.<ext>`，
 *     扩展名优先取 mime 子类型（`image/jpeg` → `jpg`），取不到才按 kind 兜底；
 *   · 其余（http(s) / blob / vscode-file / 本地路径）→ 取 basename（去 query/hash），
 *     无扩展名才回退按 kind 兜底。
 */
export function mediaDownloadFilename(src: string, kind: string): string {
	const fallbackExt = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
	const dataMime = /^data:([^;,]+)/.exec(src);
	if (dataMime) {
		const sub = (dataMime[1].split('/')[1] ?? '').replace(/[^a-z0-9]/gi, '');
		return `生成结果-${Date.now()}.${sub === 'jpeg' ? 'jpg' : (sub || fallbackExt)}`;
	}
	const tail = src.split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop() ?? '';
	return /\.[a-z0-9]{2,5}$/i.test(tail) ? tail : `生成结果-${Date.now()}.${fallbackExt}`;
}
