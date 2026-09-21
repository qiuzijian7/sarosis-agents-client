# 知识库 → 飞书知识库 同步规格（v1）

> 本文是「用 lark-cli 验证规则 → 固化为产品实现」路径的第一步产出，也是第二步
> （`FeishuDocClient` + `kbFeishuSyncService`）的实现规格。
> 状态：规则已定稿待端到端验证；验证对象 = `~/.vssaros-dev/knowledge-base/20260709063858-azbh1at`（Obsidian 导入库，80 篇，**无图片引用**）。

## 0. 范围与语义

- **单向**：本地 vault 是 source of truth；飞书侧不做回写（避免双向合并）。
- **增量**：只处理指纹变化的笔记；未变化零 API 调用。
- **幂等**：同一笔记重复同步不产生新文档（靠身份锚定）。
- **首轮全量**：白名单目录；系统文件（index/overview/insights/log/.overview.md）不同步正文。

## 1. 身份锚定（去重的根）

### 1.1 笔记 frontmatter（主锚，随笔记走）

```yaml
feishu:
  token: docxcnxxxxxxxx        # docx token 或 wiki node token
  type: docx | wiki            # 挂 wiki 树用 wiki
  space: <wiki_space_id>       # type=wiki 时必填
  parent: <parent_node_token>  # type=wiki 时必填
  url: https://xxx.feishu.cn/docx/xxx
  hash: <规范化内容指纹 sha256 前 16 位>
  rev: <document_revision_id>  # 远端上次已知修订号
  syncedAt: 2026-09-21T10:00:00Z
```

### 1.2 幂等键优先级（查找顺序）

1. frontmatter `feishu.token` ⇒ update / skip
2. 中心索引 `.feishu-sync.json`（`{ vaultId: { relPath: { token, hash } } }`，兜底 frontmatter 被清/首轮补写）
3. 远端标题匹配（`docs +search` 精确同名 + 父节点一致）⇒ 认领并补写 frontmatter
4. 都不中 ⇒ create

> 重命名/移动：token 优先，路径仅作 fallback ⇒ 不产生重复文档。

## 2. 指纹与更新判定

### 2.1 规范化规则（算 hash 前）

- 剥离 frontmatter（`---` 块）
- 剥离 `feishu` 块与 `syncedAt` 类时间字段
- 统一换行 `\r\n → \n`、去行尾空白
- 本地绝对路径 → 相对路径（`file:///...`、`G:\...` 归一）
- 图片引用统一为「可移植相对路径」（媒体库引用先本地化，见 §3）

### 2.2 判定矩阵

| hash 相同 | rev 相同 | 动作 |
|---|---|---|
| ✓ | ✓ | **skip（零 API）** |
| ✗ | ✓ | update（整篇替换） |
| 任意 | ✗（远端被手改） | 默认本地覆盖 + warning；可配 skip 并报告冲突 |

### 2.2.1 远端手改检测：`remoteHash` 口径（v1 实测修正）

⚠ **v1 API 的 `docs +fetch` 不返回 `revision_id`**（实测，且 v1 已 deprecated）⇒ 规格原定的 `rev` 比对不可用。

替代实现（已落地）：frontmatter 记录 **`remoteHash` = 同步完成后 fetch 远端 markdown 算出的指纹**。
- 检测：update 前 fetch 远端算指纹，与 `remoteHash` 不一致 ⇒ 远端被手工修改
- ⚠ **不能拿本地原文 `hash` 比**：远端 markdown 是飞书转换后的形态（表格变 `<lark-table>`、编号重排）
  ⇒ 两端天然不同，会比出 100% 误报
- 策略：`--on-conflict overwrite`（默认，本地覆盖 + 警告）/ `skip`（跳过并记 `CONFLICT-SKIP` 到日志）
- ⚠ 顺序要求：**图片插入必须在记录 `remoteHash` 之前**（插图会改变远端内容，否则下次误报冲突）

### 2.3 更新方式

- **v1 整篇替换**：`lark-cli docs +update --command overwrite --doc-format markdown`
  理由：幂等、无累积漂移、图片换图（image block 不可原地替换）一并解决。
  ⚠ **官方警告：`overwrite` 会清空文档后重写，可能丢失图片与评论** ⇒ 语义为「本地覆盖」，飞书侧的手工评论/图片
  不保留（与「本地是 source of truth」一致，但需在 UI 提示用户）。图片会在本次替换中重新上传（见 §3 缓存）。
- v2 优化：block 级 diff 局部替换（`block_replace` / `block_insert_after` / `block_delete`，需 `docs +fetch --detail with-ids`
  配合 `--scope` 局部取 block ID）——大文档省流量/配额且保留评论。

### 2.4 目标位置（个人知识库）

`docs +create` 支持 `--parent-position my_library`（直接建到个人知识库）或 `--parent-token <folder_token>`；
挂到**知识库 wiki 树**则用 lark-wiki 的节点命令（`wiki nodes create/move`）并在 frontmatter 记 `type: wiki` + `space/parent`。

## 3. 图片

### 3.1 实测结论（重要）

**飞书 markdown 导入不处理本地图片**：`![](x.png)` 会被转成 `<image token="" width="100" height="100"/>`
（**空 token 占位**，图片实际丢失）；`![[x.png]]`（Obsidian embed）原样保留为纯文本。
⇒ 必须走「上传 + 定位插入」链路。

### 3.2 已落地实现（占位 → 插图 → 删占位）

```
1. 预处理：本地图片引用（![](x.png) / ![[x.png]]）替换为占位标记 KBSYNCIMG<N>
2. 同步：create / update（占位随正文一起写入）
3. 逐张：docs +media-insert --doc <token> --file <相对路径> --type image \
          --selection-with-ellipsis "KBSYNCIMG<N>"     # 4 步编排：定位→建块→上传→绑定
4. 删除占位：docs +update --mode delete_range --selection-with-ellipsis "KBSYNCIMG<N>"
5. 记录 remoteHash（必须在插图之后）
```

- ⚠ **`--file` 只接受「当前目录内相对路径」**（与 `--markdown @file` 同约束）⇒ 执行时 `cwd` 设为笔记目录
- ⚠ `media-insert` 把图片插到**匹配块的顶层祖先**（若占位在表格/嵌套列表里，图片会落容器外）⇒ 占位应独立成段
- 失败时保留占位文本（便于人工定位），不阻塞其它图片
- 引用形态覆盖：`![](相对路径)`、`![[x.png]]`、`![](saros-media://<id>)`（先「保存到笔记」沉淀拿到本地路径）；
  `http(s)` 外链与绝对路径**不处理**（保持原样，由使用者决定）
- 缓存 `(docToken, imgSha256) → file_token` 尚未实现（同一图重复出现会重复上传；待优化）

## 4. 布局映射（md → 飞书）

| 本地 | 飞书 | 处理 |
|---|---|---|
| `#`/`##`/`###` | heading1/2/3 | 直接映射（保真度高） |
| 表格 / 代码块 / 列表 | 原生 | 直接映射 |
| `> [!note]` callout | 高亮块 | 类型→色板映射表；不支持则退化为引用块 |
| `[[笔记]]` 双链 | 文档链接 | 目标已同步 ⇒ `[title](feishu.url)`；未同步 ⇒ 纯文本 |
| `![[笔记]]` 笔记 embed | 链接 + 引用块 | 降级为「链接 + 摘要引用」 |
| Mermaid 代码块 | 不支持 | 本地渲染 PNG（复用 `mermaidInlineRenderer`）走图片链路 |
| `((blockref))` / 反链 / 图谱 | 无对应物 | 降级纯文本（**诚实边界**） |
| 目录层级 | wiki 节点树 | `库/A/B/x.md` ⇒ 节点 `A / B / x`（space 下按一级目录建父节点） |
| overview / .overview | wiki 节点引导页 | 作为父节点描述/首屏文档 |

## 5. 定时与增量

- 调度：`agentSchedulerService.registerCron({ name: 'kb-feishu-sync', cronExpression: '0 */30 * * * *' })`
  （产品化）；CLI 阶段可用 CodeBuddy automation 或手动触发。
- dirty 集：`mtime > lastSyncAt` **或** 指纹 ≠ `feishu.hash`。
- 限速：飞书 API 按 QPS 节流；单篇独立事务（失败不阻塞其他）。
- 报告：`{ created, updated, skipped, conflicts, failed[] }`，落 `.feishu-sync-log.json` + 通知。
- 首轮建议：**白名单目录 + 单篇验证 → 单目录 → 全量**。

## 6. 调用序列草案（lark-cli 阶段）

```bash
# 0) 认证（设备码流程；user 身份才能进个人 wiki）
lark-cli auth login --no-wait --domain docs --domain drive --domain wiki
lark-cli auth login --device-code <code>          # 用户浏览器授权后完成

# 1) 定位/创建 wiki 节点
lark-cli wiki spaces list
lark-cli wiki nodes list --space <space_id> --parent <parent>
lark-cli wiki nodes create --space <space_id> --parent <parent> --title "概念"

# 2) 创建文档（markdown 直传，保真；图片路径由 CLI 处理）
lark-cli doc +create --title "GC 机制" --markdown "$(cat note.md)" --folder <token>

# 3) 更新已有文档（整篇替换）
lark-cli doc +update --token <docx_token> --mode replace --markdown "$(cat note.md)"

# 4) 回写 frontmatter（应用层，脚本负责）
```

## 7. 验证清单（首轮）

- [x] `lark-cli auth login` 完成（user 身份，docs/drive/wiki 域）
- [x] 单篇无图笔记 create → frontmatter 回写 → 再跑一次 skip（零调用）
- [x] 修改正文 → update（表格/代码块/列表保真 ✓）
- [x] 带图笔记（2 张图）验证图片链路：`<image token>` 非空 ✓、占位已清除 ✓
- [x] 全量 61 篇同步完成（create=0 / skip=61 终态）
- [ ] wiki 层级：目录 → 节点树（未做树形映射，当前为 my_library 平铺）
- [x] 冲突检测：remoteHash 口径已实现（逻辑验证）
- [ ] 定时：已配置 IDE automation（工作日 10:00）

## 8. 真机坑清单（实测踩到，务必遵守）

| # | 坑 | 结论/对策 |
|---|---|---|
| 1 | 本机 CLI 1.0.27 是 **v1 参数形态** | `--title` / `--markdown` / `--mode` / `--doc`；技能文档里的 v2 写法（`--content`/`--parent-position`/`--doc-format`）不适用，且 CLI 明确警告**不要混用版本** |
| 2 | `--markdown @file` 与 `--file` **只接受「当前目录内相对路径」** | 必须 `mkdtempSync` + `cwd` 指向目标目录 + `@./note.md` |
| 3 | **Windows 命令行长度限制（32K）** | 长文档必须走 `@file`，不能塞进 argv |
| 4 | 创建返回形态是 **`data.doc_id` / `data.doc_url`**（wiki URL） | 解析必须宽松匹配 `doc_id|document_id|node_token|objToken` + `url|doc_url`；⚠ 曾因未识别 `doc_id` 导致「创建成功但未记账」 |
| 5 | **`done` 计数不增导致雪崩** | 失败若不计入 `done`，`--limit 1` 会把全部笔记都试一遍 ⇒ 见 §9 事故。已修：失败也 `done++` |
| 6 | 表格内 `[[a\|b]]` 的 `\|` 冲突 | 飞书导入会把行内 `\|` 当表格分隔符**截断后续内容** ⇒ 同步前把 `[[a\|b]]` 替换为别名 `b` |
| 7 | 注入 `# {title}` 造成重复 H1 | 文档标题已由 `--title` 设置 ⇒ 正文不再注入 H1 |
| 8 | `docs +fetch` v1 无 `revision_id` | 用 `remoteHash` 指纹替代 rev 比对（§2.2.1） |

## 9. 事故记录：61 篇孤儿文档（2026-09-21）

- **现象**：飞书个人知识库中出现重复文档（同一笔记 2 份：一份已记账、一份孤儿）
- **根因**：脚本早期版本解析返回失败（坑 #4）且失败不计入 `done`（坑 #5）⇒ 一轮 `--limit 1` 实际把 61 篇全部创建成功、但全部未回写 frontmatter
- **证据**：`.feishu-sync.log` 中 61 行 `FAILED … 响应中无文档标识`
- **本地侧影响**：无（本地 61 篇状态一致，dry-run 显示 create=0 / skip=61）
- **飞书侧影响**：61 篇孤儿文档，需清理（待用户确认；`drive +delete` 可删，但不可逆）
- **修复**：失败计入 `done` + 返回解析宽松化（两处均已在当前脚本中）
- **教训**：**写入类 API 的「成功但没记账」是最危险的状态** —— 既会重复创建，又会因重试放大；
  凡有 `--limit`/批次概念的执行器，失败必须计入配额

## 10. 定时同步与开关（automation `kb`）

- **定时任务**：IDE automation `kb`（名称「KB → 飞书知识库增量同步」，`FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=10`，
  cwds = 本工作区）执行 `--apply`。
- **开关判定（任务第一步）**：读取**两个**配置项，为「与」关系，均需 true 才执行：
  - `sessions.agentStudio.kb.feishu.enabled` —— 飞书同步总开关
  - `sessions.agentStudio.kb.feishu.autoSync` —— **定时同步开关**（默认 false）
  - 读取位置：工作区设置 `.vscode/settings.json` **与** 用户设置 `%APPDATA%\VsSaros\User\settings.json`
  - 判定：
    · `enabled` 未设置/false ⇒ 跳过，提示启用总开关；
    · `enabled` 为 true 但 `autoSync` 未设置/false ⇒ 跳过，提示开启「允许定时自动同步」；
    · 两者均 true ⇒ 执行同步。
  （两个键的 schema 默认均为 false，即「未显式开启 = 不同步」。）
- **手动同步不受开关约束**：设置面板的「预览同步计划 / 立即同步到飞书」按钮与命令行始终可用。
- **闭环**：知识库视图 → 设置（⚙）→ 📤 飞书同步 → 勾选「启用飞书同步」，经 `IConfigurationService.updateValue`
  写入**用户设置**，与 automation 读取位置一致。
- **当前状态（2026-09-21）**：两处设置文件均无 `agentStudio.kb.*` 键 ⇒ 两个开关均按默认 false 处理，
  定时任务会跳过；需先在设置面板勾选「启用飞书同步」**与**「允许定时自动同步」（或手动写入两个键为 true）。
