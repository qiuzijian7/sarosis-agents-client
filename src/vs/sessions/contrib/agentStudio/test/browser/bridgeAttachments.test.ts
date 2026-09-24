/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 入站附件落盘（2026-09-23）用例。
 *
 * 背景：渲染进程是沙箱 Chromium，`nodeRequire('fs')` **恒为 undefined**
 * （见 `browser/rendererNodeRequire.ts`）⇒ 旧的 `saveFilesToDisk` 在生产环境永远返回空数组，
 * 表现是「飞书图片/文件收到了，但 prompt 里没有路径、Agent 拿不到」。
 * 现在改为经主进程 `vscode:bridgeSaveAttachment` 写 `<userData>/bridge/attachments/`。
 *
 * 这里用假 `globalThis.vscode` 验证：主进程优先 / 无桥退化为空 / 失败跳过不中断 / base64 分块正确。
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildInboundChatAttachments, bytesToBase64, saveFilesToDiskAsync, saveFilesToDiskViaHost } from '../../browser/bridge/bridgeAttachments.js';

/** 假 IPC 桥（nativeIpcBridge 读的是 globalThis.vscode / vscodeBridge）。 */
function withFakeBridge(invoke: (channel: string, payload: { name?: string; base64?: string }) => Promise<unknown>): void {
	(globalThis as unknown as Record<string, unknown>).vscode = { ipcRenderer: { invoke } };
}

function clearBridge(): void {
	delete (globalThis as unknown as Record<string, unknown>).vscode;
	delete (globalThis as unknown as Record<string, unknown>).vscodeBridge;
}

/** 兜底路径（无桥时走旧 fs 实现）用的临时工作目录，避免污染仓库。 */
const TMP_WORKDIR = path.join(os.tmpdir(), 'saros-bridge-attach-test');

suite('入站附件落盘 · 主进程优先', () => {
	test('bytesToBase64：与 Node Buffer 结果一致（含 0x00/0xFF，且跨 32KB 分块不爆栈）', () => {
		const small = new Uint8Array([0, 1, 254, 255]);
		assert.strictEqual(bytesToBase64(small), Buffer.from(small).toString('base64'));
		const big = new Uint8Array(70000);
		for (let i = 0; i < big.length; i++) { big[i] = i % 256; }
		assert.strictEqual(bytesToBase64(big), Buffer.from(big).toString('base64'));
		assert.strictEqual(bytesToBase64(new Uint8Array(0)), '');
	});

	test('★★ 有主进程桥：每个附件调一次 vscode:bridgeSaveAttachment，返回的绝对路径按序收集', async () => {
		const calls: Array<{ ch: string; payload: { name?: string; base64?: string } }> = [];
		withFakeBridge(async (ch, payload) => {
			calls.push({ ch, payload });
			return { ok: true, path: `C:\\u\\bridge\\attachments\\1-${payload.name}` };
		});

		const paths = await saveFilesToDiskAsync(path.join(TMP_WORKDIR, 'ignored'), [
			{ mimeType: 'image/png', data: new Uint8Array([1, 2]), fileName: 'a.png' },
			{ mimeType: 'application/pdf', data: new Uint8Array([3]), fileName: 'b.pdf' },
		]);

		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].ch, 'vscode:bridgeSaveAttachment');
		assert.strictEqual(calls[0].payload.name, 'a.png');
		assert.strictEqual(calls[0].payload.base64, Buffer.from([1, 2]).toString('base64'), '字节须原样转 base64');
		assert.deepStrictEqual(paths, [
			'C:\\u\\bridge\\attachments\\1-a.png',
			'C:\\u\\bridge\\attachments\\1-b.pdf',
		]);
		clearBridge();
	});

	test('★ 缺 fileName 时用 attachment 占位（主进程仍能落盘，不会因缺名失败）', async () => {
		let seenName: string | undefined;
		withFakeBridge(async (_ch, payload) => { seenName = payload.name; return { ok: true, path: 'C:\\p\\x' }; });
		await saveFilesToDiskViaHost([{ mimeType: 'image/png', data: new Uint8Array([9]) }]);
		assert.strictEqual(seenName, 'attachment');
		clearBridge();
	});

	test('★ 无桥（非 Electron / preload 未注入）：返回空数组，不抛（引擎退化为只发占位文本）', async () => {
		clearBridge();
		assert.deepStrictEqual(await saveFilesToDiskViaHost([{ mimeType: 'image/png', data: new Uint8Array([1]) }]), []);
		// saveFilesToDiskAsync 会退回旧 fs 实现；测试环境（node）可能可用，但它也必须**不抛**
		const paths = await saveFilesToDiskAsync(TMP_WORKDIR, [{ mimeType: 'image/png', data: new Uint8Array([1]) }]);
		assert.ok(Array.isArray(paths));
		try { fs.rmSync(TMP_WORKDIR, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
	});

	test('★ 单个附件写失败（ok:false 或抛错）被跳过，不影响其余附件', async () => {
		let n = 0;
		withFakeBridge(async () => {
			n++;
			if (n === 1) { return { ok: false, error: '磁盘只读' }; }
			if (n === 2) { throw new Error('IPC 断了'); }
			return { ok: true, path: 'C:\\p\\c.png' };
		});
		const paths = await saveFilesToDiskAsync(undefined, [
			{ mimeType: 'image/png', data: new Uint8Array([1]), fileName: 'a.png' },
			{ mimeType: 'image/png', data: new Uint8Array([2]), fileName: 'b.png' },
			{ mimeType: 'image/png', data: new Uint8Array([3]), fileName: 'c.png' },
		]);
		assert.deepStrictEqual(paths, ['C:\\p\\c.png']);
		clearBridge();
	});
});

suite('入站附件 → 聊天框附件对象（显示）', () => {
	test('★★ 图片：type=image + base64 data（面板缩略图 / 模型看图都依赖它）', () => {
		const out = buildInboundChatAttachments(
			[{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]), fileName: '截图.png' }],
			['C:\\u\\bridge\\attachments\\1-截图.png'],
			'seed',
		);
		assert.strictEqual(out.length, 1);
		assert.strictEqual(out[0].type, 'image');
		assert.strictEqual(out[0].name, '截图.png');
		assert.strictEqual(out[0].mimeType, 'image/png');
		assert.strictEqual(out[0].size, 3);
		assert.strictEqual(out[0].data, Buffer.from([1, 2, 3]).toString('base64'));
		assert.strictEqual(out[0].filePath, 'C:\\u\\bridge\\attachments\\1-截图.png');
		assert.strictEqual(out[0].id, 'bridge-seed-0');
	});

	test('★★ 文件：data 必须为空（driver 会把 data 原文内联进 prompt，二进制会灌乱码 token）', () => {
		const out = buildInboundChatAttachments(
			[{ mimeType: 'application/pdf', data: new Uint8Array([0xff, 0xd8, 0xff]), fileName: '季度报表.pdf' }],
			['C:\\u\\bridge\\attachments\\2-季度报表.pdf'],
			'seed',
		);
		assert.strictEqual(out[0].type, 'file');
		assert.strictEqual(out[0].data, '', '★ 文件附件不得内联字节（否则烧 token 且把 prompt 污染）✗✓');
		assert.strictEqual(out[0].name, '季度报表.pdf');
		assert.strictEqual(out[0].size, 3);
		assert.strictEqual(out[0].filePath, 'C:\\u\\bridge\\attachments\\2-季度报表.pdf', 'pill 点击要能在编辑器打开');
	});

	test('缺文件名的图片/文件给出带扩展名的占位名（否则 pill 显示空白）', () => {
		const img = buildInboundChatAttachments([{ mimeType: 'image/jpeg', data: new Uint8Array([1]) }]);
		assert.strictEqual(img[0].name, 'image-1.jpg');
		const file = buildInboundChatAttachments([{ mimeType: 'application/octet-stream', data: new Uint8Array([1]) }]);
		assert.strictEqual(file[0].name, 'attachment-1');
		assert.strictEqual(file[0].filePath, undefined, '无落盘路径时不能塞 undefined 之外的值');
	});

	test('无附件 / 空数组安全（不产生空 pill）', () => {
		assert.deepStrictEqual(buildInboundChatAttachments([]), []);
	});
});

suite('入站附件落盘 · 接线守卫', () => {
	test('★★★ 引擎必须用 async 落盘入口（旧同步实现在生产环境恒为空）', () => {
		const engine = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/bridge/bridgeEngine.ts'), 'utf8');
		assert.ok(engine.includes('saveFilesToDiskAsync'), '★ 引擎必须用 saveFilesToDiskAsync ✗✓');
		assert.ok(!/saveFilesToDisk\(this\._bridgeWorkDir/.test(engine),
			'★ 不得再直接调同步 saveFilesToDisk（渲染进程无 fs）✗✓');
	});

	test('★★★ 引擎必须把附件作为 attachments 下发（否则聊天框只显示路径文字）', () => {
		const engine = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/bridge/bridgeEngine.ts'), 'utf8');
		assert.ok(engine.includes('buildInboundChatAttachments(msg.files, paths)'), '★ 必须构造面板附件对象 ✗✓');
		assert.ok(/attachments,\s*\n?\s*\};/.test(engine), '★ 必须把 attachments 放进 sendMessage 的 options ✗✓');
	});

	test('★★★ 广播必须带完整附件（图片不持久化，但气泡要立刻显示缩略图）', () => {
		const svc = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts'), 'utf8');
		assert.ok(/fireUserMessageAdded\([\s\S]{0,200}attachments: options\.attachments/.test(svc),
			'★ 广播若只用持久化后的 userMessage，图片附件已被过滤 ⇒ 气泡没有缩略图 ✗✓');
	});

	test('★★★ 主进程必须暴露 vscode:bridgeSaveAttachment，且走 sanitize + 附件目录', () => {
		const ch = fs.readFileSync(
			path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/electron-main/bridgeStoreChannel.ts'), 'utf8');
		assert.ok(ch.includes("validatedIpcMain.handle('vscode:bridgeSaveAttachment'"), '必须有该 handler ✗✓');
		assert.ok(ch.includes('sanitizeAttachmentFileName'), '★ 文件名必须 sanitize（防目录穿越）✗✓');
		assert.ok(ch.includes("joinBridgePath(this.dir(), 'attachments')"), '写进 <userData>/bridge/attachments ✓');
		assert.ok(ch.includes("removeHandler('vscode:bridgeSaveAttachment')"), 'dispose 必须注销该 handler ✓');
	});
});
