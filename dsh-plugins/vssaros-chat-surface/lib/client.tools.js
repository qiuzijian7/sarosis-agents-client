// @vssaros/dsh-chat-surface — 工具卡「打开文件」改接到 VsSaros 编辑器（**不遮蔽官方卡**）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.tools.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么不再遮蔽 write/edit 工具卡（2026-10-11 用户要求）──────────────────────
// 此前这里用 `tool.call.toolview` + `key: write|edit` + `priority: -10` 遮蔽官方卡、自绘 VsSaros
// 风格卡（`VssarosFsToolCard`）。用户要求**直接用官方卡**（官方卡渲染更好：完整 diff / 更多信息），
// 所以本 chunk 改职责：**只改「打开文件」的通路，不碰渲染**。
//
// 官方卡的点击最终落到 `ctx.sidebarRight.openResource(url)`：
//   `dsh-client-ui-chat/lib/client.js:12423` `openFile: (path, options) => { const url = …;
//    if (options?.line === void 0) ctx.sidebarRight.openResource(url);
//    else ctx.sidebarRight.openResource(url, { params: { line: options.line } }); }`
// 而右栏在聊天框里被 chat-only CSS 隐藏（`dshPageBridgeProtocol.ts` 的 DSH_CHAT_ONLY_CSS）
// ⇒ 点了看不到东西。这里**替换**该服务方法：
//   · 官方地址（`dsh-resource://file/session/<sid>/<path>`）与 `file://` → 交给页面桥
//     `window.vssarosDsh.openFile(绝对路径, { startLine })`（落到 VsSaros 编辑器）；
//   · 其它 URL / 桥不可用 / 服务只读 → **原样回落**官方实现 ⇒ 不改动任何别的行为。
//
// ── ★ 2026-10-12 修的真 bug：只认 `file://` 等于**这条通路从来没生效过** ──────────────────
// 官方聊天里**所有**"点文件"入口（工具卡路径按钮、正文 markdown 链接、行内 code chip）给的都是
// **`dsh-resource://file/session/<sid>/<相对路径>`**（见 `dsh-client-ui-chat` 的 `fileAddressFor`：
// 工作区内折成相对、工作区外保留绝对），而老代码 `url.slice(0,7) !== 'file://'` 直接判死 ⇒ 每次回落官方
// ⇒ 文件落进被隐藏的右栏 ⇒ **用户点聊天里的文件链接，屏幕上什么都没发生**。
// 老 e2e 只断言 `state.openFileRoute === true`（= "服务被替换过"）⇒ 假绿；现在补 `openFileHits`
// （路由**真的走通**的计数）与"点击 → 编辑器页签"断言。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.tools.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * `file://` URL → 文件系统路径（非 file URL 返回 null = 调用方回落官方实现）。
		 *
		 * 覆盖三种真实形态：`file:///C:/a/b.ts`（Windows 盘符）、`file:///home/u/a.ts`（POSIX）、
		 * `file://server/share/a.ts`（UNC）。查询串与片段截掉，百分号编码解码。
		 */
		function fileUrlToPath(url) {
			if (typeof url !== "string" || url.slice(0, 7).toLowerCase() !== "file://") {
				return null;
			}
			let rest = url.slice(7);
			const hash = rest.indexOf("#");
			if (hash >= 0) { rest = rest.slice(0, hash); }
			const query = rest.indexOf("?");
			if (query >= 0) { rest = rest.slice(0, query); }
			try { rest = decodeURIComponent(rest); } catch { /* 非法编码：按原样用 */ }
			if (rest === "") { return null; }
			if (!rest.startsWith("/")) {
				// UNC：file://server/share/x → //server/share/x
				return "//" + rest;
			}
			// 去掉盘符前多出的那个斜杠：/C:/dir/a.ts → C:/dir/a.ts
			return rest.replace(/^\/(?=[A-Za-z]:[\\/])/, "");
		}

		/** 绝对路径判定（页面里没有 node:path，只能自己判）：盘符 / POSIX 根 / UNC。 */
		function isAbsoluteFsPath(p) {
			return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
		}

		/** 会话 cwd + 地址里的**相对**路径 → 绝对路径（统一 `/` 分隔；主进程侧再归一）。 */
		function joinFsPath(cwd, rel) {
			const base = String(cwd).replace(/[\\/]+$/, "");
			const tail = String(rel).replace(/^[\\/]+/, "");
			return tail === "" ? base : `${base}/${tail}`;
		}

		/** `#L24` / `#L24-L30` / `#24` → 起始行（不认就 undefined：宁可只开文件，也不猜行号）。 */
		function parseLineFragment(fragment) {
			const m = /^#L?(\d+)(?:-L?\d+)?$/i.exec(String(fragment || ""));
			return m ? Number(m[1]) : undefined;
		}

		/** 官方文件地址前缀（`dsh-client-ui-chat` 的 `FILE_ADDRESS_PREFIX`，逐字对齐）。 */
		const DSH_RESOURCE_FILE_PREFIX = "dsh-resource://file/";

		/**
		 * `dsh-resource://file/session/<sid>/<path>` → `{ path, line? }`；不是这种地址 ⇒ **null**（调用方回落官方）。
		 *
		 * 工作区内的地址是**相对**路径 ⇒ 必须用会话 cwd 折绝对（官方同一处就是这么算的：读 `ctx.sessions` 快照）；
		 * 拿不到 cwd 时**如实返回 null**，不猜工作区（猜错会把用户带到另一个文件）。
		 * 只接管 `session` 作用域——别的 scope（如 `workspace-file`）留给官方预览器。
		 */
		function dshResourceUrlToPath(url, cwd) {
			if (typeof url !== "string" || !url.startsWith(DSH_RESOURCE_FILE_PREFIX)) {
				return null;
			}
			let rest = url.slice(DSH_RESOURCE_FILE_PREFIX.length);
			const hash = rest.indexOf("#");
			const line = hash >= 0 ? parseLineFragment(rest.slice(hash)) : undefined;
			if (hash >= 0) { rest = rest.slice(0, hash); }
			const query = rest.indexOf("?");
			if (query >= 0) { rest = rest.slice(0, query); }
			const segments = rest.split("/");
			if (segments[0] !== "session") {
				return null;
			}
			const encoded = segments.slice(2).join("/");
			let path;
			try { path = decodeURIComponent(encoded); } catch { path = encoded; }
			if (!path) {
				return null;
			}
			if (isAbsoluteFsPath(path)) {
				return { path, line };
			}
			if (typeof cwd !== "string" || cwd === "") {
				return null;
			}
			return { path: joinFsPath(cwd, path), line };
		}

		/** 当前会话 cwd（官方同款取法：`ctx.sessions` 快照）；取不到返回 undefined。 */
		function sessionCwdOf(ctx, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") {
				return undefined;
			}
			try {
				const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
				const list = sessions && sessions.list;
				const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined;
				const cwd = snapshot && snapshot.byId ? snapshot.byId[sessionId] && snapshot.byId[sessionId].cwd : undefined;
				return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
				// ★★ 2026-10-30（用户要求「desktop 用 dsh 原生交互、IDE 用 IDE 交互」）：
				//   **desktop 窗口（`chatOnly=0`）整段不装** —— 它自带官方右栏（`[data-slot="rightbar"]`），
				//   文件链接就该开在 dsh 右栏预览里；从前这里无条件 patch `openResource` ⇒ 桌面窗口点
				//   工具卡路径会**跳到 IDE 编辑器**，把原生交互换掉了 ✗。判据由入口算好放 `shell.ide`。
				if (!shell.ide) {
					state.openFileRoute = false;
					state.openFileRouteSkipped = "desktop 窗口（chatOnly=0）：保留官方右栏预览，不改道 IDE";
					return;
				}
				// ── 「打开文件」改接 VsSaros（方案 5.14 批次 3 的替代实现）──────────────
				// 服务名与 dsh 官方一致（`ctx.sidebarRight.openResource`）；取不到/只读时如实记 false，
				// 不做任何兜底伪造（宁可点了走官方隐藏右栏，也不要静默吞掉点击）。
				try {
					const sidebarRight = typeof ctx.get === "function" ? ctx.get("sidebarRight") : undefined;
					const original = sidebarRight && typeof sidebarRight.openResource === "function"
						? sidebarRight.openResource
						: null;
					if (!original || !bridge || typeof bridge.openFile !== "function") {
						state.openFileRoute = false;
						return;
					}
					const patched = function (url, options) {
						const params = options && options.params;
						const lineOpt = params && typeof params.line === "number" ? params.line : undefined;
						// 两种地址：官方 `dsh-resource://…`（**常态**，2026-10-12 起才认）与 `file://`（保留：
						// 老调用点 / 单测 / 其它宿主可能仍用它）。
						const target = dshResourceUrlToPath(url, sessionCwdOf(ctx, state.sessionId || shell.sessionId))
							|| (function () {
								const p = fileUrlToPath(url);
								return p === null ? null : { path: p, line: undefined };
							})();
						if (target !== null) {
							const startLine = target.line !== undefined ? target.line : lineOpt;
							try {
								void Promise.resolve(bridge.openFile(target.path, startLine === undefined ? undefined : { startLine }))
									.then(
										() => { state.openFileHits = (state.openFileHits | 0) + 1; state.openFilePath = target.path; },
										e => { state.openFileError = String((e && e.message) || e); },
									)
									.catch(() => undefined);
								return; // 已交给 VsSaros ⇒ 不再走（隐藏的）右栏
							} catch (e) { state.openFileError = String((e && e.message) || e); /* 桥调用同步抛：回落官方 */ }
						}
						return original.call(this, url, options);
					};
					sidebarRight.openResource = patched;
					// 服务对象可能被冻结/只读：赋值后如实核对，别谎报已生效。
					state.openFileRoute = sidebarRight.openResource === patched;
					state.fsToolCard = false; // 兼容旧状态位：本 chunk 不再自绘工具卡
				} catch (e) {
					state.openFileRoute = false;
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = { fileUrlToPath, dshResourceUrlToPath, isAbsoluteFsPath, joinFsPath, parseLineFragment };
		return module.exports;
	}
});
