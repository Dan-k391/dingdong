@echo off
cd /d "%~dp0"
echo DingDong running at http://localhost:8080  (Ctrl+C to stop)
start "" http://localhost:8080
python -m http.server 8080 || py -m http.server 8080
pause
