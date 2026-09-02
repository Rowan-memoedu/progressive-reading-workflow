#Requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Remove')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'rss-reading-scheduled.ps1'
$pwshCandidates = @(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe')
)
$pwsh = $pwshCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $pwsh) {
    throw 'A stable PowerShell 7 installation was not found under Program Files or WindowsApps.'
}
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskDefinitions = @(
    [ordered]@{
        Name = 'ProgressiveReading-RSS-Daily'
        Mode = 'daily'
        Trigger = New-ScheduledTaskTrigger -Daily -At '07:00'
    },
    [ordered]@{
        Name = 'ProgressiveReading-RSS-Weekly'
        Mode = 'weekly'
        Trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At '21:00'
    }
)

if ($Action -eq 'Install') {
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
        throw "Scheduler runner not found: $runner"
    }
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    foreach ($definition in $taskDefinitions) {
        $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode {1}' -f $runner, $definition.Mode
        $taskAction = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $projectRoot
        Register-ScheduledTask -TaskName $definition.Name -Action $taskAction -Trigger $definition.Trigger -Principal $principal -Settings $settings -Description "Progressive Reading RSS $($definition.Mode) CLI orchestration" -Force | Out-Null
    }
}
elseif ($Action -eq 'Remove') {
    foreach ($definition in $taskDefinitions) {
        if (Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $definition.Name -Confirm:$false
        }
    }
}

$result = foreach ($definition in $taskDefinitions) {
    $task = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
    if (-not $task) {
        [ordered]@{ name = $definition.Name; installed = $false }
        continue
    }
    $info = Get-ScheduledTaskInfo -TaskName $definition.Name
    [ordered]@{
        name = $definition.Name
        installed = $true
        state = [string]$task.State
        next_run_time = if ($info.NextRunTime -eq [datetime]::MinValue) { $null } else { $info.NextRunTime.ToString('o') }
        last_run_time = if ($info.LastRunTime -eq [datetime]::MinValue) { $null } else { $info.LastRunTime.ToString('o') }
        last_task_result = $info.LastTaskResult
        execute = $task.Actions[0].Execute
        arguments = $task.Actions[0].Arguments
        working_directory = $task.Actions[0].WorkingDirectory
    }
}

[ordered]@{
    schema_version = 'progressive-reading.rss-scheduler-registration/v1'
    action = $Action
    checked_at = (Get-Date).ToUniversalTime().ToString('o')
    tasks = @($result)
} | ConvertTo-Json -Depth 5
