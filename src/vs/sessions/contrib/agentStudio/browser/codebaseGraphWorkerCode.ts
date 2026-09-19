/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Worker 内嵌代码生成（2026-09-09 从 codebaseGraphService.ts 迁出，P1-5 收尾）。
 *
 * ★ 这是**字符串内嵌的 JS**（Blob URL 方式创建 Worker）：不受 tsgo / lint 检查，
 *   语法错误只能在运行时以「Worker 脚本求值失败」暴露。故提供 `codebaseGraphWorkerCode.test.ts`
 *   做 `new Function(code)` 语法自检——**改动本文件后必须跑那条测试**。
 * ★ 打包版依赖「Worker 内经 fileService 读 wasm」的路径，**不得**改为独立 worker 文件 + 模块加载
 *   （`importAMDNodeModule` 在打包 app 走 `vscode-file://` 网络 GET，ERR_FILE_NOT_FOUND）。
 */

import { AST_TO_NODE_TYPE } from '../common/codebaseIndexDefaults.js';
	export function buildWorkerCode(tsJsContent: string): string {
		return `
// === AMD Loader Shim (捕获 @vscode/tree-sitter-wasm 的 define 调用) ===
let _tsModule;
self.define = function(deps, factory) {
  if (typeof deps === 'function') { _tsModule = deps(); }
  else if (Array.isArray(deps) && typeof factory === 'function') {
    const mockDeps = deps.map(function(d) {
      if (d === 'exports') return (_tsModule = {});
      if (d === 'require') return function() { return undefined; };
      return undefined;
    });
    const result = factory.apply(null, mockDeps);
    _tsModule = result || _tsModule;
  } else { _tsModule = deps; }
};
self.define.amd = true;
// CommonJS shim (某些 UMD 模块会检查 module.exports)
self.module = { exports: {} };
self.exports = self.module.exports;
// document stub：tree-sitter.js 模块求值时立即调用 getCurrentScriptUrl()（算 _scriptName/scriptDirectory）。
// Worker 中无 document/__filename → 抛 'Unable to determine script URL'，整个 blob 脚本求值中止、onmessage 从未注册
// → 全部 worker init 超时失败、回退主线程解析（数万文件卡死 UI）。
// scriptDirectory 对本 worker 无意义（运行时 WASM 经 locateFile blob URL 加载），stub 使其温和返回 undefined。
self.document = { currentScript: null };

// === Tree-sitter.js (AMD module, inlined) ===
${tsJsContent}

// === Fallback: 如果 AMD shim 未捕获模块，尝试从全局/CommonJS 获取 ===
if (!_tsModule) {
  if (self.module && self.module.exports && self.module.exports.Parser) {
    _tsModule = self.module.exports;
  } else if (typeof self.TreeSitter !== 'undefined') {
    _tsModule = self.TreeSitter;
  }
}

// === Worker Logic ===
let Parser = null, Language = null, languages = {}, initDone = false;

const AST_TO_NODE_TYPE = ${JSON.stringify(AST_TO_NODE_TYPE)};

async function doInit(tsWasm, langWasms) {
  const TS = _tsModule;
  if (!TS || !TS.Parser) throw new Error('TreeSitter module not loaded (AMD shim failed, _tsModule=' + (TS ? Object.keys(TS) : 'null') + ')');
  // 运行时 WASM：字节已由 postMessage 传入，直接喂 wasmBinary 给 Emscripten——
  // 严禁走 fetch(blob:)：blob worker 继承文档 CSP（connect-src 无 blob:），fetch 必被拦截。
  try {
    await TS.Parser.init({ locateFile: function() { return 'tree-sitter.wasm'; }, wasmBinary: tsWasm });
  } catch (e) {
    throw new Error('TS.Parser.init failed: ' + (e && e.message ? e.message : String(e)) + ' (tsWasmBytes=' + tsWasm.byteLength + ')');
  }
  Parser = TS.Parser;
  Language = TS.Language;
  // 加载语言 WASM。注意：Language.load 仅认 Uint8Array；transfer 到 worker 的是 ArrayBuffer，
  // 直接传会误入 fetch 分支（CSP 拦截）——必须 new Uint8Array 包装。
  let langLoaded = 0;
  const failedLangs = [];
  for (const langName in langWasms) {
    try { languages[langName] = await Language.load(new Uint8Array(langWasms[langName])); langLoaded++; }
    catch(e) { failedLangs.push(langName + '(' + (e && e.message ? e.message : String(e)).substring(0, 80) + ')'); }
  }
  if (failedLangs.length > 0) {
    self.postMessage({ type: 'log', level: 'warn', message: 'lang wasm load failed: ' + failedLangs.join(', ') });
  }
  if (langLoaded === 0 && Object.keys(langWasms).length > 0) {
    throw new Error('No language WASM loaded (0/' + Object.keys(langWasms).length + ')');
  }
  initDone = true;
}

// 递归提取 AST 节点名称 — 支持 C/C++ 深层标识符
// C++ tree-sitter 中标识符通常不在直接子节点：
//   function_definition → declarator:function_declarator → declarator:field_identifier
//   class_specifier     → name:type_identifier
var IDENTIFIER_TYPES = {
  identifier: true, field_identifier: true, type_identifier: true,
  namespace_identifier: true, template_name: true, destructor_name: true
};
// C/C++ 函数名提取：沿 declarator 链取真正函数名（返回类型 type_identifier 在 DFS 中会先命中，
// 如 inline TArray X::ConvertToArray() 会被误取名 "TArray"，须优先走 declarator）
var _isDeclaratorWrapper = function (t) {
  return t === 'function_declarator' || t === 'pointer_declarator' ||
    t === 'reference_declarator' || t === 'parenthesized_declarator' || t === 'init_declarator';
};
function _extractDeclaratorName(node, source) {
  var n = node;
  for (var i = 0; i < 12; i++) {
    var decl = n.childForFieldName ? n.childForFieldName('declarator') : undefined;
    if (!decl) {
      // reference_declarator 等的 function_declarator 无 declarator 字段，从 children 找
      var cs = n.children || [];
      for (var k = 0; k < cs.length; k++) { if (_isDeclaratorWrapper(cs[k].type)) { decl = cs[k]; break; } }
    }
    if (!decl) break;
    n = decl;
    if (_isDeclaratorWrapper(n.type)) { continue; }
    break;
  }
  // qualified_identifier 的 name 可能嵌套（ns::deep::method → deep::method），循环取最内层
  while (n.type === 'qualified_identifier') {
    var nm = n.childForFieldName ? n.childForFieldName('name') : undefined;
    if (!nm || typeof nm.startIndex !== 'number') break;
    if (nm.type === 'qualified_identifier') { n = nm; continue; }
    return source.substring(nm.startIndex, nm.endIndex);
  }
  if (n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'type_identifier' ||
    n.type === 'destructor_name' || n.type === 'operator_name' || n.type === 'template_name' ||
    n.type === 'namespace_identifier') {
    return source.substring(n.startIndex, n.endIndex);
  }
  return undefined;
}
function extractName(node, source) {
  if (node.type === 'function_definition' || node.type === 'function_declaration' || node.type === 'function_declarator') {
    var fnName = _extractDeclaratorName(node, source);
    if (fnName !== undefined) return fnName;
  }
  function recurse(n) {
    if (IDENTIFIER_TYPES[n.type]) return source.substring(n.startIndex, n.endIndex);
    if (n.type === 'name') return source.substring(n.startIndex, n.endIndex);
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) {
      var r = recurse(children[i]);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  return recurse(node);
}

// 分支/循环节点类型（用于复杂度计算）
var BRANCH_NODE_TYPES = {
  if_statement:1, else_clause:1, for_statement:1, while_statement:1,
  do_statement:1, switch_statement:1, case_statement:1, catch_clause:1,
  conditional_expression:1, ternary_expression:1
};
var LOOP_NODE_TYPES = { for_statement:1, while_statement:1, do_statement:1 };

function computeComplexity(node) {
  var cyclomatic = 0, maxLoopDepth = 0;
  function traverse(n, depth) {
    if (BRANCH_NODE_TYPES[n.type]) cyclomatic++;
    if (LOOP_NODE_TYPES[n.type]) { depth++; if (depth > maxLoopDepth) maxLoopDepth = depth; }
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) traverse(children[i], depth);
  }
  traverse(node, 0);
  return { cyclomatic: cyclomatic, maxLoopDepth: maxLoopDepth };
}

function _extractCalleeName(node, source) {
  var fnNode = node.childForFieldName ? node.childForFieldName('function') : undefined;
  if (fnNode) {
    var name = extractName(fnNode, source);
    if (name) return name;
    if (fnNode.type === 'member_expression') {
      var prop = fnNode.childForFieldName ? fnNode.childForFieldName('property') : undefined;
      if (prop) return source.substring(prop.startIndex, prop.endIndex);
    }
    return undefined;
  }
  return undefined;
}

// 过程内高阶热路径分析（#9 过程间传播的基础；worker 内联版）
function _analyzeIntra(node, source, fnName) {
  var ITERATOR_APIS = { forEach:1, map:1, filter:1, reduce:1, reduceRight:1, find:1, findIndex:1, some:1, every:1, flatMap:1, each:1, collect:1, eachChild:1, walk:1, iterate:1 };
  var ALLOC_APIS = { new:1, alloc:1, allocate:1, create:1, make:1, build:1, malloc:1, construct:1, clone:1 };
  var r = { linearScanInLoop:false, allocInLoop:false, recursionInLoop:false, unguardedRecursion:false };
  var isRecursive = false;
  function visit(n, loopDepth, underGuard) {
    if (n.type === 'call_expression' || n.type === 'call' || n.type === 'method_invocation' || n.type === 'invocation_expression') {
      var callee = _extractCalleeName(n, source);
      if (callee) {
        if (callee === fnName) {
          isRecursive = true;
          if (loopDepth > 0) r.recursionInLoop = true;
          if (!underGuard) r.unguardedRecursion = true;
        }
        if (loopDepth > 0) {
          if (ITERATOR_APIS[callee]) r.linearScanInLoop = true;
          if (ALLOC_APIS[callee]) r.allocInLoop = true;
        }
      }
    }
    if (loopDepth > 0 && n.type === 'new_expression') r.allocInLoop = true;
    var isGuard = (n.type === 'if_statement' || n.type === 'conditional_expression' || n.type === 'ternary_expression' || n.type === 'switch_statement' || n.type === 'when_clause' || n.type === 'match_arm' || n.type === 'else_clause');
    var nextLoop = LOOP_NODE_TYPES[n.type] ? loopDepth + 1 : loopDepth;
    var nextGuard = underGuard || isGuard;
    if (n.children) { for (var i = 0; i < n.children.length; i++) visit(n.children[i], nextLoop, nextGuard); }
  }
  visit(node, 0, false);
  if (!isRecursive) r.unguardedRecursion = false;
  return r;
}

// 继承/接口实现提取（worker 内联版，无法 import 外部模块，逻辑与 codebaseGraphQueries.extractInherits 对齐）：
// C++ base_class_clause / TS-Java heritage(extends_clause|implements_clause) / Python superclasses / Ruby superclass
function _extractInheritNames(node, source) {
  var result = { inherits: [], implements: [] };
  function collectInto(n, out) {
    var children = n.children || [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'constant') {
        out.push(source.substring(c.startIndex, c.endIndex));
      }
      collectInto(c, out);
    }
  }
  if (node.childForFieldName) {
    var heritage = node.childForFieldName('heritage');
    if (heritage) {
      var hc = heritage.children || [];
      for (var j = 0; j < hc.length; j++) {
        if (hc[j].type === 'extends_clause') { collectInto(hc[j], result.inherits); }
        else if (hc[j].type === 'implements_clause') { collectInto(hc[j], result.implements); }
        else { collectInto(hc[j], result.inherits); }
      }
    }
    var f = node.childForFieldName('superclasses'); if (f) collectInto(f, result.inherits);
    f = node.childForFieldName('base_class_clause'); if (f) collectInto(f, result.inherits);
    f = node.childForFieldName('superclass'); if (f) collectInto(f, result.inherits);
  }
  return result;
}

// USAGE 提取（读写区分，worker 内联版，与主线程 _isUsageNode/_collectUsageEdges 对齐）
function _isUsageNode(t) {
  return t === 'assignment_expression' || t === 'assignment' ||
    t === 'augmented_assignment_expression' || t === 'compound_assignment_expression' ||
    t === 'type_annotation' || t === 'type_identifier' || t === 'type_hint' ||
    t === 'new_expression' || t === 'object_creation_expression';
}
function _collectUsageEdges(node, source, currentFn, edges) {
  var add = function (name, access) {
    if (name && name.length > 0 && name !== 'this') {
      edges.push({ source: currentFn, target: 'usage:' + name, type: 'USAGE', properties: { access: access } });
    }
  };
  if (node.type === 'assignment_expression' || node.type === 'assignment' ||
    node.type === 'augmented_assignment_expression' || node.type === 'compound_assignment_expression') {
    var left = node.childForFieldName ? (node.childForFieldName('left') || node.childForFieldName('target')) : undefined;
    if (left) {
      if (left.type === 'identifier' || left.type === 'field_identifier') {
        add(source.substring(left.startIndex, left.endIndex), 'write');
      } else if (left.childForFieldName) {
        var prop = left.childForFieldName('property') || left.childForFieldName('field');
        if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) {
          add(source.substring(prop.startIndex, prop.endIndex), 'write');
        }
      }
    }
    return;
  }
  if (node.type === 'type_annotation' || node.type === 'type_hint') {
    var ch = node.children || [];
    for (var i = 0; i < ch.length; i++) {
      if (ch[i].type === 'type_identifier' || ch[i].type === 'identifier') {
        add(source.substring(ch[i].startIndex, ch[i].endIndex), 'read');
      }
    }
    return;
  }
  if (node.type === 'type_identifier') {
    add(source.substring(node.startIndex, node.endIndex), 'read');
    return;
  }
  if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
    var ctor = node.childForFieldName ? (node.childForFieldName('constructor') || node.childForFieldName('type') || node.childForFieldName('class')) : undefined;
    if (ctor) {
      add(source.substring(ctor.startIndex, ctor.endIndex), 'read');
    }
  }
}

function walkAST(node, source, filePath, nodes, edges, currentFn, loopDepth) {
  if (loopDepth === undefined) loopDepth = 0;
  const nodeType = AST_TO_NODE_TYPE[node.type];
  let myFn = currentFn;
  // Call sites → CALLS edge (virtual target, resolved later in _matchCallsToDefinitions)
  if (currentFn && (node.type === 'call_expression' || node.type === 'call' || node.type === 'method_invocation' || node.type === 'invocation_expression')) {
    const callee = _extractCalleeName(node, source);
    if (callee) {
      edges.push({ source: currentFn, target: 'call:' + callee, type: 'CALLS', properties: { loopDepth: loopDepth } });
    }
  }
  // Usage sites → USAGE edge (read/write, resolved later in _matchUsageEdgesToDefinitions)
  if (currentFn && _isUsageNode(node.type)) {
    _collectUsageEdges(node, source, currentFn, edges);
  }
  if (nodeType) {
    const name = extractName(node, source);
    if (name) {
      const qualifiedName = filePath + '::' + name;
      const startLine = node.startPosition ? node.startPosition.row + 1 : undefined;
      const endLine = node.endPosition ? node.endPosition.row + 1 : undefined;
      var cx = computeComplexity(node);
      var intra = (nodeType === 'function' || nodeType === 'method') ? _analyzeIntra(node, source, name) : undefined;
      var hasMetrics = cx.cyclomatic > 0 || cx.maxLoopDepth > 0;
      var props = (hasMetrics || intra) ? {} : undefined;
      if (hasMetrics) { props.cyclomatic = cx.cyclomatic; props.loop_depth = cx.maxLoopDepth; }
      if (intra) {
        props.linear_scan_in_loop = intra.linearScanInLoop ? 1 : 0;
        props.alloc_in_loop = intra.allocInLoop ? 1 : 0;
        props.recursion_in_loop = intra.recursionInLoop ? 1 : 0;
        props.unguarded_recursion = intra.unguardedRecursion ? 1 : 0;
      }
      nodes.push({ id: qualifiedName, name: name, type: nodeType, filePath: filePath, qualifiedName: qualifiedName, inDegree: 0, outDegree: 0, startLine: startLine, endLine: endLine, properties: props });
      edges.push({ source: filePath, target: qualifiedName, type: 'CONTAINS' });
      // 继承/接口实现边（虚拟目标 inherits:/implements:<baseName>，索引后由 _matchInheritsToDefinitions 解析）
      if (nodeType === 'class' || nodeType === 'interface') {
        var bases = _extractInheritNames(node, source);
        for (var bi = 0; bi < bases.inherits.length; bi++) {
          edges.push({ source: qualifiedName, target: 'inherits:' + bases.inherits[bi], type: 'INHERITS' });
        }
        for (var ii = 0; ii < bases.implements.length; ii++) {
          edges.push({ source: qualifiedName, target: 'implements:' + bases.implements[ii], type: 'IMPLEMENTS' });
        }
      }
      myFn = qualifiedName;
    }
  }
  const nextLoopDepth = LOOP_NODE_TYPES[node.type] ? loopDepth + 1 : loopDepth;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      walkAST(node.children[i], source, filePath, nodes, edges, myFn, nextLoopDepth);
    }
  }
}

// Worker 级 parser 缓存（对齐 C 版 get_thread_parser）：按语言复用 Parser 实例，
// 避免大仓库每文件一次 new Parser() + setLanguage（数万次 WASM 语言绑定开销）。
const parserCache = {};

self.onmessage = async function(e) {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await doInit(msg.tsWasm, msg.langWasms);
      self.postMessage({ type: 'init-done', langCount: Object.keys(languages).length });
    } catch(err) {
      self.postMessage({ type: 'init-error', error: err.message || String(err) });
    }
  } else if (msg.type === 'parse') {
    try {
      const lang = languages[msg.langName];
      if (!lang) {
        // ★★★ 2026-09-18（用户报「C++ 项目检索不到内容：535 个 .cpp/.h 全部 0 节点」）：**缺 grammar
        // 绝不能静默返回空结果**。旧实现（用户实测 failed=0、日志一片绿）：
        //   postMessage({ ..., nodes: [], edges: [] })   ← 不带 error/status
        // ⇒ 调用方（pool.parse）据此判为「indexed（0 节点）」⇒ 索引摘要 indexed=535 failed=0、
        //   制品被写成空图，用户只看到「尚无数据」，无从判断是「这目录没代码」还是「解析器没工作」。
        // 带上 error + noGrammar 后：pool 记为 parse_error（failed++），service 会打「缺 grammar」告警。
        self.postMessage({ type: 'parse-result', id: msg.id, nodes: [], edges: [], noGrammar: true,
          error: 'no tree-sitter grammar loaded for language "' + msg.langName
            + '" (missing tree-sitter-' + msg.langName + '.wasm — usually the install package omitted this language asset)' });
        return;
      }
      let parser = parserCache[msg.langName];
      if (!parser) { parser = new Parser(); parser.setLanguage(lang); parserCache[msg.langName] = parser; }
      const tree = parser.parse(msg.source);
      const nodes = [], edges = [];
      // 必须释放 tree（WASM 线性内存），否则数千文件后 ts_malloc_default abort
      if (tree) { try { walkAST(tree.rootNode, msg.source, msg.filePath, nodes, edges); } finally { tree.delete(); } }
      self.postMessage({ type: 'parse-result', id: msg.id, nodes: nodes, edges: edges });
    } catch(err) {
      self.postMessage({ type: 'parse-result', id: msg.id, nodes: [], edges: [], error: err.message || String(err) });
    }
  }
};
`;
	}
