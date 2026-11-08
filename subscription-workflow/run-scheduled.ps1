#Requires -Version 7.0
param([Parameter(Mandatory=$true)][ValidateSet('rss','bilibili','zhihu','daily','weekly')][string]$Kind)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logRoot = 'D:\Artifacts\ProgressiveReading\subscriptions\logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = Join-Path $logRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $Kind + '.log')
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw 'Node runtime missing' }
Set-Location -LiteralPath $projectRoot
# A native scheduler trigger persists the job; the existing local service owns execution.
& $node (Join-Path $PSScriptRoot 'cli.mjs') enqueue --kind $Kind --key ('scheduled-' + (Get-Date -Format 'yyyy-MM-dd')) 2>&1 | Tee-Object -FilePath $log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$service = Get-ScheduledTask -TaskName 'Local IR Browser Highlight' -ErrorAction Stop
if ($service.State -ne 'Running') { Start-ScheduledTask -TaskName $service.TaskName }
