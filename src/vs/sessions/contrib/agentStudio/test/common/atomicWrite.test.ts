/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ATOMIC_WRITE_POSTFIX, writeFileAtomicSafe } from '../../common/atomicWrite.js';

/**
 * 共享原子写 helper（2026-09-15，P0-2）。
 *
 * 背景：本项目的关键 JSON（会话本体/索引、检查点索引/快照、`workspaces.json`）都是
 * **整文件覆盖写**且**启动即读**，普通 `writeFile` 的「截断 + 写」在崩溃/断电/OOM 时会留下
 * 截断 JSON ⇒ 用户看到"历史没了 / 工作区列表空了"。此前只有 `_writeSessionIndex` 一处做了
 * temp+rename，其余都漏了 ⇒ 抽成本 helper 统一。
 *
 * ⚠ 关键约束：`writeFile(..., { atomic })` 在 provider 不具备 `FileAtomicWrite` 能力时会
 * **直接 throw**（`platform/files/common/fileService.ts`）⇒ helper 必须**先探能力**，
 * 否则「加了保护」反而变成「写入失败」。这两个分支就是本测试要钉住的。
 */
suite('atomicWrite（共享原子写 helper）', () => {

	/** 极简 fake IFileService：只记录 writeFile 收到的 options。 */
	function makeFakeFs(capable: boolean): { fs: IFileService; calls: Array<{ uri: string; options: unknown }> } {
		const calls: Array<{ uri: string; options: unknown }> = [];
		const fake = {
			hasCapability: () => capable,
			writeFile: async (resource: URI, _content: VSBuffer, options?: unknown) => {
				calls.push({ uri: resource.toString(), options });
			},
		} as unknown as IFileService;
		return { fs: fake, calls };
	}

	test('★★★ provider 支持 FileAtomicWrite ⇒ 必须带 atomic.postfix（temp + rename）', async () => {
		const { fs: fakeFs, calls } = makeFakeFs(true);
		await writeFileAtomicSafe(fakeFs, URI.file('C:/x/y.json'), VSBuffer.fromString('{}'));
		assert.strictEqual(calls.length, 1, '应恰好写一次');
		assert.deepStrictEqual(
			calls[0].options,
			{ atomic: { postfix: ATOMIC_WRITE_POSTFIX } },
			'支持能力时必须走 atomic（否则等于没加保护）',
		);
	});

	test('★★★ provider 不支持 ⇒ **必须退回普通写**（传 atomic 会 throw，写入会彻底失败）', async () => {
		const { fs: fakeFs, calls } = makeFakeFs(false);
		await writeFileAtomicSafe(fakeFs, URI.file('C:/x/y.json'), VSBuffer.fromString('{}'));
		assert.strictEqual(calls.length, 1, '仍应写一次（不能因缺少能力就不写）');
		assert.strictEqual(calls[0].options, undefined, '不支持能力时**不得**传 atomic');
	});

	test('★ 探的能力必须是 FileAtomicWrite（不是随便一个 capability 标志）', () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/common/atomicWrite.ts'),
			'utf8',
		);
		assert.ok(src.includes('FileSystemProviderCapabilities.FileAtomicWrite'), '必须探 FileAtomicWrite');
		assert.ok(src.includes('hasCapability('), '必须用 hasCapability 判断');
	});

	test('★★★ 关键写入点必须都走 helper（会话本体/索引、检查点索引/快照、workspaces JSON）', () => {
		const root = process.cwd();
		const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
		const chat = read('src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts');
		const ckpt = read('src/vs/sessions/contrib/agentStudio/browser/checkpointService.ts');
		const studio = read('src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts');

		assert.ok(chat.includes('writeFileAtomicSafe('), 'agentChatService 必须使用 helper（会话本体 + 索引）');
		assert.ok(ckpt.includes('writeFileAtomicSafe('), 'checkpointService 必须使用 helper（index + snapshot）');
		assert.ok(studio.includes('writeFileAtomicSafe('), 'agentStudioService 必须使用 helper（workspaces/agents JSON）');

		// 反向断言：这些文件的 JSON 写入点不应再出现裸 writeFile + 内联 atomic postfix（避免两套写法漂移）。
		for (const [name, src] of [['agentChatService', chat], ['checkpointService', ckpt], ['agentStudioService', studio]] as const) {
			assert.ok(
				!src.includes(`atomic: { postfix: '.vsctmp' }`),
				`${name} 不应再内联 atomic postfix（统一走 helper，常量只有一处）`,
			);
		}
	});
});
