<#
.SYNOPSIS
  把工作区对齐到 checkout 出来的那个提交，并清掉未跟踪文件。

.DESCRIPTION
  ★ 2026-10-21：一次"发布一直是残桩"的排查结论 ——
  蓝盾的 checkout 步骤会**复用工作区** ⇒ 上一次构建残留的文件（旧的构建脚本、旧的 .build 产物、
  甚至旧的版本号）可能被带进这次构建 ⇒ 出现"CI 跑的不是最新代码"这类疑云
  ⇒ 这里把工作区**强制对齐 + 清理**：
    ① git fetch --tags  ⇒ 把 tag 拉全（changelog 的区间依赖历史 tag；缺 tag ⇒ 区间退化）
    ② git reset --hard <checkout 的那个 sha> ⇒ 工作区内容与 checkout 结果完全一致
    ③ git clean -fd      ⇒ **删掉未跟踪文件**（残留的 .build 产物、旧脚本拷贝…）

  ⚠ 刻意**不**写死"回到 origin/main"：流水线允许按任意分支触发（branches: ['*']），
    写死 main 会在分支构建时把代码拉回主线 ⇒ 只对齐"checkout 实际给出的那个提交" ✓
  ⚠ `git clean -fd` 会删**未跟踪**文件 ⇒ CI 里安全（checkout 下来的都是已跟踪文件），
    但**本地**跑要小心 ⇒ 提供 -DryRun 开关先看会删什么 ✓
#>
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$sha = (git rev-parse HEAD).Trim()
if (-not $sha) { throw "not a git repository (or HEAD unresolved)" }
Write-Host "[align] HEAD = $sha"
if ($DryRun) {
  Write-Host "[align][dry-run] would: git fetch --tags origin; git reset --hard $sha; git clean -fdn"
  git clean -fdn
  exit 0
}
git fetch --tags origin
git reset --hard $sha
git clean -fd
Write-Host "[align] workspace aligned to $sha (tags fetched, untracked files removed)"