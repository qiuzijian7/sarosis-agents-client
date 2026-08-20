/*---------------------------------------------------------------------------------------------
 *  Dynamic Workflow — worker script source (inline constant → blob worker)
 *
 *  ★ 这是「源码的源码」：导出的 WORKER_SOURCE 字符串会被 createBlobWorker
 *    动态创建为 Web Worker。因此本字符串内部：
 *      ① 禁止反引号与模板字符串（转义地狱，见 codebaseGraph worker 前车之鉴）；
 *      ② 禁止 import/export —— 完全自包含；
 *      ③ 语义与 common/workflow/{types,realm,schemaSubset}.ts 同构
 *        （materialize / schema 子集 / fatal 错误），一致性由集成测试锁定。
 *
 *  隔离目标（与 dsh 口径一致）：可终止（host terminate）+ 结果物化边界 +
 *  防误用遮蔽 —— 不是安全边界。脚本无 fs/网络/timer/宿主对象；
 *  fetch/XMLHttpRequest/importScripts/WebSocket/Worker 置 undefined。
 *
 *  hooks：agent(prompt,opts) / parallel(thunks) / pipeline(items,...stages) /
 *         phase(title) / log(msg) / args。cancel 后所有 hook 入口抛 CANCELLED
 *  （下一个 hook 边界死）；dropped promise 挂 no-op catch（contain）不杀线程。
 *  设计文档：doc/Dynamic-Workflow-Integration-Design.md §3.2.3。
 *--------------------------------------------------------------------------------------------*/

export const WORKER_SOURCE = String.raw`
'use strict';
/* ── 环境遮蔽（防误用，非安全边界）──────────────────────────────
   ★ 关键：WorkerGlobalScope 上 navigator 是 readonly getter-only 属性
     （Web IDL: readonly attribute WorkerNavigator navigator），严格模式下
     赋值会抛 TypeError → worker 加载即崩（onerror），表现为 "[object ErrorEvent]"。
     故逐项 try/catch：遮蔽失败绝不拖垮 worker 启动。 */
['fetch','XMLHttpRequest','importScripts','WebSocket','Worker'].forEach(function (k) {
  try { self[k] = undefined; } catch (e) { /* readonly — 遮蔽失败可接受 */ }
});
try { self.navigator = { userAgent: 'workflow-worker' }; } catch (e) { /* readonly */ }

/* ── trusted types：new Function 需 TrustedScript 参数 ───────────
   workbench.html CSP 有 require-trusted-types-for 'script' → worker 里
   new Function(普通字符串) 抛 EvalError（脚本被误判 SCRIPT_PARSE）。
   blob worker 是独立 realm，主线程策略不可见 → 须自己 createPolicy。
   ★ 关键：worker 的 CSP trusted-types 名单与主线程不同 —— VS Code 官方
     worker bootstrap 只用 'defaultWorkerFactory'（webWorkerServiceImpl.ts:106），
     主线程名单里的 'agentStudioWorker' 未必传递到 worker。故多策略名依次尝试，
     收集失败原因；全失败则 fail-loud（诊断信息随 SCRIPT_PARSE 带出，绝不静默）。 */
var ttObj = (typeof trustedTypes !== 'undefined') ? trustedTypes
  : (typeof globalThis !== 'undefined' && globalThis.trustedTypes) ? globalThis.trustedTypes : undefined;
var urlPolicy = undefined;   // createScriptURL（用于 import(blobUrl) —— VS Code 官方验证可靠的路径）
var ttDiag = '';
(function () {
  try {
    if (!ttObj || !ttObj.createPolicy) {
      ttDiag = 'trustedTypes unavailable (typeof=' + (typeof trustedTypes) + ')';
      return;
    }
    // 只做 createScriptURL（defaultWorkerFactory 官方就是 createScriptURL），
    // 彻底绕开 new Function + createScript 的「形参被识别成 TrustedString」坑。
    var names = ['defaultWorkerFactory', 'agentStudioWorker', 'default'];
    for (var i = 0; i < names.length; i++) {
      try {
        // 先取已存在的（VS Code bootstrap 可能已创建 defaultWorkerFactory）
        var existing = ttObj.getPolicy ? ttObj.getPolicy(names[i]) : undefined;
        if (existing && typeof existing.createScriptURL === 'function') {
          urlPolicy = existing; return;
        }
        urlPolicy = ttObj.createPolicy(names[i], { createScriptURL: function (u) { return u; } });
        if (urlPolicy) { return; }
      } catch (e) {
        ttDiag += (ttDiag ? '; ' : '') + names[i] + ' -> ' + (e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    ttDiag = 'tt init: ' + (e && e.message ? e.message : e);
  }
})();
function wrapUrl(u) {
  if (urlPolicy) { try { return urlPolicy.createScriptURL(u); } catch (e) { return u; } }
  return u; // 无 CSP 环境（测试/裸 worker）
}
// 诊断：仅在「存在 trusted types 却拿不到策略」时告警 —— 该状态下 import(blobUrl)
// 会被 CSP 拒（真实故障）。正常路径（策略创建成功 / 无 CSP 的 node 沙箱）保持静默，
// 否则每次 run 都往主线程日志刷红，掩盖真实错误。
try {
  if (ttObj && ttObj.createPolicy && !urlPolicy) {
    console.warn('[workflow-worker] trusted types policy unavailable (' + (ttDiag || 'unknown') + ') — module import may be blocked by CSP');
  }
} catch (e) { /* ignore */ }

var post = function (m) { try { self.postMessage(m); } catch (e) { /* host gone */ } };

/* ── fatal 错误（worker 内联版；组合子用 instanceof 判定，脚本无法伪造）── */
function WFErr(message, code) {
  var e = new Error('[' + code + '] ' + message);
  e.name = 'WorkflowError';
  e.wfCode = code;
  e.isWF = true;
  return e;
}
function isFatal(e) { return !!(e && e.isWF === true); }

/* ── materializeFromRealm（与 common/workflow/realm.ts 同构）──────── */
function MaterializeError(message, path) {
  var e = new Error(path + ': ' + message);
  e.name = 'MaterializeError';
  e.matPath = path;
  return e;
}
function materialize(v, what, seenP, depth, path) {
  seenP = seenP || new WeakSet();
  depth = depth || 0;
  path = path || '$';
  try {
    if (v === null || v === undefined) { return null; }
    var t = typeof v;
    if (t === 'boolean' || t === 'string') { return v; }
    if (t === 'number') {
      if (!isFinite(v)) { throw MaterializeError('non-finite number (' + String(v) + ') is not JSON', path); }
      return v === 0 ? 0 : v;
    }
    if (t === 'bigint' || t === 'symbol' || t === 'function') {
      throw MaterializeError(t + ' is not JSON', path);
    }
    if (t !== 'object') { throw MaterializeError('unsupported typeof "' + t + '"', path); }
    if (seenP.has(v)) { throw MaterializeError('circular reference', path); }
    if (depth > 64) { throw MaterializeError('nesting exceeds depth 64', path); }
    if (Array.isArray(v)) {
      seenP.add(v);
      var out = new Array(v.length);
      for (var i = 0; i < v.length; i++) {
        if (!(i in v)) { throw MaterializeError('sparse array (hole at index ' + i + ')', path + '[' + i + ']'); }
        out[i] = materialize(v[i], what, seenP, depth + 1, path + '[' + i + ']');
      }
      seenP.delete(v);
      return out;
    }
    var proto = Object.getPrototypeOf(v);
    /* 跨 realm 宽容：postMessage/跨 context 传入的 plain object 其 proto 是「对方 realm 的
       Object.prototype」—— 用 constructor.name==='Object' 识别任意 realm 的 plain object；
       class 实例/Map/Date 的 constructor.name 各异 → 仍拒（防误用，非安全边界）。 */
    var isPlain = proto === null || proto === Object.prototype ||
      (proto.constructor && proto.constructor.name === 'Object');
    if (!isPlain) {
      var cname = (proto.constructor && proto.constructor.name) || 'custom';
      throw MaterializeError(cname + ' instance is not plain JSON', path);
    }
    seenP.add(v);
    var o = {};
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      o[keys[k]] = materialize(v[keys[k]], what, seenP, depth + 1, path + '.' + keys[k]);
    }
    seenP.delete(v);
    return o;
  } catch (e) {
    if (e.name === 'MaterializeError' && depth === 0) {
      throw MaterializeError(what + ': ' + e.message, e.matPath);
    }
    throw e;
  }
}

/* ── schema 子集校验（与 common/workflow/schemaSubset.ts 同构）────── */
var SCHEMA_KEYS = ['type','properties','required','additionalProperties','items','enum','const','oneOf'];
var SCHEMA_TYPES = ['object','array','string','number','integer','boolean','null'];
function schemaBad(msg) { return WFErr(msg, 'UNSUPPORTED_SCHEMA'); }
function checkSchema(node, path, depth) {
  if (depth > 16) { throw schemaBad(path + ': schema nesting exceeds depth 16'); }
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    if (SCHEMA_KEYS.indexOf(keys[i]) < 0) {
      throw schemaBad(path + ': unsupported keyword "' + keys[i] + '"');
    }
  }
  if (node.type !== undefined && (typeof node.type !== 'string' || SCHEMA_TYPES.indexOf(node.type) < 0)) {
    throw schemaBad(path + '.type must be one of ' + SCHEMA_TYPES.join(' | '));
  }
  if (node.properties !== undefined) {
    if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
      throw schemaBad(path + '.properties must be an object');
    }
    var pk = Object.keys(node.properties);
    for (var p = 0; p < pk.length; p++) {
      var pv = node.properties[pk[p]];
      if (typeof pv !== 'object' || pv === null || Array.isArray(pv)) { throw schemaBad(path + '.properties.' + pk[p] + ' must be a schema object'); }
      checkSchema(pv, path + '.properties.' + pk[p], depth + 1);
    }
  }
  if (node.required !== undefined && (!Array.isArray(node.required) || !node.required.every(function (s) { return typeof s === 'string'; }))) {
    throw schemaBad(path + '.required must be a string array');
  }
  if (node.items !== undefined) {
    if (typeof node.items !== 'object' || node.items === null || Array.isArray(node.items)) { throw schemaBad(path + '.items must be a schema object'); }
    checkSchema(node.items, path + '.items', depth + 1);
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) { throw schemaBad(path + '.enum must be an array'); }
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) { throw schemaBad(path + '.oneOf must be a non-empty array'); }
    for (var o = 0; o < node.oneOf.length; o++) {
      var ov = node.oneOf[o];
      if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) { throw schemaBad(path + '.oneOf[' + o + '] must be a schema object'); }
      checkSchema(ov, path + '.oneOf[' + o + ']', depth + 1);
    }
  }
}

/* ── agent() 选项白名单（其余显式拒绝）──────────────────────────── */
var SUPPORTED_OPTS = { label:1, phase:1, schema:1, agentId:1, model:1 };
var DEFERRED_OPTS = { effort:1, isolation:1, agentType:1 };

/* ── child RPC 簿记 ────────────────────────────────────────────── */
var nextCallId = 1;
var pendingStart = {};    /* callId -> {resolve, reject} */
var pendingResult = {};   /* callId -> {resolve, reject} */
var pendingDispose = {};  /* callId -> {resolve} */
var pendingNodeOutput = {}; /* callId -> {resolve, reject} */
var pendingStageRun = {};   /* callId -> {resolve, reject}（P0 画布写方向桥） */

function childStart(request) {
  return new Promise(function (resolve, reject) {
    var callId = nextCallId++;
    pendingStart[callId] = { resolve: resolve, reject: reject };
    post({ type: 'child-start', callId: callId, request: request });
  });
}
function childResult(callId, childId) {
  return new Promise(function (resolve, reject) {
    pendingResult[callId] = { resolve: resolve, reject: reject };
  });
}
function childDispose(callId) {
  return new Promise(function (resolve) {
    pendingDispose[callId] = { resolve: resolve };
    post({ type: 'child-dispose', callId: callId });
  });
}

/* nodeOutput(stageUid, slot?)：读画布节点快照（M2 桥；fail-loud —— 查无即 fatal）。 */
function nodeOutputHook(rawUid, rawSlot) {
  throwIfCancelled();
  if (typeof rawUid !== 'string' || rawUid.length === 0) {
    throw WFErr('nodeOutput() requires a non-empty stageUid string', 'INVALID_ARGUMENT');
  }
  var query = { stageUid: rawUid };
  if (rawSlot !== undefined && rawSlot !== null) {
    if (typeof rawSlot !== 'number' || !isFinite(rawSlot) || rawSlot < 0 || Math.floor(rawSlot) !== rawSlot) {
      throw WFErr('nodeOutput() slot must be a non-negative integer', 'INVALID_ARGUMENT');
    }
    query.slot = rawSlot;
  }
  return contain(new Promise(function (resolve, reject) {
    var callId = nextCallId++;
    pendingNodeOutput[callId] = { resolve: resolve, reject: reject };
    post({ type: 'node-output', callId: callId, query: query });
  }));
}

/* stage(stageUid, overrides?)：**触发**画布媒体节点执行（P0 桥，写方向）。
   与 nodeOutput（只读快照）互补：真正跑 ComfyTV.ImageStage 等节点生成图像。
   fail-loud —— uid 不存在 / 执行失败一律 fatal（绝不静默 null 串坏下游）。 */
function stageHook(rawUid, rawOverrides) {
  throwIfCancelled();
  if (typeof rawUid !== 'string' || rawUid.length === 0) {
    throw WFErr('stage() requires a non-empty stageUid string', 'INVALID_ARGUMENT');
  }
  var request = { stageUid: rawUid };
  if (rawOverrides !== undefined && rawOverrides !== null) {
    if (typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
      throw WFErr('stage() overrides must be a plain object', 'INVALID_ARGUMENT');
    }
    /* 物化为 plain JSON（过 postMessage structured clone；同时挡住函数/循环引用） */
    request.overrides = materialize(rawOverrides, 'stage() overrides');
  }
  return contain(new Promise(function (resolve, reject) {
    var callId = nextCallId++;
    pendingStageRun[callId] = { resolve: resolve, reject: reject };
    post({ type: 'stage-run', callId: callId, request: request });
  }));
}

/* ── 取消状态（cancel 后所有 hook 入口抛 CANCELLED）────────────── */
var cancelReason = undefined;
var cancelError = undefined;
function cancelled() { return cancelReason !== undefined; }
function throwIfCancelled() { if (cancelled()) { throw cancelError; } }
function makeCancelledError() { return WFErr('workflow run cancelled: ' + cancelReason, 'CANCELLED'); }

/* ── 并发 slot（FIFO；cancel reject 全部 waiter）───────────────── */
var activeSlots = 0;
var slotWaiters = [];
function acquireSlot(limits) {
  if (activeSlots < limits.maxConcurrentAgents) { activeSlots++; return Promise.resolve(); }
  return new Promise(function (resolve, reject) {
    slotWaiters.push({ resolve: function () { activeSlots++; resolve(); }, reject: reject });
  });
}
function releaseSlot() {
  activeSlots--;
  var next = slotWaiters.shift();
  if (next) { next.resolve(); }
}

/* ── contain：dropped promise 不杀线程 ─────────────────────────── */
function contain(p) { p.catch(function () {}); return p; }

/* ── runtime 状态 ─────────────────────────────────────────────── */
var started = 0;
var currentPhase = undefined;
var limits = null;

function defaultLabel(prompt) {
  var line = prompt.indexOf('\n') === -1 ? prompt : prompt.slice(0, prompt.indexOf('\n'));
  return line.length <= 48 ? line : line.slice(0, 47) + '\u2026';
}

function readOpts(raw) {
  if (raw === undefined || raw === null) { return {}; }
  var opts = materialize(raw, 'agent() options');
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    throw WFErr('agent() options must be an object', 'INVALID_ARGUMENT');
  }
  var keys = Object.keys(opts);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (SUPPORTED_OPTS[k]) { continue; }
    if (DEFERRED_OPTS[k]) {
      throw WFErr('agent() option "' + k + '" is deferred and not supported by this engine (supported: label, phase, schema, agentId, model)', 'UNSUPPORTED_OPTION');
    }
    throw WFErr('agent() option "' + k + '" is not recognized (supported: label, phase, schema, agentId, model)', 'UNSUPPORTED_OPTION');
  }
  var out = {};
  ['label','phase','agentId','model'].forEach(function (s) {
    if (opts[s] !== undefined && opts[s] !== null) {
      if (typeof opts[s] !== 'string') { throw WFErr('agent() option "' + s + '" must be a string', 'INVALID_ARGUMENT'); }
      if (opts[s].length > 0) { out[s] = opts[s]; }
    }
  });
  if (opts.schema !== undefined && opts.schema !== null) {
    if (typeof opts.schema !== 'object' || Array.isArray(opts.schema)) {
      throw WFErr('agent() schema must be a JSON object', 'UNSUPPORTED_SCHEMA');
    }
    checkSchema(opts.schema, 'schema', 0);
    out.schema = opts.schema;
  }
  return out;
}

/* ── hooks ─────────────────────────────────────────────────────── */
function agentHook(rawPrompt, rawOpts) {
  throwIfCancelled();
  if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
    throw WFErr('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT');
  }
  var opts = readOpts(rawOpts);
  if (started >= limits.maxTotalAgents) {
    throw WFErr('this run reached its total agent cap (' + limits.maxTotalAgents + ') - a runaway-loop backstop; raise maxTotalAgents if the scale is intentional', 'AGENT_CAP');
  }
  started++;
  var seq = started;
  var label = opts.label || defaultLabel(rawPrompt);
  var phase = opts.phase || currentPhase;

  var runP = acquireSlot(limits).then(function () {
    throwIfCancelled();
    var request = { prompt: rawPrompt };
    if (opts.schema !== undefined) { request.schema = opts.schema; }
    if (opts.agentId !== undefined) { request.agentId = opts.agentId; }
    if (opts.model !== undefined) { request.model = opts.model; }
    return childStart(request).then(function (child) {
      if (cancelled()) { return childDispose(child.callId).then(function () { throw makeCancelledError(); }); }
      var info = { seq: seq, label: label, childId: child.childId };
      if (phase !== undefined) { info.phase = phase; }
      post({ type: 'agent-start', info: info });
      var resultP;
      try {
        resultP = childResult(child.callId, child.childId);
      } catch (syncErr) {
        return childDispose(child.callId).then(function () { throw syncErr; });
      }
      return resultP.then(function (result) {
        var outcome;
        var value;
        if (result.success && result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            if (result.structured === undefined) {
              outcome = 'failed'; value = null;
            } else {
              outcome = 'completed'; value = result.structured;
            }
          } else {
            outcome = 'completed'; value = result.output !== undefined ? result.output : '';
          }
        } else if (cancelled()) {
          outcome = 'cancelled'; value = null;
        } else {
          outcome = 'failed'; value = null;
        }
        post({ type: 'agent-end', info: { seq: seq, label: label, childId: child.childId, phase: phase, outcome: outcome } });
        return childDispose(child.callId).then(function () {
          if (outcome === 'cancelled') { throw makeCancelledError(); }
          return value;
        });
      }, function (rendered) {
        post({ type: 'agent-end', info: { seq: seq, label: label, childId: child.childId, phase: phase, outcome: cancelled() ? 'cancelled' : 'failed' } });
        return childDispose(child.callId).then(function () {
          if (cancelled()) { throw makeCancelledError(); }
          throw WFErr('child agent run failed: ' + rendered, 'AGENT_RESULT');
        });
      });
    }, function (rendered) {
      if (cancelled()) { throw makeCancelledError(); }
      throw WFErr('agent() could not start a child: ' + rendered, 'AGENT_START');
    });
  }, function (rej) {
    throw rej;
  }).then(function (v) {
    releaseSlot();
    return v;
  }, function (e) {
    releaseSlot();
    throw e;
  });
  return contain(runP);
}

function parallelHook(rawThunks) {
  throwIfCancelled();
  if (!Array.isArray(rawThunks)) {
    throw WFErr('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT');
  }
  if (rawThunks.length > limits.maxItemsPerCall) {
    throw WFErr('parallel() received ' + rawThunks.length + ' items - over the per-call cap (' + limits.maxItemsPerCall + ')', 'ITEM_CAP');
  }
  for (var i = 0; i < rawThunks.length; i++) {
    if (typeof rawThunks[i] !== 'function') {
      throw WFErr('parallel() item ' + i + ' is not a function', 'INVALID_ARGUMENT');
    }
  }
  return contain(Promise.all(rawThunks.map(function (thunk) {
    return Promise.resolve().then(function () { return thunk(); }).then(function (v) { return v; }, function (e) {
      if (isFatal(e)) { throw e; }
      return null;
    });
  })));
}

function pipelineHook(rawItems) {
  throwIfCancelled();
  var stages = Array.prototype.slice.call(arguments, 1);
  if (!Array.isArray(rawItems)) {
    throw WFErr('pipeline() requires an items array', 'INVALID_ARGUMENT');
  }
  if (rawItems.length > limits.maxItemsPerCall) {
    throw WFErr('pipeline() received ' + rawItems.length + ' items - over the per-call cap (' + limits.maxItemsPerCall + ')', 'ITEM_CAP');
  }
  if (stages.length === 0) {
    throw WFErr('pipeline() requires at least one stage function', 'INVALID_ARGUMENT');
  }
  for (var s = 0; s < stages.length; s++) {
    if (typeof stages[s] !== 'function') {
      throw WFErr('pipeline() stage ' + s + ' is not a function', 'INVALID_ARGUMENT');
    }
  }
  return contain(Promise.all(rawItems.map(function (item, index) {
    /* chain 初始 resolve(item)：stage1 的 prev = item 本身（不是 undefined） */
    var chain = Promise.resolve(item);
    for (var si = 0; si < stages.length; si++) {
      (function (stage) {
        chain = chain.then(function (prev) { return stage(prev, item, index); });
      })(stages[si]);
    }
    return chain.then(function (v) { return v; }, function (e) {
      if (isFatal(e)) { throw e; }
      return null;
    });
  })));
}

function phaseHook(title) {
  throwIfCancelled();
  if (typeof title !== 'string' || title.length === 0) {
    throw WFErr('phase() requires a non-empty title string', 'INVALID_ARGUMENT');
  }
  currentPhase = title;
  post({ type: 'phase', title: title });
}

function logHook(message) {
  throwIfCancelled();
  if (typeof message !== 'string') {
    throw WFErr('log() requires a message string', 'INVALID_ARGUMENT');
  }
  post({ type: 'log', message: message });
}

/* ── 消息胶水 ──────────────────────────────────────────────────── */
self.onmessage = function (ev) {
  var m = ev.data;
  if (!m || typeof m.type !== 'string') { return; }
  switch (m.type) {
    case 'go': {
      limits = m.init.limits;
      run(m.init.body, m.init.args);
      break;
    }
    case 'cancel': {
      if (!cancelled()) {
        cancelReason = m.reason || 'workflow cancelled';
        cancelError = makeCancelledError();
        var ws = slotWaiters.splice(0);
        for (var i = 0; i < ws.length; i++) { ws[i].reject(cancelError); }
      }
      break;
    }
    case 'child-started': {
      var ps = pendingStart[m.callId];
      if (ps) { delete pendingStart[m.callId]; ps.resolve({ callId: m.callId, childId: m.childId }); }
      break;
    }
    case 'child-start-error': {
      var pe = pendingStart[m.callId];
      if (pe) { delete pendingStart[m.callId]; pe.reject(m.rendered); }
      break;
    }
    case 'child-settled': {
      var pr = pendingResult[m.callId];
      if (pr) { delete pendingResult[m.callId]; pr.resolve(m.result); }
      break;
    }
    case 'child-failed': {
      var pf = pendingResult[m.callId];
      if (pf) { delete pendingResult[m.callId]; pf.reject(m.rendered); }
      break;
    }
    case 'child-disposed': {
      var pd = pendingDispose[m.callId];
      if (pd) { delete pendingDispose[m.callId]; pd.resolve(); }
      break;
    }
    case 'node-output-result': {
      var po = pendingNodeOutput[m.callId];
      if (po) { delete pendingNodeOutput[m.callId]; po.resolve(m.result.value); }
      break;
    }
    case 'node-output-error': {
      var poe = pendingNodeOutput[m.callId];
      /* 查询失败一律 fatal INVALID_ARGUMENT（fail-loud：绝不静默 undefined 串坏下游）。 */
      if (poe) { delete pendingNodeOutput[m.callId]; poe.reject(WFErr(m.rendered, 'INVALID_ARGUMENT')); }
      break;
    }
    case 'stage-run-result': {
      var sr = pendingStageRun[m.callId];
      if (sr) { delete pendingStageRun[m.callId]; sr.resolve(m.result.value); }
      break;
    }
    case 'stage-run-error': {
      var sre = pendingStageRun[m.callId];
      /* 画布节点执行失败一律 fatal（fail-loud：图像没生成就不该让下游拿 null 继续）。 */
      if (sre) { delete pendingStageRun[m.callId]; sre.reject(WFErr(m.rendered, 'INVALID_ARGUMENT')); }
      break;
    }
    default: break;
  }
};

/* ── 主执行 ────────────────────────────────────────────────────── */
function run(body, args) {
  var result = { value: null, stopReason: 'completed', agentsStarted: 0 };
  // hooks 经 globalThis 注入 ESM 模块（import() 的模块是独立 scope，无法闭包引用 worker 变量）
  try {
    globalThis.__wfHooks = {
      agent: function (p, o) { return agentHook(p, o); },
      parallel: function (t) { return parallelHook(t); },
      pipeline: function () { return pipelineHook.apply(null, arguments); },
      phase: function (t) { phaseHook(t); },
      log: function (msg) { logHook(msg); },
      nodeOutput: function (uid, slot) { return nodeOutputHook(uid, slot); },
      stage: function (uid, overrides) { return stageHook(uid, overrides); },
      args: args,
    };
  } catch (e) { settleFromError(e); return; }
  // ── 脚本编译执行：双路径（环境能力探测）────────────────────────────
  //  ① 浏览器/Electron worker：import(blobUrl) + createScriptURL
  //     —— 绕开 new Function 在 CSP require-trusted-types-for 'script' 下
  //     「形参被 Chromium 识别成 TrustedString → Function 构造器拒绝」的坑。
  //  ② 无 Blob/URL 环境（node vm 沙箱 / 单测）：new Function 直连
  //     —— vm.createContext 只注入 {self, console, setTimeout}，无 Blob/URL/import。
  //     该环境也没有 CSP，new Function 可直接用。
  var scriptPromise;
  var canUseModuleImport = (typeof Blob === 'function') && (typeof URL !== 'undefined') && !!URL.createObjectURL;
  try {
    if (canUseModuleImport) {
      // body 包成 ESM 模块：解构 hooks → body 在 top-level await 里执行 → 经 export 导出结果
      var modCode = 'const __h = globalThis.__wfHooks;\n' +
        'const agent = __h.agent, parallel = __h.parallel, pipeline = __h.pipeline, phase = __h.phase, log = __h.log, nodeOutput = __h.nodeOutput, stage = __h.stage, args = __h.args;\n' +
        'export const __wfResult = await (async () => {\n' + String(body) + '\n})();';
      var blob = new Blob([modCode], { type: 'text/javascript' });
      var rawUrl = URL.createObjectURL(blob);
      scriptPromise = import(wrapUrl(rawUrl)).then(function (mod) { return mod.__wfResult; });
    } else {
      var compiled = new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'nodeOutput', 'stage', 'args',
        '"use strict"; return (async () => {' + String(body) + '\n})();');
      var h = globalThis.__wfHooks;
      scriptPromise = compiled(h.agent, h.parallel, h.pipeline, h.phase, h.log, h.nodeOutput, h.stage, h.args);
    }
  } catch (parseErr) {
    var extra = ttDiag ? (' [' + ttDiag + ']') : '';
    postResult({ value: null, stopReason: 'error', error: WFErr('workflow script does not parse: ' + String(parseErr) + extra, 'SCRIPT_PARSE').message, agentsStarted: 0 });
    return;
  }  /* 两级链：第一级物化（throw → 其结果 promise reject），第二级 onF 发 completed、
     onR 统一接（含第一级 onF 的 throw —— 同一 then 的 onR 不接本 then onF 的抛错）。 */
  contain(Promise.resolve(scriptPromise).then(function (raw) {
    if (cancelled()) { throw makeCancelledError(); }
    return raw === undefined ? null : materialize(raw, 'the workflow result');
  }).then(function (value) {
    postResult({ value: value, stopReason: 'completed', agentsStarted: started });
  }, function (err) {
    settleFromError(err);
  }));
}
function settleFromError(err) {
  if (cancelled()) {
    postResult({ value: null, stopReason: 'cancelled', error: makeCancelledError().message, agentsStarted: started });
    return;
  }
  var msg;
  try { msg = (err && err.message) ? err.message : String(err); }
  catch (e2) { msg = '[unrenderable thrown value]'; }
  postResult({ value: null, stopReason: 'error', error: msg, agentsStarted: started });
}
function postResult(result) {
  post({ type: 'result', result: result });
}

/* 握手：worker 就绪，等待 go */
post({ type: 'ready' });
`;
