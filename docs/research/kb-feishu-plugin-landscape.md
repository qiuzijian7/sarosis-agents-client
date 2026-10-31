# 调研：dsh 有没有「飞书知识库」的兼容插件？

> 结论：**没有专门的"飞书知识库兼容插件"** —— 本仓没有、商城也没有。
> 但**"零件"是齐的**，散在三处：
> ① `vssaros-kb` 内置飞书同步（单向）+ 读云文档工具
> ② **IDE 侧已内置官方飞书 CLI 的安装/升级/扫码授权**（`larkCliSection` + `larkCliService`）
> ③ `vssaros-channels` 提供飞书 IM 渠道（但**不碰文档**）
>
> ⇒ 缺的不是能力，而是**把这三块串成"飞书知识库 = 一等公民库"的适配层**。

---

## 1. 本仓有没有？（**实测**）

### 1.1 插件清单里：没有独立飞书插件

| 插件 | 与飞书的关系 |
|---|---|
| `vssaros-kb` v0.5.60 | **内置飞书能力**：`/api/feishu-spaces`、`/api/feishu-sync`、`/api/feishu-cli`、`/api/feishu-log`、`/api/feishu-schedule`；工具 `kb_feishu_*`、读云文档工具 |
| `vssaros-channels` v0.1.0 | IM 渠道（**飞书/Telegram**）入站消息 → 会话；实测关键词命中：`feishu:1`，**`wiki/docx/doc:0`** ⇒ **完全不碰文档** |
| `vssaros-agents` | 提及飞书（WS 协议/凭据相关），非文档能力 |

已安装副本（`.vssaros` / `.vssaros-dev` 的 `plugins/`）里：**没有任何 feishu/lark 命名的插件**。

### 1.2 但 IDE 侧已经内置了「飞书 CLI」的一整套（这是最现成的零件）

```
src/vs/sessions/contrib/agentStudio/
├── common/larkCli.ts          LARK_CLI_PACKAGE = '@larksuite/cli'
│                               LARK_CLI_INSTALL_COMMAND = `npx @larksuite/cli@latest install`
│                               LARK_CLI_BIN = 'lark-cli'
├── browser/larkCliService.ts  getLarkCliStatus / installLarkCli（走主进程）
└── browser/larkCliSection.ts  UI：状态徽章 + 安装/升级按钮 + 「🤖 创建机器人（扫码授权）」
                               扫码后自动把 app_id/app_secret 写回渠道配置
```

界面提示原文：「官方 CLI（`@larksuite/cli`）：装好后可在终端用 `lark-cli` 直接操作飞书（**发消息 / 查群 / 读写文档**），也供 AI 技能调用」。

⚠ **本机当前未安装**（`where lark-cli` 无结果）—— 但**点一下 IDE 里那个「安装」按钮就能装**（`npx @larksuite/cli@latest install`，npm 上确认存在，当前版本 **1.0.98**）。

### 1.3 本仓已能打的飞书命令（同步脚本实测）

```
读：docs +fetch --doc <t> --doc-format markdown     ← 整篇 markdown
读：docs +fetch --doc <t> --detail with-ids         ← DocxXML（带 block_id）
写：docs +update --command overwrite --doc-format markdown
写：docs +update --command block_replace --doc-format xml --block-id <id>
建：docs +create --doc-format markdown|xml
wiki：+space-create / +node-get / +node-create / +node-delete / +move
```

---

## 2. 商城里有没有？（**线上实检**：`21.6.92.5:3040/api/v1/packages`）

| 检索词 | 命中 | 都是什么 |
|---|---|---|
| `feishu` | 19 | 全是 **plugin**：`-bot` / `-channel` / `-assistant` / `-bridge` … |
| `飞书` | 68 | 同上，多为 IM 网关、长连接 bridge、机器人 |
| `lark` | 28 | `-bridge` / `-gateway` / `-notifier` / `-link` / `-claw` … |
| `wiki` | 30 | `weibaohui-dsh-kb`（**离线团队知识库**，FDE 盒子，非飞书）、`d2moqi-dsh-openwiki`（openwiki 代码库 wiki，非飞书） |
| `kind=knowledge` | **2** | 只有 `vscode-dev-guide`、`sarosis-handbook` |

⇒ **商城里有大量飞书 IM 插件，但没有一个是"飞书云文档/知识库对接"**。
（`weibaohui-dsh-kb` 名字像，但它是**离线团队知识库**，与飞书无关。）

---

## 3. 所以：现状拼图 vs 缺口

```
                已有                                    缺
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ lark-cli 安装/升级/扫码授权  │        │ 飞书 → 本地 的**下行**同步    │
│ （IDE 内置，点一下即可）     │        │ （只有本地 → 飞书 单向）      │
│                             │        │                              │
│ 读单篇云文档 → markdown      │        │ vault 类型 `feishu`：         │
│ docs +fetch（markdown/xml）  │        │ 把 wiki 树当库树来浏览        │
│                             │        │                              │
│ wiki 空间/节点 CRUD          │        │ 写回 + rev 乐观锁             │
│                             │        │                              │
│ 同步脚本（上行，hash 去重）  │        │ 缓存索引（token/hash/rev）    │
└─────────────────────────────┘        └──────────────────────────────┘
```

---

## 4. 建议：不要新造插件，先做「适配层」

| 选项 | 做法 | 评价 |
|---|---|---|
| A 新建独立插件 `vssaros-feishu-kb` | 新包、新注册、新 UI | ❌ 要重做 vault 登记/设置页/工具注册，且会和 `vssaros-kb` 抢库抽象 |
| **B 在 `vssaros-kb` 内加 `feishu` vault 类型** | 沿用现有"外挂库"登记（`.extra-vaults.json` 增加 kind）+ 复用 lark-cli 集成 | ✅ **推荐**：改动集中在适配层，UI/搜索/工具全部复用 |
| C 只做同步增强（补下行） | 本地仍是真源，加 pull | ✅ 最省，但仍是"同步"不是"直读" |

**B 的最小骨架**：

```
core/kbFeishuVault.js
  listTree(spaceId)      → wiki 节点树 → 库树
  readDoc(token)         → docs +fetch --doc-format markdown（命中缓存直接用）
  writeDoc(token, md)    → docs +update --command overwrite（或 block_replace xml）
  stat(token)            → rev / hash（做缓存失效与乐观锁）
缓存：<库>/.feishu-cache/{<token>.md, <token>.xml, assets/, .feishu-index.json}
鉴权：复用 IDE 已有的 lark-cli 安装/登录/扫码（不另造一套）
```

---

## 5. 需要你定

1. **走 B（在 kb 内加 `feishu` 库类型）还是 C（只补下行同步）？** —— 我推荐 **先 C 验证链路，再 B 做库类型**（C 是 B 的子集，不浪费）。
2. **要不要我先把 lark-cli 装上并登录？** —— IDE 里已有按钮，也可以我调 `npx @larksuite/cli@latest install`（需你确认，因为会改机器环境）。
3. 若要做 B：**先只读（浏览/搜索飞书库）还是一步到位（可写回）？** —— 只读风险低很多（不会误改线上文档）。
