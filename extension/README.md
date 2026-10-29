# Browser extension and native host

Run `node extension/build.mjs` at the repository root. Load `extension/build/chromium` as an unpacked extension in Chrome or Edge. For development, load `extension/build/firefox/manifest.json` from Firefox's `about:debugging`. Firefox temporary add-ons do not survive browser restarts; distributing a persistent add-on requires Mozilla signing. Chrome and Edge distributions also require suitable packaging and browser approval. This is not an automatically installed browser extension.

The popup enables detailed activity detection independently for each supported site. All are disabled by default. YouTube playback also requests optional YouTube host permission. Without the native host or in private browsing, no detailed activity is sent. Without this extension, AutoPresence can only display the browser application. The extension does not send page URLs, titles, document names or content to the host. The browser's `tabs` permission is required to determine the active domain and may grant the browser APIs access to page URLs.

On Windows, after building the Electron main code, run the following **as the current user**, replacing paths and IDs with the actual installed executable, built host file, and installed extension IDs (find the IDs on each browser's extensions page). Pass only the browser IDs actually installed. The Firefox development manifest uses `autopresence@local.invalid`.

```powershell
powershell -ExecutionPolicy Bypass -File src/native/register.ps1 `
  -ElectronExe 'C:\path\to\AutoPresence.exe' `
  -HostScript 'C:\path\to\app.asar.unpacked\dist-js\native\host.js' `
  -ChromeExtensionId 'replace-with-32-character-extension-id' `
  -FirefoxExtensionId 'autopresence@local.invalid'
```

The Electron executable must support `ELECTRON_RUN_AS_NODE`. Host registration writes per-user registry keys and manifests under `%LOCALAPPDATA%\AutoPresence\NativeMessaging`. Run `src/native/unregister.ps1` to remove registrations created there. The host does not execute commands sent by pages. It validates each framed message and forwards only a predefined activity to a local Windows named pipe. The receiving application must verify the foreground process and expire stale updates. A local named pipe is not a security boundary against other local processes. Native Messaging registration, browser installation, and browser-to-application operation must be verified on Windows.
