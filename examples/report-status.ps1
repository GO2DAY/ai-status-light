<#
.SYNOPSIS
  report-status.ps1 - example status reporter for AI Status Light.

.EXAMPLE
  .\report-status.ps1 -Agent kimi -Status running -Task "正在生成周报"
  .\report-status.ps1 -Agent kimi -Status stuck -Task "需要人工确认 API key"
  .\report-status.ps1 -Agent kimi -Status assist -Task "已打电话通知老吴，等人工处理"
  .\report-status.ps1 -Agent kimi -Status idle
  .\report-status.ps1 -Agent kimi -Status offline
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Agent,

    [Parameter(Mandatory = $true)]
    [ValidateSet('running', 'idle', 'stuck', 'assist', 'offline')]
    [string]$Status,

    [string]$Task = '',

    [string]$Endpoint = 'http://127.0.0.1:17890/status'
)

$body = @{
    agent  = $Agent
    status = $Status
    task   = $Task
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $Endpoint -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 5
    if ($response.ok) {
        Write-Host "OK: $Agent -> $Status$(if ($Task) { " ($Task)" })"
    } else {
        Write-Error "Report rejected: $($response.error)"
        exit 1
    }
} catch {
    Write-Error "Cannot reach AI Status Light at $Endpoint : $($_.Exception.Message)"
    exit 1
}
