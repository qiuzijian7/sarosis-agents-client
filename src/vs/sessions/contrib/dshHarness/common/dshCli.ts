/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * dsh CLI 契约（依赖面 L0）的纯函数部分：参数拼装、启动输出解析、运行时指针与版本选择。
 * 不含 I/O，便于单测；每一条规则都对应 P0 实测结论（poc/dsh-p0/README.md 第 3 节）。
 */

/**
 * 拉起 Host 的参数。P0-1：`--patch` 等**启动器**参数必须写在 `--no-open` / `--port` 等**应用**
 * 参数之前，否则启动器把它当作应用参数并报 `unknown option`。
 *
 * @param port 监听端口。**缺省 0 = 由 OS 分配**（历史行为，逐字不变 ✓）。
 *
 * ⚠ 为什么调用方**应该**传一个稳定值（2026-10-14，缓存命中率实测根因）：
 * dsh 把 `http://127.0.0.1:<port>` 写进**每一条 system 提示**，而 `--port 0` 每次分配到的
 * 端口都不同 ⇒ 每次 Host 重启后 system 提示的字节都变 ⇒ provider 的 **prompt 前缀缓存
 * 整段失效**。真机实证：同一会话 6 次请求的 system 提示 302 行里 299 行逐字相同，
 * **唯一差异就是那一行的端口**，累计缓存命中率仅 6.4%（详见 `dshHostPortPreference.ts`）。
 *
 * 端口由**启动器**（supervisor）决定并复用，见 `dshHostSupervisor` 的偏好读写；
 * 本函数保持纯函数（不做 I/O、不探测占用），只负责拼装。
 */
export function buildHostArgs(bin: string, profile: string, overlays: readonly string[], port: number = 0): string[] {
	const launcher = ['--profile', profile];
	for (const overlay of overlays) {
		launcher.push('--patch', overlay);
	}
	return [bin, ...launcher, '--no-open', '--port', String(port)];
}

/** 从 web 模板初始化 profile（只在 profile 不存在时调用：对已存在的 profile 带此参数会报错）。 */
export function buildProfileInitArgs(bin: string, profile: string): string[] {
	return [bin, '--profile', profile, '--from-default-profile', 'web', '--help'];
}

/** `dsh plugin --profile <p> add <spec>`：dsh 会自动把包追加到 `dsh.profile.bundles`（不重复）。 */
export function buildPluginAddArgs(bin: string, profile: string, spec: string): string[] {
	return buildPluginAddArgsMany(bin, profile, [spec]);
}

/**
 * `dsh plugin --profile <p> add <spec> [<spec>…]`：**一次装多个**（2026-10-13 首启提速）。
 *
 * 为什么可以：dsh 只解析它**自有**的子命令（`allow-version` 等），**其余参数原样转交 pnpm**
 * （运行时源码注释原文：「Parse only DSH-owned commands; all other arguments remain pnpm's
 * responsibility」—— `@deepseek-ai/dsh/lib/plugin-BGnVfe_D.js`），而 pnpm 的 `add` 接受多包 ✓。
 *
 * 为什么要：串行装 = 每个变更插件一个 pnpm 进程。实测单次 2–5 s（node 冷启动 + 解析 + 落盘），
 * 首启改了 6 个插件就要 15–17 s 才轮到起 Host ✗（用户报"首次启动很慢：安装伴生插件→启动 host→
 * 加载工作区"）。实测时间线（2026-10-13 dev 实例 main.log）：
 *   `T+1s 安装 1/19` → `T+18s 安装 19/19`（其中 6 次真装各 2–5 s）→ `T+18s 起 Host` → `T+24s 工作区`
 * ⇒ 首启 24 s 里 **17 s 全在串行装插件**，起 Host 只占 6 s、工作区 0.3 s。收敛成一条命令后，
 * N 次进程/解析开销变 1 次 ✓。
 *
 * ⚠ 调用方必须保留**逐项复核 + 失败回退单装**：万一将来 dsh 改窄了参数（不再透传多 spec），
 * 批量那条会装不上，回退路径保证行为与旧版一致（最坏只是回到从前的速度）✓。
 */
export function buildPluginAddArgsMany(bin: string, profile: string, specs: readonly string[]): string[] {
	return [bin, 'plugin', '--profile', profile, 'add', ...specs];
}

/**
 * 本地目录 → pnpm 的 `file:` spec。必须用正斜杠：`file:G:\x\y` 会被 pnpm 当作相对 profile 目录的路径
 * （实测 ENOENT `profiles\vssaros\G:\x\y`），`file:G:/x/y` 才是绝对路径。
 */
export function toFileSpec(dir: string): string {
	return `file:${dir.replace(/\\/g, '/')}`;
}

/** `file:` 前缀 → 本地路径（覆盖 `file:G:/x`、`file:///G:/x`、`file:/abs`）。 */
function stripFileScheme(spec: string): string {
	const m = /^file:(.*)$/i.exec(spec);
	if (!m) {
		return spec;
	}
	const body = m[1].replace(/^\/+/, '');
	if (/^[A-Za-z]:/.test(body)) {
		return body;                             // file:///G:/x → G:/x
	}
	if (/^\.\.?([\\/]|$)/.test(body)) {
		return body;                             // file:./rel → ./rel（刻意保持相对：下面会被判"非绝对"）
	}
	return `/${body}`;                           // file:///home/a → /home/a
}

/**
 * 把一个 spec 归一成**本地绝对目录**；不是本地路径就返回 `undefined`。
 *
 * 为什么需要这条判定：「添加插件」里用户粘的可能是注册表名 / git / tarball，也可能是本机某个目录。
 * **本地目录**这一类不该走 Host 内的 `pluginManager`（实测：全新 profile 上那次安装会把未被
 * lockfile 声明的包剪掉 43 个并判 `operation-error`，首启用户点"安装"必失败——见
 * `test/node/dshFreshProfileInstall.test.ts`），而该由主进程走 `dsh plugin add`（与随包一键安装、
 * 启动时装伴生插件**同一条路**）。注册表 / git / tarball 仍需要 pnpm 的解析与取消 / 进度能力，
 * 留给商城那条。
 *
 * 判定口径**偏保守**（不确定就算"不是本地路径"）：
 *   · `file:` 前缀先剥掉；
 *   · 必须是**绝对路径**（Windows 盘符 / UNC / POSIX 根）——pnpm 语义下相对路径对 Host 的 cwd
 *     没有意义（探针 p3-16 也把相对路径判为 `invalid-spec`）；
 *   · 含 `://`（http / git+https / …）、以 `.tgz` / `.tar.gz` 结尾的一律不算；
 *   · `@scope/name`、`name@1.2.3` 这类注册表形态天然不满足"绝对路径"，自然被拒。
 */
export function localPluginDir(spec: string): string | undefined {
	const raw = spec.trim();
	if (!raw) {
		return undefined;
	}
	if (!/^file:/i.test(raw)) {
		if (/:\/\//.test(raw) || /\.(tgz|tar\.gz)$/i.test(raw)) {
			return undefined;
		}
	}
	const dir = stripFileScheme(raw);
	const absolute = /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\]/.test(dir) || dir.startsWith('/');
	if (!absolute || /\.(tgz|tar\.gz)$/i.test(dir)) {
		return undefined;
	}
	// 去掉尾部分隔符；根目录 / 只剩盘符的形态**不当包目录**（交回商城那条，让拒绝理由更像样）。
	const stripped = dir.replace(/[\\/]+$/, '');
	return stripped.length >= 2 && !/^[A-Za-z]:$/.test(stripped) ? stripped : undefined;
}

/**
 * 由 dsh bin 路径推导同 scope 的兄弟包目录：
 * `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js` + `@deepseek-ai/dsh-experimental-voice-input-bundle`
 * → `<root>/node_modules/@deepseek-ai/dsh-experimental-voice-input-bundle`。
 * 纯字符串运算（本文件零依赖）；包名不符或 bin 形状意外时返回 undefined（调用方按"未随包分发"跳过）。
 */
/**
 * 必须与运行时**同一模块实例**的 dsh 包（模块私有状态 = 跨实例必失效）。
 *
 * `@deepseek-ai/dsh-app-boot`：把"root Include entry"存在模块私有的 `WeakMap` 里（以 root context 为 key），
 * 而 `dsh-hmr` / `dsh-plugin-manager` 都靠 `reconcileProfilePatches()` 做**实时重组**。profile 的
 * `node_modules` 里若另有一份（pnpm 装插件时当传递依赖带进来的），则启动用运行时那份（注册进 A）、
 * 插件解析到 profile 那份（B 的 WeakMap 是空的）⇒ **每次实时重组必抛**
 * `dsh: profile reload requires the root Include entry`（README 4.58 的实测根因：两份的 URL 都打出来了）。
 */
export const DSH_SHARED_INSTANCE_PACKAGES: readonly string[] = ['@deepseek-ai/dsh-app-boot'];

export function resolveSiblingPackage(dshBin: string, pkgName: string): string | undefined {
	const m = /^@deepseek-ai\/([a-z0-9-]+)$/.exec(pkgName);
	if (!m) {
		return undefined;
	}
	const sep = dshBin.includes('\\') ? '\\' : '/';
	const parts = dshBin.split(/[\\/]/); // …, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'
	const i = parts.lastIndexOf('@deepseek-ai');
	if (i < 0 || parts[i + 1] !== 'dsh' || parts.length - i !== 4 || parts[i - 1] !== 'node_modules') {
		return undefined;
	}
	return [...parts.slice(0, i + 1), m[1]].join(sep);
}

export function buildVersionArgs(bin: string): string[] {
	return [bin, '--version'];
}

export interface IAuthUrl {
	readonly authUrl: string;
	readonly origin: string;
}

/**
 * 从启动输出中取认证 URL（控制桥不可用时的兜底）。只接受回环地址上的 http，
 * 避免把输出中偶然出现的其他链接当成 Host 地址。
 */
export function parseAuthUrl(text: string): IAuthUrl | undefined {
	const re = /(https?:\/\/[^\s"'<>]+\?token=[^\s"'<>]+)/g;
	for (const m of text.matchAll(re)) {
		let url: URL;
		try {
			url = new URL(m[1]);
		} catch {
			continue;
		}
		if (url.protocol === 'http:' && isLoopbackHostname(url.hostname) && url.port) {
			return { authUrl: url.href, origin: url.origin };
		}
	}
	return undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/** 视图导航围栏：只允许停留在当前 Host 的 origin 上。 */
export function isSameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

// ─── Node 版本 ────────────────────────────────────────────────────────────────

export interface ISemver {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** 预发布标识，如 `rc.2`；正式版为空串。 */
	readonly pre: string;
}

export function parseSemver(raw: string): ISemver | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
	if (!m) {
		return undefined;
	}
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
}

/** semver 优先级比较（预发布低于对应正式版，预发布段按 `.` 分段、数字段按数值比较）。 */
export function compareSemver(a: string, b: string): number {
	const x = parseSemver(a);
	const y = parseSemver(b);
	if (!x || !y) {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	for (const k of ['major', 'minor', 'patch'] as const) {
		if (x[k] !== y[k]) {
			return x[k] - y[k];
		}
	}
	if (x.pre === y.pre) {
		return 0;
	}
	if (!x.pre) {
		return 1;
	}
	if (!y.pre) {
		return -1;
	}
	const xs = x.pre.split('.');
	const ys = y.pre.split('.');
	for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
		if (xs[i] === undefined) {
			return -1;
		}
		if (ys[i] === undefined) {
			return 1;
		}
		const xn = /^\d+$/.test(xs[i]) ? Number(xs[i]) : NaN;
		const yn = /^\d+$/.test(ys[i]) ? Number(ys[i]) : NaN;
		if (!isNaN(xn) && !isNaN(yn)) {
			if (xn !== yn) {
				return xn - yn;
			}
		} else if (xs[i] !== ys[i]) {
			return xs[i] < ys[i] ? -1 : 1;
		}
	}
	return 0;
}

/** dsh 官方要求 Node 22.19+（22 线）或 24+。 */
export function isSupportedNodeVersion(raw: string): boolean {
	const v = parseSemver(raw);
	if (!v) {
		return false;
	}
	if (v.major === 22) {
		return v.minor >= 19;
	}
	return v.major >= 24;
}

// ─── 托管运行时指针 ───────────────────────────────────────────────────────────

export interface IRuntimeState {
	readonly current?: string;
	/** 曾经激活过的版本，最新在末尾；用于回滚。 */
	readonly history: readonly string[];
}

const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isRuntimeVersionDir(name: string): boolean {
	return VERSION_DIR_RE.test(name);
}

/** 解析 `state.json`；任何不合法内容都退化为空状态，而不是抛错阻断启动。 */
export function parseRuntimeState(text: string | undefined): IRuntimeState {
	if (!text) {
		return { history: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { history: [] };
	}
	if (!raw || typeof raw !== 'object') {
		return { history: [] };
	}
	const obj = raw as { current?: unknown; history?: unknown };
	const current = typeof obj.current === 'string' && isRuntimeVersionDir(obj.current) ? obj.current : undefined;
	const history = Array.isArray(obj.history) ? obj.history.filter((v): v is string => typeof v === 'string' && isRuntimeVersionDir(v)) : [];
	return { current, history };
}

export function withCurrent(state: IRuntimeState, version: string): IRuntimeState {
	const history = state.history.filter(v => v !== version);
	history.push(version);
	return { current: version, history: history.slice(-10) };
}

/**
 * 选用哪个已安装版本：指针指向的版本已安装则用它；否则用已安装中最高的**正式版**，
 * 没有正式版再用最高的预发布版。不会因为装了 alpha 就悄悄切到 alpha。
 */
export function selectRuntimeVersion(state: IRuntimeState, installed: readonly string[]): string | undefined {
	if (state.current && installed.includes(state.current)) {
		return state.current;
	}
	const sorted = [...installed].filter(isRuntimeVersionDir).sort(compareSemver);
	const stable = sorted.filter(v => !parseSemver(v)?.pre);
	return stable.at(-1) ?? sorted.at(-1);
}

// ─── 控制桥覆盖层 ─────────────────────────────────────────────────────────────

/** YAML 单引号标量：内部单引号写成两个单引号；反斜杠按字面保留（Windows 命名管道路径安全）。 */
function yamlSingleQuoted(value: string): string {
	return `'${value.replace(/'/g, '\'\'')}'`;
}

/**
 * 只经 `--patch` 覆盖层把管道路径与一次性 token 交给伴生插件，从不修改用户的 profile 或配置文件。
 * 伴生插件在 bundle patch 里以 id `vssaros-bridge` 插入自己，这里只覆盖它的 config。
 *
 * 同一次覆盖层里还关掉 dsh 官方模型插件的**首启引导弹窗**（「Add an API key to get started」）：
 * `dsh-client-ui-settings-models` 的 Host 侧 Config 就是为此留的官方开关
 * （`credentialOnboarding: boolean = true`，注释原文 "Offer the browser API-key step when no native
 * shell owns credential onboarding"）。VsSaros 自己拥有一整套凭据/模型配置 UX（Agent Studio →
 * Model Providers，含 codebuddy 登录态与自定义 BYOK），官方那套"宿主不存在才需要"的引导属重复且
 * 挡视线（实测会盖住聊天框）。行 id `ui-settings-models` 取自官方 bundle patch
 * （`@deepseek-ai/dsh-web-app/cordis.patch.yml`：`- id: ui-settings-models`）。
 */
export function renderBridgeOverlay(pipe: string, token: string, hideOfficialDeepseek: boolean, welcomeNoticeVersion?: string, idleTtlMs?: number, workspaceRoot?: string): string {
	const rows = [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'- id: vssaros-bridge',
		'  config:',
		`    pipe: ${yamlSingleQuoted(pipe)}`,
		`    token: ${yamlSingleQuoted(token)}`,
		// ★ 2026-10-15（首启慢的解法 A：Host 驻留更久 ⇒ 二次启动 ~0s）：把空闲自退 TTL 显式传下去 ——
		//   桥插件默认只有 30 分钟（`IDLE_TTL_DEFAULT_MS`），IDE 重启间隔稍长（吃顿饭/开个会）
		//   Host 就已自杀 ⇒ 下次又是一次 ~27s 冷启 ✗（2026-10-15 实测分解）。
		//   不传则不写这行（回落桥插件默认，语义不变 ✓）。
		...(typeof idleTtlMs === 'number' && idleTtlMs > 0 ? [`    idleTtlMs: ${Math.floor(idleTtlMs)}`] : []),
		// VsSaros 自带凭据 UX ⇒ 关掉官方首启引导（见上方函数注释）。
		'- id: ui-settings-models',
		'  config:',
		'    credentialOnboarding: false',
	];
	// 没配 DeepSeek Key 才隐藏官方 provider（**条件化**，判定见 supervisor 的 `_hasDeepseekCredential`）。
	// 依据：dsh-llm-deepseek 的 config 有 `models` 字段（config.d.ts：「Advisory models shown by
	// discovery consumers; defaults to V41 Flash and V4 Pro」）——置空即无可展示模型，provider 行
	// 因 unusable 而不进选择器。行 id `llm-deepseek` 取自 dsh-base/cordis.patch.yml:525。
	// 注意：provider 的**注册**保持不动（不影响凭据形态），只是"没配 Key 时没模型可展示"；
	// 哪天配了 Key，下一次 Host 启动这行就不再出现（覆盖层每次启动重新生成）。
	if (hideOfficialDeepseek) {
		rows.push(
			'- id: llm-deepseek',
			'  config:',
			'    models: []',
		);
	}
	// 官方「Preview Notice」首启弹窗（settings.onboarding 的 welcome-notice 步骤）会盖住聊天框：
	// 其可见性由「已确认的文案版本」控制（WelcomeNoticeStore 比对 ui-settings-general 的
	// welcomeNoticeVersion），预置成当前版本即永不出现。版本从运行时包读（dsh 升级自动跟随），
	// 读不到就不写这一行（退回"弹一次、点 Continue"的官方行为）。
	if (welcomeNoticeVersion) {
		rows.push(
			'- id: ui-settings-general',
			'  config:',
			`    welcomeNoticeVersion: ${yamlSingleQuoted(welcomeNoticeVersion)}`,
		);
	}
	// ★ 2026-10-15（用户报 "This turn failed: unknown prompt variable {{cwd}}…"）：官方 dsh-web-app
	//   的默认补丁把 personaSuffix 写成 `Your working directory is {{cwd}}.` —— 而 **子代理
	//   （deployment）作用域**的变量表里没有 cwd（只有 provider/model ✗）⇒ 子代理每一轮都被
	//   dsh-system-prompt 的插值器抛错中止 ✗（dsh-system-prompt/lib/index.js:169；证据链见
	//   memory: reference_dsh_prompt_variable_cwd）。
	//   修法：把后缀**烘焙成字面量** —— 我们是一个窗口一个工作区 ⇒ 与根会话里变量求值的结果一致 ✓；
	//   拿不到工作区根时给空串（也绝不能留 {{cwd}} —— 那是必炸的 ✗）。
	// ⚠ cordis patch 行**整份替换**目标行 config（web-app 补丁头注释明说）⇒ personaPrefix 必须
	//   **原文复述**（含 {{model}} —— 那个变量在 agent-loop 有注册 ✓），否则 prefix 被清空 ✗✓。
	// ⚠ 我们的 --patch 覆盖层在 web-app 自带补丁**之后**应用 ⇒ 这行稳赢 ✓。
	rows.push(
		'- id: system-prompt',
		'  config:',
		`    personaSuffix: ${yamlSingleQuoted(workspaceRoot ? `Your working directory is ${workspaceRoot}.` : '')}`,
		`    personaPrefix: ${yamlSingleQuoted('You are a coding agent powered by the {{model}} model.')}`,
	);
	rows.push('');
	return rows.join('\n');
}

export function bridgePipePath(platform: string, id: string, socketDir: string): string {
	return platform === 'win32' ? `\\\\.\\pipe\\vssaros-dsh-${id}` : `${socketDir.replace(/\/+$/, '')}/vssaros-dsh-${id}.sock`;
}

// ─── 代码图谱插件的工作区根覆盖层 ────────────────────────────────────────────

/**
 * 把"当前工作区根目录"经 `--patch` 覆盖层交给代码图谱插件（`config.workspaceRoot`）。
 *
 * 为什么非注入不可：模块按 `<root>/.codebase-memory/` 定位清单与图谱，而 Host 进程的 cwd **不是**工作区
 * ⇒ 不注入时就只能报"未配置"（页面会如实显示"工作区 (未配置)"、工具报错），而不是去猜别人的图。
 * ⚠ 行 id 必须是 **`vssaros-codebase`** —— 插件自带 `cordis.patch.yml` 插入的就是这一行；名字不一致会
 * **打空**并**静默**回到"没配"路径（与看板 `workspaceId`、bridge 同一条教训，见 README 4.79）。
 *
 * ★ 2026-10-20 起这行还携带**甲档·所有权交接**的三键（`indexTarget` / `indexWatch` / `indexMaxFiles`）——
 * 语义与"为什么必须三条一起"写在下面的行注释里 ✓。交接是**可逆**的：删掉这三键就回到"IDE 产图"✓。
 */
export function renderCodebaseOverlay(workspaceRoot: string, relatedRoots: readonly string[] = []): string {
	const rows = [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'- id: vssaros-codebase',
		'  config:',
		`    workspaceRoot: ${yamlSingleQuoted(workspaceRoot)}`,
		// ★★ 甲档·所有权交接（2026-10-20 用户拍板，见 doc/codebase-full-port-feasibility.html 的"所有权最终态"）：
		//   · `indexTarget: workspace` ⇒ dsh **写工作区**的 `.codebase-memory/`，并在清单里自称
		//     `producer: 'vssaros-dsh'` ⇒ **IDE 侧见它就不扫描、不落盘**（`_refuseSaveForDshOwned`），
		//     只保留"读 + 发现外部变化就重载" ✓ —— 这样两侧智能体看到的是**同一份事实** ✓；
		//   · `indexWatch: true` ⇒ dsh 常驻保鲜（**交接的前提**：不开就没人自动更新图 ✗）；
		//   · `indexMaxFiles` ⇒ watcher 每次运行的**扫描预算**。⚠ 不许小于工作区源文件数：
		//     甲档下一次"增量"也按它扫描，预算太小会把全量图**缩掉**（真机 2.3 万源文件的仓，默认 1500 ✗）
		//     ⇒ 这里给 20000（插件侧上限，`INDEX_MAX_FILES_CAP`）。
		'    indexTarget: workspace',
		'    indexWatch: true',
		'    indexMaxFiles: 20000',
		// ★ 2026-10-21：防抖 15s（缺省 5s 在"多人并发编辑"的仓库里会让 watcher 几乎一直忙；
		//   上限仍是 60s ✓。想更快就调小，想更省就调大 —— 这一行是**唯一**的旋钮 ✓）。
		'    debounceMs: 15000',
		// ★ 2026-10-20（真机事故）：**显式钉死档位**。watcher 的运行不传 parser ⇒ 走 `auto` ⇒ 上次实测文件数
		//   超阈值就**静默降成 regex 快档**，把 treesitter 建的 39 万节点图覆盖成 9.9 万（方法/调用边整族消失 ✗✗）。
		//   插件侧已补"沿用上次档位"的规则，这里再从**部署侧**钉死：交接的图就该是高保真的那份 ✓。
		'    parser: treesitter',
	];
	// 图谱**相关根**（主根之外的其余根，跨根只读查询用；主根仍在 `workspaceRoot`）。
	// 只在非空时写这一行：缺它 ⇒ 插件按"只有主根"处理（与旧行为一致 ✓），不会把 undefined 写进 YAML。
	const others = relatedRoots
		.filter(root => typeof root === 'string' && root.trim().length > 0 && root !== workspaceRoot);
	if (others.length) {
		rows.push('    relatedRoots:');
		for (const root of others) {
			rows.push(`      - ${yamlSingleQuoted(root)}`);
		}
	}
	rows.push('');
	return rows.join('\n');
}

// ─── 沙箱模式覆盖层（本机写不了完整性标签时的降级）────────────────────────────

/**
 * 把沙箱模式显式写到 dsh 的 `sandbox-policy` 行（`config.mode` / `config.workspaceRoot`）。
 *
 * 为什么要有（2026-10-13 用户机器实测，完整缘由见 `common/dshSandboxCompat.ts`）：
 * dsh 默认 `workspace-write` 在 Windows 上走 `windows-acl` 档 —— **每次命令调用**都要给工作区根
 * 同时写 DACL + **Low 完整性标签**（`setNamedSecurityInfoW(path, 1, 20, …)`），而这台机器上写标签
 * 被系统拒绝（连自己新建的目录都 `Access is denied`）⇒ dsh 那次合并调用整体失败 ⇒ 每个走沙箱的
 * 工具都报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)` ✗✗
 * （runner 的设计是"绝不无沙箱启动子进程" ⇒ 它**不降级**）。启动期探针探不通时用本覆盖层降级 ✓。
 *
 * ⚠ 行 id 必须逐字等于 **`sandbox-policy`** / **`permission`**（`@deepseek-ai/dsh-base/cordis.patch.yml:229`
 *   与 `:250` 定义的两行）；不一致就**打空**且不报错（与 `renderCodebaseOverlay` 同一条教训）。
 *
 * ## 为什么必须**同时**打两行（2026-10-13 实测，第一版只打第一行 ⇒ 弄坏了插件 ✗✗）
 *
 * 只打 `sandbox-policy` 时，Host 日志会出现：
 * ```
 * dsh: warning: 1 entry did not activate
 * permission (@deepseek-ai/dsh-permission-presets): Error: permission: composed sandbox and
 * approval defaults match no preset; configure defaultPreset explicitly
 * ```
 * —— preset 服务把「沙箱模式 + 审批策略」**组合**起来要求命中某个 preset（`:180` 处 `throw`），
 * 而原表里 `danger-full-access` 配的审批是 `never` ⇒ 组合 `(danger-full-access, ask)` **谁都对不上**
 * ⇒ 构造函数抛错 ⇒ `permission` 插件**整个不激活** ⇒ 沙箱策略退回默认（`workspace-write`）⇒
 * 报错照旧、还白坏一个插件 ✗✗。
 *
 * ⇒ 本覆盖层把 `danger-full-access` 这个 preset 的审批**改回 `ask`**（并显式 `defaultPreset`），
 * 让组合自洽。**注意仍不动 `approval` 行、也不动 `DSH_PERMISSION_MODE` 环境变量** ——
 * 动那个变量会让审批策略一起变成 `never` ✗（等于把审批闸也拆了，而沙箱已经关了 ⇒ 再无兜底 ✗）。
 * `permission` 行的 config 是**整体替换** ⇒ 三个 preset 必须一起写全 ✓。
 */
export function renderSandboxOverlay(mode: string, workspaceRoot: string): string {
	return [
		'# Generated by VsSaros for one Host run (sandbox downgrade; reason logged by dshSandboxProbe).',
		'- id: sandbox-policy',
		'  config:',
		`    mode: ${yamlSingleQuoted(mode)}`,
		`    workspaceRoot: ${yamlSingleQuoted(workspaceRoot)}`,
		// 第二行：让「沙箱 + 审批」的组合命中 preset（见上面那段注释；缺它会让 permission 插件抛错不激活 ✗）
		'- id: permission',
		'  config:',
		'    defaultPreset: ' + yamlSingleQuoted(mode),
		'    presets:',
		'      read-only:',
		'        sandbox: read-only',
		'        approval: ask',
		'      workspace-write:',
		'        sandbox: workspace-write',
		'        approval: ask',
		`      ${mode}:`,
		`        sandbox: ${mode}`,
		// ★ 审批策略保持 `ask`：沙箱已被降级 ⇒ 审批是唯一兜底，绝不能跟着变成 `never` ✗
		'        approval: ask',
		'',
	].join('\n');
}

// ─── 看板插件的当前工作区覆盖层 ──────────────────────────────────────────────

/**
 * 把"当前 Agent Studio 工作区 id"经 `--patch` 覆盖层交给看板插件（`config.workspaceId`）。
 * 为什么非注入不可：IDE 侧 `agentTaskBoardService.getTasks(workspaceId)` 会按它过滤，
 * 空/错值的卡片在看板界面里**不可见**（只能直接读 JSON 才发现）。
 * 与 bridge 覆盖层同机制、同约束：只覆盖插件行的 config，绝不改用户的 profile 文件。
 * 已知边界：这是**启动时的快照**——Host 运行期间切换工作区不会更新它（真到位需要运行时解析，
 * 见方案 6.8 的待办）。插件侧在拿不到 id 时 fail-closed，不会静默写错工作区。
 */
export function renderKanbanOverlay(workspaceId: string, dataRoot?: string): string {
	// `dataRoot` 也在这里注入（2026-10-12）：看板文件在 `<数据根>/<TASKBOARD_FILE>`
	// （`dsh-plugins/vssaros-kanban/lib/store.js` 的 `taskboardPath`），而模块兜底是 `~/.vssaros`
	// ⇒ dev 实例会**读写生产看板** ✗ —— 比只读的那几个更糟（这是**写**路径 ✓）。
	//
	// ⚠ 为什么必须是**同一个**条目（不能另起一个覆盖层去打同一行）：实测（`--patch a.yml --patch b.yml`
	// 都打 `vssaros-kanban`）**后一个覆盖层把整份 `config` 替换掉** ⇒ 先写的 `workspaceId` 直接消失 ✗
	// （2026-10-12 用 `--dump-config` 验证 ✓）。⇒ **一行只能有一个覆盖层**：要加键就加在同一份里。
	return [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'- id: vssaros-kanban',
		'  config:',
		`    workspaceId: ${yamlSingleQuoted(workspaceId)}`,
		...(dataRoot ? [`    dataRoot: ${yamlSingleQuoted(dataRoot)}`] : []),
		'',
	].join('\n');
}

// ─── agents 模块的 agent 目录覆盖层 ──────────────────────────────────────────

/**
 * 把 VsSaros 的 agent 目录交给 agents 模块（`config.agentsRoot`，行 id `vssaros-agents`）。
 *
 * 为什么非注入不可：模块自身的口径是 `config.dataRoot` → 环境变量 `VSSAROS_DATA_ROOT` → `~/.vssaros`
 * （`dsh-plugins/vssaros-agents/lib/store.js`），而**用户数据根在 dev 模式下是 `~/.vssaros-dev`**
 * （`agentStudioService._getGlobalDataUri()` 的注释原话：".vssaros/ or .vssaros-dev/ in dev mode"）
 * ⇒ 不注入时 dev 实例会把**生产**目录的 agent 列进聊天框（2026-10-11 实测：`~/.vssaros-dev/agents`
 * 里那 5 个 agent 一个都没出现），而生产两者恰好同路径、这类错配被完全掩盖 ✗。
 *
 * 与 bridge / kanban / codebase 同机制、同约束：只覆盖插件行的 config，绝不改用户的 profile 文件；
 * Host 停止时删掉覆盖层。⚠ 行 id 必须是 **`vssaros-agents`** —— 插件自带 `cordis.patch.yml` 插入的
 * 就是这一行，名字不一致会**打空**并**静默**退回模块自己的默认口径（同一条教训见 README 4.79）。
 *
 * ⚠ 2026-10-27「数据源统一」：**这里不再注入任何 IM 凭据**。飞书入站凭据的真源是
 *   dsh 侧 `<dataRoot>/agent-im-accounts.json`（在 dsh 设置 → 渠道 里填，走插件自己的
 *   `POST /api/bindings {action:'credentials'}`）。原先那条"IDE 设置 → 覆盖层 →
 *   `config.feishu`"的链路已下线；启动期由插件的 `migrateLegacyFeishu()` 做一次性搬运。
 */
export function renderAgentsOverlay(agentsRoot: string | undefined, agentsBuiltinRoot?: string): string {
	const lines = [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'- id: vssaros-agents',
		'  config:',
	];
	// 自定义根（`<数据根>/agents`）：dev / 生产不同，必须注入。
	if (agentsRoot) {
		lines.push(`    agentsRoot: ${yamlSingleQuoted(agentsRoot)}`);
	}
	// ★ 2026-10-19：内置 agent 目录（启动期由代码真源 `builtinAgents.ts` 生成到 runDir 的 md 副本）。
	//   没有它 ⇒ dsh 侧的 Agents 页 / 聊天框**只能看到自定义 agent**（内置一个都列不出来 ✗）。
	//   ⚠ 真源仍是代码；这里只是"Host 读不到产品源码"的产物交付（与 `bundledSkillDir` 同一类道理）。
	if (agentsBuiltinRoot) {
		lines.push(`    agentsBuiltinRoot: ${yamlSingleQuoted(agentsBuiltinRoot)}`);
	}
	lines.push('');
	return lines.join('\n');
}

// ─── 数据根覆盖层（读 `<数据根>` 的那几个模块）────────────────────────────────

/**
 * 把 VsSaros 的**数据根**（以及 MCP 配置路径）交给**读它的那几个模块**——一份覆盖层、多条行。
 *
 * 为什么非注入不可：这几个模块的兜底口径都是 `config.*` → 环境变量 → `~/.vssaros`，而
 * **用户数据根在 dev 模式下是 `~/.vssaros-dev`**（见 `agentStudioService._getGlobalDataUri()`）⇒
 * 不注入时 dev 实例读的是**生产**数据：资料库/画布/工作流页列生产库、技能页列生产技能目录、
 * MCP 页看生产 `mcp.json`（于是"页面说的文件"与"Host 真挂载用的文件"**是两个**）✗ —— 而生产
 * 两者恰好同路径，这类错配在生产上**完全被掩盖** ✓（2026-10-11 agents 那次实测就是这么发现的）。
 *
 * ⚠ 行 id 必须与插件自带 `cordis.patch.yml` 插入的**完全一致** —— 名字不一致会**打空**、
 * 并**静默**退回模块自己的默认口径（教训见 README 4.79 / 5.84）。注意 `canvas` / `mcp` 两个
 * 比同族多一个 `dsh-`（历史遗留），**不是笔误** ✓。行 id 由 `dshOverlayRowIds.test.ts`
 * 与插件补丁逐条对账，改名必须两边一起改 ✓。
 */
export function renderDataRootOverlay(dataRoot: string, mcpConfigPath?: string, extra: IDshOverlayExtras = {}): string {
	const lines = [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'# 一份覆盖层里按行 id 覆盖多个模块 —— 每行读什么见下面的注释。',
	];
	// ⚠ 这份名单 = "读 `config.dataRoot` 的模块"，由 `dshPluginPackages.test.ts` 的
	// 「数据根覆盖层：行 id 落在真插件行上，且『读数据根的模块』一个不漏」那条**按源码实际读法对账**
	// ⇒ 新增一个读数据根的模块时**必须**同步这里，否则 dev 实例会去读生产数据。
	// media（2026-10-12）读它来定位 `<数据根>/media` 与 `media-store-config.json`。
	// dashboard（2026-10-13，P2 起）：它**写** `<数据根>/dashboard/layout.json`（首页编排）⇒ 也读
	// `dataRoot` ✓。⚠ 不加这行的话，dev 实例会把编排**写进生产数据根**（而且读也在生产）—— 比"读到旧数据"
	// 更糟 ✗（本插件此前全只读，所以它是新进入这份名单的）。
	// marketplace（2026-10-22）：**读写都最重的一个** —— 它把商城安装的 skill/workflow **落盘**到
	// `<数据根>/skills|workflows`，还**写** `<数据根>/installed-packages.json` 台账。
	// ⚠ 不加这行：dev 实例会把商城下载的包与台账写进**生产数据根**（且 `installed` 页签读到生产的台账）✗✗
	//   —— 比只读的那几个危险得多，这条由 `dshPluginPackages.test.ts` 按源码实际读法对账兜住。
	// ⚠ kb / canvas 单独两行（不放进上面的循环）：它们除了数据根，还要**各自的根** —— 见下。
	// xhs-note（2026-10-28）：草稿落 `<数据根>/xhs-note/` ⇒ 也读 `config.dataRoot`。
	// ⚠ 不加这行：dev 实例的草稿会写进**生产数据根**（与 marketplace 那类同病）。
	for (const id of ['vssaros-workflow', 'vssaros-skills', 'vssaros-media', 'vssaros-dashboard', 'vssaros-marketplace']) {
		lines.push(`- id: ${id}`);
		lines.push('  config:');
		lines.push(`    dataRoot: ${yamlSingleQuoted(dataRoot)}`);
	}
	// kb：用户可以在 IDE 里把**知识库存储根**改到别处（`agentStudio.knowledge.storage.path` ✓）⇒ 那时
	// 插件只认 `<数据根>/knowledge-base` 就会**空着**（而 IDE 侧明明有内容 ✗），且页面不报错、只是"什么都没有"
	//（2026-10-12 评估发现的缺口 ✓）。改了就给 `config.kbRoot` ✓；没改**不给**（插件默认与 IDE 默认同值 ✓）。
	const kbRoot = extra.kbRoot?.trim();
	lines.push('- id: vssaros-kb');
	lines.push('  config:');
	lines.push(`    dataRoot: ${yamlSingleQuoted(dataRoot)}`);
	if (kbRoot) {
		lines.push(`    kbRoot: ${yamlSingleQuoted(kbRoot)}`);
	}
	// ★ 库记录（2026-10-15）：**同一个 `vssaros-kb` 行**（那份 config 整体替换 ⇒ 拆两份会互相擦掉 ✗）。
	//   ⚠ 空值不渲染（本文件第一条硬约束 ✓）：没有库记录时**不产生这两行** ⇒ 插件退回"按目录列出全部库"
	//   的旧行为 ✓（不假装 ✓）。形状是单引号包住的 **JSON 字符串**（见 `IDshOverlayExtras` 的注释 ✓）。
	// ⚠ 2026-10-15 真机事故：这两行**必须紧跟在 kb 行里**（YAML 里键归属于"上面最近的 `- id:`"）——
	//   web-content-import 那一行曾被插在 kb 行与这两行**之间** ⇒ 库记录全落到了它名下，kb 页拿不到注入
	//   （页面提示"老 Host / 独立启动器"、已登记的自定义路径库消失、库删除分流失去依据）✗。
	//   守卫：`dshPluginPackages.test.ts`「数据根覆盖层：每个键落在它该在的那一行」。
	const kbVaults = extra.kbVaults?.trim();
	if (kbVaults) {
		lines.push(`    kbVaults: ${yamlSingleQuoted(kbVaults)}`);
	}
	const kbActiveVaultId = extra.kbActiveVaultId?.trim();
	if (kbActiveVaultId) {
		lines.push(`    kbActiveVaultId: ${yamlSingleQuoted(kbActiveVaultId)}`);
	}
	// web-content-import（2026-10-15 新增模块）：读数据根（默认口径）＋ **写** `<kbRoot>/<vault>/库/raw/`
	// ⇒ 与 kb **同一形态**（dataRoot + 可选 kbRoot；用户改了知识库存储根时两边必须同步，否则它写去旧位置 ✗）。
	// ⚠ 它是**写**路径（比只读的那几个更怕打空：dev 实例会把内容写进生产库 ✗）。
	lines.push('- id: vssaros-web-content-import');
	lines.push('  config:');
	lines.push(`    dataRoot: ${yamlSingleQuoted(dataRoot)}`);
	if (kbRoot) {
		lines.push(`    kbRoot: ${yamlSingleQuoted(kbRoot)}`);
	}
	if (mcpConfigPath) {
		lines.push('- id: vssaros-dsh-mcp');
		lines.push('  config:');
		lines.push(`    path: ${yamlSingleQuoted(mcpConfigPath)}`);
	}
	// unreal：本文件里唯一**无文件**的一条（HTTP bridge ✓）—— 用户在 IDE 设置里改过 bridge 地址时，dsh 侧
	// 过去**没有等价配置键** ✗（只能靠环境变量 `VSSAROS_UNREAL_BRIDGE_URL` ✓）⇒ 设置改了、Host 仍连 8765 ✓。
	// 设置**留空**时不渲染 ✓（插件自带默认与 IDE 默认同值 `http://127.0.0.1:8765` ✓）。
	const unrealBridgeUrl = extra.unrealBridgeUrl?.trim();
	if (unrealBridgeUrl) {
		lines.push('- id: vssaros-unreal');
		lines.push('  config:');
		lines.push(`    bridgeUrl: ${yamlSingleQuoted(unrealBridgeUrl)}`);
	}
	// browser（2026-10-14）：同一条缺口 —— IDE 侧那三个设置（`sessions.agentStudio.browserCdp.{port,
	// launchDedicated,headless}`）本来**到不了 Host** ✗：Host 插件只读自己的 `config`（补丁里是 `{}`）或
	// `VSSAROS_BROWSER_*` 环境变量 ⇒ 用户在设置里关掉「自动拉起调试实例」**不生效**，插件照旧拉起一个
	// **空 profile** 的专属实例，于是"你自己的 Chrome（带登录态）"那条路被静默绕过 ✗
	//（现场＝用工具抓已登录站点时先撞登录墙，脚本侧表现为"它说我没登录"）。
	//
	// ⚠ 只写**用户显式改过**的键（`browser` 整体缺省 ⇒ 一条都不渲染）：插件自带默认与 IDE 默认同值，
	//   无差别地全写一遍会让"插件改了默认值"这件事在 Host 侧被静默钉死 ✗（与 unreal 那条同一口径 ✓）。
	const browser = extra.browser;
	if (browser && (browser.port !== undefined || browser.launchDedicated !== undefined || browser.headless !== undefined)) {
		lines.push('- id: vssaros-browser');
		lines.push('  config:');
		if (browser.port !== undefined) { lines.push(`    port: ${browser.port}`); }
		if (browser.launchDedicated !== undefined) { lines.push(`    launchDedicated: ${browser.launchDedicated}`); }
		if (browser.headless !== undefined) { lines.push(`    headless: ${browser.headless}`); }
	}
	return [...lines, ''].join('\n');
}

/**
 * {@link renderDataRootOverlay} 里的**额外行**。
 *
 * 为什么它们挤在同一份文件里（而不是各写一份覆盖层 ✗）：**同一行被两份覆盖层打时 `config` 是整体替换**
 * （README 5.101 实测 ✓）⇒ 每行必须**恰好**被写一次 ✓；而这几条（mcp / unreal / kb 与 canvas 的专属根 ✓）
 * 都只能和"它们那一行的数据根"写在**同一份**里 ✓。
 */
export interface IDshOverlayExtras {
	/** 知识库存储根（用户改过才给；与 IDE 的 `resolveKbRoot` 同源 ✓）—— kb 与 canvas **一起**用 ✓。 */
	readonly kbRoot?: string;
	/**
	 * **库记录**（2026-10-15）：IDE storage 里 `agentStudio.kb.vaults` 的展示字段，**已序列化成 JSON 字符串** ✓
	 * （渲染器只写 YAML scalar ⇒ 不在这里实现数组/对象 emit ✗；形状的容错在插件侧 ✓）。
	 */
	readonly kbVaults?: string;
	/** 同上：**当前激活的库 id**（`agentStudio.kb.active` ✓）。 */
	readonly kbActiveVaultId?: string;
	/** Unreal bridge 基址（IDE 设置为空时不给 ⇒ 插件用自带默认 8765 ✓）。 */
	readonly unrealBridgeUrl?: string;
	/**
	 * `browser` 插件的三个旋钮（**每个键都只在用户显式改过时才给** ⇒ 否则插件用自己的默认 ✓）。
	 *
	 * 为什么需要它：这三个键在 IDE 设置里早就有（`sessions.agentStudio.browserCdp.{port,launchDedicated,
	 * headless}`），但 Host 是独立进程、读不到 IDE 设置 ⇒ 改了**不生效** ✗（与 unreal bridge 同一条缺口，
	 * 2026-10-14 一并补上）。
	 *
	 * 为什么先管 `launchDedicated`：它决定"端口不可达时要不要自己拉起一个**空 profile** 的专属实例"。
	 * 想在**你自己那个 Chrome**（带登录态）里干活的人必须能关掉它 —— 否则登录态那条路被静默绕过 ✗。
	 */
	readonly browser?: IDshBrowserOverlayConfig;
}

/** {@link IDshOverlayExtras.browser} 的形状（三键都可选；缺省 = 不写该键）。 */
export interface IDshBrowserOverlayConfig {
	/** Chrome 远程调试端口（`--remote-debugging-port`；专属实例跑在它 +1 上）。 */
	readonly port?: number;
	/** 端口不可达时是否自己拉起专属实例（关掉 = 只在你自己那个 Chrome 里干活）。 */
	readonly launchDedicated?: boolean;
	/** 专属实例是否无头（无头下无法交互式登录）。 */
	readonly headless?: boolean;
}

// ─── 记忆模块的网关地址覆盖层 ────────────────────────────────────────────────

/**
 * 从环境变量解出记忆网关地址（`AGENTMEMORY_URL` 优先；缺失时用 `AGENTMEMORY_PORT` 拼；两个都没有
 * ⇒ `undefined` ⇒ **不渲染覆盖层**）。
 *
 * 抽成纯函数是为了可测：这里是"要接线"与"不要猜"两条纪律的交点。`app.ts._initAgentMemoryEndpoint()`
 * 是端口规则的**唯一真源**（安装版 3111 / dev 3112 / 非默认数据目录再确定性偏移），它把这两个变量
 * 写进主进程环境 ⇒ supervisor（主进程）直接继承 ✓ —— 这里**只读**，绝不自己重算那套规则。
 */
export function memoryGatewayUrlFromEnv(env: {
	readonly AGENTMEMORY_URL?: string;
	readonly AGENTMEMORY_PORT?: string;
	/**
	 * 索引签名只为"让宽对象能传进来"：目标类型全是可选属性 ⇒ 属 TS 的**弱类型**，而
	 * `process.env` 与它**没有一个共同属性** ⇒ 直接 `tsgo error TS2559`（`dshHostSupervisor.ts:614` 实测）。
	 * 有了它 `process.env` 与测试里的小对象都能传 ✓，语义没变（仍然只读这两个名字）。
	 */
	readonly [key: string]: string | undefined;
} = {}): string | undefined {
	const url = env.AGENTMEMORY_URL?.trim();
	if (url) {
		return url.replace(/\/+$/, '');
	}
	const port = Number.parseInt(env.AGENTMEMORY_PORT ?? '', 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : undefined;
}

/**
 * 把 AgentMemory 网关地址交给记忆模块（`config.gatewayUrl`，行 id `vssaros-memory`）。
 *
 * 为什么非注入不可：模块的口径是 `config.gatewayUrl` → 环境变量 `VSSAROS_MEMORY_GATEWAY_URL` →
 * **明确报"未配置"**（`dsh-plugins/vssaros-memory/lib/gateway.js:40-47`：作者刻意**不猜端口** ——
 * "猜错会读到另一个网关的库"）。而 `VSSAROS_MEMORY_GATEWAY_URL` 全仓无人设置 ⇒ 不注入时记忆页
 * 恒为 `data-vssaros-memory-state="unconfigured"`（2026-10-11 复核：记忆这块此前**根本没有覆盖层**），
 * 看上去像"记忆没生效"，实际只是**没接线**。
 *
 * **拿不到地址就不渲染这一行** —— 维持"不猜"的美德 ✓：页面如实显示"未配置"，而不是连到一个
 * 碰巧开着的端口上，读到别人的库。
 *
 * ⚠ 行 id 必须是 **`vssaros-memory`** —— 插件自带 `cordis.patch.yml` 插入的就是这一行；
 * 名字不一致会**打空**并**静默**退回"未配置"（同一条教训见 README 4.79；`p3-07` 有契约守卫钉住）。
 */
export function renderMemoryOverlay(gatewayUrl: string, dataRoot?: string, workspaceId?: string): string {
	const root = (dataRoot ?? '').trim();
	const ws = (workspaceId ?? '').trim();
	return [
		'# Generated by VsSaros for one Host run. Removed when the Host stops.',
		'- id: vssaros-memory',
		'  config:',
		`    gatewayUrl: ${yamlSingleQuoted(gatewayUrl)}`,
		// ⚠ **这三项必须写在同一个 `config` 里**：同一行被两份覆盖层打时 `config` 是
		// **整体替换**（实测，见 `dshHostConfig.ts` 文件头第 1 条）⇒ 拆成两份会静默抹掉别的键 ✗
		//（与 `renderKanbanOverlay(workspaceId, dataRoot)` 同一个坑、同一个解法 ✓）。
		// · `dataRoot`（2026-10-12）：审计账本落 `<数据根>/memory-audit/` ⇒ 不注入时 **dev 实例会把
		//   账本写进生产数据根**（`dshPluginPackages.test.ts` 的覆盖层对账会红 ✓）。
		// · `workspaceId`（2026-10-12）：记忆模块按它派生命名分区（`partitionOf` ⇒ `ws-<id>`），
		//   于是 dsh 侧记忆**按工作区隔离** ✓；不注入时回退旧分区 `default`（零行为变化 ✓）。
		// 空值不渲染（同本目录 `dshHostConfig.ts` 文件头第 2 条：字段缺失/全空白 ⇒ 不产生那一条）。
		...(root ? [`    dataRoot: ${yamlSingleQuoted(root)}`] : []),
		...(ws ? [`    workspaceId: ${yamlSingleQuoted(ws)}`] : []),
		'',
	].join('\n');
}


