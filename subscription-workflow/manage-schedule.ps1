#Requires -Version 7.0
param([ValidateSet('Install','Status')][string]$Action='Status')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$definitions = @(
    @{Name='ProgressiveReading-RSS-Source';Kind='rss';Time='06:00'},
    @{Name='ProgressiveReading-Zhihu-Source';Kind='zhihu';Time='07:00'},
    @{Name='ProgressiveReading-VideoWatch-Daily';Kind='bilibili';Time='08:00'},
    @{Name='ProgressiveReading-RSS-Daily';Kind='daily';Time='09:00'},
    @{Name='ProgressiveReading-RSS-Weekly';Kind='weekly';Time='21:00'}
)
if ($Action -eq 'Install') {
    if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'Beijing scheduling requires explicit timezone conversion on this host' }
    $backup = Join-Path 'D:\Artifacts\ProgressiveReading\subscriptions-20261106\schedule-before' (Get-Date -Format 'yyyyMMdd-HHmmss')
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    foreach ($definition in $definitions) {
        $existing = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
        if ($existing) {
            if ($existing.State -eq 'Running') { throw "Task still running: $($definition.Name)" }
            if (-not ($existing.Actions | Where-Object { $_.WorkingDirectory -eq $projectRoot -or $_.Arguments.Contains($projectRoot) })) { throw "Task ownership mismatch: $($definition.Name)" }
            Export-ScheduledTask -TaskName $definition.Name | Set-Content -LiteralPath (Join-Path $backup ($definition.Name + '.xml')) -Encoding utf8
        }
        $trigger = if ($definition.Kind -eq 'weekly') { New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At $definition.Time } else { New-ScheduledTaskTrigger -Daily -At $definition.Time }
        $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Kind {1}' -f (Join-Path $PSScriptRoot 'run-scheduled.ps1'), $definition.Kind
        $taskAction = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $projectRoot
        Register-ScheduledTask -TaskName $definition.Name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Unified subscriptions: $($definition.Kind), Beijing $($definition.Time)" -Force | Out-Null
    }
}
foreach ($definition in $definitions) {
    $task = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $definition.Name
        [pscustomobject]@{name=$task.TaskName;enabled=$task.Settings.Enabled;state=[string]$task.State;next_run=$info.NextRunTime;arguments=$task.Actions.Arguments} | ConvertTo-Json -Compress
    }
}
