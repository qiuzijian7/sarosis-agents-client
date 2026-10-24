// @vssaros/dsh-studio — 站点页（/x/studio/ 的整页 HTML）
//
// 职责只剩一件：**原样承载** Saroasis Studio System 前端（iframe 直连），外加一条站点栏
// （URL / 加载状态 / 刷新 / 外开）。
//
// ⚠ 2026-10-23 起：**AI 助手不在这里了**。它由注册式工作台 `StudioPanel`（lib/client.js）
//   在**右侧**渲染官方 chat-surface（宿主 Frame 注入 `props.conversation`）。
//   本页面里原来那个"✨ AI 助手"按钮 + 自绘浮层（iframe 指向 dsh 根）已删除 ——
//   否则会出现两套助手，且浮层里的第二份客户端拿不到会话上下文。
//
// ⚠ 自托管页面拿不到宿主 `--dsw-alias-*`，配色自带；暗色跟 `prefers-color-scheme`。

const DEFAULT_SITE = 'http://saroasisstudiosystem.saroasis.woa.com:9999/';

export function renderPage(input) {
	const siteUrl = String((input && input.siteUrl) || DEFAULT_SITE);
	const safeSite = siteUrl.replace(/"/g, '&quot;');
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>萨罗斯管理平台</title>
<style>
:root{
  --page:#eef0f4; --bar:#f7f8fa; --surface:#ffffff; --stroke:#e5e7ee; --stroke2:#d5d8e1;
  --fg:#16181d; --muted:#5b6270; --faint:#8b929e; --ok:#12805c;
}
@media (prefers-color-scheme: dark){
  :root{ --page:#14161a; --bar:#1b1d22; --surface:#17191d; --stroke:#2a2d34; --stroke2:#3a3e47;
         --fg:#f2f4f8; --muted:#aeb4bf; --faint:#7d848f; --ok:#4ade80; }
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--page);color:var(--fg);
  font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
.bar{flex:none;height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;
  background:var(--bar);border-bottom:1px solid var(--stroke);font-size:11.5px;color:var(--faint)}
.bar .lab{color:var(--muted)}
.bar .url{font-family:ui-monospace,Consolas,monospace;color:var(--muted);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;max-width:52vw}
.bar .grow{flex:1}
.bar .badge{border:1px solid var(--stroke2);border-radius:999px;padding:0 8px;font-size:11px;color:var(--faint)}
.bar .badge.ok{color:var(--ok);border-color:currentColor}
.btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:6px;
  border:1px solid var(--stroke2);background:var(--surface);color:var(--muted);
  font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.btn:hover{background:color-mix(in srgb,var(--fg) 7%,transparent)}
iframe{flex:1;min-height:0;width:100%;border:0;background:#fff}
</style>
</head>
<body>
<div class="bar">
	<span class="lab">站点</span>
	<span class="url" title="${safeSite}">${safeSite}</span>
	<span class="grow"></span>
	<span class="badge" id="state">加载中…</span>
	<button class="btn" id="reload" title="重载站点">↻ 刷新</button>
	<button class="btn" id="open" title="在外部浏览器打开">↗ 外开</button>
</div>
<iframe id="site" src="${safeSite}" title="萨罗斯管理平台" data-vssaros-studio-site referrerpolicy="no-referrer"></iframe>

<script>
(function(){
  var SITE = ${JSON.stringify(siteUrl)};
  var frame = document.getElementById('site');
  var state = document.getElementById('state');

  frame.addEventListener('load', function(){ state.textContent = '已加载'; state.className = 'badge ok'; });
  frame.addEventListener('error', function(){ state.textContent = '加载失败'; });

  document.getElementById('reload').addEventListener('click', function(){
    state.textContent = '加载中…'; state.className = 'badge';
    frame.src = SITE + (SITE.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  });
  document.getElementById('open').addEventListener('click', function(){ window.open(SITE, '_blank'); });
})();
</script>
</body>
</html>`;
}
