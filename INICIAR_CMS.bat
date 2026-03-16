@echo off
REM ============================================
REM SONORO AV - INICIAR CMS CON PM2
REM ============================================

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║                    SONORO AV - CMS                         ║
echo ║              Iniciando sistema de cartelería               ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

REM Obtener la ruta del script
cd /d "%~dp0"

REM Verificar que estamos en la carpeta correcta
if not exist "ecosystem.config.js" (
    echo.
    echo ❌ ERROR: ecosystem.config.js no encontrado
    echo.
    echo Este script debe ejecutarse desde la RAIZ del proyecto:
    echo C:\Users\sonor\Documents\...\cms-digital-signage-rpi4\
    echo.
    pause
    exit /b 1
)

REM Verificar que PM2 está instalado
where pm2 >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ ERROR: PM2 no está instalado globalmente
    echo.
    echo Instala PM2 con: npm install -g pm2
    echo.
    pause
    exit /b 1
)

REM Matar procesos anteriores si existen
echo ⏹️  Deteniendo procesos anteriores...
call pm2 kill >nul 2>nul

REM Esperar un segundo
timeout /t 1 /nobreak >nul

REM Iniciar PM2 con ecosystem.config.js
echo.
echo 🚀 Iniciando CMS Backend con PM2...
echo.

call pm2 start ecosystem.config.js

REM Esperar a que se inicie
timeout /t 3 /nobreak >nul

REM Ver status
echo.
echo 📊 Estado de procesos:
echo.
call pm2 status

REM Mostrar información
echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║                    ✅ SISTEMA INICIADO                     ║
echo ╠════════════════════════════════════════════════════════════╣
echo ║                                                             ║
echo ║  🌐 Dashboard:     http://localhost:5000/dashboard.html   ║
echo ║  ⚙️  Admin:        http://localhost:5000/admin.html       ║
echo ║  📊 API Health:    http://localhost:5000/api/health       ║
echo ║                                                             ║
echo ║  Login:                                                    ║
echo ║    Email: sonoroaxm@gmail.com                            ║
echo ║    Password: sOnoro2025@                                 ║
echo ║                                                             ║
echo ║  Puerto: 5000                                             ║
echo ║  BD: PostgreSQL (cms_signage)                            ║
echo ║                                                             ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

REM Comando para ver logs (opcional)
echo 💡 Para ver los logs en tiempo real, abre otra terminal y ejecuta:
echo    pm2 logs sonoro-backend
echo.

pause
