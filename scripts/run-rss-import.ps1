#Requires -Version 7.0
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
& $NodePath (Join-Path $projectRoot 'rss-import\cli.mjs') watch
exit $LASTEXITCODE
