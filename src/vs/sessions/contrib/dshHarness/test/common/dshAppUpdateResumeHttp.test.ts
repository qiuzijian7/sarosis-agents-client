/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 断点续传的**本地 HTTP 端到端验证**（2026-11-23）。
 *
 * 为什么补这一份：`updateService.win32.ts` 的下载链路依赖 VS Code 的 requestService /
 * fileService / Electron 主进程，没法在这里直接跑真机；但「HTTP Range 契约 + 拼接结果」
 * 完全可以本地验证。本测试起一个真实 `node:http` 服务器，用**与产品代码同一份判据**
 * （decideResume / acceptResumeResponse / validateResumeMeta）复刻下载流程，覆盖：
 *
 *   ① 首次全量；② 下载到一半断网后 206 续传，拼接与 sha256 完全一致；
 *   ③ 服务端不支持 Range（200）⇒ 回退全量；④ 206 但起点漂移 ⇒ 回退全量；
 *   ⑤ 换版本 / 换包 ⇒ 丢弃旧半成品；⑥ 校验失败 ⇒ 删 .tmp + meta，不反复拼坏前缀。
 *
 * ⚠ 这是协议契约验证，不是真机下载验证；产品侧是否真的按同一顺序调用判据，由
 *   `dshAppUpdateResume.test.ts` 的接线守卫钉住。两者合起来才是完整证据链。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshAppUpdateResumeHttp
 */

import assert from 'assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	acceptResumeResponse, decideResume, validateResumeMeta,
} from '../../../../../platform/update/common/updateResume.js';

const PAYLOAD = Buffer.alloc(192 * 1024);
for (let i = 0; i < PAYLOAD.length; i += 16) {
	randomBytes(16).copy(PAYLOAD, i);
}
const HASH = createHash('sha256').update(PAYLOAD).digest('hex');

interface IServerOptions {
	supportRange: boolean;
	/** 故意回一个起点不匹配的 Content-Range（模拟服务端错位）。 */
	wrongStart?: boolean;
}

async function startServer(opts: IServerOptions): Promise<{ server: Server; url: string; ranges: string[] }> {
	const ranges: string[] = [];
	const server = createServer((req, res) => {
		const range = req.headers.range;
		if (range) { ranges.push(range); }
		if (opts.supportRange && range) {
			const m = /^bytes=(\d+)-$/.exec(range);
			const start = m ? Number(m[1]) : 0;
			if (opts.wrongStart) {
				res.writeHead(206, {
					'Content-Range': `bytes 0-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
					'Content-Length': String(PAYLOAD.length),
				});
				res.end(PAYLOAD);
				return;
			}
			const slice = PAYLOAD.subarray(start);
			res.writeHead(206, {
				'Content-Range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
				'Content-Length': String(slice.length),
			});
			res.end(slice);
			return;
		}
		res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
		res.end(PAYLOAD);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return { server, url: `http://127.0.0.1:${port}/setup.exe`, ranges };
}

function stopServer(server: Server): Promise<void> {
	return new Promise(resolve => server.close(() => resolve()));
}

interface IUpdateLike { url: string; version: string; sha256hash: string }

/**
 * 复刻 `startBackgroundDownload` 的续传决策顺序（同一份判据 + 同一份兜底），
 * 以真实文件 I/O 验证拼接结果。`interruptAfter` 模拟「写了一半断网」。
 */
async function downloadOnce(
	url: string, tmp: string, meta: string, update: IUpdateLike,
	interruptAfter?: number,
): Promise<{ append: boolean; status: number; size: number }> {
	let resume = decideResume({ partialSize: 0 }, update);
	try {
		const parsed = validateResumeMeta(JSON.parse(await readFile(meta, 'utf8')));
		resume = decideResume({ partialSize: (await stat(tmp)).size, meta: parsed }, update);
	} catch { /* 没有半成品 / 边车损坏 ⇒ 全量 */ }

	const headers: Record<string, string> = {};
	if (resume.mode === 'resume' && resume.rangeHeader) {
		headers['Range'] = resume.rangeHeader;
	}
	const res = await fetch(url, { headers });
	const contentRange = res.headers.get('content-range') ?? undefined;
	const append = resume.mode === 'resume'
		&& acceptResumeResponse(res.status, contentRange, resume.size);
	if (!append) {
		await unlink(tmp).catch(() => undefined);
	}
	await writeFile(meta, JSON.stringify({ url, version: update.version, sha256hash: update.sha256hash }), 'utf8');

	const received = Buffer.from(await res.arrayBuffer());
	const chunk = interruptAfter !== undefined ? received.subarray(0, interruptAfter) : received;
	if (append) {
		const handle = await open(tmp, 'a');
		try { await handle.write(chunk); } finally { await handle.close(); }
	} else {
		await writeFile(tmp, chunk);
	}
	if (interruptAfter !== undefined) {
		throw new Error('simulated network interruption');
	}

	// sha256 兜底：拼接错位一定装不进去，且必须删掉坏前缀避免反复续传。
	const full = await readFile(tmp);
	if (createHash('sha256').update(full).digest('hex') !== update.sha256hash) {
		await unlink(tmp).catch(() => undefined);
		await unlink(meta).catch(() => undefined);
		throw new Error('checksum mismatch');
	}
	await unlink(meta).catch(() => undefined);
	return { append, status: res.status, size: full.length };
}

suite('dshHarness / 断点续传 HTTP 契约（本地真实服务器）', () => {

	let root: string;
	setup(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-resume-')); });
	teardown(async () => { await rm(root, { recursive: true, force: true }); });

	const paths = () => {
		const tmp = join(root, 'setup.exe.tmp');
		return { tmp, meta: `${tmp}.meta` };
	};

	test('① 首次全量下载：无半成品 ⇒ 不发 Range，结果与 sha256 一致', async () => {
		const { server, url, ranges } = await startServer({ supportRange: true });
		try {
			const { tmp, meta } = paths();
			const r = await downloadOnce(url, tmp, meta, { url, version: 'v1', sha256hash: HASH });
			assert.strictEqual(r.append, false);
			assert.strictEqual(r.status, 200);
			assert.strictEqual(r.size, PAYLOAD.length);
			assert.deepStrictEqual(ranges, []);
		} finally { await stopServer(server); }
	});

	test('② 断网后续传：206 + 起点对齐 ⇒ 拼接结果与全量逐字节一致', async () => {
		const { server, url, ranges } = await startServer({ supportRange: true });
		try {
			const { tmp, meta } = paths();
			const update = { url, version: 'v1', sha256hash: HASH };
			const cut = 70_000;
			await assert.rejects(() => downloadOnce(url, tmp, meta, update, cut), /network interruption/);
			assert.strictEqual((await stat(tmp)).size, cut, '中断后保留半成品');

			const r = await downloadOnce(url, tmp, meta, update);
			assert.strictEqual(r.append, true);
			assert.strictEqual(r.status, 206);
			assert.deepStrictEqual(ranges, [`bytes=${cut}-`], '必须真的发 Range');
			assert.strictEqual(r.size, PAYLOAD.length);
			assert.strictEqual(createHash('sha256').update(await readFile(tmp)).digest('hex'), HASH);
		} finally { await stopServer(server); }
	});

	test('③ 服务端不支持 Range（200）⇒ 回退全量，结果仍正确', async () => {
		const { server, url } = await startServer({ supportRange: false });
		try {
			const { tmp, meta } = paths();
			const update = { url, version: 'v1', sha256hash: HASH };
			await assert.rejects(() => downloadOnce(url, tmp, meta, update, 40_000), /network interruption/);
			const r = await downloadOnce(url, tmp, meta, update);
			assert.strictEqual(r.append, false);
			assert.strictEqual(r.status, 200);
			assert.strictEqual(r.size, PAYLOAD.length);
			assert.strictEqual(createHash('sha256').update(await readFile(tmp)).digest('hex'), HASH);
		} finally { await stopServer(server); }
	});

	test('④ 206 但 Content-Range 起点漂移 ⇒ 拒绝追加，回退全量', async () => {
		const { server, url } = await startServer({ supportRange: true, wrongStart: true });
		try {
			const { tmp, meta } = paths();
			const update = { url, version: 'v1', sha256hash: HASH };
			await assert.rejects(() => downloadOnce(url, tmp, meta, update, 40_000), /network interruption/);
			const r = await downloadOnce(url, tmp, meta, update);
			assert.strictEqual(r.append, false);
			assert.strictEqual(r.status, 206);
			assert.strictEqual(r.size, PAYLOAD.length);
			assert.strictEqual(createHash('sha256').update(await readFile(tmp)).digest('hex'), HASH);
		} finally { await stopServer(server); }
	});

	test('⑤ 换版本 / 换包哈希 ⇒ 丢弃旧半成品，不发过期 Range', async () => {
		const { server, url, ranges } = await startServer({ supportRange: true });
		try {
			const { tmp, meta } = paths();
			await assert.rejects(() => downloadOnce(url, tmp, meta, { url, version: 'v1', sha256hash: HASH }, 40_000), /network interruption/);
			const changed = { url, version: 'v2', sha256hash: HASH };
			const r = await downloadOnce(url, tmp, meta, changed);
			assert.strictEqual(r.append, false, '换版本不许拼旧包');
			assert.deepStrictEqual(ranges, [], '不该发 Range');
			assert.strictEqual(createHash('sha256').update(await readFile(tmp)).digest('hex'), HASH);
		} finally { await stopServer(server); }
	});

	test('⑥ 校验失败 ⇒ 删掉 .tmp + meta，下次重新全量（不反复拼坏前缀）', async () => {
		const { server, url, ranges } = await startServer({ supportRange: true });
		try {
			const { tmp, meta } = paths();
			const wrong = { url, version: 'v1', sha256hash: '0'.repeat(64) };
			await assert.rejects(() => downloadOnce(url, tmp, meta, wrong), /checksum mismatch/);
			await assert.rejects(() => stat(tmp), /ENOENT/);
			await assert.rejects(() => readFile(meta, 'utf8'), /ENOENT/);

			const r = await downloadOnce(url, tmp, meta, { url, version: 'v1', sha256hash: HASH });
			assert.strictEqual(r.append, false);
			assert.deepStrictEqual(ranges, [], '坏前缀删掉后不应再发 Range');
			assert.strictEqual(createHash('sha256').update(await readFile(tmp)).digest('hex'), HASH);
		} finally { await stopServer(server); }
	});
});
