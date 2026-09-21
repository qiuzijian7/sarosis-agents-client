// Saros Pocket — VsSaros 桥接层
//
// 职责：把 Pocket App 的 endpoint 调用翻译成「真实的 VsSaros 动作」，再把结果收拢成
// 可 JSON 序列化的值。桥接层跑在 VsSaros 的扩展进程里，因此它拿到的 vscode 命名空间
// 就是 VsSaros 本体：模型、工作区、编辑器、命令、通知。
//
// 对应 dsh-pocket 的 lib/web-rpc.js（endpoint 分派）+ client（界面）。差别：
//   - dsh 的 RPC 挂在 cordis 的 webServer 上；这里挂在 Pocket 代理的 routes 上；
//   - dsh 只能读写文件/控制隧道；VsSaros 还能聊模型、开编辑器、跑命令——因此这里
//     每个「有副作用」的 endpoint 都必须过一遍开关（allowFileWrite / allowTerminal
//     / allowedCommands），默认全部关闭，只保留只读能力。
//
// ★ 顺序即语义：先判定开关/白名单，再执行动作；任何放行分支之前都不能有早返回。

import { readdir, readFile, stat, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createSessionStore } from './sessions.mjs';

/** 默认允许远程触发的命令（只读/无副作用）。 */
export const DEFAULT_ALLOWED_COMMANDS = [
  'workbench.action.files.save',
  'workbench.action.files.saveAll',
  'workbench.action.closeActiveEditor',
  'sarosPocket.openPanel',
];

/** 文件浏览默认忽略的目录。 */
const LIST_IGNORE = new Set(['node_modules', '.git', '.svn', '.hg', '.DS_Store']);

/** 单次聊天的最长等待（10 分钟）：超过即中止，避免手机侧永远转圈。 */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000;

/** 目录列举上限。 */
const LIST_MAX = 500;

/**
 * 会话列表上限。
 *
 * 取 200 而不是 50：需求是「把 VsSaros 的会话都同步到 Pocket」，
 * 50 会在会话多的仓库里静默截断（用户以为会话丢了）。手机端一屏本来也放不下更多。
 */
const LIST_LIMIT_MAX = 200;

/** 聊天上下文为空时的形状（老版本 VsSaros 降级用）。 */
const EMPTY_CHAT_CONTEXT = Object.freeze({
  chatModes: [], agents: [], workspaces: [], workspaceId: null, worktrees: [], models: [], selection: null,
});

/** 跨进程来的载荷一律**白名单化**：只取认识的字段，长度与类型都收口。 */
function normalizeChatContext(raw) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v, max = 200) => String(v ?? '').slice(0, max);
  return {
    chatModes: arr(raw.chatModes).map((m) => ({
      id: str(m?.id, 32), label: str(m?.label, 32), description: str(m?.description, 200),
    })).filter((m) => m.id),
    agents: arr(raw.agents).map((a) => ({
      id: str(a?.id, 120), name: str(a?.name, 80), icon: str(a?.icon, 400), description: str(a?.description, 200),
    })).filter((a) => a.id),
    workspaces: arr(raw.workspaces).map((w) => ({
      id: str(w?.id, 200), name: str(w?.name, 80), path: str(w?.path, 400),
      worktreePath: w?.worktreePath ? str(w.worktreePath, 400) : null,
      worktreeBranch: w?.worktreeBranch ? str(w.worktreeBranch, 200) : null,
    })).filter((w) => w.id),
    // id 必须是字符串：数字/对象被 String() 化之后永远匹配不上真实 id，只会让人误以为"选中了"
    workspaceId: typeof raw.workspaceId === 'string' && raw.workspaceId ? raw.workspaceId.slice(0, 200) : null,
    worktrees: arr(raw.worktrees).map((t) => ({
      path: str(t?.path, 400), branch: str(t?.branch, 200), uncommitted: Number(t?.uncommitted ?? 0) || 0,
    })).filter((t) => t.path),
    models: arr(raw.models).map((m) => ({
      providerId: str(m?.providerId, 120), providerName: str(m?.providerName, 80),
      modelId: str(m?.modelId, 200), modelName: str(m?.modelName, 120),
    })).filter((m) => m.providerId && m.modelId),
    selection: raw.selection && raw.selection.providerId && raw.selection.modelId
      ? { providerId: str(raw.selection.providerId, 120), modelId: str(raw.selection.modelId, 200) }
      : null,
  };
}

function truncate(s, max) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max)}…（已截断，共 ${str.length} 字符）` : str;
}

/**
 * 把用户给的（可能是相对）路径收敛到根目录内。
 * 抗目录穿越（..）与跨盘符绝对路径；realpath 失败时 fail-safe 用 resolve 结果。
 */
async function resolveInside(root, relPath) {
  const rootAbs = resolve(String(root ?? ''));
  if (!rootAbs) throw new Error('没有可用的文件根目录 | no file root');
  const raw = String(relPath ?? '').trim();
  const target = resolve(rootAbs, raw.replace(/^[/\\]+/, ''));
  let checked = target;
  try {
    checked = await realpath(target);
  } catch {
    try { checked = resolve(await realpath(dirname(target)), target.slice(dirname(target).length)); } catch { checked = target; }
  }
  const rel = relative(rootAbs, checked);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return { abs: checked, rel: rel === '' ? '.' : rel };
  }
  throw new Error('路径越出工作区：只能访问工作区内的文件 | path escapes the workspace root');
}

function isTextBuffer(buf) {
  return !buf.subarray(0, 8192).includes(0);
}

function sanitizeAgentResult(result) {
  if (!result || typeof result !== 'object') {
    return { completed: result !== null && result !== undefined };
  }
  const out = { completed: true };
  const msg = result.errorDetails?.message;
  if (typeof msg === 'string' && msg) out.error = msg;
  if (typeof result.details === 'string' && result.details) out.details = truncate(result.details, 2000);
  if (typeof result.type === 'string') out.type = result.type;
  return out;
}

/**
 * 创建 VsSaros 桥接。
 * @param {object} opts
 * @param {typeof import('vscode')} opts.vscode VsSaros 的 vscode 命名空间
 * @param {object} opts.context 扩展 context（subscriptions / extensionPath）
 * @param {object} [opts.events] 事件总线
 * @param {() => Promise<object>} [opts.statusProvider] pocket 状态（service.status）
 * @param {() => object} opts.getConfig 配置快照
 * @param {object} [opts.log] 日志
 * @param {object} [opts.sessionStore] 会话仓库（可选，缺省自建；注入便于测试）
 * @param {ReturnType<import('./screen.mjs').createScreenSource>} [opts.screen] 屏幕采集源（桌面画面）
 * @param {ReturnType<import('./desktop-input.mjs').createDesktopInput>} [opts.desktopInput] 桌面输入转发
 */
export function createVsSarosBridge({ vscode, context, events = null, statusProvider = null, getConfig = () => ({}), log = console, sessionStore = null, screen = null, desktopInput = null } = {}) {
  const logLine = (msg) => {
    if (log?.appendLine) log.appendLine(msg);
    else (log?.info ?? log?.log ?? (() => { })).call(log, msg);
  };
  const emit = (type, data) => { try { events?.emit(type, data); } catch { /* 忽略 */ } };

  /** 进行中的聊天 run（runId → CancellationTokenSource），供 chat.cancel 中止。 */
  const runs = new Map();

  // 会话仓库：把每次 chat/agent 提升为收件箱里可见的「任务」。
  // runId 与会话 id 的映射要落在这里，因为 CancellationTokenSource 等活对象
  // 严禁进入会话对象（会话必须始终可 JSON 序列化）。
  const sessions = sessionStore ?? createSessionStore({ maxRecent: 50, events });
  /** runId → sessionId */
  const runSession = new Map();

  function cfg() {
    return getConfig() ?? {};
  }

  function fileRoot() {
    const root = String(cfg().fileRoot ?? '').trim();
    if (root) return root;
    const folder = (vscode.workspace.workspaceFolders ?? [])[0];
    return folder?.uri.fsPath ?? '';
  }

  function requireRoot() {
    const root = fileRoot();
    if (!root) throw new Error('VsSaros 没有打开的工作区，文件功能不可用（可设置 sarosPocket.fileRoot 指定根目录）| no workspace folder open');
    return root;
  }

  // ---------- VsSaros 事件 → 事件总线 ----------
  const disposables = [];
  const watch = (fn) => { try { disposables.push(fn()); } catch { /* 忽略 */ } };

  watch(() => vscode.window.onDidChangeActiveTextEditor((editor) => {
    emit('editor.change', { path: editor?.document?.uri?.fsPath ?? null, languageId: editor?.document?.languageId ?? null });
  }));
  watch(() => vscode.workspace.onDidSaveTextDocument((doc) => {
    emit('file.save', { path: doc?.uri?.fsPath ?? null });
  }));
  watch(() => vscode.window.onDidChangeWindowState((state) => {
    emit('window.state', { focused: state?.focused === true });
  }));
  watch(() => vscode.workspace.onDidChangeWorkspaceFolders(() => {
    emit('workspace.change', { folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath) });
  }));

  // ---------- 模型 / 聊天 ----------
  async function selectModels(modelId) {
    if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') return [];
    const wanted = String(modelId ?? '').trim();
    let all = [];
    try {
      all = (await vscode.lm.selectChatModels({})) ?? [];
    } catch {
      try { all = (await vscode.lm.selectChatModels()) ?? []; } catch { all = []; }
    }
    if (!wanted) return all;
    const lower = wanted.toLowerCase();
    const matched = all.filter((m) => String(m.id ?? '').toLowerCase() === lower
      || String(m.id ?? '').toLowerCase().endsWith(`/${lower}`)
      || String(m.name ?? '').toLowerCase() === lower);
    return matched.length > 0 ? matched : all.filter((m) => String(m.id ?? '').toLowerCase().includes(lower));
  }

  async function chatModels() {
    const models = await selectModels('');
    return models.map((m) => ({
      id: String(m.id ?? ''),
      name: String(m.name ?? m.id ?? ''),
      vendor: m.vendor ?? null,
      family: m.family ?? null,
      version: m.version ?? null,
      maxInputTokens: typeof m.maxInputTokens === 'number' ? m.maxInputTokens : null,
    }));
  }

  async function chatSend(payload) {
    const runId = String(payload?.runId ?? '').trim() || `run-${Date.now()}`;
    const text = String(payload?.text ?? '').trim();
    const history = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!text && history.length === 0) throw new Error('缺少消息内容 | missing message');

    // 本次对话的上下文（模式 / agent / 工作区 / worktree）：发送前先落到 VsSaros，
    // 让执行环境与手机上的选择一致。best-effort —— 落不下去也不能拦下发消息。
    if (payload?.context && typeof payload.context === 'object') {
      try { await chatContextSet(payload.context); } catch { /* 老版本 VsSaros 没有这条命令 */ }
    }

    const models = await selectModels(payload?.modelId ?? cfg().chatModel);
    const model = models[0];
    if (!model) {
      throw new Error('VsSaros 当前没有可用的语言模型：请先在 VsSaros 里配置好模型（Agent Studio / vscode.lm 提供者）。也可以用「交给 Agent」把任务直接丢给 VsSaros 的 Agent。| no language model available');
    }
    if (typeof model.sendRequest !== 'function') {
      throw new Error('该模型不支持 sendRequest | model does not support sendRequest');
    }
    if (!vscode.LanguageModelChatMessage) {
      throw new Error('当前 VsSaros 版本没有暴露 vscode.lm 消息类型，无法直连模型；请改用「交给 Agent」| LanguageModelChatMessage unavailable');
    }

    const messages = [];
    for (const m of history) {
      const content = String(m?.content ?? '').trim();
      if (!content) continue;
      messages.push(m?.role === 'assistant'
        ? vscode.LanguageModelChatMessage.Assistant(content)
        : vscode.LanguageModelChatMessage.User(content));
    }
    const systemPrompt = String(cfg().chatSystemPrompt ?? '').trim();
    const userText = systemPrompt && messages.length === 0 ? `${systemPrompt}\n\n${text}` : text;
    if (userText) messages.push(vscode.LanguageModelChatMessage.User(userText));

    const cts = new vscode.CancellationTokenSource();
    runs.set(runId, cts);
    const timer = setTimeout(() => { try { cts.cancel(); } catch { /* 忽略 */ } }, CHAT_TIMEOUT_MS);
    timer.unref?.();

    // 登记会话：收件箱据此显示「运行中」，clientRunId 保证同一 runId 重复请求不重复建会话
    const session = sessions.start({
      kind: 'chat',
      title: userText || text,
      clientRunId: runId,
    });
    runSession.set(runId, session.id);
    emit('chat.start', { runId, sessionId: session.id, modelId: String(model.id ?? ''), name: String(model.name ?? '') });

    let acc = '';
    try {
      // ★ 三态/缺省语义：未给的字段一律不传（不要传 undefined）。
      // 显式传 undefined 会让部分 provider 把它当「显式默认值」处理，等于替用户做决定。
      const modelOptions = {};
      if (typeof payload?.temperature === 'number') modelOptions.temperature = payload.temperature;
      if (typeof payload?.maxTokens === 'number') modelOptions.maxTokens = payload.maxTokens;
      const response = await model.sendRequest(
        messages,
        Object.keys(modelOptions).length > 0 ? { modelOptions } : {},
        cts.token,
      );
      for await (const part of response.stream) {
        const chunk = typeof part === 'string' ? part : (part?.value ?? part?.text ?? '');
        if (!chunk) continue;
        acc += chunk;
        // 只回显尾部片段：会话对象不能存消息全文（内存与序列化双重原因）
        sessions.update(session.id, { preview: acc.slice(-160), stats: { messages: 2 } });
        emit('chat.delta', { runId, sessionId: session.id, text: chunk });
      }
      sessions.finish(session.id, { status: 'done' });
      emit('chat.done', { runId, sessionId: session.id, text: acc, modelId: String(model.id ?? ''), name: String(model.name ?? '') });
      return { runId, sessionId: session.id, text: acc, modelId: String(model.id ?? ''), name: String(model.name ?? '') };
    } catch (err) {
      const msg = String(err?.message ?? err);
      // 被中止时按 cancelled 收尾，其他异常才记 failed
      sessions.finish(session.id, {
        status: /cancel/i.test(msg) ? 'cancelled' : 'failed',
        error: /cancel/i.test(msg) ? null : msg,
      });
      emit('chat.error', { runId, sessionId: session.id, message: msg });
      // 被中止时把已生成的部分也回给调用方，别让用户白等
      if (/cancel/i.test(msg)) return { runId, sessionId: session.id, text: acc, cancelled: true, modelId: String(model.id ?? '') };
      throw err;
    } finally {
      clearTimeout(timer);
      runs.delete(runId);
      runSession.delete(runId);
      try { cts.dispose(); } catch { /* 忽略 */ }
    }
  }

  /**
   * 中止一次聊天。接受 runId 或 sessionId —— 收件箱里用户点的是「任务」，
   * 手上有的是 sessionId，所以这里要能从会话反查 runId。
   */
  function chatCancel(payload) {
    let runId = String(payload?.runId ?? '').trim();
    const sessionId = String(payload?.sessionId ?? '').trim();
    if (!runId && sessionId) {
      for (const [rid, sid] of runSession) {
        if (sid === sessionId) { runId = rid; break; }
      }
    }
    const cts = runId ? runs.get(runId) : null;
    if (!cts) {
      // run 已结束（或根本不存在）：若是已知会话，至少把状态收敛掉，避免收件箱一直转圈
      if (sessionId && sessions.get(sessionId)) {
        sessions.finish(sessionId, { status: 'cancelled' });
        return { cancelled: false, alreadyEnded: true, sessionId };
      }
      return { cancelled: false };
    }
    try { cts.cancel(); } catch { /* 忽略 */ }
    // 会话状态由 chatSend 的 catch 分支收尾（cancelled），此处不重复结束
    return { cancelled: true, runId, sessionId: runSession.get(runId) ?? sessionId ?? null };
  }

  /** 把任务交给 VsSaros 自己的 Agent（真实进入 Agent 会话，会以完整工具链执行）。 */
  async function agentSend(payload) {
    const text = String(payload?.text ?? '').trim();
    if (!text) throw new Error('缺少消息内容 | missing message');
    const command = String(cfg().agentCommand ?? 'workbench.action.chat.open').trim() || 'workbench.action.chat.open';
    const mode = String(cfg().agentMode ?? 'agent').trim();
    const wait = payload?.wait !== false;
    const args = { query: text, mode, blockOnResponse: wait };

    // 登记会话：clientRunId 优先用调用方给的，缺省用文本内容本身做幂等键
    const session = sessions.start({
      kind: 'agent',
      title: text,
      clientRunId: String(payload?.runId ?? '').trim() || `agent:${text}`,
    });

    let result;
    try {
      result = await vscode.commands.executeCommand(command, args);
    } catch (err) {
      sessions.finish(session.id, { status: 'failed', error: String(err?.message ?? err) });
      throw new Error(`交给 VsSaros Agent 失败（${command}）：${err?.message ?? err} | failed to dispatch to the VsSaros agent`);
    }
    sessions.finish(session.id, { status: 'done' });
    emit('agent.sent', { command, mode, wait, sessionId: session.id });
    return { command, mode, sessionId: session.id, result: sanitizeAgentResult(result) };
  }

  // ---------- 文件 ----------
  async function filesList(payload) {
    const root = requireRoot();
    const rel = String(payload?.path ?? '').trim();
    const { abs, rel: safeRel } = await resolveInside(root, rel === '' ? '.' : rel);
    const info = await stat(abs).catch(() => null);
    if (info && !info.isDirectory()) throw new Error('不是目录 | not a directory');
    const entries = await readdir(abs, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (LIST_IGNORE.has(entry.name)) continue;
      const child = join(abs, entry.name);
      let size = null;
      let mtime = null;
      try {
        const st = await stat(child);
        size = st.isDirectory() ? null : st.size;
        mtime = st.mtimeMs ? Math.round(st.mtimeMs) : null;
      } catch { /* 忽略无权限条目 */ }
      items.push({ name: entry.name, dir: entry.isDirectory(), size, mtime });
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const limited = items.slice(0, LIST_MAX);
    emit('files.list', { path: safeRel, count: limited.length });
    return { root, path: safeRel, entries: limited, truncated: items.length > limited.length };
  }

  async function filesRead(payload) {
    const root = requireRoot();
    const rel = String(payload?.path ?? '').trim();
    if (!rel) throw new Error('缺少文件路径 | missing path');
    const { abs, rel: safeRel } = await resolveInside(root, rel);
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error('文件不存在 | file not found');
    if (info.isDirectory()) throw new Error('这是目录，不是文件 | it is a directory');
    const max = Math.max(1024, Number(cfg().maxFileBytes) || 256 * 1024);
    if (info.size > max) throw new Error(`文件过大（${(info.size / 1024).toFixed(1)} KB > 上限 ${Math.round(max / 1024)} KB）| file too large`);
    const buf = await readFile(abs);
    if (!isTextBuffer(buf)) throw new Error('二进制文件，无法以文本显示 | binary file');
    emit('files.read', { path: safeRel, size: info.size });
    return { path: safeRel, size: info.size, content: buf.toString('utf8') };
  }

  // ---------- git 变更 ----------
  // Status 取自 vscode.git 扩展的 API（api/git.d.ts 的 const enum），运行时拿不到
  // 枚举本体，只能按声明顺序写死数值：0..4 为已暂存，5..10 为工作区。
  const GIT_STATUS_LABEL = {
    0: 'M', 1: 'A', 2: 'D', 3: 'R', 4: 'C',
    5: 'M', 6: 'D', 7: 'U', 8: '!', 9: 'A', 10: 'R',
  };

  const DIFF_MAX_FILES = 200;
  const DIFF_MAX_TEXT = 64 * 1024;

  /**
   * 拿 vscode.git 扩展的 API。失败一律返回 null —— 变更能力是增强项，
   * 没装 git 扩展或工作区不是仓库时，App 侧应降级而不是报错。
   */
  function gitApi() {
    try {
      const ext = vscode.extensions?.getExtension?.('vscode.git');
      if (!ext) return null;
      const api = ext.isActive === false ? null : ext.exports?.getAPI?.(1);
      return api ?? null;
    } catch {
      return null;
    }
  }

  /** 选出与当前工作区最相关的仓库：优先含工作区根的，其次第一个。 */
  function pickRepository(api) {
    const repos = api?.repositories ?? [];
    if (!repos.length) return null;
    const root = (vscode.workspace.workspaceFolders ?? [])[0]?.uri?.fsPath ?? '';
    if (root) {
      const hit = repos.find((r) => String(r?.rootUri?.fsPath ?? '') === root);
      if (hit) return hit;
    }
    return repos[0];
  }

  function changeToItem(change, repoRoot) {
    const uri = change?.uri;
    const abs = String(uri?.fsPath ?? '');
    const path = repoRoot && abs.startsWith(repoRoot)
      ? abs.slice(repoRoot.length).replace(/^[\\/]/, '')
      : abs;
    return {
      path,
      // 绝对路径：供「在编辑器打开」直接复用 editor.open，避免按 repoRoot
      // 反推相对路径时与文件根（fileRoot）基准不一致而拼错。
      abs,
      status: GIT_STATUS_LABEL[Number(change?.status)] ?? '?',
      staged: Number(change?.status) <= 4,
      insertions: Number(change?.insertions ?? 0),
      deletions: Number(change?.deletions ?? 0),
    };
  }

  /**
   * 变更清单 + 单文件 diff 文本。
   *
   * 数据源两种，按可用性依次尝试：
   *   1. vscode.git 扩展 API —— 结构化、不启进程、拿得到增删行数；
   *   2. 只读 `git diff` 子进程 —— 仅在 1 不可用时使用，且只允许无副作用的
   *      只读子命令（diff / status），走 execFile 且不经过 shell，避免注入。
   */
  async function filesDiff(payload) {
    const rel = String(payload?.path ?? '').trim();
    const api = gitApi();
    const repo = api ? pickRepository(api) : null;

    if (repo) {
      const repoRoot = String(repo.rootUri?.fsPath ?? '');
      if (rel) {
        const text = await repo.diffWithHEAD?.(rel);
        return {
          source: 'git-api',
          repoRoot,
          path: rel,
          diff: truncate(String(text ?? ''), DIFF_MAX_TEXT),
        };
      }
      const state = repo.state ?? {};
      const all = [
        ...(state.indexChanges ?? []).map((c) => changeToItem(c, repoRoot)),
        ...(state.workingTreeChanges ?? []).map((c) => changeToItem(c, repoRoot)),
        ...(state.untrackedChanges ?? []).map((c) => changeToItem(c, repoRoot)),
      ];
      // 同一文件可能同时出现在暂存区与工作区，按路径去重后保留暂存态
      const byPath = new Map();
      for (const item of all) {
        const prev = byPath.get(item.path);
        if (!prev || (item.staged && !prev.staged)) byPath.set(item.path, item);
      }
      const files = [...byPath.values()].slice(0, DIFF_MAX_FILES);
      emit('files.diff', { count: files.length, truncated: byPath.size > files.length });
      return {
        source: 'git-api',
        repoRoot,
        files,
        truncated: byPath.size > files.length,
      };
    }

    // 降级：只读 git 子进程。execFile + 数组参数，不经 shell。
    const root = fileRoot();
    if (!root) throw new Error('没有可用的工作区根目录 | no workspace root');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const opts = { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true };

    if (rel) {
      const { stdout } = await run('git', ['diff', '--', rel], opts).catch(() => ({ stdout: '' }));
      return { source: 'git-cli', repoRoot: root, path: rel, diff: truncate(stdout, DIFF_MAX_TEXT) };
    }

    const { stdout } = await run('git', ['status', '--porcelain'], opts)
      .catch((err) => { throw new Error(`git status 失败（工作区可能不是 git 仓库）：${err?.message ?? err} | not a git repo`); });
    const files = String(stdout).split('\n').filter((l) => l.length > 3).slice(0, DIFF_MAX_FILES).map((line) => {
      const path = line.slice(3).replace(/^"(.*)"$/, '$1');
      return {
        path,
        // porcelain 的相对路径以仓库根为基准，此处 root 即 git 的 cwd，可直接拼回绝对路径
        abs: join(root, path),
        status: line.slice(0, 2).trim() || '?',
        staged: line[1] === ' ' || /[MADRC]/.test(line[0]),
        insertions: 0,
        deletions: 0,
      };
    });
    emit('files.diff', { count: files.length, source: 'git-cli' });
    return { source: 'git-cli', repoRoot: root, files, truncated: false };
  }

  async function filesWrite(payload) {
    if (cfg().allowFileWrite !== true) {
      throw new Error('文件写入已关闭：请在 VsSaros 设置里开启 sarosPocket.allowFileWrite | file write disabled');
    }
    const root = requireRoot();
    const rel = String(payload?.path ?? '').trim();
    if (!rel) throw new Error('缺少文件路径 | missing path');
    const content = String(payload?.content ?? '');
    const { abs, rel: safeRel } = await resolveInside(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    emit('files.write', { path: safeRel, size: content.length });
    return { path: safeRel, size: content.length };
  }

  // ---------- 命令 / 编辑器 / 通知 ----------
  function allowedCommands() {
    const list = Array.isArray(cfg().allowedCommands) ? cfg().allowedCommands : DEFAULT_ALLOWED_COMMANDS;
    return list.map((c) => String(c ?? '').trim()).filter(Boolean);
  }

  function assertCommandAllowed(command, allowlist) {
    const id = String(command ?? '').trim();
    if (!id) throw new Error('缺少命令 ID | missing command id');
    // 自家命令永远允许；其余必须精确命中白名单（不做前缀匹配，避免越权面扩大）
    if (id.startsWith('sarosPocket.')) return id;
    if (!allowlist.includes(id)) {
      throw new Error(`命令不在白名单里：${id}（可在设置 sarosPocket.allowedCommands 中追加）| command not allowed`);
    }
    return id;
  }

  async function commandsRun(payload) {
    const allowlist = allowedCommands();
    const id = assertCommandAllowed(payload?.command, allowlist);
    const args = Array.isArray(payload?.args) ? payload.args : [];
    const result = await vscode.commands.executeCommand(id, ...args);
    emit('commands.run', { command: id });
    return { command: id, result: result === undefined ? null : (safeJson(result) ?? null) };
  }

  function safeJson(value) {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return String(value);
    }
  }

  async function editorOpen(payload) {
    const root = requireRoot();
    const rel = String(payload?.path ?? '').trim();
    if (!rel) throw new Error('缺少文件路径 | missing path');
    // 绝对路径（变更页传来的那种）直接落盘使用，但仍须落在工作区内 ——
    // 这里刻意不绕过 resolveInside，越界依旧被拒。
    const target = isAbsolute(rel) ? rel : resolve(root, rel);
    const { abs, rel: safeRel } = await resolveInside(root, target);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    await vscode.window.showTextDocument(doc, { preview: false });
    emit('editor.open', { path: safeRel });
    return { path: safeRel, languageId: doc.languageId };
  }

  async function notify(payload) {
    const text = String(payload?.text ?? '').trim();
    if (!text) throw new Error('缺少通知内容 | missing text');
    const picked = await vscode.window.showInformationMessage(truncate(text, 500), '知道了');
    emit('notify', { text });
    return { shown: true, acknowledged: picked === '知道了' };
  }

  async function terminalSend(payload) {
    if (cfg().allowTerminal !== true) {
      throw new Error('终端发送已关闭：请在 VsSaros 设置里开启 sarosPocket.allowTerminal | terminal send disabled');
    }
    const text = String(payload?.text ?? '');
    if (!text.trim()) throw new Error('缺少要发送的文本 | missing text');
    const name = String(payload?.name ?? 'Saros Pocket').trim() || 'Saros Pocket';
    let terminal = vscode.window.terminals.find((t) => t.name === name);
    if (!terminal) terminal = vscode.window.createTerminal(name);
    terminal.show(true);
    terminal.sendText(text, payload?.newLine !== false);
    emit('terminal.send', { name, length: text.length });
    return { name, sent: text.length };
  }

  // ---------- 状态 ----------
  async function pocketStatus() {
    const pocket = (await statusProvider?.()) ?? null;
    const models = await chatModels().catch(() => []);
    const desktop = screen?.status?.() ?? null;
    return {
      pocket,
      vsaros: vsarosInfo(),
      features: {
        chat: models.length > 0,
        chatModels: models.length,
        agent: true,
        fileWrite: cfg().allowFileWrite === true,
        terminal: cfg().allowTerminal === true,
        desktop: desktop?.supported === true,
        desktopClients: desktop?.clients ?? 0,
        desktopInput: desktopInput?.supported === true && cfg().allowDesktopInput === true,
        fileRoot: fileRoot() || null,
      },
      app: { version: context?.extension?.packageJSON?.version ?? null },
    };
  }

  function vsarosInfo() {
    return {
      version: vscode.version,
      appName: vscode.env.appName,
      uiKind: vscode.env.uiKind,
      language: vscode.env.language,
      remoteName: vscode.env.remoteName ?? null,
      shell: typeof vscode.env.shell === 'string' ? vscode.env.shell : null,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath })),
      workspaceName: vscode.workspace.name ?? null,
      activeEditor: vscode.window.activeTextEditor?.document?.uri?.fsPath ?? null,
      focused: vscode.window.state?.focused ?? null,
    };
  }

  // ---------- 会话（收件箱 / 当前会话 两页的数据源）----------
  /**
   * 从 VsSaros 工作台拉「真实 Agent 会话」。
   *
   * 数据源是上游刚加的命令 `sarosPocket.listSessions`（见 VsSaros 的
   * src/vs/sessions/contrib/sarosPocket）—— 扩展进程拿不到工作台的
   * ISessionsManagementService，只能走命令桥。
   *
   * 失败一律返回 null：老版本 VsSaros 没有这条命令，此时收件箱必须
   * 优雅降级到扩展自己登记的会话，而不是空白或报错。
   */
  /**
   * 会话桥最近一次的结果（诊断用）：`ok` = 命令是否可用；`count` = 真实会话条数；`error` = 失败原因。
   * 面板与 App 的「列表为空」提示靠它区分两种成因：命令不可用（版本旧）vs 真的没有会话。
   */
  let sessionsDiag = { ok: null, count: 0, error: '', at: null };

  async function fetchRealSessions() {
    try {
      const raw = await vscode.commands.executeCommand('sarosPocket.listSessions');
      // 宽容解包：正常是数组；若上游改成 { sessions: [...] } 也不至于整列表空掉
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.sessions) ? raw.sessions : null);
      if (!list) {
        sessionsDiag = { ok: false, count: 0, error: `命令返回的不是数组（${raw === null ? 'null' : typeof raw}）`, at: Date.now() };
        logLine(`Saros Pocket: 会话桥 sarosPocket.listSessions 返回异常 ⇒ ${sessionsDiag.error}`);
        return null;
      }
      const mapped = list
        .filter((s) => s && typeof s === 'object' && (s.sessionId || s.id))
        .map((s) => ({
          // 复用本地会话的字段形态，前端无需分支
          id: String(s.sessionId ?? s.id),
          kind: 'agent',
          title: String(s.title || '').trim() || '（未命名会话）',
          status: REAL_STATUS_TO_LOCAL[String(s.status ?? '')] ?? 'running',
          preview: '',
          startedAt: typeof s.createdAt === 'number' ? s.createdAt : null,
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
          real: true,
          // ★ 「结束」在 Pocket 里的实现是**归档**（可逆）：列表默认收起它们，
          //   否则用户点了结束、会话还在列表里，看着像没生效（见 sessionsList）。
          archived: s.isArchived === true,
          unread: s.isRead === false,
          providerId: String(s.providerId ?? ''),
          sessionType: String(s.sessionType ?? ''),
          resource: String(s.resource ?? ''),
        }))
        // 会话列表按「最近更新在前」；缺时间的排最后（稳定排序，便于断言与翻页心智一致）
        .sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1));

      sessionsDiag = { ok: true, count: mapped.length, error: '', at: Date.now() };
      // 上游命令在、但一条会话都没有（或字段对不上被过滤掉）——这是「列表空」的两种成因之一，
      // 必须留痕，否则现场只有一句「还没有会话」，无从判断是版本旧还是真没会话。
      if (mapped.length === 0 && list.length > 0) {
        const keys = Object.keys(list[0] ?? {}).slice(0, 8).join(',');
        logLine(`Saros Pocket: 会话桥拿到 ${list.length} 条但全部被过滤（首条字段：${keys}）——请检查会话字段名`);
      } else {
        logLine(`Saros Pocket: 会话桥 sarosPocket.listSessions → ${mapped.length} 条真实会话`);
      }
      return mapped;
    } catch (err) {
      sessionsDiag = { ok: false, count: 0, error: String(err?.message ?? err), at: Date.now() };
      logLine(`Saros Pocket: 会话桥不可用（sarosPocket.listSessions 调用失败）⇒ ${sessionsDiag.error} —— 列表会退回 Pocket 自己登记的会话`);
      return null;
    }
  }

  /** 上游 status 字符串 → 本地会话状态（已在上游转成稳定字符串）。 */
  const REAL_STATUS_TO_LOCAL = {
    untitled: 'running',
    running: 'running',
    waiting: 'waiting',
    done: 'done',
    failed: 'failed',
  };

  // ---------- 聊天上下文（手机端聊天框头部：模式 / agent / 工作区 / worktree / 模型）----------
  /**
   * 读取聊天上下文。
   *
   * 数据源是 VsSaros 命令 `sarosPocket.getChatContext`（工作台进程才有
   * `IAgentStudioService` / `IModelSelectorService`，扩展进程拿不到）。
   * 失败（老版本 VsSaros 没这条命令）⇒ `degraded: true` + 空清单：
   * 手机端据此**隐藏**头部，而不是显示一堆假选项。
   */
  async function chatContext() {
    try {
      const raw = await vscode.commands.executeCommand('sarosPocket.getChatContext');
      if (!raw || typeof raw !== 'object') {
        const why = `命令返回异常（${raw === null ? 'null' : typeof raw}）`;
        logLine(`Saros Pocket: 聊天上下文桥不可用 ⇒ ${why}（手机端聊天头会显示为降级）`);
        return { degraded: true, error: why, ...EMPTY_CHAT_CONTEXT };
      }
      return { degraded: false, ...normalizeChatContext(raw) };
    } catch (err) {
      // 老版本 VsSaros 没有这条命令 ⇒ 手机端不该显示空下拉，而要说清"为什么空"
      const why = String(err?.message ?? err);
      logLine(`Saros Pocket: 聊天上下文桥不可用（sarosPocket.getChatContext 调用失败）⇒ ${why}`);
      return { degraded: true, error: why, ...EMPTY_CHAT_CONTEXT };
    }
  }

  /**
   * 写聊天上下文 —— 手机端的 agent / 工作区 / worktree / 模型选择**真的落到 VsSaros**
   * （切活动工作区、写 AgentBinding.worktreePath、写模型选择），所以不是"只改手机本地显示"。
   *
   * chatMode 不在这里写：VsSaros 的 chatMode 是每个聊天面板的本地状态，没有可写的共享服务；
   * 手机端把所选模式随每条消息下发（`chat.send` 的 `context.chatMode`），发送前经这里落一次
   * agent/工作区/worktree，保证执行环境与选择一致。
   */
  async function chatContextSet(payload = {}) {
    const patch = {
      workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined,
      worktreePath: payload.worktreePath === undefined ? undefined : (payload.worktreePath || null),
      agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
      providerId: typeof payload.providerId === 'string' ? payload.providerId : undefined,
      modelId: typeof payload.modelId === 'string' ? payload.modelId : undefined,
    };
    const out = await vscode.commands.executeCommand('sarosPocket.setChatContext', patch);
    const applied = Array.isArray(out?.applied) ? out.applied.map(String) : [];
    emit('chat.context', { applied, workspaceId: patch.workspaceId ?? null });
    return { ok: out?.ok !== false, applied };
  }

  async function sessionsList(payload = {}) {
    // 上限从 50 提到 200：需求是「把 VsSaros 的会话都同步过来」，不该悄悄截断
    const limit = Math.min(Math.max(Number(payload?.limit) || LIST_LIMIT_MAX, 1), LIST_LIMIT_MAX);
    const wantArchived = payload?.archived === true;
    const real = await fetchRealSessions();

    // 真实会话优先：它们才是用户想看的「Agent 在跑什么」。
    // 拿不到（老版本 VsSaros / 命令未注册）就回退到扩展自己登记的。
    const local = sessions.list({
      status: payload?.status,
      kind: payload?.kind,
      limit,
    });

    // 归档 = Pocket 里的「结束」：默认收起；想看就明确点「已归档」
    // （归档是纯 VsSaros 概念，本地影子会话没有这个字段 ⇒ 归档视图里不掺它们）
    const realVisible = real ? real.filter((s) => (wantArchived ? s.archived === true : s.archived !== true)) : null;
    const archivedCount = real ? real.filter((s) => s.archived === true).length : 0;

    let merged;
    if (!real) {
      merged = wantArchived ? [] : local;
    } else if (wantArchived) {
      merged = realVisible;
    } else {
      merged = realVisible.concat(local.filter((s) => !realVisible.some((r) => r.title === s.title)));
    }

    if (payload?.status) {
      merged = merged.filter((s) => s.status === payload.status);
    }
    // 统一按「最近更新在前」：真实会话内部已排好，但本地影子会话可能比它们更新
    merged = merged.slice().sort((a, b) => (b.updatedAt ?? b.startedAt ?? -1) - (a.updatedAt ?? a.startedAt ?? -1));
    return {
      sessions: merged.slice(0, limit),
      source: real ? 'vsaros' : 'pocket',
      // 面板据此决定要不要显示「已归档」芯片（0 就不显示，别放一个点进去是空的入口）
      archivedCount,
      total: merged.length,
      // 诊断：`{ok:false,error}` = VsSaros 侧的会话桥不可用（老版本 / 命令失败）；
      // App 据此把「还没有会话」换成有指向的说明，而不是让人以为真的没会话
      diag: { ...sessionsDiag },
    };
  }

  function sessionsGet(payload) {
    const id = String(payload?.id ?? '').trim();
    if (!id) throw new Error('缺少会话 id | missing session id');
    const session = sessions.get(id);
    if (!session) throw new Error('会话不存在 | session not found');
    return { session };
  }

  /**
   * 向真实 VsSaros Agent 会话发消息。
   *
   * ⚠ 写操作：会驱动 Agent 改代码，必须先过 allowAgentControl 开关（默认关闭）。
   * 只对 real 会话（来自 VsSaros 的）生效；本地登记的影子会话没有上游实体，
   * 发了也没人接，直接拒绝而不是静默成功。
   */
  async function sessionsSend(payload) {
    if (cfg().allowAgentControl !== true) {
      throw new Error('Agent 控制已关闭：请在 VsSaros 设置里开启 sarosPocket.allowAgentControl | agent control disabled');
    }
    const id = String(payload?.id ?? '').trim();
    const text = String(payload?.text ?? '').trim();
    if (!id) throw new Error('缺少会话 id | missing session id');
    if (!text) throw new Error('缺少消息内容 | missing text');

    const real = await fetchRealSessions();
    const target = (real ?? []).find((s) => s.id === id);
    if (!target) {
      throw new Error('只能向 VsSaros 的真实 Agent 会话发消息 | not a real VsSaros session');
    }

    const out = await vscode.commands.executeCommand('sarosPocket.sendRequest', id, text);
    emit('sessions.send', { id, bytes: text.length });
    return { id, sent: true, ok: out?.ok === true };
  }

  /**
   * 结束（归档）一个真实 Agent 会话 —— 对应收件箱里的「中止」。
   *
   * 用归档而非删除：归档可逆，删除不可逆。语义上都是「从活跃列表消失」。
   */
  async function sessionsArchive(payload) {
    if (cfg().allowAgentControl !== true) {
      throw new Error('Agent 控制已关闭：请在 VsSaros 设置里开启 sarosPocket.allowAgentControl | agent control disabled');
    }
    const id = String(payload?.id ?? '').trim();
    if (!id) throw new Error('缺少会话 id | missing session id');

    const real = await fetchRealSessions();
    const target = (real ?? []).find((s) => s.id === id);
    if (!target) {
      throw new Error('只能操作 VsSaros 的真实 Agent 会话 | not a real VsSaros session');
    }

    const out = await vscode.commands.executeCommand('sarosPocket.archiveSession', id);
    emit('sessions.archive', { id });
    return { id, archived: true, ok: out?.ok === true };
  }

  /** 中止会话：chat 走 CancellationTokenSource，其余直接标记取消。 */
  function sessionsCancel(payload) {
    const id = String(payload?.id ?? '').trim();
    if (!id) throw new Error('缺少会话 id | missing session id');
    const session = sessions.get(id);
    if (!session) throw new Error('会话不存在 | session not found');

    const outcome = chatCancel({ sessionId: id });
    if (!outcome.cancelled) {
      sessions.finish(id, { status: 'cancelled' });
    }
    return { sessionId: id, cancelled: true, status: sessions.get(id)?.status ?? 'cancelled' };
  }

  // ---------- 桌面画面：远程查看 VsSaros.exe 的 UI ----------
  // 走 MJPEG over HTTP（见 lib/rpc.mjs 的 /saros-pocket/screen.mjpeg），
  // 状态/参数/输入都收在这里，与聊天、文件共用同一套 endpoint 分发与错误信封。
  const DESKTOP_STREAM_URL = '/saros-pocket/screen.mjpeg';
  const DESKTOP_SNAPSHOT_URL = '/saros-pocket/screen.jpg';

  // endpoint 契约是 (payload) => Promise：即使只做同步校验也要 async，
  // 否则错误是「同步抛出」而不是 rejected promise（调用方/测试用 await 接不住）。
  async function desktopStatus() {
    const s = screen?.status?.() ?? {
      supported: false, platform: process.platform, backend: null, running: false, clients: 0, lastError: '未启用屏幕采集 | screen source not attached',
    };
    return {
      ...s,
      inputAllowed: cfg().allowDesktopInput === true,
      inputSupported: desktopInput?.supported === true,
      streamUrl: DESKTOP_STREAM_URL,
      snapshotUrl: DESKTOP_SNAPSHOT_URL,
    };
  }

  async function desktopConfig(payload) {
    if (!screen) throw new Error('屏幕采集不可用（未启用）| screen capture unavailable');
    if (cfg().desktopEnabled === false) throw new Error('桌面画面已关闭：请开启 sarosPocket.desktopEnabled | desktop view disabled');
    const patch = {};
    for (const key of ['fps', 'quality', 'scale', 'mode', 'processName', 'monitor', 'maxWidth']) {
      if (payload?.[key] !== undefined) patch[key] = payload[key];
    }
    if (patch.mode !== undefined && patch.mode !== 'window' && patch.mode !== 'screen') {
      throw new Error('采集模式只能是 window 或 screen | invalid mode');
    }
    const next = screen.reconfigure(patch);
    emit('desktop.config', next);
    return desktopStatus();
  }

  async function desktopSendInput(payload) {
    // 开关判定在 desktopInput 内部（与 terminal.send / files.write 同一个位置：动作之前）
    if (!desktopInput) throw new Error('桌面输入不可用 | desktop input unavailable');
    const result = await desktopInput.send(payload ?? {});
    emit('desktop.input', result);
    return result;
  }

  const endpoints = {
    'pocket.status': pocketStatus,
    'desktop.status': desktopStatus,
    'desktop.config': desktopConfig,
    'desktop.input': desktopSendInput,
    'vsaros.info': () => vsarosInfo(),
    'chat.models': chatModels,
    'chat.send': chatSend,
    'chat.cancel': chatCancel,
    'agent.send': agentSend,
    'sessions.list': sessionsList,
    'sessions.get': sessionsGet,
    'sessions.send': sessionsSend,
    'sessions.archive': sessionsArchive,
    'sessions.cancel': sessionsCancel,
    // 聊天框头部（模式 / agent / 工作区 / worktree / 模型）：读渲染、写落回 VsSaros
    'chat.context': chatContext,
    'chat.context.set': chatContextSet,
    'files.list': filesList,
    'files.read': filesRead,
    'files.diff': filesDiff,
    'files.write': filesWrite,
    'commands.list': () => ({ commands: allowedCommands() }),
    'commands.run': commandsRun,
    'editor.open': editorOpen,
    'notify': notify,
    'terminal.send': terminalSend,
    'events.recent': () => events?.recent() ?? [],
  };

  return {
    endpoints,
    sessions,
    dispose() {
      for (const d of disposables.reverse()) {
        try { d?.dispose?.(); } catch { /* 忽略 */ }
      }
      for (const cts of runs.values()) {
        try { cts.cancel(); cts.dispose(); } catch { /* 忽略 */ }
      }
      runs.clear();
      runSession.clear();
      logLine?.('Saros Pocket: VsSaros bridge disposed');
    },
  };
}
