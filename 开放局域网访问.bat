@echo off
chcp 65001 >nul
setlocal
title 示例动漫社 - 局域网访问设置

:: ===== 自动申请管理员权限 =====
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 正在申请管理员权限，请在弹窗中点击“是”...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" >nul 2>&1
  exit /b
)

:menu
cls
echo ============================================================
echo            示例动漫社 · 局域网访问设置
echo ============================================================
echo.
echo   [1]  开放局域网访问（放行 TCP 3000 端口）
echo        让同一 WiFi / 局域网内的同学能够打开填写页面
echo.
echo   [2]  关闭局域网访问（删除放行规则，恢复默认安全状态）
echo.
echo   [3]  查看当前放行状态
echo.
echo   [0]  退出
echo.
set /p choice=请输入数字后回车：

if "%choice%"=="1" goto open
if "%choice%"=="2" goto close
if "%choice%"=="3" goto status
if "%choice%"=="0" exit /b
goto menu

:open
echo.
netsh advfirewall firewall delete rule name="示例动漫社入社申请系统" >nul 2>&1
netsh advfirewall firewall add rule name="示例动漫社入社申请系统" dir=in action=allow protocol=TCP localport=3000 >nul
if %errorlevel% equ 0 (
  echo   √ 已放行 TCP 3000 端口
) else (
  echo   × 放行失败，请确认已使用管理员权限运行
)
echo.
echo   现在把下面的链接发给同学（同一 WiFi 下）：
echo.
node "%~dp0show-address.js"
echo.
pause
goto menu

:close
echo.
netsh advfirewall firewall delete rule name="示例动漫社入社申请系统" >nul 2>&1
echo   √ 已删除放行规则，局域网内其它设备将无法再访问
echo.
pause
goto menu

:status
echo.
netsh advfirewall firewall show rule name="示例动漫社入社申请系统" | findstr /i "规则名称 RuleName 已启用 Enabled 本地端口 LocalPort 操作 Action"
echo   （若上方没有内容，说明当前未放行）
echo.
pause
goto menu
