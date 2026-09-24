---
name: kb-category-feishu
description: 知识库「分类」与飞书知识库关联手册 —— 新建/调整笔记分类目录、把某个分类绑定到飞书知识库（自动建库或关联已有库）、以及分类变更后的跨库自动搬迁。当用户说「新建一个分类」「笔记按 XX 分类归档」「把这个分类同步/关联到飞书知识库」时使用。
---

<!-- 同步指针：本技能讲「分类目录 ⟺ 飞书知识库(space)」的映射规则；可执行能力有两处，改规则时三处同步：
     · 内置脚本 `resources/.agents/kb/feishu-sync.mjs`（loadSpaceMap / applyExplicitMappings /
       computeTargets / migrateSpaceMappings）
     · 宿主契约 `src/vs/sessions/contrib/agentStudio/browser/knowledge/feishuSyncCore.ts`
       （FEISHU_SPACE_MAP_FILE / parseSpaceMap / serializeSpaceMap / buildSyncArgs）
     · 设置面板 `browser/kbSettingsEditorPane.ts`（类别层级 / 目录映射）
     笔记**类型**（frontmatter type）的真源是 vault 根 `kb-schema.json`（见 knowledge/kbSchema.ts）。 -->

# 知识库分类 × 飞书知识库关联（kb-category-feishu）

## 先分清两个「分类」（最常见的误解）

| | 是什么 | 定义在哪 | 影响飞书落点吗 |
|---|---|---|---|
| 笔记**类型** | frontmatter 的 `type`（entity / concept / method / …） | vault 根 `kb-schema.json` 的 `types[]` | ❌ 不影响 |
| **分类目录** | 笔记区下的目录层级（如 `笔记/AI/01-基础/…`） | 文件系统本身 | ✅ **决定飞书知识库归属** |

**铁律：要让笔记进入某个飞书知识库，动的是「目录」，不是 `type`。**

## 一、新建一个分类

1. **先查重**（防同义分裂）：`search_files` 看笔记区现有目录；能复用就复用，绝不新建「看起来差不多」的平行目录。
2. **建目录**（命名与同级风格一致，例如同级已有 `01_…` 就跟着编号）：
   - 少量多篇 ⇒ 用 `kb_organize` 建目录 / 移入；
   - 只有一篇 ⇒ 直接 `file_write` 到 `笔记/<新分类>/<笔记名>.md`（目录隐式创建）。
3. **要不要登记新「类型」？默认不要。** 先看能否用既有 8 类：
   `entity / concept / method / comparison / source / query / synthesis / misc`。
   确实是一种新语义类型时，才 `patch` `kb-schema.json` 的 `types` 追加一项（6 个字段都要给全）：

   ```json
   { "id": "exercise", "label": "练习", "dir": "练习", "desc": "习题、练习与解答",
     "promptHint": "内容为题目与解答时选择此类型。", "keywords": ["习题", "练习", "答案"] }
   ```

   - ⚠ **不要**为每个 type 建一套并行目录树；`dir` 只是「实在没有合适目录时」的兜底落点（对齐技能 `kb-build` 的落点规则）。
   - 生效范围：分类器（`classifyContent`）**每次**重读 schema，即时生效；构建控制器在**单次构建会话内缓存一次** ⇒ 新发起的构建才保证读到新版本。

## 二、与飞书知识库建立关联（三种模式，先选模式再动手）

| 模式 | 适用 | 怎么做 | 结果 |
|---|---|---|---|
| **A 自动建库（默认）** | 新分类 = 一个**新**的飞书知识库 | **什么都不用配** | `apply` 时按分类目录名自动创建同名知识库 |
| **B 关联已有知识库** | 该分类要并进**现有**飞书知识库 | 写 `<vault>/.feishu-space-map.json` 显式映射 | 该目录**及其子目录**的笔记都进指定知识库 |
| **C 落到父节点** | 不想按分类分库 | 设置 `sessions.agentStudio.kb.feishu.parent`（`my_library` 或 folder token）；或把 `categoryDepth` 设为 `0` | 全部落到父位置，不建库 |

**模式 B 的文件格式**（显式映射**优先于**目录名推导，按**最长前缀**匹配）：

```json
{ "version": 1, "mappings": [ { "dir": "笔记/AI/01-基础", "spaceId": "769xxxxxxxx", "spaceName": "01-基础" } ] }
```

- `dir` 必须是**库内相对路径**（从 vault 根算，如 `笔记/AI/01-基础`），**不是**绝对路径。
- `spaceId` 来源：飞书知识库 URL，或面板「知识库设置 → 飞书同步 → 目录映射 → 🔄 刷新知识库列表」里挑。
- ⚠ **`spaceId` 是唯一生效的字段**：只写 `spaceName`（只写名字、没有 id）的条目会被**静默忽略**（不报错！）——
  表现为「用户以为已经关联到那个知识库，实际笔记被自动建到了另一个同名新库」。
  你无法凭空得到 `spaceId` ⇒ 必须让用户从面板列表里挑，或从知识库 URL 里取。
- 推荐路径：让用户在面板用「＋ 添加目录」配（面板写同一个文件）；你直接 `patch` 该文件也可以 —— 脚本每次运行都重读，**下次同步即生效**；但面板若正开着，要提示用户重开面板以刷新视图。
- 兼容极简写法：`{ "mappings": { "笔记/AI/01-基础": "769xxxxxxxx" } }`。

**类别层级（关键易错点）**：类别 = 同步源目录下**第 N 级目录**，N = 设置项
`sessions.agentStudio.kb.feishu.categoryDepth`（面板标签「类别层级」，默认 `1`）。
默认 1 ⇒ 「笔记区下的一级目录 = 一个飞书知识库」；若分类是二级结构（`笔记/A/B/`）而你想让 `B` 成为知识库，必须把 N 改成 `2`；想整个知识库不分库就设 `0`。
同步源目录默认只有「笔记」（`sessions.agentStudio.kb.feishu.srcDirs`，留空 = 整个知识库）。

## 三、改了分类之后会发生什么（自动搬迁，不用怕）

- 笔记**换了分类** ⇒ 下次 `apply` **自动跨知识库搬迁**（`wiki +move`）。依据 frontmatter 的 `feishu.token` + 本地索引反查历史落点 ⇒ 不必手工去飞书搬。
- 分类目录**改名** ⇒ 脚本识别为「改名」（旧目录已不存在）⇒ **复用原知识库**（映射键迁移），不会多建一个库。
- 每个知识库里有一张「**目录思维导图**」，随目录结构变化自动重建 —— 分类调整后它跟着更新是**正常现象**。
- 未映射的类别在 `autoCreateSpaces` 关闭时会被**跳过**（不报错），此时要在面板补映射或打开该开关。

## 四、铁律（违反会导致重复创建 / 冲突误判）

1. **绝不手改笔记 frontmatter 的 `feishu:` 块**（`token / url / hash / remoteHash / title / space / node / syncedAt` 全部由同步脚本维护）。想让某篇重新同步 ⇒ 改**正文内容**（hash 自然变化），不要动这些字段，也不要「删掉整块让它重建」。
2. 新建/调整分类后**不要直接 apply**：先 `kb_feishu_sync` **dry-run** 出计划交用户确认（完整流程见技能 `kb-feishu-sync`）。
3. 「库」是**素材层**，默认不同步（`srcDirs` 默认 `["笔记"]`）；给「库」建分类前先确认用户意图。
4. 分类名要能安全用作飞书知识库名：不要含 `"`、换行、斜杠（脚本会剥引号与换行，但别依赖它兜底）。
5. 一次移动 **>10 项**不要自己动手：按技能 `kb-build` 的约定输出 `KB_REORG` 机器可读计划块，由宿主备份并请用户确认后执行。
6. 图表类笔记同步时会被自动转成 PNG（属正常，见技能 `kb-feishu-sync`），不要因为正文被改写而回滚。

## 完成清单

- [ ] 新分类目录已存在，命名与同级风格一致（没有造平行目录）
- [ ] 需要时已在 `kb-schema.json` 登记新类型，或已确认复用既有类型
- [ ] 关联模式已明确：A 自动建库 / B 显式映射（`.feishu-space-map.json`）/ C 父节点
- [ ] `categoryDepth` 与目录层级匹配（1 级还是 2 级）
- [ ] 已 dry-run 出计划并交用户确认，未擅自 `apply`
- [ ] 全程未触碰任何 `feishu:*` 字段
