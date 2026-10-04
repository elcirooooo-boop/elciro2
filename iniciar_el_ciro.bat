@echo off
title EL CIRO - Futbol en Vivo
cls
echo ==============================================================
echo                ⚽ BIENVENIDO A EL CIRO ⚽
echo       Plataforma de Transmisiones de Futbol y Canales HD
echo ==============================================================
echo.
echo Iniciando servidor de streaming...
echo.

cd /d "%~dp0"

:: Abrir navegador automaticamente despues de 2 segundos
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5000"

:: Iniciar aplicacion Flask
python app.py

pause
