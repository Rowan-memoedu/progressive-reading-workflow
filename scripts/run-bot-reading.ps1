#Requires -Version 7.0
param([Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
& $NodePath (Join-Path $PSScriptRoot 'bot-reading-service.mjs')
exit $LASTEXITCODE
