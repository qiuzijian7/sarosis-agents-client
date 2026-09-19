# agentmemory-memory Benchmark

性能评测工具，移植自上游 [agentmemory](https://github.com/rohitg00/agentmemory) 的 `benchmark/`。

## 前置条件

**dev 网关必须已启动**（由主进程 spawn，不能独立启动）：

```bash
# 在项目根目录启动 dev（会自动 spawn 网关）
cd g:\SarosWorkspace\sarosis-agents-client
scripts\code.bat --user-data-dir=%USERPROFILE%\.vssaros-dev
```

确认网关就绪：

```bash
curl http://127.0.0.1:3112/health
# 应返回 {"status":"ok","dataDir":"...","port":3112}
```

## 运行压测

```bash
cd extensions/agentmemory-memory
npm run bench:load
```

默认配置：
- **N**（库大小）：1000, 10000
- **C**（并发）：1, 10, 100
- **ops/cell**：200

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGENTMEMORY_URL` | `http://127.0.0.1:3112` | 网关地址（dev 3112 / 安装版 3111） |
| `BENCH_AGENT_ID` | `benchmark-agent` | 搜索端点的 agent ID |
| `BENCH_SCOPE` | `benchmark` | KV scope（压测数据存这里，避免污染生产库） |
| `BENCH_N` | `1000,10000` | 库大小（逗号分隔） |
| `BENCH_C` | `1,10,100` | 并发级别（逗号分隔） |
| `BENCH_OPS` | `200` | 每 cell 的操作数 |
| `BENCH_SEED` | `12648430` | 随机种子（可复现） |
| `BENCH_OUT_DIR` | `benchmark/results` | 结果输出目录 |

## 输出

- **JSON 报告**：`benchmark/results/load-100k-<git-sha>.json`
- **控制台表格**：p50 / p90 / p99 延迟 + 吞吐量

## 测量的端点

| 端点 | 说明 |
|---|---|
| `POST /provider/remember` | 写入记忆 |
| `POST /search/<agentId>` | 检索记忆 |
| `GET /kv/<scope>?values=true` | 列出 KV 数据 |

## 与上游的差异

- **端点路径**：上游 `/agentmemory/*` ⇒ 本项目 `/provider/*` / `/search/*` / `/kv/*`
- **daemon 自启动**：上游支持 `AGENTMEMORY_BENCH_AUTOSTART=1` ⇒ 本项目去掉（网关由主进程 spawn）
- **默认 base URL**：上游 `http://localhost:3111` ⇒ 本项目 `http://127.0.0.1:3112`（dev 网关）
