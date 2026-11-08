#Requires -Version 7.0
[CmdletBinding()]
param([switch]$Status)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = 'D:\AppData\BotReading'
$taskName = 'ProgressiveReading-BotInbox'
if (-not $Status) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task already exists; inspect before replacing.' }
    $cliRoot = (Get-Item "$env:APPDATA\npm\node_modules\cn-im-cli").Target
    if (-not $cliRoot) { $cliRoot = "$env:APPDATA\npm\node_modules\cn-im-cli" }
    if (-not (Test-Path (Join-Path $cliRoot 'bin\qq-cli.mjs'))) { throw 'Bot CLI missing' }
    if (Test-Path (Join-Path $dataRoot 'config.json')) { throw 'Existing configuration requires inspection.' }
    $allowed = @{}
    foreach ($provider in @('qq','weixin')) {
        $original = Join-Path $env:USERPROFILE ".cn-im\$provider"
        $events = @(Get-Content (Join-Path $original 'events.jsonl') | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object direction -eq inbound)
        $senders = @($events | ForEach-Object { if ($provider -eq 'qq') { if ($_.user_openid) { $_.user_openid } else { $_.author_id } } else { $_.from_user_id } } | Where-Object { $_ } | Sort-Object -Unique)
        if ($senders.Count -ne 1) { throw "Cannot uniquely recover the authorized $provider sender" }
        $allowed[$provider] = $senders
        $target = Join-Path $dataRoot "bot-home\$provider"
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        # Keep encrypted credentials; do not copy historical message bodies or delete originals.
        Copy-Item -LiteralPath (Join-Path $original 'config.json') -Destination (Join-Path $target 'config.json')
        if ($provider -eq 'weixin' -and (Test-Path (Join-Path $original 'sync.json'))) {
            Copy-Item -LiteralPath (Join-Path $original 'sync.json') -Destination (Join-Path $target 'sync.json')
        }
    }
    @{ since=(Get-Date).ToUniversalTime().ToString('o'); dailyHour=20; allowedSenders=$allowed; cliRoot=$cliRoot } |
        ConvertTo-Json -Depth 5 | Set-Content (Join-Path $dataRoot 'config.json') -Encoding utf8NoBOM
    $node = (Get-Command node.exe).Source
    $pwsh = (Get-Command pwsh.exe).Source
    $runner = Join-Path $PSScriptRoot 'run-bot-reading.ps1'
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}"' -f $runner,$node
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $projectRoot
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Silent QQ/Weixin link inbox; first-link experiment, then daily 20:00 local import.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
}
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[ordered]@{ task=$taskName; state=[string]$task.State; lastResult=$info.LastTaskResult; data=$dataRoot; daily='20:00 Asia/Shanghai'; experiment='first new authorized link'; } | ConvertTo-Json
