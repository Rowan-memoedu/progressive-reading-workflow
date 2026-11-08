[CmdletBinding(DefaultParameterSetName = 'Existing')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Existing')][string]$InputDir,
    [Parameter(Mandatory, ParameterSetName = 'Video')][string]$VideoUrl,
    [Parameter(ParameterSetName = 'Video')][string]$CookiesFile,
    [Parameter(ParameterSetName = 'Video')][string]$CookiesFromProfile,
    [Parameter(ParameterSetName = 'Video')][switch]$UseAsr,
    [Parameter(ParameterSetName = 'Video')][switch]$ReuseTranscript,
    [Parameter(ParameterSetName = 'Video')][switch]$FetchOnly,
    [Parameter(Mandatory)][string]$OutputDir,
    [Parameter(Mandatory)][string]$PublishPath,
    [string]$OptionsFile,
    [ValidateSet('transcript', 'illustrated', '图文模式', 'illustrated_strong')][string]$OutputType = 'transcript',
    [switch]$Describe,
    [string]$PythonPath = 'D:\Caches\ProgressiveReading\videobook-python\Scripts\python.exe'
)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskModeJson = & node (Join-Path $taskRoot 'video-mode.mjs') $OutputType
if ($LASTEXITCODE -ne 0) { throw 'Invalid video mode.' }
$taskMode = $taskModeJson | ConvertFrom-Json
if ($Describe) { Write-Output $taskModeJson; return }
if ($PSCmdlet.ParameterSetName -eq 'Video') {
    & node (Join-Path $taskRoot 'import-transcript.mjs') --verify-upstream
    if ($LASTEXITCODE -ne 0) { throw 'Upstream source integrity failed.' }
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw 'VideoBook Python runtime is not installed.' }
    $taskUpstream = Join-Path $taskRoot 'upstream'
    $taskRawRoot = 'D:\Artifacts\ProgressiveReading\videobook\upstream-output'
    New-Item -ItemType Directory -Path $taskRawRoot -Force | Out-Null
    $taskOutputLink = Join-Path $taskUpstream 'output'
    if (Test-Path -LiteralPath $taskOutputLink) {
        $taskLink = Get-Item -LiteralPath $taskOutputLink
        if ($taskLink.LinkType -ne 'Junction' -or $taskLink.Target -ne $taskRawRoot) {
            throw "Existing upstream output is not the expected Junction: $taskOutputLink"
        }
    } else { New-Item -ItemType Junction -Path $taskOutputLink -Target $taskRawRoot | Out-Null }
    $taskDumpArgs = @((Join-Path $taskUpstream 'src\dump_transcript.py'), $VideoUrl)
    if ($CookiesFile) { $taskDumpArgs += @('--cookies-file', $CookiesFile) }
    if ($CookiesFromProfile) { $taskDumpArgs += @('--cookies-from-profile', $CookiesFromProfile) }
    if ($ReuseTranscript) {
        $taskResumeId = & $PythonPath -c 'import sys; sys.path.insert(0, sys.argv[1]); from asr_transcript import norm_id; print(norm_id(sys.argv[2]))' (Join-Path $taskUpstream 'src') $VideoUrl
        if ($LASTEXITCODE -ne 0 -or $taskResumeId -notmatch '^[A-Za-z0-9_-]+$') { throw 'Cannot resolve existing subtitle identity.' }
        $taskSavedSource = & node (Join-Path $taskRoot 'subtitle-source.mjs') $taskRawRoot $VideoUrl $taskResumeId
        if ($LASTEXITCODE -ne 0) { throw 'No saved transcript for the requested video part.' }
        Write-Output '{"stage":"upstream_subtitles","status":"reused_saved_transcript"}'
    } elseif ($UseAsr) {
        & $PythonPath (Join-Path $taskUpstream 'src\asr_transcript.py') $VideoUrl
    } else { & $PythonPath @taskDumpArgs }
    if ($LASTEXITCODE -ne 0) { throw "Upstream subtitle stage failed (exit $LASTEXITCODE); downstream was not started." }
    $taskVideoId = & $PythonPath -c 'import sys; sys.path.insert(0, sys.argv[1]); from asr_transcript import norm_id; print(norm_id(sys.argv[2]))' (Join-Path $taskUpstream 'src') $VideoUrl
    if ($LASTEXITCODE -ne 0 -or $taskVideoId -notmatch '^[A-Za-z0-9_-]+$') { throw 'Cannot resolve an exact upstream video identity.' }
    $taskSourceJson = & node (Join-Path $taskRoot 'subtitle-source.mjs') $taskRawRoot $VideoUrl $taskVideoId
    if ($LASTEXITCODE -ne 0) { throw 'Upstream did not produce a matching transcript.' }
    $taskSource = $taskSourceJson | ConvertFrom-Json
    $InputDir = $taskSource.input_dir
    $taskVideoId = $taskSource.video_id
    $taskTranscript = Join-Path $InputDir 'transcript.json'
    if (-not (Test-Path -LiteralPath $taskTranscript)) { throw 'Upstream did not produce the expected transcript.json.' }
    $taskData = Get-Content -LiteralPath $taskTranscript -Raw | ConvertFrom-Json
    if ($taskData.video_id -ne $taskVideoId) { throw 'Upstream transcript video identity mismatch.' }
    if ($FetchOnly) { Write-Output ($taskSource | ConvertTo-Json -Compress); return }
}
$taskImportArgs = @((Join-Path $taskRoot 'import-transcript.mjs'), '--input', $InputDir,
    '--output', $OutputDir, '--publish', $PublishPath)
if ($taskMode.enabled) {
    $taskImportArgs[0] = Join-Path $taskRoot 'illustrated-strong.mjs'
    if ($CookiesFile) { $taskImportArgs += @('--cookies-file', $CookiesFile) }
    $taskImportArgs += @('--python', $PythonPath, '--type', $taskMode.id)
}
if ($OptionsFile) { $taskImportArgs += @('--options', $OptionsFile) }
& node @taskImportArgs
if ($LASTEXITCODE -ne 0) { throw "Standard preprocessing failed (exit $LASTEXITCODE)." }
