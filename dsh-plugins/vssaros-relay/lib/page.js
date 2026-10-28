// @vssaros/dsh-relay — 中转站工作台页（`/x/relay/` 的整页 HTML）
//
// 职责（2026-10-27 改版）：**不再 iframe 承载中转站 Web**（那个 iframe 只会停在「密钥输入」登录页，
// 对用户没用）⇒ 改成**原生页面**：直接显示
//   ① 中转站状态（地址 / 可达性 / 版本 / 延迟）
//   ② 「注册本机到号池」按钮 —— 点一下就把**本机**注册成中转站的一个节点（不再登录后自动注册）
//   ③ **号池**（节点池）列表 —— 注册完能立刻看见自己
// 想要中转站完整后台（账号池 / 节点 / 设置）⇒ 点「↗ 外开」在浏览器里开（那里登录才正常）。
//
// ⚠ 自托管页面拿不到宿主 `--dsw-alias-*` ⇒ 配色自带；暗色跟 `prefers-color-scheme`。
// ⚠ 页面内脚本：**不许出现 `//` 行注释**（整段被拼成一行 ⇒ 注释会吃掉后续代码 ⇒ 交互静默失效）。

// 中转站地址：AnyDev 环境「我的开发环境」= 21.6.92.5，devcloud 域名是它的对外入口。
// ⚠ 用域名而不是裸 IP：裸 IP 在部分网段/浏览器里不可达，域名两边（IDE 扩展、dsh 页面）都通。
export const DEFAULT_RELAY = 'http://zijianqiu-any1.devcloud.woa.com:8000/';

const STYLE = `:root{--page:#eef0f4;--bar:#f7f8fa;--surface:#fff;--stroke:#e5e7ee;--stroke2:#d5d8e1;
--fg:#16181d;--muted:#5b6270;--faint:#8b929e;--ok:#12805c;--bad:#b4231f;--warn:#a15c00;}
@media (prefers-color-scheme: dark){:root{--page:#14161a;--bar:#1b1d22;--surface:#17191d;--stroke:#2a2d34;
--stroke2:#3a3e47;--fg:#f2f4f8;--muted:#aeb4bf;--faint:#7d848f;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--page);color:var(--fg);
font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
.bar{flex:none;height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;
background:var(--bar);border-bottom:1px solid var(--stroke);font-size:11.5px;color:var(--faint)}
.bar .lab{color:var(--muted)}
.bar .url{font-family:ui-monospace,Consolas,monospace;color:var(--muted);overflow:hidden;
text-overflow:ellipsis;white-space:nowrap;max-width:42vw}
.bar .grow{flex:1}
.bar .badge{border:1px solid var(--stroke2);border-radius:999px;padding:0 8px;font-size:11px;color:var(--faint);white-space:nowrap}
.bar .badge.ok{color:var(--ok);border-color:currentColor}
.bar .badge.bad{color:var(--bad);border-color:currentColor}
.btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:6px;
border:1px solid var(--stroke2);background:var(--surface);color:var(--muted);
font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{background:color-mix(in srgb,var(--fg) 7%,transparent)}
.btn.primary{background:color-mix(in srgb,var(--ok) 14%,var(--surface));color:var(--ok);border-color:currentColor;font-weight:600}
.btn.ok{background:color-mix(in srgb,var(--ok) 12%,var(--surface));color:var(--ok);border-color:currentColor;font-weight:600}
.btn.bad{background:color-mix(in srgb,var(--warn) 14%,var(--surface));color:var(--warn);border-color:currentColor;font-weight:600}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 55%,var(--stroke2))}
.btn.danger:hover{background:color-mix(in srgb,var(--bad) 12%,transparent)}
.btn[disabled]{opacity:.55;cursor:default}
/* ★ 额度进度条（2026-10-28）：已用占比一眼可见；≥70% 转黄、≥90% 转红 */
.qbar{margin:2px 0 8px}
.qbar-track{height:9px;border-radius:999px;background:var(--stroke2);overflow:hidden}
.qbar-fill{height:100%;border-radius:999px;background:var(--ok);transition:width .3s ease}
.qbar-fill.warn{background:var(--warn)}
.qbar-fill.hot{background:var(--bad)}
.qbar-meta{display:flex;justify-content:space-between;margin-top:5px;font-size:11.5px;color:var(--muted)}
.qbar-pct{color:var(--fg);font-weight:600}
textarea{width:100%;box-sizing:border-box;margin:4px 0;padding:6px 8px;border-radius:6px;
border:1px solid var(--stroke2);background:var(--bg);color:var(--fg);font:inherit;font-size:11.5px;resize:vertical}
textarea::placeholder{color:var(--faint)}
main{flex:1;min-height:0;overflow:auto;padding:14px}
.card{background:var(--surface);border:1px solid var(--stroke);border-radius:10px;padding:12px 14px;margin-bottom:12px}
.card h2{margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row .grow{flex:1}
.hint{color:var(--faint);font-size:11.5px;margin-top:6px}
.hint b{color:var(--muted);font-weight:600}
.state{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.state .dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.state.on .dot{background:var(--ok)}
.state.off .dot{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--stroke)}
th{color:var(--faint);font-weight:500;font-size:11px}
td.mono,th.mono{font-family:ui-monospace,Consolas,monospace}
tr.me td{background:color-mix(in srgb,var(--ok) 8%,transparent)}
.pill{display:inline-block;padding:0 7px;border-radius:999px;border:1px solid currentColor;font-size:11px}
.pill.on{color:var(--ok)}
.pill.off{color:var(--bad)}
.empty{color:var(--faint);font-size:12px;padding:10px 2px}
.grid{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,1fr);gap:12px;align-items:start}
.col{display:flex;flex-direction:column;gap:12px;min-width:0}
.grid .card{margin-bottom:0}
@media (max-width:980px){.grid{grid-template-columns:minmax(0,1fr)}}
.log{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.55;
max-height:min(46vh,430px);overflow:auto;border:1px solid var(--stroke);border-radius:8px;
background:color-mix(in srgb,var(--fg) 3%,var(--surface));padding:7px 9px}
.logrow{display:flex;gap:8px;padding:1px 0;white-space:pre-wrap;word-break:break-word}
.logrow .t{color:var(--faint);flex:none}
.logrow .k{flex:none;min-width:1.6em}
.logrow.start .k{color:var(--muted)}
.logrow.ok .k{color:var(--ok)}
.logrow.err .k{color:var(--bad)}
.logrow .m{color:var(--fg);opacity:.92}
.logrow .dim{color:var(--faint)}
h2 .btn{height:19px;padding:0 7px;margin-left:6px;vertical-align:1px}
`;

export function renderPage(input) {
	const relayUrl = String((input && input.relayUrl) || DEFAULT_RELAY);
	const safeRelay = relayUrl.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>萨罗斯中转站</title>
<style>${STYLE}</style>
</head>
<body>
<div class="bar">
	<span class="lab">中转站</span>
	<span class="url" title="${safeRelay}">${safeRelay}</span>
	<span class="grow"></span>
	<span class="badge" id="relay-ping" title="中转站可达性 / 版本 / 往返耗时">探测中…</span>
	<span class="badge" id="agent-state" title="本机 Node Agent 反向通道状态">通道…</span>
	<span class="badge" id="relay-state">加载中…</span>
	<button class="btn" id="relay-reload" title="重新探测并刷新号池">↻ 刷新</button>
	<a class="btn" href="https://token.woa.com/" target="_blank" rel="noreferrer noopener" title="打开 token.woa.com —— 看**你自己的** Token 用量与额度（内网 AI 额度看板）">🔗 Token 用量</a>
	<button class="btn" id="relay-open" title="在外部浏览器打开中转站后台">↗ 外开</button>
</div>
<main>
<div class="grid">
	<div class="col">
		<div class="card">
			<h2>本机注册</h2>
			<div class="row">
				<span class="state" id="local-state"><span class="dot"></span><span id="local-text">读取中…</span></span>
				<span class="grow"></span>
				<button class="btn primary" id="relay-enroll" title="把本机注册成中转站的一个节点">📡 注册本机到号池</button>
				<button class="btn" id="relay-reconnect" style="display:none" title="重新建立本机 Agent 的反向通道（不重新注册、不轮换令牌）">↻ 重连通道</button>
				<button class="btn danger" id="relay-unregister" style="display:none" title="把本机从号池里移除（节点自助注销；之后可再注册回来）">🗑 移除注册</button>
			</div>
			<div class="hint">点一下才注册 —— 本机（CodeBuddy provider 的这台机器）会作为<b>一个节点</b>进入中转站的号池；
			注册只上报<b>身份与模型目录</b>，<b>不上报任何 CodeBuddy 凭据</b>。同一台机器重复点不会多出节点。<br>
			注册成功后会<b>自动拉起本机的 Node Agent 反向通道</b>（之后每次启动 VsSaros 也会自动拉起）——
			中转站要调这台机器的 CodeBuddy 时，凭证与请求都留在本机，机器只负责转发。</div>
		</div>
		<div class="card">
			<h2>Agent 节点 <span id="agent-count"></span><button class="btn" id="agent-refresh" title="立即刷新 Agent 节点列表">↻ 刷新</button></h2>
			<div id="agent-body"><div class="empty">读取中…</div></div>
			<div class="hint" id="agent-updated">—</div>
			<div class="hint" id="agent-hint">「通道」= 该节点的 Node Agent 反向通道是否连着中转站（<b>连着才能被派发调用</b>）。</div>
		</div>
		<div class="card">
			<h2>号池（节点）<span id="pool-count"></span><button class="btn" id="pool-refresh" title="立即刷新号池">↻ 刷新</button><a class="btn" href="https://token.woa.com/" target="_blank" rel="noreferrer noopener" title="打开 token.woa.com —— 看**你自己的** Token 用量与额度">🔗 Token 用量</a></h2>
			<div id="pool-body"><div class="empty">读取中…</div></div>
		</div>
		<div class="card">
			<h2>Tokens 用量 <span id="quota-month"></span><button class="btn" id="quota-refresh" title="立即刷新用量">↻ 刷新</button><button class="btn primary" id="quota-login" title="在<b>真实浏览器</b>里打开 token.woa.com 登录页（登录一次即可，之后全自动）">🌐 浏览器登录</button></h2>
			<div id="quota-body"><div class="empty">读取中…</div></div>
			<div class="hint" id="quota-hint">CodeBuddy 账号的额度 / 积分（单位 credits）。<b>全自动、零手工</b>：直接复用你<b>浏览器</b>里的 token.woa.com 登录态（插件从浏览器进程里读 httpOnly cookie，不落盘、不上报，只上报额度数字）；没有登录态时会自动在浏览器里打开登录页，手机确认一次即可，之后每 30 分钟自动刷新。</div>
		</div>
	</div>
	<div class="col">
		<div class="card">
			<h2>执行日志 <span id="log-count"></span><button class="btn" id="log-refresh" title="立即刷新执行日志">↻ 刷新</button><button class="btn" id="log-clear" title="清空本机 Agent 的执行日志">清空</button></h2>
			<div class="log" id="log-body"><div class="empty">读取中…</div></div>
			<div class="hint">本机 Node Agent 的执行流水：每次被中转站派发调用（invoke）的开始 / 结束 / 失败，以及通道开合。</div>
		</div>
	</div>
</div>
</main>
<script>
(function(){
  var RELAY = ${JSON.stringify(relayUrl)};
  var ping = document.getElementById('relay-ping');
  var stateBadge = document.getElementById('relay-state');
  var localState = document.getElementById('local-state');
  var localText = document.getElementById('local-text');
  var poolBody = document.getElementById('pool-body');
  var poolCount = document.getElementById('pool-count');
  var agentBody = document.getElementById('agent-body');
  var agentCount = document.getElementById('agent-count');
  var logBody = document.getElementById('log-body');
  var logCount = document.getElementById('log-count');
  var logClear = document.getElementById('log-clear');
  var agentRefresh = document.getElementById('agent-refresh');
  var poolRefresh = document.getElementById('pool-refresh');
  var logRefresh = document.getElementById('log-refresh');
  var enrollBtn = document.getElementById('relay-enroll');
  var reconnectBtn = document.getElementById('relay-reconnect');
  var unregisterBtn = document.getElementById('relay-unregister');
  var lastPool = null;
  var lastAgent = null;
  var agentBadge = document.getElementById('agent-state');

  function setBadge(el, text, cls){ el.textContent = text; el.className = 'badge' + (cls ? ' ' + cls : ''); }

  function fmtAgo(iso){
    if (!iso) { return '—'; }
    var t = Date.parse(iso);
    if (!t) { return iso; }
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) { return s + ' 秒前'; }
    if (s < 3600) { return Math.round(s / 60) + ' 分钟前'; }
    if (s < 86400) { return Math.round(s / 3600) + ' 小时前'; }
    return Math.round(s / 86400) + ' 天前';
  }

  function renderPool(data){
    var nodes = (data && data.nodes) || [];
    poolCount.textContent = nodes.length ? ('（' + nodes.length + ' 个）') : '';
    if (!nodes.length) {
      poolBody.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = (data && data.error) ? ('读取失败：' + data.error) : '号池里还没有节点 —— 点上面的按钮把本机注册进来。';
      poolBody.appendChild(empty);
      return;
    }
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['节点', '状态', '提供者', '最后心跳', '模型', '标识'].forEach(function(h, i){
      var th = document.createElement('th');
      th.textContent = h;
      if (i === 4 || i === 5) { th.className = 'mono'; }
      head.appendChild(th);
    });
    table.appendChild(head);
    nodes.forEach(function(n){
      var tr = document.createElement('tr');
      if (n.isLocal) { tr.className = 'me'; }
      var name = document.createElement('td');
      name.textContent = n.name || n.id || '';
      tr.appendChild(name);
      var st = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill ' + (n.status === 'online' ? 'on' : 'off');
      pill.textContent = n.status === 'online' ? '在线' : (n.status || '离线');
      st.appendChild(pill);
      tr.appendChild(st);
      var prov = document.createElement('td');
      prov.textContent = n.provider || '';
      tr.appendChild(prov);
      var seen = document.createElement('td');
      seen.textContent = fmtAgo(n.lastSeenAt);
      tr.appendChild(seen);
      var models = document.createElement('td');
      models.className = 'mono';
      models.textContent = String(n.models || 0);
      tr.appendChild(models);
      var id = document.createElement('td');
      id.className = 'mono';
      id.textContent = n.id || '';
      tr.appendChild(id);
      table.appendChild(tr);
    });
    poolBody.textContent = '';
    poolBody.appendChild(table);
  }

  function refreshLocal(data){
    var me = data && data.local;
    lastPool = data || null;
    if (me && me.registered) {
      localState.className = 'state on';
      localText.textContent = '本机已注册：' + (me.name || me.id || '') + '（' + (me.status || '—') + '）';
    } else {
      localState.className = 'state off';
      localText.textContent = '本机尚未注册到号池';
    }
    updateEnrollButtons();
  }

  /**
   * 注册按钮**跟着状态走**（2026-10-28 用户要求）：
   *   · 未注册 ⇒ 「📡 注册本机到号池」（可点）
   *   · 已注册 ⇒ 变成**状态徽标**（不可点）+ 旁边给「↻ 重连通道」
   * 为何不让重复注册：auto-enroll 每次都会**轮换节点令牌** ⇒ 重复点一下会把**正在跑的通道踢断**
   *   （表现为"点一次注册，通道反而断了"）✗ ⇒ 需要重连时用「↻ 重连通道」（只重连、不轮换令牌）✓
   */
  function updateEnrollButtons(){
    var registered = !!(lastPool && lastPool.local && lastPool.local.registered);
    var connected = !!(lastAgent && lastAgent.state === 'connected');
    if (!registered) {
      enrollBtn.disabled = false;
      enrollBtn.className = 'btn primary';
      enrollBtn.textContent = '📡 注册本机到号池';
      enrollBtn.title = '把本机注册成中转站的一个节点';
      reconnectBtn.style.display = 'none';
      unregisterBtn.style.display = 'none';
      return;
    }
    enrollBtn.disabled = true;
    enrollBtn.className = 'btn ' + (connected ? 'ok' : 'bad');
    if (connected) {
      enrollBtn.textContent = '✔ 已注册 · 通道已连接';
      enrollBtn.title = '本机已在号池里（节点 ' + ((lastPool.local && lastPool.local.id) || '') + '）· 重复注册会轮换节点令牌并踢断当前通道 ⇒ 要重连请用「↻ 重连通道」';
      enrollBtn.disabled = true;
    } else {
      // ★ 池里还有本机节点、但**通道没连上**（旧节点已离线 / 本机令牌没了）
      //   ⇒ 此时必须**允许重新注册**（= 换一把新令牌 + 复用同一个节点），
      //     否则页面显示"已注册"却什么都点不了 ⇒ 卡死 ✗✗
      enrollBtn.disabled = false;
      enrollBtn.className = 'btn primary';
      enrollBtn.textContent = '🔄 重新注册并重连';
      enrollBtn.title = '本机在号池里还留着一个节点，但通道没连上（节点已离线 / 本机令牌失效）⇒ 点这里换一把新令牌并复用同一个节点（中转站按主机名判定同机 ⇒ 不会多出节点）';
    }
    reconnectBtn.style.display = '';
    reconnectBtn.className = 'btn ' + (connected ? '' : '');
    unregisterBtn.style.display = '';
  }

  function renderAgents(data){
    var nodes = (data && data.nodes) || [];
    var agents = nodes.filter(function(n){ return n.provider === 'codebuddy' || n.channelConnected; });
    agentCount.textContent = agents.length ? ('（' + agents.length + ' 个）') : '';
    var upd = document.getElementById('agent-updated');
    if (upd) {
      var now = new Date();
      function p2(n){ return (n < 10 ? '0' : '') + n; }
      upd.textContent = '更新于 ' + p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds()) +
        '（每 15 秒自动刷新，也可点右上「↻ 刷新」立即拉）';
    }
    if (!agents.length) {
      agentBody.textContent = '';
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '号池里还没有 agent 节点 —— 点「注册本机到号池」把本机加进来。';
      agentBody.appendChild(empty);
      return;
    }
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['节点', '通道', '状态', '模型', '最后心跳'].forEach(function(h, i){
      var th = document.createElement('th');
      th.textContent = h;
      head.appendChild(th);
    });
    table.appendChild(head);
    agents.forEach(function(n){
      var tr = document.createElement('tr');
      if (n.isLocal) { tr.className = 'me'; }
      var name = document.createElement('td');
      name.textContent = (n.name || n.id || '') + (n.isLocal ? '（本机）' : '');
      tr.appendChild(name);
      var ch = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill ' + (n.channelConnected ? 'on' : 'off');
      pill.textContent = n.channelConnected ? '已连接' : '未连接';
      ch.appendChild(pill);
      tr.appendChild(ch);
      var st = document.createElement('td');
      st.textContent = n.status || '—';
      tr.appendChild(st);
      var models = document.createElement('td');
      models.className = 'mono';
      models.textContent = String(n.models || 0);
      tr.appendChild(models);
      var seen = document.createElement('td');
      seen.textContent = fmtAgo(n.lastSeenAt);
      tr.appendChild(seen);
      table.appendChild(tr);
    });
    agentBody.textContent = '';
    agentBody.appendChild(table);
  }

  function logTime(iso){
    if (!iso) { return '--:--:--'; }
    var t = Date.parse(iso);
    if (!t) { return '--:--:--'; }
    var d = new Date(t);
    function pad(n){ return (n < 10 ? '0' : '') + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function logLine(e){
    var kind = String(e.kind || '');
    var row = document.createElement('div');
    row.className = 'logrow';
    var t = document.createElement('span');
    t.className = 't';
    t.textContent = logTime(e.ts);
    row.appendChild(t);
    var k = document.createElement('span');
    k.className = 'k';
    var m = document.createElement('span');
    m.className = 'm';
    if (kind === 'invoke_start') {
      row.className += ' start';
      k.textContent = '▶';
      m.textContent = '开始调用' + (e.model ? '  model=' + e.model : '') + (e.method ? '  ' + e.method : '');
    } else if (kind === 'invoke_done') {
      row.className += ' ok';
      k.textContent = '✔';
      m.textContent = '调用完成' + (e.model ? '  model=' + e.model : '') +
        (typeof e.chunks === 'number' ? '  ' + e.chunks + ' 片' : '') +
        (typeof e.ms === 'number' ? '  ' + (e.ms / 1000).toFixed(2) + 's' : '');
    } else if (kind === 'invoke_error') {
      row.className += ' err';
      k.textContent = '✘';
      m.textContent = '调用失败' + (e.model ? '  model=' + e.model : '') +
        (typeof e.ms === 'number' ? '  ' + (e.ms / 1000).toFixed(2) + 's' : '') +
        (e.error ? '  ' + String(e.error).slice(0, 160) : '');
    } else if (kind === 'channel_open') {
      row.className += ' ok';
      k.textContent = '⇢';
      m.textContent = '通道已连接' + (e.nodeId ? '  ' + e.nodeId : '');
    } else if (kind === 'channel_close') {
      row.className += ' err';
      k.textContent = '⇠';
      m.textContent = '通道断开' + (e.reason ? '  ' + e.reason : '');
    } else {
      row.className += ' start';
      k.textContent = '·';
      m.textContent = kind + (e.error ? '  ' + String(e.error).slice(0, 160) : '');
    }
    row.appendChild(k);
    row.appendChild(m);
    return row;
  }

  function renderLogs(data){
    var entries = (data && data.entries) || [];
    logCount.textContent = entries.length ? ('（' + entries.length + ' 条）') : '';
    logBody.textContent = '';
    if (!entries.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有执行记录 —— 中转站派发调用给本机 agent 时，这里会实时出现。';
      logBody.appendChild(empty);
      return;
    }
    entries.forEach(function(e){ logBody.appendChild(logLine(e)); });
  }

  function loadLogs(){
    return fetch('/x/relay/api/agent/logs', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){ renderLogs(d); })
      .catch(function(e){
        logBody.textContent = '';
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '读取执行日志失败：' + String(e);
        logBody.appendChild(empty);
      });
  }

  function loadPool(){
    return fetch('/x/relay/api/nodes', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){ renderPool(d); refreshLocal(d); renderAgents(d); })
      .catch(function(e){
        poolBody.textContent = '';
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '读取号池失败：' + String(e);
        poolBody.appendChild(empty);
      });
  }

  var AGENT_LABEL = {
    connected: '通道已连接',
    connecting: '通道连接中…',
    idle: '通道未启动',
    stopped: '通道已停止',
    error: '通道异常'
  };

  function loadAgent(){
    return fetch('/x/relay/api/agent', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var a = (d && d.agent) || {};
        lastAgent = a;
        var registered = !!(d && d.node && d.node.registered);
        var label = AGENT_LABEL[a.state] || ('通道 ' + (a.state || '未知'));
        var extra = [];
        if (a.inflight) { extra.push('在途 ' + a.inflight); }
        if (a.models) { extra.push('模型 ' + a.models); }
        if (extra.length) { label = label + ' · ' + extra.join(' · '); }
        if (a.state === 'error' && a.error) { label = label + '（' + String(a.error).slice(0, 40) + '）'; }
        if (!registered) { label = '未注册到号池'; }
        setBadge(agentBadge, label, a.state === 'connected' ? 'ok' : (registered ? 'bad' : ''));
        updateEnrollButtons();
        // ★ 诊断行：模型数 0 / 目录没上来时，**直接说出原因**（别让人对着 0 猜）✓
        var hint = document.getElementById('agent-hint');
        if (hint) {
          var bits = [];
          if (a.state === 'connected' && !a.models) {
            bits.push('本机还没上报模型目录');
            if (a.catalogError) { bits.push('原因：' + String(a.catalogError)); }
            else if (a.hasToken === false) { bits.push('原因：本机取不到 CodeBuddy 登录态'); }
          }
          hint.textContent = bits.length
            ? bits.join('　')
            : '「通道」= 该节点的 Node Agent 反向通道是否连着中转站（连着才能被派发调用）。';
        }
      })
      .catch(function(e){
        setBadge(agentBadge, '通道状态未知', 'bad');
      });
  }

  function doPing(){
    return fetch('/x/relay/api/ping', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.ok) {
          setBadge(stateBadge, '中转站不可达', 'bad');
          setBadge(ping, (d && d.error) ? String(d.error).slice(0, 60) : '不可达', 'bad');
          return;
        }
        setBadge(stateBadge, '已连接', 'ok');
        setBadge(ping, 'v' + (d.version || '?') + ' · ' + d.latencyMs + 'ms', 'ok');
      })
      .catch(function(e){
        setBadge(stateBadge, '中转站不可达', 'bad');
        setBadge(ping, String(e).slice(0, 60), 'bad');
      });
  }

  enrollBtn.addEventListener('click', function(){
    enrollBtn.disabled = true;
    var old = enrollBtn.textContent;
    enrollBtn.textContent = '注册中…';
    fetch('/x/relay/api/enroll', { method: 'POST', cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d && d.ok) {
          localState.className = 'state on';
          localText.textContent = '注册成功：' + ((d.node && d.node.name) || (d.node && d.node.id) || '本机');
        } else {
          localState.className = 'state off';
          localText.textContent = '注册失败：' + ((d && (d.error || d.detail)) || '未知错误');
        }
        return loadPool();
      })
      .then(function(){ return loadAgent(); })
      .catch(function(e){
        localState.className = 'state off';
        localText.textContent = '注册失败：' + String(e);
      })
      .then(function(){
        enrollBtn.disabled = false;
        enrollBtn.textContent = old;
      });
  });

  document.getElementById('relay-reload').addEventListener('click', function(){
    setBadge(stateBadge, '探测中…');
    doPing();
    loadPool();
    loadAgent();
    loadLogs();
  });
  document.getElementById('relay-open').addEventListener('click', function(){ window.open(RELAY, '_blank'); });

  // ── 各面板的「↻ 刷新」：立刻重拉对应数据（不用等自动轮询）────────────────
  function withBusy(btn, fn){
    if (btn) { btn.disabled = true; }
    var p = fn();
    return Promise.resolve(p).then(function(v){
      if (btn) { btn.disabled = false; }
      return v;
    }, function(e){
      if (btn) { btn.disabled = false; }
      throw e;
    });
  }
  agentRefresh.addEventListener('click', function(){
    withBusy(agentRefresh, function(){ return Promise.all([loadPool(), loadAgent()]); });
  });
  poolRefresh.addEventListener('click', function(){
    withBusy(poolRefresh, loadPool);
  });
  logRefresh.addEventListener('click', function(){
    withBusy(logRefresh, loadLogs);
  });
  reconnectBtn.addEventListener('click', function(){
    withBusy(reconnectBtn, function(){
      return fetch('/x/relay/api/agent/reconnect', { method: 'POST', cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(){ return Promise.all([loadAgent(), loadLogs()]); });
    });
  });
  unregisterBtn.addEventListener('click', function(){
    if (!window.confirm('确定把本机从号池里移除吗？\\n\\n移除后：中转站不再看到这台机器，也不能再向它派活；\\n随时可以再点「注册本机到号池」加回来。')) {
      return;
    }
    withBusy(unregisterBtn, function(){
      return fetch('/x/relay/api/unregister', { method: 'POST', cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.ok === false) {
            window.alert('移除失败：' + String(d.error || '未知原因'));
          }
          return Promise.all([loadPool(), loadAgent(), loadLogs()]);
        });
    });
  });
  logClear.addEventListener('click', function(){
    logClear.disabled = true;
    fetch('/x/relay/api/agent/logs/clear', { method: 'POST', cache: 'no-store' })
      .then(function(){ return loadLogs(); })
      .catch(function(){})
      .then(function(){ logClear.disabled = false; });
  });

  doPing();
  loadPool();
  /* ★ Tokens 用量（CodeBuddy 账号额度/积分）—— **全自动**（2026-10-28）
     数据链：dsh Host 通过**浏览器插件**（vssaros-browser 的 loginSession）读**真实浏览器**里的
             woa 会话 cookie（httpOnly 也读得到）⇒ lib/quota.js 采集额度 ⇒ 上报中转站。
     · 浏览器里已有会话 ⇒ 直接采（零交互）
     · 没有 ⇒ 自动在浏览器里打开 token.woa.com 登录页（企业 SSO 在真实浏览器里回执正常）
     ⚠ 本页是模板字符串 + 内联脚本：不能有反引号、不能有美元符号加花括号的插值、注释只能用块注释。 */
  function fmtNum(v, digits){
    return (v === null || v === undefined) ? '—' : Number(v).toFixed(digits);
  }
  /* 两路数据：
     ① 「/api/quota/account」= 中转站侧的快照（这台机器上报的额度）；
     ② 「/api/quota」= 本机 Host 侧的采集结果（**当前**采集）。 */
  function renderQuota(account, host){
    var body = document.getElementById('quota-body');
    var monthEl = document.getElementById('quota-month');
    var hintEl = document.getElementById('quota-hint');
    if (!body) { return; }
    var q = null;
    var source = '';
    var has = function (x) { return !!(x && (x.total_quota != null || x.used != null)); };
    if (host && has(host.quota)) { q = host.quota; source = '本机自动采集'; }
    else if (account && has(account.quota)) { q = account.quota; source = '中转站快照'; }
    var err = (host && (host.error || (host.quota && host.quota.error)))
      || (account && account.error) || (q && q.error) || '';
    monthEl.textContent = (q && q.month) ? ('（' + q.month + '）') : '';
    if (!q) {
      var noBrowser = host && host.browser_available === false;
      body.innerHTML = '<div class="empty">还没有额度数据' + (err ? ('：' + err) : '') + '</div>';
      hintEl.textContent = noBrowser
        ? '采集额度需要浏览器插件（@vssaros/dsh-browser）—— 请在「内置插件」里启用它。'
        : '插件会自动复用你浏览器里的 token.woa.com 登录态；没有登录态时会自动打开登录页，手机确认一次即可。';
      return;
    }
    var rows = [
      ['额度', fmtNum(q.total_quota, 0)],
      ['已用', fmtNum(q.used, 2)],
      ['剩余', fmtNum(q.remaining, 2)],
      ['账号消耗', fmtNum(q.total_consumed != null ? q.total_consumed : q.used, 2)]
    ];
    var html = '';
    /* ★ 进度条（2026-10-28 用户要求：更直观）——
       已用占额度的比例；配色随水位变化：<70% 绿 / 70~90% 黄 / ≥90% 红（快用完了）✓ */
    var totalQuota = Number(q.total_quota);
    var usedValue = Number(q.used);
    var hasRatio = isFinite(totalQuota) && totalQuota > 0 && isFinite(usedValue);
    if (hasRatio) {
      var pct = Math.max(0, Math.min(100, usedValue / totalQuota * 100));
      var level = pct >= 90 ? ' hot' : (pct >= 70 ? ' warn' : '');
      html += '<div class="qbar">'
        + '<div class="qbar-track"><div class="qbar-fill' + level + '" style="width:' + pct.toFixed(2) + '%"></div></div>'
        + '<div class="qbar-meta">'
        + '<span>已用 <b class="qbar-pct">' + pct.toFixed(1) + '%</b></span>'
        + '<span>剩余 ' + fmtNum(q.remaining, 2) + '</span>'
        + '</div></div>';
    }
    for (var i = 0; i < rows.length; i++){
      html += '<div style="display:flex;justify-content:space-between;padding:3px 0">'
        + '<span style="color:#6b7280">' + rows[i][0] + '</span>'
        + '<b>' + rows[i][1] + '</b></div>';
    }
    html += '<div style="margin-top:6px;color:#9ca3af;font-size:12px">'
      + (q.staff ? ('账号 ' + q.staff + ' · ') : '')
      + (source ? (source + ' · ') : '')
      + (q.updated_at ? ('更新于 ' + fmtAgo(q.updated_at)) : '')
      + '</div>';
    body.innerHTML = html;
    hintEl.textContent = err
      ? ('部分数据没取到：' + err + '（浏览器里的登录态可能过期 ⇒ 点「🌐 浏览器登录」重登一次）')
      : '额度单位 credits；每 30 分钟自动采集，浏览器里的登录态过期时会自动重新登录。';
  }
  function loadQuota(){
    return Promise.all([
      fetch('/x/relay/api/quota/account', { cache: 'no-store' }).then(function(r){ return r.json(); }).catch(function(){ return null; }),
      fetch('/x/relay/api/quota', { cache: 'no-store' }).then(function(r){ return r.json(); }).catch(function(){ return null; })
    ]).then(function(res){ renderQuota(res[0], res[1]); })
      .catch(function(e){
        var body = document.getElementById('quota-body');
        if (body) { body.innerHTML = '<div class="empty">读取失败：' + String(e) + '</div>'; }
      });
  }
  var quotaRefresh = document.getElementById('quota-refresh');
  if (quotaRefresh) { quotaRefresh.addEventListener('click', loadQuota); }
  /* 「🌐 浏览器登录」：让 Host 在**真实浏览器**里打开 token.woa.com 登录页
     （企业 SSO 在真实浏览器里回执正常；在 Electron 窗口里实测收不到）⇒ 零手工 ✓ */
  var quotaLogin = document.getElementById('quota-login');
  if (quotaLogin) {
    quotaLogin.addEventListener('click', function(){
      var hintEl = document.getElementById('quota-hint');
      quotaLogin.disabled = true;
      if (hintEl) { hintEl.textContent = '正在打开浏览器登录页…（登录完成后会自动采集）'; }
      fetch('/x/relay/api/quota/login', { method: 'POST', cache: 'no-store' })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (hintEl) {
            hintEl.textContent = d.ok
              ? '已采集 ✓（之后每 30 分钟自动刷新）'
              : ('没成功：' + (d.error || '未知原因'));
          }
          return loadQuota();
        })
        .catch(function(e){ if (hintEl) { hintEl.textContent = '请求失败：' + String(e); } })
        .then(function(){ quotaLogin.disabled = false; });
    });
  }

  loadAgent();
  loadLogs();
  loadQuota();
  setInterval(function(){ doPing(); loadPool(); loadAgent(); loadQuota(); }, 15000);
  /* 执行日志刷新更快（调用是秒级的事，15s 才刷一次看不出"在跑"）。
     ⚠ 这里必须用块注释：页面内联脚本会被拼成一行 ⇒ 行注释会吃掉后续代码
       （整页交互静默失效）。另外整页是模板字符串 ⇒ 注释里**不能有反引号**。 */
  setInterval(function(){ loadLogs(); }, 4000);
})();
</script>
</body>
</html>`;
}
