#Requires -Version 5.1
[CmdletBinding()]
param([ValidateSet('Install', 'Status', 'Run', 'Pause', 'Resume')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$taskName = 'ProgressiveReading-VideoWatch-Daily'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-watch-scheduled.ps1'
$dataRoot = 'D:\AppData\ProgressiveReading\VideoWatch'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions[0].WorkingDirectory -ne $projectRoot -or -not $existing.Actions[0].Arguments.Contains($runner))) {
    throw 'Existing task does not belong to this video watcher'
}
if ($Action -eq 'Install') {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $gh = (Get-Command gh.exe -ErrorAction Stop).Source
    $codex = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'
    if (-not (Test-Path -LiteralPath $codex)) { throw 'Stable model CLI executable was not found' }
    $python = 'D:\Caches\ProgressiveReading\videobook-python\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Video Python runtime was not found' }
    $toastApp = Get-StartApps | Where-Object { $_.Name -eq 'Windows PowerShell' } | Select-Object -First 1 -ExpandProperty AppID
    $runtime = [ordered]@{ node = $node; python = $python; gh = $gh; codex = $codex; toast_app_id = $toastApp }
    [void][System.IO.Directory]::CreateDirectory($dataRoot)
    [System.IO.File]::WriteAllText((Join-Path $dataRoot 'scheduler-runtime.json'), ($runtime | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -OnlyIfDue' -f $runner
    $taskAction = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At '08:00'
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $logonTrigger.Delay = 'PT1M'
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($trigger, $logonTrigger) -Principal $principal -Settings $settings -Description 'Incremental video reading at 08:00; logon catch-up only when the daily check is incomplete' -Force | Out-Null
} elseif ($Action -eq 'Run') { Start-ScheduledTask -TaskName $taskName }
elseif ($Action -eq 'Pause') { Disable-ScheduledTask -TaskName $taskName | Out-Null }
elseif ($Action -eq 'Resume') { Enable-ScheduledTask -TaskName $taskName | Out-Null }
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $taskName
[ordered]@{ name = $task.TaskName; state = [string]$task.State; next_run = $info.NextRunTime.ToString('o');
    last_run = $info.LastRunTime.ToString('o'); last_result = $info.LastTaskResult; execute = $task.Actions[0].Execute;
    arguments = $task.Actions[0].Arguments; multiple_instances = [string]$task.Settings.MultipleInstances;
    logon_type = [string]$task.Principal.LogonType; start_when_available = $task.Settings.StartWhenAvailable } | ConvertTo-Json
