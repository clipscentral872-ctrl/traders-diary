@echo off
REM Writes the whole trading record out as files you can open in Explorer.
REM Reads the Tradovate exports sitting in Downloads from the last two weeks
REM and rebuilds C:\Users\chris\Trading Record from scratch.
title Traders Diary - Write the record
cd /d "%~dp0"

echo.
echo   Reading your exports and writing the record.
echo.
node tools\write_record.mjs %*
if errorlevel 1 goto failed

echo.
start "" "%USERPROFILE%\Trading Record"
exit /b 0

:failed
echo.
echo   Something went wrong above. Leave this window open and send me the text.
pause
exit /b 1
