/*---------------------------------------------------------------------------------------------
 *  SessionSidecarStore 专属行为基线（2026-09-22 阶段④-g P1/D-6 ✓）
 *
 *  为什么需要它 ✗✓：`sessionSidecarStore.ts`（173 行 ✓）是「超长工具结果**全文永不丢**」的唯一通道 ✓，
 *  三条纪律**都对应真机事故** ✓（原标记里只有 id/长度/预览、**没有路径** ⇒ 模型无从取回 ⇒
 *  「模型好像忘了某次工具输出」✗✓；落盘失败若阻断 ⇒ 一次磁盘抖动毁掉整轮对话 ✗；重复外置 ⇒ 无谓写盘 ✓）。
 *  这里把它当**纯对象**驱动 ✓（fileService / logService / sessionsDir 全部用假的 ✓）。
 *
 *  ⚠ 断言全部**先读实现再写** ✓，且**假件照抄真件判据** ✓（期望路径一律用真 `URI.joinPath` 生成 ✓；
 *  标记格式断言按实现的 `\x1E…:` 头 + `\x1E` + 400 字符预览 ✓）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { MAX_INLINE_TOOL_RESULT, SessionSidecarStore } from '../../browser/sessionSidecarStore.js';
import type { ChatMessage } from '../../common/types.js';

const pathOf = (uri: any): string => uri?.fsPath ?? String(uri);
const sessionsDir = URI.file('/tmp/fake-sessions');
/** sidecar 目录 / 文件：一律用**真** joinPath 生成期望值 ✓（手写拼接会在 Windows 上对不上 ✗）。 */
const sidecarDirPath = (sessionId: string) => URI.joinPath(sessionsDir, `${sessionId}.sidecar`).fsPath;
const sidecarFilePath = (sessionId: string, toolCallId: string) =>
	URI.joinPath(URI.joinPath(sessionsDir, `${sessionId}.sidecar`), `tool_${toolCallId}.json`).fsPath;

interface IFakeFs {
	api: any;
	files: Map<string, string>;
	folders: Set<string>;
	writes: string[];
	foldersCreated: string[];
	deletes: Array<{ path: string; recursive: boolean }>;
	/** 让下一次 writeFile 抛错 ✓ */
	failNextWrite(): void;
	/** 让下一次 readFile 抛错 ✓ */
	failNextRead(): void;
}

function makeFs(): IFakeFs {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const writes: string[] = [];
	const foldersCreated: string[] = [];
	const deletes: Array<{ path: string; recursive: boolean }> = [];
	let failWrite = false;
	let failRead = false;
	const api: any = {
		exists: async (uri: any) => files.has(pathOf(uri)) || folders.has(pathOf(uri)),
		createFolder: async (uri: any) => { const p = pathOf(uri); folders.add(p); foldersCreated.push(p); },
		writeFile: async (uri: any, buf: any) => {
			if (failWrite) { failWrite = false; throw new Error('EACCES fake'); }
			const p = pathOf(uri); writes.push(p); files.set(p, buf.toString());
		},
		readFile: async (uri: any) => {
			if (failRead) { failRead = false; throw new Error('EIO fake'); }
			const p = pathOf(uri);
			if (!files.has(p)) { throw new Error('ENOENT ' + p); }
			return { value: { toString: () => files.get(p)! } };
		},
		del: async (uri: any, opts?: any) => {
			const p = pathOf(uri);
			deletes.push({ path: p, recursive: !!opts?.recursive });
			folders.delete(p);
			for (const k of [...files.keys()]) { if (k === p || k.startsWith(p)) { files.delete(k); } }
		},
	};
	return { api, files, folders, writes, foldersCreated, deletes, failNextWrite: () => { failWrite = true; }, failNextRead: () => { failRead = true; } };
}

function makeStore(fs: IFakeFs, warns: string[], infos: string[] = []) {
	const log: any = {
		info(...a: unknown[]) { infos.push(a.map(String).join(' ')); },
		warn(...a: unknown[]) { warns.push(a.map(String).join(' ')); },
		error() { }, debug() { }, trace() { },
	};
	// ⚠ 构造顺序照抄真件 ✗✓：`(fileService, logService, resolveSessionsDir)` ✓
	return new SessionSidecarStore(fs.api, log, async () => sessionsDir);
}

const withLongResult = (id: string, len: number): ChatMessage => ({
	id: `msg_${id}`, role: 'assistant', content: 'x', timestamp: '',
	toolCalls: [{ id, name: 'grep', arguments: '{}', result: 'R'.repeat(len), status: 'done' }],
} as any);

suite('SessionSidecarStore — 「全文永不丢」的三条纪律 ✓', () => {

	test('★ `dirUri` 约定：`<sessionsDir>/<sessionId>.sidecar/` ✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		assert.strictEqual(pathOf(await store.dirUri('a1', 's1')), sidecarDirPath('s1'),
			'sidecar 必须落在会话目录下（放到工作区**之外** ⇒ 模型用 terminal 读 ✓）');
	});

	test('★★★ `ensure` 的句柄**必须带文件路径** ✓✓（旧实现只有 id/长度/预览 ⇒ 模型无从取回 ✗✓）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		const content = 'X'.repeat(9000);
		const handle = await store.ensure('a1', 's1', 't1', content);

		assert.strictEqual(fs.files.get(sidecarFilePath('s1', 't1')), content,
			'必须把**全文**落盘（落成截断版 ⇒ 信息真的丢了 ✗✓）');
		assert.deepStrictEqual(fs.foldersCreated, [sidecarDirPath('s1')], '必须按需建 sidecar 目录 ✓');
		assert.ok(handle.includes(sidecarFilePath('s1', 't1')),
			`★ 句柄必须含**可取回路径**（实际「${handle}」✗✓ —— 没有路径就等于没有取回通道 ✓）`);
		assert.ok(handle.includes('9000'), '句柄必须报原字符数（让模型知道丢了多少 ✓）');
		assert.ok(handle.includes('terminal'), '句柄必须给出**取回手段**（否则模型不知道能用什么读 ✓）');
	});

	test('★★★ `ensure` 幂等：同一 `id::session::toolCallId` 只写一次 ✓（且**不得**被新内容覆盖 ✗✓）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await store.ensure('a1', 's1', 't1', 'FIRST');
		const writesAfterFirst = fs.writes.length;
		await store.ensure('a1', 's1', 't1', 'SECOND');
		assert.strictEqual(fs.writes.length, writesAfterFirst,
			`第二次必须命中内存句柄表 ⇒ 零写盘（实际 ${fs.writes.length} 次 ✗✓ —— 每轮重写会放大 IO ✓）`);
		assert.strictEqual(fs.files.get(sidecarFilePath('s1', 't1')), 'FIRST',
			'已落盘内容必须保持不变（同一 toolCallId ⇒ 内容本就确定 ✓）');
	});

	test('★★ `ensure` 缺 agentId/sessionId/toolCallId 时 ⇒ 返回空句柄且**不建目录不落盘** ✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		// ⚠ noSession 桶（sessionId 为 undefined ✓）绝不能创建 sidecar：否则系统消息也会产生垃圾目录 ✗✓
		assert.strictEqual(await store.ensure('a1', undefined, 't1', 'X'), '', 'sessionId 缺失 ⇒ 空句柄 ✓');
		assert.strictEqual(await store.ensure(undefined, 's1', 't1', 'X'), '', 'agentId 缺失 ⇒ 空句柄 ✓');
		assert.strictEqual(await store.ensure('a1', 's1', '', 'X'), '', 'toolCallId 缺失 ⇒ 空句柄 ✓');
		assert.strictEqual(fs.writes.length, 0, '不得落盘 ✓');
		assert.strictEqual(fs.foldersCreated.length, 0, '不得建目录 ✓');
	});

	test('★★★ `ensure` 落盘失败 ⇒ **不阻断**（返回空句柄退化为纯截断 ✓）且只提示一次 ✓', async () => {
		const fs = makeFs();
		const warns: string[] = [];
		const store = makeStore(fs, warns);
		fs.failNextWrite();
		assert.strictEqual(await store.ensure('a1', 's1', 't1', 'X'.repeat(100)), '',
			'失败必须退化为空句柄（抛出去会毁掉整轮对话 ✗✓）');
		fs.failNextWrite();
		await store.ensure('a1', 's1', 't2', 'Y'.repeat(100));
		assert.strictEqual(warns.length, 1,
			`落盘失败只提示一次（实际 ${warns.length} 次 ✗✓ —— 每轮刷屏会淹没真正的问题 ✓）`);
		assert.ok(warns[0].includes('sidecar'), '日志必须标明来自 sidecar 通道 ✓');
	});

	test('★★★ `externalize` 边界与标记：**仅超 8KB** ✓、标记含 `id:长度` 头 + 400 字预览 ✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, [], []);
		const exact = withLongResult('exact', MAX_INLINE_TOOL_RESULT);        // = 8192 ⇒ **不**外置 ✓
		const over = withLongResult('over', MAX_INLINE_TOOL_RESULT + 1);      // 8193 ⇒ 外置 ✓
		const messages = [exact, over] as ChatMessage[];
		const count = await store.externalize('a1', 's1', messages);

		assert.strictEqual(count, 1, `只应外置 1 条（实际 ${count} ✗✓ —— 边界是「> cap」不是「>= cap」✓）`);
		assert.strictEqual((exact.toolCalls![0] as any).result.length, MAX_INLINE_TOOL_RESULT,
			'恰好等于上限的结果必须**原样保留** ✓（多外置一条就多一次读盘 ✓）');
		const marker = (over.toolCalls![0] as any).result as string;
		assert.ok(marker.startsWith('\x1EVSSAROS_TOOL_REF:over:8193\x1E'),
			`标记头必须是 \`\\x1EVSSAROS_TOOL_REF:<id>:<原长度>\\x1E\`（实际 ${JSON.stringify(marker.slice(0, 40))} ✗✓ —— 确定性前缀对 prompt 前缀缓存友好 ✓）`);
		assert.strictEqual(marker.length - marker.indexOf('\x1E', 1) - 1, 400,
			'标记尾部必须带 400 字预览（UI 无文件时也要能看到开头 ✓）');
		assert.strictEqual(fs.files.get(sidecarFilePath('s1', 'over'))!.length, MAX_INLINE_TOOL_RESULT + 1,
			'外置的必须是**全文**（不是预览 ✗✓）');
	});

	test('★★★ **往返一致**：`externalize` → `resolveRefs`（**新实例** ✓）必须逐字还原 ✓✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		const msg = withLongResult('rt', 20000);
		// ⚠ 期望值必须**捕获前置值** ✗✓（我首跑手写 'Z' 而 helper 填的是 'R' ⇒ 假红一次 ✓）
		const original = (msg.toolCalls![0] as any).result as string;
		await store.externalize('a1', 's1', [msg]);
		assert.ok((msg.toolCalls![0] as any).result.startsWith('\x1EVSSAROS_TOOL_REF:'),
			'前置：已替换为标记 ✓');

		// 新实例（模拟重启 ✓ —— 内存句柄表为空 ✓，只能靠标记里的路径解析 ✓）
		const store2 = makeStore(fs, []);
		const restored = await store2.resolveRefs('a1', 's1', [msg]);
		assert.strictEqual(restored, 1, '必须还原 1 条 ✓');
		assert.strictEqual((msg.toolCalls![0] as any).result, original,
			'★ 必须**逐字**还原（还原成截断版 ⇒ 懒加载后模型看到的仍不全 ✗✓）');
	});

	test('★★ `resolveRefs` 降级：sidecar 目录/文件缺失或读失败 ⇒ **保留标记**（UI 至少能显示预览 ✓）', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		const msg = withLongResult('gone', 20000);
		await store.externalize('a1', 's1', [msg]);
		const marked = (msg.toolCalls![0] as any).result as string;

		const noDir = makeStore(makeFs(), []);   // 全新 fs ⇒ sidecar 目录不存在 ✓
		assert.strictEqual(await noDir.resolveRefs('a1', 's1', [msg]), 0, '目录缺失 ⇒ 0 条 ✓');
		assert.strictEqual((msg.toolCalls![0] as any).result, marked, '标记必须保留（不得清空 ⇒ 否则连预览都没了 ✗✓）');

		fs.failNextRead();
		assert.strictEqual(await store.resolveRefs('a1', 's1', [msg]), 0, '读失败 ⇒ 0 条 ✓');
		assert.strictEqual((msg.toolCalls![0] as any).result, marked, '读失败必须保留标记 ✓');

		// 非外置结果（普通文本 / 短结果）不得被误改 ✓
		const plain = withLongResult('plain', 100);
		const plainBefore = (plain.toolCalls![0] as any).result;
		assert.strictEqual(await store.resolveRefs('a1', 's1', [plain]), 0);
		assert.strictEqual((plain.toolCalls![0] as any).result, plainBefore, '普通结果必须原样 ✓');
	});

	test('★ `deleteDir` 递归删除 ✓、目录不存在时**不调 del** ✓、异常不抛 ✓', async () => {
		const fs = makeFs();
		const store = makeStore(fs, []);
		await store.deleteDir('a1', 's1');                        // 不存在 ⇒ 什么都不做 ✓
		assert.strictEqual(fs.deletes.length, 0, '目录不存在时不应调用 del ✓');

		await store.ensure('a1', 's1', 't1', 'X'.repeat(100));     // 建目录 + 文件 ✓
		await store.deleteDir('a1', 's1');
		assert.deepStrictEqual(fs.deletes, [{ path: sidecarDirPath('s1'), recursive: true }],
			'必须**递归**删除（非递归会留下文件 ⇒ 会话删了 sidecar 还在 ✗✓）');
		assert.strictEqual(fs.files.has(sidecarFilePath('s1', 't1')), false, '文件必须一并删掉 ✓');
		assert.doesNotThrow(() => store.deleteDir('a1', 's1'), '重复删除必须安全 ✓');
	});
});
