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
    // 收件箱（design-spec 2.1）
    sessions: [],
    sessionFilter: 'all',
    activeSessionId: null,
  };

  var el = {};
  ['connDot', 'connText', 'hostInfo', 'modelSelect', 'messages', 'input', 'send', 'toAgent',
    'clearChat', 'entries', 'pathText', 'upDir', 'reloadFiles', 'fileView', 'fileName',
    'fileBody', 'openInEditor', 'closeFile', 'statusCards', 'events', 'clearEvents', 'toast',
    'sessionList', 'sessionChips', 'reloadSessions', 'browseFiles', 'changes', 'reloadChanges',
    'screenImg', 'screenStatus', 'screenMode', 'screenFps', 'screenScale', 'screenShot',
    'screenReload', 'screenInputBar', 'screenInputOn', 'screenText', 'screenFull', 'screenWrap']
    .forEach(function (id) {
      el[id] = document.getElementById(id);
    });

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

  async function loadModels() {
    try {
      var models = await rpc('chat.models', {});
      state.models = Array.isArray(models) ? models : [];
    } catch (err) {
      state.models = [];
    }
    if (state.models.length === 0) {
      el.modelSelect.innerHTML = '<option value="">（没有可用模型，用「交给 Agent」）</option>';
      return;
    }
    el.modelSelect.innerHTML = state.models.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.name || m.id) + '</option>';
    }).join('');
    state.modelId = el.modelSelect.value;
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
        card('公网隧道', p.tunnelUrl || ((p.tunnelState && p.tunnelState.phase) || 'idle'), p.tunnelUrl ? 'on' : 'off'),
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

  function renderSessions() {
    if (!el.sessionList) return;
    var list = state.sessions || [];
    if (list.length === 0) {
      el.sessionList.innerHTML = '<div class="empty">还没有会话。发一条消息或交给 Agent 试试。</div>';
      return;
    }
    el.sessionList.innerHTML = list.map(function (s) {
      var meta = (s.kind === 'agent' ? 'Agent' : '对话') + ' · ' + timeAgo(s.updatedAt || s.startedAt);
      if (s.error) meta += ' · ' + esc(s.error);
      // 真实 VsSaros 会话才有「继续/结束」：影子会话没有上游实体，操作会失败
      var actions = s.real
        ? '<div class="session-actions">'
        + '<button class="ghost small session-send" type="button">继续</button>'
        + '<button class="ghost small session-archive" type="button">结束</button>'
        + '</div>'
        : '';
      return '<div class="session" data-id="' + esc(s.id) + '" data-real="' + (s.real ? '1' : '') + '">'
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
      var out = await rpc('sessions.list', {
        status: state.sessionFilter === 'all' ? undefined : state.sessionFilter,
        limit: 50,
      });
      state.sessions = out.sessions || [];
    } catch (err) {
      state.sessions = [];
      if (el.sessionList) el.sessionList.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      return;
    }
    renderSessions();
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
    if (name === 'changes') loadChanges().catch(function (e) { toast(e.message); });
    if (name === 'screen') startScreen().catch(function (e) { if (el.screenStatus) el.screenStatus.textContent = e.message; });
  }

  // ---------- 屏幕：远程看 VsSaros.exe 的 UI ----------
  // 画面走 MJPEG（<img> 直接渲染 multipart/x-mixed-replace）；
  // 个别浏览器不支持 multipart 时自动降级为「按帧拉 screen.jpg + blob」的轮询。
  var screenState = {
    mode: 'window', fps: 4, scale: 0.5,
    loaded: false, polling: false, lastBlob: null,
    loadTimer: null, pollTimer: null, statusTimer: null,
    inputOn: false, inputSupported: false, supported: false,
    lastFrames: 0, lastFramesAt: 0, fps: '',
  };

  function setScreenHint(text) {
    if (el.screenStatus) el.screenStatus.textContent = text;
  }

  function stopScreen() {
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
      screenState.inputOn = st.inputAllowed === true;
      if (el.screenInputBar) el.screenInputBar.classList.toggle('hidden', !screenState.inputSupported);
      // 主机端没开 allowDesktopInput → 复选框禁用并复位（前端不假装能操作）
      if (el.screenInputOn) {
        el.screenInputOn.checked = screenState.inputOn;
        el.screenInputOn.disabled = !screenState.inputOn;
      }
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

  /** 图像上的点击/滚轮 → 归一化坐标（0~1）→ 主机侧映射回屏幕绝对坐标。 */
  function screenPoint(ev) {
    var r = el.screenImg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  }

  async function sendDesktopInput(action) {
    try {
      await rpc('desktop.input', action);
    } catch (err) {
      toast(err.message);
    }
  }

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
  el.modelSelect.addEventListener('change', function () { state.modelId = el.modelSelect.value; });

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
      if (!screenState.inputOn) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'click', x: p.x, y: p.y });
    });
    el.screenImg.addEventListener('wheel', function (ev) {
      if (!screenState.inputOn) return;
      ev.preventDefault();
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'wheel', x: p.x, y: p.y, delta: ev.deltaY > 0 ? -120 : 120 });
    }, { passive: false });
    el.screenImg.addEventListener('dblclick', function (ev) {
      if (!screenState.inputOn) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'dblclick', x: p.x, y: p.y });
    });
    // 长按/右键：手机上没有右键，用 contextmenu（长按即可触发）
    el.screenImg.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      if (!screenState.inputOn) return;
      var p = screenPoint(ev);
      sendDesktopInput({ type: 'click', x: p.x, y: p.y, button: 'right' });
    });
    el.screenFull.addEventListener('click', function () {
      var node = el.screenWrap;
      if (!node) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (node.requestFullscreen) node.requestFullscreen().catch(function () { toast('全屏被浏览器拒绝'); });
    });
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
      screenState.inputOn = el.screenInputOn.checked === true;
      if (screenState.inputOn && !screenState.inputSupported) {
        screenState.inputOn = false;
        el.screenInputOn.checked = false;
        toast('主机端不支持桌面输入（仅 Windows）');
      }
    });
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
      '<p id="pairErr" style="color:#ef4444;margin:10px 0 0;min-height:1.2em"></p></div>';
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
  }

  function start() {
    setConn('', '连接中…');
    connectEvents();
    loadModels().then(loadStatus).catch(function () { /* 状态页会自己重试 */ });
    addMsg('system', '已连上 Pocket。直接对话 = 用 VsSaros 配置的模型；「交给 Agent」= 把任务丢进 VsSaros 的 Agent 会话。');
    loadSessions().catch(function () { /* 启动时静默，进收件箱会再试 */ });
    setInterval(function () { if (state.tab === 'status') loadStatus(); }, 15000);
    // 深链直达：/pocket/#screen（「打开屏幕」命令 / 二维码分享）
    var hash = (location.hash || '').replace(/^#/, '');
    if (hash) switchTab(hash);
  }

  if (BASE) {
    start();
  } else if (typeof location !== 'undefined' && /^(capacitor|ionic|file):/i.test(location.protocol)) {
    // 原生壳且未配对 → 配对引导页
    showPairing();
  } else {
    start();
  }
})();
