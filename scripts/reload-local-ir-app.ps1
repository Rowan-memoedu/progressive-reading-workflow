#Requires -Version 7.4
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $projectRoot 'scripts\progressive-reading-app.mjs'
$port = 37829
$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($listeners.Count -gt 1) { throw 'Multiple listeners; refusing to reload' }
$oldId = if ($listeners.Count) { $listeners[0] } else { $null }
if ($oldId) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$oldId"
    $entryToken = '(?:^|\s)(?:"' + [regex]::Escape($entry) + '"|' + [regex]::Escape($entry) + ')(?:\s|$)'
    if ($processInfo.Name -ne 'node.exe' -or $processInfo.CommandLine -notmatch $entryToken) { throw 'Listener does not match the exact progressive-reading entry point' }
}
$statePath = Join-Path $projectRoot '.local-ir\browser-import-broker\state.json'
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if (@($state.tasks | Where-Object { $_.status -in @('queued','claimed') }).Count) { throw 'Import tasks are active; reload deferred' }
}
if (-not $Apply) {
    [pscustomobject]@{status='ready_for_reload'; project=$projectRoot; old_pid=$oldId; port=$port; snapshot_mode='durable_live_sync_with_legacy_pointer_fallback'} | ConvertTo-Json
    return
}
$taskName = 'Local IR Browser Highlight'
$task = Get-ScheduledTask -TaskName $taskName
$runner = Join-Path $PSScriptRoot 'run-local-ir-app.ps1'
if ($task.Actions.Count -ne 1 -or $task.Actions[0].Arguments -notlike "*`"$runner`"*") { throw 'Run repair-local-ir-task.ps1 -Apply before reloading; persistent task runner is required' }
$logRoot = Join-Path 'D:\Artifacts\ProgressiveReading\activation' (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
    for ($i=0; $i -lt 30 -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 500 }
    if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { throw 'Scheduled task did not stop' }
}
if ($oldId -and (Get-Process -Id $oldId -ErrorAction SilentlyContinue)) { Stop-Process -Id $oldId; Wait-Process -Id $oldId -Timeout 15 -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName $taskName
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $auth = Invoke-RestMethod "http://127.0.0.1:$port/api/browser-import/cookies/status" -TimeoutSec 2
        $rules = Invoke-RestMethod "http://127.0.0.1:$port/api/browser-import/rules" -TimeoutSec 2
        $page = Invoke-WebRequest "http://127.0.0.1:$port/import" -TimeoutSec 2
        $owner = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        $newProcess = if ($owner.Count -eq 1) { Get-CimInstance Win32_Process -Filter "ProcessId=$($owner[0])" } else { $null }
        $parent = if ($newProcess) { Get-CimInstance Win32_Process -Filter "ProcessId=$($newProcess.ParentProcessId)" } else { $null }
        if ($newProcess -and $newProcess.ProcessId -ne $oldId -and $newProcess.Name -eq 'node.exe' -and $newProcess.CommandLine.Contains($entry) -and $parent.CommandLine.Contains($runner) -and (Get-ScheduledTask -TaskName $taskName).State -eq 'Running' -and $auth.receiver_enabled -and $auth.mode -ne 'manual_snapshot' -and $auth.schema -eq 'local-ir.chrome-live-sync/v1' -and $rules.schema -eq 'local-ir.import-rules/v1' -and $page.StatusCode -eq 200) {
            $receipt = @{status='activated'; launcher='windows_scheduled_task'; task=$taskName; old_pid=$oldId; new_pid=$newProcess.ProcessId; auth=$auth; rules_schema=$rules.schema; web_import_http=$page.StatusCode}
            $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logRoot 'activation.json') -Encoding utf8
            $receipt | ConvertTo-Json -Depth 5
            return
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}
throw 'Activation did not pass; inspect D:\Artifacts\ProgressiveReading\service-logs and the scheduled task status'
