---
name: confightml
description: 生成零依赖、可在浏览器内编辑的自包含单文件 HTML 面板（ConfigHtml）
activation: auto
match: [confightml, config.html, config html, html 面板, html panel, 单文件 html, 可编辑 html, editable html, 生成页面, 生成网页, 制作页面, 做个页面, agent 面板, 配置面板, 海报, 卡片, 落地页, landing page, poster]
category: creative
recommended_tools: []
---

You are running the **confightml** skill.

## 你的唯一职责

根据用户的自然语言需求，生成一份 **完整的、自包含的、零依赖的单文件 HTML 文档**。
这份 HTML 会被原样写入 Agent 的 `config.html` 文件，并在 Canvas 中预览，
用户可以在编辑器内直接拖拽 / 编辑其中的元素。

## 文件名与路径约束（强制）

- **文件名固定为 `config.html`**，不可改名。
- **文件路径固定为 `~/.saros/agents/{agentId}/config.html`**。

## 数据持久化（保存按钮 / Ctrl+S）

表单控件（`<input>` / `<textarea>` / `<select>`）的值在编辑模式下通过**保存按钮**或 **Ctrl+S** 持久化到 `config.html`：

- **编辑模式下**：用户输入 → 运行时自动更新 HTML 的 `value`/`checked`/`selected` 属性 → 点击工具栏**保存按钮**或按 **Ctrl+S** → 写入磁盘。
- **非编辑模式下**：页面加载时从 HTML 属性恢复显示值。
- 你**不需要**写任何 JS 持久化逻辑——运行时完全自动处理。
- 标记 `data-no-persist` 的输入框不参与持久化（如临时搜索框）。
- 编辑器会自动同步内存模型，Ctrl+Z/Y 可撤销/重做。

```html
<!-- 编辑模式下输入值自动持久化到 value 属性 -->
<input type="text" value="默认名" placeholder="输入名称" />

<!-- 不需要持久化的临时输入框 -->
<input type="text" data-no-persist placeholder="搜索…" />
```

---

## 协议 API 参考

`config.html` 通过全局对象 `window.AgentConfigHtml` 与宿主通信。所有方法均为 **异步返回 Promise**。

### API 速查表

| 方法 | 签名 | 用途 | 典型场景 |
|------|------|------|----------|
| `connect()` | `() → Promise<AgentConfigHtml>` | 建立与宿主的通信连接 | 页面初始化 |
| `chatSend(msg, opts?)` | `(string, {context?, showInChat?}) → Promise<void>` | 单向发送消息给 Agent | 触发 Agent 执行任务 |
| `chatSendStream(msg, cb)` | `(string, StreamCallbacks) → {cancel()}` | **流式发送 + 接收实时回复**（可取消） | 对话面板、AI 问答 |
| `runTerminal(cmd, args?, opts?)` | `(string, string[]?, {cwd?, env?}?) → Promise<void>` | **在集成终端中执行命令**（实时输出） | 运行 Python/Node 脚本、pip 安装 |
| `writeHtml(html)` | `(string) → Promise<void>` | **将 HTML 内容写入 config.html 并落盘** | 保存表单配置、持久化页面修改 |
| `kvGet(key)` | `(string) → Promise<any>` | **从数据存储读取值** | 读取配置、历史记录 |
| `kvSet(key, value)` | `(string, any) → Promise<void>` | **写入数据存储并落盘** | 保存配置、存储分析结果 |
| `kvDelete(key)` | `(string) → Promise<void>` | 删除数据存储中的 key | 清理旧数据 |
| `kvList(prefix?)` | `(string?) → Promise<string[]>` | 列举 key（可选前缀过滤） | 枚举报告列表 |
| `sendEvent(name, payload?)` | `(string, any?) → Promise<void>` | 发送自定义事件给 Agent | 按钮点击、状态上报 |
| `notify(msg, level?)` | `(string, 'info'\|'success'\|'warning'\|'error'?) → Promise<void>` | 在 Agent Studio UI 显示通知 | 操作成功/失败提示 |
| `on(event, fn)` | `('command'\|'message', fn) → void` | 监听宿主推送事件 | 接收 Agent 指令 |

---

### 1. 连接 connect()

页面初始化时调用，建立 postMessage 通信通道。

```js
var api = await window.AgentConfigHtml.connect();
// 连接成功后 window.AgentConfigHtml.isConnected() 返回 true
```

---

### 2. 单向发送 chatSend(msg, opts?)

将消息发送给 Agent 处理，**不返回回复给 config.html**（Agent 的回复在聊天面板中显示）。

```js
await window.AgentConfigHtml.chatSend('请分析 /data/report.csv 并更新看板', {
  showInChat: true  // 默认 true
});
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | ✅ | 发送给 Agent 的消息 |
| `options.showInChat` | boolean | ❌ | 默认 `true` |

---

### 3. 流式对话 chatSendStream(msg, callbacks) ⭐ 核心 API

发送消息并**实时接收 Agent 的流式回复**（逐 token 推送回页面）。返回 `{cancel()}` 可随时中断。

```js
var stream = window.AgentConfigHtml.chatSendStream('今天天气怎么样？', {
  onDelta: function(d) {
    // d.type: 'text' | 'thinking' | 'tool_start' | 'tool_end' | 'done'
    // d.content: 增量文本  d.fullText: 累积完整文本（推荐用于展示）
    // d.toolName: 工具名  d.toolResult: 工具结果
  },
  onDone: function(ok, fullText, error) {
    // ok: true=成功 false=失败  fullText: 完整回复  error: 失败原因
  }
});
stream.cancel(); // 中断
```

**Delta 类型表：**

| `d.type` | 何时触发 | 可用字段 |
|----------|----------|----------|
| `text` | 模型输出普通 token | `content`, `fullText` |
| `thinking` | 模型内部推理 | `content`, `fullText` |
| `tool_start` | Agent 开始调用工具 | `toolName` |
| `tool_end` | 工具执行完成 | `toolName`, `toolResult` |
| `done` | 所有内容输出完毕 | —（紧接着触发 `onDone`） |

**最佳实践：** 用 `d.fullText` 展示、一个 stream 同时只一个、`onDone` 中清理 UI 状态。

**完整对话面板：**

```html
<div id="chat-output" style="max-height:400px;overflow:auto"></div>
<div style="display:flex;gap:8px;margin-top:8px">
  <input id="chat-input" placeholder="输入消息…" style="flex:1" />
  <button id="chat-send">发送</button>
  <button id="chat-cancel" disabled>取消</button>
</div>
<script>
var stream = null;
var output = document.getElementById('chat-output');
function append(html){ output.innerHTML += html; output.scrollTop = output.scrollHeight; }

document.getElementById('chat-send').onclick = function(){
  var msg = document.getElementById('chat-input').value.trim();
  if(!msg || stream) return;
  document.getElementById('chat-input').value = '';
  append('<div><b>你：</b>' + msg + '</div>');
  document.getElementById('chat-send').disabled = true;
  document.getElementById('chat-cancel').disabled = false;

  stream = window.AgentConfigHtml.chatSendStream(msg, {
    onDelta: function(d){
      if(d.type==='text' || d.type==='thinking'){
        if(!document.getElementById('assistant-msg'))
          append('<div id="assistant-msg"><b>Agent：</b><span></span></div>');
        document.querySelector('#assistant-msg span').textContent = d.fullText || '';
      } else if(d.type==='tool_start'){
        append('<div>🔧 ' + d.toolName + ' 执行中…</div>');
      } else if(d.type==='tool_end'){
        append('<div>✓ ' + d.toolName + ' 完成</div>');
      }
    },
    onDone: function(ok, fullText, error){
      stream = null;
      document.getElementById('chat-send').disabled = false;
      document.getElementById('chat-cancel').disabled = true;
      if(!ok) append('<div>⚠ ' + error + '</div>');
    }
  });
};

document.getElementById('chat-cancel').onclick = function(){
  if(stream){ stream.cancel(); stream = null; }
  document.getElementById('chat-send').disabled = false;
  document.getElementById('chat-cancel').disabled = true;
};
</script>
```

---

### 4. 事件与通知 sendEvent() / notify() / on()

```js
await window.AgentConfigHtml.sendEvent('button.clicked', { buttonId: 'refresh' });
await window.AgentConfigHtml.notify('操作成功', 'success');

window.AgentConfigHtml.on('command', function(cmd) {
  if(cmd.name === 'refresh') location.reload();
});
```

---

### 5. 终端执行 runTerminal(cmd, args?, opts?) ⭐ 运行脚本

在 **VS Saros 集成终端**中执行命令，实时显示 `stdout`/`stderr` 输出。终端窗口会自动聚焦，用户可见完整的执行进度。

适用于运行 Python 脚本、Node 脚本、pip/npm 安装等任意 CLI 命令。

```js
// 运行 Python 脚本（输出显示在集成终端中）
await window.AgentConfigHtml.runTerminal('python', ['script.py']);

// 指定工作目录
await window.AgentConfigHtml.runTerminal('python', ['train.py'], { cwd: '/path/to/project' });

// 设置环境变量
await window.AgentConfigHtml.runTerminal('python', ['server.py'], { env: { DEBUG: '1' } });

// 运行 Node 脚本
await window.AgentConfigHtml.runTerminal('node', ['build.js']);

// 安装依赖
await window.AgentConfigHtml.runTerminal('pip', ['install', '-r', 'requirements.txt']);
await window.AgentConfigHtml.runTerminal('npm', ['install']);
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cmd` | string | ✅ | 要执行的命令（如 `python`、`node`、`pip`、`npm`） |
| `args` | string[] | ❌ | 命令行参数，默认 `[]` |
| `options.cwd` | string | ❌ | 工作目录，默认使用 Agent 工作目录 |
| `options.env` | Record<string, string> | ❌ | 额外的环境变量 |

**完整示例——Python 脚本执行面板：**

```html
<div class="card">
  <h3>🐍 Python 脚本执行</h3>
  <label>脚本路径 <input id="script-path" type="text" value="script.py" /></label>
  <label style="margin-top:8px">参数 <input id="script-args" type="text" placeholder="--epochs 100 --batch 32" /></label>
  <div style="margin-top:12px;display:flex;gap:8px">
    <button id="btn-run">▶ 运行</button>
    <button id="btn-install" class="secondary">📦 安装依赖</button>
    <span id="run-status" style="font-size:13px;color:var(--deck-chrome-muted)"></span>
  </div>
</div>
<script>
document.getElementById('btn-run').onclick = async function(){
  var status = document.getElementById('run-status');
  status.textContent = '执行中…';
  try {
    var path = document.getElementById('script-path').value.trim();
    var args = document.getElementById('script-args').value.trim().split(/\s+/).filter(Boolean);
    await window.AgentConfigHtml.runTerminal('python', [path].concat(args));
    status.textContent = '✓ 已启动，请查看终端窗口';
  } catch(e){
    status.textContent = '✗ 失败: ' + e.message;
  }
};
document.getElementById('btn-install').onclick = async function(){
  await window.AgentConfigHtml.runTerminal('pip', ['install', '-r', 'requirements.txt']);
};
</script>
```

**注意事项：**
- 命令在**新终端实例**中执行，不会影响已有终端
- 执行完成后终端保持打开，方便查看完整日志和输出
- 需要系统中已安装对应命令（如 `python` 在系统 PATH 中可访问）
- `runTerminal` 返回 Promise，在终端创建并开始执行后即 resolve（不等命令执行结束）

---

### 6. 文件保存 writeHtml(html) ⭐ 持久化

将完整的 HTML 内容写入 `config.html` 文件并落盘。适用于：表单配置保存、运行时修改页面结构后持久化、动态生成内容写入文件。

```js
// 保存当前页面 HTML（含 input 修改后的 value 属性）到磁盘
var fullHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
await window.AgentConfigHtml.writeHtml(fullHtml);
console.log('已写入磁盘');
```

**典型场景——表单配置保存：**

```html
<button id="btn-save">💾 保存配置</button>
<script>
document.getElementById('btn-save').onclick = async function() {
  // 1. 将 input 当前值写入 HTML value 属性
  document.querySelectorAll('input[type="text"]').forEach(function(input) {
    input.setAttribute('value', input.value);
  });
  document.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
    if (cb.checked) cb.setAttribute('checked', '');
    else cb.removeAttribute('checked');
  });

  // 2. 获取完整 HTML 并落盘
  var html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  try {
    await window.AgentConfigHtml.writeHtml(html);
    alert('✅ 配置已保存到文件');
  } catch(e) {
    alert('❌ 保存失败: ' + e.message);
  }
};
</script>
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `html` | string | ✅ | 完整的 HTML 文档内容（从 `<!DOCTYPE html>` 开始） |

**注意事项：**
- 传入的是**完整 HTML 文档**，宿主会自动剥离注入的 SDK/CSP 代码后写盘
- 保存后**不会自动刷新预览**（避免运行时状态冲突），用户切换模式或重开文件时加载最新内容
- `setAttribute('value', ...)` 是关键——仅修改 `.value` 属性不会反映到 `outerHTML` 中，必须同步 `value` HTML 属性
- `checkbox` 需要 `setAttribute('checked', '')` / `removeAttribute('checked')` 同步
- `select` 需要 `option.setAttribute('selected', '')` 同步选中项

**input/checkbox/select 属性同步辅助函数：**

```js
function syncFormAttrsToHtml() {
  // text input
  document.querySelectorAll('input[type="text"], input[type="password"], textarea').forEach(function(el) {
    el.setAttribute('value', el.value);
    if (el.tagName === 'TEXTAREA') el.textContent = el.value;
  });
  // checkbox
  document.querySelectorAll('input[type="checkbox"]').forEach(function(el) {
    if (el.checked) el.setAttribute('checked', ''); else el.removeAttribute('checked');
  });
  // select
  document.querySelectorAll('select').forEach(function(sel) {
    sel.querySelectorAll('option').forEach(function(opt) {
      if (opt.selected) opt.setAttribute('selected', ''); else opt.removeAttribute('selected');
    });
  });
}

// 保存时调用：
syncFormAttrsToHtml();
var html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
await window.AgentConfigHtml.writeHtml(html);
```

---

### 7. 数据存储 kvGet / kvSet / kvDelete / kvList ⭐ 结构化数据持久化

KV 存储提供轻量级结构化数据持久化，数据保存在 `~/.vssaros/agents/{agentId}/data/kv.json`。

```js
// 保存配置
await AgentConfigHtml.kvSet('settings', {
  insightsPath: 'F:/UE5/UnrealInsights.exe',
  cacheDir: 'D:/TraceCache',
  autoCpu: true,
});

// 读取配置
var settings = await AgentConfigHtml.kvGet('settings');
// → { insightsPath: '...', cacheDir: '...', autoCpu: true }

// 删除
await AgentConfigHtml.kvDelete('settings');

// 列举所有 key（可选前缀）
var allKeys = await AgentConfigHtml.kvList();
var reportKeys = await AgentConfigHtml.kvList('report_');
// → ['report_2025-07-01', 'report_2025-07-02']
```

| 方法 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `kvGet(key)` | key: string | `Promise<any \| undefined>` | 读取值，不存在返回 undefined |
| `kvSet(key, value)` | key: string, value: any | `Promise<void>` | 写入并落盘 |
| `kvDelete(key)` | key: string | `Promise<void>` | 删除 key |
| `kvList(prefix?)` | prefix?: string | `Promise<string[]>` | 列举 key，可选前缀过滤 |

**典型场景——分析报告存储与展示：**

```html
<script>
// 保存分析结果
async function saveReport(traceFile, results) {
  var reportId = 'report_' + new Date().toISOString().slice(0, 10);
  await AgentConfigHtml.kvSet(reportId, {
    trace: traceFile,
    cpuMs: results.cpuMs,
    gcPct: results.gcPct,
    status: 'completed',
    timestamp: Date.now(),
  });
}

// 加载所有报告
async function loadReports() {
  var keys = await AgentConfigHtml.kvList('report_');
  var reports = await Promise.all(
    keys.map(async function(k) {
      return Object.assign({ id: k }, await AgentConfigHtml.kvGet(k));
    })
  );
  return reports.sort(function(a, b) { return b.timestamp - a.timestamp; });
}

// 清理旧报告（保留最近 50 条）
async function cleanupOldReports() {
  var keys = await AgentConfigHtml.kvList('report_');
  if (keys.length <= 50) return;
  var reports = await Promise.all(
    keys.map(async function(k) {
      return { key: k, ts: (await AgentConfigHtml.kvGet(k)).timestamp };
    })
  );
  reports.sort(function(a, b) { return b.ts - a.ts; });
  var toDelete = reports.slice(50);
  for (var i = 0; i < toDelete.length; i++) {
    await AgentConfigHtml.kvDelete(toDelete[i].key);
  }
}
</script>
```

**KV 存储 vs writeHtml：**

| | `kvSet/kvGet` | `writeHtml` |
|---|---|---|
| 存储格式 | JSON 结构化数据 | 完整 HTML 文档 |
| 查询能力 | key 精确 + 前缀过滤 | 无 |
| 适合场景 | 配置、报告、状态 | 页面结构修改 |
| 容量 | < 10MB（单 JSON 文件） | 无限制 |
| 读写延迟 | ~5ms | ~20ms |

---
## 输出格式（强制）

- **只输出一个 ```html 代码块**，里面是一份从 `<!DOCTYPE html>` 到 `</html>` 的完整文档。
- 代码块前后可以有一两句简短中文说明，但**绝不要**把 HTML 拆成多个片段。
- **绝不要**输出 `configmd-patch` / `configmd-command` 这类旧块（那是已废弃的 ConfigMD 协议）。
- 如果用户只是要求**局部修改**已有 HTML，仍然输出**完整文档**，不要只给 diff。

## 硬性约束：零依赖单文件

1. **不允许任何外部资源**：禁止外链 CSS/JS/字体/图片 CDN。图标用内联 SVG，字体用系统字体栈。
2. **所有 CSS 内联在 `<style>` 中**，所有 JS 内联在 `<script>` 中。
3. 文档 **结构清晰、语义化**：`<header> <main> <section> <footer>`，标题层级正确。
4. 默认 **浅色主题**，颜色用 CSS 变量集中在 `:root`。
5. 响应式：1280px 不溢出。

## 可编辑契约

### data-edit-slot（原位编辑）

```html
<h1 data-edit-slot data-slot-type="text">可编辑标题</h1>
<p data-edit-slot data-slot-type="text">可直接改的文字。</p>
```
`data-slot-type`: `text` / `image` / `metric` / `table-cell`

### data-slide-object（自由拖拽，可选）

```html
<div data-slide-object data-oid="o1" style="position:absolute;left:8%;top:12%;width:40%">
  <div contenteditable="false">可拖动块</div>
</div>
```
- `data-oid` 文档内唯一；父容器 `position:relative`

### --deck-chrome-*（推荐）

```css
:root{
  --deck-chrome-bg:rgba(255,255,255,.92);--deck-chrome-border:rgba(0,0,0,.12);
  --deck-chrome-text:#1f2937;--deck-chrome-muted:#6b7280;--deck-chrome-accent:#2563eb;
  --deck-chrome-shadow:0 6px 24px rgba(0,0,0,.18);--deck-chrome-surface:#f9fafb;
}
```

### 编辑模式表单持久化

- 编辑模式中用户在 `<input>` / `<textarea>` / `<select>` 输入的值**自动**写入对应 HTML 属性
- 保存时这些值随 HTML 一起持久化，无需任何 JS
- `data-no-persist` 标记的控件不参与持久化

> 不要写编辑器运行时 JS，宿主自动注入。你只产出**带正确标注的静态 HTML**。

---

## 生成流程

1. 理解用户意图（面板 / 对话 / 看板 / 落地页…）。
2. 选视觉风格，定义 `:root` 颜色 + `--deck-chrome-*`。
3. 写语义化结构，标注 `data-edit-slot`；表单控件设置合理的 `value` / `placeholder` 默认值。
4. 如需动态交互，按需加入 `<script>`——仅限协议 API 调用（`chatSend` / `chatSendStream` / `runTerminal` / `writeHtml` / `kvGet` / `kvSet` / `kvDelete` / `kvList` / `sendEvent` / `notify`），不写编辑器逻辑。
5. 自检：零外链、`data-oid` 唯一、API 调用在 try/catch 中。
6. 输出**单个** ```html 代码块。

---

## 完整集成示例（表单持久化 + 流式对话）

```html
<!DOCTYPE html>
<html lang="zh-CN" data-template-edit-mode="slots">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 助手</title>
<style>
  :root{--bg:#f6f7fb;--fg:#1f2937;--accent:#2563eb;--card:#fff;--border:rgba(0,0,0,.08);
    --deck-chrome-bg:rgba(255,255,255,.92);--deck-chrome-border:rgba(0,0,0,.12);
    --deck-chrome-text:#1f2937;--deck-chrome-muted:#6b7280;--deck-chrome-accent:#2563eb;
    --deck-chrome-shadow:0 6px 24px rgba(0,0,0,.18);--deck-chrome-surface:#f9fafb;}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);line-height:1.6}
  main{max-width:760px;margin:0 auto;padding:32px 20px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
  input,textarea{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font:inherit}
  button{padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  button.secondary{background:transparent;color:var(--fg)}
  #chat-output{max-height:360px;overflow:auto;display:flex;flex-direction:column;gap:8px}
  .user-msg{align-self:flex-end;background:var(--accent);color:#fff;padding:8px 12px;border-radius:8px;max-width:80%}
  .assistant-msg{align-self:flex-start;background:var(--bg);padding:8px 12px;border-radius:8px;max-width:85%;border:1px solid var(--border)}
  .tool-card{font-size:12px;color:var(--deck-chrome-muted);align-self:flex-start}
</style>
</head>
<body><main>
  <!-- 设置区：编辑模式下输入值自动持久化到 HTML 属性 -->
  <section class="card">
    <h3 data-edit-slot data-slot-type="text">⚙ 设置</h3>
    <label>系统名称 <input type="text" value="默认系统" data-edit-slot data-slot-type="text" /></label>
    <label style="margin-top:8px"><input type="checkbox" checked /> 自动摘要（编辑模式可切换并持久化 checked 属性）</label>
  </section>

  <!-- 对话区 -->
  <section class="card">
    <h3 data-edit-slot data-slot-type="text">💬 对话</h3>
    <div id="chat-output"></div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <input id="chat-input" placeholder="输入消息…" data-no-persist />
      <button id="chat-send">发送</button>
      <button id="chat-cancel" class="secondary" disabled>取消</button>
    </div>
  </section>
</main></body>
<script>
(async function(){
  await window.AgentConfigHtml.connect();
  var stream = null;
  var output = document.getElementById('chat-output');
  function append(className, html){
    var d = document.createElement('div');d.className = className;d.innerHTML = html;
    output.appendChild(d);output.scrollTop = output.scrollHeight;
  }

  document.getElementById('chat-send').onclick = function(){
    var msg = document.getElementById('chat-input').value.trim();
    if(!msg || stream) return;
    document.getElementById('chat-input').value = '';
    append('user-msg', msg);
    document.getElementById('chat-send').disabled = true;
    document.getElementById('chat-cancel').disabled = false;

    var msgDiv = document.createElement('div');
    msgDiv.className = 'assistant-msg'; msgDiv.innerHTML = '<b>Agent：</b><span></span>';
    output.appendChild(msgDiv);
    var span = msgDiv.querySelector('span');

    stream = window.AgentConfigHtml.chatSendStream(msg, {
      onDelta: function(d){
        if(d.type==='text' || d.type==='thinking'){
          span.textContent = d.fullText || '';
          output.scrollTop = output.scrollHeight;
        } else if(d.type==='tool_start'){
          append('tool-card', '🔧 ' + d.toolName);
        } else if(d.type==='tool_end'){
          append('tool-card', '✓ ' + d.toolName + ' 完成');
        }
      },
      onDone: function(ok, fullText, error){
        stream = null;
        document.getElementById('chat-send').disabled = false;
        document.getElementById('chat-cancel').disabled = true;
        if(!ok) span.textContent += ' [' + error + ']';
      }
    });
  };

  document.getElementById('chat-cancel').onclick = function(){
    if(stream){ stream.cancel(); stream = null; }
    document.getElementById('chat-send').disabled = false;
    document.getElementById('chat-cancel').disabled = true;
  };
})();
</script>
</html>
```

记住：**只输出完整的单文件 HTML，标注好可编辑 slot，表单控件设好默认 value。动态交互仅限 AgentConfigHtml 协议 API（`chatSend` / `chatSendStream` / `runTerminal` / `writeHtml` / `kvGet` / `kvSet` / `kvDelete` / `kvList` / `sendEvent` / `notify`），不写编辑器运行时。如需保存表单配置，使用 `writeHtml` + `setAttribute('value', ...)` 或 `kvSet` / `kvGet` 模式。**
