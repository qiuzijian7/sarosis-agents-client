# @vssaros/dsh-ego

ego lite（`ego-browser`）在 **DeepSeek Harness** 里的薄接入：随包 vendored 的技能 + 4 个工具。

## 一句话边界

| 问题 | 答案 |
| --- | --- |
| 这个包里**有**浏览器吗？ | **没有**。ego lite 浏览器是第三方独立应用（不开源、单独下载：<https://lite.ego.app/>）。 |
| 用户不装 app 能用吗？ | **不能**。`globalThis.ego` 那份原生绑定（任务空间 / 快照 / CDP）由 app 进程注入。 |
| 那这个包解决什么？ | Windows 上两个真问题：**Host 进程的 PATH 是陈旧的**、**PowerShell 没有 heredoc**。 |

## 工具面（4 个）

| 工具 | 读写 | 作用 |
| --- | --- | --- |
| `ego_status` | 只读 | CLI 在哪 / 绑定在不在 / 版本 / 任务空间几条。`probe: true` 才真的连运行时。 |
| `ego_guide` | 只读 | `ego-browser skill` 的输出 —— **ego API 的唯一真源**（随用户装的版本走）。 |
| `ego_spaces` | 只读 | 任务空间清单（id / 名称 / ownership / 最近标签）。 |
| `ego_run` | **动作** | 在 ego 的 node 上下文执行一段 JS（脚本走 stdin，等价 heredoc、不落临时文件）。**逐次审批**。 |

取巧的地方（都写在 `lib/core/cli.js` 的文件头）：

- **不依赖 PATH**：`config.cliPath` → `VSSAROS_EGO_CLI` → `PATH` → 已知安装位置，四段依次探测；
  探测不到时**把试过哪些位置原样报出来**（用户才知道该填哪儿）。
- **Windows `.cmd` 垫片**：node 不能直接 spawn 批处理 ⇒ 经 `cmd.exe /d /s /c` + `windowsVerbatimArguments`。
- **超时要杀进程树**：`cmd.exe` 被杀 ≠ 它拉起的助手也结束 ⇒ Windows 上补一次 `taskkill /T /F`。
- 所有子进程都带 `windowsHide: true`（Host 没有可继承的控制台，漏了每次调用闪一个窗口）。

## 配置

`cordis.patch.yml` 里是 `config: {}`；需要时由 `dshCli.ts` 的覆盖层注入（或环境变量）：

| 键 / 环境变量 | 缺省 | 说明 |
| --- | --- | --- |
| `config.cliPath` / `VSSAROS_EGO_CLI` | 自动探测 | `ego-browser` 的**绝对路径**（`…/ego-browser.cmd`） |
| `config.allowRun` / `VSSAROS_EGO_ALLOW_RUN` | `false` | 免审批执行 `ego_run`（**只给无人值守**；默认 fail-closed） |
| `config.timeoutMs` / `VSSAROS_EGO_TIMEOUT_MS` | `120000` | 单次 `ego_run` 预算，夹在 5s～600s |

## 安装

随包自动安装（`dshHostSupervisor` 的伴生插件清单里有它：`DSH_EGO_PLUGIN_NAME`）。手工装：

```bash
dsh plugin --profile vssaros add <repo>/dsh-plugins/vssaros-ego
```

**改完必须 bump `package.json` 的 version**（`dsh plugin add` 同版本短路不重装）。

## 与 `@vssaros/dsh-browser` 的关系（不是替代）

`vssaros-browser` 是 **CDP 驱动用户本机 Chrome**：共用你那一个浏览器窗口，会跟你抢标签。
ego lite 是**另一个浏览器**：每个 agent 一个隔离 Space，人机并行。

两者**并存**、各管一摊：要"用我现在的 Chrome 登录态抓一页"→ `browser`；要"agent 自己在后台
连开十个页面干半小时"→ `ego_run`。**不要**为了让路线统一而删掉任一边。

## 验证

```bash
node dsh-plugins/vssaros-ego/test/run-ego-check.mjs   # 进程内自检（不联网、不起 Host）
node dsh-plugins/check-plugin-files.mjs               # files 覆盖
node dsh-plugins/check-tool-definitions.mjs           # 工具定义完整（output.schema/render 必填）
node dsh-plugins/check-spawn-hide.mjs                 # 子进程 windowsHide
```

真机（需要用户已装 ego lite）：`ego_status`（`probe: true`）→ `ego_guide` → `ego_run` 跑一段
`console.log(await ego.listTaskSpaces())`。
