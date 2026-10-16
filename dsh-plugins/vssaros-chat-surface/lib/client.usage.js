// @vssaros/dsh-chat-surface — 回合用量页脚（conversation.chat.turnTail）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.usage.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 本文件渲染什么 ────────────────────────────────────────────────────────────
// 一行页脚 chips：`◷ 12s`（本轮耗时）· `Σ 74.3k`（本轮 tokens）· `⚡ 99.5%`（**缓存命中率**，
// hover 出「Token 消耗明细」浮层）· `◎ 积分 1.23`（本轮积分，数据由 VsSaros 主进程的计费探针经
// `vssaros-dsh-credit` DOM 事件推来）· `⏹ 已中断`（按需）。
//
// ── 实时性（2026-10-11 用户要求）──────────────────────────────────────────────
// **单回合输出过程中这些 chip 必须实时更新**，所以：
//  ① 耗时：运行中由本地秒级 ticker 刷新（回合结束后用 start/end 的权威值，不跳动）；
//  ② tokens / 缓存命中率：运行中取**各 assistant 步骤的 `usage` 求和** —— 该字段由流式
//     `usage` chunk 就地更新（`dsh-client-ui-chat/lib/client.js:7510` `case "usage": {...state, usage}`），
//     所以每完成一轮 LLM 调用就会看到数字上涨；回合结束后改用 `turn-tail` 节点的权威汇总；
//  ③ 积分：主进程代理抓到一条推一条（DOM 事件），窗口右端在运行中开区间 ⇒ 立刻计入；
//  ④ 数据没到时**不隐藏 chip**，用 0 / — 占位常驻（与 VsSaros 原生面板
//     `agentChatPanel.messages.ts` 的「处理中 0 占位常驻」同口径）。
//
// ── 数据来源（都与官方 TurnUsagePanel 同源，不是我们另造）──────────────────────
// 官方 `TurnUsagePanel` 用的也是这些（`client.js:6606` `TurnUsagePanel({ usage: data.tokenUsage })`），
// 字段为 `{ inputTokens, uncachedInputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
// outputTokens, totalTokens, routes? }`。缓存命中率口径与官方一致：命中 / 输入总量
// （官方 `formatCacheHitPercent(cacheReadTokens, totalTokens - outputTokens)`），
// 与 VsSaros 原生面板（`agentChatPanel.tokenPopup.ts`）的「输入 = 命中+未命中+写入」同义。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.usage.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		// ── 纯逻辑（导出到 exports.__test 供单测直接断言；不参与插件装载）──────────
		/** 数值守卫：非有限数一律 null（= "缺数据"，与 0 必须区分）。 */
		function num(v) {
			return typeof v === "number" && isFinite(v) ? v : null;
		}
		/** 明细里 `null` ⇒ `—`（缺数据）；`0` ⇒ `"0"`（真实读数）。与原生面板 `fmtNum` 同口径。 */
		function formatTokenValue(v) {
			return v === null || v === undefined ? "—" : Math.round(v).toLocaleString("en-US");
		}
		/**
		 * 把一份 `TurnTokenUsage` 归整成页脚/浮层要用的形状。
		 * `prompt`（输入总量）= `inputTokens`，缺省时由 `缓存命中 + 缓存写入 + 未缓存输入` 派生
		 * （与官方 `client.js:6993` 的三项求和同式）。
		 */
		function summarizeTurnUsage(u) {
			if (!u || typeof u !== "object") {
				return null;
			}
			const cacheRead = num(u.cacheReadTokens);
			const cacheWrite = num(u.cacheWriteTokens);
			const uncached = num(u.uncachedInputTokens);
			const output = num(u.outputTokens);
			const reasoning = num(u.reasoningTokens);
			const total = num(u.totalTokens);
			let prompt = num(u.inputTokens);
			if (prompt === null && (cacheRead !== null || cacheWrite !== null || uncached !== null)) {
				prompt = (cacheRead || 0) + (cacheWrite || 0) + (uncached || 0);
			}
			const routes = Array.isArray(u.routes) && u.routes.length > 0 && u.routes[0] && typeof u.routes[0] === "object"
				? { provider: typeof u.routes[0].provider === "string" ? u.routes[0].provider : null,
					model: typeof u.routes[0].model === "string" ? u.routes[0].model : null }
				: null;
			return {
				cacheRead, cacheWrite, uncached, prompt, output, reasoning, total, routes,
				// 回复内容 = 输出 − 思考过程（原生面板同式；缺任一项则 null 让它显示 `—`）
				content: output === null ? null : (reasoning === null ? output : Math.max(0, output - reasoning)),
			};
		}
		/** 把若干份 usage 求和（某项在所有份里都缺失 ⇒ 结果仍是 null = "缺数据"）。 */
		function sumUsage(list) {
			const add = (a, b) => (a === null && b === null ? null : (a || 0) + (b || 0));
			let acc = null;
			for (const raw of list || []) {
				const u = summarizeTurnUsage(raw);
				if (!u) {
					continue;
				}
				acc = acc === null ? u : {
					cacheRead: add(acc.cacheRead, u.cacheRead), cacheWrite: add(acc.cacheWrite, u.cacheWrite),
					uncached: add(acc.uncached, u.uncached), prompt: add(acc.prompt, u.prompt),
					output: add(acc.output, u.output), reasoning: add(acc.reasoning, u.reasoning),
					total: add(acc.total, u.total),
					routes: acc.routes || u.routes,
					content: add(acc.content, u.content),
				};
			}
			return acc;
		}
		/**
		 * 缓存命中率文本（`"99.5%"`）。没有输入量（`prompt <= 0` 或缺失）⇒ `null`（显示 `—`）。
		 *
		 * 诚实性：**部分命中绝不四舍五入成 100%**（官方 `formatCacheHitPercent` 的同一条原则）——
		 * 1 位小数会给出 `"100.0%"` 时改用 2 位小数。
		 */
		function cacheHitRateText(cacheRead, prompt) {
			if (cacheRead === null || prompt === null || prompt <= 0) {
				return null;
			}
			if (prompt - cacheRead <= 0) {
				return "100%";
			}
			const pct = (cacheRead / prompt) * 100;
			const one = pct.toFixed(1);
			return (one === "100.0" ? pct.toFixed(2) : one) + "%";
		}
		/** 三段条宽度（命中 / 写入 / 未命中）；没有输入量时不出条。 */
		function hitRateSegments(info) {
			const prompt = info && info.prompt ? info.prompt : 0;
			const read = info && info.cacheRead !== null ? info.cacheRead : null;
			if (!prompt || read === null) {
				return null;
			}
			const readPct = (read / prompt) * 100;
			const writePct = ((info.cacheWrite || 0) / prompt) * 100;
			const missPct = Math.max(0, 100 - readPct - writePct);
			return { read: readPct, write: writePct, miss: missPct };
		}
		/** 浮层重绘判定用的 usage 指纹（避免"每次都新建对象 ⇒ 每次 store 通知都重渲染"）。 */
		function usageKeyOf(u) {
			if (!u) {
				return "";
			}
			return [u.cacheRead, u.cacheWrite, u.uncached, u.prompt, u.output, u.reasoning, u.total, u.content,
				u.routes ? u.routes.provider + "/" + u.routes.model : ""].join("|");
		}
		/**
		 * 按**回合时间窗**把积分样本归到本回合：`samples` 里 `at ∈ [start, end]` 的样本，
		 * 且（在样本与回合都给出了标识时）provider/model 必须一致 —— 避免把**另一个会话**
		 * 的请求算进来（代理是广播的，见 VsSaros `dshViewHost.pushCredit`）。
		 *
		 * `end === null`（回合运行中）表示窗口上端开区间 ⇒ 边跑边计入。
		 *
		 * @returns `{ credit, responses }`：`credit` 仅在**至少一个**样本真的带 credit 字段时给出
		 * （"响应没有该字段"与"积分 0"必须区分 ⇒ 前者仍显示 `—`）。
		 */
		function creditInWindow(samples, window) {
			let credit = null;
			let responses = 0;
			for (const s of samples || []) {
				if (!s || typeof s.at !== "number") {
					continue;
				}
				if (typeof window.start === "number" && s.at < window.start) {
					continue;
				}
				if (typeof window.end === "number" && s.at > window.end) {
					continue;
				}
				if (window.model && s.model && s.model !== window.model) {
					continue;
				}
				if (window.provider && s.route && s.route !== window.provider) {
					continue;
				}
				responses += 1;
				if (typeof s.credit === "number" && isFinite(s.credit)) {
					credit = (credit === null ? 0 : credit) + s.credit;
				}
			}
			return { credit, responses };
		}
		/** 本轮耗时：`12s` / `1m33s`。 */
		function formatTurnMs(ms) {
			const sec = Math.max(0, Math.round(ms / 1000));
			return sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m" + (sec % 60) + "s";
		}
		/** 本轮 tokens 缩写：`74.3k`。 */
		function formatTurnTokens(n) {
			return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
		}
		/**
		 * 积分取数：优先 `TurnTokenUsage` 里透传的字段（未来由 harness 塞入即自动点亮），
		 * 否则由调用方用主进程代理推来的样本按回合时间窗求和。
		 */
		function pickCredit(usage) {
			if (!usage || typeof usage !== "object") { return null; }
			for (const k of ["creditUsed", "credits", "credit", "cost", "costUsd"]) {
				const v = usage[k];
				if (typeof v === "number" && isFinite(v)) { return v; }
			}
			return null;
		}
		/** 积分展示：≥10 取整，否则最多两位小数（`12.3` / `1.23`）。 */
		function formatTurnCredit(v) {
			return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
		}
		/**
		 * 把 store 里读到的原始数据算成页脚形状（**纯函数** ⇒ 单测可直接跑"运行中/实时上涨"场景）。
		 *
		 * @param input.turn - 回合定位（`{ turn, start?, end? }`；`end` 缺省 = 运行中）
		 * @param input.tailUsage - `turn-tail` 节点的 `tokenUsage`（回合结束后的权威汇总）
		 * @param input.stepUsages - 本回合各 assistant 步骤的 `usage`（**流式过程中就更新**）⇒ 运行中用它
		 * @param input.legacyMs - `legacy.turnTimings` 回落的耗时（无 start/end 时用）
		 * @param input.now - 当前时间（运行中算耗时；由组件秒级 ticker 驱动刷新）
		 * @param input.samples - 主进程代理推来的积分样本
		 * @param input.interrupted - 是否被中断
		 */
		function deriveTurnFooter(input) {
			const turn = (input && input.turn) || {};
			const startedAt = turn.start && typeof turn.start.time === "number" ? turn.start.time : null;
			const endedAt = turn.end && typeof turn.end.time === "number" ? turn.end.time : null;
			const running = endedAt === null;
			let ms = null;
			if (startedAt !== null && endedAt !== null) {
				ms = endedAt - startedAt;
			} else if (startedAt !== null && typeof input.now === "number") {
				ms = Math.max(0, input.now - startedAt);
			} else if (typeof input.legacyMs === "number") {
				ms = input.legacyMs;
			}
			// 运行中：各步骤 usage 实时求和；结束后：turn-tail 的权威汇总（缺失时回落逐步求和）。
			let usage = running ? (sumUsage(input.stepUsages) || summarizeTurnUsage(input.tailUsage)) : summarizeTurnUsage(input.tailUsage);
			if (!usage) {
				usage = sumUsage(input.stepUsages);
			}
			const direct = pickCredit(input.tailUsage);
			const window = {
				start: startedAt, end: endedAt,
				provider: usage && usage.routes ? usage.routes.provider : null,
				model: usage && usage.routes ? usage.routes.model : null,
			};
			const viaProxy = direct === null ? creditInWindow(input.samples, window) : null;
			return {
				running,
				ms: ms !== null && ms > 0 ? ms : (running ? 0 : null),
				interrupted: input.interrupted === true,
				usage,
				usageKey: usageKeyOf(usage),
				tokens: usage && usage.total !== null ? usage.total : null,
				credit: direct !== null ? direct : viaProxy.credit,
				creditResponses: viaProxy ? viaProxy.responses : 0,
				hitRateText: usage ? cacheHitRateText(usage.cacheRead, usage.prompt) : null,
			};
		}

		/** 已收到的积分样本（进程内、按视图；由 `vssaros-dsh-credit` DOM 事件喂）。 */
		const creditSamples = [];
		const creditListeners = new Set();
		const CREDIT_SAMPLES_MAX = 200;
		function pushCreditSample(sample) {
			creditSamples.push(sample);
			while (creditSamples.length > CREDIT_SAMPLES_MAX) {
				creditSamples.shift();
			}
			for (const fn of creditListeners) {
				try { fn(); } catch { /* 一个订阅者出错不影响其它 */ }
			}
		}
		function subscribeCredit(fn) {
			creditListeners.add(fn);
			return () => { creditListeners.delete(fn); };
		}
		/** 解析 DOM 事件负载（preload 已校验形状；这里再兜一层，脏数据不入样本池）。 */
		function normalizeCreditSample(detail) {
			if (!detail || typeof detail !== "object" || typeof detail.route !== "string") {
				return null;
			}
			if (typeof detail.at !== "number" || !isFinite(detail.at)) {
				return null;
			}
			return {
				route: detail.route,
				model: typeof detail.model === "string" ? detail.model : null,
				credit: typeof detail.credit === "number" && isFinite(detail.credit) ? detail.credit : null,
				at: detail.at,
			};
		}

		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state;
				// ── 回合用量页脚（方案 5.14 批次 2 修订：迁到气泡底部）────────────────
				// VsSaros 原生把「耗时 / tokens / 缓存命中率 / 积分」放在**助手气泡底部**（回合级），
				// 而 dsh 官方 header 没有用量 UI（官方只有 message 侧的「本轮用量」按钮）。
				// conversation.chat.turnTail 是 list 槽（session 作用域），官方语义是
				// 「收尾正文之下、动作行之前」的回合级追加项（DeliverablesTail / PlanCards / 日程卡都用它），
				// 正是气泡底部的落点。owner props 提供 turn(TurnLocation) + seq + openFile。
				const TURN_USAGE_SLOT = "conversation.chat.turnTail";
				// selector 返回对象，必须自带浅比较：否则每次 store 通知都会产生新引用 → 重渲染。
				// ⚠ 比的是**字段**而不是 `usage` 对象引用：deriveTurnFooter 每次都新建对象，
				//   按引用比会让"每个流式 chunk"都触发重渲染（性能与闪烁）。
				function sameTurnUsage(a, b) {
					if (a === b) { return true; }
					if (!a || !b) { return false; }
					return a.ms === b.ms && a.tokens === b.tokens && a.running === b.running
						&& a.interrupted === b.interrupted
						&& a.credit === b.credit && a.creditResponses === b.creditResponses
						&& a.hitRateText === b.hitRateText && a.usageKey === b.usageKey;
				}
				const TURN_PILL_STYLE = {
					display: "inline-flex", alignItems: "center", gap: 4,
					padding: "1px 8px", borderRadius: 999,
					border: "1px solid var(--dsw-alias-border-l1, transparent)",
					background: "var(--dsw-alias-bg-layer-1, transparent)",
					color: "var(--dsw-alias-label-secondary, currentColor)",
					fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
				};
				function turnPill(key, glyph, text, title, extraStyle, onHover) {
					const props = {
						key, title, style: Object.assign({}, TURN_PILL_STYLE, extraStyle || {}),
					};
					if (onHover) {
						props.onMouseEnter = onHover.onEnter;
						props.onMouseLeave = onHover.onLeave;
					}
					return react.createElement("span", props,
						react.createElement("span", { style: { opacity: 0.7 } }, glyph), text);
				}

				// ── Token 明细浮层（照 VsSaros 原生 `agentChatPanel.tokenPopup.ts` 的口径）──
				// 三条硬性语义与原生一致：① 所有行**无条件**渲染（0 是真实读数）；② 缺数据 `—`、零值 `0`；
				// ③ 命中率条按 命中/写入/未命中 三段着色。
				const POPUP_STYLE = {
					position: "fixed", zIndex: 2147483000, minWidth: 248,
					padding: "10px 12px", borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
					background: "var(--dsw-alias-bg-layer-2, rgba(24,24,26,0.98))",
					color: "var(--dsw-alias-label-primary, currentColor)",
					fontSize: 12, lineHeight: "18px",
					boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
					transform: "translate(-50%, -100%)", pointerEvents: "none",
				};
				const ROW_STYLE = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 };
				const GROUP_TITLE_STYLE = { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, fontWeight: 600 };
				const SUB_ROW_STYLE = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, paddingLeft: 12 };
				const SUB_LABEL_STYLE = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--dsw-alias-label-secondary, currentColor)" };
				const DOT_COLORS = { hit: "#4fbf67", write: "#e5c07b", miss: "#e06c75" };
				function dot(kind) {
					return react.createElement("span", {
						style: { width: 6, height: 6, borderRadius: 3, background: DOT_COLORS[kind], display: "inline-block" },
					});
				}
				function subRow(label, value, colorKey) {
					return react.createElement("div", { style: SUB_ROW_STYLE, key: label },
						react.createElement("span", { style: SUB_LABEL_STYLE }, colorKey ? dot(colorKey) : null, label),
						react.createElement("span", null, formatTokenValue(value)));
				}
				function TurnUsagePopup(props) {
					const info = props.info;
					const rect = props.rect;
					const seg = hitRateSegments(info);
					const rateText = props.hitRateText;
					return react.createElement("div", {
						className: "vssaros-token-popup",
						style: Object.assign({}, POPUP_STYLE, { left: rect.left + rect.width / 2, top: rect.top - 8 }),
					},
						react.createElement("div", { style: ROW_STYLE },
							react.createElement("span", { style: { fontWeight: 600 } }, "Token 消耗明细"),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary, currentColor)" } },
								"总计 " + formatTokenValue(info.total))),
						info.routes
							? react.createElement("div", { style: Object.assign({}, ROW_STYLE, { color: "var(--dsw-alias-label-secondary, currentColor)" }) },
								react.createElement("span", null, "模型"),
								react.createElement("span", null,
									[info.routes.provider, info.routes.model].filter(Boolean).join(" / ")))
							: null,
						react.createElement("div", { style: GROUP_TITLE_STYLE },
							react.createElement("span", null, "输入"),
							react.createElement("span", null, formatTokenValue(info.prompt))),
						subRow("缓存命中", info.cacheRead, "hit"),
						subRow("缓存未命中", info.uncached, "miss"),
						// ⚠ 传原始 `cacheWrite`（可能是 null）—— 否则"字段缺失"会被显示成 0（与 `—` 语义混淆）。
						subRow("缓存写入", info.cacheWrite, "write"),
						react.createElement("div", { style: GROUP_TITLE_STYLE },
							react.createElement("span", null, "输出"),
							react.createElement("span", null, formatTokenValue(info.output))),
						subRow("思考过程", info.reasoning, null),
						subRow("回复内容", info.content, null),
						react.createElement("div", { style: Object.assign({}, ROW_STYLE, { marginTop: 8, fontWeight: 600 }) },
							react.createElement("span", null, "⚡ 缓存命中率"),
							react.createElement("span", null, rateText === null ? "—" : rateText)),
						react.createElement("div", {
							style: { display: "flex", height: 6, marginTop: 6, borderRadius: 3, overflow: "hidden",
								background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.2))" },
						},
							seg ? react.createElement("span", { style: { width: seg.read + "%", background: DOT_COLORS.hit } }) : null,
							seg ? react.createElement("span", { style: { width: seg.write + "%", background: DOT_COLORS.write } }) : null,
							seg ? react.createElement("span", { style: { width: seg.miss + "%", background: DOT_COLORS.miss } }) : null),
						react.createElement("div", { style: { display: "flex", gap: 12, marginTop: 6, color: "var(--dsw-alias-label-secondary, currentColor)" } },
							react.createElement("span", { style: SUB_LABEL_STYLE }, dot("hit"), "命中"),
							react.createElement("span", { style: SUB_LABEL_STYLE }, dot("write"), "写入"),
							react.createElement("span", { style: SUB_LABEL_STYLE }, dot("miss"), "未命中")));
				}

				function TurnUsageFooter(props) {
					const turn = props.turn;
					// 积分样本到达（主进程代理推送）时强制重渲染：这些数据不在 dsh store 里，
					// 不会自己触发订阅更新。
					const [, creditTick] = react.useState(0);
					react.useEffect(() => subscribeCredit(() => creditTick(t => t + 1)), []);
					// hover 浮层：固定定位（虚拟列表的祖先带 overflow，绝对定位会被裁掉）⇒ 记锚点矩形。
					const [popupRect, setPopupRect] = react.useState(null);
					// 秒级 ticker（运行中刷新耗时/积分窗）；tick 值本身不参与渲染，只用来触发重渲染。
					const [, setTick] = react.useState(0);
					const info = props.useChat ? props.useChat((s) => {
						if (!s || !s.nodes || !s.nodes.values || !turn || typeof turn.turn !== "number") {
							return null;
						}
						// 本回合的 turn-tail 节点（TurnTailChatData：回合结束后的权威汇总）
						// 与各 assistant 步骤的 usage（**流式过程中就更新** ⇒ 实时数字来源）。
						let tailUsage = null;
						const stepUsages = [];
						const seenSteps = {};
						const values = s.nodes.values();
						for (const n of values) {
							if (!n || !n.data || n.data.turn !== turn.turn) {
								continue;
							}
							if (n.kind === "turn-tail") {
								tailUsage = n.data.tokenUsage || tailUsage;
								continue;
							}
							if (n.kind !== "assistant" && n.kind !== "assistant-step") {
								continue;
							}
							const u = n.data.usage;
							if (!u || typeof u !== "object") {
								continue;
							}
							// 去重：视图层可能同时暴露 assistant 与 assistant-step（同一个 step 只算一次）。
							const key = n.data.step !== undefined ? "s" + n.data.step
								: (n.data.seq !== undefined ? "q" + n.data.seq : null);
							if (key !== null) {
								if (seenSteps[key]) { continue; }
								seenSteps[key] = true;
							}
							stepUsages.push(u);
						}
						// 耗时回落：legacy.turnTimings（按 turn 号索引；回合结束后才有）。
						let legacyMs = null;
						const timing = s.legacy && s.legacy.turnTimings && s.legacy.turnTimings.get ? s.legacy.turnTimings.get(turn.turn) : undefined;
						if (timing && typeof timing.startTime === "number" && typeof timing.endTime === "number") {
							legacyMs = timing.endTime - timing.startTime;
						}
						// 已中断：回合结束原因为 interrupted（被中断）或 aborted（用户停止）；回落 closing.status。
						const reasonKind = turn.end && turn.end.data && turn.end.data.reason ? turn.end.data.reason.kind : null;
						return deriveTurnFooter({
							turn, tailUsage, stepUsages, legacyMs,
							now: Date.now(), samples: creditSamples,
							interrupted: reasonKind === "interrupted" || reasonKind === "aborted",
						});
					}, sameTurnUsage) : null;
					const running = !!(info && info.running);
					react.useEffect(() => {
						if (!running) {
							return undefined;
						}
						const id = setInterval(() => setTick(t => t + 1), 1000);
						return () => clearInterval(id);
					}, [running]);
					if (!info) {
						return null;
					}
					const pills = [];
					// 四个 chip **常驻**（数据未到用 0 / — 占位），回合结束后保留最终值。
					pills.push(turnPill("d", "◷", formatTurnMs(info.ms === null ? 0 : info.ms), "本轮耗时"));
					pills.push(turnPill("t", "Σ", formatTurnTokens(info.tokens === null ? 0 : info.tokens), "本轮 tokens"));
					// 缓存命中率：常驻 chip，hover 出「Token 消耗明细」浮层（无缓存字段时显示 `—`）。
					const hoverHandlers = info.usage ? {
						onEnter: (e) => {
							const target = e && e.currentTarget;
							if (target && typeof target.getBoundingClientRect === "function") {
								const r = target.getBoundingClientRect();
								setPopupRect({ left: r.left + r.width / 2, top: r.top, width: 0 });
							}
						},
						onLeave: () => setPopupRect(null),
					} : null;
					pills.push(turnPill("h", "⚡",
						info.hitRateText === null ? "缓存 —" : info.hitRateText,
						info.hitRateText === null
							? "缓存命中率：还没有缓存读数（该 provider 未上报 cacheRead/cacheWrite）"
							: "缓存命中率（hover 看 Token 消耗明细）",
						null, hoverHandlers));
					// 积分消耗：主进程计费探针抓到的按轮求和（无数据源时显示「积分 —」）。
					pills.push(turnPill("c", "◎",
						info.credit === null ? "积分 —" : "积分 " + formatTurnCredit(info.credit),
						info.credit === null
							? "本轮积分：暂未从网关响应里读到 credit（探针未就绪或该响应无该字段）"
							: "本轮积分消耗（按回合时间窗汇总 " + info.creditResponses + " 个响应）"));
					if (info.interrupted) {
						pills.push(turnPill("i", "⏹", "已中断", "本轮被中断", {
							color: "var(--dsw-alias-state-warn-primary, currentColor)",
						}));
					}
					const nodes = [react.createElement("div", {
						key: "pills",
						"data-vssaros-turn-usage": "1",
						style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, margin: "4px 0 2px", opacity: running ? 0.85 : 1 },
					}, ...pills)];
					if (popupRect && info.usage) {
						nodes.push(react.createElement(TurnUsagePopup, {
							key: "popup", info: info.usage, rect: popupRect, hitRateText: info.hitRateText,
						}));
					}
					return react.createElement(react.Fragment, null, ...nodes);
				}
				try {
					// 积分样本入站（preload 把主进程推来的负载转成 DOM 事件；事件名与协议常量一致）。
					// `document` 在页面里恒存在；缺它（非浏览器环境）时跳过监听，**不**让 install 整段失败。
					const canListen = typeof document !== "undefined" && typeof document.addEventListener === "function";
					const onCreditEvent = (e) => {
						const sample = normalizeCreditSample(e && e.detail);
						if (sample) {
							pushCreditSample(sample);
						}
					};
					if (canListen) {
						document.addEventListener("vssaros-dsh-credit", onCreditEvent);
					}
					ctx.slots.inject(TURN_USAGE_SLOT, () => {
						const dispose = ctx.slots.register({ name: TURN_USAGE_SLOT, id: "vssaros-turn-usage", order: 100 }, TurnUsageFooter);
						return () => {
							if (canListen) {
								document.removeEventListener("vssaros-dsh-credit", onCreditEvent);
							}
							dispose();
						};
					});
					state.turnUsage = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		// 仅测试用：纯逻辑直接断言（插件装载只读 install，见 dsh client-modules 契约）。
		exports.__test = {
			num, formatTokenValue, summarizeTurnUsage, sumUsage, cacheHitRateText, hitRateSegments,
			usageKeyOf, deriveTurnFooter, creditInWindow, normalizeCreditSample,
			formatTurnMs, formatTurnTokens, formatTurnCredit, pickCredit,
			pushCreditSample, creditSamples,
		};
		return module.exports;
	}
});
