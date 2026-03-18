# Changelog

All notable changes to Clarity Scribe are documented here.

## [1.2.0] - 2026-03-18

### Fixed
- **Recording in Production Builds** — AudioWorklet processor was not bundled by Vite for production. Inlined via Blob URL so recording works in both dev and packaged builds.
- **Recording Toggle State** — Fixed desync between App and hook `isRecordingRef` that caused recordings to get stuck and require a force-quit to stop.

### Changed
- **App Icon** — Redesigned to full-bleed dark navy with white mic-pen symbol. Squircle mask with transparent corners applied for proper Dock appearance on unsigned builds.
- **Dock Visibility** — App now appears in the macOS Dock like a standard application.
- **Setup Persistence** — Setup completion is saved so returning users skip the setup screen entirely.
- **Permission Hints** — Clearer rationale text for mic ("Required to hear your voice for transcription") and accessibility ("Required to auto-paste text into your active app") permissions during setup.

## [1.1.0] - 2026-03-18

### Added
- **Guided First-Run Setup** — Two-phase onboarding: model download progress bar followed by explicit permission requests for microphone and accessibility (System Events). No more surprise permission dialogs.
- **Visible Tray Icon** — SVG microphone icon in the macOS menu bar with Show/Quit context menu. Previously the tray used an empty/invisible icon.
- **Hotkey Hint in Widget** — Status area now shows `Press ⌥+Space to record` when idle, so new users know how to use the app without opening Settings.
- **Launch on Login** — Toggle in Settings (off by default) to auto-start Clarity Scribe when you log in.
- **Individual History Deletion** — Delete single transcription entries with inline "Confirm Delete?" / "Cancel" buttons. Previously only "Clear All" was available.
- **Delete Confirmation UX** — Both individual delete and Clear All now show explicit "Confirm?" + "Cancel" buttons instead of auto-dismissing hints.

### Changed
- **Default Model** — Upgraded from Whisper Small (244M params, ~10.5% WER) to **Whisper Large V3 Turbo** (809M params, ~7.7% WER). ~30% more accurate with comparable speed.
- **Setup Screen Title** — Renamed from "Clarity Lite" to "Clarity Scribe" throughout.
- **Window Centering** — First launch now centers the widget horizontally and places it at the upper third of the screen. Previously defaulted to bottom-right corner which could be off-screen. Also validates saved positions are still on-screen (handles monitor changes).
- **Active App Polling** — Deferred to after setup completes, so the System Events permission is requested in context during onboarding rather than firing unexpectedly at launch.

### Fixed
- **Hotkey Display** — `Option+Space` on Mac now correctly displays as `⌥ + Space` in Settings. Previously the Space part was invisible because Mac's Option key produces a non-breaking space character (`\u00A0`) which wasn't being mapped.

### Security
- **Build Hardening** — Source maps disabled, `console.log` and `debugger` statements stripped from production builds, legal comments removed. No personal paths or identifiers leak into the DMG.
- **Git Author Sanitized** — All commits use `Clarity Scribe <noreply>` as author.

## [1.0.0] - 2026-03-17

### Added
- Initial release
- Global hotkey recording with configurable shortcut
- Whisper-powered offline transcription
- Paste-to-target with active app detection (macOS AppleScript, Windows PowerShell)
- Clipboard fallback when paste isn't possible
- Transcription history with timestamps
- Always-on-top floating widget with waveform visualization
- Settings panel: hotkey, microphone selection, language, auto-stop silence
- macOS DMG and Windows NSIS installer build configs
- macOS entitlements for microphone, automation, and native modules
