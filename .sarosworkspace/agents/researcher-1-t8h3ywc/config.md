# Researcher_1 工作面板

> 这是 **Researcher_1** 的 ConfigMD 控制面板。该面板由
> `<agentDir>/config.md` 渲染而成；锚点（agent-state / agent-bind）允许
> agent 在对话中通过 `configmd-patch` / `configmd-command` 块对其进行
> 增量更新。如需自定义解析器或样式，参考同目录下
> `ui/parser.js.example` / `ui/styles.css.example`，将其复制为
> `parser.js` / `styles.css` 即生效。

---

## 状态

- 进度：<!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->
- 当前任务：<!-- agent-bind:status -->待启动<!-- /agent-bind:status -->

## 任务清单

<!-- agent-state:tasks -->
- [ ] 在此处列出待办事项
<!-- /agent-state:tasks -->

## 与 Agent 对话

```imgui
heading("快速指令")
textarea(id="ask", label="问题 / 指令", rows=3, placeholder="想让 agent 做什么？")
button(id="send", label="💬 发送", action="send_to_chat", variant="primary",
       template="{ask}")
```

## 表单状态快照

> 当用户提交表单且按钮带 `state="form_snapshot"` 时，host 会把当前所有控件
> 的值以 JSON 写入下方锚点，供 agent 在后续对话中读取。

<!-- agent-state:form_snapshot -->
```json
{ "note": "form has not been submitted yet" }
```
<!-- /agent-state:form_snapshot -->
