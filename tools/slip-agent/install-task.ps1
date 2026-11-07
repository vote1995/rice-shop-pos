# Slip reader agent — install/remove the Windows Scheduled Task "RicePosSlipAgent".
#   .\install-task.ps1            install + start (runs node agent.mjs hidden at every logon)
#   .\install-task.ps1 -Uninstall remove the task
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'RicePosSlipAgent'
$Folder = $PSScriptRoot

function Remove-AgentTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    }
    else {
        Write-Host "Scheduled task '$TaskName' is not installed (nothing to do)."
    }
}

if ($Uninstall) {
    Remove-AgentTask
    exit 0
}

# --- sanity checks -----------------------------------------------------------
$agent = Join-Path $Folder 'agent.mjs'
if (-not (Test-Path $agent)) { throw "agent.mjs not found next to install-task.ps1 ($Folder)" }
if (-not (Test-Path (Join-Path $Folder '.env'))) {
    Write-Warning "No .env found in $Folder - create it from .env.example, otherwise the agent exits immediately."
}

$node = $null
try { $node = (Get-Command node -ErrorAction Stop).Source } catch { throw "node.exe not found in PATH. Install Node.js 22 first." }

# --- task definition ---------------------------------------------------------
# Runs node with the full path to agent.mjs, working directory = this folder,
# at every logon of the current user, with no execution time limit and up to
# 3 restarts (1 min apart) after failures. Interactive logon needs no admin
# (S4U does); the console is hidden by launching through `conhost --headless`.
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$Action = New-ScheduledTaskAction -Execute $conhost `
    -Argument "--headless `"$node`" `"$agent`"" -WorkingDirectory $Folder
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName `
    -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force -ErrorAction Stop | Out-Null

Write-Host "Installed scheduled task '$TaskName':"
Write-Host "  node   : $node"
Write-Host "  agent  : $agent"
Write-Host "  workdir: $Folder"
Write-Host "  mode   : hidden (conhost --headless), at logon of $env:USERNAME"
Write-Host "  policy : no time limit, restart up to 3x (1 min apart) on failure"

Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Write-Host "Started. Logs: $Folder\agent.log"
Write-Host "Stop with: Stop-ScheduledTask $TaskName   Uninstall with: .\install-task.ps1 -Uninstall"
