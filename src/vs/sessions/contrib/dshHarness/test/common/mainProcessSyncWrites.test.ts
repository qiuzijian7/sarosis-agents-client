/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★ 主进程**不许出现同步写** —— 2026-10-12 三次"零 CPU 假死"的永久守卫。
 *
 * ## 现场（三次，全部同一栈）
 * `20261011T235147`（02:58:59，空闲）、`20261012T181430`（18:19:05）、`20261012T191746`（19:21:53）：
 * 主进程（Electron browser）的 JS 线程停在 `ntdll!NtWriteFile` ← `KERNELBASE!WriteFile`
 * ← `libuv uv_fs_write`（**同步**文件写）← JS 回调，之后**永不返回**：
 * 窗口 `Responding=False`、13 个进程 CPU 增量全 0、`MainHeartbeat` 停更、inspector/CDP 全部不应答
 * —— 整个 IDE 假死，只能外部结束进程（详见 `code/electron-main/mainHeartbeat.ts` 的头注释）。
 *
 * ## 为什么用源码守卫而不是行为测试
 * 同步写本身**行为正确**（写得进去），只有在"内核 I/O 被挂住"（本机注入了腾讯 iOA 的 DLP
 * 过滤驱动 `TxUmon64.dll`）时才变成全 IDE 假死 —— 单测里永远复现不出内核态挂起。
 * 而这类调用一旦新增就是**不可挽回**的风险面，所以钉在源码层：主进程只许用 `fs.promises`。
 *
 * ## 扫描面（按"会被编进主进程"的形态枚举，不猜）
 * 1. `src/vs` 下所有 `electron-main/` 目录里的 `.ts`（VS Code 约定：这些一律编进主进程）；
 * 2. 由 electron-main 通道直接 import 的 node 侧助手（`agentStudio/node/mediaStore.ts` ←
 *    `mediaStoreChannel.ts`；`agentStudio/node/gitVersionEngine.ts` ← `gitVersionChannel.ts`）；
 * 3. 排除 `*.test.ts`（它们在测试进程里跑，不在应用主进程）。
 *
 * ⚠ 边界（**故意不覆盖**，留给下一批）：`mkdirSync` / `rmSync` / `unlinkSync` / `renameSync` /
 * `mkdtempSync` 与全部同步**读**（`readFileSync` / `statSync` / `readdirSync` / `existsSync`）。
 * 它们同为阻塞调用，但一次改动面太大；本守卫先钉住"真正咬过人"的**数据写**族。
 */

import assert from 'assert';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const VS_ROOT = join(REPO, 'src', 'vs');

/** 同步写家族：这些调用会**在调用线程上**完成写（libuv 同步路径）⇒ 主线程一旦撞上就永久阻塞。 */
const SYNC_WRITE_CALL = /\b(writeFileSync|appendFileSync|writeSync|openSync|truncateSync|fdatasyncSync|fsyncSync|copyFileSync)\s*\(/;

/** 关键文件在扫描面里"必须在场"——枚举一旦坏了就当场失败，而不是空跑变绿。 */
const MUST_BE_SCANNED = [
	'sessions/contrib/agentStudio/electron-main/bridgeStoreChannel.ts',
	'sessions/contrib/agentStudio/electron-main/kbDocConvertChannel.ts',
	'sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts',
];

/** 由 electron-main 直接 import 的 node 助手（不在 `electron-main/` 目录下，但同样跑在主进程）。 */
const MAIN_LOADED_NODE_HELPERS = [
	'sessions/contrib/agentStudio/node/mediaStore.ts',
	'sessions/contrib/agentStudio/node/gitVersionEngine.ts',
];

/** 递归收集 `src/vs` 下所有 `electron-main` 目录里的 `.ts`（排除 `*.test.ts`）。 */
function collectMainProcessSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'electron-main') {
					for (const leaf of collectTsFiles(abs)) {
						out.push(leaf);
					}
				} else if (entry.name !== 'node_modules' && entry.name !== 'out') {
					walk(abs);
				}
			}
		}
	};
	walk(VS_ROOT);
	return out;
}

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectTsFiles(abs));
		} else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			out.push(abs);
		}
	}
	return out;
}

/** 去掉注释行：注释里**提到**某个 API 名不算违规（本仓大量注释在解释这些 API 的取舍）。 */
function codeLines(source: string): { text: string; line: number }[] {
	const out: { text: string; line: number }[] = [];
	const lines = source.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
			continue;
		}
		out.push({ text: lines[i], line: i + 1 });
	}
	return out;
}

/** 扫一个文件，返回违规行（`<相对路径>:<行号> <源码>`）。 */
function findSyncWrites(absPath: string): string[] {
	const rel = absPath.slice(REPO.length + 1).replace(/\\/g, '/');
	return codeLines(readFileSync(absPath, 'utf8'))
		.filter(l => SYNC_WRITE_CALL.test(l.text))
		.map(l => `${rel}:${l.line} ${l.text.trim()}`);
}

suite('main-process sync writes（主进程不许同步写）', () => {

	test('★ 守卫自检：检测器认得出真实调用、且不误报注释（否则守卫会静默失效）', () => {
		assert.ok(SYNC_WRITE_CALL.test("fs.writeFileSync(p, data, 'utf8');"), '真实调用必须命中');
		assert.ok(SYNC_WRITE_CALL.test('await fsp.writeFile(p, data);') === false, '异步写不该命中');
		// 注释行先被剥掉，再交给同一个正则 ⇒ 注释里出现 API 名不会误报
		const lines = codeLines([
			'/** 异步复制：同步 `copyFileSync` 会把主线程整片钉住 */',
			'// fs.writeFileSync(a, b);  ← 历史写法，已改异步',
			'await fsp.copyFile(from, to);',
		].join('\n'));
		assert.deepStrictEqual(lines.map(l => l.line), [3], '注释行应被剥掉，只剩代码行');
		assert.strictEqual(lines.some(l => SYNC_WRITE_CALL.test(l.text)), false, '剥掉注释后不该有命中');
	});

	test('★ 扫描面自证：electron-main 目录真的被枚举到了（防"扫不到任何文件"式空跑）', () => {
		const sources = collectMainProcessSources().map(p => p.slice(VS_ROOT.length + 1).replace(/\\/g, '/'));
		assert.ok(sources.length >= 20, `枚举到的主进程源文件太少（${sources.length} 个）⇒ 枚举逻辑可能坏了`);
		for (const must of MUST_BE_SCANNED) {
			assert.ok(sources.includes(must), `扫描面里少了 ${must}（枚举逻辑坏了 ⇒ 守卫会变成空跑）`);
		}
		assert.strictEqual(sources.some(s => s.endsWith('.test.ts')), false, '测试文件不参与（它们不在应用主进程里跑）');
	});

	test('★ 主进程里不允许出现同步写（写族：writeFileSync / appendFileSync / writeSync / openSync / truncateSync / fsync / fdatasync / copyFileSync）', () => {
		const sources = collectMainProcessSources();
		assert.ok(sources.length > 0, '没扫到任何 electron-main 源文件 —— 守卫不能空跑');
		const violations: string[] = [];
		for (const abs of sources) {
			// 目录名不一定是 electron-main（收集阶段只收 electron-main 与显式助手），这里逐个真扫
			if (!statSync(abs).isFile()) {
				continue;
			}
			violations.push(...findSyncWrites(abs));
		}
		assert.deepStrictEqual(
			violations,
			[],
			'主进程出现同步写 ⇒ 一旦内核 I/O 被挂住就是整个 IDE 假死（2026-10-12 三次现场）：\n'
			+ `${violations.join('\n')}\n`
			+ '改成 `fs.promises` / `fsp.*`（异步走 libuv 线程池）；只读、目录操作等也尽量一并异步化。',
		);
	});

	test('★ 主进程加载的 node 助手同样不许同步写（mediaStore / gitVersionEngine）', () => {
		const violations: string[] = [];
		for (const rel of MAIN_LOADED_NODE_HELPERS) {
			const abs = join(VS_ROOT, rel);
			assert.ok(statSync(abs).isFile(), `${rel} 不存在了 —— 守卫的名单要跟着改（不能静默失效）`);
			violations.push(...findSyncWrites(abs));
		}
		assert.deepStrictEqual(violations, [], `主进程加载的 node 助手出现同步写：\n${violations.join('\n')}`);
	});
});
