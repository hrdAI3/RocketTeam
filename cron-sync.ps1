# Rocket Team — sync cron entry point.
# Runs every N minutes via Windows Task Scheduler (see scripts/install-cron.ps1).
# Pulls CC sessions + re-derives anomalies + re-warms work summaries.

$ErrorActionPreference = 'Stop'
$ProjectRoot = 'D:\hrdai\team'
$Bun = 'C:\Users\neuro\.bun\bin\bun.exe'
$LogDir = Join-Path $ProjectRoot 'private\cron-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format 'yyyy-MM-dd'
$Log = Join-Path $LogDir "$Stamp.log"

Set-Location $ProjectRoot
$started = Get-Date -Format 'o'
Add-Content -Path $Log -Value "=== $started sync start ==="
try {
    & $Bun run src/scripts/sync.ts --only=cc,anomaly,summaries --lookback=2 2>&1 | Tee-Object -Append -FilePath $Log
    $exit = $LASTEXITCODE
    Add-Content -Path $Log -Value "=== $(Get-Date -Format 'o') sync done exit=$exit ==="
} catch {
    Add-Content -Path $Log -Value "=== $(Get-Date -Format 'o') sync crashed: $_ ==="
    throw
}
