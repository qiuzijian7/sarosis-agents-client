# deploy-update-server.ps1
# 在目标服务器上部署 VsSarosis 更新服务器

param(
    [string]$ServerIP = "21.139.192.124",
    [string]$DeployPath = "C:\vssaros-update",
    [int]$Port = 3030
)

Write-Host "=== VsSarosis 更新服务器部署脚本 ===" -ForegroundColor Green
Write-Host "目标服务器: $ServerIP" -ForegroundColor Yellow
Write-Host "部署路径: $DeployPath" -ForegroundColor Yellow
Write-Host "服务端口: $Port" -ForegroundColor Yellow
Write-Host ""

# 1. 创建部署目录
Write-Host "[1/5] 创建部署目录..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null

# 2. 复制更新服务器文件
Write-Host "[2/5] 复制更新服务器文件..." -ForegroundColor Cyan
$sourcePath = "..\update-server"
$destPath = "$DeployPath\update-server"
if (Test-Path $destPath) {
    Remove-Item -Recurse -Force $destPath
}
Copy-Item -Recurse -Force $sourcePath $destPath

# 2.5 可选组件包（媒体 / Office / Whisper）：同步到 DOWNLOADS_DIR/components。
# 先执行 node build/saros/package-components.mjs 生成；不存在时保留服务器现有组件。
$componentsSource = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'build\saros\update-server\downloads\components'
if (Test-Path -LiteralPath $componentsSource) {
    $downloadsDest = Join-Path $DeployPath 'downloads'
    $componentsDest = Join-Path $downloadsDest 'components'
    New-Item -ItemType Directory -Force -Path $componentsDest | Out-Null
    Copy-Item -Path (Join-Path $componentsSource '*') -Destination $componentsDest -Recurse -Force
    Write-Host "[OK] 已同步可选组件包到 $componentsDest" -ForegroundColor Green
} else {
    Write-Host "[WARN] 未找到 $componentsSource；服务器沿用现有组件包" -ForegroundColor Yellow
}

# 2.6 dsh 插件补丁包（插件级升级 P0）：同步到 DOWNLOADS_DIR/plugins，服务端 /api/dsh-plugins 读取。
# 由 node build/saros/package-dsh-plugins.mjs 生成。私钥/公钥绝不复制到公开下载目录
# （/downloads/** 是匿名可读的静态路由）。
$pluginsSource = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'build\saros\update-server\downloads\plugins'
if (Test-Path -LiteralPath $pluginsSource) {
    $downloadsDest = Join-Path $DeployPath 'downloads'
    $pluginsDest = Join-Path $downloadsDest 'plugins'
    New-Item -ItemType Directory -Force -Path $pluginsDest | Out-Null
    $copied = 0
    foreach ($f in Get-ChildItem -LiteralPath $pluginsSource -File) {
        if ($f.Extension -eq '.pem' -or $f.Name -eq 'plugin-signing-key.pem') {
            Write-Host "[WARN] 跳过密钥文件（不得公开）：$($f.Name)" -ForegroundColor Yellow
            continue
        }
        Copy-Item -LiteralPath $f.FullName -Destination $pluginsDest -Force
        $copied++
    }
    if (Test-Path -LiteralPath (Join-Path $pluginsSource 'plugins-manifest.json')) {
        Write-Host "[OK] 已同步 $copied 个插件补丁文件到 $pluginsDest" -ForegroundColor Green
    } else {
        Write-Host "[WARN] 缺 plugins-manifest.json；/api/dsh-plugins 会返回 404" -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARN] 未找到 $pluginsSource；服务器沿用现有插件补丁包" -ForegroundColor Yellow
}

# 3. 创建 package.json (如果需要)
Write-Host "[3/5] 创建 package.json..." -ForegroundColor Cyan
$packageJson = @{
    name = "vssaros-update-server"
    version = "1.0.0"
    description = "VsSarosis hot update server"
    main = "server.mjs"
    scripts = @{
        start = "node server.mjs"
        dev = "nodemon server.mjs"
    }
    dependencies = @{
        # server.mjs 是零依赖，不需要安装任何包
    }
}
$packageJson | ConvertTo-Json | Out-File -FilePath "$DeployPath\update-server\package.json" -Encoding UTF8

# 4. 创建启动脚本
Write-Host "[4/5] 创建启动脚本..." -ForegroundColor Cyan
$startScript = @"
# 启动 VsSarosis 更新服务器
`$env:PORT = $Port
# Windows 安装包内置 ffmpeg / whisper 后约 760 MiB，旧的 512 MiB 上限会拒收
`$env:MAX_UPLOAD_SIZE = 2147483648
`$env:MAX_DOWNLOAD_SIZE = 2147483648
node `$PSScriptRoot\update-server\server.mjs
"@
$startScript | Out-File -FilePath "$DeployPath\start.ps1" -Encoding UTF8

# 5. 创建 PM2 配置文件 (可选，如果使用 PM2 管理进程)
Write-Host "[5/5] 创建 PM2 配置..." -ForegroundColor Cyan
$pm2Config = @{
    apps = @(
        @{
            name = "vssaros-update"
            script = "update-server/server.mjs"
            instances = 1
            autorestart = $true
            watch = $false
            env = @{
                NODE_ENV = "production"
                PORT = $Port
                MAX_UPLOAD_SIZE = 2147483648
                MAX_DOWNLOAD_SIZE = 2147483648
            }
        }
    )
}
$pm2Config | ConvertTo-Json -Depth 10 | Out-File -FilePath "$DeployPath\ecosystem.config.js" -Encoding UTF8

Write-Host ""
Write-Host "=== 部署完成 ===" -ForegroundColor Green
Write-Host "部署路径: $DeployPath" -ForegroundColor Yellow
Write-Host ""
Write-Host "下一步操作:" -ForegroundColor Magenta
Write-Host "1. 进入部署目录: cd $DeployPath" -ForegroundColor White
Write-Host "2. 安装 PM2 (可选): npm install -g pm2" -ForegroundColor White
Write-Host "3. 使用 PM2 启动: pm2 start ecosystem.config.js" -ForegroundColor White
Write-Host "4. 或直接启动: .\start.ps1" -ForegroundColor White
Write-Host "5. 测试服务: curl http://localhost:$Port/health" -ForegroundColor White
Write-Host ""
Write-Host "更新服务器 URL: http://${ServerIP}:$Port" -ForegroundColor Green
