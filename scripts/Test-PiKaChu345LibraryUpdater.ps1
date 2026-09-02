[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDirectory = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    'D:/Projects/progressive-reading-workflow\scripts'
}
$updater = Join-Path $scriptDirectory 'Update-PiKaChu345Library.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('pikachu-library-updater-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $testRoot 'vault\阅读区\PiKaChu345 数学笔记库'
$rollback = Join-Path $testRoot 'rollback'
$manifest = Join-Path $testRoot 'config\current.json'
$hostVault = Join-Path $testRoot 'vault'

function New-TestSource {
    param([string]$Path, [string]$Marker, [switch]$NestedObsidian)
    New-Item -ItemType Directory -Path (Join-Path $Path 'math') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Path '.obsidian\plugins\obsidian-tikzjax') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $Path 'math\note.md') -Value "version=$Marker" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $Path "asset-$Marker.txt") -Value $Marker -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $Path '.obsidian\plugins\obsidian-tikzjax\main.js') -Value "plugin=$Marker" -Encoding UTF8
    if ($NestedObsidian) {
        New-Item -ItemType Directory -Path (Join-Path $Path 'math\.obsidian') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $Path 'math\.obsidian\bad.json') -Value '{}' -Encoding UTF8
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

try {
    $source1 = Join-Path $testRoot 'source1'
    $source2 = Join-Path $testRoot 'source2'
    $source3 = Join-Path $testRoot 'source3'
    $badSource = Join-Path $testRoot 'bad-source'
    New-TestSource -Path $source1 -Marker 'one'
    New-TestSource -Path $source2 -Marker 'two'
    New-TestSource -Path $source3 -Marker 'three'
    New-TestSource -Path $badSource -Marker 'bad' -NestedObsidian

    New-Item -ItemType Directory -Path (Join-Path $hostVault '.obsidian\plugins\obsidian-tikzjax') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $hostVault '.obsidian\plugins\obsidian-tikzjax\main.js') -Value 'host-original' -Encoding UTF8
    $hostPluginHash = (Get-FileHash -LiteralPath (Join-Path $hostVault '.obsidian\plugins\obsidian-tikzjax\main.js') -Algorithm SHA256).Hash

    & $updater -Source $source1 -Version '2026.08.11-r1' -Target $target -RollbackRoot $rollback -ManifestPath $manifest -HostVaultRoot $hostVault -Apply | Out-Null
    Assert-True (Test-Path -LiteralPath (Join-Path $target 'math\note.md')) 'initial install creates target'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $target '.obsidian'))) 'source .obsidian is excluded'
    Assert-True ((Get-Content -LiteralPath (Join-Path $target 'math\note.md') -Raw) -match 'one') 'initial content is installed'

    $beforePreviewTargetHash = (Get-FileHash -LiteralPath (Join-Path $target 'math\note.md') -Algorithm SHA256).Hash
    $beforePreviewManifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
    $preview = & $updater -Source $source2 -Version '2026.08.12-r1' -Target $target -RollbackRoot $rollback -ManifestPath $manifest -HostVaultRoot $hostVault | ConvertFrom-Json
    Assert-True ($preview.Mode -eq 'Preview') 'default mode is preview'
    Assert-True ($beforePreviewTargetHash -eq (Get-FileHash -LiteralPath (Join-Path $target 'math\note.md') -Algorithm SHA256).Hash) 'preview leaves target unchanged'
    Assert-True ($beforePreviewManifestHash -eq (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash) 'preview leaves manifest unchanged'

    & $updater -Source $source2 -Version '2026.08.12-r1' -Target $target -RollbackRoot $rollback -ManifestPath $manifest -HostVaultRoot $hostVault -Apply | Out-Null
    Assert-True ((Get-Content -LiteralPath (Join-Path $target 'math\note.md') -Raw) -match 'two') 'second version replaces target'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rollback 'PiKaChu345-2026.08.11-r1\math\note.md') -Raw) -match 'one') 'first version is the rollback'

    & $updater -Source $source3 -Version '2026.08.13-r1' -Target $target -RollbackRoot $rollback -ManifestPath $manifest -HostVaultRoot $hostVault -Apply | Out-Null
    Assert-True ((Get-Content -LiteralPath (Join-Path $target 'math\note.md') -Raw) -match 'three') 'third version replaces target'
    Assert-True ((Get-Content -LiteralPath (Join-Path $rollback 'PiKaChu345-2026.08.12-r1\math\note.md') -Raw) -match 'two') 'second version becomes rollback'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $rollback 'PiKaChu345-2026.08.11-r1'))) 'older managed rollback is cleaned'

    $beforeFailureHash = (Get-FileHash -LiteralPath (Join-Path $target 'math\note.md') -Algorithm SHA256).Hash
    $failed = $false
    try {
        & $updater -Source $badSource -Version '2026.08.14-r1' -Target $target -RollbackRoot $rollback -ManifestPath $manifest -HostVaultRoot $hostVault -Apply | Out-Null
    } catch {
        $failed = $true
    }
    Assert-True $failed 'invalid nested .obsidian source fails'
    Assert-True ($beforeFailureHash -eq (Get-FileHash -LiteralPath (Join-Path $target 'math\note.md') -Algorithm SHA256).Hash) 'failure leaves current target unchanged'
    Assert-True ($hostPluginHash -eq (Get-FileHash -LiteralPath (Join-Path $hostVault '.obsidian\plugins\obsidian-tikzjax\main.js') -Algorithm SHA256).Hash) 'updater never changes host plugin code'
    Assert-True (@(Get-ChildItem -LiteralPath $rollback -Directory -Filter 'PiKaChu345-*').Count -eq 1) 'exactly one rollback remains'

    [pscustomobject]@{
        Status = 'PASS'
        Cases = @(
            'initial install',
            'preview has no mutation',
            'version replacement',
            'one rollback retained',
            'older rollback cleaned',
            'invalid source does not replace current',
            'plugin differences are report-only'
        )
    } | ConvertTo-Json -Depth 4
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
