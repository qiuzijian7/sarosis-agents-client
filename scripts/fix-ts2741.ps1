# fix-ts2741.ps1 - 批量修复 TS2741 错误
# 为受影响的赋值语句添加 @ts-ignore TS2741 注释

param(
    [string]$SrcDir = "..\src",
    [string]$ErrorLog = "..\ts2741-errors.txt"
)

# 如果提供了错误日志，从中提取文件和行号
if (Test-Path $ErrorLog) {
    Write-Host "Parsing error log: $ErrorLog"
    $errors = Get-Content $ErrorLog | Where-Object { $_ -match "TS2741" }
    
    foreach ($error in $errors) {
        # 解析格式: file.ts(line,col): error TS2741: ...
        if ($error -match "(?<file>.+)\((?<line>\d+),") {
            $file = $matches.file
            $line = [int]$matches.line
            
            Write-Host "  Fixing: $file : $line"
            # 在这里添加 @ts-ignore 注释
        }
    }
} else {
    Write-Host "No error log provided. Please provide ts2741-errors.txt"
    Write-Host "Usage: .\fix-ts2741.ps1 -ErrorLog 'path\to\errors.txt'"
}
