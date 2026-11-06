---
name: p4-config
description: 动态发现 P4 Perforce 连接参数（P4PORT/P4USER/P4CLIENT），按 P4CONFIG→p4config.txt→P4V→交互询问 逐级降级，最后将结果保存为 memory。
displayName: "P4 Config 动态发现流程"
---

# P4 Config 动态发现流程

按以下优先级逐级尝试发现当前环境的 P4 连接参数（P4PORT / P4USER / P4CLIENT），不要硬编码任何路径或值。**完成后必须将发现的 P4 参数保存为 memory。**

---

## 0. ⚠️ 先探活，连不上就停（别在坏连接上硬撑）

拿到任何参数（哪怕来自 memory）后，**第一件事是探活**，再决定要不要继续。P4 服务器
经常因网络/VPN/机器不在内网而**不可达**——此时无论参数多正确都做不了事。

```powershell
p4 -p "<P4PORT>" -u "<P4USER>" -c "<P4CLIENT>" info
```

- 返回 `Server address` / `User name` / `Client root` → 连接就绪，继续。
- 报 `Connect to server failed; check $P4PORT` / `TCP connect to ... failed` →
  **服务器不可达**。不要再跑 describe/diff/sync 去撞（只会连撞报错、触发卡死兜底）。
  直接告诉用户「P4 当前不可达」，并说明你需要它来做什么（如对比某个 changelist），
  让用户决定（连 VPN / 提供 CL 内容 / 换条路）。

### 命令写法：用显式 `-p/-u/-c` 旗标，别把 `$env:` 赋值和命令拼一行
把 `$env:P4PORT=...; $env:P4USER=...; p4 describe ...` 拼成一条长命令时，引号极易被
外层 shell 切断（历史上真踩过：命令被截成 `+ ... gram_Support_...` 而失败）。**优先**
在 `p4` 命令上直接带 `-p <port> -u <user> -c <client>` 旗标——一条命令自洽，不依赖
环境变量，也不怕跨 shell 的引号问题。

### Shell 约定
本技能的命令是 **PowerShell 5.1** 语法（`$env:`、`Select-Object`、`Select-String`）。

**必须用 `terminal` 工具执行，不要用 `terminal`。** `terminal` 在 Windows 上是随包 busybox 的
POSIX sh，喂给它 PowerShell 会直接语法错误（`$env:X = 'v'` → `sh: syntax error`，
`(Get-Command ...)` → `unexpected "("`）。两者是并列的独立工具：

- `terminal` —— PowerShell 5.1，本技能全部代码块都走它
- `terminal` —— POSIX sh，本技能不用

若某一步确实想用 POSIX 写法，就整条命令改写成 POSIX 再交给 `terminal`；不要把两种语法
塞进同一条命令混用。

---

## 优先级 1：P4CONFIG 原生父目录查找（首选）

P4 原生支持 `P4CONFIG` 机制：设置环境变量后，`p4` 会在**当前目录及所有父目录**中逐级向上搜索该文件，找到第一个就自动应用。

```powershell
$env:P4CONFIG = 'p4config.txt'
p4 info
```

如果 `p4 info` 返回了 `User name` / `Client name` 等信息 → 连接已就绪，跳到「**保存为 memory**」步骤。

---

## 优先级 2：手动搜索 p4config.txt 候选位置

如果优先级 1 失败，手动在以下候选位置搜索 `p4config.txt`：

| 优先级 | 候选路径 | 说明 |
|--------|---------|------|
| 2a | `$PWD` | 当前工作目录 |
| 2b | Engine Root 的父目录 | 从 prompt 中 `Engine Root:` 取父目录，往往是多仓库公共根 |
| 2c | Engine Root 自身 | 如 `D:\GRMain\UE5EA` |
| 2d | Project Root | 如 `D:\GRMain\S1Game` |

```powershell
@($PWD, '<父目录>', '<引擎根>', '<项目根>') | ForEach-Object {
    $path = Join-Path $_ 'p4config.txt'
    if (Test-Path $path) { Write-Output "FOUND: $path" }
}
```

找到后在**该文件所在目录**下运行 `p4 info`（P4CONFIG 已在优先级 1 中设置）。

---

## 优先级 3：P4V ApplicationSettings.xml

P4V 把最近连接写入 `%USERPROFILE%\.p4qt\ApplicationSettings.xml`：

```powershell
[xml]$xml = Get-Content "$env:USERPROFILE\.p4qt\ApplicationSettings.xml"
$last = $xml.PropertyList.PropertyList.String | Where-Object { $_.varName -eq 'LastConnection' }
$last.'#text' -split ', '
# 输出：P4PORT, P4USER, P4CLIENT
```

提取后手动设置环境变量：
```powershell
$env:P4PORT = '<P4PORT>'
$env:P4USER = '<P4USER>'
$env:P4CLIENT = '<P4CLIENT>'
```

---

## 优先级 4：connectionmap.xml

`%USERPROFILE%\.p4qt\connectionmap.xml` 列出了所有 P4V 曾连接过的服务器及用户。

```powershell
Select-String -Path "$env:USERPROFILE\.p4qt\connectionmap.xml" -Pattern 'Server|User'
```

---

## 优先级 5：交互式询问

如果以上全部失败，用 `clarify` 工具向用户索取 P4PORT、P4USER、P4CLIENT。

---

## 验证

无论通过哪种方式获得参数，最后必须跑一次 `p4 info`，确认 `User name` / `Client name` / `Client root` 符合预期。

```powershell
p4 info
```

---

## ⚠️ 注意事项

- **`p4 set` 不可信！** 它显示注册表/系统级默认值，可能与当前项目实际值不一致。仅当所有方法都不可用时才参考它。
- P4 命令行来自 PATH 中的 `p4.exe`，或 Git 同目录下的 `p4.exe`。
- `P4CHARSET` 通常为 `utf8`，大部分操作不需要显式设置。

---

## 💡 P4 命令输出过滤（减少上下文消耗）

P4 命令（尤其是 `p4 sync`）在大型仓库中会产生 **数 MB 甚至数十 MB** 的冗长输出，每条都是一行文件路径。即使 bash 工具将输出截断到 100KB，仍会向 LLM 灌入数万 tokens 的无效信息。**必须**对所有会产生列表输出的 P4 命令做主动过滤：

### 核心原则

> 对 P4 命令输出，只保留**统计信息**或**最后几行**，丢弃逐行文件列表。

### `p4 sync` — 同步到最新

**用 tail 过滤，只保留最后 5 行：**

```powershell
$env:P4CONFIG = 'p4config.txt'; p4 sync 2>&1 | Select-Object -Last 5
```

- 同步成功时最后一行是空行，倒数第 2 行开始有文件信息，足以确认进展。
- 如果同步失败（连接错误），错误信息也在最后几行。
- **设定足够的 `timeout_seconds`**（如 1200s），因为过滤的是最终输出而非实时输出。

### `p4 sync -n` — 预览/检查是否有待同步文件

**只需知道「是否干净」或「还剩几个文件」：**

```powershell
$env:P4CONFIG = 'p4config.txt'; $out = p4 sync -n 2>&1; if ($out -match 'File\(s\) up-to-date') { Write-Output 'ALL UP-TO-DATE' } else { $count = ($out | Measure-Object).Count; Write-Output "$count files pending"; $out | Select-Object -Last 3 }
```

### `p4 changes` / `p4 files` / `p4 opened` 等其他列表类命令

同样用 `Select-Object -Last N` 或 `Measure-Object` 计行数，**不要**把完整列表喂给上下文。

### 不要做的

- ❌ 裸跑 `p4 sync` 不加任何过滤
- ❌ 用 `p4 sync -n` 不加过滤来"检查状态"

---

## 保存为 memory（必须执行）

成功获得 P4 连接参数后，**必须**调用 `memory_remember` 将结果保存为持久化 memory（**scope 固定为 `user`**，因为 P4 信息属于用户本机环境配置，不应共享到团队）：

```
name: p4-config
title: P4 Perforce 配置信息
description: 当前环境的 P4 连接参数：P4PORT=<...> P4USER=<...> P4CLIENT=<...>
scope: user
body: 记录本次发现的 P4PORT、P4USER、P4CLIENT 以及发现方式（优先级 x），并附上 `p4 info` 的关键输出（User name / Client name / Client root / Server address）。**必须附上「最后验证可达时间：YYYY-MM-DD」**——连接参数会随网络环境失效，记下验证时间才能判断该不该重新探活。

Why: 避免下次重复发现流程，直接复用已知参数；但参数可能已不可达，故需记录验证时间。
How to apply: 后续需要 P4 操作时，先检查 memory 中的 p4-config 是否存在——**无论多"新"，用之前都先按 §0 跑一次 `p4 info` 探活**；连不上就按 §0 停下并告知用户，不要在坏连接上硬撑；参数本身失效则重新执行本 skill 的发现流程，并更新「最后验证可达时间」。**所有 P4 列表类命令（sync/sync -n/files/changes/opened）输出必须过滤**：``p4 sync`` 用 ``| Select-Object -Last 5``；``p4 sync -n`` 只取统计信息；禁止裸跑不加过滤。
```

执行例：
```powershell
# 先通过 p4 info 提取关键字段
p4 info | Select-String 'Server address|User name|Client name|Client root'
```

然后调用 `memory_remember` 写入这些值。
