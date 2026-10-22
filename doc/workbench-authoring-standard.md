# 工作台制作规范（Pane × 承载容器）v1.0

- 状态：草案（2026-10-21，随稿 A 定稿）
- 适用：`dsh-plugins/vssaros-*` 里所有带页面的工作台（知识库 / 记忆库 / 代码库 / 媒体库 / 看板 / 工作流 / 主页 / Agents / 会话 / 定时任务 …）
- 配套稿：`doc/dsh-workbench-layout-v2-mockup.html`（稿 A = 侧栏单行入口 + 整页工作台中心 + 右栏承载）
- 不适用：纯工具型插件（`kind: 'none'`，如 `web-content-import`）—— 它们没有页面

---

## 0. 一句话

**一份内容、两个 Pane、四种容器。**
Pane 不知道自己被谁装着；容器只负责给尺寸和边框；`?surface=` 决定这一份页面此刻该画哪一半。

---

## 1. 三层模型

| 层 | 是什么 | 谁拥有 | 不许做什么 |
|---|---|---|---|
| **Pane** | 内容单元：`catalog`（目录页）/ `core`（核心页） | 插件页自己（`/x/<module>/`） | 不许假设自己被放在左边还是右边 |
| **Surface** | 承载参数：`sideview` / `editor` / 缺省（完整页） | 宿主注入 `?surface=` | 不许用 UA / 窗口尺寸猜 |
| **Host** | 画容器的人：dsh 官方页（`main` / 右侧栏）/ VsSaros（sideview / EditorPane） | 平台 | 不许渲染业务内容，只给矩形 + 主题 |

**Pane 划分只认两个**（第三个 `detail` 只有在 core 里确实要"选中项详情"时才拆，且默认不拆）：

- `catalog` = **目录页**：列出这个工作台里有什么，负责"选哪个"。
- `core` = **核心页**：选中之后真正干活的那个视图（校核结果 / 看板列 / 图谱 / 编辑器主体）。

> 判据：**把 catalog 内容放进 core 里，会不会挤掉主视图？** 会 ⇒ 拆成 catalog。不会 ⇒ 别拆（多一个 Pane 就多一套状态同步）。

---

## 2. 承载矩阵（本规范的主表）

| 模式 | Host | 容器 | 装什么 | 关键实现 |
|---|---|---|---|---|
| **dsh 窗口（全窗）** | dsh 官方 Web Client | 中栏 `main`（keyed，key = `vssaros-wb-<id>`） | **core** | `ctx.layout.selectPanel('vssaros-wb-<id>')`；点侧栏「🗂 工作台」行 → 先落**工作台中心** |
| | | 右侧栏 `sidebar.right.pane.tab`（key = `<id>-catalog`） | **catalog** | `ctx.sidebarRightTabs.register({ id, kind: '<id>-catalog', title })` + `sidebarRight.openTab(...)` |
| **dsh 窗口（聊天框）** | 同上（`DSH_CHAT_ONLY_CSS` 只裁左栏） | 右侧栏（唯一可用） | **catalog + core 两个页签**（core 默认激活） | 降级形态，见 §2.2 |
| **IDE（sideview）** | VsSaros | 活动栏容器 → sideview 视图 | **catalog** | `pageSurface='sideview'` ⇒ URL 追加 `?surface=sideview` |
| **IDE（编辑区）** | VsSaros | `DshPluginPageEditorPane` | **core** | `pageSurface='editor'` ⇒ `?surface=editor`；由 sideview 调 `bridge.openModulePage(route)` 打开 |

### 2.1 dsh 窗口的三态

| 态 | 中栏 | 右栏 | 入口 |
|---|---|---|---|
| `idle` | 会话（官方 conversation） | 上次的页签（可空） | 默认 |
| `launcher` | **工作台中心**（全部工作台卡片 / Tab / 搜索） | 保持不变 | 点侧栏「🗂 工作台」行 |
| `active(<id>, <sel>)` | **core**（该工作台） | **catalog**（该工作台） | 中心页点卡片 / 右栏历史 |

- 「工作台中心」是**一个 Pane**（`launcher`），不是某个工作台的 core；它注册在 `main` 的 key `vssaros-workbench` 上（现成）。
- 切工作台 = 换 `main` 的 key + 换右栏 tab kind；**不新开右栏页签堆叠**（右栏同时最多两个：catalog + 临时页）。

### 2.2 聊天框降级（必须实现，不是可选）

聊天框左栏被裁 ⇒ 没有「工作台」行入口，中栏是会话 ⇒ **只能右栏**：

- 右栏注册两个页签：`<id>-catalog`（目录）与 `<id>-core`（核心），core 优先激活。
- 目录项点击 = 在**同一右栏**里切到 core 页签并带上选中项（不打开新窗口）。
- 宽度按 320–420 设计（见 §5）。
- 验收要求：**不能出现"有入口、点开空白"**，也不能出现"入口根本不出现"（侧栏被裁时应有替代入口，见 §7.3）。

---

## 3. Pane 内容边界

### 3.1 catalog（目录页）

必须有：

- 搜索（本地过滤即可，别为此新开接口）
- 分组 / 过滤 / 排序（沿用 `vssaros.wbNav.order` / `pinned` 的同一套口径）
- 每个条目的：图标、名称、**状态徽标**（条数 / 运行中 / 有更新）、**选中态**
- 空态（"这个工作台还没有内容" + 一个创建动作）

禁止：

- 业务主视图（宽表格、大图、编辑器、图谱画布）—— 那是 core
- 横向滚动（窄容器里必须一列到底，长标题省略 + tooltip）
- 自己发起写操作后不刷新 core（写必须通知 core，见 §5.3）

### 3.2 core（核心页）

必须有：

- 页头：标题 + 面包屑（工作台 › 选中项）+ 该视图的操作按钮
- **可独立打开**：直接访问 `/x/<module>/?surface=editor&sel=<id>` 就能完整工作（不依赖 catalog 的 DOM 存在）
- 三态：`未选择`（引导文案，不是空白）/ `加载中` / `错误`（带重试，且写明失败原因）
- 只读提示：只读能力（如媒体库）必须在页头明说，不要等用户点了才报错

禁止：

- 放导航树 / 条目清单（那是 catalog）
- 依赖"我是中栏"来做样式（高度、圆角、左右边框都由容器给）

---

## 4. 渲染契约（同一份代码怎么长出两种形态）

### 4.1 URL

```
/x/<module>/                    → 完整页（dsh main 面板 / 浏览器直开 / 探针）
/x/<module>/?surface=sideview   → catalog 版
/x/<module>/?surface=editor     → core 版
/x/<module>/?surface=editor&sel=<id>   → core 版并定位到某个条目（可选）
```

规则：

- **只登记一条路由**。`validatePluginRoute()` 明确拒绝查询串（`dshPluginPage.ts:27-53`），索引用查询串而不是子路由；`DSH_MODULE_PAGES` 只认整条路由，子路由不登记（`dshHarness.contribution.ts:1461` 已写死这条）。
- 缺省（无 `surface`）**永远渲染"完整可用"的那一版**，且必须包含 catalog + core 两半（探针走无参数 URL，见 `vssaros-dashboard/lib/index.js:801-812` 的先例）。
- `surface` 是**建议不是命令**：页面拿到不认识的 surface 值时按完整页渲染（`vssaros-dashboard/lib/sideview.js:31` 的原话：「页面不该把自己钉在某个表面参数上」）。

### 4.2 组合方式

```js
// 一个 router，三个出口，共用同一份数据加载
const surface = url.searchParams.get('surface');
const data = await collect();            // ← 只取一次，两个 Pane 共用
if (surface === 'sideview') html = renderCatalogShell(data); // catalog 单栏
else if (surface === 'editor') html = renderCoreShell(data, sel);
else html = renderFullShell(data, sel);  // catalog | core 双栏（完整页）
```

- **一份数据获取**，三个壳。禁止为 sideview 单独写一套取数逻辑（两份取数 = 两份口径，必有偏差）。
- 共享组件放 `lib/views/<module>/{catalog.js,core.js,shell.js}`；`lib/index.js` 只做路由 + 取数 + 组装。

### 4.3 尺寸自适应

- 用**容器查询**（`container-type: inline-size`），断点固定 **320 / 520 / 760**。
- **禁止 media query**：sideview（≈360px）与编辑区（≈1200px）在**同一个窗口**里，`@media` 分不开（这条已经被 dsh-desktop 的规范点名，`development-guide.zh.md:185`）。
- catalog 在 ≤520 时收成单列、隐藏次要列（数量/时间），保留名称 + 状态徽标。
- 完整页里 core:catalog 默认 **1 : 0.32**（catalog 固定 320–380px，core 吃剩余），catalog 不允许超过 40%。

---

## 5. 跨容器联动

### 5.1 dsh 全窗（同页面内）

- 点 catalog 条目 ⇒ `main` 已在该工作台 ⇒ 只更新 core 的选中项（**同一页内 state**，不换面板、不换页签）。
- 点中心页卡片 ⇒ 设 `main` key + 右栏 tab kind，然后一次性把 `sel` 传过去。

### 5.2 IDE（跨 surface，必须经宿主）

sideview 与 editor 是**两个独立的 webContents**，同 origin 但不同文档 ⇒ **不能用 DOM / React 状态通信**。链路：

```
sideview(catalog) 点条目
  → bridge.openModulePage('/x/<module>/')      # 已存在，白名单 DSH_MODULE_PAGES
  → 宿主打开 DshPluginPageEditorPane(pageSurface='editor')
  → core 页读选中项（§5.3）
```

- `openModulePage` 只接受**整条路由**（`dshPageBridgeProtocol.ts:410-419`），不带查询串 ⇒ 选中项**不能走 URL**。
- 宿主对同一模块页**复用**已有的编辑区实例（不要每点一次开一个新 pane）——这条由 `openModulePage` 的容器单例保证，验收时按"连点 5 个条目，编辑区只应有 1 个页签"检查。

### 5.3 选中项共享（真源）

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **S1 同源 localStorage（首选）** | catalog 写 `vssaros.wb.<module>.sel`；core 启动读一次 + 监听 `storage` 事件 | 零协议改动；`storage` 事件跨 webContents 在 Chromium 同源下通常可用 | **先实现 S1** |
| S2 桥新增命令 | `bridge.wbSelect({module, id})` + 宿主推给对应 editor 视图 | 桥版本 +1、两端三处改 | S1 实测不同步时才上 |

S1 细则：

- key：`vssaros.wb.<module>.sel`（值为条目 id 或 JSON `{id, ts}`）。
- core 侧：`storage` 事件 + 窗口 `focus` 时重读（document 可见性变化也算）。
- 读不到 ⇒ 显示 core 的空态（"从左侧目录选一项"），**不要**显示错误。

### 5.4 写操作回流

- core 里改了数据 ⇒ 写 localStorage 的 `vssaros.wb.<module>.rev`（自增修订号），catalog 监听 `storage` 重取列表。
- dsh 全窗里两个 Pane 在同一页面 ⇒ 直接调用即可，但仍应写 `rev`（否则切换承载后行为不一致，属于"同一份代码两种行为"）。

---

## 6. 目录项（catalog entry）数据契约

```ts
interface IWorkbenchCatalogEntry {
  id: string;              // 稳定 id（写进 localStorage / URL 的 sel）
  title: string;           // 单行，超长省略 + title 属性
  icon?: string;           // codicon 名或 emoji（与工作台自身图标风格一致）
  group?: string;          // 分组名（catalog 内部分组，不叫"分类"，避免与市场分类混）
  badge?: string | number; // 条数 / 状态，≤4 字符
  status?: 'ok' | 'warn' | 'error' | 'busy'; // 决定徽标颜色，不用自由文本
  subtitle?: string;       // 一行辅助信息（时间 / 来源），≤30 字
}
```

- 条目**必须有稳定 id**：没有稳定 id 就没法做选中态、深链、探针断言。
- 排序由 catalog 自己负责（pinned 优先 → 自定义顺序 → 名称），core 不参与排序。

---

## 7. 工程落点（新做一个工作台要动的清单）

### 7.1 插件侧（必改）

1. `dsh-plugins/vssaros-<module>/lib/index.js`：注册 `/x/<module>/` 路由 + `?surface=` 分发 + 取数一次。
2. `lib/views/<module>/…`：`catalog.js` / `core.js` / `shell.js`，容器查询断点 320/520/760。
3. `package.json`：`vssaros.view = { kind: 'page', route: '/x/<module>/' }`；`files` 必须包含 `lib/`。
4. `cordis.patch.yml`：条目 + `config`（数据根从 `dshHomePath()` 取，不写死 `~/.dsh`）。
5. **版本 bump**（同版本宿主不重装）；改完内容也要 bump。

### 7.2 IDE 侧（必改，两处同值）

6. `src/vs/sessions/contrib/dshHarness/common/dshModuleContainers.ts`
   - `DSH_MODULE_CONTAINERS`：加一行（`containerId` / `modules` / `activityBar{ title, icon, order }`）
   - `DSH_MODULE_PAGES`：加 `{ module, kind: 'page', route }`
   - ⚠ 这两张表有守卫「与插件清单逐项一致（含 order）」(`dshModuleContainers.test.ts`)，只改一处会红。
7. `src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts` 的 `_registerModuleToolIcon`：`order` 必须与 6 同值。

### 7.3 chat-surface（dsh 侧入口）

8. `dsh-plugins/vssaros-chat-surface/lib/client.workbenchNav.js`
   - `DEFAULT_ITEMS` 加条目（`id` / `name` / `ico` / `route`）
   - 若该工作台需要 `main` 面板：注册 `main` keyed `<id>`；右栏 tab kind `<id>-catalog`
9. `dsh-plugins/check-chat-surface-chunks.mjs`：新槽条目进 `OUR_BASELINE` / `OFFICIAL_ENTRIES` 对账（漏登记 = 静默 tie，`goal` 那次教训）。
10. 聊天框替代入口：侧栏被裁时，入口必须挂在**右栏或聊天框 header**（现有 `client.settings.js` / `client.workbenchNav.js` 的 ⚙ 菜单是可达面），不能只靠侧栏。

### 7.4 探针（必配）

11. `poc/**/p3-*.mjs`：至少覆盖 §8 矩阵里本工作台的 4 行；断言必须踩**页面锚点**（`data-vssaros-page="<module>"` + `data-vssaros-surface="<surface>"`）。
12. 页面 `<body>` 必须带这两个 data 属性（sideview 版见 `vssaros-dashboard/lib/sideview.js:128`）。

---

## 8. 验收矩阵（真机，逐格打勾）

| # | 环境 | 期望 |
|---|---|---|
| 1 | dsh 全窗 · 点「🗂 工作台」 | 中栏 = 工作台中心；右栏不被破坏 |
| 2 | dsh 全窗 · 打开某工作台 | 中栏 = **core**（带选中项或空态引导）；右栏 = **catalog** |
| 3 | dsh 全窗 · 点 catalog 条目 | core 切换；**右栏页签数不增加**；刷新后选中项保留 |
| 4 | dsh 聊天框 | 无"点开空白"；core 在右栏可读（320–420px 不出横向滚动） |
| 5 | IDE · 活动栏图标 | sideview = **catalog**（`data-vssaros-surface="sideview"`） |
| 6 | IDE · 点 catalog 条目 | 编辑区出现**1 个** core 页签（`surface=editor`）；连点 5 条仍 1 个 |
| 7 | IDE · 编辑区刷新 / 重开 | core 记得上次选中项（§5.3） |
| 8 | 直开 `/x/<module>/`（无 surface） | 完整页可用（探针口径，catalog + core 都在） |
| 9 | 320px 容器 | 无横向滚动、按钮不裁切、标题不竖排 |
| 10 | 空态 / 错误态 | 有文案 + 有下一步动作，**不是空白**（`feedback_blank_page_three_causes`） |

---

## 9. 反例（做过一次就别再做）

- ❌ 写两套页面（`/catalog.html` + `/core.html`）各自取数 —— 口径必分叉。
- ❌ 用 `@media` 判宽度 —— sideview 与编辑区同窗不同宽，判不出来。
- ❌ 把选中项塞进路由（`/x/kb/?sel=…`）当宿主入口用 —— 宿主白名单只认整条路由，`validatePluginRoute` 拒查询串。
- ❌ 让 core 依赖 catalog 的 DOM 或 React 上下文 —— editor 承载时两者是不同 webContents。
- ❌ 每点一个条目就 `openModulePage` 一次而宿主不复用实例 —— 编辑区堆满页签。
- ❌ 在 catalog 里放业务主视图 —— 窄容器里必然裁切。
- ❌ 只做侧栏入口、不做聊天框替代入口 —— 聊天框里这个工作台等于不存在。
- ❌ 页面把自己钉死在某一个 `surface` 值上（未知值必须回落完整页）。

---

## 10. 迁移与版本

- 已有工作台改造顺序：**先拆 catalog/core（内容层）→ 再接 `?surface=` 两版 → 最后接 IDE 编辑区**。反过来做会得到"能打开但不知该画什么"的空壳。
- 每一步都能独立验收（§8 的 1–3 只是 dsh 侧，5–7 才是 IDE 侧），不要一次性全改完再测。
- 桥协议**本规范不新增任何命令**（`openModulePage` 已有）；若 S1 实测失败需要 S2，按 `dshPageBridgeProtocol.ts` 的规矩：bump 版本 + 两端 + 探针同批改。
