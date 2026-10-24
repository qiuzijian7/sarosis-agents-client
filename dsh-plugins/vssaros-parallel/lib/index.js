// @vssaros/dsh-parallel — 并行 TUI 工作台（页面 /x/parallel/ + 格位 API）
//
// ── 形态（稿 A 网格，已拍板）────────────────────────────────────────────────────
//   一屏 N 格，**每格一个独立的 dsh 进程**（社区 `@tomowang/dsh-tui`，自带 core、不连 Host）。
//   本插件在 Host 侧用 node-pty 起进程，把**原始 ANSI 字节流**经 SSE 推给页面，浏览器端 xterm 渲染
//   （颜色完整）。官方 `remote.terminal` 不用于此：它的下行是"纯文本屏幕快照"（无 ANSI 样式）⇒ 颜色会丢。
//
// ── 实测依据（doc/dsh-tui-ecosystem-research.md §7）──────────────────────────────
//   · 同 profile 多实例可并行；写锁是**会话目录级** ⇒ 不同格无冲突，同一会话只能一个写者；
//   · 每格内存 ≈ 71.6MB（带我们全套模块，空闲）⇒ 12 格 ≈ 0.86GB；
//   · ⚠ Windows ConPTY 下 `pty.pid` 为 **0** ⇒ 关格只走 `pty.kill()`，绝不按 pid 杀；
//   · 社区 TUI 要 dsh **0.2.1-rc.2**（`^0.2.1-rc.2`）⇒ 格子进程的 runtime 由 `config.tuiCommand` 指定。
//
// ── 路由 ─────────────────────────────────────────────────────────────────────
//   GET    /x/parallel/api/state                  格位列表 + PTY 探测结果
//   GET    /x/parallel/api/options                起格候选（工作区 = 与聊天框工作区 chip 同源 / preset）
//   POST   /x/parallel/api/cells                  起一格 {id?, title?, preset?, cols?, rows?, cwd?}
//   POST   /x/parallel/api/cells/<id>/input       键盘输入 {data}
//   POST   /x/parallel/api/cells/<id>/resize      {cols, rows}
//   DELETE /x/parallel/api/cells/<id>             关格
//   GET    /x/parallel/api/cells/<id>/stream      SSE：先回放 backlog，再增量
//
// ⚠ 只声明 `tools`：`webServer` / `connection` 只在 web 模板里存在，写进静态 inject 会让插件在
//   headless / tui profile 里**永久 pending**（照 dashboard / kanban 的写法收窄 ✓）。

// ⚠ 这里必须列全实际用到的函数：`existsSync` / `statSync` 曾漏在 import 之外，
//   而调用点全在 try/catch 里 ⇒ ReferenceError 被吞掉，会话目录回解**静默返回空**（守卫按源码字符串查不出来）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCellRegistry, probePty } from './cells.js';
import { resolveTuiRuntime } from './runtime.js';

export const name = 'vssaros-parallel';

export const inject = ['tools'];

/** 页面路由前缀（⚠ 必须与 package.json 的 `vssaros.view.route` 和宿主 `DSH_MODULE_PAGES` 一致）。 */
const ROUTE_PREFIX = '/x/parallel';

const HERE = dirname(fileURLToPath(import.meta.url));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param ctx - Host 侧 cordis 上下文。
 * @param {object} [config] 插件配置（见 cordis.patch.yml 的默认值）。
 */
export function apply(ctx, config) {
	const cfg = config || {};
	const maxCells = Number.isFinite(cfg.maxCells) ? cfg.maxCells : 12;
	const tuiCommand = String(cfg.tuiCommand || 'dsh');
	const tuiArgs = Array.isArray(cfg.tuiArgs) && cfg.tuiArgs.length ? cfg.tuiArgs.map(String) : ['--profile', 'tui'];
	const tuiHome = typeof cfg.tuiHome === 'string' && cfg.tuiHome ? cfg.tuiHome : '';
	const tuiCwd = typeof cfg.tuiCwd === 'string' && cfg.tuiCwd ? cfg.tuiCwd : '';

	/** 最近用过的 cwd（内存态，只用于给"新增格位"的候选，不落盘）。 */
	const recentCwds = [];

	/**
	 * 把 dsh 的会话目录名还原成真实路径。
	 *
	 * dsh 把会话按 cwd 分目录：`<DSH_HOME>/sessions/--G-SarosWorkspace-sarosis-agents-client--`。
	 * ⚠ 这个编码**有损**：`\` 和原文里的 `-` 都变成 `-` ⇒ 纯字符串反解必然出错
	 *   （`sarosis-agents-client` 会被解成 `sarosis\agents\client`）。
	 * ★ 所以这里**不猜**：把 `-` 的所有切分可能都试一遍，**只保留磁盘上真实存在的目录**。
	 *   实践中通常只有一种切分能命中 ⇒ 结果唯一；出现多解就全部返回（由调用方决定怎么显示，不挑一个冒充）。
	 *
	 * @param {string} name 会话目录名（形如 `--C-Users-me-proj--`）。
	 * @returns {string[]} 真实存在的目录（0 或 1 个最常见）。
	 */
	function decodeSessionDirName(name) {
		const s = String(name || '');
		if (s.length < 6 || !s.startsWith('--') || !s.endsWith('--')) { return []; }
		const core = s.slice(2, -2);            // G-SarosWorkspace-sarosis-agents-client
		const parts = core.split('-');
		if (parts.length < 2) { return []; }
		const drive = parts[0].toUpperCase();
		if (!/^[A-Z]$/.test(drive)) { return []; }
		const rest = parts.slice(1);
		// 组合数 = 2^(n-1)。路径段通常 < 10 ⇒ 可控；再多就放弃（不在候选列表里瞎猜）
		if (rest.length > 12) { return []; }
		const total = 1 << (rest.length - 1);
		const out = [];
		for (let mask = 0; mask < total; mask += 1) {
			let seg = rest[0];
			const segs = [];
			for (let i = 1; i < rest.length; i += 1) {
				if (mask & (1 << (i - 1))) { segs.push(seg); seg = rest[i]; }
				else { seg += '-' + rest[i]; }
			}
			segs.push(seg);
			const p = drive + ':\\' + segs.join('\\');
			try {
				if (existsSync(p) && statSync(p).isDirectory()) { out.push(p); }
			} catch { /* 权限/畸形路径 ⇒ 跳过 */ }
		}
		return out;
	}

	/**
	 * 从最近的会话目录里回解出工作区路径（按目录 mtime 取前 N 个，避免会话很多时全扫）。
	 * ⚠ 只有**唯一解**才收：多解说明编码有歧义，宁可不出候选，也不给一个可能错的路径。
	 */
	function recentSessionCwds(limit) {
		const home = tuiHome || String(process.env.DSH_HOME || '');
		if (!home) { return []; }
		const dir = join(home, 'sessions');
		let names = [];
		try { names = readdirSync(dir); } catch { return []; }
		const items = [];
		for (const n of names) {
			try { items.push({ n, t: statSync(join(dir, n)).mtimeMs }); } catch { /* 读不到就跳过 */ }
		}
		items.sort((a, b) => b.t - a.t);
		const out = [];
		const seen = new Set();
		for (const it of items.slice(0, Math.max(1, limit))) {
			const hits = decodeSessionDirName(it.n);
			if (hits.length !== 1 || seen.has(hits[0])) { continue; }
			seen.add(hits[0]);
			out.push(hits[0]);
		}
		return out;
	}

	/**
	 * IDE「工作区」栏的记录（多根）—— 从 `workspaces.json` 读。
	 *
	 * 位置：**dsh home 的上一级**（= VS Code 的 userData 根；dev 是 `~/.vssaros-dev`，
	 *   与 `AgentStudioService` 的 `workspaces.json` 同根）。Host 自带 `DSH_HOME`，不用另配路径。
	 * ⚠ 读不到（自定义 data 目录 / 老宿主 / 非 IDE 启动的 Host）⇒ `null`，调用方回落并如实说明。
	 */
	function readIdeWorkspaces() {
		const home = tuiHome || String(process.env.DSH_HOME || '');
		if (!home) { return null; }
		try {
			return groupIdeWorkspaces(JSON.parse(readFileSync(join(home, '..', 'workspaces.json'), 'utf8')));
		} catch { return null; }
	}

	/**
	 * 可选的工作区目录。
	 *
	 * ★ **第一优先级 = 聊天框上方那枚工作区 chip 的同一份清单**（用户 2026-10-23 要求
	 *   「新建格子的工作区与会话中工作区 chip 保持一致」）：
	 *   chip 读 dsh 客户端 `workspaces.list` 快照，而 Host 侧那棵树的根就是 `workspaceRegistry`
	 *   ⇒ 我们从 registry 取，顺序、显示名（`title → 路径末段 → id`）两边逐字一致 ✓。
	 * ⚠ 注册表不可用（headless / tui profile、老 Host）时才回落到"真跑过 dsh 的目录"
	 *   （config.tuiCwd / Host cwd / 最近起过的格 / 会话目录名回解），并由 `/api/options` 的
	 *   `workspaceSource` 如实告诉页面 —— 不假装两边一致。
	 */
	function listCwds() {
		const out = [];
		const seen = new Set();
		const push = (item) => {
			const path = String((item && item.path) || '').trim();
			const key = pathKey(path);
			if (!path || seen.has(key)) { return; }
			seen.add(key);
			out.push({ ...item, path, source: (item && item.source) || 'other' });
		};
		// ① ★ 与工作区 chip 同源：Host registry 的顺序与显示名
		for (const o of workspaceCwdOptions(pickWorkspaceItems(ctx))) { push(o); }
		// ② 兜底候选（pathKey 去重 ⇒ 已被工作区列过的目录不会重复出现）
		push({ path: tuiCwd, label: 'config.tuiCwd', source: 'config' });
		push({ path: process.cwd(), label: 'Host 的 cwd', source: 'host' });
		for (const p of recentCwds) { push({ path: p, label: '最近起过的格位用过的目录', source: 'recent' }); }
		// 从 dsh 的会话目录名**回解**出真实目录（见 decodeSessionDirName 的说明）——
		// 这一路是 registry 不可用时的替代品，不是真源。
		for (const p of recentSessionCwds(12)) { push({ path: p, label: '真跑过 dsh 的项目根', source: 'session' }); }
		return out;
	}

	/**
	 * 可选的 agent preset。
	 *
	 * ★ 来源两处（都是**磁盘上真实的定义**，不写死清单）：
	 *   ① 社区 TUI 自带：`<profile>/node_modules/@tomowang/dsh-tui/presets/*.patch.yml` ⇒ 文件名即 id；
	 *   ② 我们自己的：`<profile>/node_modules/@vssaros/dsh-agents/cordis.presets.yml` 里的 `id:` 行。
	 * ⚠ preset 只在**新会话**生效（`--agent-preset`，见 buildArgs 的注释）⇒ 换 preset 要重起格。
	 */
	function listPresets() {
		const home = tuiHome || String(process.env.DSH_HOME || '');
		return scanPresets(join(home, 'profiles', 'tui'));
	}

	/**
	 * 可选的 **Bot / Agent**（用户 2026-10-23 要求「缺少模型、bot 选择 UI」）。
	 *
	 * ★ 来源 = dsh 的 preset roster（`ctx.agentPresets.list()`）：在 dsh 内部 **agent 也是以
	 *   preset 存在的**（chat-surface 的「模式」chip 就是这么区分：白名单里的算模式，其余 roster 行是 Bot）。
	 *   ⇒ 起格时把 bot id 传给 `--agent-preset <id>`，TUI 就会挂载该 agent（= 用这个 bot 开会话）✓。
	 * ⚠ 运行时可选取（`ctx.get`）：headless / tui profile 里没有这个服务 ⇒ 返回 null，页面如实说明。
	 *
	 * @returns {Promise<{id: string, name: string, desc: string}[]|null>}
	 */
	async function listAgents() {
		let reg;
		try { reg = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined; } catch { return null; }
		if (!reg || typeof reg.list !== 'function') { return null; }
		let rows;
		try { rows = await reg.list(); } catch { return null; }
		if (!Array.isArray(rows)) { return null; }
		const out = [];
		const seen = new Set();
		for (const r of rows) {
			const id = String((r && r.id) || '').trim();
			// 模式已单独一栏；broken 的行选了也起不来 ⇒ 不列
			if (!id || seen.has(id) || (r && r.broken) || PRESET_MODE_IDS.indexOf(id) >= 0) { continue; }
			seen.add(id);
			out.push({ id, name: String((r && r.name) || id).trim(), desc: String((r && r.description) || '').trim() });
			if (out.length >= 100) { break; }
		}
		return out;
	}

	/** PTY 探测结果（懒加载一次；失败要如实报给页面，**不假装能起格**）。 */
	let ptyProbe = null;
	/** TUI 运行时探测结果（同样是懒加载一次）。 */
	let tuiInfo = null;
	let registry = null;
	let registryError = null;

	/**
	 * 探测 TUI 运行时（runtime 在哪、版本够不够、tui profile 有没有装社区 TUI）。
	 * ⚠ 起格**之前**就查清楚：否则现场只有 "spawn dsh ENOENT"，很难查（实机踩过）。
	 */
	const ensureTui = () => {
		if (tuiInfo) { return tuiInfo; }
		tuiInfo = resolveTuiRuntime({
			configured: tuiCommand,
			args: tuiArgs,
			dshHome: tuiHome || String(process.env.DSH_HOME || ''),
		});
		return tuiInfo;
	};

	/** 拿（或首次建）格位注册表。 */
	const ensureRegistry = async () => {
		if (registry) { return registry; }
		if (registryError) { return null; }
		const tui = ensureTui();
		if (!tui.ok) {
			registryError = 'TUI 运行时不可用：' + tui.problems.join('；');
			return null;
		}
		ptyProbe = ptyProbe || await probePty();
		if (!ptyProbe.ok) {
			registryError = 'PTY 不可用（node-pty 未解析到）：' + String(ptyProbe.error || '');
			return null;
		}
		registry = createCellRegistry({
			maxCells,
			// ⚠ node-pty 的签名是 spawn(file, args, options) —— 不是 spawn(options, ...)。
			spawnPty: (spec) => {
				// ★ 不给子进程继承宿主自用的变量（NODE_OPTIONS / NODE_CHANNEL_FD / VSCODE_* / ELECTRON_*）
				const env = childEnv(process.env, {
					TERM: 'xterm-256color',
					COLORTERM: 'truecolor',
					...(tuiHome ? { DSH_HOME: tuiHome } : {}),
				});
				// 诊断：把被剔掉的键名记一次（**只记名字不记值**，避免把 token 写进日志）
				try {
					const dropped = Object.keys(process.env).filter((k) => !(k in env));
					if (dropped.length) { console.error('[vssaros-parallel] spawn env pruned: ' + dropped.join(',')); }
				} catch { /* 诊断失败不影响起格 */ }
				const p = ptyProbe.spawn(
					// ⚠ 用探测结果（node + runtime 的 bin.js），不是裸 `dsh`（PATH 里常常没有）。
					spec.command || tui.command,
					// baseArgs 优先用调用方给的，否则用 config.tuiArgs；preset 由这里拼成 --agent-preset
					buildArgs(spec && spec.args ? spec.args : tui.args, spec && spec.preset),
					{
						name: 'xterm-256color',
						cols: spec.cols,
						rows: spec.rows,
						cwd: spec.cwd || tuiCwd || process.cwd(),
						env,
						...(process.platform === 'win32' ? { useConpty: true } : {}),
					},
				);
				/**
				 * ★ 诊断（2026-10-23 排"格子起来十几秒就 exit 1"）：
				 *   页面只能看到 PTY 的**原始输出**，Ink 一旦清屏，真正的错误就看不见了。
				 *   这里额外记录**退出码 + 退出前最后一段输出**到 Host 日志（`host-*.log`），
				 *   下次复现时能直接看到原因（这条是只读旁路，不影响 registry 自己的监听）。
				 */
				try {
					let tail = '';
					p.onData((d) => { tail = (tail + String(d)).slice(-1500); });
					p.onExit((e) => {
						const code = e && typeof e.exitCode === 'number' ? e.exitCode : null;
						// 只对非 0 退出叫（正常关格是 kill，不该刷日志）
						if (code !== null && code !== 0) {
							console.error('[vssaros-parallel] cell exited code=' + code
								+ ' cwd=' + (spec.cwd || tuiCwd || process.cwd())
								+ ' preset=' + (spec.preset || '(default)')
								+ '\n--- tail ---\n' + tail.replace(/[\u0000-\u0008\u000b-\u001f]/g, '') + '\n--- /tail ---');
						}
					});
				} catch { /* 诊断失败不影响起格 */ }
				return p;
			},
		});
		return registry;
	};

	ctx.effect(() => () => {
		// Host 卸载 ⇒ 关掉所有格子（否则会留下孤儿 dsh 进程并持有会话写租约）。
		try { if (registry) { registry.closeAll(); } } catch { /* 尽力而为 */ }
	});

	ctx.inject(['webServer', 'connection'], (page) => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('unauthorized');
				return;
			}
			const url = new URL(req.url || '/', 'http://127.0.0.1');
			const path = url.pathname.replace(/\/+$/, '');
			const method = String(req.method || 'GET').toUpperCase();
			try {
				// ── 页面 ──
				if (method === 'GET' && (path === ROUTE_PREFIX || path === ROUTE_PREFIX + '/index.html')) {
					send(res, 200, 'text/html; charset=utf-8', renderPage(cfg));
					return;
				}
				// ── 客户端脚本（独立文件：模板串里写 JS 会被反引号提前闭合）──
				if (method === 'GET' && path === ROUTE_PREFIX + '/client.js') {
					send(res, 200, 'text/javascript; charset=utf-8', readClientFile('pageClient.js', '/* client script missing */'));
					return;
				}
				// ── 页面样式（★ 独立文件：调样式只要刷新页面，不用重启 Host）──
				if (method === 'GET' && path === ROUTE_PREFIX + '/page.css') {
					send(res, 200, 'text/css; charset=utf-8', readClientFile('page.css', '/* page.css missing */'));
					return;
				}
				// ── vendored 浏览器依赖（xterm.js + addon-fit；MIT，LICENSE 随包）──
				//    ⚠ 白名单比"目录遍历"安全：只认这几个确切文件名。
				const vendorHit = path.match(new RegExp('^' + ROUTE_PREFIX.replace(/\//g, '\\/') + '/vendor/(xterm\\.js|xterm\\.css|addon-fit\\.js)$'));
				if (vendorHit && method === 'GET') {
					const fileName = vendorHit[1];
					const isCss = fileName.endsWith('.css');
					try {
						const body = readFileSync(join(HERE, '..', 'vendor', fileName), 'utf8');
						res.writeHead(200, {
							'content-type': isCss ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
							// 静态 vendor：可以缓存，但别 immutable（换版本要能刷到）
							'cache-control': 'public, max-age=3600',
						});
						res.end(body);
					} catch (e) {
						send(res, 404, 'text/plain; charset=utf-8', 'vendor 文件读不到：' + fileName + '（' + String((e && e.message) || e) + '）');
					}
					return;
				}
				// ── API ──
				if (path === ROUTE_PREFIX + '/api/state' && method === 'GET') {
					const reg = await ensureRegistry();
					sendJson(res, 200, {
						ok: !!reg,
						error: reg ? undefined : registryError,
						pty: ptyProbe ? { ok: ptyProbe.ok, via: ptyProbe.via, error: ptyProbe.error } : null,
						maxCells,
						// 探测结论（runtime 版本 / 是否满足 peer / tui profile 状态 / 待解决的问题）
						// 与用户显式配置分开给，页面上能一眼看出"实际用的是哪个、还差什么"。
						tui: { ...ensureTui(), configured: { command: tuiCommand, args: tuiArgs, home: tuiHome || '(继承 Host)' } },
						cells: reg ? reg.list() : [],
					});
					return;
				}
				// ── 起格时可选的候选（工作区 / preset）──
				if (path === ROUTE_PREFIX + '/api/options' && method === 'GET') {
					const groups = readIdeWorkspaces();
					const cwds = listCwds();
					const agents = await listAgents();
					const presetMenu = presetMenuItems(listPresets());
					sendJson(res, 200, {
						ok: true,
						// ★ IDE「工作区」栏的记录（多根）：左侧栏那行「VsSaros_S1Game（2 个根）」就是它，
						//   页面有它就按"工作区 + 各根"分组展示（用户 2026-10-23 要求与工作区栏一致）。
						workspaces: groups,
						cwds,
						// 'ide' = 与左侧工作区栏同一份记录（多根）；
						// 'workspace' = 只有 dsh 已登记的单目录工作区；'fallback' = 连注册表都没有 ⇒ 兜底目录
						workspaceSource: groups ? 'ide' : (cwds.some((c) => c.source === 'workspace') ? 'workspace' : 'fallback'),
						// ★ 与 chat-surface 的「模式」chip 同一份菜单（白名单 + 分组 + 文案，见 presetMenuItems）
						presets: presetMenu,
						// ★ Bot / Agent（roster 里除模式以外的行）；null = 这个 Host 没有 agentPresets 服务
						agents,
						defaults: {
							// 默认 = 第一个工作区的主根（= 左侧工作区栏第一行的主目录）
							cwd: (groups && groups[0] && groups[0].roots[0] && groups[0].roots[0].path)
								|| (cwds[0] && cwds[0].path) || tuiCwd || process.cwd(),
							// ★ 模式默认选「标准模式（VsSaros）」—— 用户 2026-10-23 明确要求；
							//   与 tui profile 的部署默认一致（dev/prod 的 `default: vssaros-standard`），
							//   ⇒ 表单里显示的就是真正会生效的那个，不是"（不指定）"。
							preset: (presetMenu.filter((x) => x.id === 'vssaros-standard')[0]
								|| presetMenu[0] || { id: '' }).id,
						},
					});
					return;
				}
				if (path === ROUTE_PREFIX + '/api/cells' && method === 'POST') {
					const reg = await ensureRegistry();
					if (!reg) { sendJson(res, 503, { ok: false, error: registryError }); return; }
					const body = await readJson(req);
					const created = reg.create({
						id: (body && body.id) || nextId(reg),
						title: body && body.title,
						preset: body && body.preset,
						cols: body && body.cols,
						rows: body && body.rows,
						cwd: (body && body.cwd) || tuiCwd,
					});
					// 记下这次用的目录，下次「新增格位」能当候选（诚实：只记真起过的）
					if (created.ok && created.cell && created.cell.cwd && recentCwds.indexOf(created.cell.cwd) < 0) {
						recentCwds.unshift(created.cell.cwd);
						if (recentCwds.length > 8) { recentCwds.length = 8; }
					}
					sendJson(res, created.ok ? 200 : 400, created);
					return;
				}
				const cellAction = path.match(new RegExp('^' + ROUTE_PREFIX.replace(/\//g, '\\/') + '/api/cells/([^/]+)/(input|resize|stream)$'));
				if (cellAction) {
					const id = decodeURIComponent(cellAction[1]);
					const action = cellAction[2];
					const reg = await ensureRegistry();
					if (!reg) { sendJson(res, 503, { ok: false, error: registryError }); return; }
					if (action === 'stream' && method === 'GET') {
						streamCell(req, res, reg, id);
						return;
					}
					if (action === 'input' && method === 'POST') {
						const body = await readJson(req);
						sendJson(res, 200, reg.write(id, (body && body.data) || ''));
						return;
					}
					if (action === 'resize' && method === 'POST') {
						const body = await readJson(req);
						sendJson(res, 200, reg.resize(id, body && body.cols, body && body.rows));
						return;
					}
				}
				const one = path.match(new RegExp('^' + ROUTE_PREFIX.replace(/\//g, '\\/') + '/api/cells/([^/]+)$'));
				if (one && method === 'DELETE') {
					const reg = await ensureRegistry();
					if (!reg) { sendJson(res, 503, { ok: false, error: registryError }); return; }
					sendJson(res, 200, reg.close(decodeURIComponent(one[1])));
					return;
				}
				sendJson(res, 404, { ok: false, error: '未知路由：' + method + ' ' + path });
			} catch (e) {
				sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
			}
		},
	})));

	/**
	 * 拼格位进程的启动参数。
	 *
	 * ★ preset 生效方式：TUI 只认 `--agent-preset <id>`，且**只对"新会话"有效**
	 *   （`--resume` 时它按落盘 header 里记的 preset 走，命令行会被忽略 —— 源码 `lib/index.js:807-847`）。
	 *   ⇒ 换 preset 必须**重起格**（不带 --resume），页面上要说清这一点。
	 * ⚠ 工作区（cwd）不是参数，而是 node-pty 的 spawn 选项 ⇒ 同样只能开进程时定。
	 */
	/** 仅测试用（不碰网络、不碰 PTY）：路由前缀与 id 生成。 */
	export_test({
		ROUTE_PREFIX,
		nextId,
		renderPage,
	});
}

function export_test(obj) {
	testHooks = obj;
}
let testHooks = null;

/**
 * 拼格位进程的启动参数（纯函数 ⇒ 可单测）。
 *
 * ★ preset 的生效方式：TUI 只认 `--agent-preset <id>`，而且**只对"新会话"有效**
 *   （带 `--resume` 时它按落盘 header 里记的 preset 走，命令行被忽略 —— 源码 `lib/index.js:807-847`）
 *   ⇒ 换 preset 必须**重起格**，页面上要说清这一点。
 * ⚠ 工作区（cwd）不是命令行参数，而是 node-pty 的 spawn 选项 ⇒ 同样只能在开进程时定。
 *
 * @param {string[]} baseArgs 基础参数（一般是 `['--profile','tui']`）。
 * @param {string} [preset] preset id；空则不加参数。
 * @returns {string[]} 新数组（不改入参）。
 */
export function buildArgs(baseArgs, preset) {
	const argv = (Array.isArray(baseArgs) ? baseArgs : []).slice();
	const id = String(preset || '').trim();
	// 调用方已经写了 --agent-preset 就不重复追加（否则 TUI 会取到两个值）
	if (id && argv.indexOf('--agent-preset') < 0) {
		argv.push('--agent-preset', id);
	}
	return argv;
}

/** 取路径末段（`C:\a\b` 与 `/a/b` 都认）；空串/非串返回空。与会话 chip 的 `baseName` 同口径。 */
function baseName(p) {
	const s = String(p || '').trim();
	if (!s) { return ''; }
	const parts = s.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
	return parts[parts.length - 1] || '';
}

/**
 * 路径去重键：Windows 大小写不敏感、`\` 与 `/` 等价、忽略尾斜杠。
 * （同一目录常有两种写法：registry 里是 `fs.realpath` 结果，配置/最近用过的是原样字符串）
 */
function pathKey(p) {
	const s = String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
	return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * 从 Host 上下文里取工作区注册表条目（`ctx.workspaceRegistry.list()`）。
 *
 * ★ 为什么要走注册表：聊天框那枚工作区 chip 读的是 dsh 客户端 `workspaces.list` 快照，
 *   而它正是这颗 Host registry 的投影 ⇒ 只有从同一个源取，新建格子的工作区下拉
 *   才可能在**顺序、显示名**上与 chip 逐字一致。
 * ⚠ 一律 `ctx.get` 运行时可选取，**不写进静态 `inject`**：headless / tui profile 里没有
 *   这个服务，静态 inject 会让整个插件永久 pending（比少一项候选糟得多）。
 *
 * @param {object} ctx - Host cordis 上下文。
 * @returns {object[]|null} registry 条目；服务不可用/读失败 ⇒ `null`（调用方据此回落并如实说明）。
 */
export function pickWorkspaceItems(ctx) {
	try {
		const reg = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
		if (!reg || typeof reg.list !== 'function') { return null; }
		const items = reg.list();
		return Array.isArray(items) ? items : null;
	} catch { return null; }
}

/**
 * 工作区条目 ⇒ 起格表单的 cwd 候选（纯函数 ⇒ 守卫直接断言，不碰 ctx / 网络）。
 *
 * 显示名走 `title → 路径末段 → id`，与聊天框 chip 的 `workspaceLabel` **同一个口径**
 * （见 `vssaros-chat-surface/lib/client.workspace.js`）⇒ 同一个工作区在两边叫同一个名字。
 *
 * @param {object[]|null} items - registry 条目（`{id, path, title, sessionIds}`）。
 * @returns {{path: string, label: string, source: string, workspaceId: string, sessions: number}[]}
 */
export function workspaceCwdOptions(items) {
	const out = [];
	for (const w of Array.isArray(items) ? items : []) {
		const path = String((w && w.path) || '').trim();
		// 没有路径的条目对"起格的 cwd"没有意义（registry 理论上不会给，防脏数据）
		if (!path) { continue; }
		const title = String((w && w.title) || '').trim();
		out.push({
			path,
			label: title || baseName(path) || String((w && w.id) || ''),
			source: 'workspace',
			workspaceId: String((w && w.id) || ''),
			sessions: Array.isArray(w && w.sessionIds) ? w.sessionIds.length : 0,
		});
	}
	return out;
}

/**
 * IDE「工作区」栏的记录（多根）⇒ 起格表单的分组候选（纯函数）。
 *
 * 真源是 VS Code 的 `workspaces.json`（`AgentStudioService` 的同名存储）：一条记录 =
 * **一个工作区**，`path` 是主根、`relatedFolders` 是其余根 ⇒ 左侧栏显示的「VsSaros_S1Game（2 个根）」
 * 就是它。会话里那枚 chip 也靠它把 dsh 摊平的条目重新合成一组（见宿主的 `DSH_PAGE_IPC_WORKSPACES`）。
 * ⚠ 与 registry 的差别：registry 是**单目录**、且由宿主把各根摊平成 N 条 ⇒ 只看 registry
 *   永远得不到"同一个工作区的两个根"这层关系（用户截图里 `S1Game`/`UE5EA` 各出现两次的根因）。
 *
 * @param {object[]|null} list - `workspaces.json` 的数组（`{id,name,path,relatedFolders,codeWorkspacePath}`）。
 * @returns {{id: string, name: string, roots: {path: string, name: string, isPrimary: boolean}[], codeWorkspacePath?: string}[]|null}
 *          没有任何可用记录 ⇒ `null`（调用方据此回落，不假装有工作区）。
 */
export function groupIdeWorkspaces(list) {
	const out = [];
	for (const w of Array.isArray(list) ? list : []) {
		if (!w || typeof w !== 'object') { continue; }
		const name = String(w.name || '').trim();
		const primary = String(w.path || '').trim();
		// 名称或主根缺失 ⇒ 整条丢掉（不猜、不补假根）
		if (!name || !primary) { continue; }
		const roots = [{ path: primary, name: baseName(primary) || name, isPrimary: true }];
		const seen = new Set([pathKey(primary)]);
		for (const r of Array.isArray(w.relatedFolders) ? w.relatedFolders : []) {
			const path = String((r && r.path) || '').trim();
			const key = pathKey(path);
			if (!path || seen.has(key)) { continue; }
			seen.add(key);
			roots.push({ path, name: String((r && r.name) || '').trim() || baseName(path), isPrimary: false });
		}
		// 上限与宿主协议一致（30 个工作区 / 每组 16 根）—— 推送面是外部输入，不无限收
		if (roots.length > 16) { roots.length = 16; }
		const cw = String(w.codeWorkspacePath || '').trim();
		out.push({ id: String(w.id || ''), name, roots, ...(cw ? { codeWorkspacePath: cw } : {}) });
		if (out.length >= 30) { break; }
	}
	return out.length ? out : null;
}

/**
 * preset 菜单 = 与 chat-surface 的「模式」chip **同一口径**（用户 2026-10-23 要求：
 * 「preset 要求显示内容和 chat-surface 中的 preset chip 显示内容一致，并且 UI 风格要求统一」）。
 *
 * 白名单只有 4 个（2026-10-21 用户拍板）：
 *   · `vssaros-standard` / `vssaros-ptc` —— 我们的两个档（官方模式副本 + 我们的模块/工具面）；
 *   · `minimal` / `cordis` —— dsh 原生的极简 / 创造模式。
 * ⚠ 官方的 `standard` / `ptc` **故意不列**：它们与我们两个档是同一件事的两种版本，并列只会分不清；
 *   `vssaros-full` **已退役**（与标准模式只差 denyTools 清单，改由运行期开关承担）。
 * ★ 这份白名单与文案由守卫 `check-parallel-cells.mjs` 与 `vssaros-chat-surface/lib/client.preset.js`
 *   **逐字比对** ⇒ 两边任何一处漂移都会红（文案是"用户可见"的东西，最容易在两边各改一半）。
 */
export const PRESET_MODE_IDS = ['vssaros-standard', 'vssaros-ptc', 'minimal', 'cordis'];
/** 分组（顺序 = 菜单里的顺序；组标题与 chip 的菜单组标题一致）。 */
export const PRESET_GROUPS = [
	{ key: 'vssaros', title: 'VsSaros 模式（工具面已收敛 + 上下文压缩）', ids: ['vssaros-standard', 'vssaros-ptc'] },
	{ key: 'dsh', title: 'dsh 原生（工具全开、无额外压缩）', ids: ['minimal', 'cordis'] },
];
/**
 * dsh 原生 2 个模式的本地化名 + 一句说明。
 * ⚠ 这两个在 roster 里**没有描述**（官方本地化文案在 `dsh-client-ui-agent-preset` 包内部，拿不到）
 *   ⇒ chip 那边也是一份硬编码（`client.preset.js` 的 `BUILTIN_MODE_COPY`）：两边必须逐字相同。
 */
export const BUILTIN_MODE_COPY = {
	minimal: { name: '极简模式', desc: '只留终端与图片读取（知识库 / 记忆 / 看板等模块照常可用），适合测试与基线对比。' },
	cordis: { name: '创造模式', desc: '用对话定制 DSH —— 让 Agent 写插件、加功能；我们的知识库 / 记忆 / 看板等模块同样可用。' },
};

/**
 * 磁盘扫到的 preset 原始列表 ⇒ 菜单项（过滤 + 固定顺序 + 文案），纯函数 ⇒ 守卫直接断言。
 *
 * @param {Array<{id: string, name?: string, description?: string}>|null} presets
 * @returns {{id: string, name: string, desc: string, group: string, groupTitle: string}[]}
 */
export function scanPresets(profileDir) {
	const out = [];
	const seen = new Set();
	const add = (id, from, name, description) => {
		const v = String(id || '').trim();
		if (!v || seen.has(v)) { return; }
		seen.add(v);
		// name / description 是 preset 定义里的显示名与说明（例如「标准模式（VsSaros）」）⇒ 页面直接用它，
		// 这样菜单里看到的叫法**和会话里的模式菜单一致**，不用前端再硬编码一张映射表。
		out.push({ id: v, from, name: String(name || '').trim(), description: String(description || '').trim() });
	};
	const dir = String(profileDir || '').trim();
	if (!dir) { return out; }
	try {
		for (const f of readdirSync(join(dir, 'node_modules', '@tomowang', 'dsh-tui', 'presets'))) {
			const m = /^(.+)\.patch\.yml$/.exec(f);
			if (m) { add(m[1], 'tomowang'); }
		}
	} catch { /* 没装或结构不同 ⇒ 空着，让用户手输 */ }
	try {
		const text = readFileSync(join(dir, 'node_modules', '@vssaros', 'dsh-agents', 'cordis.presets.yml'), 'utf8');
		// ⚠ 必须限定**正好 8 格缩进**：那一层才是 preset 的 id/name/description。
		//   更深的 10 格缩进是**插件** id（tool-bash / vssaros-kanban …）⇒ 全抓进来会把菜单灌成几十项垃圾，
		//   而且选了一个不存在的"preset"会让 TUI 起不来（或起在错的组合上）。
		const found = [];
		let cur = null;
		for (const line of text.split(/\r?\n/)) {
			const mId = /^ {8}id:\s*['"]?([A-Za-z0-9._-]+)/.exec(line);
			if (mId) {
				cur = { id: mId[1], name: '', description: '' };
				found.push(cur);
				continue;
			}
			const mName = /^ {8}name:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
			if (mName && cur && !cur.name) { cur.name = mName[1].trim(); }
			// description 是同一层的一句说明（chip 的菜单第二行就是它）
			const mDesc = /^ {8}description:\s*"?([^"\n]*)"?\s*$/.exec(line);
			if (mDesc && cur && !cur.description) { cur.description = mDesc[1].trim(); }
		}
		for (const p of found) { add(p.id, 'vssaros', p.name, p.description); }
	} catch { /* 没装就只给社区那四个 */ }
	return out;
}

export function presetMenuItems(presets) {
	const rows = Array.isArray(presets) ? presets : [];
	const find = (id) => rows.filter((p) => p && String(p.id) === id)[0];
	const out = [];
	for (const g of PRESET_GROUPS) {
		for (const id of g.ids) {
			const row = find(id);
			// 磁盘上没有这个 preset（profile 没装 / 版本不同）⇒ 不列；编一个出来只会让起格失败
			if (!row) { continue; }
			const copy = BUILTIN_MODE_COPY[id];
			out.push({
				id,
				name: copy ? copy.name : (String(row.name || '').trim() || id),
				desc: copy ? copy.desc : String(row.description || '').trim(),
				group: g.key,
				groupTitle: g.title,
			});
		}
	}
	return out;
}

/** 明确要剔掉的宿主变量（其余靠前缀规则）。 */
export const HOST_ENV_DROP = [
	'NODE_OPTIONS',
	'NODE_CHANNEL_FD',
	'NODE_CHANNEL_SERIALIZATION_MODE',
	'ELECTRON_RUN_AS_NODE',
	'ELECTRON_NO_ATTACH_CONSOLE',
];

/**
 * 起格子进程（TUI）的环境变量：继承 Host 的，但**剔掉宿主注入给 Host 自己的东西**。
 *
 * ★ 为什么必须剔（2026-10-23 排「格子起来十几秒就 exit 1」）：
 *   ① `NODE_OPTIONS`：IDE 会给 Host 注入 `--import <hostPreload>`（诊断 preload，
 *      见 `dshHostSupervisor.ts:849`）⇒ 原样传给 TUI 等于让一个普通 node 进程去加载
 *      宿主的 preload（dsh 自己的启动器也是先 `delete env.NODE_OPTIONS`，
 *      见 `dshRuntimeManager.ts:102`）。
 *   ② `NODE_CHANNEL_FD` / `NODE_CHANNEL_SERIALIZATION_MODE`：Electron 的 IPC 通道 fd
 *      被继承后，子 node 进程会尝试接管一个**属于别人**的管道。
 *   ③ `ELECTRON_*` / `VSCODE_*`：宿主与扩展自用，TUI 一个也用不到。
 *
 * @param {Record<string, string|undefined>} base - 一般是 `process.env`。
 * @param {Record<string, string>} [extra] - 本插件要设的（TERM / DSH_HOME…），最后覆盖。
 * @returns {Record<string, string|undefined>} 新对象（不改入参）。
 */
export function childEnv(base, extra) {
	const out = {};
	const src = base || {};
	for (const k of Object.keys(src)) {
		if (HOST_ENV_DROP.indexOf(k) >= 0) { continue; }
		if (k.indexOf('VSCODE_') === 0 || k.indexOf('ELECTRON_') === 0) { continue; }
		out[k] = src[k];
	}
	const add = extra || {};
	for (const k of Object.keys(add)) { out[k] = add[k]; }
	return out;
}

/** 自动编号：A1、A2…（用户可自己给 id）。 */
function nextId(reg) {
	const used = new Set((reg ? reg.list() : []).map((c) => String(c.id)));
	const letters = 'ABCDEFGHIJKL';
	for (let i = 0; i < letters.length; i += 1) {
		for (let n = 1; n <= 9; n += 1) {
			const id = letters[i] + n;
			if (!used.has(id)) { return id; }
		}
	}
	return 'X' + (used.size + 1);
}

function send(res, status, contentType, body) {
	res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
	res.end(body);
}
function sendJson(res, status, value) {
	send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}
function readJson(req) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on('data', (c) => {
			size += c.length;
			if (size > 1024 * 1024) { req.destroy(); resolve(null); return; }
			chunks.push(c);
		});
		req.on('end', () => {
			try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); }
		});
		req.on('error', () => resolve(null));
	});
}

/** 一格的 SSE 流：先回放 backlog（刷新页面能看到历史），再推增量。 */
function streamCell(req, res, reg, id) {
	const sub = reg.subscribe(id, (event) => {
		if (event.type === 'data') { writeEvent(res, 'data', { seq: event.seq, data: event.data }); }
		else if (event.type === 'state') { writeEvent(res, 'state', { state: event.state, exitCode: event.exitCode }); }
	});
	if (!sub) { sendJson(res, 404, { ok: false, error: '格位不存在：' + id }); return; }
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-store',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
	});
	// 首帧带上回放（客户端先铺满屏，再接增量）
	writeEvent(res, 'replay', { data: sub.backlog });
	writeEvent(res, 'ready', { id });
	const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch { /* 已断开 */ } }, 15000);
	const cleanup = () => {
		clearInterval(beat);
		try { sub.unsubscribe(); } catch { /* 已释放 */ }
		try { res.end(); } catch { /* 已关闭 */ }
	};
	req.on('close', cleanup);
	req.on('error', cleanup);
	res.on('error', cleanup);
}

function writeEvent(res, name, payload) {
	try { res.write('event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n'); } catch { /* 已断开 */ }
}

/**
 * 读页面静态资源（脚本 / 样式）。**每次请求都读磁盘** ⇒ 改样式或客户端脚本只要刷新页面即可生效，
 * 不必重启 Host（Host 只在启动时 import 本模块的代码）。
 *
 * @param {string} fileName `pageClient.js` / `page.css`。
 * @param {string} fallback 读不到时的占位内容前缀（保证响应仍然是合法 JS/CSS，不炸页面）。
 */
function readClientFile(fileName, fallback) {
	try {
		return readFileSync(join(HERE, fileName), 'utf8');
	} catch (e) {
		return (fallback || '/* missing */') + ' /* ' + fileName + ': ' + String((e && e.message) || e) + ' */';
	}
}

function renderPage(cfg) {
	return [
		'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		'<title>并行 TUI 工作台 · VsSaros</title>',
		// vendored xterm（MIT）—— 顺序：xterm.js 先，addon-fit 次（它挂 window.FitAddon）
		'<link rel="stylesheet" href="' + ROUTE_PREFIX + '/vendor/xterm.css">',
		// ★ 页面样式走**独立文件**：改样式只要刷新，不用重启 Host（Host 只在启动时 import 本模块）
		'<link rel="stylesheet" href="' + ROUTE_PREFIX + '/page.css">',
		'<script src="' + ROUTE_PREFIX + '/vendor/xterm.js"></script>',
		'<script src="' + ROUTE_PREFIX + '/vendor/addon-fit.js"></script>',
		'</head><body>',
		'<div class="wrap" data-vssaros-page="parallel">',

		'<div class="bar"><h1>并行 TUI 工作台</h1>',
		'<span class="pill" id="pty-pill" data-pty="unknown">PTY 检测中…</span>',
		'<span class="pill" id="tui-pill" data-tui="unknown" title="">TUI 运行时检测中…</span>',
		'<span class="pill" id="count-pill">— 格</span>',
		'<span class="sp"></span>',
		// 列数：auto 模式按「每格最小可读宽度」换行，不会把格子压扁。
		'<span class="seg" id="cols-seg" role="group" aria-label="每行列数">',
		'<button type="button" data-cols="auto" aria-pressed="true">自动</button>',
		'<button type="button" data-cols="1" aria-pressed="false">1 列</button>',
		'<button type="button" data-cols="2" aria-pressed="false">2 列</button>',
		'<button type="button" data-cols="3" aria-pressed="false">3 列</button>',
		'</span>',
		'<button class="btn primary" id="add-btn">＋ 新增格位</button>',
		'<button class="btn" id="close-all-btn">关闭全部</button></div>',

		'<p class="banner" id="banner">每格是一个<b>独立的 dsh 进程</b>（社区 TUI），原始 ANSI 流经 SSE 推到本页；',
		'关格只走 PTY 句柄（Windows ConPTY 下 pid 恒为 0，按 pid 杀既杀不到也可能误杀）。</p>',

		'<div class="grid" id="grid" data-cols="auto"></div>',

		'<p class="foot">格太窄看不清时点格头的 <b>⤢</b> 放大（TUI 会重排到宽屏列数）；Esc 退出放大。',
		'实测：N 格 = N 个独立 dsh 进程、同 profile 可并行、写锁是会话级，每格 ≈ 71.6MB（空闲）。</p>',
		'</div>',
		// ⚠ 必须拼成一个字符串：数组元素会被 join('\n') 插换行 ⇒ URL 里混进换行 ⇒ 脚本 404。
		'<script src="' + ROUTE_PREFIX + '/client.js"></script>',
		'</body></html>',
	].join('\n');
}

export const __test = {
	get ROUTE_PREFIX() { return ROUTE_PREFIX; },
	get renderPage() { return renderPage; },
	get nextId() { return nextId; },
	get buildArgs() { return buildArgs; },
	// 工作区候选是否与聊天框那枚 chip 同源同口径（2026-10-23）
	get workspaceCwdOptions() { return workspaceCwdOptions; },
	get pickWorkspaceItems() { return pickWorkspaceItems; },
	// preset 菜单是否与 chat-surface 的「模式」chip 同口径（2026-10-23）
	get presetMenuItems() { return presetMenuItems; },
	get scanPresets() { return scanPresets; },
	get PRESET_GROUPS() { return PRESET_GROUPS; },
	get BUILTIN_MODE_COPY() { return BUILTIN_MODE_COPY; },
	get PRESET_MODE_IDS() { return PRESET_MODE_IDS; },
	// IDE 工作区记录（多根）→ 起格表单的分组候选（2026-10-23）
	get groupIdeWorkspaces() { return groupIdeWorkspaces; },
	// 子进程环境清理（宿主注入的 NODE_OPTIONS / VSCODE_* 等不能带给 TUI）
	get childEnv() { return childEnv; },
	get HOST_ENV_DROP() { return HOST_ENV_DROP; },
	get hooks() { return testHooks; },
};
