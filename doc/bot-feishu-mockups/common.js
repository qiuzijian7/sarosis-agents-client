/* 多方案 mockup 共用的示意数据与交互（纯前端内存态，不读写任何真实数据）。
   ★ 2026-11-10 规格修订：不再有「全局应用池」这一层 UI / 概念，也没有 bot→appId 映射。
     「绑定」= 这个 Bot 的一条 (飞书应用 + chat_id) 记录；应用可选「已有应用」或就地「添加新应用」。 */
(function () {
  'use strict';

  var SCHEMES = {
    a: {
      title: 'A · 顶层页签独立一项',
      where: '会话视图顶部页签条：「飞书」与「设置」并列，成为第 6 项。',
      good: '一眼可见、与其它页签同级；绑定页独占整屏，配置空间最大。',
      bad: '页签由 6 项变 7 项，窄容器要换行；每个 Bot 会话都多一个页签。',
      ref: '对齐用户截图的顶部页签条（对话/轨迹/记忆/技能/待办/设置）。'
    },
    b: {
      title: 'B · 设置页左侧分组导航',
      where: '顶层页签不变；「设置」页内加一列分组导航，飞书是其中一项。',
      good: '与 dsh 设置弹窗左导航、SuperAgent SettingsPage 的 SETTINGS_GROUPS 同构；顶层不增页签。',
      bad: '多一层层级（点「设置」→ 再点「飞书配置」）；窄容器侧栏要降级成横排。',
      ref: '对齐 design/channel-mockups/b-master-detail.html 的主从结构与官方设置弹窗左导航。'
    },
    c: {
      title: 'C · 设置页顶部分段',
      where: '顶层页签不变；「设置」页顶部一排分段按钮，飞书是其中一段。',
      good: '层级最浅、改动面最小；窄容器分段换行即可，不需要侧栏。',
      bad: '分组再多会挤；视觉上「飞书」不如独立页签显眼。',
      ref: '对齐 doc/dsh-settings-models-providers-mockup.html 的 .seg 分段控件。'
    },
    d: {
      title: 'D · 设置页集成项列表 → 就地展开',
      where: '「设置」页里是一列集成项，「飞书配置」就是其中一项，点开就地展开绑定面板。',
      good: '最贴合「为一项」的字面意思；以后加 Telegram / Discord 只要加一行。',
      bad: '多一次点击才进配置；展开后设置页会变长。',
      ref: '对齐官方设置页的分组行列表（ul.rows / li.row）。'
    }
  };

  /* 已有应用只作为「选择已有应用」的下拉数据源，不在界面上单列展示、也不叫池。 */
  var apps = [
    { id: 'cli_aa8b38921fa35b04', name: '主应用', def: true, secret: true, gp: 'open' },
    { id: 'cli_bb7c29013de44a91', name: '评测专用', def: false, secret: true, gp: 'allowlist' },
    { id: 'cli_cc9d18024ef55b82', name: '待补 Secret', def: false, secret: false, gp: 'open' }
  ];
  /* 群策略枚举逐字对齐 imPlatforms.js 的 feishu.fields[groupPolicy]（单一真源，不另立口径）。 */
  var GROUP_POLICIES = [
    { value: 'open', label: 'open：群里可用（需 @ 机器人）' },
    { value: 'allowlist', label: 'allowlist：只在指定群（需配 rooms）' },
    { value: 'disabled', label: 'disabled：群里不响应' }
  ];
  var policyOptions = function (sel) {
    return GROUP_POLICIES.map(function (o) {
      return '<option value="' + o.value + '"' + (o.value === sel ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  };
  var botNames = { coder: 'Coder', architect: 'Architect', superagent: 'SuperAgent' };
  /* 每个 Bot 自己的「绑定」列表：一条 = (应用, chat_id, 会话类型)。 */
  var binds = {
    coder: [{ id: 'b1', appId: '', chatId: 'oc_5f2a9d1c3e7b40', chatType: 'group', gp: 'open', enabled: true }],
    architect: [{ id: 'b2', appId: 'cli_bb7c29013de44a91', chatId: 'oc_88c1e2f4a6d903', chatType: 'group', gp: 'allowlist', enabled: true }],
    superagent: []
  };
  var S = { scheme: 'a', bot: 'coder', nav: 'feishu', width: '980', app: '', chatId: '', chatType: 'group', dirty: false };
  var seq = 3;
  var embed = /[?&]embed=1/.test(window.location.search);

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var appOf = function (id) { for (var i = 0; i < apps.length; i++) { if (apps[i].id === id) return apps[i]; } return null; };
  var usable = function (a) { return !!(a && a.secret); };
  var appLabel = function (id) {
    if (!id) return 'VsSaros助手';
    var a = appOf(id);
    return a && a.name ? a.name + ' · ' + id : id;
  };
  var myBinds = function () { return binds[S.bot] || []; };

  /* ── 内容片段 ───────────────────────────────────────────────────────── */
  function feishuHTML() {
    return [
      '<section class="fm-panel" id="fm-panel-feishu">',
      '<div class="fm-phead"><h2>飞书绑定</h2><span class="fm-badge" id="fm-bindcount"></span></div>',
      '<p class="fm-psub">一条「绑定」= 这个 Bot 用哪个飞书应用接哪个会话。<b>应用</b>可以选已有的，也可以就地添加新应用；<b>chat_id</b> 填要接入的飞书会话。App Secret 只写不读，明文不回显。</p>',
      '<div class="fm-grid">',
      /* ① 主卡：绑定（原「当前 Bot 选用的应用」） */
      '<div class="fm-card">',
      '<h3>绑定</h3>',
      '<p class="fm-hint">下面是这个 Bot 已经配置的绑定；新增、删除都只影响当前 Bot。</p>',
      '<div class="fm-bindlist" id="fm-bindlist"></div>',
      '</div>',
      /* ② 新建绑定：选已有应用 / 添加新应用 + chat_id */
      '<div class="fm-card">',
      '<h3>新建绑定</h3>',
      '<p class="fm-hint">选一个已配置过的应用，或选「+ 添加新应用」直接填 App ID / App Secret。</p>',
      '<div class="fm-fld"><label for="fm-apppick">应用</label><select id="fm-apppick"></select></div>',
      '<div class="fm-newform" id="fm-newform" hidden>',
      '<div class="fm-fld"><label for="fm-nid">App ID</label><input id="fm-nid" placeholder="cli_xxxxxxxx"></div>',
      '<div class="fm-fld"><label for="fm-nsec">App Secret</label><input id="fm-nsec" type="password" placeholder="只写不读"></div>',
      '<div class="fm-fld"><label for="fm-nname">名称</label><input id="fm-nname" placeholder="可选，便于下次在下拉里认出"></div>',
      '<div class="fm-fld"><label for="fm-ngp">群策略</label><select id="fm-ngp">' + policyOptions('open') + '</select></div>',
      '<p class="fm-hint">作为用这个应用新建绑定时的默认群策略；每条绑定仍可单独覆盖。</p>',
      '</div>',
      '<div class="fm-fld"><label for="fm-chatid">chat_id</label><input id="fm-chatid" placeholder="oc_…（飞书会话 ID）"></div>',
      '<div class="fm-fld"><label for="fm-chattype">会话类型</label><select id="fm-chattype"><option value="group">群聊（需 @ 机器人）</option><option value="p2p">私聊</option></select></div>',
      '<div class="fm-fld"><label for="fm-gp">群策略</label><select id="fm-gp">' + policyOptions('open') + '</select></div>',
      '<div class="fm-fld"><label for="fm-allow">入站白名单</label><input id="fm-allow" placeholder="逗号分隔 userId；留空 = 拒绝所有入站（fail-closed）"></div>',
      '<div class="fm-actions"><button class="fm-btn pri" id="fm-savebind">保存绑定</button><button class="fm-btn" id="fm-resetbind">清空表单</button></div>',
      '<div class="fm-feedback" id="fm-bindfb" aria-live="polite"></div>',
      '</div></div>',
      '<div class="fm-contract">落盘：<code>agent-bindings.json</code> 每条绑定存 <code>appId</code> / <code>chatId</code> / <code>groupPolicy</code> / <code>targetId</code>（当前 Bot）；应用凭据在 <code>agent-im-accounts.json</code>。写口：<code>action:\'create\'</code> 建绑定、<code>action:\'feishu-app\'</code> 添加新应用。<b>groupPolicy 生效在绑定级</b>（channelPolicy.js），枚举来自 imPlatforms 单一真源、默认 open；不要放进 feishu-app（那个 action 只存 appSecret/name，存了不生效）。绑定直接带 appId（空 = VsSaros助手），已有应用只作为「选择已有应用」的下拉可选项。</div>',
      '</section>'
    ].join('');
  }

  function settingsHTML() {
    return [
      '<section class="fm-panel"><div class="fm-phead"><h2>Bot 配置</h2><span class="fm-badge">对照页</span></div>',
      '<p class="fm-psub">飞书「绑定」（应用 + chat_id）已并入飞书页，这一页只保留 Bot 定义。</p>',
      '<div class="fm-grid">',
      '<div class="fm-card"><h3>Bot 配置</h3><p class="fm-hint">名称 / 描述 / 角色 / 模型 / 技能 / 人设，写回 .agent.md。</p>',
      '<div class="fm-fld"><label>名称</label><input value="Coder" readonly></div>',
      '<div class="fm-fld"><label>模型</label><input value="vssaros-codebuddy/hy4" readonly></div>',
      '<div class="fm-fld"><label>技能</label><input value="anysearch, analysis" readonly></div></div>',
      '<div class="fm-card"><h3>飞书绑定</h3><p class="fm-hint">已移到「飞书」页：在那里选应用 / 添加新应用并配置 chat_id。</p>',
      '<div class="fm-placeholder">不在这里重复配置</div></div>',
      '</div></section>'
    ].join('');
  }

  function otherHTML() { return '<section class="fm-panel"><div class="fm-placeholder">该分组保持现状，本稿不改动。点「飞书配置」查看本方案的核心改动。</div></section>'; }

  /* ── 各方案的导航骨架 ───────────────────────────────────────────────── */
  function tab(label, nav, isNew) {
    return '<button class="fm-tab" data-nav="' + nav + '">' + label + (isNew ? '<span class="fm-new">一项</span>' : '') + '</button>';
  }
  function topTabs(scheme) {
    var h = '<div class="fm-tabs" id="fm-tabs">';
    h += tab('对话', 'other') + tab('轨迹', 'other') + tab('记忆', 'other') + tab('技能', 'other') + tab('待办', 'other');
    if (scheme === 'a') { h += tab('飞书', 'feishu', true); }
    h += tab('设置', scheme === 'a' ? 'settings' : 'feishu');
    h += '<span class="fm-tabs-spacer"></span><span class="fm-tabs-note">窄容器页签完整换行</span></div>';
    return h;
  }
  function navItems(kind) {
    var items = [
      { label: 'Bot 配置', nav: 'settings', desc: '名称 / 模型 / 技能 / 人设' },
      { label: '飞书配置', nav: 'feishu', desc: '绑定 = 应用 + chat_id' },
      { label: '其它渠道', nav: 'other', desc: 'Telegram / 企业微信（保持现状）' }
    ];
    return items.map(function (it) {
      var count = it.nav === 'feishu' ? (binds[S.bot] || []).length + ' 条' : '';
      if (kind === 'row') {
        return '<div class="fm-itemrow" data-nav="' + it.nav + '" tabindex="0" role="button"><span class="fm-itemico">' + (it.nav === 'feishu' ? 'Fs' : '·') + '</span><span class="fm-itemtext"><b>' + it.label + '</b><span>' + it.desc + '</span></span><span class="fm-itemact">配置 ›</span></div>';
      }
      return '<button class="fm-navitem" data-nav="' + it.nav + '"><span class="fm-navdot"></span>' + it.label + '<span class="fm-navcount">' + count + '</span></button>';
    }).join('');
  }
  function middleHTML(scheme) {
    if (scheme === 'b') {
      return '<div class="fm-split"><div class="fm-sidenav" id="fm-innernav"><div class="fm-navttl">Bot 设置分组</div>' + navItems('side') + '</div><div class="fm-content"><div class="fm-body" id="fm-content"></div></div></div>';
    }
    if (scheme === 'c') {
      return '<div class="fm-segnav" id="fm-innernav">' + navItems('seg') + '</div><div class="fm-body" id="fm-content"></div>';
    }
    if (scheme === 'd') {
      return '<div class="fm-itemlist" id="fm-innernav">' + navItems('row') + '</div><div class="fm-expand" id="fm-expand"><div class="fm-body" id="fm-content"></div></div>';
    }
    return '<div class="fm-body" id="fm-content"></div>';
  }

  function ctlHTML() {
    return '<div class="fm-ctl">' +
      '<div class="fm-ctl-grp"><span>容器宽度</span><div class="fm-seg" id="fm-wseg"><button data-w="980" class="on">980 · 宽</button><button data-w="760">760 · 中栏</button><button data-w="520">520 · 窄</button></div></div>' +
      '<div class="fm-ctl-grp"><span>当前 Bot</span><div class="fm-seg" id="fm-botseg"><button data-bot="coder" class="on">Coder</button><button data-bot="architect">Architect</button><button data-bot="superagent">SuperAgent</button></div></div>' +
      '<div class="fm-ctl-grp"><span>外观</span><div class="fm-seg" id="fm-themseg"><button data-theme="light" class="on">浅色</button><button data-theme="dark">深色</button></div></div>' +
      '<div class="fm-ctl-grp"><span>自证</span><span id="fm-probe">— 待检查</span></div></div>';
  }

  function docHTML(scheme) {
    var s = SCHEMES[scheme];
    return '<div class="fm-doc">' +
      '<span class="fm-banner">MOCKUP · 纯示意，非实现代码 · 确认方案后才改生产代码</span>' +
      '<h1>' + s.title + '</h1>' +
      '<p class="fm-lead"><b>本轮修订</b>：去掉「全局应用池」与 bot→应用映射；原「当前 Bot 选用的应用」改名为<b>「绑定」</b>，一条绑定 = 选择已有应用（或添加新应用）+ 配置 chat_id。</p>' +
      '<p class="fm-lead"><b>「一项」的位置：</b>' + s.where + '</p>' +
      '<p class="fm-ref"><b>权威参考</b>：① 用户现状截图 <code>image.919b0ec3c3.png</code>（浅色会话视图，顶部页签条）；② <code>doc/dsh-settings-models-providers-mockup.html</code>（官方设置页实测色值）；③ <code>design/channel-mockups/b-master-detail.html</code>（主从结构）。<br>' + s.ref + '<br><b>数据契约</b>：绑定存 <code>agent-bindings.json</code>（<code>appId</code> / <code>chatId</code> / <code>targetId</code>），应用凭据存 <code>agent-im-accounts.json</code>，已有应用仅作下拉可选项；Secret 明文永不回传。四个方案共用同一份数据与交互。</p>' +
      '<div class="fm-trade"><div><b>取舍 · 优点</b><span class="good">' + s.good + '</span></div><div><b>取舍 · 代价</b><span class="bad">' + s.bad + '</span></div></div>' +
      '</div>';
  }

  function footHTML() {
    return '<p class="fm-foot">这是 MOCKUP（纯 HTML/CSS/JS 示意），不读写真实数据。四款方案对比见 <code>index.html</code>。需求：移除设置弹窗「渠道」页签 · 各 Bot 的飞书配置作为一项 · 不展示全局应用池 ·「绑定」= 已有/新应用 + chat_id。</p>';
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */
  function renderSelect() {
    var sel = $('fm-apppick'); if (!sel) return;
    var opts = ['<optgroup label="已有应用"><option value="">VsSaros助手</option>'];
    apps.forEach(function (a) {
      if (a.def) return;
      opts.push('<option value="' + esc(a.id) + '"' + (usable(a) ? '' : ' disabled') + '>' + esc(a.name ? a.name + ' · ' : '') + esc(a.id) + (usable(a) ? '' : '（缺 App Secret）') + '</option>');
    });
    opts.push('</optgroup><optgroup label="添加"><option value="__new__">+ 添加新应用…</option></optgroup>');
    sel.innerHTML = opts.join('');
    sel.value = S.app;
    var nf = $('fm-newform'); if (nf) nf.hidden = (S.app !== '__new__');
  }
  function renderBindings() {
    var box = $('fm-bindlist'); if (!box) return;
    var list = myBinds();
    if (!list.length) {
      box.innerHTML = '<div class="fm-placeholder">这个 Bot 还没有绑定。在右侧选应用并填 chat_id 后点「保存绑定」。</div>';
    } else {
      box.innerHTML = list.map(function (b) {
        var a = appOf(b.appId);
        var state = !a || a.def || a.secret ? 'ok' : 'warn';
        return '<div class="fm-bindrow" data-bind="' + esc(b.id) + '">' +
          '<span class="fm-bindmain"><b>' + esc(appLabel(b.appId)) + '</b><span class="fm-mono">' + esc(b.chatId) + '</span><span class="fm-mono">群策略：' + esc(b.gp || 'open') + '</span></span>' +
          '<span class="fm-state ' + state + '"><i></i>' + (b.enabled === false ? '停用' : (b.chatType === 'group' ? '群聊' : '私聊')) + '</span>' +
          '<button class="fm-btn" data-del="' + esc(b.id) + '" title="删除这条绑定">删除</button>' +
          '</div>';
      }).join('');
    }
    if ($('fm-bindcount')) $('fm-bindcount').textContent = list.length + ' 条绑定';
    /* B/C/D 内部导航里的条数徽标也跟着当前 Bot 变 */
    Array.prototype.forEach.call(document.querySelectorAll('.fm-navitem[data-nav="feishu"] .fm-navcount'), function (n) {
      n.textContent = list.length + ' 条';
    });
  }
  function renderForm() {
    if ($('fm-chatid') && !S.dirty) $('fm-chatid').value = S.chatId;
    if ($('fm-chattype')) $('fm-chattype').value = S.chatType;
  }
  function updateNav() {
    var nodes = document.querySelectorAll('[data-nav]');
    Array.prototype.forEach.call(nodes, function (n) {
      var want = n.getAttribute('data-nav');
      var on = want === S.nav;
      if (n.classList.contains('fm-tab') && S.scheme !== 'a' && want === 'feishu') on = true;
      n.classList.toggle('on', on);
    });
    if ($('fm-expand')) $('fm-expand').hidden = !(S.scheme === 'd' && S.nav !== 'other');
    if ($('fm-innernav')) $('fm-innernav').hidden = (S.nav === 'other');
    if ($('fm-botchip')) $('fm-botchip').textContent = 'Bot: ' + botNames[S.bot];
  }
  function renderContent() {
    var box = $('fm-content'); if (!box) return;
    box.innerHTML = S.nav === 'feishu' ? feishuHTML() : S.nav === 'settings' ? settingsHTML() : otherHTML();
    refreshData();
  }
  /* 只刷新数据，不重建面板：就地反馈与正在输入的表单才不会被冲掉。 */
  function refreshData() { renderSelect(); renderBindings(); renderForm(); updateNav(); probe(); }
  function renderAll() { renderContent(); }

  /* 自证探针：窄容器无横向溢出 / 导航项完整可见 / 卡片不被压成几十像素 */
  function probe() {
    var el = $('fm-probe'); if (!el) return;
    var navs = document.querySelectorAll('.fm-tab, .fm-navitem, .fm-itemrow');
    var allVisible = true;
    Array.prototype.forEach.call(navs, function (n) {
      if (n.hidden || n.closest('[hidden]')) return;
      var r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 18) allVisible = false;
    });
    var stage = $('fm-stage');
    var stageW = stage ? Math.round(stage.getBoundingClientRect().width) : 0;
    var card = document.querySelector('#fm-content .fm-card');
    var cardW = card ? Math.round(card.getBoundingClientRect().width) : 999;
    var overflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    var ok = allVisible && !overflow && cardW > 230;
    el.textContent = (ok ? '✓' : '✗') + ' 导航 ' + navs.length + ' 项可见 · 卡 ' + cardW + 'px · 舞台 ' + stageW + 'px · ' + (overflow ? '横向溢出' : '无溢出');
    el.style.color = ok ? '#187a3b' : 'var(--red)';
  }

  function feedback(kind, text) {
    var el = $('fm-bindfb'); if (!el) return;
    el.className = 'fm-feedback ' + (kind || '');
    el.textContent = text || '';
  }

  /* ── 事件（document 级委托，动态内容无需重绑）─────────────────────── */
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('button, .fm-itemrow, [data-nav]') : null;
    if (!t) return;
    if (t.hasAttribute('data-del')) {
      var delId = t.getAttribute('data-del');
      binds[S.bot] = myBinds().filter(function (b) { return b.id !== delId; });
      feedback('ok', '已删除这条绑定');
      refreshData(); return;
    }
    if (t.hasAttribute('data-nav')) {
      S.nav = t.getAttribute('data-nav'); renderAll(); return;
    }
    if (t.id === 'fm-resetbind') {
      S.app = ''; S.chatId = ''; S.chatType = 'group'; S.dirty = false;
      $('fm-chatid').value = ''; $('fm-allow').value = '';
      $('fm-nid').value = ''; $('fm-nsec').value = ''; $('fm-nname').value = '';
      if ($('fm-gp')) $('fm-gp').value = 'open';
      if ($('fm-ngp')) $('fm-ngp').value = 'open';
      feedback('', ''); refreshData(); return;
    }
    if (t.id === 'fm-savebind') {
      var appId = S.app;
      var chatId = String($('fm-chatid').value || '').trim();
      var chatType = String($('fm-chattype').value || 'group');
      var gp = String(($('fm-gp') && $('fm-gp').value) || 'open');
      S.chatId = chatId; S.chatType = chatType; S.dirty = true;
      if (appId === '__new__') {
        var nid = String($('fm-nid').value || '').trim();
        var sec = String($('fm-nsec').value || '').trim();
        var nm = String($('fm-nname').value || '').trim();
        if (!/^cli_[A-Za-z0-9]{4,64}$/.test(nid) || !sec) {
          feedback('err', '✗ 请填合法 App ID（cli_…）与 App Secret'); return;
        }
        if (appOf(nid)) { feedback('err', '✗ 这个 App ID 已配置过，请直接在下拉里选它'); return; }
        var ngp = String(($('fm-ngp') && $('fm-ngp').value) || 'open');
        apps.push({ id: nid, name: nm, def: false, secret: true, gp: ngp });
        if ($('fm-gp')) { $('fm-gp').value = ngp; }
        gp = ngp;
        appId = nid;
      }
      if (!chatId) { feedback('err', '✗ 请填 chat_id（oc_…）'); return; }
      binds[S.bot] = myBinds().concat([{
        id: 'b' + (seq++), appId: appId, chatId: chatId, chatType: chatType, gp: gp, enabled: true
      }]);
      S.app = appId; S.chatId = ''; S.chatType = 'group'; S.dirty = false;
      $('fm-chatid').value = ''; $('fm-allow').value = '';
      $('fm-nid').value = ''; $('fm-nsec').value = ''; $('fm-nname').value = '';
      feedback('ok', '✓ 已保存绑定：' + appLabel(appId) + ' → ' + chatId + ' · groupPolicy=' + gp);
      refreshData(); return;
    }
    if (t.hasAttribute('data-w')) {
      S.width = t.getAttribute('data-w'); $('fm-stage').setAttribute('data-w', S.width);
      Array.prototype.forEach.call($('fm-wseg').querySelectorAll('button'), function (x) { x.classList.toggle('on', x === t); });
      probe(); return;
    }
    if (t.hasAttribute('data-bot')) {
      S.bot = t.getAttribute('data-bot'); S.app = ''; S.chatId = ''; S.chatType = 'group'; S.dirty = false;
      Array.prototype.forEach.call($('fm-botseg').querySelectorAll('button'), function (x) { x.classList.toggle('on', x === t); });
      if ($('fm-chatid')) $('fm-chatid').value = '';
      if ($('fm-allow')) $('fm-allow').value = '';
      if ($('fm-gp')) $('fm-gp').value = 'open';
      feedback('', ''); refreshData(); return;
    }
    if (t.hasAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', t.getAttribute('data-theme'));
      Array.prototype.forEach.call($('fm-themseg').querySelectorAll('button'), function (x) { x.classList.toggle('on', x === t); });
      probe(); return;
    }
  }
  function onChange(e) {
    if (!e.target) return;
    if (e.target.id === 'fm-apppick') {
      S.app = e.target.value;
      var nf = $('fm-newform'); if (nf) { nf.hidden = (S.app !== '__new__'); if (S.app === '__new__') $('fm-nid').focus(); }
      /* 选已有应用 ⇒ 绑定表单跟随该应用的默认群策略；选「添加新应用」⇒ 跟随新应用表单里的值。 */
      var a = appOf(S.app);
      var gp = S.app === '__new__' ? String(($('fm-ngp') && $('fm-ngp').value) || 'open') : (a ? a.gp : 'open');
      if ($('fm-gp')) $('fm-gp').value = gp || 'open';
      feedback('', ''); probe(); return;
    }
    if (e.target.id === 'fm-ngp') { if ($('fm-gp')) $('fm-gp').value = e.target.value; }
    if (e.target.id === 'fm-chatid') { S.chatId = e.target.value; S.dirty = true; }
    if (e.target.id === 'fm-chattype') { S.chatType = e.target.value; }
  }
  function onKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var r = e.target && e.target.closest ? e.target.closest('.fm-itemrow[data-nav]') : null;
    if (r) { e.preventDefault(); onClick({ target: r }); }
  }

  window.FM = {
    SCHEMES: SCHEMES,
    init: function (scheme) {
      S.scheme = SCHEMES[scheme] ? scheme : 'a';
      if (embed) document.body.setAttribute('data-embed', '1');
      var root = $('fm-root');
      root.innerHTML = (embed ? '' : docHTML(S.scheme)) + (embed ? '' : ctlHTML()) +
        '<div class="fm-stage" id="fm-stage" data-w="' + S.width + '">' +
        '<div class="fm-stage-hd"><span class="fm-dot"></span><span>会话视图 · Bot 作用域</span><span class="fm-grow"></span><span class="fm-botchip" id="fm-botchip"></span></div>' +
        topTabs(S.scheme) + middleHTML(S.scheme) + '</div>' + (embed ? '' : footHTML());
      document.addEventListener('click', onClick);
      document.addEventListener('change', onChange);
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', probe);
      renderAll();
    },
    meta: function () { return SCHEMES; }
  };
})();
