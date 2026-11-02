/*
 * 知识库「主页」页面渲染（★ 2026-11-02）
 *
 * 谁用它：`/x/kb/home` 路由 —— 中间栏的 KbHomeEditorPane 用同源 iframe 加载它。
 * 为什么在这里渲染：库清单 / 篇数 / 是否已绑飞书 这些数据本来就只在插件侧有，
 *   页面直取即可，不必再造一套「IDE ↔ 插件」的取数协议。
 *
 * 纯函数（进数据、出 HTML 字符串），方便单测与守卫。
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 按库名生成确定性封面渐变（同一个库每次颜色一致，不会闪） */
function coverOf(name) {
	let h = 0;
	for (let i = 0; i < String(name).length; i += 1) { h = (h * 31 + String(name).charCodeAt(i)) >>> 0; }
	const hue = h % 360;
	return `linear-gradient(135deg, hsl(${hue} 45% 34%), hsl(${hue + 26} 38% 18%))`;
}

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

	const cards = kbs.map((k) => `
		<button class="card" data-kb="${esc(k.name)}">
			<div class="cv" style="background:${coverOf(k.name)}"></div>
			<div class="bd">
				<div class="nm">${esc(k.name)}</div>
				${k.excerpt ? `<div class="ex">${esc(k.excerpt)}</div>` : ''}
				<div class="mt">
					<span>${k.docs || 0} 篇</span>
					${k.weekNew ? `<span class="wk">7 天 +${k.weekNew}</span>` : ''}
					${k.hasFeishu ? '<span class="fb">🔗 飞书</span>' : ''}
				</div>
				<div class="tm">${esc(when(k.updatedAt))}</div>
			</div>
		</button>`).join('');

	const recent = kbs.slice(0, 8).map((k) => `
		<div class="r"><span class="nm">${esc(k.name)}</span><span class="k">${k.docs || 0} 篇</span><span class="tm">${esc(when(k.updatedAt))}</span></div>`).join('');

	return `<!doctype html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<style>
  :root[data-theme="dark"]{--bg:#15161a;--panel:#1c1d22;--panel2:#22232a;--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.18);--fg:#e8e9ec;--fg2:#a9abb3;--fg3:#71737c;--accent:#5b8cff;--ok:#3fb950}
  :root[data-theme="light"]{--bg:#f5f6f8;--panel:#fff;--panel2:#f0f2f5;--line:rgba(0,0,0,.09);--line2:rgba(0,0,0,.17);--fg:#1b1d22;--fg2:#5a5e68;--fg3:#8b8f99;--accent:#2f6bff;--ok:#1a7f37}
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
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
  .card{text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:11px;overflow:hidden;cursor:pointer;padding:0;color:inherit;font:inherit}
  .card:hover{transform:translateY(-2px);border-color:var(--line2);box-shadow:0 8px 22px rgba(0,0,0,.25)}
  .cv{height:78px}
  .bd{padding:9px 10px 11px}
  .nm{font-size:12.5px;font-weight:600}
  .mt{font-size:11px;color:var(--fg3);margin-top:2px;display:flex;gap:6px}
  .fb{color:var(--ok)}
  .wk{color:var(--accent)}
  .ex{font-size:11px;color:var(--fg3);margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.45}
  .tm{font-size:10.5px;color:var(--fg3);margin-top:2px}
  .card.new{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:146px;border:1.5px dashed var(--line2);background:transparent;color:var(--fg2)}
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
</style></head><body><div class="wrap">
  <div class="hd">
    <div><h1>知识库主页</h1><div class="sub">${esc(vaultName)} · ${kbs.length} 个知识库 · ${noteCount} 篇笔记${emptyCount ? '（' + emptyCount + ' 个空库）' : ''}</div></div>
    <div class="acts">
      <button class="btn" id="theme">☀ 明暗</button>
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
  document.getElementById('theme').onclick = function(){
    var r = document.documentElement;
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
  };
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
       * 通知"侧栏"定位到该库。两种宿主形态都要覆盖：
       *   ① 覆盖层模式：主页 iframe 的 parent 就是 KB 页面 ⇒ postMessage 直达 ✓
       *   ② 独立页签模式：parent 是**壳**，KB 页面在另一个文档 ⇒ postMessage 到不了 ✗
       *      ⇒ 补一条 localStorage 广播（同源跨文档，storage 事件会在别的文档触发 ✓）
       *      ⚠ 这段在**模板字符串内部** ⇒ 注释里不许出现反引号（会提前结束模板 ✗）
       */
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ source: 'kb-home', type: 'open-kb', kb: kb }, '*');
        }
      } catch (e) { /* 跨域等异常 ⇒ 继续走广播 */ }
      try {
        localStorage.setItem('vssaros.kb.focus', JSON.stringify({ kb: kb, at: Date.now() }));
      } catch (e) { /* 无 localStorage 就只剩 postMessage */ }
      toast('已在左侧定位「' + kb + '」');
    };
  });
})();
</script></body></html>`;
}

export { when as relativeTime, coverOf as homeCoverOf };
