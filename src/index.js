/**
 * electron-taskbar-widget 公开入口。
 *
 * 导出高层 Electron 宿主工厂 `createTaskbarWidget`，以及底层布局计算、PowerShell UIA 探测、
 * Windows 10 任务列表压缩控制器和 Win32 FFI 工具函数。
 */

export { createTaskbarWidget } from './host.js';
export { createLegacyLayoutController, isLegacyWindows } from './legacy-layout.js';
export {
  buildProbeScript,
  encodePowerShellCommand,
  parseProbeOutput,
  probeTaskbar,
} from './gap-probe.js';
export {
  MIN_TEXT_CSS,
  WINDOW_PADDING_CSS,
  MIN_WINDOW_CSS,
  DOCK_MARGIN_CSS,
  MIN_GAP_CSS,
  FIXED_STRIP_CSS,
  sideFor,
  shouldShow,
  shouldCoalesceProbe,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  selectGap,
  clampWindowWidth,
} from './layout.js';
export * from './win32.js';
