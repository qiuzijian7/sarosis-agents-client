# 调研（前提：允许本地缓存）：飞书有没有「可无缝对接的本地格式」+「本地文档浏览器」

> 结论先行：
> **① 有可用的本地格式，而且官方就认 Markdown**（导入 / 导出都支持）；想更保真还有 **docx** 与 **DocxXML（带 block_id）**。
> **② 没有独立的"本地飞书浏览器"** —— 显示飞书文档只有两条官方路：飞书客户端 / 网页（都需登录）。
> ⇒ 落地方案应是：**本地缓存 markdown（官方互通格式） + 用我们自己的渲染器显示**，把"显示"和"飞书"解耦。

---

## 1. 问题一：有没有能和线上飞书文档无缝对接的本地格式？

### 1.1 三档格式（按保真度从低到高）

| 档 | 格式 | 谁认 | 保真度 | 用途 |
|---|---|---|---|---|
| **A** | **Markdown（.md）** | **官方导入/导出都认** ✅ | 中（复杂表格、脑图、小组件会**降级**） | **本地缓存 + 人类可读 + 可 git** |
| B | **docx（Word）** | 官方导入/导出都认 ✅ | 高 | 归档、交付、打印 |
| C | **DocxXML（lark-cli `--doc-format xml`）** | lark-cli（本仓已用）✅ | **高（带 block_id，可块级回写）** | 需要保真回写时 |
| — | 块结构 JSON（docx blocks API） | 开放平台原生 | 最高（就是线上本体） | 做无损同步的终极形态 |

### 1.2 官方证据【外部·官方已核实】

**导入**（`POST /open-apis/drive/v1/import_tasks`）：
> 将本地文件如 Word、TXT、**Markdown**、Excel 等导入为飞书在线云文档……
> `doc` 类型支持 `docx / doc / md / txt / mark / markdown`；**扩展名为 md/txt/mark/markdown 时按 markdown 解析**。
> 频率限制：**100 次/分钟**；需先上传文件拿 `file_token`，异步轮询结果。

**导出**（`POST /open-apis/drive/v1/export_tasks`）：
> 云文档（`docx`）支持导出为 **Microsoft Word (DOCX)、PDF**；电子表格 → xlsx/csv；多维表格 → xlsx/csv；思维笔记 → FreeMind/PNG。
> 导出文件 **10 分钟后删除**；需应用对文档有权限（加为协作者或空间授权）。
> （Markdown 导出为较新能力，社区实测"复杂表格/脑图会损失"。）

**官方帮助中心**（下载云文档）：
> 桌面端/网页版：整个文档可下载为 **Word、PDF 或 Markdown**。
> ⚠ 并明确提醒："通过第三方工具打开下载到本地的飞书云文档时，**部分格式会进行降级处理**（例如小组件下载后可能降级为图片）"。

### 1.3 本仓已有的能力【实测】

`scripts/feishu-sync.mjs` 里已经在用的命令（这就是"无缝对接"的现成管道）：

```
读：docs +fetch --doc <token> --doc-format markdown --as user      → 整篇 markdown
读：docs +fetch --doc <token> --detail with-ids --as user          → DocxXML（带 block_id）
写：docs +update --command overwrite   --doc-format markdown @./note.md
写：docs +update --command block_replace --doc-format xml  --block-id <id>
建：docs +create --doc-format markdown|xml --content @./note.md
wiki：+space-create / +node-get / +node-create / +node-delete / +move
drive：+update-title
```

⚠ 前提：**lark-cli 必须装好且已 user 身份登录**（本机当前 `where lark-cli` 无结果 ⇒ 现在跑不动）。

---

## 2. 问题二：有没有"本地飞书浏览器"可以显示飞书文档？

### 2.1 结论：**没有**独立的官方本地文档查看器

可用来"看"飞书文档的方式只有这几种：

| 方式 | 是否官方 | 离线 | 能否被我们嵌入/复用 |
|---|---|---|---|
| 飞书桌面客户端（Win/Mac/Linux） | ✅ | ✅ 支持离线编辑，联网自动同步 | ❌ 独立进程，不是一个可嵌入的渲染组件 |
| 飞书网页版（需登录） | ✅ | ❌ | ❌ 需登录态，且是 SaaS 页面 |
| 导出为 docx / PDF 后本地打开 | ✅ | ✅ | ⚠ 可以，但"显示"已经和飞书解耦了 |
| 第三方工具（如社区 `feishu-doc-export` 批量导出） | ❌ 社区 | — | ⚠ 只解决"批量导出"，不是浏览器 |

> 关于"Mac 客户端 ≥7.12 可把云文档文件夹同步到本地（`~/Library/Application Support/Feishu/Sync/`）"：
> 【外部·**待核实**】第三方教程口径，且**同步的是客户端自己用的格式**——它不是 markdown/docx，**不能**当作我们的库目录来读。
> 即便成立，也只能作为"客户端自己的离线缓存"，与我们无关。

### 2.2 所以正确的做法是：**自己渲染**（我们已经具备）

我们仓库里**已经有完整的正文渲染链路**（`lib/md/` + markdown-it + `.kb-html-cache/` 磁盘缓存），把飞书文档 `+fetch --doc-format markdown` 拉下来后，**直接用现有渲染器显示即可** —— 不需要"飞书浏览器"。

代价（要如实接受）：
- 飞书专属富组件（画板、多维表格、小组件、@人、块评论）**显示不出来**，会降级成文本/图片占位
- 需要图片/附件：走 `+fetch --detail with-ids`（DocxXML）+ 附件下载

---

## 3. 结合"允许本地缓存"的落地建议

```
本地缓存目录（<库>/.feishu-cache/ 或独立缓存库）
├── <node-token>.md        ← 正文（docs +fetch --doc-format markdown）★ 主要缓存
├── <node-token>.xml       ← 结构（--detail with-ids）★ 需要保真回写时才存
├── assets/                ← 图片/附件
└── .feishu-index.json     ← { token, title, hash, rev, syncedAt, parentToken, path }

读：缓存命中且 rev 未变 ⇒ 直接渲染（零 API）
    否则 ⇒ +fetch markdown → 更新缓存
写：编辑 → overwrite markdown（简单）
    需要保真 → block_replace xml（按 block_id）
冲突：以 rev 做乐观锁；本地改了但远端 rev 变了 ⇒ 提示用户"远端已更新"，不要静默覆盖
鉴权：user 身份（个人库必须）；token 过期 ⇒ 引导重新登录，不假装成功
限频：导入 100 次/分钟；同步仍走 800ms/篇 的保守间隔
```

**关键取舍**：把 **Markdown 当作"线上飞书文档的有损投影"**，把 **DocxXML/块结构 当作"需要保真时的通道"**。
日常浏览/搜索/图谱/版本（git）都跑在 markdown 缓存上；只有"写回"时才走保真通道。

---

## 4. 需要你定三件事

1. **缓存格式选哪档？** 建议 **markdown 为主 + DocxXML 按需**（成本最低、且官方互通）；若要求"字字保真"就得上块结构同步，复杂度跳一个量级。
2. **是不是接受"飞书富组件显示不出来"？** 若接受 ⇒ 用我们现有渲染器，零新增依赖；若不接受 ⇒ 只能跳转到飞书客户端/网页打开（放弃内嵌显示）。
3. **先做哪一步？** 建议：装 lark-cli + 打通「飞书 → 本地 markdown 缓存 → 界面显示」这条**单向只读**链路（P0，天级），验证通过再做写回（P1）。
