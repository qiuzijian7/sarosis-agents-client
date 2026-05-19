/*---------------------------------------------------------------------------------------------
 *  ConfigMD demo — exercises every Phase 1/2/3 imgui feature:
 *    Widgets:
 *      heading / text / divider / spacer
 *      input_text / textarea / number / slider
 *      select / radio / checkbox
 *      progress / badge
 *      row_start / row_end / column_start / column_end
 *      button(action=send_to_chat | run_skill | set_state | patch | clear_chat,
 *             confirm?, variant?, state? <Phase 3: snapshot anchor>)
 *
 *    Bidirectional:
 *      Form values persist via sessionStorage across reloads.
 *      Agent can push `imgui.set` / `imgui.toast` / `imgui.reset` commands
 *      back into the preview by emitting a ```configmd-command``` block.
 *      Phase 3: assistant replies sent via imgui buttons are also parsed
 *      for configmd-command blocks (previously only HTML-event-originated
 *      replies were).
 *
 *    Anchors:
 *      <!-- agent-state:NAME -->...<!-- /agent-state:NAME -->
 *      <!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->
 *
 *    Phase 3 highlights:
 *      §1 — agent → preview state push (imgui.set_one / imgui.toast) now
 *           works from chat replies originating in the imgui form itself.
 *      §2 — `state="form_snapshot"` on the submit button writes a JSON
 *           snapshot of all form values into the agent-state anchor
 *           BEFORE sending the chat message, so the agent can re-read
 *           the form state in any later prompt.
 *      §6 — intentional broken imgui block to show parser error UI.
 *--------------------------------------------------------------------------------------------*/

export const CONFIG_MD_DEMO = `# 🎯 ConfigMD · 研究分析师工作台

> **Phase 3 演示** — 控件 · action · 双向命令 · 持久化 · 二次确认 · 状态闭环 · 错误诊断。

---

## 1. 进度面板（agent → preview 双向通信）

\`\`\`imgui
heading("当前研究进度")
row_start()
progress(id="overall", label="总体进度", value=45, max=100)
badge("进行中", color="info")
row_end()
spacer()
text("👇 让 Agent 直接推送进度更新（Phase 3：消息走 imgui 提交也会解析回复中的 configmd-command）")

row_start()
button(id="ask_progress_80", label="📤 让 Agent 推送 80%", action="send_to_chat", variant="secondary",
       template="请输出一个 configmd-command 代码块，把进度（id=overall）设为 80。格式：\\n\\n\\\`\\\`\\\`configmd-command\\n{ \\"name\\": \\"imgui.set_one\\", \\"params\\": { \\"id\\": \\"overall\\", \\"value\\": 80 } }\\n\\\`\\\`\\\`")
button(id="ask_toast", label="🍞 让 Agent 弹 toast", action="send_to_chat", variant="secondary",
       template="请输出一个 configmd-command 代码块显示成功 toast：\\n\\n\\\`\\\`\\\`configmd-command\\n{ \\"name\\": \\"imgui.toast\\", \\"params\\": { \\"message\\": \\"已收到指令\\", \\"variant\\": \\"success\\" } }\\n\\\`\\\`\\\`")
row_end()
\`\`\`

---

## 2. 调研参数（Phase 3：state snapshot）

\`\`\`imgui
heading("发起新一轮调研")
text("此表单值会自动持久化（sessionStorage），刷新后保留。")
text("Phase 3：「开始调研」按钮带 state=\\"form_snapshot\\"，提交时会把全部表单值以 JSON 写入 §7 锚点 — Agent 在后续对话中可读取。")

input_text(id="topic", label="研究主题", placeholder="例：AI Agent 框架对比")
textarea(id="background", label="背景信息", rows=3, placeholder="补充上下文（可选）")

row_start()
number(id="papers", label="期望论文数", min=1, max=50, value=10)
slider(id="depth", label="深度", min=1, max=5, value=3)
row_end()

select(id="lang", label="语言", options=["zh","en","ja","es"], value="zh")
radio(id="style", label="输出风格", options=["简明","详尽","学术"], value="详尽")

row_start()
checkbox(id="cite", label="附引用", value=true)
checkbox(id="cn_first", label="中文优先", value=true)
checkbox(id="risks", label="风险分析")
row_end()

divider()
button(id="submit", label="🚀 开始调研（含状态快照）", action="send_to_chat", variant="primary",
       state="form_snapshot",
       template="请按以下参数发起调研（完整结构已写入 §7 form_snapshot 锚点，可直接读取）：\\n- 主题：{topic}\\n- 背景：{background}\\n- 论文数：{papers}\\n- 深度：{depth}/5\\n- 语言：{lang}\\n- 风格：{style}\\n- 引用：{cite}，中文优先：{cn_first}，含风险：{risks}\\n\\n开始后请输出一个 configmd-command 代码块把进度推到 5%：\\n\\\`\\\`\\\`configmd-command\\n{ \\"name\\": \\"imgui.set_one\\", \\"params\\": { \\"id\\": \\"overall\\", \\"value\\": 5 } }\\n\\\`\\\`\\\`")
\`\`\`

---

## 3. Action 全家桶演示

### 3.1 send_to_chat（默认）

\`\`\`imgui
heading("快捷指令")
row_start()
button(id="summary", label="📋 总结", action="send_to_chat", variant="primary",
       template="请用 5 条要点总结当前研究的核心发现。")
button(id="next", label="➡️ 下一步", action="send_to_chat", variant="secondary",
       template="基于现有进度，请规划下一步并列出 3 个具体行动项。")
button(id="risks_btn", label="⚠️ 风险检查", action="send_to_chat", variant="secondary",
       template="请审视当前研究中可能存在的盲点、偏见或证据强度不足的地方。")
row_end()
\`\`\`

### 3.2 run_skill（自动加 [skill:NAME] 前缀）

\`\`\`imgui
heading("调用 Skill")
input_text(id="search_q", label="搜索关键词", placeholder="例：multi-agent collaboration 2025", value="LLM agent benchmarks")
button(id="ws", label="🌐 网页搜索", action="run_skill", skill="web-search", variant="primary",
       template="围绕关键词「{search_q}」检索最新 5 篇高质量资料并摘要。")
\`\`\`

### 3.3 set_state（替换 agent-state 锚点）

\`\`\`imgui
heading("更新任务清单")
text("点击下方按钮，会原子替换 §6 任务清单的内容。")
button(id="mark_done", label="✓ 标记前 3 项完成", action="set_state", anchor="tasks", variant="primary",
       template="- [x] 收集行业研究报告（10 份）\\n- [x] 整理关键数据指标\\n- [x] 撰写竞品分析章节\\n- [ ] 输出最终报告 PDF\\n- [ ] 提交评审会议")
button(id="reset_tasks", label="↺ 重置清单", action="set_state", anchor="tasks", variant="secondary",
       template="- [ ] 收集行业研究报告（10 份）\\n- [ ] 整理关键数据指标\\n- [ ] 撰写竞品分析章节\\n- [ ] 输出最终报告 PDF\\n- [ ] 提交评审会议")
\`\`\`

### 3.4 patch（任意 patch ops，payload 为 JSON）

\`\`\`imgui
heading("应用 Patch")
text("payload 中是 IConfigMdPatchOp[] 数组，等价于模型输出的 configmd-patch 块。")
button(id="bind_progress_done", label="📌 设进度文字为「100% 已完成」", action="patch", variant="primary",
       payload="[{\\"op\\":\\"replace-bind\\",\\"anchor\\":\\"progress\\",\\"content\\":\\"100% 已完成\\"},{\\"op\\":\\"replace-bind\\",\\"anchor\\":\\"status\\",\\"content\\":\\"已交付\\"}]")
\`\`\`

### 3.5 clear_chat（带 confirm 二次确认）

\`\`\`imgui
heading("危险操作")
button(id="clear", label="🗑 清空对话", action="clear_chat", variant="danger",
       confirm="确认清空当前会话历史？")
\`\`\`

---

## 4. 自由提问

\`\`\`imgui
heading("向 Agent 提问")
textarea(id="question", label="问题", rows=4, placeholder="输入你想问 Agent 的任何问题…")
button(id="ask", label="💬 发送", action="send_to_chat", variant="primary",
       template="{question}")
\`\`\`

---

## 5. 显示组件（progress / badge）

\`\`\`imgui
heading("状态可视化")
row_start()
badge("✓ 成功", color="success")
badge("⚠ 警告", color="warning")
badge("✗ 失败", color="danger")
badge("ℹ 提示", color="info")
badge("默认")
row_end()
spacer()
progress(id="step1", label="步骤 1", value=100, max=100)
progress(id="step2", label="步骤 2", value=70, max=100)
progress(id="step3", label="步骤 3", value=15, max=100)
\`\`\`

---

## 6. 错误诊断演示（Phase 3）

下面这个 imgui 块**故意**写错，用于展示错误 UI：行号 + 错误说明 + 原始片段（红色卡片）。
不会影响其他块的渲染。

\`\`\`imgui
heading("正常 widget")
this_is_not_a_widget("oops")
button(id="missing_paren", label="忘记关括号", action="send_to_chat",
       template="this line forgets to close
\`\`\`

---

## 7. 任务清单（agent-state 锚点）

<!-- agent-state:tasks -->
- [ ] 收集行业研究报告（10 份）
- [ ] 整理关键数据指标
- [ ] 撰写竞品分析章节
- [ ] 输出最终报告 PDF
- [ ] 提交评审会议
<!-- /agent-state:tasks -->

> 上方任务清单使用 \`<!-- agent-state:tasks -->\` 锚点包裹。
> §3.3 的按钮通过 \`set_state\` action 直接替换该锚点内容。

### 表单状态快照（由 §2 「开始调研」自动写入）

<!-- agent-state:form_snapshot -->
\`\`\`json
{ "note": "form has not been submitted yet" }
\`\`\`
<!-- /agent-state:form_snapshot -->

> 当用户点击 §2 的提交按钮时，host 会先把当前所有表单值以 JSON 写入此锚点，再发送 chat 消息。
> Agent 在任何后续 prompt 中读取本文件即可获得最新结构化输入。

---

## 8. agent-bind 状态绑定

进度：<!-- agent-bind:progress -->45%<!-- /agent-bind:progress -->
状态：<!-- agent-bind:status -->进行中<!-- /agent-bind:status -->

> §3.4 的「应用 Patch」按钮会用 \`replace-bind\` op 把以上两个 \`agent-bind\` 替换为「100% 已完成」/「已交付」。

---

## 9. 控件 / Action 速查表

### 控件
| 类别 | 写法 |
|---|---|
| 容器 | \`row_start()\` / \`row_end()\` · \`column_start()\` / \`column_end()\` |
| 文本 | \`heading("…")\` · \`text("…")\` · \`divider()\` · \`spacer()\` |
| 显示 | \`progress(id, label, value, max?)\` · \`badge("文字", color="success|warning|danger|info|default")\` |
| 输入 | \`input_text(id, label, placeholder?, value?)\` · \`textarea(id, label, rows?)\` · \`number(id, label, min?, max?)\` |
| 选择 | \`select(id, label, options=[...])\` · \`radio(id, label, options=[...])\` · \`checkbox(id, label)\` |
| 滑块 | \`slider(id, label, min, max, value?)\` |
| 按钮 | \`button(id, label, action=…, template?, variant?, confirm?, anchor?, skill?, payload?, state?)\` |

### Action
| Action | 必需属性 | 行为 |
|---|---|---|
| \`send_to_chat\` *(默认)* | — | 把 \`template\` 渲染后发到当前 chat session |
| \`run_skill\` | \`skill="…"\` | 同上 + 自动加 \`[skill:NAME]\` 前缀 |
| \`set_state\` | \`anchor="…"\` | 替换 \`<!-- agent-state:NAME -->\` 块内容（content = \`template\` 渲染结果） |
| \`patch\` | \`payload="JSON"\` | 应用 patch ops 数组（IConfigMdPatchOp[]） |
| \`clear_chat\` | — | 清空当前 session 历史（建议配 \`confirm="…"\`） |
| \`noop\` | — | 仅触发 SDK 端行为，host 不动作 |

### Phase 3 通用属性
| 属性 | 说明 |
|---|---|
| \`state="ANCHOR"\` | 提交前自动把全部表单值以 JSON 写入指定 \`agent-state\` 锚点。可与任意 action 组合（先快照、后行动）。 |

### 双向命令（agent → preview）
模型在回复中输出 \`\\\`\\\`\\\`configmd-command\\n{...}\\n\\\`\\\`\`\` 即可。Phase 3：从 imgui 按钮提交触发的对话回复也会被解析（之前仅 HTML 事件路径解析）。

| name | params | 用途 |
|---|---|---|
| \`imgui.set\` | \`{ values: { id: value, ... } }\` | 批量赋值 |
| \`imgui.set_one\` | \`{ id, value, max? }\` | 单值更新 |
| \`imgui.toast\` | \`{ message, variant?, duration? }\` | 弹出瞬时提示 |
| \`imgui.reset\` | \`{ formId? }\` | 重置一个/所有 form（清 sessionStorage） |

### 模板占位符
\`button.template\` 中可用 \`{id}\` 引用同一表单内任意控件的当前值；
未匹配的 \`{xxx}\` 原样保留。

`;
