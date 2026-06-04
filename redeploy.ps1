# Rocket Team — one-command redeploy (production).
#
# Prod runs `next start` (compiled build) on :3000, NOT `next dev` — so code
# changes need a rebuild + server restart to take effect. This does both:
#   1. next build  (compiled, optimized; ignoreBuildErrors is set in next.config)
#   2. stop the current :3000 server
#   3. start a fresh detached `next start`
#
# Usage:  ./redeploy.ps1     (from D:\hrdai\team, or anywhere — it cd's itself)

$ErrorActionPreference = 'Stop'
$Root = 'D:\hrdai\team'
$Bun = 'C:\Users\neuro\.bun\bin\bun.exe'
Set-Location $Root

Write-Host '[redeploy] building…' -ForegroundColor Cyan
& $Bun run build
if ($LASTEXITCODE -ne 0) {
  Write-Host '[redeploy] BUILD FAILED — leaving the running server untouched.' -ForegroundColor Red
  exit 1
}

Write-Host '[redeploy] stopping current :3000 server…' -ForegroundColor Cyan
$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  try { taskkill /PID $c.OwningProcess /T /F 2>&1 | Out-Null } catch {}
}
Start-Sleep -Seconds 2

Write-Host '[redeploy] starting fresh production server…' -ForegroundColor Cyan
$p = Start-Process -FilePath $Bun -ArgumentList '--bun','run','start' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 8
$l = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (@($l).Count -ge 1) {
  Write-Host "[redeploy] DONE — server up on :3000 (pid $($p.Id)). Hard-refresh the browser (Ctrl+Shift+R)." -ForegroundColor Green
} else {
  Write-Host '[redeploy] WARNING — no listener on :3000 after start. Check logs.' -ForegroundColor Red
  exit 1
}
