
---

## 18. Agent 的生命周期：**寄生在 VsSaros app 上**（2026-10-28）

需求（用户原话）：「Agent 客户端 要求启动 vssaros app 时才启动，关闭 app 时，同时 关闭 agent 客户端」。

### 18.1 关键事实：Agent **不能**放在 dsh Host 里

`src/vs/sessions/contrib/dshHarness/electron-main/dshHostReaper.ts` 的文件头原话：

> keepAlive 的 Host **故意**活过 IDE 退出（它有自己的空闲 TTL）

⇒ 放在 Host 里 ⇒ **关掉 app 后 Agent 还会继续连着中转站** ✗（与需求相反）。

### 18.2 落点：主进程（与 app 同生共死）

新增 `src/vs/sessions/contrib/dshHarness/electron-main/nodeAgentHost.ts`：

- **复用**插件那份 Agent 实现（动态 import `dsh-plugins/vssaros-relay/lib/agent.js`）⇒
  **不复制第二份** ⇒ 协议改动只有一处 ✓；
- 启动：`main.ts` 的 `createServices()` 里 `nodeAgentHost.start()`；
- 退出：`onWillShutdown` 里 `nodeAgentHost.dispose()` ⇒ **通道主动 close**
  （中转站立刻把节点标离线，不用等 TCP 超时）；
- 凭据：dsh 凭据库 `<userData>/dsh-home/.credentials.yaml`
  （`VSSAROS_CODEBUDDY_KEY` + `VSSAROS_RELAY_NODE`，与 dsh 侧/插件**同一份**）；
- **实时读**凭据 + 30s 看门狗 ⇒ 用户在 app 运行期间点「注册本机到号池」也能立刻生效。

### 18.3 Host 侧同步调整（避免两份 Agent 抢令牌）

- `vssaros-relay` 插件：`agentEnabled: false`（**默认不在 Host 里起 Agent**）⇒
  只保留「注册」能力（写 `VSSAROS_RELAY_NODE`，主进程那份读同一份凭据 ⇒ 点完即生效 ✓）；
  保留开关便于回退/对照；
- 插件页面的通道状态改为**以中转站为准**（`/api/nodes/pool` 的 `channel_connected`）⇒
  主进程那份的真实状态，中转站知道 ✓；
- **节点令牌唯一** ⇒ 后注册的一方会作废前一方 ⇒ 同一台机器**只能有一个 Agent 客户端**。

### 18.4 独立启动器降级为诊断工具

`scripts/run-node-agent.mjs`：**默认一次性**（跑完 `--seconds` 自己退出）⇒
不留「与 app 无关的常驻进程」；`--keep` 才常驻（仅调试）。
同时**删掉了**开机自启的启动文件夹 `.vbs`（它让 Agent 在 app 之外也跑 ⇒ 违背需求）。

### 18.5 守卫

`dsh-plugins/vssaros-relay/test/run-node-agent-lifecycle-check.mjs`（10 条）：
主进程有宿主且实现 dispose / main.ts 启+停两处都挂 / 插件默认不在 Host 起 /
状态以中转站为准 / 启动器默认不常驻 / **实测启动器跑完会自己退出**。
