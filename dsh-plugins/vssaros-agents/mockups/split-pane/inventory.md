# Bots 工作台（窗口模式）功能清单 —— 供 IDE 拆分对照

> **布局（2026-10-27 定稿）**：三栏 —— **左 sideview（选谁）· 中 chat-surface（会话，宿主组件）· 右 多页签（配谁）**。
> 两个宿主只有容器不同：dsh 侧三栏都在工作台页里；IDE 侧左栏进 sideview、中+右进编辑器区（分左右两组）。
> 中栏**不自己实现聊天**：它是宿主注入的 chat-surface 本体。
>
> **命名统一（2026-10-27）**：原「Agents 工作台（配置面）」与「Bots 入口（对话侧使用面）」
> 合并为一个产品概念 —— **Bots 工作台**。界面文案只用 "bot"；
> `agent` / `preset` 降为内部实现词（代码标识符、`allowedAgentPresets` 字段名等保持不动）。
> 合并后的能力映射：原 Bots 入口的「选 bot → 切人格」变为工作台顶部的 **▶ 在对话里使用**
> （`POST /x/agents/api/persona`，当前会话继续），不再需要两处各选一次。

> 来源：`dsh-plugins/vssaros-agents/lib/client.agents.js`（4226 行，2026-10-23 三栏版）
> 与 `lib/index.js` 的路由/动作。逐条对应源码行号，便于复核。

## A. 布局（三栏 + 工具栏 + 4 页签）

| # | 区域 | 内容 | 源码 |
|---|---|---|---|
| A1 | 工具栏 | `Bots N` · 统计 · 筛选 · ⟳刷新 · 完整页 | L4 |
| A2 | 顶级页签（**4 个**） | ◍名册 / ▤用量 / ⇄委派 / ⚿授权 | L318-321 |
| A3 | 名册·左栏（236px） | 已注册 N / 未注册 N / 群聊 N（可折叠）+ 新建 bot + 新建群聊 | L7-9, L549 |
| A4 | 名册·中栏 | 选 agent ⇒ 该 bot 最近会话 + composer（发送=去完整页开新回合）<br>选群聊 ⇒ 群聊 transcript（只读）+ 群设置 | L12-16 |
| A5 | 名册·右栏（320px） | 5 个子 tab：💬最近会话 / ❐记忆 / ⎇演化 / 🏷版本 / ⑂分支 | L323-329 |

## B. 每个 agent 可编辑的字段（`action:'update'` / `resetModel` / `set-subagent`）

| # | 字段 | 说明 | 源码 |
|---|---|---|---|
| B1 | name / description / role | 欢迎卡与卡片上显示 | L2293 |
| B2 | model | 主模型；`resetModel` 恢复默认 | L2294 |
| B3 | persona | 人设正文（= `.agent.md` 的 body） | L515 |
| B4 | skills[] | 技能白名单（勾选式） | L2698 |
| B5 | suggestions[] | 欢迎卡三条建议词（⚠ 不能含半角逗号） | `agentMdFormat` + `index.js` |
| B6 | memory-chars / memory-mode | 注入 MEMORY 的字符数（session/live 冻结策略） | L1104 |
| B7 | subagent 开关 | 别的 agent 能否点名派活给它 | L2342 |
| B8 | allowedAgentPresets | 它可以派给哪些 agent | L511 |

## C. 群聊

| # | 功能 | 说明 | 源码 |
|---|---|---|---|
| C1 | 新建群聊 | name + mode(`open`/`group`/`all`) + members[] | L638, L652 |
| C2 | 群设置·模式 | 新会话绑到本群 / 清掉该成员其它群绑定 | L1640-1651 |
| C3 | 群设置·成员策略 | 每成员 `mode`（policy action） | L3211 |
| C4 | 邀请成员 | `invite` action | `index.js` |
| C5 | 群聊 transcript | 只读；发消息要开完整页 | L16 |

## D. 记忆（右栏 ❐记忆 子 tab）

| # | 功能 | 说明 | 源码 |
|---|---|---|---|
| D1 | 读 MEMORY.md | 文件内容 + Git 历史 + diff | L21 |
| D2 | 追加条目 | `write-memory`（从条目库勾选 → 追加） | L1036 |
| D3 | 提交快照 | 记一个版本（版本/分支页签的数据源） | L1036 |
| D4 | 演化 / 版本 / 分支 | 数据来自 `/api/memory`；tag/分支接口**插件没暴露** ⇒ 如实写"在完整页" | L17, L493 |

## E. 全局页签（不针对单个 agent）

| # | 页签 | 内容 | 源码 |
|---|---|---|---|
| E1 | ▤用量 | 每 preset 的 sessions / tokens / turns / lastActive | L21, `/usage` |
| E2 | ⇄委派 | assignments（谁派给谁） | `/assignments` |
| E3 | ⚿授权 | 审批模板（N 个）+ 发件箱 outbox（N 条，带状态徽章） | L2271-2281 |
| E4 | 会话桥 | 「最近会话」点了要打开**那条**会话（桥 v19 `preload-dshView`） | L228, L267, L375 |

## F. 后端动作（15 个 POST action）

```
create  update  rename  delete  resetModel  set-subagent
session  mode    policy  invite   remove     message
dispatch  credentials  write-memory
```

## G. 路由（12 条）

```
/x/agents/api/{home, agents, groups, group-file, live, memory, agentmemory,
                usage, assignments, approval-templates, outbox, prompt,
                bindings, session, session-rename, cancel, page}
```

## H. 已知诚实边界（窗口版自己写明的）

- 会话回合只能在 dsh 客户端跑 ⇒ IDE 侧同样**不做假 chat**，只给"打开完整页/在会话页继续"。
- 版本/分支的 tag 接口未暴露 ⇒ 显示"在完整页"。
- 群聊发消息同理。

---

---

# 附：方案 C（IDE 内嵌 dsh 的 UI）调研结论（2026-10-27）

**结论：C 不但可行，而且已经实现了大半 —— 我此前“跨运行时 + CSP 双份”的判断是错的。**

## 已有三条通道（都在仓库里，非设想）

| # | 通道 | 证据 | 现状 |
|---|---|---|---|
| ① | **插件自托管页**（`view.kind=page`） | `dshModuleContainers.ts:317 { module:'agents', kind:'page', route:'/x/agents/' }`；`dshPluginPageEditorInput/Pane` | ✅ 已登记 |
| ② | **`?surface=` 分流** | `index.js:2176` 按 `surface=sideview` 选 `renderSideviewPage`；`sideview.js`（798 行）摘要版、`detail.js`（1702 行）完整页 | ✅ 两版都有 |
| ③ | **dsh 聊天实例承载** | `dshChatInstanceHost.ts`：`surface=chat` 的 WebContentsView 放进 `NativeChatEditorPane`，视图 id 按 chatId 稳定，会话绑定走 `session.start` | ✅ 已有 |

另：`dshViewHost` 用 `<origin><route>` + token 交换（`authUrl` 形如 `http://127.0.0.1:PORT/?token=…`），并带主题桥 / 有界重试 / 导航白名单 —— 承载面不需要我们重写。

## 三种落地形态

| 形态 | 做法 | 改造量 | 满足三栏 |
|---|---|---|---|
| **C1 复用现状** | 侧栏 `?surface=sideview` + 编辑区完整页 | **0**（已实现） | ✗ 两栏，无独立会话中栏 |
| **C2 拆 pane**（推荐） | 编辑区拆两个 page 视图：`?pane=config`；中栏用 `NativeChatEditorPane(engine=dsh)` 绑该 bot；侧栏仍是 sideview | 中：dsh 加一个 query 分支 + IDE 注册一个输入 | ✓ |
| **C3 整页三栏** | `detail.js` 自己变三栏（含 conversation），IDE 只开一个 page | 大：page 表面拿不到 `props.conversation`，只能像 agents 面板那样自己嵌 chat | ✓ 但左侧栏空转 |

## C 的取舍

- **收益**：零 UI 重复 —— dsh / 侧栏 / 编辑区三处同一份 `sideview.js` / `detail.js`；改文案不用改三遍；mockup 里的 kit/block 都不必实现。
- **代价**：① 每个 pane 变体都是一次 HTTP 页面（改一次要重编译/装插件/清缓存）；② IDE 侧编辑体验受限于 dsh 页面（用不上 IDE 命令面板/编辑器服务）；③ pane 组合是 URL 约定，类型不安全。
- **与 A/B 对比**：A（IDE 自绘）灵活可单测但要维护两套；B 是中间态；C 一份 UI 全生效。

## 待真机确认的一处

C2 的中栏要求 `NativeChatEditorPane(engine=dsh)` 能**先切人格再开会话**（`POST /x/agents/api/persona` → `session.start`）。`dshChatInstanceHost.ts` 头部写「换人格是另一条路，在当前会话内继续」，逻辑上成立，但**没有真机验证过"新会话直接用该 bot 人格"**。

---

# 对照：这些功能在 IDE 拆分后落在哪

| 窗口位置 | IDE split 落位 | 理由 |
|---|---|---|
| A3 名册左栏 | **sideview 左栏**（列表 + 分组 + 搜索 + 新建） | 与 kb 一致：左栏只做"选谁" |
| B1~B5（名称/描述/角色/模型/人设/技能/建议词） | **editorpane · 详情页签** | 针对单个 agent 的编辑 |
| B6~B8（记忆参数/委派开关/白名单集合） | **editorpane · 「记忆」「委派」页签** | 选项类，低频 |
| C1~C5 群聊 | **editorpane · 群聊详情**（选中群聊时切换） | 群也是"一个对象" |
| D1~D4 记忆/演化/版本/分支 | **editorpane · 「记忆」「版本」页签** | 针对单个 agent |
| E1~E3 用量/委派/授权 | **独立的编辑器 Tab**（全局，不是 agent 详情） | 不针对单个 agent，塞进详情会误导 |
| A1 工具栏（Bots/统计/筛选/刷新） | 侧栏顶部（计数 + 刷新 + 筛选） | 全局操作留在左栏 |
| A4 中栏会话 | 不搬（打不开真实会话）⇒ 详情里给「最近会话列表 + 在会话页继续」 | 不做假 chat |
