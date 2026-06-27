# MCP 工具诊断脚本
# 用法：重新加载 IDE 窗口后，发送一条测试消息，然后运行此脚本
# PowerShell -ExecutionPolicy Bypass -File dev\diag-mcp-tools.ps1

$logDir = "$env:APPDATA\CodeBuddy CN\logs"
$latestDir = Get-ChildItem $logDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latestDir) {
    Write-Host "❌ 未找到日志目录" -ForegroundColor Red
    exit 1
}
Write-Host "最新日志目录: $($latestDir.Name)" -ForegroundColor Cyan

# 搜索所有窗口的 renderer.log
$rendererLogs = Get-ChildItem $latestDir.FullName -Recurse -Filter "renderer.log" -ErrorAction SilentlyContinue
foreach ($log in $rendererLogs) {
    Write-Host "`n=== $($log.FullName) ===" -ForegroundColor Yellow
    $content = Get-Content $log.FullName -ErrorAction SilentlyContinue

    # 关键诊断日志
    $patterns = @(
        "McpToolProvider.*_wire",
        "McpToolProvider.*Server:",
        "McpToolProvider.*route:",
        "McpToolProvider.*tool routes updated",
        "McpToolProvider.*_inferSecurityLevel",
        "AgentDriver.*Tool inventory",
        "AgentDriver.*MCP",
        "AgentOS.*Direct mode tools",
        "AgentOS.*TOOLS SENT TO LLM",
        "AgentOS.*No MCP tools",
        "BYOK.*sending.*tools",
        "BYOK.*NO tools",
        "CodebaseMemory.*Bootstrap",
        "CodebaseMemory.*Server"
    )

    foreach ($pattern in $patterns) {
        $matches = $content | Select-String -Pattern $pattern -ErrorAction SilentlyContinue
        foreach ($m in $matches) {
            Write-Host "  $($m.Line)" -ForegroundColor White
        }
    }
}

# 检查 agentStudio.log
$agentStudioLog = Join-Path $latestDir.FullName "window1\agentStudio.log"
if (Test-Path $agentStudioLog) {
    Write-Host "`n=== agentStudio.log ===" -ForegroundColor Yellow
    $content = Get-Content $agentStudioLog -ErrorAction SilentlyContinue
    $matches = $content | Select-String -Pattern "CodebaseMemory|McpToolProvider|MCP" -ErrorAction SilentlyContinue
    foreach ($m in $matches) {
        Write-Host "  $($m.Line)" -ForegroundColor White
    }
}

# 检查 MCP 进程
Write-Host "`n=== MCP 进程状态 ===" -ForegroundColor Yellow
$procs = Get-Process -Name "codebase-memory-mcp" -ErrorAction SilentlyContinue
if ($procs) {
    foreach ($p in $procs) {
        Write-Host "  PID=$($p.Id), Memory=$([math]::Round($p.WorkingSet64/1KB))KB" -ForegroundColor Green
    }
} else {
    Write-Host "  ❌ codebase-memory-mcp 进程未运行!" -ForegroundColor Red
}

# 检查 MCP 配置
Write-Host "`n=== MCP 配置 ===" -ForegroundColor Yellow
$mcpConfig = "$env:USERPROFILE\.saros\mcp.json"
if (Test-Path $mcpConfig) {
    Write-Host "  配置文件: $mcpConfig" -ForegroundColor Green
    $config = Get-Content $mcpConfig -Raw | ConvertFrom-Json
    $servers = $config.servers.PSObject.Properties.Name
    Write-Host "  配置的服务器: $($servers -join ', ')" -ForegroundColor Green
} else {
    Write-Host "  ❌ ~/.saros/mcp.json 不存在!" -ForegroundColor Red
}

Write-Host "`n=== 诊断完成 ===" -ForegroundColor Cyan
Write-Host @"
诊断指南：
- 如果 'McpToolProvider.*Server:' 显示 0 个服务器 → MCP 服务未发现，检查配置
- 如果服务器存在但 tools=0 → MCP 服务器未连接或未返回工具列表
- 如果工具存在但 'AgentDriver.*MCP: all=0' → McpToolProvider._routes 未传播
- 如果 'MCP: all>0 but afterFilter=0' → chatModeConfig 过滤问题，检查 securityLevel
- 如果 'TOOLS SENT TO LLM' 中 MCP=0 → enabledTools 不含 MCP 工具
- 如果 'BYOK.*sending.*tools' 中 MCP=0 → HTTP 请求未包含 MCP 工具
"@ -ForegroundColor Gray
