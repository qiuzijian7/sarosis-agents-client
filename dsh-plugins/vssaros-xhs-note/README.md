# 小红书笔记（`@vssaros/dsh-xhs-note`）· 创作型工作台样板

把「主题 + 素材」整理成小红书笔记（标题 / 正文 / 话题标签），**草稿落本机数据目录**，**AI 协作能带着草稿进去**。

本包是 `doc/xhs-workbench-fix-plan.md` 的**落地样板**：把商城版（`sara2398/xiaohongshu-note-workbench`）的三个硬伤逐条修掉，并保持「A 类挂载 + 共享层 + 容器查询」。

> 📸 **样板说明（含真机明/暗截图、逐项对照、照抄指南）**：`doc/xhs-note-workbench-demo.md`
> ![light](../../doc/xhs-note-demo-light.png)

---

## 一、三个硬伤怎么修的

| 硬伤 | 商城版 | 本样板 |
|---|---|---|
| **草稿只在 localStorage** | `localStorage['…drafts.v1']`，20 条上限、超出静默丢 | `<数据根>/xhs-note/drafts/<id>.json`：**一稿一文件 + tmp→rename 原子写 + `rev` 乐观锁（冲突 409）+ 200 篇上限**；旧 localStorage **一次性迁移**（标记写在数据根，幂等） |
| **暗色不跟随** | 自造 `--ink/--rose/--paper` + 26 处裸色 | 颜色**只走** `var(--dsw-alias-*, 兜底)`；品牌色收敛到 `--wb-brand`（默认跟随宿主，`data-brand="xhs"` 才用粉）；尺寸走 `--wb-*`；`@container` 三档断点 |
| **AI 不知道你在写什么** | 打开对话不传草稿 | 点「AI 协助」→ 把 `{主题/标题/正文/标签}` 组成指令，经 **`vssaros-composer-prefill`** 事件**预填**进 composer（不自动发送；输入机非 plain / 已有内容时不覆盖、改为追加） |

---

## 二、文件结构

```
lib/
├── index.js        服务端：4 条草稿路由 + 迁移 + 页面壳（/x/xhs-note/）
├── store.js        草稿存储：原子写 / rev 乐观锁 / 上限 / 迁移（数据根委托 foundation）
├── foundationRef.js 绑定 @vssaros/dsh-foundation（dataRootOf 的唯一真源）
├── prefill.js      预填文案纯函数（截断 / 抬头 / 去重键）
├── client.js       客户端入口（只装载子块；**不写 chunk: 字段**）
├── client.xhs-note.js  工作台面板：三栏 + 共享层 + 令牌 + 注册
test/
└── run-xhs-note-check.mjs  39 条自检（存储 / 迁移 / 上限 / 403? / HTTP 路由 / 静态契约）
```

**挂载方式**：A 类（`require('react')` + `ctx.desktopWorkbenches.register`，宿主渲染，自己不建 root）。
**注册位置**：在**子块**里（`client.xhs-note.js`）—— `check-workbench-style.mjs` 用「含 `desktopWorkbenches.register` 的文件」当组件文件检查，放入口会被误判「没用共享层」。

---

## 三、验证

```bash
# 包自检（39 条：存储原子性/乐观锁/上限/迁移幂等/HTTP 路由/无裸色/≥10 个 wb-*/容器查询/入口无 chunk）
node dsh-plugins/vssaros-xhs-note/test/run-xhs-note-check.mjs

# 仓库守卫
node dsh-plugins/check-workbench-style.mjs      # 本包已入 UNIFIED 白名单
node dsh-plugins/check-workbench-catalog.mjs
node dsh-plugins/check-chat-surface-chunks.mjs
node dsh-plugins/check-host-config.mjs          # dataRootOf 走委托（唯一真源在 foundation）
```

**真机已验（2026-10-24，沙箱 13/13）**：注册表有 `vssaros/xhs-note` · 面板渲染（root / toolbar / 生成按钮 / 对话停靠点 / `#vssaros-wb-ui`）· 切暗色 `bg #fff→#151517`、`fg #0f1115→#f9fafb` · 生成出标题 · **保存后 `/api/drafts` 读回 1 篇、磁盘上真有 JSON** · 预填事件被 chat-surface 认领并回结构化回执 · boot 无失败。
> 探针：`%TEMP%\wb-xhs-probe`（准备脚本 `%TEMP%\wb-xhs-prep.mjs`）。该沙箱状态下没有活动会话 ⇒ 预填回执是 `{applied:false, reason:'no-input'}`（通道通、落笔条件不满足）。

**两个真机 bug（务必别再踩）**：

1. **缺 `cordis.patch.yml` + `dsh.bundle.patch`** ⇒ 插件**根本不进运行时**，且宿主**不报错**（注册表里就是没有）；
2. **描述符漏 `repository`** ⇒ 宿主 `normalize()` 判 `Invalid workbench repository`，模块加载了但注册被拒。格式：`vssaros:<模块>` 或 `https://github.com/<owner>/<repo>`。

---

## 四、设计取舍（写在代码里，也写在这里）

1. **"生成"仍是本机模板**：与商城版同口径（4 风格 × 3 标题 + 固定正文骨架），**不走模型**；模型的价值放在「润色」这一步（预填草稿给 AI）。想全自动生成，把 `generate()` 换成 `POST /api/generate` 即可。
2. **草稿一稿一文件**：单表每次保存要重写全部，200 篇会卡；顺带能只改一篇。
3. **`rev` 乐观锁**：两个窗口同时改同一篇，后者拿 409 而不是互相覆盖（测试与 HTTP 层都钉住了）。
4. **迁移标记写数据根**：换机重迁也只导一次；localStorage 那份**不删**，留作最后保险。
5. **数据根委托 foundation**：本仓 `check-host-config.mjs` 要求「委托 N 份 + 真源 1 处」，自己再写一份回落链会红。
