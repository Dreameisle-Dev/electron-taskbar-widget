/**
 * Windows 任务栏嵌入所需的 Win32 原生绑定层（基于 `koffi` FFI，零 C++ 编译）。
 *
 * 职责与约束：
 * 1. 仅在 `win32` 平台延迟加载 `user32.dll` 与 `advapi32.dll`；非 Windows 平台或缺少 `koffi` 时
 *    安全降级返回 `null`/`false`，不抛出未捕获异常。
 * 2. 所有轮询高频调用均复用固定 `Buffer`（注册表值、显示器信息、窗口类名），
 *    避免原生堆持续分配与泄漏。
 * 3. 按系统版本自动区分嵌入策略：
 *    - Windows 11（build >= 22000）：`SetParent` + `WS_CHILD` 挂载到任务栏并以 `GA_PARENT` 校验；
 *    - Windows 10（build < 22000）：保持顶层 `WS_POPUP` + `WS_EX_LAYERED | TOOLWINDOW | NOACTIVATE`，
 *      以任务栏作为 owner（`GWLP_HWNDPARENT`），规避经典任务栏重绘覆盖子窗口的问题。
 */

import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x40000;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;
const SWP_FRAMECHANGED = 0x20;
const HWND_TOP = 0;
const HWND_TOPMOST = -1;
const GW_HWNDPREV = 3;
const GW_OWNER = 4;
const GA_PARENT = 1;
const GWLP_HWNDPARENT = -8;
const MONITOR_DEFAULTTONEAREST = 2;
/** `MONITORINFO` 字节长度：`DWORD cbSize` + `RECT rcMonitor` + `RECT rcWork` + `DWORD dwFlags`。 */
const MONITORINFO_SIZE = 40;
const RRF_RT_REG_DWORD = 0x10;
const HKEY_CURRENT_USER = 0x80000001n;
const FINGERPRINT_MULTIPLIER = 0x9e3779b97f4a7c15n;
const MASK_64 = 0xffffffffffffffffn;
const VK_RCONTROL = 0xa3;
const VK_RMENU = 0xa5;

/** 桌面与任务栏自身窗口类名，全屏检测时必须忽略，避免将桌面误判为全屏应用。 */
const IGNORED_FOREGROUND_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]);

let initialized = false;
let available = false;
let koffi = null;
let user32 = null;
let advapi32 = null;
let initError = null;

// 复用固定 Buffer，避免 1s/2s 轮询中的临时缓冲区反复分配。
const REG_DATA_BUF = Buffer.allocUnsafe(4);
const REG_SIZE_BUF = Buffer.allocUnsafe(4);
const MONITORINFO_BUF = Buffer.alloc(MONITORINFO_SIZE);
const CLASS_NAME_BUF = Buffer.alloc(512);

/** 绑定可选 Win32 符号：在老版本 Windows 缺失时返回 `null`，不阻塞核心嵌入链路。 */
function bindOptional(lib, prototype) {
  try {
    return lib.func(prototype);
  } catch {
    return null;
  }
}

function ensureNative() {
  if (initialized) return available;
  initialized = true;
  if (process.platform !== 'win32') return false;

  try {
    koffi = require('koffi');
    const user32Lib = koffi.load('user32.dll');

    koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    koffi.struct('POINT', {
      x: 'long',
      y: 'long',
    });

    koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)');

    user32 = {
      FindWindowW: user32Lib.func(
        'void * __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)'
      ),
      FindWindowExW: user32Lib.func(
        'void * __stdcall FindWindowExW(void *hWndParent, void *hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'
      ),
      GetWindowRect: user32Lib.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ RECT *lpRect)'),
      GetClientRect: user32Lib.func('bool __stdcall GetClientRect(void *hWnd, _Out_ RECT *lpRect)'),
      ClientToScreen: user32Lib.func(
        'bool __stdcall ClientToScreen(void *hWnd, _Inout_ POINT *lpPoint)'
      ),
      GetDpiForWindow: bindOptional(user32Lib, 'uint __stdcall GetDpiForWindow(void *hWnd)'),
      SetParent: user32Lib.func('void * __stdcall SetParent(void *hWndChild, void *hWndNewParent)'),
      GetParent: user32Lib.func('void * __stdcall GetParent(void *hWnd)'),
      GetAncestor: user32Lib.func('void * __stdcall GetAncestor(void *hwnd, uint gaFlags)'),
      GetWindowLongW: user32Lib.func('long __stdcall GetWindowLongW(void *hWnd, int nIndex)'),
      SetWindowLongW: user32Lib.func(
        'long __stdcall SetWindowLongW(void *hWnd, int nIndex, long dwNewLong)'
      ),
      // 64 位进程中 `GWLP_HWNDPARENT` 为指针宽度，应优先使用 `SetWindowLongPtrW`。
      SetWindowLongPtrW: bindOptional(
        user32Lib,
        'intptr_t __stdcall SetWindowLongPtrW(void *hWnd, int nIndex, intptr_t dwNewLong)'
      ),
      SetWindowPos: user32Lib.func(
        'bool __stdcall SetWindowPos(void *hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'
      ),
      ShowWindow: user32Lib.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
      IsWindow: user32Lib.func('bool __stdcall IsWindow(void *hWnd)'),
      IsWindowVisible: user32Lib.func('bool __stdcall IsWindowVisible(void *hWnd)'),
      GetForegroundWindow: user32Lib.func('void * __stdcall GetForegroundWindow()'),
      MonitorFromWindow: bindOptional(
        user32Lib,
        'void * __stdcall MonitorFromWindow(void *hWnd, uint dwFlags)'
      ),
      GetMonitorInfoW: bindOptional(
        user32Lib,
        'bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ uint8_t *lpmi)'
      ),
      GetAsyncKeyState: bindOptional(user32Lib, 'short __stdcall GetAsyncKeyState(int vKey)'),
      GetWindow: user32Lib.func('void * __stdcall GetWindow(void *hWnd, uint uCmd)'),
      EnumWindows: bindOptional(
        user32Lib,
        'bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)'
      ),
      MoveWindow: bindOptional(
        user32Lib,
        'bool __stdcall MoveWindow(void *hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)'
      ),
      GetClassNameW: user32Lib.func(
        'int __stdcall GetClassNameW(void *hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)'
      ),
    };

    // `advapi32.dll` 仅用于读取系统主题和任务栏对齐两个可选注册表项，加载失败时降级为空。
    try {
      const advapi32Lib = koffi.load('advapi32.dll');
      advapi32 = {
        RegGetValueW: bindOptional(
          advapi32Lib,
          'int __stdcall RegGetValueW(intptr_t hkey, const char16_t *lpSubKey, const char16_t *lpValue, uint dwFlags, uint *pdwType, _Out_ uint8_t *pvData, _Inout_ uint8_t *pcbData)'
        ),
      };
    } catch {
      advapi32 = null;
    }

    available = true;
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
    available = false;
  }

  return available;
}

function asHwnd(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value === 0n ? null : value;
  if (typeof value === 'number') return value === 0 ? null : BigInt(value);
  try {
    const hwnd = BigInt(value);
    return hwnd === 0n ? null : hwnd;
  } catch {
    return null;
  }
}

function readRegDword(subKey, valueName) {
  if (!ensureNative() || !advapi32?.RegGetValueW) return null;
  try {
    REG_DATA_BUF.writeUInt32LE(0, 0);
    REG_SIZE_BUF.writeUInt32LE(4, 0);
    const status = advapi32.RegGetValueW(
      HKEY_CURRENT_USER,
      subKey,
      valueName,
      RRF_RT_REG_DWORD,
      null,
      REG_DATA_BUF,
      REG_SIZE_BUF
    );
    if (status !== 0) return null;
    return REG_DATA_BUF.readUInt32LE(0);
  } catch {
    return null;
  }
}

/** 从 Electron `BrowserWindow` 实例读取底层 Win32 HWND（`BigInt`）。 */
export function getNativeHwnd(win) {
  if (process.platform !== 'win32') return null;
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  } catch {
    return null;
  }
}

/** 查找主显示器任务栏窗口 `Shell_TrayWnd`。 */
export function findTaskbar() {
  if (!ensureNative()) return null;
  try {
    return asHwnd(user32.FindWindowW('Shell_TrayWnd', null));
  } catch {
    return null;
  }
}

/** 查找任务栏托盘通知区域 `TrayNotifyWnd`。 */
export function findTrayNotify(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;
  try {
    return asHwnd(user32.FindWindowExW(tray, null, 'TrayNotifyWnd', null));
  } catch {
    return null;
  }
}

/**
 * 查找 Windows 10 经典任务栏内容容器（`ReBarWindow32`，极少数情况为 `WorkerW`）。
 * Windows 11 的 XAML 任务栏不包含此类经典子窗口。
 */
export function findTaskbarContainer(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;
  try {
    return (
      asHwnd(user32.FindWindowExW(tray, null, 'ReBarWindow32', null)) ??
      asHwnd(user32.FindWindowExW(tray, null, 'WorkerW', null))
    );
  } catch {
    return null;
  }
}

/** 查找 Windows 10 任务列表窗口（`MSTaskSwWClass` 或 `MSTaskListWClass`）。 */
export function findTaskList(containerHwnd) {
  if (!ensureNative()) return null;
  const container = asHwnd(containerHwnd);
  if (!container) return null;
  try {
    return (
      asHwnd(user32.FindWindowExW(container, null, 'MSTaskSwWClass', null)) ??
      asHwnd(user32.FindWindowExW(container, null, 'MSTaskListWClass', null))
    );
  } catch {
    return null;
  }
}

/** 列出主任务栏（`Shell_TrayWnd`）及所有副屏任务栏（`Shell_SecondaryTrayWnd`）。 */
export function listTaskbars() {
  if (!ensureNative()) return [];
  const taskbars = [];
  try {
    const primary = asHwnd(user32.FindWindowW('Shell_TrayWnd', null));
    if (primary) taskbars.push(primary);

    let after = null;
    while (true) {
      const next = asHwnd(user32.FindWindowExW(null, after, 'Shell_SecondaryTrayWnd', null));
      if (!next) break;
      if (next !== primary) taskbars.push(next);
      after = next;
    }
  } catch {
    // 枚举中断时保留已收集的句柄
  }
  return taskbars;
}

/** 获取窗口所在显示器的 `HMONITOR` 句柄。 */
export function getWindowMonitor(hwnd) {
  if (!ensureNative() || !user32.MonitorFromWindow) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST));
  } catch {
    return null;
  }
}

/**
 * 获取窗口所在显示器的物理像素矩形（`rcMonitor`）。
 * 多屏负坐标或异构 DPI 下，全屏检测必须以目标显示器矩形为准。
 */
export function getMonitorRect(hwnd) {
  if (!ensureNative() || !user32.GetMonitorInfoW) return null;
  const monitor = getWindowMonitor(hwnd);
  if (!monitor) return null;

  try {
    // 直接按 `MONITORINFO` 内存布局解码，避免 FFI 嵌套输出结构回写差异：
    // cbSize@0, rcMonitor(left/top/right/bottom)@4/8/12/16, rcWork@20, dwFlags@36。
    MONITORINFO_BUF.fill(0);
    MONITORINFO_BUF.writeUInt32LE(MONITORINFO_SIZE, 0);
    if (!user32.GetMonitorInfoW(monitor, MONITORINFO_BUF)) return null;
    return {
      left: MONITORINFO_BUF.readInt32LE(4),
      top: MONITORINFO_BUF.readInt32LE(8),
      right: MONITORINFO_BUF.readInt32LE(12),
      bottom: MONITORINFO_BUF.readInt32LE(16),
    };
  } catch {
    return null;
  }
}

/**
 * 读取任务栏（或任意子容器）的物理坐标、客户区尺寸、横竖排方向与 DPI 缩放比。
 */
export function getTaskbarMetrics(trayHwnd) {
  if (!ensureNative()) return null;
  const tray = asHwnd(trayHwnd);
  if (!tray) return null;

  try {
    const windowRect = {};
    if (!user32.GetWindowRect(tray, windowRect)) return null;

    const clientRect = {};
    if (!user32.GetClientRect(tray, clientRect)) return null;

    const origin = { x: 0, y: 0 };
    if (!user32.ClientToScreen(tray, origin)) return null;

    let dpi = 96;
    try {
      if (user32.GetDpiForWindow) dpi = Number(user32.GetDpiForWindow(tray)) || 96;
    } catch {
      dpi = 96;
    }
    const clientWidth = clientRect.right - clientRect.left;
    const clientHeight = clientRect.bottom - clientRect.top;
    if (clientWidth <= 0 || clientHeight <= 0) return null;

    return {
      screenLeft: origin.x,
      screenTop: origin.y,
      clientWidth,
      clientHeight,
      vertical: clientHeight > clientWidth,
      dpiScale: dpi / 96,
      windowRect: {
        left: windowRect.left,
        top: windowRect.top,
        right: windowRect.right,
        bottom: windowRect.bottom,
      },
    };
  } catch {
    return null;
  }
}

export function getWindowRect(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;

  try {
    const rect = {};
    if (!user32.GetWindowRect(h, rect)) return null;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
  } catch {
    return null;
  }
}

export function getForegroundWindow() {
  if (!ensureNative()) return null;
  try {
    return asHwnd(user32.GetForegroundWindow());
  } catch {
    return null;
  }
}

export function getClassName(hwnd) {
  if (!ensureNative()) return '';
  const h = asHwnd(hwnd);
  if (!h) return '';

  try {
    const length = user32.GetClassNameW(h, CLASS_NAME_BUF, CLASS_NAME_BUF.length / 2);
    if (!length || length <= 0) return '';
    return CLASS_NAME_BUF.subarray(0, length * 2).toString('utf16le');
  } catch {
    return '';
  }
}

export function isWindowVisible(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;
  try {
    return Boolean(user32.IsWindowVisible(h));
  } catch {
    return false;
  }
}

/** 直接向 HWND 发送 `SW_HIDE`，作为 Electron `win.hide()` 在子窗口状态不同步时的兜底。 */
export function hideWindow(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;
  try {
    user32.ShowWindow(h, 0);
    return true;
  } catch {
    return false;
  }
}

export function getWindowParent(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.GetParent(h));
  } catch {
    return null;
  }
}

/**
 * 通过 `GetAncestor(GA_PARENT)` 读取真实父窗口句柄。
 * 与 `GetParent` 不同，它不会对 `WS_POPUP` 窗口返回 owner，适合校验 `SetParent` 是否生效。
 */
export function getWindowAncestor(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;
  try {
    return asHwnd(user32.GetAncestor(h, GA_PARENT));
  } catch {
    return null;
  }
}

/**
 * 将 Electron 窗口附着到指定任务栏窗口，并按系统版本配置窗口样式：
 * - Windows 11：`SetParent(h, tray)` + `WS_CHILD` + `WS_EX_NOACTIVATE`（移除 `WS_EX_TOOLWINDOW`），
 *   以 `GetAncestor(GA_PARENT) === tray` 校验是否被系统拒绝；
 * - Windows 10：不调用 `SetParent`（避免被 topmost 任务栏重绘遮挡），将任务栏设为 owner，
 *   配置 `WS_POPUP`（去边框位）与 `WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`，
 *   由调用方在显示后配合 `win.setAlwaysOnTop(true)` 保持顶层可见。
 */
export function embedWindow(hwnd, trayHwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  const tray = asHwnd(trayHwnd);
  if (!h || !tray) return false;

  try {
    if (isLegacyBuild()) {
      const owner = Number(tray);
      try {
        if (user32.SetWindowLongPtrW) {
          user32.SetWindowLongPtrW(h, GWLP_HWNDPARENT, owner);
        } else if (user32.SetWindowLongW) {
          user32.SetWindowLongW(h, GWLP_HWNDPARENT, owner);
        }
      } catch {
        // owner 设置失败不影响顶层 overlay 定位显示
      }
    } else {
      user32.SetParent(h, tray);
    }

    let style = user32.GetWindowLongW(h, GWL_STYLE);
    const frameBits = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    if (isLegacyBuild()) {
      style = (style & ~WS_CHILD) | WS_POPUP;
      style &= ~frameBits;
    } else {
      style = (style & ~WS_POPUP) | WS_CHILD;
    }
    user32.SetWindowLongW(h, GWL_STYLE, style);

    let exStyle = user32.GetWindowLongW(h, GWL_EXSTYLE);
    if (isLegacyBuild()) {
      exStyle |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    } else {
      exStyle = (exStyle & ~WS_EX_TOOLWINDOW) | WS_EX_NOACTIVATE;
    }
    user32.SetWindowLongW(h, GWL_EXSTYLE, exStyle);

    // 刷新窗口样式缓存，确保后续定位与内容区尺寸计算按无框样式生效。
    user32.SetWindowPos(
      h,
      HWND_TOP,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
    );

    if (isLegacyBuild()) {
      return Boolean(user32.IsWindow(h));
    }
    return asHwnd(user32.GetAncestor(h, GA_PARENT)) === tray;
  } catch {
    return false;
  }
}

/** 读取窗口当前原生样式位快照，供日志诊断与 topmost 状态检查使用。 */
export function getWindowStyleInfo(hwnd) {
  if (!ensureNative()) return null;
  const h = asHwnd(hwnd);
  if (!h) return null;

  try {
    const style = Number(user32.GetWindowLongW(h, GWL_STYLE)) >>> 0;
    const exStyle = Number(user32.GetWindowLongW(h, GWL_EXSTYLE)) >>> 0;
    return {
      style: `0x${style.toString(16)}`,
      exStyle: `0x${exStyle.toString(16)}`,
      popup: (style & WS_POPUP) !== 0,
      child: (style & WS_CHILD) !== 0,
      layered: (exStyle & WS_EX_LAYERED) !== 0,
      topmost: (exStyle & WS_EX_TOPMOST) !== 0,
      toolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0,
      noActivate: (exStyle & WS_EX_NOACTIVATE) !== 0,
    };
  } catch {
    return null;
  }
}

/**
 * 通过 `SetWindowPos` 更新窗口物理坐标（及可选尺寸），不改变 z-order 也不抢占焦点。
 * 省略 `width`/`height` 时仅移动位置（`SWP_NOSIZE`），避免触发多余尺寸重排。
 * 子窗口使用父客户区坐标，顶层 overlay 使用屏幕坐标。
 */
export function setWindowBounds(hwnd, { x, y, width = null, height = null }) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    const resize = Number.isFinite(width) && Number.isFinite(height);
    const flags = (resize ? 0 : SWP_NOSIZE) | SWP_NOZORDER | SWP_NOACTIVATE;
    return Boolean(
      user32.SetWindowPos(h, HWND_TOP, x, y, resize ? width : 0, resize ? height : 0, flags)
    );
  } catch {
    return false;
  }
}

/** 调用 `MoveWindow` 移动并重绘子窗口（父客户区坐标），用于 Windows 10 压缩/恢复任务列表。 */
export function moveWindow(hwnd, { x, y, width, height }) {
  if (!ensureNative() || !user32.MoveWindow) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(user32.MoveWindow(h, x, y, width, height, true));
  } catch {
    return false;
  }
}

/** 将 `WS_CHILD` 窗口提升至同级子窗口顶端（不移动、不改尺寸、不激活）。 */
export function assertTopChild(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(
      user32.SetWindowPos(h, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    );
  } catch {
    return false;
  }
}

/**
 * 将 Windows 10 顶层 `WS_POPUP` 窗口重新提到 `HWND_TOPMOST` 栈顶（不移动、不改尺寸、不激活）。
 * 当点击任务栏或压缩任务列表导致 `Shell_TrayWnd` 升至歌词窗上方时用于无闪烁恢复置顶。
 */
export function assertTopmost(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(
      user32.SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    );
  } catch {
    return false;
  }
}

/**
 * 判断顶层窗口 `hwnd` 在 Win32 Z 序中是否严格位于 `referenceHwnd` 之上。
 * 从 `referenceHwnd` 沿 `GW_HWNDPREV` 向上遍历（最多 512 步），避免无谓重复置顶导致闪烁。
 */
export function isWindowAbove(hwnd, referenceHwnd) {
  if (!ensureNative()) return false;
  const target = asHwnd(hwnd);
  const ref = asHwnd(referenceHwnd);
  if (!target || !ref || target === ref) return false;

  try {
    let current = asHwnd(user32.GetWindow(ref, GW_HWNDPREV));
    let steps = 0;
    while (current && steps < 512) {
      if (current === target) return true;
      current = asHwnd(user32.GetWindow(current, GW_HWNDPREV));
      steps += 1;
    }
    return false;
  } catch {
    return false;
  }
}

export function isWindow(hwnd) {
  if (!ensureNative()) return false;
  const h = asHwnd(hwnd);
  if (!h) return false;

  try {
    return Boolean(user32.IsWindow(h));
  } catch {
    return false;
  }
}

/**
 * 计算当前会在任务栏显示按钮的可见顶层应用窗口集合指纹（64 位累加哈希 + 计数）。
 * 当应用窗口增删导致指纹变化时，上层可触发防抖后的 UIA 空档重测。
 */
export function getTaskbarWindowsFingerprint() {
  if (!ensureNative() || !user32.EnumWindows) return null;

  try {
    let sum = 0n;
    let count = 0;

    user32.EnumWindows((hwnd) => {
      try {
        const h = asHwnd(hwnd);
        if (!h) return true;
        if (!user32.IsWindowVisible(h)) return true;

        const exStyle = user32.GetWindowLongW(h, GWL_EXSTYLE) >>> 0;
        if (exStyle & WS_EX_TOOLWINDOW) return true;

        const owner = asHwnd(user32.GetWindow(h, GW_OWNER));
        if (owner !== null && !(exStyle & WS_EX_APPWINDOW)) return true;

        sum = (sum + h * FINGERPRINT_MULTIPLIER) & MASK_64;
        count += 1;
        return true;
      } catch {
        return true;
      }
    }, 0);

    return `${sum.toString(16)}:${count}`;
  } catch {
    return null;
  }
}

/** 纯几何判断：矩形 `rect` 是否完整覆盖目标显示器范围 `bounds`（物理像素）。 */
export function isFullscreenRect(rect, bounds) {
  if (!rect || !bounds) return false;
  return (
    rect.left <= bounds.x &&
    rect.top <= bounds.y &&
    rect.right >= bounds.x + bounds.width &&
    rect.bottom >= bounds.y + bounds.height
  );
}

/** 判断当前前台窗口是否在指定显示器物理范围 `bounds` 上处于全屏状态。 */
export function isFullscreenForeground({ trayHwnd, ownHwnd, bounds } = {}) {
  if (!ensureNative()) return false;

  try {
    const foreground = getForegroundWindow();
    if (!foreground) return false;
    if (foreground === asHwnd(ownHwnd) || foreground === asHwnd(trayHwnd)) return false;
    if (IGNORED_FOREGROUND_CLASSES.has(getClassName(foreground))) return false;
    if (!bounds) return false;

    const rect = getWindowRect(foreground);
    return rect ? isFullscreenRect(rect, bounds) : false;
  } catch {
    return false;
  }
}

/** 读取注册表 `SystemUsesLightTheme`，返回任务栏是否为浅色主题（不可读时返回 `null`）。 */
export function readSystemUsesLightTheme() {
  const value = readRegDword(
    'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    'SystemUsesLightTheme'
  );
  return value === null ? null : value === 1;
}

/** 读取注册表 `TaskbarAl`（Windows 11 任务栏对齐：`0` = 左对齐，`1` = 居中；不可读返回 `null`）。 */
export function readTaskbarAlignment() {
  return readRegDword(
    'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced',
    'TaskbarAl'
  );
}

/** 返回当前 Windows 系统构建号（如 `19045`、`22631`、`26100`）；非 Windows 返回 `0`。 */
export function getOsBuild() {
  if (process.platform !== 'win32') return 0;
  return Number(os.release().split('.')[2] || 0);
}

/** 是否为 Windows 10 及更早的经典任务栏构建（`0 < build < 22000`）。 */
export function isLegacyBuild() {
  const build = getOsBuild();
  return build > 0 && build < 22000;
}

/** 返回原生绑定初始化失败时的错误信息（正常时为 `null`）。 */
export function getNativeInitError() {
  ensureNative();
  return initError;
}

/**
 * 检测右侧 Ctrl 或右侧 Alt 是否按下。
 * 可用于在 Electron `globalShortcut` 回调中区分左侧 Ctrl+Alt 与国际键盘布局的 AltGr。
 */
export function isRightAltOrCtrlDown() {
  if (!ensureNative() || !user32.GetAsyncKeyState) return false;
  try {
    const rightCtrl = user32.GetAsyncKeyState(VK_RCONTROL);
    const rightAlt = user32.GetAsyncKeyState(VK_RMENU);
    return (rightCtrl & 0x8000) !== 0 || (rightAlt & 0x8000) !== 0;
  } catch {
    return false;
  }
}
