# deploy-update-server.ps1
# 在目标服务器上部署 VsSarosis 更新服务器

param(
    [string]$ServerIP = "21.91.41.66",
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
Write-Host "更新服务器 URL: http://$ServerIP:$Port" -ForegroundColor Green
