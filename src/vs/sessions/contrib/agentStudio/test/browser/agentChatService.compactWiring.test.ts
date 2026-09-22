/*---------------------------------------------------------------------------------------------
 *  agentChatService.compactWiring.test.ts — 手动压缩/推迟压缩的接线与取消语义（源码级断言）
 *
 *  背景（2026-09-22，缺点⑥③⑦修复 + 阶段④-d 重构适配）：
 *  压缩编排已迁入 `contextMaintenance.ts`（ContextMaintenance 类），拦截与 turn 收尾
 *  仍在 `agentChatService.ts` —— 本测试对**两个文件**做源码级断言
 *  （同 `agentChatService.cancelPlaceholder.test.ts` 的既有模式：剥注释后断言代码事实）。
 *  钉住的不变量：
 *   ① `/compact` 拦截必须在流建立**之前**（命令不产生 turn、不抢流 ✓）；
 *   ② 推迟压缩钩子必须在 `return chatMessage` 之前、且 fire-and-forget（不阻塞返回 ✓）；
 *   ③ 竞态防护：写边界必须在会话写锁内重读校验（摘要期间新消息落盘 ⇒ 放弃 ✓）；
 *   ④ /compact-reset 只移除边界消息（其余一条不动 ✓）；
 *   ⑤ 取消语义：取消 ≠ 回滚 —— 已落盘边界照常生效；推迟写入失败只告警（自愈 ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/agentChatService.compactWiring.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('压缩编排接线与取消语义（源码级）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const REL_SVC = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';
	const REL_MAINT = 'src/vs/sessions/contrib/agentStudio/browser/contextMaintenance.ts';

	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};

	/** 剥注释（本仓教训：新代码的注释会刻意引用旧文案取证，连注释一起查必然假红 ✗）。 */
	const stripComments = (src: string): string => src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	test('① /compact 拦截在流建立之前（命令不产生 turn、不抢流 ✓）', () => {
		const code = stripComments(readSrc(REL_SVC));
		const interceptAt = code.indexOf('return this._handleCompactSlashCommand(');
		const streamSetupAt = code.indexOf('const controller = new AbortController();');
		assert.ok(interceptAt > 0, 'sendMessage 里必须有 /compact 拦截调用 ✓');
		assert.ok(streamSetupAt > 0, 'sendMessage 里必须存在流建立点（基准代码 ✓）');
		assert.ok(interceptAt < streamSetupAt,
			'拦截必须先于流建立 ✓（否则 /compact 会掐掉上一个流、还注册一个用不上的 controller ✗）');
		assert.ok(code.includes("options.source === 'user'"),
			'拦截必须限 source=user/空 ✓（快捷回复/看板/workflow 的文本可能恰以 /compact 开头 ✗）');
	});

	test('② 推迟压缩钩子在 return 之前、且 fire-and-forget（不阻塞 sendMessage 返回 ✓）', () => {
		const code = stripComments(readSrc(REL_SVC));
		const hookAt = code.indexOf('void this._maintenance.runDeferredCompaction(agentId, options.agentSessionId);');
		assert.ok(hookAt > 0, '必须有推迟压缩的 fire-and-forget 挂载（void ⇒ 不 await ✓）');
		const returnAfterHook = code.indexOf('return chatMessage;', hookAt);
		assert.ok(returnAfterHook > hookAt,
			'钩子之后必须跟到 sendMessage 的 return（钩子在收尾段 ✓；流收尾后无人启动补做 ✗）');
		assert.ok(/!\((?:acc\.)?pendingCompaction && (?:acc\.)?pendingCompaction\.tokensSaved > 0\)/.test(code),
			'本轮已落边界（高压同步压缩）⇒ 必须跳过补做（不得重复压缩 ✗）；命名随重构漂移（acc. 前缀）⇒ 正则兼容 ✓');
	});

	test('③ 竞态防护：写边界必须在写锁内重读校验尾部（摘要期间的新消息 ⇒ 放弃 ✓）', () => {
		const code = stripComments(readSrc(REL_MAINT));
		assert.ok(code.includes('this.deps.withSessionLogLock(key, async'),
			'边界写入必须进会话写锁（与 append/snapshot 串行化 ✓）');
		assert.ok(code.includes('fresh.length !== raw.length') && code.includes('fresh[fresh.length - 1]?.id !== lastId'),
			'锁内必须重读并校验尾部未变（条数 + 末条 id 双重校验 ✓）');
		assert.ok(code.includes('this.deps.writeSessionSnapshotLocked('),
			'锁内必须调 writeSessionSnapshotLocked（锁不可重入 ⇒ 严禁 persistSnapshot 死锁 ✗✓）');
	});

	test('④ /compact-reset：只移除压缩边界（其余消息一条不动 ✓）', () => {
		const code = stripComments(readSrc(REL_MAINT));
		assert.ok(code.includes("m?.metadata?.type !== COMPACTION_METADATA_TYPE"),
			'reset 的过滤条件必须精确命中边界元数据 ✓');
		const svc = stripComments(readSrc(REL_SVC));
		assert.ok(/compact\|compact-reset/.test(svc),
			'拦截正则必须同时覆盖 /compact 与 /compact-reset ✓');
	});

	test('⑤ 取消语义（cancellation ≠ rollback）：取消轮次的边界照常落盘 + 无收益不落 ✓', () => {
		const code = stripComments(readSrc(REL_SVC));
		// 两条边界落盘路径（多 turn / 回退）都必须带 tokensSaved>0 守卫 ——
		// 取消的轮次若已压缩且有效 ⇒ 边界落盘生效（取消 ≠ 回滚 ✓，对齐 OpenClaw）；
		// 压缩无收益的 ⇒ 不落 ✓（fail-safe ②）。
		const guards = code.match(/(?:acc\.)?pendingCompaction && (?:acc\.)?pendingCompaction\.tokensSaved > 0/g) ?? [];
		assert.ok(guards.length >= 3,
			`两条落盘路径 + 推迟钩子守卫都必须有 tokensSaved>0 判定（实际 ${guards.length} 处 ✗；命名随重构漂移 ⇒ 正则兼容 acc. 前缀 ✓）`);
		const maint = stripComments(readSrc(REL_MAINT));
		assert.ok(maint.includes('deferred compaction failed'),
			'推迟压缩失败必须只记日志（下轮 preflight 重判，自愈 ✓）');
	});
});
