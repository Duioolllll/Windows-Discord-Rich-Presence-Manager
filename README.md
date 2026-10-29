# AutoPresence (development preview)

AutoPresence is an in-progress Windows Discord activity detector. This repository is not yet a finished or Windows-validated release. It uses Electron and TypeScript: Electron simplifies a shared JavaScript desktop UI and integration, at the cost of substantially higher memory use than a native WebView/Tauri approach. Windows measurements and a performance comparison are still required.

## Development

Use Node.js 24 and pnpm 11. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The build emits `dist-js/` and two browser-extension directories under `extension/build/`. On a Windows desktop, `pnpm start` starts the Electron application after building. On first launch, choose English or Korean, then start the Discord desktop client and enter a Discord developer Application ID to connect. You can skip connection and configure it later in Settings, where you can also change the language. Create an application in the Discord Developer Portal and copy its Application ID from General Information; this is a public application identifier, not an account token. One ID has one Discord application name, and image keys must be registered with that application. Discord integration uses local IPC; the older Discord RPC library is deprecated, and current official SDK compatibility remains to be verified.

See [extension/README.md](extension/README.md) for loading the extension and per-user Native Messaging host registration and removal. Detailed site signals must be enabled in both the extension and app. Browser extensions require separate user installation. The app only accepts a browser signal while a corresponding browser process is in the foreground and expires it after 15 seconds. A local pipe is not an authentication boundary against other local processes.

`pnpm package:win` attempts x64 NSIS and portable packages. Windows installation, removal, executable startup, browser registration and Discord integration are not yet verified. Native host registration is currently manual, including on installed builds; automatic installer registration is not implemented. Unsigned executables can trigger SmartScreen warnings. Do not treat generated binaries as a verified release.

## Privacy and limitations

Foreground application name and, with the extension, active domain are used by default. Page titles, URLs and executable paths are not sent to Discord. Private browsing is excluded by the extension. Site-specific signals are optional, allowlisted, and send predefined categories rather than URLs. Pause and exclusion controls are provided. No account token or user keystrokes are collected.

This preview does not implement application-specific internal detection for VS Code, Figma, Notion, Word, or Photoshop; unsupported actions are not inferred. The extension currently implements a subset of site signals. Path, file-path, and window-title rules are represented by the core but cannot match in the current app integration because those values are not collected. The browser association is process-name based, not proof of the exact native window. The supplied tests use mocks or Linux-compatible components; they do not prove Windows operation, browser integration, performance, or installer behavior.

## Verification status

`pnpm test` runs unit tests for the engine, protocol, extension behavior, Windows detector parsing and local fake Discord IPC. A Windows desktop with Discord, browsers and the extension is required to validate the complete workflow and to measure CPU and memory use.
