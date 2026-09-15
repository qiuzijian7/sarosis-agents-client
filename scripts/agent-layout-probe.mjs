#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  [Saros] Agent 布局**几何探针**（纯 Node + CDP，不依赖任何 MCP）
 *
 *  ── 为什么是"几何量"而不是"像素" ────────────────────────────────────
 *
 *  "布局对不对"本质是**有哪些 part、在哪、多大** —— 数值、确定性、可比对。
 *  截图只给人看。真机上踩过的坑（panel 是 `0×0` 却仍渲染、侧栏只有 48px、
 *  两个编辑器并排）**全都是几何量一眼能看出的**，靠人工截图 + 文字描述却来回好几轮。
 *
 *  所以本脚本做两件事：
 *    1. 读几何量 → 与 `layout-expect.json` 比对 → **可自动化的正确性信号**；
 *    2. 顺手截一张图 → 落盘 PNG（人/AI 可以直接看图，不必手动截图）。
 *
 *  ── 前提：应用必须开着 CDP 端口 ────────────────────────────────────
 *
 *  仓库里没有 `remote-debugging-port`，dev 启动默认不开。用：
 *
 *      scripts\code.bat --remote-debugging-port=9222
 *
 *  （它是 Chromium 开关，Electron 直接认；本仓 ext host 已带 `--inspect`，属同类做法。）
 *
 *  ── 用法 ───────────────────────────────────────────────────────────
 *
 *      node scripts/agent-layout-probe.mjs                 # 探测 + 截图 + 比对期望值
 *      node scripts/agent-layout-probe.mjs --port=9333
 *      node scripts/agent-layout-probe.mjs --no-screenshot
 *      node scripts/agent-layout-probe.mjs --target=sessions   # 多窗口时选目标页
 *
 *  退出码：0 = 与期望一致（或无期望文件）/ 1 = 有差异 / 2 = 连不上或环境错误
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.codebuddy', 'smoke');

const argv = process.argv.slice(2);
const hasFlag = name => argv.includes(`--${name}`);
const optValue = (name, fallback) => {
	const hit = argv.find(a => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(optValue('port', '9222'));
const TARGET_MATCH = optValue('target', undefined);
const DO_SCREENSHOT = !hasFlag('no-screenshot');
const EXPECT_FILE = optValue('expect', path.join(OUT_DIR, 'layout-expect.json'));

/**
 * 在渲染进程里跑的探测脚本。
 *
 * ⚠ 只读 DOM，不改任何状态 —— 探针必须是"无副作用"的，否则它会污染被测对象
 * （布局问题本身就跟"谁在什么时候改了 DOM"高度纠缠）。
 */
const PROBE_EXPRESSION = `(() => {
	const parts = Array.from(document.querySelectorAll('.part')).map(el => {
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		const w = Math.round(r.width), h = Math.round(r.height);
		return {
			id: el.id || null,
			classes: Array.from(el.classList),
			x: Math.round(r.x), y: Math.round(r.y), w, h,
			display: cs.display,
			// ★ 内联样式是关键证据：grid 布局过的 part 会被写上 width/height/top/left。
			// 没有内联尺寸却仍有 rect ⇒ 它是**游离元素**（按自身 CSS 渲染），
			// 而不是"被布局成了这个大小"—— 这两种情况的修法完全不同。
			inline: el.style.cssText.slice(0, 200),
			// ★ "可见"= 有面积 **且** 没被 display/visibility 关掉。
			// 只看 rect 会把 panel 那种「0×0 但 DOM 仍在」的情况判成"不可见"，
			// 而真机症状恰恰是"它虽然 0×0，内容却溢出渲染出来了" ⇒ 两者都要记录。
			visible: w > 0 && h > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'
		};
	});
	// ★ 图标条宽度链：上一版确认了"图标条在 DOM 里、有条目、但宽度 0"
	// ⇒ 这一版往上采 6 层的计算样式，直接看**是哪一层把宽度算成 0**（只读，不改 DOM）。
	// ⚠ 本注释位于模板字符串内部 ⇒ 不得出现反引号（否则提前闭合，报
	// "Unexpected identifier"）—— 这个坑我已经踩过三次。
	const stripChain = (() => {
		const sidebar = document.querySelector('.part.sidebar');
		if (!sidebar) {
			return { found: false, reason: 'no .part.sidebar' };
		}
		// ★★ 优先取**领养部件内**的那条（2026-09-15）：侧栏里同时存在
		// 「侧栏自己的空 composite bar」与「领养进来的 activitybar 的 bar」，
		// querySelector 取的是 DOM 序第一条约等于空的那条 ⇒ 会量错对象 ✗。
		// 必须优先锁定 .part.activitybar 子树里的那条（= 真正的图标条）。
		const bar = sidebar.querySelector('.part.activitybar .monaco-action-bar.vertical')
			|| sidebar.querySelector('.monaco-action-bar.vertical');
		if (!bar) {
			return { found: false, reason: 'no .monaco-action-bar.vertical inside sidebar' };
		}
		const chain = [];
		let el = bar;
		while (el && chain.length < 6) {
			const cs = getComputedStyle(el);
			chain.push({
				classes: Array.from(el.classList).join(' '),
				offsetW: el.offsetWidth, offsetH: el.offsetHeight,
				cssW: cs.width, cssH: cs.height,
				minW: cs.minWidth, maxW: cs.maxWidth,
				flex: cs.flex, display: cs.display, position: cs.position, overflowX: cs.overflowX
			});
			el = el.parentElement;
		}
		// 条目明细：区分"条里没有条目" vs "有条目但塌成 0"。
		const items = Array.from(bar.querySelectorAll('.action-item')).map(item => {
			const label = item.querySelector('.action-label');
			return {
				title: item.getAttribute('title') || (label ? (label.getAttribute('title') || label.getAttribute('aria-label')) : null) || null,
				offsetW: item.offsetWidth, offsetH: item.offsetHeight,
				display: getComputedStyle(item).display,
				labelDisplay: label ? getComputedStyle(label).display : null,
				labelSize: label ? (label.offsetWidth + 'x' + label.offsetHeight) : null
			};
		});
		return { found: true, chain, itemCount: items.length, items };
	})();

	// ★ 全页面扫描所有 .monaco-action-bar —— 上一版只取了侧栏里**第一条**，
	// 若侧栏内有多条（sessions 侧栏自己的 composite bar + 折进来的 activity bar），
	// 就会测到空的那条而误判"条目 0"。这里把所有条都列出来，含尺寸与条目数。
	const allActionBars = Array.from(document.querySelectorAll('.monaco-action-bar')).map(b => {
		const r = b.getBoundingClientRect();
		const items = Array.from(b.querySelectorAll('.action-item'));
		return {
			classes: Array.from(b.classList).join(' '),
			w: Math.round(r.width), h: Math.round(r.height),
			items: items.length,
			// ★ 条目标题：用来判断"哪个容器在哪条 bar 里"（数量不足以定位）。
			titles: items.map(item => {
				const label = item.querySelector('.action-label');
				const text = label ? (label.getAttribute('aria-label') || label.getAttribute('title')) : null;
				return text || item.getAttribute('title') || '(无标题)';
			}),
			parent: b.parentElement ? Array.from(b.parentElement.classList).join(' ') : null,
			// ★★ 祖先路径（2026-09-15 新增）：只给 parent 一层**不足以区分**两条 bar
			// —— 侧栏里同时存在「侧栏自己的空 composite bar」和「领养进来的 activitybar 的 bar」，
			// 两者的直接父元素都是 .composite-bar-container ⇒ 无法分辨 ✗。
			// 这里一路上溯 6 层，把 tag.class 串起来 ⇒ 一眼看出它属于哪棵子树 ✓
			// （含 .part.activitybar 的 = 真正的图标条 ✓）。
			path: (() => {
				const parts = [];
				let el = b.parentElement;
				while (el && parts.length < 6) {
					const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
					parts.push(el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
					el = el.parentElement;
				}
				return parts.join(' < ');
			})()
		};
	});

	// ★★ 领养子树专测（2026-09-15 新增）：**只**在 .part.sidebar .part.activitybar 里量。
	// 起因：上一版探针走的是 .part.sidebar → .composite → .composite-bar-container
	// → .composite-bar（40×13 ✗），但侧栏里**有两条**同构的 bar ⇒ 很可能量到了
	// 「侧栏自己的空 bar」而不是图标条 ✗（"走错子树" —— 与之前"隐藏兄弟节点带偏链"
	// 是同一类坑：链走对了层数，却走错了分支）。
	// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
	const adoptedStrip = (() => {
		const part = document.querySelector('.part.sidebar .part.activitybar');
		if (!part) {
			return { found: false, reason: '侧栏里没有 .part.activitybar（图标条部件未被领养？）' };
		}
		const pr = part.getBoundingClientRect();
		const pcs = getComputedStyle(part);
		const describe = el => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return {
				classes: Array.from(el.classList).join(' '),
				offsetW: el.offsetWidth, offsetH: el.offsetHeight,
				w: Math.round(r.width), h: Math.round(r.height),
				cssW: cs.width, cssH: cs.height,
				display: cs.display, visibility: cs.visibility,
				position: cs.position, overflowY: cs.overflowY
			};
		};
		// 部件自身 + 它的可见子树（沿第一个可见子元素下钻 5 层）
		const chain = [describe(part)];
		let el = Array.from(part.children).find(c => c.offsetHeight > 0) || null;
		while (el && chain.length < 6) {
			chain.push(describe(el));
			el = Array.from(el.children).find(c => c.offsetHeight > 0) || null;
		}
		// 部件内所有 bar + 条目
		const bars = Array.from(part.querySelectorAll('.monaco-action-bar')).map(b => {
			const items = Array.from(b.querySelectorAll('.action-item'));
			const r = b.getBoundingClientRect();
			return {
				classes: Array.from(b.classList).join(' '),
				w: Math.round(r.width), h: Math.round(r.height),
				items: items.length,
				firstItem: items.length ? describe(items[0]) : null
			};
		});
		return {
			found: true,
			rect: { x: Math.round(pr.left), y: Math.round(pr.top), w: Math.round(pr.width), h: Math.round(pr.height) },
			display: pcs.display, visibility: pcs.visibility, overflowY: pcs.overflowY,
			chain, bars
		};
	})();

	// ★ 侧栏内容**高度链**：从 .part.sidebar > .content 一路向下取 6 层，
	// 用来定位"内容没铺满整列"是**哪一层先短了**（与宽度链同一手法）。
	// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
	const contentChain = (() => {
		const sidebar = document.querySelector('.part.sidebar');
		const content = sidebar ? sidebar.querySelector(':scope > .content') : null;
		if (!content) {
			return { found: false };
		}
		const describe = el => {
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			return {
				classes: Array.from(el.classList).join(' '),
				h: Math.round(r.height),
				w: Math.round(r.width),
				cssH: cs.height,
				minH: cs.minHeight,
				flex: cs.flex,
				display: cs.display,
				overflowY: cs.overflowY
			};
		};
		// .content 的**全部子元素**（含隐藏的进度条）—— 先看清有哪几个兄弟。
		const children = Array.from(content.children).map(describe);
		// 再从**第一个可见子元素**往下走 6 层（跳过隐藏的进度条）。
		const chain = [];
		let el = Array.from(content.children).find(c => c.offsetHeight > 0) || null;
		while (el && chain.length < 6) {
			chain.push(describe(el));
			el = Array.from(el.children).find(c => c.offsetHeight > 0) || null;
		}
		return { found: true, contentH: Math.round(content.getBoundingClientRect().height), children, chain };
	})();

	// ★ sash（可拖拽边框）诊断：判断"边框拖不动"是**被遮挡**还是**被约束**。
	// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
	// 关键判据：sash 中心的 elementFromPoint —— 命中的若不是 sash 自己，
	// 说明有元素压在它上面 ⇒ 鼠标事件根本到不了 sash ⇒ 拖不动。
	// （若是"被约束"，则命中仍是 sash，但 min/max 宽度把它锁死了。）
	const sashInfo = (() => {
		const sashes = Array.from(document.querySelectorAll('.monaco-sash'));
		return sashes.map(sash => {
			const r = sash.getBoundingClientRect();
			const cs = getComputedStyle(sash);
			const cx = Math.round(r.left + r.width / 2);
			const cy = Math.round(r.top + r.height / 2);
			let hit = null;
			let hitIsSash = false;
			if (r.width > 0 && r.height > 0) {
				hit = document.elementFromPoint(cx, cy);
				hitIsSash = !!hit && (hit === sash || sash.contains(hit));
			}
			let hitDesc = null;
			if (hit) {
				const cls = typeof hit.className === 'string' ? hit.className.trim().split(/\s+/).filter(Boolean).join('.') : '';
				hitDesc = hit.tagName.toLowerCase() + (cls ? '.' + cls : '');
			}
			return {
				cls: Array.from(sash.classList).join(' '),
				parent: sash.parentElement ? Array.from(sash.parentElement.classList).join(' ') : null,
				x: Math.round(r.left), y: Math.round(r.top),
				w: Math.round(r.width), h: Math.round(r.height),
				cursor: cs.cursor, pe: cs.pointerEvents, z: cs.zIndex,
				display: cs.display, visibility: cs.visibility,
				hit: hitDesc,
				hitIsSash
			};
		}).filter(s => s.w > 0 && s.h > 0);
	})();

	// ★★ 图标条**条目**诊断：直接量目标元素本身。
	// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
	// 教训来源：之前把"bar 自身的宽度 40"误读成"action-item 规则生效"，
	// 白跑两轮。这里一律量 action-item 自己。
	const stripDiag = (() => {
		// ★★ 同上：优先领养部件内的条（.part.activitybar），否则会量到侧栏自己的空 bar ✗。
		const bar = document.querySelector('.part.sidebar .part.activitybar .monaco-action-bar.vertical')
			|| document.querySelector('.part.sidebar .monaco-action-bar.vertical');
		if (!bar) {
			return { foundBar: false };
		}

		// ① 从 bar 往上找作用域类，看它在不在祖先链上（CSS 选择器以它为根）。
		let el = bar;
		let scopeAt = null;
		while (el && el !== document.body) {
			if (el.classList && el.classList.contains('agent-sessions-workbench')) {
				scopeAt = el.id || el.className;
				break;
			}
			el = el.parentElement;
		}

		// ② 条目本身的**计算后**尺寸（不是 bar 的）。
		const items = Array.from(bar.querySelectorAll('.action-item'));
		const sample = items.slice(0, 3).map(it => {
			const r = it.getBoundingClientRect();
			const cs = getComputedStyle(it);
			const label = it.querySelector('.action-label');
			const lcs = label ? getComputedStyle(label) : null;
			const ariaEl = it.querySelector('[aria-label]');
			return {
				w: Math.round(r.width),
				h: Math.round(r.height),
				cssW: cs.width,
				cssH: cs.height,
				display: cs.display,
				labelW: lcs ? lcs.width : null,
				labelH: lcs ? lcs.height : null,
				aria: it.getAttribute('aria-label') || (ariaEl ? ariaEl.getAttribute('aria-label') : null)
			};
		});

		// ③ 那条规则是否在**已加载**的样式表里。
		let ruleFound = false;
		let ruleText = null;
		try {
			for (const sheet of Array.from(document.styleSheets)) {
				let rules;
				try { rules = sheet.cssRules; } catch { continue; }
				for (const r of Array.from(rules || [])) {
					if (r.selectorText && r.selectorText.indexOf('composite-bar-container') !== -1 && r.selectorText.indexOf('action-item') !== -1) {
						ruleFound = true;
						ruleText = r.cssText.slice(0, 120);
						break;
					}
				}
				if (ruleFound) { break; }
			}
		} catch { /* 跨域样式表读不到 */ }

		// ★ -8px 偏移定位：量 activitybar 部件元素的关键 computed 值。
		// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
		let activityBarDiag = null;
		const ab = document.getElementById('workbench.parts.activitybar');
		if (ab) {
			const acs = getComputedStyle(ab);
			const ar = ab.getBoundingClientRect();
			activityBarDiag = {
				rect: { x: Math.round(ar.left), y: Math.round(ar.top), w: Math.round(ar.width), h: Math.round(ar.height) },
				position: acs.position,
				marginLeft: acs.marginLeft,
				marginRight: acs.marginRight,
				left: acs.left,
				top: acs.top,
				transform: acs.transform,
				inlineStyle: ab.getAttribute('style'),
				parent: ab.parentElement ? (ab.parentElement.id || Array.from(ab.parentElement.classList).join(' ')) : null
			};
		}

		// ★ 标题栏 logo 诊断：量 computed backgroundImage（能看到解析后的 URL ✓）。
		// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
		let appIconDiag = null;
		const ai = document.querySelector('a.window-appicon');
		if (ai) {
			const aiCs = getComputedStyle(ai);
			const aiR = ai.getBoundingClientRect();
			appIconDiag = {
				rect: { w: Math.round(aiR.width), h: Math.round(aiR.height) },
				backgroundImage: aiCs.backgroundImage.slice(0, 240),
				display: aiCs.display
			};
		}

		// ★ 侧栏直接子元素 dump（带宽度）—— 定位 SCM 视图渲染到了哪。
		// ⚠ 本注释在模板字符串内 ⇒ 不得出现反引号。
		const sidebarEl = document.querySelector('.part.sidebar');
		let sidebarChildren = null;
		if (sidebarEl) {
			sidebarChildren = Array.from(sidebarEl.children).map(c => {
				const cr = c.getBoundingClientRect();
				return {
					tag: c.tagName.toLowerCase(),
					id: c.id || null,
					cls: Array.from(c.classList).join(' '),
					x: Math.round(cr.left),
					w: Math.round(cr.width),
					h: Math.round(cr.height),
					display: getComputedStyle(c).display
				};
			});
		}

		// viewlet（视图容器）的位置与祖先链 —— 回答"SCM 视图渲染到了哪"。
		const viewletEl = document.querySelector('.part.sidebar .composite.viewlet');
		let viewletDiag = null;
		if (viewletEl) {
			const vr = viewletEl.getBoundingClientRect();
			const ancestors = [];
			let p = viewletEl;
			while (p && p !== document.body && ancestors.length < 5) {
				const pr = p.getBoundingClientRect();
				ancestors.push((p.id ? '#' + p.id : '') + '.' + Array.from(p.classList).slice(0, 3).join('.') + ' ' + Math.round(pr.width) + 'x' + Math.round(pr.height));
				p = p.parentElement;
			}
			viewletDiag = { rect: { x: Math.round(vr.left), w: Math.round(vr.width), h: Math.round(vr.height) }, ancestors };
		}

		const r = bar.getBoundingClientRect();
		return {
			foundBar: true,
			scopeAt,
			barSize: { w: Math.round(r.width), h: Math.round(r.height) },
			itemCount: items.length,
			items: sample,
			ruleFound,
			ruleText,
			activityBar: activityBarDiag,
			appIcon: appIconDiag,
			sidebarChildren,
			viewlet: viewletDiag
		};
	})();

	return JSON.stringify({
		title: document.title,
		url: location.href,
		window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
		parts,
		stripChain,
		allActionBars,
		adoptedStrip,
		contentChain,
		sashInfo,
		stripDiag
	});
})()`;

//#region --- CDP

async function listTargets() {
	let response;
	try {
		response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
	} catch (error) {
		console.error(`✖ 连不上 CDP（127.0.0.1:${PORT}）：${error.message}`);
		console.error('');
		console.error('  应用必须带调试端口启动：');
		console.error('      scripts\\code.bat --remote-debugging-port=' + PORT);
		process.exit(2);
	}
	if (!response.ok) {
		console.error(`✖ CDP 返回 HTTP ${response.status}`);
		process.exit(2);
	}
	return response.json();
}

function pickTarget(targets) {
	const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
	if (!pages.length) {
		console.error('✖ 没有可用的 page target。当前 target：');
		for (const t of targets) {
			console.error(`   [${t.type}] ${t.url}`);
		}
		process.exit(2);
	}
	if (TARGET_MATCH) {
		const matched = pages.find(t => t.url.includes(TARGET_MATCH) || (t.title ?? '').includes(TARGET_MATCH));
		if (!matched) {
			console.error(`✖ --target=${TARGET_MATCH} 没匹配到。可选：`);
			for (const t of pages) {
				console.error(`   ${t.title}  ${t.url}`);
			}
			process.exit(2);
		}
		return matched;
	}
	return pages[0];
}

async function connect(webSocketDebuggerUrl) {
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('CDP 握手超时')), 5000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
		ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 握手失败')); }, { once: true });
	});

	let nextId = 1;
	const pending = new Map();
	ws.addEventListener('message', event => {
		let message;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}
		const resolve = pending.get(message.id);
		if (resolve) {
			pending.delete(message.id);
			resolve(message);
		}
	});

	const send = (method, params) => new Promise(resolve => {
		const id = nextId++;
		pending.set(id, resolve);
		ws.send(JSON.stringify({ id, method, params }));
	});

	return { ws, send };
}

//#endregion

//#region --- 比对

function compare(snapshot, expect) {
	const diffs = [];
	const byId = new Map(snapshot.parts.map(part => [part.id, part]));

	for (const [id, spec] of Object.entries(expect.parts ?? {})) {
		const actual = byId.get(id);
		if (!actual) {
			diffs.push(`缺少部件 \`${id}\``);
			continue;
		}
		if (spec.visible !== undefined && actual.visible !== spec.visible) {
			diffs.push(`\`${id}\` visible=${actual.visible}，期望 ${spec.visible}（${actual.w}×${actual.h}, display=${actual.display}）`);
		}
		if (spec.minWidth !== undefined && actual.w < spec.minWidth) {
			diffs.push(`\`${id}\` 宽 ${actual.w} < 期望下限 ${spec.minWidth}`);
		}
		if (spec.maxWidth !== undefined && actual.w > spec.maxWidth) {
			diffs.push(`\`${id}\` 宽 ${actual.w} > 期望上限 ${spec.maxWidth}`);
		}
		if (spec.minHeight !== undefined && actual.h < spec.minHeight) {
			diffs.push(`\`${id}\` 高 ${actual.h} < 期望下限 ${spec.minHeight}`);
		}
	}

	for (const id of expect.forbidVisibleParts ?? []) {
		const actual = byId.get(id);
		if (!actual) {
			continue;
		}
		// ★★ 这里**不能只看 `visible`**：panel 那种坑正是 `0×0` 但 DOM 仍在、
		// 内容溢出渲染（`display` 不是 `none`）—— 只看面积会判成"不可见"而**漏报**。
		// 所以判据是"**DOM 没被隐藏**"：`display !== 'none'` 或仍有面积。
		if (actual.visible || actual.display !== 'none') {
			diffs.push(`\`${id}\` 不应可见，但 DOM 未隐藏（${actual.w}×${actual.h}, display=${actual.display}）`);
		}
	}

	return diffs;
}

//#endregion

async function main() {
	const targets = await listTargets();
	const target = pickTarget(targets);
	console.log(`▶ 目标：${target.title || '(无标题)'}`);
	console.log(`   ${target.url}`);

	const { ws, send } = await connect(target.webSocketDebuggerUrl);

	// ★★ --evalFile=<js 文件>：在跑探测**之前**先在该页执行一段 JS，
	// 用于把 UI 驱动到待测状态（例如点击左上角收缩按钮 ⇒ 折叠态）。
	// ⚠ 用**文件**而不是 --eval=<内联字符串>：内联要穿过 cmd → node 两层引号，
	// 中文/引号/斜杠都容易被吃掉（本仓踩过多次）✗。文件路径是唯一要转义的参数 ✓。
	// ⚠ 脚本里**不得出现反引号**（若它本身又是个模板串），用普通字符串即可。
	const evalFile = optValue('evalFile', null);
	if (evalFile) {
		const abs = path.isAbsolute(evalFile) ? evalFile : path.join(ROOT, evalFile);
		const code = fs.readFileSync(abs, 'utf8');
		const r = await send('Runtime.evaluate', {
			expression: code,
			returnByValue: true,
			awaitPromise: true,
		});
		const exc = r.result?.exceptionDetails;
		if (exc) {
			console.error(`✖ --evalFile 抛错：${exc.exception?.description ?? exc.text}`);
		} else {
			console.log(`▶ --evalFile 结果：${JSON.stringify(r.result?.result?.value)}`);
		}
		// 布局（grid resize / 折叠动画）是异步的 ⇒ 等它稳定再探测，否则量到中间态 ✗。
		await new Promise(res => setTimeout(res, 1500));
	}

	// ★★ --drag="x1,y1>x2,y2"：用 CDP 的 **Input.dispatchMouseEvent** 模拟真实鼠标拖拽。
	//
	// ⚠ 为什么不能靠注入 JS 派发 PointerEvent：合成事件的 `isTrusted=false` ✗，
	// Monaco 的 `Sash`/`Gesture` 不认 ✗（2026-09-15 实测：往 document 派发
	// pointerdown/move/up 完全没反应，`agentEditorGrew: 0` ✓）。
	// CDP 的 Input 域产生的是**受信任**输入 ✓，与真人拖拽等价 ✓。
	//
	// 用途：验证「边框能不能拖」这类**只能靠交互暴露**的 bug ——
	// 例如右栏宽度被 max 夹住时，光看几何量区分不了「默认值」与「被夹住」✗。
	const dragFrom = optValue('dragFrom', null);
	const dragTo = optValue('dragTo', null);
	if (dragFrom && dragTo) {
		const parse = s => {
			const m = /^(\d+),(\d+)$/.exec(s);
			return m ? [Number(m[1]), Number(m[2])] : null;
		};
		const p1 = parse(dragFrom);
		const p2 = parse(dragTo);
		if (!p1 || !p2) {
			console.error('✖ --dragFrom/--dragTo 格式应为 "x,y"');
		} else {
			const [x1, y1] = p1;
			const [x2, y2] = p2;
			const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
				type, x, y, button: 'left', buttons, clickCount: 1,
			});
			await mouse('mouseMoved', x1, y1, 0);
			await mouse('mousePressed', x1, y1, 1);
			const STEPS = 8;
			for (let i = 1; i <= STEPS; i++) {
				await mouse('mouseMoved', Math.round(x1 + ((x2 - x1) * i) / STEPS), Math.round(y1 + ((y2 - y1) * i) / STEPS), 1);
			}
			await mouse('mouseReleased', x2, y2, 0);
			console.log(`▶ 拖拽 ${x1},${y1} → ${x2},${y2} 完成`);
			await new Promise(res => setTimeout(res, 900));
		}
	}

	try {
		const evaluated = await send('Runtime.evaluate', { expression: PROBE_EXPRESSION, returnByValue: true });
		const raw = evaluated.result?.result?.value;
		if (typeof raw !== 'string') {
			console.error('✖ 探测表达式没有返回字符串：', JSON.stringify(evaluated.result).slice(0, 400));
			process.exit(2);
		}
		const snapshot = JSON.parse(raw);

		console.log('');
		console.log(`窗口：${snapshot.window.innerWidth}×${snapshot.window.innerHeight}`);
		console.log('');
		console.log('部件几何量（可见的在前）：');
		const sorted = [...snapshot.parts].sort((a, b) => Number(b.visible) - Number(a.visible) || b.w * b.h - a.w * a.h);
		for (const part of sorted) {
			const flag = part.visible ? '●' : '○';
			console.log(`  ${flag} ${String(part.id ?? '(无 id)').padEnd(38)} ${String(part.w).padStart(5)}×${String(part.h).padEnd(5)} @(${part.x},${part.y})  display=${part.display}`);
		}

		// ★ 图标条宽度链（判定"宽度为 0"发生在哪一层）。
		console.log('');
		console.log('图标条宽度链（.monaco-action-bar.vertical 往上 6 层）：');
		const chain = snapshot.stripChain;
		if (!chain || !chain.found) {
			console.log(`  （未取到：${chain ? chain.reason : '无数据'}）`);
		} else {
			for (const level of chain.chain) {
				console.log(`  .${level.classes}`);
				console.log(`      offset=${level.offsetW}×${level.offsetH}  css=${level.cssW}×${level.cssH}  minW=${level.minW}  maxW=${level.maxW}  flex=${level.flex}  display=${level.display}  position=${level.position}  overflowX=${level.overflowX}`);
			}
			console.log('  全页面 .monaco-action-bar 扫描（有条目的 + 侧栏内的全部）：');
			const withItems = (snapshot.allActionBars ?? []).filter(
				b => b.items > 0 || String(b.path ?? '').indexOf('part.sidebar') !== -1,
			);
			if (!withItems.length) {
				console.log('      （全页面没有任何含 .action-item 的 action bar）');
			}
			for (const b of withItems) {
				console.log(`      .${b.classes}  ${b.w}×${b.h}  items=${b.items}`);
				console.log(`          祖先路径：${b.path ?? '(未采集)'}`);
				console.log(`          标题：${b.titles.join(' | ') || '(空)'}`);
			}
			console.log(`  条目数：${chain.itemCount}`);
			for (const item of chain.items) {
				console.log(`      ${item.offsetW}×${item.offsetH}  display=${item.display}  label.display=${item.labelDisplay}  label=${item.labelSize}  title=${item.title ?? '(无)'}`);
			}
		}

		// ★★ 领养子树专测（2026-09-15）：**只**在 .part.sidebar .part.activitybar 里量
		// —— 这是区分「量错了对象」与「图标条真的被压扁」的判据。
		console.log('');
		console.log('★ 领养子树专测（.part.sidebar .part.activitybar 内部）：');
		const ad = snapshot.adoptedStrip;
		if (!ad || !ad.found) {
			console.log(`  （未取到：${ad ? ad.reason : '无数据'}）`);
		} else {
			console.log(`  部件 rect=(${ad.rect.x},${ad.rect.y}) ${ad.rect.w}×${ad.rect.h}  display=${ad.display}  visibility=${ad.visibility}  overflowY=${ad.overflowY}`);
			console.log('  部件内可见子树（逐层下钻）：');
			for (const lv of ad.chain) {
				console.log(`      .${lv.classes || '(无 class)'}  offset=${lv.offsetW}×${lv.offsetH}  rect=${lv.w}×${lv.h}  css=${lv.cssW}×${lv.cssH}  display=${lv.display}  position=${lv.position}  overflowY=${lv.overflowY}`);
			}
			console.log(`  部件内 .monaco-action-bar：${ad.bars.length} 条`);
			for (const b of ad.bars) {
				console.log(`      .${b.classes}  ${b.w}×${b.h}  items=${b.items}`);
				if (b.firstItem) {
					console.log(`          首个条目：offset=${b.firstItem.offsetW}×${b.firstItem.offsetH}  rect=${b.firstItem.w}×${b.firstItem.h}  css=${b.firstItem.cssW}×${b.firstItem.cssH}  display=${b.firstItem.display}`);
				}
			}
		}

		// ★ 侧栏内容高度链（定位"内容没铺满整列"是哪一层先短了）。
		console.log('');
		console.log('侧栏内容高度链（.part.sidebar > .content）：');
		const contentChain = snapshot.contentChain;
		if (!contentChain || !contentChain.found) {
			console.log('  （未取到 .part.sidebar > .content）');
		} else {
			console.log(`  .content 自身 h=${contentChain.contentH}`);
			console.log('  它的全部子元素：');
			for (const child of contentChain.children) {
				console.log(`      .${child.classes || '(无 class)'}  ${child.w}×${child.h}  display=${child.display}  flex=${child.flex}`);
			}
			console.log('  从第一个可见子元素往下（6 层）：');
			for (const level of contentChain.chain) {
				console.log(`      .${level.classes || '(无 class)'}  h=${level.h}  cssH=${level.cssH}  minH=${level.minH}  flex=${level.flex}  display=${level.display}  overflowY=${level.overflowY}`);
			}
		}

		// ★ sash 诊断（定位"边框拖不动"）。
		console.log('');
		console.log('sash（可拖拽边框）诊断：');
		const sashInfo = snapshot.sashInfo || [];
		if (sashInfo.length === 0) {
			console.log('  （页面上没有可见的 .monaco-sash ⇒ sash 根本没渲染出来）');
		} else {
			for (const s of sashInfo) {
				console.log(`  [${s.cls}]  ${s.w}x${s.h} @(${s.x},${s.y})  cursor=${s.cursor}  pointerEvents=${s.pe}  z=${s.z}  display=${s.display}  visibility=${s.visibility}`);
				console.log(`      parent=[${s.parent}]  命中元素=${s.hit ?? '(未测)'}  hitIsSash=${s.hitIsSash}`);
			}
		}

		// ★★ 图标条条目诊断（直接量目标元素）。
		console.log('');
		console.log('图标条条目诊断：');
		const stripDiag = snapshot.stripDiag;
		if (!stripDiag || !stripDiag.foundBar) {
			console.log('  （侧栏里找不到 .monaco-action-bar.vertical ⇒ 条本身不存在）');
		} else {
			console.log(`  条尺寸：${stripDiag.barSize.w}×${stripDiag.barSize.h}`);
			console.log(`  作用域类 agent-sessions-workbench 命中于：${stripDiag.scopeAt ?? '★ 没找到（祖先链上没有这个类！）'}`);
			console.log(`  .action-item 数量：${stripDiag.itemCount}`);
			for (const it of stripDiag.items) {
				console.log(`      ${it.w}×${it.h}  css=${it.cssW}×${it.cssH}  display=${it.display}  label=${it.labelW}×${it.labelH}  aria=${it.aria ?? '(无)'}`);
			}
			console.log(`  CSS 规则 .composite-bar-container .action-item 是否在已加载样式表中：${stripDiag.ruleFound ? '在 ✓' : '★ 不在 ✗'}`);
			if (stripDiag.ruleText) {
				console.log(`      规则片段：${stripDiag.ruleText}`);
			}
			const abd = stripDiag.activityBar;
			if (abd) {
				console.log(`  activitybar 部件元素：rect=(${abd.rect.x},${abd.rect.y}) ${abd.rect.w}x${abd.rect.h}  position=${abd.position}  marginLeft=${abd.marginLeft}  left=${abd.left}  top=${abd.top}  transform=${abd.transform}`);
				console.log(`      inlineStyle=${abd.inlineStyle ?? '(无)'}`);
				console.log(`      parent=${abd.parent}`);
			} else {
				console.log('  ★ activitybar 部件元素不在 DOM（getElementById 为 null）');
			}
			const apd = stripDiag.appIcon;
			if (apd) {
				console.log('  标题栏 logo：' + apd.rect.w + 'x' + apd.rect.h + '  display=' + apd.display);
				console.log('      backgroundImage=' + apd.backgroundImage);
			} else {
				console.log('  ★ 页面上没有 a.window-appicon');
			}
			if (stripDiag.sidebarChildren) {
				console.log('  .part.sidebar 直接子元素：');
				for (const c of stripDiag.sidebarChildren) {
					console.log('      <' + c.tag + (c.id ? ' #' + c.id : '') + '> .' + c.cls + '  @x=' + c.x + ' ' + c.w + 'x' + c.h + '  display=' + c.display);
				}
			}
			if (stripDiag.viewlet) {
				console.log('  viewlet：x=' + stripDiag.viewlet.rect.x + ' ' + stripDiag.viewlet.rect.w + 'x' + stripDiag.viewlet.rect.h);
				for (const a of stripDiag.viewlet.ancestors) {
					console.log('      ↑ ' + a);
				}
			} else {
				console.log('  ★ 侧栏内没有 .composite.viewlet（视图不在侧栏里）');
			}
		}

		fs.mkdirSync(OUT_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T');
		const snapshotFile = path.join(OUT_DIR, `layout-${stamp}.json`);
		fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, '\t'), 'utf8');
		fs.writeFileSync(path.join(OUT_DIR, 'layout-last.json'), JSON.stringify(snapshot, null, '\t'), 'utf8');

		let shotFile;
		if (DO_SCREENSHOT) {
			const shot = await send('Page.captureScreenshot', { format: 'png' });
			const data = shot.result?.data;
			if (data) {
				shotFile = path.join(OUT_DIR, `layout-${stamp}.png`);
				fs.writeFileSync(shotFile, Buffer.from(data, 'base64'));
			}
		}

		console.log('');
		console.log(`几何量快照：${path.relative(ROOT, snapshotFile)}`);
		console.log(`上一轮快照：${path.relative(ROOT, path.join(OUT_DIR, 'layout-last.json'))}`);
		if (shotFile) {
			console.log(`截图：${path.relative(ROOT, shotFile)}`);
		}

		if (!fs.existsSync(EXPECT_FILE)) {
			console.log('');
			console.log(`（无期望文件 ${path.relative(ROOT, EXPECT_FILE)}，本轮只留档，不判定）`);
			process.exit(0);
		}

		const expect = JSON.parse(fs.readFileSync(EXPECT_FILE, 'utf8'));
		const diffs = compare(snapshot, expect);
		console.log('');
		if (!diffs.length) {
			console.log('✔ 布局与期望一致');
			process.exit(0);
		}
		console.log(`✚ 与期望不符（${diffs.length} 处）：`);
		for (const diff of diffs) {
			console.log(`  ✚ ${diff}`);
		}
		process.exit(1);
	} finally {
		ws.close();
	}
}

main().catch(error => {
	console.error('✖ 探针自身出错：', error);
	process.exit(2);
});
