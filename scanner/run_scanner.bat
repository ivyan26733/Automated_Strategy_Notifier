@echo off
title NSE Stock Scanner
cd /d "%~dp0"

echo ========================================
echo  NSE STOCK SCANNER
echo ========================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Please install Python 3.11+.
    pause
    exit /b 1
)

:: Install / verify dependencies
echo Checking dependencies...
pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)
echo Dependencies OK.
echo.

:: Run scanner
echo Starting scanner...
echo.
python -c "
from app.scanner.runner import run
summary = run(refresh_data=True)
print()
print('========================================')
print('NSE STOCK SCANNER COMPLETE')
print('========================================')
print(f'Run ID           : {summary[\"run_id\"]}')
print(f'Stocks scanned   : {summary[\"stocks_requested\"]:,}')
print(f'Stocks processed : {summary[\"stocks_processed\"]:,}')
print(f'Stocks failed    : {summary[\"stocks_failed\"]:,}')
print(f'Signals created  : {summary[\"signals_created\"]:,}')
print(f'Supabase update  : SUCCESS' if summary['status'] == 'success' else f'Supabase update  : PARTIAL')
print(f'Duration         : {summary[\"elapsed_seconds\"]}s')
print('========================================')
"

if errorlevel 1 (
    echo.
    echo Scanner encountered errors. Check output above.
)

echo.
echo Press any key to close...
pause >nul
