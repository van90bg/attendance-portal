@echo off
REM Cloud Agent sandbox bootstrap - Windows (double-click or run: start.cmd)
setlocal
cd /d "%~dp0"

if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - fill in keys, then run again.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js ^>=^= 18 required ^(node not found^).
  exit /b 1
)

if not exist node_modules (
  call npm install --no-audit --no-fund
)

call npm start