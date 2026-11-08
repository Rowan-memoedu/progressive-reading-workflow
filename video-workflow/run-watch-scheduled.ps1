#Requires -Version 5.1
[CmdletBinding()]
param([switch]$OnlyIfDue)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = 'D:\AppData\ProgressiveReading\VideoWatch'
$artifactRoot = 'D:\Artifacts\ProgressiveReading\video-watch\scheduler'
[void][System.IO.Directory]::CreateDirectory($artifactRoot)
$logFile = Join-Path $artifactRoot ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.log')
$statusFile = Join-Path $dataRoot 'scheduler-status.json'
$previous = $null
if (Test-Path -LiteralPath $statusFile) {
    try { $previous = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $previous = $null }
}
. (Join-Path $PSScriptRoot 'watch-schedule-policy.ps1')
if ($OnlyIfDue -and -not (Test-VideoWatchDue -Previous $previous)) {
    $skipped = [ordered]@{status='skipped_not_due';checked_at=[DateTime]::UtcNow.ToString('o')}
    [System.IO.File]::WriteAllText((Join-Path $dataRoot 'last-trigger.json'), ($skipped | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    exit 0
}
$started = [DateTime]::UtcNow
$exitCode = 1
$errorMessage = $null
$notificationError = $null
$check = $null
$status = 'failed'
$notice = $false
[System.IO.File]::WriteAllText($logFile, ('Started ' + $started.ToString('o') + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
$running = [ordered]@{scheduler='Windows Task Scheduler';status='running';started_at=$started.ToString('o');exit_code=$null;log_path=$logFile;pid=$PID}
[System.IO.File]::WriteAllText($statusFile, ($running | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

try {
    $runtime = Get-Content -LiteralPath (Join-Path $dataRoot 'scheduler-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($file in @($runtime.node, $runtime.python, $runtime.gh)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing runtime executable: $file" }
    }
    $directories = @((Split-Path -Parent $runtime.node), (Split-Path -Parent $runtime.python), (Split-Path -Parent $runtime.gh))
    if ($runtime.codex) { $directories += Split-Path -Parent $runtime.codex }
    if ($runtime.codex) {
        if (-not (Test-Path -LiteralPath $runtime.codex -PathType Leaf)) { throw 'Configured Codex executable is missing' }
        $env:AI_PRODUCER_CODEX_BIN = $runtime.codex
    }
    # Rebuild PATH from durable Windows settings; never inherit an app's cache PATH.
    $env:Path = ($directories -join ';') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:PYTHONIOENCODING = 'utf-8'
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $OutputEncoding
    Set-Location -LiteralPath $projectRoot
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $runtime.node (Join-Path $PSScriptRoot 'watch.mjs') run 2>&1 | Out-File -LiteralPath $logFile -Append -Encoding utf8
        $nodeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldErrorAction }
    if ($nodeExitCode -ne 0) { throw "Video watcher exited with code $nodeExitCode" }
    $check = Get-Content -LiteralPath (Join-Path $dataRoot 'last-check.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([DateTime]::Parse($check.checked_at).ToUniversalTime() -lt $started.AddSeconds(-2)) { throw 'No fresh watcher report was produced' }
    $notice = [bool]$check.has_updates
    if (@($check.errors).Count -gt 0 -or @($check.blocked).Count -gt 0) { $status = 'needs_attention'; $exitCode = 1 }
    elseif ([int]$check.pending -gt 0) { $status = 'waiting_source'; $exitCode = 0 }
    elseif ($check.has_updates) { $status = 'completed'; $exitCode = 0 }
    else { $status = 'no_changes'; $exitCode = 0 }
} catch {
    $errorMessage = $_.Exception.Message
    $errorMessage | Out-File -LiteralPath $logFile -Append -Encoding utf8
    $notice = -not $previous -or $previous.error -ne $errorMessage
}

if ($notice -and $runtime.toast_app_id) {
    try {
        $messages = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'watch-notification.zh-CN.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $completed = @($check.events | Where-Object { $_.status -eq 'completed' })
        if ($completed.Count -gt 0) { $body = $messages.completed -f $completed.Count, (($completed | Select-Object -First 3 -ExpandProperty title) -join ', ') }
        elseif ($status -eq 'waiting_source') { $body = $messages.waiting }
        else { $body = $messages.attention }
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
        $xml.GetElementsByTagName('text').Item(0).InnerText = $messages.title
        $xml.GetElementsByTagName('text').Item(1).InnerText = $body
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($runtime.toast_app_id).Show($toast)
    } catch { $notificationError = $_.Exception.Message }
}

$summary = [ordered]@{
    scheduler = 'Windows Task Scheduler'
    status = $status
    started_at = $started.ToString('o')
    completed_at = [DateTime]::UtcNow.ToString('o')
    exit_code = $exitCode
    log_path = $logFile
    has_updates = $notice
    error = $errorMessage
    notification_error = $notificationError
}
$temporary = $statusFile + '.' + $PID + '.tmp'
[System.IO.File]::WriteAllText($temporary, ($summary | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temporary -Destination $statusFile -Force
exit $exitCode
