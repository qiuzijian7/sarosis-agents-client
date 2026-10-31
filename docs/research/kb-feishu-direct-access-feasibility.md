# 调研：dsh 侧知识库能否「不要本地文件」，直接读写飞书知识库

> 结论先行：**能直读直写（飞书开放平台支持），但"完全不要本地文件"意味着重写知识库的存储层** ——
> 实测现有代码有 **367 处直接文件操作、散布 16 个文件**（`index.js` 一个文件就 166 处）。
> 建议走「**飞书库 = 在线库 + 本地缓存副本**」，而不是「零本地文件」。

---

## 1. 现状（本仓**实测**，不是推断）

### 1.1 已经有的飞书能力

| 能力 | 证据 | 方向 |
|---|---|---|
| **读单篇飞书云文档 → markdown** | `lib/index.js` L5061–5077（工具描述："读取飞书/Lark **云文档正文**（转成 markdown ✓，含标题/列表/表格/链接 ✓）"） | 飞书 → 本地（**读** ✓） |
| 列出知识库空间 | `/api/feishu-spaces`、`findSameNameSpace`、`SPACE_LIST_ARGS` | 读元数据 ✓ |
| **同步（上行）** | `scripts/feishu-sync.mjs`：frontmatter `feishu:` 块锚定（token/hash/url/rev/syncedAt），hash 去重，变更走 `docs +update --command overwrite --doc-format markdown` | 本地 → 飞书（**写** ✓） |
| 目录 → 空间映射 | `.feishu-sync.json` v2 含 `spaces`（类别→知识库）与 `files` 明细 | — |
| 定时同步 / 冲突策略 / 限速 | `/api/feishu-schedule`、`conflict: 'skip'`、`intervalMs: 800` | — |

### 1.2 三个关键约束（实测）

1. **底层是外部 `lark-cli`**，不是本仓直接调开放平台 HTTP：
   `runLarkCli()` 用 `spawn`/`spawnSync` 调 CLI（`%APPDATA%\npm\lark-cli.cmd`，Windows 下是 `.cmd` shim，Node 不经 shell 跑不了 —— L182–224 有专门处理）。
   ⚠ **本机当前未安装 lark-cli**（`where lark-cli` 无结果）⇒ 现有飞书能力在你这台机器上现在跑不起来。
2. **单向上行**：规则文件 `doc/kb-feishu-sync-spec.md` 写明"本地 vault 是 source of truth" ⇒ **没有下行（飞书 → 本地）同步**。
3. **需要 user 身份登录**（个人知识库 `my_library` 必须用用户身份，不能用 tenant token）。

---

## 2. 飞书侧能力（**【外部】** 公开资料，非本仓实测）

| 维度 | 支持情况 | 对"当库用"的含义 |
|---|---|---|
| **结构** | 知识库 = wiki 空间，**节点是树形**（`wiki/v2/spaces/:id/nodes`）；节点类型含 `docx` / `sheet` / `bitable` / `mindnote` / `file` | ✅ **天然契合**：wiki 树 ≈ 目录树，node token ≈ 路径 |
| **读正文** | `docx/v1/documents/:id/raw_content`（近似 markdown，含标题/列表/表格/链接）；也可拉 `blocks` 逐块 | ✅ 读可行 |
| **写正文** | 块级 API（创建/更新/删除块），或"整体 overwrite 为 markdown" | ⚠ 可写，但**语义是块** ⇒ markdown ↔ 块有转换与有损 |
| **建文档** | 从 markdown 导入创建文档 / 在空间下建节点 | ✅ 可行 |
| **并发** | 文档有 `revision_id` | ⚠ 可做乐观锁，但要自己实现（我们现在的 git 版本与之无关） |
| **权限** | 需应用作用域（`docx:document`、`wiki:wiki`）+ 用户/租户授权；个人库必须 **user** 身份 | ⚠ 每次写都要带着用户授权；token 会过期 |
| **限频** | 按应用与按文档限流（同步脚本已用 800ms/篇 的保守间隔） | ⚠ 全库操作（建索引、搜索、图谱）若每次都打 API，会被限流打爆 |
| **附件** | 附件是独立 drive 文件，不等于 markdown 里的相对路径 | ❌ 与现有"库/raw 素材"模型不直接对应 |
| **离线** | 无 | ❌ 断网即不可用（与"本地优先"定位冲突） |

---

## 3. 真正的阻力：本仓与"文件系统"的耦合（实测数字）

```
KB 插件直接碰文件系统的地方：
   dsh-plugins/vssaros-kb/lib/index.js              166 处（9038 行）
   dsh-plugins/vssaros-kb/lib/store.js               40 处
   dsh-plugins/vssaros-kb/lib/organize.js            36 处
   dsh-plugins/vssaros-kb/lib/core/kbDocExtract.js   18 处
   dsh-plugins/vssaros-kb/lib/core/kbMindmap.js      18 处
   dsh-plugins/vssaros-kb/lib/client.kb.js           16 处
   … 合计 367 处 / 16 个文件
```

而这些能力**全部建立在"能扫目录 + 能读全文"之上**：

| 能力 | 依赖的文件系统假设 |
|---|---|
| 全文搜索、双链、标签分组 | 遍历 `笔记/` + `库/` 读每个 `.md` 正文 |
| 索引缓存 `.kbkernel.json` / 图谱 / 脑图 | 同上，产物也**落盘** |
| `view-data` 的失效判据 | `笔记`/`库` 两个目录的 **mtime**（L6288 `vaultSigOf`） |
| 版本管理（一库一 git） | 库目录本身就是 git 工作区 |
| 素材区 `库/raw` | 真实文件（PNG/PDF），现已接 LFS |
| 树的渲染 | 目录层级 = 文件层级 |

⇒ 要"零本地文件"，就要把上面每一项改成**远端语义**（分页、限频、无 mtime、有损转换、附件另算），
本质是把 `VaultProvider`（list / read / write / tree / search / stat）这一层**抽出来并重写 16 个文件的调用点**。

---

## 4. 三条路线对比

| | A 同步增强（下行补齐） | **B 飞书库 = 在线库（本地缓存副本）** | C 零本地文件 |
|---|---|---|---|
| 做法 | 本地仍是真源；新增「从飞书拉下来」（按 frontmatter `feishu:` 锚点做增量 pull） | 新增 vault 类型 `feishu`：树/正文**从飞书读**，本地只做缓存与离线兜底；编辑写回飞书 | 完全移除本地目录，一切走 API |
| 本地文件 | 有（真源） | 有（**缓存**，可随时重建） | 无 |
| 搜索/图谱/双链 | 全部照旧 ✅ | 首次建缓存后可跑；增量靠节点版本号 | 需全量改造成远端查询 ⚠ |
| 版本管理 | git 照旧 ✅ | 本地 git 只管缓存 ⚠；**真正的版本应看飞书 revision** | 只能用飞书 revision |
| 冲突 | 本地优先，人工解 | 写回时按 revision 做乐观锁 | 同 B |
| 断网 | 可用 ✅ | 只读缓存 ⚠ | 不可用 ❌ |
| 工作量 | **小（天级）** | **中（周级）** | **大（数周 + 高风险）** |
| 风险 | 低 | 中（转换有损、限频、授权过期） | 高（重构面 367 处） |

---

## 5. 建议路线（按这个顺序，每步都有可用产出）

```
P0（小，立刻可做）
  · 装好 lark-cli 并登录（现在本机没有 ⇒ 现有飞书功能全跑不动）
  · 补齐**下行**：按 frontmatter `feishu:{token,hash,rev}` 增量 pull，落地成本地 .md
  · 结论产出：飞书 ⇄ 本地双向同步，本地仍是真源

P1（中）
  · 引入 vault 类型 `feishu`（沿用现有"外挂库"登记机制：`kbVaults` / `.extra-vaults.json` 增加一个 kind 字段）
  · 树与正文**直读飞书**（wiki 节点 → 树；raw_content → markdown）
  · 本地缓存只做加速与离线兜底，可用 `.gitignore` 排除（它可再生）
  · 编辑 → 写回飞书（overwrite markdown 或块级更新），按 revision 做乐观锁

P2（谨慎）
  · 搜索/图谱/双链 改为"基于缓存构建"（与 P1 的缓存一致），并接受"缓存不是实时"的代价
  · 附件：明确不支持或走外链（不要让飞书附件进 git/LFS）
```

---

## 6. 风险与合规（和"自建 git 服务器"那节的结论同源）

1. **数据出域**：直读直写意味着正文经过飞书（外部服务）。必须由用户**显式授权**并说清存什么；默认仍应本地优先。
2. **转换有损**：飞书富内容（画板、多维表格、块内评论、@人）无法完整映射成 markdown ⇒ **往返会丢信息**。至少要做：写回前 diff 提示 + 保留原始块快照。
3. **授权过期**：user token 失效后写操作会 401 ⇒ 需要"重新登录"引导（现在 CLI 缺失时已有类似提示，可复用）。
4. **限频**：全库级操作（建索引/搜索/图谱）不能每次都打 API ⇒ 必须有缓存与增量版本号。
5. **离线**：P1 之后知识库**依赖网络**，与"库 = 本地文件夹"的核心模型有冲突 ⇒ 建议 P1 保留本地缓存兜底，不要做 C。

---

## 7. 需要你拍板

1. **先做 P0（装 lark-cli + 补齐下行双向同步）？** —— 成本最低、立刻能让"飞书 ↔ 知识库"双向跑起来。
2. **能不能接受"本地保留缓存副本"？** —— 如果答案是"必须零本地文件"，那就是 C 方案，我需要先做 `VaultProvider` 抽象重构（367 处调用点），风险和工作量都要单独立项。
3. **飞书里的非 markdown 内容（画板/表格/多维表格）怎么处理？** —— 建议：只读不写（写回时跳过并提示），避免静默丢内容。
