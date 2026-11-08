#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'watch-schedule-policy.ps1')
$morning = [datetime]'2026-10-29T09:00:00'
if (-not (Test-VideoWatchDue -Previous $null -Now $morning)) { throw 'Missing run must catch up' }
if (Test-VideoWatchDue -Previous $null -Now ([datetime]'2026-10-29T07:00:00')) { throw 'Do not run before 08:00' }
if (Test-VideoWatchDue -Previous @{exit_code=0;completed_at=$morning.ToString('o')} -Now $morning.AddHours(1)) { throw 'Successful daily run must not repeat at logon' }
if (-not (Test-VideoWatchDue -Previous @{exit_code=1;completed_at=$morning.ToString('o')} -Now $morning.AddHours(1))) { throw 'Failed run must remain eligible' }
if (-not (Test-VideoWatchDue -Previous @{exit_code=$null;status='running'} -Now $morning)) { throw 'Interrupted run must remain eligible' }
if (-not (Test-VideoWatchDue -Previous @{exit_code=0;completed_at=$morning.AddDays(-1).ToString('o')} -Now $morning)) { throw 'Previous day must not suppress new day' }
'6 schedule policy checks passed'
