<#
.SYNOPSIS
  发布后**回读核验** —— 让"残桩"不可能以"流水线成功"的形式溜过去。

.DESCRIPTION
  背景：过去一个月里，每个版本的 release 都是**残桩**（描述只有 19 字符 = tag message、
    没有安装包直链），而流水线**一直是绿的** ⇒ 没人发现 ⇒ 直到用户去下载才发现没有包 ✗✗
    （工蜂 `POST /releases` 会用 body 里的 `name` 覆盖 `description` ⇒ 新建的 release
      天生是残桩；这条已由 `build/saros/create-release.cjs` 修掉，但**必须有回读校验**
      才敢相信它 ⇒ 本步骤就是那道校验。）

  判据（见 build/saros/verify-release.mjs）：
    ① 两个仓库的 release 都存在
    ② 描述长度 ≥ 200 字符（有真正的 changelog，而不是 tag message）
    ③ 资产链接里有安装包（用户能真的下载到）
  任一不满足 ⇒ 退出码非 0 ⇒ **流水线红** ⇒ 残桩发布不出去 ✓
#>
$ErrorActionPreference = 'Stop'
$version = $null
try { $version = (Get-Content (Join-Path $PSScriptRoot '..\..\product.json') -Raw | ConvertFrom-Json).version } catch { }
if (-not $version) { throw "cannot read version from product.json" }
$tag = "v$version"
Write-Host "[verify] checking release $tag"
node (Join-Path $PSScriptRoot '..\..\build\saros\verify-release.mjs') $tag
if ($LASTEXITCODE -ne 0) { throw "release verification failed for $tag (stub release? no asset link?)" }
Write-Host "[verify] release $tag OK"