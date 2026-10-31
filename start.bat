@echo off
chcp 65001 >nul
cd /d %~dp0

if not exist node_modules (
  echo.
  echo   首次运行：正在安装依赖 exceljs / jimp，请稍候...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   依赖安装失败，请确认已安装 Node.js 且网络可用。
    pause
    exit /b 1
  )
)

node show-address.js
echo.
echo   本窗口请保持打开（关闭窗口 = 关闭服务，别人就打不开了）
echo.
start "" http://localhost:3000/
node server.js
pause
