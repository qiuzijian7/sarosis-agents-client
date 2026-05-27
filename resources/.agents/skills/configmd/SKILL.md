---
name: ConfigMD
description: 让 agent 自主创建/编辑当前实例的 ConfigMD（含 imgui 表单 DSL）
activation: auto
match: [configmd, config.md, config md, imgui, imgui form, imgui 表单, 配置面板, agent 面板, agent panel, agent-state, agent-bind, 修改面板, 编辑面板, 更新进度, 推送进度, toast]
category: meta
recommended_tools: []
---

You are running the **configmd** skill.

## What is ConfigMD?

Each agent instance owns a `config.md` file at
`<workspace>/.sarosisworkspace/agents/<agentDir>/config.md`. Its contents are
rendered into a webview panel inside the agent editor as an interactive UI.
You — the agent — can both **read** the current panel state and **drive** the
panel by emitting structured code blocks in your reply. The host parses those
blocks out of your message, applies them to disk, and pushes runtime commands
into the live preview.

## When this skill is active you should:

1. If the user asks you to *create* a panel from scratch, write the full
   `config.md` body in a `configmd-patch` block (see schema below). Default to
   the imgui DSL for any interactive sections.
2. If the user asks you to *modify* something specific (a section, a
   progress value, a status badge), prefer **targeted ops** over rewriting the
   whole file: `replace-anchor`, `replace-bind`, `append`, etc.
3. If the user asks you to *push live state* without rewriting the markdown
   (e.g. "set progress to 60"), emit a `configmd-command` block instead — that
   updates the preview in-place via the SDK without touching `config.md`.

## Two block types you can emit in your replies

### A) `configmd-patch` — durable edits to `config.md`

Each entry in the array is one `IConfigMdPatchOp`:

```configmd-patch
[
  { "op": "replace-all",     "content": "<full new markdown>" },
  { "op": "replace-anchor",  "anchor": "tasks", "content": "- [x] step 1\n- [ ] step 2" },
  { "op": "replace-bind",    "anchor": "progress", "content": "60%" },
  { "op": "append",          "content": "\n## New section\n…" }
]
```

`replace-anchor` rewrites the body between
`<!-- agent-state:NAME -->` and `<!-- /agent-state:NAME -->` markers.

`replace-bind` rewrites the body between
`<!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->` (use this for inline
numeric/string status, e.g. "60%", "已完成").

### B) `configmd-command` — transient commands pushed to the live preview

```configmd-command
{ "name": "imgui.set_one", "params": { "id": "overall", "value": 80 } }
```

Supported names:
- `imgui.set_one`   `{ id, value, max? }`            — update a single control
- `imgui.set`       `{ values: { id1: v1, ... } }`   — batch update many controls
- `imgui.toast`     `{ message, variant?, duration? }` — variant: success | warning | error | info
- `imgui.reset`     `{ formId? }`                     — reset a form to defaults

## imgui DSL — when authoring a fresh panel

Wrap interactive UI in fenced ` ```imgui ` blocks; the host turns them into HTML
forms. One widget per logical line, function-call syntax `widget(args)`. Lines
with unbalanced brackets are joined with the next line, so multi-line button
definitions are fine.

### Widgets

| Group | Syntax |
|---|---|
| Containers | `row_start()` / `row_end()` · `column_start()` / `column_end()` |
| Static    | `heading("…")` · `text("…")` · `divider()` · `spacer()` |
| Display   | `progress(id, label, value, max?)` · `badge("text", color="success\|warning\|danger\|info\|default")` |
| Input     | `input_text(id, label, placeholder?, value?)` · `textarea(id, label, rows?)` · `number(id, label, min?, max?, value?)` |
| Choice    | `select(id, label, options=[...], value?)` · `radio(id, label, options=[...], value?)` · `checkbox(id, label, value?)` |
| Slider    | `slider(id, label, min, max, value?)` |
| Button    | `button(id, label, action=…, template?, variant?, confirm?, anchor?, skill?, payload?, state?)` |

### Button actions

| Action | Required | Effect |
|---|---|---|
| `send_to_chat` *(default)* | — | Render `template` and send as a chat message |
| `run_skill` | `skill="…"` | Same as send_to_chat but auto-prefixes `[skill:NAME]` |
| `set_state` | `anchor="…"` | Replace the `<!-- agent-state:NAME -->` block with the rendered template |
| `patch`     | `payload="JSON"` | Apply IConfigMdPatchOp[] from the payload |
| `clear_chat` | — | Clear the chat history (always pair with `confirm="…"`) |
| `noop`      | — | Trigger only client-side SDK behaviour |

`state="ANCHOR"` (any action) — before the action runs, snapshot the form's
current values into the named `agent-state` anchor as a JSON code block.
`template` supports `{id}` placeholders that resolve to other controls' values.

### Anchors you can use in the markdown body

```markdown
<!-- agent-state:tasks -->
- [ ] step 1
<!-- /agent-state:tasks -->

当前进度: <!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->
```

## Authoring guidelines

- Prefer `replace-anchor` / `replace-bind` over `replace-all` whenever
  possible — they preserve sections you don't care about.
- Keep imgui forms small (≤ 8 inputs per form). Compose multiple ` ```imgui `
  blocks separated by markdown headings instead of one giant form.
- Always give buttons that send to chat a `template=` so the chat receives a
  clear, structured message (use `{id}` placeholders to splice form values).
- For destructive buttons (clear chat, reset, etc.) always set
  `confirm="<warning>"` to require a two-click gesture.

## Example — a small "research kickoff" panel

```configmd-patch
[{"op": "replace-all", "content": "# 研究助手\n\n## 启动调研\n\n```imgui\nheading(\"新一轮调研\")\ninput_text(id=\"topic\", label=\"主题\", placeholder=\"例：AI Agent\")\nslider(id=\"depth\", label=\"深度\", min=1, max=5, value=3)\nbutton(id=\"go\", label=\"开始\", action=\"send_to_chat\", state=\"snap\", template=\"请按主题《{topic}》以深度 {depth}/5 开始调研。\")\n```\n\n## 状态\n\n进度: <!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->\n\n## 快照\n\n<!-- agent-state:snap -->\n```json\n{}\n```\n<!-- /agent-state:snap -->\n"}]
```

## File layout — where everything lives

Each agent has its own ConfigMD scaffold inside its instance directory:

```
<workspace>/.sarosisworkspace/agents/<agentDir>/
  ├── agent.yaml                 # carries a `configMd` section (parserPath/stylesPath optional)
  ├── config.md                  # the markdown source — what `configmd-patch` writes to
  └── ui/                       # OPTIONAL — only created when you customise parser/styles
      ├── parser.js              # custom MD→HTML parser (overrides built-in)
      └── styles.css             # custom CSS (appended after built-in styles)
```

The **engine default** parser and styles live in the extension's built-in
`media/configmd/` directory. You can read them as references:
`media/configmd/parser.js` (default parser) and `media/configmd/styles.css`
(default styles).

When `agent.yaml.configMd` does **not** contain `parserPath` / `stylesPath`,
the host uses its built-in markdown parser + bundled imgui SDK styles.
This is the zero-config default — it always works.

## Customising parser / styles

To override the default look-and-feel you need to:

1. **Create custom files** in `<agentDir>/ui/`:
   - `ui/parser.js` — copy from `media/configmd/parser.js` and edit
   - `ui/styles.css` — copy from `media/configmd/styles.css` and edit

2. **Update `agent.yaml`** to point at your custom files:
   ```yaml
   configMd:
     mdPath: "config.md"
     parserPath: "ui/parser.js"    # add this line
     stylesPath: "ui/styles.css"   # add this line
   ```

### Parser specification (`ui/parser.js`)

The file must be a **CommonJS module** exporting an object with a
`parse(markdown, options)` method:

```javascript
// ui/parser.js — custom markdown → HTML parser
module.exports = {
  parse: function(markdown, options) {
    // options.employeeId — current agent id
    // Return: HTML string
    return customRender(markdown);
  }
};
```

**Rules:**
- The parser runs in a `new Function(...)` sandbox (no `require`).
- Output is post-processed: ````imgui` blocks are auto-converted to
  interactive forms, so you don't need to handle imgui DSL yourself.
- Preserve `<!-- agent-state:NAME -->` and `<!-- agent-bind:NAME -->`
  markers if you want state persistence to work.
- You can use any markdown library (e.g. `marked`, `remark`) as long as
  you bundle it inline (no external requires).

### Styles specification (`ui/styles.css`)

The file contains **CSS rules** that are appended after the built-in
imgui SDK styles. Your rules have higher specificity, so you can
override any default style.

**Key selectors to customise:**

| Selector | Target |
|----------|--------|
| `.imgui-form` | the form container |
| `.imgui-input`, `.imgui-select` | input/select elements |
| `.imgui-button-primary` | primary button |
| `.imgui-error` | error messages |
| `[data-agent-state]` | state anchor containers |

**Tip:** Start by copying `media/configmd/styles.css` and only
change what you need. The default file documents all available
selectors with examples.

## Workflow — "make the panel prettier"

When the user asks you to improve the panel appearance:

1. **Read references** (if first time):
   - Read `media/configmd/styles.css` to understand available selectors
   - Read `media/configmd/parser.js` to understand parser API

2. **Check current state**:
   - If `<agentDir>/ui/styles.css` exists, read it to preserve user customisations
   - If `<agentDir>/ui/parser.js` exists, read it too

3. **Create/Update custom files**:
   - Use `filesystem.write_file` to create/update `ui/styles.css`
   - Use `filesystem.write_file` to create/update `ui/parser.js` (if changing parser)

4. **Update `agent.yaml`** (if not already done):
   - Read `agent.yaml`, check if `configMd.parserPath` / `configMd.stylesPath` are set
   - If missing, add them via `configmd-patch` or direct yaml edit

When in doubt: emit one fenced block at a time, keep the JSON compact, do not
wrap the block in additional prose unless it's purely diagnostic for the user.
