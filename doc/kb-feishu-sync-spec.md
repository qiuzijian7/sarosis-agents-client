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

### 3.1 实测结论（CLI 1.0.9x 复测）

**飞书 markdown 导入不处理本地图片**：`docs +create` 会直接丢弃并告警
`degrade_code=2119 Invalid resource token`；`![[x.png]]`（Obsidian embed）原样保留为纯文本。

### 3.2 已落地实现（占位 → `block_replace` 为 `<img>`，**已真机验证**）

```
1. 预处理：本地图片引用（![](x.png) / ![[x.png]]）→ 占位 KBSYNCIMG<N>
   ⚠ 占位必须**独占段落**（前后补空行）——插图用 block_replace，属「整块替换」
2. 同步：create / update 写入正文（占位随正文一起进入飞书）
3. 定位：docs +fetch --doc <token> --detail with-ids ⇒ 找「文本恰为占位」的块 id
4. 插图：docs +update --doc <token> --command block_replace --block-id <块id> \
          --content '@./repl.xml' --doc-format xml          # repl.xml: <img path="@./x.png"/>
   ⇒ CLI 自动上传本地图片并原位替换（实测返回 block_type: "image"）
5. 记录 remoteHash（必须在插图之后，否则下次误报「远端被手工修改」）
```

- ⚠ **本地图片只支持 `append` / `block_insert_after` / `block_replace` / `overwrite`**
  （`str_replace` 报 `local images and files are only supported with …`）
- ⚠ `<img>` 必须用 **`path="本地相对路径"`**；用 `img_key="<file_token>"` 报 `Image resource resolve failed`
- ⚠ `--content @file` 与 `path="@./x.png"` 的相对路径都基于 **cwd** ⇒ cwd 设为笔记目录，临时 xml 也写在那里（用完即删）
- 行内 / 表格内引用**无法自动插入**（占不了独立段落）⇒ 保留占位文本并**显式告警**（`inline` 列表）
- 图片文件找不到 ⇒ 保留原引用并**显式告警**（`missing` 列表）——不再静默，避免用户误以为已同步
- 引用形态覆盖：`![](相对路径)`、`![[x.png]]`、`![](saros-media://<id>)`（先「保存到笔记」沉淀本地路径）；
  `http(s)` 外链与绝对路径**不处理**（保持原样）
- 缓存 `(docToken, imgSha256) → file_token` 仍未实现（同一图重复出现会重复上传；待优化）

### 3.3 标题同步（**已实现并验证**，CLI 1.0.9x）

`docs +update` 在 1.0.9x 下**没有** `--new-title`（`block_replace` 改 `<title>` 块实测无效，返回 `degrade_code=1011`）
⇒ 改用 **`drive +update-title`**（官方支持 rename「云文档 / wiki 节点」）：

```
drive +update-title --token <docx_token> --type docx --title "<新标题>"    # 实测 data.updated: true
```

- **触发条件**：`collectPlan` 比较「文件名（= 标题）」与 frontmatter 记录的 `feishu.title`
  ⇒ 不一致时**把动作提升为 `update`**（复用同一条通路：冲突检测 / 图片链路 / remoteHash 记录）✓
- **顺序**：必须在「记录 remoteHash」**之前**（标题会进入远端 markdown 的 `<title>` 行）
- **老笔记兼容**：`feishu.title` 为空（尚未记录）⇒ 不因标题触发全量重写；等下次内容变化时自然补记
- 实测：`标题已更新: 位置验证-改名 → 位置验证-最终名`，`drive +inspect` 回读一致 ✓

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
| 1 | ~~本机 CLI 1.0.27 是 v1 参数形态~~ **已升级到 1.0.96（v2 形态）** | 命令契约见 §13；脚本已按 1.0.9x 适配。旧形态命令（`--markdown`/`--mode`/`--wiki-space`）**全部失效** ⇒ 升级 CLI 后必须回归本清单 |
| 2 | `--content @file` 与 `<img path="…">` **只接受当前目录内相对路径** | 必须 `mkdtempSync` + `cwd` 指向目标目录 + `@./note.md` |
| 3 | **Windows 命令行长度限制（32K）** | 长文档必须走 `@file`，不能塞进 argv |
| 4 | 创建返回形态是 **`data.doc_id` / `data.doc_url`**（wiki URL） | 解析必须宽松匹配 `doc_id|document_id|node_token|objToken` + `url|doc_url`；⚠ 曾因未识别 `doc_id` 导致「创建成功但未记账」 |
| 5 | **`done` 计数不增导致雪崩** | 失败若不计入 `done`，`--limit 1` 会把全部笔记都试一遍 ⇒ 见 §9 事故。已修：失败也 `done++` |
| 6 | 表格内 `[[a\|b]]` 的 `\|` 冲突 | 飞书导入会把行内 `\|` 当表格分隔符**截断后续内容** ⇒ 同步前把 `[[a\|b]]` 替换为别名 `b` |
| 7 | 注入 `# {title}` 造成重复 H1 | 文档标题已由 `--title` 设置 ⇒ 正文不再注入 H1 |
| 8 | `docs +fetch` v1 无 `revision_id` | 用 `remoteHash` 指纹替代 rev 比对（§2.2.1） |
| 9 | `FileAccess.asFileUri` 的参数类型是 `AppResourcePath`（字符串字面量联合） | 动态拼接的路径需断言：`as AppResourcePath`（从 `base/common/network.js` 导入类型） |
| 10 | `KbOpStatus` 只有 `'success' \| 'failure'`（**没有 `'error'`**） | `_logOp(code, status, detail)` 传 `'failure'`；自定义字段放进 `detail` |
| 11 | `base/common/path.js` **无 default export** | 用 `import * as path from '.../base/common/path.js'`（或具名导入 `dirname`/`join`） |
| 12 | **CLI 1.0.9x 全面 v2 参数**（升级后实测） | create：`--title --doc-format markdown --content @file`；update：`--command overwrite\|block_replace\|str_replace`；父级：`--parent-position` / `--parent-token` |
| 13 | 类别落点不再有 `--wiki-space` | 改 `wiki +node-create --space-id <id> --title <t>` ⇒ 拿 `obj_token`（写正文）+ `node_token`（搬迁） |
| 14 | `docs +fetch` 返回结构变了 | `--doc-format markdown`，正文在 `data.document.content`（旧为 `data.markdown`）⇒ 不修则 `remoteHash` 恒空、冲突检测**静默失效** |
| 15 | `wiki +node-get` 参数改为 `--node-token` | 可传 node_token / obj_token / URL；旧 `--obj-token` 已不存在 |
| 16 | `docs +media-insert` 移除 `--selection-with-ellipsis`（只能插文末） | 图片改走「fetch with-ids 找占位块 → `block_replace` 为 `<img path="@./x.png"/>`」（§3.2，已真机验证） |
| 17 | 占位必须**独占段落** | 插图是 `block_replace`（整块替换）⇒ 同段有其它文字会被一起替换掉；行内/表格内引用无法自动插图（保留占位+告警） |
| 18 | `migrateIndexEntries` 必须**迁移**而非删除条目 | 若只删旧路径条目，而该文档本轮因「无需处理」被 `continue`，索引记录会**永久丢失** ⇒ 之后读不到 `prevSpace`，跨知识库搬迁永远不再触发（E2E 实测踩到） |

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
- **闭环**：知识库视图 → ⚙ 设置（在**中间栏 EditorPane** 中打开，原侧栏下拉形态已废弃）→ 📤 飞书同步 →
  勾选「启用飞书同步」，经 `IConfigurationService.updateValue` 写入**用户设置**，与 automation 读取位置一致。
- **当前状态（2026-09-21）**：两处设置文件均无 `agentStudio.kb.*` 键 ⇒ 两个开关均按默认 false 处理，
  定时任务会跳过；需先在设置面板勾选「启用飞书同步」**与**「允许定时自动同步」（或手动写入两个键为 true）。

## 11. 脚本内置化与 CLI 检测（2026-09-21 用户拍板）

### 11.1 同步脚本内置（不要外部实现）

- 脚本随产品发布：**`resources/.agents/kb/feishu-sync.mjs`**（与 `resources/.agents/skills/` 同级）。
  ⇒ 用户无需自备脚本，也**不再暴露「脚本路径」配置项**（原 `feishu.scriptPath` 已移除）。
- 产品侧定位：`browser/knowledge/feishuSyncCore.ts#resolveSyncScript`，多候选（按可靠性）：
  1. `FileAccess.asFileUri('vs/../../resources/.agents/kb/feishu-sync.mjs')`（dev / 打包通用，与技能目录同策略）
  2. `<appRoot>/resources/.agents/kb/feishu-sync.mjs`
  3. `<dirname(appRoot)>/resources/...`（appRoot 位于 out/ 子目录的布局）
  4. `<process.resourcesPath>/app/resources/...`（安装包布局）
  全部不存在 ⇒ 面板与执行前均给「安装可能不完整」提示（不静默失败）。
- 开发期副本：`.codebuddy/kb-feishu-sync.mjs`（保持与内置脚本一致，仅用于本工作区命令行调试）。

**`--parent` 语义（面板显示为「同步到」）**：

| 取值 | 脚本翻译为 | 落点 |
|---|---|---|
| `my_library`（默认） | `docs +create --wiki-space my_library` | 飞书**个人知识库**（wiki 空间） |
| 其它（文件夹 token） | `docs +create --folder-token <token>` | 飞书**云空间指定文件夹** |

⚠ 仅在**新建**文档时使用；已同步文档走 `docs +update --doc <token>`，**位置不变**。
（面板标签原为「目标位置」，因自解释性差已改为「同步到」并加说明行 —— 用户反馈 2026-09-21。）

### 11.2 飞书 CLI 检测（lark-cli 是外部依赖）

- 检测：`feishuSyncCore.ts#detectLarkCli` —— 经主进程通道 `vscode:execCode`（与 `execute_code` 同一原语）
  跑 `lark-cli --version` 判安装，再跑 `lark-cli auth status` 判登录态。
- 三态语义（**不误报**）：`installed`（含版本 / 登录态）/ `missing`（命令不可用）/ `unknown`（执行通道不可用，如实说明）。
- UI：设置面板「飞书 CLI」行 = 路径输入（`feishu.cliPath`，默认 `lark-cli`）+ 「🔄 重新检测」+ 状态文案；
  「立即同步」前也做一次预检，未安装则**直接给安装引导并中止**（不让脚本跑到一半失败）。
- 自定义路径：`feishu.cliPath` 非默认值时，执行命令追加 `--cli <path>` 透传给脚本（脚本内 `CLI` 变量替代硬编码
  `lark-cli`）；因脚本仍硬编码默认名，安装到非 PATH 位置**必须**走这个选项。
- ⚠ 未安装时的引导文案明确「安装并确保在 PATH 中，或填写可执行文件完整路径」——**不假设**具体安装方式。

### 11.3 CLI 升级（真机接口，2026-09-21 实测）

- **权威接口**：
  - `lark-cli update --check --json` —— **只读检查**，实测返回
    `{ action: "update_available", current_version: "1.0.27", latest_version: "1.0.96", message, url, changelog, auto_update, ok }`
    （已是最新时 `action: "up_to_date"`）
  - `lark-cli update` —— 升级，**自动识别安装方式**（npm 全局 ⇒ `npm i -g @larksuite/cli@<version>`；
    手动安装 ⇒ 输出 GitHub Releases 下载地址）
  - 其它：`--force`（强制重装）、`--json`（结构化输出）
- 实现（`feishuSyncCore.ts`）：
  - `parseUpdateCheck`：JSON 优先（括号配对提取，容忍前置彩色码/日志行），文本回退解析
    `Update available: 1.0.27 -> 1.0.96`；无法解析 ⇒ `undefined` ⇒ **不误报可升级**
  - `hasUpdate`：仅 `action === 'update_available'` 或版本号确有差异才为真
  - `checkCliUpdate`：`update --check --json`（短命令通道，15s 超时）；`buildUpgradeArgs()` ⇒ `['update']`
- UI（设置面板「飞书 CLI」区）：`🔄 重新检测` 同时检查更新；检测到可升级时显示
  「⬆️ 可升级：1.0.27 → 1.0.96」+ `⬆️ 升级 lark-cli` + `📄 查看版本说明`（打开 Release 页，可从检测结果取 URL）。
- ★ 升级走**终端**（`executable = cliPath`、args = `['update']`、`waitOnExit`）：下载耗时较长，
  终端可见进度、失败可读 ⇒ 不适合单次缓冲的短命令通道；升级后提示点「重新检测」刷新版本与登录态。
- 未安装时**不做**更新检查（无意义且会误导）。

### 11.4 执行器：Electron 自带 node（2026-09-21 用户要求）

目标：同步执行**不依赖用户系统安装的 node**。

做法（仍是终端执行，但换执行器）：

```
createTerminal({ config: {
  executable: <Electron 二进制路径>,        // = process.execPath
  args: [内置脚本, ...buildSyncArgs(...)],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  cwd, waitOnExit: true,
} })
```

- helper：`feishuSyncCore.ts#electronNodeLaunch()`（复用 common 层既有的 `nodeExecPath()` 防御式读取）。
- ⚠ **必须带 `ELECTRON_RUN_AS_NODE=1`**：`process.execPath` 在 Electron 里是 Electron 二进制，
  直接跑 `.mjs` 会被当作 app 入口加载后立即退出（既有范式见 `electron-main/configHtmlServerChannel.ts:140-146`）。
- ⚠ **`env` 必须保留完整进程环境**：脚本内部仍要 `spawn('lark-cli')`，丢掉 PATH ⇒ 「CLI 明明装了却找不到」。
- 取不到 Electron 路径 ⇒ 回退系统 `node`（保持可用，不硬失败）；实际执行器记入操作日志
  `feishu.sync` 的 `detail.runner = electron-node | system-node`。

**实测记录（本机 2026-09-21）**：

| 项 | 结果 |
|---|---|
| Electron 二进制以 node 模式执行 JS（`.build/electron/VsSaros.exe` + flag） | ✅ `NODE=v22.22.1` |
| 该环境下子进程调用 CLI：`spawnSync('lark-cli', ['--version'])` | ✅ `STATUS=0`，输出 `lark-cli version 1.0.27`（**PATH 有效**） |
| 内置脚本在 **Electron-as-node + 无控制台（管道/重定向捕获）** | ⚠ 未见 stdout（exit=0） |
| 内置脚本在 **PTY 终端**下（本产品实际路径） | 未能本机模拟验证 |

| 内置脚本在 **Electron-as-node** 下（修复入口守卫后重测） | ✅ `--help` 与 dry-run 输出均正常 |

⚠ **曾误判为「无控制台时 stdout 丢失」**：当时资源副本运行零输出（exit=0）被归因于输出通道。
**真因是脚本末尾入口守卫写死了 `endsWith('kb-feishu-sync.mjs')`**，而内置副本名为 `feishu-sync.mjs`
（资源目录去掉了 `kb-` 前缀）⇒ **`main()` 从不执行**（静默、退出码 0）。已改为宽松匹配 `*feishu-sync.mjs`。
★ 教训：**「进程正常退出但零输出」优先怀疑入口/守卫条件不匹配，而非输出通道**；
素材/脚本**改名（加去前缀）必须同步检查所有按文件名判断的代码**。

⇒ 仍**以 `.feishu-sync.log`（脚本自行逐篇落盘）作为结果兜底**：面板「📄 查看同步日志」可核对
create/update/skip/move 与失败原因（对自动化任务等捕获场景尤其有用）。

### 11.5 多类别 → 多飞书知识库（2026-09-21 用户确认后实现）

**用户决策**：① 类别 = 同步源目录下的**一级目录**；② 未映射类别**自动创建**同名知识库；
③ 本地删除**默认保留远端**，可显式开启清理。

- **索引 v2**（`<vault>/.feishu-sync.json`）：
  `{ version: 2, spaces: { <类别>: { spaceId, name, createdAt } }, files: { <相对路径>: { token, hash, space, node, url } } }`
  - 读取时**自动兼容 v1 扁平结构**（顶层 `{路径:{token,hash}}` ⇒ 迁入 `files`）
  - 新增字段：`space`（知识库 id）、`node`（wiki node_token —— 跨知识库移动需要）
- **脚本新增参数**：`--category-depth N`（默认 1；0 = 不分类别）/
  `--auto-create-spaces`、`--no-auto-create-spaces`（默认**开**）/ `--prune`（默认**关**）
- **同步行为**：
  - 每个类别查 `spaces` 映射 ⇒ `docs +create --wiki-space <spaceId>`；未映射且开关开 ⇒
    `wiki +space-create --name <类别名>` 建库并记入映射
  - **类别变更**（`files[rel].space` ≠ 目标知识库）⇒ `wiki +move --node-token <node> --target-space-id <new>`
    跨知识库搬迁；`node` 缺失时用 `wiki +node-get --obj-token <docToken>` 反查
  - **仅类别变化、内容未变**（skip + needsMove）⇒ **只搬迁**节点 + 更新 frontmatter/索引，不重写正文
  - `--prune`：索引中本地已不存在的条目 ⇒ `wiki +node-delete --node-token <node> --yes`（默认不做）
  - ⚠ v1 索引没有 `space` 记录 ⇒ 首轮会把全部已同步文档视为「需搬迁」（`move` 幂等；
    已在目标库时由飞书返回错误并记入日志，不影响内容更新）
- **产品侧**：新增配置 `feishu.categoryDepth`（number，默认 1）/ `feishu.autoCreateSpaces`（boolean，默认 true）/
  `feishu.pruneRemote`（boolean，默认 false）；面板「飞书同步」区新增「类别层级 / 自动建库 / 删除清理」三行控件。
- **实测（本机，2026-09-21）**：dry-run 正确识别 **10 个类别**、预告「将创建 10 个知识库 + **搬迁 58 篇**」。
  ⚠ **尚未执行 apply** —— 它会创建 10 个真实知识库并把 58 篇移动过去，需用户确认后再跑。

## 12. 测试与验证（2026-09-21 新增）

### 12.1 自动化测试 `kbFeishuSyncScript.test.ts`（35 例，全绿）

| 分区 | 覆盖内容 |
|---|---|
| 指纹口径 | 剥 frontmatter（回写不触发 update）/ CRLF / 本地绝对路径归一 ⇒ 不误判「内容变了」；正文真变 ⇒ 指纹必变 |
| frontmatter | 无 frontmatter / 有其它键 / 重复写入幂等 / 正文 `---` 不破坏 |
| markdown | 表格内 `[[a\|b]]` 截断修复、`[[a]]` 保留、表格·代码块·列表逐字保真 |
| 图片抽取 | embed 与 md 两种引用、多图编号、文件缺失保留原样、远程/绝对路径/非图片不处理 |
| 类别推导 | depth 0/1/2、src 根下文件 ⇒ null、前缀不匹配 ⇒ null |
| 索引 | 缺失/损坏 ⇒ 空结构、v1→v2 迁移、save/load 往返 |
| **改名 / 移动** | 改名后仍 update/skip（**绝不 create**）、索引旧条目可迁移（**否则 prune 误删远端**）、换类别 ⇒ targetSpace + needsMove、未映射 ⇒ null、新建文档不搬迁 |
| **类别改名** | 复用原 spaceId（映射键迁移）、不重复迁移、无历史 ⇒ 交自动建库 |
| 返回解析 | `doc_id`/`document_id`/`node_token` + `doc_url`/`url` 兼容（§9 事故防回归） |

运行：

```
node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
     src/vs/sessions/contrib/agentStudio/browser/knowledge/kbFeishuSyncScript.test.ts
```

### 12.2 测试暴露并已修复的两个真实缺陷

1. **改名 / 移动后历史丢失**：`collectPlan` 只按**路径**查索引 ⇒ 改名或换目录后 `prevSpace`/`prevNode` 为空
   ⇒ 「类别改名」被误判为新类别（新建多余知识库）、搬迁还需额外 API 反查旧节点。
   **修**：按 frontmatter `token` 反查历史记录（`byToken` 兜底）✓
2. **prune 误删风险**：索引里「同 token 的旧路径」残留会被 `--prune` 当成「本地已删除」⇒ 删掉远端节点（数据丢失级）。
   **修**：`migrateIndexEntries`（写回前迁移旧条目）+ prune 内 `liveTokens` 保险丝（仍被现存文档引用的 token 绝不删）✓

### 12.3 真机端到端清单（需用户确认后执行；会在飞书产生测试知识库）

| 步骤 | 验证点 |
|---|---|
| 沙盒建 `库/_feishu-sync-test/01-测试类别/格式验证.md`（含表格 + 代码块 + 图片 + wikilink） | 格式保真 |
| `--apply` | 自动创建/复用知识库「01-测试类别」+ 创建文档 |
| `docs +fetch` 看远端 markdown | 表格变 lark-table、图片 `token` 非空、`[[a\|b]]` 已替换为别名 |
| 本地**改文件名** → `--apply` | 远端仍是**同一篇**（token 不变）+ 标题更新 + 无新增副本 |
| 本地**移到另一类别目录** → `--apply` | 节点被 `wiki +move` 到目标知识库（`wiki +node-list` 可核对） |
| 本地**改类别目录名** → `--apply` | 复用原知识库（不新建）、文档位置不变 |
| 开 `--prune` 删除一篇 → `--apply` | 仅该篇远端节点被移除；**改名残留不被误删** |

清理：测试产生的知识库用 `lark-cli wiki +delete-space` 删除（或保留为样例库）。

### 12.4 真机 E2E 结果（2026-09-21 已执行，CLI 1.0.96）

沙盒：`库/_feishu-sync-e2e`（格式样本 + 类别样本 + 本地图片）

| 场景 | 结果 | 证据 |
|---|---|---|
| 格式保真 | ✅ 标题 / H2 / 代码块（python）/ 嵌套列表 / 加粗斜体 **全部保真** | `docs +fetch` 回读比对 |
| 表格 + wikilink | ✅ 预处理后 `\| 双链别名 \| 知识库首页 \| 待验证 \|` **三列完整** | ⚠ 对照组（不预处理）实测被拆成两列且第三列丢失 ⇒ 印证 §8#6 修复必要 |
| 图片（2 张） | ✅ 远端生成真实图片块（`feishu.cn/file/…`、`block_type: image`），占位消失、位置正确 | `docs +fetch --detail with-ids` |
| 无类别文档落点 | ✅ `my_library`（`--parent-position`） | 索引 `space: my_library` |
| 类别文档落点 | ✅ 自动建知识库 + `wiki +node-create` 建节点（记 `space`/`node`） | 索引 + frontmatter |
| **改文件名** | ✅ 识别为 **update 同一篇**（token 不变、**未重复创建**），索引条目被迁移 | `[update] ✓ … → B9PQd8…`、`[索引] 迁移改名/移动记录：…` |
| **换类别目录** | ✅ 自动创建目标知识库 + `wiki +move` 搬迁；`wiki +node-list` 确认节点已在目标库 | `[move] ✓ … → 知识库「98-e2e-类别B」` |
| **类别目录改名** | ✅ 映射复用原知识库（**不新建**），文档位置不变（无需搬迁） | `[space] 类别改名：映射「…B」→「…B-改名」（复用 7687902…）` |
| **标题跟随文件名** | ✅ **已实现**（§3.3：`drive +update-title`）⇒ `标题已更新: 位置验证-改名 → 位置验证-最终名` | `drive +inspect` 回读标题一致 |

### 12.5 E2E 暴露并已修复的三个缺陷

1. **索引记录永久丢失**（最严重）：`migrateIndexEntries` 只删旧路径条目，而该文档本轮可能因「内容未变、无需处理」被 `continue` ⇒ 新条目从未写入 ⇒ `prevSpace` 丢失 ⇒ **跨知识库搬迁永远不再触发**。
   **修**：迁移条目（`idx.files[新路径] = 旧记录`）而非删除 ✓（§8#18）
2. **「文档换目录」被误判为「目录改名」**：两者数据特征相同 ⇒ 误复用旧知识库（新类别不建库、文档也不搬迁）。
   **修**：加入文件系统判据——**旧类别目录是否仍存在**（存在 ⇒ 换目录；不存在 ⇒ 目录改名）✓
3. **无类别文档自我搬迁**：`prevSpace=''` 与目标 `my_library` 不等 ⇒ 每次同步多一次无谓 `wiki +move`。
   **修**：`needsMove` 要求 `prevSpace` 非空；无类别文档的目标落点显式记为 `my_library`（`computeTargets` 增 `parentSpace` 参数）✓

> 另新增两类**显式告警**（此前静默保留、用户会误以为已同步）：「图片引用找不到文件」与「行内/表格内图片无法自动插入」。

## 13. CLI 1.0.9x 参数契约（脚本唯一真源，2026-09-21 实测）

| 用途 | 命令（**当前 CLI 形态**） | 关键返回 |
|---|---|---|
| 建文档（无类别） | `docs +create --title T --doc-format markdown --content @./note.md --parent-position my_library` | `data.document.document_id` / `url` / `revision_id` |
| 建 wiki 节点（类别） | `wiki +node-create --space-id <id> --title T` | `data.node_token` / `obj_token` / `space_id` / `url` |
| 写正文 | `docs +update --doc <token> --command overwrite --doc-format markdown --content @./note.md` | `ok: true`；失败含 `error.message` |
| 读正文（指纹核对） | `docs +fetch --doc <token> --doc-format markdown` | `data.document.content` |
| 读结构（找块 id） | `docs +fetch --doc <token> --detail with-ids` | DocxXML（含 `id="…"`） |
| 插图 | `docs +update --doc <token> --command block_replace --block-id <块id> --content @./repl.xml --doc-format xml` | `data.document.new_blocks[]`（`block_type: image`） |
| 建知识库 | `wiki +space-create --name N --as user` | `data.space_id` |
| 搬节点 | `wiki +move --node-token <node> --target-space-id <spaceId>` | `ok: true` |
| 列节点 | `wiki +node-list --space-id <id>` | 节点数组（`node_token` / `obj_token` / `title`） |
| 解析节点 | `wiki +node-get --node-token <token\|url>` | `node_token` / `obj_token` |
| 删节点 | `wiki +node-delete --node-token <node> [--include-children=false] --yes` | `ok: true`（`--yes` 为本机实测存在的确认参数） |
| **改标题**（云文档 / wiki 节点） | `drive +update-title --token <docx> --type docx --title "<新>"` | `data.updated` / `data.title` / `url` |

- ⚠ 所有 docs 命令的 `--content` 支持 `@file`（**相对 cwd**）；长文必须走 `@file`（Windows 32K 限制）。
- ⚠ 解析一律**宽松匹配**（`pickDocInfo` / `pickNodeInfo`）：CLI 小版本间字段位置会变
  （如 `data.document.document_id` 与 `data.doc_id`）⇒ 不要写死路径。
- ⚠ **升级 lark-cli 后必须做两件事**（§11.3 升级入口 + 本流程 = 应对 CLI 变更的完整闭环）：
  1. **回归本表**：命令形态可能整体变化（1.0.27 → 1.0.96 换掉了全部参数）；
  2. **重建远端指纹基线**：
     ```
     node .codebuddy/kb-feishu-sync.mjs --vault <vault> --src <src> --refresh-remote --apply
     ```
     原因：`docs +fetch` 的导出格式随版本变化 ⇒ 已记录的 `remoteHash` 与新格式**全面失配**
     （实测：61 篇中 55 篇失配、一致 0）⇒ 若不刷新，下次任何一篇内容变化都会误报「远端被手工修改」。
     `--refresh-remote` 只改本地 frontmatter 的 `remoteHash`（不写远端、不改索引），并顺带为缺失该字段的老笔记补记；
     刷新后 `--dry-run` 应仍为全 `skip`（证明不改变同步语义）。
- `--prune` 依赖的 `wiki +node-delete --yes` 参数**已实测存在**；注意 `--include-children` 默认 `true`（**级联删除子树**）。

## 14. 知识库根目录的「目录思维导图」（mindnote，2026-09-22 新增）

需求：同步文件夹（= 飞书知识库）根目录要有一份**飞书原生思维导图**文档，且新增/改名/移动笔记后自动更新。

### 14.1 形态与位置

- 每个**类别知识库**根下一份，标题固定 `目录思维导图`（`MINDMAP_TITLE`，**不带 emoji** —— 原因见 §14.4#1）
- 结构：根（库名）→ 目录（逐级）→ 笔记标题（叶子）

### 14.2 命令契约（2026-09-22 实测）

| 步骤 | 命令 | 关键返回 |
|---|---|---|
| 建文档 | `wiki +node-create --space-id <id> --title <T> --obj-type mindnote` | `obj_token`（= mindnote_id）/ `node_token` |
| 写节点 | `mindnotes nodes create --mindnote-id <id> --data @nodes.json` | `data.ids[]`（**服务端生成**的 node_id，按请求顺序） |
| 读节点 | `mindnotes nodes list --mindnote-id <id>` | `data.nodes[]`（含 `parent_id`，可还原层级） |
| 删文档 | `wiki +node-delete --node-token <t> --obj-type mindnote --yes` | `ok: true` |

节点 JSON（**三个硬约束**，均逐一实测）：

```json
{ "client_token": "<每次唯一>",
  "nodes": [ { "parent_id": "<已有节点的服务端 id；根层省略>",
               "texts": [ { "element_type": "text", "text": { "content": "文本" } } ] } ] }
```

1. 文本必须是 **`texts[]` + `text.content`**（写成 `text: "串"` 报 `9499`；写成 `text: { text: … }` 报 `99992402 field validation failed`）
2. **不接受自定义 `node_id`**（传了报 `3411001 system internal error`）⇒ id 只能由服务端生成，`parent_id` 必须引用**已存在**的 id ⇒ **必须逐层写**（`writeMindmapTree`：BFS，同层一次批量提交）
3. **`client_token` 是幂等键**：同 token 重复请求被**忽略**（既不重复建、也不更新）；换 token 则**追加** ⇒ 该接口**只增不改**，没有删除/更新节点的能力

### 14.3 更新策略（为什么是「删旧建新」）

因 14.2#3（只增不改）且无节点删除接口 ⇒ 若直接追加，每新增一篇笔记都会让导图**累积一批重复节点**。

⇒ 故：结构指纹（`mindmapHash`）变化时 **删旧文档 → 重建 → 逐层写入**；指纹未变 ⇒ **零 API 调用**。

- ⚠ 代价：每次结构变化后**文档 URL 会变**（旧链接失效）。作为自动生成的导图可接受。
- 记账：索引 `mindmaps[spaceId] = { objToken, nodeToken, hash, title, updatedAt }`
- 开关：`--no-mindmap`；⚠ `my_library`（非 wiki space）**暂不支持**（CLI 无 mindnote 创建途径）

### 14.4 实测坑

| # | 坑 | 现象 | 处理 |
|---|---|---|---|
| 1 | **标题不能含 emoji** | `wiki +node-create` 静默失败（连错误都解析不出来） | `lark()` 在 Windows 用 `shell: true`（`lark-cli` 是批处理）⇒ 参数经 cmd.exe 按**本地代码页**解释 ⇒ emoji 无法表示。标题只用中文 |
| 2 | 节点 `text` 结构 | `9499` / `99992402` | 必须 `texts:[{element_type:'text',text:{content}}]` |
| 3 | 自定义 `node_id` | `3411001 system internal error` | 不传，改用响应 `data.ids[]` |
| 4 | 导图多出无意义层级 | 出现「库 / 知识库根 / 类别」嵌套 | `p.rel` 是**相对 vault** 的 ⇒ 需依次剥掉 `p.src` 前缀与类别前缀 |
| 5 | **`wiki +node-delete` 必须带 `--obj-type`** | 报 `--obj-type is required (one of: …)` | 导图传 `mindnote`；**prune 传 `docx`**（顺手修复，未单独真机验证） |
| 6 | 同层批量依赖顺序 | — | `data.ids[]` 与请求顺序一致；数量不符即**中止**（宁可不写，也不写层级错乱的导图） |

### 14.5 验证记录（2026-09-22）

沙盒 `库/_mindmap-e2e`（4 篇笔记，含 `sub` 子目录、2 个类别）：

| 项 | 结果 |
|---|---|
| 首次同步 | 建 2 个知识库 + 3 篇笔记 + 2 份导图（7 / 5 节点）✓ |
| 导树读回 | `01-目录A → 笔记甲 / sub → 笔记乙` 层级正确 ✓ |
| **新增笔记后** | 导图重建为 5 节点，含新笔记 ✓ |
| **结构未变复跑** | 无任何 mindmap 动作（幂等，零调用）✓ |
| 清理 | 测试知识库 3 个（`ok=true`）+ 本地沙盒 + 索引残留（`spaces`/`mindmaps` 已空）✓ |

## 14. 用户自定义「目录 ↔ 飞书知识库」映射（2026-09-22）

- **配置文件**：`<vault>/.feishu-space-map.json`
  ```json
  { "version": 1, "mappings": [{ "dir": "库/AI/01-基础概念", "spaceId": "769…", "spaceName": "01-基础概念" }] }
  ```
  兼容极简写法：`{ "mappings": { "库/AI/01-基础概念": "769…" } }`
- **语义**：显式映射**优先于**「类别层级」推导；映射目录**及其子目录**的笔记绑定到指定知识库（**最长前缀**匹配）。
  未映射目录仍按 `--category-depth` 推导、必要时自动建库 ⇒ 两种方式可混用（映射目录**不会**被自动建库）。
- **为什么落文件而不是 CLI 参数**：JSON 经 argv 在 Windows（`shell: true`）下会被引号破坏；文件还能让 UI 与脚本读写同一份契约。
- **实现位置**：
  - 脚本：`SPACE_MAP_FILE` / `loadSpaceMap()` / `applyExplicitMappings()`（导出的纯函数，有单测）。
    ⚠ 调用必须**最早**（先于 `categories` 计算与自动建库）——否则映射目录会被当成「新类别」多建一个无用知识库（真机验证踩到）。
  - TS：`feishuSyncCore.ts` 的 `parseSpaceMap` / `serializeSpaceMap` / `parseSpaceList` / `listWikiSpaces`
    （`wiki +space-list --page-all --format json`；这是本仓库**首个**列取飞书知识库的能力）。
  - UI：设置面板「📤 飞书同步 → 目录映射」= `＋ 添加目录` + 每行「知识库下拉」+ `🗑` + `🔄 刷新知识库列表`；
    host 扩展 4 个方法（`loadSpaceMap` / `saveSpaceMap` / `listSpaces` / `pickDirForMapping`，目录限定在 vault 内）。
- **新建知识库**（面板内置）：目录映射的下拉首项是「＋ 新建飞书知识库…」⇒ 弹输入框填写名称 ⇒
  `wiki +space-create --name "<名称>" --as user` ⇒ 成功后自动选中并写回映射。
  名称先经 `sanitizeSpaceName()` 去掉 `"` 与换行（CLI 走 shell ⇒ 不净化会被引号破坏）；失败在面板给出原因（未装 CLI / 未登录）。
- **验证**（真机 dry-run）：`库/_feishu-map-test/01-x → FAKE_SPACE_0001`（映射生效、**不建库**）；
  `02-y → (将创建)`（未映射照旧自动推导）；`将创建知识库 1 个：02-y` ✓

## 15. 导入链接 / URL（2026-09-22 实现）

**链路**：库分区工具栏「🔗 导入链接」→ 输入 URL →

1. **正文**：`IWebContentExtractorService.extract()`（主进程 reader-mode；`redirect` 重抓一次；`error` 直接回报）；
   降级：`IRequestService.request({type:'GET'})` + `htmlToPlainText()` 兜底。
2. **图片本地化**：`ISharedWebContentExtractorService.readImage()`（共享进程读二进制，不受 renderer CSP 限制）
   → 落 `库/raw/assets/<slug>/<序号>-<名>.<ext>` → `rewriteMarkdownImageUrls()` 把远程引用改写为**相对 md 目录**的本地路径。
3. **组装**：`composeArticleMarkdown()`（标题 / 作者 / 来源 / 日期 / 封面本地路径）。
4. **落盘**：`库/raw/<slug>.md`（同名自动 `-2`/`-3`，不覆盖）⇒ 之后可「构建为笔记」。

- **为什么必须图片本地化**：飞书同步只认**本地相对引用**（§3）；远程 `https://` 图会被当成「未找到文件」跳过。
  改写后的相对路径同时满足两处基准：笔记预览 `resolveAssetSrc`（相对笔记目录）与 `feishu-sync extractImages`（`path.dirname(note)`）。
- **平台识别**：`kbUrlScraper.KB_URL_PLATFORMS`（小红书 / 抖音 / B站 / YouTube / 微博 / 公众号 / 知乎 / 掘金 / CSDN / 飞书 + 通用兜底）。
- **实现位置**：`kbImportController.importUrl()`（**静态**方法，服务由调用方注入 ⇒ 不改类构造签名）；
  视图 `knowledgeBaseView.importFromUrl()`（已注入两个提取器服务）+ library 分区工具栏按钮。
- **视频（yt-dlp 扩展点，2026-09-22 已接）**：平台为 video / mixed（抖音 / B站 / YouTube / 快手 / TikTok / 微博）时，
  先用 **yt-dlp** 取元信息（标题 / 时长 / 封面 / 作者 / 发布日期 / 简介）：

  ```
  yt-dlp --no-playlist --no-warnings --skip-download --print "<6 字段，||| 分隔>" "<url>"
  ```

  - ⚠ 用 `--print` 而**非** `--dump-json`：主进程命令通道（`vscode:execCode`）是**单次缓冲**，dump-json 含 `formats` 数组可达数百 KB；
  - ⚠ 字段分隔用 `|||`（TAB 经 shell 传递易被规范化）；`parseYtDlpPrint()` 同时兼容真实 TSV，`NA` 视为空；
  - 封面本地化后交给 `composeVideoMarkdown()`（含「未下载本体」说明 + 原文链接），抓到正文时附在 `## 正文`；
  - **未安装 / 未登录 / 抓取失败 ⇒ 自动降级为「仅记链接 + OG 元数据」**，不中断导入（单测覆盖该降级路径）；
  - **刻意不下载视频本体**：几十 MB～GB 会拖慢索引与飞书同步（飞书同步也不处理视频）。需要时自行 `yt-dlp <url>`；
    后续可接 terminal 长任务 + 可执行路径配置项（同 `feishuCli` 模式）。
  - 安装：`pipx install yt-dlp` / `pip install -U yt-dlp` / `winget install yt-dlp`（需在 PATH 中）。
- **内容总结（2026-09-22 扩展）**：
  - **图片**：图片本地化到 `库/raw/assets/<slug>/` 后，「构建笔记」时 `_buildNoteAgentic` 会把**图片清单**注入 prompt，
    并要求 agent 逐张调用 **`vision_analyze`** 总结图片内容（该工具一次只接受一张图 ⇒ 循环，上限 8 张）。
    前提：`knowledge-base-expert` 白名单已加入 `vision_analyze`（`common/builtinAgents.ts`），
    且配置了多模态模型（`AGENT_STUDIO_AUX_VISION_PROVIDER` / `_MODEL`；未配置时自动路由到第一个支持图像的模型）。
  - **视频**：`fetchVideoSubtitles()`（yt-dlp `--write-subs --write-auto-subs --sub-langs "zh.*,en.*"`）
    → `parseSubtitlesToText()` 清洗（去时间轴/序号、**自动字幕重复行去重**、截断 20k 字）
    → 写入素材 md 的 `## 字幕（用于总结视频内容）` 段 → 构建笔记时 agent 据此总结，并把 `> 原文：<url>` 保留在笔记中。
    ⚠ 字幕是**文件**（stdout 单次缓冲装不下）⇒ 先落库内临时目录 `库/.kb-subs-tmp/`，读回后**立即清理**。
  - ⚠ **无字幕视频无法「总结内容」**：项目**没有 ASR**（只有方向相反的 TTS：`generate_audio` / `text_to_speech`），
    纯音乐或无字幕视频只能总结到「标题 + 简介 + 封面」层级；真正转写需新建 ASR（本地 whisper 或云端接口）。
- **已知限制**：强 SPA / 登录墙（小红书详情页等）仍可能只拿到 OG 元数据；`m3u8` 明确不下载
  （`isDownloadableMedia` 排除）；**Playwright / headless 仍是未接的扩展点**（项目内 playwright 目前只服务 browserView 平台层）。
- **验证**：新增纯函数（`slugifyTitle` / `planImagePath` / `htmlToPlainText`）单测 3 例 ✓；`tsgo` 0 ✓；lint 0 ✓。
  **真实抓取需在 IDE 重编译后点按钮**（依赖主进程提取器服务）。
