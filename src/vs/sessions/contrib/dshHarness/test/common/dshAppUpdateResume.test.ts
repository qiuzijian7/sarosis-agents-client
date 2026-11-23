/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Windows 应用包断点续传判据的行为守卫（2026-11-23）。
 *
 * 重点：任何不确定都退回全量下载；206 起点必须对齐；坏前缀不能反复续传；
 * `cleanup()` 只保留当前版本的 .exe / .tmp / .tmp.meta。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAppUpdateResume
 */

import assert from 'assert';
import {
	MAX_RESUME_BYTES, acceptResumeResponse, decideResume, shouldKeepPartialFile, validateResumeMeta,
} from '../../../../../platform/update/common/updateResume.js';

const update = { url: 'https://update.example/win32/setup.exe', version: 'abc123', sha256hash: 'a'.repeat(64) };
const meta = { url: update.url, version: update.version, sha256hash: update.sha256hash };

suite('dshHarness / 应用安装包断点续传判据', () => {

	test('元信息齐全且匹配 ⇒ resume，Range 头正确', () => {
		const d = decideResume({ partialSize: 123_456, meta }, update);
		assert.strictEqual(d.mode, 'resume');
		assert.strictEqual(d.size, 123_456);
		assert.strictEqual(d.rangeHeader, 'bytes=123456-');
		assert.match(d.reason, /续传/);
	});

	test('不确定就退回全量：无元信息 / 换版本 / 换地址 / 换哈希', () => {
		assert.strictEqual(decideResume({ partialSize: 100 }, update).mode, 'fresh');
		assert.strictEqual(decideResume({ partialSize: 100, meta: { ...meta, version: 'other' } }, update).mode, 'fresh');
		assert.strictEqual(decideResume({ partialSize: 100, meta: { ...meta, url: 'https://other/x' } }, update).mode, 'fresh');
		assert.strictEqual(decideResume({ partialSize: 100, meta: { ...meta, sha256hash: 'b'.repeat(64) } }, update).mode, 'fresh');
		// 两边都缺哈希时不算「换了包」，仍可续传（老更新源不给 sha256）
		const noHash = { url: update.url, version: update.version };
		assert.strictEqual(decideResume({ partialSize: 100, meta: noHash }, { url: update.url, version: update.version }).mode, 'resume');
	});

	test('残留文件大小不可信 ⇒ 全量', () => {
		for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_RESUME_BYTES + 1]) {
			assert.strictEqual(decideResume({ partialSize: size, meta }, update).mode, 'fresh', `size=${size}`);
		}
		assert.strictEqual(decideResume({ partialSize: MAX_RESUME_BYTES, meta }, update).mode, 'resume');
	});

	test('只有 206 且 Content-Range 起点对齐才追加写', () => {
		assert.strictEqual(acceptResumeResponse(206, 'bytes 123456-999999/1000000', 123_456), true);
		assert.strictEqual(acceptResumeResponse(206, 'bytes 123456-999999/*', 123_456), true);
		assert.strictEqual(acceptResumeResponse(206, 'bytes 0-999999/1000000', 123_456), false, '起点不对齐不能拼');
		assert.strictEqual(acceptResumeResponse(206, undefined, 123_456), false);
		assert.strictEqual(acceptResumeResponse(206, 'garbage', 123_456), false);
		assert.strictEqual(acceptResumeResponse(200, 'bytes 123456-999999/1000000', 123_456), false, '服务端不支持 Range ⇒ 全量');
		assert.strictEqual(acceptResumeResponse(416, 'bytes */1000000', 123_456), false);
	});

	test('validateResumeMeta：白名单重建、脏值丢弃', () => {
		assert.deepStrictEqual(validateResumeMeta({ ...meta, injected: 'evil' }), meta);
		assert.strictEqual((validateResumeMeta({ ...meta, injected: 'evil' }) as Record<string, unknown> | undefined)?.injected, undefined);
		assert.strictEqual(validateResumeMeta(null), undefined);
		assert.strictEqual(validateResumeMeta({ url: 'x' }), undefined);
		assert.strictEqual(validateResumeMeta({ ...meta, url: 42 }), undefined);
		assert.strictEqual(validateResumeMeta({ ...meta, url: 'x'.repeat(5000) })?.url.length, 2048);
	});

	test('cleanup：只保留当前版本的成品 / 半成品 / 边车', () => {
		const q = 'stable', v = 'abc123';
		for (const name of [`CodeSetup-${q}-${v}.exe`, `CodeSetup-${q}-${v}.exe.tmp`, `CodeSetup-${q}-${v}.exe.tmp.meta`]) {
			assert.strictEqual(shouldKeepPartialFile(name, q, v), true, name);
		}
		for (const name of [`CodeSetup-${q}-old.exe`, `CodeSetup-${q}-old.exe.tmp`, `CodeSetup-${q}-${v}.tmp.meta`, 'session-ending.flag', 'cancel.flag']) {
			assert.strictEqual(shouldKeepPartialFile(name, q, v), false, name);
		}
	});

	test('平台下载链路真的接上了判据（不能只留一份没人用的纯函数）', async () => {
		// ⚠ runner 会把测试 bundle 成 cjs ⇒ `import.meta.url` 指向临时目录，不能用来定位仓库源码；
		//   与仓内其它源码守卫一致，用 process.cwd() 拼绝对路径。
		const [{ readFile }, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
		const src = await readFile(path.join(process.cwd(), 'src', 'vs', 'platform', 'update', 'electron-main', 'updateService.win32.ts'), 'utf8');
		assert.match(src, /decideResume\(/, '下载前必须判可不可续传');
		assert.match(src, /acceptResumeResponse\(/, '206 与起点必须由判据确认');
		assert.match(src, /shouldKeepPartialFile\(/, 'cleanup 必须保留当前版本半成品');
		assert.match(src, /Range: resume\.rangeHeader/, '必须真的发 Range 头');
		assert.match(src, /\.tmp\.meta/, '必须有边车元信息');
		assert.match(src, /checksum\(downloadPath, update\.sha256hash\)/, 'sha256 兜底不许被绕过');
		assert.match(src, /await unlink\(metaPath\)/, '成功后要清掉边车');
	});
});
