@echo off
rem ============================================================================
rem Launch the dev app detached (this script returns immediately) so that
rem F5 -> "Launch & Attach Dev (9799)" can attach instead of launching.
rem
rem Why detached + attach: js-debug's `launch` request tears the browser down
rem when the debug session ends (cleanUp: wholeBrowser), which looked exactly
rem like "the app closes itself a few seconds after F5". Attach never does that.
rem
rem The real work lives in start-dev-app.mjs, which also records HOW the app
rem died (exit code + signal) into %USERPROFILE%\.vssaros-dev\logs\app-exit.log.
rem Node is used there on purpose: PowerShell's $proc.ExitCode turned out to be
rem unreadable (`code=(unknown)`) in exactly the cases we need to diagnose.
rem ============================================================================
setlocal
start "" /b node "%~dp0start-dev-app.mjs"
exit /b 0
