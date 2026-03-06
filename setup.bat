@echo off
cd /d "%~dp0"
echo Installing dependencies...
npm install
echo.
echo Setup complete. Run scan.bat to generate the dashboard.
pause
