@echo off
REM ============================================================
REM  install.bat  –  Arcanator first-time setup
REM  Run once as Administrator before using start.bat
REM ============================================================

echo.
echo  ======================================
echo   Arcanator – Instalacion de dependencias
echo  ======================================
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python no encontrado. Instala Python 3.10+ desde https://python.org
    pause & exit /b 1
)

REM Check FFmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [AVISO] FFmpeg no encontrado en el PATH.
    echo         Descargalo desde https://ffmpeg.org/download.html
    echo         y aniadelo al PATH del sistema antes de exportar videos.
    echo.
)

echo [1/3] Creando entorno virtual Python...
cd /d "%~dp0backend"
python -m venv venv
if errorlevel 1 ( echo [ERROR] No se pudo crear el entorno virtual. & pause & exit /b 1 )

echo [2/3] Instalando dependencias Python...
call venv\Scripts\activate.bat
pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 ( echo [ERROR] Fallo al instalar dependencias. & pause & exit /b 1 )

echo [3/3] Creando directorio de salida...
if not exist "%~dp0output" mkdir "%~dp0output"

echo.
echo  ======================================
echo   Instalacion completada con exito.
echo   Ahora ejecuta start.bat para iniciar.
echo  ======================================
echo.
pause
