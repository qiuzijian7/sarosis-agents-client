/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `@vssaros/dsh-browser`：把 **`browser`（CDP）族下移到 Host**（README 4.66/4.67）。
 *
 * 钉四类东西：
 * 1. **移植不走样**：端口/profile/开关这些值必须与 IDE 侧真源（`common/browserCdp.ts`、
 *    `common/chromeDebugSetup.ts`）逐字一致 —— 不一致的症状是"Host 拉起的 Chrome 与 IDE 那份不是同一个"。
 * 2. **生成物不落后**：`lib/core/snapshot.js`（注入脚本 + 渲染器）由 `bin/sync-snapshot.mjs` 从真源
 *    `browser/browserCdpSnapshot.ts` 生成 ⇒ 用 `--check` 断言"真源改了必须重新生成"。
 * 3. **契约**：工具名/参数面与 `vssaros-ide` 的同名工具一致；动作类默认不放行。
 * 4. **真的能跑**：端到端拉起 headless Chrome，跑 **snapshot → click → type** 全链路（全程无 VsSaros）。
 */

const CORE_CDP = 'dsh-plugins/vssaros-browser/lib/core/cdp.js';
const CORE_CHROME = 'dsh-plugins/vssaros-browser/lib/core/chrome.js';
const CORE_HOST = 'dsh-plugins/vssaros-browser/lib/core/host.js';
const CORE_CLIENT = 'dsh-plugins/vssaros-browser/lib/core/client.js';
const CORE_COOKIES = 'dsh-plugins/vssaros-browser/lib/core/cookies.js';
const CORE_COOKIE_STORE = 'dsh-plugins/vssaros-browser/lib/core/cookieStore.js';
const CORE_LOGIN_PROBE = 'dsh-plugins/vssaros-browser/lib/core/loginProbe.js';
const CORE_EVALUATE = 'dsh-plugins/vssaros-browser/lib/core/evaluateResult.js';
const CORE_UNREACHABLE = 'dsh-plugins/vssaros-browser/lib/core/unreachable.js';
const PLUGIN_INDEX = 'dsh-plugins/vssaros-browser/lib/index.js';
const SYNC_SCRIPT = 'dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs';
const IDE_PLUGIN = 'dsh-plugins/vssaros-ide/lib/index.js';
const SRC_BROWSER_CDP = 'src/vs/sessions/contrib/agentStudio/common/browserCdp.ts';
const SRC_CHROME_SETUP = 'src/vs/sessions/contrib/agentStudio/common/chromeDebugSetup.ts';
/** Host 侧**真实**工具面（权威来源；`tools-snapshot.mjs` 生成）。 */
const TOOLS_SNAPSHOT = 'dsh-plugins/tools-snapshot.json';
/** 技能手册（它会被**两种**运行环境读到，工具面却不一样）。 */
const SKILL_WEB_IMPORT = 'resources/.agents/skills/web-content-import/SKILL.md';

const abs = (rel: string): string => path.join(process.cwd(), rel);
const readIf = (rel: string): string | undefined => (fs.existsSync(abs(rel)) ? fs.readFileSync(abs(rel), 'utf8') : undefined);
const load = async <T>(rel: string): Promise<T> => await import(pathToFileURL(abs(rel)).href) as T;

interface IChromeCore {
	readonly DEFAULT_CDP_PORT: number;
	readonly CDP_COMMAND_TIMEOUT_MS: number;
	readonly CHROME_REMOTE_DEBUGGING_PAGE: string;
	readonly CHROME_PATH_ENV: string;
	readonly DEDICATED_PROFILE_DIRNAME: string;
	dedicatedPortFor(port: number): number;
	cdpEndpointCandidates(port: number): readonly { host: string; port: number; url: string; selfLaunched: boolean }[];
	chromeExecutableCandidates(env: Record<string, string | undefined>, platform: string): string[];
	pickChromeExecutable(candidates: readonly string[], exists: (p: string) => boolean): string | undefined;
	dedicatedProfileDir(home: string, platform: string): string;
	buildDedicatedChromeArgs(dir: string, port: number, headless: boolean): string[];
}

interface ICdpHostLike {
	readonly dedicatedPort: number;
	/** 我们自己拉起的那个 Chrome 的 pid（测试 cleanup 用，见 E2E 的 finally）。 */
	readonly dedicatedPid?: number;
	status(): Promise<{ ok: boolean; endpoint?: string; connected: boolean; browser?: string; selfLaunched?: boolean; error?: string }>;
	/** `ownerKey` = 会话归属键（`sessionKeyOf` 的产出；省略 = 旧的无隔离行为）。 */
	ensurePage(ownerKey?: string, url?: string): Promise<{ targetId: string; sessionId: string; url: string }>;
	/** 会话结束时回收它名下的页面（2026-10-13）。 */
	closeSessionPages(ownerKey: string): Promise<{ closed: string[]; skipped: string }>;
	command(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<unknown>;
	dispose(): void;
}
interface IHostCore {
	CdpHost: new (options: {
		port?: number; launchDedicated?: boolean; headless?: boolean; homeDir: string;
		platform?: string; env?: Record<string, string | undefined>; logger?: { info?: (m: string) => void; warn?: (m: string) => void };
	}) => ICdpHostLike;
}

interface IClientCore {
	BrowserCdpClient: new (
		invoke: (req: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
		logger?: { info?: (m: string) => void; warn?: (m: string) => void },
	) => {
		status(): Promise<{ ok: boolean }>;
		snapshot(): Promise<unknown>;
		images(): Promise<unknown>;
		navigate(url: string): Promise<string>;
		click(ref: number): Promise<string>;
		type(ref: number, text: string, opts?: { append?: boolean }): Promise<string>;
		pressEnter(): Promise<string>;
		pressKey(key: string): Promise<void>;
		scroll(direction: 'up' | 'down', amount: number, ref?: number): Promise<string>;
		back(): Promise<string>;
		reset(): Promise<void>;
		/** 在当前页面里执行调用方给的 JS（`evaluate` op 的实现）。 */
		evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
	};
}

interface IRegisteredTool {
	readonly name: string;
	readonly description?: string;
	readonly parameters?: { readonly properties?: Record<string, unknown>; readonly enumOps?: unknown };
	readonly output?: { readonly schema?: unknown; readonly render?: unknown };
	isConcurrencySafe?: (args: { op?: string; action?: string; done?: boolean }) => boolean;
	execute: (params: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
}

/** 用假 ctx 驱动插件注册（与 `dshIdeToolContract.test.ts` 同一手法：不碰真 Host）。 */
interface IFakeHost {
	readonly tools: IRegisteredTool[];
	readonly provided: Map<string, unknown>;
	/** 审批缝：给了就模拟"有审批通道"，并把每次请求记下来。 */
	readonly approvals: { toolName?: string; reason?: string }[];
	/** 事件缝（2026-10-13）：把 `ctx.on` 的订阅记下来 ⇒ 守卫能断言"会话结束回收确实接上了"。 */
	events?: { event: string; handler: (payload: unknown) => void }[];
	/** 卸载钩子（`ctx.effect` 的返回值）——可见性门控靠它在卸载时注销工具，守卫要能驱动它。 */
	disposers?: (() => void)[];
	approvalOutcome?: string;
}

async function loadTool(
	config: Record<string, unknown> = {},
	host: IFakeHost = { tools: [], provided: new Map(), approvals: [] },
	options: { waitForRegistrationMs?: number; allowAbsent?: boolean } = {},
): Promise<IRegisteredTool> {
	const mod = await load<{ apply(ctx: unknown, config?: unknown): void }>(PLUGIN_INDEX);
	// 订阅记账（写在 host 上，调用方读得到）：`agent/disposed` 那条回收逻辑**必须**接上，
	// 否则"多会话隔离"只有前半段（各拿自己的页）而没有后半段（用完不还）。
	const events: { event: string; handler: (payload: unknown) => void }[] = [];
	host.events = events;
	const disposers: (() => void)[] = [];
	host.disposers = disposers;
	const ctx = {
		logger: { info: () => { /* 静音 */ }, warn: () => { /* 静音 */ } },
		// ⚠ 必须**留住**返回的 disposer（2026-10-13）：`ctx.effect` 的返回值就是"卸载钩子"，
		//   可见性门控靠它在卸载时注销工具 —— 只 `fn()` 不存，就测不出"卸载不留孤儿注册"。
		effect: (fn: () => unknown) => {
			const disposer = fn();
			if (typeof disposer === 'function') { disposers.push(disposer as () => void); }
		},
		provide: (name: string, value: unknown) => { host.provided.set(name, value); },
		on: (event: string, handler: (payload: unknown) => void) => {
			events.push({ event, handler });
			return () => { /* 摘除（守卫会断言返回的是函数） */ };
		},
		get: (name: string) => name === 'approval' && host.approvalOutcome
			? { request: async (req: { toolName?: string; reason?: string }) => { host.approvals.push(req); return host.approvalOutcome; } }
			: undefined,
		tools: {
			register: (tool: IRegisteredTool) => {
				// 镜像 dsh ≥ 0.2.1-alpha.1 的注册契约：`output` 必须给 `{ schema, render }`，缺了整条
				// entry **不激活**（Host 里表现为"插件像没装"；在真机上就是这么踩到的）⇒ 这里当场红。
				if (!tool.output || typeof tool.output.schema !== 'object' || typeof tool.output.render !== 'function') {
					throw new TypeError(`tool "${tool.name}" must declare output { schema, render }`);
				}
				host.tools.push(tool);
				// ⚠ `dispose` 必须**真的**把它从工具面里拿掉（2026-10-13）：可见性门控就是靠它撤下
				//   "连不上"的工具 —— 这里若是个 noop，那条守卫就永远绿，等于没测。
				return {
					dispose: () => {
						const at = host.tools.indexOf(tool);
						if (at >= 0) { host.tools.splice(at, 1); }
					},
				};
			},
		},
	};
	mod.apply(ctx, config);
	// ★ 可见性门控（2026-10-13）：无兜底时注册是**异步**的（先探一次可达性）⇒ 需要时等一下。
	//   默认 0ms：默认路径（`launchDedicated` 开）是**同步**注册，不必等。
	const deadline = Date.now() + (options.waitForRegistrationMs ?? 0);
	while (host.tools.length === 0 && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	if (options.allowAbsent !== true) {
		assert.strictEqual(host.tools.length, 1,
			`应当只注册一个工具（实际 ${host.tools.length}）—— 只有"门控把它撤下了"这条合法路径才传 allowAbsent`);
	}
	return host.tools[0];
}

/**
 * 起一个**假 CDP 端点**（只回 `/json/version`）—— 让可达性探测**成功**。
 *
 * 为什么需要它：可见性门控里唯一"通了才露面"的那条路（`launchDedicated` 关着）没法用
 * "真有 Chrome"来测（测试机上不能假设有），而"可达 ⇒ 注册、随后断开 ⇒ 撤下并拦住授权"
 * 这整条链路**必须**有个能真连上的端点。门控测试不会用它的 `webSocketDebuggerUrl` 真连。
 */
async function startFakeCdpEndpoint(): Promise<{ port: number; close(): Promise<void> }> {
	const server = http.createServer((req, res) => {
		if (req.url?.startsWith('/json/version')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({
				Browser: 'FakeChrome/1.0',
				webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
			}));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	const port = await new Promise<number>(resolve => {
		server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
	});
	let closed = false;
	return {
		port,
		close: async () => {
			if (closed) { return; }
			closed = true;
			// ⚠ `closeAllConnections` **必须**：可达性探测走的是 `fetch`，它会留 keep-alive 连接 ——
			//   只调 `server.close()` 会一直等那些连接关闭，回调**永远不触发**（实测把测试挂死）。
			server.closeAllConnections?.();
			await new Promise<void>(resolve => { server.close(() => resolve()); });
		},
	};
}

/** 取一个空闲端口对（E2E 用；专属实例占 +1，所以要确认 +1 也空着）。 */
async function freePortPair(): Promise<{ port: number; dedicated: number }> {
	const free = (p: number) => new Promise<boolean>(resolve => {
		const srv = net.createServer();
		srv.once('error', () => resolve(false));
		srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
	});
	for (let i = 0; i < 20; i++) {
		const srv = net.createServer();
		const port = await new Promise<number>(resolve => {
			srv.listen(0, '127.0.0.1', () => {
				const p = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(p));
			});
		});
		if (await free(port + 1)) { return { port, dedicated: port + 1 }; }
	}
	throw new Error('找不到一对空闲端口');
}

/** 页内求值（E2E 断言用；走 Host 那条连接）。 */
async function evaluate(host: ICdpHostLike, sessionId: string, expression: string): Promise<unknown> {
	const res = await host.command('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as { result?: { value?: unknown } };
	return res?.result?.value;
}

/** 取页面上某个标签的 ref（照 snapshot 脚本打的 `data-saros-ref` 属性）。 */
async function refOfTag(host: ICdpHostLike, sessionId: string, tag: string): Promise<number | undefined> {
	const list = await evaluate(host, sessionId,
		`[...document.querySelectorAll('[data-saros-ref]')].filter(e => e.tagName === '${tag}').map(e => Number(e.getAttribute('data-saros-ref')))`) as unknown;
	return Array.isArray(list) && typeof list[0] === 'number' ? list[0] : undefined;
}

/** 当前浏览器里所有 target 的 id（会话回收的断言用：到底哪条 tab 还在）。 */
async function targetIds(host: ICdpHostLike, sessionId: string): Promise<string[]> {
	const res = await host.command('Target.getTargets', {}, sessionId) as { targetInfos?: { targetId?: string }[] };
	return (res?.targetInfos ?? []).map(t => String(t?.targetId));
}

/**
 * 等某条 target 从列表里消失。
 *
 * ⚠ 必须等：`Target.closeTarget` **是异步生效的**（命令返回 ≠ 已从 `Target.getTargets` 里消失），
 * 立刻查会看到竞态 —— 2026-10-13 真机就是这么红的（"A 的页面确实关掉了"失败，其实正在关）。
 */
async function waitGone(host: ICdpHostLike, sessionId: string, targetId: string, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await targetIds(host, sessionId)).includes(targetId)) { return true; }
		if (Date.now() > deadline) { return false; }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

suite('vssaros-browser（browser 族下移到 Host：CDP 不依赖 VsSaros）', () => {

	test('★ 移植的常量与 IDE 侧真源**逐字一致**（漂移 = Host 与 IDE 驱动的不是同一个 Chrome）', async () => {
		const core = await load<IChromeCore>(CORE_CHROME);
		const browserCdp = readIf(SRC_BROWSER_CDP);
		const chromeSetup = readIf(SRC_CHROME_SETUP);
		if (!browserCdp || !chromeSetup) { assert.ok(true, '（跳过：读不到 IDE 侧真源）'); return; }

		assert.strictEqual(core.DEFAULT_CDP_PORT, 9222);
		assert.ok(browserCdp.includes('export const DEFAULT_CDP_PORT = 9222;'), '默认端口真源变了');
		assert.strictEqual(core.CDP_COMMAND_TIMEOUT_MS, 20_000);
		assert.ok(browserCdp.includes('export const CDP_COMMAND_TIMEOUT_MS = 20_000;'), '命令超时真源变了');
		assert.strictEqual(core.CHROME_PATH_ENV, 'SAROS_CHROME_PATH');
		assert.ok(chromeSetup.includes("export const CHROME_PATH_ENV = 'SAROS_CHROME_PATH';"), '环境变量逃生舱真源变了');
		assert.strictEqual(core.CHROME_REMOTE_DEBUGGING_PAGE, 'chrome://inspect/#remote-debugging');
		assert.ok(chromeSetup.includes("export const CHROME_REMOTE_DEBUGGING_PAGE = 'chrome://inspect/#remote-debugging';"), '引导页面地址真源变了');
		assert.strictEqual(core.DEDICATED_PROFILE_DIRNAME, 'browser-profile');
		assert.ok(chromeSetup.includes("export const DEDICATED_PROFILE_DIRNAME = 'browser-profile';"), '专属 profile 目录名真源变了');

		// 专属端口 +1（上限退回 -1）与 profile 路径分隔符：两侧必须是同一个算法
		assert.strictEqual(core.dedicatedPortFor(9222), 9223);
		assert.strictEqual(core.dedicatedPortFor(65535), 65534);
		assert.ok(browserCdp.includes('const next = configuredPort + 1;') && browserCdp.includes('next > 65535 ? configuredPort - 1 : next'),
			'专属端口算法变了（错开一位是"把 9222 留给用户自己的 Chrome"的前提）');
		assert.strictEqual(core.dedicatedProfileDir('C:\\Users\\x', 'win32'), 'C:\\Users\\x\\.vssaros\\browser-profile');
		assert.strictEqual(core.dedicatedProfileDir('/home/x', 'linux'), '/home/x/.vssaros/browser-profile');

		// 命令行开关：`--user-data-dir` 不是可选项（Chrome 136+ 对默认 profile 会静默忽略调试端口）
		assert.deepStrictEqual(core.buildDedicatedChromeArgs('/p', 9333, false), [
			'--user-data-dir=/p', '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check',
		]);
		assert.deepStrictEqual(core.buildDedicatedChromeArgs('/p', 9333, true).at(-1), '--headless',
			'无头只加一个不带 `=new` 的 --headless（Chrome 132+ 就是新无头）');
		for (const flag of ['--user-data-dir=', '--remote-debugging-port=', '--no-first-run', '--no-default-browser-check', "'--headless'"]) {
			assert.ok(chromeSetup.includes(flag), `命令行开关 ${flag} 在真源里找不到 ⇒ 移植已漂移`);
		}
	});

	test('★ 生成物不落后于真源：`bin/sync-snapshot.mjs --check` 必须绿', () => {
		const r = spawnSync(process.execPath, [abs(SYNC_SCRIPT), '--check'], { cwd: process.cwd(), encoding: 'utf8' });
		assert.strictEqual(r.status, 0,
			`lib/core/snapshot.js 与真源不一致（真源改过但没重新生成？）\n${r.stdout ?? ''}${r.stderr ?? ''}`);
	});

	test('候选端点顺序：先配置端口（你自己的 Chrome）→ 同端口 IPv6 → 专属实例（+1）', async () => {
		const core = await load<IChromeCore>(CORE_CHROME);
		const c = core.cdpEndpointCandidates(9222);
		assert.deepStrictEqual(c.map(e => e.url), ['http://127.0.0.1:9222', 'http://[::1]:9222', 'http://127.0.0.1:9223'],
			'顺序即语义：用户自己的 Chrome 必须优先于我们拉起的专属实例');
		assert.deepStrictEqual(c.map(e => e.selfLaunched), [false, false, true]);
		const edge = core.cdpEndpointCandidates(65535);
		assert.deepStrictEqual(edge.map(e => e.url), ['http://127.0.0.1:65535', 'http://[::1]:65535', 'http://127.0.0.1:65534']);
		const cands = core.chromeExecutableCandidates({ SAROS_CHROME_PATH: ' D:\\chrome.exe ' }, 'win32');
		assert.strictEqual(cands[0], 'D:\\chrome.exe', '显式覆盖必须最优先（且去空白）');
		assert.strictEqual(core.pickChromeExecutable(['a', 'b'], p => p === 'b'), 'b');
		assert.strictEqual(core.pickChromeExecutable([], () => true), undefined);
	});

	test('★ `browser` 工具契约：与 IDE 侧同名同参数；18 个 op 全部有实现；动作类默认不放行', async () => {
		const tool = await loadTool();
		const ide = readIf(IDE_PLUGIN);
		const clientSrc = readIf(CORE_CLIENT) ?? '';
		assert.strictEqual(tool.name, 'browser', '必须与 IDE 侧同名（模型看到的是同一个工具）');
		const props = Object.keys(tool.parameters?.properties ?? {});
		// 前 8 个 = 退役前 IDE 侧的参数面（逐字一致）；后 4 个（action / done / expression / timeoutMs）
		// 是 Host 侧新增 op 的参数（2026-10-13：cookie 通道 2 个 + 页面内取值 2 个）；
		// 再后 6 个（delayMs / max / regex / selector / textGone / urlContains）是 2026-10-15 的 P0 新增
		//（`waitFor` 4 个 + `find` 2 个 —— 见 `vssaros-browser/lib/core/interaction.js` / `findInSnapshot.js`）。
		assert.deepStrictEqual(props.sort(),
			['action', 'amount', 'append', 'delayMs', 'direction', 'done', 'expression', 'key', 'max', 'op', 'ref',
				'regex', 'selector', 'text', 'textGone', 'timeoutMs', 'url', 'urlContains'],
			'参数面 = IDE 侧那 8 个 + Host 新增 op 的 10 个（少了某个 = 模型按旧 schema 调用时会丢参）');
		// ⚠ 退役后**不再**去 IDE 侧插件里找这些参数名（README 4.73 Step 3：那个工具已从 `vssaros-ide` 删掉）
		//   ⇒ 参数面由上面这条**硬编码期望** + 官方工具面快照（`dsh-plugins/tools-snapshot.json`）共同钉住 ✓；
		//   与 IDE 侧的**行为**等价性由 `dshBrowserParity.test.ts` 对着退役前的实现做逐字对照 ✓。
		assert.ok(!/name: 'browser'/.test(ide ?? ''), 'IDE 侧插件不该再定义 `browser`（同名 ＝ 整条 entry 失效）');
		// 13 个 op 都在能力层有实现（不是"留了个洞"）：前 11 个是 IDE 侧移植，后 2 个由 Host 侧新增。
		for (const method of [
			'status', 'snapshot', 'images', 'navigate', 'click', 'type', 'pressEnter', 'pressKey', 'scroll', 'back', 'reset',
			'cookiesGetAll', 'cookiesForSite', 'cookiesSet', 'pageProbe', 'openForLogin', 'checkLogin',
		]) {
			assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(clientSrc), `能力层缺 ${method}() ⇒ 该 op 没真的实现`);
		}
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'status' }), true, '只读 op 可并行');
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'navigate' }), false, '动作类 op 独占（与 IDE 侧同口径）');
		// 2026-10-15（P0）：两个新 op 都是**只读** ⇒ 可并行，且不该弹确认（与 `status` 同一档 ✓）。
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'waitFor' }), true, 'waitFor 只读 ⇒ 可并行');
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'find' }), true, 'find 只读 ⇒ 可并行');
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'media' }), true, 'media 只读 ⇒ 可并行（2026-10-15）');
		// 不给任何条件 ⇒ 立刻报错（不进入轮询、不占 timeout）—— 见 `core/interaction.js` 的归一化。
		const waitMissing = await tool.execute({ op: 'waitFor' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/至少一条/.test(waitMissing ?? ''), `waitFor 缺条件必须报错，实际：${waitMissing}`);
		const findMissing = await tool.execute({ op: 'find' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/需要 `text`/.test(findMissing ?? ''), `find 缺检索词必须报错，实际：${findMissing}`);
		// 2026-10-15（P1-⑤）：`storage` 的 `list` 只读可并行；`export`/`import` 是动作类（独占 + 两道闸）✓
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'storage', action: 'list' }), true, 'storage list 只读 ⇒ 可并行');
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'storage', action: 'export' }), false, 'storage export 是动作类 ⇒ 独占');
		assert.deepStrictEqual(tool.isConcurrencySafe?.({ op: 'storage', action: 'import' }), false, 'storage import 是动作类 ⇒ 独占');
		// ★ `export` **默认关**，且**在审批之前**就被拒（"不许为一个必然被拒的调用点确认" ✓）——
		//   这条同时钉住"两道闸"：开关关的时候连审批请求都不该发出去。
		const storageHost: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		const storageTool = await loadTool({}, storageHost);
		const storageErr = await storageTool.execute({ op: 'storage', action: 'export' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/默认关闭/.test(storageErr ?? '') && /allowStorageIO/.test(storageErr ?? ''),
			`storage export 默认必须关闭并说出开关名，实际：${storageErr}`);
		assert.strictEqual(storageHost.approvals.length, 0, '开关关着时不该先弹确认（校验必须先于确认）');

		// 让路标记：必须 provide（`vssaros-ide` 靠它决定让路，否则同名工具撞车 ⇒ 整条 entry 失效）
		const provideHost: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		await loadTool({}, provideHost);
		assert.ok(provideHost.provided.has('vssarosBrowser'), '必须 provide vssarosBrowser（让路标记）');

		// ★ 动作类 + **没有审批通道** ⇒ fail-closed 拒绝，且说清两条出路
		const noChannel = await loadTool({});
		const blocked = await noChannel.execute({ op: 'reset' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/没有审批通道/.test(blocked ?? '') && /fail-closed/.test(blocked ?? ''),
			`无审批通道必须 fail-closed 拒绝，实际：${blocked}`);
		// ★ 有通道但用户**拒批** ⇒ 拒绝（且不碰浏览器）
		const rejectedHost: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'rejected' };
		const rejected = await loadTool({}, rejectedHost);
		const denied = await rejected.execute({ op: 'reset' }, { agent: {}, callId: 'call-1' }).then(() => undefined, (e: Error) => e.message);
		assert.ok(/未获准（rejected）/.test(denied ?? ''), `拒批必须如实报，实际：${denied}`);
		assert.strictEqual(rejectedHost.approvals.length, 1, '动作类必须先问过用户');
		assert.strictEqual(rejectedHost.approvals[0].toolName, 'browser', '审批请求要带上工具名（审计口径）');
		// ★ 获准（`allowed-once`）⇒ 执行 —— 用 `reset`（只丢连接、不碰网络）⇒ 断言是确定性的
		const okHost: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		const granted = await loadTool({}, okHost);
		const done = await granted.execute({ op: 'reset' }, { agent: {}, callId: 'call-2' }) as string;
		assert.ok(/已丢弃 CDP 连接/.test(done), `获准后应当执行，实际：${done}`);
		// ★ `allowActions: true` = 显式免确认（无人值守）⇒ 不问就执行
		const allowHost: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		const free = await loadTool({ allowActions: true }, allowHost);
		await free.execute({ op: 'reset' }, {});
		assert.strictEqual(allowHost.approvals.length, 0, '显式免确认时不该弹确认');
		// ★ 只读 op 不问（哪怕审批通道在、且会拒）
		const readHost: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'rejected' };
		const readTool = await loadTool({}, readHost);
		await readTool.execute({ op: 'status' }, {}).catch(() => undefined);   // 无 Chrome ⇒ 返回"不可达"JSON ✓
		assert.strictEqual(readHost.approvals.length, 0, '只读 op 不该弹确认');

		const unknown = await tool.execute({ op: 'teleport' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/不认识的 browser op/.test(unknown ?? ''), `不认识的 op 要明确失败，实际：${unknown}`);
		// 参数校验在**碰网络之前**（这里 allowActions=true 才轮到校验分支）
		const allowed = await loadTool({ allowActions: true });
		for (const [params, expect] of [
			[{ op: 'navigate' }, /需要 url/],
			[{ op: 'click' }, /需要整数 ref/],
			[{ op: 'type', ref: 3 }, /需要 text/],
			[{ op: 'pressKey' }, /需要 key/],
			[{ op: 'scroll', amount: 10 }, /需要 direction/],
			[{ op: 'scroll', direction: 'down' }, /正整数 amount/],
		] as [Record<string, unknown>, RegExp][]) {
			const msg = await allowed.execute(params, {}).then(() => undefined, (e: Error) => e.message);
			assert.ok(expect.test(msg ?? ''), `${JSON.stringify(params)} 应当被拒（${expect}），实际：${msg}`);
		}
	});

	test('★★ 端到端：Host 侧拉起 headless Chrome → snapshot → click → type（全程无 VsSaros）', async function () {
		const core = await load<IChromeCore>(CORE_CHROME);
		const { CdpHost } = await load<IHostCore>(CORE_HOST);
		const { BrowserCdpClient } = await load<IClientCore>(CORE_CLIENT);
		const exe = core.pickChromeExecutable(
			core.chromeExecutableCandidates(process.env as Record<string, string | undefined>, process.platform),
			p => fs.existsSync(p),
		);
		if (!exe) {
			this.skip();   // 没装 Chrome：跳过（能力验证，不是门禁；skip() 会抛出，故无需 return）
		}
		const { port, dedicated } = await freePortPair();
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-browser-e2e-'));
		const host = new CdpHost({
			port, launchDedicated: true, headless: true, homeDir: tempHome,
			platform: process.platform, env: process.env as Record<string, string | undefined>,
			logger: { info: () => { /* 静音 */ }, warn: () => { /* 静音 */ } },
		});
		// 直接用 Host 侧的能力层（与插件注册的那份同一个类 + 同一个 invoker）
		const { createHostInvoker } = await load<{
			createHostInvoker: (h: ICdpHostLike) => (r: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
		}>('dsh-plugins/vssaros-browser/lib/core/invoker.js');
		const client = new BrowserCdpClient(createHostInvoker(host));
		try {
			// ① 候选端点全不可达 ⇒ 它**自己拉起**专属实例并连上（不需要用户勾任何同意框）
			const page = await host.ensurePage();
			assert.ok(page.targetId && page.sessionId, 'ensurePage 必须给出 targetId 与 sessionId');
			assert.ok(fs.existsSync(core.dedicatedProfileDir(tempHome, process.platform)),
				'专属 profile 目录没建在临时 home 下 ⇒ 会污染用户真实 profile ✗');

			// ② 状态：如实报告"连的是我们自己拉起的那一个"
			const status = await host.status();
			assert.strictEqual(status.ok, true, `连不上：${status.error ?? ''}`);
			assert.strictEqual(status.selfLaunched, true, `应当连的是专属实例（+1 端口 ${dedicated}）`);
			assert.ok(/Chrome\//.test(status.browser ?? ''), `读不到浏览器版本：${status.browser}`);

			// ③ 导航到一页，然后走 **snapshot → click → type** 全链路
			const html = '<title>host-cdp-probe</title>'
				+ '<button id="b" style="width:120px;height:40px" onclick="document.title=\'clicked\'">go</button>'
				+ '<input id="i" style="width:200px;height:30px" aria-label="probe-input">';
			await host.command('Page.navigate', { url: `data:text/html,${encodeURIComponent(html)}` }, page.sessionId);
			let title: unknown;
			for (let i = 0; i < 40 && title !== 'host-cdp-probe'; i++) {
				title = await evaluate(host, page.sessionId, 'document.title');
				if (title !== 'host-cdp-probe') { await new Promise(r => setTimeout(r, 150)); }
			}
			assert.strictEqual(title, 'host-cdp-probe', '导航没到位');

			// 快照：注入脚本必须给可交互元素打上 ref（`click`/`type` 全靠它）
			const snap = await client.snapshot() as { nodes?: unknown[] };
			assert.ok(snap && typeof snap === 'object', `snapshot 没返回值：${JSON.stringify(snap)?.slice(0, 120)}`);
			const buttonRef = await refOfTag(host, page.sessionId, 'BUTTON');
			const inputRef = await refOfTag(host, page.sessionId, 'INPUT');
			assert.ok(typeof buttonRef === 'number', '快照没给 button 打 ref ⇒ click 无从下手');
			assert.ok(typeof inputRef === 'number', '快照没给 input 打 ref ⇒ type 无从下手');

			// click：真实鼠标事件必须真的触发页面的 onclick
			const clicked = await client.click(buttonRef);
			assert.ok(/^Clicked \[/.test(clicked), `click 返回值不合预期：${clicked.slice(0, 120)}`);
			assert.strictEqual(await evaluate(host, page.sessionId, 'document.title'), 'clicked',
				'click 没有真的点到（真实鼠标事件这条路失败）');

			// type：走真实输入管线（React 受控组件也能生效）
			await client.type(inputRef, 'host typed');
			assert.strictEqual(await evaluate(host, page.sessionId, "document.querySelector('#i').value"), 'host typed',
				'type 没有把文字送进输入框');

			// back：要么真的退回去、要么明确说清"退不了"（两条分支都要有可读的话，不许静默/抛错）
			const backText = await client.back();
			assert.ok(/^(Went back|Cannot go back)/.test(backText),
				`back 的返回必须是这两种之一：${backText.slice(0, 140)}`);

			// ★ `evaluate`（2026-10-13）：页面内取值这条通道的真机验证 —— 三条边界都在真 CDP 上跑：
			//   同步取值、异步取值（awaitPromise）、以及两种"取不回来"必须**明确报错**的情形。
			assert.strictEqual(await client.evaluate('(() => 40 + 2)()'), 42, 'evaluate 取不回简单值');
			assert.strictEqual(await client.evaluate('(async () => 7)()'), 7,
				'awaitPromise 没生效（async 表达式拿不到值 ⇒ 用户的抽取代码全废）');
			// ⚠ **实测锚点**（2026-10-13）：CDP 对 DOM 节点（活对象）**不报错** —— `returnByValue` 会把它
			//   静默序列化成空对象（真实返回 `{ result: { type: 'object', value: {} } }`，连 `objectId` 都没有），
			//   与"页面**真的**返回了 `{}`"在协议层**无法区分** ⇒ client 层拦不住，补救在渲染层（对空对象给提示）。
			//   这条断言钉的就是这个事实：CDP 哪天改了行为（改成报错 / 回 objectId），这里**必须红** ——
			//   那时才该把判定挪回 client 层（见 `client.evaluate` 上方那段注释）。
			assert.deepStrictEqual(await client.evaluate('document.body'), {},
				'CDP 对"活对象"的行为变了 —— 先去读 client.evaluate 上方的注释，再决定怎么改，别直接改这条期望');
			await assert.rejects(async () => await client.evaluate('throw new Error("boom")'), /page evaluation failed: .*boom/,
				'页内异常必须变成工具错误，而不是静默给一个空结果');

			// ★ 多会话隔离的**后半段**（2026-10-13，真机）：会话结束时回收**自己**那条 tab，
			//   且绝不动别人那条 —— 前半段（各拿自己的页）已在 `CdpTargetManager` 那组守卫里钉住。
			const pageA = await host.ensurePage('sess-A', 'about:blank');
			const pageB = await host.ensurePage('sess-B', 'about:blank');
			assert.notStrictEqual(pageA.targetId, pageB.targetId, '两个会话应当是两条 tab');
			const reaped = await host.closeSessionPages('sess-A');
			assert.deepStrictEqual(reaped.closed, [pageA.targetId], '应当且只应当回收会话 A 那条');
			assert.strictEqual(reaped.skipped, '', '已连接时不该走"从没连过"那条短路');
			assert.ok(await waitGone(host, page.sessionId, pageA.targetId), 'A 的页面应当真的被关掉（等它异步生效）');
			assert.ok((await targetIds(host, page.sessionId)).includes(pageB.targetId),
				'B 的页面不许被动到 —— 这是"互不影响"的核心');
			const pageA2 = await host.ensurePage('sess-A', 'about:blank');
			assert.notStrictEqual(pageA2.targetId, pageA.targetId, '回收后再用会话 A 应新建，而不是复活一条已关的');
			await host.closeSessionPages('sess-B');
			await host.closeSessionPages('sess-A');
		} finally {
			// ★ 兜底清理（2026-10-13 实测踩到）：`launchDedicatedChrome` 是 detached + unref ——
			//   **故意**的（用户很可能正在那个窗口里登录，Host 退出不该收走他的窗口）；
			//   但测试必须自己收干净：`Browser.close` 只保证浏览器级命令返回，实际进程（含
			//   crashpad/gpu 子进程）可能拖成孤儿。漏几次之后攒下的 headless Chrome 会让**后续**
			//   运行从 2.5s 变成 20s 超时（现象与代码回归一模一样，极难归因）。
			try { await host.command('Browser.close'); } catch { /* 进程可能已退 */ }
			const pid = host.dedicatedPid;
			if (typeof pid === 'number') {
				try {
					if (process.platform === 'win32') {
						spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
					} else {
						process.kill(pid);
					}
				} catch { /* 已经退了 */ }
			}
			host.dispose();
			try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* Chrome 可能还占着文件 */ }
		}
	});
});

/**
 * **单一所有者契约**（README 4.73 Step 3）：`browser` / `unreal_*` 已**整族退役**到 Host 侧插件，
 * `vssaros-ide` 只保留"只能在 IDE 里做"的那几族 ⇒ 同名工具**只有一个所有者**。
 *
 * 为什么必须钉住：dsh 里同名不是"后者覆盖"，而是**整条 entry 注册失败**（表现成"工具静默少了一批"）。
 * 过渡期用的是"服务在场就让路"；退役之后判据更简单也更硬 —— **IDE 侧根本不再定义它们**。
 */
suite('browser 族「单一所有者」契约：退役后 IDE 侧不再定义它们', () => {

	test('★ vssaros-ide 不再定义 browser / unreal_*；只留 IDE 独有的那几族', async () => {
		const mod = await load<{ apply(ctx: unknown, config?: unknown): void }>(IDE_PLUGIN);
		const names: string[] = [];
		const ctx = {
			// IDE 插件的 apply 只**读**这个服务（工具执行时才用它）⇒ 假对象就够
			vssarosBridge: { callIDE: async () => '' },
			logger: { info: () => { /* 静音 */ }, warn: () => { /* 静音 */ } },
			effect: (fn: () => unknown) => fn(),
			get: () => undefined,
			tools: {
				register: (tool: { name: string; output?: unknown }) => {
					if (!tool.output) { throw new TypeError(`tool "${tool.name}" must declare output`); }
					names.push(tool.name);
					return { dispose: () => { /* noop */ } };
				},
			},
		};
		mod.apply(ctx, {});

		assert.ok(!names.includes('browser'), 'browser 已退役 ⇒ IDE 侧不许再定义（同名＝整条 entry 失效）');
		assert.ok(!names.some(n => n.startsWith('unreal_')), 'unreal_* 已退役 ⇒ IDE 侧不许再定义');
		assert.ok(names.includes('get_diagnostics') && names.includes('canvas') && names.includes('show_diff'),
			`只能在 IDE 里做的那几族必须留着，实际：${names.join(', ')}`);

		// 叠加后**不许有重名**：Host 侧那几个 + IDE 侧剩下的
		const hostSide = ['browser', 'unreal_health', 'unreal_help', 'unreal_dump', 'unreal_find_asset'];
		const union = [...names, ...hostSide];
		assert.strictEqual(new Set(union).size, union.length, `叠加后出现重名：${union.join(', ')}`);
	});

	test('★ 接线守卫：随包安装清单与 channel 必须真的带上这两个插件（少了就是"整族没人提供"）', () => {
		const supervisor = readIf('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
		const channel = readIf('src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts');
		const constants = readIf('src/vs/sessions/contrib/dshHarness/common/dshHarness.ts');
		if (!supervisor || !channel || !constants) { assert.ok(true, '（跳过：读不到这些源码）'); return; }
		// 常量两侧同名（改名字符串会让清单与包名错开 ⇒ 装不上，且只在运行时表现为"少了能力"）
		assert.ok(constants.includes("export const DSH_BROWSER_PLUGIN_NAME = '@vssaros/dsh-browser';"), '包名常量变了');
		assert.ok(constants.includes("export const DSH_UNREAL_PLUGIN_NAME = '@vssaros/dsh-unreal';"), '包名常量变了');
		for (const name of ['DSH_BROWSER_PLUGIN_NAME', 'DSH_UNREAL_PLUGIN_NAME']) {
			assert.ok(supervisor.includes(`[${name}, this._opts.`), `${name} 不在随包安装清单里 ⇒ VsSaros 不会装它、让路永不触发`);
		}
		// channel 必须把两个目录解析出来并交给 supervisor（缺任一处 = 永远 undefined = 不装）
		for (const dir of ['browserPluginDir', 'unrealPluginDir']) {
			assert.ok(channel.includes(`${dir}: existsSync(`), `channel 没把 ${dir} 交给 supervisor`);
			assert.ok(supervisor.includes(`readonly ${dir}?`), `supervisor 没有 ${dir} 选项`);
		}
		assert.ok(channel.includes("join(this._bundledPluginsRoot, 'vssaros-browser')"), 'browser 插件目录的解析变了');
		assert.ok(channel.includes("join(this._bundledPluginsRoot, 'vssaros-unreal')"), 'unreal 插件目录的解析变了');
	});
});

// ─── 登录态与 cookie 通道（2026-10-13）────────────────────────────────────────
//
// 为什么这一批不碰真浏览器：承重件是**纯函数**（域名边界、凭据净化、存档判别式、登录三态判定）
// 与**两道闸**（默认关闭的总开关 + 逐次审批）。它们才是"会不会把凭据搬到错的域名上 / 会不会
// 谎报登录成功 / 会不会把凭据写进磁盘"的判据，值得逐条钉死。
// 真机那半（真的 `Storage.getCookies` / `Network.setCookies`）由 `poc/dsh-p0` 的探针覆盖。

interface ICookieCore {
	readonly COOKIE_STORE_VERSION: number;
	parseSiteUrl(raw: unknown): { url: string; host: string; protocol: string; isLoopback: boolean } | undefined;
	isAllowedSiteUrl(site: unknown): boolean;
	cookieDomainMatches(domain: unknown, host: unknown): boolean;
	filterCookiesForSite(cookies: unknown, host: unknown): Array<{ name: string; domain?: string }>;
	looksLikeSessionCookie(name: unknown): boolean;
	summarizeCookies(cookies: unknown, host?: unknown): { total: number; sessionish: string[]; hasSessionish: boolean };
	safeHostSlug(host: unknown): string | undefined;
	cookieStorePath(home: string, platform: string, host: unknown): string | undefined;
	sanitizeCookie(cookie: unknown): Record<string, unknown> | undefined;
	cookieStoreEnvelope(host: string, cookies: unknown, savedAt: string): Record<string, unknown>;
	parseCookieStoreEnvelope(text: unknown): { ok: boolean; reason?: string; host?: string; savedAt?: string; cookies?: Array<Record<string, unknown>> };
	normalizeCookieAction(raw: unknown): 'inspect' | 'export' | 'import';
	formatCookieReport(options: Record<string, unknown>): string;
}

interface ICookieStoreCore {
	readCookieStore(filePath: unknown): { ok: boolean; reason?: string; host?: string; cookies?: Array<Record<string, unknown>> };
	writeCookieStore(filePath: unknown, envelope: Record<string, unknown>): { ok: boolean; path?: string; reason?: string };
}

interface ILoginState {
	readonly host: string;
	readonly url: string;
	readonly onSite: boolean;
	readonly verdict: 'signed-in' | 'not-signed-in' | 'inconclusive';
	readonly conflict: boolean;
	readonly cookies: { total: number; sessionish: string[]; hasSessionish: boolean };
	readonly page: { verdict: string; kind?: string; signals: string[]; length: number };
	readonly evidence: string[];
}

interface ILoginProbeCore {
	PAGE_PROBE_SCRIPT: string;
	judgeLoginState(options: { cookies?: unknown; probe?: unknown; host?: string }): ILoginState;
	formatLoginVerdict(state: unknown): string;
	loginGuidanceText(options: Record<string, unknown>): string;
}

interface ILoginClientCore {
	checkLogin(url?: string): Promise<ILoginState>;
}

suite('vssaros-browser：登录态与 cookie 通道（纯逻辑 + 两道闸）', () => {

	test('★★ 域名匹配必须是**后缀边界**：notexample.com 不得拿到 .example.com 的 cookie', async () => {
		const c = await load<ICookieCore>(CORE_COOKIES);
		assert.strictEqual(c.cookieDomainMatches('.example.com', 'www.example.com'), true);
		assert.strictEqual(c.cookieDomainMatches('example.com', 'example.com'), true);
		assert.strictEqual(c.cookieDomainMatches('.example.com', 'notexample.com'), false,
			'这是安全边界，不是风格问题：裸 endsWith(domain) 会在这里放行');
		assert.strictEqual(c.cookieDomainMatches('.example.com', 'example.com.evil.tld'), false);
		assert.strictEqual(c.cookieDomainMatches('', 'example.com'), false);
		assert.strictEqual(c.cookieDomainMatches('.example.com', ''), false);

		const filtered = c.filterCookiesForSite([
			{ name: 'a', value: '1', domain: '.example.com' },
			{ name: 'b', value: '2', domain: 'notexample.com' },
			{ name: 'c', value: '3', domain: 'www.example.com' },
			{ value: '4', domain: '.example.com' },   // 无名 cookie 必须被剔掉
		], 'www.example.com');
		assert.deepStrictEqual(filtered.map(x => x.name), ['a', 'c']);
	});

	test('★ 站点围栏：只接受 https（或本地回环 http），存档路径**不可由调用方指定**', async () => {
		const c = await load<ICookieCore>(CORE_COOKIES);
		assert.strictEqual(c.isAllowedSiteUrl(c.parseSiteUrl('https://www.zhihu.com/question/1')), true);
		assert.strictEqual(c.isAllowedSiteUrl(c.parseSiteUrl('http://example.com/')), false, '明文 http 上不搬运凭据');
		assert.strictEqual(c.isAllowedSiteUrl(c.parseSiteUrl('http://127.0.0.1:8080/')), true, '回环例外（开发自测）');
		assert.strictEqual(c.parseSiteUrl('javascript:alert(1)'), undefined);
		assert.strictEqual(c.parseSiteUrl('not a url'), undefined);
		assert.strictEqual(c.parseSiteUrl(''), undefined);
		assert.strictEqual(c.parseSiteUrl(undefined), undefined);

		const slug = c.safeHostSlug('../../etc/passwd');
		assert.ok(!!slug && !slug.includes('/') && !slug.includes('..'), `净化必须挡住路径穿越，实际：${String(slug)}`);
		assert.strictEqual(c.safeHostSlug(''), undefined);

		assert.strictEqual(c.cookieStorePath('C:\\Users\\x', 'win32', 'www.zhihu.com'),
			'C:\\Users\\x\\.vssaros\\browser-cookies\\www.zhihu.com.json');
		assert.strictEqual(c.cookieStorePath('C:\\Users\\x', 'win32', ''), undefined, '没有主机名就不给路径（而不是拼出一个怪名字）');
	});

	test('★★ 净化：丢掉会话 cookie 的 `expires=-1`（原样写回会变成 1970 年 ⇒ 立刻过期的死 cookie）', async () => {
		const c = await load<ICookieCore>(CORE_COOKIES);
		const cleaned = c.sanitizeCookie({
			name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/', expires: -1,
			httpOnly: false, secure: true, sameSite: 'None', size: 42, priority: 'Medium',
		});
		assert.deepStrictEqual(cleaned, { name: 'SESSDATA', value: 'v', domain: '.bilibili.com', path: '/', secure: true, sameSite: 'None' },
			'白名单式净化：只留 CDP 认识的字段，且丢 expires<=0');
		assert.strictEqual(c.sanitizeCookie({ value: 'no-name' }), undefined, '没有名字的 cookie 一律丢');
		assert.strictEqual(c.sanitizeCookie(undefined), undefined);
	});

	test('★★ 存档判别式（**不抛错**）：畸形 / 版本不符 / 空集合都要能如实报出来', async () => {
		const c = await load<ICookieCore>(CORE_COOKIES);
		assert.strictEqual(c.parseCookieStoreEnvelope('not json').reason, 'not-json');
		assert.strictEqual(c.parseCookieStoreEnvelope('[]').reason, 'not-object');
		assert.strictEqual(c.parseCookieStoreEnvelope(JSON.stringify({ version: 99, host: 'x', cookies: [] })).reason, 'version-mismatch(99)',
			'未知版本一律拒 —— 宁可读不出来也不误注入');
		assert.strictEqual(c.parseCookieStoreEnvelope(JSON.stringify({ version: 1, cookies: [] })).reason, 'missing-host');
		assert.strictEqual(c.parseCookieStoreEnvelope(JSON.stringify({ version: 1, host: 'x', cookies: 'nope' })).reason, 'missing-cookies');
		assert.strictEqual(c.parseCookieStoreEnvelope(JSON.stringify({ version: 1, host: 'x', cookies: [{ name: '' }] })).reason, 'no-usable-cookies');
		assert.strictEqual(c.normalizeCookieAction('DROP TABLE'), 'inspect', '不认识的动作必须落到只读那一档');

		const env = c.cookieStoreEnvelope('www.zhihu.com', [{ name: 'z_c0', value: 'v', domain: '.zhihu.com', expires: -1 }], '2026-10-13T00:00:00.000Z');
		assert.strictEqual(env.version, c.COOKIE_STORE_VERSION, '信封要带版本号（读侧按版本分派）');
		const back = c.parseCookieStoreEnvelope(JSON.stringify(env));
		assert.strictEqual(back.ok, true);
		assert.strictEqual(back.host, 'www.zhihu.com');
		assert.strictEqual(back.cookies?.length, 1);
	});

	test('★ 给模型的报告里**只有计数与名字**（cookie 值绝不外传）', async () => {
		const c = await load<ICookieCore>(CORE_COOKIES);
		const report = c.formatCookieReport({
			action: 'export', host: 'www.zhihu.com', path: 'C:\\x\\www.zhihu.com.json',
			summary: c.summarizeCookies([{ name: 'z_c0', value: 'SUPER-SECRET-VALUE', domain: '.zhihu.com' }], 'www.zhihu.com'),
		});
		assert.ok(report.includes('**1**'), `要给数量，实际：${report.slice(0, 120)}`);
		assert.ok(report.includes('z_c0'), '可以给名字（归因用）');
		assert.ok(!report.includes('SUPER-SECRET-VALUE'), 'cookie 值**绝不**出现在给模型 / 日志的文本里');
		assert.ok(/credentials/.test(report), '导出必须提醒"这个文件就是活凭据"');

		// ★ 站点白名单是**刚被守卫抓出来的真缺陷**：知乎的登录 cookie 名是 `z_c0`、微博是 `SUB`，
		//   通用语义词表一条都命中不了 ⇒ 没有白名单就会"明明登录了却判没登录"。
		//   这两条同时钉住"白名单必须**按站点**生效"—— 任何把短名字塞进通用表的改动都会在这里红。
		assert.deepStrictEqual(c.summarizeCookies([{ name: 'z_c0' }], 'www.zhihu.com').sessionish, ['z_c0']);
		assert.deepStrictEqual(c.summarizeCookies([{ name: 'z_c0' }], 'example.com').sessionish, [],
			'白名单必须按站点生效：换个站点就不该认它（否则等于全局放宽）');
		assert.deepStrictEqual(c.summarizeCookies([{ name: 'SUB' }], 'weibo.com').sessionish, ['SUB']);
		assert.deepStrictEqual(c.summarizeCookies([{ name: 'web_session' }], 'anything.example').sessionish, ['web_session'],
			'通用语义词（session / token / auth…）不依赖站点白名单');
	});

	test('★ 存档读写往返 + 原子写（不残留 .tmp）+ 读不存在 = 如实报告', async () => {
		const store = await load<ICookieStoreCore>(CORE_COOKIE_STORE);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-cookie-store-'));
		try {
			const file = path.join(dir, 'nested', 'www.zhihu.com.json');
			assert.deepStrictEqual(store.readCookieStore(file), { ok: false, reason: 'missing-file' });
			assert.strictEqual(store.readCookieStore(undefined).ok, false);

			const env = { version: 1, host: 'www.zhihu.com', savedAt: 'x', cookies: [{ name: 'z_c0', value: 'v', domain: '.zhihu.com' }] };
			const written = store.writeCookieStore(file, env);
			assert.strictEqual(written.ok, true, `写失败：${written.reason ?? ''}`);
			assert.ok(!fs.existsSync(`${file}.tmp`), '原子写不能留下临时文件');
			const back = store.readCookieStore(file);
			assert.strictEqual(back.ok, true);
			assert.strictEqual(back.cookies?.[0]?.name, 'z_c0');
		} finally {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 本机 safe-delete shim 偶尔超时 */ }
		}
	});

	test('★★ 登录判据：两条**独立**证据；冲突时判 inconclusive（绝不谎报"已登录"）', async () => {
		const p = await load<ILoginProbeCore>(CORE_LOGIN_PROBE);
		const host = 'www.xiaohongshu.com';
		const loginCookie = [{ name: 'web_session', value: 'x', domain: '.xiaohongshu.com' }];
		const openPage = { url: 'https://www.xiaohongshu.com/explore', host, title: '小红书', text: '正文'.repeat(200) };
		const wallPage = { url: 'https://www.xiaohongshu.com/explore', host, title: '小红书', text: '请先登录后查看' };

		// ① 页面不判墙 且 就在目标站 ⇒ signed-in
		const ok = p.judgeLoginState({ cookies: loginCookie, probe: openPage, host });
		assert.strictEqual(ok.verdict, 'signed-in');
		assert.strictEqual(ok.conflict, false);
		assert.ok(ok.evidence.some(e => e.startsWith('cookie evidence')), '证据必须写出来（模型不该自己编原因）');
		assert.ok(ok.evidence.some(e => e.startsWith('page evidence')), '两条独立证据都要在');

		// ② 页面仍是墙 + 无 cookie ⇒ not-signed-in
		const wall = p.judgeLoginState({ cookies: [], probe: wallPage, host });
		assert.strictEqual(wall.verdict, 'not-signed-in');
		assert.strictEqual(wall.page.kind, 'login-required', '用的是与 HTTP 通道同一份判定真源');

		// ③ 页面仍是墙 + 有 cookie ⇒ **冲突**，判 inconclusive（这是最危险的一种：宣布成功就会接着读一张墙）
		const conflict = p.judgeLoginState({ cookies: loginCookie, probe: wallPage, host });
		assert.strictEqual(conflict.verdict, 'inconclusive');
		assert.strictEqual(conflict.conflict, true);

		// ④ 页面证据不可用时，cookie 是**独立**证据（"没看到页面"不等于"没登录"）
		const cookieOnly = p.judgeLoginState({ cookies: loginCookie, probe: { url: '', host: '', title: '', text: '' }, host });
		assert.strictEqual(cookieOnly.verdict, 'signed-in');
		const offSite = p.judgeLoginState({ cookies: loginCookie, probe: { url: 'https://example.com/', host: 'example.com', title: 'x', text: 'y' }, host });
		assert.strictEqual(offSite.onSite, false, '不是目标站 ⇒ 页面证据必须被忽略（否则看的是别的页）');
		assert.strictEqual(offSite.verdict, 'signed-in');

		// ⑤ 什么证据都没有 ⇒ inconclusive（"没证据"≠"没登录"）
		const nothing = p.judgeLoginState({ cookies: [], probe: { url: '', host: '', title: '', text: '' }, host });
		assert.strictEqual(nothing.verdict, 'inconclusive');
	});

	test('★ 结论文案：不宣布成功的分支必须**明确禁止重试**（否则模型会连点这个 op）', async () => {
		const p = await load<ILoginProbeCore>(CORE_LOGIN_PROBE);
		const host = 'www.xiaohongshu.com';
		const notSigned = p.formatLoginVerdict(p.judgeLoginState({ cookies: [], probe: { url: 'https://www.xiaohongshu.com/x', host, title: 't', text: '请先登录后查看' }, host }));
		assert.ok(notSigned.includes('NOT signed in'), notSigned.slice(0, 60));
		assert.ok(notSigned.includes('Do NOT call this op repeatedly'), '必须禁止空转重试');

		const signed = p.formatLoginVerdict(p.judgeLoginState({ cookies: [{ name: 'web_session', value: 'v', domain: '.xiaohongshu.com' }], probe: { url: 'https://www.xiaohongshu.com/x', host, title: 't', text: '正文'.repeat(200) }, host }));
		assert.ok(signed.includes('looks signed in'));
		assert.ok(signed.includes('If the page still comes back as a wall'), '不把"判据通过"说成"内容一定读得到"');

		const conflict = p.formatLoginVerdict(p.judgeLoginState({ cookies: [{ name: 'web_session', value: 'v', domain: '.xiaohongshu.com' }], probe: { url: 'https://www.xiaohongshu.com/x', host, title: 't', text: '请先登录后查看' }, host }));
		assert.ok(conflict.includes('conflicting evidence'), '冲突必须显式标注');

		const guidance = p.loginGuidanceText({ url: 'https://www.xiaohongshu.com/x', endpoint: 'http://127.0.0.1:9222', selfLaunched: false });
		assert.ok(/Never ask for, or type, credentials/.test(guidance), '凭据纪律写死在引导文案里');
		assert.ok(guidance.includes('done: true'), '给出**可验证**的下一步');
		assert.ok(guidance.includes('9222'), '说清去哪个窗口');
	});

	test('★★ 只读的登录检查**不得凭空开 tab**：没有已协商页面时，一次 ensurePage 都不该发（假 invoker 记录）', async () => {
		const { BrowserCdpClient } = await load<{ BrowserCdpClient: new (invoke: (req: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>, logger?: unknown) => ILoginClientCore }>(CORE_CLIENT);
		const requests: Record<string, unknown>[] = [];
		const client = new BrowserCdpClient(async req => {
			requests.push(req);
			if (req.op === 'command') { return { ok: true, result: { cookies: [{ name: 'z_c0', value: 'v', domain: '.zhihu.com' }] } }; }
			if (req.op === 'ensurePage') { return { ok: true, result: { targetId: 't1', sessionId: 's1', url: 'about:blank' } }; }
			return { ok: false, error: `unexpected op ${String(req.op)}` };
		});
		const state = await client.checkLogin('https://www.zhihu.com/');
		assert.ok(!requests.some(r => r.op === 'ensurePage'),
			'checkLogin 不该协商页面（`page()` 在无缓存时会新建 about:blank —— 凭空开页不是"只读"该有的副作用）');
		assert.strictEqual(state.host, 'www.zhihu.com');
		assert.strictEqual(state.verdict, 'signed-in', '有 cookie 即便没有页面也算已登录（cookie 是独立证据）');
	});

	test('★★ 两道闸：默认关闭时 export/import 直接拒且**不弹审批**；参数/开关校验一律在碰网络之前', async () => {
		const tool = await loadTool({ allowActions: true });
		for (const [params, expect] of [
			[{ op: 'login', url: 'not-a-url' }, /不是合法地址/],
			[{ op: 'cookies', action: 'inspect' }, /需要 url/],
			[{ op: 'cookies', action: 'export', url: 'http://example.com/' }, /只接受 https/],
			[{ op: 'cookies', action: 'export', url: 'https://www.zhihu.com/' }, /默认关闭/],
			[{ op: 'cookies', action: 'import', url: 'https://www.zhihu.com/' }, /默认关闭/],
		] as [Record<string, unknown>, RegExp][]) {
			const msg = await tool.execute(params, {}).then(() => undefined, (e: Error) => e.message);
			assert.ok(expect.test(msg ?? ''), `${JSON.stringify(params)} 应当被拒（${expect}），实际：${msg}`);
		}

		// 开关关着时**连审批都不该问**（用户不该为一个必然失败的调用点确认）
		const gated: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		const gatedTool = await loadTool({}, gated);
		const denied = await gatedTool.execute({ op: 'cookies', action: 'export', url: 'https://www.zhihu.com/' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/默认关闭/.test(denied ?? ''), `实际：${denied}`);
		assert.strictEqual(gated.approvals.length, 0, '开关拒掉的调用不该弹审批');

		// 开关打开 ⇒ 逐次审批，且文案要说真话（这是"搬凭据"，不是"翻页"）
		const open: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'rejected' };
		const openTool = await loadTool({ allowCookieIO: true }, open);
		const rejected = await openTool.execute({ op: 'cookies', action: 'export', url: 'https://www.zhihu.com/' }, {}).then(() => undefined, (e: Error) => e.message);
		assert.ok(/未获准/.test(rejected ?? ''), `实际：${rejected}`);
		assert.strictEqual(open.approvals.length, 1, '开关打开后必须逐次问用户');
		assert.ok(/凭据/.test(open.approvals[0].reason ?? ''), '审批文案必须说清这是凭据操作');

		// 只读面（inspect / done=true）不得进审批 —— 用同一个判定函数（`isActionOp`）钉住
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'cookies', action: 'inspect' }), true, 'inspect 只读');
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'cookies', action: 'export' }), false);
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'login', done: true }), true, 'done=true 只读');
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'login' }), false, '不带 done 会打开页面');
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'snapshot' }), true);
	});
});

// ─── 多会话隔离（2026-10-13，用户要求"多 session 同时用 browser 要互不影响"）──────
//
// 为什么这批必须**行为级**测：隔离的全部影响面就是"这次调用落在哪条 tab 上" ——
// 用假 conn 驱动 `CdpTargetManager` 的决策（真发 `Target.*` 命令的形状、假账户），
// 既能逐条钉住串台，又不需要真浏览器。

interface IFakeTargetInfo {
	targetId: string;
	url: string;
	title: string;
	type: string;
}

interface IFakeConn {
	readonly targets: IFakeTargetInfo[];
	readonly methods: string[];
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** 一个最小的"假浏览器"：维护 target 列表，认 `Target.*` 四件事。 */
function makeFakeConn(): IFakeConn {
	let counter = 0;
	const targets: IFakeTargetInfo[] = [];
	const methods: string[] = [];
	const conn: IFakeConn = {
		targets,
		methods,
		async send(method, params) {
			methods.push(method);
			if (method === 'Target.getTargets') { return { targetInfos: targets.map(t => ({ ...t })) }; }
			if (method === 'Target.createTarget') {
				const targetId = `T${++counter}`;
				targets.push({ targetId, url: String(params?.['url'] ?? 'about:blank'), title: '', type: 'page' });
				return { targetId };
			}
			if (method === 'Target.attachToTarget') { return { sessionId: `S-${String(params?.['targetId'])}-${targets.length}` }; }
			if (method === 'Target.closeTarget') {
				const id = String(params?.['targetId']);
				const i = targets.findIndex(t => t.targetId === id);
				if (i >= 0) { targets.splice(i, 1); }
				return {};
			}
			return {};
		},
	};
	return conn;
}

const SILENT_LOGGER = { info: () => { /* 静音 */ }, warn: () => { /* 静音 */ } };

/** 一个绑定了会话的客户端视图（`forSession` 的返回形状；只列守卫用到的成员）。 */
interface IEnsurePageView {
	readonly sessionKey: string;
	page(url?: string): Promise<unknown>;
	navigate(url: string): Promise<string>;
	openForLogin(url: string): Promise<unknown>;
	snapshot(): Promise<unknown>;
	closeOwnedPage(): Promise<void>;
}

interface ITargetManagerLike {
	readonly ownedCount: number;
	ownedCountOf(key: string): number;
	clearSessions(): void;
	ensurePage(url?: string, ownerKey?: string): Promise<{ targetId: string; sessionId: string; url: string; owner?: string; reused?: boolean; created?: boolean }>;
	closeOwned(targetId: string, ownerKey?: string): Promise<{ closed: boolean }>;
}

suite('vssaros-browser：多会话隔离（每个会话自己那条 tab）', () => {

	const mgr = async (conn: IFakeConn): Promise<ITargetManagerLike> =>
		new (await load<{ CdpTargetManager: new (c: unknown, l: unknown) => ITargetManagerLike }>(CORE_CDP)).CdpTargetManager(conn, SILENT_LOGGER);

	test('★★ 两个会话各拿到**自己的** tab（这是"互不影响"的全部依据）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const a = await m.ensurePage('https://a.example/', 'sess-A');
		const b = await m.ensurePage('https://b.example/', 'sess-B');

		assert.notStrictEqual(a.targetId, b.targetId, '两个会话必须落在不同的 tab 上 —— 共用一条就是串台');
		assert.strictEqual(a.owner, 'sess-A');
		assert.strictEqual(b.owner, 'sess-B');
		assert.strictEqual(m.ownedCountOf('sess-A'), 1);
		assert.strictEqual(m.ownedCountOf('sess-B'), 1);
		assert.strictEqual(m.ownedCount, 2);
	});

	test('★★ 同一会话复用**自己**那条（换 URL 也不新开：导航是调用方的事）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const a1 = await m.ensurePage('https://a.example/', 'sess-A');
		const a2 = await m.ensurePage('https://a.example/other', 'sess-A');
		assert.strictEqual(a2.targetId, a1.targetId, '同一会话必须复用自己那条');
		assert.strictEqual(a2.reused, true);
		assert.strictEqual(m.ownedCount, 1, '换 URL 不该再开一条');
	});

	test('★★ 绝不抢别人的 tab —— **哪怕 URL 完全匹配**（URL 匹配分支在多会话下必须禁用）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const b = await m.ensurePage('https://b.example/', 'sess-B');
		const c = await m.ensurePage('https://b.example/', 'sess-C');
		assert.notStrictEqual(c.targetId, b.targetId,
			'URL 匹配正是串台的来源：B 在这个页面上做事，C 指名同一 URL 也必须自己新开一条');
		assert.strictEqual(m.ownedCountOf('sess-C'), 1);
		assert.strictEqual(m.ownedCountOf('sess-B'), 1);
	});

	test('★★ 断线重连后回到**自己那条**（既不串台、也不泄漏 tab）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const a = await m.ensurePage('https://a.example/', 'sess-A');
		const b = await m.ensurePage('https://b.example/', 'sess-B');
		m.clearSessions();   // 连接断开：CDP 的 sessionId 全部作废（归属记账保留）
		const a2 = await m.ensurePage('https://a.example/', 'sess-A');
		const b2 = await m.ensurePage('https://b.example/', 'sess-B');
		assert.strictEqual(a2.targetId, a.targetId, '重连后必须重新 attach 回自己那条，而不是另开');
		assert.strictEqual(b2.targetId, b.targetId);
		assert.strictEqual(m.ownedCount, 2, '重连不该多出 tab（那正是"泄漏 tab"的老 bug）');
	});

	test('★ 用户把 tab 关掉 ⇒ 销账并新建（账面不许留死指针）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const b = await m.ensurePage('https://b.example/', 'sess-B');
		conn.targets.splice(conn.targets.findIndex(t => t.targetId === b.targetId), 1);
		const b2 = await m.ensurePage('https://b.example/', 'sess-B');
		assert.notStrictEqual(b2.targetId, b.targetId, '旧的没了就该新建');
		assert.strictEqual(m.ownedCountOf('sess-B'), 1, '旧那条必须销账，否则 ownedCount 虚高');
	});

	test('★★ 关页也是按归属拒绝：不许跨会话关页（含空键）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const a = await m.ensurePage('https://a.example/', 'sess-A');
		await assert.rejects(() => m.closeOwned(a.targetId, 'sess-B'), /属于另一个会话/,
			'别的会话不许关我的页面（那会让我下一次调用直接失败）');
		await assert.rejects(() => m.closeOwned(a.targetId, ''), /属于另一个会话/,
			'空键（无会话身份）也不许关别人的 —— 否则隔离可以绕过');
		await assert.rejects(() => m.closeOwned('T-does-not-exist', 'sess-A'), /不是本工具创建的/,
			'非本工具创建的（用户自己的 tab）一律拒绝');
		assert.strictEqual((await m.closeOwned(a.targetId, 'sess-A')).closed, true);
		assert.strictEqual(m.ownedCountOf('sess-A'), 0);
	});

	test('★ 无会话键时**保持原有行为**（IDE 旧路径 / 诊断不受影响）', async () => {
		const conn = makeFakeConn();
		const m = await mgr(conn);
		const l1 = await m.ensurePage('https://x.example/');
		const l2 = await m.ensurePage('https://y.example/');
		assert.strictEqual(l2.targetId, l1.targetId, '无键时"已 attach 的优先"这条旧语义必须保留');
		assert.strictEqual(m.ownedCount, 1);
		assert.strictEqual(m.ownedCountOf(''), 1, '无键的 tab 归属键是空串');
	});

	test('★★ 会话键真从 `exec.agent.id` 取，且畸形一律不猜（纯函数）', async () => {
		const mod = await load<{ sessionKeyOf: (exec: unknown) => string }>(PLUGIN_INDEX);
		assert.strictEqual(typeof mod.sessionKeyOf, 'function', 'sessionKeyOf 必须导出（它是隔离入口的判据）');
		assert.strictEqual(mod.sessionKeyOf({ agent: { id: 'sess-1' } }), 'sess-1');
		assert.strictEqual(mod.sessionKeyOf({ agent: { id: '' } }), '', '空串 ⇒ 不隔离');
		assert.strictEqual(mod.sessionKeyOf({ agent: { id: 42 } }), '', '非字符串 ⇒ 不猜（拿畸形 id 当键比不隔离更糟）');
		assert.strictEqual(mod.sessionKeyOf({ agent: {} }), '');
		assert.strictEqual(mod.sessionKeyOf({ agent: null }), '');
		assert.strictEqual(mod.sessionKeyOf({}), '');
		assert.strictEqual(mod.sessionKeyOf(undefined), '');
	});

	test('★★ `forSession` 把会话键透到通道层，且**各视图各持自己的页面缓存**（假 invoker 记录）', async () => {
		const { BrowserCdpClient } = await load<{
			BrowserCdpClient: new (invoke: (req: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>, logger?: unknown, key?: string) => {
				readonly sessionKey: string;
				forSession(key: string): { readonly sessionKey: string; page(url?: string): Promise<unknown> };
			};
		}>(CORE_CLIENT);
		const requests: Record<string, unknown>[] = [];
		const base = new BrowserCdpClient(async req => {
			requests.push(req);
			return { ok: true, result: { targetId: 'T1', sessionId: 'S1', url: 'about:blank' } };
		});

		const a = base.forSession('sess-A');
		assert.strictEqual(a.sessionKey, 'sess-A');
		await a.page();
		assert.strictEqual(requests.at(-1)?.['op'], 'ensurePage');
		assert.strictEqual(requests.at(-1)?.['key'], 'sess-A', '会话键必须透到通道层（否则隔离形同虚设）');

		const before = requests.length;
		await a.page();
		assert.strictEqual(requests.length, before, '同一视图内应命中自己的页面缓存（不重复协商）');

		const b = base.forSession('sess-B');
		await b.page();
		assert.strictEqual(requests.at(-1)?.['key'], 'sess-B', '另一个会话用自己的键');
	});

	test('★★ 每个会协商页面的入口都必须带会话键 —— 漏一个就串台（真机实测抓过 navigate 那一处）', async () => {
		const { BrowserCdpClient } = await load<{
			BrowserCdpClient: new (
				invoke: (req: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>,
				logger?: unknown,
				key?: string,
			) => { forSession(key: string): IEnsurePageView };
		}>(CORE_CLIENT);
		const requests: Record<string, unknown>[] = [];
		const view = new BrowserCdpClient(async req => {
			requests.push(req);
			if (req['op'] === 'command') {
				// `Page.navigate` / `Runtime.evaluate` 之类一律给个能跑通的最小回包
				return { ok: true, result: { result: { value: { url: 'https://x.example/', title: 't', nodes: [], headings: [], textExcerpt: 'x', truncatedRefs: false, images: [], videos: [], truncated: false, skippedInline: 0, readyState: 'complete' } } } };
			}
			return { ok: true, result: { targetId: 'T1', sessionId: 'S1', url: 'https://x.example/' } };
		}, undefined, 'sess-A').forSession('sess-A');

		const ensureCalls = () => requests.filter(r => r['op'] === 'ensurePage');

		await view.page();
		assert.strictEqual(ensureCalls().at(-1)?.['key'], 'sess-A', 'page() 要带键');

		await view.navigate('https://x.example/').catch(() => undefined);
		assert.strictEqual(ensureCalls().at(-1)?.['key'], 'sess-A',
			'navigate() 也要带键 —— 漏了它会复用别的会话的 tab（真机抓过的那个 bug）');

		await view.openForLogin('https://x.example/').catch(() => undefined);
		assert.strictEqual(ensureCalls().at(-1)?.['key'], 'sess-A', 'openForLogin() 要带键');

		assert.ok(ensureCalls().length >= 3, `至少要看到三次协商（实际 ${ensureCalls().length}）—— 防这条断言空跑`);
		for (const call of ensureCalls()) {
			assert.strictEqual(call['key'], 'sess-A', `每一次 ensurePage 都必须带键，实际：${JSON.stringify(call)}`);
		}
	});

	test('★ 能力声明：provide 上标了"页面按会话隔离"（诊断/守卫能读到）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		await loadTool({}, host);
		const provided = host.provided.get('vssarosBrowser') as { sessionIsolation?: string } | undefined;
		assert.strictEqual(provided?.sessionIsolation, 'per-session-tab');
	});
});

// ─── 多会话隔离的闭环：会话结束回收 + 反检测基线（2026-10-13）────────────────────

suite('vssaros-browser：会话结束回收页面 + 反检测基线', () => {

	test('★★ 从没连过 CDP ⇒ 回收**什么都不做**（不许为了关页面去连一次、更不许因此拉起浏览器）', async () => {
		const { CdpHost } = await load<IHostCore>(CORE_HOST);
		// 端口给一个几乎不可能有东西的号 + 禁掉自动拉起 ⇒ 这次调用绝不该碰网络
		const cold = new CdpHost({ port: 1, launchDedicated: false, headless: true, homeDir: os.tmpdir() });
		try {
			const result = await cold.closeSessionPages('sess-A');
			assert.deepStrictEqual(result, { closed: [], skipped: 'never-connected' },
				'冷启动必须短路返回 —— 否则"会话结束"反而会拉起一个浏览器（本末倒置）');
		} finally {
			cold.dispose();
		}
	});

	test('★★ `ownedTargetsOf` 只列本会话名下的 tab（回收的输入必须精确）', async () => {
		const { CdpTargetManager } = await load<{
			CdpTargetManager: new (c: unknown, l: unknown) => ITargetManagerLike & { ownedTargetsOf(k: string): string[] };
		}>(CORE_CDP);
		const m = new CdpTargetManager(makeFakeConn(), SILENT_LOGGER);
		const a = await m.ensurePage('https://a.example/', 'sess-A');
		const b = await m.ensurePage('https://b.example/', 'sess-B');
		assert.deepStrictEqual(m.ownedTargetsOf('sess-A'), [a.targetId]);
		assert.deepStrictEqual(m.ownedTargetsOf('sess-B'), [b.targetId]);
		assert.deepStrictEqual(m.ownedTargetsOf('sess-C'), [], '没有页面的会话给空数组（而不是抛错）');
		assert.deepStrictEqual(m.ownedTargetsOf(''), [], '空键名下也不该有页面');
	});

	test('★★ `agent/disposed` 必须真的接上（隔离的后半段：用完要能还）+ handler 容错', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		await loadTool({}, host);
		const subscription = (host.events ?? []).find(e => e.event === 'agent/disposed');
		assert.ok(subscription,
			`必须订阅 agent/disposed，实际订阅了：${(host.events ?? []).map(e => e.event).join(', ') || '(无)'}`);

		// handler 跑在**别人的**事件循环里 ⇒ 任何畸形 payload 都不许抛。
		// （`{ agent: { id: 'sess-A' } }` 会 fire-and-forget 去回收 —— 此处的 host 从未连过 CDP，
		//   于是走"never-connected"短路，不会碰网络，这正是上面那条守卫的同一个性质。）
		for (const payload of [undefined, {}, { agent: null }, { agent: {} }, { agent: { id: 42 } }, { agent: { id: 'sess-A' } }]) {
			assert.doesNotThrow(() => subscription?.handler(payload), `payload=${JSON.stringify(payload)} 时 handler 不该抛`);
		}
	});

	test('★★ 反检测基线：dsh 侧与 IDE 侧**同一行**（两处拉起的实例行为必须一致）', async () => {
		const chromeCore = await load<IChromeCore>(CORE_CHROME);
		const dshArgs = chromeCore.buildDedicatedChromeArgs('/tmp/p', 9223, false);
		assert.ok(dshArgs.includes('--disable-blink-features=AutomationControlled'),
			`dsh 侧缺反检测基线：${dshArgs.join(' ')}`);

		// 三条"不做"的边界（调研结论，别自作聪明加回来）
		assert.ok(!dshArgs.some(a => /user-agent/i.test(a)), '不改 UA：真实浏览器本身就是最强信号');
		assert.ok(!dshArgs.some(a => /disable-blink-features=(?!AutomationControlled)/.test(a)), '不叠加别的 blink 开关');
		assert.ok(!dshArgs.includes('--headless=new'), '无头仍用不带 =new 的 --headless（老版本上 =new 会掉回有窗口）');

		const ideSrc = readIf(SRC_CHROME_SETUP);
		assert.ok(ideSrc, `读不到 IDE 侧真源：${SRC_CHROME_SETUP}`);
		assert.ok(ideSrc.includes('--disable-blink-features=AutomationControlled'),
			'IDE 侧那份 buildDedicatedChromeArgs 也要有同一行 —— 否则两条路行为不一致（症状是"有时能过检测、有时不能"）');
	});
});

// ─── `evaluate` op：默认关 + 逐次审批（审批必须回显代码）+ 有界输出（2026-10-13）──────

interface IEvaluateCore {
	readonly EVALUATE_MAX_EXPRESSION_CHARS: number;
	readonly EVALUATE_MAX_RESULT_CHARS: number;
	readonly EVALUATE_REASON_PREVIEW_CHARS: number;
	readonly EVALUATE_MAX_TIMEOUT_MS: number;
	normalizeExpression(raw: unknown): string;
	expressionPreview(expression: unknown): string;
	clampEvaluateTimeout(raw: unknown): number | undefined;
	valueTypeOf(value: unknown): string;
	formatEvaluateResult(expression: string, value: unknown): string;
}

suite('vssaros-browser：evaluate（页面内取值）的闸与边界', () => {

	test('★ 表达式校验：空 / 非字符串 / 超长都在**审批之前**就被拒', async () => {
		const core = await load<IEvaluateCore>(CORE_EVALUATE);
		assert.throws(() => core.normalizeExpression(undefined), /需要 expression/);
		assert.throws(() => core.normalizeExpression('   '), /需要 expression/);
		assert.throws(() => core.normalizeExpression(42), /需要 expression/);
		assert.throws(
			() => core.normalizeExpression('x'.repeat(core.EVALUATE_MAX_EXPRESSION_CHARS + 1)),
			/太长/,
			'超长表达式要在问用户之前就拒掉（否则用户为一次必然失败的调用点确认）',
		);
		assert.strictEqual(core.normalizeExpression('  1 + 1  '), '1 + 1', 'trim 之后原样使用（不美化、不改写）');
	});

	test('★★ 默认关闭：连审批都不该弹（顺序必须是"先校验、后询问"）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		const tool = await loadTool({}, host);   // 不给 allowEvaluate ⇒ 默认关
		await assert.rejects(async () => await tool.execute({ op: 'evaluate', expression: '1+1' }), /默认关闭/);
		assert.strictEqual(host.approvals.length, 0,
			'开关关着时不该弹审批 —— 那是一次**必然被拒**的询问（审批疲劳正是这么来的）');
	});

	test('★★ 开了开关但没有审批通道 ⇒ fail-closed（绝不静默执行）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };   // 无 approvalOutcome ⇒ 没有审批服务
		const tool = await loadTool({ allowEvaluate: true }, host);
		await assert.rejects(async () => await tool.execute({ op: 'evaluate', expression: '1+1' }), /没有审批通道/);
	});

	test('★★ 审批**必须回显那段代码**（用户批的是代码，不是"某个叫 evaluate 的动作"）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		const tool = await loadTool({ allowEvaluate: true }, host);
		// 会走到 client（此处没有可连的 CDP）⇒ 必然失败，但那不是本测试要看的东西。
		await tool.execute({ op: 'evaluate', expression: 'document.querySelectorAll(".item").length' }).catch(() => undefined);

		assert.strictEqual(host.approvals.length, 1, '审批必须发生一次');
		const reason = String(host.approvals[0].reason ?? '');
		assert.ok(reason.includes('document.querySelectorAll(".item").length'),
			`审批文案必须逐字回显表达式，否则用户无从判断：${reason}`);
		assert.ok(/cookie|localStorage/.test(reason), '还要说清它能读到什么（cookie / localStorage）—— 这是点同意的依据');
	});

	test('★ 审批被拒 ⇒ 不执行（且消息里带上结果原因）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'denied' };
		const tool = await loadTool({ allowEvaluate: true }, host);
		await assert.rejects(async () => await tool.execute({ op: 'evaluate', expression: '1+1' }), /未获准（denied）/);
	});

	test('★ op 表里有 evaluate，且它属动作类（不可并发）；只读 op 仍可并发', async () => {
		const tool = await loadTool({}, { tools: [], provided: new Map(), approvals: [] });
		const ops = (tool.parameters as { properties: { op: { enum: string[] } } }).properties.op.enum;
		assert.ok(ops.includes('evaluate'), `op 表缺 evaluate：${ops.join(' / ')}`);
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'evaluate' }), false, 'evaluate 不该被判为可并发');
		assert.strictEqual(tool.isConcurrencySafe?.({ op: 'snapshot' }), true, '只读 op 必须仍然可并发（别把闸开成一律独占）');
	});

	test('★★ 渲染：标出类型、说清"这不是页面内容"，超长结果**必须截断**', async () => {
		const core = await load<IEvaluateCore>(CORE_EVALUATE);
		const short = core.formatEvaluateResult('document.title', 'hello');
		assert.ok(short.includes('(string)'), '要标出值的类型（免得把 [object Object] 当内容用）');
		assert.ok(short.includes('hello'), '值本身要在结果里');
		assert.ok(short.includes('not page content'), '必须说清这是页面里的值、不是页面内容');
		assert.ok(short.includes('snapshot'), '必须提醒"跑过 JS 后 ref 可能失效 ⇒ 重新 snapshot"');

		const long = core.formatEvaluateResult('document.documentElement.outerHTML', 'y'.repeat(core.EVALUATE_MAX_RESULT_CHARS + 500));
		assert.ok(long.length < core.EVALUATE_MAX_RESULT_CHARS + 2000,
			'结果必须被截断 —— 一个 outerHTML 就能灌爆上下文');
		assert.ok(/truncated: 500 more chars/.test(long), `截断要标出被丢了多少：${long.slice(-140)}`);

		const arr = core.formatEvaluateResult('[...document.querySelectorAll("a")]', ['a', 'b']);
		assert.ok(arr.includes('(array(2))'), '数组要带长度（这是"取全了没有"的判据）');
		assert.ok(core.formatEvaluateResult('x', undefined).includes('(undefined)'), 'undefined 也要如实说，不能装作空结果');
		assert.strictEqual(core.valueTypeOf(null), 'null');
		assert.strictEqual(core.valueTypeOf({}), 'object');
	});

	test('★★ 空对象要给可行动提示（活对象在协议层判不出来 —— 这是唯一的补救）', async () => {
		const core = await load<IEvaluateCore>(CORE_EVALUATE);
		// 实测背景：`document.body` 经 CDP 回来**就是** `{}`（见 E2E 里那条行为锚点）。
		const rendered = core.formatEvaluateResult('document.body', {});
		assert.ok(/empty object/i.test(rendered), `空对象必须提示（否则模型以为"内容本来就是空的"）：${rendered}`);
		assert.ok(rendered.includes('outerHTML'), '提示要给**可行动**的替代写法（改成返回字符串）');

		// 反向：非空对象不该出现这条提示（否则每次取对象都要看一遍噪音，久了就被无视）
		assert.ok(!/empty object/i.test(core.formatEvaluateResult('({ a: 1 })', { a: 1 })), '非空对象不该被误标');
	});

	test('★ 超时归一：没给交给 CDP 默认；给了夹在 1s～120s', async () => {
		const core = await load<IEvaluateCore>(CORE_EVALUATE);
		assert.strictEqual(core.clampEvaluateTimeout(undefined), undefined,
			'没给就返回 undefined（由 client 用 CDP 默认值 —— 两处各写一个默认数必然漂移）');
		assert.strictEqual(core.clampEvaluateTimeout(0), undefined);
		assert.strictEqual(core.clampEvaluateTimeout(Number.NaN), undefined);
		assert.strictEqual(core.clampEvaluateTimeout(500), 1000, '低于 1s 抬到 1s');
		assert.strictEqual(core.clampEvaluateTimeout(5000), 5000, '区间内原样');
		assert.strictEqual(core.clampEvaluateTimeout(9_999_999), core.EVALUATE_MAX_TIMEOUT_MS, '超上限夹到上限');
	});

	test('★ 审批预览：压平空白 + 截断（弹窗里要读得完，内容仍逐字来自调用方）', async () => {
		const core = await load<IEvaluateCore>(CORE_EVALUATE);
		assert.strictEqual(core.expressionPreview('  a\n\n  b\tc  '), 'a b c');
		const long = core.expressionPreview('z'.repeat(core.EVALUATE_REASON_PREVIEW_CHARS + 40));
		assert.ok(long.length < core.EVALUATE_REASON_PREVIEW_CHARS + 40, '预览要截断');
		assert.ok(/\+\d+ chars\)$/.test(long), `截断要标出来：${long.slice(-40)}`);
	});

	test('★ 工具描述要一起交代：默认关 + 不要拿它搬凭据', async () => {
		const tool = await loadTool({}, { tools: [], provided: new Map(), approvals: [] });
		const description = String(tool.description ?? '');
		assert.ok(description.includes('evaluate'), 'op 列表要含 evaluate');
		assert.ok(description.includes('默认关闭'), '要写明默认关（否则模型以为调了就能用）');
		assert.ok(description.includes('凭据'), '要写明别拿它搬凭据（那是 cookies 的事，且值不该进上下文）');
	});

	test('★ 技能文档与能力对齐：web-content-import 不再宣称"没有执行 JS 的工具"', () => {
		const skill = readIf('resources/.agents/skills/web-content-import/SKILL.md');
		assert.ok(skill, '读不到技能文件');
		assert.ok(!skill.includes('没有「在页面里执行任意 JS」的工具'),
			'能力已经补上（op: evaluate），这句陈旧的断言必须改掉 —— 否则模型永远不会想到用这条通道');
		assert.ok(skill.includes('op: "evaluate"'), '要给出这条通道的用法与前提（默认关 + 逐次批准）');
		// ★ 工具可见性门控（2026-10-13）：`browser` 在不可达时会**不在**工具列表里 ⇒ 技能必须教模型
		//   怎么解释这件事（否则它要么以为工具坏了、要么干等，而正确动作是"请用户开一次调试"）。
		assert.ok(skill.includes('在不在你的工具列表里'), '要教模型先看工具在不在 —— 它会动态消失（不可达时）');
		assert.ok(skill.includes('chrome://inspect/#remote-debugging'), '工具不在时要给出"请用户开调试"那句原话');
	});
});

// ─── 「连不上浏览器」的可读错误 + 审批前门控（2026-10-13，真机日志定位）──────────────
//
// 背景（用户给的两张真机截图）：模型按我们的登录墙文案去调 `browser.login` ⇒ **先弹授权卡** ⇒
// 用户点了"允许一次" ⇒ 然后才失败，而错误是裸的 `fetch failed`。四个缺陷里这个组钉住其中三个：
// ③ 错误不可读、② 审批在必然失败的检查之前、④ Host 侧默认值与 IDE 侧不一致。

interface IUnreachableCore {
	unreachableMessage(op: string, info: Record<string, unknown>): string;
}

suite('vssaros-browser：连不上浏览器时的门控与文案', () => {

	test('★★ 底层 `fetch failed` 必须被翻译成人能读的原因（真机日志里模型只能自己猜）', async () => {
		const hostMod = await load<{ explainEndpointFailure(e: unknown): string }>(CORE_HOST);
		assert.ok(/连接被拒绝/.test(hostMod.explainEndpointFailure(new TypeError('fetch failed'))),
			'`fetch failed` 的实际含义就是"那个端口没人在听"');
		assert.ok(/连接被拒绝/.test(hostMod.explainEndpointFailure(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))));
		assert.ok(/超时/.test(hostMod.explainEndpointFailure(Object.assign(new Error('x'), { cause: { code: 'ETIMEDOUT' } }))));
		assert.strictEqual(hostMod.explainEndpointFailure(new Error('no webSocketDebuggerUrl in /json/version')),
			'no webSocketDebuggerUrl in /json/version',
			'翻译只**加**信息，不丢原始消息（那种错误已经够可读，别覆盖掉）');
		assert.ok(hostMod.explainEndpointFailure(undefined).length > 0, '没原因也要给一句话，不能空白');
	});

	test('★★ 不可达文案：说清现象 + 请谁做什么 + **明说重试没用**', async () => {
		const core = await load<IUnreachableCore>(CORE_UNREACHABLE);
		const msg = core.unreachableMessage('login', {
			endpoint: 'http://127.0.0.1:9222',
			error: '连接被拒绝 —— 该端口上没有 Chrome 在监听（远程调试没开，或端口不对）',
			launchDedicated: false,
			dedicatedPort: 9223,
		});
		assert.ok(msg.includes('http://127.0.0.1:9222'), '要说清连的是哪个端点');
		assert.ok(msg.includes('连接被拒绝'), '要把原因原样带出来');
		assert.ok(msg.includes('chrome://inspect/#remote-debugging'), '要给出"请用户开一次远程调试"这条真出路');
		assert.ok(/重试本工具没有任何意义/.test(msg),
			'★★★★ 必须明说重试无用 —— 真机日志里最贵的浪费就是模型在同一个失败上反复撞');
		assert.ok(msg.includes('VSSAROS_BROWSER_LAUNCH_DEDICATED'), '关着时要告诉它怎么开自动拉起');
		assert.ok(!/已开启/.test(msg), '关着时不能说自己已经开着（说假话比不说更糟）');
		assert.ok(/如实告诉用户/.test(msg), '要提醒把"做了什么"告诉用户（否则用户只看到"做不到"）');
	});

	test('★★ 自动拉起开着时文案换成"直接重试"（两条路互斥，别同时讲）', async () => {
		const core = await load<IUnreachableCore>(CORE_UNREACHABLE);
		const msg = core.unreachableMessage('navigate', {
			endpoint: 'http://127.0.0.1:9222', error: '连接被拒绝', launchDedicated: true, dedicatedPort: 9223,
		});
		assert.ok(msg.includes('9223'), '要说清专属实例跑在哪个端口');
		assert.ok(!msg.includes('VSSAROS_BROWSER_LAUNCH_DEDICATED'), '已经开着时不该再教怎么开');
	});

	test('★ 端口不是 9222 时要提醒"那个勾选框只认 9222"', async () => {
		const core = await load<IUnreachableCore>(CORE_UNREACHABLE);
		const msg = core.unreachableMessage('snapshot', { endpoint: 'http://127.0.0.1:9333', error: '连接被拒绝' });
		assert.ok(/保持 9222/.test(msg), `端口对不上是"加了参数却连不上"的经典原因，必须提醒：${msg.slice(0, 220)}`);
	});

	test('★★ `ensureReachable`：连不上时给可读原因，且**失败结论会被缓存**', async () => {
		const { CdpHost } = await load<{
			CdpHost: new (o: Record<string, unknown>) => {
				probe(): Promise<{ ok: boolean; error?: string }>;
				ensureReachable(): Promise<{ ok: boolean; error?: string; endpoint?: string; connected?: boolean }>;
				dispose(): void;
			};
		}>(CORE_HOST);
		const h = new CdpHost({ port: 1, launchDedicated: false, homeDir: os.tmpdir() });
		try {
			let probes = 0;
			const real = h.probe.bind(h);
			(h as unknown as { probe: () => Promise<unknown> }).probe = async () => { probes++; return await real(); };

			const cold = await h.ensureReachable();
			assert.strictEqual(cold.ok, false, '端口 1 上不可能有 Chrome 在监听');
			assert.notStrictEqual(String(cold.error), 'fetch failed', `错误不该是裸的 fetch failed：${cold.error}`);
			assert.ok(/连接被拒绝|超时|不可达/.test(String(cold.error)), `要是人话：${cold.error}`);

			await h.ensureReachable();
			assert.strictEqual(probes, 1, '失败必须被缓存 —— 否则模型连试几个 op 就是每个都白等一次探测');

			(h as unknown as { _conn: unknown })._conn = { /* 假装连上了 */ };
			const hot = await h.ensureReachable();
			assert.strictEqual(hot.ok, true, '已连接直接放行（连接在手是最硬的证据）');
			assert.strictEqual(probes, 1, '已连接时不该再探测');
		} finally {
			h.dispose();
		}
	});

	test('★★★ 无兜底且不可达 ⇒ `browser` **压根不在工具面里**（缺陷 1 的彻底修法）', async () => {
		// 端口 1（本机不可能有人监听）+ 关掉自动拉起 ⇒ "确定不可用"的场景
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		await loadTool({ port: 1, launchDedicated: false }, host, { allowAbsent: true });

		// 给"首轮探测"留足时间：只有**等过之后仍未注册**才算数（否则可能只是探测还没跑完）
		await new Promise(resolve => setTimeout(resolve, 400));
		assert.strictEqual(host.tools.length, 0,
			'★★★★ 这正是真机事故的主因：浏览器根本连不上，工具却仍在列表里 ⇒ 模型必然去试 ⇒ 弹一次授权 ⇒ 失败。'
			+ '无兜底时**不许**把它暴露给模型');
		// ⚠ 让路标记照旧提供：它决定"IDE 侧那套 `browser` 要不要让位"，必须在装配期**静态**定下来，
		//   与可见性门控是两件事。两边都不注册是**对的** —— 此刻浏览器就是不可用，给个假入口更糟。
		assert.ok(host.provided.has('vssarosBrowser'),
			'让路标记仍要在（否则 IDE 侧会补一个"行为不确定"的同名工具）');
	});

	test('★★ 有兜底（`launchDedicated` 开）⇒ **同步**注册：默认路径零延迟，也不必先探测', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		const tool = await loadTool({ port: 1, launchDedicated: true }, host);
		assert.ok(tool, '有兜底时"连不上"不等于"用不了"（会自己拉起专属实例）⇒ 必须立刻可见');
	});

	test('★★★ 通了才露面；随后断开 ⇒ 拦住"审批之前"的调用 + `status` 仍可诊断', async () => {
		const fake = await startFakeCdpEndpoint();
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [], approvalOutcome: 'allowed-once' };
		try {
			const tool = await loadTool({ port: fake.port, launchDedicated: false }, host, { waitForRegistrationMs: 2_000 });
			assert.ok(tool, '可达时必须把工具暴露出来（否则用户永远用不上浏览器）');

			await fake.close();   // 端口没了 —— 但重探要等 30s，所以工具**此刻仍在**工具面里

			// ① 这段窗口由 `requireReachable` 兜住：下一次会失败的动作类调用必须在**审批之前**被拦
			await assert.rejects(
				async () => await tool.execute({ op: 'login', url: 'https://www.xiaohongshu.com/explore/abc' }),
				/CDP 端点全部不可达|连不上 Chrome/,
				'连不上时必须在审批**之前**拒绝，且错误要说清是"连不上"',
			);
			assert.strictEqual(host.approvals.length, 0,
				'★★★★ 真机日志里用户就是白点了一次"允许一次"（授权卡 → 25s 等待 → fetch failed）'
				+ ' —— 校验必须发生在审批之前');
			assert.strictEqual(host.tools.length, 1, '（重探周期还没到 ⇒ 工具仍在册，这正是要被兜住的那段窗口）');

			// ② `status` 例外：它的**存在意义**就是如实报告"连不上"（拦了它等于把诊断能力一起关掉）
			const out = await tool.execute({ op: 'status' });
			assert.ok(/"ok":\s*false/.test(String(out)), `status 必须如实报不可用而不是抛错：${String(out).slice(0, 240)}`);
		} finally {
			await fake.close().catch(() => undefined);
		}
	});

	test('★ 卸载 ⇒ 注销（插件重载不留孤儿注册）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		const tool = await loadTool({ port: 1, launchDedicated: true }, host);
		assert.ok(tool && host.tools.length === 1);
		assert.ok((host.disposers ?? []).length > 0, '`ctx.effect` 必须留下卸载钩子');
		for (const dispose of host.disposers ?? []) { dispose(); }
		assert.strictEqual(host.tools.length, 0, '卸载后必须把工具摘掉 —— 否则重载会留下孤儿注册（两个同名工具会让整条 entry 失效）');
	});

	test('★★ 默认"自动拉起"必须是**开**（与 IDE 侧那个设置的默认值一致 —— 否则"开箱即用"是假的）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		await loadTool({}, host);   // 不给配置 ⇒ 走默认值（与 cordis.patch.yml 的 `config: {}` 同一条路）
		const provided = host.provided.get('vssarosBrowser') as { launchDedicated?: boolean } | undefined;
		assert.strictEqual(provided?.launchDedicated, true,
			'Host 是独立进程、读不到 IDE 的 settings ⇒ 默认值必须以这一侧为准；'
			+ 'false 的症状就是真机那次"工具看得见、永远用不了"');
	});

	test('★ 显式关掉就真的关（既反映在能力声明里，也真的不再无条件注册）', async () => {
		const host: IFakeHost = { tools: [], provided: new Map(), approvals: [] };
		// ⚠ 关掉之后走的是"先探一次可达性"那条路（端口 1 ⇒ 探不通 ⇒ 不注册）⇒ 要 allowAbsent。
		await loadTool({ port: 1, launchDedicated: false }, host, { allowAbsent: true });
		assert.strictEqual((host.provided.get('vssarosBrowser') as { launchDedicated?: boolean })?.launchDedicated, false,
			'显式配置必须生效（否则"能关"是假的）');
		assert.strictEqual(host.tools.length, 0, '关掉兜底 + 不可达 ⇒ 不该注册（与上一条守卫是同一条判据）');
	});

	test('★ 工具描述要交代"连不上时别重试"（模型不会自己知道）', async () => {
		const tool = await loadTool({}, { tools: [], provided: new Map(), approvals: [] });
		const description = String(tool.description ?? '');
		assert.ok(description.includes('CDP 端点全部不可达'), '要把这个错误串写进描述，模型才认得出它');
		assert.ok(description.includes('不要重试'), '要明说不要重试');
	});

	test('★★★ 技能引用的工具必须与**实际工具面**对账（Host-only 里没有 IDE 内置工具）', async () => {
		const skill = readIf(SKILL_WEB_IMPORT);
		const snapshot = readIf(TOOLS_SNAPSHOT);
		assert.ok(skill, `读不到技能文件：${SKILL_WEB_IMPORT}`);
		assert.ok(snapshot, `读不到工具面快照：${TOOLS_SNAPSHOT}`);

		// Host 侧**真实**注册的工具名（快照是权威来源）
		const hostTools = new Set(Array.from(snapshot.matchAll(/"name"\s*:\s*"([a-zA-Z_0-9-]+)"/g), m => m[1]));
		assert.ok(hostTools.has('browser'), `快照里应当有 browser（实际 ${hostTools.size} 个工具）`);

		// ⚠ 这些名字**只在 IDE 侧**注册（`agentStudio/browser/providers/tool/**`）⇒ Host-only 环境里不存在。
		//   这正是真机事故的**同构**问题：手册让人走 `web_extract` / `video_analyze`，而 Host 侧根本没这两个
		//   工具 ⇒ 模型照名字硬调 ⇒ 白失败一轮。所以技能**必须**显式声明它们"仅 IDE 侧"。
		// 2026-10-16（重构 4）：vision_analyze / video_analyze / extract_video_frames 已迁到 Host
		//   （`vssaros-media` 0.5.0，定义在插件、执行经桥回 IDE）⇒ 从 ideOnly 名单摘掉（守卫的注释
		//   自己写了"若真把它移到 Host 了，这条断言该跟着改" ✓）。
		const ideOnly = ['web_extract', 'web_search', 'execute_code'];
		for (const name of ideOnly) {
			assert.ok(!hostTools.has(name),
				`${name} 不该出现在 Host 工具面里（若真把它移到 Host 了，这条断言该跟着改）`);
			if (!skill.includes(name)) { continue; }   // 技能没提到它 ⇒ 不必声明
			assert.ok(skill.includes('仅 IDE 侧'),
				`技能提到了 ${name}（Host-only 下不存在）⇒ 必须显式声明"仅 IDE 侧"，否则模型会照名字硬调`);
		}

		// 总则必须在：不在列表里就当作不存在（按**实际**工具面选路）
		assert.ok(/不在你的列表里|当作不存在/.test(skill),
			'必须有"按实际工具面选路"的总则 —— 手册里点名的工具，不代表调用方手里就有');
		assert.ok(skill.includes('browser'), '总则里要专门交代 `browser`（它会动态消失）');
	});

	test('★★ 不可达文案**不许点名** IDE-only 工具（Host 侧没有它们 —— 点名就是让人白调）', async () => {
		const core = await load<IUnreachableCore>(CORE_UNREACHABLE);
		const msg = core.unreachableMessage('snapshot', { endpoint: 'http://127.0.0.1:9222', error: '连接被拒绝' });
		for (const name of ['web_extract', 'web_search', 'video_analyze', 'vision_analyze', 'execute_code']) {
			assert.ok(!msg.includes(name),
				`文案里点了 ${name}，但 Host 侧没有这个工具 ⇒ 模型照着调只会白失败一轮（本插件跑在 Host 侧）。`
				+ '要写"用你手上确实有的通道"，不要点名具体工具');
		}
		assert.ok(/确实有|你的工具列表/.test(msg), '要说清"用你手上确实有的通道"，而不是点名某个具体工具');
	});

	test('★★ 技能对 IDE-only 工具的**首次提及**必须就近声明（防"手册入口没交代"）', () => {
		const skill = readIf(SKILL_WEB_IMPORT) ?? '';
		// ⚠ **跳过 frontmatter**：`description` 是技能的**索引行**（给检索用的），不是手册正文。
		//   它点名工具无害（正文第 -1 步会交代）—— 但如果拿它当"首次提及"，断言就会指错地方
		//   （2026-10-13 实测：它抓到的是 description 行，而不是该负责的对照表行）。
		const fmEnd = skill.indexOf('---', skill.indexOf('---') + 3);
		const body = fmEnd >= 0 ? skill.slice(fmEnd) : skill;
		for (const name of ['web_extract', 'web_search', 'video_analyze']) {
			assert.ok(body.includes(name), `正文里应当提到 ${name}（第 -1 步的工具面对照表里就有）`);
			// ⚠ 用**同一行**判定，不用"附近 N 字符"：整张对照表都落在 N 字符内 ⇒ 一处漏标会被邻行掩护。
			const line = body.split('\n').find(l => l.includes(name)) ?? '';
			assert.ok(line.includes('仅 IDE 侧'),
				`正文里 ${name} 首次出现在这一行：「${line.slice(0, 90)}」—— 同一行必须标"仅 IDE 侧"，`
				+ ' 入口要让人一眼看出"这个工具我可能没有"');
		}
	});
});
