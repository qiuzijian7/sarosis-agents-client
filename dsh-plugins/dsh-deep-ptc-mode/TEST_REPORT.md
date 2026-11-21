# Deep PTC 测试报告 / Test report

## 2.3.0 · 2026-11-20

- Windows、Node 24，306 项自动化测试通过，`npm run check` 通过。新增测试覆盖环境复制（不含会话与记忆）、残留目录清理、启动参数、桌面版 CLI 查找、侧栏命令、`virtual_dsh` 工具与审批（每个对话一次）、状态推送和对话记录摘要。
- DSH 桌面版 0.2.2-rc.5：用户从侧栏启动虚拟 DSH，插件、Skill 与设置和真实环境一致；停止按钮确实结束进程，再次启动得到全新实例。模型操作虚拟 DSH 的功能由用户试用，未发现问题。
- 通过 Web API 在未登录的虚拟 DSH 中发起对话：会话创建、消息送达和事件读取正常，该轮以模型请求错误结束，符合预期。新侧栏布局在桌面版中截图核对。

- Windows, Node 24: 306 automated tests and `npm run check` pass. New tests cover environment mirroring without sessions or memory, sweeping leftovers, launcher arguments, desktop CLI lookup, the panel command, the `virtual_dsh` tool with one approval per conversation, status pushes and transcript summaries.
- DSH desktop 0.2.2-rc.5: the user started the virtual DSH from the side panel with the same plugins, skills and settings; Stop ended it and a new start was fresh. The user also tried the model-driven controls without finding problems.
- A test conversation through the Web API in a signed-out virtual DSH created the session, delivered the message and read the events; the turn ended with the expected model request error. The compact panel was checked in the desktop app.

## 2.2.0 · 2026-11-20

- Windows、Node 24，296 项自动化测试通过。客户端构建一致性和 10 种环境组合通过检查。
- 真实 DSH 0.2.2-rc.1 分别以普通深度 PTC 和深度创造模式加载。六篇新增 Skill 的正文和示例可读取，创造工具按开关挂载。
- 两个独立 Web 预览并行运行，一个测试插件使所在进程以退出码 37 终止后，另一实例仍返回 HTTP 200。Chrome 加载了打包插件的客户端。
- 科学图表生成器的 SVG、CSV 和结果卡片使用同一组数据；办公生成器的 Excel 与 Word 汇总值一致。前端示例在 Chrome 验证了延迟响应、错误恢复和窄屏布局。此次验证未测真实模型的汇报频率。

## 2.1.0 · 2026-11-19

Windows、Node 24 与 DSH 桌面版 0.2.2-rc.5（deepseek-flash），285 项自动化测试通过，`npm run check` 通过。

| 场景 | 观察 |
| --- | --- |
| 杂乱的出行请求（目标、约束、验收与客套话混在一条） | 模型在作答前主动整理出 9 条，覆盖 10/10 段；对「1500 是否两人合计」记为推断，并在回答里说明这个假设。 |
| 确认并精简后追问 | 会话日志中原话节点被 `replace` 为替身，原事件保留；后续回答仍遵守预算和饮食约束。 |
| 防偷懒提醒 | 模型首次调用出错、尚未整理时触发一次提醒。 |
| 提问卡回答 | 模型收到 `[Card answer: …]` 加 `city = philadelphia «费城»` 的结构化消息；聊天显示为一行。 |
| 工具参数 | 修复前 `ask_user` 等工具在 SDK 中为 `unknown`，一次提问卡花 2 分 31 秒试参数；修复后首次调用成功。 |
| 缓存 | 任务卡改走上下文快照前后，同一对话每次更新的未缓存输入：18,769 / 18,389 / 18,477 → 2,635 / 647 / 597；第 1 轮结束时上下文 69.4k → 32.7k。精简原话会让其后的前缀重算一次（本例 12,490）。 |

以上为单次实测个例，不代表模型稳定的成功率。

- Windows, Node 24, DSH desktop 0.2.2-rc.5 (deepseek-flash): 285 automated tests and `npm run check` pass.
- Live: the model filed a scattered request before answering (10/10 clauses covered), condensing replaced the message node while keeping the original event, card answers arrived in the structured form, the card tools' arguments are typed again, and moving the brief into the context snapshot cut uncached input per update from about 18,500 to 600–2,600 tokens. Single observed runs, not a success-rate evaluation.

## 2.0.0 · 2026-11-18

Windows、Node 24 与 DSH 0.2.2-rc.1，263 项自动化测试通过。隔离宿主验证了面板子代理提问、接收回答、提交提案及面板审批，也验证了 PowerShell、WSL、受限调用拒绝、第三方工具替换和预设降级。

通过 DSH 的 deepseek-account 路由使用 deepseek-flash（high）运行临时项目。以下为个例观察。汇报间隔按宿主提交助手消息的时间计量，包含工具等待，不代表流式界面首字延迟。

| 场景 | 观察 |
| --- | --- |
| 空设定项目 | 模型主动提问并生成带选项的仓库诊断卡；首问涉及当前任务方向，用户未回答，未产生获批设定。 |
| 排查空输入错误 | 一次运行有 6 条可见助手消息，最长记录间隔约 12.7 秒。实际验证空输入与普通输入并生成结果表。 |
| 三个版本的延迟 | 实际展示 48、35、29 ms，使用指标、条形图和表格，指出 v3 最快。 |
| 格式选择 | 早期运行使用宿主提问工具，在无人回答时等待约 120 秒。补充非阻塞卡片调用示例后，同一问题复测生成两按钮选择卡，约 24 秒交回控制。该次 4 次工具调用仅有最后一条可见文字，汇报提醒仍依赖模型执行。 |
| 修改已有功能 | 在修复空数组之前引用 F1，并在同一张结果卡汇总新行为和非空均值的回归验证。个别首条汇报使用英文。 |

复测入口为 `node scripts/check-parity.mjs live`，需设置 `PTC_RUNTIME_MODULES` 并有可用的 DSH 登录。可附加 setup、investigation、display、choice、regression 仅运行选定场景。每次生成新的临时工作区和结果 JSON。

## 1.9.9 · 2026-11-17

- Windows、Node 24.18.0：258 项自动化测试通过。验证过期卡片按钮、卡片设置关闭、项目文件外部修改、保留 Markdown 和未提交草稿、按需 Skill 样板及预设恢复。
- 实际 DSH 0.2.2-rc.1（隔离配置）：从卡片入口执行真实 PowerShell 和 WSL Bash 命令，验证宿主策略拒绝以及受限 WSL 拒绝。通过项目卡片命令创建设定、调用工具提出修改，再从宿主命令审批。核对工具作用域、预设声明更新、兼容降级与第三方工具按需加载。工具替换覆盖 Shell、非 Shell 工具、宿主继承与后加载的模拟提供者。
- 界面交互由客户端组件测试覆盖。上述宿主测试无需模型调用。此轮未验证 macOS 或 Linux 的原生桌面交互，也未评估提示词改写对模型任务成功率的影响。

- Windows, Node 24.18.0: 258 automated tests passed. Coverage includes stale buttons, the conversation-card switch, external file edits, Markdown and draft preservation, on-demand skill examples, and preset recovery.
- Installed DSH 0.2.2-rc.1 (isolated profiles): card commands ran in PowerShell and WSL Bash, honored host policy, and refused confined WSL execution. Host commands and the project tool covered settings creation, proposal and approval. Composition checks covered tool scope, upstream refresh, fallback and on-demand external tools. Tool overrides covered a shell, a non-shell tool, inherited registrations and a stand-in provider loaded later.
- Client behavior was verified with component tests; host checks required no model calls. Native macOS/Linux desktop interaction and model task success after the prompt rewrite were outside this run.

## 历史记录 / Earlier releases

> 1.9.5 启动与特效性能：210 项自动化测试及结构检查通过。新增覆盖：宿主服务永不就绪时 apply() 立即返回；预设仍在后台发布；深度 PTC 的 resolve 会等到首次发布完成，其他预设不等待；两个深度 PTC 会话之间切换时特效属性不被摘除；特效样式不包含宿主配色变量、字体、全站控件规则或通配元素规则。在本地 DSH 0.2.2-rc.1 测试 profile 中：启动正常，预设注册；开启特效时宿主变量（背景、文字、字体）与关闭时一致；4 个深度 PTC 会话之间切换，特效属性翻转 0 次。浏览器窗格处于隐藏状态，页面不渲染，因此未测量切换耗时。
> Version 1.9.5 startup and effects performance: 210 tests and structural checks pass. New coverage: apply() returns at once when host services never become ready; the preset still publishes in the background; a Deep PTC resolve waits for the first publication while other presets do not; switching between two Deep PTC conversations never removes the effects attribute; the effects stylesheet contains no host colour tokens, fonts, page-wide control rules or universal rules. In a local DSH 0.2.2-rc.1 test profile, boot succeeded and the preset registered; host background, label and font variables were identical with effects on and off; moving among four Deep PTC conversations flipped the effects attribute 0 times. The browser pane was hidden, so the page did not render and switch timing was not measured.

> 1.9.4 胶囊位置与面板宽度：205 项自动化测试及结构检查通过。新增覆盖：默认位置、dsh-claude-style 下胶囊移入工具栏且两处胶囊控制同一面板、隐藏后右侧栏引导出现并可打开面板、位置偏好持久化、左边缘拖动/方向键/双击调整宽度及上下限、右下角挂件留白。在本地 DSH 0.2.2-rc.1 测试 profile 中实测：拖动后面板由 280px 变为 482px，对话区边距同步，宽度被记住；用 claude-style 的页面标记模拟时，胶囊与模型选择器、发送按钮同处一行；窄屏浮动面板保留拖动边缘；客户端无本插件报错。未与 dsh-claude-style、dsh-whale-widget 实际同装运行；10 个界面插件为发布包静态核对，见 [协作说明](COMPATIBILITY.md)。
> Version 1.9.4 capsule position and panel width: 205 tests and structural checks pass, covering default placement, the toolbar capsule beside dsh-claude-style controlling the same panel, the sidebar guide entry when hidden, remembered placement, edge drag/keys/double-click resizing with bounds, and the corner-widget inset. In a local DSH 0.2.2-rc.1 test profile, dragging widened the panel from 280px to 482px with the conversation margin following and the width remembered; with dsh-claude-style's page marker simulated, the capsule shared the toolbar row with the model selector and send button; the floating panel kept its resize edge; no client errors from this plugin. dsh-claude-style and dsh-whale-widget were not installed alongside; the ten UI plugins were reviewed statically from their published packages.

> 1.9.3 界面调整：201 项自动化测试及结构检查通过。输出文件按钮覆盖普通/折叠列表、所属会话、相对/Windows/UNC 路径、中文及特殊字符、旧版预览接口和打开失败后的恢复。另使用真实 DSH Desktop 0.2.2-rc.2 文件地址解析器确认四类路径可由当前面板的打开函数正确还原。子代理行保留状态指示与辅助阅读标签，可见内容仅为名称和同一行右侧的用时。未做整窗目视验收。
> Version 1.9.3 UI changes: 201 tests and structural checks pass. Output-opening coverage includes folded entries, owning sessions, path encodings, the older viewer API and failure recovery. The actual DSH Desktop 0.2.2-rc.2 file-address parser correctly decodes four path cases generated by the current panel opener. Subagent rows retain indicators and accessible state labels, with only the name and right-aligned duration visible. No full-window visual review was performed.

> 2026-11-12 插件协作验证：已发布包的实际注册代码在隔离服务上下文中注册 DrawAI 0.4.6 的 19 个工具、归藏设计 0.1.4 的 2 个工具和 Agentero host 0.1.8 的 5 个工具。使用桌面宿主 0.2.2-rc.2 的实际参数校验器及 TypeScript / Python SDK 渲染器，26 个工具的发现和选用路径通过。7 条技能全文读取通过；DrawAI 临时文件的读→改→回读、SVG 导出及旧 revision 拒写通过。修复前连续三次旧 revision 拒写会误隔离改图工具；通用分类修复后文件保持不变、工具仍可用，最新 revision 写入通过。新增两项回归测试，全部 199 项通过。context 为源码接口核对。完整来源、版本和未验证项目见 [协作说明](COMPATIBILITY.md)。未做浏览器/模型/外部 CLI/视频端到端验证。
> Plugin workflow verification: 26 actual published tool definitions passed isolated registration, host 0.2.2-rc.2 schema validation, Deep PTC selection and both host SDK renderers. Seven skill contents, DrawAI read/edit/readback and SVG export passed. Three stale-revision rejections reproduced incorrect quarantine before the generic conflict-classification fix; afterwards safe rejection and a fresh-revision write passed. All 199 tests pass, including two new regressions. Context received source review. See the linked report for versions and limits; no browser, model, external CLI or video end-to-end test was performed.

> 2026-11-12 的本地修订通过 197 项自动化测试。新增覆盖独立侧边面板的收起、缩放和原生侧栏全屏避让，空白会话选择 Deep PTC 后的工具门禁与 Skill 投影，以及通用 SSH / DSH Go 资料复制。本机 DSH Desktop 0.2.2-rc.2 的实际选择方法允许空白会话切换，并拒绝首轮已开始后的切换。新布局尚未做整窗目视验证，也未连接真实 SSH 主机或手机。
> The local revision on 2026-11-12 passes 197 tests, including side-panel collapse, resizing and fullscreen avoidance, command gates and skill state after blank-session selection, and SSH / DSH Go information copying. The installed DSH Desktop 0.2.2-rc.2 selection method accepts blank-session changes and refuses them once a turn has started. The new layout has no full-window visual check, and no real SSH host or phone was connected.

> 1.9.0 在 Windows 和 Node 24 上通过 191 项自动化测试，新增输出文件与 SSH 记录、应用商店 PowerShell 识别、安全模式判定、右侧栏页签和设置页。另在隔离的测试 profile 中启动 DSH 0.2.2-rc.1 Web 界面实测：设置左导航只有一个「Agent 预设」并新增「深度 PTC」页；模式选择器显示本地化名称与当前环境；右侧栏引导页列出「深度 PTC」，页签内容完整；胶囊位于输入区停靠位，点击可展开已收起的右侧栏；右侧栏全屏时胶囊被遮住，不再悬浮；客户端无本插件报错。未在测试中发送消息，因此输出文件与 SSH 记录的实际写入只由自动化测试覆盖。下方保留 1.7.3 的桌面实测记录。
> Version 1.9.0 passes 191 automated tests on Windows and Node 24, adding output-file and SSH activity, Microsoft Store PowerShell discovery, safe-mode diagnosis, the right sidebar tab and the settings page. A DSH 0.2.2-rc.1 Web UI run in an isolated test profile confirmed one Agent presets entry plus the new Deep PTC page in settings, the localized preset label with its environment, the Deep PTC tab on the right sidebar guide with complete content, the capsule in the composer dock opening a collapsed sidebar, the capsule covered rather than floating over a fullscreen sidebar, and no client errors from this plugin. No message was sent, so recorded outputs and SSH activity are covered by automated tests only. The desktop audits below document 1.7.3.

日期 / Date: 2026-11-05。测试宿主：Windows 桌面 DSH 0.2.2-rc.1 + WSL Ubuntu、Node 24。此版本是测试样本，运行时不据此固定工具清单。

## 中文

本版修复官方工具被旧隔离记录误拦、工具来源缓存不更新、暂停检测误判、缺失可执行程序误分类、大 schema 无法加载、适配失败后残留部分注册，以及重载按钮依赖缺失和网关返回结构处理错误。官方预设优先从运行宿主公开注册表读取，接口不可用时查找实际安装声明；仅最终兜底使用快照并告警。声明变化自动更新新预设，不强切换旧会话。

| 检查 | 汇总结果 |
| --- | --- |
| 自动化回归 | 77 项全通过；暂停检测另含 125 条断言用例，0 不符 |
| 官方适配 | 隔离宿主实际提供的 28 个官方工具身份、参数和可见性对照通过；官方工具不隔离，来源不明工具保留可用 |
| 动态更新 | 运行中改变官方声明，新增能力自动进入新预设；旧作用域保持不变。公开注册表变更与来源缓存刷新测试通过 |
| 降级与协作 | 可选模块/服务缺失、外部插件故障、自身适配失败时，官方 PTC 保持可用；部分注册回滚、大 schema 完整披露通过 |
| 桌面实测 A | 日志记录 43 次调用、19 种工具（含目录入口）。文件、图片、搜索、shell、job、联网和目标工具正常；4 次有意读取不存在文件失败后，官方 read 仍正常 |
| 桌面实测 B | 普通 subagent、fork、代理列表、限时提问正常；自有 WSL job 取消后 Linux PID 已消失。对子代理 UUID 使用 teammate 通信接口不满足前置条件，按此记录，不归因插件故障 |
| 真实插话 | 自动在真实命令开始约 1 秒后发送消息，调用约 2 秒后返回后台 job，原命令继续并完成；区别于伪造事件的单元测试 |
| 重载按钮 | 实际桌面点击成功，界面和会话命令日志均确认；不触发模型调用、不终止后台任务 |
| 打包 | 干净目录中在宿主依赖图下加载通过；交接文档与原始审计数据不进入发行包 |

边界：静态暂停检测不是完整语言解释器，未知时长放行；任意 `run_code`、同步子进程和长 workflow 内部等待不能保证被插话提前结束，应使用受管理的后台任务。`wsl -- sleep 20` 的实际暂停仍被拒绝。实际桌面未提供 workflow；未为测试创建真实定时任务/工作树，未在 macOS 真机执行。报告不宣称穷尽所有 bug 或全部第三方插件组合。

## English

The release fixes stale official-tool quarantine, source-cache refresh, false pause detection, missing-executable classification, oversized schema disclosure, partial registration rollback, and the composer's reset dependency/response handling. It prefers the running host's public PTC registry, discovers installed declarations as fallback, and warns before using a bundled snapshot. Changed declarations refresh new generations without switching leased sessions.

77 regression tests pass, including a 125-case pause table. Actual-host comparison covers the 28 official capabilities and their identity, schema and visibility. Missing optional services, incompatible plugins and adapter failures preserve official operation. Live declaration changes and registration rollback pass.

Desktop audit A records 43 calls across 19 tool names, including the directory; four intentional missing-file reads do not disable official read. File/image/search/shell/job/web/goal operations succeed. Audit B covers subagents, fork, lists and timed questions; cancelling the owned WSL job removes its Linux PID. Teammate-only communication with a subagent UUID is recorded as an unmet precondition, not a plugin defect.

A real interjection sent about one second after command start releases its foreground wait about two seconds later; the job continues and completes. The actual composer reset button and command log both confirm success. Clean-package loading passes; private handoffs and raw session logs are excluded.

Limits: static pause detection is not a full interpreter; unresolved waits pass through. Arbitrary run_code/synchronous/workflow waits cannot guarantee early steering. Use managed jobs. The real `wsl -- sleep 20` pause remains blocked. No workflow was exposed in the desktop session; live schedules/worktrees and native macOS were not exercised. This is bounded coverage, not a universal defect-free claim.
