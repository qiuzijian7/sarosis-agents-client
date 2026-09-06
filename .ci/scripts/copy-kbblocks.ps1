# 复制 kbblocks webview 资源到 out-build
# Join-Path 三参数形式需 PS 7+；构建机为 PS 5.1，改用 Split-Path 两次。
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$srcMedia = "src\vs\sessions\contrib\agentStudio\webview\media"
$outMedia = "out-build\vs\sessions\contrib\agentStudio\webview\media"
New-Item -Force -ItemType Directory $outMedia | Out-Null
foreach ($ext in @('js', 'css')) {
  $f = ('kbblocks.' + $ext)
  if (Test-Path ($srcMedia + '\' + $f)) {
    Copy-Item ($srcMedia + '\' + $f) ($outMedia + '\' + $f) -Force
    $fSize = (Get-Item ($outMedia + '\' + $f)).Length
    Write-Host ('[OK] Copied ' + $f + ' to out-build (' + $fSize + ' bytes)')
  } else {
    Write-Host ('[WARN] ' + $f + ' not found — KB markdown Mermaid will not render')
  }
}
