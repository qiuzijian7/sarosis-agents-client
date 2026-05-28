# TDB-AM 接入 sarosis-agents-client（内嵌 vendor 版）

## 1. 总体架构

```
sarosis VSCode host（单进程）
├─ extensions/knot-agui          ← 原有，未触碰
├─ extensions/memory-example     ← 原有，未触碰
├─ extensions/tdb-am-gateway     ← 内嵌 TDB-AM 网关
│  ├─ src/inlineGateway.ts       —— 包装器（注入环境变量）
│  ├─ src/extension.ts           —— 扩展入口
│  └─ vendor/tdbam/              —— TDB-AM 上游源码（已本地化，剔除向量/原生模块）
├─ extensions/tdb-am-memory      ← capability provider（IMemoryProvider 桥接）
└─ extensions/tdb-am-viewer      ← 侧边栏 UI + Knot 桥
   ├─ in-process Knot → OpenAI 协议适配器（端口 8421）
   ├─ TreeView：L0 / L1 / L2 / L3 四根节点
   └─ Webview：点击条目展示完整内容
```

* 召回路径：**仅 keyword (FTS5)**，**关闭 embedding** —— 完全离线，不需 embedding 服务。
* L1/L2/L3 抽取所需的 LLM 调用，全部经 Knot Bridge 翻译为 Knot AG-UI 协议，跟随用户当前 Chat 选定的模型。
* **不再需要外部 TencentDB-Agent-Memory 仓库**（阶段 3 已把上游源码完整内嵌到 `extensions/tdb-am-gateway/vendor/tdbam/`）。详见 `vendor/tdbam/COPY_MANIFEST.md`。

## 2. 在 sarosis 中编译

```bash
cd D:/UGit/sarosis-agents-client/extensions/tdb-am-gateway
npm install   # 安装 vendor 需要的 ai / @ai-sdk/openai / yaml / js-tiktoken / json5 / zod

cd ../tdb-am-memory
npm install

cd ../tdb-am-viewer
npm install

cd ../..
# 跑全量 watch（推荐，开发期）
npm run watch
# 或者只编译扩展
npm run watch-extensions
```

## 3. 配置（VS Code 设置）

```jsonc
{
  // ──── Knot 配置（如果你已配过，跳过这一段） ────
  "knot.token": "<你的 Knot token>",
  "knot.user":  "<企微英文名>",
  "knot.endpoint": "https://knot.woa.com",
  "knot.agents": [
    { "id": "your-agent-id", "name": "默认抽取 Agent" }
  ],

  // ──── TDB-AM 配置 ────
  "tdbam.gatewayPort": 8420,                    // 内嵌网关端口
  "tdbam.knotBridgePort": 8421,                 // Knot 桥端口
  "tdbam.knotAgentId": "your-agent-id",         // 留空时取 knot.agents[0].id
  "tdbam.dataDir": "",                           // 留空 = ~/.tdai
  "tdbam.recallStrategy": "keyword",            // 仅支持 keyword（向量已禁用）
  "tdbam.autoStart": true
}
```

## 4. 运行

启动 sarosis（dev 模式：`./scripts/code.sh` / `./scripts/code.bat`）。

* 左侧活动栏会出现 **TDB-AM 图标**，点击展开可见 4 个根节点（L0/L1/L2/L3）。
* 第一次启动数据为空，触发几轮 Agent 对话后再点刷新即可看到 L0 条目。
* L1/L2/L3 由 TDB-AM 后台 pipeline 异步抽取。

## 5. 命令面板

| 命令 | 说明 |
|---|---|
| `TDB-AM: 刷新记忆树` | 重新拉取 gateway 数据 |
| `TDB-AM: 重启服务` | 重启 Knot 桥（gateway 由 tdb-am-gateway 扩展管理）|
| `TDB-AM: 停止服务` | 停止 Knot 桥 |
| `TDB-AM: 健康检查（gateway + Knot 桥）` | ping 两个端口，气泡提示 |

## 6. 故障排查

| 现象 | 检查项 |
|---|---|
| **侧边栏没有 TDB-AM 图标** | 1) 检查 `tdb-am-viewer` 是否在编译产物中（`extensions/tdb-am-viewer/out/`）；2) 看 `输出` → `TDB-AM Viewer` 频道是否报错 |
| **TreeView 一直空** | OutputChannel `TDB-AM Gateway` 看 `[gateway]` 日志；常见是 vendor 编译产物缺失或端口冲突 |
| `knot.token` 报错 | 在 sarosis 设置里填 `knot.token`；与现有 KnotBot 共用 |
| Knot 桥 502 | 查看 OutputChannel 中 `[knot-bridge]` 行，常见是 `knotAgentId` 错或 token 过期 |
| 网关启动失败 | 看 `TDB-AM Gateway` 频道首行；常见是 vendor 内未安装 npm 依赖（`cd extensions/tdb-am-gateway && npm install`）|

## 7. 已知限制

* L2 / L3 探测式 endpoint（`/search/scenes`、`/search/persona`）当前 vendor gateway 未必内置；找不到时这两层 TreeView 显示"空"，**不阻塞 L0/L1**。
* TreeView 的 30 秒轮询足够 PoC 用，正式版应改 server-sent event 或 file watch。
* 向量召回与原生模块（@node-rs/jieba / sqlite-vec）已禁用，详见 `extensions/tdb-am-gateway/vendor/tdbam/COPY_MANIFEST.md` 第 3 节。
