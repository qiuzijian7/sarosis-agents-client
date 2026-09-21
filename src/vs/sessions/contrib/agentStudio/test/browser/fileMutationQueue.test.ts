/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 按文件串行的写互斥队列回归测试（2026-09-21，对齐 pi `withFileMutationQueue`）。
 *
 * 该模块的价值在「恢复主循环并行时不出丢更新」——所以测试必须钉住**并发语义**本身：
 *  1. 同一文件键**严格串行**（同一时刻最多 1 个任务在跑）；
 *  2. **不同文件键并行**（锁粒度是文件，不是全局 —— 否则退化成"全局串行"）；
 *  3. 前一个任务**失败不阻塞**后一个（否则一次 patch 失败会把该文件后续写入挂死 ✗）；
 *  4. 异常/返回值**原样透传**给调用方（工具层判定失败依赖它）；
 *  5. 队尾**释放**（Map 不能无界增长）；
 *  6. 键归一（分隔符 / Windows 大小写 / 相对↔绝对 / realpath）—— 归一不到位等于没锁。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/fileMutationQueue.test.ts
 */
import assert from 'assert';
import {
	withFileMutationQueue,
	normalizeMutationKey,
	resolveToolMutationKey,
	pendingFileMutationQueueCount,
	__resetFileMutationQueuesForTest,
	FILE_MUTATING_TOOL_PATH_ARG,
} from '../../common/fileMutationQueue.js';

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

suite('fileMutationQueue — 并发语义', () => {

	setup(() => { __resetFileMutationQueuesForTest(); });

	test('★★★ 同一文件键严格串行（同一时刻最多 1 个任务在跑）', async () => {
		let active = 0;
		let maxActive = 0;
		await Promise.all(Array.from({ length: 4 }, () => withFileMutationQueue('/same.ts', async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await delay(2);
			active--;
		})));
		assert.strictEqual(maxActive, 1, '同键任务出现了重叠执行 ⇒ 队列无效（丢更新 ✗）');
	});

	test('★★★ 不同文件键并行（锁粒度是文件，不是全局）', async () => {
		let active = 0;
		let maxActive = 0;
		const task = () => async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await delay(5);
			active--;
		};
		await Promise.all([
			withFileMutationQueue('/a.ts', task()),
			withFileMutationQueue('/a.ts', task()),
			withFileMutationQueue('/b.ts', task()),
			withFileMutationQueue('/b.ts', task()),
		]);
		assert.strictEqual(maxActive, 2, '两个不同文件应各自并行（每组最多 1 个）⇒ 期望同时 2 个');
	});

	test('★★★ 严格 FIFO：后一个任务必须等前一个结束（能看到前一个的副作用）', async () => {
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const p1 = withFileMutationQueue('/f.ts', async () => {
			order.push('t1-start');
			await gate;
			order.push('t1-end');
			return 1;
		});
		const p2 = withFileMutationQueue('/f.ts', async () => { order.push('t2'); return 2; });

		// 让微任务跑几轮：t2 绝不能在 t1 结束前开始
		for (let i = 0; i < 5; i++) { await Promise.resolve(); }
		assert.deepStrictEqual(order, ['t1-start'], 't2 在 t1 结束前启动了 ⇒ 存在读-改-写交错 ✗');

		release();
		assert.strictEqual(await p1, 1);
		assert.strictEqual(await p2, 2);
		assert.deepStrictEqual(order, ['t1-start', 't1-end', 't2']);
	});

	test('★★★ 前一个任务失败**不阻塞**后一个（否则一次失败就挂死该文件）', async () => {
		const failing = withFileMutationQueue('/g.ts', async () => { throw new Error('boom'); });
		await assert.rejects(failing, /boom/, '异常必须原样透传给调用方 ✗');
		const next = withFileMutationQueue('/g.ts', async () => 'ok');
		assert.strictEqual(await next, 'ok', '前序失败后，同文件的下一个任务仍必须执行 ✗');
	});

	test('★ 队尾释放：任务结束后不留条目（Map 不能无界增长）', async () => {
		let release!: () => void;
		const p = withFileMutationQueue('/p.ts', () => new Promise<void>(r => { release = r; }));
		await Promise.resolve();
		assert.strictEqual(pendingFileMutationQueueCount(), 1, '在飞的任务应占用 1 个条目');

		release();
		await p;
		await delay(0);
		assert.strictEqual(pendingFileMutationQueueCount(), 0, '任务结束后必须释放条目 ✗');
	});
});

suite('fileMutationQueue — 键归一', () => {

	test('★ 分隔符统一 + 折叠重复分隔符 / `./` + 去尾斜杠', () => {
		assert.strictEqual(normalizeMutationKey('a\\b\\c.ts'), 'a/b/c.ts');
		assert.strictEqual(normalizeMutationKey('a//b/./c'), 'a/b/c');
		assert.strictEqual(normalizeMutationKey('/a/b/'), '/a/b');
		assert.strictEqual(normalizeMutationKey('  /a/b.ts  '), '/a/b.ts');
	});

	test('★ Windows 形状路径大小写不敏感（C:/Users/A 与 c:/users/a 必须同键）', () => {
		assert.strictEqual(normalizeMutationKey('C:\\Users\\Me\\A.ts'), normalizeMutationKey('c:/users/me/a.ts'));
		// POSIX 大小写敏感：不能折叠（那是两个不同文件）
		assert.notStrictEqual(normalizeMutationKey('/usr/Me/A.ts'), normalizeMutationKey('/usr/me/a.ts'));
	});

	test('★ 只有文件写工具（patch / file_write）映射到路径字段', () => {
		assert.strictEqual(FILE_MUTATING_TOOL_PATH_ARG.get('patch'), 'path');
		assert.strictEqual(FILE_MUTATING_TOOL_PATH_ARG.get('file_write'), 'path');
		assert.strictEqual(FILE_MUTATING_TOOL_PATH_ARG.get('file_read'), undefined, '只读工具不该进队列 ✗');
	});
});

suite('fileMutationQueue — resolveToolMutationKey', () => {

	test('★★★ 非写工具 / 无路径 ⇒ undefined（必须直通，不能全局串行）', async () => {
		assert.strictEqual(await resolveToolMutationKey('file_read', { path: 'a.ts' }, {}), undefined);
		assert.strictEqual(await resolveToolMutationKey('patch', {}, {}), undefined);
		assert.strictEqual(await resolveToolMutationKey('patch', { path: '   ' }, {}), undefined);
		assert.strictEqual(await resolveToolMutationKey('patch', undefined, {}), undefined);
	});

	test('★★★ 相对路径必须拼 root —— 相对与绝对两种写法落到同一个键', async () => {
		const rel = await resolveToolMutationKey('patch', { path: 'src/a.ts' }, { rootPath: 'C:\\ws' });
		const abs = await resolveToolMutationKey('patch', { path: 'C:\\ws\\src\\a.ts' }, { rootPath: 'C:\\ws' });
		assert.strictEqual(rel, abs, '同一文件的相对/绝对写法必须同键（否则等于没锁）✗');
		assert.strictEqual(rel, 'c:/ws/src/a.ts');
	});

	test('★★★ realpath 优先（符号链接/别名归一）', async () => {
		const key = await resolveToolMutationKey('file_write', { path: 'C:/link/a.ts' }, {
			rootPath: 'C:/ws',
			realpath: async () => 'C:/real/a.ts',
		});
		assert.strictEqual(key, 'c:/real/a.ts');
	});

	test('★ realpath 抛错 / 返回 undefined ⇒ 退化为词法键（绝不因此让工具失败）', async () => {
		const throwing = await resolveToolMutationKey('patch', { path: '/ws/a.ts' }, {
			realpath: async () => { throw new Error('ENOENT'); },
		});
		assert.strictEqual(throwing, '/ws/a.ts');
		const undef = await resolveToolMutationKey('patch', { path: '/ws/a.ts' }, {
			realpath: async () => undefined,
		});
		assert.strictEqual(undef, '/ws/a.ts');
	});
});
