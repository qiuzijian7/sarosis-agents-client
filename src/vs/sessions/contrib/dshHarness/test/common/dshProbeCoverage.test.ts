/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 探针覆盖守卫（`poc/dsh-p0/scripts/` ↔ `run-all.mjs`）。
 *
 * **为什么有这条**（2026-10-12 现场）：`p3-06` 这个探针**早就跑不过**了 —— 插件后来在顶层角色里多注册
 * 了一个服务（`sessionProjections`），而探针的 fake ctx 没跟上 ⇒ 取到 `undefined` 直接抛，
 * **一行断言都没跑** ✗。它明明写着 `report(results)`、也明明在 `run-all.mjs` 的列表里 ✓，
 * 可完整跑要十几分钟 ⇒ 事实上没人跑 ⇒ 烂了很久没人知道 ✗。同一轮还发现 `p3-09` 里一句**恒假的死分支**
 * （`另有 N 个` 的判据用的是已被 limit 截断的数组），也只有"真去跑一次"才抓得到 ✓。
 *
 * **这条守卫的能力边界**（写清楚，别指望它干别的）：它**只读文本、跑得飞快**，能挡住的是
 * 「新写的探针没人跑」；它**挡不住**「插件改了、探针没跟上」（那必须真跑 ✗）—— 那一半交给
 * `node poc/dsh-p0/scripts/run-all.mjs --fast`（只跑明确标了"不需要真机 Host"的几项，几秒到几十秒 ✓）。
 *
 * **口径**：凡是**带 `report(results)` 的脚本都算探针**（没有它的是一次性工具/库，不受此约束）。
 * 每个探针必须**要么**出现在 `run-all.mjs` 的列表里、**要么**进下面的排除表并写明理由 ——
 * **没有理由的排除就是"忘了跑"** ✓。
 */

import assert from 'assert';
import * as fs from 'fs';
import { join } from '../../../../../base/common/path.js';

/** 相对仓库根：探针目录。`repoRoot()` 的判据就靠它是否存在于 `process.cwd()`。 */
const SCRIPTS_REL = join('poc', 'dsh-p0', 'scripts');

/** `report()` 的**定义**就在这里（它是库、不是探针）⇒ 检测探针时要跳过它。 */
const LIBRARY_FILES = ['lib.mjs'];

/** 明确不进 `run-all` 的探针：**每条都必须给理由**（没理由的排除 = 忘了跑）。 */
const EXCLUDED: readonly [file: string, why: string][] = [
	['workbench-e2e.mjs', '真 App 整链 e2e：要 `npm run watch` 在跑 + out/ 新鲜 + 真 electron，属手动跑'],
	// 2026-10-18：`p3-120-popout-parity.mjs` **不放这里** ✗ —— 它是 parity **取证器**（只 dump 不断言、
	//   永远 exit 0），文件里没有 `report(results)` ⇒ `probeFiles()` 本来就不会把它算成探针 ✓。
	//   把它列进排除表反而会踩本守卫的反向断言（「排除表里写了非探针」）✗ —— 实测就是这么红的。
	['workbench-e2e-restart.mjs', '同上，且它会重启工作台（会打断正在用的人）'],
	// 2026-10-12：真机端到端骨架（真 Host + inline mock 模型/网关 + 临时数据根，不碰用户 profile 与记忆库）。
	// ⚠ 2026-10-13 **已转绿并移出本表**（13/13）—— 当时写的转绿条件是"profile 干净"，而真因比它更深，
	// 是**三层叠加**（细节见探针头注释与 `run-all.mjs` 的登记备注）：
	//   ① 复用了被 6 个探针共用的 `p3headless`，其中 codebase / workflow 的 `file:` 指向**源码目录**
	//      ⇒ `failed to import` ⇒ **整条回合跑不完**（不是"少两个插件"，是 12 条判据集体红 ✗）；
	//   ② **`spawnSync` 同步阻塞父进程事件循环** ⇒ 同进程内的 mock HTTP server 永远无人应答 ⇒ 挂到超时
	//      （现象是"dsh 零输出 + mock 收到的请求 = []"，极难反推 ✗）；
	//   ③ mock 的收尾判据依赖"最后一条 user 之后有没有 tool_calls"，而 headless 链路上 dsh 会追加一条
	//      runtime-context 用户消息 ⇒ 判据恒假 ⇒ 无限反复发 tool_call（同 `mock-llm.mjs` 记的坑 ✓）。
	// 修法：独占 profile `p3memory` + 异步 `spawn` + 整会话计数判据 ✓。
];
// ⚠ 2026-10-12 备注：`p3-30-preset-delivers-tools.mjs` 曾一度列入本表（它在 headless app 里无法验证
// `agent-preset-registry` ✗）。后来把它改成**两态自适应** ✓ —— 环境读注册表就走硬断言 ✓、
// 忽略它就断言**降级行为** ✓（并把转绿条件写进断言名 ✓）⇒ 可以正常进 `run-all.mjs` ✓，
// 不再需要"靠排除表 + 人工判断转绿时机" ✗。细节见 `doc/dsh-shell-contract.html` §8 ③ 与 `p3-29`。

function repoRoot(): string | undefined {
	return fs.existsSync(join(process.cwd(), SCRIPTS_REL)) ? process.cwd() : undefined;
}

function scriptPath(root: string, file: string): string {
	return join(root, SCRIPTS_REL, file);
}

/** 目录里所有"像探针"的脚本（带 `report(results)`，且不是库）。 */
function probeFiles(root: string): string[] {
	return fs.readdirSync(scriptPath(root, ''))
		.filter(file => file.endsWith('.mjs') && !LIBRARY_FILES.includes(file))
		.filter(file => fs.readFileSync(scriptPath(root, file), 'utf8').includes('report(results)'))
		.sort();
}

function readRunner(root: string): string {
	return fs.readFileSync(scriptPath(root, 'run-all.mjs'), 'utf8');
}

/**
 * `run-all.mjs` 里**选择集**引用到的脚本名。两种形态都要认（runner 在 2026-10-19 被重写过）：
 *   · 旧：`'scripts/xxx.mjs'` 字面量（扁平列表）；
 *   · 新：`GROUPS = { …: ['xxx.mjs', …] }` 里的**裸文件名**。
 *
 * ⚠ 只认一种形态的后果是**整族假阴性**：实测（2026-10-20）只认旧形态 ⇒ 引用数 0 ⇒
 *   140+ 条探针全被判"没进 run-all"，于是"列表被改坏了"与"每个探针都要被覆盖"两条一起假红。
 *   教训同 `feedback_static_scan_surface`：采集面按**注册形态**枚举。
 */
function referencedScripts(runner: string): string[] {
	const legacy = [...runner.matchAll(/'scripts\/([\w.-]+\.mjs)'/g)].map(m => m[1]);
	const groupsBlock = /const GROUPS = \{[\s\S]*?\n\};/.exec(runner)?.[0] ?? '';
	const grouped = [...groupsBlock.matchAll(/'([\w.-]+\.mjs)'/g)].map(m => m[1]);
	return [...new Set([...legacy, ...grouped])];
}

/** runner 是否走"目录自动发现 + `--all` 覆盖全部"的形态（2026-10-19 起）。 */
function autoDiscoversAll(runner: string): boolean {
	return runner.includes('readdirSync(SCRIPTS_DIR)') && runner.includes('files = allProbes');
}

/** 自动发现认哪些前缀（只有写进这条正则的批次才会被 `--all` 跑到）。 */
function autoCovered(file: string): boolean {
	// 与 runner 的 `/^(?:p0|p3)-.*\.mjs$/` 同口径：改批次必须同步改这里
	return /^(?:p0|p3)-/.test(file);
}

/** 明确标了 `{ fast: true }` 的脚本名（旧形态的 `--fast` 组；新 runner 没有这个概念）。 */
function fastScripts(runner: string): string[] {
	return [...runner.matchAll(/'scripts\/([\w.-]+\.mjs)'\][^\n]*\{ fast: true \}/g)].map(m => m[1]);
}

/**
 * 已知**需要真机 Host / 真 App** 的探针前缀（从 `run-all.mjs` 的分组与探针自身 import 得来）。
 * 它们**不许**被标 `fast`：`--fast` 静默少跑 ⇒ 假绿，比红更糟 ✗。
 */
// ⚠ 前缀要带尾横线（`p3-10-`）：裸写 `p3-10` 会把 p3-101/p3-102 也撞上（startsWith 无前缀边界 ✗
//   —— 2026-10-16 实测：两个进程内探针被误判"要真机" ⇒ 这条守卫假红 ✗）。
const HOSTY_PREFIXES = ['p0-01-', 'p0-04-', 'p0-08-', 'p0-22-', 'p0-07-', 'p3-01-', 'p3-04-', 'p3-05-', 'p3-06-',
	'p3-07-', 'p3-08-', 'p3-09-', 'p3-10-', 'p3-11-', 'p3-12-', 'p3-13-', 'p3-14-', 'p3-16-', 'p3-17-', 'p3-18-',
	'p3-20-', 'p3-117-', 'p3-118-', 'p3-119-', 'p3-121-', 'workbench'];

/**
 * **实测慢到不能进 `--fast`** 的项（进程内 ≠ 快 ✗）。`p0-11` 要真跑 dsh CLI 的 install/remove 子命令，
 * 实测 **604s** —— 放进 `--fast` 就等于 `--fast` 也得十几分钟，那这条路就白设了 ✓。
 * 它同时需要**放宽超时**（默认 600s 会以 `timeout` 的样子变红 ✗，那是假红 ✓）。
 */
const SLOW_PREFIXES = ['p0-11'];

suite('dshProbeCoverage（探针必须被 run-all 覆盖）', () => {
	test('★ 每个探针都能被 run-all 跑到（在分组里 / 自动发现覆盖 / 进排除表并写明理由）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const runner = readRunner(root!);
		const referenced = referencedScripts(runner);
		const auto = autoDiscoversAll(runner);
		const missing = probeFiles(root!).filter(file => {
			if (EXCLUDED.some(([name]) => name === file)) { return false; }
			if (referenced.includes(file)) { return false; }
			// 自动发现形态下，写进发现正则的批次（p0/p3）由 `--all` 覆盖 ⇒ 不必逐条登记；
			// 其它前缀（workbench-e2e 那种）跑不到 ⇒ 必须显式引用或进排除表。
			return !(auto && autoCovered(file));
		});
		assert.deepStrictEqual(missing, [],
			`这些探针 run-all 跑不到（会像 p3-06 那样悄悄腐烂）：${missing.join(', ')}`);
	});

	test('★ run-all 引用到的脚本都真实存在（改名/删文件后列表不许留幽灵）', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const referenced = referencedScripts(readRunner(root!));
		assert.ok(referenced.length >= 20, `run-all 的列表看起来被改坏了：只引用 ${referenced.length} 个脚本`);
		const ghosts = [...new Set(referenced)].filter(file => !fs.existsSync(scriptPath(root!, file)));
		assert.deepStrictEqual(ghosts, [], `run-all 引用了不存在的脚本：${ghosts.join(', ')}`);
	});

	test('★ 排除表不许腐烂：每条都得是真探针、真有理由、且不与 run-all 打架', function () {
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const probes = new Set(probeFiles(root!));
		const referenced = referencedScripts(readRunner(root!));
		for (const [file, why] of EXCLUDED) {
			assert.ok(probes.has(file), `排除表里的 ${file} 不是探针（或已改名 / 已删除）——请同步排除表`);
			assert.ok(!referenced.includes(file), `${file} 既在排除表、又在 run-all 里：两处口径打架`);
			assert.ok(why.trim().length >= 8, `${file} 的排除理由太短，等于没写理由`);
		}
	});

	test('★ 快速通道必须在（--fast 或"默认分组"），且不许把整目录当默认', function () {
		// 这条只钉**形状**，不假装能判断"某脚本到底要不要 Host"（那得读脚本、还判不准 ✗）。它挡的是：
		// ① 快速通道被整条删掉（症状：又回到"十几分钟没人跑"）；② 默认变成全量（症状：一跑就撞真机项 ⇒ 没人跑）。
		// 2026-10-19 runner 重写成"分组选择集"形态 ⇒ `--fast` 被 `--group`（默认 agents）取代，两态都要认。
		const root = repoRoot();
		if (!root) {
			this.skip();
		}
		const runner = readRunner(root!);

		if (runner.includes('--fast')) {
			const fast = fastScripts(runner);
			assert.ok(fast.length >= 3, `--fast 组至少要有几项，实际 ${fast.length}：${fast.join(', ') || '（空）'}`);
			const wronglyMarked = fast.filter(file => HOSTY_PREFIXES.some(prefix => file.startsWith(prefix)));
			assert.deepStrictEqual(wronglyMarked, [],
				`这些项需要真机 Host/真 App，不许标 fast（会被 --fast 静默跳过 ⇒ 假绿）：${wronglyMarked.join(', ')}`);
			const tooSlowInFast = fast.filter(file => SLOW_PREFIXES.some(prefix => file.startsWith(prefix)));
			assert.deepStrictEqual(tooSlowInFast, [],
				`这些项**实测极慢**（进程内 ≠ 快），放进 --fast 会让这条路失去意义：${tooSlowInFast.join(', ')}`);
			return;
		}

		// 新形态：默认必须落到**某个非空分组**（而不是 `--all`），且要能跳过浏览器项。
		const defaultGroup = /const group = valueOf\('--group'\) \?\? \(has\('--all'\) \? '' : '([\w-]+)'\)/.exec(runner)?.[1];
		assert.ok(defaultGroup, 'run-all.mjs 必须有一个默认分组（否则一跑就是全量 ⇒ 没人跑）');
		assert.ok(runner.includes(`\t${defaultGroup}: [`), `默认分组 ${defaultGroup} 必须在 GROUPS 里显式列出`);
		assert.ok(runner.includes('--skip-browser'), '必须保留 --skip-browser（浏览器项在某些环境根本起不来）');

		const groupBlock = new RegExp(`\\t${defaultGroup}: \\[([\\s\\S]*?)\\n\\t\\]`).exec(runner)?.[1] ?? '';
		const defaults = [...groupBlock.matchAll(/'([\w.-]+\.mjs)'/g)].map(m => m[1]);
		assert.ok(defaults.length >= 3, `默认分组至少要有几项，实际 ${defaults.length}`);
		// 默认组里若有"要真机"的项，就必须留下能把它摘掉的入口（--filter / --skip-browser），
		// 否则这条快速通道在缺环境时整条不可用 ⇒ 又回到"没人跑"。
		const hostyInDefault = defaults.filter(file => HOSTY_PREFIXES.some(prefix => file.startsWith(prefix)));
		if (hostyInDefault.length > 0) {
			assert.ok(runner.includes('--filter') || runner.includes('--skip-browser'),
				`默认分组含需要真机的项（${hostyInDefault.join(', ')}），但 runner 没有 --filter/--skip-browser 可摘掉它们`);
		}
	});
});
