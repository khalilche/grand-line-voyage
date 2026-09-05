@echo off
:loop
echo [Tunel] Conectando... espera el link que empieza con https:// y termina en .trycloudflare.com
echo [Tunel] (Ese link CAMBIA cada vez que esta ventana se reinicia - copia siempre el mas nuevo)
echo.
npx cloudflared tunnel --url http://localhost:8080
echo.
echo [Tunel] Se cerro o crasheo - reiniciando en 3 segundos... (cierra esta ventana para apagarlo del todo)
timeout /t 3 >nul
goto loop
