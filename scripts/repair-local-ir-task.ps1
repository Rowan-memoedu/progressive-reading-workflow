#Requires -Version 7.4
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$name = 'Local IR Browser Highlight'
$task = Get-ScheduledTask -TaskName $name
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Apply) {
    $task.Settings | Select-Object RestartCount, RestartInterval, ExecutionTimeLimit, MultipleInstances
    return
}
$evidence = Join-Path 'D:\Artifacts\ProgressiveReading\activation' ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-task')
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
Export-ScheduledTask -TaskName $name | Set-Content (Join-Path $evidence 'before.xml')
$runner = Join-Path $PSScriptRoot 'run-local-ir-app.ps1'
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $runner,(Get-Command node.exe).Source
$action = New-ScheduledTaskAction -Execute (Get-Command pwsh.exe).Source -Argument $arguments -WorkingDirectory $root
# Preserve account, logon trigger, and other settings on the existing task.
$settings = $task.Settings
$settings.RestartCount = 99
$settings.RestartInterval = 'PT1M'
$settings.ExecutionTimeLimit = 'PT0S'
$settings.MultipleInstances = 'IgnoreNew'
$settings.StartWhenAvailable = $true
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$triggers = @($task.Triggers | Where-Object { $_.Id -ne 'LocalIrAvailability' })
$availability = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$availability.Id = 'LocalIrAvailability'
$triggers += $availability
# Native repetition also restores a clean exit; IgnoreNew leaves a healthy run alone.
Set-ScheduledTask -TaskName $name -Action $action -Settings $settings -Trigger $triggers | Out-Null
Export-ScheduledTask -TaskName $name | Set-Content (Join-Path $evidence 'after.xml')
[pscustomobject]@{status='configured';task=$name;evidence=$evidence} | ConvertTo-Json
