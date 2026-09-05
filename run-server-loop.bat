@echo off
cd /d "%~dp0"
:loop
echo [Servidor] Iniciando...
node server\index.mjs
echo.
echo [Servidor] Se detuvo o crasheo - reiniciando en 3 segundos... (cierra esta ventana para apagarlo del todo)
timeout /t 3 >nul
goto loop
