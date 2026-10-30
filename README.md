# AutoPresence (development preview)

AutoPresence is an in-progress Windows Discord activity detector. This repository is not yet a finished or Windows-validated release. It uses Electron and TypeScript; Windows performance and end-to-end behavior still need measurement.

## Development

Use Node.js 24 and pnpm 11. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

On a Windows desktop, `pnpm start` starts the Electron application after building. On first launch, choose English or Korean, then start the Discord desktop client and enter a Discord developer Application ID. You can configure the connection later in Settings. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and copy its Application ID from General Information. The ID is public; do not enter an account token or password.

The detector lists processes with visible top-level windows in the current session, including minimized windows. The active eligible app takes priority; when the active window is excluded, the previously selected app remains selected while it is running. Otherwise, the most recently started eligible app is selected. Browser processes, Discord, AutoPresence, and common system shells are excluded. Tray-only, hidden-window and some packaged apps may not appear. Details say the app is **running**, not that a particular action is being performed. Exclusions and custom rules remain available.

Browser and website detection is temporarily disabled: the application does not start its Native Messaging server and does not use browser signals. The extension source is retained for future work but is not included in this package. If you installed a previous browser extension, disable or uninstall it separately; the desktop app cannot turn it off for you.

## Discord names and images

The app sends the detected name in the RPC activity `name` field and an image reference in `assets.large_image`. Some common apps (Visual Studio Code, Figma, Notion, Spotify, Steam) use public PNG logos from GitHub's `github/explore` repository, pinned to a specific commit. Other apps use text only unless you add an Activity Rule with a display name and either an image asset key registered to your Discord application or a public HTTPS image URL. Discord retrieves external images; do not use URLs containing private information. URLs with credentials, queries, fragments, local hostnames or IP addresses are rejected.

The implementation references the open-source [xhayper/discord-rpc](https://github.com/xhayper/discord-rpc) activity payload and the [Discord activity documentation](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway-events.mdx). The actual appearance of the requested name and image depends on Discord's client and API behavior and has not yet been verified on Windows; an RPC acknowledgement is not proof of how a profile renders. The connected Discord Application ID may still affect the name Discord shows.

`pnpm package:win` attempts x64 NSIS and portable packages. Windows installation, removal, executable startup and Discord integration are not yet verified. Unsigned executables can trigger SmartScreen warnings. Do not treat generated binaries as a verified release.

## Privacy and limitations

The running application name and generic activity can be published to Discord. Window titles and executable paths are not collected by default. Known application logo URLs and explicitly configured image URLs are shared with Discord for image fetching. Pause and exclusion controls are provided. No account token or keystrokes are collected.

This preview does not implement application-specific internal detection; it does not infer unsupported actions. Path and window-title rules cannot match because those values are not collected. The supplied tests use mocks or Linux-compatible components; they do not prove Windows operation, Discord rendering, performance, or installer behavior.

## Verification status

`pnpm test` exercises the engine, process-selection policy, protocol, UI and fake Discord IPC. A Windows desktop with Discord is required to validate the complete workflow and measure CPU and memory use.
