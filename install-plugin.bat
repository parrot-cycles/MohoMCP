@echo off
echo ============================================
echo  MohoMCP Plugin Installer
echo ============================================
echo.

rem Usage: install-plugin.bat ["D:\path\to\Moho 14"]
rem Without an argument, uses the folder Moho's installer registered (the first
rem one found if several Moho versions are installed), else the default path.
set "MOHO_DIR=%~1"
if not defined MOHO_DIR for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -like 'Moho*' | Select-Object -First 1).InstallLocation"`) do set "MOHO_DIR=%%P"
if not defined MOHO_DIR set "MOHO_DIR=C:\Program Files\Moho 14"
if "%MOHO_DIR:~-1%"=="\" set "MOHO_DIR=%MOHO_DIR:~0,-1%"

set "SCRIPTS=%MOHO_DIR%\Resources\Support\Scripts"
set "MENU_DEST=%SCRIPTS%\Menu\MohoMCP"
set "MODULE_DEST=%SCRIPTS%\Modules\moho_mcp"
set "TOOL_DEST=%SCRIPTS%\Tool"
set "SRC=%~dp0moho-plugin"

echo Moho scripts folder: "%SCRIPTS%"
echo.
if not exist "%SCRIPTS%\Tool\_tool_list.txt" (
    echo ERROR: No Moho install found there.
    echo Pass your Moho install folder as an argument, for example:
    echo   install-plugin.bat "D:\Apps\Moho 14"
    echo.
    pause
    exit /b 1
)

rem Never delete or write through links. Moho's own folders must not be links
rem (they could lead back into a checkout); MohoMCP's own paths that are links
rem (junctions or symlinks, e.g. Menu\MohoMCP linked to <checkout>\moho-plugin)
rem are removed as links only, so their targets are never touched.
call :islink "%SCRIPTS%\Menu"
if defined ISLINK goto :linked_moho_folder
call :islink "%SCRIPTS%\Modules"
if defined ISLINK goto :linked_moho_folder
call :islink "%TOOL_DEST%"
if defined ISLINK goto :linked_moho_folder
call :unlink "%MENU_DEST%"
call :unlink "%MENU_DEST%\moho_mcp"
call :unlink "%MENU_DEST%\json.lua"
call :unlink "%MENU_DEST%\MohoMCP_Server.lua"
call :unlink "%MODULE_DEST%"
call :unlink "%TOOL_DEST%\MohoMCP_Poller.lua"

rem Moho runs every .lua file under Scripts\Menu at startup as a menu script,
rem so only MohoMCP_Server.lua goes there. Library modules go in Scripts\Modules.
echo Removing library files left in the Menu folder by older versions...
if exist "%MENU_DEST%\moho_mcp" rmdir /S /Q "%MENU_DEST%\moho_mcp"
if exist "%MENU_DEST%\json.lua" del /Q "%MENU_DEST%\json.lua"

echo Copying files...
mkdir "%MENU_DEST%" 2>NUL
copy /Y "%SRC%\MohoMCP_Server.lua" "%MENU_DEST%\" >NUL && xcopy /E /I /Y /Q "%SRC%\moho_mcp" "%MODULE_DEST%" >NUL && copy /Y "%SRC%\MohoMCP_Poller.lua" "%TOOL_DEST%\" >NUL
if errorlevel 1 (
    echo.
    echo ERROR: Copying failed. If Moho is under Program Files, run this as Administrator.
    echo.
    pause
    exit /b 1
)

echo Registering tool in tool list...
findstr /C:"MohoMCP_Poller" "%TOOL_DEST%\_tool_list.txt" >NUL 2>&1
if errorlevel 1 (
    echo tool	MohoMCP_Poller	...>> "%TOOL_DEST%\_tool_list.txt"
    echo   Added MohoMCP_Poller to _tool_list.txt
) else (
    echo   MohoMCP_Poller already in _tool_list.txt
)

echo.
echo Verifying installation...
dir /s /b "%MENU_DEST%" "%MODULE_DEST%"
echo.
dir "%TOOL_DEST%\MohoMCP_Poller.lua"

echo.
echo ============================================
echo  Installation complete!
echo ============================================
echo.
echo Next steps:
echo  1. Open MOHO 14
echo  2. Scripts menu ^> MohoMCP ^> Start/Stop MohoMCP Server
echo  3. Select the "MohoMCP Poller" tool from the toolbar
echo     (it will be in the last tool group)
echo  4. While the tool is selected, the server polls for requests
echo.
pause
exit /b 0

:linked_moho_folder
echo.
echo ERROR: A Moho Scripts folder (Menu, Modules or Tool) is a link. It could lead
echo back into this checkout, so the installer will not write into it.
echo.
pause
exit /b 1

rem Sets ISLINK when %1 is a junction or symbolic link (reparse point: the
rem 9th attribute letter is "l").
:islink
set "ISLINK="
set "ATTR=%~a1"
if not defined ATTR exit /b 0
if "%ATTR:~8,1%"=="l" set "ISLINK=1"
exit /b 0

rem Removes %1 if, and only if, it is a link: rmdir without /S removes a
rem directory junction/symlink itself; del removes a file symlink itself.
:unlink
call :islink "%~1"
if not defined ISLINK exit /b 0
if "%ATTR:~0,1%"=="d" (rmdir "%~1") else (del /Q "%~1")
echo   unlinked %~1
exit /b 0
