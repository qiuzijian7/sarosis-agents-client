/*---------------------------------------------------------------------------------------------
 *  ContextCompressionService — _getSessionMessages / _getGitHubToken 单测
 *
 *  覆盖 Phase 1 骨架补全后的两条核心路径：
 *  - _getSessionMessages：listSessions 反查 URI → subscribe 快照 → Turn[] 映射为 ITurnMessage[]
 *  - setAuthToken/_getGitHubToken：token 推送/读取
 *  均为纯逻辑测试（mock agentService），不依赖 live LLM / DI 容器。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ContextCompressionService } from '../../node/contextCompressionService.js';

// ─── Mocks ──────────────────────────────────────────────────────────

const nullLog = { info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, trace: () => { } } as any;

function createService(agentService?: any): ContextCompressionService {
	const sessionStoreStub = {
		insertMemory: () => 'mem_x',
		updateMemory: () => { },
		deleteMemory: () => { },
		getMemories: () => [],
		incrementMemoryAccess: () => { },
		searchWithRelevance: () => [],
		logCompression: () => { },
		getCompressionHistory: () => [],
		getLatestCompression: () => undefined,
		dispose: () => { },
	} as any;
	const configStub = { getValue: () => undefined } as any;
	return new ContextCompressionService(
		sessionStoreStub,
		configStub,
		nullLog,
		{} as any, // copilotApiService（这些路径不使用）
		agentService,
	);
}

function makeTurn(userText: string, assistantText: string, toolName?: string): any {
	const responseParts: any[] = [];
	if (assistantText) {
		responseParts.push({ kind: 'markdown', id: 'p1', content: assistantText });
	}
	if (toolName) {
		responseParts.push({
			kind: 'toolCall',
			toolCall: {
				toolCallId: 'tc-1',
				toolName,
				displayName: toolName,
				result: { content: [{ text: 'tool output text' }] },
			},
		});
	}
	return { id: `turn-${userText}`, userMessage: { text: userText }, responseParts, state: 'completed' };
}

function makeAgentService(opts: { sessions?: any[]; turns?: any[]; subscribedClientIds?: string[] }): any {
	return {
		listSessions: async () => opts.sessions ?? [],
		subscribe: async (resource: URI, clientId: string) => {
			opts.subscribedClientIds?.push(clientId);
			return { resource, state: { turns: opts.turns ?? [] }, fromSeq: 0 };
		},
		unsubscribe: (_resource: URI, _clientId: string) => { },
	};
}

// ─── Tests ──────────────────────────────────────────────────────────

suite('ContextCompressionService', () => {

	suite('_getSessionMessages', () => {

		test('returns empty when agentService unavailable', async () => {
			const svc = createService(undefined);
			const messages = await (svc as any)._getSessionMessages('abc');
			assert.deepStrictEqual(messages, []);
		});

		test('returns empty when session id not found', async () => {
			const svc = createService(makeAgentService({ sessions: [{ session: URI.parse('copilot:/other-id') }] }));
			const messages = await (svc as any)._getSessionMessages('abc');
			assert.deepStrictEqual(messages, []);
		});

		test('maps turns to user/assistant/tool messages', async () => {
			const turns = [
				makeTurn('deploy the app', 'I will run the pipeline', 'run_terminal_command'),
				makeTurn('looks good', 'Done.'),
			];
			const svc = createService(makeAgentService({
				sessions: [{ session: URI.parse('copilot:/abc-123') }],
				turns,
			}));
			const messages = await (svc as any)._getSessionMessages('abc-123');
			assert.strictEqual(messages.length, 5); // user+tool+assistant + user+assistant
			assert.deepStrictEqual(messages.map((m: any) => m.role), ['user', 'tool', 'assistant', 'user', 'assistant']);
			assert.strictEqual(messages[0].content, 'deploy the app');
			assert.strictEqual(messages[1].toolName, 'run_terminal_command');
			assert.strictEqual(messages[1].toolCallId, 'tc-1');
			assert.ok(messages[1].content.includes('tool output text'));
			assert.strictEqual(messages[2].content, 'I will run the pipeline');
		});

		test('matches session by full URI string too', async () => {
			const svc = createService(makeAgentService({
				sessions: [{ session: URI.parse('copilot:/abc-123') }],
				turns: [makeTurn('hi', 'hello')],
			}));
			const messages = await (svc as any)._getSessionMessages('copilot:/abc-123');
			assert.strictEqual(messages.length, 2);
		});

		test('unsubscribes after reading snapshot', async () => {
			const subscribed: string[] = [];
			let unsubscribed = false;
			const agentService = {
				listSessions: async () => [{ session: URI.parse('copilot:/abc') }],
				subscribe: async (resource: URI, clientId: string) => {
					subscribed.push(clientId);
					return { resource, state: { turns: [] }, fromSeq: 0 };
				},
				unsubscribe: () => { unsubscribed = true; },
			};
			const svc = createService(agentService);
			await (svc as any)._getSessionMessages('abc');
			assert.deepStrictEqual(subscribed, ['context-compression']);
			assert.strictEqual(unsubscribed, true);
		});
	});

	suite('_turnsToMessages', () => {

		test('concatenates multiple markdown parts into one assistant message', () => {
			const svc = createService(undefined);
			const turn = {
				id: 't1',
				userMessage: { text: 'q' },
				responseParts: [
					{ kind: 'markdown', id: 'p1', content: 'first ' },
					{ kind: 'markdown', id: 'p2', content: 'second' },
				],
				state: 'completed',
			};
			const messages = (svc as any)._turnsToMessages([turn]);
			assert.strictEqual(messages.length, 2);
			assert.strictEqual(messages[1].content, 'first second');
		});

		test('truncates long tool output at 4000 chars', () => {
			const svc = createService(undefined);
			const big = 'x'.repeat(10000);
			const turn = makeTurn('u', '', 'big_tool');
			turn.responseParts[0].toolCall.result = { content: [{ text: big }] };
			const messages = (svc as any)._turnsToMessages([turn]);
			const toolMsg = messages.find((m: any) => m.role === 'tool');
			assert.ok(toolMsg.content.length <= 4000);
		});

		test('skips empty user message and empty assistant text', () => {
			const svc = createService(undefined);
			const messages = (svc as any)._turnsToMessages([
				{ id: 't1', userMessage: { text: '' }, responseParts: [], state: 'completed' },
			]);
			assert.deepStrictEqual(messages, []);
		});
	});

	suite('setAuthToken / _getGitHubToken', () => {

		test('token roundtrip', async () => {
			const svc = createService(undefined);
			assert.strictEqual(await (svc as any)._getGitHubToken(), undefined);
			svc.setAuthToken('ghp_test_token');
			assert.strictEqual(await (svc as any)._getGitHubToken(), 'ghp_test_token');
			svc.setAuthToken(undefined);
			assert.strictEqual(await (svc as any)._getGitHubToken(), undefined);
		});
	});
});
