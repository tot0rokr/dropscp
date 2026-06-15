@echo off
setlocal
cd /d "%~dp0"

REM Start the server in a new window so it keeps running
start "dropscp" cmd /k "npm start"

REM Wait for the server to come up, then open the browser
powershell -NoProfile -Command "$u='http://127.0.0.1:8765'; for($i=0;$i -lt 30;$i++){ try { (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1) | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }; Start-Process $u"

endlocal
