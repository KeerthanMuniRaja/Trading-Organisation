# Owner-run, once (OPS-04): registers a per-user Windows scheduled task that starts the organisation's supervisor when
# you log on and restarts it within 5 minutes whenever it stops, so the organisation keeps running without a terminal.
# It needs no administrator rights and changes nothing else. Check with your IT policy before using it on an office laptop.
#   pwsh -File scripts\install-supervisor-task.ps1 -WhatIf     show what would be registered, change nothing
#   pwsh -File scripts\install-supervisor-task.ps1             register (or replace) the task
#   pwsh -File scripts\install-supervisor-task.ps1 -Remove     remove it
# The laptop must be awake for jobs to run. If it slept through a job's time, the supervisor catches up today's jobs
# when it wakes (readiness before the close, the cycle after 16:05 IST).
param([switch]$Remove, [switch]$WhatIf)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'Trading organisation supervisor'

if ($Remove) {
  if ($WhatIf) { "Would remove the scheduled task '$name'."; return }
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  "Removed the scheduled task '$name'."
  return
}

$node = (Get-Command node -ErrorAction Stop).Source
# --managed: the task restarts the supervisor, so its watchdog only exits (it would otherwise start its own replacement)
$arguments = '--env-file-if-exists=.env scripts/supervisor.mjs --managed'
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# restart whenever it stops (up to 999 times), never time it out, start late if the logon was missed, keep one copy only
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

if ($WhatIf) {
  "Would register the scheduled task '$name' for $($env:USERNAME):"
  "  run:      $node $arguments"
  "  in:       $root"
  "  when:     at logon; restarted within 5 minutes whenever it stops; one copy at a time"
  return
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force `
  -Description 'Runs the trading organisation day (readiness 09:00 IST, cycle 16:05 IST, Friday backup); see docs/live-testing.md' | Out-Null
Start-ScheduledTask -TaskName $name
"Registered and started '$name'. Check it with: npm run status (Supervisor line), or remove it with -Remove."
