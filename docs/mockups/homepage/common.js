/* VsSaros 主页重设计 · mockup 共享脚本（图标精灵 / 主题 / 轻量交互） */
(function () {
  var ICONS = {
    home:'<path d="M3 10.2 12 3l9 7.2"/><path d="M5.5 9.2V20h13V9.2"/><path d="M9.5 20v-6h5v6"/>',
    grid:'<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    search:'<circle cx="10.8" cy="10.8" r="6.8"/><path d="m20 20-4.4-4.4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    command:'<path d="M9 6.5a2.5 2.5 0 1 0-2.5 2.5h11A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5z"/>',
    'chevron-right':'<path d="m9 5 7 7-7 7"/>',
    'chevron-down':'<path d="m5 9 7 7 7-7"/>',
    'arrow-up-right':'<path d="M7 17 17 7M8 7h9v9"/>',
    'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>',
    history:'<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3 8.5"/><path d="M3 3.5v5h5"/><path d="M12 7.5V12l3 1.8"/>',
    book:'<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17.5H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M4 17.5h16"/>',
    brain:'<path d="M12 6a3 3 0 0 0-5.7-1.2A3 3 0 0 0 4.5 10a3 3 0 0 0 .8 4.8A3 3 0 0 0 12 18z"/><path d="M12 6a3 3 0 0 1 5.7-1.2A3 3 0 0 1 19.5 10a3 3 0 0 1-.8 4.8A3 3 0 0 1 12 18z"/><path d="M12 6v12"/>',
    code:'<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.3" cy="9" r="1.4"/><path d="m4 17 4.8-4.8L12 15.5 15.5 12 20 16.5"/>',
    store:'<path d="M3 9.5 4.6 4h14.8L21 9.5"/><path d="M3 9.5a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.6 0"/><path d="M5 11.5V20h14v-8.5"/><path d="M9.5 20v-5h5v5"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h3M8 17.5h6"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1l1.9-1.1"/>',
    moon:'<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    pin:'<path d="M12 16.5V21"/><path d="M8.5 3h7l-1 6 3 3v2h-11v-2l3-3z"/>',
    more:'<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    play:'<path d="m8 5 11 7-11 7z"/>',
    pause:'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    activity:'<path d="M2.5 12h4.2l3-7.5 4.3 15 3-7.5h4.5"/>',
    chart:'<path d="M3 20.5h18"/><rect x="4.5" y="12" width="3.5" height="6" rx="1"/><rect x="10" y="8" width="3.5" height="10" rx="1"/><rect x="15.5" y="4.5" width="3.5" height="13.5" rx="1"/>',
    layers:'<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    folder:'<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
    terminal:'<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="m6.5 9 3 3-3 3M12 15h5"/>',
    sparkles:'<path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    check:'<path d="m4.5 12.5 5 5 10-10"/>',
    alert:'<path d="M12 3.5 21 19.5H3z"/><path d="M12 9.5v4.5M12 17h.01"/>',
    refresh:'<path d="M20 11a8 8 0 1 0-2.3 6"/><path d="M20 4.5V11h-6.5"/>',
    external:'<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v5.5A1.5 1.5 0 0 1 16.5 21h-12A1.5 1.5 0 0 1 3 19.5v-12A1.5 1.5 0 0 1 4.5 6H10"/>',
    grip:'<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>',
    x:'<path d="M5 5 19 19M19 5 5 19"/>',
    filter:'<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    zap:'<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>',
    message:'<path d="M20 15.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5z"/><path d="M8 9h8M8 12.5h5"/>',
    cpu:'<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    'git-branch':'<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2a5 5 0 0 1-5 5H8.2"/>',
    bell:'<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 6.5-2.5 8h17c0-1.5-2.5-2-2.5-8z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    list:'<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    'panel-left':'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    maximize:'<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/>',
    target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    timer:'<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M9 2h6"/>',
    sliders:'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    'file-text':'<path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9z"/><path d="M13 3v6h6M8.5 13h7M8.5 16.5h5"/>',
    rocket:'<path d="M5 15c-1 2-1 4-1 4s2 0 4-1"/><path d="M9.5 14.5 6 11a11 11 0 0 1 8-7c2.5 0 4 1.5 4 1.5s1.5 1.5 1.5 4a11 11 0 0 1-7 8z"/><circle cx="14.5" cy="9.5" r="1.6"/>'
  };
  var defs = Object.keys(ICONS).map(function (k) {
    return '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>';
  }).join('');
  document.body.insertAdjacentHTML('afterbegin',
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' + defs + '</svg>');

  // 主题：默认跟随 IDE 深色，可切浅色；落地时改由宿主注入 --dsw-alias-* 并跟随窗口主题
  var saved = null;
  try { saved = localStorage.getItem('vssaros-mockup-theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  function syncThemeButtons() {
    var light = document.documentElement.dataset.theme === 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      var use = b.querySelector('use');
      if (use) use.setAttribute('href', light ? '#i-sun' : '#i-moon');
      b.setAttribute('aria-label', light ? '切换到深色主题' : '切换到浅色主题');
      b.title = b.getAttribute('aria-label');
    });
  }
  syncThemeButtons();

  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  document.body.appendChild(toast);
  var toastTimer = null;
  function say(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1900);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme-toggle]');
    if (t) {
      var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('vssaros-mockup-theme', next); } catch (err) {}
      syncThemeButtons();
      say(next === 'light' ? '已切到浅色主题（真实页面跟随 IDE 窗口主题）' : '已切到深色主题');
      return;
    }
    var toastEl = e.target.closest('[data-toast]');
    if (toastEl && !e.target.closest('[data-tab],[data-theme-toggle]')) {
      say(toastEl.getAttribute('data-toast'));
      return;
    }
    var tab = e.target.closest('[data-tab]');
    if (tab) {
      var scope = tab.closest('[data-tabs-scope]') || document;
      scope.querySelectorAll('[data-tab]').forEach(function (b) {
        b.classList.toggle('is-active', b === tab);
      });
      scope.querySelectorAll('[data-panel]').forEach(function (p) {
        p.hidden = p.getAttribute('data-panel') !== tab.getAttribute('data-tab');
      });
      return;
    }
    var zen = e.target.closest('[data-zen]');
    if (zen) {
      var app = document.querySelector('.app');
      app.classList.toggle('is-zen');
      zen.setAttribute('aria-pressed', String(app.classList.contains('is-zen')));
      say(app.classList.contains('is-zen') ? '专注模式：已隐藏活动栏与标题栏' : '已恢复 IDE 外壳');
      return;
    }
    var narrow = e.target.closest('[data-narrow]');
    if (narrow) {
      var stage = document.querySelector('.stage');
      stage.classList.toggle('is-narrow');
      narrow.setAttribute('aria-pressed', String(stage.classList.contains('is-narrow')));
      say(stage.classList.contains('is-narrow') ? '按 320px 侧栏预览容器查询效果' : '已恢复全宽编辑区');
      return;
    }
    var edit = e.target.closest('[data-edit-toggle]');
    if (edit) {
      var inner = document.querySelector('.stage-inner');
      var on = !inner.classList.contains('is-editing');
      inner.classList.toggle('is-editing', on);
      edit.setAttribute('aria-pressed', String(on));
      edit.innerHTML = '<svg class="ic"><use href="#i-' + (on ? 'check' : 'sliders') + '"></use></svg>' + (on ? '完成编排' : '自定义');
      say(on ? '编排态：显示拖拽把手与卡片操作' : '已退出编排态');
      return;
    }
  });

  // 关键字过滤（用于会话列表 / 工作台列表）
  document.querySelectorAll('[data-filter]').forEach(function (input) {
    input.addEventListener('input', function () {
      var scope = input.closest('[data-filter-scope]') || document;
      var q = input.value.trim().toLowerCase();
      scope.querySelectorAll('[data-filter-item]').forEach(function (el) {
        el.hidden = !!q && (el.textContent || '').toLowerCase().indexOf(q) < 0;
      });
    });
  });

  // 时钟卡片（服务端给初值，客户端自走；对齐 catalog 的 clock widget）
  var clocks = document.querySelectorAll('[data-clock]');
  if (clocks.length) {
    var tick = function () {
      var d = new Date();
      var p = function (n) { return String(n).padStart(2, '0'); };
      clocks.forEach(function (el) {
        el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) +
          (el.getAttribute('data-clock') === 'sec' ? ':' + p(d.getSeconds()) : '');
      });
    };
    tick(); setInterval(tick, 1000);
  }

  // ⌘K / Ctrl+K 聚焦主命令框
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      var box = document.querySelector('[data-search-main]');
      if (box) { e.preventDefault(); box.focus(); }
    }
    if (e.key === 'Escape' && document.activeElement && document.activeElement.matches('[data-search-main]')) {
      document.activeElement.blur();
    }
  });
})();
