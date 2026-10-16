// @vssaros/dsh-browser — 「连不上浏览器」时给模型/用户的指引（纯函数，可单测）。
//
// ## 为什么值得单独一个文件
//
// 2026-10-13 真机日志定位到的缺陷：`browser.login` 在**浏览器根本连不上**时抛的是底层
// `TypeError: fetch failed` —— 模型只能自己猜 "Chrome not running with CDP"，用户看到的是
// "做不到"。而实际上有**两条现成的出路**（请用户开一次远程调试 / 让工具自动拉起专属实例），
// 只是没有任何人告诉他。
//
// 所以这里的每条文案都遵守本仓那条纪律（"审批/错误文案必须说真话"）：
//   ① 说清**现象**（连不上哪个端点、原因是什么）；
//   ② 说清**下一步是谁做什么**（要用户动手的，必须明说是"请用户"）；
//   ③ 说清**现在重试没用** —— 否则模型会在同一个失败上反复撞（那是真机日志里最贵的浪费）。
//
// ⚠ 与 `loginProbe.js` 的 `loginGuidanceText` 的分工：那一条讲的是"页面在登录墙后面，请用户
// **登录**"；本文件讲的是"**传输层**连不上，请用户**开调试**"。两者都会提到同一个
// `chrome://inspect/#remote-debugging` 页面，但成因与下一步完全不同 —— 别合并（合并的症状是
// 模型把"端口没开"当成"没登录"，然后去请用户登录一个根本没加载的页面）。

import { CHROME_REMOTE_DEBUGGING_PAGE } from './chrome.js';

/**
 * 连不上时的完整指引。
 *
 * @param {string} op                      被拒的 op（模型看得见自己刚才想做什么）
 * @param {{ endpoint?: string, error?: string, launchDedicated?: boolean, dedicatedPort?: number }} info
 * @returns {string} 给模型的错误正文
 */
export function unreachableMessage(op, info) {
	const endpoint = info?.endpoint || '(未知端点)';
	const reason = info?.error || '(无原因)';
	const port = portOf(endpoint);
	const lines = [
		`## browser.${op} 没有执行 —— 连不上 Chrome 的调试端口`,
		'',
		`试过 ${endpoint}，结果为：${reason}`,
		'',
		`**在下面任一动作完成之前，重试本工具没有任何意义**（每次都会撞同一堵墙）：`,
		'',
		'1. **请用户开一次远程调试**（推荐，一次搞定且能带上他的登录态）：在日常使用的 Chrome 地址栏里',
		`   **手动输入** \`${CHROME_REMOTE_DEBUGGING_PAGE}\` 并勾选 "Allow remote debugging for this browser instance"。`,
		`   ⚠ 那个勾选**没法由程序代劳**（Chrome 忽略外部传来的 chrome:// 地址，且这是它的显式同意闸门）；`,
		`   它也**没有端口选项**，只会监听 9222${port && port !== '9222' ? ` —— 所以配置里的端口要保持 9222（当前是 ${port}，对不上）` : ''}。`,
	];
	if (info?.launchDedicated === true) {
		lines.push(
			`2. 或让**本工具自动拉起**一个专属实例（已开启）：直接重试本工具即可 —— 连不上时它会自己起一个`,
			`   可调试的 Chrome（跑在 ${info.dedicatedPort ?? '(配置端口 +1)'} 上，用独立 profile）。`,
			`   若它仍失败，错误里会给拉起失败的具体原因（照实转告用户）。`,
		);
	} else {
		lines.push(
			'2. 或让本工具**自动拉起**一个专属实例：需要开启 `launchDedicated`（配置 `launchDedicated = true`，',
			'   或环境变量 `VSSAROS_BROWSER_LAUNCH_DEDICATED=1`）—— 这条路不需要用户勾任何同意框。',
			'   ⚠ 这是 **Host 侧**的配置（独立于 VsSaros 设置界面），要改就改 Host 的运行配置。',
		);
	}
	lines.push(
		'',
		'3. 也可以**完全不用浏览器**：换你**手上确实有**的文本通道（照你自己的工具列表选），或直接问用户要内容。',
		'   ⚠ 本插件跑在 **Host 侧**：Host-only 环境里**没有** VsSaros 内建的那批抓取 / 检索工具 ——'
			+ ' 别按"IDE 里能用"的印象去调（那只会白失败一轮）。这里**刻意不写它们的名字**：'
			+ '写了就会有人照着调。',
		'',
		'完成 1 或 2 之后**如实告诉用户你做了什么**，再重试本工具（`op: "status"` 可以先用来看端口通不通）。',
	);
	return lines.join('\n');
}

/** 从 `http://127.0.0.1:9222` 里取端口（只用于文案，取不到就不写）。 */
function portOf(endpoint) {
	const matched = /:(\d+)\s*$/.exec(String(endpoint ?? ''));
	return matched ? matched[1] : '';
}
