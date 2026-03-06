@echo off
cd /d "%~dp0"

echo Running carrier restriction scan...
"C:\Program Files\nodejs\node.exe" "%~dp0scraper.js"
if errorlevel 1 (
  echo ERROR: scraper failed. Check that Node.js is installed.
  pause
  exit /b 1
)

echo.
echo Pushing updated dashboard to GitHub...
git add dashboard.html
git commit -m "Daily scan %date%"
git push origin main

echo.
echo Done. Dashboard is live on GitHub Pages.
