# Windows and WSL in practice

For work on a Windows machine, with or without WSL. Check which shell this session uses (execution-environment section) before applying a rule.

## Paths
- Windows `C:\Users\me\file.txt` is `/mnt/c/Users/me/file.txt` in WSL. Convert with `wslpath -u 'C:\path'` and `wslpath -w /mnt/c/path`; quote both forms, since paths often contain spaces and non-ASCII characters (中文目录名 are common).
- File tools and a tool's `workdir` take the host (Windows) path. Only the command text inside WSL uses `/mnt/...`.
- The Windows user folders are not where Linux puts them: Downloads, Desktop and Documents may be redirected (OneDrive, another drive). Read the real location from the registry (`reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"`) or ask, instead of assuming `C:\Users\<name>\Downloads`.
- The WSL home (`/home/<user>`) is on ext4 and fast; `/mnt/c` is a network-like 9P mount and slow for many small files (node_modules, git status on big repos). Build and install inside the Linux filesystem when the project allows; edit Windows files in place when the user works on them there.
- Linux paths are case-sensitive, Windows ones are not. `/mnt/c` follows Windows rules by default: two names differing only in case may collide.
- Windows forbids `< > : " / \ | ? *` in names and reserves `CON`, `PRN`, `AUX`, `NUL`, `COM1`… Long paths over 260 characters fail in many Windows tools.

## Calling between the two sides
- From WSL, run Windows programs by their `.exe` name: `powershell.exe -NoProfile -Command '…'`, `cmd.exe /c …`, `explorer.exe .`, `clip.exe`. Pass Windows paths to them. Their output arrives in the console code page, often with CRLF; strip `\r` before comparing.
- From Windows, run Linux commands with `wsl.exe -d <distro> -e bash -lc '…'`.
- Use Linux tools for Linux work. Reach for Windows only for what needs it: GUI programs, the registry, Windows services, Office automation, Windows-only CLIs.

## Networking
- WSL 2 runs in a VM. A server started in WSL is usually reachable from Windows at `localhost` (localhost forwarding); a server on Windows is reached from WSL at `localhost` only in mirrored networking mode, otherwise at the Windows host IP (`ip route show default | awk '{print $3}'`). Test with a bounded `curl -m 5` before assuming either way.
- A proxy app on Windows (Clash and similar) does not automatically apply in WSL; respect the `HTTP(S)_PROXY` variables already set and do not change proxy settings without asking.

## Windows PowerShell 5.1 (powershell.exe)
- No `&&` or `||`: use `cmd1; if ($?) { cmd2 }`. No ternary, no `??`.
- Redirecting a native program's stderr (`2>&1`) wraps lines as errors and sets `$?` to false even on success; read `$LASTEXITCODE` for native programs.
- Encoding: `Set-Content`/`Add-Content` write the ANSI code page; `Out-File` and `>` write UTF-16 LE in 5.1. Write files for other tools with `Set-Content -Encoding utf8` (adds a BOM in 5.1) or `[IO.File]::WriteAllText($p, $s, [Text.UTF8Encoding]::new($false))` for UTF-8 without BOM. A BOM breaks some parsers (shebangs, some JSON readers).
- Quoting: single quotes are literal, double quotes expand `$var` and backtick escapes. When calling from bash, wrap the whole PowerShell command in single quotes and use double quotes inside.
- `Remove-Item -Recurse -Force`, `Stop-Process` and similar may prompt; add `-Confirm:$false` only when you mean it.
- PowerShell 7 (`pwsh`) differs: it has `&&`, UTF-8 without BOM by default and the ternary operator. Check which one the session uses.

## Text files
- Line endings: keep each file's existing style. Git's `core.autocrlf=true` checks out CRLF on Windows and stores LF; scripts run in WSL must have LF (`bash\r: No such file` means CRLF). Fix one file with `sed -i 's/\r$//' f` or a `.gitattributes` rule, not a global setting change.
- Console output from Chinese Windows tools may be GBK/CP936. Decode it explicitly (`iconv -f GBK -t UTF-8`, Python `errors="replace"`) instead of printing mojibake.

## Files, locks and permissions
- Windows locks open files: deleting or renaming a file a program has open (an editor, Excel, a running exe, an antivirus scan) fails with "being used by another process". Close or wait for the program; do not kill processes you did not start without asking.
- `chmod` on `/mnt/c` has no effect unless the mount uses metadata. Executable scripts belong on the Linux side.
- Elevated (administrator) actions cannot be performed from a normal session: say what needs elevation and let the user run it.
- Defender or other antivirus can quarantine freshly written scripts or slow down builds; report it instead of disabling protection.

## Before you finish
State which side (Windows or WSL) a produced file or service lives on, with the path the user can open (the Windows path for files they will open in Explorer).
