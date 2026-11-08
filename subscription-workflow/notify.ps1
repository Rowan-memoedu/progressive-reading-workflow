#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference = 'Stop'
$message = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$xml.GetElementsByTagName('text').Item(0).InnerText = $message.title
$xml.GetElementsByTagName('text').Item(1).InnerText = $message.body
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
