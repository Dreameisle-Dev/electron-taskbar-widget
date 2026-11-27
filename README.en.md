# electron-taskbar-widget

Embed transparent Electron `BrowserWindow` widgets into free space on the Windows 10/11 taskbar using `koffi` FFI (no C++ compilation) and UI Automation. Used by [Dreamisle](https://github.com/Dreameisle-Dev/Dreamisle-electron) and reusable in any Electron app.

[中文](./README.md) | English

## Features

- **Zero C++ native compilation**: Calls `user32.dll` and `advapi32.dll` via `koffi` (no `node-gyp` rebuilds across Electron versions), reusing preallocated buffers in polling loops.
- **Windows 10 & Windows 11 strategies**:
  - **Windows 11 (build ≥ 22000)**: Attaches via `SetParent` + `WS_CHILD`, probes taskbar button rectangles through PowerShell UI Automation, selects the widest free gap for centered or left-aligned taskbars, and falls back to the left of the system tray when UIA probing fails.
  - **Windows 10 (build < 22000)**: Squeezes the classic task list (`MSTaskSwWClass`) via `MoveWindow` to carve out real space (horizontal top/bottom and vertical left/right taskbars), renders as a topmost `WS_POPUP` overlay, and restores the task list on disable, empty content, DPI changes, or exit.
- **Full Electron host controller (`createTaskbarWidget`)**:
  - Follows an optional owner window across monitors (including secondary taskbars `Shell_SecondaryTrayWnd`);
  - Hides automatically when a foreground fullscreen window covers the widget's monitor;
  - Recovers from Explorer restarts, DPI/height changes (recreating the transparent surface), window-list fingerprint changes, and system light/dark theme or alignment updates.
- **Layered exports**: Use the high-level host controller or import the Win32 FFI, UIA probe, pure layout math, or Win10 squeeze controller individually.

## Requirements

- Windows 10 / 11 x64 (verified on Electron 40, Node.js 22, and `koffi` 3). Safe to import as a no-op on non-Windows platforms.
- Peer runtime dependencies provided by the host Electron app: `electron` and `koffi`.
- When packaging with `electron-builder`, unpack `koffi` from ASAR:
  ```json
  "asarUnpack": [
    "node_modules/koffi/**/*",
    "node_modules/@koromix/koffi-win32-*/**/*"
  ]
  ```

## Usage

Not published to npm yet. Add it as a Git submodule or clone the repository directly:

```bash
git submodule add https://github.com/Dreameisle-Dev/electron-taskbar-widget.git packages/electron-taskbar-widget
```

```js
import path from 'node:path';
import { createTaskbarWidget } from './packages/electron-taskbar-widget/src/index.js';

const widget = createTaskbarWidget({
  htmlPath: path.join(__dirname, 'widget.html'),
  preload: path.join(__dirname, 'widget-preload.js'),
  fixedLengthCss: 400, // set to 0 or null to size dynamically from setContentWidth()
  initialHasContent: true,
  getOwnerWindow: () => mainWindow,
  onEmbedded: ({ state }) => {
    widget.send('widget:theme', { light: state.lightTaskbar, align: state.align });
  },
  onStateChange: (state) => {
    widget.send('widget:theme', { light: state.lightTaskbar, align: state.align });
  },
});

widget.enable();
app.on('before-quit', () => widget.dispose());
```

TypeScript declarations are in [types/index.d.ts](./types/index.d.ts).

## Known Limitations

- Third-party or heavily customized taskbars (ExplorerPatcher, StartAllBack, Windhawk, etc.) may alter window hierarchy or UIA trees and cause embedding or probing to fail.
- Vertical taskbars are supported on Windows 10 only (Windows 11 does not natively support vertical taskbars).
- Windows 11 gap probing spawns short-lived `powershell.exe` processes to query `UIAutomationClient`, throttled via window-fingerprint debouncing and minimum probe intervals.

## Testing & Contributing

```bash
npm test
```

Pure layout, probe parsing, and geometry tests run on Linux, macOS, and Windows without Electron or `koffi`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
