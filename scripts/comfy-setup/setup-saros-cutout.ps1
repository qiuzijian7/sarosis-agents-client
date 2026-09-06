# ---------------------------------------------------------------------------------------------
#  setup-saros-cutout.ps1 - Saros "AI 去背景" ComfyUI 环境一键安装 (Windows)
#
#  步骤:
#    1. 定位 ComfyUI (portable / 源码部署), 未找到则给出安装指引。
#    2. 安装 saros_cutout 自定义节点 (拷贝脚本同目录的 saros_cutout/ 到 custom_nodes/)。
#    3. 下载 BiRefNet-general ONNX 模型 (GitHub Releases, 972 MB) 到 ComfyUI models/onnx/。
#    4. 安装 onnxruntime (GPU 优先, 失败回退 CPU), 并自检节点注册。
#
#  用法 (PowerShell 5.1+, 无需管理员):
#    powershell -ExecutionPolicy Bypass -File setup-saros-cutout.ps1 [-ComfyRoot <path>] [-SkipModel] [-CpuOnly]
#
#  模型文件名与 scripts/comfy-custom-nodes/saros_cutout/__init__.py 的 DEFAULT_MODEL
#  以及 webview comfyCutout.ts 的 DEFAULT_CUTOUT_MODEL_FILE 保持一致。
# ---------------------------------------------------------------------------------------------

[CmdletBinding()]
param(
    [string]$ComfyRoot = '',
    [switch]$SkipModel,
    [switch]$CpuOnly
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NODE_NAME        = 'SarosBiRefNetCutout'
$NODE_DIR_NAME    = 'saros_cutout'
$MODEL_FILE       = 'BiRefNet-general-epoch_244.onnx'
$MODEL_URL        = 'https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx'
$MODEL_SIZE_BYTES = 972666916

function Write-Step  { param([string]$t) Write-Host "`n== $t" -ForegroundColor Cyan }
function Write-Ok    { param([string]$t) Write-Host "   [OK] $t" -ForegroundColor Green }
function Write-Warn2 { param([string]$t) Write-Host "   [!!] $t" -ForegroundColor Yellow }
function Write-Fail  { param([string]$t) Write-Host "   [X]  $t" -ForegroundColor Red }

function Download-File {
    param([string]$Url, [string]$Dest)
    $tmp = "$Dest.part"
    try {
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $Url -Destination $tmp
        Move-Item -Force $tmp $Dest
        return $true
    } catch {
        Write-Warn2 "BITS 不可用, 回退 Invoke-WebRequest..."
    }
    try {
        $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
        $ProgressPreference = $old
        Move-Item -Force $tmp $Dest
        return $true
    } catch {
        Write-Fail "下载失败: $($_.Exception.Message)"
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        return $false
    }
}

function Find-ComfyRoot {
    if ($ComfyRoot) {
        if (Test-Path (Join-Path $ComfyRoot 'main.py') -PathType Leaf) { return (Resolve-Path $ComfyRoot).Path }
        Write-Warn2 "指定的 -ComfyRoot 下没有 main.py: $ComfyRoot"
    }
    $searchRoots = @($env:USERPROFILE + '\Desktop', $env:USERPROFILE + '\Downloads', 'D:\', 'C:\', 'D:\AI', 'D:\ComfyUI', 'C:\ComfyUI')
    $found = $null
    foreach ($root in $searchRoots) {
        if (-not (Test-Path $root)) { continue }
        $dirs = Get-ChildItem -Path $root -Directory -Filter 'ComfyUI*' -ErrorAction SilentlyContinue
        foreach ($d in $dirs) {
            foreach ($sub in @($d.FullName, (Join-Path $d.FullName 'ComfyUI'))) {
                if (Test-Path (Join-Path $sub 'main.py') -PathType Leaf) { return $sub }
            }
        }
    }
    return $found
}

function Test-NodeRegistered {
    param([string]$BaseUrl)
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/object_info" -UseBasicParsing -TimeoutSec 15
        return ($resp.Content -match [regex]::Escape($NODE_NAME))
    } catch { return $false }
}

# === 主流程 ====================================================================================

Write-Host '============================================================'
Write-Host ' Saros 去背景 (saros_cutout) ComfyUI 环境安装器'
Write-Host '============================================================'

# --- 1. 定位 ComfyUI ---------------------------------------------------------------------------
Write-Step '步骤 1/4: 定位 ComfyUI'
$comfy = Find-ComfyRoot
if (-not $comfy) {
    Write-Warn2 '未找到 ComfyUI, 请先安装 ComfyUI portable:'
    Write-Host  '   1) 打开 https://github.com/comfyanonymous/ComfyUI/releases/latest'
    Write-Host  "   2) 下载 ComfyUI_windows_portable_nvidia.7z (N 卡) 或 ..._cpu.7z"
    Write-Host  '   3) 解压到任意目录, 重新运行本脚本并加参数: -ComfyRoot "<解压目录>\ComfyUI"'
    exit 1
}
Write-Ok "ComfyUI: $comfy"

$customNodes = Join-Path $comfy 'custom_nodes'
$onnxDir     = Join-Path $comfy 'models\onnx'

$pyExe = $null
$candidates = @(
    (Join-Path $comfy 'python_embeded\python.exe'),
    (Join-Path $comfy 'venv\Scripts\python.exe'),
    (Join-Path (Split-Path -Parent $comfy) 'venv\Scripts\python.exe')
)
foreach ($p in $candidates) {
    if (Test-Path $p) { $pyExe = $p; break }
}
if (-not $pyExe) { $pyExe = 'python' }
Write-Ok "Python: $pyExe"

# --- 2. 安装节点 ---------------------------------------------------------------------------------
Write-Step '步骤 2/4: 安装 saros_cutout 节点'
$nodeSource = Join-Path $PSScriptRoot $NODE_DIR_NAME
if (-not (Test-Path (Join-Path $nodeSource '__init__.py'))) {
    Write-Fail "脚本目录下未找到节点源码: $nodeSource"
    Write-Host  '   请将 saros_cutout/ 目录 (含 __init__.py) 放到本脚本同目录后重试,'
    Write-Host  '   或从 Saros 安装包 resources/comfy-custom-nodes/ 获取。'
    exit 1
}
$nodeDest = Join-Path $customNodes $NODE_DIR_NAME
New-Item -ItemType Directory -Force -Path $customNodes | Out-Null
Copy-Item -Path $nodeSource -Destination $nodeDest -Recurse -Force
Write-Ok "节点已安装: $nodeDest"

# --- 3. 下载模型 ---------------------------------------------------------------------------------
Write-Step '步骤 3/4: 下载去背景模型 (972 MB)'
$modelDest = Join-Path $onnxDir $MODEL_FILE
if (Test-Path $modelDest) {
    $size = (Get-Item $modelDest).Length
    if ([Math]::Abs($size - $MODEL_SIZE_BYTES) -lt 1MB) {
        Write-Ok "模型已存在, 跳过下载: $modelDest"
    } else {
        Write-Warn2 "模型文件大小异常 ($size B, 期望 $MODEL_SIZE_BYTES B), 重新下载..."
        Remove-Item $modelDest -Force
        if (-not (Download-File -Url $MODEL_URL -Dest $modelDest)) { exit 1 }
    }
} elseif ($SkipModel) {
    Write-Warn2 '-SkipModel 已指定且模型不存在: 去背景在模型放置前将不可用!'
} else {
    New-Item -ItemType Directory -Force -Path $onnxDir | Out-Null
    if (-not (Download-File -Url $MODEL_URL -Dest $modelDest)) {
        Write-Warn2 '自动下载失败, 请手动下载并放入 models\onnx\:'
        Write-Host  "   $MODEL_URL"
        exit 1
    }
    Write-Ok "模型已下载: $modelDest"
}

# --- 4. 安装 onnxruntime -------------------------------------------------------------------------
Write-Step '步骤 4/4: 安装 onnxruntime'
$ortPkg = 'onnxruntime'
if (-not $CpuOnly) {
    $hasNvidia = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' }) -ne $null
    if ($hasNvidia) { $ortPkg = 'onnxruntime-gpu' }
}
& $pyExe -m pip install $ortPkg --quiet
if ($LASTEXITCODE -ne 0 -and $ortPkg -eq 'onnxruntime-gpu') {
    Write-Warn2 'onnxruntime-gpu 安装失败, 回退 CPU 版...'
    & $pyExe -m pip install onnxruntime --quiet
}
Write-Ok "onnxruntime 已安装 ($ortPkg)"

# --- 自检 ---------------------------------------------------------------------------------------
Write-Step '自检: 启动 ComfyUI 后验证节点注册'
Write-Host  '   请手动启动 ComfyUI (run_nvidia_gpu.bat 或 python main.py), 然后运行:'
Write-Host  "   powershell -Command `"(Invoke-WebRequest 'http://127.0.0.1:8188/object_info').Content -match '$NODE_NAME'`""
Write-Host  '   输出 True 即安装成功。Saros 客户端连接 ComfyUI 后即可使用「AI 去背景」。'
Write-Host ''
Write-Host '完成!' -ForegroundColor Green
