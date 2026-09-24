/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbImportControllerAgentSession.test.ts — 「agent 自主读写」批量构建路径的测试（tdd 风格）。
 *
 *  覆盖：
 *   1. `_cacheEntryFresh` — 缓存新鲜度（mtime 判定：素材改过后必须能重建）
 *   2. `_collectPendingSources` — pending 计算（未构建 / 素材已改 / 幽灵缓存 / 排除产出笔记与系统文件）
 *   3. `_parseReorgPlan` — KB_REORG 计划解析与安全校验（越界/覆盖/穿越/上限）
 *   4. `buildPendingAsAgentSession` — 集成：会话创建 + 两阶段消息（技能挂载）+ 产出归集 +
 *      缓存回填（靠 frontmatter sources）+ 通知；以及无 chat 服务时的降级
 *
 *  运行方式：
 *   node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *       src/vs/sessions/contrib/agentStudio/browser/kbImportControllerAgentSession.test.ts
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { KbImportController } from './kbImportController.js';

// ---------------------------------------------------------------------------
// 内存 FS mock：resolve 对缺失路径**抛错**（exists/新鲜度判定靠它），
// mtime 可控制（种子给定；新写入的文件取递增时钟 ⇒ 模拟「构建产物比素材新」）。
// ---------------------------------------------------------------------------

interface ISeedFile { content: string; mtime: number }

function createFs(seed: Record<string, ISeedFile | string>) {
	const files = new Map<string, ISeedFile>();
	const dirs = new Set<string>(['/']);
	let clock = 1000;
	const keyOf = (uri: URI) => uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
	const addDir = (k: string) => {
		const segs = k.split('/').filter(Boolean);
		let acc = '';
		for (const s of segs) { acc += '/' + s; dirs.add(acc); }
	};
	for (const [p, v] of Object.entries(seed)) {
		const k = URI.file(p).fsPath.replace(/\\/g, '/');
		files.set(k, typeof v === 'string' ? { content: v, mtime: 100 } : v);
		addDir(k.split('/').slice(0, -1).join('/'));
	}
	const service: any = {
		async resolve(uri: URI): Promise<any> {
			const k = keyOf(uri);
			if (files.has(k)) {
				const f = files.get(k)!;
				return { resource: uri, name: k.split('/').pop(), isDirectory: false, mtime: f.mtime, size: f.content.length };
			}
			if (dirs.has(k) || k === '') {
				const prefix = k === '' ? '/' : k + '/';
				const children: any[] = [];
				const seen = new Set<string>();
				for (const d of dirs) {
					if (d === k || !d.startsWith(prefix)) { continue; }
					const seg = d.slice(prefix.length);
					if (!seg.includes('/') && !seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
				}
				for (const [p, f] of files) {
					if (!p.startsWith(prefix)) { continue; }
					const rest = p.slice(prefix.length);
					const seg = rest.split('/')[0];
					if (rest.includes('/')) {
						if (!seen.has(seg)) { seen.add(seg); children.push({ resource: URI.file(prefix + seg), name: seg, isDirectory: true }); }
					} else if (!seen.has(seg)) {
						seen.add(seg);
						children.push({ resource: URI.file(p), name: seg, isDirectory: false, mtime: f.mtime, size: f.content.length });
					}
				}
				return { resource: uri, name: k.split('/').pop() ?? '', isDirectory: true, children };
			}
			throw new Error('not found: ' + k);
		},
		async stat(uri: URI): Promise<any> { return service.resolve(uri); },
		async readFile(uri: URI): Promise<{ value: { toString(): string; byteLength: number } }> {
			const f = files.get(keyOf(uri));
			if (!f) { throw new Error('not found'); }
			return { value: { toString: () => f.content, byteLength: f.content.length } };
		},
		async writeFile(uri: URI, value: { toString(): string }): Promise<void> {
			const k = keyOf(uri);
			files.set(k, { content: value.toString(), mtime: ++clock });
			addDir(k.split('/').slice(0, -1).join('/'));
		},
		async createFolder(uri: URI): Promise<void> { addDir(keyOf(uri)); },
		async del(uri: URI): Promise<void> { files.delete(keyOf(uri)); },
	};
	return {
		service: service as any,
		has(path: string) { return files.has(keyOf(URI.file(path))); },
		content(path: string): string | undefined { return files.get(keyOf(URI.file(path)))?.content; },
	};
}

const quietLog: any = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
const VAULT = '/vault';
const fp = (p: string) => URI.file(p).fsPath;   // 平台相关的 fsPath（缓存键的口径）

function createController(fs: ReturnType<typeof createFs>, opts?: { chat?: any }) {
	const notices: { message: string }[] = [];
	const opened: unknown[] = [];
	const controller = new KbImportController(
		{ getValue: () => undefined } as any,       // configurationService
		quietLog,
		fs.service,                                  // fileService
		{} as any,                                   // environmentService
		{} as any,                                   // storageService
		{ requestKbRefresh() { } } as any,           // agentStudioService
		{} as any,                                   // viewsService
		{ async openEditor(i: unknown) { opened.push(i); return undefined; } } as any,  // editorService
		{ notify(o: any) { notices.push(o); }, info() { }, warn() { }, prompt() { return { dispose() { } }; } } as any,  // notificationService
		{} as any,                                   // requestService
		undefined as any,                            // agentDriverService（本套件不走 agentic 单篇）
		opts?.chat,                                  // agentChatService
	);
	return { controller, notices, opened };
}

/** 模拟「知识库专家」agent 的两阶段应答：Phase 1 写笔记（带 sources frontmatter），Phase 2 写知识体系.md。 */
function createChatMock(fs: ReturnType<typeof createFs>, opts?: { failCreate?: boolean }) {
	const calls: { agentId: string; message: string; options: any }[] = [];
	const created: { agentId: string; name: string; id: string }[] = [];
	const svc: any = {
		async createAgentSession(agentId: string, name: string) {
			if (opts?.failCreate) { throw new Error('会话创建失败'); }
			const s = { id: `sess-${created.length + 1}`, agentId, name };
			created.push(s);
			return s;
		},
		async replaceHistory() { },
		async sendMessage(agentId: string, message: string, options: any, onDelta?: (d: any) => void) {
			calls.push({ agentId, message, options });
			if (message.includes('Phase 1')) {
				const note = '/vault/笔记/01_学习/UnrealEngine/09_UI与Slate/UI优化技巧.md';
				const content = '---\ntype: method\ntitle: UI优化技巧\nsources:\n  - "[[raw/UI优化篇.md]]"\n---\n\n# UI优化技巧\n\n正文';
				await fs.service.writeFile(URI.file(note), { toString: () => content });
				onDelta?.({ type: 'tool_end', content: `wrote ${content.length} chars to ${fp(note)}` });
			} else if (message.includes('Phase 2')) {
				const doc = '/vault/笔记/知识体系.md';
				const docContent = '# 知识体系\n\n## 目录结构总览\n- [[UI优化技巧]]';
				await fs.service.writeFile(URI.file(doc), { toString: () => docContent });
				onDelta?.({ type: 'tool_end', content: `wrote ${docContent.length} chars to ${fp(doc)}` });
				onDelta?.({ type: 'text', content: '完成。\n<!-- KB_REORG {"moves":[]} -->' });
			}
			return { content: 'done' };
		},
	};
	return { svc, calls, created };
}

suite('_cacheEntryFresh（缓存新鲜度：素材改过后必须能重建）', () => {

	test('笔记不比素材旧 ⇒ 新鲜（命中缓存）', async () => {
		const fs = createFs({
			'/vault/库/raw/a.md': { content: '素材', mtime: 100 },
			'/vault/笔记/n.md': { content: '笔记', mtime: 200 },
		});
		const fresh = await (KbImportController as any)._cacheEntryFresh(fs.service, URI.file('/vault/库/raw/a.md'), fp('/vault/笔记/n.md'));
		assert.strictEqual(fresh, true);
	});

	test('素材比笔记新（构建后又被改过）⇒ 不新鲜（要重建）', async () => {
		const fs = createFs({
			'/vault/库/raw/a.md': { content: '素材', mtime: 300 },
			'/vault/笔记/n.md': { content: '笔记', mtime: 200 },
		});
		const fresh = await (KbImportController as any)._cacheEntryFresh(fs.service, URI.file('/vault/库/raw/a.md'), fp('/vault/笔记/n.md'));
		assert.strictEqual(fresh, false);
	});

	test('笔记不存在（幽灵缓存）⇒ 不新鲜（要重建）', async () => {
		const fs = createFs({ '/vault/库/raw/a.md': { content: '素材', mtime: 100 } });
		const fresh = await (KbImportController as any)._cacheEntryFresh(fs.service, URI.file('/vault/库/raw/a.md'), fp('/vault/笔记/不存在.md'));
		assert.strictEqual(fresh, false);
	});
});

suite('_collectPendingSources（pending 判定）', () => {

	test('未构建 + 素材已改 + 幽灵缓存 ⇒ 进 pending；新鲜命中 / 产出笔记 / 系统文件 ⇒ 不进', async () => {
		const cache = {
			[fp('/vault/库/raw/新鲜.md')]: fp('/vault/笔记/已有/新鲜笔记.md'),       // 新鲜 ⇒ 跳过
			[fp('/vault/库/raw/改过了.md')]: fp('/vault/笔记/已有/旧笔记.md'),        // 素材新 ⇒ 重建
			[fp('/vault/库/raw/幽灵.md')]: fp('/vault/笔记/已被删.md'),              // 笔记没了 ⇒ 重建
			[fp('/vault/库/raw/某素材.md')]: fp('/vault/库/概念/产出.md'),           // 值 ⇒ 「产出.md」是笔记不是素材
		};
		const fs = createFs({
			'/vault/.kb-build-cache.json': JSON.stringify(cache),
			'/vault/库/raw/新鲜.md': { content: 'a', mtime: 100 },
			'/vault/笔记/已有/新鲜笔记.md': { content: 'n', mtime: 200 },
			'/vault/库/raw/改过了.md': { content: 'b', mtime: 300 },
			'/vault/笔记/已有/旧笔记.md': { content: 'n', mtime: 200 },
			'/vault/库/raw/幽灵.md': { content: 'g', mtime: 100 },
			'/vault/库/raw/某素材.md': { content: 's', mtime: 100 },
			'/vault/库/概念/产出.md': { content: 'p', mtime: 100 },
			'/vault/库/raw/新素材.md': { content: 'c', mtime: 100 },
			'/vault/库/index.md': { content: 'sys', mtime: 100 },
			'/vault/库/.hidden.md': { content: 'h', mtime: 100 },
		});
		const { pending } = await (KbImportController as any)._collectPendingSources(
			fs.service, URI.file(VAULT), quietLog, { notify() { }, info() { }, warn() { } }, { requestKbRefresh() { } },
		);
		const names = pending.map((u: URI) => u.path.split('/').pop()).sort();
		assert.deepStrictEqual(names, ['幽灵.md', '改过了.md', '新素材.md'], 'pending 恰好是这三个');
	});
});

suite('_parseReorgPlan（KB_REORG 计划解析与安全校验）', () => {

	const VAULT_URI = URI.file(VAULT);
	const NOTES_URI = URI.file('/vault/笔记');

	test('合法计划 ⇒ 解析出 move（含相对路径）', async () => {
		const fs = createFs({ '/vault/笔记/a.md': 'x' });
		const plan = await (KbImportController as any)._parseReorgPlan(
			'前言…\n<!-- KB_REORG\n{"reason":"归位","moves":[{"from":"笔记/a.md","to":"笔记/01_学习/b.md"}]}\n-->\n后记',
			VAULT_URI, NOTES_URI, fs.service, quietLog,
		);
		assert.strictEqual(plan.reason, '归位');
		assert.strictEqual(plan.moves.length, 1);
		assert.strictEqual(plan.moves[0].fromRel, '笔记/a.md');
		assert.strictEqual(plan.moves[0].toRel, '笔记/01_学习/b.md');
	});

	test('无块 / JSON 坏 / moves 非数组 ⇒ 空计划（不抛错）', async () => {
		const fs = createFs({});
		for (const text of ['没有块', '<!-- KB_REORG {bad json} -->', '<!-- KB_REORG {"moves":"不是数组"} -->']) {
			const plan = await (KbImportController as any)._parseReorgPlan(text, VAULT_URI, NOTES_URI, fs.service, quietLog);
			assert.strictEqual(plan.moves.length, 0, `「${text.slice(0, 12)}…」⇒ 空`);
		}
	});

	test('安全闸：越出笔记区 / to 已存在 / `..` 穿越 / from===to ⇒ 全部跳过', async () => {
		const fs = createFs({ '/vault/笔记/a.md': 'x', '/vault/笔记/已有.md': 'y', '/vault/库/raw/x.md': 'z' });
		const plan = await (KbImportController as any)._parseReorgPlan(
			'<!-- KB_REORG {"moves":['
			+ '{"from":"库/raw/x.md","to":"笔记/偷渡.md"},'            // 越出笔记区
			+ '{"from":"笔记/a.md","to":"笔记/已有.md"},'              // to 已存在
			+ '{"from":"笔记/a.md","to":"笔记/../库/穿越.md"},'        // `..`
			+ '{"from":"笔记/a.md","to":"笔记/a.md"},'                // from===to
			+ '{"from":"笔记/不存在.md","to":"笔记/某处.md"}'          // from 不存在
			+ ']} -->',
			VAULT_URI, NOTES_URI, fs.service, quietLog,
		);
		assert.strictEqual(plan.moves.length, 0, '全部 5 条都被拒');
	});

	test('超过 50 条 ⇒ 截断到上限', async () => {
		const seed: Record<string, string> = {};
		const moves = [];
		for (let i = 0; i < 60; i++) { seed[`/vault/笔记/f${i}.md`] = 'x'; moves.push({ from: `笔记/f${i}.md`, to: `笔记/sub/f${i}.md` }); }
		const fs = createFs(seed);
		const plan = await (KbImportController as any)._parseReorgPlan(
			`<!-- KB_REORG {"moves":${JSON.stringify(moves)}} -->`, VAULT_URI, NOTES_URI, fs.service, quietLog,
		);
		assert.strictEqual(plan.moves.length, 50, '封顶 50 项');
	});
});

suite('buildPendingAsAgentSession（agent 自主读写：集成）', () => {

	const seed = () => ({
		'/vault/库/raw/UI优化篇.md': { content: '# UI优化篇 素材原文', mtime: 100 },
		'/vault/库/raw/已构建.md': { content: '# 已构建素材', mtime: 50 },
		'/vault/笔记/已有/已构建笔记.md': { content: '---\ntitle: 已构建笔记\n---\n', mtime: 200 },
		'/vault/.kb-build-cache.json': JSON.stringify({ [fp('/vault/库/raw/已构建.md')]: fp('/vault/笔记/已有/已构建笔记.md') }),
	});

	test('完整流程：会话创建 + 两阶段消息（挂技能）+ 产出归集 + 缓存回填 + 通知', async () => {
		const fs = createFs(seed());
		const chat = createChatMock(fs);
		const { controller, notices, opened } = createController(fs, { chat: chat.svc });

		const res = await controller.buildPendingAsAgentSession(URI.file(VAULT));

		// ① 会话：只建一个，agent 是知识库专家，标题形如「知识库构建 · …」；页签打开
		assert.strictEqual(chat.created.length, 1, '只建一个会话');
		assert.strictEqual(chat.created[0].agentId, 'knowledge-base-expert');
		assert.ok(/知识库构建 · \d{2}-\d{2} \d{2}:\d{2}/.test(chat.created[0].name), '会话标题带时间');
		assert.strictEqual(opened.length, 1, '打开了一个聊天页签');

		// ② 两条消息：同一 sessionId；带 explicitSkillIds 挂载 kb-build；不传 chatOnly（允许写工具）
		assert.strictEqual(chat.calls.length, 2, 'Phase 1 + Phase 2 两条消息');
		assert.ok(chat.calls.every(c => c.options.agentSessionId === chat.created[0].id), '同一 sessionId');
		assert.deepStrictEqual(chat.calls[0].options.explicitSkillIds, ['kb-build'], '挂载 kb-build 技能');
		assert.ok(!('chatOnly' in chat.calls[0].options), '绝不能传 chatOnly（会过滤掉 file_write）');

		// ③ Phase 1 消息只带数据：素材绝对路径 + sources 引用 + 目录树
		const p1 = chat.calls[0].message;
		assert.ok(p1.includes('素材清单'), 'Phase 1 有素材清单');
		assert.ok(p1.includes('UI优化篇.md'), '清单里有素材文件名');
		// sources 引用的实际形态：`库/raw/ui优化篇.md`（_relativeFromLib：带「库/」前缀、小写；normalizeSourceRef 会再归一）
		assert.ok(p1.toLowerCase().includes('库/raw/ui优化篇.md'), '清单里带 sources 相对引用');
		assert.ok(p1.includes('笔记区现有目录树'), '带目录树快照');
		assert.ok(!p1.includes('Schema 类型定义'), '规则不再塞消息里（已移进技能）');

		// ④ Phase 2 是一句话触发
		assert.ok(chat.calls[1].message.includes('Phase 2'), 'Phase 2 消息');
		assert.ok(chat.calls[1].message.length < 400, 'Phase 2 是短消息');

		// ⑤ 结果：产出归集正确（知识体系.md 不算笔记）
		assert.strictEqual(res.pending, 1, '只有 UI优化篇.md 待构建');
		assert.strictEqual(res.built, 1, '产出 1 篇笔记');
		assert.ok(res.systemDoc?.endsWith('知识体系.md'), '知识体系.md 单独识别');
		assert.strictEqual(res.usedFallback, false);

		// ⑥ 缓存回填：按新笔记 frontmatter 的 sources 反查来源
		const cacheText = fs.content('/vault/.kb-build-cache.json')!;
		const cache = JSON.parse(cacheText) as Record<string, string>;
		assert.ok(cache[fp('/vault/库/raw/UI优化篇.md')]?.endsWith('UI优化技巧.md'), '素材 → 笔记映射写入缓存');

		// ⑦ 通知可见
		assert.ok(notices.some(n => n.message.includes('知识库构建完成')), '有完成通知');
	});

	test('无 chat 服务 ⇒ 自动降级（usedFallback=true），不建会话', async () => {
		const fs = createFs(seed());
		const { controller } = createController(fs);   // 不传 chat
		const res = await controller.buildPendingAsAgentSession(URI.file(VAULT));
		assert.strictEqual(res.usedFallback, true, '走了降级路径');
	});

	test('无待构建素材 ⇒ 早退 + 明确通知（不建会话、不发消息）', async () => {
		const fs = createFs({
			'/vault/库/raw/已构建.md': { content: 'x', mtime: 50 },
			'/vault/笔记/n.md': { content: 'n', mtime: 200 },
			'/vault/.kb-build-cache.json': JSON.stringify({ [fp('/vault/库/raw/已构建.md')]: fp('/vault/笔记/n.md') }),
		});
		const chat = createChatMock(fs);
		const { controller, notices } = createController(fs, { chat: chat.svc });
		const res = await controller.buildPendingAsAgentSession(URI.file(VAULT));
		assert.strictEqual(res.pending, 0);
		assert.strictEqual(chat.created.length, 0, '没有素材就不建会话');
		assert.strictEqual(chat.calls.length, 0, '没有素材就不发消息');
		assert.ok(notices.some(n => n.message.includes('没有待构建的素材')), '空结果也必须可见（通知）');
	});
});
