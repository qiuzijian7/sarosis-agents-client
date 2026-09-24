/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chrome「调试入口」相关的**纯逻辑**（可单测：无 fs、无 Electron 依赖）。
 *
 * ## 实测结论（2026-09-24，本机 Chrome 152.0.7977.83）：自动化开启远程调试只有一条路
 *
 *   ✖ `chrome.exe "chrome://inspect/#remote-debugging"` —— Chrome **忽略**从命令行/外部程序传来
 *     的 `chrome://` URL（防外部程序直接打开内部页）。四种写法**全部实测**过，全都只开出空白
 *     New Tab、URL 被丢弃：
 *       · `--new-window` + 带锚点 URL      · 不带锚点的 `chrome://inspect`
 *       · URL 放在所有开关之前             · `--app=chrome://inspect`
 *     结论：**连"帮用户打开这一页"都做不到**，更不必说替他勾选。
 *   ✖ 程序代点那个勾选框 —— 它是 Chrome 的**显式同意闸门**：要自动化得先有 CDP（而 CDP 正是目标，
 *     循环依赖），或走 OS 级 UI 自动化去点一个安全同意框（Chrome 默认还不把 WebUI 内容暴露给
 *     无障碍树，得先开 `--force-renderer-accessibility`）—— 脆弱，且本质是在绕过用户同意。本仓不做。
 *   ✖ `--remote-debugging-port` 打**默认 profile** —— Chrome 136+ 起**静默忽略**（必须同一条命令行
 *     带 `--user-data-dir`）。这就是"给快捷方式加了参数却依然连不上"的真正原因。
 *   ✔ **另起一个带 `--user-data-dir` + `--remote-debugging-port` 的 Chrome 实例** —— 唯一可脚本化、
 *     无需任何勾选、且不动用户日常 Chrome 的路径（登录态落在那个专属 profile 里，可累积）。
 *
 * 因此本模块提供：定位 chrome 可执行文件（上面 ✔ 那条路要用它来起实例），以及集中声明用户
 * **必须手输**的那个页面地址（它出现在多处提示文案里，写错会让人在浏览器里找不到勾选框 ——
 * "找不到"比"没提示"更糟）。
 *
 * ## 与既有模块的约定一致
 *
 * 候选路径是纯数据、存在性由调用方注入（`gitBashProvider` / `comfyLauncher` 同一做法）——
 * 于是"装在 D 盘""用 SAROS_CHROME_PATH 覆盖"这些情形都能在没有 Electron 的环境里验证。
 */

/**
 * 用户**必须在地址栏手动输入**的页面（"Allow remote debugging for this browser instance" 勾选框在这里）。
 *
 * ⚠ 只能手输：Chrome 忽略从命令行/外部程序传来的 `chrome://` URL（见上方实测），我们无法代开。
 * 多处提示文案共用此常量 —— 它写错会让人在浏览器里找不到勾选框。
 */
export const CHROME_REMOTE_DEBUGGING_PAGE = 'chrome://inspect/#remote-debugging';

/** 环境变量逃生舱：Chrome 装在非标准位置时由用户指定。对齐 `SAROS_GIT_BASH_PATH` 的设计。 */
export const CHROME_PATH_ENV = 'SAROS_CHROME_PATH';

/**
 * Windows 非默认盘兜底。企业环境里把 Chrome 装在 D:\ 而非 C:\ 是常见情况
 * （本仓 `gitBashProvider.ts` 就因为"本机 Git 装在 D 盘"专门加了同样的兜底）。
 * 代价只是几次 existsSync。
 */
const EXTRA_WINDOWS_DRIVES = ['D', 'E', 'F', 'G'];

const WINDOWS_CHROME_REL = '\\Google\\Chrome\\Application\\chrome.exe';

/**
 * 按优先级列出 Chrome 可执行文件候选（**去重、去空**）。
 *
 * 顺序即优先级：用户显式覆盖 → 系统级安装 → 用户级安装 → 非默认盘。
 * 不覆盖 Chromium / Edge：它们的调试页是 `edge://inspect` / `chrome://inspect`，
 * 入口与后续 CDP 流程都不同，混在一起会让"连上了但行为不对"难以归因。
 */
export function chromeExecutableCandidates(
	env: Record<string, string | undefined>,
	platform: string,
): string[] {
	const out: string[] = [];

	const override = env[CHROME_PATH_ENV]?.trim();
	if (override) { out.push(override); }

	if (platform === 'win32') {
		const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
		const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
		out.push(`${programFiles}${WINDOWS_CHROME_REL}`);
		out.push(`${programFilesX86}${WINDOWS_CHROME_REL}`);
		const localAppData = env['LOCALAPPDATA'];
		// 用户级安装（无管理员权限时 Chrome 会装到这里），实测常见。
		if (localAppData) { out.push(`${localAppData}${WINDOWS_CHROME_REL}`); }
		for (const drive of EXTRA_WINDOWS_DRIVES) {
			out.push(`${drive}:\\Program Files${WINDOWS_CHROME_REL}`);
		}
	} else if (platform === 'darwin') {
		out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
	} else {
		out.push(
			'/usr/bin/google-chrome',
			'/usr/bin/google-chrome-stable',
			'/opt/google/chrome/google-chrome',
		);
	}

	// 去重（覆盖项可能与标准路径相同）并剔除空串。
	return [...new Set(out)].filter(p => p.length > 0);
}

/** 取第一个真实存在的候选；都不存在返回 undefined（调用方据此给出"找不到 Chrome"的提示）。 */
export function pickChromeExecutable(
	candidates: readonly string[],
	exists: (path: string) => boolean,
): string | undefined {
	return candidates.find(p => exists(p));
}

// ─── 路线 ✔：自带 user-data-dir 的可调试实例 ────────────────────────────────────

/**
 * 专属调试 profile 的目录（放在 `~/.vssaros/` 下，与 `anysearch.env` 等用户级数据同处）。
 *
 * 为什么是"专属"而不是你的主 profile：主 profile 带调试端口会被 Chrome 直接拒绝，
 * 而**复制**主 profile 又要多占几百 MB~GB、还可能拿到不一致的 cookie（见文件头对照表）。
 * 专属 profile 的代价只是"要在这个窗口里登录一次"，之后登录态会留在里面累积。
 */
export const DEDICATED_PROFILE_DIRNAME = 'browser-profile';

/** 专属调试 profile 的绝对路径。不 import `path`：本模块要保持"渲染器也能 import"（无 Node 依赖）。 */
export function dedicatedProfileDir(homeDir: string, platform: string): string {
	const sep = platform === 'win32' ? '\\' : '/';
	return `${homeDir}${sep}.vssaros${sep}${DEDICATED_PROFILE_DIRNAME}`;
}

/**
 * 拉起可调试 Chrome 的命令行参数。
 *
 * ⚠ `--user-data-dir` **不是可选项**：Chrome 136+ 对**默认** profile 会静默忽略
 * `--remote-debugging-port`（这正是"给快捷方式加了参数却依然连不上"的原因）。带上它，
 * Chrome 才会真的开端口 —— 也就**不需要**用户去勾那个同意框，这是唯一可脚本化的路。
 *
 * `--no-first-run` / `--no-default-browser-check`：专属 profile 首次启动会弹"欢迎/导入数据"
 * 向导与"设为默认浏览器"提示，都会挡住页面并且让端口就绪时间不可预测。
 *
 * `headless` 用**不带 `=new` 的** `--headless`：Chrome 132+ 起它就是"新无头"（CDP 与页面能力
 * 与有窗口一致，只是不显示窗口），而在更老的版本上 `--headless=new` 反而会因不识别而落到有窗口模式。
 * ⚠ 无头下**没法交互式登录** —— 所以默认不开；要在专属 profile 里首次登录时也必须先用有窗口模式。
 */
export function buildDedicatedChromeArgs(profileDir: string, port: number, headless: boolean): string[] {
	const args = [
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${port}`,
		'--no-first-run',
		'--no-default-browser-check',
	];
	if (headless) { args.push('--headless'); }
	return args;
}

// ─── 探测失败时给用户看的引导文案 ──────────────────────────────────────────────

/**
 * 端点探测失败时的**人读引导**：告诉他具体怎么做，而不是只报 "connect failed"。
 *
 * 放在本模块（纯字符串装配、无 electron 依赖）是为了能被单测钉住：这段文案里出现的**页面地址**与
 * **端口**是用户唯一的行动依据 —— 照着手输却找不到那个勾选框，比不给提示更糟。
 *
 * 三个端口数字各有各的用处，**不要合并**：`configuredPort` 是用户能在设置里改的那个（也是我们优先
 * 尝试的那个），`dedicatedPort` 是我们的专属实例实际所在（= 配置端口 + 1，理由见
 * `browserCdp.ts` 的 `dedicatedPortFor`），而那个勾选框只认 9222 —— 三者混为一谈会让用户改错地方。
 */
export function remoteDebuggingHint(options: {
	/** 用户设置的端口（他自己的浏览器应该在这里）。 */
	readonly configuredPort: number;
	/** 我们自行拉起的专属实例所在端口（= 配置端口 + 1）。 */
	readonly dedicatedPort: number;
	/** 底层失败原因，原样带在最前面（不要把真实错误吞掉）。 */
	readonly detail: string;
}): string {
	const { configuredPort, dedicatedPort, detail } = options;
	return `${detail}\n\nChrome 的远程调试端口不可达（期望 ${configuredPort}）。三种开法（按省事程度排序）：`
		+ `\n  ① **什么都不用做**：保持设置里「自动拉起调试实例」为开 —— VsSaros 会在**第一次真正要用浏览器工具时**`
		+ `自行用专属 profile 起一个可调试 Chrome（不需要你开调试，也不需要勾任何同意框）。`
		+ `\n     它跑在端口 ${dedicatedPort}（= 你设置的 ${configuredPort} **+1**）：错开一位是为了不占用 ${configuredPort}，`
		+ `把那个端口留给下面 ② 那条路 —— 否则你日常 Chrome 的开关会绑不上端口，那条路会被静默堵死。`
		+ `\n  ② 也可以继续用你日常的 Chrome：在地址栏**手动输入** ${CHROME_REMOTE_DEBUGGING_PAGE} 并回车，`
		+ `勾选 "Allow remote debugging for this browser instance"。`
		+ `\n     ⚠ 这一步**没法替你做**（两重原因都已实测）：Chrome 会**忽略**从命令行/其他程序传来的 chrome:// URL ——`
		+ `--new-window / 带锚点 / URL 前置 / --app= 四种写法全部只会开出一个空白 New Tab；`
		+ `而那个勾选是 Chrome 的显式同意闸门，只对**当次**实例有效（重启 Chrome 要重勾）。`
		+ `\n     ⚠ 那个开关**没有端口选项**，只会监听默认的 9222（IPv6 形态是 [::1]:9222）—— 所以这条要求`
		+ `「Chrome 调试端口」保持 9222；改成别的值会让它连不上，而我们只会看到"不可达"然后去用专属实例。`
		+ `\n  ③ 或者完全自己动手：用 --remote-debugging-port=${configuredPort} --user-data-dir=<独立目录> 另起一个 Chrome 实例`
		+ `（⚠ 必须带 \`--user-data-dir\`：Chrome 136+ 起不带它时该开关对默认 profile 会被**静默忽略**，`
		+ `这也是"给快捷方式加了参数却连不上"的真正原因）。`
		+ `\n若端口不同，请在「设置 → 工具配置 → 浏览器工具（CDP）」里改「Chrome 调试端口」。`;
}

// ─── 「改用你自己日常的 Chrome」引导卡（2026-09-24）─────────────────────────────
//
// 背景：专属实例（配置端口 +1）是"什么都不用配"的兜底，但它是**空 profile** —— 遇到小红书
// 这类站点只会渲染登录墙（实测：`browser_get_images` 只返回 15 张头像）。更彻底的路是用用户
// 自己那个已登录全部站点的 Chrome，而它需要用户**手动**勾一次同意框（没法自动化，见下方 ①）。
//
// 交付形态：模型调用 `browser_use_my_chrome` → 工具返回一张**聊天卡片**（复用 `clarify` 卡的
// 协议：`__clarify__` + options 即按钮）→ 用户点按钮 → 选择作为用户消息回到模型 → 模型带
// `confirmed` 再调一次 → 工具丢弃旧连接、重新探测、给出结论。全程不需要用户离开聊天框。

/**
 * 引导卡的按钮文案 —— **单一真源**。
 *
 * 为什么必须与 `interpretOwnChromeChoice` 共用同一份字面量：`clarify` 卡协议把选项**按文案
 * 字符串**回传（options 即按钮文案）。两处各写一遍，就会出现"用户明明点了『我已勾选』，
 * 却被识别成取消"——而那个 bug 的表现是"点了没反应"，最难归因。
 */
export const OWN_CHROME_CHOICE_RECHECK = '我已勾选，重新检测';
export const OWN_CHROME_CHOICE_KEEP_DEDICATED = '继续用专属实例';
export const OWN_CHROME_CHOICE_CANCEL = '不用了，取消';

export type OwnChromeChoice = 'recheck' | 'keep-dedicated' | 'cancel';

/** 把卡片回传的选项文案反解成动作。未知/空值一律 `cancel`（**绝不**误触发连接动作）。 */
export function interpretOwnChromeChoice(choice: string | undefined): OwnChromeChoice {
	const v = (choice ?? '').trim();
	if (v === OWN_CHROME_CHOICE_RECHECK) { return 'recheck'; }
	if (v === OWN_CHROME_CHOICE_KEEP_DEDICATED) { return 'keep-dedicated'; }
	return 'cancel';
}

/** 引导卡的问题正文（原样显示给用户）。 */
export function ownChromeGuideQuestion(options: { readonly configuredPort: number }): string {
	return [
		'要改用**你自己日常的 Chrome**（会带上你全部站点的登录态，比专属实例彻底），需要你手动做一次 —— 这一步**没法替你完成**：',
		`  ① 在你自己日常的 Chrome 地址栏**手输** ${CHROME_REMOTE_DEBUGGING_PAGE} 并回车`,
		'     （Chrome 会**忽略**从其它程序传来的 chrome:// 地址，所以只能你手输）；',
		'  ② 勾选 "Allow remote debugging for this browser instance"；',
		`  ③ 保持「Chrome 调试端口」为 ${options.configuredPort} —— 那个勾选框**没有端口选项**，只认它。`,
		'',
		'⚠ 勾选只对**当次** Chrome 实例有效（重启 Chrome 要重勾一次）。',
		'完成后点下面的按钮：我会丢弃旧连接、重新探测，然后接着跑。',
	].join('\n');
}

/** 引导卡点完之后的结论文案。 */
export function ownChromeOutcomeText(
	outcome:
		| { readonly kind: 'connected'; readonly endpoint?: string }
		| { readonly kind: 'not-found'; readonly detail?: string }
		| { readonly kind: 'keep-dedicated' }
		| { readonly kind: 'cancelled' },
	options: { readonly configuredPort: number; readonly dedicatedPort: number },
): string {
	switch (outcome.kind) {
		case 'connected':
			return `✅ 已连上**你自己的 Chrome**${outcome.endpoint ? `（${outcome.endpoint}）` : ''} —— 后续 browser_* 调用都会驱动它，带你全部登录态。`
				+ '现在可以重新读取那个需要登录的页面了。';
		case 'not-found':
			return `⚠ 仍未在 **${options.configuredPort}** 上探测到可调试的 Chrome${outcome.detail ? `（${outcome.detail}）` : ''}。请确认：\n`
				+ `  · 勾选框是在**你自己日常那个** Chrome 里勾的（不是别的实例）；\n`
				+ `  · 「Chrome 调试端口」仍是 ${options.configuredPort}（改成别的值会与那个勾选框错开）；\n`
				+ '  · 勾选后没有重启过 Chrome（重启需重勾）。\n'
				+ `期间我会继续用专属实例（端口 ${options.dedicatedPort}）—— 它没有你的登录态，遇到需要登录的站点仍会是登录墙。`;
		case 'keep-dedicated':
			return `好的，继续用专属实例（端口 ${options.dedicatedPort}）。⚠ 它是**空 profile**：需要登录的站点会看到登录墙，`
				+ '要读正文/配图/视频时仍需先在那个窗口里登录一次（登录态会留在它的 profile 里）。';
		default:
			return '已取消（保持当前浏览器不变）。';
	}
}

