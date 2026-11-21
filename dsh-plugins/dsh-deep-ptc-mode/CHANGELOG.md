# Changelog

## 2.3.0 — 2026-11-20

- 深度创造模式在侧栏有了独立分区，新增「虚拟 DSH 环境」：一键启动与当前宿主版本、插件、Skill 和设置一致的全新 DSH，不含会话、工作区和记忆，在右侧栏打开。启动进度显示在卡片里，可随时停止。登录凭据在启动时从当前 DSH 复制，停止时最先删除；临时目录在停止时清理，残留在下次启动时清除。
- 创造模式新增 `virtual_dsh` 工具：启动、重启、停止、状态、日志，增删额外插件，读写 `cordis.patch.yml`，在虚拟 DSH 中对话并读回每一轮的回复、工具调用和错误。每个对话审批一次；无论谁启动，侧栏都会实时显示。
- 内置 Skill 增至十个：新增 `windows-wsl`、`dsh-plugin-dev`、`virtual-dsh-testing`、`tool-evaluation`；`dsh-operations` 补充卡片等待规则、审批、失效工具和常见误用。Skill 卡片上的简介跟随 DSH 界面语言。图表与资料核验 Skill 先检查 Python 依赖。
- 侧栏更简洁：空分区一行显示，工具状态为「正常 · 重载」，说明改为悬停提示；虚拟 DSH 状态不再以命令行出现在对话里。

- Deep creative mode gets its own side-panel section with a Virtual DSH card: a fresh DSH with the same host version, plugins, skills and settings, without sessions, workspaces or memory, opened in the right sidebar. The card shows startup steps and can stop it any time. Credentials are copied from the launching DSH at start and deleted first at stop; its directory is removed on stop and leftovers are swept at the next start.
- New `virtual_dsh` tool in creative mode: start, restart, stop, status, logs, extra plugins, its `cordis.patch.yml`, and test conversations with replies, tool calls and errors read back. One approval per conversation; every start shows in the side panel.
- Ten built-in skills: new `windows-wsl`, `dsh-plugin-dev`, `virtual-dsh-testing` and `tool-evaluation`; `dsh-operations` adds card waiting rules, approvals, quarantined tools and common mistakes. Skill card descriptions follow the DSH display language. The figure and source skills check Python dependencies first.
- A quieter side panel: one-line empty sections, "OK · Reload" tool state, explanations as tooltips; virtual DSH status no longer shows as command rows in the chat.

## 2.2.0 — 2026-11-20

- 侧栏新增「深度创造模式」开关，开启后新建会话即可使用官方创造工具和开发资料。开发包可在独立进程、临时目录和 Web profile 中安装测试。
- 深度 PTC 新增六个按需 Skill，覆盖宿主操作、本地 Web 验证、前端实现、原始资料核验、办公交付与科学图表。后四项附有可运行的示例。科学图表可从同一组观测值生成 SVG、统计表和结果卡片。
- 对话进行中即可在输入框上方看到卡片。项目卡使用运行时上下文快照，并将省略名单计入 16,000 字符预算。修复新旧客户端重复通知模型和关闭卡片后仍被要求使用卡片工具的问题。

- Enable Deep creative mode in the side panel for new conversations. Test plugin archives in a separate DSH Web process with its own home and profile.
- Six on-demand skills cover DSH operations, local web testing, frontend implementation, primary-source research, Office delivery and scientific figures. Four include runnable examples. The figure generator produces an SVG, a statistical summary and a conversation card from the same measurements.
- Cards appear above the composer during a running turn. Project cards use a runtime snapshot with a 16,000-character budget including omitted titles. Delivery receipts handle mixed client versions, and project setup follows the active question-tool settings.

## 2.1.0 — 2026-11-19

- 新增任务卡「本次任务」：模型把用户消息整理成目标、约束、验收、背景和待确认条目，复述用户的条目附经过核对的原话引文，隐含需求标为推断；逐段覆盖检查，未归档原文原样列出。
- 确认后可精简上下文：原话在模型上下文里换成替身，原事件保留在聊天和会话记录中，可读回、可恢复。用户确认的条目模型不能改写或删除。
- 任务卡内容走运行时上下文快照，不改动系统提示；实测每次更新的未缓存输入从约 18,500 token 降到 600–2,600。
- 内容较多的消息未整理时提醒模型；收尾前核对验收项。
- 提问卡回答和按钮选择由服务端以结构化格式送达模型（卡片 id、问题 id、选项值和用户看到的文字），旧客户端回退到文字回复；卡片回答可作为任务卡引文。
- 修复 `ask_user`、`ui_card`、`project_cards` 参数在 PTC SDK 中显示为 `unknown` 的问题，新增 schema 回归测试。`ui_card` 返回值去掉展示字段。
- 设置新增「任务卡」开关，侧边面板新增「本次任务」。
- Task brief: the model files goals, constraints, acceptance criteria, context and open questions from the user's messages, with checked verbatim quotes, inferred items marked, and clause-level coverage showing unfiled text.
- Confirm and condense replaces filed messages in the model's context with stubs; originals stay in the chat and the log and can be read back or restored. Confirmed items are the user's.
- The brief travels as a runtime-context snapshot instead of the system prompt: 600–2,600 uncached tokens per update instead of about 18,500 in a live rerun.
- Reminders for unfiled substantive messages; acceptance items are checked before the final answer.
- Question-card answers and button choices reach the model in a structured form delivered by the server; older clients fall back to text; card answers can be quoted in the brief.
- Fix the `ask_user`, `ui_card` and `project_cards` parameters showing as `unknown` in the PTC SDK, with a schema regression test; `ui_card` results drop presentation fields.
- Task brief switch in settings and a Task brief section in the side panel.

## 2.0.1 — 2026-11-18

- 对话卡片按版本留在历史中，只有最新一轮可以点，旧版本只读存档，关闭的卡片收成一行。
- 新增不阻塞的 `ask_user` 提问卡片，开启对话卡片时取代官方提问工具，回答作为下一条消息送达。
- 卡片未指定 `size` 时自动并排排版。
- 特点卡片作为受保护提示词中的独立模块注入，增删改和润色立即以 steer 消息送达模型；超长时整张略去并列名。润色支持子代理或当前对话，由用户决定是否采用。
- 侧边面板加入特点卡片入口：编辑（不打扰模型）或让模型在主对话引导设置；兼容「更多会话视图」菜单。
- 新增「面板位置」设置，可把整个面板放进右侧栏，并适配 dsh-better-sidebar（#25）。
- shell 沙箱提权改为立即返回 `approval-N` 审批任务，`job_output` 查询状态，不再卡住。
- 新增受保护的进度汇报指引，开局静默即提醒。
- Cards stay in history by version (latest turn clickable, older ones archived); non-blocking `ask_user` question cards replace the official question tool; automatic side-by-side card layout.
- Project cards become modular protected prompt constraints; every change reaches the model at once; whole-card truncation; user-reviewed polishing via subagent or chat; project card entry in the side panel.
- Panel location setting with sidebar and dsh-better-sidebar support (#25); sandbox escalations become queryable approval jobs; protected progress-reporting guidance.

## 2.0.0 — 2026-11-18

- 恢复原版 1.9.9 主提示词。深度 PTC 会话主动汇报、展示实测结果并提供可交互选项。
- 面板子代理支持就地建卡、结束后重新开始。项目记住未完成的引导和暂缓决定。不同来源的提案独立保存，冲突时合并后再次审批。
- F 卡指导模型验证相关既有行为并列出实测、失败和待测结果。新增通过 DSH 账号运行的真实模型验收脚本。
- Restore the original 1.9.9 persona. Add in-panel guide conversations, workspace setup memory, source-aware proposal review and F-record regression reporting.

## 1.9.9 — 2026-11-17

- 对话卡片升级为可组合的卡片接口：页头 + 最多 6 个块 + 脚注 + 最多 4 个按钮。新增 11 种展示块（指标卡、键值行、进度条、条形图、折线图、环形图、步骤、表格、标签、段落、提示）和 2 种交互块（选项、时间/日期/数字输入）。按钮可以在宿主上执行（删除定时任务或运行命令）、把用户的选择作为下一条消息发给模型，或两者兼做；`keep` 让卡片按完后继续可用。命令中的 `{name}` 只接受时间、日期、数字和卡片声明的选项值，服务端再次校验。1.9.7/1.9.8 的 `lines` 与 `stop` 仍可读取。
- 卡片外观重做：统一的排版与配色，跟随明暗主题；图表配色经色盲安全校验且每个数值都直接印出；折线图悬停显示数值，环形图悬停联动图例；关闭按钮移到页头。修复卡片在每一轮末尾重复显示的问题，现在只在最新一轮末尾出现一次。
- 对话卡片、20 个开发场景样板和项目卡片维护各有一份按需 Skill。样板用真实解析器校验。需判断权限、进程归属或部署目标的按钮把选择交回模型。
- 卡片代码拆分为 `card-blocks.mjs`（块词汇与校验）、`cards.mjs`（卡片状态）、`card-runner.mjs`（按所选环境运行命令）、`card-skill.mjs`（skill）与 `cards-context.mjs`（宿主接线）；输入校验与存储状态解析共用同一套读取器。
- 卡片按钮通过当前会话绑定的 Harness Shell、工作目录、沙箱与审批执行。拒绝旧版卡片操作和已关闭的功能。长任务可以返回宿主后台任务 ID。
- 修复：安全模式会整体回到官方组合，Windows 上即变成 PowerShell。现在只要故障不在执行环境行，安全模式保留所选 Shell。WSL 说明补充：默认用 WSL 内的 Linux 工具，只在确实需要 Windows 时才通过互操作调用 powershell.exe。
- 新增通用 `toolOverrides`（#23）。在当前预设停用指定工具行、屏蔽继承的同名工具并声明可选替代工具。支持 Shell 与其他插件工具，旧 `disabledShellTools` 继续有效。感谢 @Hermuc 提出问题。
- 界面特效开关从侧边面板移到「设置 → 深度 PTC → 外观」。
- 新增「特点卡片」。工作区的 `PROJECT-CARDS.md` 保存用户设定 R、已实现功能 F 和用户要求 Q。DSH 系统提示词每次请求读取当前文件，历史消息中引用的内容按历史版本处理。
- 深度 PTC 会话新增「特点卡片」页，支持编辑、润色、审批、历史与回滚。提交比较编辑时的文件版本，遇到外部更新会保留草稿并提供合并，写入保留插件管理范围外的 Markdown。
- 设置 → 深度 PTC 新增「卡片」：对话卡片、特点卡片各一个开关，默认开启，即时生效。
- 对话卡片新增 `size`（full / half / third）：多张卡片排成网格，可两张并排或三张一行，窄窗口自动堆叠；skill 增加多卡片排版规范与并排样板。
- 侧边面板的执行环境、子代理、后台任务、输出文件、SSH、工具状态可拖动排序（或聚焦后按 ↑ ↓），顺序按浏览器保存。
- Conversation cards become a composable card interface: a header, up to 6 blocks, a note and up to 4 buttons. Adds 11 display blocks (stats, rows, progress, bars, line, donut, steps, table, tags, text, callout) and 2 interactive blocks (choice; time/date/number field). A button can run on the host (delete scheduled tasks or run a command), send the user's choice to the model as their next message, or both; `keep` leaves the card usable. `{name}` placeholders accept only times, dates, numbers and option values the card declared, validated again on the server. Cards from 1.9.7/1.9.8 (`lines`, `stop`) still load.
- Redesigned card look: one type and colour system following light and dark themes; a colour-vision-safe chart palette with every value printed; a line-chart hover tooltip and a donut hover linked to its legend; the close button moves to the header. Fixes cards repeating after every turn: they now draw once, after the latest turn.
- Separate on-demand skills cover the card interface, 20 validated development examples and project card maintenance. Actions requiring ownership or deployment checks hand the decision back to the model.
- Card code splits into `card-blocks.mjs` (block vocabulary and readers), `cards.mjs` (card state), `card-runner.mjs` (commands in the selected environment), `card-skill.mjs` (the skill) and `cards-context.mjs` (host wiring); tool input and stored state share one reader.
- Card buttons use the session’s bound Harness shell, working directory, sandbox and approval pipeline. The service rejects obsolete card actions and honors the feature switch. Long commands can return a managed job ID.
- Fixed: safe mode fell back to the whole official composition, which is PowerShell on Windows. It now keeps the selected shell unless the execution rows failed. The WSL instructions now prefer Linux tools inside WSL and use powershell.exe interop only for steps that need Windows.
- Add `toolOverrides` (#23) to disable a preset row, mask an inherited tool and suggest an optional replacement, for shells and other tools. Existing `disabledShellTools` settings still work. Thanks to @Hermuc for the report.
- The visual effects switch moves from the side panel to Settings → Deep PTC → Appearance.
- Project cards live in `PROJECT-CARDS.md` as user settings (R), implemented features (F) and user requirements (Q). The system prompt reads the current file on each request. Earlier quotes in chat remain historical.
- The Project cards tab supports edits, draft polishing, approvals, history and rollback. Submissions check the file version, keep drafts on conflict and preserve surrounding Markdown.
- Settings → Deep PTC gains a Cards section: one switch each for conversation cards and project cards, on by default and applied at once.
- Conversation cards gain `size` (full / half / third): several cards form a grid, two side by side or three in a row, stacking in narrow windows; the skill adds multi-card layout rules and side-by-side samples.
- The side panel's sections (environment, subagents, jobs, output files, SSH, tool state) can be reordered by dragging or with ↑ ↓ on a focused handle; the order is kept per browser.
- F 卡片用于回归检查。改新功能前读取相关已实现行为，验证受影响的既有功能。精简常驻提示词，按功能拆分卡片界面源码。预设注册失败时尝试恢复上一个可用定义。
- Use F cards as regression references for related changes. Shorten the resident persona and split card UI source by feature. Restore the last usable preset after a rejected registration.

## 1.9.8 — 2026-11-17

- 修复：更新已有卡片时写入的状态里带了一个 `undefined` 字段，宿主判定为不可序列化而拒绝写入。现在更新会清除旧结果，状态保持纯 JSON。新增严格序列化守卫测试，这类问题以后会在提交前被测试拦下。
- 1.9.7 的对话卡片能力不变：`ui_card` 工具、`deep-ptcCards` 投影、`deep-ptc-card-act` 命令与 `turnTail` 渲染。
- Fixed: updating an existing card wrote a state with an `undefined` field, which the host rejects as non-serializable. Updating now clears the previous result and keeps the state pure JSON, and a strict serializability guard in the tests catches this class of bug before release.
- The card capability from 1.9.7 is unchanged: the `ui_card` tool, the `deepPtcCards` projection, the `deep-ptc-card-act` command and the `turnTail` rendering.

## 1.9.7 — 2026-11-17

- 卡片改为插件自己的实现：会话投影保存卡片、宿主命令处理按钮、`conversation.chat.turnTail` 渲染、新增 `ui_card` 工具负责创建/更新/删除。不再依赖宿主 `actionCards` 的 `propose_action`——那个工具是“按需动态声明”的，进不了深度 PTC 的 `run_code` 工具集，卡片因此无法在 PTC 会话里出现。现在与 Skill 卡片同一套机制，在 PTC 和其它会话里都能用。
- 卡片按钮执行真实动作：删除卡片指定的定时任务、运行一条命令（30 秒超时）；执行中/成功/失败三态直接显示在卡片上。
- 移除 1.9.6 的 action-card 种类、技能与客户端 body（改用 `ui_card` 工具），并新增纯逻辑单测。
- Cards now use the plugin's own mechanism: a session projection holds them, a host command handles the button, `conversation.chat.turnTail` renders them, and a new `ui_card` tool creates, updates and removes them. The host's `actionCards` `propose_action` is no longer used: that tool is declared conditionally and never reaches Deep PTC's `run_code` tool set, so cards could not appear in PTC sessions. This is the same mechanism the skill card uses, so cards work in PTC and elsewhere.
- A card button really runs: it deletes the scheduled tasks the card names and runs one command (30s timeout); working/done/failed states render on the card itself.
- Removes 1.9.6's action-card kind, skill and client body in favour of `ui_card`, and adds unit tests for the pure card logic.

## 1.9.6 — 2026-11-17

- 新增「小卡片」：插件向宿主注册一个通用操作卡片种类（`deep-ptc-card`），模型可以在回答下方留一张静态卡片——标题、键值行、脚注——卡片上的按钮由宿主真正执行：删除指定的定时任务，或运行一条命令。卡片用宿主原生的 action-cards 界面渲染，不遮挡输入框；未注册 body 的宿主会退化成只有「暂不」的兜底卡片，不影响其他功能。
- 新增 `deep-ptc-cards` 技能，说明何时、如何放一张卡片，以及 details 的字段与限制（每轮最多一张）。
- 新增卡片 body 的客户端实现、中英文案与轻量样式；卡片种类与技能都是可选层，缺少宿主服务时只关掉卡片本身。
- New "small card" action kind (`deep-ptc-card`): the model can leave a static card under an answer — title, labelled rows, note — whose button really runs on the host: deleting the scheduled tasks it names or running one command. Cards use the host's native action-card UI and never cover the composer; a host without our body falls back to a dismiss-only card, so nothing else changes.
- New `deep-ptc-cards` skill describing when and how to place a card, its details fields and the one-card-per-turn limit.
- Adds the client card body, bilingual copy and lightweight styles. The kind and the skill are both optional layers: a missing host service disables the card alone.

## 1.9.5 — 2026-11-14

- 插件启动不再等待任何宿主服务（#18）。技能卡、工具状态和输出/SSH 记录在各自服务就绪后自行启动；晚注册的会话投影首次读取时会折叠完整日志，不丢记录。预设在后台发布，只有打开深度 PTC 会话时才会等待首次发布完成，不会拖住整个 Host 启动。感谢 @Freezecatmeow 定位问题并提交 #19。
- 界面特效不再改写宿主的配色变量、字体和全站控件过渡（#17）。特效只作用于输入框、发送键、消息气泡、回复排版和会话行，私有变量固定定义在根元素上；在深度 PTC 会话之间切换时特效不会先摘后挂，离开时延迟 150ms 关闭。减少动态效果模式只针对这些元素生效。
- README 新增贡献者名单。
- Plugin startup no longer waits for any host service (#18). The skill card, tool state and output/SSH activity start when their services are ready; a projection registered late folds the whole log on first read. The preset publishes in the background, and only opening a Deep PTC conversation waits for the first publication, so the Host boot is never held. Thanks to @Freezecatmeow for the diagnosis and #19.
- Visual effects no longer rewrite host colour tokens, fonts or transitions on every control (#17). They touch only the composer, send button, message bubbles, reply typography and session rows; private variables are defined once on the root. Moving between Deep PTC conversations keeps the effects on instead of removing and re-adding them, and leaving waits 150ms before switching off. Reduced motion applies to those elements only.
- Add a contributors section to the README.

## 1.9.4 — 2026-11-13

- 胶囊位置可选：自动 / 输入框下方 / 工具栏 / 隐藏。「自动」检测到 dsh-claude-style 时把胶囊放进输入框工具栏（`conversation.input.right`），不再单独占一行（#16，也补上 #12 的第 3 点）。隐藏后，右侧栏新建页签引导中会出现「深度 PTC」，页签内的按钮可打开面板。
- 侧边面板左边缘可拖动调整宽度，也可用方向键（Shift 加大步长）、Home/End 调整，双击恢复 280px。宽度按浏览器保存，并限制在 240–640px；停靠时对话区至少保留 540px。
- 固定在右下角的悬浮挂件（dsh-whale-widget）不再遮住面板底部按钮：面板正文按重叠高度留出空间。
- Capsule position: auto, below the composer, toolbar or hidden. Auto puts the capsule in the composer toolbar (`conversation.input.right`) beside dsh-claude-style instead of on its own row (#16; also #12 item 3). When the capsule is hidden, the Deep PTC tab appears on the sidebar's new-tab guide and opens the panel.
- The side panel's left edge resizes it by dragging, arrow keys (Shift for larger steps) or Home/End; a double click restores 280px. The width is remembered per browser and kept within 240–640px, leaving at least 540px for a docked conversation.
- A widget pinned to the bottom-right corner (dsh-whale-widget) no longer covers the panel's last controls.

## 1.9.3 — 2026-11-12

- 侧边输出文件可点击，使用 DSH 原生文件资源接口按所属会话打开；兼容折叠列表、相对路径、Windows/UNC 路径及带中文和特殊字符的文件名，预览不可用时显示提示。
- 子代理行精简为状态指示、名字与同一行最右侧的用时，移除可见状态文字、统计摘要和 token 消耗。状态仍供辅助阅读工具使用。
- Output files open through DSH's native session-scoped viewer, including folded entries, relative/Windows/UNC paths and special characters; unavailable previews show a message.
- Subagent rows show the state indicator, name and right-aligned duration. Visible state text, summaries and token usage are removed; state remains available to assistive technology.

## 1.9.2 — 2026-11-12

- 文档与简介说明 DrawAI 绘图、归藏设计技能、Agentero 论文工具、dsh-ops 执行环境及 DSH Go 连接辅助的协作方式，并标明验证范围。26 个真实工具通过隔离注册、发现、选用和宿主双语言 SDK 渲染；DrawAI 的文件编辑、SVG 导出和 revision 冲突保护通过。统一分类层将明确的并发编辑冲突归为输入状态过旧，修复连续旧 revision 拒写导致工具误隔离；保留实现缺陷、不可用和部分完成的处理。
- Document the workflows and verification limits for DrawAI diagrams, guizang-design skills, Agentero paper tools, dsh-ops execution environments and DSH Go connection assistance. Twenty-six actual tools passed isolated interface checks and both host SDK renderers. DrawAI file edits, SVG export and revision-conflict protection passed. Classify explicit optimistic-lock conflicts as stale input so repeated safe rejections cannot quarantine a working editor; retain defect, unavailability and partial-effect handling.

- 面板回到对话区侧边，保留输入框下方的胶囊，使用布局事件更新位置。旧侧栏页签显示迁移提示。
- 命令与 Skill 投影跟随宿主当前预设选择，修复空白会话先创建再选择 Deep PTC 时的模式门禁。
- 通用 SSH 增加检查命令复制，并提供按需复制的 DSH Go 连接资料。

- Restore the conversation-side panel and retain the capsule below the composer. Layout events update its position. Old sidebar tabs show a migration hint.
- Follow the host's current preset selection in command gates and the skill projection, including a blank session switched to Deep PTC after creation.
- Add a general SSH check-command copy action and optional DSH Go connection details.

## 1.9.1 — 2026-11-11

- 更新 npm 与 DSH 插件管理器中的简介：写明右侧栏面板（子代理、后台任务、输出文件、SSH 连接）以及对官方与第三方插件的兼容；README 的「五个基本问题」补充新的提问与工作纪律规则。代码与 1.9.0 相同。

- The npm and DSH plugin-manager descriptions now cover the right-sidebar panel (subagents, background jobs, output files, SSH connections) and compatibility with official and third-party plugins; the README's five basic problems include the new asking and work-discipline rules. The code is unchanged from 1.9.0.

## 1.9.0 — 2026-11-11

- 面板移入 DSH 官方入口：设置里新增独立的「深度 PTC」页（执行环境、界面特效、可复制的诊断信息）；右侧栏新增「深度 PTC」页签，也出现在右侧栏的新建页签引导中，停靠、浮动、全屏由 DSH 管理；输入框下方的小胶囊打开它，没有右侧栏的宿主在原地展开。原来悬浮的侧边卡片、挤压对话区的停靠列和右上角胶囊全部移除，右侧栏全屏时不再残留悬浮胶囊（#11），也不再遮挡消息（#12）。
- 设置左导航不再出现两个「Agent 预设」（#9、#13）：去掉对 `settings.section` 的同 id 影子注册，改为注册自己的设置页。
- 深度 PTC 会话里的官方插件（如 Computer Use）不再静默缺席（#14）：除子代理、定时任务、预设注册表和应用自身代码外，官方插件一律按角色收到基础预设 `ptc`，不再逐个读取源码判断。仅在深度 PTC 会话中生效。
- 感谢 @GYT-Lucas 在 #13、#14 中定位根因并提交修复，本版以自己的实现吸收了这两个问题。
- 新增「输出文件」：本会话写入或交付的文件，最新在前；最多三个位置，超出时折叠占一个位置。规则与 DSH 官方交付卡片一致，并包括 `run_code` 内写入的文件。
- 新增 SSH：面板列出本会话连接过的主机及结果，以及 `~/.ssh/config` 的主机别名；模型获得本机 OpenSSH 客户端位置、主机别名和非交互使用规则（`BatchMode`、超时、认证失败即停、长任务转后台）。只读取主机名称、地址、用户和端口，不读取密钥。
- 预设名称与描述改为与语言无关（`Deep PTC · PowerShell`），模式选择器和会话头部仍按 DSH 语言显示本地化文字；安全模式会写出宿主给出的原因。
- 安全模式只在预设行真正启动失败时启用；仅在等待服务的行不再触发安全模式（#5）。修改设置或上游声明后重新尝试完整预设。
- 识别 Microsoft Store 安装的 PowerShell 7：用 `lstat` 和 `readlink` 读取应用执行别名，不再把“拒绝访问”的路径一律当作存在；同一安装只列一次，标为「PowerShell 7（应用商店）」（#10）。
- 界面特效轻量化（#6）：样式直接作用于 DSH 的 `data-composer-card`、`data-message-bubble` 等稳定属性，不再逐帧计算元素样式；循环动画只改透明度或位移；光点画布只覆盖输入框附近，像素密度上限 1.5，空闲或窗口隐藏时停止；不再定时轮询当前会话。检测到 dsh-claude-style、dsh-refined-ui 等外观插件时特效默认关闭，手动打开后保留选择（#7）。
- 移除本插件添加的全部快捷键：Ctrl/⌘+K 命令面板（与 DSH「搜索会话」冲突）、`/`、Alt+↑/↓ 和 Ctrl+Alt+D。诊断信息移到设置页。
- 人设新增「遵循用户指令」和「工作纪律」：不认识的词先问用户，用户不知道时再自行查证；用户说明优先于模型的既有认识；不擅自换方案；多项请求逐项核对；不虚报验证结果。
- 预设身份兼容层在宿主 `composedPreset` 签名不符时不安装。

- The panel moves into official DSH entry points: a Deep PTC settings page (environment, visual effects, copyable diagnostics), and a Deep PTC tab in the right sidebar, also listed on its new-tab guide, which DSH docks, floats and expands like its own tabs. The capsule under the composer opens it, or opens the panel in place on a host without a right sidebar. The floating side card, the docked column that narrowed the conversation and the top-right pill are gone, so nothing floats over a fullscreen sidebar (#11) or covers messages (#12).
- The settings navigation lists Agent presets once (#9, #13): the same-id shadow entry in `settings.section` is replaced by Deep PTC's own settings page.
- Official plugins such as computer use no longer go missing in Deep PTC sessions (#14): apart from subagents, schedules, the preset registry and the application's own code, every official plugin sees the base preset `ptc` by its role, without its source being read. Only Deep PTC sessions are affected.
- Thanks to @GYT-Lucas for tracing the causes and contributing fixes in #13 and #14; this release absorbs both with its own implementation.
- Output files: files this conversation wrote or delivered, newest first, in three positions with overflow folded into one. The rule matches DSH's deliverables card and also counts files written from `run_code`.
- SSH: the panel lists hosts this conversation reached with their outcome, and the host aliases from `~/.ssh/config`. The model is told where the OpenSSH client is, which aliases exist, and the non-interactive rules (`BatchMode`, timeouts, stop on authentication failure, long work as a background job). Only names, addresses, users and ports are read, never keys.
- The preset name and description are language-neutral (`Deep PTC · PowerShell`); the mode picker and conversation header still show localized text. Safe mode publishes the host's reason.
- Safe mode starts only when a preset row actually fails; rows still waiting for a service no longer trigger it (#5). Changing settings or upstream declarations retries the full preset.
- Microsoft Store PowerShell 7 is discovered: the app execution alias is read with `lstat` and `readlink` instead of treating any access-denied path as present, and one install is listed once as "PowerShell 7 (Microsoft Store)" (#10).
- Lighter visual effects (#6): styles target DSH's stable attributes such as `data-composer-card` and `data-message-bubble` instead of measuring elements every frame; looping animations change only opacity or transforms; the spark canvas covers only the composer area at no more than 1.5 device pixels per CSS pixel and stops when idle or hidden; the active session is no longer polled. With an appearance plugin such as dsh-claude-style or dsh-refined-ui installed, effects start off, and an explicit choice is kept (#7).
- All keyboard shortcuts added by this plugin are removed: the Ctrl/Cmd+K palette (which collided with DSH's session search), `/`, Alt+Up/Down and Ctrl+Alt+D. Diagnostics move to the settings page.
- The persona adds "Follow the user's instructions" and "Work discipline": ask the user about an unfamiliar term first and research it only when they do not know; the user's statements outrank the model's prior beliefs; no silent change of approach; check off every part of a multi-part request; never report unverified results as verified.
- The preset identity layer is not installed when the host's `composedPreset` has an unexpected signature.

## 1.8.8 — 2026-11-10

- 模式选择器、会话模式标签、设置页、侧栏和命令面板随 DSH 的语言设置切换中英文。切换语言会保留当前预设选择和未保存的表单输入。
- 第三方插件通过同一套两层规则识别预设。适配优先使用 `deep-ptc`，需要兼容时默认返回 `ptc` 别名。DSH 仍实际挂载 `deep-ptc`。探测现在覆盖 `dist`，忽略注释和无关比较，并在插件升级后刷新。
- 工具隔离要求错误消息明确标注 HTTP 状态。带 `ERR_MODULE_NOT_FOUND` 或 `MODULE_NOT_FOUND` 的模块加载失败会立即隔离，工具内部缺陷累计三次才隔离。
- PowerShell 等待检测识别真正的 `Start-Job` 和 `Start-ThreadJob` 脚本块，继续检查同一条命令里的前台等待。
- `ask_user_question` 要求正数超时。若宿主提问记录为空或结构不兼容，保留官方等待。结构不兼容时记录一次诊断。
- 映射执行器抽到独立模块，并合并宿主执行器的兼容性检查。

- The mode picker, conversation preset label, settings, sidebar, and command palette follow DSH's Chinese or English language setting. Switching languages preserves the selected preset and unsaved form input.
- Third-party plugins share a two-layer preset check. It prefers `deep-ptc` and defaults to the `ptc` alias when compatibility is needed. DSH still mounts `deep-ptc`. Detection covers `dist` packages, ignores comments and unrelated comparisons, and refreshes after plugin updates.
- Tool quarantine requires an explicit HTTP status in error text. Module load failures carrying `ERR_MODULE_NOT_FOUND` or `MODULE_NOT_FOUND` quarantine immediately. Defects inside a tool still require three consecutive failures.
- PowerShell wait detection recognises actual `Start-Job` and `Start-ThreadJob` script blocks and still checks foreground waits in the same command.
- `ask_user_question` requires a positive timeout. Empty or incompatible host question records preserve the official wait, and incompatible records are logged once.
- The mapped executor now lives in a standalone module with a shared check for the host executor interface.

## 1.8.7 — 2026-11-10

- 在深度 PTC 侧栏加入界面特效开关。关闭后即时撤掉界面美化和动画，设置保存在当前客户端。使用外部主题或 UI 插件时建议关闭。
- 新增后台任务卡片。默认最多六个位置，运行中的任务优先且最多五条，已结束最多三条。折叠入口占一个位置并显示隐藏数量。
- 合并 PTC 和创造模式的 Skill 目录，修复重复注册文件系统提供器后误退安全模式的问题。
- 修复 Electron 特效层覆盖窗口拖动区的问题，区分工具重载命令不可用和执行失败，并添加中英文插件详情。
- Windows 可填写 Niubash 的 `bash.exe` 路径来使用原生 Bash。受限模式可选 PowerShell。宿主最低版本为 DSH `0.2.2-rc.1`。

- Add a visual effects switch to the Deep PTC side card. It applies immediately and remembers the choice in the current client. Keep it off when using an external theme or UI plugin.
- Show background jobs in six preview positions. Up to five active jobs take priority over up to three finished jobs. The overflow row uses one position and shows the hidden count.
- Merge PTC and creative-mode skill directories into one filesystem provider to avoid an unnecessary fallback to safe mode.
- Restore Electron window dragging with effects enabled, distinguish unavailable reload commands from execution errors, and add English and Chinese plugin details.
- Support native Windows Bash through an explicit Niubash `bash.exe` path. Use PowerShell for confined Windows work. The minimum host version is DSH `0.2.2-rc.1`.

## 1.8.6 — 2026-11-09

- 运行中的输入框泛蓝光：对话运行时输入框边框转蓝并持续呼吸发光。1.8.5 已移植这段动效，但发送后输入框处于聚焦状态，聚焦样式的 `!important` 阴影压过了动画，所以看不到；现在聚焦样式只在空闲时生效。
- 侧边卡片改为白底蓝点缀：底色与宿主一致（暗色主题跟随宿主深色），分割线与边框为浅灰色，只有选中的执行环境、按钮描边和子代理状态小方块用蓝色；文字与其他地方一样用宿主的黑色与灰色。
- 侧边卡片停靠时不再是悬浮卡片，而是从对话区右侧分出的一栏：贴住右边缘、上下通高，只留左侧分隔线；对话区让出这一栏的宽度，滚动条不会被遮住。窄屏收起的小胶囊点开后仍是悬浮卡片。
- 运行中的子代理只有行首的状态小方块闪烁蓝光，整行不发光；收起成小胶囊时也一样。系统开启“减少动态效果”时停止闪烁。
- 修复：子代理的运行状态改为同时参考会话列表里的实时状态。父会话的子代理目录只在打开官方下拉框时刷新，之前正在运行的子代理会显示为“空闲”。
- 官方声明的升级检测不再每 5 秒读一次：只在设置变更时，以及每个深度PTC对话创建或恢复、宿主确定预设之前确认一次；声明有变化时先重新派生，新对话直接用上最新预设。确认最多等 5 秒，出错或超时都照常继续。
- 预设身份兼容层的诊断改写到宿主日志，不再写入固定的本机路径（此前 1.8.0–1.8.5 的包里带有一个写死的 Windows 用户目录）。
- 工具启动自己的程序失败（`spawn … ENOENT`，无论是否带错误码）判为不可用；外部工具执行的命令不存在（command not found / not recognized）算一次普通失败，连续三次才隔离，不再当作输入错误。
- 与 refined ui 一致，子代理运行期间也算对话在运行：主代理交出这一轮后，输入框仍保持蓝光和冒泡，直到子代理结束。
- 输入框上方冒出的光点更多、稍大：频率翻倍，半径略增，样式不变。

- The composer glows blue while the conversation runs. 1.8.5 carried the animation, but the composer keeps focus after sending and the focus style's `!important` shadow beat the animation; the focus style now applies only when idle.
- The side card is white with blue accents: the host's own background (dark themes follow the host), light grey dividers and borders, and blue only on the selected environment, button outlines and the subagent status squares; text keeps the host's black and grey as elsewhere.
- Docked, the side card is no longer a floating card but a column split off the right of the conversation: flush with the edge, full height, with only a left divider. The conversation gives up that width, so its scrollbar stays visible. Opened from the narrow-window pill it is still a floating card.
- For a running subagent only the small status square flashes blue; the row itself does not glow, and the folded pill behaves the same. Reduced motion stops the flashing.
- Fix: a subagent's running state also follows the live session list. The parent's subagent catalog refreshes only when the official dropdown opens, so a running subagent used to show as idle.
- The upstream-declaration check no longer reads every 5 seconds: it runs when settings change and once before each Deep PTC conversation is created or resumed, right before the host resolves its preset; a changed declaration is re-derived first, so the new conversation gets the fresh preset. The check waits at most 5 seconds and never blocks on an error.
- The preset identity layer logs through the host logger instead of a fixed path on one machine (1.8.0–1.8.5 shipped a hard-coded Windows user directory).
- A tool that cannot start its own program (`spawn … ENOENT`, with or without the code) is unavailable; a command an external tool ran that is not installed (command not found / not recognized) is an ordinary failure, quarantined only after three in a row, instead of wrong input.
- As in dsh-refined-ui, a running subagent keeps the conversation working: after the main agent hands off its turn, the composer keeps its glow and bubbles until the subagent finishes.
- More, slightly larger sparks rise from the composer: twice as often and a little bigger, in the same style.

## 1.8.5 — 2026-11-09

- 插件实验台改为**始终开启**，移除设置开关：新建深度 PTC 会话会读取宿主创造模式并加载相对 PTC 的差量行。
- 旧 profile 中的 `pluginLab` 键仅为兼容保留，值会被忽略；创造模式读不到或进入安全模式时，会话仍只使用 PTC 工具。
- 设置页不再显示插件实验台选项；其余执行环境与工具设置不变。
- persona 删去“在 DeepSeek / 深度求索工作”的公司身份表述，改为“你拥有 unlimited token”；预算与反注水规则不变。
- 新增 Skill 上下文卡片：每轮结束只列当前仍加载、未关闭的 Skill，提供逐项滑动开关与“全部保留 / 全部关闭”；下一条消息发送时固定，关闭项在下轮前从模型上下文移除，历史仍完整保留。卡片同时识别官方 `skill` 工具与 `run_code` 内 PTC 子调用加载的 Skill。状态投影在插件根部注册并按会话 header 激活，升级后已有 Deep PTC 会话也能恢复卡片。

- Make the plugin lab **always on** and remove the settings toggle: a new Deep PTC session reads the host creative preset and appends only the rows it adds.
- Keep the legacy `pluginLab` key accepted but ignored; if the creative preset cannot be read or the preset enters safe mode, the session keeps the PTC tools only.
- No plugin-lab option is shown in settings; execution-environment and tool settings are unchanged.
- Remove the “works at DeepSeek” company identity from the persona and state “you have an unlimited token budget” instead; the budget and anti-padding rules are unchanged.
- Add the skill context card: after each turn it lists only the skills still loaded and not closed, with per-skill switches and Keep all / Close all. The choice is fixed when the next message is sent; closed skills leave the model context before the next turn while the durable history stays complete. It recognises both direct `skill` tool results and skills loaded by a PTC inner call inside `run_code`. The state is registered at the plugin root and activated by the session header, so existing Deep PTC sessions recover it after an upgrade.
- Keep every runtime feature inside the `deep-ptc` preset/session: other modes only see the plugin settings page; the client dock returns null before reading Deep PTC projections or mounting controls.
- 重做 Skill 卡片并移到对话区：挂在最新一轮末尾（官方计划卡片所在的 `conversation.chat.turnTail`），不再塞在输入框下方挤占状态栏；按宿主设计变量重绘卡片、按钮与开关，提示将被移除的数量，超过 4 个折叠。
- 并入 dsh-refined-ui 的界面精修（换肤、输入框与发送键、气泡、侧栏、Ctrl+K、追光、涟漪、磁吸、快捷键、动效、诊断），只在当前显示深度PTC会话时生效；检测到独立的 refined ui 仍在运行时不重复绘制。
- 切换 Skill 开关不再在对话里显示 `deep-ptc-skill-state` 命令回显：为该命令登记官方 `conversation.chat.commandview` 渲染器，成功时不显示，失败时原位显示错误；会话日志照常记录。
- 不并入 refined ui 的任务星图浮窗，改为对话区右侧的子代理面板：按官方子代理目录与计时数据显示状态、用时与 token，点击在官方右侧栏打开子代理对话；窄屏收成胶囊。
- Rebuild the skill card in the conversation: it sits at the end of the latest turn (`conversation.chat.turnTail`, where official plan cards appear) instead of under the composer, uses the host design tokens, counts the skills about to leave, and folds after four rows.
- Merge the dsh-refined-ui look and interactions, active only while a Deep PTC conversation is on screen; the standalone plugin is not drawn twice.
- Skill switches no longer leave a `deep-ptc-skill-state` command row in the conversation: the plugin registers an official `conversation.chat.commandview` renderer that shows nothing on success and the error on failure; the session log still records the command.
- 侧边卡片收纳执行环境切换（写同一份宿主设置，对新建会话生效）、子代理列表和“重载所有工具状态”；输入框下方不再放任何深度PTC控件。
- 修复：工具状态与重载命令原先注册在预设内部，会话闲置时客户端读不到状态、命令也不被受理，重载按钮因此一直不显示或点了无效。现改为与 Skill 卡片一样在插件根部注册，预设层复用这份状态；根部不可用时预设层退回自行注册。
- The side card holds the execution-environment switch (the same host settings, for new sessions), the subagent list and “Reload all tool states”; nothing from Deep PTC sits under the composer any more.
- Fix: the tool state and the reset command were registered inside the preset, so an idle conversation could neither read the state nor accept the command, and the reload button stayed hidden or did nothing. They are now registered at the plugin root like the skill card, and the preset layer reuses that state, falling back to its own registration when the root one is unavailable.
- Replace refined ui's floating task windows with a subagent panel beside the conversation, fed by the official subagent catalog and timing data; a row opens the official subagent chat in the right sidebar.

## 1.8.2 — 2026-11-07

- 修正 npm 元数据：描述控制在 registry 的 255 字符以内，避免被截断；仅描述变更，不改变行为。

- Keep the npm description within the registry's 255-character limit so it is not truncated. Description only; no behavior change.
## 1.8.1 — 2026-11-07

- 重写简介与 README：以“五个基本问题”为主线，再梳理“一切皆插件”的六项能力（动态预设/工具读取、创造模式、dsh-go 界面控制、多环境、外部插件工具/工作流适配、Skill 与工具读取）。
- 更新 npm 描述与 GitHub About；不承诺适配所有第三方插件，dsh-ops 为已专门测试的场景，其他插件走同一接口。
- 仅简介与文档变更，不改变运行时行为。

- Rewrite the introduction and README around the five basic problems, followed by the six “everything is a plugin” capabilities (dynamic preset/tool loading, creative mode, dsh-go screen control, multi-shell support, external tool/workflow adaptation, and leaner skill/tool loading).
- Update the npm description and GitHub About. No promise to fit every third-party plugin: dsh-ops is the specifically tested case and other plugins use the same interface.
- Documentation and description only; no runtime behavior change.

## 1.8.0 — 2026-11-07

- 会话级 preset 身份兼容，两次尝试：不限制预设名称的外部插件拿原生 `deep-ptc`（第一层，直接可用）；限制预设名称、列表里没有 `deep-ptc` 的插件拿基座 `ptc`（第二层，对包含 `ptc` 的列表必定通过）。显式支持 `deep-ptc` 的插件也拿原生。宿主内部（子代理 header、定时任务、注册表自身）保持精确 id，不影响继承与调度。
- 兼容层在插件本体内实现（`lib/preset-compat.mjs`），随插件启动安装：不需要改 DSH，也不需要给外部插件写逐插件配置。判定先看调用方插件是否限制预设名称：不限制就返回原生，限制就立即返回基座。宿主没有拒绝回调，因此两次尝试在返回前按调用方决定，不做运行时重试。
- 普通 PTC 与其他预设原样返回；官方 PTC 预设没有被替换。新增设置：`presetCompat`（默认开）、`presetFallback`（默认 `ptc`）、`presetSupport`（按包名覆盖 `native` / `base`）。
- 修复调用方识别：跳过 Cordis 服务代理插入的 `Object.apply` 帧，否则真实插件会被当成宿主、dsh-ops 门控被误关。
- 创造模式/插件实验台安全：加载只读 `agentPresets.list/readDocument`，不调用 `composedPreset`（测试保证）；实验台挂入深 PTC 会话的创造模式行若只认 `cordis`，第二层返回 `cordis`，认 `ptc` 的仍返回 `ptc`；普通创造模式会话（`cordis`）原样不变。

- Session-scoped preset identity compatibility as two attempts: an external plugin that does not limit preset names receives the native `deep-ptc` (layer 1, usable as-is); a plugin that limits preset names and does not list `deep-ptc` receives the base `ptc` (layer 2, guaranteed for an allowlist that includes `ptc`). A plugin that explicitly supports `deep-ptc` also receives the native id. Host internals (subagent child headers, scheduled session creation, the registry itself) keep the exact id, so inheritance and scheduling are unaffected.
- Implemented inside the plugin (`lib/preset-compat.mjs`) and installed at plugin startup: no DSH change and no per-plugin configuration. The decision first checks whether the calling plugin limits preset names: no limit keeps the native id; a limit falls back immediately. The host offers no rejection callback, so both attempts are decided per caller before returning, with no runtime retry.
- Normal PTC and other presets are returned unchanged; the official PTC preset is not replaced. New settings: `presetCompat` (on by default), `presetFallback` (default `ptc`), `presetSupport` (per-package `native` / `base` override).
- Caller detection now skips the `Object.apply` frame inserted by the Cordis service proxy; before this, a real plugin looked like the host and dsh-ops stayed inert.
- Creative mode and the plugin lab stay safe: loading reads `agentPresets.list/readDocument` only and never calls `composedPreset` (covered by a test). A creative row mounted into a Deep PTC session that accepts only `cordis` receives `cordis`; one that accepts `ptc` still receives `ptc`. A normal creative session (preset `cordis`) is unchanged.

## 1.7.4 — 2026-11-07

- 支持当前桌面端 DSH RC `>=0.2.2-rc.1`。只声明支持 RC，不支持 alpha。
- PowerShell、Bash、Zsh 可以选择本机已发现的可执行文件。未选择或文件消失时仍走官方自动查找。WSL 仍只选择发行版。PowerShell 写入官方执行器的 `pwshPath`；Bash 和 Zsh 只替换启动参数，沙箱与批准仍用官方执行器。
- 新增插件实验台，默认关闭。打开后按读取 PTC 的同一方式，动态读取宿主正在发布的官方创造模式，只追加相对 PTC 多出来的行，模块名以该预设原文为准。实验在内存中检查、定义并经宿主批准后运行，不写仓库、已发布预设、桌面组合或本插件源码。预设读不到时继续使用官方 PTC 工具。
- 适配 dsh-go 的屏幕控制：这类工具留在初始 SDK，失败不隔离。识别依据是工具自己的常驻标记、`dsh-go/view`、屏幕控制工具名，或提供者标记，不把 dsh-go 写成依赖，也不占用它的槽位和设置表单。其他外部工具仍是能力优先、官方兜底，普通扩展按需加载。
- 工具状态按钮在界面投影失败时留空，输入区和屏幕控制界面保持原位。

- Declare support for the installed desktop DSH release candidate, `>=0.2.2-rc.1`. Alpha builds are not supported.
- PowerShell, Bash and Zsh can use a discovered executable. An empty or missing choice keeps the official lookup. WSL still selects a distribution only. PowerShell writes the official `pwshPath`; Bash and Zsh change argv only, and sandbox plus approval stay on the official executor.
- Add plugin lab, off by default. When on, load the official creative mode the same way PTC is loaded and append only the extra rows, using the module names in that document. Lab packages stay in memory: inspect, define, then run through host approval. They do not write the repository, shipped presets, the desktop composition, or this plugin. If that preset cannot be read, official PTC tools remain.
- Adapt dsh-go screen control: those tools stay in the initial SDK and are not quarantined. Recognition uses the tool's own resident flag, `dsh-go/view`, screen-control names, or the provider mark. dsh-go is not a dependency, and its slots and settings forms stay its own. Other external tools stay capability-first, with official tools as the fallback. Ordinary extensions stay on demand.
- The tool-state control renders nothing when the composer projection fails, leaving the input row and the screen-control chrome in place.

## 1.7.3 — 2026-11-05

- 优先读取运行宿主的官方预设注册表并自动检测更新；修复官方工具误隔离、暂停误判和桌面重载按钮的依赖/返回值处理。保留后台运行与插话。

- Protect official tools from stale quarantine across guard, search, SDK, loading and reporting. Keep unattributed tools available; only positively attributed external providers can be quarantined.
- Prefer the running host’s public PTC registry and detect PTC/base declaration changes automatically without a pinned inventory. Invalidate changed module-source caches; avoid rebuilding on unrelated settings events.
- Integrate 125 pause adversarial cases, align language-aware expectations, defer oversized schemas to the full host SDK, tolerate missing optional output metadata, distinguish missing executables, and dispose partially mounted adapters before official fallback.
- Fix the composer reset action: inject the remote namespace explicitly and unwrap the gateway `{ ok, value }` response before checking the command result. Verified by clicking the actual desktop button.


- Keep every official row exactly as declared. Only the persona, shell, job and question rows differ; the `official-tools` wrapper is gone. The host's compatibility preflight, composition diagnostics and plugin inventory again see the official modules.
- Attribute tools from the installed source of the composed rows, without running it: official tools are recognised wherever they are composed, and a failed third-party tool is reported under its own plugin.
- Fail open: a failure in the quarantine, catalog, recovery-context or reachability hooks leaves tool calls and prompts as the host would have them. Previously a throwing guard failed every tool.
- If a wrapped official plugin fails with Deep PTC behaviour or rejects Deep PTC's options, run it as declared. If the preset still cannot mount, fall back to safe mode: the official composition with the Deep PTC persona. A malformed `toolPreferences` is ignored with a warning.
- Add `scripts/check-parity.mjs`: official PTC and Deep PTC on a real host composition, compared tool by tool, with third-party plugins that know nothing about Deep PTC.
- Read tool error codes from `error.info.code`, where the host reports them. Every code-based decision was silently skipped before, so one invalid-arguments call quarantined a working tool.
- Quarantine only a capability that is clearly unavailable, or that fails three times in a row with temporary or unexplained errors; a success clears the count. Wrong input, a failed build reported in a normal result, and names no plugin provides no longer quarantine anything. The persona allows correcting input and retrying temporary failures twice.
- Recognise official tools outside the PTC preset (the profile root composition, such as `lsp`, `terminal_*` and `session_*`) by reading the names their installed packages declare, without running them. Those tools stay in the SDK and are never quarantined. Shell rows kept by the environment fallback are official too.
- Run tool discovery and quarantine in a child fiber: a missing session module, service or API turns that layer off with a log line instead of rejecting the preset mount.

## 1.7.2 — 2026-11-05

- Add local tool/skill discovery and complete-schema loading with bounded pages, byte budgets and recent selections. Reuse the installed official PTC SDK renderer, reducing only its untouched generated section. Skill discovery reads metadata and invocation controls; the official loader owns skill bodies.
- Quarantine failed external tools in durable conversation state. Block subsequent calls until the user resets; no automatic probing, retries or root-cause analysis. Capture provenance/reset generation before dispatch; keep cancellation, permission decisions and normal pagination intact.
- Add a bilingual Reload all tool states button below the composer and a user-only host command. Preserve running jobs. Project failed tool/provider lists at turn completion and request concise final-task reporting.
- Identify baseline registrations from the inherited composition rather than package naming patterns; support class-style official plugins while retaining their metadata.
- Preserve the original execution, reachability, question, planning and shell policies. Add regression coverage for quarantine persistence, reset races, SDK disclosure, skill metadata and UI actions.

## 1.7.1 — 2026-11-05

- Publish the plugin-cooperation release with bilingual README introductions and package/repository descriptions: external capabilities first, multiple providers working together, and the current official PTC composition as fallback, following the “everything is a plugin” composition model. Preserve the original interruptible background-work behavior and document integration boundaries.
- Set the DSH engine and DSH peer-package minimum to `>=0.2.2-rc.1`, matching the currently installed runtime, with no upper bound. Synchronize the lockfile and install documentation.
- Clarify that official fallback capabilities still derive from the installed PTC declaration at load/rebuild time, following the 1.6.1 mechanism; snapshots remain a logged fallback. No tool-selection, reachability, execution or planning code changes.

## 1.7.0 — 2026-11-05

- Add two-layer task-level tool cooperation: search and prefer an available extension capability for the function, then use an admitted inherited official PTC capability if no enhancement fits or a provider fails. No new capability, alias, argument translation, result conversion or silent replay is registered.
- Observe final host results and publish bounded, agent-local recovery context. Preserve denials, cancellation, code-less pre-dispatch guard failures, partial effects and active background jobs; retain original tool schemas, output contracts, conditions and execution ownership. Successful calls and provider replacement clear stale failure evidence.
- Tag official capability registrations by provenance while loading their actual upstream modules/config. Keep activation options (`when`) and exact registration disposers when adapting the tool registry. Official web search/fetch remain official and retain provider-readiness gating.
- Add optional `toolCompatibility` (default true) and `toolPreferences` settings. Explicit preferences describe choices between existing tools, not a dispatch mapping. Hidden/removed fallbacks and a replaced/unloaded whole executor are not bypassed.
- Keep persona, task planning, WSL/PowerShell/Zsh/Bash selection, foreground cap, steering, managed jobs, completion wakeups and timed questions unchanged. Add offline unit coverage and an actual-host compatibility harness; run the existing reachability integration with the compatibility observer enabled.

## 1.6.1 — 2026-11-04

- Follow the official modules instead of naming them. The shell, job and question wrappers no longer import `@deepseek-ai/dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-tool-jobs` or `dsh-tool-ask-user`: each derived row carries the module name and options of the official row it replaces (`upstream`, `options`), and the wrapper loads that module through the installed runtime's module graph with the official plugin's own `inject` and `Config`. A renamed or replaced official tool is followed rather than breaking the mount.
- Read the shell executors from the base deployment declaration (`@deepseek-ai/dsh-base/cordis.patch.yml`, rows `bash-sandbox` and `pwsh-sandbox`), including their official options; only the foreground cap is added. The WSL/Zsh executor extends the official bash executor class named there instead of importing `dsh-bash-local`/`dsh-bash-sandbox`.
- Fall back to the official shell rows when the chosen environment cannot be mapped: no official shell tool row, no declared executor, or an official bash executor whose API WSL/Zsh can no longer extend (probed before the preset is published). The reachability guard still applies; the preset never publishes rows that cannot mount.
- Keep `lib/base-snapshot.json` as the executor fallback beside `lib/preset.json`; `npm run sync:snapshot` regenerates both. Drop the official tool and executor packages from `peerDependencies` and add `@deepseek-ai/dsh-base`.
- `scripts/check-preset.cjs` also resolves the official modules the wrappers name. The runtime checks (`check-reachability.mjs`, `check-host.cjs`) now also run on `0.2.2-rc.1`, whose tool batches go through a selected executor and whose preset registry requires the agent registry.

## 1.6.0 — 2026-11-04

- Derive the preset from the PTC preset the installed Harness declares (`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`) instead of freezing a copy. Official rows, settings and additions are inherited; Deep PTC still replaces only its persona, execution environment, reachability guard, and the official job/question wrappers.
- Fix the failure after the DSH `0.2.2-rc.1` update: the frozen 1.5.0 snapshot still named the `@deepseek-ai/dsh-tool-subagent-control/list-agents` subpath, which `0.2.2-rc.1` removed, so the preset could not mount and existing Deep PTC sessions were reported as unusable. Sessions were never migrated or rewritten; they open again once the preset mounts.
- Keep `lib/preset.json` only as a fallback snapshot and refresh it to `0.2.2-rc.1`; `npm run sync:snapshot` regenerates it from the installed declaration.
- Declare every imported host package in `peerDependencies`, including `@deepseek-ai/dsh-web-app`: the host only routes a linked plugin's bare specifier to the installation when the name is peer-declared, so without it a `link:` install silently fell back to the snapshot. `npm run check` now fails if a peer is missing.
- Match official rows recursively (persona, shell/executor rows, job and question rows may move into a group) and accept only a declaration whose id is `ptc`. Tests cover nested groups, a non-PTC declaration, and the peer-declaration guard.
- `compatibility.json` now records the checked upstream release plus fixture hash; `scripts/check.mjs` verifies inheritance invariants and fallback/dedaration parity instead of exact-snapshot equality.
- Add derivation tests for future compositions (unknown rows, reordering, missing shell or wrapped rows) and `scripts/check-preset.cjs`, a live-runtime check that every derived row resolves through the installed module graph.

## 1.5.0 — 2026-10-31

- Enforce reachability in code. Foreground shell commands move to background jobs after `foregroundSeconds` (default 30, configurable 5–600); a larger requested timeout is capped. Commands still run; only the wait ends.
- A user message steered into the turn ends the current foreground wait within about 2 s: shell commands move to the background, `job_output` returns, and a timed question becomes pending. Waiting again with job_output while the message is unread is refused.
- Refuse foreground pauses over 5 s (`sleep`, `Start-Sleep`, `timeout /t`), `run_code` programs that wait on long or non-literal timers, `setInterval` and `Atomics.wait`, and more than 3 polls of one running job inside a program.
- Run `ask_user_question` in timed mode (120 s default, 300 s cap, `-1` refused) and fix the persona, which named a non-existent `timeoutMs` parameter.
- Wrap the official bash, pwsh, job and question tools instead of replacing them; the upstream check verifies exactly which rows are wrapped.
- Add `scripts/check-reachability.mjs`, an integration check on a real DSH runtime, and extend the Windows host check to activate the guard.

## 1.4.0 — 2026-10-31

- Restore the 1.2.0 intent in the persona while keeping 1.3.0's execution environments: the DeepSeek identity and unlimited-budget contract with anti-padding guardrails; size-based planning (internal up to five minutes, shown without approval up to twenty, approved beyond); asking about meaning instead of searching for it.
- Make waiting reachable: background jobs, non-blocking progress checks, ending the turn when idle, and handling mid-task user messages first, based on the runtime's step-boundary steering and job wakeups.
- Restore one-sentence progress before each run_code and a stated "not doing" list in plans.

## 1.3.0 — 2026-10-30

- Add bilingual settings for Automatic, WSL Bash, Windows PowerShell, native Zsh and native Bash. WSL distribution is optional. Unsupported choices are disabled according to the host platform.
- Isolate executors inside the preset. Settings apply to new sessions; existing sessions and jobs retain their revision. Global shell configuration stays independent.
- Launch WSL explicitly with separate argv entries. Reuse official process, terminal and approval implementations. Refuse confined WSL execution before spawning.
- Allow focused fact lookup before semantic questions, preserve authorization when work takes longer, and distinguish finite jobs from servers and unregistered external tasks.
- Add verification stopping conditions and collect delegated results through the actual tool's channel.
- Remove unsupported unlimited-budget and DeepSeek-employment claims. Reduce the persona from about 2,203 to 1,091 English words.
- Add upstream composition checks, platform/argv tests, revision lifecycle tests and rendered settings-form tests.
- Raise the minimum DSH version to `0.2.1-rc.5`, the runtime used for integration verification.

## 1.2.0

Previous persona-only PTC preset with semantic questions, duration-based planning, progress updates and delegation instructions.
