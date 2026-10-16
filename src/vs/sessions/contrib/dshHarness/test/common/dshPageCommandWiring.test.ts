/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **聊天页按钮 → IDE** 的接线守卫（2026-10-14 建立）。
 *
 * 为什么要有（现状盘点结论）：dsh 聊天卡片上的每个可点控件最终都变成一条**页面桥命令**
 * （`bridge.openFile(...)` 这类），链子有五段：
 *
 *   ① 页面控件（`dsh-plugins/vssaros-chat-surface/lib/client.*.js` 的 `bridge.<method>(…)`；
 *      2026-10-14 扩面：**插件页**也算 —— 见 `PLUGIN_PAGE_SOURCES` 的登记表）
 *   ② preload 暴露面（`electron-browser/preload-dshView.ts` 的 `method: '<x>'`）
 *   ③ 协议校验（`common/dshPageBridgeProtocol.ts`：`DshPageCommand` 联合 + `validatePageCommand`）
 *   ④ IDE 侧处理器（`dshHarness.contribution.ts` 的 `_handle` **或** `dshChatInstanceHost.ts` 的按 viewId 分发）
 *   ⑤ 处理器里再间接调用的**命令 id**（如 `agentStudio.openUncommittedDiff`，实现在 `extensions/agent-studio`）
 *
 * 实测覆盖情况：①②③ 有组件级/协议级测试，**④⑤ 此前一条测试都没有** —— 而这两段恰好是
 * "点了没反应、日志里也没有"的唯一来源：
 *   · ④ 断：命令加进协议但没人 `case` 它 ⇒ 页面照发、宿主静默丢（`dshChatInstanceHost.ts:193-198` 的注释就写着
 *     「在终端打开没反应」那次是这么查的 ✗）；
 *   · ⑤ 断：命令 id 拼错/换名/扩展没实现 ⇒ 走**回退分支**（`showUncommittedDiff` 会退成"直接打开文件"），
 *     界面看起来"能用"，实际是错的行为 ✗。
 *
 * ⚠ **⑤ 的扫描必须用 fs 扫到 `extensions/agent-studio/out/`**：那份构建产物被 `.gitignore` 挡着，
 *   ripgrep/grep 类搜索**看不见**它 ⇒ 用文本搜索会得出"命令压根没实现"的错误结论（2026-10-14 实测踩过：
 *   差点把正常的 `showUncommittedDiff` 当成死命令 ✗）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs --only dshPageCommandWiring
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL = 'src/vs/sessions/contrib/dshHarness/common/dshPageBridgeProtocol.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts';
const CHAT_HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts';
const PRELOAD = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';
/**
 * ⑥ 段的落点：页面桥命令最终**转成的 IDE 命令**在哪儿（④ 里那些 `commandId` 的实现方 ✓）。
 * ⚠ 这里只读**源码**（不看 `out/`）⇒ 守卫管的是"写法"，产物对不对由编译 + 真机兜 ✓。
 */
const AGENT_STUDIO_CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
/**
 * ⑥ 段的落点之一（2026-10-15，README 5.138「甲」第 1 期）：知识库"命令要的动作"的服务。
 * 搬进这里的动作 ⇒ dsh 引擎下**不再依赖真源视图**（这是那次真机事故的根治方向 ✓）。
 */
const KB_COMMAND_SERVICE = 'src/vs/sessions/contrib/agentStudio/browser/knowledge/kbCommandService.ts';
/** ⑥ 的两份对账面：接管表（谁被插件页接管）＋ 常量表（常量名 → 真实视图 id ✓）。 */
const ACTIVITY_BAR = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshActivityBarContribution.ts';
const CONSTANTS = 'src/vs/sessions/contrib/agentStudio/common/constants.ts';
/** ⑦ 的三方：host 接口（声明）· 设置面板（调用）· 命令服务（提供）✓ */
const KB_SETTINGS_INPUT = 'src/vs/sessions/contrib/agentStudio/browser/kbSettingsEditorInput.ts';
const KB_SETTINGS_PANE = 'src/vs/sessions/contrib/agentStudio/browser/kbSettingsEditorPane.ts';
const CHAT_SURFACE_DIR = 'dsh-plugins/vssaros-chat-surface/lib';
/**
 * **非聊天页**的页面侧调用点（2026-10-14 扩面）：采集面按"调用形态"枚举，不止聊天框。
 *   · `vssaros-agents` 的 Agents 页（`/x/agents`）—— 行内「设置」调 `bridge.openAgentSettings(...)`。
 * ⚠ 加新页时把它的**页面入口文件**登记进来（别只写在注释里 ✗）：漏登记 = 该页的新桥调用不受 ③ 保护。
 */
const PLUGIN_PAGE_SOURCES = [
	'dsh-plugins/vssaros-agents/lib/index.js',
	// 2026-10-15 加：**集成页**（`/x/skills/`）—— 标题栏 ↗ 调 `bridge.openModulePage(location.pathname)`，
	// 置顶主入口调 `bridge.openSkillMarket()`（打开 VsSaros 技能商城，桥 `8 → 9`）。
	// ⚠ 它页面侧刻意把桥对象命名为 `bridge`（不是 `pageBridge` 之类）：本守卫按 `bridge.<方法名>(`
	//   这个**字面形态**采集 ⇒ 改名 = 这两个调用落进盲区（点了没反应、日志也无线索 ✗）。
	'dsh-plugins/vssaros-skills/lib/index.js',
	// 2026-10-15 加：**知识库页**（`/x/kb/`）—— 它的桥调用写在模板串里的内联脚本中，且**两种形态都有**：
	//   `bridge.openFile(…)`（局部别名）与 `window.vssarosDsh.openFile(…)`（直写全局 ✓）。
	//   采集面因此**按两种形态**扫（见 ③ 里的两段正则 ✓）—— 只认一种写法就会整族假阴性 ✓。
	'dsh-plugins/vssaros-kb/lib/index.js',
];
/** 命令 id 的其它可能注册处（扩展那半只在这里；`out/**` 被 gitignore ⇒ 必须显式进扫描面 ✓）。 */
const COMMAND_ROOTS = ['src', 'extensions/agent-studio/src', 'extensions/agent-studio/out'];

/**
 * **允许"没有 IDE 侧处理器"的页面命令**（协议里有、但不由 IDE 处理）：逐条写明归属与理由。
 *
 * ⚠ 只加"确实有人处理、只是不在这两个宿主里"的项；"忘了写 case"不许塞进来 ✗（那正是本守卫要抓的）。
 */
const HANDLED_ELSEWHERE: Record<string, string> = {
	ping: 'Host 侧答（页面桥的存活探测）；页面侧另由 `client.hideBridgePing.js` 遮蔽官方指示器 ⇒ 不需要 IDE 处理器 ✓',
};

/**
 * **核心命令**：字面量不是以 `registerCommand('id')` 形态注册的（VS Code 里常用常量表，例如
 * `TerminalCommandId.Focus = 'workbench.action.terminal.focus'`）⇒ ② 的严格扫描会漏。
 *
 * ⚠ 只登记**核心工作台**命令、且写明它在哪声明（不许拿它当垃圾桶 ✗ —— 2026-10-14 修掉的那个
 * `agentStudio.presetAgent.focus` 就是**不在**本表、又查不到注册处 ⇒ 正是本表要挡住的那类假 id ✓）。
 */
const CORE_COMMAND_IDS: Record<string, string> = {
	revealInExplorer: '核心命令：`src/vs/workbench/contrib/files/browser/fileConstants.ts` 里以常量声明 ✓',
	'workbench.action.terminal.focus': '核心命令：`src/vs/workbench/contrib/terminal/common/terminal.ts` 的 `TerminalCommandId.Focus` 常量 ✓',
};

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉注释（防"注释里写了 case xxx"造成假绿）。 */
function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** 从 `from` 起到 `to` 之前（找不到 `to` 就用全文）—— 限定在一个函数/类型块里，避免全文 `case` 串味。 */
function sliceFrom(text: string, from: string, to?: string): string {
	const start = text.indexOf(from);
	assert.ok(start >= 0, `找不到切片起点：${from}`);
	if (!to) { return text.slice(start); }
	const end = text.indexOf(to, start + from.length);
	return end > start ? text.slice(start, end) : text.slice(start);
}

function matchAll(text: string, re: RegExp): string[] {
	return [...text.matchAll(re)].map(m => m[1]);
}

/** 数据驱动表：页面桥命令 → 谁处理（本测试的核心断言面）。 */
suite('聊天页按钮 → IDE 接线（协议 / preload / 处理器 / 命令 id 四段对账）', () => {

	test('① 协议里的每条页面命令，都必须有 IDE 侧处理器（或写明归属例外）', function () {
		const proto = stripComments(read(PROTOCOL));
		const methods = [...new Set(matchAll(sliceFrom(proto, 'export type DshPageCommand', 'export function validatePageCommand'), /readonly method: '([a-zA-Z]+)'/g))];
		// 防空跑：命令数缩水就红（否则"一个都没扫到"会被当成通过 ✗）
		assert.ok(methods.length >= 12, `DshPageCommand 只扫到 ${methods.length} 条命令 —— 扫描面缩水了，别当成通过 ✗`);

		const contribution = stripComments(read(CONTRIBUTION));
		const handledByContribution = new Set(matchAll(
			sliceFrom(contribution, 'private async _handle('),
			/case '([a-zA-Z]+)':/g,
		));
		const chatHost = stripComments(read(CHAT_HOST));
		const handledByChatHost = new Set(matchAll(chatHost, /e\.command\.method === '([a-zA-Z]+)'/g));
		// 防空跑：两个宿主都得真的扫到东西
		assert.ok(handledByContribution.size >= 8, `_handle 只扫到 ${handledByContribution.size} 个 case —— 处理器改名/改结构了，本守卫要同步 ✓`);
		assert.ok(handledByChatHost.size >= 5, `dshChatInstanceHost 只扫到 ${handledByChatHost.size} 个方法 —— 分发链改了，本守卫要同步 ✓`);

		const orphans = methods.filter(m => !handledByContribution.has(m) && !handledByChatHost.has(m) && !HANDLED_ELSEWHERE[m]);
		assert.deepStrictEqual(orphans, [],
			'这些页面命令**没人处理** ⇒ 页面点了没反应、日志里也没线索（协议加了命令就要接上宿主 ✗）：\n' + orphans.join('\n'));

		// 例外表本身也要诚实：写进来的必须真的在协议里（否则就是过期条目 ✗）
		for (const name of Object.keys(HANDLED_ELSEWHERE)) {
			assert.ok(methods.includes(name), `例外表里的 ${name} 已不在协议里 ⇒ 删掉这条例外 ✓`);
			assert.ok(HANDLED_ELSEWHERE[name].trim().length >= 8, `${name} 的例外理由太短（要写清谁在哪儿处理 ✓）`);
		}
	});

	test('② IDE 处理器里引用的**命令 id** 必须真的有人注册（含 agent-studio 扩展那半）', function () {
		const contribution = stripComments(read(CONTRIBUTION));
		const chatHost = stripComments(read(CHAT_HOST));
		const ids = new Set<string>();
		for (const src of [contribution, chatHost]) {
			for (const id of matchAll(src, /executeCommand(?:<[^>]*>)?\(\s*'([^']+)'/g)) { ids.add(id); }
		}
		// 防空跑：这条链至少引用了 1 个命令 id（现在有 agentStudio.openUncommittedDiff 等）
		assert.ok(ids.size >= 1, `两个处理器里一个 executeCommand('id') 都没扫到 —— 扫描面缩水了 ✗`);

		// 扫命令注册面（fs 直扫，**必须包含 extensions 的 out/**：文本搜索看不见它 ✗）
		// 核心命令走例外表（它们在核心里以常量声明，不在本仓的注册链上 ✓）
		const pending = new Set([...ids].filter(id => !CORE_COMMAND_IDS[id]));
		const walk = (dir: string): void => {
			if (pending.size === 0) { return; }
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (pending.size === 0) { return; }
				if (entry.name === 'node_modules' || entry.name === '.git') { continue; }
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!/\.(ts|js|json)$/.test(entry.name)) { continue; }
				let text: string;
				try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
				for (const id of [...pending]) {
					// 注册/声明的四种形态都认（命令表、`registerCommand`、菜单 `id:`、扩展的 registerCommand ✓）
					if (text.includes(`registerCommand('${id}'`) || text.includes(`registerCommand<`) && text.includes(`>'${id}'`)
						|| text.includes(`id: '${id}'`) || text.includes(`"command": "${id}"`)) {
						pending.delete(id);
					}
				}
			}
		};
		for (const root of COMMAND_ROOTS) {
			if (pending.size === 0) { break; }
			walk(path.join(process.cwd(), root));
		}
		assert.deepStrictEqual([...pending], [],
			'这些命令 id 在仓里找不到注册/声明处 ⇒ 执行时会抛错并走回退分支（界面看着"能用"、行为其实是错的 ✗）：\n'
			+ [...pending].map(id => `  ${id}`).join('\n')
			+ '\n  （注册在扩展里也行 —— 但注意 `extensions/agent-studio/out/` 被 gitignore，文本搜索看不见它 ✓；'
			+ '\n   核心工作台命令若用常量表注册，登记进 CORE_COMMAND_IDS 并写明声明处 ✓）');

		// 例外表也要诚实：登记了却没人用 ⇒ 删掉（防表越攒越像垃圾桶 ✓）
		for (const [id, why] of Object.entries(CORE_COMMAND_IDS)) {
			assert.ok(ids.has(id), `CORE_COMMAND_IDS 里的 ${id} 已不在处理器引用里 ⇒ 删掉这条例外 ✓`);
			assert.ok(why.trim().length >= 10, `${id} 的说明太短（要写清在哪声明 ✓）`);
		}
	});

	test('③ 页面侧 `bridge.<x>(…)` ⊆ preload 暴露面（键名）⊆ 协议校验器，且键名 == 协议方法名', function () {
		// 页面调的是 preload 暴露对象的**键**（`bridge.<key>(…)`）⇒ 对账要拿键名，不是 `invoke({method})` 的值 ✗
		// （2026-10-14 实测：只比 `method:` 值时，把键名改错的突变**不会红** —— 那条口径漏的就是"点了
		//   `bridge.x is not a function`"这类事故本身 ⇒ 换成键名 ✓）。
		const preload = stripComments(read(PRELOAD));
		const apiBlock = sliceFrom(preload, 'const api = {', 'contextBridge.exposeInMainWorld');
		// 暴露面 = `api` 里**值为函数**的键（`bridgeVersion`/`surface`/`sessionId`/`viewId` 这类数据键不算 ✓）
		const exposedKeys = [...apiBlock.matchAll(/^\t\t([a-zA-Z]+):\s*\(/gm)].map(m => m[1]);
		assert.ok(exposedKeys.length >= 8, `preload 只扫到 ${exposedKeys.length} 个可调用键 —— 暴露面改了，本守卫要同步 ✓`);
		const exposed = new Set(exposedKeys);

		// 键名 → 该键 `invoke({ method: '<x>' })` 里的方法名（取键到下一个键之间那段，避免串味）
		const methodByKey = new Map<string, string>();
		const keyStarts = [...apiBlock.matchAll(/^\t\t([a-zA-Z]+):\s*\(/gm)].map(m => ({ key: m[1], at: m.index ?? 0 }));
		for (let i = 0; i < keyStarts.length; i++) {
			const seg = apiBlock.slice(keyStarts[i].at, keyStarts[i + 1]?.at ?? apiBlock.length);
			const method = /method: '([a-zA-Z]+)'/.exec(seg)?.[1];
			assert.ok(method, `preload 的 ${keyStarts[i].key} 没有找到 invoke({ method: … }) ⇒ 它不像一条页面桥命令（本守卫要同步 ✓）`);
			methodByKey.set(keyStarts[i].key, method!);
		}

		const proto = stripComments(read(PROTOCOL));
		const validated = new Set(matchAll(sliceFrom(proto, 'export function validatePageCommand'), /case '([a-zA-Z]+)':/g));
		assert.ok(validated.size >= 12, `validatePageCommand 只扫到 ${validated.size} 个分支 —— 校验器改了，本守卫要同步 ✓`);

		// 键名与协议方法名必须一致（防"键拷错、method 还是别人那条"这种错位）
		const mismatched = [...methodByKey].filter(([key, method]) => key !== method).map(([key, method]) => `${key} → method: '${method}'`).sort();
		assert.deepStrictEqual(mismatched, [],
			'preload 里页面的 API 名与它实际发的协议方法名不一致 ⇒ 页面在调一个"名字像 A、其实是 B"的命令 ✗：\n' + mismatched.join('\n'));

		// 暴露的每条方法都要有协议分支（否则请求会被**静默丢弃**：页面以为发了 ✗）
		const notValidated = [...methodByKey.values()].filter(m => !validated.has(m)).sort();
		assert.deepStrictEqual(notValidated, [],
			'preload 暴露了协议校验器不认的方法 ⇒ 请求会被静默丢弃（页面以为发出了 ✗）：\n' + notValidated.join('\n'));

		// 页面侧：`bridge.<key>(…)` 必须都在暴露面里
		const files = fs.readdirSync(path.join(process.cwd(), CHAT_SURFACE_DIR)).filter(f => /^client.*\.js$/.test(f));
		assert.ok(files.length >= 8, `聊天页面 chunk 只找到 ${files.length} 个 —— 扫描面缩水了 ✗`);
		const calls = new Set<string>();
		for (const f of files) {
			const src = stripComments(fs.readFileSync(path.join(process.cwd(), CHAT_SURFACE_DIR, f), 'utf8'));
			for (const m of matchAll(src, /\bbridge\.([a-zA-Z]+)\(/g)) { calls.add(m); }
		}
		// 2026-10-14：**插件页**（不只是聊天页）也会调页面桥 —— 第一条是 dsh 的 Agents 页 `/x/agents`
		// 行内「设置」（`bridge.openAgentSettings(...)`，打开该 bot 的 Agent 设置编辑器页）。
		// 采集面按**调用形态**枚举（凡 `bridge.<key>(` 明确写出就算，那页的调用写在一段内联脚本字符串里，
		// 正则照样扫得到 ✓）；漏了这一段，这条新接线正好落进本守卫存在的意义里（点了没反应、日志无线索 ✗）。
		for (const rel of PLUGIN_PAGE_SOURCES) {
			const src = stripComments(read(rel));
			let found = 0;
			// ⚠ **两种字面形态都要认** ✗：`bridge.openFile(…)`（局部别名）与 `window.vssarosDsh.openFile(…)`
			//（直写全局 —— kb 页两种混用 ✓）。只认一种 ⇒ 另一族的键名写错照样假绿（本仓的"采集面按
			//注册形态枚举"教训 ✓）。
			// ⚠ 动态取法（`bridge[method](…)`，kb 页的 `openHostPanel` 就是）**扫不到也不该扫** ✗ ——
			//   方法名那时是运行时值；它的接线由协议/preload 两段的对账覆盖 ✓。
			for (const m of matchAll(src, /\bbridge\.([a-zA-Z]+)\(/g)) { calls.add(m); found++; }
			for (const m of matchAll(src, /window\.vssarosDsh\.([a-zA-Z]+)\(/g)) { calls.add(m); found++; }
			assert.ok(found >= 1, `${rel} 一个 bridge 调用都没扫到 —— 采集面缩水了（该页确实有桥调用 ✗）`);
		}
		assert.ok(calls.size >= 8, `只扫到 ${calls.size} 个 bridge 调用 —— 扫描面缩水了 ✗`);
		const notExposed = [...calls].filter(c => !exposed.has(c)).sort();
		assert.deepStrictEqual(notExposed, [],
			'页面调了 preload 没暴露的桥方法 ⇒ 运行时 "bridge.x is not a function"（点击无反应 ✗）：\n' + notExposed.join('\n'));
	});

	test('④ 页面桥命令 → 真源动作：不许**盲转型**取视图（dsh 引擎下同一个视图 id 是插件页）', function () {
		// 2026-10-15（用户报「sideview 里 ⚙ / 🕸 点了没反应」）：链子到 ⑤ 之后还有**第六段** ——
		// 命令 ⇒ 真源动作。`moduleEngine=dsh` 时容器 `agentStudio.knowledgeBase` 与视图 id
		// `agentStudio.knowledgeBaseView` **都交给了 dsh 插件页**（`dshActivityBarContribution.ts` 的
		// `MODULE_VIEW_HOSTS`）⇒ `getViewWithId<KnowledgeBaseViewPane>(…)` 那个泛型是**谎**（运行时是
		// `DshPluginViewPane`）⇒ 调用它的方法就是 `… is not a function` ⇒ 用户看到"点了没反应" ✗。
		//
		// 判据（甲三期做完后的口径）：
		//   ① 知识库视图**一次都不许取**（`getViewWithId(...KB_VIEW_ID)` 与盲转型都算 ✗）；
		//   ② 四个入口的落点**逐个登记** ⇒ 全在 `IKbCommandService`（第 1/2/3 期分别搬的 ✓）。
		// ⚠ 落点表是**白名单**：入口改名 / 换落点 ⇒ 必须回来改这里（否则守卫会静默放行一个"没人接"的入口 ✗）。
		const src = stripComments(read(AGENT_STUDIO_CONTRIBUTION));
		const blindCasts = [...src.matchAll(/getViewWithId<[^>]*>\s*\(\s*AGENT_STUDIO_KB_VIEW_ID\s*\)/g)].length;
		assert.strictEqual(blindCasts, 0,
			`还有 ${blindCasts} 处按知识库视图 id 取视图 ⇒ dsh 引擎下拿到的是插件页、调它的方法必然 TypeError（点了没反应 ✗）`
			+ '；四个入口都已搬进 `IKbCommandService`，不该再取视图 ✓');

		const routes: readonly [entry: string, pattern: RegExp][] = [
			['知识库设置', /IKbCommandService\)\.openSettings\(\)/],
			['关系图谱', /IKbCommandService\)\.openGraph\(\)/],
			['配置文件夹为知识库', /IKbCommandService\)\.addVaultFromFolder\(\)/],
			['删除知识库', /IKbCommandService\)\.removeVaultById\(id\)/],
		];
		for (const [entry, pattern] of routes) {
			assert.ok(pattern.test(src), `入口「${entry}」的落点变了（期望：${pattern}）⇒ 要么改回、要么同步本守卫 ✓`);
		}

		// 服务自己必须注册（忘了 `registerSingleton` ⇒ 命令执行时 "command not found" ⇒ 又是一次"点了没反应" ✗）
		const service = stripComments(read(KB_COMMAND_SERVICE));
		assert.ok(/registerSingleton\(\s*IKbCommandService\s*,\s*KbCommandService/.test(service),
			'`kbCommandService.ts` 里没有 `registerSingleton(IKbCommandService, KbCommandService, …)` ⇒ 命令侧解不出它 ✗');
	});

	test('⑤ 转发类页面命令必须在宿主**留痕**（"点了没反应且日志无线索"是最差的一种）', function () {
		// 2026-10-15（用户报 ⚙/🕸 没反应那次）：`_handle` 里"把活转给别的命令"的那几条（kb 四条 / 两个商城 /
		// Agent 列表）此前**一条日志都没有** ⇒ 真机上只能靠"renderer.log 里没有对应行"倒推，无法区分
		//   · 点击根本没到宿主（页面/preload 那侧断）／
		//   · 到了宿主但转发失败（命令不存在 / 目标层抛错）
		// ⇒ 转发类命令**一律先记一笔** ✓
		// ⚠ 判据口径说清：**该 case 块里至少出现一处 `_logService.<level>(`** ⇒ 钉的是"完全无痕"这一类 ✗；
		//   它**不**要求"入口必留痕"（只在 catch 里记一笔也算过 —— 那是更强的做法，真机排查靠它更省事 ✓）。
		//   之所以只钉这一档：守卫要能被单点突变证伪（摘一条日志仍可能合规 ⇒ 那种突变不该红 ✗）。
		const contribution = stripComments(read(CONTRIBUTION));
		const body = sliceFrom(contribution, 'private async _handle(');
		const labels = [...body.matchAll(/case '([a-zA-Z]+)':/g)].map(m => ({ name: m[1], at: m.index ?? 0 }));
		assert.ok(labels.length >= 8, `_handle 只扫到 ${labels.length} 个 case —— 扫描面缩水了 ✗`);

		const forwarding: string[] = [];
		const silent: string[] = [];
		for (let i = 0; i < labels.length; i++) {
			const block = body.slice(labels[i].at, labels[i + 1]?.at ?? body.length);
			// 只盯"转发到别的层"的那种；纯通知 / 纯打开视图的不算 ✓
			if (!/\.executeCommand\(/.test(block)) { continue; }
			forwarding.push(labels[i].name);
			if (!/_logService\.(info|warn|error)\(/.test(block)) { silent.push(labels[i].name); }
		}
		// 防空跑：现在至少有 5 条转发（kb 两条 case 块 / 两个商城 / Agent 列表）
		assert.ok(forwarding.length >= 5, `只扫到 ${forwarding.length} 条转发类页面命令 —— 扫描面缩水了 ✗`);
		assert.deepStrictEqual(silent, [],
			'这些页面命令**转发了别的命令却没留痕** ⇒ 真机"点了没反应"时无法区分"点击没到宿主"/"转发失败" ✗'
			+ '（补一行 `this._logService.info(`[dshHarness] page <method> ⇒ …`)` 即可 ✓）：\n' + silent.join('\n'));
	});

	test('⑥ **全族**纪律：被 dsh 插件页接管的视图 id，谁都不许拿去"取 Pane"', function () {
		// 2026-10-16：甲把"命令不许取真源视图"落在 kb 上；同一条规则其实是**全族**的 ——
		// `MODULE_VIEW_HOSTS` 里那 10 个 id 在 `moduleEngine=dsh` 时承载的都是 `DshPluginViewPane`，
		// 真源 `*ViewPane` **根本不会实例化** ⇒ 任何 `viewsService.getViewWithId(<那个 id>)` 都是
		// 盲转型、调用其方法必然 `… is not a function` ⇒ 用户看到"点了没反应" ✗（kb 那次真机事故的根因）。
		//
		// 本条与 ④ 的分工：④ 钉 kb **这一处**的落点（谁转发到什么），⑥ 钉**全族**（谁都不许按这些 id 取视图）✓
		// —— 新模块按同样的方式迁移时，④ 要手改白名单，⑥ **自动覆盖** ✓。
		const bar = stripComments(read(ACTIVITY_BAR));
		const hostConsts = [...new Set(matchAll(bar, /pageHost\(\s*([A-Z0-9_]+)\s*,/g))];
		// 防空跑：接管表缩水就红（否则"一个都没扫到"会被当成通过 ✗）
		assert.ok(hostConsts.length >= 10, `接管表只扫到 ${hostConsts.length} 个 pageHost —— 扫描面缩水了 ✗`);

		// 常量名 → 真实 id 字符串（两种形态都要认：字面量 id 与常量名同样是违规写法 ✓）
		const consts = stripComments(read(CONSTANTS));
		const idByName = new Map<string, string>();
		for (const m of consts.matchAll(/export const (\w+) = '([^']+)'/g)) { idByName.set(m[1], m[2]); }
		const takenIds = new Set<string>();
		const missing: string[] = [];
		for (const name of hostConsts) {
			const id = idByName.get(name);
			if (!id) { missing.push(name); continue; }
			takenIds.add(id);
		}
		assert.deepStrictEqual(missing, [],
			'接管表里的这些常量在 `agentStudio/common/constants.ts` 里找不到字面量值 ⇒ 本守卫取不到 id ✗：' + missing.join(', '));

		// 全仓扫"取 Pane"手法：只看 `getViewWithId(...)` / `getActiveViewWithId(...)` 的**实参** ✓
		// ⚠ 跳过 `test/`：守卫自身要写这些常量名与字面量 id ✗（写入即自伤 ⇒ 永久红）
		const offenders: string[] = [];
		const viewCalls = /get(?:Active)?ViewWithId(?:<[^>]*>)?\(\s*([^)]*)\)/g;
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test' || entry.name === 'out') { continue; }
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!entry.name.endsWith('.ts')) { continue; }
				let text: string;
				try { text = stripComments(fs.readFileSync(full, 'utf8')); } catch { continue; }
				if (!text.includes('getViewWithId') && !text.includes('getActiveViewWithId')) { continue; }
				for (const m of text.matchAll(viewCalls)) {
					const arg = m[1];
					const hitName = hostConsts.find(name => arg.includes(name));
					const hitId = [...takenIds].find(id => arg.includes(`'${id}'`) || arg.includes(`"${id}"`));
					if (!hitName && !hitId) { continue; }
					const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
					offenders.push(`${rel}: getViewWithId(${arg.trim()})${hitName ? `  ← ${hitName}` : ''}`);
				}
			}
		};
		walk(path.join(process.cwd(), 'src'));
		assert.deepStrictEqual(offenders, [],
			'按"被 dsh 插件页接管的视图 id"取 Pane ⇒ dsh 引擎下拿到的是插件页、真源视图根本没实例化（点了没反应 ✗）\n'
			+ '  修法：把那批动作**从视图搬进浏览器层服务**（范例 `browser/knowledge/kbCommandService.ts` ✓，README 5.138/5.139）：\n'
			+ offenders.map(o => `  ${o}`).join('\n'));
	});

	test('⑦ 设置面板的 host **契约**：面板用到的每个方法，服务那份 host 都必须提供', function () {
		// 2026-10-16：甲的第三期把 host 从"视图里造"搬成"服务里造" ⇒ 两边一旦不同步，
		// 症状是**运行时**才炸（点 ⚙ 面板渲染到一半 `host.xxx is not a function` ✗）——
		// 而这条链现在**没有视图**能兜（dsh 引擎下正是没有视图的那条路 ✓）⇒ 必须静态钉住。
		// 三向对账：接口声明 ⊇ 面板调用 ⊆ 服务提供（任一向断了都红 ✓）。
		const iface = stripComments(read(KB_SETTINGS_INPUT));
		// ⚠ 结束锚点用"第一个顶格 `}`"（**别**用后面某个声明名：那个声明未必在那个接口之后 ⇒
		//   切到文件尾会把整份实现也算进来，扫出伪方法 `constructor` ✗ —— 第一版就是这么假红的 ✓）。
		const ifaceStart = iface.indexOf('export interface IKbSettingsHost');
		assert.ok(ifaceStart >= 0, '`kbSettingsEditorInput.ts` 里找不到 `export interface IKbSettingsHost` ✗');
		const ifaceEnd = iface.indexOf('\n}', ifaceStart);
		const ifaceBlock = iface.slice(ifaceStart, ifaceEnd > 0 ? ifaceEnd : iface.length);
		const declared = new Set(matchAll(ifaceBlock, /^\t([a-zA-Z]+)\(/gm));
		assert.ok(declared.size >= 15, `IKbSettingsHost 只扫到 ${declared.size} 个方法 —— 接口改了，本守卫要同步 ✓`);

		const pane = stripComments(read(KB_SETTINGS_PANE));
		// 面板里两种写法都要认：`const host = this._host;` 之后用 `host.x(`，以及直接 `this._host.x(` ✓
		const used = new Set([...matchAll(pane, /\bhost\.([a-zA-Z]+)\(/g), ...matchAll(pane, /this\._host\.([a-zA-Z]+)\(/g)]);
		assert.ok(used.size >= 15, `设置面板只扫到 ${used.size} 个 host 调用 —— 扫描面缩水了 ✗`);

		const service = stripComments(read(KB_COMMAND_SERVICE));
		const provided = new Set(matchAll(sliceFrom(service, 'private _buildSettingsHost(', 'async openSettings('), /^\t\t\t([a-zA-Z]+):\s*\(/gm));
		assert.ok(provided.size >= 15, `服务的 _buildSettingsHost 只扫到 ${provided.size} 个键 —— 结构改了，本守卫要同步 ✓`);

		const notDeclared = [...used].filter(name => !declared.has(name)).sort();
		assert.deepStrictEqual(notDeclared, [],
			'设置面板调了 `IKbSettingsHost` 里**没声明**的方法 ⇒ 类型检查本该拦住（多半是字符串拼的调用）✗：\n' + notDeclared.join('\n'));
		const notProvided = [...declared].filter(name => !provided.has(name)).sort();
		assert.deepStrictEqual(notProvided, [],
			'`IKbSettingsHost` 声明了、但**服务那份 host 没提供** ⇒ 点 ⚙ 时面板运行到那一段就崩（`host.x is not a function`）✗\n'
			+ '  （补进 `KbCommandService._buildSettingsHost()` 即可 ✓）：\n' + notProvided.join('\n'));
	});
});
