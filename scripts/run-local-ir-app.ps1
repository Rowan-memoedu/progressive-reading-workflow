#Requires -Version 7.4
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logRoot = 'D:\Artifacts\ProgressiveReading\service-logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$env:PROGRESSIVE_READING_WORKFLOW_ROOT = $projectRoot
$env:PROGRESSIVE_READING_APP_PORT = '37829'
$env:PROGRESSIVE_READING_COOKIE_SNAPSHOT_PATH = ''
$env:PROGRESSIVE_READING_COOKIE_DATA_ROOT = 'D:\AppData\ProgressiveReading\BrowserAuth'
$env:PROGRESSIVE_READING_URL_COOKIE_MAP_JSON = ''
$env:PROGRESSIVE_READING_BROWSER_PREPROCESS_TEST_PRODUCER = ''
$env:AI_PRODUCER_PROVIDER = 'codex_exec'
$env:NODE_ENV = 'production'
Set-Location -LiteralPath $projectRoot
"$(Get-Date -Format o) starting" | Set-Content (Join-Path $logRoot "$stamp.lifecycle.log")
try {
    & $NodePath (Join-Path $PSScriptRoot 'progressive-reading-app.mjs') 1>> (Join-Path $logRoot "$stamp.stdout.log") 2>> (Join-Path $logRoot "$stamp.stderr.log")
    $result = $LASTEXITCODE
} catch {
    $_ | Out-String | Add-Content (Join-Path $logRoot "$stamp.stderr.log")
    $result = 1
}
"$(Get-Date -Format o) exited code=$result" | Add-Content (Join-Path $logRoot "$stamp.lifecycle.log")
if ($result -ne 0) { exit 1 }
exit 0
