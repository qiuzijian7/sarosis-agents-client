---
name: git-config
description: 动态发现本机 Git 可执行文件路径，按 PATH→常见安装目录→UGit 嵌入版→全局搜索→交互询问 逐级降级，最后将结果保存为 memory。
displayName: "Git Config 动态发现流程"
---

# Git Config 动态发现流程

按以下优先级逐级尝试发现当前环境的 Git 可执行文件路径（`git.exe` 的完整绝对路径），不要硬编码任何路径或值。**完成后必须将发现的 Git 路径保存为 memory。**

> **Shell 约定：本技能所有代码块是 PowerShell 5.1，必须用 `terminal` 工具执行，不要用
> `terminal`。** `terminal` 在 Windows 上是随包 busybox 的 POSIX sh，`$gitExe = (Get-Command
> git ...)` 这类写法会直接报 `sh: syntax error: unexpected "("`。两者是并列的独立
> 工具：`terminal` 跑 PowerShell，`terminal` 跑 POSIX sh。

---

## 优先级 1：系统 PATH 中的 git（首选）

直接检查 git 是否已在 PATH 中，并获取其完整路径：

```powershell
$gitExe = (Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
```

如果返回了有效的 `.exe` 路径 → 跳到「**保存为 memory**」步骤。

也可以同时用 `where.exe git 2>$null` 交叉验证。

---

## 优先级 2：常见 Git for Windows 安装目录

如果优先级 1 失败（`Get-Command` 无结果），检查常见独立安装路径：

```powershell
@(
    'C:\Program Files\Git\cmd\git.exe',
    'C:\Program Files (x86)\Git\cmd\git.exe',
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
```

找到后跳到「**保存为 memory**」步骤。

---

## 优先级 3：UGit 嵌入式 Git

UGit（腾讯 UGit 客户端）自带嵌入式 Git，路径模式为：
`%LOCALAPPDATA%\UGit\app-<版本号>\resources\app\git\cmd\git.exe`

```powershell
$ugitDirs = Get-ChildItem "$env:LOCALAPPDATA\UGit\app-*" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
foreach ($dir in $ugitDirs) {
    $candidate = Join-Path $dir.FullName 'resources\app\git\cmd\git.exe'
    if (Test-Path $candidate) {
        Write-Output "FOUND: $candidate"
        break
    }
}
```

注意：`app-<版本号>` 可能随 UGit 更新变化，可能有多个版本目录共存。按版本号降序取最新的可用版本。

---

## 优先级 4：全局搜索 git.exe（兜底）

在常见的用户目录和 Program Files 中搜索 `git.exe`：

```powershell
$searchRoots = @(
    "$env:LOCALAPPDATA",
    "$env:APPDATA",
    'C:\Program Files',
    'C:\Program Files (x86)'
)
foreach ($root in $searchRoots) {
    $found = Get-ChildItem -Path $root -Filter 'git.exe' -Recurse -Depth 5 -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\git\\cmd\\git\.exe$' -or $_.FullName -match '\\Git\\bin\\git\.exe$' } |
        Select-Object -First 1 -ExpandProperty FullName
    if ($found) { Write-Output "FOUND: $found"; break }
}
```

匹配模式说明：优先匹配 `\git\cmd\git.exe`（Git for Windows 结构），其次 `\Git\bin\git.exe`（MSYS2/MinGW 结构）。

---

## 优先级 5：交互式询问

如果以上全部失败，用 `clarify` 工具向用户索取 git.exe 的完整路径。

---

## 验证

无论通过哪种方式获得路径，最后必须跑一次 `git --version` 确认可执行且输出版本号：

```powershell
& $gitExe --version
```

预期输出类似：`git version 2.x.x.windows.x`

---

## ⚠️ 注意事项

- **不要假设 git 一定在 PATH 中。** 部分环境（如 CI runner、精简开发机）可能没有配置 PATH。
- **UGit 嵌入版的版本号会变化**（如 `app-5.51.0` → `app-5.52.0`），优先用通配符匹配最新版本。
- **全局搜索比较耗时**（优先级 4），仅在前 3 级全部失败时才执行，且限制深度为 5 层以避免搜索整个磁盘。
- `git --version` 输出包含版本号，version 字段形如 `git version 2.41.0.windows.1`。

---

## 保存为 memory（必须执行）

成功获得 Git 路径后，**必须**调用 `memory_remember` 将结果保存为持久化 memory（**scope 固定为 `user`**，因为 Git 路径属于用户本机环境配置，不应共享到团队）：

```
name: git-path
title: Git 可执行文件路径
description: Git 路径：<完整绝对路径>
scope: user
body: 记录本次发现的 Git 可执行文件的完整绝对路径、版本号、以及发现方式（优先级 x），附上 `git --version` 的完整输出。

Why: 避免下次重复发现流程，直接复用已知路径。
How to apply: 后续需要 Git 操作时，先读取 memory 中的 git-path，设置 `$gitExe = '<路径>'`，然后用 `& $gitExe <命令>` 执行。如果路径失效（文件不存在或版本不兼容），重新执行本 skill 的发现流程。
```

执行例：
```powershell
# 获取版本信息
& $gitExe --version
```

然后调用 `memory_remember` 写入路径和版本号。
