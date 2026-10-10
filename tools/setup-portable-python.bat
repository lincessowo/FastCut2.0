@echo off
REM This Source Code Form is subject to the terms of the Mozilla Public
REM License, v. 2.0. If a copy of the MPL was not distributed with this
REM file, You can obtain one at https://mozilla.org/MPL/2.0/.
chcp 65001 >nul 2>&1
powershell -ExecutionPolicy Bypass -File "%~dp0setup-portable-python.ps1"
pause
