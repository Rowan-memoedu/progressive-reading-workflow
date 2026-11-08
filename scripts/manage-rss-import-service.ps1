#Requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Install','Status','Pause','Resume')][string]$Action='Status')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$taskName='ProgressiveReading-RSS-Import'
$runner=Join-Path $PSScriptRoot 'run-rss-import.ps1'
$task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and ($task.Actions.WorkingDirectory -ne $projectRoot -or -not $task.Actions.Arguments.Contains($runner))) { throw 'Task ownership mismatch' }
if ($Action -eq 'Install') {
    if ($task) { throw 'Task already exists; use Resume or inspect its configuration.' }
    $node=(Get-Command node.exe -ErrorAction Stop).Source
    $pwsh=@((Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),(Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe')) | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
    if (-not $pwsh) { throw 'Stable PowerShell 7 not found' }
    if (-not (Test-Path -LiteralPath 'D:\AppData\RSSImport\RSS 自动导入.md')) { throw 'RSS configuration document not found' }
    $arguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $runner,$node
    $taskAction=New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $projectRoot
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'RSS subscriptions to the shared standard Obsidian import workflow; no daily/weekly reports or approval.' | Out-Null
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
} elseif ($Action -eq 'Pause' -and $task) {
    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -TaskPath '\' }
    # Task Scheduler may stop the PowerShell parent while leaving Node alive.
    # Stop only the process holding this importer's lock after checking its command.
    $lockPath='D:\AppData\RSSImport\runtime.lock.json'
    if (Test-Path -LiteralPath $lockPath) {
        $rssLock=Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        $rssDaemon=Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$rssLock.pid)
        if ($rssDaemon) {
            $rssEntry=Join-Path $projectRoot 'rss-import\cli.mjs'
            if (-not $rssDaemon.CommandLine.Contains($rssEntry) -or $rssDaemon.CommandLine -notmatch '(?:^|\s)watch(?:\s|$)') { throw 'Refusing to stop an unowned RSS state writer' }
            Stop-Process -Id $rssDaemon.ProcessId -Force -ErrorAction Stop
            Wait-Process -Id $rssDaemon.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
} elseif ($Action -eq 'Resume' -and $task) {
    Enable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
}
$task=Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
    $info=Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
    [pscustomobject]@{task=$taskName;state=[string]$task.State;enabled=$task.Settings.Enabled;last_result=$info.LastTaskResult;config='D:\AppData\RSSImport\RSS 自动导入.md';health='D:\AppData\RSSImport\health.json'} | ConvertTo-Json
} else { [pscustomobject]@{task=$taskName;installed=$false} | ConvertTo-Json }
