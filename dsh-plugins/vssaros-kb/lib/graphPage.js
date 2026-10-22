/**
 * 关系图谱页面（`/x/kb/graph`）—— **从 IDE 侧迁来**（2026-10-19）。
 *
 * 为什么迁：IDE 侧那套（`kbGraph.ts` + `kbGraphView.ts` + `kbGraphEditorPane.ts` ≈ 2357 行）
 * 与 dsh 知识库页是两套入口；用户主用 dsh 页面 ⇒ 图谱放这儿就不用切编辑器 Tab。
 * 迁完**删 IDE 侧**（不保留双实现 —— 本仓为双真源付过代价）。
 *
 * 数据：`GET /x/kb/api/graph?vault=<id>`（节点 id = vault 内相对路径）⇒ 双击拼绝对路径交给
 *  页面桥 `openFile` 打开笔记 ✓。
 *
 * ⚠ 纪律（本仓踩过的坑）：
 *   · 本文件的 CSS/JS 都以**模板串**形式拼进页面 ⇒ **内容里不许出现反引号**（会提前闭合，
 *     真机上表现为整页白屏）；页面 JS 里也**不用 `${}` 插值**（会被服务端先吃掉）。
 *   · 页内脚本一处 ReferenceError 会让**整段**脚本变哑 ⇒ 由 `scripts/check-page-script.mjs` 守。
 */
import { escapeHtml, renderShell } from './pageShell.js';

/** 页面样式（作用域限定在 #kb-graph-root 内，不污染 shell） */
export const GRAPH_CSS = `
#kb-graph-root { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--vscode-editor-background, #1e1e1e); }
.kbg-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); font-size: 12px; }
.kbg-count { opacity: .72; font-variant-numeric: tabular-nums; }
.kbg-btn { border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); background: transparent;
  color: var(--vscode-foreground, #ccc); font-size: 12px; padding: 3px 9px; border-radius: 4px; cursor: pointer; }
.kbg-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.kbg-btn[aria-pressed="false"] { opacity: .55; }
.kbg-wrap { position: relative; flex: 1; overflow: hidden; }
#kbg-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
#kbg-canvas.dragging { cursor: grabbing; }
.kbg-legend { position: absolute; left: 10px; bottom: 10px; max-width: 46%;
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 5px;
  background: var(--vscode-editorWidget-background, rgba(37,37,38,.92));
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); font-size: 11px; }
.kbg-legend b { font-weight: 600; opacity: .85; margin-bottom: 2px; }
.kbg-legend button { display: flex; align-items: center; gap: 6px; border: none; background: transparent;
  color: inherit; font-size: 11px; padding: 1px 2px; border-radius: 3px; cursor: pointer; text-align: left; }
.kbg-legend button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.kbg-legend button[aria-pressed="false"] { opacity: .35; text-decoration: line-through; }
.kbg-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.kbg-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  text-align: center; font-size: 13px; line-height: 1.7; opacity: .82; pointer-events: none; }
.kbg-hint small { display: block; opacity: .7; font-size: 11px; }
.kbg-hint[hidden] { display: none; }
`;

/**
 * 页内脚本（ES5 风格 IIFE）。
 * ⚠ 不使用 `${}` 插值、不使用反引号 —— 整个字符串会被原样塞进页面模板串。
 */
export const GRAPH_SCRIPT = `
(function () {
  'use strict';

  var root = document.getElementById('kb-graph-root');
  var wrap = document.getElementById('kbg-wrap');
  var canvas = document.getElementById('kbg-canvas');
  var ctx = canvas.getContext('2d');
  var countEl = document.getElementById('kbg-count');
  var hintEl = document.getElementById('kbg-hint');
  var legendEl = document.getElementById('kbg-legend');

  var vaultId = root.getAttribute('data-vault') || '';
  var notesDir = String(root.getAttribute('data-notes-dir') || '').replace(/[\\\\/]+$/, '');

  // 力参数（与 IDE 侧默认值一致：0.16 / 0.2 / 0.008）
  /**
   * 力参数。★ 2026-10-19 调参记录（都靠浏览器实测，不靠眼估）：
   *  · center 0.008（原值）→ 0.003：中心力太强会把簇全拽到中部、簇内挤成一坨（真机截图 ✗）；
   *  · 0.003 又太弱：孤点没有弹簧约束，只被斥力推 ⇒ 整体摊到 4600×5700（画布才 2560×1211，
   *    fitView 只能缩到 0.19，等于把图缩成一点 ✗）；
   *  · 最终 0.012 + MAX_STEP 钳制：既不重叠、又能收进画布（fitView 后 scale 明显回升）。
   */
  var FORCES = { repulsion: 0.16, spring: 0.2, center: 0.012 };
  var COLLIDE = 28;
  /**
   * ★ 2026-10-19：**单帧最大位移**（防数值发散）。
   *
   * 斥力是 k*k/dist ⇒ dist 很小时给出巨大冲量（dist=1、k=22 时就是 475*alpha），
   * 而速度只有 0.9 的衰减 ⇒ 节点会带着惯性一路飘到几万像素外。
   * 实测（真机 75 节点）：包围盒达到 85 万 px、fitView 被 clamp 到 0.1，整张图糊成一个点 ✗。
   * 加上钳制后，最远节点也被压在合理范围内（配合下面的 dist 下限）。
   */
  var MAX_STEP = 24;
  var LABEL_MIN_SCALE = 0.6;
  var TICK_DECAY = 0.98;

  var PALETTE = ['#8b7cf6', '#4ea8de', '#48bf8f', '#e0a458', '#d96c8f', '#61c0c8', '#a3b565', '#b07cc6'];

  var state = {
    nodes: [], edges: [], byId: {},
    scale: 1, ox: 0, oy: 0, cx: 0, cy: 0,
    alpha: 0, iter: 0, running: false, raf: 0,
    hovered: null, hoverNbr: {}, hoverEdges: {},
    selected: null,
    hiddenGroups: {},
    showOrphans: true,
    dragging: null, panning: false, lastX: 0, lastY: 0,
    stats: { notes: 0, edges: 0, orphans: 0, dangling: 0 },
    loading: false
  };

  function groupColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) | 0; }
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  function resize() {
    var rect = wrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    state.cx = rect.width / 2;
    state.cy = rect.height / 2;
    draw();
  }

  // ── 数据 ────────────────────────────────────────────────────────────────
  function load(force) {
    if (state.loading) { return; }
    state.loading = true;
    setCount('加载中…');
    var url = '/x/kb/api/graph?vault=' + encodeURIComponent(vaultId) + (force ? '&refresh=1' : '');
    window.fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.loading = false;
        if (!data || !data.ok) { setCount(''); showHint('读取图谱失败', (data && data.error) || '未知错误'); return; }
        applyData(data);
      })
      .catch(function (e) {
        state.loading = false;
        setCount('');
        showHint('读取图谱失败', String(e && e.message ? e.message : e));
      });
  }

  function applyData(data) {
    state.stats = data.stats || { notes: 0, edges: 0, orphans: 0, dangling: 0 };
    state.nodes = [];
    state.edges = [];
    state.byId = {};
    state.selected = null;
    state.hovered = null;
    state.hoverNbr = {};
    state.hoverEdges = {};

    var i;
    for (i = 0; i < (data.nodes || []).length; i++) {
      var n = data.nodes[i];
      var node = {
        id: n.id,
        label: n.label || n.id,
        group: n.group || '(根)',
        degree: n.degree || 0,
        radius: 6 + (n.degree > 0 ? Math.log2(n.degree + 1) * 4 : 0),
        // ★ 2026-10-19：初始位置按**画布尺寸**散布。原先固定 ±110px 的一小团 ⇒
        //   有限迭代里摊不开，几个簇最后挤在中心（真机截图：三簇叠在中间、四周大片空白 ✗）。
        x: state.cx + (Math.random() - 0.5) * state.cx * 1.5,
        y: state.cy + (Math.random() - 0.5) * state.cy * 1.5,
        vx: 0, vy: 0
      };
      state.nodes.push(node);
      state.byId[node.id] = node;
    }
    for (i = 0; i < (data.edges || []).length; i++) {
      var e = data.edges[i];
      var src = state.byId[e.source];
      var dst = state.byId[e.target];
      if (src && dst) { state.edges.push({ source: src, target: dst }); }
    }
    renderLegend();
    restart();
  }

  function restart() {
    state.alpha = 1;
    state.iter = 0;
    state.running = true;
    if (state.raf) { cancelAnimationFrame(state.raf); }
    state.raf = requestAnimationFrame(tick);
  }

  // ── 力导向 ──────────────────────────────────────────────────────────────
  function simulate() {
    var nodes = state.nodes;
    var n = nodes.length;
    if (!n) { return; }
    var area = (state.cx * 2) * (state.cy * 2);
    // 「布局密度」给出的理想边长
    var looseK = Math.sqrt(area / n) * FORCES.repulsion;
    // ★★ 2026-10-19：**理想边长必须有保底**，不能小于「两个节点直径 + 间距」——
    //   否则弹簧（目标距离 k*2）会把相连节点拉进彼此体内 ⇒ 圆必然重叠 ✗。
    //   实测（真机 75 节点）：looseK≈22px，而度数高的节点半径 25px（直径 50px）⇒ 44px 的目标
    //   距离比两圆半径和还小 ⇒ 怎么迭代都会叠。保底取 avgR*2 + 34。
    var avgRadius = 0;
    for (var m = 0; m < n; m++) { avgRadius += nodes[m].radius; }
    avgRadius /= n;
    // ⚠⚠ 不能直接把 k 放大：k 同时进**斥力 k*k** 和弹簧目标 k*2 ⇒ 一放大斥力按平方增长，
    //    节点会被弹到几万像素外（实测包围盒 111 万 px、fitView 被 clamp 到最小 0.1，图糊成一点 ✗）。
    //    正解：斥力尺度 k 保持原公式不变，**只把弹簧目标距离**抬到「两圆直径 + 间距」。
    var k = looseK;
    var springLen = Math.max(k * 2, avgRadius * 2 + 40);
    var alpha = state.alpha;
    var i, j, a, b, dx, dy, dist, minDist, f, cf;

    for (i = 0; i < n; i++) {
      if (nodes[i] === state.dragging) { continue; }
      for (j = i + 1; j < n; j++) {
        if (nodes[j] === state.dragging) { continue; }
        a = nodes[i]; b = nodes[j];
        dx = b.x - a.x; dy = b.y - a.y;
        // 下限 1 → 12：dist→1 时斥力 k*k/dist 会爆炸（配合 MAX_STEP 一起防发散 ✓）
        dist = Math.max(12, Math.sqrt(dx * dx + dy * dy));
        f = (k * k) / dist * alpha;
        minDist = a.radius + b.radius + COLLIDE;
        // ★ 2026-10-19：碰撞权重 0.5 → 0.9（力导向里的碰撞是**软约束**，会被弹簧与中心力压过
        //   ⇒ 节点叠在一起。加大权重 + 收敛后硬分离，双保险 ✓）
        cf = dist < minDist ? (minDist - dist) * alpha * 0.9 : 0;
        f += cf;
        dx /= dist; dy /= dist;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (i = 0; i < state.edges.length; i++) {
      var edge = state.edges[i];
      if (edge.source === state.dragging || edge.target === state.dragging) { continue; }
      dx = edge.target.x - edge.source.x;
      dy = edge.target.y - edge.source.y;
      dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      // 目标距离用 springLen（≥ 两圆直径 + 间距）⇒ 相连节点不会挤进彼此体内 ✓
      f = (dist - springLen) * alpha * FORCES.spring;
      dx /= dist; dy /= dist;
      edge.source.vx += dx * f; edge.source.vy += dy * f;
      edge.target.vx -= dx * f; edge.target.vy -= dy * f;
    }
    for (i = 0; i < n; i++) {
      var node = nodes[i];
      if (node === state.dragging) { continue; }
      node.vx += (state.cx - node.x) * alpha * FORCES.center;
      node.vy += (state.cy - node.y) * alpha * FORCES.center;
      node.vx *= 0.9; node.vy *= 0.9;
      // 钳制单帧位移（见 MAX_STEP 的注释：不做这一步，斥力冲量会让节点飘出几万像素 ✗）
      var sp = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (sp > MAX_STEP) {
        node.vx = node.vx / sp * MAX_STEP;
        node.vy = node.vy / sp * MAX_STEP;
      }
      node.x += node.vx; node.y += node.vy;
    }
  }

  /**
   * 收敛后的**硬分离**：力导向的碰撞是软约束（会被弹簧/中心力压过），最后用位置修正
   * 保证"圆不重叠" —— 这是"图上永远看得清每个节点"的关键一步（真机截图里簇内叠成一坨 ✗）。
   * 只做几轮、只推可见节点；每轮无改动就提前退出。
   */
  function separateOverlaps(passes) {
    for (var p = 0; p < passes; p++) {
      var moved = false;
      for (var i = 0; i < state.nodes.length; i++) {
        var a = state.nodes[i];
        if (!visible(a)) { continue; }
        for (var j = i + 1; j < state.nodes.length; j++) {
          var b = state.nodes[j];
          if (!visible(b)) { continue; }
          var dx = b.x - a.x;
          var dy = b.y - a.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var minD = a.radius + b.radius + 10;
          if (dist >= minD) { continue; }
          if (dist < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dist = 1; }
          var push = (minD - dist) / 2;
          dx /= dist; dy /= dist;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
          moved = true;
        }
      }
      if (!moved) { break; }
    }
  }

  function tick() {
    if (state.alpha < 0.01 && state.iter > 100) {
      state.running = false;
      // 收敛后：硬分离（保证不叠）＋ 自动适应视野（避免大片空白 / 图跑出画布）
      separateOverlaps(6);
      // 收敛后"保护式"适配（缩太小就不动，保持 1.0 让用户自己浏览）
      fitView(false);
      setCount();
      draw();
      return;
    }
    simulate();
    state.alpha *= TICK_DECAY;
    state.iter++;
    setCount();
    draw();
    state.raf = requestAnimationFrame(tick);
  }

  // ── 可见性 ──────────────────────────────────────────────────────────────
  function visible(node) {
    if (state.hiddenGroups[node.group]) { return false; }
    if (!state.showOrphans && node.degree === 0) { return false; }
    return true;
  }

  // ── 绘制 ────────────────────────────────────────────────────────────────
  function toScreen(x, y) {
    return {
      x: (x - state.cx) * state.scale + state.ox + state.cx,
      y: (y - state.cy) * state.scale + state.oy + state.cy
    };
  }

  function draw() {
    var w = canvas.width / (window.devicePixelRatio || 1);
    var h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(state.ox + state.cx, state.oy + state.cy);
    ctx.scale(state.scale, state.scale);
    ctx.translate(-state.cx, -state.cy);

    var i;
    // 边（两端都可见才画）
    for (i = 0; i < state.edges.length; i++) {
      var edge = state.edges[i];
      if (!visible(edge.source) || !visible(edge.target)) { continue; }
      var hot = state.hoverEdges[i] === true;
      ctx.beginPath();
      ctx.moveTo(edge.source.x, edge.source.y);
      ctx.lineTo(edge.target.x, edge.target.y);
      ctx.globalAlpha = hot ? 1 : 0.45;
      ctx.lineWidth = hot ? 2.4 : 1.2;
      ctx.strokeStyle = hot ? '#ffd479' : (state.hovered ? 'rgba(160,160,170,.35)' : 'rgba(150,150,160,.75)');
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 节点
    for (i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (!visible(node)) { continue; }
      var nbr = state.hoverNbr[node.id] === true;
      var dim = state.hovered && !nbr;
      ctx.globalAlpha = dim ? 0.32 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = nbr ? '#ffd479' : groupColor(node.group);
      ctx.fill();
      if (node === state.selected || nbr) {
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 标签（低缩放只留骨架；hover / 邻居 / 选中始终显示）
    for (i = 0; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      if (!visible(nd)) { continue; }
      var show = state.scale >= LABEL_MIN_SCALE || nd === state.hovered || nd === state.selected || state.hoverNbr[nd.id] === true;
      if (!show) { continue; }
      var text = String(nd.label).slice(0, 18);
      ctx.font = '500 12px "SF Pro Display", system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var ly = nd.y + nd.radius + 6;
      var mw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(20,20,22,.72)';
      ctx.fillRect(nd.x - mw / 2 - 4, ly - 2, mw + 8, 17);
      ctx.fillStyle = 'rgba(240,240,245,.95)';
      ctx.fillText(text, nd.x, ly);
    }
    ctx.restore();
  }

  // ── 工具条 / 图例 / 提示 ────────────────────────────────────────────────
  function setCount(msg) {
    if (msg) { countEl.textContent = msg; return; }
    var s = state.stats;
    var hidden = 0;
    for (var g in state.hiddenGroups) { if (state.hiddenGroups[g]) { hidden++; } }
    var text = s.notes + ' 节点 · ' + s.edges + ' 连线';
    if (s.orphans) { text += ' · ' + s.orphans + ' 孤点'; }
    if (s.dangling) { text += ' · ' + s.dangling + ' 悬空链接'; }
    if (hidden) { text += ' · 已隐藏 ' + hidden + ' 组'; }
    countEl.textContent = text;
  }

  function showHint(title, detail) {
    if (!hintEl) { return; }
    hintEl.innerHTML = '';
    var t = document.createElement('div');
    t.textContent = title;
    var d = document.createElement('small');
    d.textContent = detail || '';
    hintEl.appendChild(t);
    hintEl.appendChild(d);
    hintEl.hidden = false;
  }

  function hideHint() { if (hintEl) { hintEl.hidden = true; } }

  function renderLegend() {
    if (!legendEl) { return; }
    legendEl.innerHTML = '';
    var groups = {};
    var i;
    for (i = 0; i < state.nodes.length; i++) {
      var g = state.nodes[i].group;
      groups[g] = (groups[g] || 0) + 1;
    }
    var names = Object.keys(groups).sort(function (a, b) { return groups[b] - groups[a]; });
    if (names.length < 2) { legendEl.hidden = true; return; }
    legendEl.hidden = false;
    var head = document.createElement('b');
    head.textContent = '分组（点击过滤）';
    legendEl.appendChild(head);
    for (i = 0; i < names.length && i < 12; i++) {
      (function (name) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', state.hiddenGroups[name] ? 'false' : 'true');
        var dot = document.createElement('span');
        dot.className = 'kbg-dot';
        dot.style.background = groupColor(name);
        var label = document.createElement('span');
        label.textContent = name + ' (' + groups[name] + ')';
        btn.appendChild(dot);
        btn.appendChild(label);
        btn.onclick = function () {
          state.hiddenGroups[name] = !state.hiddenGroups[name];
          btn.setAttribute('aria-pressed', state.hiddenGroups[name] ? 'false' : 'true');
          setCount();
          draw();
        };
        legendEl.appendChild(btn);
      })(names[i]);
    }
  }

  // ── 交互 ────────────────────────────────────────────────────────────────
  function worldFromEvent(ev) {
    var rect = canvas.getBoundingClientRect();
    var sx = ev.clientX - rect.left;
    var sy = ev.clientY - rect.top;
    return {
      sx: sx, sy: sy,
      x: (sx - state.ox - state.cx) / state.scale + state.cx,
      y: (sy - state.oy - state.cy) / state.scale + state.cy
    };
  }

  function findNode(wx, wy) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (!visible(node)) { continue; }
      var d = Math.hypot(node.x - wx, node.y - wy);
      if (d <= node.radius + 4 && d < bestD) { best = node; bestD = d; }
    }
    return best;
  }

  function updateHover(node) {
    state.hovered = node;
    state.hoverNbr = {};
    state.hoverEdges = {};
    if (!node) { return; }
    state.hoverNbr[node.id] = true;
    for (var i = 0; i < state.edges.length; i++) {
      var edge = state.edges[i];
      if (edge.source === node) { state.hoverNbr[edge.target.id] = true; state.hoverEdges[i] = true; }
      else if (edge.target === node) { state.hoverNbr[edge.source.id] = true; state.hoverEdges[i] = true; }
    }
  }

  canvas.addEventListener('mousemove', function (ev) {
    if (state.dragging) {
      var wp = worldFromEvent(ev);
      state.dragging.x = wp.x;
      state.dragging.y = wp.y;
      state.dragging.vx = 0;
      state.dragging.vy = 0;
      draw();
      return;
    }
    if (state.panning) {
      state.ox += ev.clientX - state.lastX;
      state.oy += ev.clientY - state.lastY;
      state.lastX = ev.clientX;
      state.lastY = ev.clientY;
      draw();
      return;
    }
    var p = worldFromEvent(ev);
    var hit = findNode(p.x, p.y);
    if (hit !== state.hovered) {
      updateHover(hit);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
      draw();
    }
  });

  canvas.addEventListener('mousedown', function (ev) {
    if (ev.button !== 0) { return; }
    var p = worldFromEvent(ev);
    var hit = findNode(p.x, p.y);
    if (hit) { state.dragging = hit; canvas.className = 'dragging'; }
    else { state.panning = true; state.lastX = ev.clientX; state.lastY = ev.clientY; canvas.className = 'dragging'; }
  });

  function endDrag() {
    if (state.dragging) { state.dragging = null; }
    state.panning = false;
    canvas.className = '';
  }
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', function () {
    endDrag();
    updateHover(null);
    draw();
  });

  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var p = worldFromEvent(ev);
    var factor = ev.deltaY > 0 ? 0.9 : 1.1;
    var next = Math.max(0.1, Math.min(3, state.scale * factor));
    if (next === state.scale) { return; }
    // 以鼠标为锚点缩放：保持鼠标下的世界坐标不动
    state.ox = p.sx - (p.x - state.cx) * next - state.cx;
    state.oy = p.sy - (p.y - state.cy) * next - state.cy;
    state.scale = next;
    draw();
  }, { passive: false });

  canvas.addEventListener('click', function (ev) {
    var p = worldFromEvent(ev);
    var hit = findNode(p.x, p.y);
    state.selected = hit;
    draw();
  });

  canvas.addEventListener('dblclick', function (ev) {
    var p = worldFromEvent(ev);
    var hit = findNode(p.x, p.y);
    if (!hit) { return; }
    var abs = notesDir + '/' + hit.id;
    var bridge = window.vssarosDsh;
    if (bridge && typeof bridge.openFile === 'function') {
      bridge.openFile(abs);
      return;
    }
    // 旧宿主 / 直接用浏览器打开页面 ⇒ 如实说明（不假装打开了）
    showHint('无法直接打开笔记', '当前环境没有页面桥，请用 VSSAROS 的 dsh 页面打开本页');
  });

  // ── 工具条按钮 ──────────────────────────────────────────────────────────
  /**
   * 把图缩放到窗口内。
   * @param force true = 用户主动点「适应视图」（无条件适配）；
   *              false = **收敛后自动**调用（做保护：缩得太小就不动，见下）。
   *
   * ★ 2026-10-19（真机截图）：这份库 75 节点 / 244 边，布局是纵向长条（约 4100px 高，
   *   画布只有 1211）⇒ 无条件适配会把 scale 压到 0.27 ⇒ 节点变小点、标签全被隐藏（<0.6）⇒
   *   用户看到的就是"一堆糊在一起的圆"，比不缩放更糟 ✗。
   *   ⇒ 自动适配时**低于 MIN_AUTO_SCALE 就放弃**，保持 1.0：宁可看不全（可拖拽/滚轮浏览），
   *     也不要缩到认不出。
   */
  function fitView(force) {
    var i, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (!visible(node)) { continue; }
      any = true;
      if (node.x < minX) { minX = node.x; }
      if (node.x > maxX) { maxX = node.x; }
      if (node.y < minY) { minY = node.y; }
      if (node.y > maxY) { maxY = node.y; }
    }
    if (!any) { return; }
    var rect = wrap.getBoundingClientRect();
    var pad = 60;
    var bw = Math.max(1, maxX - minX);
    var bh = Math.max(1, maxY - minY);
    var scale = Math.max(0.1, Math.min(3, Math.min((rect.width - pad * 2) / bw, (rect.height - pad * 2) / bh)));
    var MIN_AUTO_SCALE = 0.45;
    if (!force && scale < MIN_AUTO_SCALE) { return; }
    state.scale = scale;
    state.ox = -(((minX + maxX) / 2) - state.cx) * scale;
    state.oy = -(((minY + maxY) / 2) - state.cy) * scale;
    draw();
  }

  function bind(id, handler) {
    var el = document.getElementById(id);
    if (el) { el.onclick = handler; }
  }

  bind('kbg-rebuild', function () { load(true); });
  bind('kbg-relayout', function () { restart(); });
  // 用户主动点「适应视图」⇒ 无条件适配（force = true）
  bind('kbg-fit', function () { fitView(true); });
  bind('kbg-orphans', function () {
    state.showOrphans = !state.showOrphans;
    var el = document.getElementById('kbg-orphans');
    if (el) { el.setAttribute('aria-pressed', state.showOrphans ? 'true' : 'false'); }
    setCount();
    // 用户主动切换过滤 ⇒ 无条件适配（但同样受 fitView 的 0.1 下限保护）
    fitView(true);
  });

  window.addEventListener('resize', resize);

  // ★ 只读探针钩子（无副作用，仅读状态）：供离线验证脚本量化「节点是否重叠 / 视图是否铺满」。
  //   没有它，这类问题只能靠肉眼看截图才发现（本轮就是这么被真机截图抓到的 ✗）。
  window.__kbgSnapshot = function () {
    var out = [];
    for (var i = 0; i < state.nodes.length; i++) {
      var nd = state.nodes[i];
      out.push({ id: nd.id, x: nd.x, y: nd.y, r: nd.radius, degree: nd.degree, visible: visible(nd) });
    }
    return {
      nodes: out, scale: state.scale, ox: state.ox, oy: state.oy,
      cx: state.cx, cy: state.cy, iter: state.iter, running: state.running,
      stats: state.stats
    };
  };

  resize();
  load(false);
})();
`;

/**
 * 渲染图谱页面。
 * @param {{ vaultId: string, vaultName: string, notesDir: string }} options
 */
export function renderGraphPage({ vaultId, vaultName, notesDir }) {
	const body = `
<div id="kb-graph-root" data-vault="${escapeHtml(vaultId)}" data-notes-dir="${escapeHtml(notesDir)}">
  <div class="kbg-bar">
    <span class="kbg-count" id="kbg-count">加载中…</span>
    <button type="button" class="kbg-btn" id="kbg-rebuild" title="重新扫描笔记并重算双链">重新构建</button>
    <button type="button" class="kbg-btn" id="kbg-relayout" title="重新执行力导向布局">重新布局</button>
    <button type="button" class="kbg-btn" id="kbg-fit" title="把整张图缩放到窗口内">适应视图</button>
    <button type="button" class="kbg-btn" id="kbg-orphans" aria-pressed="true" title="显示/隐藏没有双链的笔记">孤点</button>
  </div>
  <div class="kbg-wrap" id="kbg-wrap">
    <canvas id="kbg-canvas"></canvas>
    <div class="kbg-legend" id="kbg-legend" hidden></div>
    <div class="kbg-hint" id="kbg-hint" hidden></div>
  </div>
</div>`;
	return renderShell({
		kind: 'kb-graph',
		title: '关系图谱',
		subtitle: vaultName,
		bodyHtml: body,
		extraCss: GRAPH_CSS,
		script: GRAPH_SCRIPT,
	});
}
