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
			// ★★ 2026-10-20（用户报「命中率 pill 显示 100%」）：
			//   实测 dsh 现在上报的口径是【inputTokens **不含** cacheRead】：
			//     { inputTokens: 161, outputTokens: 188, totalTokens: 153309, cacheReadTokens: 152960 }
			//   其中 total ≈ cacheRead + input + output ✓
			//   而从前这里直接拿 inputTokens 当分母 ⇒ 152960 / 161 = 95006% ⇒ 被 `cacheHitRateText`
			//   的 `prompt - cacheRead <= 0` 兜成 **"100%"**（用户看到的就是这个假 100% ✗）。
			//   ⇒ 判据：**只有当 inputTokens 明显小于缓存量时**，才认定"input 不含缓存"，
			//     分母补成 `cacheRead + cacheWrite + uncached(或 input)`；旧口径（input 已含全部输入）
			//     下 input ≥ cacheRead ⇒ 不会误加，行为不变 ✓
			const cacheSum = (cacheRead === null && cacheWrite === null) ? null
				: (cacheRead || 0) + (cacheWrite || 0) + (uncached !== null ? uncached : (prompt || 0));
			if (cacheSum !== null && cacheSum > 0 && (prompt === null || prompt < (cacheRead || 0) + (cacheWrite || 0))) {
				prompt = cacheSum;
			} else if (prompt === null && cacheSum !== null) {
				prompt = cacheSum;
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
			/**
			 * 按时间窗取样本；`strict` 时再要求 model/provider 完全一致。
			 *
			 * ★★ 2026-10-20（用户报「积分 pill 显示 `—`」）真机日志佐证：
			 *   代理**读到了** `[dshCredit] route=vssaros-codebuddy model=deepseek-v4-flash-ioa
			 *   status=200 credit=0.15`，而页面仍显示 `—`。
			 *   病根：会话侧记的模型是 `deepseek-v4-flash`，网关抓到的带 **`-ioa` 后缀**
			 *   ⇒ 完全相等永远不成立 ⇒ 样本被全过滤 ⇒ credit=null（"没数据"，不是"0"）。
			 *   ⇒ 先严格匹配；**严格匹配一个样本都没有**时才放宽 model/provider（只按时间窗）。
			 *     时间窗本身已经把范围收到"本回合"，放宽的代价远小于"整块数据丢失"。
			 */
			/**
			 * `level`：`strict` = model+route 全等；`route` = route 全等 + model **同族**
			 * （一方是另一方加 `-后缀`：`deepseek-v4-flash` ↔ `deepseek-v4-flash-ioa`）。
			 */
			const sameFamily = (a, b) => a === b || a.startsWith(b + "-") || b.startsWith(a + "-");
			const collect = (level) => {
				let credit = null;
				let responses = 0;
				// ★ 2026-10-20（重启后用户报「积分显示异常」）：`start` 缺失时从前**不设下界**
				//   ⇒ 把样本池里所有历史响应都算进本回合（越用越大 ✗）。这里给一个 10 分钟的有界兜底。
				const floor = typeof window.start === "number" ? window.start
					: (typeof window.now === "number" ? window.now - 10 * 60_000 : null);
				for (const s of samples || []) {
					if (!s || typeof s.at !== "number") {
						continue;
					}
					if (typeof floor === "number" && s.at < floor) {
						continue;
					}
					if (typeof window.end === "number" && s.at > window.end) {
						continue;
					}
					if (window.provider && s.route && s.route !== window.provider) {
						continue;
					}
					if (window.model && s.model) {
						if (level === "strict" ? s.model !== window.model : !sameFamily(String(s.model), String(window.model))) {
							continue;
						}
					}
					responses += 1;
					if (typeof s.credit === "number" && isFinite(s.credit)) {
						credit = (credit === null ? 0 : credit) + s.credit;
					}
				}
				return { credit, responses };
			};
			// 两档递降：精确（model+route）→ route 相同且 model **同族**（网关常加后缀：
			//   会话侧 `deepseek-v4-flash` ↔ 网关 `deepseek-v4-flash-ioa`）。
			// ⚠ 2026-10-20 去掉了"纯时间窗"档、也不接受"route 同但 model 完全无关"：主进程的积分样本是
			//   **广播**的，同一网关上别的会话（别的模型）的请求会落进同一时间窗 ⇒ 算进来就是记错账 ✗
			//   （单测「provider/model 不符的其它会话请求被排除」钉的正是这两条）。对不上 ⇒ 如实显示「—」。
			for (const level of ["strict", "route"]) {
				const r = collect(level);
				if (r.responses > 0) { return r; }
			}
			return { credit: null, responses: 0 };
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
				// ⚠ `now` 用于"`start` 缺失时的 10 分钟有界兜底"（否则会累积全池样本 ⇒ 积分越用越大 ✗）
				now: typeof input.now === "number" ? input.now : undefined,
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
				// ★ 2026-10-20：把**积分窗口**一并交出去 —— 组件要能在 credit 事件到达时**自己重算**
				//   （选择器结果被缓存，store 不变就不会重算；见 TurnUsageFooter 里的注释）。
				creditWindow: window,
				hitRateText: usage ? cacheHitRateText(usage.cacheRead, usage.prompt) : null,
			};
		}

		/**
		 * 从聊天 store 的 `timeline.turns`（Map<turn, { turn, start?, end? }>）里找**正在进行**的回合。
		 *
		 * 为什么需要（2026-10-20 用户：要求 LLM 输出过程中实时显示 pill）：composer dock 那份页脚
		 * 是用同一个组件包出来的，但 composer 槽**不传 `turn`** ⇒ 选择器第一句 `!turn` 直接 return null
		 * ⇒ 流式期间这一份**从来没渲染过** ✗。turnTail 槽要等回合结束才出现 ⇒ 用户只能等说完才看到数字。
		 * 这里自己从 store 定位：最大回合号且有 start、没有 end 的那一个；没有 ⇒ null（不渲染）。
		 */
		function liveTurnOf(timeline) {
			const turns = timeline && timeline.turns;
			if (!turns || typeof turns.values !== "function") {
				return null;
			}
			let best = null;
			for (const t of turns.values()) {
				if (!t || typeof t.turn !== "number" || !t.start || t.end !== undefined) {
					continue;
				}
				if (!best || t.turn > best.turn) {
					best = t;
				}
			}
			return best;
		}

		/**
		 * 正在流式输出的这一步的**输出 token 估算**（网关只在每步结束时给真实 usage）。
		 *
		 * 口径：粗略按字符折算 —— CJK 约 1 字 ≈ 1 token、其余约 4 字符 ≈ 1 token（与常见 BPE 量级一致）。
		 * 只用于运行中 pill 的"正在涨"效果，界面上以 `≈` 标明；这一步结束后由真实 usage 取代，不进入任何汇总口径。
		 * @param partial - store 的 `legacy.partial`（`{ turn, step, blocks: [{ kind, text }] }`）
		 * @param turnNo - 只估算属于该回合的 partial
		 * @returns 估算值；没有在途输出 ⇒ 0
		 */
		function estimatePartialTokens(partial, turnNo) {
			if (!partial || partial.turn !== turnNo || !Array.isArray(partial.blocks)) {
				return 0;
			}
			let cjk = 0;
			let other = 0;
			for (const b of partial.blocks) {
				const text = b && typeof b.text === "string" ? b.text : "";
				for (let i = 0; i < text.length; i++) {
					const c = text.charCodeAt(i);
					if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) {
						cjk++;
					} else {
						other++;
					}
				}
			}
			return cjk + Math.ceil(other / 4);
		}

		/**
		 * 会话账本投影的 key（与 `dsh-plugins/vssaros-bridge/lib/credit.js` 的 `CREDIT_PROJECTION_KEY`
		 * **字面一致**；插件之间不能互相 import ⇒ 两份常量，由契约测试钉住）。
		 */
		const CREDIT_PROJECTION_KEY = "vssaros-credit";
		/**
		 * 从投影视图里取某回合的账本条目。
		 * 视图形状（Host 侧 `creditProjection().wire.view`）：`{ byTurn: { [turn]: { credit, responses } }, outside }`。
		 * 形状不对 / 没有该回合 ⇒ `null`（调用方退回旧的时间窗估算）。
		 */
		function ledgerEntryFor(view, turn) {
			if (!view || typeof view !== "object" || !view.byTurn || typeof view.byTurn !== "object") {
				return null;
			}
			if (!turn || typeof turn.turn !== "number") {
				return null;
			}
			const cell = view.byTurn[turn.turn];
			if (!cell || typeof cell !== "object" || typeof cell.responses !== "number" || cell.responses <= 0) {
				return null;
			}
			const credit = typeof cell.credit === "number" && isFinite(cell.credit) ? cell.credit : null;
			return { credit, responses: cell.responses };
		}

		/** 已收到的积分样本（进程内、按视图；由 `vssaros-dsh-credit` DOM 事件喂）。 */
		const creditSamples = [];
		/** 样本键 → 已收（**去重**用：同一批样本可能被推两次，见下面 pushCreditSample）。 */
		const creditSampleKeys = new Set();
		const creditListeners = new Set();
		const CREDIT_SAMPLES_MAX = 200;
		/**
		 * 样本键：同一次上游响应 = 同一 (at, route, model, credit)。
		 *
		 * ★★ 2026-10-20（用户报「重启后积分 pill 显示 —」→ 修法带来的新风险）：
		 *   历史样本从磁盘恢复后，宿主要给已就绪的页面**再补发一遍**（`replayCreditsAgain`），
		 *   而页面池是按时间窗**求和**的 ⇒ 同一批样本进池两次，积分就翻倍 ✗✗。
		 *   这里做**内容级去重**：补发是幂等的，宿主也就不必精算"哪些还没发过"。
		 */
		const creditKeyOf = (s) => [s.at, s.route, s.model === null ? "" : s.model,
			s.credit === null ? "" : s.credit].join("|");
		function pushCreditSample(sample) {
			const key = creditKeyOf(sample);
			if (creditSampleKeys.has(key)) {
				return;      // 已经收过 —— 不重复计数（也顺带免掉一次无意义的重渲染）
			}
			creditSampleKeys.add(key);
			creditSamples.push(sample);
			while (creditSamples.length > CREDIT_SAMPLES_MAX) {
				const dropped = creditSamples.shift();
				if (dropped) { creditSampleKeys.delete(creditKeyOf(dropped)); }
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
						// ★★ 2026-10-20（用户报「积分 pill 一直显示 —」）真因：
						//   这个比较器**不漏 credit**（也不漏命中率）⇒ `useChat(selector)` 认为"没变化"，
						//   于是返回**缓存的旧 info**（credit: null）。
						//   `subscribeCredit` 的 `creditTick` 只能让组件重渲染，**不会让选择器重算** ⇒
						//   样本到了也不显示 —— 只有 `ms` 在变（running 每秒涨）时才"顺带"更新，
						//   而积分样本通常在 SSE **末块**才到、此时 ms 已固定 ⇒ 最后一次永远进不来 ✗✗
						&& a.credit === b.credit && a.creditResponses === b.creditResponses
						&& a.hitRateText === b.hitRateText
						&& a.credit === b.credit && a.creditResponses === b.creditResponses
						&& a.hitRateText === b.hitRateText && a.usageKey === b.usageKey
						// 运行中的流式估算与起点（漏比较 ⇒ 选择器返回旧值，pill 不涨 ✗）
						&& a.partialTokens === b.partialTokens && a.startedAt === b.startedAt;
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
					// composer dock（liveOnly）不传 `turn` ⇒ 自己从 store 的 timeline 找正在进行的回合（见 liveTurnOf）。
					//   `useChat` 的选择器要稳定可比 ⇒ 只取回合号；完整回合对象在选择器里现读。
					const liveTurnNo = props.liveOnly && props.useChat
						? props.useChat((s) => { const t = liveTurnOf(s && s.timeline); return t ? t.turn : null; })
						: null;
					const turn = props.liveOnly ? (liveTurnNo === null ? null : { turn: liveTurnNo }) : props.turn;
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
						// 回合记录以 store 的 timeline 为准（start/end 时间）：composer 那份只知道回合号；
						// turnTail 那份传来的对象若缺时间，也从这里补齐。
						const rec = (s.timeline && s.timeline.turns && typeof s.timeline.turns.get === "function"
							&& s.timeline.turns.get(turn.turn)) || turn;
						const derived = deriveTurnFooter({
							turn: rec, tailUsage, stepUsages, legacyMs,
							now: Date.now(), samples: creditSamples,
							interrupted: reasonKind === "interrupted" || reasonKind === "aborted",
						});
						// ★ 2026-10-20（用户：LLM 输出过程中实时显示 pill）：网关只在**每步结束**时给 usage，
						//   正在输出的这一步按流式文本估算输出 token（界面以 `≈` 标明；这一步结束即由真实值取代）。
						derived.partialTokens = derived.running ? estimatePartialTokens(s.legacy && s.legacy.partial, turn.turn) : 0;
						derived.startedAt = rec && rec.start && typeof rec.start.time === "number" ? rec.start.time : null;
						return derived;
					}, sameTurnUsage) : null;
					const running = !!(info && info.running);
					react.useEffect(() => {
						if (!running) {
							return undefined;
						}
						const id = setInterval(() => setTick(t => t + 1), 1000);
						return () => clearInterval(id);
					}, [running]);
					// ★★ 2026-10-20（用户：积分仍显示 `—`）—— 上一轮的修法**无效**，原因在这：
					//   `useChat(selector)` 的选择器结果**只在 store 变化时重算**；我上一轮把 credit 加进了
					//   `sameTurnUsage`，但 `subscribeCredit` 的 tick 只让组件**重渲染**、不碰 store
					//   ⇒ 比较器根本不会被调用 ⇒ `info.credit` 永远停在首算值（那时池里还没样本）✗✗
					//   ⇒ 正解：积分计算**移出选择器**，用组件自己的 state，由 credit 事件驱动重算。
					//     （`info.credit` 保留为首屏兜底：selector 首算时若已有样本就直接有值。）
					const win = info && info.creditWindow ? info.creditWindow : null;
					const winKey = win ? String(win.start ?? "") + ":" + String(win.end ?? "") : "";
					// 用一个 useState 持有的可变盒子当"最新窗口"引用（等价 useRef，但不依赖 useRef ——
					// 宿主的 react 一定有 useState；单测的假 react 也只提供 useState/useEffect）。
					const [winBox] = react.useState(() => ({ current: null }));
					const winRef = winBox || { current: null };
					winRef.current = win;
					const [liveCredit, setLiveCredit] = react.useState(null);
					react.useEffect(() => {
						const recompute = () => {
							const w = winRef.current;
							setLiveCredit(w ? creditInWindow(creditSamples, w) : null);
						};
						recompute();
						return subscribeCredit(recompute);
					}, [winKey]);
					// ★★ 2026-10-20：**会话账本**（Host 侧投影 `vssaros-credit`，见 vssaros-bridge/lib/credit.js）。
					//   Host 按 LLM 调用区间把积分归属到 (会话, 回合) 并写进会话日志 ⇒ 这里拿到的是**本会话
					//   本回合**的准确值，重启/换窗口也还在。`useProjection` 是 session 作用域槽的标准 props
					//   （turnTail 槽声明 `scope: "session"`）；拿不到（老 Host / 非 session 槽）就退回下面的时间窗估算。
					//   ⚠ 这是 hook：必须**无条件**调用（props.useProjection 的有无对同一槽实例是稳定的 ✓）。
					const creditLedgerView = typeof props.useProjection === "function" ? props.useProjection(CREDIT_PROJECTION_KEY) : undefined;
					const ledgerEntry = ledgerEntryFor(creditLedgerView, turn);
					if (!info) {
						return null;
					}
					// ★ 2026-10-20（用户要求「LLM 输出过程中就显示 pill」）：
					//   composer 那份（见 install 里的第二个槽）**只在运行中**渲染 ——
					//   回合结束后由 `conversation.chat.turnTail` 那份负责，不会出现两份 ✗。
					if (props.liveOnly && !info.running) {
						return null;
					}
					const pills = [];
					// 四个 chip **常驻**（数据未到用 0 / — 占位），回合结束后保留最终值。
					// ★ 2026-10-20：运行中的耗时**在渲染时**现算（`Date.now() - startedAt`）——选择器结果被缓存，
					//   两步之间（工具执行期间）store 不动 ⇒ 选择器里的 ms 会停住；秒级 ticker 触发的重渲染走这里才会走表。
					const liveMs = info.running && typeof info.startedAt === "number" ? Math.max(0, Date.now() - info.startedAt) : null;
					pills.push(turnPill("d", "◷", formatTurnMs(liveMs !== null ? liveMs : (info.ms === null ? 0 : info.ms)), "本轮耗时"));
					// tokens：已完成步骤的真实值 + 正在输出这一步的估算（有估算时前缀 `≈`，tooltip 说明）。
					const partialTokens = info.running && typeof info.partialTokens === "number" ? info.partialTokens : 0;
					const tokenBase = info.tokens === null ? 0 : info.tokens;
					pills.push(turnPill("t", "Σ",
						(partialTokens > 0 ? "≈" : "") + formatTurnTokens(tokenBase + partialTokens),
						partialTokens > 0
							? "本轮 tokens（已完成步骤 " + formatTurnTokens(tokenBase) + " + 正在输出约 " + formatTurnTokens(partialTokens) + "，这一步结束后换成网关真实值）"
							: "本轮 tokens"));
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
					// 积分消耗。取数优先级：
					//   ① 会话账本（Host 投影，**准确归属**到本会话本回合）；
					//   ② `liveCredit`（旧链路：广播样本按回合时间窗估算，credit 事件驱动重算）；
					//   ③ `info.credit`（旧链路选择器首算，兜底）。
					const liveHas = liveCredit && typeof liveCredit.credit === "number" && isFinite(liveCredit.credit);
					const creditValue = ledgerEntry ? ledgerEntry.credit : (liveHas ? liveCredit.credit : info.credit);
					const creditResponses = ledgerEntry ? ledgerEntry.responses
						: (liveCredit && liveCredit.responses > 0 ? liveCredit.responses : info.creditResponses);
					pills.push(turnPill("c", "◎",
						creditValue === null ? "积分 —" : "积分 " + formatTurnCredit(creditValue),
						ledgerEntry
							? (creditValue === null
								? "本轮积分：会话账本记了 " + creditResponses + " 个响应，但网关都没上报 credit"
								: "本轮积分消耗（会话账本：" + creditResponses + " 个响应）")
							: creditValue === null
								// ★ 2026-10-20（用户反复报 `—`）：把**判定依据**写进 tooltip ——
								//   「池里几条样本 / 本回合窗口」能一眼区分是"事件没到"还是"窗口过滤掉了"，
								//   而不是只说一句"没读到"让人继续猜 ✗。
								? "本轮积分：暂未读到 credit —— 会话账本无记录，样本池 " + creditSamples.length + " 条"
									+ (win && typeof win.start === "number" ? "，本回合窗口 " + new Date(win.start).toLocaleTimeString() : "")
									+ (win && typeof win.end === "number" ? "–" + new Date(win.end).toLocaleTimeString() : "–现在")
								: "本轮积分消耗（估算：按回合时间窗汇总 " + creditResponses + " 个响应）"));
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
					// ★★ 2026-10-20（用户要求：**LLM 输出过程中**就要看到这些 pill）：
					//   `conversation.chat.turnTail` 的官方语义是"回合末尾"⇒ 流式期间这个槽根本不渲染
					//   ⇒ 用户要等 LLM 说完才看到耗时/tokens/命中率/积分 ✗（组件内部其实早就支持 running：
					//   `deriveTurnFooter` 会用 `now - start` 算耗时、按各 step 的 usage 实时求和）。
					//   ⇒ 同一份数据再挂到 **composer dock**（输入区下方、会话期间常驻），只在 running 时渲染；
					//     回合结束后它自己 return null，交给 turnTail 那份显示（不重复 ✓）。
					//   ⚠ 包 try/catch：老版本/别的装配里没有该槽时，只是少了"流式中"的那份，不能让整个部件装不上。
					try {
						const LIVE_SLOT = "conversation.composer.dock";
						ctx.slots.inject(LIVE_SLOT, () => ctx.slots.register(
							{ name: LIVE_SLOT, id: "vssaros-turn-usage-live", order: 100 },
							(props) => react.createElement(TurnUsageFooter, Object.assign({}, props, { liveOnly: true })),
						));
					} catch (e) {
						state.liveUsageError = String((e && e.message) || e);
					}
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
			CREDIT_PROJECTION_KEY, ledgerEntryFor,
			liveTurnOf, estimatePartialTokens,
		};
		return module.exports;
	}
});
