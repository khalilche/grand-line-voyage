@echo off
cd /d "%~dp0"
echo ================================================
echo   Preparando el juego para jugar online...
echo ================================================
call npm run build
if errorlevel 1 (
  echo.
  echo Hubo un error compilando el juego. Revisa el mensaje de arriba.
  pause
  exit /b 1
)

echo.
echo Abriendo el servidor y el tunel publico en dos ventanas nuevas...
echo NO CIERRES esas dos ventanas mientras esten jugando.
echo Si una se cierra sola por accidente, solo vuelve a correr este archivo.
echo.
start "Servidor del juego - NO CERRAR" cmd /k run-server-loop.bat
timeout /t 2 >nul
start "Link para amigos - NO CERRAR" cmd /k run-tunnel-loop.bat

echo.
echo Listo. En la ventana "Link para amigos" va a aparecer algo como:
echo   https://algo-random.trycloudflare.com
echo Ese es el link que le mandas a tus amigos. Si alguna ventana se
echo reinicia sola, el link cambia - copia siempre el mas reciente.
echo.
pause
