/*
 * 把 IDE 侧构建的 React 知识库侧栏（`webview/media/kbSideview.js`）同步到 dsh 插件，
 * 并产出一个「插件页宿主」HTML —— 让 **agents 窗口的知识库**与 **IDE 侧栏**跑同一份 UI 代码。
 *
 * 为什么需要这一步：两边是不同发布单元（IDE 工作台 vs dsh 插件 npm 包），
 * 插件页是 Host 用 HTTP 服务的，**读不到 IDE 的 src 树** ⇒ 必须把产物复制过来。
 *
 * 产出：
 *   dsh-plugins/vssaros-kb/lib/web/kbSideview.js     ← 由 esbuild 产出，原样复制
 *   dsh-plugins/vssaros-kb/lib/web/sideview.html     ← 宿主页（数据来自 /x/kb/api/page）
 *
 * 用法：
 *   node dsh-plugins/vssaros-kb/scripts/sync-kb-sideview.mjs
 *   （改完 React 组件后：先在 webview 子工程 build:kbSideview，再跑本脚本）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');
const SRC_BUNDLE = join(REPO_ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media', 'kbSideview.js');
const OUT_DIR = join(PLUGIN_ROOT, 'lib', 'web');
const OUT_BUNDLE = join(OUT_DIR, 'kbSideview.js');
// 编辑器是**独立 bundle**（进入编辑态才按需加载）⇒ 单独一份产物
const SRC_EDITOR = join(SRC_BUNDLE.replace(/kbSideview\.js$/, 'kbEditor.js'));
const OUT_EDITOR = join(OUT_DIR, 'kbEditor.js');

if (!existsSync(SRC_BUNDLE)) {
	console.error(`✗ 找不到构建产物：${SRC_BUNDLE}`);
	console.error('  先在 src/vs/sessions/contrib/agentStudio/webview 下执行：npm run build:kbSideview');
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const bundle = readFileSync(SRC_BUNDLE);
writeFileSync(OUT_BUNDLE, bundle);
// 编辑器 bundle：存在才同步（没装 vendor-codemirror 的机器上不该因此报错）
if (existsSync(SRC_EDITOR)) {
	const ed = readFileSync(SRC_EDITOR);
	writeFileSync(OUT_EDITOR, ed);
	console.log(`✓ → lib/web/kbEditor.js  (${(ed.length / 1024).toFixed(1)} KB，编辑态按需加载)`);
} else {
	console.log('（跳过）没找到 kbEditor.js：编辑器将退回 textarea');
}
console.log(`✓ ${SRC_BUNDLE.replace(REPO_ROOT, '.')} → lib/web/kbSideview.js  (${(bundle.length / 1024).toFixed(1)} KB)`);

// ★ 2026-10-24：同一份 bundle 再落一份到 `lib/client.kbview.js`。
//   为什么需要第二份：工作台面板里用 `<script src>` 拉 `/x/kb/web/kbSideview.js` **被宿主挡掉**
//   （真机报错「bundle 加载失败」）—— 页面子资源请求不走插件路由；而插件自己的 client 子块
//   走的是**装载器**（`client.kb.js` 就是这么加载的，通道已验证可用）。
//   ⚠ 装载器只认 `client.<名字>.js` 命名，改成别的名字会被拒 ⇒ 名字不能随便取。
// ⚠ 必须包成装载器认的 chunk 形态（`window.__ModuleLoader__.load({id, chunk, factory})`）——
//   裸 IIFE 直接 require.async 会被拒（装载器期待 factory 注册）。bundle 在 factory 体内执行，
//   它自己会把 `window.__KB_SIDEVIEW_MOUNT__` 挂到全局 ✓。
writeFileSync(join(OUT_DIR, '..', 'client.kbview.js'),
	'window.__KB_SIDEVIEW_EMBED__ = true;\n'   // ★ 关键：告知 bundle「你是被宿主挂载的」，禁止自举
	+ 'window.__ModuleLoader__.load({ id: \'@vssaros/dsh-kb/view\', chunk: \'client.kbview.js\', factory: () => {\n'
	+ bundle.toString('utf8')
	+ '\nreturn {}; } });\n');
console.log('✓ → lib/client.kbview.js（给工作台面板走装载器加载）');

// ── 宿主页 ────────────────────────────────────────────────────────────────
// 顺序很关键：**先注入数据、再加载 bundle**（bundle 在顶层就 createRoot 并读 __KB_SIDEVIEW_DATA__）
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>知识库</title>
<style>
	html, body { margin: 0; height: 100%; background: var(--vscode-sideBar-background, #252526); }
	#root { height: 100%; }
	#boot { display: grid; place-items: center; height: 100%; color: #9d9d9d;
		font: 13px "Segoe UI", "Microsoft YaHei", sans-serif; }
</style>
</head>
<body>
<div id="root"><div id="boot">正在加载知识库…</div></div>
<script>
/*
 * 适配层：把 dsh 插件的 \`/x/kb/api/page\` 形状 → React 组件的数据契约。
 *
 * 两侧的差别只有一处：组件的 \`path\` 由**宿主自己解释**。
 *   - IDE 侧：\`笔记/01_学习/x\`（宿主自己拼 notesDir）
 *   - 插件页：直接用服务端给的 **abs 绝对路径**（\`/api/doc?uri=\` 就吃它）
 * ⇒ 同一份组件，两种 path 语义，不需要改组件 ✓
 */
// 数据由服务端统一组装（GET /x/kb/api/view-data）—— 此处**不再自己映射字段**。
// 为什么改：以前这里有一份 mapNodes / links，工作台面板里又有一份 ⇒ 字段会漂移
//   （「面板 101 篇、页面 102 篇」这类差异就是这么来的）。收回到服务端后只改一处。
// 注意：本段处在模板字符串里 —— 注释不能出现反引号，也不能写反斜杠 n。

// 写操作（/api/new|rename|delete）需要 vaultId + 库根目录（把绝对路径折回相对路径）
let VAULT_ID = '';
let VAULT_DIR = '';

async function boot() {
	window.__KB_BOOT_STAGE__ = 'start';
	let data = { vaultName: '(未连接)', vaults: [], noteCount: 0, tree: [], library: [], libraryCount: 0, tags: [], indexState: 'ready' };
	window.__KB_SIDEVIEW_DATA__ = data;
	try {
		// supportPageVaultSwitch：页面切库靠 URL 参数 ?vault= 传下去。
		// 之前固定打 /api/view-data（不带参数）⇒ 即便下拉里选了别的库，取数仍是默认库。
		const wantVault = new URLSearchParams(window.location.search).get('vault') || '';
		const res = await fetch('/x/kb/api/view-data' + (wantVault ? ('?vault=' + encodeURIComponent(wantVault)) : ''), { credentials: 'same-origin', cache: 'no-store' });
		const body = await res.json();
		if (body && body.ok && body.data) {
			data = body.data;
			VAULT_ID = String(data.activeVaultId || '');
			const list = data.vaults || [];
			const cur = list.find(v => v.id === VAULT_ID) || list[0];
			if (cur) { VAULT_DIR = String(cur.dir || ''); }
		}
	} catch (e) {
		data.indexState = 'stale';
		console.error('[kb-sideview] 读取 /api/view-data 失败', e);
	}

	window.__KB_SIDEVIEW_DATA__ = data;
	window.__KB_BOOT_STAGE__ = 'data';

	// ② 动作：插件页能做的先接上，做不了的如实记录（不假装成功）
	const post = (path, body) => fetch('/x/kb/api' + path, {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body || {}),
	});
	// 组件的 path 是**绝对路径**（插件侧约定的宿主语义），而 /api/rename|delete 要相对库根的 rel
	const BS = String.fromCharCode(92);            // 反斜杠（避免在模板串里堆转义）
	const norm = s => String(s || '').split(BS).join('/');
	const relOf = abs => {
		const a = norm(abs);
		const root = norm(VAULT_DIR).replace(new RegExp('/+$'), '');
		return root && a.indexOf(root) === 0 ? a.slice(root.length).replace(new RegExp('^/+'), '') : a;
	};
	// ETag 备忘（2026-10-26，P2）：uri → { etag, doc }；304 时直接复用上次的对象
	const docEtagCache = new Map();

	const writeOp = (path, body) => post(path, body).then(r => r.json()).then(b => {
		if (b && b.ok === false) { window.alert('操作失败：' + (b.error || '未知错误')); return; }
		window.location.reload();            // 写成功后整页重载（数据是服务端渲染进 html 的）
	}).catch(e => window.alert('操作失败：' + (e && e.message ? e.message : e)));

	// ── 只读报告层（2026-10-25）────────────────────────────────────────
	// 为什么页面上要自己做一个：视图的「体检 / 审核 / 去重」按钮按能力门控，
	//   而设置页容器在**工作台面板**侧（React）。插件页没有那个容器 ⇒ 之前三个按钮不出现。
	//   这里用最小 DOM 弹层承载**同样的报告**，数据全部来自已有路由（不重写后端逻辑）。
	// ⚠ 本段在模板串里 ⇒ 注释不许出现反引号，换行用 String.fromCharCode(10)。
	const kbReportOverlay = (title, lines, actions) => {
		const NL = String.fromCharCode(10);
		const old = document.getElementById("kb-report");
		if (old) { old.remove(); }
		const wrap = document.createElement("div");
		wrap.id = "kb-report";
		wrap.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;";
		const box = document.createElement("div");
		box.style.cssText = "width:min(760px,92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--vscode-sideBar-background,#252526);color:inherit;border:1px solid rgba(127,127,127,.35);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.5);";
		const bar = document.createElement("div");
		bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.25);";
		const h2 = document.createElement("div");
		h2.textContent = title;
		h2.style.cssText = "font:600 13px/1.4 system-ui,sans-serif;";
		const spacer = document.createElement("div");
		spacer.style.flex = "1";
		bar.appendChild(h2); bar.appendChild(spacer);
		for (const a of (actions || [])) {
			const b = document.createElement("button");
			b.textContent = a.label;
			b.style.cssText = "height:24px;padding:0 10px;font-size:11.5px;cursor:pointer;border-radius:4px;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.35);";
			b.onclick = a.onClick;
			bar.appendChild(b);
		}
		const close = document.createElement("button");
		close.textContent = "关闭";
		close.style.cssText = "height:24px;padding:0 10px;font-size:11.5px;cursor:pointer;border-radius:4px;background:transparent;color:inherit;border:1px solid rgba(127,127,127,.35);";
		close.onclick = () => wrap.remove();
		bar.appendChild(close);
		const pre = document.createElement("pre");
		pre.textContent = (lines || []).join(NL);
		pre.style.cssText = "margin:0;padding:12px;overflow:auto;white-space:pre-wrap;font:12px/1.7 var(--vscode-editor-font-family,monospace);";
		box.appendChild(bar); box.appendChild(pre);
		wrap.appendChild(box);
		wrap.addEventListener("click", ev => { if (ev.target === wrap) { wrap.remove(); } });
		document.body.appendChild(wrap);
		return wrap;
	};

	// 体检 / 查重 / 审核：都是"拉一次 → 显示一段文本"，共用同一个弹层
	const renderHealthText = r => {
		const out = [];
		out.push("笔记 " + r.total + " · 图谱节点 " + r.nodes + " · 边 " + r.edges);
		out.push("孤立 " + r.orphanCount + " · 断链 " + r.brokenCount + " · 无标签 " + r.noTagCount + " · 空目录 " + r.emptyDirCount + " · 同名 " + r.dupNameCount);
		if (r.brokenCount) { out.push(""); out.push("断链（前 10）："); for (const x of (r.broken || []).slice(0, 10)) { out.push("  " + String(x.from).split("/").pop() + "  ->  " + x.target); } }
		if (r.orphanCount) { out.push(""); out.push("孤立笔记（前 10）："); for (const x of (r.orphans || []).slice(0, 10)) { out.push("  " + String(x).split("/").pop()); } }
		if (r.emptyDirCount) { out.push(""); out.push("空目录（前 10）："); for (const x of (r.emptyDirs || []).slice(0, 10)) { out.push("  " + String(x)); } }
		return out;
	};
	window.__KB_SIDEVIEW_ACTIONS__ = {
		openNode: p => { window.location.href = '/x/kb/doc?uri=' + encodeURIComponent(p); },
		openLink: p => { window.location.href = '/x/kb/doc?uri=' + encodeURIComponent(p); },
		refresh: () => window.location.reload(),
		openGraph: () => { window.location.href = '/x/kb/graph'; },
		// ★ 2026-10-25（真机：插件页点 ⚙ 没反应）：**不再提供假的 openSettings**。
		//   视图的逻辑是「有 openSettings 就交给宿主；没有就打开自己的设置面板」。
		//   之前这里只是 console.warn ⇒ 宿主算"有"，面板却永远打不开。
		//   现在不提供 ⇒ 视图用自己的设置面板（库切换 / 排序 / 能力清单 / 诊断）。
		switchVault: id => {
			const u = new URL(window.location.href);
			u.searchParams.set('vault', String(id || ''));
			window.location.href = u.href;
		},
		// 新建 / 本地载入库：POST /api/vault-add，成功后带新库 id 重开页面
		addVault: (mode, path, name) => {
			fetch('/x/kb/api/vault-add', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode: mode, path: path, name: name }),
			}).then(r => r.json()).then(b => {
				if (!b || b.ok === false) { window.alert('操作失败：' + String((b && b.error) || '未知错误')); return; }
				const u = new URL(window.location.href);
				u.searchParams.set('vault', String((b.vault && b.vault.id) || ''));
				window.location.href = u.href;
			}).catch(e => window.alert('操作失败：' + String((e && e.message) || e)));
		},
		// 全文检索（2026-10-23）：同源 fetch，天然异步 ⇒ 直接返回 Promise（组件按 Promise 兑现）
		// 失败/字段不符 ⇒ 返回 undefined（组件退回"按名过滤"，不显示假的空结果 ✗）
		search: (q, m) => {
			if (!q || !String(q).trim()) { return Promise.resolve([]); }
			if (m !== 'fulltext') { return Promise.resolve(undefined); }
			return fetch('/x/kb/api/search?q=' + encodeURIComponent(String(q).trim()) + '&limit=20', { credentials: 'same-origin' })
				.then(r => r.json())
				.then(b => {
					const raw = (b && (b.hits || b.results || b.items)) || null;
					if (!Array.isArray(raw)) { return undefined; }
					return raw.map(h => ({
						title: String(h.title || h.name || String(h.path || h.rel || '').split('/').pop() || '').replace(/\.md$/i, ''),
						path: h.abs || h.path || h.rel || '',
						snippet: String(h.snippet || h.preview || '').replace(/\s+/g, ' ').slice(0, 110),
					})).filter(h => !!h.path);
				})
				.catch(() => undefined);
		},
		// 插件页没有"按标签过滤"这条路由 ⇒ 如实告知（原来只 console.warn，看起来像坏了）
		pickTag: t => window.alert('插件页暂不支持按标签筛选：' + String(t) + String.fromCharCode(10) + '请在工作台面板里使用「标签分类」。'),
		// ── 三项只读报告（2026-10-25）：页面也有入口，数据来自已有路由 ──
		runLint: () => {
			fetch("/x/kb/api/health", { credentials: "same-origin" })
				.then(r => r.json())
				.then(b => {
					if (!b || b.ok === false) { window.alert("体检失败：" + String((b && b.error) || "未知原因")); return; }
					kbReportOverlay("体检报告", renderHealthText(b.report || {}));
				})
				.catch(e => window.alert("体检失败：" + String((e && e.message) || e)));
		},
		runDedup: () => {
			const NL = String.fromCharCode(10);
			fetch("/x/kb/api/dedupe", { credentials: "same-origin" })
				.then(r => r.json())
				.then(b => {
					if (!b || b.ok === false) { window.alert("查重失败：" + String((b && b.error) || "未知原因")); return; }
					const out = ["已扫描 " + b.scanned + " 篇 · 完全重复 " + b.exactCount + " 组 · 近似重复 " + b.pairCount + " 对（阈值 " + b.threshold + "）"];
					if (b.exactCount) { out.push(""); out.push("完全重复："); for (const list of (b.exact || []).slice(0, 10)) { out.push("  " + list.map(x => String(x).split("/").pop()).join("  =  ")); } }
					if (b.pairCount) { out.push(""); out.push("近似重复（前 10 对）："); for (const x of (b.pairs || []).slice(0, 10)) { out.push("  " + Math.round(x.similarity * 100) + "%  " + String(x.a).split("/").pop() + "  <->  " + String(x.b).split("/").pop()); } }
					if (!b.exactCount && !b.pairCount) { out.push(""); out.push("没有发现重复（这通常是好事）"); }
					out.push(""); out.push("（只报告，不修改任何文件）");
					kbReportOverlay("查重报告", out);
				})
				.catch(e => window.alert("查重失败：" + String((e && e.message) || e)));
		},
		reviewQueue: () => {
			fetch("/x/kb/api/review", { credentials: "same-origin" })
				.then(r => r.json())
				.then(b => {
					if (!b || b.ok === false) { window.alert("读取审核清单失败：" + String((b && b.error) || "未知原因")); return; }
					const out = ["共 " + b.total + " 篇 · 已审 " + b.approvedCount + " · 未审 " + b.unreviewedCount + " · 驳回 " + (b.rejectedCount || 0)];
					out.push("");
					out.push("未审（前 20）：");
					for (const x of (b.unreviewed || []).slice(0, 20)) { out.push("  " + x.rel); }
					if (!(b.unreviewed || []).length) { out.push("  （都审完了）"); }
					out.push(""); out.push("（标记请在 设置 → 📋 审核 里逐篇操作）");
					kbReportOverlay("审核概览", out);
				})
				.catch(e => window.alert("读取审核清单失败：" + String((e && e.message) || e)));
		},
		// 2026-10-24：Electron 不支持 window.prompt（confirm 也不可靠）⇒ 视图自己弹框，宿主只执行
		// 同步飞书（2026-10-24）：走插件路由跑随包脚本，与 kb_feishu_sync 同一份实现。
		// 注意：本段处在模板串里 —— 注释里不能出现反引号（会把模板提前闭合），
		// 也不能写反斜杠 n（会被模板吃掉成真换行而打断字符串）⇒ 换行一律用 String.fromCharCode(10)。
		feishuSync: () => {
			window.alert('开始同步飞书…逐篇串行，可能需要几分钟。');
			fetch('/x/kb/api/feishu-sync', { method: 'POST', credentials: 'same-origin' })
				.then(r => r.json())
				.then(b => {
					const NL = String.fromCharCode(10);
					const raw = String((b && b.output) || '').replace(new RegExp(String.fromCharCode(13), 'g'), '');
					const tail = raw.split(NL).filter(Boolean).slice(-12).join(NL);
					window.alert((b && b.ok ? '同步完成' : '同步结束（有失败项，见下）') + NL + NL + (tail || (b && b.error) || '(无输出)'));
				})
				.catch(e => window.alert('同步失败：' + String((e && e.message) || e)));
		},
		// 三端共用视图后页面也有导图：只需声明"服务端有 /api/canvas"
		canvas: true,
		// 站外链接（2026-10-26）：正文里的 https 链接交给浏览器新窗口打开
		// 站外链接：延迟复查是否真的开了（Electron 里 window.open 可能"返回对象但立刻关闭"）
		// 在系统文件管理器里定位：交给服务端 spawn（渲染进程没有外壳权限）
		reveal: p => {
			fetch('/x/kb/api/reveal', { method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uri: String(p) }) })
				.then(r => r.json())
				.then(b => { if (!b || b.ok === false) { window.alert("打开资源管理器失败：" + String((b && b.error) || "未知原因")); } })
				.catch(e => window.alert("打开资源管理器失败：" + String((e && e.message) || e)));
		},
		openUrl: url => {
			const u = String(url);
			let w = null;
			try { w = window.open(u, "_blank"); } catch (e) { w = null; }
			window.setTimeout(() => {
				let blocked = false;
				try { blocked = !w || w.closed === true; } catch (e) { blocked = true; }
				if (!blocked) { return; }
				try { if (navigator.clipboard && navigator.clipboard.writeText) { void navigator.clipboard.writeText(u); } } catch (e) { /* 忽略 */ }
				window.alert("宿主没有打开新窗口（可能被安全策略拦截）。链接已复制：" + String.fromCharCode(10) + u);
			}, 500);
		},
		useInlineDialogs: true,
		// 内嵌阅读：插件页没有 IDE 编辑区 ⇒ 提供 loadDoc，视图渲染右栏正文
		loadDoc: p => {
			const uri = String(p);
			const prev = docEtagCache.get(uri);
			return fetch('/x/kb/api/doc?uri=' + encodeURIComponent(p), {
				credentials: 'same-origin',
				headers: prev && prev.etag ? { 'if-none-match': prev.etag } : undefined,
			})
				.then(r => ((r.status === 304 && prev) ? prev.doc : r.json()))
				.then(b => {
					const t = b && (b.text ?? b.content ?? b.body);
					const doc = {
					title: String(p).split('/').pop().replace(/\.md$/i, ''),
					text: typeof t === 'string' ? t : ((b && b.error) || '(读不到正文)'),
					// 文档所在目录（用于把相对图片折成绝对路径）
					base: String(p).replace(new RegExp('[\\\\/][^\\\\/]*$'), ''),
					// 保存时的前置校验用（磁盘 mtime；0 = 未知，服务端跳过校验）
					mtime: (b && b.mtime) || 0,
					// 服务端渲染好的 HTML（markdown-it + Obsidian 方言）
					html: (b && typeof b.html === 'string') ? b.html : '',
						math: !!(b && b.math),
					};
					// 只有读成功且有 etag 才记（失败不记，避免下次拿缓存冒充成功）
					if (doc && doc.text && b && typeof b.etag === 'string' && b.etag) {
						docEtagCache.set(uri, { etag: b.etag, doc: doc });
					}
					return doc;
				})
				.catch(() => ({ title: String(p).split('/').pop(), text: '读取失败' }));
		},
		// 图片：交给插件的 /api/asset（围栏与 /api/doc 同源，只白名单展示型 MIME）
		assetUrl: abs => '/x/kb/api/asset?uri=' + encodeURIComponent(abs),
		// 附件上传（粘贴/拖入图片）：body 直接是 File，服务端收原始字节
		uploadAsset: (file, docPath) => {
			const q = '?doc=' + encodeURIComponent(docPath) + '&name=' + encodeURIComponent(file.name || 'pasted.png');
			return fetch('/x/kb/api/asset/upload' + q, {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': file.type || 'application/octet-stream' },
				body: file,
			}).then(r => r.json()).catch(() => ({ ok: false, error: '上传失败（响应不是 JSON）' }));
		},
		// 备份历史 / 恢复
		listBackups: p => fetch('/x/kb/api/backup?doc=' + encodeURIComponent(p), { credentials: 'same-origin' })
			.then(r => r.json()).catch(() => ({ ok: false, error: '读取备份失败（响应不是 JSON）' })),
		restoreBackup: (p, name) => fetch('/x/kb/api/backup/restore', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ doc: p, name }),
		}).then(r => r.json()).catch(() => ({ ok: false, error: '恢复失败（响应不是 JSON）' })),
		// 保存正文（行内编辑 / 任务勾选）：服务端只允许写「笔记」区的 .md
		saveDoc: (p, text, expectedMtime) => fetch('/x/kb/api/doc', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(expectedMtime ? { uri: p, text, expectedMtime } : { uri: p, text }),
		}).then(r => r.json()).catch(() => ({ ok: false, error: '保存失败（响应不是 JSON）' })),

		// ── 写操作（2026-10-23）：入参照抄 client.kb.js:219/239/261，别再自己猜字段名 ──
		createNote: (dir, name) => {
			const n = String(name || '').trim();
			if (n) { void writeOp('/new', { vaultId: VAULT_ID, kind: 'note', dir: dir || '笔记', name: n }); }
		},
		newFolder: (dir, name) => {
			const n = String(name || '').trim();
			if (n) { void writeOp('/new', { vaultId: VAULT_ID, kind: 'folder', dir: dir || '笔记', name: n }); }
		},
		renameNode: (p, newName) => {
			const n = String(newName || '').trim();
			const rel = relOf(p);
			const segs = rel.split('/');
			const base = segs.pop() || '';
			const isMd = /\.md$/i.test(base);
			if (!n || n === base.replace(/\.md$/i, '')) { return; }
			const to = segs.concat(n + (isMd ? '.md' : '')).join('/');
			void writeOp('/rename', { vaultId: VAULT_ID, from: rel, to: to, mode: 'move' });
		},
		// 拖拽移动（2026-10-23）：走现成的 /api/rename（mode=move）。多选批量 ⇒ 串行发，最后一个再 reload
		moveNodes: (froms, toFolder) => {
			const list = (froms || []).map(relOf).filter(Boolean);
			if (!list.length) { return; }
			const dirRel = relOf(toFolder).replace(new RegExp('/+$'), '');
			const jobs = list.map(rel => {
				const base = rel.split('/').pop() || '';
				return { rel, to: dirRel + '/' + base };
			}).filter(j => j.to !== j.rel);
			if (!jobs.length) { return; }
			let i = 0;
			const next = () => {
				if (i >= jobs.length) { window.location.reload(); return; }
				const job = jobs[i++];
				post('/rename', { vaultId: VAULT_ID, from: job.rel, to: job.to, mode: 'move' })
					.then(r => r.json())
					.then(b => { if (b && b.ok === false) { console.warn('[kb-sideview] 移动失败：', job.rel, b.error); } })
					.catch(e => console.warn('[kb-sideview] 移动失败：', job.rel, e))
					.then(next);
			};
			next();
		},
		// 批量删除（多选右键）：只确认一次，串行发完再 reload
		deleteNodes: (paths, skipConfirm) => {
			const list = (paths || []).map(relOf).filter(Boolean);
			if (!list.length) { return; }
			if (!skipConfirm && !window.confirm('删除选中的 ' + list.length + ' 项？（移到回收站，可在旧页恢复）')) { return; }
			let i = 0;
			const next = () => {
				if (i >= list.length) { window.location.reload(); return; }
				const rel = list[i++];
				post('/delete', { vaultId: VAULT_ID, from: rel })
					.then(r => r.json())
					.then(b => { if (b && b.ok === false) { console.warn('[kb-sideview] 删除失败：', rel, b.error); } })
					.catch(e => console.warn('[kb-sideview] 删除失败：', rel, e))
					.then(next);
			};
			next();
		},
		deleteNode: p => {
			const rel = relOf(p);
			void writeOp('/delete', { vaultId: VAULT_ID, from: rel });
		},
	};
	void post;   // 供后续写操作（/api/new、/api/rename、/api/delete）复用
	window.__KB_BOOT_STAGE__ = 'actions';

	// ③ 再加载 UI
	const s = document.createElement('script');
	s.src = '/x/kb/web/kbSideview.js';
	s.onerror = () => { document.getElementById('boot').textContent = '加载 kbSideview.js 失败（先跑 sync-kb-sideview.mjs）'; };
	document.body.appendChild(s);
	document.getElementById('boot')?.remove();
}

boot().catch(e => { window.__KB_BOOT_STAGE__ = 'ERR:' + String((e && e.message) || e); });
</script>
</body>
</html>
`;

const outHtml = join(OUT_DIR, 'sideview.html');
/*
 * ★★ 2026-10-26（P4）：把页内 `<script>` **外置**成 `web/page-boot.js`。
 *   为什么必须外置：只要还有内联脚本，CSP 就只能写 `script-src 'unsafe-inline'`，
 *   那等于没加防护。外置后服务端可以要求 `script-src 'self'`。
 *   抽取放在生成之后、写盘之前 —— 模板本身不用改结构，减少再次把转义写坏的风险。
 */
const inlineMatch = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!inlineMatch) {
	console.error('✗ 没找到页内脚本：模板结构变了（外置步骤需要它）');
	process.exit(1);
}
const bootJs = inlineMatch[1];
const htmlWithSrc = html.replace(inlineMatch[0], '<script src="/x/kb/web/page-boot.js" defer></script>');
const outBoot = join(OUT_DIR, 'page-boot.js');
writeFileSync(outBoot, bootJs, 'utf8');
writeFileSync(outHtml, htmlWithSrc, 'utf8');
console.log(`✓ 生成 lib/web/sideview.html  (${(statSync(outHtml).size / 1024).toFixed(1)} KB)`);
console.log(`✓ 生成 lib/web/page-boot.js  (${(statSync(outBoot).size / 1024).toFixed(1)} KB，脚本已外置以便 CSP)`);
console.log('\n下一步（在 lib/index.js 的 /x/kb handler 里加两条分支）：');
console.log('  if (url.pathname === `${ROUTE_PREFIX}/sideview`)      → 返回 lib/web/sideview.html');
// ★ 2026-10-24：**生成后立刻做语法校验**（这一条是血换来的）。
//   本文件的 html 是大模板串，模板里 `\/`→`/`、`\n`→真换行、`\\.`→`.` 都会被吃掉：
//   一次 `replace(/\/+$/,'')` 被吃成 `//+$/`（= 注释）⇒ 整段内联脚本 SyntaxError ⇒
//   页面只剩演示数据 + 所有右键/拖拽/删除全失效，而 `node --check` 对**外层** mjs 是绿 ✗。
//   ⇒ 必须校验**生成出来的**那段脚本，且校验失败要**非零退出**（CI/守卫才拦得住）。
try {
	const vm = await import('node:vm');
	new vm.Script(bootJs, { filename: 'page-boot.js' });   // 只解析、不执行
} catch (err) {
	console.error('✗ page-boot.js 语法错误（生成器把转义吃掉了？）：' + String((err && err.message) || err));
	process.exit(1);
}
if (/<script(?![^>]*\bsrc=)/.test(htmlWithSrc)) {
	console.error('✗ 外置后仍有内联脚本 ⇒ CSP 会失效');
	process.exit(1);
}

console.log('  if (url.pathname === `${ROUTE_PREFIX}/web/kbSideview.js`) → 返回 lib/web/kbSideview.js (application/javascript)');
