# One command to set up and start the trading organisation on a new Windows machine (OPS-05).
#
#   1. On the machine it runs on now:  npm run handover -- --to "home EliteBook"
#   2. On the new machine, in a PowerShell window:
#        gh repo clone KeerthanMuniRaja/Trading-Organisation; cd Trading-Organisation; git checkout dev
#        powershell -ExecutionPolicy Bypass -File scripts\setup-machine.ps1
#
# Safe to run again: every step checks what is already done. It stops with a plain message when something only you can
# do is missing (a program to install, your three secret files), and continues from there when run again.
# What it does, in order:
#   programs (Node 24, Python 3.12, Git, GitHub CLI) -> both repositories -> the data (first time only) -> your secrets
#   -> install -> the database (restored from the newest backup, first time only) -> the knowledge index
#   -> the model and its runtime -> faster model settings measured here (threads; the Intel graphics if faster)
#   -> a bigger decision model, used only if it passes our exams -> checks -> start (supervisor; optional auto-start)
#
#   -SkipUpgrade   no bigger model (saves a 6-9 GB download and about an hour of exams)
#   -NoStart       set up only; start later with: npm run supervisor
#   -Refresh       place the data repository's data again even though this machine already has a database
param([switch]$SkipUpgrade, [switch]$NoStart, [switch]$Refresh)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$step = 0
function Step($text) { $script:step++; Write-Host ""; Write-Host "[$script:step] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    ok: $text" -ForegroundColor Green }
function Note($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Stop-Here($text) { Write-Host ""; Write-Host "STOPPED: $text" -ForegroundColor Red; Write-Host "Fix that, then run the same command again; finished steps are skipped."; exit 2 }
function Run($exe, [string[]]$arguments, $what) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Stop-Here "$what failed (exit $LASTEXITCODE)" }
}
function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# ---------- 1. programs ----------
Step 'Programs: Node.js 24, Python 3.12, Git, GitHub CLI'
$missing = @()
if (Has node) { $v = (node -v); if ($v -notmatch '^v24\.') { $missing += "Node.js 24.x (found $v; the project needs 24, not 25+)" } else { Ok "Node.js $v" } } else { $missing += 'Node.js 24.x' }
$python = $null
# native programs' error output is checked through cmd: Windows PowerShell 5.1 turns redirected stderr into errors
if (Has py) { cmd /c "py -3.12 -c print(1) >nul 2>&1"; if ($LASTEXITCODE -eq 0) { $python = 'py'; Ok 'Python 3.12 (py -3.12)' } }
if (-not $python -and (Has python)) { $pv = (cmd /c "python --version 2>&1"); if ("$pv" -match '3\.12\.') { $python = 'python'; Ok "$pv" } }
if (-not $python) { $missing += 'Python 3.12' }
if (Has git) { Ok (git --version) } else { $missing += 'Git' }
if (Has gh) { Ok 'GitHub CLI' } else { $missing += 'GitHub CLI (gh)' }
if ($missing.Count) {
  Note ('Missing: ' + ($missing -join '; '))
  if (Has winget) {
    $answer = Read-Host '    Install them now with winget (Microsoft''s installer)? (y/N)'
    if ($answer -match '^[yY]') {
      # pinned to 24: the project needs Node 24 (not 25+), and winget's generic "LTS" may already be a newer line
      if ($missing -match 'Node') { winget install --id OpenJS.NodeJS --version 24.11.1 -e --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { Note 'winget has no Node 24.11.1: install Node 24.x by hand from nodejs.org/en/download (choose v24)' } }
      if ($missing -match 'Python') { winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements }
      if ($missing -match '^Git$') { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements }
      if ($missing -match 'GitHub CLI') { winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements }
      Stop-Here 'Programs installed. Close this window, open a new PowerShell (so it sees them), sign in with "gh auth login", then run the setup again'
    }
  }
  Stop-Here ('Install: ' + ($missing -join '; ') + '. Node 24: nodejs.org (LTS 24.x); Python 3.12: python.org; Git: git-scm.com; GitHub CLI: cli.github.com')
}
$pyExe = if ($python -eq 'py') { 'py' } else { 'python' }
$pyArgs = if ($python -eq 'py') { @('-3.12') } else { @() }
cmd /c "gh auth status >nul 2>&1"
if ($LASTEXITCODE -ne 0) { Stop-Here 'Sign in to GitHub first: gh auth login (as KeerthanMuniRaja)' }
Ok 'GitHub CLI signed in'

# ---------- 2. repositories ----------
Step 'Both repositories'
if (-not (Test-Path (Join-Path $root '.git'))) { Stop-Here 'Run this from inside the cloned Trading-Organisation folder' }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'dev') {
  if (git status --porcelain) { Stop-Here "The code is on branch $branch with local changes; commit them or switch to dev yourself" }
  Run git @('checkout', 'dev') 'switching to dev'
}
Run git @('pull', '--ff-only', 'origin', 'dev') 'updating the code'
Ok 'code: dev, up to date'
$dataRepo = Join-Path $root '.local\data-repo'
if (Test-Path (Join-Path $dataRepo '.git')) { Run git @('-C', $dataRepo, 'pull', '--ff-only') 'updating the data repository' }
else { New-Item -ItemType Directory -Force (Join-Path $root '.local') | Out-Null; Run gh @('repo', 'clone', 'KeerthanMuniRaja/trading-organisation-data', $dataRepo) 'cloning the data repository' }
$lastData = (git -C $dataRepo log -1 --format=%s).Trim()
Ok "data: up to date (last: $lastData)"

# ---------- 3. data ----------
Step 'The data (first time only)'
$database = Join-Path $root '.data\paper'
$hasDatabase = (Test-Path $database) -and (Get-ChildItem $database -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($hasDatabase -and -not $Refresh) { Ok 'this machine already has a database: its data is kept (use -Refresh to place the repository''s again)' }
else {
  robocopy (Join-Path $dataRepo 'local') (Join-Path $root '.local') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Stop-Here 'copying the data failed' }
  foreach ($name in 'hermes', 'ruflo', 'skfolio') {
    $from = Join-Path $dataRepo "state\$name"
    if (Test-Path $from) { robocopy $from (Join-Path $root "integrations\$name\.state") /E /NFL /NDL /NJH /NJS /NP | Out-Null }
  }
  $global:LASTEXITCODE = 0
  Ok 'data placed in .local and the integrations'' state'
}
$autolearn = Join-Path $root '.local\claims\autolearn.json'
if (-not (Test-Path $autolearn)) {
  New-Item -ItemType Directory -Force (Split-Path $autolearn) | Out-Null
  [IO.File]::WriteAllText($autolearn, '{ "recipientBotIds": ["debate-bull", "debate-bear", "tradingagents"], "primarySourceIds": [], "holdDays": 7, "maxModelCallsPerCycle": 80 }' + "`n")
  Ok 'news fact-check configuration created'
} else { Ok 'news fact-check configuration present' }

# ---------- 4. secrets ----------
Step 'Your three secret files'
$secrets = @(@('.env', (Join-Path $root '.env')), @('credentials.json', (Join-Path $root '.local\credentials.json')), @('owner-signing-key.pem', (Join-Path $root '.local\owner-signing-key.pem')))
$absent = @($secrets | Where-Object { -not (Test-Path $_[1]) } | ForEach-Object { $_[0] })
if ($absent.Count) {
  Stop-Here ("Missing: " + ($absent -join ', ') + ". Take them from your private backup (the data repository's 'DO NOT OPEN' file): .env goes in the project folder, credentials.json and owner-signing-key.pem in .local\")
}
Ok 'all three present (not read or shown)'
# a database path left from the old machine would point nowhere here
$envText = [IO.File]::ReadAllText((Join-Path $root '.env'))
$dbLine = [regex]::Match($envText, '(?m)^DATABASE_PATH=(.*)$')
if ($dbLine.Success -and $dbLine.Groups[1].Value.Trim() -ne '.data/paper' -and -not (Test-Path $dbLine.Groups[1].Value.Trim())) {
  [IO.File]::WriteAllText((Join-Path $root '.env'), ($envText -replace '(?m)^DATABASE_PATH=.*$', 'DATABASE_PATH=.data/paper'))
  Ok 'DATABASE_PATH pointed at the old machine; now .data/paper'
}
foreach ($v in 'PRINCIPALS_JSON', 'MAX_ORDER_PAISE', 'MAX_EXPOSURE_PAISE', 'MAX_REALISED_LOSS_PAISE') {
  if ([Environment]::GetEnvironmentVariable($v, 'User') -or [Environment]::GetEnvironmentVariable($v, 'Machine')) {
    Note "$v is set in Windows' environment and would override .env; remove it (System > Environment Variables)"
  }
}

# ---------- 5. install ----------
Step 'Install (Node packages, build, three Python environments)'
Run npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund') 'npm ci'
Run npm @('run', 'build') 'the backend build'
$toml = Join-Path $root 'integrations\ruflo\node_modules\toml'
if (-not (Test-Path $toml)) {
  $tmp = Join-Path $env:TEMP 'org-toml'
  Run npm @('install', '--prefix', $tmp, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', 'toml@4.2.0') 'the TOML parser'
  New-Item -ItemType Directory -Force (Split-Path $toml) | Out-Null
  Copy-Item -Recurse (Join-Path $tmp 'node_modules\toml') $toml
}
$envs = @(
  @('research', '.local\replay-venv', @('-m', 'pip', 'install', '--no-deps', '-r', 'integrations\market-replay\requirements.lock.txt')),
  @('portfolio', 'integrations\skfolio\.venv', @('-m', 'pip', 'install', '--require-hashes', '--no-deps', '-r', 'integrations\skfolio\requirements.lock')),
  @('TradingAgents', '.local\tradingagents-venv', @('-m', 'pip', 'install', '-r', 'integrations\tradingagents\requirements.lock.txt')))
foreach ($e in $envs) {
  $venvPy = Join-Path $root ($e[1] + '\Scripts\python.exe')
  $marker = Join-Path $root ($e[1] + '\.installed')
  if (Test-Path $marker) { Ok "$($e[0]) environment"; continue }
  if (-not (Test-Path $venvPy)) { Run $pyExe ($pyArgs + @('-m', 'venv', (Join-Path $root $e[1]))) "creating the $($e[0]) environment" }
  Run $venvPy ($e[2] + @('--disable-pip-version-check')) "installing the $($e[0]) environment"
  if ($e[0] -eq 'TradingAgents') { Run $venvPy @('-m', 'pip', 'install', '--no-deps', '-r', 'integrations\tradingagents\requirements.txt', '--disable-pip-version-check') 'TradingAgents itself' }
  Set-Content $marker (Get-Date -Format o)
  Ok "$($e[0]) environment installed"
}

# ---------- 6. database ----------
Step 'The database'
if ($hasDatabase) { Ok 'already in .data\paper' }
else {
  $backup = Get-ChildItem (Join-Path $root '.local\backups') -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $backup) { Stop-Here 'No backup in .local\backups: on the old machine run "npm run handover", then run this again' }
  Run node @('--env-file=.env', 'scripts\backup.mjs', 'restore', $backup.FullName, '.data\paper') 'restoring the database'
  Ok "restored from $($backup.Name) (verified first)"
}

# ---------- 7. knowledge ----------
Step 'The knowledge index'
Run npm @('run', 'knowledge', '--', 'build') 'the knowledge index'
Ok 'built'

# ---------- 8. the model ----------
Step 'The local model (Qwen 3.5-4B, 2.6 GB) and its runtime'
Run npm @('run', 'model:local', '--', 'install', 'runtime') 'the model runtime'
Run npm @('run', 'model:local', '--', 'install', 'qwen3.5-4b-q4km') 'the model'
if ($envText -notmatch '(?m)^HERMES_MODEL_BASE_URL=') { Run npm @('run', 'model:local', '--', 'configure', 'qwen3.5-4b-q4km') 'configuring the model' }
if ($envText -notmatch '(?m)^MODEL_AUTOSTART=') { Add-Content (Join-Path $root '.env') 'MODEL_AUTOSTART=qwen3.5-4b-q4km'; Ok 'the supervisor starts the model for each cycle' }
Ok 'installed and verified against the lock'

# ---------- 9. faster model settings (points 1 and 4) ----------
Step 'Faster model settings for this machine (the Intel graphics runtime if it is faster; the best thread counts)'
& npm run model:local -- resolve runtime-vulkan
if ($LASTEXITCODE -eq 0) { & npm run model:local -- install runtime-vulkan }
if ($LASTEXITCODE -ne 0) { Note 'the graphics runtime was not available or not verified: the CPU build is used'; $global:LASTEXITCODE = 0 }
Run npm @('run', 'model:tune') 'measuring the model speed (several minutes)'
Ok 'measured: see .local\models\tuning.json'

# ---------- 10. a bigger decision model (point 3) ----------
Step 'A bigger decision model for the debate and TradingAgents (used only if it passes our exams)'
$ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Note "this machine has $ramGB GB of RAM"
if ($SkipUpgrade) { Note 'skipped (-SkipUpgrade): the 4B does every job' }
elseif ($ramGB -lt 15) { Note 'under 15 GB: the 4B does every job' }
else {
  & npm run model:upgrade
  if ($LASTEXITCODE -ne 0) { Note 'the upgrade did not complete: the 4B does every job (run "npm run model:upgrade" later to try again)'; $global:LASTEXITCODE = 0 }
}

# ---------- 11. checks ----------
Step 'Checks'
& npm run verify -- --quick
if ($LASTEXITCODE -ne 0) { Note 'some checks failed: see .local\verify\*.log before trusting this machine'; $global:LASTEXITCODE = 0 } else { Ok 'all checks passed' }
& npm run preflight
$global:LASTEXITCODE = 0

# ---------- 12. start ----------
Step 'Start'
if ($NoStart) { Note 'not started (-NoStart). Start with: npm run supervisor'; exit 0 }
if ($lastData -notmatch '^Handover to') {
  Note 'The data repository''s last change is not a handover. Run the organisation on ONE machine only.'
  $answer = Read-Host '    Is it stopped on the old machine (npm run handover there)? (y/N)'
  if ($answer -notmatch '^[yY]') { Note 'not started. After the handover there: npm run supervisor'; exit 0 }
}
$answer = Read-Host '    Start the supervisor automatically at every logon, restarting it if it stops (a Windows scheduled task, no admin rights)? (y/N)'
if ($answer -match '^[yY]') {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install-supervisor-task.ps1')
  Start-ScheduledTask -TaskName 'Trading organisation supervisor'
  Ok 'scheduled task registered and started'
} else {
  New-Item -ItemType Directory -Force (Join-Path $root '.local\logs') | Out-Null
  Start-Process -FilePath cmd.exe -ArgumentList '/c', 'npm run supervisor >> .local\logs\supervisor.log 2>&1' -WorkingDirectory $root -WindowStyle Minimized
  Ok 'supervisor started in a minimized window (after a restart, run: npm run supervisor)'
}
Write-Host ''
Write-Host 'Done. Check with: npm run status   (readiness 09:00, the cycle with the model at 16:05 IST, a Friday backup)' -ForegroundColor Green
