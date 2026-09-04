@echo off
cd /d "C:\Users\hpcnd\Downloads\Python\scanner"

if not exist "logs" mkdir "logs"

:: Timestamp for log file name (YYYYMMDD)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set dt=%%I
set LOGFILE=logs\scanner_%dt:~0,8%.log

echo. >> "%LOGFILE%"
echo ======================================================== >> "%LOGFILE%"
echo  NSE Scanner Run  [%dt:~6,2%-%dt:~4,2%-%dt:~0,4%  %dt:~8,2%:%dt:~10,2%:%dt:~12,2% IST] >> "%LOGFILE%"
echo ======================================================== >> "%LOGFILE%"

:: Run scanner — output goes to log
"C:\Users\hpcnd\AppData\Local\Programs\Python\Python312\python.exe" -c ^
"from app.scanner.runner import run; s = run(refresh_data=True); print(); print('Stocks processed:', s['stocks_processed']); print('Signals created :', s['signals_created']); print('Status          :', s['status']); print('Duration        :', s['elapsed_seconds'], 's')" ^
>> "%LOGFILE%" 2>&1

if errorlevel 1 (
    echo [FAILED] Check log above for details >> "%LOGFILE%"
) else (
    echo [SUCCESS] Run complete >> "%LOGFILE%"
)
