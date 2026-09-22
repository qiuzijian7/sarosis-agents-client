/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * sessions 贡献「入口清单」不变量 —— **源码级**断言（2026-09-21）。
 *
 * ## 为什么需要这个文件
 *
 * `src/vs/sessions/` 下的 workbench 贡献**不是** glob 自动发现的，而是靠
 * `sessions.common.main.ts` / `sessions.web.main.ts` / `sessions.desktop.main.ts`
 * 三份**手写精选清单**逐条 `import` 加载。于是有一类缺陷：
 *
 *     文件写好了、`registerWorkbenchContribution2` 也调了、编译也没报错，
 *     但**没有任何入口 import 它** ⇒ 构造函数永不执行 ⇒ 命令一个都不注册。
 *
 * 这类缺陷单测测不出来（模块内逻辑全对，错的是"没人加载它"），且现场表现极具误导性：
 *
 *   · 2026-09-21 实测 —— `contrib/sarosPocket/browser/sarosPocket.contribution.ts`
 *     零登记 ⇒ 五条 `sarosPocket.*` 命令全不注册 ⇒ Pocket 侧
 *     `fetchRealSessions()` 每次抛错 ⇒ **手机端会话列表永远空**，
 *     并被误判成"真的没有会话" / "Pocket 前端 bug"（查了一轮前端与 CSS）。
 *   · 同一坑此前已踩过一次 —— `workbench/browser/workbench.zenMode.contribution.js`
 *     （见 `sessions.common.main.ts:16-37` 的注释：侧栏永远停在 48px）。
 *
 * ## 这个不变量守什么
 *
 * 守「**关键贡献必须被入口清单显式登记，且登记路径真实存在**」。
 * 任何人删除/漏加登记行会当场失败，而不是等到真机上手摸。
 *
 * 手法与 `workspaceFolderWriters.test.ts` 一致（扫源码 + 剥行注释 + 元测试防假绿）。
 *
 * 运行（从仓库根）：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/sarosPocket/test/browser/sarosPocketEntry.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** sessions 模块根（扫描基准，相对 `process.cwd()`）。 */
const SESSIONS = 'src/vs/sessions';

/**
 * 三份手写入口清单。
 *
 * 为什么都要看：common 是共享基线，web / desktop 各插自己的平台特有贡献；
 * 只要**任意一份**登记了就算加载到（web 与 desktop 不会同时运行）。
 */
const ENTRY_FILES = [
	'sessions.common.main.ts',
	'sessions.web.main.ts',
	'sessions.desktop.main.ts',
] as const;

/**
 * ★ 必须被入口清单登记的贡献（相对 {@link SESSIONS}，写 `.js` 形态 —— 与 import 语句一致）。
 *
 * 新增条目必须写明「漏登记的后果」，默认答案是「不要新增」。
 */
const MUST_BE_REGISTERED: readonly {
	/** import 语句里的 spec 形态（用于匹配清单） */
	readonly spec: string;
	/** 源文件相对**仓库根**的路径（用于存在性校验）—— zenMode 这类跨模块贡献不在 sessions 下 */
	readonly file: string;
	readonly why: string;
}[] = [
	{
		spec: 'contrib/sarosPocket/browser/sarosPocket.contribution.js',
		file: 'src/vs/sessions/contrib/sarosPocket/browser/sarosPocket.contribution.ts',
		why: 'Pocket 会话桥：漏登记 ⇒ sarosPocket.* 五条命令全不注册 ⇒ 手机端会话列表永远空（2026-09-21 实测）',
	},
	{
		spec: '../workbench/browser/workbench.zenMode.contribution.js',
		file: 'src/vs/workbench/browser/workbench.zenMode.contribution.ts',
		why: 'zenMode 配置唯一注册处：漏登记 ⇒ Layout.restoreParts() 抛错中断 ⇒ 侧栏永远停在 48px（同源历史坑）',
	},
];

/**
 * Pocket 会话桥必须注册的命令 id 全集。
 *
 * 为什么在**上游**钉住：这些 id 是跨仓契约 —— Saros-agents-pocket 用
 * `vscode.commands.executeCommand('sarosPocket.xxx')` 调用；少注册一个，
 * 下游只表现为"该功能静默降级"，极难定位。
 */
const REQUIRED_POCKET_COMMANDS = [
	'sarosPocket.listSessions',
	'sarosPocket.sendRequest',
	'sarosPocket.archiveSession',
	'sarosPocket.getChatContext',
	'sarosPocket.setChatContext',
	// ★ 2026-09-22 双向实时同步新增的三条（漏注册的现场表现同样是"功能静默降级"）：
	//   sendToSession      —— 手机发的消息进真实会话（桌面聊天框才会同步）
	//   readSessionEvents  —— 按游标增量读（手机端实时看桌面正在跑的消息）
	//   readSessionHistory —— 按窗口读历史（手机端「载入更早的消息」）
	'sarosPocket.sendToSession',
	'sarosPocket.readSessionEvents',
	'sarosPocket.readSessionHistory',
] as const;

const SAROS_POCKET_CONTRIB = 'contrib/sarosPocket/browser/sarosPocket.contribution.ts';

/** 去掉**整行** `//` 注释 —— 源码级不变量只看代码（与 workspaceFolderWriters.test.ts 同法）。 */
function stripComments(src: string): string {
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 读取三份入口清单并拼接（剥离注释，避免注释里提到某文件就被误判为已登记）。 */
function readEntrySources(): string {
	const root = path.join(process.cwd(), SESSIONS);
	let merged = '';
	for (const name of ENTRY_FILES) {
		const file = path.join(root, name);
		assert.ok(fs.existsSync(file), `入口清单不存在（路径基准变了？）：${file}`);
		merged += stripComments(fs.readFileSync(file, 'utf8')) + '\n';
	}
	return merged;
}

/** 判断某贡献 spec 是否被任意入口清单 import。 */
function isRegistered(entrySrc: string, spec: string): boolean {
	// 直接按 spec 原样匹配：清单里可能是 `./contrib/...`（同模块）或
	// `../workbench/...`（跨模块），两种都原样出现在 import 字符串里。
	return entrySrc.includes(spec);
}

/** 取出 contribution 文件里所有 `static readonly ID = 'xxx'` 声明的命令 id。 */
function declaredCommandIds(src: string): string[] {
	const ids: string[] = [];
	const re = /static\s+readonly\s+ID\s*=\s*['"]([^'"]+)['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) { ids.push(m[1]); }
	return ids;
}

suite('sessions 贡献入口清单 — 登记不变量', () => {

	test('元测试：入口清单可读，且确实含已知登记项（扫描基准未失效）', () => {
		const src = readEntrySources();
		// 若连这些基线项都扫不到，说明读错文件 / 注释剥离过头 —— 必须红，不能假绿。
		assert.ok(
			src.includes('contrib/memory/browser/memory.contribution.js'),
			'入口清单里应含 memory.contribution —— 扫描基准或注释剥离失效了',
		);
		assert.ok(
			src.includes('services/sessions/browser/sessionsManagementService.js'),
			'入口清单里应含 sessionsManagementService —— 扫描基准失效了',
		);
	});

	test('★★ 关键贡献必须被入口清单登记（漏登记 = 命令永不注册）', () => {
		const entrySrc = readEntrySources();
		const missing = MUST_BE_REGISTERED.filter(e => !isRegistered(entrySrc, e.spec));
		assert.deepStrictEqual(
			missing.map(e => e.spec),
			[],
			'这些贡献没有被任何 sessions 入口清单 import —— 文件存在 ≠ 被加载，' +
			'其构造函数永不执行、命令永不注册。请在 sessions.common.main.ts 补上 import。' +
			`漏登记：${missing.map(e => `${e.spec}（${e.why}）`).join('; ')}`,
		);
	});

	test('★ 登记的 import 路径必须真实存在（路径写错同样静默失效）', () => {
		for (const entry of MUST_BE_REGISTERED) {
			const tsFile = path.join(process.cwd(), entry.file);
			assert.ok(
				fs.existsSync(tsFile),
				`登记的贡献文件不存在：${tsFile}（import 写错也不会编译报错，只在运行时静默失效）`,
			);
		}
	});

	test('★★ sarosPocket 必须注册全部会话桥命令（少一个 = 下游静默降级）', () => {
		const file = path.join(process.cwd(), SESSIONS, SAROS_POCKET_CONTRIB);
		assert.ok(fs.existsSync(file), `会话桥贡献文件不存在：${file}`);
		const src = stripComments(fs.readFileSync(file, 'utf8'));
		const ids = declaredCommandIds(src);
		const missing = REQUIRED_POCKET_COMMANDS.filter(id => !ids.includes(id));
		assert.deepStrictEqual(
			missing,
			[],
			'会话桥命令 id 缺失 —— Pocket 侧 executeCommand 会失败并静默降级。' +
			`已注册：${ids.join(', ')}；缺失：${missing.join(', ')}`,
		);
	});

	test('★ 跨仓契约：Pocket 调用的命令 id 必须都在上游注册过', () => {
		// Pocket 是**独立仓库**（默认与 VsSaros 同级目录）。目录不在时跳过 ——
		// 不能因为没 clone 就把上游 CI 变红。
		const pocketRoot = path.resolve(process.cwd(), '..', 'saros-agents-pocket');
		const bridgeFile = path.join(pocketRoot, 'lib', 'bridge.mjs');
		if (!fs.existsSync(bridgeFile)) {
			return; // 环境里没有 Pocket 仓：跳过
		}

		const upstreamIds = declaredCommandIds(stripComments(
			fs.readFileSync(path.join(process.cwd(), SESSIONS, SAROS_POCKET_CONTRIB), 'utf8'),
		));

		const bridgeSrc = stripComments(fs.readFileSync(bridgeFile, 'utf8'));
		const called = new Set<string>();
		const re = /executeCommand\(\s*['"](sarosPocket\.[^'"]+)['"]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(bridgeSrc)) !== null) { called.add(m[1]); }

		assert.ok(
			called.size > 0,
			'Pocket 的 bridge.mjs 里没扫到任何 sarosPocket.* 调用 —— 判据失效了（不是"契约已废弃"）',
		);

		const unknown = [...called].filter(id => !upstreamIds.includes(id));
		assert.deepStrictEqual(
			unknown,
			[],
			'Pocket 调用了上游未注册的命令 —— 跨仓契约漂移，现场表现为功能静默降级。' +
			`上游已注册：${upstreamIds.join(', ')}；Pocket 调用但未注册：${unknown.join(', ')}`,
		);
	});
});
