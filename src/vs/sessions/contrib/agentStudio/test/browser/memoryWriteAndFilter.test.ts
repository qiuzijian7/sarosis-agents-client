/*---------------------------------------------------------------------------------------------
 *  memoryWriteAndFilter.test.ts — 记忆写入 + 显示 + 过滤 完整链路测试
 *
 *  覆盖：
 *    1. _storeTurnObservations: LLM 流式输出过程中消息写入记忆（角色筛选、去重、长度截断）
 *    2. matchesTier + scope + search 过滤逻辑
 *    3. 端到端：写入 → 搜索 → 过滤 → 校验数据完整性
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentOSService } from '../../browser/agentOSService.js';

// ─── matchesTier 的纯函数副本（从 memoryDetailEditorPane.ts 复制，
//     用于纯逻辑测试，不引入 DOM/DI 依赖） ───────────────────────────
type LayerFilter = 'all' | 'working' | 'pattern' | 'fact' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'semantic' | 'procedural';
type ScopeFilter = 'all' | 'workspace' | 'session' | 'agent';

interface IMemoryEntry {
	id: string;
	type: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

const EPISODIC_TYPES: ReadonlySet<string> = new Set(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']);
function matchesTier(mem: IMemoryEntry, tier: LayerFilter): boolean {
	if (tier === 'all') return true;
	if (tier === 'episodic') return EPISODIC_TYPES.has(mem.type);
	return mem.type === tier;
}

function matchesScope(mem: IMemoryEntry, scope: ScopeFilter, sessionId: string, agentId: string, workspaceId: string): boolean {
	if (scope === 'all') return true;
	const session = mem.metadata?.['sessionId'] as string ?? '';
	const agId = mem.metadata?.['agentId'] as string ?? '';
	const wsId = mem.metadata?.['workspaceId'] as string ?? '';
	switch (scope) {
		case 'workspace': return wsId === workspaceId;
		case 'session': return session === sessionId;
		case 'agent': return agId === agentId;
		default: return true;
	}
}

function matchesSearch(mem: IMemoryEntry, query: string): boolean {
	if (!query) return true;
	const lower = query.toLowerCase();
	return (
		mem.content.toLowerCase().includes(lower) ||
		(mem.id ?? '').toLowerCase().includes(lower) ||
		(mem.type ?? '').toLowerCase().includes(lower)
	);
}

suite('Memory Write & Filter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── 辅助工厂 ─────────────────────────────────────────────────────────

	function createAgentOSService(): any {
		// 与 AgentOSService 当前构造签名保持一致：
		// (logService, environmentService, workspaceContextService, pathService, fileService, instantiationService)
		const logService = new NullLogService();
		const envStub: any = { userRoamingDataHome: URI.file('/tmp'), appRoot: '/tmp' };
		const wsStub: any = { getWorkspace: () => ({ folders: [] as any[] }) };
		const pathStub: any = { userHome: async () => URI.file('/tmp') };
		const fileStub: any = {};
		const instStub: any = { invokeFunction: (fn: any) => fn(() => undefined) };
		return new (AgentOSService as any)(logService, envStub, wsStub, pathStub, fileStub, instStub) as any;
	}

	// 支持搜索的 MemoryProvider（writeMemory 存入内存，searchMemory 按关键词返回）
	class StoredMemoryProvider {
		readonly id = 'test-memory';
		private _store: IMemoryEntry[] = [];
		/** 2026-07-25 P0：_storeTurnObservations 改道 observe（mem:obs）后的调用记录 */
		readonly observeCalls: Array<{ agentId: string; payload: any }> = [];
		readonly writeCalls: Array<{ agentId: string; entry: any }> = [];

		async writeMemory(agentId: string, entry: any): Promise<void> {
			this.writeCalls.push({ agentId, entry });
			this._store.push({
				id: entry.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				type: entry.type ?? 'working',
				content: entry.content ?? '',
				metadata: { agentId, ...entry.metadata },
				timestamp: entry.timestamp ?? Date.now(),
			});
		}

		/** 会话观察写入（mem:obs）——映射为既有断言形状（role/content/source 字段） */
		async observe(agentId: string, payload: any): Promise<void> {
			this.observeCalls.push({ agentId, payload });
			const data = payload?.data ?? {};
			this._store.push({
				id: `obs-${payload.sessionId}-${this._store.length}`,
				type: 'episodic',
				content: data.content ?? '',
				metadata: { agentId, role: data.role, sessionId: payload.sessionId, source: payload.hookType },
				timestamp: Date.now(),
			});
		}

		async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
			if (!query || query === '*') {
				return this._store.filter(m => (m.metadata?.['agentId'] as string) === agentId);
			}
			const lower = query.toLowerCase();
			return this._store.filter(m =>
				(m.metadata?.['agentId'] as string) === agentId &&
				m.content.toLowerCase().includes(lower)
			);
		}

		async loadContext(agentId: string): Promise<any> {
			const mems = this._store.filter(m => (m.metadata?.['agentId'] as string) === agentId);
			const longTerm = mems.filter(m => m.type === 'episodic' || m.type === 'semantic' || m.type === 'procedural');
			const shortTerm = mems.filter(m => m.type === 'working');
			return { longTermMemories: longTerm, shortTermMemories: shortTerm, injectedContext: '' };
		}

		getAll(): IMemoryEntry[] { return [...this._store]; }
		reset(): void { this._store = []; }
	}

	const AGENT = 'test-agent';
	const SESSION = 'sess-001';
	const WORKSPACE = 'test-workspace';

	// ═════════════════════════════════════════════════════════════════════
	// Suite 1: _storeTurnObservations — 消息写入记忆
	// ═════════════════════════════════════════════════════════════════════

	suite('_storeTurnObservations', () => {

		test('user message is written with correct metadata', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'user', content: 'Please analyze the authentication module in src/auth.ts' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1, 'one memory should be written');
				const m = all[0];
				assert.ok(m.id.startsWith('obs-'), `id should start with obs-, got ${m.id}`);
				assert.strictEqual(m.type, 'episodic');
				assert.ok(m.content.includes('[user]'), 'content should include [user] prefix');
				assert.ok(m.content.includes('src/auth.ts'), 'content should contain the message text');
				assert.strictEqual(m.metadata?.['role'], 'user');
				assert.strictEqual(m.metadata?.['sessionId'], SESSION);
				assert.strictEqual(m.metadata?.['source'], 'turn_observation');
				assert.strictEqual(m.metadata?.['agentId'], AGENT);
			} finally {
				svc.dispose();
			}
		});

		test('assistant message is written', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'assistant', content: 'The auth module uses JWT tokens with a 15-minute expiry.' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1);
				assert.strictEqual(all[0].metadata?.['role'], 'assistant');
				assert.ok(all[0].content.includes('[assistant]'));
				assert.ok(all[0].content.includes('JWT tokens'));
			} finally {
				svc.dispose();
			}
		});

		test('tool message is written', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'tool', content: '{"filePath":"src/auth.ts","lineCount":256}' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1);
				assert.strictEqual(all[0].metadata?.['role'], 'tool');
			} finally {
				svc.dispose();
			}
		});

		test('system message is NOT written', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'system', content: 'You are a helpful assistant specialized in code analysis.' },
				{ role: 'user', content: 'Hello, what can you help with?' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1, 'only user message should be written, system skipped');
				assert.strictEqual(all[0].metadata?.['role'], 'user');
			} finally {
				svc.dispose();
			}
		});

		test('null/undefined message is skipped', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				null,
				undefined,
				{ role: 'user', content: 'valid message with enough chars' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1);
			} finally {
				svc.dispose();
			}
		});

		test('short content (<8 chars) is skipped', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'user', content: 'Hi' },
				{ role: 'user', content: 'Please analyze the complete authentication module' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1, '"Hi" should be skipped, only long message written');
				assert.ok(all[0].content.includes('Please analyze'));
			} finally {
				svc.dispose();
			}
		});

		test('duplicate content (same hash) is deduplicated', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const sameContent = 'This is the exact same message repeated for dedup test';
			const messages = [
				{ role: 'user', content: sameContent },
				{ role: 'user', content: sameContent },
				{ role: 'assistant', content: sameContent },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1, 'same content hash should be deduplicated to 1');
			} finally {
				svc.dispose();
			}
		});

		test('2026-07-25 P0: 观察改道 mem:obs —— 走 observe 而非 writeMemory', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'user', content: 'Remember to check the deploy pipeline config tomorrow' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				assert.strictEqual(provider.observeCalls.length, 1, 'should write via observe (session-scoped)');
				assert.strictEqual(provider.writeCalls.length, 0, 'should NOT write via writeMemory (long-term)');
				assert.strictEqual(provider.observeCalls[0].payload.hookType, 'turn_observation');
				assert.strictEqual(provider.observeCalls[0].payload.sessionId, SESSION);
				assert.ok(String(provider.observeCalls[0].payload.data.content).includes('deploy pipeline'));
			} finally {
				svc.dispose();
			}
		});

		test('content is truncated to 1500 chars', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const longContent = 'X'.repeat(3000);
			const messages = [
				{ role: 'user', content: longContent },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				assert.strictEqual(all.length, 1);
				// [user] prefix = 6 chars + space + content up to 1500 = max ~1507
				const contentPart = all[0].content.replace('[user] ', '');
				assert.ok(contentPart.length <= 1500, `truncated content should be ≤1500 chars, got ${contentPart.length}`);
			} finally {
				svc.dispose();
			}
		});

		test('full turn: user + assistant + tool all written', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'system', content: 'You are a code reviewer.' },
				{ role: 'user', content: 'Review the auth module for security vulnerabilities' },
				{ role: 'assistant', content: 'I will analyze auth.ts for potential issues now using the read_file tool' },
				{ role: 'tool', content: '{"file":"auth.ts","lines":256,"found":"JWT secret hardcoded"}' },
				{ role: 'assistant', content: 'Found a critical vulnerability: JWT secret is hardcoded in auth.ts line 42' },
			];
			try {
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				const all = provider.getAll();
				// system skipped, but 4 non-system messages
				assert.strictEqual(all.length, 4, '4 non-system messages should be written');
				const roles = all.map(m => m.metadata?.['role']);
				assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
				// verify content includes key terms
				assert.ok(all[2].content.includes('JWT secret hardcoded'), 'tool result content should be preserved');
			} finally {
				svc.dispose();
			}
		});

	});

	// ═════════════════════════════════════════════════════════════════════
	// Suite 2: matchesTier + scope + search 过滤逻辑
	// ═════════════════════════════════════════════════════════════════════

	suite('matchesTier', () => {

		const entries: IMemoryEntry[] = [
			{ id: 'm1', type: 'working', content: 'working memory content' },
			{ id: 'm2', type: 'pattern', content: 'pattern discovery: users prefer dark theme' },
			{ id: 'm3', type: 'fact', content: 'port 8080 is the default API port' },
			{ id: 'm4', type: 'preference', content: 'prefers TypeScript over JavaScript' },
			{ id: 'm5', type: 'architecture', content: 'microservices with gRPC communication' },
			{ id: 'm6', type: 'bug', content: 'NullPointerException when config is missing' },
			{ id: 'm7', type: 'workflow', content: 'deploy: npm run build → docker build → push → deploy' },
			{ id: 'm8', type: 'semantic', content: 'user is a senior backend engineer' },
			{ id: 'm9', type: 'procedural', content: 'multi-step procedure for database migration' },
		];

		test('tier "all" matches everything', () => {
			const filtered = entries.filter(e => matchesTier(e, 'all'));
			assert.strictEqual(filtered.length, 9);
		});

		test('tier "working" matches only working type', () => {
			const filtered = entries.filter(e => matchesTier(e, 'working'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].type, 'working');
		});

		test('tier "fact" matches only fact type', () => {
			const filtered = entries.filter(e => matchesTier(e, 'fact'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].type, 'fact');
		});

		test('tier with no matching entries returns empty', () => {
			const onlyWorking = entries.filter(e => e.type === 'working');
			const filtered = onlyWorking.filter(e => matchesTier(e, 'semantic'));
			assert.strictEqual(filtered.length, 0);
		});

		test('all 9 tier types individually filter correctly', () => {
			const tiers: LayerFilter[] = ['working', 'pattern', 'fact', 'preference', 'architecture', 'bug', 'workflow', 'semantic', 'procedural'];
			for (const tier of tiers) {
				const filtered = entries.filter(e => matchesTier(e, tier));
				assert.strictEqual(filtered.length, 1, `tier "${tier}" should have exactly 1 entry`);
				assert.strictEqual(filtered[0].type, tier);
			}
		});

	});

	suite('matchesScope', () => {

		const SID = 'sess-abc';
		const AID = 'agent-xyz';
		const WSID = 'ws-proj';

		const scopeEntries: IMemoryEntry[] = [
			{ id: 's1', type: 'working', content: 'all scope', metadata: { sessionId: SID, agentId: AID, workspaceId: WSID } },
			{ id: 's2', type: 'working', content: 'no metadata', metadata: {} },
			{ id: 's3', type: 'working', content: 'other session', metadata: { sessionId: 'sess-xyz', agentId: AID, workspaceId: WSID } },
		];

		test('scope "all" matches everything', () => {
			const filtered = scopeEntries.filter(e => matchesScope(e, 'all', SID, AID, WSID));
			assert.strictEqual(filtered.length, 3);
		});

		test('scope "workspace" matches only workspace-scoped', () => {
			const filtered = scopeEntries.filter(e => matchesScope(e, 'workspace', SID, AID, WSID));
			assert.strictEqual(filtered.length, 2);  // s1 + s3 have WSID; s2 has no workspaceId
		});

		test('scope "session" matches only session-scoped', () => {
			const filtered = scopeEntries.filter(e => matchesScope(e, 'session', SID, AID, WSID));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].metadata?.['sessionId'], SID);
		});

		test('scope "agent" matches only agent-scoped', () => {
			const filtered = scopeEntries.filter(e => matchesScope(e, 'agent', SID, AID, WSID));
			assert.strictEqual(filtered.length, 2);  // s1 + s3 have AID; s2 has no agentId
		});

	});

	suite('matchesSearch', () => {

		const searchEntries: IMemoryEntry[] = [
			{ id: 'mem-1', type: 'working', content: 'This is about authentication module' },
			{ id: 'mem-2', type: 'pattern', content: 'Users prefer dark theme in the editor' },
			{ id: 'mem-3', type: 'fact', content: 'API endpoint is https://api.example.com' },
			{ id: 'token-auth', type: 'fact', content: 'JWT tokens expire after 24 hours' },
		];

		test('empty query matches all', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, ''));
			assert.strictEqual(filtered.length, 4);
		});

		test('query matches content', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, 'authentication'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].id, 'mem-1');
		});

		test('query matches id', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, 'token'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].id, 'token-auth');
		});

		test('query matches type', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, 'pattern'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].type, 'pattern');
		});

		test('case-insensitive search', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, 'DARK THEME'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].id, 'mem-2');
		});

		test('query with no match returns empty', () => {
			const filtered = searchEntries.filter(e => matchesSearch(e, 'nonexistent'));
			assert.strictEqual(filtered.length, 0);
		});

	});

	suite('combined filters (tier + scope + search)', () => {

		function makeEntry(id: string, type: string, content: string, overrides?: Partial<Record<string, unknown>>): IMemoryEntry {
			return {
				id,
				type,
				content,
				metadata: {
					agentId: 'ag-1',
					sessionId: 'sess-main',
					workspaceId: 'ws-main',
					...overrides,
				},
			};
		}

		const combinedEntries = [
			makeEntry('m1', 'working', 'initial observation of the system'),
			makeEntry('m2', 'working', 'user asks about authentication flow'),
			makeEntry('m3', 'pattern', 'repeated pattern: users prefer dark mode'),
			makeEntry('m4', 'fact', 'the API runs on port 3000'),
			makeEntry('m5', 'bug', 'null pointer when config file missing'),
			makeEntry('m6', 'bug', 'timeout on large file uploads over 500MB'),
			makeEntry('m7', 'workflow', 'deploy procedure: build, test, push, tag'),
			makeEntry('m8', 'fact', 'database connection uses connection pooling', { agentId: 'ag-2', sessionId: 'sess-other', workspaceId: 'ws-other' }),
		];

		test('filter: layer=bug + scope=agent + search=null => 2 results', () => {
			const AID = 'ag-1';
			const layer: LayerFilter = 'bug';
			const scope: ScopeFilter = 'agent';
			const query = '';
			const filtered = combinedEntries
				.filter(e => matchesTier(e, layer))
				.filter(e => matchesScope(e, scope, 'sess-main', AID, 'ws-main'))
				.filter(e => matchesSearch(e, query));
			assert.strictEqual(filtered.length, 2);
			assert.ok(filtered.every(e => e.type === 'bug'));
		});

		test('filter: layer=all + scope=session + search=null => 7 results (ag-1 session)', () => {
			const SID = 'sess-main';
			const filtered = combinedEntries
				.filter(e => matchesTier(e, 'all'))
				.filter(e => matchesScope(e, 'session', SID, 'ag-1', 'ws-main'))
				.filter(e => matchesSearch(e, ''));
			assert.strictEqual(filtered.length, 7, '8 entries total, but m8 has different agent, so 7 from ag-1 session');
		});

		test('filter: layer=fact + scope=all + search=port => 1 result', () => {
			const filtered = combinedEntries
				.filter(e => matchesTier(e, 'fact'))
				.filter(e => matchesScope(e, 'all', '', '', ''))
				.filter(e => matchesSearch(e, 'port'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].id, 'm4');
		});

		test('filter: layer=all + scope=all + search=upload => 1 result (m6)', () => {
			const filtered = combinedEntries
				.filter(e => matchesTier(e, 'all'))
				.filter(e => matchesScope(e, 'all', '', '', ''))
				.filter(e => matchesSearch(e, 'upload'));
			assert.strictEqual(filtered.length, 1);
			assert.strictEqual(filtered[0].id, 'm6');
		});

		test('no results when filters are too restrictive', () => {
			const filtered = combinedEntries
				.filter(e => matchesTier(e, 'semantic'))
				.filter(e => matchesScope(e, 'session', 'nonexistent', 'ag-1', 'ws-main'))
				.filter(e => matchesSearch(e, ''));
			assert.strictEqual(filtered.length, 0);
		});

	});

	// ═════════════════════════════════════════════════════════════════════
	// Suite 3: 端到端 — 写入 → 搜索 → 校验
	// ═════════════════════════════════════════════════════════════════════

	suite('write → search → verify', () => {

		test('writes during turn are searchable and return correctly', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			const messages = [
				{ role: 'user', content: 'What is the authentication flow for API v2?' },
				{ role: 'assistant', content: 'The auth flow uses JWT: request → middleware → validate → attach user' },
				{ role: 'tool', content: '{"file":"src/middleware/auth.ts","method":"validateJWT","tokenSource":"Bearer header"}' },
			];
			try {
				// Step 1: Write via _storeTurnObservations
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, messages);
				assert.strictEqual(provider.getAll().length, 3);

				// Step 2: Search
				const results = await provider.searchMemory(AGENT, '');
				assert.strictEqual(results.length, 3);

				// Step 3: Verify content integrity
				const contents = results.map(r => r.content);
				assert.ok(contents.some(c => c.includes('authentication flow')), 'user message content should be searchable');
				assert.ok(contents.some(c => c.includes('JWT')), 'assistant content should be searchable');
				assert.ok(contents.some(c => c.includes('validateJWT')), 'tool result should be searchable');

				// Step 4: Search by keyword
				const authResults = await provider.searchMemory(AGENT, 'auth');
				assert.ok(authResults.length >= 2, 'auth keyword should match user + assistant messages');

				const toolResults = await provider.searchMemory(AGENT, 'middleware');
				assert.ok(toolResults.length >= 1, 'middleware keyword should match tool result');
			} finally {
				svc.dispose();
			}
		});

		test('multiple turns accumulate correctly', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			try {
				// Turn 1
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, [
					{ role: 'user', content: 'Analyze the user module please' },
					{ role: 'assistant', content: 'The user module has 3 sub-modules: auth, profile, settings' },
				]);
				assert.strictEqual(provider.getAll().length, 2);

				// Turn 2 — new observations
				await (svc as any)._storeTurnObservations(provider, AGENT, SESSION, [
					{ role: 'user', content: 'Now check the payment module too' },
					{ role: 'assistant', content: 'Payment uses Stripe integration with webhooks' },
				]);
				const all = provider.getAll();
				// Turn 2's user message is new, assistant too → 2 + 2 = 4 total
				assert.strictEqual(all.length, 4, 'accumulated 4 messages across 2 turns');

				// Verify all are Type → episodic
				for (const m of all) {
					assert.strictEqual(m.type, 'episodic');
					assert.strictEqual(m.metadata?.['source'], 'turn_observation');
				}
			} finally {
				svc.dispose();
			}
		});

		test('different agents are isolated in search', async () => {
			const svc = createAgentOSService();
			const provider = new StoredMemoryProvider();
			try {
				await (svc as any)._storeTurnObservations(provider, 'agent-alpha', SESSION, [
					{ role: 'user', content: 'Alpha agent specific task about frontend components' },
				]);
				await (svc as any)._storeTurnObservations(provider, 'agent-beta', SESSION, [
					{ role: 'user', content: 'Beta agent task about database migration scripts' },
				]);

				const alphaResults = await provider.searchMemory('agent-alpha', '');
				const betaResults = await provider.searchMemory('agent-beta', '');

				assert.strictEqual(alphaResults.length, 1);
				assert.ok(alphaResults[0].content.includes('frontend'));

				assert.strictEqual(betaResults.length, 1);
				assert.ok(betaResults[0].content.includes('database'));
			} finally {
				svc.dispose();
			}
		});

	test('filter by type: episodic layer, working, fact correctly separated', () => {
		// agentmemory 原版：episodic 是「层」（原生类型集合），working 是层，fact 是层内原生类型
		const all: IMemoryEntry[] = [
			{ id: 'm-0', type: 'pattern', content: 'recurring deploy pattern observed across sessions', metadata: { agentId: AGENT, sessionId: SESSION, source: 'consolidation' } },
			{ id: 'm-1', type: 'working', content: 'manual observation: the deployment region is us-east-1', metadata: { agentId: AGENT, sessionId: SESSION, source: 'manual' } },
			{ id: 'm-2', type: 'fact', content: 'production port is 443 with TLS 1.3', metadata: { agentId: AGENT, sessionId: SESSION, source: 'manual' } },
		];
		assert.strictEqual(all.length, 3);
		// episodic 层 = 原生类型（pattern + fact）= 2
		assert.strictEqual(all.filter(e => matchesTier(e, 'episodic' as any)).length, 2);
		// working 层 = 1
		assert.strictEqual(all.filter(e => matchesTier(e, 'working')).length, 1);
		// fact 原生类型 = 1（也属 episodic 层）
		assert.strictEqual(all.filter(e => matchesTier(e, 'fact')).length, 1);
		assert.strictEqual(all.filter(e => matchesSearch(e, 'deploy pattern')).length, 1);
		assert.strictEqual(all.filter(e => matchesSearch(e, 'TLS 1.3')).length, 1);
	});

	});

});
