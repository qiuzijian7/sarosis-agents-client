/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh 聊天的**计费探针**代理 —— 「真·积分」唯一可行的落点（2026-10-11）。
 *
 * ── 为什么非得有代理 ────────────────────────────────────────────────────────
 * 网关的积分在 SSE 末块 `usage.credit` 里（扩展侧能读到并打印：
 * `extensions/codebuddy-provider/src/extension.ts` 的 `[SSE-Diag] usage.credit=`）。
 * 但 **dsh 侧把它丢掉了**，且丢在最底层：
 *   · `dsh-llm-pi-ai` 的 `mapUsage()` 只保留 input/output/totalTokens/cacheRead/cacheWrite；
 *   · dsh 的按轮类型 `TurnTokenUsage` 也只有 token 桶（`dsh-client-ui-chat` 的 chat-nodes.d.ts）。
 * 所有"在 dsh 内部取积分"的路子都已排查排除：`agent/request` 是**请求前**的 waterfall；
 * `agent/assistant-stream` 帧里的 usage 已经是 `mapUsage` 之后的结果；`TurnTokenUsage` 里
 * 没有位置放它。⇒ 只有**在链路上的人**能拿到它，那就是本代理。
 *
 * ── 工作方式 ────────────────────────────────────────────────────────────────
 * `providers.sync` 时把每条路由的 `baseURL` 改写成 `http://127.0.0.1:<port>/r/<secret>/<route>`；
 * dsh（pi-ai）照常请求 `{baseURL}/chat/completions` ⇒ 落到本代理 ⇒ 原样转发到真实网关，
 * 一边**流式回传**、一边从响应尾部读出积分。请求 header（含 Authorization）与 body
 * **原样转发**：代理不持有、不解析、不落盘任何凭据。
 *
 * ── 安全边界（改动前务必读）─────────────────────────────────────────────────
 * 1. 只监听 `127.0.0.1`（不对外暴露）；
 * 2. 路径必须带 secret（`/r/<secret>/…`）—— 只有我们写进 profile 的那条 baseURL 知道它。
 *    否则同机任意进程都能把它当"带用户凭据的开放代理"用 ✗。
 *
 *    ⚠ **secret 自 2026-10-15 起持久化**（`<userData>/dsh-credit-proxy.secret`，0600），不再是
 *    每进程轮换。改动理由与安全性论证（这条边界当时是"每进程随机"）：
 *      · 那个 secret **本来就落在磁盘上**：每次 `providers.sync` 都把含 secret 的整条 baseURL
 *        写进 profile 的 `cordis.patch.yml` ⇒ "能读到那个文件的人"一直都能拿到 secret ⇒
 *        持久化**没有扩大暴露面**（同一个防护等级：读得到 profile 目录的人）。
 *      · 每进程轮换买到的唯一东西是"旧 secret 随进程失效"——而 Host 是 keepAlive 的，
 *        旧 secret 失效后旧 Host 里的路由**全部指向死代理**（同样要重写 profile 才能活）✗；
 *      · 换来的收益：**baseURL 跨进程稳定 ⇒ 幂等比对不再每次都 changed=true ⇒ 不再每次首启
 *        都付一次 `settings.mutate`（= 整份 profile 热重组，本机实测 20–24s，首启最大单项）** ✓。
 *    要恢复轮换的话：只改 `_getSecret()`（改回 `randomBytes`），别的都不用动 ✓。
 * 3. 只转发**已登记路由**的目标（未登记一律 502）—— URL 里的 host 不参与转发 ⇒ 无 SSRF 面；
 * 4. 转发前丢掉 `accept-encoding` 并显式要 `identity`：这样响应体是明文，可直接扫 SSE
 *    文本而无需解压/再压缩（压缩流上扫 JSON 会漏字段）。
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { Disposable } from '../../../../base/common/lifecycle.js';

/** 一次上游响应抓到的计费样本。 */
export interface IDshCreditSample {
	/** dsh 路由名（`vssaros-<id>`）。 */
	readonly route: string;
	/** 请求体里的模型 id（尽力而为：只从请求体头部 8KB 解析）。 */
	readonly model?: string;
	/** 网关上报的积分。**缺省 = 该响应没有积分字段**（与"积分 0"必须区分）。 */
	readonly credit?: number;
	/** 该响应的 HTTP 状态（诊断用）。 */
	readonly status?: number;
	/** 抓到的时间（epoch ms）。 */
	readonly at: number;
}

/** 逐跳 header 不转发（RFC 7230）。 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * 积分字段候选名（与扩展侧 `_creditCandidates` 同源）：
 * 网关改名字时这里跟着改；候选顺序 = 命中优先级。
 */
const CREDIT_FIELDS = ['credit', 'credits', 'cost', 'costUsd'] as const;

/** 请求体头部抓取上限（只为解析 `"model"`，不缓存整个 body）。 */
const REQUEST_HEAD_BYTES = 8 * 1024;
/** 响应尾部保留窗口（usage 在末块；一个回合的响应可能很长，故只留尾部）。 */
const RESPONSE_TAIL_CHARS = 64 * 1024;
/** 样本环形缓冲上限（诊断 + 后续送页面用）。 */
const MAX_SAMPLES = 200;

/** {@link DshCreditProxy} 的构造参数（2026-10-15 起收敛成对象：`onSample` 之外加了稳定性两件套）。 */
export interface IDshCreditProxyOptions {
	readonly onSample: (sample: IDshCreditSample) => void;
	/**
	 * 用户数据根（`~/.vssaros[-dev]`）。给了它 ⇒ secret 持久化 + 固定端口优先 ⇒ **baseURL 跨进程稳定**
	 * ⇒ `providers.sync` 的幂等比对不再每次首启都 `changed=true`（否则每次都付一次 `settings.mutate`
	 * 的整份 profile 热重组，本机实测 20–24s，首启最大单项 —— 2026-10-15 实测拆解见文件头 §2）。
	 * 不给 ⇒ 回到"每进程随机"的旧行为（单测/探针走这条 ✓）。
	 */
	readonly userDataPath?: string;
	/** 记日志（端口被占用退回随机时要留痕——那一幕意味着本次启动会重写 profile）。 */
	readonly log?: (line: string) => void;
	/**
	 * 历史样本从磁盘恢复完成（2026-10-20 用户报「重启后积分 pill 显示 —」）。
	 *
	 * 为什么需要回调：视图就绪时会把 `recentSamples` 一次性补发给页面（`creditsReplayedAt` 守卫）。
	 * 若那会儿磁盘还没读完（冷启动几毫秒，但页面也可能比它快），补发的是空数组 ⇒ 页面池永远空 ⇒
	 * 历史回合的积分一直是 — ✗。恢复完成后再触发一次补发，页面侧按样本键去重 ⇒ 不会重复计数。
	 */
	readonly onSamplesRestored?: () => void;
}

export class DshCreditProxy extends Disposable {

	/**
	 * 路径密钥（安全边界 2）：懒加载（`routeBaseURL` 第一次被调时经 `_getSecret()` 就位），
	 * 因为持久化读盘是异步的——主线程上不许同步 I/O（`mainProcessSyncWrites` 守卫的同一纪律 ✓）。
	 */
	private _secret: string | undefined;
	/** 已登记路由 → 真实 baseURL（去掉尾斜杠）。 */
	private readonly _routes = new Map<string, string>();
	private readonly _samples: IDshCreditSample[] = [];
	private _listening: Promise<number> | undefined;

	/** 历史样本落盘（debounce 句柄；见 `_persistSamples`）。 */
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly _opts: IDshCreditProxyOptions) {
		super();
		// ★★ 2026-10-20（用户报「重启后积分 pill 显示 —」）：**样本要跨进程存活**。
		//   样本池原来只在主进程内存 ⇒ 重开 app 就空了 ⇒ 页面拿到空池 ⇒ 历史回合的积分永远算不出来 ✗。
		//   恢复是异步的（主线程不许同步 I/O），完成后再让视图补发一次（`onSamplesRestored`）。
		void this._restoreSamples();
		this._register({ dispose: () => { if (this._persistTimer) { clearTimeout(this._persistTimer); } } });
	}

	/** 样本文件（与 secret / 固定端口同一根：`userDataPath`）。没有 `userDataPath` 就不落盘（单测/探针）。 */
	private get _samplesFile(): string | undefined {
		const root = this._opts.userDataPath?.trim();
		return root ? join(root, 'dsh-credit-samples.json') : undefined;
	}

	/**
	 * 从磁盘恢复历史样本。
	 *
	 * 只保留**形状正确**的（`route` 字符串 + `at` 数字）：损坏条目会污染页面侧的时间窗求和
	 * （一个 NaN 就能把整轮积分变成 null ✗）。读不到/损坏 ⇒ 当作没有（行为回到旧版）。
	 */
	private async _restoreSamples(): Promise<void> {
		const file = this._samplesFile;
		if (!file) {
			return;
		}
		try {
			const raw = await fsp.readFile(file, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return;
			}
			const restored: IDshCreditSample[] = [];
			for (const item of parsed) {
				if (!item || typeof item !== 'object') {
					continue;
				}
				const s = item as Partial<IDshCreditSample>;
				if (typeof s.route !== 'string' || !s.route || typeof s.at !== 'number' || !isFinite(s.at)) {
					continue;
				}
				restored.push({
					route: s.route,
					...(typeof s.model === 'string' ? { model: s.model } : {}),
					...(typeof s.credit === 'number' && isFinite(s.credit) ? { credit: s.credit } : {}),
					...(typeof s.status === 'number' ? { status: s.status } : {}),
					at: s.at,
				});
			}
			// 把恢复的接到**现有池前面**（构造函数之后才到的活样本不能被覆盖）—— 按时间排序更稳。
			const merged = [...restored, ...this._samples].sort((a, b) => a.at - b.at);
			this._samples.length = 0;
			for (const s of merged.slice(-MAX_SAMPLES)) {
				this._samples.push(s);
			}
			this._opts.log?.(`dshCredit: 从磁盘恢复 ${restored.length} 条历史积分样本（重启后历史回合仍能显示积分 ✓）`);
			if (restored.length > 0) {
				this._opts.onSamplesRestored?.();
			}
		} catch (e) {
			// 文件不存在是常态（首次运行）；其它错误留一行 warn，但不影响抓取。
			const code = (e as NodeJS.ErrnoException)?.code;
			if (code !== 'ENOENT') {
				this._opts.log?.(`dshCredit: 历史样本读取失败（本次从空池开始）：${String((e as Error)?.message ?? e)}`);
			}
		}
	}

	/**
	 * 落盘（debounce 1s）：一个回合会连续抓到几十条样本，逐条写盘会白占主线程 I/O。
	 * 异步写（`fsp.writeFile`）—— 主进程同步写有守卫测试盯着，这里绝不能改成 writeFileSync。
	 */
	private _persistSamples(): void {
		const file = this._samplesFile;
		if (!file) {
			return;
		}
		if (this._persistTimer) {
			return;     // 已有一次待写：写的时候取的是当时的全量池 ⇒ 合并成一次 ✓
		}
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			const payload = JSON.stringify(this._samples);
			void fsp.writeFile(file, `${payload}\n`, { mode: 0o600 })
				.catch(e => this._opts.log?.(`dshCredit: 历史样本落盘失败（本次进程内仍有效）：${String((e as Error)?.message ?? e)}`));
		}, 1000);
	}

	/**
	 * 登记一条路由，并返回 dsh 该用的 baseURL（指向本代理）。
	 * @param route - dsh 路由名（`vssaros-*`）。
	 * @param realBaseURL - 真实网关 baseURL。
	 * @returns 指向本代理的 baseURL（含当前 secret）。
	 */
	async routeBaseURL(route: string, realBaseURL: string): Promise<string> {
		const port = await this._ensureListening();
		const secret = await this._getSecret();
		this._routes.set(route, realBaseURL.replace(/\/+$/, ''));
		return `http://127.0.0.1:${port}/r/${secret}/${route}`;
	}

	/**
	 * 取 secret：有 `userDataPath` 时读/写 `<userData>/dsh-credit-proxy.secret`（0600）⇒ 跨进程稳定；
	 * 读不到/写不进就退回内存里的随机值（行为退回"每进程随机"✓，只是本次启动会重写一次 profile）。
	 */
	private async _getSecret(): Promise<string> {
		if (this._secret !== undefined) {
			return this._secret;
		}
		const root = this._opts.userDataPath?.trim();
		if (root) {
			const file = join(root, 'dsh-credit-proxy.secret');
			try {
				const existing = (await fsp.readFile(file, 'utf8')).trim();
				if (/^[0-9a-f]{32}$/.test(existing)) {
					return this._secret = existing;
				}
			} catch { /* 没有就生成 */ }
			const generated = randomBytes(16).toString('hex');
			// 写不进去不致命（退回内存值）⇒ fire-and-forget，但写失败要留痕。
			void fsp.writeFile(file, `${generated}\n`, { mode: 0o600 })
				.catch(e => this._opts.log?.(`dshCredit: secret 落盘失败（本次进程内有效）：${String((e as Error)?.message ?? e)}`));
			return this._secret = generated;
		}
		return this._secret = randomBytes(16).toString('hex');
	}

	/**
	 * 固定优先端口：`23100 + hash(userDataPath) % 400`（dev/prod 同一台机器不会撞 ✓）。
	 * 为什么固定：端口进 baseURL ⇒ 跨进程稳定 ⇒ `providers.sync` 幂等（见文件头 §2 的 2026-10-15 注）。
	 */
	private _preferredPort(): number | undefined {
		const root = this._opts.userDataPath?.trim();
		if (!root) {
			return undefined;
		}
		let h = 0;
		for (const ch of root) {
			h = (h * 31 + ch.charCodeAt(0)) | 0;
		}
		return 23100 + (Math.abs(h) % 400);
	}

	/** 最近的计费样本（诊断；后续阶段送到页面用）。 */
	recent(): readonly IDshCreditSample[] {
		return this._samples;
	}

	/** 确保监听就绪（幂等）；返回监听端口。固定端口被占用时退回随机（并记日志 ⇒ 那次的 flap 有据可查）。 */
	private _ensureListening(): Promise<number> {
		if (this._listening) {
			return this._listening;
		}
		this._listening = (async () => {
			const preferred = this._preferredPort();
			if (preferred !== undefined) {
				try {
					return await this._listen(preferred);
				} catch {
					this._opts.log?.(`dshCredit: 固定端口 ${preferred} 被占用，退回随机端口（本次启动的 providers.sync 会重写 profile）`);
				}
			}
			return this._listen(0);
		})();
		return this._listening;
	}

	/** 监听一个端口（`0` = OS 分配）。 */
	private _listen(port: number): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const server = createServer((req, res) => { void this._handle(req, res); });
			const onError = (e: Error) => reject(e);
			server.once('error', onError);
			server.listen(port, '127.0.0.1', () => {
				server.removeListener('error', onError);
				const address = server.address();
				if (!address || typeof address === 'string') {
					server.close();
					reject(new Error('dshCredit: 无法取得监听端口'));
					return;
				}
				this._register({ dispose: () => server.close() });
				resolve(address.port);
			});
		});
	}

	private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const raw = req.url ?? '';
		const at = raw.indexOf('?');
		const path = at < 0 ? raw : raw.slice(0, at);
		const query = at < 0 ? '' : raw.slice(at);
		const match = /^\/r\/([0-9a-f]+)\/([A-Za-z0-9._-]+)(\/.*)?$/.exec(path);
		if (!match || match[1] !== this._secret) {
			res.writeHead(404, { 'content-type': 'text/plain' });
			res.end('dshCredit: not found');
			return;
		}
		const route = match[2];
		const upstreamBase = this._routes.get(route);
		if (!upstreamBase) {
			// 未登记路由不转发（安全边界 3）。
			res.writeHead(502, { 'content-type': 'text/plain' });
			res.end(`dshCredit: route "${route}" not registered`);
			return;
		}
		try {
			await this._forward(req, res, route, upstreamBase + (match[3] ?? '') + query);
		} catch (e) {
			const message = String((e as Error)?.message ?? e);
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'text/plain' });
			}
			res.end(`dshCredit: upstream failed: ${message}`);
		}
	}

	/** 原样转发一次请求，并在回传过程中抓积分。 */
	private async _forward(req: IncomingMessage, res: ServerResponse, route: string, target: string): Promise<void> {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(req.headers)) {
			const name = key.toLowerCase();
			// 安全边界 4：不要压缩，明文才好扫 usage；host/content-length 由 fetch 自己算。
			if (HOP_BY_HOP.has(name) || name === 'host' || name === 'content-length' || name === 'accept-encoding') {
				continue;
			}
			if (typeof value === 'string') {
				headers[key] = value;
			} else if (Array.isArray(value)) {
				headers[key] = value.join(', ');
			}
		}
		headers['accept-encoding'] = 'identity';

		const controller = new AbortController();
		// 客户端断开（用户点了停止 / 页面关闭）⇒ 立刻掐掉上游，别留孤儿连接。
		req.on('aborted', () => controller.abort());
		res.on('close', () => { if (!res.writableEnded) { controller.abort(); } });

		let requestHead = '';
		let body: PassThrough | undefined;
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			body = new PassThrough();
			// ⚠ 抓样本的监听必须挂在 **req** 上，**绝不能**挂在 `body` 上（这曾是一个真 bug）。
			// `body` 是马上要交给 `fetch` 读的那条流：给它加 `'data'` 监听会让它进入 flowing 模式，
			// chunk 被监听器**消费掉**，fetch 侧只剩残渣 ⇒ 上游收到空/截断的请求体。
			// 实测（2026-10-11，dsh 聊天必然 400）：上游网关回
			// `400 {"code":11101,"msg":"Unmarshal chat params failed with error: EOF"}`（空体），
			// 大 body 时回 `invalid character 'S' looking for beginning of value`（从半截开始解析）；
			// 直连同一请求 200。本地复现：观察者挂 body ⇒ 上游收到 0/40105 字节；挂 req ⇒ 40105/40105 ✓。
			// `req` 上挂 `'data'` 再 `pipe(body)` 是安全的：同一次 emit 会同时喂给观察者与 pipe 目标。
			req.on('data', (chunk: Buffer) => {
				if (requestHead.length < REQUEST_HEAD_BYTES) {
					requestHead += chunk.toString('utf8');
				}
			});
			req.pipe(body);
		}

		const upstream = await fetch(target, {
			method: req.method,
			headers,
			body,
			duplex: 'half',
			signal: controller.signal,
		} as RequestInit & { duplex: 'half' });

		const outHeaders: Record<string, string> = {};
		upstream.headers.forEach((value, key) => {
			const name = key.toLowerCase();
			if (!HOP_BY_HOP.has(name) && name !== 'content-encoding' && name !== 'content-length') {
				outHeaders[key] = value;
			}
		});
		res.writeHead(upstream.status, outHeaders);

		let tail = '';
		// ★★ 2026-10-20（用户报「积分 —」；今天 19:00–19:07 会话日志里 38 次模型响应，代理只记下 1 条）：
		//   dsh 的 pi-ai 适配器读完流后**无条件**调 `consumer.abort("pi-ai stream consumer stopped")`
		//   （dsh-llm-pi-ai `finally` 块）⇒ 客户端几乎总是**先于上游**断开连接 ⇒ 上面的 `res.on('close')`
		//   abort 掉上游读取 ⇒ `reader.read()` 抛 AbortError ⇒ 原来写在循环**之后**的 `_record` 根本不执行，
		//   而 `_handle` 的 catch 因头已发出只 `res.end()`、不留任何日志 ⇒ 样本**静默丢失** ✗✗。
		//   积分在 SSE 末块里，那时其实**已经读进 tail 了** ⇒ 改成：无论正常结束 / 客户端断开 / 出错，
		//   都在 finally 里记一次（`recorded` 防重）。
		//   顺带两处：① 先追加 tail 再写下游（写失败也不丢这一块）；② 等 drain 时同时等 close
		//   （客户端断开后 drain 永远不来 ⇒ 原来会一直挂着）。
		let recorded = false;
		const recordOnce = () => {
			if (recorded) {
				return;
			}
			recorded = true;
			try {
				this._record(route, requestHead, tail, upstream.status);
			} catch (e) {
				this._opts.log?.(`dshCredit: 记录样本失败：${String((e as Error)?.message ?? e)}`);
			}
		};
		try {
			if (upstream.body) {
				const reader = upstream.body.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) {
							break;
						}
						if (!value) {
							continue;
						}
						tail = (tail + Buffer.from(value).toString('utf8')).slice(-RESPONSE_TAIL_CHARS);
						if (res.destroyed) {
							continue;   // 下游已断：不再写，但继续把上游尾巴读完（积分在末块）—— 若上游已被 abort，下一次 read 会抛出
						}
						// 背压：写不进去就等 drain，避免大回答在内存里堆着；客户端断开时 drain 不会来 ⇒ 同时等 close。
						if (!res.write(value)) {
							await Promise.race([once(res, 'drain'), once(res, 'close')]);
						}
					}
				} finally {
					if (!res.writableEnded && !res.destroyed) {
						res.end();
					}
				}
			} else {
				res.end();
			}
		} finally {
			recordOnce();
		}
	}

	/** 最近的样本环（视图重载后回放用 —— 页面侧的样本池是"活推送"，页面重载即清零 ✗）。 */
	get recentSamples(): readonly IDshCreditSample[] {
		return this._samples.slice();
	}

	/** 从请求头/响应尾抽样本（模型 id + 积分）并回调。 */
	private _record(route: string, requestHead: string, responseTail: string, status: number): void {
		const modelMatch = /"model"\s*:\s*"([^"]{1,200})"/.exec(requestHead);
		let credit: number | undefined;
		for (const field of CREDIT_FIELDS) {
			// 取**最后一次**出现：末块是权威值（流式过程中可能上报多次）。
			const re = new RegExp(`"${field}"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)`, 'g');
			let hit: RegExpExecArray | null;
			let last: number | undefined;
			while ((hit = re.exec(responseTail)) !== null) {
				last = Number(hit[1]);
			}
			if (last !== undefined && Number.isFinite(last)) {
				credit = last;
				break;
			}
		}
		const sample: IDshCreditSample = {
			route,
			...(modelMatch ? { model: modelMatch[1] } : {}),
			...(credit === undefined ? {} : { credit }),
			status,
			at: Date.now(),
		};
		this._samples.push(sample);
		if (this._samples.length > MAX_SAMPLES) {
			this._samples.shift();
		}
		// ★ 2026-10-20：样本落盘（debounce 1s，异步写）—— 重开 app 后历史回合的积分仍算得出来。
		this._persistSamples();
		// ★ 2026-10-15（用户报"积分 chip 一直 —"，实测 7 次采样 credit 全是 0 ✗）：不看到网关的
		//   usage 原文就分不清"网关真报 0"还是"字段名没对上/没报" ✗ ⇒ 这种样本顺带把 usage 数值段
		//   打进日志（只取 `"usage"` 键起的 700 字符；usage 是纯数值块，不含回答正文 ✓）。
		//   这行同时是"缓存 chip 一直 —"的判据：网关有没有上报 cache 字段，看它就知道了 ✓。
		if (credit === undefined || credit === 0) {
			const at = responseTail.search(/"usage"\s*:/);
			this._opts.log?.(at >= 0
				? `[dshCredit] credit 缺失/为 0 ⇒ 网关 usage 原文：${responseTail.slice(at, at + 700).replace(/\s+/g, ' ')}`
				: `[dshCredit] credit 缺失/为 0，且响应尾部没有 "usage" 键（尾窗 ${RESPONSE_TAIL_CHARS} 字符）`);
		}
		try {
			this._opts.onSample(sample);
		} catch {
			// 消费者异常绝不影响转发。
		}
	}
}
