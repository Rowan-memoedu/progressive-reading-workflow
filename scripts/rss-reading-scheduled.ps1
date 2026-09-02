#Requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('daily', 'weekly')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$schedulerRoot = Join-Path $projectRoot 'imports\rss-reading\scheduler'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $schedulerRoot ("{0}-{1}.log" -f $Mode, $timestamp)
$statusPath = Join-Path $schedulerRoot ("{0}-status.json" -f $Mode)
$temporaryStatusPath = "{0}.{1}.tmp" -f $statusPath, $PID
$startedAt = (Get-Date).ToUniversalTime().ToString('o')

New-Item -ItemType Directory -Path $schedulerRoot -Force | Out-Null
Set-Location -LiteralPath $projectRoot

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$npmArgs = @('run', ("rss:orchestrate:{0}" -f $Mode))
$exitCode = 1
$errorMessage = $null

try {
    & $npm @npmArgs *>> $logPath
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        $errorMessage = "npm exited with code $exitCode"
    }
}
catch {
    $errorMessage = $_.Exception.Message
    $errorMessage | Out-File -LiteralPath $logPath -Append -Encoding utf8
    $exitCode = 1
}

$status = [ordered]@{
    schema_version = 'progressive-reading.rss-scheduler-status/v1'
    mode = $Mode
    status = if ($exitCode -eq 0) { 'completed' } else { 'failed' }
    started_at = $startedAt
    completed_at = (Get-Date).ToUniversalTime().ToString('o')
    exit_code = $exitCode
    command = "npm run rss:orchestrate:$Mode"
    project_root = $projectRoot
    log_path = $logPath
    error = $errorMessage
}

$status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryStatusPath -Encoding utf8
Move-Item -LiteralPath $temporaryStatusPath -Destination $statusPath -Force
exit $exitCode
