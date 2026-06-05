@echo off
REM Rocket Team server keepalive — runs `next start` on :3000 and auto-restarts
REM if it ever exits (crash, OOM). Launched hidden at login by the Startup-folder
REM .vbs shim (start-rocket-team.vbs). Logs to private\server-logs\.
setlocal
set ROOT=D:\hrdai\team
set BUN=C:\Users\neuro\.bun\bin\bun.exe
set LOGDIR=%ROOT%\private\server-logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%ROOT%"

:loop
echo [%date% %time%] starting next start >> "%LOGDIR%\keepalive.log"
"%BUN%" --bun run start >> "%LOGDIR%\server.log" 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restarting in 5s >> "%LOGDIR%\keepalive.log"
timeout /t 5 /nobreak >nul
goto loop
