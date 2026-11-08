#Requires -Version 5.1
function Test-VideoWatchDue {
    param($Previous, [datetime]$Now = (Get-Date))
    if ($Now.TimeOfDay -lt [TimeSpan]::FromHours(8)) { return $false }
    if ($Previous -and $Previous.exit_code -eq 0 -and $Previous.completed_at) {
        $finished = [DateTime]::Parse($Previous.completed_at).ToLocalTime()
        if ($finished.Date -eq $Now.Date) { return $false }
    }
    return $true
}
