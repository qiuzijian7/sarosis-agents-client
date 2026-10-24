# 小红书笔记工作台 · 源码分析

**样本**：商城条目 `sara2398/xiaohongshu-note-workbench@0.1.1`（源码在本机 `%TEMP%\wb-market-src\sara2398__xiaohongshu-note-workbench`）
**规模**：12 个文件；客户端 **`lib/client.js` 单文件 201 行 / 18 KB**（**未压缩、可直接读**），服务端 **`dsh/index.js` 只有 3 行**
**分析时间**：2026-10-24

---

## 0. 六个结论（先看这段）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **挂载方式 = A 类（宿主托管 React）** | `__ModuleLoader__.load` → `require('react')` → `ctx.desktopWorkbenches.register(descriptor, Workbench)`，**自己不建 root** |
| 2 | **服务端是空壳** | `dsh/index.js` 全文：`export const name = …; export function apply() {}` ⇒ 纯客户端工作台，零 API |
| 3 | **"生成"是本机字符串模板，不是模型** | `createDraft()` 用 4 组标题模板 + 4 段引言 + 固定正文骨架；**全文件 0 处 `fetch` / 0 处模型调用** |
| 4 | **草稿存在 `localStorage`，不落 DSH 数据根** | `STORAGE_KEY = 'dsh-xhs-note-workbench.drafts.v1'`，上限 20 条 |
| 5 | **样式自造一套粉色变量，暗色不跟随** | `.xhswb{--ink/--muted/--line/--rose/--rose2/--paper}` + 26 处裸 `#hex`/`rgba`；**但容器查询达标**（`@container` 850/560） |
| 6 | **右栏对话是宿主给的** | 组件签名 `Workbench({ service, conversation })`，AI 模式把 `conversation` 放进右侧 340px 栏 |

---

## 1. 源码地图

| 文件 | 行数/体积 | 职责 |
|---|---|---|
| `package.json` | 903 B | `main`/`exports`（`.` 与 `./client`）、`dsh.bundle.patch`、`dsh.client.inject: ['dsh-desktop-workbenches']`、`files` 白名单 |
| `cordis.patch.yml` | 3 行 | 只做一件事：`- insert: [{ id, name: dsh-xiaohongshu-note-workbench, config: {} }]` |
| `dsh/index.js` | **3 行** | `export const name`；`export function apply() {}`（**空实现**） |
| **`lib/client.js`** | **201 行 / 18 KB** | 全部逻辑与 UI：样式注入、模板生成、状态、保存/复制、AI 协作接线、注册 |
| `scripts/check-workbench-package.mjs` | 1.3 KB | 结构自检（清单字段 / 文件存在 / 客户端里有 id 与 `customFrame: true` / 禁止占位仓库地址） |
| `docs/acceptance.md` | 1.1 KB | 11 条本机验收，**10 条打勾、1 条未勾**（"已安装列表显示…"） |
| `docs/market-entry.yml` | 641 B | 商城条目元数据（含 2 张截图 raw 地址） |
| `README.md` | 1 KB | 使用流程 + "数据与网络"说明（明确写了"均在本机完成"） |

> 没有 `src/`、没有构建脚本、没有测试框架 —— 客户端就是手写的成品源码。这一点在商城 19 个条目里很少见（多数只发 bundle）。

---

## 2. 挂载链路（逐层）

```1:5:lib/client.js
window.__ModuleLoader__.load({
  id: 'dsh-xiaohongshu-note-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
```

```186:199:lib/client.js
function apply(ctx) {
  ctx.effect(() => ctx.desktopWorkbenches.register({
    title: '小红书笔记创作',
    description: '根据主题和素材生成标题、正文和话题标签，支持修改、保存与复制定稿。',
    category: '内容创作',
    panelTitle: '小红书笔记创作',
    icon: '✎',
    audience: '个人博主',
    repository: 'https://github.com/sara2398/xiaohongshu-note-workbench',
    customFrame: true
  }, Workbench))
}
return { apply, inject: ['desktopWorkbenches'] }
```

**链路**：`__ModuleLoader__` 装载 chunk → `require('react')` 拿**宿主那份** → `apply(ctx)` → `ctx.desktopWorkbenches.register(desc, Workbench)` → 宿主把 `Workbench` 渲染进 `main` 槽。

**要点**

- **A 类标准姿势**：`ctx.effect(...)` 包注册（可随插件卸载回收）、`inject: ['desktopWorkbenches']` 声明依赖、**没有 `createRoot`**；
- **描述符用了宿主未必认的字段**：`category` / `panelTitle` / `audience` —— 我们宿主的 `normalize()` 只校验 `title` + `Component` 并读取 `customFrame`/`headerLayout`/`layout`，多出来的字段会被忽略（不报错，但也不生效）；
- **入口没写 `chunk:`** —— 正确（写了会让整个 web boot 失败，见 `doc/workbench-react-mounting.md`）。

---

## 3. 组件结构与状态

```
Workbench({ service, conversation })
├─ 9 个 useState
│   topic / material / style / draft            ← 创作输入 + 生成结果
│   saved / aiOpen / startingAi / error / toast ← 本机草稿、AI 栏开合、错误、提示
├─ 纯函数工具（组件外）
│   clean(value) / keywords(topic, material) / createDraft(topic, material, style)
└─ 渲染
    header：logo「薯」+ 标题 + 副标题 + 右上「AI 协助」
    main（grid 两栏）
      ├─ 左 card：kicker「✦ 从灵感到成稿」/ 主题 input（maxLength 80）/ 素材 textarea（maxLength 4000）
      │           / 风格 select（4 种）/ 生成按钮（文案随 draft 变「重新生成一版」）
      │           / 已保存定稿列表（最多展示 6 条，可载入 / 删除）
      └─ 右 card：无草稿 ⇒ 空态「从一个主题开始」
                  有草稿 ⇒ 3 个可选标题 + 最终标题 input + 正文 textarea（240px）
                            + 标签 textarea + 「保存定稿 / 复制完整笔记 / AI 协助润色」
    aiOpen ⇒ 外层再包一层三栏：编辑区 + 右侧 340px 对话栏（`conversation` 或启动页）
    toast：右下角 1.8s 自动消失
```

**状态管理**：全在组件内 `useState`，无 context / 无 reducer / 无外部库 —— 201 行能撑住，因为只有一条主流程。

---

## 4. "生成"到底做了什么（最重要）

```33:52:lib/client.js
function createDraft(topic, material, style) {
  const titleSets = { 真诚分享: […3 条], 实用攻略: […3 条], 轻松活泼: […3 条], 简洁专业: […3 条] }
  const intros = { 真诚分享: `最近认真体验了一次${t}…`, … }
  const body = `${intros[style]}\n\n【我的素材】\n${seed}\n\n【建议这样做】\n1. …\n2. …\n3. …\n\n【最后想说】\n…`
  const tags = [`#${t}`, …keywords(t, m).map(…), '#小红书笔记', '#经验分享']
  return { titles, title: titles[0], body, tags: [...new Set(tags)].slice(0, 8).join(' ') }
}
```

- **纯模板**：4 种风格各 3 个标题句式、4 段引言、1 套固定正文骨架（"【我的素材】/【建议这样做】/【最后想说】"）；
- **"素材"只是被原样塞进正文**（`seed`），没有任何摘要、改写或结构化；
- **标签**：主题 + 用标点切词后的前 6 个词 + 两个固定 tag，去重后取 8 个；
- **零网络**：全文件无 `fetch`、无模型调用、无 API 路由 ⇒ README「生成、编辑和保存定稿均在本机完成」是**如实**的，但商城文案「根据主题和素材生成」容易被读成"模型生成"。

> 这是分析里最值得警惕的一条：**界面看起来像 AI 写作，实际是文案模板**。它不影响"能不能用"，但影响"值不值得装"。

---

## 5. 持久化与剪贴板

```54:59:lib/client.js
function readSaved() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.slice(0, 20) : []
  } catch { return [] }
}
```

| 项 | 实现 | 评价 |
|---|---|---|
| 存储位置 | `localStorage['dsh-xhs-note-workbench.drafts.v1']` | ✗ 不落 `<DSH 数据根>/<id>/`；换机、清缓存即丢；与"卸载不删数据"约定不符 |
| 上限 | 20 条（`slice(0, 20)`），UI 只展示 6 条 | 超出后静默丢弃最旧的 —— 没有提示 |
| 记录字段 | `{ id, topic, title, body, tags, savedAt }`（`savedAt` 用 `toLocaleString('zh-CN')`） | 时间用本地化字符串，排序/比较不可靠 |
| 载入 | `loadDraft()` 把 `titles` 重置为 `[item.title]` | 载入后**丢失另外两个候选标题**（重新生成才能拿回） |
| 复制 | `navigator.clipboard.writeText(title + body + tags)`，失败给"请手动选择" | ✓ 有兜底 |

---

## 6. AI 协作怎么接的（唯一与宿主交互的地方）

```123:138:lib/client.js
async function openAi() {
  setAiOpen(true)
  const current = service.currentSession?.()
  if (current && service.ownsSession?.(current)) return      // 已有自己的会话 ⇒ 直接复用
  const workspace = service.defaultWorkspace?.()
  if (workspace) await service.newSession(workspace.workspaceId)
  else await service.newWorkspaceSession()
}
```

- 用的是**宿主注入的 `service`**（`currentSession` / `ownsSession` / `defaultWorkspace` / `newSession` / `newWorkspaceSession`），全部带 `?.` 兜底；
- 右侧渲染的是 **`conversation` prop**（宿主给的会话 UI），拿不到时显示"选择位置并开始"的启动页；
- 打开 AI 时布局从**两栏变三栏**（编辑区 + 340px 对话），`@container (max-width:850px)` 下自动堆叠成上下；
- **没有把"当前草稿"塞进对话**（对比：选址工作台会把选中点告诉对话）—— 想润色还得自己复制粘贴，这是最明显的功能缺口。

---

## 7. 样式系统（好看，但不跟主题）

```8:12:lib/client.js
.xhswb{--ink:#271f24;--muted:#736970;--line:#eadfe4;--rose:#ff2e55;--rose2:#fff0f3;--paper:#fffdfc;
  background:linear-gradient(145deg,#fff9f7 0%,#fff 46%,#fff7f9 100%);
  font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif; container-type:inline-size}
@container (max-width:850px){ … 两栏→一栏，对话栏转到底部 … }
@container (max-width:560px){ … 标题副文案隐藏、按钮换行 … }
```

| 维度 | 实现 | 与规范的差距 |
|---|---|---|
| 颜色 | 6 个**自造变量** + 裸 `#fff` / `rgba(255,46,85,.18)` 等 | ✗ 不用 `--dsw-alias-*` ⇒ **暗色主题下仍是粉色亮底** |
| 品牌色 | `--rose` 直接写在根类上（未做"单一入口 + 作用域"） | △ 作用域确实只在 `.xhswb` 内（这点对了），但没有"切 host 品牌"的开关 |
| 尺寸 | 手写 `9px/11px/12px/15px/18px` | ✗ 不用 `--wb-*` 刻度 |
| 响应式 | **容器查询**（850 / 560）+ `container-type:inline-size` | ✓ **达标**，比多数内置包做得好 |
| 可达性 | `aria-label`、`role="alert"/"status"`、`:focus-visible` 3px outline | ✓ 达标 |
| 注入 | `injectStyles()` 建 `<style data-xhs-workbench>`，重复调用早退 | ✓ 正确（不重复注入） |
| 宿主让步 | `padding-left: max(24px, var(--dsh-frame-leading-clearance, 24px))` | ✓ **唯一读宿主变量的地方**：给宿主侧边栏让位，值得抄 |

---

## 8. 与「工作台框架」的对照（沿用 `doc/workbench-framework-conformance.md` 的条款）

| 条款 | 本工作台 | 说明 |
|---|---|---|
| **F1 注册式** | **✓** | A 类标准姿势，`ctx.effect` 包裹 |
| **F2 三栏** | **✓ 近似** | 两栏为常态，开 AI 变三栏（编辑 + 对话） |
| **F3 右栏 = 官方对话** | **✓** | 直接渲染宿主 `conversation`，不自造聊天 UI |
| **F4 平台级入口** | **✗** | 入口在工作台头部（「AI 协助」），非平台右上角 |
| **F5 只走令牌** | **✗** | 自造粉色变量 + 裸色，暗色不跟随 |
| **F6 品牌色单一入口** | **△** | 作用域对（仅 `.xhswb`），但没有 host/brand 切换 |
| **F7 容器查询** | **✓** | `container-type` + 两档 `@container` |
| **F8 面板守卫** | **n/a** | 它不调用 `selectPanel`，无需守卫 |

**判定**：**5.5 / 8** —— 是商城里最接近该框架的实现；两个硬伤是**颜色不跟主题**和**数据不落盘**。

---

## 9. 可借鉴 / 风险 / 改法

### 9.1 值得抄的 5 条

1. **201 行单文件就能交付一个工作台**：样式注入 + 一个组件 + 一个 `apply`，没有构建链、没有框架；
2. **`conversation` prop 直接用宿主的**：不自造聊天 UI，天然继承模型/工具/权限；
3. **`service.currentSession?.() + ownsSession?.()` 先复用再新建**：避免每次点 AI 都开一串新会话；
4. **容器查询做两档就够**（850 堆叠 / 560 收细节），比一堆 `@media` 可靠；
5. **`injectStyles` 幂等**（`style[data-xhs-workbench]` 存在就 return）。

### 9.2 风险 5 条

1. **"生成"是模板**：商城文案容易被读成 AI 生成 ⇒ 建议文案改成"按模板生成草稿，可让 AI 润色"，或在界面标"本机模板"；
2. **数据只在 localStorage**：换机/清缓存即丢，且超出 20 条静默丢弃 ⇒ 应落 `<数据根>/<id>/drafts.json`；
3. **暗色下是亮粉色**：与 dsh 视觉断裂；`--paper/--ink` 等应换成 `--dsw-alias-*`；
4. **描述符字段超出宿主契约**（`category/panelTitle/audience`）：装到我们的宿主会被忽略，别指望它们生效；
5. **AI 不知道你在写什么**：打开对话不会带当前草稿，润色需要手工复制 —— 少了"共享 selection"这一环。

### 9.3 若要在我们这边重做（建议）

| 改动 | 落点 | 成本 |
|---|---|---|
| 生成改走模型 | 新增 `POST /x/<id>/api/generate`（或直接让对话产出，工作台只负责结构化展示） | M |
| 草稿落数据根 | `lib/store.js` + `GET/POST /api/drafts`，`localStorage` 只留 UI 偏好 | S |
| 颜色令牌化 | `.xhswb` 变量 → `var(--dsw-alias-*, 兜底)`；`--rose` 收敛为 `--wb-brand` 且默认跟随 host | S |
| 把草稿交给对话 | 打开 AI 时把 `{title, body, tags}` 作为上下文（或预填一条消息） | S |
| 复用共享层 | 头部/卡片/按钮换 `wb-toolbar` / `wb-card` / `wb-btn` | S–M |

---

## 10. 复现

源码在本机：`%TEMP%\wb-market-src\sara2398__xiaohongshu-note-workbench\`（来自 `codeload.github.com/sara2398/xiaohongshu-note-workbench/tar.gz/HEAD`）。
结构自检：`node scripts/check-workbench-package.mjs`（只校验包结构，不校验行为）。
