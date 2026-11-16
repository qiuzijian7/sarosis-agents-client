/*
 * 知识库「主页」页面渲染（★ 2026-11-02）
 *
 * 谁用它：`/x/kb/home` 路由 —— 中间栏的 KbHomeEditorPane 用同源 iframe 加载它。
 * 为什么在这里渲染：库清单 / 篇数 / 是否已绑飞书 这些数据本来就只在插件侧有，
 *   页面直取即可，不必再造一套「IDE ↔ 插件」的取数协议。
 *
 * 纯函数（进数据、出 HTML 字符串），方便单测与守卫。
 */

// ★ 2026-11-11 落地 doc/kb-card-icon-e-mixed.html 定型稿：E 的状态化卡片 + B 的语义 SVG 图标
import { iconForKb, svgIcon } from './core/kbCardIcons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(ms) {
	if (!ms) { return ''; }
	const d = Date.now() - ms;
	if (d < 60e3) { return '刚刚'; }
	if (d < 36e5) { return Math.round(d / 6e4) + ' 分钟前'; }
	if (d < 864e5) { return Math.round(d / 36e5) + ' 小时前'; }
	return Math.round(d / 864e5) + ' 天前';
}

/**
 * @param {{ vaultName?: string, kbs?: Array<{name:string,docs:number,hasFeishu?:boolean,updatedAt?:number}>, routePrefix?: string }} data
 * @returns {string} 完整 HTML
 */
export function renderHomePage(data = {}) {
	const kbs = Array.isArray(data.kbs) ? data.kbs : [];
	const vaultName = data.vaultName || '知识库';
	const prefix = data.routePrefix || '/x/kb';
	const noteCount = kbs.reduce((s, k) => s + (k.docs || 0), 0);
	const bound = kbs.filter((k) => k.hasFeishu).length;
	const emptyCount = kbs.filter((k) => !k.docs).length;
	/** ★ 近 7 天有改动的篇数合计（真数据，来自 mtime 聚合） */
	const weekTotal = kbs.reduce((s, k) => s + (k.weekNew || 0), 0);

	/*
	 * ★ 2026-11-11：卡片改版（方案 E + B 的 SVG 图标）。
	 *   去掉 78px 纯渐变封面 ⇒ 改成 40px 圆角底 + 语义线性图标；
	 *   原来散在正文的「篇数 / 7 天 +N / 飞书 / 时间」收敛成角标 + chip：
	 *     近 7 天更新 = 图标右上圆点，飞书已绑 = 右上 link 角标，
	 *     空库 = 虚线边框 + 「空」角标，篇数 = 底部 chip（时间仍在一行末尾）。
	 *   ⚠ 角标必须绝对定位，否则会作为 flex 子项把卡片撑高（E mockup 截图验出来的坑）。
	 */
	const cards = kbs.map((k) => {
		const meta = iconForKb(k.name);
		const empty = !k.docs;
		const corner = empty
			? '<span class="cb-empty" title="这个知识库还没有文档">空</span>'
			: (k.hasFeishu ? `<span class="cb-corner" title="已关联飞书知识库">${svgIcon('link')}</span>` : '');
		return `
		<button class="card${empty ? ' empty' : ''}" data-kb="${esc(k.name)}">
			${corner}
			<div class="cb-top">
				<span class="ci" style="color:${meta.color}" title="${esc(meta.cat)}">${svgIcon(meta.icon)}${k.weekNew ? '<span class="cb-dot" title="近 7 天有更新"></span>' : ''}</span>
				<span class="nm">${esc(k.name)}</span>
			</div>
			${k.excerpt ? `<div class="ex">${esc(k.excerpt)}</div>` : ''}
			<div class="cb-foot">
				<span class="cb-chip">${k.docs || 0} 篇</span>
				<span class="tm">${esc(when(k.updatedAt))}</span>
			</div>
		</button>`;
	}).join('');

	const recent = kbs.slice(0, 8).map((k) => `
		<div class="r"><span class="nm">${esc(k.name)}</span><span class="k">${k.docs || 0} 篇</span><span class="tm">${esc(when(k.updatedAt))}</span></div>`).join('');

	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  /*
   * ★ 2026-11-11（用户：「总览页配色和 dsh 外观不一致」）：
   *   旧版写死一套自家调色板（蓝黑底 + 冷灰面板），且 html 根节点钉死暗色档、
   *   页面自带独立明暗按钮切档 ⇒ ① 色值与 dsh 官方
   *   （bg-base #151517 / layer-1 #232324 / layer-2 #2c2c2e / label-primary #f9fafb）
   *   接近但不等；② 切到浅色外观时这页纹丝不动；③ 用户点一次按钮就永久反色 ✗。
   *
   *   修法照 vssaros-marketplace/lib/page.css 的同类修复范式：
   *     · 内部语义变量名（--bg/--panel/--fg/...）全保留 ⇒ 下面几十处引用一行不动；
   *     · 每个变量写成「dsh 外观令牌 + 兜底值」的 var()；
   *     · 明暗唯一开关 = prefers-color-scheme（宿主 dshViewHost 用 CDP emulation
   *       把它模拟成当前 IDE 主题 / dsh「外观」，切外观时媒体查询实时重算）；
   *   ⚠ /x/kb/home 是独立 iframe 文档，父文档的 dsh 外观令牌不会跨 iframe 继承 ⇒
   *     fallback 是真正生效的值，必须深/浅两档都给（只给深色正是 marketplace 修掉的 bug）。
   *     页内 script 还会尝试从父页同步父文档真实令牌，成功即像素级对齐周边 IDE 色。
   */
  :root{
    color-scheme:dark;
    --bg:var(--dsw-alias-bg-base,#151517);
    --panel:var(--dsw-alias-bg-layer-1,#232324);
    --panel2:var(--dsw-alias-bg-layer-2,#2c2c2e);
    --line:var(--dsw-alias-border-l1,rgba(255,255,255,.06));
    --line2:var(--dsw-alias-border-l2,rgba(255,255,255,.12));
    --fg:var(--dsw-alias-label-primary,#f9fafb);
    --fg2:var(--dsw-alias-label-secondary,#cfd3d6);
    --fg3:var(--dsw-alias-label-tertiary,#adb2b8);
    --accent:var(--dsw-alias-button-primary-fill,#5b8cff);
    --ok:var(--dsw-alias-state-success-primary,#3fb950);
    --warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  }
  @media (prefers-color-scheme: light){
    :root{
      color-scheme:light;
      --bg:var(--dsw-alias-bg-base,#ffffff);
      /* ★ 2026-11-11：官方浅色把三层表面都定成纯白、边框仅 4% ⇒ 卡片糊成一片。
       *   这里给兜底补层次（略灰表面 + 可见边框），父页注入令牌时再由下方专属块兜底。 */
      --panel:var(--dsw-alias-bg-layer-1,#f7f8fa);
      --panel2:var(--dsw-alias-bg-layer-2,#eceff3);
      --line:var(--dsw-alias-border-l1,rgba(0,0,0,.10));
      --line2:var(--dsw-alias-border-l2,rgba(0,0,0,.16));
      --fg:var(--dsw-alias-label-primary,#0f1115);
      --fg2:var(--dsw-alias-label-secondary,#61666b);
      --fg3:var(--dsw-alias-label-tertiary,#81858c);
      --accent:var(--dsw-alias-button-primary-fill,#2f6bff);
      --ok:var(--dsw-alias-state-success-primary,#1a7f37);
      --warn:var(--dsw-alias-state-warn-primary,#a56a10);
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:22px 24px 60px}
  .hd{display:flex;align-items:flex-end;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .hd h1{margin:0 0 2px;font-size:19px;font-weight:650}
  .hd .sub{font-size:12px;color:var(--fg3)}
  .hd .acts{margin-left:auto;display:flex;gap:8px}
  .btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--line2);background:var(--panel2);color:var(--fg2);font-size:12.5px;cursor:pointer}
  .btn:hover{color:var(--fg)}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
  .st{position:relative;padding:10px 12px;border-radius:10px;background:var(--panel);border:1px solid var(--line);overflow:hidden}
  .st .bar{position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
  .st:nth-child(2) .bar{background:var(--ok)}
  .st .lb{font-size:11px;color:var(--fg3)}
  .st .v{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums}
  .st .v small{font-size:11px;color:var(--fg3);font-weight:500;margin-left:2px}
  .sec{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:13.5px;font-weight:600}
  .sec .c{font-size:11.5px;color:var(--fg3);font-weight:400}
  /* ★ 方案 E：状态化卡片。图标底 40px + 语义 SVG；角标全部绝对定位，不占 flex 流 */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(180px,100%),1fr));gap:12px}
  .card{position:relative;display:flex;flex-direction:column;gap:7px;text-align:left;min-height:124px;padding:11px;background:var(--panel);border:1px solid var(--line);border-radius:11px;cursor:pointer;color:inherit;font:inherit;transition:.15s}
  .card:hover{transform:translateY(-2px);border-color:var(--line2);box-shadow:0 8px 22px rgba(0,0,0,.18)}
  .cb-top{display:flex;align-items:center;gap:10px;min-width:0;padding-right:24px}
  .ci{flex:0 0 auto;position:relative;width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);background:rgba(127,127,127,.10)}
  .ci svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
  .cb-dot{position:absolute;right:-3px;top:-3px;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--panel)}
  .cb-corner{position:absolute;right:9px;top:9px;color:var(--ok);line-height:1;display:flex}
  .cb-corner svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .card.empty{border-style:dashed;border-color:var(--warn)}
  .cb-empty{position:absolute;right:9px;top:9px;font-size:10px;line-height:1.2;color:var(--warn);border:1px solid var(--warn);border-radius:5px;padding:0 4px}
  .cb-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:6px}
  .cb-chip{font-size:10.5px;color:var(--fg2);background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:1px 8px;font-variant-numeric:tabular-nums}
  .nm{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .ex{font-size:11px;color:var(--fg3);margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.45}
  .tm{font-size:10.5px;color:var(--fg3)}
  .card.new{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:124px;border:1.5px dashed var(--line2);background:transparent;color:var(--fg2)}
  .card.new:hover{border-color:var(--accent);color:var(--accent)}
  .card.new .p{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(91,140,255,.14);color:var(--accent);font-size:16px}
  .recent{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
  .r{display:flex;align-items:center;gap:9px;padding:8px 11px;border-top:1px solid var(--line);font-size:12.5px}
  .r:first-child{border-top:0}
  .r .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
  .r .k{color:var(--fg3);font-size:11px}
  .r .tm{color:var(--fg3);font-size:11px;width:64px;text-align:right}
  .empty{padding:26px;text-align:center;color:var(--fg3);border:1px dashed var(--line2);border-radius:10px;margin-top:14px}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(8px);background:var(--panel2);border:1px solid var(--line2);padding:7px 13px;border-radius:9px;font-size:12.5px;opacity:0;pointer-events:none;transition:.2s}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  /* 页内弹窗（Electron 里 window.prompt 会被阻塞/不弹 ⇒ 必须自己画） */
  .mask{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;padding:20px;z-index:40}
  .mask.on{display:flex}
  .modal{width:380px;max-width:100%;background:var(--panel);border:1px solid var(--line2);border-radius:13px;overflow:hidden}
  .modal h3{margin:0;padding:13px 15px;border-bottom:1px solid var(--line);font-size:13.5px;font-weight:600}
  .modal .bd{padding:13px 15px;display:flex;flex-direction:column;gap:10px}
  .modal label{font-size:12px;color:var(--fg2);display:flex;flex-direction:column;gap:5px}
  .modal input{padding:7px 9px;border-radius:7px;border:1px solid var(--line2);background:var(--panel2);outline:none;font-size:12.5px;color:var(--fg)}
  .modal input:focus{border-color:var(--accent)}
  .modal footer{padding:11px 15px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}
  /*
   * ★ 2026-11-11（用户：白色外观下表现不佳）：
   *   dsh 官方浅色把 bg-base / layer-1 / layer-2 全定成纯白、border-l1 仅 4%，
   *   而父页同步进来的 IDE 浅色令牌也可能是同色 ⇒ 卡片与页面糊成一片、只剩文字漂浮。
   *   这里在浅色档用「可见边框 + 轻阴影 + 略深 chip」补回层次；深色档一行不动。
   */
  @media (prefers-color-scheme: light){
    .card,.st,.recent{border-color:rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.05)}
    .card:hover{border-color:rgba(0,0,0,.2);box-shadow:0 6px 18px rgba(0,0,0,.10)}
    .card.new{border-color:rgba(0,0,0,.2)}
    .ci{background:rgba(0,0,0,.045)}
    .cb-chip{background:#eceff3;border-color:rgba(0,0,0,.08)}
    .toast,.modal{box-shadow:0 8px 28px rgba(0,0,0,.14)}
  }
</style></head><body><div class="wrap">
  <div class="hd">
    <div><h1>知识库主页</h1><div class="sub">${esc(vaultName)} · ${kbs.length} 个知识库 · ${noteCount} 篇笔记${emptyCount ? '（' + emptyCount + ' 个空库）' : ''}</div></div>
    <div class="acts">
      <span class="sub" title="明暗跟随 VsSaros 外观设置，本页不再单独切换">外观跟随宿主</span>
      <button class="btn primary" id="newBtn">＋ 新建知识库</button>
    </div>
  </div>
  <div class="stats">
    <div class="st"><span class="bar"></span><div class="lb">知识库</div><div class="v">${kbs.length}<small>个</small></div></div>
    <div class="st"><span class="bar"></span><div class="lb">笔记</div><div class="v">${noteCount}<small>篇</small></div></div>
    <div class="st"><span class="bar"></span><div class="lb">近 7 天改动</div><div class="v">${weekTotal}<small>篇</small></div></div>
    <div class="st"><span class="bar"></span><div class="lb">已绑飞书</div><div class="v">${bound}<small>个</small></div></div>
  </div>
  <div class="sec">全部知识库 <span class="c">${kbs.length} 个</span></div>
  <div class="grid">
    <button class="card new" id="newCard"><span class="p">＋</span><span>新建知识库</span><span style="font-size:11px;color:var(--fg3)">建文件夹 · 关联飞书</span></button>
    ${cards}
  </div>
  ${kbs.length
		? '<div class="sec" style="margin-top:22px">最近更新 <span class="c">按库</span></div><div class="recent">' + recent + '</div>'
		: '<div class="empty">这个库还没有知识库：点上面「新建知识库」开始。</div>'}
</div>
<div class="mask" id="mask">
  <div class="modal">
    <h3>新建知识库（在「知识库列表」下建文件夹）</h3>
    <div class="bd">
      <label>名称<input id="kbname" placeholder="例如：团队 UI 知识库" maxlength="64" /></label>
      <label>关联飞书（可选）<input id="kbspace" placeholder="wiki 空间 ID 或粘贴空间链接" /></label>
    </div>
    <footer><button class="btn" id="cancel">取消</button><button class="btn primary" id="ok">创建</button></footer>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var PREFIX = ${JSON.stringify(prefix)};
  var t = document.getElementById('toast'), tt = 0;
  function toast(m){ t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(function(){ t.classList.remove('on'); }, 1900); }
  /*
   * ★ 2026-11-11：明暗不再由本页单独切换，改为跟随宿主外观。
   *   CSS 已用两档 var() + prefers-color-scheme 兜底；这里再尝试把父文档里被宿主
   *   钉过的真实令牌同步进来（同源 iframe 才拿得到）⇒ 与周边 IDE 色像素级一致。
   *   拿不到（跨域 / sandbox / 父页无令牌）就静默用 CSS 兜底，明暗仍由媒体查询跟随。
   */
  var HOST_TOKENS = ['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-bg-layer-2',
    '--dsw-alias-border-l1','--dsw-alias-border-l2','--dsw-alias-label-primary',
    '--dsw-alias-label-secondary','--dsw-alias-label-tertiary',
    '--dsw-alias-button-primary-fill','--dsw-alias-state-success-primary'];
  function syncHostTheme(){
    try {
      var p = window.parent;
      if (!p || p === window || !p.document || !p.document.documentElement) { return; }
      var cs = p.getComputedStyle(p.document.documentElement);
      var root = document.documentElement;
      for (var i = 0; i < HOST_TOKENS.length; i++) {
        var name = HOST_TOKENS[i], v = cs && cs.getPropertyValue(name).trim();
        if (v) { root.style.setProperty(name, v); } else { root.style.removeProperty(name); }
      }
    } catch (e) { /* 跨域 / 无令牌 ⇒ 用 CSS 两档兜底 */ }
  }
  syncHostTheme();
  /* 宿主切外观时重新同步：父文档自定义事件 + 系统配色变化 + 同源 storage 广播 */
  try {
    var pd = window.parent && window.parent.document;
    if (pd && pd.addEventListener) { pd.addEventListener('vssaros-dsh-theme', syncHostTheme); }
  } catch (e) { /* 忽略 */ }
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) { mq.addEventListener('change', syncHostTheme); }
    else if (mq.addListener) { mq.addListener(syncHostTheme); }
  } catch (e) { /* 老内核 */ }
  window.addEventListener('storage', function(ev){ if (!ev || ev.key === 'vssaros.theme') { syncHostTheme(); } });
  /*
   * 新建：**页内弹窗**，不用 window.prompt
   *   （Electron 的 prompt 会被阻塞甚至不弹 ⇒ 点了像没反应；本仓多处踩过，见 client.js 注释）
   */
  var mask = document.getElementById('mask'), nameEl = document.getElementById('kbname'), spaceEl = document.getElementById('kbspace');
  function openDialog(){ mask.classList.add('on'); nameEl.value = ''; spaceEl.value = ''; setTimeout(function(){ nameEl.focus(); }, 30); }
  function closeDialog(){ mask.classList.remove('on'); }
  function create(){
    var name = String(nameEl.value || '').trim();
    if (!name) { nameEl.focus(); toast('先给知识库起个名字'); return; }
    fetch(PREFIX + '/api/kb-create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: name }) })
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(j){
        if (!j || !j.ok) { toast((j && j.error) || '创建失败'); return; }
        var sp = String(spaceEl.value || '').trim();
        var done = function(){ toast('已创建「' + j.name + '」'); setTimeout(function(){ location.reload(); }, 700); };
        if (!sp) { closeDialog(); done(); return; }
        // 关联飞书：支持粘链接（抽数字）或裸 ID
        var sid = (sp.match(/(\\d{6,})/) || [])[1] || sp;
        fetch(PREFIX + '/api/kb-bind', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ kb: j.name, spaceId: sid, spaceName: name }) })
          .then(function(r){ return r.json().catch(function(){ return {}; }); })
          .then(function(b){ if (!b || !b.ok) { toast('库已建好，但关联飞书失败：' + ((b && b.error) || '')); } closeDialog(); done(); })
          .catch(function(){ closeDialog(); done(); });
      })
      .catch(function(e){ toast('创建失败：' + ((e && e.message) || e)); });
  }
  document.getElementById('newBtn').onclick = openDialog;
  document.getElementById('newCard').onclick = openDialog;
  document.getElementById('cancel').onclick = closeDialog;
  document.getElementById('ok').onclick = create;
  mask.addEventListener('click', function(e){ if (e.target === mask) { closeDialog(); } });
  nameEl.addEventListener('keydown', function(e){ if (e.key === 'Enter') { create(); } });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { closeDialog(); } });
  /*
   * 点卡片 ⇒ 让**侧栏**定位到该知识库（主页在 iframe 里，只能靠 postMessage）。
   * 父窗口（面板）收到 source:'kb-home' 的消息会展开「知识库列表」并展开那个节点。
   * 不在 iframe 里（例如直接浏览器打开）时退回 toast，别静默。
   */
  Array.prototype.forEach.call(document.querySelectorAll('[data-kb]'), function(el){
    el.onclick = function(){
      var kb = el.getAttribute('data-kb');
      /*
       * ★ 2026-11-12（用户：点卡片弹出两个定位 tip、左侧树却没跳）：
       *   旧版同时发 postMessage + localStorage 广播，父页两个监听器各处理一次；
       *   父页 applyFocus 又用「切换展开」⇒ 两次切换 = 展开又收起，净效果为零 ✗。
       *   两条通道仍要保留（覆盖层 / 独立页签两种宿主形态），但带**同一个 id** 让父页去重；
       *   iframe 不再自己弹 toast ⇒ 全局只剩父页一条反馈。
       *   ⚠ 这段在模板字符串内部 ⇒ 注释里不许出现反引号（会提前结束模板 ✗）
       */
      var id = 'kb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      var embedded = !!(window.parent && window.parent !== window);
      try {
        if (embedded) {
          window.parent.postMessage({ source: 'kb-home', type: 'open-kb', kb: kb, id: id }, '*');
        }
      } catch (e) { /* 跨域等异常 ⇒ 继续走广播 */ }
      try {
        localStorage.setItem('vssaros.kb.focus', JSON.stringify({ kb: kb, id: id, at: Date.now() }));
      } catch (e) { /* 无 localStorage 就只剩 postMessage */ }
      // 只有直接打开（不在 iframe 里）才由本页兜底给反馈；嵌入时统一交给父页，避免双 toast
      if (!embedded) { toast('已在左侧定位「' + kb + '」'); }
    };
  });
})();
</script></body></html>`;
}

export { when as relativeTime };
