@echo off
REM Build statuESK VS Code extension
call npm install
call npm run compile
if %errorlevel% neq 0 (
  echo Build failed!
  exit /b %errorlevel%
)
echo Build succeeded!
