# Keep verified dependency layers in the reused CI workspace; never cache an incomplete install.

function Initialize-DependencyCache {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $script:dependencyCacheRoot = $RepoRoot
  $script:dependencyCacheTool = Join-Path $RepoRoot 'build\saros\dependency-cache.cjs'
  $script:dependencyPlanFile = Join-Path $RepoRoot ('.build\dependency-plan-' + $PID + '.json')
  $npmCommand = Get-Command npm -ErrorAction Stop
  $env:SAROS_DEPENDENCY_NPM = [string](& $npmCommand --version)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve npm version for dependency cache' }
  $pythonCommand = Get-Command python -ErrorAction Stop
  $pythonVersion = [string](& $pythonCommand --version 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Python version for dependency cache' }
  $sdkVersions = @(Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Include' -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name | Sort-Object)
  $env:SAROS_DEPENDENCY_TOOLCHAIN = (@($latestMsvc.Name, $vsPath, ($sdkVersions -join ','), $pythonVersion, $env:GYP_MSVS_VERSION, $env:npm_config_runtime, $env:npm_config_target, $env:npm_config_arch, $env:npm_config_build_from_source, $env:CC, $env:CXX, $env:CFLAGS, $env:CXXFLAGS, $env:LDFLAGS) -join '|')
  $planText = & node $script:dependencyCacheTool --plan
  if ($LASTEXITCODE -ne 0) { throw 'Dependency cache planning failed' }
  $script:dependencyPlan = ConvertFrom-Json ([string]::Join([Environment]::NewLine, [string[]]$planText))
  $script:dependencyEntries = @{}
  foreach ($entry in $script:dependencyPlan.entries) {
    $entry | Add-Member -NotePropertyName completed -NotePropertyValue $false
    if ($env:SAROS_INSTALL_CACHE -eq '0') { $entry.hit = $false }
    $script:dependencyEntries[$entry.relative] = $entry
  }
}

function Test-DependencyLayer {
  param([AllowEmptyString()][string]$Relative)
  if (-not $script:dependencyEntries.ContainsKey($Relative)) { throw ('Unplanned dependency layer: ' + $Relative) }
  $entry = $script:dependencyEntries[$Relative]
  Write-Host ('[deps-cache] ' + $(if ($Relative) { $Relative } else { 'root' }) + ': ' + $(if ($entry.hit) { 'hit' } else { 'miss' }) + ' (' + $entry.reason + ')')
  return [bool]$entry.hit
}

function Clear-DependencyLayer {
  param([AllowEmptyString()][string]$Relative)
  & node $script:dependencyCacheTool --clean $Relative
  if ($LASTEXITCODE -ne 0) { throw ('Cannot clean dependency layer: ' + $Relative) }
}

function Complete-DependencyLayer {
  param([AllowEmptyString()][string]$Relative)
  if (-not $script:dependencyEntries.ContainsKey($Relative)) { throw ('Unplanned completed dependency layer: ' + $Relative) }
  $script:dependencyEntries[$Relative].completed = $true
}

function Save-DependencyCache {
  New-Item -ItemType Directory -Force -Path (Split-Path $script:dependencyPlanFile) | Out-Null
  [IO.File]::WriteAllText($script:dependencyPlanFile, ($script:dependencyPlan | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
  try {
    & node $script:dependencyCacheTool --seal $script:dependencyPlanFile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency cache sealing failed' }
  } finally {
    Remove-Item -LiteralPath $script:dependencyPlanFile -Force -ErrorAction SilentlyContinue
  }
}
