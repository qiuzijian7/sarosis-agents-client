/*---------------------------------------------------------------------------------------------
 *  chatMessagesDerivedContract.test.ts — 「派生发送副本」标记契约（2026-09-20，源码级 + 行为级）
 *
 *  背景（真机日志 vscode-app-1789900477124 取证 ✓）：
 *   LMBridge 的 sanitize 回写（languageModelsBridge:~662）声称 "orphan fix persisted"，
 *   但它只对**真实历史数组**有效（legacy 路径直传历史引用 ✓）。pi 路径传的是
 *   `convertToChatMessages` 派生的一次性副本 ⇒ 旧代码照样 splice、照样谎报已持久化，
 *   而内核 transcript 毫无变化：孤儿下一轮原样复发（实测每轮固定剥 6-7 条），
 *   把排障引向错误方向（真因是转换层漏 toolCallId，已同日修复）。
 *
 *  修法（本文件钉住 ✓）：
 *   ① 派生副本产出方打 `markChatMessagesDerived` 标记（pi 适配器已打 ✓）；
 *   ② 守卫侧按 `isChatMessagesDerived` 分流：派生 ⇒ 跳过无效回写 + 如实日志；
 *      真实历史 ⇒ 保持既有 splice + "persisted" 语义不变（legacy 无回归 ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/chatMessagesDerivedContract.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	CHAT_MESSAGES_DERIVED,
	isChatMessagesDerived,
	markChatMessagesDerived,
} from '../../common/providers.js';
import { convertToChatMessages } from '../../browser/piLoop/streamAdapter.js';

suite('「派生发送副本」标记契约（sanitize 回写语义纠偏）', () => {

	const BRIDGE_REL = 'src/vs/sessions/contrib/agentStudio/browser/languageModelsBridge.ts';
	const ADAPTER_REL = 'src/vs/sessions/contrib/agentStudio/browser/piLoop/streamAdapter.ts';
	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	// 剥离注释（本仓教训：注释里刻意引用旧日志/旧写法作取证，连注释查会假红 ✓）
	const stripComments = (src: string): string => src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	test('★★★ 标记语义：普通数组 false；标记后 true（且标记不可枚举、不污染序列化）', () => {
		const plain = [{ role: 'user', content: 'a' }] as never[];
		assert.strictEqual(isChatMessagesDerived(plain), false, '未标记数组必须判为非派生 ✗');
		assert.strictEqual(isChatMessagesDerived(undefined), false);
		assert.strictEqual(isChatMessagesDerived({} as never), false);

		const marked = markChatMessagesDerived(plain as never);
		assert.strictEqual(isChatMessagesDerived(marked), true, '标记后必须判为派生 ✗');
		// 不可枚举 ⇒ JSON.stringify / 展开循环不会带上它（不污染调试转储与回写内容 ✓）
		assert.strictEqual(Object.keys(marked as object).includes(String(CHAT_MESSAGES_DERIVED)), false);
		assert.ok(!JSON.stringify(marked).includes('chatMessagesDerived'));
	});

	test('★★★ pi 适配器产出的消息数组必须带派生标记（真实行为断言）', () => {
		const converted = convertToChatMessages([{ role: 'user', content: 'hi' }] as never);
		assert.strictEqual(isChatMessagesDerived(converted), true,
			'convertToChatMessages 产出是派生副本 ⇒ 必须打标（否则守卫会重复无效回写 ✗）');
		// 源码级防回归：标记调用必须在 convertToChatMessages 内（不是别处顺手打的）
		const code = stripComments(readSrc(ADAPTER_REL));
		const fnIdx = code.indexOf('export function convertToChatMessages');
		assert.ok(fnIdx !== -1 && code.slice(fnIdx, fnIdx + 400).includes('markChatMessagesDerived('),
			'convertToChatMessages 必须打标（派生一次性副本 ✗）');
	});

	test('★★★ 守卫分流：派生副本 ⇒ 跳过回写 + 如实日志；真实历史 ⇒ 保持既有 splice/persisted', () => {
		const code = stripComments(readSrc(BRIDGE_REL));
		assert.ok(code.includes('isChatMessagesDerived(messages)'), '必须按派生标记分流 ✗');
		// 派生分支：不得再打 “orphan fix persisted”（那是谎报 ✗），且要给出真因指引
		assert.ok(code.includes('nothing rewritten durably'),
			'派生副本必须如实说明「未持久化」（否则日志把排障引向错误方向 ✗）');
		assert.ok(code.includes('Fix the producing conversion instead of relying on write-back'),
			'派生分支必须点明「去修生产侧转换」这一真因方向 ✗');
		// 真实历史分支：既有 splice + persisted 语义必须保留（legacy 无回归 ✓）
		assert.ok(code.includes('messages.splice(0, messages.length, ...(sanitizedMessages'),
			'真实历史数组的回写不得删（legacy prompt cache 前缀稳定性依赖它 ✗）');
		assert.ok(code.includes('orphan fix persisted'),
			'真实历史分支的 persisted 语义必须保留 ✗');
		// 顺序：分流判定必须在 splice 之前（否则派生副本照样被无效回写 ✗）
		const guardIdx = code.indexOf('const callerMessagesDerived = isChatMessagesDerived(messages)');
		const spliceIdx = code.indexOf('messages.splice(0, messages.length, ...(sanitizedMessages');
		assert.ok(guardIdx !== -1 && spliceIdx !== -1 && guardIdx < spliceIdx,
			'分流判定必须**先于** splice ✗');
		// 派生分支不得出现在 splice 的同一 if 里（必须互斥）
		assert.ok(code.includes('else if (callerMessagesDerived && sanitizedMessages.length < normalizedMessages.length)'),
			'派生分支必须与真实历史分支互斥（else if ✗）');
	});
});
