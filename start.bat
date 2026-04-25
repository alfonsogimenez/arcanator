@echo off
REM ============================================================
REM  start.bat  –  Start the Arcanator backend (uvicorn)
REM  Keep this window open while using the app.
REM  Access the app at: http://localhost:8000
REM ============================================================

cd /d "%~dp0backend"

REM Activate virtual environment
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo [AVISO] Entorno virtual no encontrado. Usando Python del sistema.
    echo         Si hay errores, ejecuta install.bat primero.
)

echo.
echo  ========================
echo   Arcanator esta corriendo
echo   http://localhost:8000
echo  ========================
echo.

uvicorn main:app --host 0.0.0.0 --port 8000 --reload

pause
