@echo off
chcp 65001 >nul
echo.
echo ==========================================
echo        MD 文件整理工具 - 启动脚本
echo ==========================================
echo.

cd /d "%~dp0"

echo [1/2] 安装依赖...
call npm install
if %ERRORLEVEL% neq 0 (
    echo [x] npm install 失败，请确认已安装 Node.js
    pause
    exit /b 1
)

echo.
echo [2/2] 启动服务...
echo.
echo [ok] 服务启动后，请在浏览器中访问:
echo    http://localhost:3737
echo.
echo （按 Ctrl+C 停止服务）
echo.
node server.js
pause
