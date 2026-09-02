[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}\.\d{2}\.\d{2}-r[1-9]\d*$')]
    [string]$Version,

    [string]$Target = 'D:/Projects/progressive-reading-workflow\阅读区\PiKaChu345 数学笔记库',

    [string]$RollbackRoot = 'D:\KnowledgeBases\ToolTrials\Pika-Library-Rollback',

    [string]$ManifestPath = 'D:/Projects/progressive-reading-workflow\config\pikachu345-library.current.json',

    [string]$HostVaultRoot = 'D:/Projects',

    [string]$SourceDynamic = '',

    [string]$ShareUrl = '',

    [string]$SourceZipSha256 = '',

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:AllowedPlugins = @(
    'cm-editor-syntax-highlight-obsidian',
    'obsidian-tikzjax'
)

function Get-CanonicalPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-SafeManagedPaths {
    param(
        [string]$ResolvedSource,
        [string]$ResolvedTarget,
        [string]$ResolvedRollbackRoot,
        [string]$ResolvedManifestPath
    )

    if (-not (Test-Path -LiteralPath $ResolvedSource -PathType Container)) {
        throw "Source directory does not exist: $ResolvedSource"
    }

    foreach ($path in @($ResolvedTarget, $ResolvedRollbackRoot)) {
        $root = [IO.Path]::GetPathRoot($path).TrimEnd('\')
        if ($path.TrimEnd('\') -eq $root) {
            throw "Refusing to manage a filesystem root: $path"
        }
    }

    if ($ResolvedTarget.StartsWith($ResolvedSource + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $ResolvedSource.StartsWith($ResolvedTarget + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Source and target must not contain one another.'
    }

    if ($ResolvedRollbackRoot.StartsWith($ResolvedTarget + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $ResolvedTarget.StartsWith($ResolvedRollbackRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Target and rollback root must not contain one another.'
    }

    if ($ResolvedManifestPath.StartsWith($ResolvedTarget + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Manifest must live outside the replaceable target directory.'
    }
}

function ConvertTo-VersionKey {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -notmatch '^(?<date>\d{4}\.\d{2}\.\d{2})-r(?<revision>[1-9]\d*)$') {
        throw "Invalid version: $Value"
    }
    $date = [datetime]::ParseExact($Matches.date, 'yyyy.MM.dd', [Globalization.CultureInfo]::InvariantCulture)
    return [pscustomobject]@{ Date = $date; Revision = [int]$Matches.revision }
}

function Test-VersionNewer {
    param([string]$Candidate, [string]$Current)
    $candidateKey = ConvertTo-VersionKey -Value $Candidate
    $currentKey = ConvertTo-VersionKey -Value $Current
    return ($candidateKey.Date -gt $currentKey.Date) -or
        (($candidateKey.Date -eq $currentKey.Date) -and ($candidateKey.Revision -gt $currentKey.Revision))
}

function Test-ExcludedSourcePath {
    param([string]$RelativePath)
    $segments = $RelativePath -split '[\\/]'
    return $segments.Count -gt 0 -and $segments[0] -eq '.obsidian'
}

function Get-LibraryInventory {
    param([Parameter(Mandatory = $true)][string]$Root)
    $resolvedRoot = Get-CanonicalPath -Path $Root
    $files = @(
        Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse -Force | ForEach-Object {
            $relative = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\', '/')
            if (-not (Test-ExcludedSourcePath -RelativePath $relative)) {
                [pscustomobject]@{
                    Path = $relative.Replace('\', '/')
                    Bytes = [int64]$_.Length
                    Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                }
            }
        } | Sort-Object Path
    )
    return [pscustomobject]@{
        FileCount = $files.Count
        TotalBytes = [int64](($files | Measure-Object -Property Bytes -Sum).Sum)
        Files = $files
    }
}

function Assert-NoNestedObsidian {
    param([Parameter(Mandatory = $true)][string]$Root)
    $resolvedRoot = Get-CanonicalPath -Path $Root
    $nested = @(
        Get-ChildItem -LiteralPath $resolvedRoot -Directory -Recurse -Force |
            Where-Object {
                $_.Name -eq '.obsidian' -and
                $_.Parent.FullName -ne $resolvedRoot
            }
    )
    if ($nested.Count -gt 0) {
        throw "Nested .obsidian directory is not allowed: $($nested[0].FullName)"
    }
}

function Assert-InventoryEqual {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual,
        [string]$Label = 'inventory'
    )
    if ([int]$Expected.FileCount -ne [int]$Actual.FileCount -or
        [int64]$Expected.TotalBytes -ne [int64]$Actual.TotalBytes) {
        throw "$Label count or byte total mismatch."
    }
    for ($index = 0; $index -lt $Expected.Files.Count; $index++) {
        $left = $Expected.Files[$index]
        $right = $Actual.Files[$index]
        if ($left.Path -cne $right.Path -or
            [int64]$left.Bytes -ne [int64]$right.Bytes -or
            $left.Sha256 -cne $right.Sha256) {
            throw "$Label mismatch at index ${index}: $($left.Path)"
        }
    }
}

function Copy-LibraryContent {
    param([string]$From, [string]$To)
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    Get-ChildItem -LiteralPath $From -Force | Where-Object Name -ne '.obsidian' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $To -Recurse -Force
    }
}

function Write-JsonAtomic {
    param([string]$Path, $Value)
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.tmp-' + [guid]::NewGuid().ToString('N'))
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-PluginDifferenceReport {
    param([string]$SourceRoot, [string]$VaultRoot)
    $sourcePlugins = Join-Path $SourceRoot '.obsidian\plugins'
    $hostPlugins = Join-Path $VaultRoot '.obsidian\plugins'
    $report = @()
    foreach ($pluginId in $script:AllowedPlugins) {
        $sourcePlugin = Join-Path $sourcePlugins $pluginId
        $hostPlugin = Join-Path $hostPlugins $pluginId
        if (-not (Test-Path -LiteralPath $sourcePlugin -PathType Container)) {
            $report += [pscustomobject]@{ Plugin = $pluginId; State = 'missing-from-source'; ChangedFiles = @() }
            continue
        }
        if (-not (Test-Path -LiteralPath $hostPlugin -PathType Container)) {
            $report += [pscustomobject]@{ Plugin = $pluginId; State = 'not-installed-in-host'; ChangedFiles = @() }
            continue
        }
        $sourceInventory = Get-LibraryInventory -Root $sourcePlugin
        $hostInventory = Get-LibraryInventory -Root $hostPlugin
        $sourceMap = @{}; $hostMap = @{}
        foreach ($item in $sourceInventory.Files) { $sourceMap[$item.Path] = $item.Sha256 }
        foreach ($item in $hostInventory.Files) { $hostMap[$item.Path] = $item.Sha256 }
        $paths = @($sourceMap.Keys + $hostMap.Keys | Sort-Object -Unique)
        $changed = @($paths | Where-Object { $sourceMap[$_] -ne $hostMap[$_] })
        $report += [pscustomobject]@{
            Plugin = $pluginId
            State = if ($changed.Count -eq 0) { 'same' } else { 'different-report-only' }
            ChangedFiles = $changed
        }
    }
    return $report
}

$resolvedSource = Get-CanonicalPath -Path $Source
$resolvedTarget = Get-CanonicalPath -Path $Target
$resolvedRollbackRoot = Get-CanonicalPath -Path $RollbackRoot
$resolvedManifestPath = Get-CanonicalPath -Path $ManifestPath
$resolvedHostVaultRoot = Get-CanonicalPath -Path $HostVaultRoot

Assert-SafeManagedPaths -ResolvedSource $resolvedSource -ResolvedTarget $resolvedTarget -ResolvedRollbackRoot $resolvedRollbackRoot -ResolvedManifestPath $resolvedManifestPath
Assert-NoNestedObsidian -Root $resolvedSource
$sourceInventory = Get-LibraryInventory -Root $resolvedSource
if ($sourceInventory.FileCount -eq 0) { throw 'Source contains no importable files.' }

$currentManifest = $null
if (Test-Path -LiteralPath $resolvedManifestPath -PathType Leaf) {
    $currentManifest = Get-Content -LiteralPath $resolvedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (Test-VersionNewer -Candidate $Version -Current $currentManifest.version)) {
        throw "Version must be newer than current version $($currentManifest.version)."
    }
} elseif (Test-Path -LiteralPath $resolvedTarget) {
    throw 'Target exists but no current manifest is available; refusing an unmanaged replacement.'
}

$pluginReport = @(Get-PluginDifferenceReport -SourceRoot $resolvedSource -VaultRoot $resolvedHostVaultRoot)
$preview = [pscustomobject]@{
    Mode = if ($Apply) { 'Apply' } else { 'Preview' }
    Version = $Version
    CurrentVersion = if ($null -eq $currentManifest) { $null } else { $currentManifest.version }
    Source = $resolvedSource
    Target = $resolvedTarget
    RollbackRoot = $resolvedRollbackRoot
    FileCount = $sourceInventory.FileCount
    TotalBytes = $sourceInventory.TotalBytes
    PluginChanges = $pluginReport
    Note = 'Plugin differences are report-only; this updater never writes host plugins.'
}

if (-not $Apply) {
    $preview | ConvertTo-Json -Depth 8
    exit 0
}

$targetParent = Split-Path -Parent $resolvedTarget
New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
$incoming = Join-Path $targetParent ('.PiKaChu345.incoming-' + [guid]::NewGuid().ToString('N'))
$oldSibling = Join-Path $targetParent ('.PiKaChu345.old-' + [guid]::NewGuid().ToString('N'))
$rollbackIncoming = $null
$newRollback = $null
$swapped = $false

try {
    Copy-LibraryContent -From $resolvedSource -To $incoming
    $incomingInventory = Get-LibraryInventory -Root $incoming
    Assert-InventoryEqual -Expected $sourceInventory -Actual $incomingInventory -Label 'incoming'

    if ($null -ne $currentManifest) {
        $currentInventory = Get-LibraryInventory -Root $resolvedTarget
        Assert-InventoryEqual -Expected $currentManifest.inventory -Actual $currentInventory -Label 'current target'
        Move-Item -LiteralPath $resolvedTarget -Destination $oldSibling
    }

    Move-Item -LiteralPath $incoming -Destination $resolvedTarget
    $swapped = $true
    $installedInventory = Get-LibraryInventory -Root $resolvedTarget
    Assert-InventoryEqual -Expected $sourceInventory -Actual $installedInventory -Label 'installed target'

    if ($null -ne $currentManifest) {
        New-Item -ItemType Directory -Path $resolvedRollbackRoot -Force | Out-Null
        $rollbackIncoming = Join-Path $resolvedRollbackRoot ('.incoming-' + [guid]::NewGuid().ToString('N'))
        $newRollback = Join-Path $resolvedRollbackRoot ('PiKaChu345-' + $currentManifest.version)
        if (Test-Path -LiteralPath $newRollback) {
            throw "Managed rollback already exists: $newRollback"
        }
        Copy-LibraryContent -From $oldSibling -To $rollbackIncoming
        $rollbackInventory = Get-LibraryInventory -Root $rollbackIncoming
        Assert-InventoryEqual -Expected $currentManifest.inventory -Actual $rollbackInventory -Label 'new rollback'
        Move-Item -LiteralPath $rollbackIncoming -Destination $newRollback
        $finalRollbackInventory = Get-LibraryInventory -Root $newRollback
        Assert-InventoryEqual -Expected $currentManifest.inventory -Actual $finalRollbackInventory -Label 'final rollback'
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        library = 'PiKaChu345 数学笔记库'
        version = $Version
        installedAt = (Get-Date).ToUniversalTime().ToString('o')
        source = $resolvedSource
        target = $resolvedTarget
        rollbackRoot = $resolvedRollbackRoot
        previousVersion = if ($null -eq $currentManifest) { $null } else { $currentManifest.version }
        sourceDynamic = $SourceDynamic
        shareUrl = $ShareUrl
        sourceZipSha256 = $SourceZipSha256
        allowedPlugins = $script:AllowedPlugins
        pluginChanges = $pluginReport
        inventory = $sourceInventory
    }
    Write-JsonAtomic -Path $resolvedManifestPath -Value $manifest

    if (Test-Path -LiteralPath $oldSibling) {
        Remove-Item -LiteralPath $oldSibling -Recurse -Force
    }

    if ($null -ne $newRollback) {
        Get-ChildItem -LiteralPath $resolvedRollbackRoot -Directory -Filter 'PiKaChu345-*' |
            Where-Object FullName -ne $newRollback |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    }

    [pscustomobject]@{
        Status = 'Applied'
        Version = $Version
        Target = $resolvedTarget
        Rollback = $newRollback
        FileCount = $sourceInventory.FileCount
        TotalBytes = $sourceInventory.TotalBytes
        Manifest = $resolvedManifestPath
        PluginChanges = $pluginReport
    } | ConvertTo-Json -Depth 8
} catch {
    $failure = $_
    if ($swapped -and (Test-Path -LiteralPath $oldSibling)) {
        if (Test-Path -LiteralPath $resolvedTarget) {
            Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
        }
        Move-Item -LiteralPath $oldSibling -Destination $resolvedTarget
    }
    foreach ($temporaryPath in @($incoming, $rollbackIncoming)) {
        if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
            Remove-Item -LiteralPath $temporaryPath -Recurse -Force
        }
    }
    throw $failure
}
