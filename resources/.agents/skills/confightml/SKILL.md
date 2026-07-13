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
4. 如需动态交互，按需加入 `<script>`——仅限协议 API 调用（`chatSend` / `chatSendStream` / `sendEvent` / `notify`），不写编辑器逻辑。
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

记住：**只输出完整的单文件 HTML，标注好可编辑 slot，表单控件设好默认 value，不写编辑器运行时。**
