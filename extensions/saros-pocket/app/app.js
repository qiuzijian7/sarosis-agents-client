// Saros Pocket App — 手机端与 VsSaros 通信的轻量客户端
//
// 通信两条通道（与 lib/rpc.mjs 对应）：
//   1. POST {rpcPrefix}<endpoint>  —— 请求-响应（聊天/文件/命令/状态）
//   2. GET  {eventsPath}           —— SSE 事件流（聊天流式增量、VsSaros 侧事件）
//
// 无框架、无构建：原生 JS，直接由 Pocket 代理托管（/pocket/）。
// 界面参考 dsh-pocket 的移动端点（窄屏优先、大点击区），但只做「通信」这一件事。

(function () {
  'use strict';

  var boot = window.__POCKET__ || {};
  // BASE 是「跨源基址」：浏览器内由代理同源托管，为空串 → 走相对路径，行为不变；
  // Capacitor 打包后页面源是 capacitor://localhost / http://localhost，必须拼成
  // http://<电脑IP>:3081 这样的绝对地址才能连到 Pocket 代理（见 mobile/sync-web.mjs）。
  var BASE = boot.baseUrl || '';
  function abs(p) { return BASE && p.charAt(0) === '/' ? BASE + p : p; }
  var RPC = abs(boot.rpcPrefix || '/saros-pocket/rpc/');
  var EVENTS = abs(boot.eventsPath || '/saros-pocket/events');

  var state = {
    tab: 'inbox',
    models: [],
    modelId: '',
    history: [],       // [{role, content}]
    busy: false,
    streamingId: null, // 正在接收流式的 runId
    path: '',
    filePath: null,
    events: [],
    status: null,
    // 会话列表（原「收件箱」，design-spec 2.1）
    sessions: [],
    sessionFilter: 'all',
    /** 已归档会话数（VsSaros 侧归档 = Pocket 的「结束」）；0 时不显示「已归档」芯片 */
    archivedCount: 0,
    /** 会话来源：'vsaros' = 真实 VsSaros 会话；'pocket' = 老版本降级到本地登记 */
    sessionSource: '',
    /** 会话桥诊断（{ok,count,error}）：列表为空时用来区分"命令不可用"与"真的没会话" */
    sessionDiag: null,
    activeSessionId: null,
    /**
     * 聊天上下文（与 VsSaros 聊天框同构的头部）：agent / 工作区 / worktree / 模式。
     * 由 `chat.context` 填充；老版本 VsSaros 读不到时 degraded=true（头部隐藏真实列表）。
     */
    chatContext: { degraded: false, chatModes: [], agents: [], workspaces: [], worktrees: [], workspaceId: '', worktreePath: '', agentId: '', selection: null },
    /** 聊天模式：craft（完整工具）/ ask（只读）/ plan（只读+任务拆解），与桌面端输入框同档 */
    chatMode: 'craft',
    /** 聊天上下文是否已拉过（首次进「当前会话」页时惰性加载） */
    chatContextLoaded: false,
  };

  var el = {};
  ['connDot', 'connText', 'hostInfo', 'modelSelect', 'messages', 'input', 'send', 'toAgent',
    'clearChat', 'entries', 'pathText', 'upDir', 'reloadFiles', 'fileView', 'fileName',
    'fileBody', 'openInEditor', 'closeFile', 'statusCards', 'events', 'clearEvents', 'toast',
    'sessionList', 'sessionChips', 'reloadSessions', 'browseFiles', 'changes', 'reloadChanges', 'sessionDiag',
    'voice',
    'screenImg', 'screenStatus', 'screenMode', 'screenFps', 'screenScale', 'screenShot',
    'screenReload', 'screenInputBar', 'screenInputOn', 'screenText', 'screenFull', 'screenWrap',
    'screenExit', 'screenInputNote', 'screenInputRecheck', 'screenInputBadge',
    'chatContextBar', 'chatAgent', 'chatWorkspace', 'chatWorktree', 'chatModes', 'chatCtxHint',
    // App 自升级（原生壳专用；浏览器里 updateWrap 保持隐藏）
    'updateWrap', 'updateState', 'updateCheck', 'updateInstall', 'updateGrant',
    'updateBarWrap', 'updateBar', 'updateNotes', 'updateAuto', 'updateUrl', 'updateSrcHint', 'updateCur',
    // App 信息（点顶部 logo 弹出）
    'aboutOpen', 'aboutMask', 'aboutClose', 'aboutVer', 'aboutRows', 'aboutNote', 'aboutCheck', 'aboutOk']
    .forEach(function (id) {
      el[id] = document.getElementById(id);
    });

  /**
   * 把 `?token=<访问密码>` 从地址栏摘掉。
   *
   * 为什么：面板的「在浏览器打开（免输密码）」会用带 `?token=` 的地址打开本机浏览器，
   * 代理**在响应头里已经种下 HttpOnly cookie**（后续请求靠 cookie 鉴权），所以参数此刻已经没用了；
   * 留着只会进浏览器历史、被截图/分享带走。用 replaceState（不是 push）⇒ 不产生返回栈残留。
   */
  function stripTokenFromAddressBar() {
    try {
      var u = new URL(window.location.href);
      if (!u.searchParams.has('token')) return;
      u.searchParams.delete('token');
      var clean = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash;
      window.history.replaceState(null, '', clean);
    } catch (e) { /* 老浏览器/异常 URL：保持原样，不影响功能 */ }
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  var toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2400);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------- RPC ----------
  async function rpc(endpoint, payload) {
    var res = await fetch(RPC + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: payload || {} }),
      // 跨源（Capacitor：capacitor://localhost → http://<电脑IP>:3081）时
      // 必须显式带上 PIN 会话 cookie，否则每个请求都会被代理判为未登录。
      credentials: BASE ? 'include' : 'same-origin',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var body = await res.json().catch(function () { return null; });
    if (!body) throw new Error('响应不是合法 JSON');
    if (!body.ok) throw new Error((body.error && body.error.message) || '请求失败');
    return body.value;
  }

  // ---------- 连接状态 ----------
  function setConn(kind, text) {
    el.connDot.className = 'dot' + (kind ? ' ' + kind : '');
    el.connText.textContent = text;
  }

  function connectEvents() {
    if (typeof EventSource !== 'function') {
      setConn('off', '浏览器不支持事件流');
      return;
    }
    // withCredentials：跨源场景（Capacitor）下让 SSE 也携带 PIN 会话 cookie。
    var source = new EventSource(EVENTS, BASE ? { withCredentials: true } : undefined);
    source.addEventListener('open', function () { setConn('on', '已连接 VsSaros'); });
    source.addEventListener('error', function () { setConn('off', '连接断开，重连中…'); });
    ['chat.delta', 'chat.done', 'chat.error', 'chat.start', 'editor.change', 'file.save',
      'window.state', 'files.list', 'files.read', 'commands.run', 'notify', 'agent.sent', 'terminal.send',
      'session.start', 'session.update', 'session.done']
      .forEach(function (type) {
        source.addEventListener(type, function (ev) {
          var data = null;
          try { data = JSON.parse(ev.data); } catch (e) { data = null; }
          pushEvent(type, data);
          if (type === 'chat.delta') onDelta(data);
          // 会话状态变化 → 收件箱可见时立即刷新，用户不必手动点
          if (type.indexOf('session.') === 0 && state.tab === 'inbox') {
            loadSessions().catch(function () { /* 后台静默刷新 */ });
          }
        });
      });
  }

  function pushEvent(type, data) {
    state.events.unshift({ type: type, data: data, at: Date.now() });
    if (state.events.length > 60) state.events.pop();
    if (state.tab === 'status') renderEvents();
  }

  function renderEvents() {
    el.events.innerHTML = state.events.map(function (e) {
      var t = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
      var brief = '';
      try { brief = typeof e.data === 'string' ? e.data : JSON.stringify(e.data); } catch (err) { brief = ''; }
      if (brief && brief.length > 120) brief = brief.slice(0, 120) + '…';
      return '<div class="ev"><span class="t">' + esc(t) + '</span><span>' + esc(e.type) + '</span><span>' + esc(brief) + '</span></div>';
    }).join('') || '<div class="empty">暂无事件</div>';
  }

  // ---------- 对话 ----------
  function addMsg(kind, text, runId) {
    var div = document.createElement('div');
    div.className = 'msg ' + kind;
    div.textContent = text || '';
    if (runId) div.dataset.runId = runId;
    el.messages.appendChild(div);
    el.messages.scrollTop = el.messages.scrollHeight;
    return div;
  }

  function onDelta(data) {
    if (!data || !data.runId) return;
    var node = el.messages.querySelector('.msg[data-run-id="' + data.runId + '"]');
    if (!node) return;
    node.textContent = (node.textContent || '') + (data.text || '');
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function setBusy(on) {
    state.busy = on;
    el.send.disabled = on;
    el.toAgent.disabled = on;
    el.send.textContent = on ? '思考中…' : '发送';
    // 开始等待回复时停掉录音：否则「思考中」期间还在听，说出来的话会被追加进输入框，
    // 看着像识别串了台。已识别的文字保留在输入框里，不丢。
    if (on && voice.on) stopVoice();
    if (el.voice) el.voice.disabled = on || !voice.supported;
  }

  async function sendToChat() {
    var text = el.input.value.trim();
    if (!text || state.busy) return;
    el.input.value = '';
    el.input.style.height = 'auto';
    addMsg('user', text);
    state.history.push({ role: 'user', content: text });

    var runId = uid();
    state.streamingId = runId;
    var bubble = addMsg('assistant streaming', '', runId);
    setBusy(true);
    try {
      var res = await rpc('chat.send', {
        runId: runId,
        text: text,
        messages: state.history.slice(-20, -1),
        modelId: state.modelId || undefined,
        // 本次对话的上下文（模式/agent/工作区/worktree）：服务端会先落到 VsSaros 再发请求
        context: chatContextPayload(),
      });
      if (!bubble.textContent) bubble.textContent = (res && res.text) || '（模型没有输出）';
      bubble.classList.remove('streaming');
      if (res && res.text) state.history.push({ role: 'assistant', content: res.text });
      if (res && res.cancelled) addMsg('system', '已中止（超过 10 分钟上限或手动取消）');
    } catch (err) {
      bubble.classList.remove('streaming');
      bubble.className = 'msg error';
      bubble.textContent = err.message || String(err);
    } finally {
      state.streamingId = null;
      setBusy(false);
    }
  }

  async function sendToAgent() {
    var text = el.input.value.trim();
    if (!text || state.busy) return;
    el.input.value = '';
    addMsg('user', text);
    setBusy(true);
    try {
      var res = await rpc('agent.send', { text: text });
      var r = (res && res.result) || {};
      addMsg('system', r.error
        ? 'Agent 返回错误：' + r.error
        : '已交给 VsSaros Agent（' + (res && res.command ? res.command : 'workbench.action.chat.open') + '）执行，回复请在 VsSaros 里查看。');
    } catch (err) {
      addMsg('error', err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  // ---------- 语音输入 ----------
  // 为什么不用「录音上传 + 服务端转写」：那条路要 getUserMedia，而它和
  // SpeechRecognition 一样**只在安全上下文可用**。局域网 http://<IP>:3081 下浏览器
  // 根本不给麦克风，上传方案同样救不了，却要多背一条音频通道和一个外部 ASR 依赖。
  // 所以用浏览器原生识别（零依赖），并在非安全上下文下把按钮讲清楚，而不是假装能用。
  var voice = { recognition: null, on: false, base: '', supported: false, blocked: '' };

  /** 安全上下文之外一律不可用：http 局域网是 Pocket 的默认访问方式，必须显式说明。 */
  function voiceUnavailableReason() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return '这个浏览器不支持语音识别（iOS Safari / 部分国产内核不支持）';
    if (!window.isSecureContext) return '语音需要 https：局域网 http 下浏览器不给麦克风。改用公网隧道地址，或用手机输入法自带的麦克风';
    return '';
  }

  function setVoiceState(on) {
    voice.on = on;
    if (!el.voice) return;
    el.voice.classList.toggle('recording', on);
    el.voice.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.voice.textContent = on ? '停止' : '🎙';
    el.voice.title = on ? '停止并保留已识别的文字' : '语音输入';
  }

  function startVoice() {
    var rec = voice.recognition;
    if (!rec) return;
    // 每次开始都记下输入框的当前内容：识别结果是**追加**上去的，
    // 这样用户先打字再说、或说了两段，都不会被后面的结果覆盖掉。
    voice.base = el.input.value;
    try {
      rec.start();
      setVoiceState(true);
    } catch (err) {
      // Chrome 在已 start 时重复调用会抛 InvalidStateError —— 不是故障，忽略即可
      setVoiceState(false);
    }
  }

  function stopVoice() {
    if (voice.recognition) {
      try { voice.recognition.stop(); } catch (err) { /* 已停止 */ }
    }
    setVoiceState(false);
  }

  function setupVoiceInput() {
    if (!el.voice) return;
    voice.blocked = voiceUnavailableReason();
    voice.supported = !voice.blocked;
    if (!voice.supported) {
      el.voice.disabled = true;
      el.voice.classList.add('disabled');
      el.voice.title = voice.blocked;
      return;
    }

    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var rec = new SR();
    rec.lang = navigator.language || 'zh-CN';
    // 连续识别 + 即时结果：说完自然停顿会继续听，用户点「停止」才结束，
    // 比说一句就断更适合「边说边改」的输入场景。
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = function (ev) {
      var finalText = '';
      var interimText = '';
      for (var i = ev.resultIndex; i < ev.results.length; i += 1) {
        var result = ev.results[i];
        var piece = (result[0] && result[0].transcript) || '';
        if (result.isFinal) finalText += piece;
        else interimText += piece;
      }
      // final 结果固化进 base（后续结果追加在它后面），interim 只做预览、不入 base
      if (finalText) voice.base += finalText;
      el.input.value = voice.base + interimText;
      el.input.dispatchEvent(new Event('input'));
    };
    rec.onerror = function (ev) {
      setVoiceState(false);
      // not-allowed / service-not-allowed = 麦克风权限被拒或系统没开识别服务，
      // 与网络类错误分开讲，否则用户只会看到一句没用的「error」。
      var why = ev.error === 'not-allowed' || ev.error === 'service-not-allowed'
        ? '麦克风权限被拒或系统未启用语音识别'
        : ('识别失败：' + ev.error);
      toast(why);
    };
    rec.onend = function () { setVoiceState(false); };

    voice.recognition = rec;
    el.voice.addEventListener('click', function () {
      if (voice.on) stopVoice(); else startVoice();
    });
  }

  // ---------- 聊天上下文（与 VsSaros 聊天框同构：Agent / 工作区 / Worktree / 模式）----------
  // 模式与桌面端输入框一致的三档（craft/ask/plan；workflow 由工作流编辑器驱动，不作为手选项）
  var CHAT_MODE_FALLBACK = [
    { id: 'craft', label: 'Craft', description: '完整工具访问，可直接修改代码和执行命令' },
    { id: 'ask', label: 'Ask', description: '只读工具访问，提供技术解答和建议' },
    { id: 'plan', label: 'Plan', description: '只读探索 + 任务拆解' },
  ];

  /**
   * 给 VsSaros 返回的模式 id 配上本地文案。
   * VsSaros 只给 id（契约是 id，标签在客户端）；缺标签时退回 id 本身，不至于显示空白。
   */
  function mergeChatModeLabels(list) {
    if (!Array.isArray(list) || list.length === 0) return CHAT_MODE_FALLBACK;
    return list.map(function (m) {
      var id = m && m.id ? String(m.id) : '';
      var known = CHAT_MODE_FALLBACK.filter(function (f) { return f.id === id; })[0];
      return {
        id: id,
        label: (m && m.label) || (known && known.label) || id,
        description: (m && m.description) || (known && known.description) || '',
      };
    }).filter(function (m) { return !!m.id; });
  }

  /** 空选项文案（列表为空 / 老版本 VsSaros 时不能留一个空白下拉让人困惑）。 */
  function fillSelect(sel, items, value, emptyLabel) {
    if (!sel) return;
    if (!items.length) {
      sel.innerHTML = '<option value="">' + esc(emptyLabel) + '</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = items.map(function (it) {
      var label = it.label || it.name || it.id;
      if (it.extra) label += ' · ' + it.extra;
      return '<option value="' + esc(it.id) + '">' + esc(label) + '</option>';
    }).join('');
    if (value) sel.value = value;
  }

  async function loadChatContext() {
    var ctx = null;
    try { ctx = await rpc('chat.context', {}); } catch (err) { ctx = null; }
    var degraded = !ctx || ctx.degraded === true;
    state.chatContext = {
      degraded: degraded,
      // VsSaros 只给 id（标签是客户端的事）⇒ 按 id 映射回本地文案；未知 id 退回原样显示
      error: (ctx && ctx.error) || '',
      chatModes: mergeChatModeLabels(ctx && Array.isArray(ctx.chatModes) ? ctx.chatModes : []),
      agents: (ctx && Array.isArray(ctx.agents)) ? ctx.agents : [],
      workspaces: (ctx && Array.isArray(ctx.workspaces)) ? ctx.workspaces : [],
      worktrees: (ctx && Array.isArray(ctx.worktrees)) ? ctx.worktrees : [],
      workspaceId: (ctx && ctx.workspaceId) || '',
      selection: (ctx && ctx.selection) || null,
    };
    // 默认选第一个 agent / 活动工作区（与桌面端"当前值"对齐）
    if (!state.chatContext.agentId && state.chatContext.agents.length) {
      state.chatContext.agentId = state.chatContext.agents[0].id;
    }
    if (!state.chatContext.workspaceId && state.chatContext.workspaces.length) {
      state.chatContext.workspaceId = state.chatContext.workspaces[0].id;
    }
    renderChatContext();
  }

  function renderChatContext() {
    var c = state.chatContext;
    fillSelect(el.chatAgent, c.agents.map(function (a) {
      return { id: a.id, label: a.name || a.id };
    }), c.agentId, '（VsSaros 暂无 Agent）');
    fillSelect(el.chatWorkspace, c.workspaces.map(function (w) {
      return { id: w.id, label: w.name || w.id, extra: w.worktreeBranch || '' };
    }), c.workspaceId, '（VsSaros 暂无工作区）');
    // worktree：主仓库用空值表示（与桌面端契约一致：列表只含"主仓库之外"的 worktree）
    fillSelect(el.chatWorktree, [{ id: '', label: '主仓库' }].concat(c.worktrees.map(function (t) {
      return { id: t.path, label: t.branch || t.path, extra: t.uncommitted ? t.uncommitted + ' 改动' : '' };
    })), state.chatContext.worktreePath || '', '主仓库');
    renderChatModes();
    renderChatCtxHint();
  }

  function renderChatModes() {
    if (!el.chatModes) return;
    var modes = state.chatContext.chatModes;
    el.chatModes.innerHTML = modes.map(function (m) {
      return '<button type="button" class="chat-mode' + (m.id === state.chatMode ? ' active' : '')
        + '" data-mode="' + esc(m.id) + '" title="' + esc(m.description || '') + '">' + esc(m.label || m.id) + '</button>';
    }).join('');
  }

  function renderChatCtxHint() {
    if (!el.chatCtxHint) return;
    var c = state.chatContext;
    if (c.degraded) {
      // 带上原因：这行文字要能直接回答「为什么 Agent/工作区是空的」
      el.chatCtxHint.textContent = '没读到 VsSaros 的工作区/Agent 列表：' + (c.error || '会话桥不可用')
        + ' —— 模式仍可用；请确认 VsSaros 已重新编译到包含 sarosPocket.getChatContext 的版本。';
      el.chatCtxHint.className = 'chat-ctx-hint warn';
      return;
    }
    var ws = c.workspaces.filter(function (w) { return w.id === c.workspaceId; })[0];
    var parts = [];
    if (ws) parts.push(ws.name || ws.id);
    if (c.worktreePath) parts.push('worktree: ' + (c.worktreePath.split(/[\\/]/).pop() || c.worktreePath));
    if (state.modelId) {
      var model = (state.models || []).filter(function (m) { return m.id === state.modelId; })[0];
      if (model) parts.push(model.name || model.id);
    }
    var mode = c.chatModes.filter(function (m) { return m.id === state.chatMode; })[0];
    if (mode) parts.push(mode.label);
    el.chatCtxHint.textContent = parts.join(' · ');
    el.chatCtxHint.className = 'chat-ctx-hint';
  }

  /** 随每条消息下发的上下文（模式 + agent + 工作区 + worktree）。 */
  function chatContextPayload() {
    var c = state.chatContext;
    return {
      chatMode: state.chatMode,
      agentId: c.agentId || '',
      workspaceId: c.workspaceId || '',
      worktreePath: c.worktreePath || '',
    };
  }

  /** 把选择**真的落到 VsSaros**（切工作区 / 写 worktree 绑定 / 写模型选择）；失败只提示，不拦操作。 */
  function pushChatContext() {
    rpc('chat.context.set', chatContextPayload()).catch(function (err) {
      toast('上下文没能写到 VsSaros：' + (err.message || err));
    });
  }

  async function loadModels() {
    try {
      var models = await rpc('chat.models', {});
      state.models = Array.isArray(models) ? models : [];
    } catch (err) {
      state.models = [];
    }
    if (state.models.length === 0) {
      el.modelSelect.innerHTML = '<option value="">（没有可用模型，用「交给 Agent」）</option>';
      renderChatCtxHint();
      return;
    }
    el.modelSelect.innerHTML = state.models.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.name || m.id) + '</option>';
    }).join('');
    state.modelId = el.modelSelect.value;
    renderChatCtxHint(); // 上下文摘要里带上模型名
  }

  // ---------- 文件 ----------
  async function loadDir(path) {
    var res = await rpc('files.list', { path: path || '' });
    state.path = res.path === '.' ? '' : res.path;
    el.pathText.textContent = '/' + (state.path || '');
    if (!res.entries.length) {
      el.entries.innerHTML = '<div class="empty">空目录</div>';
      return;
    }
    el.entries.innerHTML = res.entries.map(function (e) {
      var size = e.dir ? '' : (e.size == null ? '' : (e.size > 1024 ? Math.round(e.size / 1024) + ' KB' : e.size + ' B'));
      return '<div class="entry" data-name="' + esc(e.name) + '" data-dir="' + (e.dir ? '1' : '0') + '">'
        + '<span class="kind">' + (e.dir ? '[D]' : '[F]') + '</span>'
        + '<span class="name">' + esc(e.name) + '</span>'
        + '<span class="size">' + esc(size) + '</span></div>';
    }).join('');
  }

  async function openFile(name) {
    var path = state.path ? state.path + '/' + name : name;
    var res = await rpc('files.read', { path: path });
    state.filePath = path;
    el.fileName.textContent = path;
    el.fileBody.textContent = res.content || '（空文件）';
    el.fileView.classList.remove('hidden');
  }

  // ---------- 状态 ----------
  function card(k, v, cls) {
    return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>';
  }

  /**
   * 公网隧道那张卡显示什么。
   *
   * 优先级：下载进度 > 隧道地址 > 阶段文案。
   * 下载 cloudflared 是首启最慢的一步（约 20MB），以前只显示 downloading 一个词，
   * 看起来像卡死；这里给出真实字节数与百分比。
   */
  function tunnelCardValue(p) {
    if (p.tunnelUrl) return p.tunnelUrl;
    var ts = p.tunnelState || {};
    var d = ts.download;
    if (d && ts.phase === 'downloading') {
      if (d.percent != null) return '下载 cloudflared ' + d.percent + '%（' + fmtBytes(d.received) + ' / ' + fmtBytes(d.total) + '）';
      return '下载 cloudflared ' + fmtBytes(d.received);
    }
    return ts.phase || 'idle';
  }

  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function loadStatus() {
    try {
      var s = await rpc('pocket.status', {});
      state.status = s;
      var p = s.pocket || {};
      var v = s.vsaros || {};
      var f = s.features || {};
      el.hostInfo.textContent = (v.appName || 'VsSaros') + ' ' + (v.version || '');
      el.statusCards.innerHTML = [
        card('VsSaros', (v.appName || 'VsSaros') + ' ' + (v.version || '?')),
        card('工作区', (v.workspaceFolders && v.workspaceFolders[0] && v.workspaceFolders[0].path) || '（未打开）'),
        card('上游端口', p.upstreamPort == null ? '?' : String(p.upstreamPort)),
        card('代理端口', p.proxyPort == null ? '未启动' : String(p.proxyPort), p.proxyRunning ? 'on' : 'off'),
        card('局域网', p.lanUrl || '未检测到', p.lanUrl ? 'on' : 'off'),
        card('公网隧道', tunnelCardValue(p), p.tunnelUrl ? 'on' : 'off'),
        card('模型可用', f.chat ? (f.chatModels + ' 个') : '无', f.chat ? 'on' : 'off'),
        card('当前编辑器', v.activeEditor || '（无）'),
        card('文件写入', f.fileWrite ? '已开启' : '已关闭', f.fileWrite ? 'on' : 'off'),
        card('终端发送', f.terminal ? '已开启' : '已关闭', f.terminal ? 'on' : 'off'),
        card('桌面画面', f.desktop ? '可用' : '不可用', f.desktop ? 'on' : 'off'),
        card('桌面观看中', f.desktopClients ? (f.desktopClients + ' 台') : '无'),
        card('远程键鼠', f.desktopInput ? '已开启' : '已关闭', f.desktopInput ? 'on' : 'off'),
        // 仅在原生壳（有跨源基址）里出现：换一台电脑时用它重新配对。
        BASE ? card('已配对电脑', BASE, 'on') : '',
        BASE ? '<div class="card"><div class="k">配对</div>' +
          '<div class="v"><button class="ghost small" id="unpair" type="button">忘记此电脑</button></div></div>' : '',
      ].join('');
      var unpair = document.getElementById('unpair');
      if (unpair) {
        unpair.addEventListener('click', function () {
          try { localStorage.removeItem(PAIR_KEY); } catch (e) { /* 忽略 */ }
          location.reload();
        });
      }
    } catch (err) {
      el.statusCards.innerHTML = '<div class="card"><div class="k">状态</div><div class="v off">' + esc(err.message) + '</div></div>';
    }
  }

  // ---------- 收件箱（会话列表） ----------
  var STATUS_LABEL = {
    running: '运行中',
    waiting: '待授权',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };

  function statusLabel(status) {
    return STATUS_LABEL[status] || status || '未知';
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
    return Math.round(sec / 3600) + ' 小时前';
  }

  /**
   * 会话桥是通的、上游也返回了条目，但一条都没留下（字段名对不上被全部过滤）。
   * 与「真的没有会话」必须分开提示：前者是可修的桥接问题，后者是用户侧没开会话。
   */
  function diagDroppedAll() {
    var d = state.sessionDiag;
    return !!d && d.ok === true && (d.raw || 0) > 0 && d.dropped === d.raw;
  }

  function renderSessions() {
    if (!el.sessionList) return;
    var list = state.sessions || [];
    if (list.length === 0) {
      var degraded = state.sessionDiag && state.sessionDiag.ok === false;
      if (state.sessionFilter === 'archived') {
        el.sessionList.innerHTML = '<div class="empty">还没有已归档的会话。</div>';
      } else if (degraded) {
        // ★ 「列表空」有两种成因，必须分开说：命令不可用（版本/异常）vs 真的没有会话
        el.sessionList.innerHTML = '<div class="empty">'
          + '没能读到 VsSaros 的会话列表 —— ' + esc(state.sessionDiag.error || '会话桥不可用') + '。<br>'
          + '这里显示的是 Pocket 自己记录的会话。请确认 VsSaros 已重启到包含 <code>sarosPocket.listSessions</code> 的版本；'
          + '细节见 VsSaros「输出 → Saros Pocket」里的会话桥日志。</div>';
      } else if ((state.archivedCount || 0) > 0) {
        // 会话不是没了，是都被「结束」收进归档了 ⇒ 别报「还没有会话」，那会让人以为数据丢了
        el.sessionList.innerHTML = '<div class="empty">'
          + state.archivedCount + ' 个会话已结束（归档）。<br>'
          + '点上面的「已归档 ' + state.archivedCount + '」查看它们。</div>';
      } else if (diagDroppedAll()) {
        // 命令通、上游也返回了条目，但字段名对不上被全部丢弃 —— 与「真没会话」必须分开讲
        el.sessionList.innerHTML = '<div class="empty">'
          + '读到 ' + state.sessionDiag.raw + ' 条会话，但字段对不上、全部被过滤掉了。<br>'
          + '细节（首条字段名）见 VsSaros「输出 → Saros Pocket」的会话桥日志。</div>';
      } else {
        el.sessionList.innerHTML = '<div class="empty">VsSaros 里还没有会话。在电脑上开一个 Agent 会话，或直接发一条消息试试。</div>';
      }
      return;
    }
    el.sessionList.innerHTML = list.map(function (s) {
      // 列表里混着 VsSaros 真实会话与本地影子会话 ⇒ meta 要能一眼分辨
      var meta = (s.archived ? '已归档 · ' : '')
        + (s.kind === 'agent' ? 'Agent' : '对话')
        + (s.sessionType ? '（' + s.sessionType + '）' : '')
        + ' · ' + timeAgo(s.updatedAt || s.startedAt);
      if (s.error) meta += ' · ' + esc(s.error);
      // 真实 VsSaros 会话才有「继续/结束」：影子会话没有上游实体，操作会失败。
      // 已归档的会话不再给「结束」（它就是归档态），保留「继续」以便重新激活。
      var actions = s.real
        ? '<div class="session-actions">'
        + '<button class="ghost small session-send" type="button">继续</button>'
        + (s.archived ? '' : '<button class="ghost small session-archive" type="button">结束</button>')
        + '</div>'
        : '';
      return '<div class="session" data-id="' + esc(s.id) + '" data-real="' + (s.real ? '1' : '') + '"'
        + (s.archived ? ' data-archived="1"' : '') + '>'
        + '<div class="session-top">'
        + '<div class="session-title">' + esc(s.title) + '</div>'
        + '<span class="badge ' + esc(s.status) + '">' + esc(statusLabel(s.status)) + '</span>'
        + '</div>'
        + '<div class="session-meta">' + esc(meta) + '</div>'
        + (s.preview ? '<div class="session-preview">' + esc(s.preview) + '</div>' : '')
        + actions
        + '</div>';
    }).join('');
  }

  /** 向真实 Agent 会话发一条消息（需上游开启 allowAgentControl）。 */
  async function sendToSession(id) {
    var text = window.prompt('发给这个 Agent 会话：');
    if (!text || !text.trim()) return;
    try {
      await rpc('sessions.send', { id: id, text: text.trim() });
      toast('已发送');
      loadSessions();
    } catch (err) {
      toast(err.message);
    }
  }

  /** 结束（归档）一个真实 Agent 会话。 */
  async function archiveSession(id) {
    if (!window.confirm('结束这个 Agent 会话？（归档，可在 VsSaros 里恢复）')) return;
    try {
      await rpc('sessions.archive', { id: id });
      toast('已结束');
      loadSessions();
    } catch (err) {
      toast(err.message);
    }
  }

  async function loadSessions() {
    if (!el.sessionList) return;
    try {
      // 「已归档」是单独的视图（VsSaros 的归档 = Pocket 的「结束」，默认收起）
      var query = state.sessionFilter === 'archived'
        ? { archived: true, limit: 200 }
        : { status: state.sessionFilter === 'all' ? undefined : state.sessionFilter, limit: 200 };
      var out = await rpc('sessions.list', query);
      state.sessions = out.sessions || [];
      state.archivedCount = typeof out.archivedCount === 'number' ? out.archivedCount : 0;
      state.sessionSource = out.source || '';
      state.sessionDiag = out.diag || null;
    } catch (err) {
      state.sessions = [];
      if (el.sessionList) el.sessionList.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      return;
    }
    renderArchivedChip();
    renderSessionDiag();
    renderSessions();
  }

  /**
   * 会话桥诊断提示：命令不可用时在列表上方留一行（**即使列表有内容也显示** ——
   * 那种情况下用户看到的是"只有 Pocket 自己记的会话"，同样需要知道原因）。
   */
  function renderSessionDiag() {
    if (!el.sessionDiag) return;
    var d = state.sessionDiag;
    var degraded = d && d.ok === false;
    // providers 是**明确的空数组**（不是 null —— null 表示老版上游没给这个字段，不能当 0 个）：
    // 桥是通的，但 VsSaros 一个会话 provider 都没注册 ⇒ 列表不可能有内容，开多少会话都没用。
    var noProvider = d && d.ok === true && Array.isArray(d.providers) && d.providers.length === 0;
    if (!degraded && !noProvider) {
      el.sessionDiag.classList.add('hidden');
      el.sessionDiag.textContent = '';
      return;
    }
    el.sessionDiag.textContent = degraded
      ? ('VsSaros 会话桥不可用：' + (d.error || '未知原因') + '（列表可能只显示 Pocket 自己记录的会话）')
      : ('VsSaros 没有注册任何会话 provider（' + (d.mode ? '工作台形态：' + d.mode : '形态未知')
        + '）⇒ 会话列表一定是空的。请确认 chat.agentHost.enabled / sessions.agentStudio.enabled 已开启。');
    el.sessionDiag.classList.remove('hidden');
  }

  /** 「已归档」芯片：只有真的存在归档会话时才出现（点进去空的入口比没有更糟）。 */
  function renderArchivedChip() {
    if (!el.sessionChips) return;
    var chip = el.sessionChips.querySelector('[data-status="archived"]');
    if (!chip) return;
    var has = (state.archivedCount || 0) > 0;
    chip.classList.toggle('hidden', !has);
    chip.textContent = has ? '已归档 ' + state.archivedCount : '已归档';
    // 停在归档视图里、但它已经空了 → 退回「全部」，避免看起来像"空了/坏了"
    if (!has && state.sessionFilter === 'archived') {
      state.sessionFilter = 'all';
      var all = el.sessionChips.querySelector('[data-status="all"]');
      Array.prototype.forEach.call(el.sessionChips.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('active', c === all);
      });
      loadSessions().catch(function () { /* 下一次刷新会自愈 */ });
    }
  }

  /** 点会话 → 切到「当前会话」页并聚焦它。 */
  function openSession(id) {
    state.activeSessionId = id;
    switchTab('chat');
  }

  // ---------- 交互绑定 ----------
  function switchTab(name) {
    state.tab = name;
    ['inbox', 'chat', 'screen', 'changes', 'status', 'files'].forEach(function (t) {
      var node = document.getElementById('view-' + t);
      if (node) node.classList.toggle('hidden', t !== name);
    });
    if (name !== 'screen') stopScreen();
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (name === 'inbox') loadSessions().catch(function (e) { toast(e.message); });
    if (name === 'files' && !el.entries.childElementCount) loadDir('').catch(function (e) { toast(e.message); });
    if (name === 'status') { loadStatus(); renderEvents(); }
    // 聊天页首次进入时拉一次上下文（Agent / 工作区 / worktree / 可用模式）
    if (name === 'chat' && !state.chatContextLoaded) {
      state.chatContextLoaded = true;
      loadChatContext().catch(function () { /* 头部会显示降级提示 */ });
    }
    if (name === 'changes') loadChanges().catch(function (e) { toast(e.message); });
    if (name === 'screen') startScreen().catch(function (e) { if (el.screenStatus) el.screenStatus.textContent = e.message; });
  }

  // ---------- 屏幕：远程看 VsSaros.exe 的 UI ----------
  // 画面走 MJPEG（<img> 直接渲染 multipart/x-mixed-replace）；
  // 个别浏览器不支持 multipart 时自动降级为「按帧拉 screen.jpg + blob」的轮询。
  // 观看端「愿意发键鼠」的偏好：**默认开**（用户要求：打开就能远程操控），
  // 但用户亲手关掉后要**记住**（localStorage）—— 默认开不等于"每次偷偷打开"。
  // ★ 必须定义在 screenState **之前**：`var` 不会提升赋值，写在后面的话
  //   `readInputOptIn()` 里的键名会是 undefined，读到 null ⇒ 永远回默认开（真被这个坑到过）。
  var INPUT_OPTIN_KEY = 'sarosPocket.screenInputOptIn';
  function readInputOptIn() {
    try { var v = localStorage.getItem(INPUT_OPTIN_KEY); return v === null ? true : v === '1'; } catch (e) { return true; }
  }
  function writeInputOptIn(on) {
    try { localStorage.setItem(INPUT_OPTIN_KEY, on ? '1' : '0'); } catch (e) { /* 隐私模式等：忽略 */ }
  }

  var screenState = {
    mode: 'window', fps: 4, scale: 0.5,
    loaded: false, polling: false, lastBlob: null,
    loadTimer: null, pollTimer: null, statusTimer: null,
    // 远程操作分两层，别混：
    //   inputSupported 主机端**能不能**转发键鼠（仅 Windows）
    //   inputAllowed   主机端**是否允许**（sarosPocket.allowDesktopInput，电脑上改，默认已开）
    //   inputOptIn     本机（这台手机）**是否愿意**发键鼠 —— **默认开**，但用户关掉后要记住
    // ★ 旧实现把「主机已允许」直接当成开关的选中态、并用它决定 disabled，
    //   于是主机没允许时开关既点不动、也不说为什么（用户反馈「远程操作无法开启」）。
    inputSupported: false, inputAllowed: false, inputOptIn: readInputOptIn(),
    supported: false, pseudoFull: false,
    lastFrames: 0, lastFramesAt: 0, fps: '',
  };

  /** 当前是否真的会把键鼠发到电脑：主机允许 + 本机已开启。 */
  function inputActive() {
    return screenState.inputAllowed === true && screenState.inputOptIn === true;
  }

  /** 同步远程操作区的可用态与说明文字（主机未允许时给出「去哪开」的可操作指引）。 */
  function updateScreenInputUI() {
    var allowed = screenState.inputAllowed === true;
    if (el.screenInputOn) {
      el.screenInputOn.disabled = !allowed;
      el.screenInputOn.checked = allowed && screenState.inputOptIn === true;
    }
    // ★ 「远程操作中」必须看得见：默认开启后，用户不该在不知情时把键鼠发到电脑。
    //   画面上贴一个常显标识（全屏时也在），比只在设置区写一行字可靠得多。
    if (el.screenInputBadge) {
      el.screenInputBadge.classList.toggle('hidden', !inputActive());
    }
    if (!el.screenInputNote) return;
    if (!allowed) {
      el.screenInputNote.textContent = '电脑端还没允许远程操作：在 VsSaros 的插件页 → 桌面画面 → 打开「Allow Desktop Input」，然后点「重新检测」。';
      el.screenInputNote.className = 'screen-inputnote warn';
    } else if (screenState.inputOptIn) {
      el.screenInputNote.textContent = '已开启（默认）：点击 / 滚轮 / 键盘会发到电脑，画面左上角有「远程操作中」。不需要时关掉这个开关。';
      el.screenInputNote.className = 'screen-inputnote';
    } else {
      el.screenInputNote.textContent = '已按你的设置关闭。打开上面的开关后，点击 / 滚轮 / 键盘才会发到电脑。';
      el.screenInputNote.className = 'screen-inputnote';
    }
  }

  function setScreenHint(text) {
    if (el.screenStatus) el.screenStatus.textContent = text;
  }

  function stopScreen() {
    if (isScreenFull()) exitScreenFull();
    if (screenState.loadTimer) { clearTimeout(screenState.loadTimer); screenState.loadTimer = null; }
    if (screenState.pollTimer) { clearTimeout(screenState.pollTimer); screenState.pollTimer = null; }
    if (screenState.statusTimer) { clearInterval(screenState.statusTimer); screenState.statusTimer = null; }
    screenState.polling = false;
    screenState.loaded = false;
    if (el.screenImg) {
      el.screenImg.onload = null;
      el.screenImg.onerror = null;
      // 断开 MJPEG：清空 src 才会让服务端收到 close（否则采集进程一直跑）
      el.screenImg.src = '';
      try { el.screenImg.removeAttribute('src'); } catch (e) { /* 忽略 */ }
    }
    if (screenState.lastBlob) { URL.revokeObjectURL(screenState.lastBlob); screenState.lastBlob = null; }
  }

  function startMjpeg() {
    screenState.loaded = false;
    if (el.screenImg) {
      el.screenImg.onload = function () { screenState.loaded = true; };
      el.screenImg.onerror = function () { if (!screenState.loaded) startPolling(); };
      el.screenImg.src = abs('/saros-pocket/screen.mjpeg') + '?t=' + Date.now();
    }
    // 5 秒内没收到首帧（Safari/部分 WebView 不支持 multipart）→ 降级轮询
    screenState.loadTimer = setTimeout(function () {
      if (!screenState.loaded) startPolling();
    }, 5000);
  }

  async function startPolling() {
    if (screenState.polling) return;
    screenState.polling = true;
    setScreenHint('轮询模式（浏览器不支持 MJPEG）');
    var tick = async function () {
      if (!screenState.polling) return;
      try {
        var res = await fetch(abs('/saros-pocket/screen.jpg') + '?t=' + Date.now(), {
          credentials: BASE ? 'include' : 'same-origin',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        if (screenState.lastBlob) URL.revokeObjectURL(screenState.lastBlob);
        screenState.lastBlob = url;
        if (el.screenImg) el.screenImg.src = url;
      } catch (err) {
        setScreenHint('取帧失败：' + err.message);
      }
      if (screenState.polling) {
        screenState.pollTimer = setTimeout(tick, Math.max(120, Math.round(1000 / screenState.fps)));
      }
    };
    await tick();
  }

  async function refreshScreenStatus() {
    try {
      var st = await rpc('desktop.status', {});
      screenState.supported = st.supported === true;
      screenState.inputSupported = st.inputSupported === true;
      // 主机端允许与否（每 4s 刷新 ⇒ 电脑上改完设置，手机上最多 4s 就能打开开关）
      screenState.inputAllowed = st.inputAllowed === true;
      if (el.screenInputBar) el.screenInputBar.classList.toggle('hidden', !screenState.inputSupported);
      updateScreenInputUI();
      // 实测帧率：用服务端累计帧数做差（客户端数不了 MJPEG 的帧）
      if (typeof st.frames === 'number') {
        var now = Date.now();
        if (screenState.lastFramesAt) {
          var dt = (now - screenState.lastFramesAt) / 1000;
          var df = st.frames - screenState.lastFrames;
          if (dt > 0.8 && df >= 0) screenState.fps = (df / dt).toFixed(1) + ' fps';
        }
        screenState.lastFrames = st.frames;
        screenState.lastFramesAt = now;
      }
      var rect = st.rect ? (st.rect.width + '×' + st.rect.height) : '—';
      var rate = screenState.fps && st.lastFrameBytes
        ? ' · ' + Math.round(st.lastFrameBytes * parseFloat(screenState.fps) / 1024) + ' KB/s'
        : '';
      setScreenHint([
        st.supported ? '' : '当前平台不支持屏幕采集',
        st.backend || '',
        st.running ? '采集中' : '空闲',
        screenState.fps + rate,
        '区域 ' + rect,
        st.clients ? '观看 ' + st.clients : '',
        st.lastError ? '⚠ ' + st.lastError : '',
      ].filter(Boolean).join(' · ') || '—');
    } catch (err) {
      setScreenHint(err.message);
    }
  }

  async function startScreen() {
    if (!el.screenImg) return;
    await refreshScreenStatus();
    // 支持采集 → 先下发参数（含观看端宽度上限）再起流；不支持就直接试一次（服务端会给 503 文案）
    if (screenState.supported) await applyScreenConfig();
    else startMjpeg();
    fitScreenImage(); // 首帧到达前先按当前（无尺寸）算一次没关系，load 后还会再算
    if (screenState.statusTimer) clearInterval(screenState.statusTimer);
    screenState.statusTimer = setInterval(refreshScreenStatus, 4000);
  }

  /** 观看端显示宽度上限：手机屏小，别让它下载 2K 帧（省带宽也省解码）。 */
  function screenMaxWidth() {
    var w = (window.innerWidth || 480) * (window.devicePixelRatio || 1);
    return Math.max(320, Math.min(1600, Math.round(w)));
  }

  async function applyScreenConfig() {
    var patch = {
      mode: screenState.mode,
      fps: screenState.fps,
      scale: screenState.scale,
      maxWidth: screenMaxWidth(),
    };
    try {
      await rpc('desktop.config', patch);
      startMjpeg();
    } catch (err) {
      toast(err.message);
    }
  }

  /**
   * 把画面**铺满**可用区域（保持比例，只在比例不一致的那一侧留黑边）。
   *
   * 为什么必须自己算尺寸：`object-fit` 只在「盒子尺寸 ≠ 图片自身尺寸」时才起作用 ——
   * 早先样式里只写了 `max-width/max-height:100%` + `object-fit:contain`，盒子等于图片的像素尺寸，
   * 于是画面按**帧的像素 1:1** 显示：帧分辨率 = 观看端宽度 × 质量系数（默认 0.5），
   * 桌面浏览器（DPR=1）下就正好是半宽 ⇒ 全屏后画面只占中间一小块、四周全黑（用户报的「没有真正全屏」）。
   *
   * 显示尺寸与传输分辨率因此**解耦**：这里只决定「画多大」，帧分辨率仍由「质量」下拉决定（省流量）。
   * 注意：尺寸直接写在 `img` 盒子上（不用 transform / 不用 letterbox），点击坐标换算才能继续用盒子矩形。
   */
  function fitScreenImage() {
    var wrap = el.screenWrap, img = el.screenImg;
    if (!wrap || !img) return;
    var nw = img.naturalWidth || 0, nh = img.naturalHeight || 0;
    if (!nw || !nh) return;                       // 还没有首帧，无从计算
    var availW = wrap.clientWidth, availH = wrap.clientHeight;
    if (!availW || !availH) return;               // 不可见（比如切到别的页签）
    var scale = Math.min(availW / nw, availH / nh);
    var w = Math.max(1, Math.round(nw * scale));
    var h = Math.max(1, Math.round(nh * scale));
    if (img.__fitW === w && img.__fitH === h) return;  // 每帧都会触发 load，别反复写样式
    img.__fitW = w; img.__fitH = h;
    img.style.width = w + 'px';
    img.style.height = h + 'px';
  }

  /**
   * 图像上的点击/滚轮 → 归一化坐标（0~1）→ 主机侧映射回屏幕绝对坐标。
   *
   * ★ 按「**画面实际占的那块内容区**」算，而不是盒子矩形：盒子可能比画面大
   * （`max-width/max-height` 夹住、或样式兜底给了 `object-fit:contain`），
   * 那时用盒子算会把坐标算偏 —— 远程点击就点错地方。
   */
  function screenPoint(ev) {
    var img = el.screenImg;
    var r = img.getBoundingClientRect();
    var nw = img.naturalWidth || r.width, nh = img.naturalHeight || r.height;
    var s = Math.min(r.width / nw, r.height / nh);   // object-fit: contain
    var w = nw * s, h = nh * s;
    var left = r.left + (r.width - w) / 2, top = r.top + (r.height - h) / 2;
    return {
      x: Math.min(1, Math.max(0, (ev.clientX - left) / w)),
      y: Math.min(1, Math.max(0, (ev.clientY - top) / h)),
    };
  }

  async function sendDesktopInput(action) {
    try {
      await rpc('desktop.input', action);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- 全屏 ----------
  // 为什么需要两条路：桌面浏览器有 Fullscreen API，但**原生壳（Capacitor WebView）**
  // 与 iOS Safari 对「普通元素」全屏要么不支持、要么 `requestFullscreen()` 存在却什么都不做
  // （Android WebView 需要宿主实现 onShowCustomView；iOS 只支持 video 元素）。
  // 旧实现只调 API、且没有失败兜底 ⇒ 手机上点「全屏」毫无反应（用户反馈）。
  // 现在：先试 API，**用 document.fullscreenElement 校验是否真的生效**，没生效就退回
  // 「CSS 伪全屏」（把画面区 position:fixed 铺满 + 右上角「退出全屏」）。
  function isScreenFull() {
    var doc = document;
    return !!(doc.fullscreenElement === el.screenWrap || doc.webkitFullscreenElement === el.screenWrap)
      || screenState.pseudoFull === true;
  }

  /** 原生壳里顺手收起系统状态栏（没有 Capacitor 就静默跳过，不影响网页端）。 */
  function hideNativeStatusBar(hide) {
    try {
      var plugins = window.Capacitor && window.Capacitor.Plugins;
      var sb = plugins && plugins.StatusBar;
      if (sb && typeof sb.hide === 'function' && typeof sb.show === 'function') {
        (hide ? sb.hide() : sb.show()).catch(function () { /* 忽略 */ });
      }
    } catch (e) { /* 忽略 */ }
  }

  function setPseudoFull(on) {
    screenState.pseudoFull = on === true;
    if (el.screenWrap) el.screenWrap.classList.toggle('pseudo-fullscreen', screenState.pseudoFull);
    hideNativeStatusBar(screenState.pseudoFull);
    updateFullUI();
    // 可用区域变了（铺满整个视口）⇒ 重算画面尺寸，下一帧再算（等布局落定）
    requestAnimationFrame(fitScreenImage);
  }

  function updateFullUI() {
    var on = isScreenFull();
    if (el.screenFull) el.screenFull.textContent = on ? '退出全屏' : '全屏';
    if (el.screenExit) el.screenExit.classList.toggle('hidden', !on);
  }

  /** API 调了但没生效（WebView 常见）→ 退回伪全屏。 */
  function verifyFullscreen() {
    if (screenState.pseudoFull) return;
    if (document.fullscreenElement !== el.screenWrap && document.webkitFullscreenElement !== el.screenWrap) {
      setPseudoFull(true);
    } else {
      updateFullUI();
    }
  }

  function exitScreenFull() {
    if (screenState.pseudoFull) { setPseudoFull(false); return; }
    var doc = document;
    var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (isScreenFull() && exit) {
      try { exit.call(doc); } catch (e) { /* 忽略 */ }
    }
    updateFullUI();
  }

  function toggleScreenFull() {
    var node = el.screenWrap;
    if (!node) return;
    if (isScreenFull()) { exitScreenFull(); return; }
    var req = node.requestFullscreen || node.webkitRequestFullscreen;
    if (!req) { setPseudoFull(true); return; }
    try {
      var p = req.call(node, { navigationUI: 'hide' });
      if (p && typeof p.then === 'function') {
        p.then(function () { setTimeout(verifyFullscreen, 80); }, function () { setPseudoFull(true); });
      } else {
        setTimeout(verifyFullscreen, 150);
      }
    } catch (e) {
      setPseudoFull(true);
    }
  }

  function onFullscreenChange() {
    updateFullUI();
    // 进/退全屏后可用区域变化 ⇒ 画面要重新铺满（真全屏由浏览器改布局，会晚一拍）
    requestAnimationFrame(fitScreenImage);
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  // 伪全屏下没有浏览器的 Esc 退出，自己接一下（真全屏由浏览器处理）
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && screenState.pseudoFull) exitScreenFull();
  });

  /** 变更页：文件清单 + 按需展开的 diff 文本（files.diff 驱动）。 */
  var changesState = { files: [], source: '', repoRoot: '' };

  async function loadChanges() {
    if (!el.changes) return;
    el.changes.innerHTML = '<div class="empty">正在读取变更…</div>';
    try {
      var out = await rpc('files.diff', {});
      changesState = {
        files: out.files || [],
        source: out.source || '',
        repoRoot: out.repoRoot || '',
      };
    } catch (err) {
      changesState = { files: [], source: '', repoRoot: '' };
      el.changes.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      return;
    }
    renderChanges();
  }

  function renderChanges() {
    if (!el.changes) return;
    var files = changesState.files;
    if (!files.length) {
      el.changes.innerHTML = '<div class="empty">没有未提交的变更。</div>';
      if (el.changesTitle) el.changesTitle.textContent = '变更';
      return;
    }
    if (el.changesTitle) {
      el.changesTitle.textContent = '变更 · ' + files.length + ' 个文件'
        + (changesState.source === 'git-cli' ? '（git CLI）' : '');
    }
    el.changes.innerHTML = files.map(function (f) {
      var stat = (f.insertions || f.deletions)
        ? '<span class="diff-stat"><i>+' + f.insertions + '</i><b>-' + f.deletions + '</b></span>'
        : '';
      return '<div class="change" data-path="' + esc(f.path) + '" data-abs="' + esc(f.abs || '') + '">'
        + '<button class="change-head" type="button">'
        + '<span class="change-badge' + (f.staged ? ' staged' : '') + '">' + esc(f.status) + '</span>'
        + '<span class="change-path">' + esc(f.path) + '</span>'
        + stat
        + '</button>'
        + '<div class="change-actions">'
        + '<button class="ghost small change-open" type="button">在编辑器打开</button>'
        + '</div>'
        + '<pre class="diff hidden"></pre>'
        + '</div>';
    }).join('');
  }

  /** 在 VsSaros 编辑器里打开该变更文件。 */
  async function openChangeInEditor(node) {
    // 优先用绝对路径：变更清单按 repoRoot 取相对路径，而 editor.open 以 fileRoot
    // 为基准，两者在多根工作区/子目录仓库下并不一致。
    var target = node.dataset.abs || node.dataset.path;
    if (!target) return;
    try {
      await rpc('editor.open', { path: target });
      toast('已在 VsSaros 打开');
    } catch (err) {
      toast(err.message);
    }
  }

  /** 展开/收起单个文件的 diff：首次点开时才拉取，避免一次拉满。 */
  async function toggleDiff(node) {
    var pre = node.querySelector('.diff');
    if (!pre) return;
    if (!pre.classList.contains('hidden')) {
      pre.classList.add('hidden');
      pre.textContent = '';
      node.classList.remove('expanded');
      return;
    }
    var path = node.dataset.path;
    pre.classList.remove('hidden');
    node.classList.add('expanded');
    pre.textContent = '加载 diff…';
    try {
      var out = await rpc('files.diff', { path: path });
      pre.textContent = out.diff || '（无差异文本：可能是新增/二进制文件）';
    } catch (err) {
      pre.textContent = '读取失败：' + err.message;
    }
  }

  el.send.addEventListener('click', function () { sendToChat(); });
  el.toAgent.addEventListener('click', function () { sendToAgent(); });
  el.clearChat.addEventListener('click', function () {
    state.history = [];
    el.messages.innerHTML = '';
    addMsg('system', '对话已清空（VsSaros 侧的会话不受影响）');
  });
  el.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey) && !e.isComposing) {
      e.preventDefault();
      sendToChat();
    }
  });
  el.input.addEventListener('input', function () {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
  });
  el.modelSelect.addEventListener('change', function () {
    state.modelId = el.modelSelect.value;
    renderChatCtxHint();
  });

  // 聊天上下文头部：改选即写回 VsSaros（切工作区 / 写 worktree 绑定），摘要行同步刷新
  if (el.chatAgent) {
    el.chatAgent.addEventListener('change', function () {
      state.chatContext.agentId = el.chatAgent.value;
      renderChatCtxHint();
      pushChatContext();
    });
  }
  if (el.chatWorkspace) {
    el.chatWorkspace.addEventListener('change', function () {
      state.chatContext.workspaceId = el.chatWorkspace.value;
      // 换工作区后 worktree 列表会变 ⇒ 退回主仓库，等下次拉上下文时再给新列表
      state.chatContext.worktreePath = '';
      if (el.chatWorktree) el.chatWorktree.value = '';
      renderChatCtxHint();
      pushChatContext();
      loadChatContext().catch(function () { /* 保持现状 */ });
    });
  }
  if (el.chatWorktree) {
    el.chatWorktree.addEventListener('change', function () {
      state.chatContext.worktreePath = el.chatWorktree.value;
      renderChatCtxHint();
      pushChatContext();
    });
  }
  if (el.chatModes) {
    el.chatModes.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chat-mode') : null;
      if (!btn || !btn.dataset.mode) return;
      state.chatMode = btn.dataset.mode;
      renderChatModes();
      renderChatCtxHint();
    });
  }

  el.entries.addEventListener('click', function (e) {
    var node = e.target.closest ? e.target.closest('.entry') : null;
    if (!node) return;
    var name = node.dataset.name;
    if (node.dataset.dir === '1') {
      loadDir(state.path ? state.path + '/' + name : name).catch(function (err) { toast(err.message); });
    } else {
      openFile(name).catch(function (err) { toast(err.message); });
    }
  });
  el.upDir.addEventListener('click', function () {
    var parts = state.path.split('/').filter(Boolean);
    parts.pop();
    loadDir(parts.join('/')).catch(function (e) { toast(e.message); });
  });
  el.reloadFiles.addEventListener('click', function () {
    loadDir(state.path).catch(function (e) { toast(e.message); });
  });
  el.closeFile.addEventListener('click', function () { el.fileView.classList.add('hidden'); });
  el.openInEditor.addEventListener('click', function () {
    if (!state.filePath) return;
    rpc('editor.open', { path: state.filePath })
      .then(function () { toast('已在 VsSaros 打开'); })
      .catch(function (e) { toast(e.message); });
  });
  el.clearEvents.addEventListener('click', function () { state.events = []; renderEvents(); });

  // 屏幕页交互：参数变更 → 重启画面流；点击/滚轮/按键 → 归一化坐标转发
  if (el.screenMode) {
    el.screenMode.addEventListener('change', function () {
      screenState.mode = el.screenMode.value === 'screen' ? 'screen' : 'window';
      applyScreenConfig();
    });
    el.screenFps.addEventListener('change', function () {
      screenState.fps = Number(el.screenFps.value) || 4;
      applyScreenConfig();
    });
    el.screenScale.addEventListener('change', function () {
      screenState.scale = Number(el.screenScale.value) || 0.5;
      applyScreenConfig();
    });
    el.screenReload.addEventListener('click', function () {
      stopScreen();
      startScreen().catch(function (err) { setScreenHint(err.message); });
    });
    el.screenShot.addEventListener('click', async function () {
      try {
        var res = await fetch(abs('/saros-pocket/screen.jpg') + '?t=' + Date.now(), {
          credentials: BASE ? 'include' : 'same-origin',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var url = URL.createObjectURL(await res.blob());
        var a = document.createElement('a');
        a.href = url;
        a.download = 'saros-pocket-' + Date.now() + '.jpg';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        toast('截图已保存');
      } catch (err) {
        toast(err.message);
      }
    });
    el.screenImg.addEventListener('click', function (ev) {
      if (!inputActive()) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'click', x: p.x, y: p.y });
    });
    el.screenImg.addEventListener('wheel', function (ev) {
      if (!inputActive()) return;
      ev.preventDefault();
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'wheel', x: p.x, y: p.y, delta: ev.deltaY > 0 ? -120 : 120 });
    }, { passive: false });
    el.screenImg.addEventListener('dblclick', function (ev) {
      if (!inputActive()) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'dblclick', x: p.x, y: p.y });
    });
    // 长按/右键：手机上没有右键，用 contextmenu（长按即可触发）
    el.screenImg.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (!inputActive()) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'click', x: p.x, y: p.y, button: 'right' });
    });
    el.screenFull.addEventListener('click', function () { toggleScreenFull(); });
    if (el.screenExit) el.screenExit.addEventListener('click', function () { exitScreenFull(); });
    // 画面铺满：首帧到达（MJPEG 与轮询两种取帧方式都会触发 load）、窗口/方向变化时重算
    // （不重算就会按帧的像素 1:1 显示 —— 全屏后画面只占中间一小块，见 fitScreenImage 注释）
    el.screenImg.addEventListener('load', fitScreenImage);
    window.addEventListener('resize', fitScreenImage);
    window.addEventListener('orientationchange', function () { setTimeout(fitScreenImage, 120); });
    if (el.screenInputRecheck) {
      el.screenInputRecheck.addEventListener('click', function () {
        toast('重新检测…');
        refreshScreenStatus().then(function () {
          toast(screenState.inputAllowed ? '电脑端已允许远程操作' : '电脑端仍未允许');
        });
      });
    }
    Array.prototype.forEach.call(el.screenInputBar.querySelectorAll('[data-key]'), function (b) {
      b.addEventListener('click', function () { sendDesktopInput({ type: 'key', key: b.dataset.key }); });
    });
    el.screenText.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.isComposing) return;
      var text = el.screenText.value;
      if (!text) return;
      el.screenText.value = '';
      sendDesktopInput({ type: 'text', text: text });
    });
    el.screenInputOn.addEventListener('change', function () {
      // 主机没允许 → 开关不可用，直接说明原因（不要静默把用户的操作吞掉）
      if (el.screenInputOn.checked && screenState.inputAllowed !== true) {
        screenState.inputOptIn = false;
        updateScreenInputUI();
        toast('电脑端还没允许远程操作，请先在 VsSaros 插件页打开 Allow Desktop Input');
        return;
      }
      screenState.inputOptIn = el.screenInputOn.checked === true;
      if (screenState.inputOptIn && screenState.inputSupported !== true) {
        screenState.inputOptIn = false;
        toast('主机端不支持桌面输入（仅 Windows）');
      }
      writeInputOptIn(screenState.inputOptIn); // 记住用户的选择（默认开，但关掉就别再自动打开）
      updateScreenInputUI();
    });
    updateScreenInputUI();
  }

  // 收件箱交互
  if (el.sessionChips) {
    el.sessionChips.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.chip') : null;
      if (!chip) return;
      state.sessionFilter = chip.dataset.status || 'all';
      Array.prototype.forEach.call(el.sessionChips.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('active', c === chip);
      });
      loadSessions().catch(function (err) { toast(err.message); });
    });
  }
  if (el.sessionList) {
    el.sessionList.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('.session') : null;
      if (!node || !node.dataset.id) return;
      // 「继续/结束」是写操作，先处理并阻止冒泡，避免顺带切页
      if (e.target.closest('.session-send')) {
        sendToSession(node.dataset.id);
        return;
      }
      if (e.target.closest('.session-archive')) {
        archiveSession(node.dataset.id);
        return;
      }
      openSession(node.dataset.id);
    });
  }
  if (el.reloadSessions) {
    el.reloadSessions.addEventListener('click', function () {
      loadSessions().catch(function (err) { toast(err.message); });
    });
  }
  // 「文件」降级为收件箱页的次级入口：不在底部导航占位置，但原有浏览能力不丢
  if (el.browseFiles) {
    el.browseFiles.addEventListener('click', function () { switchTab('files'); });
  }
  if (el.reloadChanges) {
    el.reloadChanges.addEventListener('click', function () {
      loadChanges().catch(function (err) { toast(err.message); });
    });
  }
  if (el.changes) {
    el.changes.addEventListener('click', function (e) {
      var node = e.target.closest ? e.target.closest('.change') : null;
      if (!node) return;
      if (e.target.closest('.change-open')) {
        openChangeInEditor(node);
        return;
      }
      toggleDiff(node).catch(function (err) { toast(err.message); });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () { switchTab(b.dataset.view); });
  });

  // ---------- 配对（原生壳专用） ----------
  // 浏览器内由代理同源托管，BASE 恒为空 → 下面整段不生效，行为与原来完全一致。
  // 原生壳里若还没配对（localStorage 无 baseUrl），先显示配对页，否则会
  // 对着 capacitor://localhost 发请求、永远连不上而且没有任何提示。
  var PAIR_KEY = 'saros.pocket.baseUrl';

  function normalizeBase(raw) {
    var s = String(raw || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s;
  }

  function showPairing() {
    document.body.innerHTML =
      '<div class="card" style="padding:24px;max-width:420px;margin:14vh auto;font:14px/1.7 system-ui">' +
      '<h1 style="font-size:18px;margin:0 0 10px">先连接一台电脑</h1>' +
      '<p style="color:#6b7280;margin:0 0 14px">在电脑上打开 VsSaros，运行命令 ' +
      '<b>Saros Pocket: 打开访问面板</b>，用本页扫描其中的二维码，或手动填入地址。</p>' +
      '<input id="pairUrl" placeholder="http://192.168.1.9:3081" ' +
      'style="width:100%;padding:10px;border:1px solid #2a2f3a;border-radius:8px;background:#0f1115;color:#e6e8ec">' +
      '<button id="pairGo" style="margin-top:10px;width:100%;padding:10px;background:#4f6ef7;color:#fff;' +
      'border:0;border-radius:8px;font-size:14px">连接</button>' +
      '<p id="pairErr" style="color:#ef4444;margin:10px 0 0;min-height:1.2em"></p>' +
      // App 升级入口：**未配对时也要能升级**。否则刚装好的用户会被"看不到升级入口"卡住 ——
      // 升级卡片在「状态」页，而没配对时显示的是这一页（真机/模拟器实测发现的缺口）。
      '<div id="pairUpd" style="margin-top:16px;padding-top:12px;border-top:1px solid #2a2f3a;' +
      'color:#9ca3af;font-size:13px">' +
      '<span id="pairUpdText">App 升级：准备中…</span>' +
      '<button id="pairUpdBtn" style="display:none;margin-top:8px;width:100%;padding:9px;background:#374151;' +
      'color:#fff;border:0;border-radius:8px;font-size:13px">下载并安装</button></div></div>';
    var input = document.getElementById('pairUrl');
    var err = document.getElementById('pairErr');
    document.getElementById('pairGo').addEventListener('click', function () {
      var base = normalizeBase(input.value);
      if (!base) { err.textContent = '请填入地址'; return; }
      err.textContent = '正在验证…';
      // 用一个只读 endpoint 验证：能拿到 status 说明地址与 PIN 都通过。
      fetch(base + '/saros-pocket/rpc/pocket.status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: {} }), credentials: 'include',
      }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function (b) { return b && b.ok ? b : Promise.reject(new Error('未通过')); })
        .then(function () {
          try { localStorage.setItem(PAIR_KEY, base); } catch (e) { /* 忽略 */ }
          location.reload();
        })
        .catch(function () { err.textContent = '连不上：确认电脑已开启 Pocket，且 PIN 已输入（首次访问会要求密码）'; });
    });
    // 升级入口（未配对也能用）：把当前状态画上去 + 绑按钮
    renderPairUpdate();
    bindPairUpdate();
  }

  // ---------- App 自升级（原生壳专用） ----------
  //
  // 链路：JS 取版本清单 → 比 versionCode → **原生**下载（边下边算 SHA-256）→ 唤起系统安装器。
  // 为什么装包必须原生：WebView 既拿不到文件系统路径，也无法触发系统安装器（Android 8+ 还要
  // 先给「允许安装未知应用」授权）。原生实现在
  // mobile/android-overlay/.../PocketUpdaterPlugin.java（由 scripts/apply-android-overlay.mjs 注入到现场生成的工程）。
  //
  // 两个刻意的设计：
  //   1. **升级与「配对电脑」无关**：清单走一个独立 URL（流水线产物 update.json），
  //      没配对、电脑关机、换了电脑都能升级。
  //   2. 浏览器里没有这个插件 ⇒ 整块卡片保持 hidden，网页版行为完全不变。
  var UPDATE_SRC_KEY = 'saros.pocket.updateUrl';
  var UPDATE_AUTO_KEY = 'saros.pocket.updateAuto';
  var UPDATE_AUTO_INTERVAL = 6 * 60 * 60 * 1000;
  var update = {
    plugin: null,
    appVersion: '',
    appBuild: 0,
    latest: null,
    /** idle（待检查）|checking|uptodate|available|downloading|needGrant|installing|error */
    phase: 'idle',
    percent: null,
    received: 0,
    total: 0,
    error: '',
    listener: null,
    timer: null,
  };

  /** 升级源地址：App 内填的（localStorage）优先，其次构建期注入的默认值。 */
  function updateSource() {
    var injected = (boot.updateUrl || '').trim();
    try {
      var own = (localStorage.getItem(UPDATE_SRC_KEY) || '').trim();
      return own || injected;
    } catch (e) {
      return injected;
    }
  }

  function autoCheckOn() {
    try {
      var v = localStorage.getItem(UPDATE_AUTO_KEY);
      return v === null ? true : v === '1';
    } catch (e) {
      return true;
    }
  }

  /**
   * 清单必须自证完备才采用：**缺 sha256 就不下**（升级包被替换是最危险的一类失败）。
   * 版本比较只看 versionCode —— Android 的单调整数，versionName 只是给人看的。
   */
  function isValidManifest(m) {
    if (!m || typeof m !== 'object') return false;
    var code = Number(m.versionCode);
    if (!isFinite(code) || code <= 0) return false;
    if (typeof m.url !== 'string' || !/^https?:\/\//i.test(m.url)) return false;
    if (typeof m.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(m.sha256)) return false;
    return true;
  }

  function updateNotesHtml(m) {
    if (!m || !m.notes || !m.notes.length) return '';
    var items = m.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    return '<div class="update-notes">更新说明：<ul>' + items + '</ul></div>';
  }

  function renderUpdate() {
    if (!el.updateWrap) return;
    var m = update.latest;
    var cur = '当前 App：v' + (update.appVersion || '?') + '（build ' + update.appBuild + '）';
    var text;
    switch (update.phase) {
      case 'checking':
        text = '正在检查更新…';
        break;
      case 'uptodate':
        text = '已是最新（v' + (m ? m.versionName : '') + '）';
        break;
      case 'available':
        text = '发现新版本 v' + (m ? m.versionName : '') + '（build ' + (m ? m.versionCode : '') + '）';
        break;
      case 'downloading':
        text = '下载中 ' + (update.percent == null ? fmtBytes(update.received) : update.percent + '%')
          + (update.total ? '（' + fmtBytes(update.received) + ' / ' + fmtBytes(update.total) + '）' : '');
        break;
      case 'needGrant':
        text = '需要先允许「安装未知应用」，点「去授权」打开设置后返回再安装';
        break;
      case 'installing':
        text = '已唤起系统安装器 —— 按提示完成安装（本页会自动关闭）';
        break;
      case 'error':
        text = '失败：' + (update.error || '未知错误');
        break;
      default:
        text = updateSource()
          ? '尚未检查（有新版本会提示）'
          : '未配置升级源 —— 展开下面「升级源」填入 update.json 地址';
    }
    el.updateState.textContent = text;
    el.updateState.className = 'v' + (update.phase === 'uptodate' ? ' on' : (update.phase === 'error' ? ' off' : ''));
    // 当前版本**常显**（不放进折叠的「升级源」里：用户最常问的就是"我现在是哪版"）
    el.updateCur.textContent = cur;

    var busy = update.phase === 'checking' || update.phase === 'downloading';
    el.updateCheck.disabled = busy;
    el.updateCheck.textContent = update.phase === 'checking' ? '检查中…' : '检查更新';
    el.updateInstall.classList.toggle('hidden', update.phase !== 'available');
    el.updateGrant.classList.toggle('hidden', update.phase !== 'needGrant');
    var bar = update.phase === 'downloading';
    el.updateBarWrap.classList.toggle('hidden', !bar);
    el.updateBar.style.width = bar ? (update.percent == null ? '5' : update.percent) + '%' : '0%';
    el.updateNotes.classList.toggle('hidden', update.phase !== 'available');
    el.updateNotes.innerHTML = update.phase === 'available' ? updateNotesHtml(m) : '';
    renderPairUpdate();
  }

  /**
   * 配对引导页上的升级入口（未配对也能升级）。
   *
   * 文案**复用**「状态」页那份：`el.updateState` 即使因为配对页替换了 body 而脱离文档，
   * 节点上的 textContent 仍是 renderUpdate 刚写进去的值 —— 省掉一份平行的状态机（两处说法才不会漂）。
   */
  function renderPairUpdate() {
    var box = document.getElementById('pairUpd');
    if (!box) return;
    if (!update.plugin) { box.style.display = 'none'; return; }
    var label = document.getElementById('pairUpdText');
    var btn = document.getElementById('pairUpdBtn');
    var state = (el.updateState && el.updateState.textContent) || '准备中…';
    // 配对页没有「升级源」折叠区 ⇒ 未配置时别照搬状态页那句"展开下面…"（用户会找不着）
    if (update.phase === 'idle' && !updateSource()) state = '未设置升级源';
    label.textContent = 'App v' + (update.appVersion || '?') + ' · ' + state;
    var show = update.phase === 'available' || update.phase === 'needGrant' || update.phase === 'downloading';
    btn.style.display = show ? 'block' : 'none';
    btn.disabled = update.phase === 'downloading';
    btn.textContent = update.phase === 'needGrant' ? '去授权'
      : (update.phase === 'downloading'
        ? ('下载中 ' + (update.percent == null ? '' : update.percent + '%'))
        : '下载并安装');
  }

  function bindPairUpdate() {
    var btn = document.getElementById('pairUpdBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // 缺授权时这一步是去系统设置（回来后 phase 回到 available，用户再点一次即安装）
      if (update.phase === 'needGrant') {
        update.plugin.openInstallSettings()
          .then(function () { update.phase = 'available'; renderUpdate(); })
          .catch(function (err) {
            update.error = (err && err.message) || '打开授权页失败';
            update.phase = 'error';
            renderUpdate();
          });
        return;
      }
      downloadAndInstall();
    });
  }

  async function checkUpdate(silent) {
    var src = updateSource();
    if (!src) {
      update.phase = 'idle';
      update.error = '';
      renderUpdate();
      if (!silent) toast('先填升级源地址（update.json）');
      return;
    }
    update.phase = 'checking';
    update.error = '';
    renderUpdate();
    try {
      var m;
      if (update.plugin.fetchText) {
        // **优先走原生**：壳内页面源是 http://localhost，而清单在别的域 ⇒ fetch 是跨源请求，
        // 静态托管方（蓝盾构件 / 内网 nginx）通常不发 CORS 头 ⇒ 浏览器会拦掉响应，
        // JS 只能看到 "Failed to fetch"（真机上实测踩到）。原生没有 CORS 概念。
        var r = await update.plugin.fetchText({ url: src });
        m = JSON.parse((r && r.body) || '');
      } else {
        // 兜底（浏览器/旧版插件）：同源或对方给了 CORS 头时同样可用
        var res = await fetch(src, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        m = await res.json();
      }
      if (!isValidManifest(m)) throw new Error('清单不完整（需要 versionCode / url / sha256）');
      update.latest = m;
      update.phase = Number(m.versionCode) > update.appBuild ? 'available' : 'uptodate';
      if (update.phase === 'available' && silent) toast('有新版本 v' + m.versionName);
    } catch (err) {
      update.phase = 'error';
      update.error = (err && err.message) || String(err);
      if (!silent) toast('检查更新失败');
    }
    renderUpdate();
  }

  /** 下载（原生，带进度事件）→ 唤起安装器；缺授权时先引导去设置。 */
  async function downloadAndInstall() {
    var m = update.latest;
    if (!m || !update.plugin) return;
    try {
      var granted = await update.plugin.canInstall();
      if (granted && granted.value === false) {
        update.phase = 'needGrant';
        renderUpdate();
        return;
      }
      if (!update.listener) {
        update.listener = await update.plugin.addListener('progress', function (p) {
          update.percent = p && p.percent != null ? p.percent : null;
          update.received = (p && p.received) || 0;
          update.total = (p && p.total) || 0;
          renderUpdate();
        });
      }
      update.phase = 'downloading';
      update.percent = 0;
      update.received = 0;
      update.total = 0;
      renderUpdate();
      var res = await update.plugin.download({
        url: m.url,
        sha256: m.sha256,
        fileName: 'saros-pocket-' + m.versionName + '.apk',
      });
      update.phase = 'installing';
      renderUpdate();
      await update.plugin.install({ path: res && res.path });
      toast('已唤起安装器');
    } catch (err) {
      update.phase = 'error';
      update.error = (err && (err.message || err.errorMessage)) || String(err);
      renderUpdate();
      toast('升级失败');
    }
  }

  /**
   * 初始化自升级（原生壳专用）。
   * 刻意在 `start()` **之外**调用：未配对时走配对引导页，也照样能升级 App。
   */
  // ---------- App 信息（点顶部 logo 弹出）----------
  /**
   * 原生壳里的「安装版本」：Capacitor `App.getInfo()` → `{version: versionName, build: versionCode}`。
   * 用 memo 化的 promise：升级卡片与这里的弹层都要，避免原生桥被重复调用。
   * 浏览器里没有 App 插件 ⇒ 直接 resolve(false)，版本号走「网页版」那条路。
   */
  var appInfoPromise = null;
  function probeAppInfo() {
    if (appInfoPromise) return appInfoPromise;
    var plugins = window.Capacitor && window.Capacitor.Plugins;
    var AppPlugin = plugins && plugins.App;
    appInfoPromise = (AppPlugin && typeof AppPlugin.getInfo === 'function')
      ? AppPlugin.getInfo().then(function (info) {
        update.appVersion = (info && info.version) || '';
        update.appBuild = Number(info && info.build) || 0;
        return true;
      }).catch(function () { return false; })
      : Promise.resolve(false);
    return appInfoPromise;
  }

  /** 版本号那一行：原生壳用**真实安装版本**；浏览器退化成「网页版（VsSaros 扩展 x.y.z）」。 */
  function aboutVersionText() {
    if (update.appVersion) {
      return '版本 ' + update.appVersion + (update.appBuild ? '（构建 ' + update.appBuild + '）' : '');
    }
    var ext = state.status && state.status.app && state.status.app.version;
    if (isNativeShell) return '版本未知（原生壳没回版本号）';
    return '网页版' + (ext ? '（VsSaros 扩展 ' + ext + '）' : '');
  }

  /** 弹层里的信息行（只读）。取不到的显示「—」而不是隐藏 —— 让人看得出"这项没拿到"。 */
  function aboutRows() {
    var s = state.status || {};
    var v = s.vsaros || {};
    var f = s.features || {};
    var rows = [
      ['版本号', update.appVersion || (isNativeShell ? '（原生壳未提供）' : '—')],
      ['构建号', update.appBuild ? String(update.appBuild) : '—'],
      ['运行环境', isNativeShell ? 'Android App（原生壳）' : '浏览器网页版'],
      ['连接的电脑', BASE || location.origin],
      ['连接状态', (el.connText && el.connText.textContent) || '—'],
      ['VsSaros', (v.appName || 'VsSaros') + (v.version ? ' ' + v.version : '')],
      ['VsSaros 扩展', (s.app && s.app.version) || '—'],
      ['工作区', v.workspaceName || '—'],
      ['升级源', updateSource() || '未配置（可在「连接」页填）'],
      ['最新版本', update.latest ? (update.latest.versionName + '（' + update.latest.versionCode + '）') : '未检查'],
      ['桌面同屏', f.desktop ? '可用' : '不可用'],
    ];
    if (!el.aboutRows) return;
    el.aboutRows.innerHTML = rows.map(function (r) {
      return '<div>' + esc(r[0]) + '</div><div>' + esc(r[1]) + '</div>';
    }).join('');
  }

  function renderAbout() {
    if (!el.aboutMask) return;
    el.aboutVer.textContent = aboutVersionText();
    aboutRows();
    el.aboutNote.textContent = [
      'Saros Pocket 是 VsSaros 的手机伴侣：看会话、跟 Agent 对话、随时查看电脑屏幕、翻文件。',
      '它只是一层界面 —— 模型、Agent、代码与凭据都在你配对的那台电脑上跑，不经过第三方服务器。',
      '可在「连接」页检查更新并就地安装（升级源也可以改）。',
    ].join('\n');
    // 「去检查更新」只在原生壳（有升级插件）里有意义
    if (el.aboutCheck) el.aboutCheck.classList.toggle('hidden', !update.plugin);
  }

  function openAbout() {
    renderAbout();
    el.aboutMask.classList.remove('hidden');
    // 顺手刷一次状态（连接/扩展版本）——离线也不阻塞：拿到再刷新行，拿不到就看本机版本
    loadStatus().then(function () {
      if (!el.aboutMask.classList.contains('hidden')) renderAbout();
    }).catch(function () { /* 忽略 */ });
  }

  function closeAbout() {
    el.aboutMask.classList.add('hidden');
    if (el.aboutOpen) el.aboutOpen.focus();   // 焦点还给 logo，键盘用户不迷路
  }

  function setupAbout() {
    if (!el.aboutOpen || !el.aboutMask) return;   // 老页面（没这段 DOM）也不报错
    el.aboutOpen.addEventListener('click', openAbout);
    if (el.aboutClose) el.aboutClose.addEventListener('click', closeAbout);
    if (el.aboutOk) el.aboutOk.addEventListener('click', closeAbout);
    // 点遮罩空白处关闭（点面板内部不关）
    el.aboutMask.addEventListener('click', function (e) { if (e.target === el.aboutMask) closeAbout(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.aboutMask.classList.contains('hidden')) closeAbout();
    });
    if (el.aboutCheck) {
      el.aboutCheck.addEventListener('click', function () {
        closeAbout();
        switchTab('status');   // 进度条与结果都在「连接」页的升级卡片里，这里负责把人送过去 + 触发
        if (typeof checkUpdate === 'function') checkUpdate(false);
      });
    }
    probeAppInfo().then(function () {
      if (!el.aboutMask.classList.contains('hidden')) renderAbout();
    });
  }

  function setupUpdater() {
    var plugins = window.Capacitor && window.Capacitor.Plugins;
    update.plugin = (plugins && plugins.PocketUpdater) || null;
    if (!update.plugin || !el.updateWrap) return; // 浏览器：保持隐藏，行为不变
    el.updateWrap.classList.remove('hidden');

    // 版本号统一走 probeAppInfo()（memo 化）⇒ 弹层与升级卡片共享同一次 App.getInfo()
    probeAppInfo().then(function () {
      renderUpdate();
      maybeAutoCheck();
    });

    el.updateCheck.addEventListener('click', function () { checkUpdate(false); });
    el.updateInstall.addEventListener('click', downloadAndInstall);
    el.updateGrant.addEventListener('click', function () {
      update.plugin.openInstallSettings()
        .then(function () { update.phase = 'available'; renderUpdate(); })
        .catch(function (err) {
          update.phase = 'error';
          update.error = (err && err.message) || '打开授权页失败';
          renderUpdate();
        });
    });
    el.updateAuto.checked = autoCheckOn();
    el.updateAuto.addEventListener('change', function () {
      try { localStorage.setItem(UPDATE_AUTO_KEY, el.updateAuto.checked ? '1' : '0'); } catch (e) { /* 忽略 */ }
    });
    el.updateUrl.value = updateSource();
    el.updateUrl.addEventListener('change', function () {
      try { localStorage.setItem(UPDATE_SRC_KEY, el.updateUrl.value.trim()); } catch (e) { /* 忽略 */ }
      update.latest = null;
      update.phase = 'idle';
      renderUpdate();
    });
    renderUpdate();
  }

  /** 自动检查：启动 2 秒后静默一次，之后每 6 小时一次（可关）。 */
  function maybeAutoCheck() {
    if (!update.plugin || !autoCheckOn() || !updateSource()) return;
    setTimeout(function () { checkUpdate(true); }, 2000);
    if (!update.timer) {
      update.timer = setInterval(function () { checkUpdate(true); }, UPDATE_AUTO_INTERVAL);
    }
  }

  function start() {
    setConn('', '连接中…');
    // 语音输入是非必要能力：不可用就把按钮讲清楚，不能影响主流程
    setupVoiceInput();
    connectEvents();
    loadModels().then(loadStatus).catch(function () { /* 状态页会自己重试 */ });
    addMsg('system', '已连上 Pocket。直接对话 = 用 VsSaros 配置的模型；「交给 Agent」= 把任务丢进 VsSaros 的 Agent 会话。');
    loadSessions().catch(function () { /* 启动时静默，进收件箱会再试 */ });
    setInterval(function () { if (state.tab === 'status') loadStatus(); }, 15000);
    // 深链直达：/pocket/#screen（「打开屏幕」命令 / 二维码分享）
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash) switchTab(hash);
  }

  // 打开即摘掉地址栏里的 ?token=<访问密码>（cookie 已由响应头种下，见 stripTokenFromAddressBar）
  stripTokenFromAddressBar();

  // App 自升级：**在配对分支之外**初始化 —— 没配对（看到的是配对引导页）也要能升级 App。
  setupUpdater();
  // App 信息（点 logo）：同样在配对分支之外 —— 版本号在"还没连上电脑"时最有用（排查用）。
  setupAbout();

  /**
   * 是否在**原生壳**里。
   *
   * ⚠ 不要用 `location.protocol` 判断：`server.androidScheme` 配成 `http` 后，
   * 壳里的页面是 `http://localhost`，协议判断会漏 —— 实测（真机 logcat）：未配对时走进 `start()`，
   * 于是对着 `http://localhost/saros-pocket/rpc/*` 一通请求全 404，用户看到的是一屏连接错误，
   * 而不是本该出现的配对引导页。`Capacitor.isNativePlatform()` 才是可靠信号。
   */
  var isNativeShell = !!(window.Capacitor
    && (typeof window.Capacitor.isNativePlatform === 'function'
      ? window.Capacitor.isNativePlatform()
      : window.Capacitor.Plugins));

  if (BASE) {
    start();
  } else if (isNativeShell) {
    // 原生壳且未配对 → 配对引导页
    showPairing();
  } else {
    start();
  }
})();
