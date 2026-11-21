# Deep PTC mode

[中文](README.zh.md) · MIT · **2.3.0**

[Changelog](CHANGELOG.md) · [Test report](TEST_REPORT.md) · [Plugin workflows and verification](COMPATIBILITY.md)

Deep PTC is a DeepSeek Harness agent mode with progress reports, clarifying questions, task-size planning, and interruptible background work. It builds on the installed official PTC preset with selectable shells, on-demand tools and skills, and a two-layer preset identity adapter for third-party plugins. Cards face both you and the model: you see a clear card, the model reads precise context with ids, sources and states; the task brief files the goals, constraints and acceptance criteria in your messages and, once you confirm, can take the raw messages out of the model's context.

The panel sits beside the conversation and shows the environment, Deep creative mode with the virtual DSH, subagents, jobs, output files, SSH connections and tool state. The panel width can be dragged. The capsule expands or collapses it; it sits below the composer by default and can move into the toolbar or be hidden. Deep PTC also has its own settings page. Visual effects are lightweight and start off when an appearance plugin is installed.

## Changes in 2.3.0

- **Virtual DSH**: Deep creative mode has its own section in the side panel with a **Virtual DSH** card. One click starts a fresh DSH with the same host version, plugins, skills and settings as yours, and none of your sessions, workspaces or memory. It opens in the right sidebar. The card shows each startup step and can stop it at any time. It signs in with the credentials of the DSH that launched it, copied when it starts and deleted first when it stops. Stopping removes its temporary directory. Leftovers from a crash are swept at the next start.
- **The model drives it**: in creative mode the `virtual_dsh` tool can start, restart and stop the virtual DSH, and read its status and logs. It can add or remove extra plugins, read and write its `cordis.patch.yml`, and chat with it: send test messages and read back each turn's replies, tool calls and errors. The first action asks you once per conversation; after that the model can restart it as often as testing needs. Every start shows up in the side panel, whoever started it, so you can stop it there.
- **Ten built-in skills**: new `windows-wsl`, `dsh-plugin-dev`, `virtual-dsh-testing` and `tool-evaluation`. `dsh-operations` now covers which cards wait for you, approvals, quarantined tools and common mistakes. Skills stay in English; their descriptions on the skill card follow the DSH display language. The figure and source skills check their Python dependencies before running.
- **A quieter side panel**: empty sections take one line, tool state reads "OK · Reload", and long explanations moved into hover tooltips. Virtual DSH status no longer appears as command rows in the chat.

## Changes in 2.2.0

- Enable Deep creative mode in the side panel for new conversations. Test plugin archives in a separate DSH Web process with its own home and profile.
- Six on-demand skills cover DSH operations, local web testing, frontend implementation, primary-source research, Office delivery and scientific figures. Four include runnable examples. The figure generator produces an SVG, a statistical summary and a conversation card from the same measurements.
- Cards appear above the composer during a running turn. Project cards use a runtime snapshot with a 16,000-character budget including omitted titles. Delivery receipts handle mixed client versions, and project setup follows the active question-tool settings.

## Changes in 2.1.0

2.1.0 gives cards a model view: besides what you see, a card reaches the model's context in a precise, token-lean form.

- **Task brief**: the model files the goals, constraints, acceptance criteria, context and open questions in your messages into numbered items (G / C / A / K / O). An item that restates you carries a verbatim quote that the plugin checks against your message; implicit needs are marked inferred. Every clause of a filed message is either filed or marked as carrying no task content, and whatever is left is shown verbatim as unfiled text.
- **Condense after you confirm**: once the brief is right, Confirm and condense replaces your messages in the model's context with a stub that points to the brief and keeps unfiled text verbatim, before the next request. Your messages stay in the chat and the log; the model reads them back with `task_brief source`, and you can restore them in one click. Only you can change items you confirmed.
- **The brief stays out of the system prompt**: the fixed guidance lives in the system prompt and the brief itself travels as a runtime-context snapshot, appended only when it changes and re-sent by the host after compaction. In a live rerun, each update cost 600–2,600 uncached input tokens instead of about 18,500.
- **Filing on its own**: an unfiled substantive message earns a reminder (at most two per message); acceptance items are checked one by one before the final answer.
- **Structured card answers**: answers to question cards and button choices go straight to the model with the card id, question ids, option values and the words you saw. The chat shows one line and the answers stay on the card. Older clients fall back to the plain text reply. Card answers can be quoted in the task brief.
- **Fix: the model could not see the card tools' arguments**: the parameter schemas of `ask_user`, `ui_card` and `project_cards` used constructs outside the PTC SDK subset, so `run_code` showed them as `unknown` and the model had to probe. They are typed now, with a regression test.
- `ui_card` results drop presentation fields such as size and tone.
- Settings → Deep PTC → Cards gains a Task brief switch (on by default); the side panel gains Task brief.

## Changes in 2.0.1

2.0.1 focuses on stability and fills in cards, questions and the panel from user feedback.

- **Conversation cards stay in the history**: each version draws at the turn it appeared in; only cards in the latest turn are clickable, older versions and earlier turns are read-only archives, and closed cards fold into one line.
- **Question cards replace the official question tool**: with conversation cards on, the model asks with `ask_user` (single choice, multiple choice, text, optional recommended answers). Asking never blocks; your answer arrives as your next message and the card keeps the answered result.
- **Automatic card layout**: without an explicit `size`, narrow cards pair up or sit three in a row and wide cards take the full row.
- **Project cards are modular prompt constraints**: each card is one self-contained module of a protected system prompt section, with its title, revision and item IDs. Every create, edit, delete and polish reaches the model at once as a steer message, even mid-task. Over the size limit whole later cards are left out and named instead of cutting a card in half.
- **You decide on polishing**: polish with a subagent or the current conversation, review the result side by side, and adopt or discard it.
- **Project cards in the side panel**: Edit project cards opens the editor without involving the model; Set up with the model guides you with questions in the main conversation. The editor is found even when the host moves plugin views into its More views menu.
- **Panel location (#25)**: Settings → Deep PTC → Appearance → Panel location offers Beside conversation or Sidebar. In the sidebar the whole panel is a Deep PTC tab of the right sidebar that the capsule opens; with dsh-better-sidebar it opens as one of its pages and can also go in its bottom workbench.
- **Sandbox escalations never hang**: a shell escalation returns an `approval-N` handle at once, the approval prompt appears as usual and the command runs once approved; `job_output` reports waiting, running, finished, rejected or withdrawn.
- **More active progress updates**: a protected prompt section asks the model to say what it will do before its first tool call and then report findings, thoughts and next steps every one or two steps, hypotheses and dead ends included; a silent first step gets a reminder.
- **Built-in prompts and card constraints are never compacted**: they are system prompt sections read on every request and never enter the history.

## Changes in 2.0.0

Version 2 restores the original 1.9.9 persona and adds proactive cards and progress reminders. Workspace setup remembers guidance, pending proposals and deferral. Independent sources keep separate proposals. Stale proposals require merging and fresh approval. End and restart the panel guide without losing pending proposals. For feature changes the model uses related F records to report new and existing behavior checks together.

## Five basic problems

| # | Problem | What Deep PTC does |
| --- | --- | --- |
| 1 | **Working silently without reporting** | Give a brief chat update before each `run_code` call. Two consecutive tool steps without assistant text trigger a reminder at the next step. |
| 2 | **Guessing instead of asking** | Meaning belongs to the user, facts to the tools: ask one to three questions with options when names, targets, routes, scope or acceptance criteria are unclear; an unfamiliar term is asked about first and researched only when the user does not know it; inspectable facts are looked up. The user's statements outrank the model's prior beliefs: no silent change of approach, every part of a request checked off, nothing unverified reported as verified. |
| 3 | **Sleeping or becoming unreachable** | Enforced in code: foreground waits move to the background after 30 s; a user message hands the waiting command to the background within about 2 s; foreground sleeps over 5 s are refused; job completion wakes the model. |
| 4 | **No plan, or an invisible plan** | Plan by estimated size: act silently under 5 minutes; show the plan and start without approval for 5–20 minutes; show it and wait for approval over 20 minutes. Re-plan when the estimate moves up; the user can redirect at any step. |
| 5 | **Not using the concise context and unlimited-token prompt** | Derive from the live official PTC composition, keep the tool catalog compact and load full schemas on demand, and state that this mode spends its token budget on reads, searches, commands and checks rather than rationing them. The prompt does not change billing or the real token limit. |

## Built for “everything is a plugin”

### 1. Dynamic preset and tool loading

Read the running host's official PTC declaration and inherit its rows as they are; only the persona, execution group, reachability guard, job wrapper and question wrapper are replaced. Rebuild only when the declaration or settings change, checked when settings change and once before each Deep PTC conversation is created or resumed, with no polling timer; fall back to the bundled snapshot with a warning if it cannot be loaded, parsed or derived. An official upgrade can add tools without a release of this preset; existing sessions are not forcibly switched.

### 2. Flexible creative-mode tools

Enable Deep creative mode from the side panel for new sessions to access the official creative tools and developer resources. Test candidate packages in a virtual DSH that copies your environment, as described below.

### 3. dsh-go screen-control adaptation

Screen-control tools stay in the initial PTC SDK, are not moved on demand, and are not quarantined on failure. Recognition uses the tool's own `resident` mark, `dsh-go/view`, its name or its provider mark. Deep PTC does not claim dsh-go's slots or replace its settings form; if the tool-state projection fails, that control stays empty without tearing down the composer or screen-control UI.

### 4. Wider execution environments

WSL Bash, PowerShell (including discovered 5.1 and 7 executables), Zsh and native Bash are supported. The choice applies to this preset only and does not change the global shell; sandbox, approval and process management stay official. WSL currently requires the host-authorized `danger-full-access` mode.

### 5. External plugin tools and workflows

This is the core interface: external plugins publish tools under their own contract; Deep PTC discovers them, loads them on demand, quarantines failures per conversation and falls back to official PTC. Extensions must support the installed host and publish into the `deep-ptc` scope; Deep PTC does not depend on any specific plugin or replace the executor.

Third-party plugins that query `composedPreset` share the same compatibility rules. The tested dsh-ops package recognises only `minimal/standard/ptc/cordis`, so its query receives `ptc` in a session that DSH mounts as `deep-ptc`. Quarantine applies only to tools attributed to external providers.

### 6. Leaner skill and tool loading

Each turn ends with a skill context card that lists only the skills still loaded and not closed, so the user decides what stays for the next turn.

Search summaries first, then load full schemas: six entries per page by default (maximum eight), up to six schemas within a 16 KB budget per load, and up to twelve recent selections. Quarantine persists with the conversation: clear unavailability blocks immediately; temporary failures need three in a row and a success clears the count; wrong arguments, denial and normal business failures are not tool failures; one reset clears only the current conversation. Skills load in two stages: discovery reads metadata and invocation permission only; the official `skill` tool loads the body.

Install the plugin, choose an environment under **Settings → Deep PTC**, and select **Deep PTC Mode** for a new conversation.

## Skill context card (1.8.5)

After each turn, a card at the end of that turn in the conversation (where official plan cards appear) lists only the skills that are **still in context and not closed** — not the whole skill catalog. Each row shows the name, description and a switch, on by default; the card also offers **Keep all / Close all** and says how many skills leave after the next message. More than four rows fold behind “Show all”. Only the latest turn shows the card.

- A switch changes the next turn only. It is fixed when you send the next message and applied before the first model step of that turn.
- A kept skill stays in context without a reload; a closed skill has its tool-result body replaced with a short marker, while the durable log and human transcript keep the original text.
- A closed skill disappears from later cards until the model loads it again.
- If a new task really needs it, the model calls `skill` again and the card lists it after that turn.
- The state is registered at the plugin root, so an existing Deep PTC session also rebuilds it from history after an upgrade; no new session is required.
- The card tracks skills loaded directly through the official `skill` tool and skills loaded by a PTC inner call inside `run_code`. The latter usually reach the program rather than the model context, so closing one only removes it from the card, not from program output. `/name` injections are not covered yet.
- A switch leaves no command row in the conversation (the session log still records it); only a failed switch shows a short error line in place.

## Conversation cards (1.9.9)

The model leaves cards at the end of the conversation with the `ui_card` tool. Cards are **composed**, not picked from fixed templates: a header (title, subtitle, icon, state tone), up to 6 blocks, a note and up to 4 buttons. Any combination is valid, so the model can create a new card for any situation.

- **Display blocks**: `stats` tiles, `rows`, `progress`, `bars`, `line` (with a hover tooltip), `donut`, `steps` (checklist or timeline), `table`, `tags`, `text`, `callout`.
- **Interactive blocks**: `choice` (single or multiple, with a preselected recommendation) and `field` (time, date or number).
- **Layout**: each card can set `size` (full / half / third); several cards form a grid, two side by side or three in a row, stacking in narrow windows.
- **Buttons**: `run` really runs on the host (deletes scheduled tasks, or runs one command in **your selected execution environment**); `reply` sends the user's choice to the model as their next message; a button can do both. `keep` leaves the card usable after a press (restart, snooze, rerun).
- **Safety**: `{name}` placeholders in a command are filled only from times, dates, numbers and option values the card declared, so free text never reaches a shell; the server validates them again. Destructive buttons use the `danger` style.
- **Model view**: answers and button choices reach the model as `[Card answer: id «title»]` followed by `question id = value «the words you saw»`; tool results carry no presentation fields such as size or tone.
- **Design**: one type scale, spacing and colour system that follows the host's light and dark themes; the chart palette is validated for colour-vision deficiency and every value is printed, so colour never carries meaning alone. Cards draw once, after the latest turn.

Three card skills cover the interface (`deep-ptc-cards`), development templates (`deep-ptc-card-examples`), and project settings and proposals (`deep-ptc-project-cards`).

Deep PTC sessions add ten on-demand skills: DSH operations, local web testing, frontend design, primary-source research, Office delivery, scientific figures, Windows and WSL, DSH plugin development, virtual DSH testing and tool evaluation. Frontend design, primary-source research, Office delivery and scientific figures include a working HTML form, a source passage locator, an Excel/Word report generator, and a measurement-to-SVG and card generator. The skill loader supplies the directory containing their examples.

## Project cards (1.9.9)

The project's standing rules and records, kept in `PROJECT-CARDS.md` at the workspace root. Like AGENTS.md it lives in the workspace, and other AI tools read it as plain documentation.

- **Current file on each request**. The system prompt includes the current `PROJECT-CARDS.md` for DSH conversations in the workspace. User-approved settings take precedence among project documents. Earlier copies quoted in the conversation are historical. The project-card interface is read-only in other modes.
- **Three kinds**:
  - **Setting cards** (R ids) are yours, grouped as stack and environment, code conventions, constraints, workflow, product and other. The model can only propose changes, which take effect once you approve them.
  - **Implemented features** (F): the model records verified behavior, its entry point and relevant checks. Before changing related code, it reads these entries and retests existing behavior affected by the change. Users can question records for the model to verify and correct.
  - **User requirements** (Q ids) record the lasting requirements you have stated, with their status (active / done / superseded). The model checks new requests against them and asks you first when they conflict.
- **The Project cards view** sits next to Chat / Trajectory / Stats in Deep PTC sessions. You can browse cards by group, edit and submit them, or tick a box to have the model polish your edit first (it comes back as a proposal for you to approve). You can also browse history and roll back, approve or reject proposals, and question the model's records. Each submit, approval and rollback sends the model a message.
- **Getting started**: when project cards are enabled and a project has no setting cards, the model should initiate setup in its first visible reply with a specific question or grounded draft. Setup started in chat offers approval in that chat. Starting setup in the Project cards panel opens a dedicated subagent there for questions, replies and proposals. A reply steers its current task.
- **Edit protection**. Submit, delete and rollback check the file version from when the edit began. On a conflict, the editor keeps the draft and offers to merge it with the current content. Writes preserve Markdown outside the managed lines. History and proposals live in `$DSH_HOME/storages/deep-ptc-project-cards.json`.
- Under **Settings → Deep PTC → Cards** you can switch off conversation cards and project cards separately (both on by default).

## Task brief (2.1.0)

People write the way they talk: goals, limits, background and pleasantries in one message, spread over several turns. The task brief files them into one conversation card: you see a clear card, the model reads clean, numbered context.

- **Five sections**: goals G, constraints C, acceptance A, context K, open questions O. One fact per item, in your language, each fact once.
- **Sources**: an item that restates you carries your words as a quote, checked against your message or card answer; a made-up quote is refused. Implicit needs the model infers are marked inferred and checked with you before it relies on them.
- **Coverage**: each message is checked clause by clause. Text neither quoted by an item nor marked as carrying no task content shows on the card as unfiled text and goes back to the model to file.
- **On the card**: confirm, edit, finish or reopen, and remove each item; keep a goal or constraint for the project, which writes it to the project cards' user requirements (Q); add your own items. The model cannot reword or drop items you confirmed.
- **Condensing**: Confirm and condense replaces filed messages in the model's context with a stub listing their items and repeating unfiled text verbatim. The original event is kept and the chat is unchanged; Restore original undoes it. Condensing recomputes the prefix cache after that message once, so it pays most for long messages condensed early.
- **What the model reads** (a context snapshot appended when it changes):

  ```
  # Task brief (rev 4) — this conversation's current brief; it replaces earlier task brief snapshots
  Constraints
  - C2 [user m8] 周日晚上必须回到上海
  - C3 [inferred] 1500 按两人合计
  Acceptance — check each before your final answer; mark finished ones done
  - A1 [confirmed] 给一张按时间排好的表格
  ```

- The card shows at the end of the turn that last changed it, and Task brief in the side panel is always there. Switch it off under Settings → Deep PTC → Cards.

## Panel, settings page and visual effects

The Deep PTC mode label, settings, and conversation UI switch between Chinese and English with DSH **Settings → General → Language**. Every entry point uses an official DSH extension point; the plugin changes no host layout and registers no keyboard shortcuts.

- **Settings → Deep PTC**: execution environment and shell; under Cards, the conversation cards, project cards and task brief switches; under Appearance, the visual effects switch and the capsule position (the effects switch lives only here, not in the side panel); copyable diagnostics to attach to interface bug reports.
- **The Deep PTC panel beside the conversation** is open by default when there is room. It follows the conversation width and hides under a fullscreen native sidebar. On narrow screens the bottom capsule expands it.
  - **Execution environment**: WSL, PowerShell, native Bash or Zsh, for newly created Deep PTC sessions.
  - **Deep creative mode**: the switch, and the Virtual DSH card with its status, startup steps and Start / Open in sidebar / Stop.
  - **Compact by default**: an empty section takes one line, and explanations are hover tooltips.
  - **Order**: hover a section and drag the handle at its top left to reorder the environment, Deep creative mode, project cards, task brief, subagents, jobs, output files, SSH and tool state (or focus the handle and press ↑ ↓); the order is kept per browser.
  - **Subagents**: the state indicator and name on the left, with duration at the right of the same row; a row opens that subagent's chat in the official right sidebar.
  - **Background jobs**: six positions, up to five active jobs first and up to three finished jobs; overflow folds into one expandable row.
  - **Output files**: files this conversation wrote or delivered, newest first; click to open the file in DSH's native preview. Three positions are available, with overflow folded into one of them. The rule matches DSH's own deliverables card and also counts files written from `run_code`.
  - **SSH connections**: hosts this conversation reached, with their outcome, and the host aliases in `~/.ssh/config`.
  - **Tool state**: "OK" with a Reload link in its header (it reloads all tool states), and the failed external tools when there are any.
- **The capsule** shows the environment, subagent count and tool notices, and toggles the independent side panel. Its position is a setting (Settings → Deep PTC → Appearance): auto, below the composer, in the composer toolbar, or hidden. Auto uses the toolbar beside dsh-claude-style so a one-row composer stays one row. When hidden, open the panel from the Deep PTC tab on the right sidebar.
- **Panel location**: choose Beside conversation or Sidebar under Settings → Deep PTC → Appearance. In Sidebar mode the whole panel lives in the Deep PTC tab of the right sidebar and the capsule opens it; with dsh-better-sidebar installed it opens as one of its pages and can also go in its bottom workbench.
- **Panel width**: drag the panel's left edge, or focus it and use the arrow keys (Shift for larger steps) or Home/End; a double click restores 280px. The width is remembered, from 240 to 640px, and a docked panel leaves at least 540px for the conversation.

Visual effects apply **only while the conversation on screen is a Deep PTC session**, and only on the composer, send button, message bubbles, reply typography and session rows. They never rewrite the host's colour tokens or fonts, so switching conversations does not restyle the whole page: a hairline on the focused composer, a blue gradient send button, soft blue user bubbles, pointer spotlight, click ripple, a magnetic send button; while running, a glowing composer, a send-button ring and sparks rising above the composer.

- Light rendering: effect styles target DSH's own stable attributes instead of measuring elements every frame; looping animations change only opacity or transforms; the spark canvas covers only the area around the composer at no more than 1.5 device pixels per CSS pixel and stops drawing when nothing moves or the window is hidden.
- With an appearance plugin such as dsh-claude-style or dsh-refined-ui installed, effects start off; turning them on keeps your choice. The standalone dsh-refined-ui is never drawn twice.
- Everything honours reduced motion.

## SSH

The panel can copy a general SSH check command or DSH Go connection details. Normal SSH, SCP, SFTP and forwarding work uses OpenSSH. DSH Go can start managed `dsh web` on a POSIX remote host, or attach to an existing service on Windows. Use the actual service port and configure authentication in the client. Copying these details prepares information.

DSH allows a blank session to select another preset before its first turn starts. It locks that choice once a turn has started. Deep PTC command gates follow the host's current selection, which is also used by the UI.

Deep PTC reaches external hosts through the local OpenSSH client in the selected environment's shell; it adds no transport of its own. The model is told where the client is, which host aliases `~/.ssh/config` defines (names, addresses, users and ports only, never keys), and how to use them: always non-interactive (`BatchMode=yes`, a connect timeout), no interactive remote shell, never waiting for a password or host-key prompt; on an authentication failure it stops and tells you instead of trying other credentials or disabling host-key checking; long remote work runs as a background job. In WSL, SSH runs inside the distribution with its own `~/.ssh`.

## 1.7.2: lightweight, on-demand tool orchestration

One tool/skill directory, `deep_ptc_tools`, coordinates discovery. Task operations still belong to external providers and the current official PTC tools.

- **Search summaries, then load definitions.** Local metadata search prefers external tools, then returns official candidates when no extension matches. Pages default to six entries (maximum eight); disclose up to six complete schemas within a 16 KB budget per load. Official tools stay available; up to twelve recent extension selections enter the host-generated PTC SDK on demand.
- **Quarantine what is actually broken.** A tool that is clearly unavailable (a missing module or API, or a declared unavailable state) is quarantined at once; temporary and unexplained failures need three in a row, and a success clears the count. Wrong arguments or paths, denial, cancellation and normal results describing their own subject (such as a failed build) are not tool failures. Official tools are never quarantined, including those in the profile's root composition (such as `lsp` and `terminal_*`). After quarantine, execution is blocked in code and state persists with the session. Agent recreation, conversation restore and provider reload do not lift quarantine. Capture provenance and reset generation before dispatch; late pre-reset results cannot contaminate the new state. Empty results, normal pagination and ordinary nonzero command exits are not failures either.
- **Finish the task; do not diagnose failed providers.** Correct wrong input and retry a temporary failure at most twice. Once a tool is quarantined, move promptly to a working equivalent or official fallback, with no probing, retrying or root-cause investigation. Read back only the task state necessary to avoid duplicate effects after a potentially partial mutation.
- **Brief completion reporting.** The model lists failed tools and declared provider names at completion. The runtime also projects an expandable compatibility notice after a turn ends. Unknown ownership is reported as unknown, never inferred from a tool name.
- **One-click reload.** “Reload all tool states” clears quarantine and on-demand selections for the current conversation without a model call or stopping running jobs. The user slash command `/deep-ptc-reset-tools` provides the same action. The tool state and this command are registered at the plugin root, like the skill card, so they work in an idle conversation too.
- **Two-stage skill use.** Search the host's resolved, model-invocable skill metadata, then load the exact name with the official `skill` tool and follow its full instructions. Reuse instructions already in context. Discovery never reads skill bodies.

```js
// Inside the official run_code tool; discovery itself never executes a found task tool.
const matches = await tools.deep_ptc_tools({ action: 'search', query: 'search files' });
const loaded = await tools.deep_ptc_tools({ action: 'load', names: ['actual_tool_name'] });
const skills = await tools.deep_ptc_tools({ action: 'skills', query: 'build test' });
// Next use each actual tool schema, or the official skill loader for a selected skill.
```

Set `compactToolCatalog: false` under `deep-ptc-settings` to retain the full host SDK while keeping quarantine and reset. `toolCompatibility: false` disables the entire new layer. Optional `toolPreferences` still guide choices between existing tools.

Compaction only changes an untouched SDK section generated by the installed official renderer. Provider-owned/custom SDKs keep their own loaders. Extensions must support the host and publish into `deep-ptc`; this layer does not override hidden tools, authorization or an unloaded whole executor. Actual OPS/online-model end-to-end integration has not been performed.



## Enforced reachability: no sleeping, always interruptible

From 1.5.0, "don't sleep or wait" is enforced by plugin code, not just requested in the prompt:

| Situation | What the code does |
| --- | --- |
| A foreground command runs long | After **30 s** (configurable, 5–600) it moves to a background job and keeps running; a larger requested `timeoutMs` is capped |
| You send a message while a command runs | The foreground wait ends within about 2 s, the command continues in the background, and the model reads your message; job completion still wakes it |
| `job_output` waits on a job | Capped at 30 s, ends early when you send a message, and waiting again while your message is unread is refused |
| The model writes `sleep 60`, `Start-Sleep 30` or `timeout /t 20` | Foreground pauses over 5 s are refused (`run_in_background` commands are exempt); short readiness loops such as `sleep 1` still work |
| `setTimeout`, `setInterval` or `time.sleep` in a `run_code` program | Known waits over 5 s are refused; unresolved durations pass through; polling one running job more than 3 times in one program is refused |
| `ask_user_question` | Replaced by non-blocking `ask_user` question cards while conversation cards are on (the answer arrives as your next message); with cards off it runs in timed mode: 120 s by default, at most 300 s, `-1` refused. An unanswered question becomes pending and your later answer arrives as a message; typing a reply instead of using the card ends the wait at once |

These rules apply only to Deep PTC sessions. They rely on the desktop "busy Enter" setting being **steer**; with **queue**, messages wait for the whole turn to end.

```yaml
- id: deep-ptc-settings
  config:
    foregroundSeconds: 30   # foreground wait cap in seconds, 5-600
```

## Choose an execution environment

Open **Settings → Deep PTC**, choose an environment, save, and create a new **Deep PTC Mode** session.

| Selection | Host | Executor / tool |
| --- | --- | --- |
| Automatic | Windows / macOS / Linux | PowerShell on Windows, Zsh on macOS, Bash on Linux |
| WSL Bash | Windows | Explicit `wsl.exe ... --exec bash -lc`, tool `bash` |
| PowerShell | Windows | Official native PowerShell executor, tool `pwsh` |
| Native Bash | Windows | An absolute path to `bash.exe`, such as the Niubash binary bundled with `dsh-ops` |
| Zsh | macOS / Linux | `/bin/zsh -lc` on macOS; installed `zsh` on Linux; tool `zsh` |
| Native Bash | macOS / Linux | Official Bash executor, tool `bash` |

Unsupported choices are disabled according to the Host, not the browser OS, and rejected by the Host schema. Leave the WSL distribution blank for the Windows default or enter an installed name such as `Ubuntu`. Zsh must be installed when selected on Linux.

The selection changes the real executor, tool contract and environment instructions. Executors live in a preset-local `shell` realm, independent of the global shell and other presets. Settings register a new preset revision for new sessions. Existing sessions and background jobs retain their revision: create a new session to change environment safely.

WSL source uses Linux/POSIX syntax, while file tools and `workdir` use Windows host paths. Distribution, cwd and source are distinct argv entries passed through `wsl.exe --cd`; no surrounding shell string is assembled. Login-shell configuration in the selected distribution controls Linux PATH and proxy setup. Windows environment variables are not all automatically exported into Linux.

### Sandbox behavior

Native PowerShell and the macOS/Linux shells use Harness sandbox, approval and process management. On Windows, WSL and native Bash require execution already authorized as `danger-full-access`. Choose PowerShell for confined Windows work.

PowerShell, macOS/Linux Bash and Zsh can use a discovered executable. On Windows, native Bash accepts an absolute path to `bash.exe`, such as `<profile>/node_modules/dsh-ops/runtime/win32-x64/niubash/winuxcmd/bin/bash.exe`. If that path is unavailable, new sessions keep the official shell.


### The selection holds on every execution path (1.9.9)

- Card buttons use the shell tool, working directory, sandbox and approval policy of the current session. Confined WSL calls are refused. After a 30-second foreground wait, the host may return a managed background job ID.
- Safe mode used to fall back to the whole official composition, which is PowerShell on Windows. It now keeps the selected WSL/Bash/Zsh unless the failure is in the execution rows themselves.
- The WSL instructions now say to work with Linux tools inside WSL by default and to call powershell.exe through interop only for steps that genuinely need Windows (GUI, registry, Windows-only programs), saying so when it does.

### Configure a tool replacement for the preset (#23)

In the existing `deep-ptc-settings` configuration, specify a tool name and optionally its preset row and replacement. For example, install a plugin that provides `pwsh_safe`, then configure the preset:

```yaml
- id: deep-ptc-settings
  config:
    toolOverrides:
      - tool: pwsh
        row: tool-pwsh
        replacement: pwsh_safe
```

The rule is scoped to Deep PTC. `tool` hides the inherited tool of that name. `row` disables the entire named preset row, including any other tools it registers. `replacement` is optional. If its provider has yet to load, the model is told that the replacement is unavailable for that request. Calls use the replacement’s own schema and permission policy.

Existing `disabledShellTools: ['pwsh']` configurations keep working. A card command reports an error when its session’s shell is disabled. A reply button can send the decision to the model, which can then use an installed replacement. New sessions use the updated preset settings.

## Deep creative mode and isolated plugin previews

Enable **Deep creative mode** in its own section of the side panel and open a new Deep PTC conversation. The setting belongs to the profile. Existing conversations retain their preset generation. The mode discovers the host’s creative tools and development skills, including Cordis Inspect where available.

Develop in a checkout separate from the active plugin installation, build the candidate and run `npm pack`.

**Virtual DSH.** The Virtual DSH card in the side panel starts a fresh DSH Web instance with the same host version as the desktop app (it uses the CLI the desktop app ships), the same plugins, skills, agent presets and settings, and none of your sessions, workspaces, memory or `AGENTS.md`. It signs in with the credentials of the DSH that launched it: they are copied at start and deleted first at stop, and no account is ever bundled with the plugin. Only one runs at a time; it opens in the right sidebar, and stopping it removes its directory. A crash leaves a directory that the next start sweeps.

**The `virtual_dsh` tool** (creative mode) lets the model drive it: `start` (optionally with `package`, the built `.tgz`), `status`, `restart`, `stop`, `logs`, `add_plugin` / `remove_plugin` / `list_plugins` for extra plugins (a `.tgz`, a directory or an npm name), `read_config` / `write_config` for its `cordis.patch.yml`, and `chat` / `transcript` / `sessions` / `cancel` to hold test conversations in it and read back replies, tool calls and errors. The first action that starts, changes or talks to it asks you once for the whole conversation. Changes restart it on the same port, so an open sidebar tab keeps working. The `deep-ptc-virtual-dsh-testing` skill describes the testing procedure.

Without the tool, the same launcher runs as a managed shell job: `node "<plugin directory>/lib/preview.mjs" --package "<absolute path to the built .tgz>"`, with `--cli <path>` for a specific DSH CLI and `--no-credentials` to start signed out. The creative prompt supplies the launcher and CLI paths. Desktop-only APIs need desktop verification.

## dsh-go and other external tools

Deep PTC can use other plugins within the same task: **DrawAI** reads, edits and exports diagrams; **guizang-design** supplies page, slide, social-card and writing skills; **Agentero** supplies paper and note tools; **dsh-ops** recognizes the preset for its execution environments; and **DSH Go** receives screen-tool availability and SSH connection assistance. **dsh-context** can read skills from the current Agent's service for context inspection.

Version 1.9.2 prevents repeated stale-revision rejections from quarantining a working editor. Twenty-six actual DrawAI, guizang-design and Agentero host tools passed isolated interface checks; DrawAI file editing and SVG export also passed. Design generation, the paper CLI, phone connections and video rendering have their own dependencies and verification limits. See the [plugin workflow details](COMPATIBILITY.md).

External plugins are discovered from what they actually register. Tools and workflows are chosen by capability first. Official PTC tools stay available and are the fallback when a third-party tool fails. No external plugin, including dsh-go, is a dependency of this package.

**dsh-go** (the phone app and its screen-control surface) stays usable inside a Deep PTC session:

- Screen-control tools remain in the initial PTC SDK. They are not folded into the on-demand catalog and they are not quarantined after a failure. A tool qualifies when it sets `resident` (or `deepPtc.resident`), when its presentation carries the `dsh-go/view` key, when its name is `intent`, `collect`, `tap_xy`, or starts with `screen_`, or when its provider is marked as dsh-go, screen control, computer use, or phone control. Any other plugin can use the same `resident` flag. Ordinary extensions stay on demand.
- Deep PTC does not declare dsh-go's own slots and does not replace its settings. Those forms still come from the Cordis schema, so the app renders them itself.
- The panel reads its own state first. If a projection is missing or the session belongs to another preset, that part is left out; a failure in the panel leaves the conversation, the input row and the screen-control chrome in place.

Phone screen control was not clicked on a device for this release. The guarantee above is the SDK membership, the quarantine rule, and the composer failure path.

## 1.8.0: session-scoped preset identity

External plugins often use the preset ID to enable capabilities. The adapter runs only for sessions using Deep PTC. DSH mounts `deep-ptc` and records that preset ID on the session. A plugin such as dsh-ops that relies on official preset IDs receives `ptc` when it queries `composedPreset`.

- **Layer 1 (native)**: an external plugin that does not limit preset names receives `deep-ptc` and works as-is; a plugin that explicitly declares support for `deep-ptc` also receives the native id.
- **Layer 2 (compatibility alias)** returns `ptc` by default when the caller's gate requires an official preset ID. The alias applies to that query.
- Host calls that must stay exact (subagent child headers, scheduled session creation, the registry itself) always receive `deep-ptc`, so inheritance and scheduling are unaffected.
- A normal PTC session already returns `ptc`; every other preset is returned unchanged. The official PTC preset is not replaced, and DSH is not modified.
- Creative mode and the plugin lab: loading reads the host roster and documents only, never `composedPreset`. A creative row mounted into a Deep PTC session that accepts only `cordis` gets `cordis`; a normal creative session is unchanged.
- `composedPreset` returns one ID per call. The adapter selects a layer from the caller's package or explicit settings before returning. The host exposes no callback for the caller's validation result. The settings are `presetCompat`, `presetFallback` and `presetSupport`.

Limitation: this wraps the host's `agentPresets.composedPreset` instance and depends on its internal signature, so re-check after a DSH upgrade. The per-package probe is heuristic; dynamically assembled ids may not be recognised.

## Working contract

- Spend the budget on the work: the persona grants an unlimited token budget in this mode, so it does not skip reads, searches, commands or checks to save tokens. Guardrails forbid padding, and compaction, pruning and subagents keep each request inside its finite context window.
- Stay reachable while work runs: no sleeps, busy-polls or long foreground calls. Long commands run as background jobs while the model continues short steps and checks progress without blocking; with nothing left to do it states what is running and ends the turn. Job completion wakes it, and user messages are handled immediately.
- Plan by expected size: five minutes or less, plan internally and act; five to twenty minutes, show the plan and start without approval; more than twenty minutes, show the plan and wait for approval. Re-plan when the estimate moves up a band. Explicit plan mode always wins.
- Ask instead of guessing intent: meaning belongs to the user, facts to the tools. Unfamiliar names, competing targets or routes, authoritative sources, expected process, acceptance criteria and scope are asked about rather than guessed or searched for; inspectable facts are looked up. One to three questions with options, recommended first; the user's answer wins.
- Work visibly: one sentence before each `run_code`, longer updates at milestones, never more than two or three silent tool calls.
- Verify changed behavior and stop when criteria are met; delegate only genuinely independent work and collect results through the actual tool's channel.

A prompt changes the model's working tendency, not the real token limit or billing, and compliance is not guaranteed. The setting that actually controls thinking depth is the model's `reasoningEffort`.

## Install or upgrade

Requires Node `>=24` and DSH `>=0.2.2-rc.1`. The installer rejects the current package on DSH `0.2.1-rc.5` based on its manifest. macOS/Zsh checks cover configuration, argv and tool mounting.

```js
plugin_manager({ action: "install_bundle", target: "dsh-deep-ptc-mode@2.3.0" })
// Or from a local checkout or archive:
plugin_manager({ action: "install_bundle", target: "C:\\path\\to\\dsh-deep-ptc-mode" })
// Or target: "C:\\path\\to\\dsh-deep-ptc-mode-2.3.0.tgz"
```

Repository locator: `github:lishize20040802-rgb/dsh-deep-ptc-mode`. It installs content actually published there; a local upgrade does not publish to GitHub or npm.

Installing the same bundle updates it. Upgrading from the persona-only release requires a Host plugin reload; reopen the app if the settings card has not appeared. Installation does not change the default mode for unrelated new sessions.

Settings persist through the active profile's Cordis patch:

```yaml
- id: deep-ptc-settings
  config:
    environment: auto       # auto | wsl | powershell | zsh | bash
    wslDistribution: ''      # blank uses the Windows default
    shellExecutable: ''      # blank keeps the official lookup
```

`pluginLab` defaults to false and can be changed from the side panel.

Prefer the UI, which uses revisioned, atomic Host form writes.

## Mode isolation

Runtime features serve sessions currently selected as `deep-ptc`. The preset mounts its tool directory, tool state and execution environment. The skill projection starts from the creation header and folds valid host `agent-preset/selected` events. Commands, `agent/pre-step` and the client panel check the current selection. Other modes keep empty skill state, and a missing creation header starts inactive.

## Compatibility and development

Deep PTC is composed at load time from the PTC preset the installed Harness declares (`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`). Every official row is inherited as-is; Deep PTC replaces only its persona text, swaps the two platform-switched shell tools for one isolated execution group, adds the reachability guard, and wraps the official job and question tools. The wrappers and the execution group never name an official module themselves: they load the module the official row names (and the shell executors the base deployment declares in `@deepseek-ai/dsh-base/cordis.patch.yml`), with the official options. An official PTC change therefore reaches this mode without a plugin release, and a removed or renamed upstream module cannot leave a stale row behind. When the chosen execution environment cannot be mapped onto the official rows, those rows are kept and the change is logged. If the declaration cannot be resolved, read or parsed, the bundled `lib/preset.json` snapshot is used as a fallback and the fallback is logged.

Because the declarations are resolved through the host runtime, every host package the plugin imports statically is declared in `peerDependencies` — including `@deepseek-ai/dsh-web-app`. The host routes those names to the installation for a linked plugin; `npm run check` fails if one is missing, which is what keeps a `link:` installation on the live declaration instead of silently using the fallback snapshot. `compatibility.json` records the upstream release the checked fixture was taken from and its hash; `npm run check` verifies that the bundled fallback still derives the same preset as that fixture and that the inheritance invariants hold. The engines range is an installation floor, not proof that every future release was tested, so run `npm run check:upstream -- <path>` against a new release before trusting it.

```sh
npm ci
npm run build:client
npm run check
npm test
npm run check:upstream -- /path/to/the/new/upstream/ptc.patch.yml
npm run sync:snapshot                      # refresh lib/preset.json and lib/base-snapshot.json from the installed declarations
PTC_RUNTIME_MODULES=/path/to/dsh/node_modules node scripts/check-preset.cjs  # loader-level row resolution on a real runtime
PTC_RUNTIME_MODULES=/path/to/dsh/node_modules node scripts/check-reachability.mjs  # interruptible waits on a real runtime
npm pack
```

The checker parses `!!js` as data and asserts the derivation invariants: every official row survives unchanged except the persona, the shell rows and the two wrapped tools (including when the official preset nests them in a group); row ids stay unique; derivation is deterministic across ten platform/environment pairs. Tests cover future compositions as well (unknown rows, reordered rows, removed shell or wrapped rows), plus platforms, argv boundaries, confined WSL refusal, atomic settings writes and stale revisions. Real-task evaluations should measure successful completion, unnecessary questions, scope expansion, background-work collection and latency.

Main files: `cordis.patch.yml` is the settings entry; `lib/index.mjs` manages revisions; `lib/model.mjs` builds isolated execution configurations; `lib/executor.mjs` extends the official bash executor for WSL/Zsh; `lib/terminal.mjs` runs the official shell tool the declaration names, with interruptible waits and the Zsh dialect; `lib/jobs-tool.mjs` and `lib/ask-user.mjs` run the official job and question tools the declaration names; `lib/host.mjs` resolves those official modules through the installed runtime; `lib/guard.mjs`, `lib/rules.mjs`, `lib/sleep-lint.mjs` and `lib/reachable.mjs` implement the pause/polling guard and interruptible waits; `lib/client.js` is the generated client bundle built from `src/client/`; `lib/upstream.mjs` locates and parses the installed PTC declaration; `lib/preset.json` holds the persona and the fallback snapshot used only when that declaration is unavailable.

Uninstall with `plugin_manager` action `remove_bundle`, target `dsh-deep-ptc-mode`. Local link installations depend on their source directory: uninstall before deleting it.

## Author

Deep PTC mode is written and maintained by [lishize20040802-rgb](https://github.com/lishize20040802-rgb).

- Issues and feature requests: [GitHub issues](https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode/issues)
- Email: lishize20040802@gmail.com

### Contributors

Thanks to these contributors for merged pull requests:

- [Freezecatmeow](https://github.com/Freezecatmeow): found and fixed the Web profile boot timeout caused by plugin startup waiting on host services ([#18](https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode/issues/18), [#19](https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode/pull/19)).
- [GYT-Lucas](https://github.com/GYT-Lucas): the duplicated Agent presets settings entry and official preset-gate compatibility ([#13](https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode/pull/13), [#14](https://github.com/lishize20040802-rgb/dsh-deep-ptc-mode/pull/14)).

Bugs in DeepSeek Harness itself belong upstream, at [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).


Runtime boundaries: pause checks distinguish executable waits from strings, comments and ordinary timer callbacks. Known constants/products are checked; unresolved durations pass through. `wsl -- sleep 20` really pauses and remains refused. Static checks are not a complete language interpreter. Arbitrary run_code, synchronous subprocesses and long workflow waits cannot currently guarantee early steering; use managed jobs for long work. Official tools are never quarantined, including by stale records. Unattributed tools remain available; quarantine requires positive external attribution.

Version 1.7.3 first reads the running host’s public PTC registry, then discovers installed declarations if that API is unavailable, and uses a warned snapshot only as the final fallback. Registry/declaration or plugin-setting changes automatically refresh new preset generations; changed module sources invalidate attribution caches. No pinned DSH version selects the tool inventory, and leased sessions are not forcibly switched.
