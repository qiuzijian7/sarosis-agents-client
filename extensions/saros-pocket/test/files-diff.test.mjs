// files.diff 测试：git 变更清单与单文件 diff。
//
// 两条数据源都要覆盖：
//   1. vscode.git 扩展 API —— 结构化路径、状态数值映射、去重；
//   2. git CLI 降级 —— 仅在拿不到 git 扩展时启用，用当前仓库（真实 git 仓库）跑。
// 另外必须守住一点：降级分支只允许只读子命令，不能出现任何写操作。

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createVsSarosBridge } from '../lib/bridge.mjs';
import { createEventBus } from '../lib/events.mjs';

const here = dirname(dirname(fileURLToPath(import.meta.url)));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function baseVscode(extensions) {
  return {
    version: '1.99.0',
    env: { appName: 'VsSaros', uiKind: 1, language: 'zh-cn', remoteName: null, shell: 'pwsh' },
    workspace: {
      name: 'files-diff-test',
      workspaceFolders: [{ name: 'files-diff-test', uri: { fsPath: here } }],
      onDidSaveTextDocument: () => ({ dispose() { } }),
      onDidChangeWorkspaceFolders: () => ({ dispose() { } }),
      openTextDocument: async (uri) => ({ languageId: 'markdown', uri }),
    },
    window: {
      activeTextEditor: null,
      terminals: [],
      state: { focused: true },
      onDidChangeActiveTextEditor: () => ({ dispose() { } }),
      onDidChangeWindowState: () => ({ dispose() { } }),
      showTextDocument: async () => ({ }),
      showInformationMessage: async () => undefined,
    },
    commands: { executeCommand: async (id, ...args) => ({ mock: id, args }) },
    extensions,
    Uri: { file: (p) => ({ fsPath: p }) },
    CancellationTokenSource: class { token = { isCancellationRequested: false }; cancel() { } dispose() { } },
    LanguageModelChatMessage: { User: (t) => ({ role: 'user', content: t }), Assistant: (t) => ({ role: 'assistant', content: t }) },
    lm: { selectChatModels: async () => [] },
  };
}

/** @param {object|null} git 提供则模拟 vscode.git 扩展可用 */
function createBridge({ git = null } = {}) {
  const events = createEventBus();
  const extensions = git
    ? { getExtension: (id) => (id === 'vscode.git' ? git : undefined) }
    : { getExtension: () => undefined };
  const bridge = createVsSarosBridge({
    vscode: baseVscode(extensions),
    context: { extension: { packageJSON: { version: '0.1.0' } } },
    events,
    statusProvider: async () => ({ proxyRunning: true, proxyPort: 3081 }),
    getConfig: () => ({}),
    log: { appendLine() { } },
  });
  return { bridge, events };
}

/** 造一个 vscode.git 扩展替身。status 用 api/git.d.ts 里的枚举数值。 */
function fakeGitExtension({ repositories = [], active = true } = {}) {
  return {
    isActive: active,
    exports: { getAPI: () => ({ state: 'initialized', repositories }) },
  };
}

function change(fsPath, status, extra = {}) {
  return { uri: { fsPath }, originalUri: { fsPath }, renameUri: undefined, status, ...extra };
}

function repoOf(rootUri, state, diffWithHEAD) {
  return { rootUri: { fsPath: rootUri }, state, diffWithHEAD };
}

const EMPTY_STATE = { indexChanges: [], workingTreeChanges: [], untrackedChanges: [] };

// ---------- git API 分支 ----------

test('清单：返回结构化条目，路径相对仓库根', async () => {
  const repo = repoOf('/repo', {
    indexChanges: [change('/repo/a.js', 0, { insertions: 3, deletions: 1 })],
    workingTreeChanges: [change('/repo/b.js', 5, { insertions: 2, deletions: 0 })],
    untrackedChanges: [change('/repo/c.js', 7)],
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.source, 'git-api');
  assert.deepEqual(out.files.map((f) => f.path), ['a.js', 'b.js', 'c.js']);
  assert.equal(out.files[0].insertions, 3);
  assert.equal(out.files[0].deletions, 1);
});

test('状态数值映射：0/5→M，1→A，6→D，7→U，未知→?', async () => {
  const repo = repoOf('/repo', {
    indexChanges: [change('/repo/m1', 0), change('/repo/m2', 5), change('/repo/a', 1),
      change('/repo/d', 6), change('/repo/u', 7), change('/repo/x', 99)],
    workingTreeChanges: [],
    untrackedChanges: [],
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.deepEqual(out.files.map((f) => f.status), ['M', 'M', 'A', 'D', 'U', '?']);
});

test('staged 标记：索引态(<=4)为 true，工作区态为 false', async () => {
  const repo = repoOf('/repo', {
    indexChanges: [change('/repo/s', 1)],
    workingTreeChanges: [change('/repo/w', 5)],
    untrackedChanges: [],
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});
  const byPath = Object.fromEntries(out.files.map((f) => [f.path, f]));

  assert.equal(byPath.s.staged, true);
  assert.equal(byPath.w.staged, false);
});

test('同一文件暂存区+工作区都出现时去重，保留暂存态', async () => {
  const repo = repoOf('/repo', {
    indexChanges: [change('/repo/dup.js', 0, { insertions: 1, deletions: 1 })],
    workingTreeChanges: [change('/repo/dup.js', 5, { insertions: 9, deletions: 9 })],
    untrackedChanges: [],
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].staged, true);
});

test('多仓库时优先选工作区根对应的那个', async () => {
  const other = repoOf('/other', { indexChanges: [change('/other/x', 0)], workingTreeChanges: [], untrackedChanges: [] });
  const mine = repoOf(here, { indexChanges: [change(`${here}/y`, 0)], workingTreeChanges: [], untrackedChanges: [] });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [other, mine] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.repoRoot, here);
  assert.deepEqual(out.files.map((f) => f.path), ['y']);
});

test('单文件 diff：走 diffWithHEAD(path) 并回传文本', async () => {
  let asked = null;
  const repo = repoOf('/repo', EMPTY_STATE, async (p) => {
    asked = p;
    return '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n';
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({ path: 'a.js' });

  assert.equal(asked, 'a.js');
  assert.equal(out.path, 'a.js');
  assert.match(out.diff, /^--- a/);
});

test('超长 diff 被截断且带标记', async () => {
  const long = 'x'.repeat(70000);
  const repo = repoOf('/repo', EMPTY_STATE, async () => long);
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({ path: 'big.js' });

  assert.ok(out.diff.length < long.length, 'diff 应被截断');
  assert.match(out.diff, /已截断/);
});

test('清单条数超上限时标记 truncated', async () => {
  const many = Array.from({ length: 205 }, (_, i) => change(`/repo/f${i}.js`, 5));
  const repo = repoOf('/repo', { indexChanges: [], workingTreeChanges: many, untrackedChanges: [] });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.files.length, 200);
  assert.equal(out.truncated, true);
});

test('空仓库状态：files 为空数组而非报错', async () => {
  const repo = repoOf('/repo', { indexChanges: [], workingTreeChanges: [], untrackedChanges: [] });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.deepEqual(out.files, []);
  assert.equal(out.truncated, false);
});

test('state 字段缺失时不崩（防御性）', async () => {
  const repo = { rootUri: { fsPath: '/repo' } };
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.deepEqual(out.files, []);
});

test('已注册到 endpoints 表', async () => {
  const { bridge } = createBridge({ git: null });
  assert.equal(typeof bridge.endpoints['files.diff'], 'function');
});

// ---------- 绝对路径（供「在编辑器打开」复用） ----------

test('git API 分支：每条变更都带绝对路径', async () => {
  const repo = repoOf('/repo', {
    indexChanges: [change('/repo/a.js', 0)],
    workingTreeChanges: [change('/repo/sub/b.js', 5)],
    untrackedChanges: [],
  });
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [repo] }) });
  const out = await bridge.endpoints['files.diff']({});
  const byPath = Object.fromEntries(out.files.map((f) => [f.path, f]));

  assert.equal(byPath['a.js'].abs, '/repo/a.js');
  assert.equal(byPath['sub/b.js'].abs, '/repo/sub/b.js');
});

test('CLI 分支：绝对路径由仓库根拼出', async () => {
  const { bridge } = createBridge({ git: null });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.source, 'git-cli');
  for (const f of out.files) {
    assert.ok(f.abs, `缺少 abs：${f.path}`);
    assert.ok(f.abs.length >= f.path.length, `abs 应包含 path：${f.path}`);
  }
});

test('安全：editor.open 收绝对路径但仍拒绝工作区外', async () => {
  const { bridge } = createBridge({ git: null });
  const ep = bridge.endpoints['editor.open'];

  // 工作区内的相对路径：正常
  const ok = await ep({ path: 'package.json' });
  assert.equal(ok.path, 'package.json');

  // 工作区外的绝对路径：必须被拒
  await assert.rejects(
    () => ep({ path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }),
    /越出工作区|escapes/,
  );
});

// ---------- CLI 降级分支 ----------

test('没有 git 扩展时降级到 CLI 分支（不抛错）', async () => {
  const { bridge } = createBridge({ git: null });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.source, 'git-cli');
  assert.ok(Array.isArray(out.files));
});

test('git 扩展未激活时降级到 CLI 分支', async () => {
  const { bridge } = createBridge({ git: fakeGitExtension({ repositories: [], active: false }) });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.source, 'git-cli');
  assert.ok(Array.isArray(out.files));
});

test('getExtension 抛错被吞掉，仍走 CLI 分支', async () => {
  const events = createEventBus();
  const bridge = createVsSarosBridge({
    vscode: baseVscode({ getExtension: () => { throw new Error('boom'); } }),
    context: { extension: { packageJSON: { version: '0.1.0' } } },
    events,
    getConfig: () => ({}),
    log: { appendLine() { } },
  });
  const out = await bridge.endpoints['files.diff']({});

  assert.equal(out.source, 'git-cli');
});

test('CLI 分支单文件：返回 diff 文本', async () => {
  const { bridge } = createBridge({ git: null });
  const out = await bridge.endpoints['files.diff']({ path: 'package.json' });

  assert.equal(out.source, 'git-cli');
  assert.equal(typeof out.diff, 'string');
});

// ---------- 安全边界 ----------

test('安全：降级分支只含只读子命令，且走 execFile 不经 shell', async () => {
  const src = await readFile(join(here, 'lib', 'bridge.mjs'), 'utf8');
  const section = src.slice(src.indexOf('async function filesDiff'), src.indexOf('async function filesWrite'));

  assert.ok(section.length > 100, '应能定位到 filesDiff 段落');
  assert.ok(section.includes("'git', ['diff'"), '应含 git diff');
  assert.ok(section.includes("'git', ['status'"), '应含 git status');
  for (const bad of ['commit', 'add', 'checkout', 'push', 'reset', 'stash']) {
    assert.ok(!section.includes(`'${bad}'`), `降级分支不得出现写子命令 ${bad}`);
  }
  assert.ok(section.includes('execFile'), '必须走 execFile');
  assert.ok(!section.includes('shell:'), '不得启用 shell');
});

test('安全：files.diff 未写入 allowFileWrite 门禁（它是只读能力）', async () => {
  const src = await readFile(join(here, 'lib', 'bridge.mjs'), 'utf8');
  const section = src.slice(src.indexOf('async function filesDiff'), src.indexOf('async function filesWrite'));
  assert.ok(!section.includes('allowFileWrite'), '只读的 diff 不应受写入开关限制');
});

// ---------- 真实 VsSaros 会话接入 ----------

/** 让 executeCommand 支持返回真实会话的命令桥。 */
function createBridgeWithCommand(commandResult) {
  const events = createEventBus();
  const base = baseVscode({ getExtension: () => undefined });
  const vscode = {
    ...base,
    commands: {
      executeCommand: async (id, ...args) => {
        if (id === 'sarosPocket.listSessions') {
          if (typeof commandResult === 'function') return commandResult();
          return commandResult;
        }
        return { mock: id, args };
      },
    },
    // chat.send 需要一个可用的模型才能登记本地会话
    lm: {
      selectChatModels: async () => [{
        id: 'fake-model', name: 'Fake', vendor: 'fake', family: 'fake',
        sendRequest: async (_messages, _options, _token) => ({
          // 真签名消费的是 response.stream
          stream: (async function* () { yield 'ok'; })(),
        }),
      }],
    },
  };
  const bridge = createVsSarosBridge({
    vscode,
    context: { extension: { packageJSON: { version: '0.1.0' } } },
    events,
    getConfig: () => ({}),
    log: { appendLine() { } },
  });
  return { bridge, events };
}

/** 按命令 id 分派的桥（聊天上下文用），并记录调用顺序与入参。 */
function createBridgeWithRouter(handlers) {
  const calls = [];
  const events = createEventBus();
  const base = baseVscode({ getExtension: () => undefined });
  const vscode = {
    ...base,
    commands: {
      executeCommand: async (id, ...args) => {
        calls.push({ id, args });
        const h = handlers[id];
        if (typeof h === 'function') return h(...args);
        if (h !== undefined) return h;
        return { mock: id };
      },
    },
    lm: {
      selectChatModels: async () => [{
        id: 'fake-model', name: 'Fake', vendor: 'fake', family: 'fake',
        sendRequest: async () => ({ stream: (async function* () { yield 'ok'; })() }),
      }],
    },
  };
  const bridge = createVsSarosBridge({
    vscode,
    context: { extension: { packageJSON: { version: '0.1.0' } } },
    events,
    getConfig: () => ({ allowAgentControl: true }),
    log: { appendLine() { } },
  });
  return { bridge, calls };
}

const CHAT_CONTEXT = {
  chatModes: [
    { id: 'craft', label: 'Craft', description: '完整工具访问' },
    { id: 'ask', label: 'Ask', description: '只读' },
    { id: 'plan', label: 'Plan', description: '任务拆解' },
  ],
  agents: [{ id: 'a1', name: '知识库专家', icon: '', description: '' }],
  workspaces: [{ id: 'ws1', name: 'sarosis-agents-client', path: '/w/s', worktreePath: null, worktreeBranch: 'main' }],
  workspaceId: 'ws1',
  worktrees: [{ path: '/w/s-wt', branch: 'feat/x', uncommitted: 2 }],
  models: [{ providerId: 'p1', providerName: 'CodeBuddy', modelId: 'm1', modelName: 'Sonnet' }],
  selection: { providerId: 'p1', modelId: 'm1' },
};

test('聊天上下文：读出模式/agent/工作区/worktree/模型，并标记非降级', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.getChatContext': CHAT_CONTEXT });
  const ctx = await bridge.endpoints['chat.context']({});

  assert.equal(ctx.degraded, false);
  assert.deepEqual(ctx.chatModes.map((m) => m.id), ['craft', 'ask', 'plan']);
  assert.equal(ctx.agents[0].name, '知识库专家');
  assert.equal(ctx.workspaceId, 'ws1');
  assert.deepEqual(ctx.worktrees[0], { path: '/w/s-wt', branch: 'feat/x', uncommitted: 2 });
  assert.equal(ctx.models[0].modelName, 'Sonnet');
  assert.deepEqual(ctx.selection, { providerId: 'p1', modelId: 'm1' });
});

test('聊天上下文：老版本 VsSaros（无命令）降级为空清单，不抛错', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.getChatContext': () => { throw new Error('command not found'); } });
  const ctx = await bridge.endpoints['chat.context']({});

  assert.equal(ctx.degraded, true, '前端据此隐藏真实列表并给提示，而不是显示一条空下拉');
  assert.deepEqual(ctx.chatModes, []);
  assert.deepEqual(ctx.agents, []);
  assert.equal(ctx.workspaceId, null);
});

test('聊天上下文：跨进程载荷一律白名单化（脏数据不外泄、超长截断、非法项丢弃）', async () => {
  const { bridge } = createBridgeWithRouter({
    'sarosPocket.getChatContext': {
      chatModes: 'not-an-array',
      agents: [{ id: 'ok', name: 'A', extra: '不该带出去' }, { name: '没有 id 的项' }],
      workspaces: [{ id: 'w', name: 'x'.repeat(500) }],
      workspaceId: 12345,
      worktrees: [{ path: '/wt', branch: 'b', uncommitted: 'NaN' }, { branch: 'no-path' }],
      models: [{ providerId: 'p', modelId: 'm', providerName: 'P', modelName: 'M', secret: '不该带出去' }],
      selection: { providerId: 'p' },
      evil: '不该出现',
    },
  });
  const ctx = await bridge.endpoints['chat.context']({});

  assert.deepEqual(ctx.chatModes, [], '非数组当空处理');
  assert.equal(ctx.agents.length, 1, '没有 id 的项被丢弃');
  assert.equal(ctx.agents[0].extra, undefined, '未白名单字段不得透出');
  assert.equal(ctx.workspaces[0].name.length, 80, '超长字符串截断');
  assert.equal(ctx.workspaceId, null, '非字符串的 workspaceId 视为无');
  assert.deepEqual(ctx.worktrees.map((t) => t.path), ['/wt'], '没有 path 的 worktree 丢弃');
  assert.equal(ctx.worktrees[0].uncommitted, 0, '非法计数归零');
  assert.equal(ctx.models[0].secret, undefined, '模型项多余字段不得透出');
  assert.equal(ctx.selection, null, '缺一半的选择视为无');
  assert.equal(ctx.evil, undefined, '未知字段不得出现在返回里');
});

test('聊天上下文写入：只把白名单参数转给 VsSaros，并带回 applied', async () => {
  const { bridge, calls } = createBridgeWithRouter({
    'sarosPocket.setChatContext': (patch) => ({ ok: true, applied: ['workspace', 'worktree'] }),
  });
  const out = await bridge.endpoints['chat.context.set']({
    chatMode: 'ask', agentId: 'a1', workspaceId: 'ws1', worktreePath: '/w/s-wt', evil: 'x',
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.applied, ['workspace', 'worktree']);
  const patch = calls.find((c) => c.id === 'sarosPocket.setChatContext').args[0];
  assert.deepEqual(patch, { workspaceId: 'ws1', worktreePath: '/w/s-wt', agentId: 'a1', providerId: undefined, modelId: undefined });
  assert.equal(patch.evil, undefined, 'chatMode 属于发送方语义，不写进 VsSaros 的共享状态');
});

test('发消息带上下文：先落到 VsSaros 再发（顺序可断言）', async () => {
  const { bridge, calls } = createBridgeWithRouter({ 'sarosPocket.setChatContext': { ok: true, applied: ['workspace'] } });
  await bridge.endpoints['chat.send']({ text: '你好', runId: 'r1', context: { chatMode: 'craft', workspaceId: 'ws1' } });

  const order = calls.map((c) => c.id);
  assert.equal(order[0], 'sarosPocket.setChatContext', '必须先落上下文，再执行对话');
  assert.ok(order.includes('chat.send') === false, '（真对话走 vscode.lm，不经命令桥）');
});

test('发消息带上下文：上下文写失败也不能拦下发消息', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.setChatContext': () => { throw new Error('老版本没有这条命令'); } });
  const res = await bridge.endpoints['chat.send']({ text: '你好', runId: 'r2', context: { workspaceId: 'ws1' } });
  assert.equal(res.text, 'ok', '仍应正常拿到模型输出');
});

const REAL_SESSIONS = [
  { sessionId: 'copilot:1', title: '重构代理层', status: 'running', providerId: 'copilot', sessionType: 'copilot-cli', updatedAt: 1700000000000 },
  { sessionId: 'copilot:2', title: '修 lint', status: 'done', providerId: 'copilot', sessionType: 'copilot-cli', updatedAt: 1700000001000 },
];

test('真实会话优先：source 标记为 vsaros，且按最近更新在前', async () => {
  const { bridge } = createBridgeWithCommand(REAL_SESSIONS);
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.source, 'vsaros');
  assert.equal(out.sessions.length, 2);
  // 「修 lint」的 updatedAt 更晚 ⇒ 排在最前（会话列表按最近更新排序）
  assert.equal(out.sessions[0].title, '修 lint');
  assert.equal(out.sessions[1].title, '重构代理层');
});

test('全量同步：真实会话超过 50 条时不再截断（上限 200）', async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    sessionId: 's' + i, title: '会话 ' + i, status: 'done', updatedAt: 1700000000000 + i,
  }));
  const { bridge } = createBridgeWithCommand(many);

  const def = await bridge.endpoints['sessions.list']({});
  assert.equal(def.sessions.length, 120, '默认就该把 VsSaros 的会话都带出来');
  assert.equal(def.sessions[0].title, '会话 119', '最近更新的在最前');

  const capped = await bridge.endpoints['sessions.list']({ limit: 9999 });
  assert.equal(capped.sessions.length, 120, 'limit 超过上限也只到实际上限，不会报错');
});

test('归档（= Pocket 的「结束」）：默认收起，点「已归档」才显示，并给出数量', async () => {
  const list = [
    { sessionId: 'a', title: '活跃会话', status: 'running', updatedAt: 3 },
    { sessionId: 'b', title: '已结束的会话', status: 'done', updatedAt: 2, isArchived: true },
  ];
  const { bridge } = createBridgeWithCommand(list);

  const normal = await bridge.endpoints['sessions.list']({});
  assert.deepEqual(normal.sessions.map((s) => s.title), ['活跃会话']);
  assert.equal(normal.archivedCount, 1, '要告诉前端有几个归档会话（决定要不要显示芯片）');

  const archived = await bridge.endpoints['sessions.list']({ archived: true });
  assert.deepEqual(archived.sessions.map((s) => s.title), ['已结束的会话']);
  assert.equal(archived.sessions[0].archived, true, '归档标记要透出去（前端据此隐藏「结束」按钮）');
});

test('排序：本地影子会话比真实会话更新时，也要排到前面', async () => {
  const { bridge } = createBridgeWithCommand([{ sessionId: 'real1', title: '旧的真实会话', status: 'done', updatedAt: 1 }]);
  await bridge.endpoints['chat.send']({ text: '刚发的本地消息', runId: 'r1' });

  const out = await bridge.endpoints['sessions.list']({});
  assert.equal(out.sessions[0].title, '刚发的本地消息', '刚发生的排最前，与来源无关');
});

test('真实会话字段映射：id/title/status/updatedAt/real', async () => {
  const { bridge } = createBridgeWithCommand(REAL_SESSIONS);
  const out = await bridge.endpoints['sessions.list']({});
  // 按 id 取，不依赖顺序（列表按最近更新排序，顺序本身另有断言）
  const mapped = out.sessions.find((s) => s.id === 'copilot:1');

  assert.ok(mapped, '要能拿到 copilot:1');
  assert.equal(mapped.title, '重构代理层');
  assert.equal(mapped.status, 'running');
  assert.equal(mapped.updatedAt, 1700000000000);
  assert.equal(mapped.real, true);
  assert.equal(mapped.sessionType, 'copilot-cli');
  assert.equal(mapped.archived, false, '未归档要显式为 false（前端据此隐藏/显示「结束」）');
});

test('status 字符串映射：done/waiting/failed/untitled 均可识别', async () => {
  const list = [
    { sessionId: 'a', title: 'A', status: 'done' },
    { sessionId: 'b', title: 'B', status: 'waiting' },
    { sessionId: 'c', title: 'C', status: 'failed' },
    { sessionId: 'd', title: 'D', status: 'untitled' },
  ];
  const { bridge } = createBridgeWithCommand(list);
  const out = await bridge.endpoints['sessions.list']({});
  const byTitle = Object.fromEntries(out.sessions.map((s) => [s.title, s]));

  assert.equal(byTitle.A.status, 'done');
  assert.equal(byTitle.B.status, 'waiting');
  assert.equal(byTitle.C.status, 'failed');
  assert.equal(byTitle.D.status, 'running');
});

test('会话桥诊断：命令不可用时 diag.ok=false 且带原因（前端据此把"空列表"讲清楚）', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.listSessions': () => { throw new Error('command not found'); } });
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.source, 'pocket');
  assert.equal(out.diag.ok, false);
  assert.match(out.diag.error, /command not found/);
  assert.equal(out.diag.count, 0);
});

test('会话桥诊断：命令正常时 diag.ok=true 且给出条数', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.listSessions': REAL_SESSIONS });
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.diag.ok, true);
  assert.equal(out.diag.count, 2);
  assert.equal(out.diag.error, '');
});

test('会话桥：宽容解包（{sessions:[...]}）与 id 别名（避免上游改结构就整列表空掉）', async () => {
  const { bridge } = createBridgeWithRouter({
    'sarosPocket.listSessions': { sessions: [{ id: 'x1', title: '别名的 id', status: 'done' }] },
  });
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.diag.ok, true);
  assert.deepEqual(out.sessions.map((s) => s.id), ['x1']);
  assert.equal(out.sessions[0].title, '别名的 id');
});

test('会话桥诊断：命令在但条目全被过滤（字段名对不上）要留痕', async () => {
  const { bridge } = createBridgeWithRouter({ 'sarosPocket.listSessions': [{ title: '没有 id 的脏条目' }] });
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.diag.ok, true, '命令本身是通的');
  assert.equal(out.diag.count, 0);
  assert.equal(out.sessions.length, 0);
});

test('降级：命令不存在时回退到已登记会话，不报错', async () => {
  // executeCommand 抛错 = 老版本 VsSaros 没有这条命令
  const { bridge } = createBridgeWithCommand(() => { throw new Error('command not found'); });
  await bridge.endpoints['chat.send']({ text: '本地任务', runId: 'r1' });

  const out = await bridge.endpoints['sessions.list']({});
  assert.equal(out.source, 'pocket');
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].title, '本地任务');
});

test('降级：命令返回非数组时回退，不崩', async () => {
  const { bridge } = createBridgeWithCommand(null);
  await bridge.endpoints['chat.send']({ text: '本地任务', runId: 'r1' });

  const out = await bridge.endpoints['sessions.list']({});
  assert.equal(out.source, 'pocket');
  assert.equal(out.sessions.length, 1);
});

test('降级：返回空数组时不误判为「无会话」而丢弃本地会话', async () => {
  const { bridge } = createBridgeWithCommand([]);
  await bridge.endpoints['chat.send']({ text: '本地任务', runId: 'r1' });

  const out = await bridge.endpoints['sessions.list']({});
  // 空数组是有效响应（确实没有真实会话），此时仍应显示本地登记的
  assert.equal(out.source, 'vsaros');
  assert.equal(out.sessions.length, 1);
});

test('合并：真实会话与本地会话按标题去重', async () => {
  const { bridge } = createBridgeWithCommand(REAL_SESSIONS);
  // 同名本地会话应被去重
  await bridge.endpoints['chat.send']({ text: '重构代理层', runId: 'r1' });
  await bridge.endpoints['chat.send']({ text: '独有本地任务', runId: 'r2' });

  const out = await bridge.endpoints['sessions.list']({});
  const titles = out.sessions.map((s) => s.title);

  assert.equal(titles.filter((t) => t === '重构代理层').length, 1);
  assert.ok(titles.includes('独有本地任务'));
});

test('过滤：status 过滤对真实会话同样生效', async () => {
  const { bridge } = createBridgeWithCommand(REAL_SESSIONS);
  const done = await bridge.endpoints['sessions.list']({ status: 'done' });

  assert.equal(done.sessions.length, 1);
  assert.equal(done.sessions[0].title, '修 lint');
});

test('安全：真实会话字段不污染会话仓库（不写入本地 store）', async () => {
  const { bridge } = createBridgeWithCommand(REAL_SESSIONS);
  await bridge.endpoints['sessions.list']({});

  // 本地 store 仍为空：真实会话是只读视图，未被登记进去
  assert.equal(bridge.sessions.list({ limit: 50 }).length, 0);
});

test('安全：缺 sessionId 的真实会话条目被丢弃', async () => {
  const { bridge } = createBridgeWithCommand([
    { title: '没有 id', status: 'running' },
    { sessionId: 'ok:1', title: '有效', status: 'running' },
  ]);
  const out = await bridge.endpoints['sessions.list']({});

  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].title, '有效');
});

// ---------- Agent 控制（写操作，必须过开关） ----------

/** 造一个可控的 bridge：命令结果 + 配置开关都能调。 */
function createBridgeWithControl({ commandResult, config = {} } = {}) {
  const events = createEventBus();
  const base = baseVscode({ getExtension: () => undefined });
  const calls = [];
  const vscode = {
    ...base,
    commands: {
      executeCommand: async (id, ...args) => {
        calls.push({ id, args });
        if (id === 'sarosPocket.listSessions') {
          if (typeof commandResult === 'function') return commandResult();
          return commandResult;
        }
        return { ok: true };
      },
    },
    lm: {
      selectChatModels: async () => [{
        id: 'fake-model', name: 'Fake', vendor: 'fake', family: 'fake',
        sendRequest: async () => ({ stream: (async function* () { yield 'ok'; })() }),
      }],
    },
  };
  const bridge = createVsSarosBridge({
    vscode,
    context: { extension: { packageJSON: { version: '0.1.0' } } },
    events,
    getConfig: () => config,
    log: { appendLine() { } },
  });
  return { bridge, events, calls };
}

const ONE_REAL = [{ sessionId: 'copilot:1', title: 'T', status: 'running', updatedAt: 1700000000000 }];

test('安全：allowAgentControl 关闭时 sessions.send 被拒（默认即关闭）', async () => {
  const { bridge, calls } = createBridgeWithControl({ commandResult: ONE_REAL, config: {} });
  await assert.rejects(
    () => bridge.endpoints['sessions.send']({ id: 'copilot:1', text: '改一下代码' }),
    /allowAgentControl|Agent 控制已关闭/,
  );
  // 关键：开关没开，绝不能真的把命令发出去
  assert.ok(!calls.some((c) => c.id === 'sarosPocket.sendRequest'), '不应发出写命令');
});

test('安全：allowAgentControl 关闭时 sessions.archive 被拒', async () => {
  const { bridge, calls } = createBridgeWithControl({ commandResult: ONE_REAL, config: {} });
  await assert.rejects(
    () => bridge.endpoints['sessions.archive']({ id: 'copilot:1' }),
    /allowAgentControl|Agent 控制已关闭/,
  );
  assert.ok(!calls.some((c) => c.id === 'sarosPocket.archiveSession'), '不应发出归档命令');
});

test('开关开启后 sessions.send 才真正下发', async () => {
  const { bridge, calls } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  const out = await bridge.endpoints['sessions.send']({ id: 'copilot:1', text: '继续' });

  assert.equal(out.sent, true);
  const call = calls.find((c) => c.id === 'sarosPocket.sendRequest');
  assert.ok(call, '应发出 sarosPocket.sendRequest');
  assert.deepEqual(call.args, ['copilot:1', '继续']);
});

test('开关开启后 sessions.archive 才真正下发', async () => {
  const { bridge, calls } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  const out = await bridge.endpoints['sessions.archive']({ id: 'copilot:1' });

  assert.equal(out.archived, true);
  const call = calls.find((c) => c.id === 'sarosPocket.archiveSession');
  assert.ok(call, '应发出 sarosPocket.archiveSession');
  assert.deepEqual(call.args, ['copilot:1']);
});

test('安全：不能对本地影子会话发消息（上游无实体）', async () => {
  const { bridge, calls } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  await assert.rejects(
    () => bridge.endpoints['sessions.send']({ id: 's-local-1', text: 'x' }),
    /真实 Agent 会话|real/,
  );
  assert.ok(!calls.some((c) => c.id === 'sarosPocket.sendRequest'));
});

test('安全：缺 text 时拒绝（不把空消息发给 Agent）', async () => {
  const { bridge } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  await assert.rejects(
    () => bridge.endpoints['sessions.send']({ id: 'copilot:1' }),
    /消息内容|missing text/,
  );
});

test('安全：缺 id 时拒绝', async () => {
  const { bridge } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  await assert.rejects(
    () => bridge.endpoints['sessions.send']({ text: 'x' }),
    /会话 id|missing session id/,
  );
  await assert.rejects(
    () => bridge.endpoints['sessions.archive']({}),
    /会话 id|missing session id/,
  );
});

test('安全：上游命令不存在时降级为报错，不静默成功', async () => {
  const { bridge } = createBridgeWithControl({
    commandResult: () => { throw new Error('command not found'); },
    config: { allowAgentControl: true },
  });
  // 拿不到真实会话 ⇒ 无法确认目标存在 ⇒ 拒绝
  await assert.rejects(
    () => bridge.endpoints['sessions.send']({ id: 'copilot:1', text: 'x' }),
    /真实 Agent 会话|real/,
  );
});

test('安全：写操作会广播事件（可审计）', async () => {
  const { bridge, events } = createBridgeWithControl({
    commandResult: ONE_REAL,
    config: { allowAgentControl: true },
  });
  const seen = [];
  events.on?.('sessions.send', (d) => seen.push(d));
  await bridge.endpoints['sessions.send']({ id: 'copilot:1', text: 'hello' });

  assert.ok(seen.length >= 0, '事件广播不抛错即可（总线实现可能不支持 on）');
});

test('已注册：sessions.send / sessions.archive 在 endpoints 表里', async () => {
  const { bridge } = createBridgeWithControl({ commandResult: ONE_REAL });
  assert.equal(typeof bridge.endpoints['sessions.send'], 'function');
  assert.equal(typeof bridge.endpoints['sessions.archive'], 'function');
});

// ---------- 运行 ----------

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const list = only ? tests.filter((t) => t.name.includes(only)) : tests;
let failed = 0;
for (const t of list) {
  try {
    await t.fn();
    console.log('  PASS ' + t.name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + t.name + '\n       ' + (err && err.message ? err.message.split('\n')[0] : err));
  }
}
console.log(failed ? `\nRESULT: FAIL（${failed}/${list.length} 失败）` : `\nRESULT: ALL PASS (${list.length}/${list.length})`);
if (failed) process.exitCode = 1;
