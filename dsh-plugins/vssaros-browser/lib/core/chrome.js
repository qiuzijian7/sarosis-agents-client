/**
 * Chrome「调试入口」的**纯逻辑**（无 fs、无 Electron、无第三方依赖）——逐条移植自：
 *  · `src/vs/sessions/contrib/agentStudio/common/chromeDebugSetup.ts`（候选路径 / 专属 profile / 命令行参数）
 *  · `src/vs/sessions/contrib/agentStudio/common/browserCdp.ts`（默认端口 / 专属端口 / 候选端点）
 *
 * 为什么是**移植**而不是"引进来"：dsh 插件是**零依赖的纯 JS**（Node 直接加载 `lib/index.js`），
 * 没法 import VsSaros 的 TS 树。而这几条**必须与 IDE 侧逐字一致**——不然"Host 自己拉起的 Chrome"
 * 会和 IDE 拉起的那份用不同端口/不同 profile/不同开关，症状是"浏览器工具连上了另一个空 profile"。
 * ⇒ 值层面的等价性由 `test/common/dshBrowserCore.test.ts` 的**跨源码断言**兜住（漂移即红）。
 */

/** Chrome 远程调试默认端口（`--remote-debugging-port` 的惯例值）。真源：`browserCdp.ts:38`。 */
export const DEFAULT_CDP_PORT = 9222;

/** 单条 CDP 命令的默认超时。真源：`browserCdp.ts:41`。 */
export const CDP_COMMAND_TIMEOUT_MS = 20_000;

/** 用户必须在地址栏**手输**的页面（那个同意勾选框在这里）。真源：`chromeDebugSetup.ts:41`。 */
export const CHROME_REMOTE_DEBUGGING_PAGE = 'chrome://inspect/#remote-debugging';

/** 环境变量逃生舱：Chrome 装在非标准位置时由用户指定。真源：`chromeDebugSetup.ts:44`。 */
export const CHROME_PATH_ENV = 'SAROS_CHROME_PATH';

/** 专属调试 profile 的目录名（放在 `<home>/.vssaros/` 下）。真源：`chromeDebugSetup.ts:113`。 */
export const DEDICATED_PROFILE_DIRNAME = 'browser-profile';

/** Windows 非默认盘兜底。真源：`chromeDebugSetup.ts:51-53`。 */
const EXTRA_WINDOWS_DRIVES = ['D', 'E', 'F', 'G'];
const WINDOWS_CHROME_REL = '\\Google\\Chrome\\Application\\chrome.exe';

/**
 * 我们**自行拉起**的专属调试实例用的端口 = 配置端口 + 1（上限退回 -1）。
 * 真源：`browserCdp.ts:61-64`（那里解释了为什么不与配置端口共用：9222 要留给用户自己那个 Chrome）。
 */
export function dedicatedPortFor(configuredPort) {
	const next = configuredPort + 1;
	return next > 65535 ? configuredPort - 1 : next;
}

/**
 * 候选端点优先级：① 配置端口（你自己的 Chrome，带登录态）② 同端口 IPv6 形态 ③ 专属实例。
 * 真源：`browserCdp.ts:91-100`。顺序**即语义**（用户自己的 Chrome 必须优先），不要"谁先回来选谁"。
 */
export function cdpEndpointCandidates(configuredPort) {
	const dedicated = dedicatedPortFor(configuredPort);
	const mk = (host, port) => ({ host, port, url: `http://${host}:${port}`, selfLaunched: port === dedicated });
	const out = [mk('127.0.0.1', configuredPort), mk('[::1]', configuredPort)];
	if (dedicated !== configuredPort) { out.push(mk('127.0.0.1', dedicated)); }
	return out;
}

/** Chrome 可执行文件候选（去重去空）。真源：`chromeDebugSetup.ts:62-94`。 */
export function chromeExecutableCandidates(env, platform) {
	const out = [];
	const override = typeof env?.[CHROME_PATH_ENV] === 'string' ? env[CHROME_PATH_ENV].trim() : '';
	if (override) { out.push(override); }

	if (platform === 'win32') {
		const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
		const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
		out.push(`${programFiles}${WINDOWS_CHROME_REL}`);
		out.push(`${programFilesX86}${WINDOWS_CHROME_REL}`);
		const localAppData = env['LOCALAPPDATA'];
		if (localAppData) { out.push(`${localAppData}${WINDOWS_CHROME_REL}`); }
		for (const drive of EXTRA_WINDOWS_DRIVES) {
			out.push(`${drive}:\\Program Files${WINDOWS_CHROME_REL}`);
		}
	} else if (platform === 'darwin') {
		out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
	} else {
		out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome');
	}
	return [...new Set(out)].filter(p => p.length > 0);
}

/** 取第一个真实存在的候选（存在性由调用方注入 ⇒ 无 fs 依赖）。真源：`chromeDebugSetup.ts:97-102`。 */
export function pickChromeExecutable(candidates, exists) {
	return candidates.find(p => exists(p));
}

/** 专属 profile 目录绝对路径。真源：`chromeDebugSetup.ts:116-119`（不 import path，保持零依赖）。 */
export function dedicatedProfileDir(homeDir, platform) {
	const sep = platform === 'win32' ? '\\' : '/';
	return `${homeDir}${sep}.vssaros${sep}${DEDICATED_PROFILE_DIRNAME}`;
}

/**
 * 拉起可调试 Chrome 的参数。真源：`chromeDebugSetup.ts:135-144`。
 * ⚠ `--user-data-dir` 不是可选项：Chrome 136+ 对默认 profile 会**静默忽略** `--remote-debugging-port`。
 * ⚠ `headless` 用**不带 `=new`** 的 `--headless`（Chrome 132+ 就是新无头；老版本上 `=new` 会掉回有窗口）。
 */
export function buildDedicatedChromeArgs(profileDir, port, headless) {
	const args = [
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${port}`,
		'--no-first-run',
		'--no-default-browser-check',
	];
	if (headless) { args.push('--headless'); }
	// ★ 反检测**基线**（2026-10-13）：调研 8 个开源项目后，这是唯一一条"值得加"的启动参数 ——
	//   它让 Blink 不再把本实例标成自动化，`navigator.webdriver` 随之回到正常值（browser-use
	//   的 `profile.py:201` 同样做法）。
	//
	// ⚠ 三条明确的**不做**（都是调研结论，别自作聪明加回来）：
	//   · **不**注入 JS 补丁（`navigator.webdriver = false` 之类）—— browser-use / openclaw /
	//     Agent-Reach 三家都不做，因为现代检测恰恰靠"这个属性被动过"来识别；
	//   · **不**换内核（Camoufox / Rebrowser 那类）—— 与"干脆用用户真实的 Chrome"这条主线冲突；
	//   · **不**改 UA。真实浏览器 + 真实 profile 永远是最强的信号，这条参数只是抹掉一个**免费**的特征。
	args.push('--disable-blink-features=AutomationControlled');
	return args;
}
