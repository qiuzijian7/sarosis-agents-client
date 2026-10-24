# 设置 → 工作台商城：逐元素源码拆解与可复用经验（2026-10-23）

**截图对应的不是 dsh 插件页，而是设置分区**：`dsh-plugins/vssaros-chat-surface/lib/client.market.js`（71 KB，注册到 `settings.section` 槽，section id = `vssaros-workbench`）。
**数据全部来自 `dsh-plugins/vssaros-market/`**：`GET /x/market/api/catalog` + `POST /x/market/api/{install,uninstall,check}`。界面**只负责渲染与交互**，不自己算指标。

> 这份文件开头有一段 30 行的"设计契约"注释（第 8–37 行），是理解全部取舍的钥匙 —— 下面每一节都会指回它。

---

## 1. 页面骨架（从上到下）

| 区域 | 源码 | 说明 |
|---|---|---|
| **页头** | `client.market.js:883-905` | `h1` =「工作台」+ 一句副标题「有序组织专属界面、会话与资料」；**搜索框**（`type=search`，placeholder「搜索名称、作者或分类」，`aria-label`，左内嵌 🔍）；右侧「＋ 制作我的工作台」primary 按钮（切到制作视图，同一按钮在制作视图里变「← 返回工作台市场」） |
| **目录状态条** | `907-909` | `vssWbNotice` + `sourceText(...)`：**如实说目录来自哪儿 / 有没有读失败**（不是只在出错时才提示） |
| 消息条 | `910-914` | 页内操作结果（warn 时左边框变警告色 + `role="alert"`），带"关闭" |
| **工具行** | `916-958` | 左：三个 Tab；右：刷新圆钮 + 分类 select + 排序 select |
| 网格 | `961-977` | `vssWbGrid`，每卡一行 `Card`；空态占满整行（`grid-column:1/-1`） |
| 加载更多 | `978+` | `PAGE_SIZE = 24`（`86` 行），超过就出"加载更多" |

> 截图里右上角的「打开配置文件」属于**设置页外壳**，不归这个分区；本节从搜索框开始。

**页头的一条纪律**：标题与副标题**跟着视图变**（市场视图「工作台」/ 制作视图「制作属于你的工作台」），搜索框只在市场视图出现 —— 不是"一直显示但禁用"。

---

## 2. 页头：搜索 + 制作入口

```883:899:dsh-plugins/vssaros-chat-surface/lib/client.market.js
react.createElement("h1", null, isSubmit ? "制作属于你的工作台" : "工作台"),
react.createElement("p", { className: "vssWbMuted" }, isSubmit ? "遵循规范开发、安装并验证，也可以准备材料提交到工作台市场。" : "有序组织专属界面、会话与资料"),
react.createElement("label", { className: "vssWbSearch" }, … input type="search" placeholder="搜索名称、作者或分类" …
```

**特色**

- 搜索是 `<label>` 包 `<input type="search">`（点图标也能聚焦），`aria-label="搜索工作台"`，带 `data-vssaros-market-search` 锚点；`focus-visible` 有独立的 focus ring（`--dsw-focus-ring-color`）；
- 「＋ 制作我的工作台」是**主按钮**，和"安装"同色 —— 这个页面同时承担"逛市场"和"做工作台"两件事，靠**视图切换**（`isSubmit`）而不是新开页；
- 卡片网格上方还有一条**常驻状态条**（`sourceText`）：说明目录是从哪儿读的（随包策展 / 远程 / 缓存）、有没有失败 —— **正常时也说**，不是只在出错时才出现。

---

## 3. 工具行：三个 Tab + 两个下拉

```917:941:dsh-plugins/vssaros-chat-surface/lib/client.market.js
react.createElement("div", { className: "vssWbTabs", role: "tablist", "aria-label": "工作台集合",
	onKeyDown: ev => { ... ArrowRight / ArrowLeft / Home / End ... },
```

**特色**

- Tab 文案带**计数**：`市场` / `我的收藏 (n)` / `已安装 (n)` —— 不用点进去就知道有没有内容；
- **键盘可达**：`role="tablist"` + `role="tab"` + `aria-selected` + **roving tabindex**（选中项 `0`，其余 `-1`）+ 四个方向键/Home/End；
- 每个 Tab 带 `data-vssaros-market-tab`，探针可直接点（**锚点用 `data-*` 不用类名**）。

```942:957:dsh-plugins/vssaros-chat-surface/lib/client.market.js
react.createElement("button", { className: "vssWbRound", "aria-label": tab === "mine" ? "检查更新" : "刷新目录", "aria-busy": loading ? "true" : "false", ...
```

**刷新钮**：**同一个按钮随 Tab 变语义** —— 在"已安装"页它是"检查更新"，在"市场/收藏"页是"刷新目录"；`aria-busy` + 文案变 `…` 表示进行中。

**两个下拉**：分类（`全部类型` + 目录里声明过的分类）与排序（`Star 数量` / `下载量` / `更新时间` / `名称`）。切换任一个都会 **`setVisible(PAGE_SIZE)` 把分页归零**（否则会停留在"第 5 页"看到空列表）。

---

## 4. 卡片（这是截图里信息密度最高的部分）

### 4.1 媒体区：有截图就显示，没有就画骨架

```403:423:dsh-plugins/vssaros-chat-surface/lib/client.market.js
function Preview(props) {
	const shots = Array.isArray(it.screenshots) ? it.screenshots : [];
	const src = shots.length ? String(shots[0].url || "") : "";
```

- **有截图**：`<img class="vssWbCardScreenshot">`，`object-fit:cover; object-position:center`，`loading="lazy"`，`onError` 时 **`display:none`**（图挂了不留破图）；
- **没有截图**：画一张**模拟预览**（三个圆点 + 两个面板"会话 / 业务区域"，有 `icon` 就居中放图标），并标 `aria-label="…界面预览（模拟）"` —— **绝不伪造真实截图**；
- 整块媒体区是 `<button>`，点它开详情模态；右上角有"放大"角标（内联 SVG）。

### 4.2 标题：有仓库地址就是外链

```494:497:dsh-plugins/vssaros-chat-surface/lib/client.market.js
repo ? react.createElement("h2", null,
	react.createElement("a", { className: "vssWbTitleText", href: repo, target: "_blank", rel: "noopener noreferrer" }, it.name || it.id))
```

`rel="noopener noreferrer"` 是硬要求（防 `window.opener` 反向控制）。"已安装"页额外显示一个分类小标（`本地` / 目录分类）。

### 4.3 作者行：GitHub 头像由 owner 派生

```451:462:dsh-plugins/vssaros-chat-surface/lib/client.market.js
const avatar = owner ? ("https://github.com/" + encodeURIComponent(owner) + ".png?size=40") : "";
```

- **不额外请求 API**：GitHub 头像 URL 规则稳定（`github.com/<login>.png?size=40`），省一次鉴权与限流；
- `encodeURIComponent(owner)` 防注入；`onError` 隐藏后回落到 👤；
- 同一行还挂两类**状态徽标**：`不兼容`（附 `title` 写出运行时版本与要求）、`待重启`。

### 4.4 指标行：**只在有数时渲染，且独立成行**

```466:514:dsh-plugins/vssaros-chat-surface/lib/client.market.js
const listed = it.listed === true;
const stars = Number.isFinite(it.stars) ? it.stars : null;
const hasMetrics = listed && (stars !== null || downloads !== null);
...
// 指标**独立成行**（不放底部）：窄卡片里底部还要放 GitHub / 收藏 / 主按钮，
// 指标挤进去会被压成竖排（★ / 0 分两行）✗ ⇒ 挪到上面独占一行 ✓
```

两条经验都很值钱：

1. **不伪造指标**：目录没给数就**整块不渲染**（不是显示 0）；`listed` 是"来自已发布目录"的标记，本地条目即使有数也不显示；
2. **指标单独一行**：早期放在底部控制行里，窄卡片被压成竖排（`★` 和 `0` 各占一行）⇒ 挪到描述上方独占一行。

### 4.5 底部控制行：一个"主按钮状态机"

```518:559:dsh-plugins/vssaros-chat-surface/lib/client.market.js
// GitHub 圆钮 → 收藏 → 卸载 → 主按钮
canOpen ? "打开" : canInstall ? "安装" : installed ? "已安装" : policyBlocked ? "已停用" : compat === "incompatible" ? "不兼容" : repo ? "查看安装说明" : "不可安装"
```

主按钮**七种终态**，按"能不能用"逐层降级，**没有一种情况是空白或可点的假按钮**：

| 条件 | 呈现 | 为什么 |
|---|---|---|
| 已安装且有 route/registeredId | `打开`（primary） | 装了就能用 |
| `installable && !installed && 兼容 && 未被策略拦` | `安装`（primary，busy 时"安装中…" + disabled） | 正常路径 |
| 已安装但宿主里还没有 | `重启后可用`（span，非按钮） | 运行中的进程不热加载新包 |
| 策略停用 | `已停用`（disabled + title 写原因） | 别让用户反复点 |
| 版本不兼容 | `不兼容`（disabled + title 说等作者发兼容版） | 同上 |
| 有仓库但不可装 | `查看安装说明`（外链） | 给出路，不是死路 |
| 什么都没有 | `不可安装`（disabled） | 诚实 |

**收藏**用 `aria-pressed` + `★/☆` 双态，存 `localStorage['vssaros.market.favorites']`（`87` 行；私密模式写入失败不崩）。
**GitHub 圆钮**只在有 `url` 时出现，图标是**内联 SVG**：

```426:430:dsh-plugins/vssaros-chat-surface/lib/client.market.js
// ⚠ 为什么不用字符（如 "⌂"）：dsh 客户端的字体子集里没有那个字形 ⇒ 渲染成豆腐块 ✗
```

---

## 5. 详情模态：只读、不重复主操作

- **截图轮播**（`567-581`）：多张时出 `‹ ›` 与 `1 / N`（`aria-live="polite"`）；
- **兼容性一行**（`584+`）：有结论直接显示；没有就给「检查兼容性」（会下载包做检查但**不安装**）；再往下是**静态能力扫描**结论（"它的服务端会…"）；
- **模态里没有安装按钮**（文件头注释第 18 行明确）—— 安装只发生在卡片上，避免"同一个动作两个入口、状态不同步"。

---

## 6. 空态：四种文案，每种都给下一步

```967:976:dsh-plugins/vssaros-chat-surface/lib/client.market.js
tab === "favorites" ? "还没有收藏工作台" : tab === "mine" ? "还没有安装工作台"
	: key ? "没有找到匹配的工作台" : "市场目录暂不可用"
```

副文案配套给动作：收藏 → "把鼠标移到市场卡片上，点击书签即可收藏"；已安装 → "到工作台市场选择一个开始"；搜索无果 → "试试其他关键词或分类"；目录挂了 → 打印 `loadError` 并提示重试。**每个空态都说清"为什么空 + 我该做什么"**。

---

## 7. 数据契约（`vssaros-market/lib/catalog.js`）

| 字段 | 语义 | 界面用法 |
|---|---|---|
| `id` | **`owner/repo`**（目录内唯一） | 卡片 `data-*` 与收藏键 |
| `owner` / `url` | GitHub 登录名 / 仓库地址 | 头像派生 / 外链 |
| `screenshots[]` | `{url, alt, width, height}` | 媒体区第一张 + 模态轮播 |
| `metrics.{githubStars,npmDownloads30d,githubReleaseDownloads}` | `{value, status}` **三态** | `status !== 'ok'` ⇒ 视为无值 |
| `distribution` / `distributionType` | 安装源（bundle / github-source / github-release…） | 决定 `installable` |
| `compatibility` / `policy` | 兼容性结论、策略放行 | 徽标 + 禁用主按钮 |
| `listed` | 是否来自**已发布目录** | 决定是否显示指标 |

服务端归一化时**已经**把三态压成 `null`：

```131:142:dsh-plugins/vssaros-market/lib/catalog.js
function metricOf(...holders) {
	for (const holder of holders) {
		if (holder.status !== undefined && holder.status !== 'ok') { continue; }
		const value = holder.value;
		if (Number.isSafeInteger(value) && value >= 0) { return value; }
	}
	return null;
}
```

⇒ 界面只需要判 `Number.isFinite`，**不用懂三种指标来源的差别**。这是"口径收敛在服务端"的正面例子。

---

## 8. 可复用经验（下次开发工作台/商城页直接照抄）

### 8.1 内容诚实性（最重要）

1. **没有数据就不渲染那一块**，不显示 `0`、不显示 `--`、不编排序（值缺失的**排最后**，见 `858` 行注释）；本地条目即使有数也不显示（`listed` 门槛）。
2. **没有截图就画"模拟预览"并标注"（模拟）"**，不拿别的图冒充。
3. **能力边界写在按钮 title 里**（"与当前 dsh 不兼容，等作者发布兼容版本"），用户点不了也知道为什么。

### 8.2 卡片布局

4. **媒体 → 标题 → 作者/版本/徽标 → 指标 → 描述 → 操作** 的固定顺序；指标独占一行（窄卡是常态）。
5. **描述两行截断**（`-webkit-line-clamp`），兜底文案"暂时还没有填写介绍"而不是空白。
6. **底部只放圆形小控件 + 一个主按钮**；次要动作用 `vssWbLink`（文字链），危险动作用 `danger` 变体。

### 8.3 状态与反馈

7. **主按钮写成状态机穷举**，每个分支都有文案；`busy` 用 `Set<id>` 做**同条目串行化**（`245` 行注释：装包分钟级，防重复点）。
8. **反馈双写**：页内消息条（`say`）+ IDE 通知（`notify`）—— 前者在用户眼前，后者在窗口角落；安装结果两者都要写。
9. **重启才生效的安装要说"待重启/重启后可用"**，不要让用户以为失败。

### 8.4 可测试性与可达性

10. **锚点一律 `data-*`**（`data-vssaros-market-card/tab/install/uninstall/compat/policy`），类名属于视觉层（我们做 UI 统一时被这条坑过三次）。
11. **键盘可达**：`tablist` + roving tabindex + 方向键；轮播 `aria-live`；开关用 `aria-pressed`。
12. **图标用内联 SVG**：dsh 字体子集没有那些字形，字符图标会变豆腐块（文件里两处都写了原因）。

### 8.5 图标与图片

13. **头像按规则派生**（`github.com/<login>.png`）比多打一次 API 更稳；
14. **所有 `<img>` 都带 `onError` 兜底**（隐藏 + 占位），网络不可靠是常态；
15. **外链一律 `target="_blank" rel="noopener noreferrer"`**。

### 8.6 性能与分页

16. `PAGE_SIZE = 24` + "加载更多"；**筛选/排序变更时重置分页**；
17. 截图 `loading="lazy"`；不预加载全部卡片的大图。

---

## 9. 开工检查表（新做"商城式列表页"时逐条过）

- [ ] 数据口径是否在服务端收敛成"有值 / `null`"两态？界面不猜三态。
- [ ] 无数据的字段是否**整块不渲染**（而不是 0）？
- [ ] 主按钮是否**穷举了所有终态**（可用 / 已装 / 待重启 / 不兼容 / 停用 / 有外链 / 不可用）？
- [ ] 是否用 `Set` 做了**同条目操作串行化** + `busy` 文案？
- [ ] 反馈是否**页内 + 系统通知**双写？
- [ ] 空态是否**四种分支**（收藏空 / 已装空 / 搜索空 / 目录不可用）且各带下一步？
- [ ] 机器锚点是否全部 `data-*`？
- [ ] 键盘能走完 Tab 切换、轮播、收藏吗？
- [ ] 所有图标是 SVG、所有 `img` 有 `onError`、所有外链带 `noopener`？
- [ ] 分页在筛选/排序后是否重置？

---

## 10. 一句话总结

这个页面最值得抄的不是样式，而是**三条纪律**：**没数据不显示假数据**、**主按钮穷举状态且每个都有出处**、**机器锚点与视觉类名解耦**。三者合起来，界面在"目录只有部分字段""包还没发布完""用户点了不能点的东西"这些真实场景下都不会骗人。
