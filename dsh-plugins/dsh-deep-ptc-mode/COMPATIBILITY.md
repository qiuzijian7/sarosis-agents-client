# 插件协作与验证范围 / Plugin workflows and verification

Deep PTC **1.9.9** 的卡片、宿主执行和预设兼容回归见 [测试报告](TEST_REPORT.md)。下方界面插件和第三方工具协作结果保留当时的验证版本。

For the **1.9.9** card, host execution and preset checks, see the [test report](TEST_REPORT.md). The UI plugin and third-party tool results below retain their original tested versions.

Deep PTC **1.9.5** · 核对日期：2026-11-13（界面插件）；插件协作部分核对于 2026-11-12。接口验证使用 DSH Desktop 0.2.2-rc.2 的校验器与 SDK 渲染器、内嵌 Node 24.21.0。

## 可以配合完成哪些工作

插件需要安装在 Deep PTC 所在的同一运行配置中，并完成各自要求的账号、CLI 或服务设置。下表按实际工作流说明配合方式和已有证据。

| 插件及核对版本 | 在 Deep PTC 任务中的作用 | 验证范围 |
| --- | --- | --- |
| [DrawAI](https://github.com/fourzkw/dsh-drawai) 0.4.6 | 读取和修改画布，在讨论、编码或整理需求时制作流程图与架构图，再导出 SVG 交付 | 实际注册 19 个工具和 2 条内嵌技能；读图→改图→回读、SVG 导出通过。连续旧 revision 拒写后工具仍可用，新 revision 写入通过。浏览器画面、PNG、语音及视频渲染未做端到端验证 |
| [归藏设计](https://github.com/op7418/dsh-guizang-design) 0.1.4 | 按需读取页面、PPT、图文卡片、文案润色与语气技能，并使用作品库和语气工具，把任务内容整理为设计交付物 | 实际注册 2 个工具；5 条技能可列出并读取全文。工具经过 Deep PTC 发现、选用及宿主 SDK 渲染。技能中的脚本、浏览器缩略图和设计生成未做端到端验证 |
| [Agentero](https://github.com/poco-ai/agentero-dsh-plugin) 0.1.8 | 在论文阅读和研究任务中选用论文列表、导入、笔记读取/搜索和 arXiv 发现工具 | host 的实际注册函数提供 5 个工具；参数校验、发现、选用及宿主 SDK 渲染通过。需配置 Agentero CLI 与论文库；未联网导入论文、翻译或执行外部 CLI |
| dsh-ops：实际包验证 0.5.0，源码研究 0.5.4 | 让依赖官方预设 ID 的执行环境在 Deep PTC 会话中识别为 PTC；Niubash 可作为 Windows 原生 Bash 后端 | 既有真实包预设识别路径及 Windows Niubash 命令验证通过，见 [1.9.0 记录](CHANGELOG.md#190--2026-11-11)。本轮未重做其全部业务验证 |
| DSH Go / dsh-go | 保持屏幕控制工具初始可用，配合 Deep PTC 的任务处理；需要 SSH 时可复制主机、端口、用户等连接资料 | 屏幕工具保留规则和资料复制有自动化覆盖。手机连接、认证和隧道由 DSH Go 管理；未连接真实手机或 SSH 主机 |
| [dsh-context](https://github.com/bowenliang123/dsh-context) 0.83.1 | 按当前 Agent 的服务读取 Skill 信息，便于检查 Deep PTC 会话的上下文 | 已核对 `agentPresets.serviceFor(agent, 'skills')` 读取路径。属于源码接口核对，图表和 Token 统计未做实机验证 |

“隔离接口验证”使用已发布包的真实注册函数、工具代码和宿主参数/SDK 实现，其余服务上下文为模拟。它证明所列调用路径可用，不代表插件的全部业务功能已验收。

## DrawAI 的调用方式

选择 Deep PTC 后，DrawAI 仍注册自己的工具和技能。Deep PTC 通过现有通用目录接入，保留完整工具定义。

1. 发现所需画布/视频能力，再选用工具。`diagram_apply` 定义较大时，通过现有完整 SDK 披露机制接入，不截断参数。
2. 修改前调用 `diagram_read`，将返回的 `revision` 交给 `diagram_apply.expectRevision`。DrawAI 的并发保护继续拒绝过旧版本，Deep PTC 将明确的 revision/ETag 冲突归为输入状态过旧，允许重读，不累计工具故障。
3. 交付矢量图时可调用 `diagram_export`，无需打开浏览器画布。该 SVG 是宿主侧的近似重绘，视觉验收仍需浏览器画布。
4. 视频和其他异步任务由 DrawAI 自己的状态工具管理。其任务 ID 不转换成 Harness job ID，也不保证出现在 Deep PTC 后台任务卡片中。
5. `pending`、`not-open`、`timeout` 等正常返回状态不等同于工具实现故障。缺少附件/图像服务的隔离环境返回 `look.status="unsupported"`，读图和改图仍正常。

## SSH 与 DSH Go

SSH 辅助也服务于日常远程命令、文件传输和端口转发。面板可以复制非交互 SSH 检查命令；模型沿用认证失败即停、长任务转后台、隧道显式绑定回环地址的规则。

DSH Go 的连接资料是额外便利：按远端系统选择托管启动或连接已有服务，使用实际服务端口，并在客户端配置认证。复制资料不会发起连接，也不会收集或修改密钥。

## 界面与轻量化

外观重叠时，可关闭 Deep PTC 额外界面特效，必要时收起对话侧边面板。关闭特效不修改其他插件的工具注册与执行方式。

### 界面插件（关闭特效后）

不为其他界面插件单独适配主题。目标是：关闭 Deep PTC 界面特效后，Deep PTC 的胶囊、侧边面板和按钮不变形、不错位。特效关闭时，`body[data-dpt-ui]` 不挂载，所有特效规则和指针、键盘监听都不生效。保留的只有 `.dpt-*` 命名空间内的胶囊、侧边面板（`position:fixed; z-index:20`）和 Skill 卡片。

2026-11-13 按 GitHub `dsh-plugin` 话题的 star 数，选取主要功能为网页界面的前 10 个插件，对 npm/GitHub 发布包做静态核对（未安装、未执行）：

| 插件 | 核对版本 | 关闭特效后的情况 |
| --- | --- | --- |
| DeepSeek-Balance-Whale-Widget | 0.4.2 | 鲸鱼固定在窗口右下角，层级高，会盖住侧边面板底部的按钮。**已处理**：面板正文按重叠高度留出底部空间 |
| dsh-wallpaper-engine | 1.4.2 | 只改背景与玻璃效果，不改 Deep PTC 控件；面板沿用宿主背景变量 |
| dsh-pet | 0.4.8 | 独立 Electron 窗口，不进入网页 DOM |
| DSH-better-sidebar | 0.32.1 | 底部工作台压缩对话列高度；面板按对话区实际尺寸测量，会跟随 |
| dsh-context | 0.84.1 | 使用右侧栏页签与 `conversation.input.overlay`，与 Deep PTC 控件无重叠 |
| dsh-deep-whale（皮肤管理器） | 0.1.9 | 通过宿主变量换肤；面板使用同一组变量 |
| dsh-genui | 0.16.0 | 在回复内渲染组件，并使用 `conversation.input.dock`（输入框上方） |
| dsh-startup-screen | 1.3.0 | 启动遮罩层级 2147483000，高于面板，仅在启动时出现 |
| dsh-ads | 0.1.4 | 弹窗层级高于面板，属该插件的设计 |
| dsh-synapse | 0.5.7 | 画布工作区层级 100/200，高于面板 |
| dsh-claude-style（议题 #16） | 0.21.0 | 输入框收成一行后，胶囊会单独占一行。**已处理**：胶囊移入工具栏槽位 `conversation.input.right`，见下 |

胶囊位置在「设置 → 深度 PTC → 外观」中调整：

- **自动**（默认）：检测到 dsh-claude-style 时放进工具栏，否则放在输入框下方。
- **输入框下方** / **工具栏** / **隐藏**：手动指定。

选择「隐藏」时，右侧栏的新建页签引导会列出「深度 PTC」页签，可从页签里的按钮打开面板。dsh-cost-meter 同样占用 `composer.dock`，两者各占一行，不会重叠。

本版没有为这些插件增加运行时依赖、轮询、固定常驻工具清单或每款插件专属提示词。只有用户选择 Deep PTC 的会话使用其适配逻辑；第三方自身的权限、沙箱和运行条件仍生效。

## 验证与来源

- npm 固定版本发布包经过 SHA-512 校验，仅在忽略目录中解包；第三方安装脚本未执行，也未安装到用户日常 profile。
- DrawAI、归藏设计和 Agentero host 合计 26 个真实工具通过宿主 JSON Schema 校验、Deep PTC 发现/选用及 TypeScript / Python SDK 渲染；7 条技能全文读取通过。
- 在临时工作区复现并发编辑问题：修复前，三次旧 revision 拒写会误隔离 `diagram_apply`；修复后同样三次拒写保持文件不变，工具仍可调用，新 revision 写入通过。临时文件在验证后清理。
- 新增两项错误分类回归。完整 199 项自动化测试通过；缺模块、实现缺陷及明确部分完成仍保持原分类。
- 归藏设计、context 和 Agentero 的推荐来源可追溯到官方 11 月 8 日文章：[原文](https://x.com/DeepSeekHarness/status/2119431663642153128)、[保留原作者与编号的正文镜像](https://threadnavigator.com/thread/2119431663642153128/)。原文在核对时返回 403，正文通过镜像读取。DrawAI 是 fourzkw 的社区项目。本表不代表官方对 Deep PTC 的认证。

## English

Deep PTC 1.9.5 can use DrawAI for diagram editing and SVG delivery, guizang-design for design/writing skills and library tools, and Agentero for paper/note tools. dsh-ops supplies compatible execution environments, DSH Go can combine screen tools with SSH connection assistance, and dsh-context can inspect skills through the current Agent's service.

Twenty-six published DrawAI 0.4.6, guizang-design 0.1.4 and Agentero host 0.1.8 tool definitions passed isolated registration, host 0.2.2-rc.2 schema validation, Deep PTC discovery/selection and both host SDK renderers. Seven skill contents were readable. DrawAI read/edit/readback, SVG export and repeated stale-revision rejection followed by a fresh-revision write passed. The generic conflict-classification fix preserves unavailable-provider, defect and partial-effect handling. All 199 automated tests pass.

With the Deep PTC visual effects off, the ten most-starred web UI plugins on the `dsh-plugin` topic (checked statically on 2026-11-13) leave the capsule, side panel and buttons intact. Two cases are handled: the bottom-right whale widget no longer covers the panel's last controls, and with dsh-claude-style the capsule joins the composer toolbar (`conversation.input.right`) instead of taking its own row (#16). The capsule position (auto, below the composer, toolbar, hidden) is a viewer setting. When the capsule is hidden, the Deep PTC sidebar tab provides the way back to the panel.

The table distinguishes those checks from prior dsh-ops evidence, automated DSH Go rules and source-only context inspection. Browser visuals, design generation, external paper CLI workflows, real phone/SSH connections, PNG and video rendering were not validated end to end. Plugins retain their own setup and authorization requirements. No runtime dependencies, polling or vendor-specific resident tool lists were added.
