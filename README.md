# electron-taskbar-widget

在 Windows 10/11 任务栏空闲区域嵌入透明 Electron `BrowserWindow` 组件的引擎，基于 `koffi` FFI（零 C++ 编译）与 UI Automation，供 [音梦屿（Dreamisle）](https://github.com/Dreameisle-Dev/Dreamisle-electron) 及其他需要任务栏常驻组件的 Electron 应用使用。

中文 | [English](./README.en.md)

## 功能

- **零 C++ 原生编译**：通过 `koffi` 直接调用 `user32.dll` / `advapi32.dll`，无需 `node-gyp` 或按 Electron 版本重编原生模块；轮询路径复用固定 `Buffer`。
- **双系统任务栏策略**：
  - **Windows 11（build ≥ 22000）**：使用 `SetParent` + `WS_CHILD` 挂载到任务栏，通过 PowerShell UI Automation 探测任务栏按钮矩形并选择最宽空档（自动适配居中/左对齐任务栏），探测失败时回退到托盘通知区左侧。
  - **Windows 10（build < 22000）**：通过 `MoveWindow` 压缩经典任务列表（`MSTaskSwWClass`）腾出真实空位（支持底部/顶部横排与左/右侧竖排），以顶层 topmost `WS_POPUP` 呈现；停用、无内容、DPI 变化或退出时自动恢复任务列表宽度。
- **完整宿主生命周期（`createTaskbarWidget`）**：
  - 跨屏跟随主窗口所在显示器的任务栏（支持副屏 `Shell_SecondaryTrayWnd`）；
  - 按显示器物理边界检测前台全屏窗口并自动隐藏/恢复；
  - 监听 Explorer 重启、DPI/缩放变化、任务栏应用窗口指纹变化、系统浅色/深色主题与对齐方式切换，自动重测或重建窗口。
- **分层导出**：除高层宿主控制器外，底层 Win32 FFI、UIA 探测、纯几何布局与 Win10 压缩控制器均可按需单独引入。

## 运行环境

- Windows 10 / 11（x64，已在 Electron 40 + Node.js 22 + `koffi` 3 验证）；非 Windows 平台可安全导入并降级为空操作。
- 宿主应用需提供运行时依赖：`electron` 与 `koffi`。
- 若使用 `electron-builder` 打包，须在 `asarUnpack` 中解包 `koffi`：
  ```json
  "asarUnpack": [
    "node_modules/koffi/**/*",
    "node_modules/@koromix/koffi-win32-*/**/*"
  ]
  ```

## 引入方式

本项目暂未发布到 npm，可通过 Git Submodule 或直接克隆源码使用：

```bash
git submodule add https://github.com/Dreameisle-Dev/electron-taskbar-widget.git packages/electron-taskbar-widget
```

```js
import path from 'node:path';
import { createTaskbarWidget } from './packages/electron-taskbar-widget/src/index.js';

const widget = createTaskbarWidget({
  htmlPath: path.join(__dirname, 'widget.html'),
  preload: path.join(__dirname, 'widget-preload.js'),
  fixedLengthCss: 400, // 设为 0 或 null 可按内容测量宽度动态伸缩
  initialHasContent: true,
  getOwnerWindow: () => mainWindow, // 可选：跟随主窗口所在显示器
  onEmbedded: ({ state }) => {
    widget.send('widget:theme', { light: state.lightTaskbar, align: state.align });
  },
  onStateChange: (state) => {
    widget.send('widget:theme', { light: state.lightTaskbar, align: state.align });
  },
  onEnableFailed: (error) => {
    console.warn('Taskbar widget failed to enable:', error.message);
  },
});

widget.enable();

// 退出前务必清理，确保恢复 Windows 10 任务列表宽度
app.on('before-quit', () => widget.dispose());
```

## 模块与 API

| 子入口 | 说明 |
| --- | --- |
| `src/index.js` | 统一导出 `createTaskbarWidget` 及以下全部底层模块。 |
| `src/host.js` | 高层 Electron 宿主 `createTaskbarWidget(options)`：返回 `{ enable, disable, dispose, isEnabled, isRunning, isVisible, getWindow, getState, setHasContent, setContentWidth, send, refresh }`。 |
| `src/layout.js` | 纯几何函数（零 Electron / 原生依赖）：`sideFor`、`shouldShow`、`shouldCoalesceProbe`、`selectGap`、`clampWindowWidth`、`computeLegacyTaskbarLayout`、`computeLegacyVerticalTaskbarLayout`。 |
| `src/gap-probe.js` | PowerShell UIA 探测：`probeTaskbar`、`buildProbeScript`、`encodePowerShellCommand`、`parseProbeOutput`。 |
| `src/legacy-layout.js` | Windows 10 任务列表压缩状态机：`createLegacyLayoutController`、`isLegacyWindows`。 |
| `src/win32.js` | `koffi` Win32 绑定：`findTaskbar`、`listTaskbars`、`getTaskbarMetrics`、`embedWindow`、`setWindowBounds`、`moveWindow`、`assertTopChild`、`isFullscreenForeground`、`readSystemUsesLightTheme`、`readTaskbarAlignment` 等。 |

完整 TypeScript 类型声明见 [types/index.d.ts](./types/index.d.ts)。

## 已知限制

- 使用第三方任务栏工具（如 ExplorerPatcher、StartAllBack、Windhawk 等高度定制任务栏）时，窗口层级或 UIA 树可能与原生任务栏不同，导致嵌入或探测失败。
- Windows 11 原生不支持侧边竖排任务栏，竖排布局仅在 Windows 10 分支启用。
- Windows 11 空档探测通过短生命周期 `powershell.exe` 调用 `UIAutomationClient` 完成，已通过窗口指纹防抖与最小间隔节流降低调用频率。

## 测试与贡献

```bash
npm test
```

纯逻辑与输出解析测试可在 Linux / macOS / Windows 上直接运行（无需 Electron 或 `koffi`）。提交兼容性问题或 PR 请参考 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[MIT](./LICENSE)
