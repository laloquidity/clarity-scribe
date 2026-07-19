# uia-probe

Scribe's native Windows **UI Automation** reader — the screen agent's primary
"eyes" (see the repo README, *Screen agent*). A long-running stdio process that,
on request, returns the foreground (or a given) window's interactive controls as
JSON and activates them by id via `InvokePattern`/`ValuePattern`.

The compiled **`uia-probe.exe` is committed** (like the prebuilt
`smart-whisper.node`) so end users need no build step. Rebuild it only when
`uia-probe.cs` changes.

## Rebuild (maintainers)

No .NET SDK needed — uses the .NET Framework compiler that ships with Windows:

```powershell
$wpf = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\WPF"
& C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /o+ `
  /out:uia-probe.exe /win32manifest:uia-probe.manifest `
  /r:"$wpf\UIAutomationClient.dll" /r:"$wpf\UIAutomationTypes.dll" /r:"$wpf\WindowsBase.dll" `
  uia-probe.cs
```

The `uia-probe.manifest` declares **PerMonitorV2 DPI awareness** so
`BoundingRectangle` values are physical screen pixels (correct on scaled
displays) — it must be embedded via `/win32manifest`.

## Protocol

One JSON command per line on stdin → one JSON response per line on stdout:

| Command | Result |
|---|---|
| `{"cmd":"dump"}` | foreground window + interactive controls |
| `{"cmd":"dump","hwnd":N}` | same for a specific window (agent stays scoped to the app it drives) |
| `{"cmd":"windows"}` | visible top-level app windows (find a just-launched app) |
| `{"cmd":"invoke","id":N}` | `InvokePattern`/`Toggle`/`SelectionItem` on control N |
| `{"cmd":"setvalue","id":N,"text":"…"}` | focus + `ValuePattern.SetValue` |
| `{"cmd":"focus","id":N}` | `SetFocus()` |
| `{"cmd":"ping"}` | liveness |

Design notes: one bulk `FindAll` + `CacheRequest` (never per-property
cross-process reads); condition = enabled + on-screen + control-view +
interactive control types; hosted UWP `CoreWindow`s are resolved from their
`ApplicationFrameHost` frame; runs out-of-process so a hung app's UIA call can
be killed and the probe respawned by the caller's watchdog.
