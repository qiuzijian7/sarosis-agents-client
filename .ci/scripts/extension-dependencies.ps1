# Shared, side-effect-free dependency guards for the required webview extensions.

function Get-RequiredExtensionDependencyFiles {
  @(
    'extensions\markdown-math\node_modules\@types\node\index.d.ts',
    'extensions\markdown-math\node_modules\undici-types\index.d.ts',
    'extensions\markdown-math\node_modules\@types\markdown-it\index.d.ts',
    'extensions\mermaid-chat-features\node_modules\@types\node\index.d.ts',
    'extensions\mermaid-chat-features\node_modules\undici-types\index.d.ts',
    'extensions\mermaid-chat-features\node_modules\@vscode\codicons\dist\codicon.css',
    'extensions\mermaid-chat-features\node_modules\@vscode\codicons\dist\codicon.ttf',
    'extensions\mermaid-chat-features\node_modules\dompurify\dist\purify.es.mjs',
    'extensions\mermaid-chat-features\node_modules\dompurify\dist\purify.es.d.mts',
    'extensions\mermaid-chat-features\node_modules\dompurify\dist\purify.cjs.js',
    'extensions\mermaid-chat-features\node_modules\dompurify\dist\purify.cjs.d.ts',
    'dsh-plugins\vssaros-pele\assets\pele.global.js'
  )
}

function Assert-ExtensionBuildDependencies {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $missing = @()
  foreach ($relative in (Get-RequiredExtensionDependencyFiles)) {
    $file = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      $missing += $relative
      continue
    }
    if ((Get-Item -LiteralPath $file -ErrorAction Stop).Length -le 0) { $missing += $relative }
  }
  if ($missing.Count -gt 0) {
    throw ('Required extension build dependencies missing or empty: ' + ($missing -join ', ') + '. Reinstall required extension dependencies before compiling.')
  }
  Write-Host '[deps-check] Required extension build dependencies verified'
}

function Install-RequiredExtensionDependencies {
  param([Parameter(Mandatory = $true)][string]$Directory)
  Push-Location -LiteralPath $Directory -ErrorAction Stop
  try {
    $npmCommand = Get-Command npm -ErrorAction Stop
    $installed = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      Write-Host ('[deps-install] ' + $Directory + ' (attempt ' + $attempt + '/3)')
      $installArgs = @('--ignore-scripts', '--include=dev', '--no-fund', '--no-audit', '--fetch-retries=2', '--fetch-retry-mintimeout=2000', '--fetch-retry-maxtimeout=15000', '--fetch-timeout=60000')
      if ($attempt -gt 1) { $installArgs += '--prefer-offline' }
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        & $npmCommand install @installArgs 2>&1 | Out-Host
        $installExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousPreference
      }
      if ($installExit -eq 0) { $installed = $true; break }
      Write-Host ('[deps-install] Required extension install failed (exit ' + $installExit + ')')
      if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
    }
    if (-not $installed) { throw ('Required extension npm install failed after 3 attempts: ' + $Directory + ' (exit ' + $installExit + ')') }
  } finally {
    Pop-Location
  }
}
