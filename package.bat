@echo off
REM Build and package statuESK VS Code extension
call npm install
call npm run compile
if %errorlevel% neq 0 (
  echo Build failed!
  exit /b %errorlevel%
)
call npx vsce package
if %errorlevel% neq 0 (
  echo Packaging failed!
  exit /b %errorlevel%
)
echo Build and packaging succeeded!
