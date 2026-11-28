/**
 * Electron Windows 10/11 任务栏组件宿主控制器。
 *
 * 负责透明无框 `BrowserWindow` 的完整生命周期与任务栏协同：
 * - 按主窗口所在显示器解析目标任务栏（支持 Windows 11 副屏 `Shell_SecondaryTrayWnd`）；
 * - 初始窗口按显示器尺寸创建，规避 Chromium 透明合成 surface 在 `SetParent` 后「只缩不涨」的限制；
 * - Windows 11 采用 UIA 空档探测 + 托盘左侧兜底 + `WS_CHILD` 周期置顶；
 * - Windows 10 采用经典任务列表压缩 + 顶层 topmost `WS_POPUP` overlay，停用或无内容时恢复任务列表；
 * - 内置巡检：Explorer 重启自恢复、跨屏跟随、DPI/高度变化防抖重建、按显示器前台全屏自动隐藏、
 *   系统浅色主题与任务栏对齐变更响应、应用窗口指纹防抖重测。
 */

import { createRequire } from 'node:module';
import {
  assertTopChild,
  assertTopmost,
  embedWindow,
  findTaskbar,
  findTrayNotify,
  getMonitorRect,
  getNativeHwnd,
  getNativeInitError,
  getOsBuild,
  getTaskbarMetrics,
  getTaskbarWindowsFingerprint,
  getWindowAncestor,
  getWindowMonitor,
  getWindowParent,
  getWindowRect,
  getWindowStyleInfo,
  hideWindow,
  isFullscreenForeground,
  isWindow,
  isWindowAbove,
  isWindowVisible,
  listTaskbars,
  readSystemUsesLightTheme,
  readTaskbarAlignment,
  setWindowBounds,
} from './win32.js';
import {
  clampWindowWidth,
  DOCK_MARGIN_CSS,
  FIXED_STRIP_CSS,
  selectGap,
  shouldCoalesceProbe,
  shouldShow,
  sideFor,
  WINDOW_PADDING_CSS,
} from './layout.js';
import { createLegacyLayoutController, isLegacyWindows } from './legacy-layout.js';
import { probeTaskbar } from './gap-probe.js';

const require = createRequire(import.meta.url);

const DEFAULT_FALLBACK_MARGIN_CSS = 12;
const DEFAULT_RECREATE_DELAY_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_FULLSCREEN_INTERVAL_MS = 1000;
const DEFAULT_PROBE_HEARTBEAT_MS = 60000;
const DEFAULT_PROBE_DEBOUNCE_MS = 500;
const DEFAULT_MIN_PROBE_INTERVAL_MS = 5000;
const DEFAULT_METRICS_RECREATE_DELAY_MS = 1200;

function resolveElectron(injected) {
  if (injected) return injected;
  try {
    return require('electron');
  } catch {
    return null;
  }
}

/**
 * 创建一个挂接到 Windows 10/11 任务栏的 Electron 组件宿主实例。
 *
 * @param {object} options
 * @param {string} [options.htmlPath] 渲染页面本地 HTML 路径（与 `load` 二选一）
 * @param {(win: import('electron').BrowserWindow) => void} [options.load] 自定义加载函数
 * @param {string} [options.preload] Preload 脚本绝对路径
 * @param {object} [options.webPreferences] 额外 `webPreferences` 覆盖项
 * @param {boolean} [options.ignoreMouseEvents=true] 是否开启鼠标穿透
 * @param {number | null} [options.fixedLengthCss=400] 固定组件长度（CSS px）；设为 `0` 或 `null` 按内容宽度动态收缩
 * @param {number} [options.initialWidthCss=300] 初始内容宽度估值（CSS px）
 * @param {number} [options.fallbackMarginCss=12] UIA 失败时贴靠托盘左侧的间距（CSS px）
 * @param {boolean} [options.initialHasContent=false] 初始是否有可展示内容
 * @param {() => import('electron').BrowserWindow | null} [options.getOwnerWindow] 可选主窗口获取函数，用于跨屏跟随
 * @param {(webContents: import('electron').WebContents, htmlPath: string | null) => void} [options.hardenWindow] 可选窗口安全加固钩子
 * @param {(message: string, details?: object | null) => void} [options.logger] 可选诊断日志回调
 * @param {(ctx: { win: import('electron').BrowserWindow, state: object }) => void} [options.onEmbedded] 嵌入成功回调
 * @param {(state: object) => void} [options.onStateChange] 主题/方向/对齐状态变化回调
 * @param {(error: Error, ctx: { notifyUser: boolean }) => void} [options.onEnableFailed] 首次启用失败回调
 * @param {{ BrowserWindow: typeof import('electron').BrowserWindow, screen: typeof import('electron').screen }} [options.electron] 可选 Electron 模块注入（便于测试）
 */
export function createTaskbarWidget(options = {}) {
  const {
    htmlPath = null,
    load = null,
    preload = undefined,
    webPreferences = {},
    ignoreMouseEvents = true,
    fixedLengthCss = FIXED_STRIP_CSS,
    initialWidthCss = 300,
    fallbackMarginCss = DEFAULT_FALLBACK_MARGIN_CSS,
    recreateDelayMs = DEFAULT_RECREATE_DELAY_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    fullscreenIntervalMs = DEFAULT_FULLSCREEN_INTERVAL_MS,
    probeHeartbeatMs = DEFAULT_PROBE_HEARTBEAT_MS,
    probeDebounceMs = DEFAULT_PROBE_DEBOUNCE_MS,
    minProbeIntervalMs = DEFAULT_MIN_PROBE_INTERVAL_MS,
    metricsRecreateDelayMs = DEFAULT_METRICS_RECREATE_DELAY_MS,
    initialHasContent = false,
    getOwnerWindow = null,
    hardenWindow = null,
    logger = null,
    onEmbedded = null,
    onStateChange = null,
    onEnableFailed = null,
    electron: injectedElectron = null,
  } = options;

  const fixedStripCss =
    Number.isFinite(fixedLengthCss) && fixedLengthCss > 0 ? fixedLengthCss : 0;

  const log = (message, details = null) => {
    if (typeof logger === 'function') logger(message, details);
  };

  const legacyLayout = createLegacyLayoutController({
    logger: log,
    fixedStripCss,
  });

  // 运行时窗口与布局状态
  let win = null;
  let hwnd = null;
  let trayHwnd = null;
  let enabled = false;
  let visible = false;
  let fullscreen = false;
  let hasContent = Boolean(initialHasContent);
  let widthCss = Math.max(1, Number(initialWidthCss) || 300);
  let currentGap = null;
  let fallbackMetrics = null;
  let lastWindowKey = null;
  let lastContentSizeKey = null;
  let lightTaskbar = null;
  let verticalTaskbar = false;
  let fixedAlign = 'end';

  // 巡检与探测调度状态
  let pollTimer = null;
  let fullscreenTimer = null;
  let heartbeatTimer = null;
  let probeDebounceTimer = null;
  let probeInFlight = null;
  let probeInFlightKey = null;
  let probeRerunRequested = false;
  let lastProbeAt = 0;
  let lastFingerprint = null;
  let lastLightTheme = null;
  let lastAlignment = null;

  let recreateTimer = null;
  let metricsRecreateTimer = null;
  let lastTaskbarMetrics = null;

  function getElectronApi() {
    const api = resolveElectron(injectedElectron);
    if (!api?.BrowserWindow || !api?.screen) {
      throw new Error('Electron BrowserWindow/screen APIs are unavailable in this runtime');
    }
    return api;
  }

  function isWindowAlive(window) {
    return window !== null && !window.isDestroyed() && !window.webContents.isDestroyed();
  }

  function widgetWindowAlive() {
    return isWindowAlive(win) && hwnd !== null && isWindow(hwnd);
  }

  function defaultLightTaskbar() {
    return readSystemUsesLightTheme() ?? !isLegacyWindows();
  }

  function getState() {
    return {
      enabled,
      running: process.platform === 'win32' && enabled && isWindowAlive(win),
      visible,
      vertical: verticalTaskbar,
      align: fixedAlign,
      lightTaskbar: lightTaskbar ?? defaultLightTaskbar(),
      legacy: isLegacyWindows(),
      fullscreen,
    };
  }

  function notifyStateChange() {
    if (typeof onStateChange === 'function') onStateChange(getState());
  }

  function setLightTaskbar(value) {
    const next = value !== false;
    if (lightTaskbar === next) return;
    lightTaskbar = next;
    notifyStateChange();
  }

  function setAlign(next) {
    const value = next === 'start' ? 'start' : 'end';
    if (value === fixedAlign) return;
    fixedAlign = value;
    notifyStateChange();
  }

  function send(channel, payload) {
    if (!isWindowAlive(win)) return;
    win.webContents.send(channel, payload);
  }

  /**
   * 同步更新窗口内容区尺寸与原生位置：
   * 1. 先以 CSS 像素调用 `win.setContentSize` 保证 WebContents 视口尺寸正确；
   * 2. 读回实际原生矩形（吸收无框窗口可能存在的不可见边框）；
   * 3. 用 `SetWindowPos` 摆回目标坐标（Win10 顶层 overlay 用屏幕坐标，Win11 子窗口用父客户区坐标）。
   */
  function applyWindowBounds(base, dpi, force) {
    if (!isWindowAlive(win)) return false;
    const scale = Number.isFinite(dpi) && dpi > 0 ? dpi : 1;
    const contentWidth = Math.max(1, Math.round(base.width / scale));
    const contentHeight = Math.max(1, Math.round(base.height / scale));
    const legacy = isLegacyWindows();
    const taskbarMetrics = legacy && trayHwnd ? getTaskbarMetrics(trayHwnd) : null;
    const x = base.x + (taskbarMetrics ? taskbarMetrics.screenLeft : 0);
    const y = base.y + (taskbarMetrics ? taskbarMetrics.screenTop : 0);
    const sizeKey = `${scale}:${contentWidth}x${contentHeight}`;
    const key = `${sizeKey}@${x},${y}`;
    if (!force && key === lastWindowKey) return true;

    const needsResize = force || sizeKey !== lastContentSizeKey;
    if (!needsResize) {
      if (!setWindowBounds(hwnd, { x, y })) return false;
      lastWindowKey = key;
      return true;
    }

    let nativeRect = null;
    try {
      win.setContentSize(contentWidth, contentHeight);
      nativeRect = getWindowRect(hwnd);
    } catch {
      // setContentSize 失败时退回纯原生尺寸
    }

    const next = {
      x,
      y,
      width: nativeRect ? Math.max(1, nativeRect.right - nativeRect.left) : base.width,
      height: nativeRect ? Math.max(1, nativeRect.bottom - nativeRect.top) : base.height,
    };
    if (!setWindowBounds(hwnd, next)) return false;

    lastContentSizeKey = sizeKey;
    lastWindowKey = key;
    return true;
  }

  function metricsKey(metrics) {
    if (!metrics) return null;
    // 仅追踪会影响视口与 DPI 的高度和缩放比；任务栏水平宽度变化只需重定位，无需重建窗口。
    return `${metrics.clientHeight}@${metrics.dpiScale}`;
  }

  function scheduleMetricsRecreate() {
    if (!enabled || !trayHwnd || metricsRecreateTimer) return;
    metricsRecreateTimer = setTimeout(() => {
      metricsRecreateTimer = null;
      if (!enabled || !trayHwnd || !isWindow(trayHwnd)) return;

      const next = metricsKey(getTaskbarMetrics(trayHwnd));
      if (!next) return;
      if (!lastTaskbarMetrics) {
        lastTaskbarMetrics = next;
        return;
      }
      if (next === lastTaskbarMetrics) return;

      log('taskbar metrics changed; recreating the widget', {
        from: lastTaskbarMetrics,
        to: next,
      });
      lastTaskbarMetrics = next;
      recreateWindow();
    }, metricsRecreateDelayMs);
  }

  function primaryDisplayBounds() {
    const { screen } = getElectronApi();
    const display = screen.getPrimaryDisplay();
    // 宽高使用 floor，避免非整数缩放（如 150%）下 DIP 取整回乘多出 1px 导致全屏漏判。
    return {
      x: Math.round(display.bounds.x * display.scaleFactor),
      y: Math.round(display.bounds.y * display.scaleFactor),
      width: Math.floor(display.bounds.width * display.scaleFactor),
      height: Math.floor(display.bounds.height * display.scaleFactor),
    };
  }

  function ownerWindowHwnd() {
    if (typeof getOwnerWindow !== 'function') return null;
    const owner = getOwnerWindow();
    if (!owner || owner.isDestroyed()) return null;
    return getNativeHwnd(owner);
  }

  function resolveTargetTaskbar() {
    const ownerHwnd = ownerWindowHwnd();
    if (ownerHwnd) {
      const monitor = getWindowMonitor(ownerHwnd);
      if (monitor) {
        for (const taskbar of listTaskbars()) {
          if (getWindowMonitor(taskbar) === monitor) return taskbar;
        }
      }
    }
    return findTaskbar();
  }

  function targetMonitorBounds() {
    const rect = trayHwnd ? getMonitorRect(trayHwnd) : null;
    if (rect) {
      return {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      };
    }
    return primaryDisplayBounds();
  }

  function targetTaskbarChanged() {
    if (!enabled || !trayHwnd) return false;
    const next = resolveTargetTaskbar();
    if (!next || next === trayHwnd) return false;

    log('taskbar target changed; recreating the widget', {
      from: String(trayHwnd),
      to: String(next),
    });
    legacyLayout.reset();
    trayHwnd = next;
    recreateWindow();
    return true;
  }

  function refreshFullscreen() {
    if (!enabled) return;

    let next = false;
    try {
      next = isFullscreenForeground({ trayHwnd, ownHwnd: hwnd, bounds: targetMonitorBounds() });
    } catch (error) {
      log('fullscreen detection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (next === fullscreen) return;
    fullscreen = next;
    updateVisibility();

    if (!fullscreen && enabled && hasContent) probeAndApply();
  }

  function computeWantVisible() {
    return shouldShow({
      enabled,
      hasContent,
      fullscreen,
      hasGap: !!currentGap,
      hasFallback: !!fallbackMetrics,
      windowAlive: widgetWindowAlive(),
    });
  }

  function ensureLegacyTopmost(forceRaise = false) {
    if (!isLegacyWindows() || !isWindowAlive(win) || !hwnd) return;
    const needsTopmostFlag = getWindowStyleInfo(hwnd)?.topmost !== true;
    if (needsTopmostFlag) {
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
      } catch {
        try {
          win.setAlwaysOnTop(true);
        } catch {
          // 下一轮可见性同步会重试
        }
      }
    }
    // 即使 WS_EX_TOPMOST 仍为真，点击任务栏或压缩任务列表也可能让 Shell_TrayWnd 升到歌词窗上方；
    // 仅在确实掉到任务栏下方或刚移动任务列表时才提升，既防遮挡又避免周期性闪烁。
    const behindTaskbar = Boolean(trayHwnd && !isWindowAbove(hwnd, trayHwnd));
    if (forceRaise || needsTopmostFlag || behindTaskbar) {
      assertTopmost(hwnd);
    }
  }

  function effectiveDesiredWidthCss() {
    if (fixedStripCss > 0) return Math.max(1, fixedStripCss - 2 * WINDOW_PADDING_CSS);
    return widthCss;
  }

  function applyFallbackPosition(metrics, force) {
    const dpi = metrics.dpiScale || 1;
    const taskbarWidthCss = metrics.clientWidth / dpi;
    const desiredWidthCss = clampWindowWidth({
      contentWidthCss: effectiveDesiredWidthCss(),
      gapWidthCss: 99999,
    });
    const windowWidthCss = Math.min(desiredWidthCss, taskbarWidthCss - 2 * fallbackMarginCss);
    if (windowWidthCss <= 0) return false;
    const widthPx = Math.round(windowWidthCss * dpi);
    const notifyRect = getWindowRect(findTrayNotify(trayHwnd));
    const rawX = notifyRect
      ? notifyRect.left - metrics.screenLeft - widthPx - Math.round(fallbackMarginCss * dpi)
      : metrics.clientWidth - widthPx - Math.round(fallbackMarginCss * dpi);
    const x = Math.min(Math.max(0, rawX), Math.max(0, metrics.clientWidth - widthPx));
    return applyWindowBounds({ x, y: 0, width: widthPx, height: metrics.clientHeight }, dpi, force);
  }

  function applyPosition(force = false) {
    if (!hwnd || !trayHwnd) return false;

    if (currentGap?.legacy) {
      const dpi = getTaskbarMetrics(trayHwnd)?.dpiScale || 1;
      return applyWindowBounds(currentGap.bounds, dpi, force);
    }

    if (!currentGap) {
      if (fallbackMetrics) return applyFallbackPosition(fallbackMetrics, force);
      return false;
    }

    const { side, gap, dpi, height } = currentGap;
    const windowWidthCss = clampWindowWidth({
      contentWidthCss: effectiveDesiredWidthCss(),
      gapWidthCss: gap.right - gap.left,
    });
    if (windowWidthCss === 0) return false;

    const xPx = Math.round(
      (gap.left +
        (side === 'left'
          ? DOCK_MARGIN_CSS
          : gap.right - gap.left - DOCK_MARGIN_CSS - windowWidthCss)) *
        dpi
    );
    return applyWindowBounds(
      {
        x: xPx,
        y: 0,
        width: Math.round(windowWidthCss * dpi),
        height,
      },
      dpi,
      force
    );
  }

  function updateVisibility(forceRaiseLegacy = false) {
    if (!isWindowAlive(win)) {
      visible = false;
      return;
    }

    const nativeVisible = hwnd ? isWindowVisible(hwnd) : false;

    if (!computeWantVisible()) {
      if (win.isVisible() || nativeVisible) {
        try {
          win.hide();
        } catch {
          // 下面再用原生 ShowWindow(SW_HIDE) 兜底
        }
        if (nativeVisible) hideWindow(hwnd);
        log('taskbar widget hidden', { hwnd: String(hwnd) });
      }
      visible = false;
      return;
    }

    const wasShown = win.isVisible() || nativeVisible;
    if (!wasShown) {
      applyPosition(true);
      if (isLegacyWindows()) ensureLegacyTopmost(true);
      win.showInactive();
    }
    visible = true;
    applyPosition(!wasShown);
    if (isLegacyWindows()) {
      ensureLegacyTopmost(forceRaiseLegacy || !wasShown);
    } else {
      assertTopChild(hwnd);
    }
    if (!wasShown) {
      log('taskbar widget shown', {
        hwnd: String(hwnd),
        nativeVisible: hwnd ? isWindowVisible(hwnd) : false,
        rect: getWindowRect(hwnd),
        styles: getWindowStyleInfo(hwnd),
      });
    }
  }

  function applyLegacyGap() {
    if (!enabled || !hwnd || !trayHwnd) return null;

    if (!hasContent) {
      legacyLayout.restore();
      currentGap = null;
      fallbackMetrics = null;
      updateVisibility();
      return false;
    }

    if (fullscreen) {
      updateVisibility();
      return false;
    }

    const result = legacyLayout.apply({ trayHwnd, widthCss });
    if (result.ok) {
      setAlign('end');
      if (result.vertical !== verticalTaskbar) {
        verticalTaskbar = result.vertical;
        notifyStateChange();
      }
      currentGap = { side: 'right', legacy: true, bounds: result.bounds };
      fallbackMetrics = null;
      setLightTaskbar(defaultLightTaskbar());
      updateVisibility(result.taskListMoved);
      return true;
    }

    if (result.reason === 'retry') {
      return true;
    }

    if (result.reason === 'no-space' || result.reason === 'waiting') {
      currentGap = null;
      fallbackMetrics = null;
      updateVisibility();
      return false;
    }

    legacyLayout.restore();
    return null;
  }

  async function resolveGap() {
    const expectedHwnd = hwnd;
    const expectedTray = trayHwnd;

    if (isLegacyWindows() && legacyLayout.isUsable()) {
      const legacy = applyLegacyGap();
      if (legacy !== null) {
        if (!enabled || !hwnd || !trayHwnd || hwnd !== expectedHwnd || trayHwnd !== expectedTray) {
          return false;
        }
        return legacy;
      }
    }

    const probe = await probeTaskbar({ taskbarHwnd: trayHwnd });

    if (!enabled || !hwnd || !trayHwnd || hwnd !== expectedHwnd || trayHwnd !== expectedTray) {
      return false;
    }

    const metrics = getTaskbarMetrics(trayHwnd);
    if (!metrics) {
      currentGap = null;
      fallbackMetrics = null;
      updateVisibility();
      return false;
    }

    if (metrics.vertical) {
      currentGap = null;
      fallbackMetrics = null;
      updateVisibility();
      return false;
    }

    if (verticalTaskbar) {
      verticalTaskbar = false;
      notifyStateChange();
    }

    // 探测不到任何按钮时不视作「整条任务栏均为空档」，退回托盘左侧兜底避免遮盖图标。
    if (!probe || probe.buttons.length === 0) {
      setAlign('end');
      currentGap = null;
      fallbackMetrics = metrics;
      updateVisibility();
      return false;
    }

    const dpi = metrics.dpiScale || 1;
    const taskbarWidthCss = metrics.clientWidth / dpi;
    const taskbarHeightCss = metrics.clientHeight / dpi;
    const buttonsCss = probe.buttons.map((button) => ({
      x: (button.x - metrics.screenLeft) / dpi,
      w: button.w / dpi,
      h: button.h / dpi,
    }));

    let side = sideFor({ osBuild: probe.osBuild, taskbarAl: probe.taskbarAl });
    const gapInput = {
      taskbarWidth: taskbarWidthCss,
      taskbarHeight: taskbarHeightCss,
      buttons: buttonsCss,
    };
    let gap = selectGap({ ...gapInput, side });
    if (!gap) {
      const otherSide = side === 'left' ? 'right' : 'left';
      gap = selectGap({ ...gapInput, side: otherSide });
      if (gap) side = otherSide;
    }

    setAlign(side === 'left' ? 'start' : 'end');
    setLightTaskbar(probe.lightTaskbar ?? defaultLightTaskbar());

    if (!gap) {
      currentGap = null;
      fallbackMetrics = null;
      updateVisibility();
      return false;
    }

    fallbackMetrics = null;
    currentGap = { side, gap, dpi, height: metrics.clientHeight };
    updateVisibility();
    return true;
  }

  function probeAndApply() {
    if (!enabled || !hwnd || !trayHwnd) return Promise.resolve(false);

    const requestedKey = `${hwnd}:${trayHwnd}`;

    if (probeInFlight && shouldCoalesceProbe(probeInFlightKey, requestedKey)) {
      probeRerunRequested = true;
      return probeInFlight;
    }

    probeRerunRequested = false;
    lastProbeAt = Date.now();

    const promise = (async () => {
      try {
        return await resolveGap();
      } catch (error) {
        log('taskbar probe failed; keeping the last good gap', {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      } finally {
        if (probeInFlight === promise) {
          probeInFlight = null;
          probeInFlightKey = null;
          if (probeRerunRequested) {
            probeRerunRequested = false;
            probeAndApply();
          }
        }
      }
    })();

    probeInFlight = promise;
    probeInFlightKey = requestedKey;
    return promise;
  }

  function scheduleProbe() {
    if (!enabled) return;
    clearTimeout(probeDebounceTimer);
    const sinceLastProbe = Date.now() - lastProbeAt;
    const delay = Math.max(probeDebounceMs, minProbeIntervalMs - sinceLastProbe);
    probeDebounceTimer = setTimeout(() => {
      probeDebounceTimer = null;
      probeAndApply();
    }, delay);
  }

  function pollTaskbarState() {
    if (!enabled) return;
    try {
      if ((trayHwnd && !isWindow(trayHwnd)) || (hwnd && !isWindow(hwnd))) {
        recreateWindow();
        return;
      }

      if (targetTaskbarChanged()) return;

      const taskbarMetrics = getTaskbarMetrics(trayHwnd);
      if (taskbarMetrics) {
        const key = metricsKey(taskbarMetrics);
        if (!lastTaskbarMetrics) lastTaskbarMetrics = key;
        else if (key !== lastTaskbarMetrics) scheduleMetricsRecreate();
      }

      if (visible && !fullscreen && hwnd && isWindow(hwnd)) {
        if (isLegacyWindows()) ensureLegacyTopmost(false);
        else assertTopChild(hwnd);
      }
      if (isLegacyWindows() && legacyLayout.isUsable()) probeAndApply();

      const fingerprint = getTaskbarWindowsFingerprint();
      if (fingerprint !== null) {
        if (lastFingerprint !== null && fingerprint !== lastFingerprint) scheduleProbe();
        lastFingerprint = fingerprint;
      }

      const light = readSystemUsesLightTheme();
      if (light !== null) {
        if (lastLightTheme !== null && light !== lastLightTheme) setLightTaskbar(light);
        lastLightTheme = light;
      }

      const alignment = readTaskbarAlignment();
      if (alignment !== null) {
        if (lastAlignment !== null && alignment !== lastAlignment) probeAndApply();
        lastAlignment = alignment;
      }
    } catch (error) {
      log('failed to poll taskbar state', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function onDisplayMetrics() {
    lastWindowKey = null;
    lastContentSizeKey = null;
    if (targetTaskbarChanged()) return;
    scheduleMetricsRecreate();
    probeAndApply();
  }

  function startMonitors() {
    stopMonitors();
    const { screen } = getElectronApi();
    lastFingerprint = getTaskbarWindowsFingerprint();
    lastLightTheme = readSystemUsesLightTheme();
    lastAlignment = readTaskbarAlignment();

    pollTimer = setInterval(pollTaskbarState, pollIntervalMs);
    fullscreenTimer = setInterval(refreshFullscreen, fullscreenIntervalMs);
    heartbeatTimer = setInterval(() => {
      if (enabled && hasContent && !fullscreen) probeAndApply();
    }, probeHeartbeatMs);

    screen.on('display-metrics-changed', onDisplayMetrics);
    screen.on('display-added', onDisplayMetrics);
    screen.on('display-removed', onDisplayMetrics);
  }

  function stopMonitors() {
    clearInterval(pollTimer);
    pollTimer = null;
    clearInterval(fullscreenTimer);
    fullscreenTimer = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clearTimeout(probeDebounceTimer);
    probeDebounceTimer = null;
    clearTimeout(metricsRecreateTimer);
    metricsRecreateTimer = null;
    lastTaskbarMetrics = null;
    fullscreen = false;

    const api = resolveElectron(injectedElectron);
    if (api?.screen) {
      api.screen.removeListener('display-metrics-changed', onDisplayMetrics);
      api.screen.removeListener('display-added', onDisplayMetrics);
      api.screen.removeListener('display-removed', onDisplayMetrics);
    }
  }

  function scheduleRecreate() {
    if (!enabled) return;
    clearTimeout(recreateTimer);
    recreateTimer = setTimeout(() => {
      recreateTimer = null;
      if (enabled) recreateWindow();
    }, recreateDelayMs);
  }

  function destroyWindow() {
    const current = win;
    win = null;
    hwnd = null;
    trayHwnd = null;
    visible = false;
    currentGap = null;
    fallbackMetrics = null;
    lastWindowKey = null;
    lastContentSizeKey = null;
    probeRerunRequested = false;
    if (current && !current.isDestroyed()) current.destroy();
  }

  function recreateWindow() {
    if (!enabled) return;
    clearTimeout(recreateTimer);
    recreateTimer = null;
    try {
      // Explorer 重启后旧任务列表句柄已失效需重置；仅渲染进程崩溃时保留压缩状态减少图标抖动。
      if (!trayHwnd || !isWindow(trayHwnd)) legacyLayout.reset();
      destroyWindow();
      createWindow({ pending: false, notifyUser: false });
    } catch (error) {
      log('failed to recreate the taskbar widget window', {
        message: error instanceof Error ? error.message : String(error),
      });
      destroyWindow();
      scheduleRecreate();
    }
  }

  function failEnablement(error, notifyUser) {
    log('failed to enable taskbar widget', {
      message: error instanceof Error ? error.message : String(error),
      nativeError: getNativeInitError(),
    });
    enabled = false;
    stopMonitors();
    clearTimeout(recreateTimer);
    recreateTimer = null;
    destroyWindow();
    legacyLayout.reset();
    if (typeof onEnableFailed === 'function') {
      onEnableFailed(error instanceof Error ? error : new Error(String(error)), { notifyUser });
    }
  }

  function handleEmbedFailure(context, message) {
    if (context.pending) {
      failEnablement(new Error(message), context.notifyUser);
      return;
    }
    log(`${message}; retrying`);
    scheduleRecreate();
  }

  function createWindow(context = {}) {
    if (isWindowAlive(win)) return;
    const { BrowserWindow, screen } = getElectronApi();

    const windowContext = {
      pending: context.pending === true,
      notifyUser: context.notifyUser === true,
    };

    clearTimeout(recreateTimer);
    recreateTimer = null;
    clearTimeout(metricsRecreateTimer);
    metricsRecreateTimer = null;

    const owner = typeof getOwnerWindow === 'function' ? getOwnerWindow() : null;
    const primaryTaskbar = findTaskbar();
    const targetTaskbar = resolveTargetTaskbar();
    const onPrimaryTaskbar = !targetTaskbar || !primaryTaskbar || targetTaskbar === primaryTaskbar;
    const targetDisplay =
      onPrimaryTaskbar || !owner || owner.isDestroyed()
        ? screen.getPrimaryDisplay()
        : screen.getDisplayMatching(owner.getBounds());

    const targetMetrics = targetTaskbar ? getTaskbarMetrics(targetTaskbar) : null;
    const verticalTarget = targetMetrics
      ? targetMetrics.vertical === true || targetMetrics.clientHeight > targetMetrics.clientWidth
      : verticalTaskbar;
    verticalTaskbar = verticalTarget;

    // 初始窗口覆盖目标方向最大可能尺寸，避免透明窗口在 SetParent 后合成 surface 只缩不涨。
    const initialWidth =
      verticalTarget && targetMetrics
        ? Math.max(1, Math.round(targetMetrics.clientWidth / (targetMetrics.dpiScale || 1)))
        : Math.max(1, Math.round(targetDisplay.bounds.width));
    const initialHeight = verticalTarget ? Math.max(1, Math.round(targetDisplay.bounds.height)) : 200;

    const next = new BrowserWindow({
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      width: initialWidth,
      height: initialHeight,
      frame: false,
      thickFrame: false,
      transparent: true,
      backgroundColor: '#00000000',
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        ...(preload ? { preload } : {}),
        ...webPreferences,
      },
    });

    if (typeof hardenWindow === 'function') {
      hardenWindow(next.webContents, htmlPath);
    }

    win = next;
    if (ignoreMouseEvents) {
      try {
        next.setIgnoreMouseEvents(true);
      } catch {
        // 不支持时忽略
      }
    }
    hwnd = null;
    trayHwnd = null;
    visible = false;
    currentGap = null;
    fallbackMetrics = null;
    lastWindowKey = null;
    lastContentSizeKey = null;

    if (typeof load === 'function') {
      load(next);
    } else if (htmlPath) {
      next.loadFile(htmlPath);
    } else {
      throw new Error('createTaskbarWidget requires either `htmlPath` or `load`');
    }

    next.webContents.on('did-finish-load', () => {
      if (win !== next || next.isDestroyed()) return;

      const nextHwnd = getNativeHwnd(next);
      const nextTrayHwnd = resolveTargetTaskbar();
      if (!nextHwnd || !nextTrayHwnd) {
        handleEmbedFailure(windowContext, 'taskbar window not found');
        return;
      }

      if (!embedWindow(nextHwnd, nextTrayHwnd)) {
        log('embed verification failed', {
          hwnd: String(nextHwnd),
          trayHwnd: String(nextTrayHwnd),
          parent: String(getWindowParent(nextHwnd)),
          ancestor: String(getWindowAncestor(nextHwnd)),
        });
        handleEmbedFailure(windowContext, 'failed to embed the widget into the taskbar container');
        return;
      }

      windowContext.pending = false;
      hwnd = nextHwnd;
      trayHwnd = nextTrayHwnd;
      const nextMetrics = getTaskbarMetrics(nextTrayHwnd);
      verticalTaskbar = nextMetrics
        ? nextMetrics.vertical === true || nextMetrics.clientHeight > nextMetrics.clientWidth
        : verticalTaskbar;
      lastTaskbarMetrics = metricsKey(nextMetrics);
      const windowsParent = getWindowParent(nextHwnd);
      log('taskbar widget embedded', {
        hwnd: String(nextHwnd),
        trayHwnd: String(nextTrayHwnd),
        windowsParent: windowsParent ? String(windowsParent) : null,
        osBuild: getOsBuild(),
        legacy: isLegacyWindows(),
        metrics: lastTaskbarMetrics,
        styles: getWindowStyleInfo(nextHwnd),
      });

      if (typeof onEmbedded === 'function') {
        onEmbedded({ win: next, state: getState() });
      }
      updateVisibility();
      probeAndApply();
    });

    next.on('closed', () => {
      if (win !== next) return;
      win = null;
      hwnd = null;
      trayHwnd = null;
      visible = false;
      currentGap = null;
      fallbackMetrics = null;
      lastWindowKey = null;
      lastContentSizeKey = null;
      if (!enabled) return;
      if (windowContext.pending) {
        failEnablement(new Error('taskbar window closed before embedding'), windowContext.notifyUser);
      } else {
        recreateWindow();
      }
    });

    next.webContents.on('render-process-gone', () => {
      if (win !== next) return;
      if (windowContext.pending) {
        failEnablement(
          new Error('renderer exited before the widget was embedded'),
          windowContext.notifyUser
        );
        return;
      }
      destroyWindow();
      scheduleRecreate();
    });
  }

  /** 启动任务栏嵌入并开始监听系统状态。非 Windows 或任务栏不可用时返回 `false`。 */
  function enable({ notifyUser = false } = {}) {
    if (process.platform !== 'win32') return false;
    if (enabled && isWindowAlive(win)) return true;

    try {
      const tray = resolveTargetTaskbar();
      if (!tray) {
        throw new Error(
          'Shell_TrayWnd not found; native helpers are unavailable or the taskbar is missing'
        );
      }
      const metrics = getTaskbarMetrics(tray);
      if (!metrics) {
        throw new Error('taskbar metrics unavailable; native helpers failed');
      }

      const vertical = metrics.vertical === true || metrics.clientHeight > metrics.clientWidth;
      if (vertical && !isLegacyWindows()) {
        throw new Error('vertical taskbars are only supported on Windows 10');
      }
      verticalTaskbar = vertical;

      log('enabling taskbar widget', {
        osBuild: getOsBuild(),
        legacy: isLegacyWindows(),
        vertical,
        trayHwnd: String(tray),
        clientWidth: metrics.clientWidth,
        clientHeight: metrics.clientHeight,
        dpiScale: metrics.dpiScale,
        monitorRect: getMonitorRect(tray),
        nativeError: getNativeInitError(),
      });

      enabled = true;
      startMonitors();
      createWindow({ pending: true, notifyUser });
      return true;
    } catch (error) {
      failEnablement(error, notifyUser);
      return false;
    }
  }

  /** 停用组件、销毁窗口并恢复 Windows 10 任务列表宽度。 */
  function disable() {
    enabled = false;
    stopMonitors();
    clearTimeout(recreateTimer);
    recreateTimer = null;
    destroyWindow();
    legacyLayout.reset();
    log('taskbar widget disabled');
  }

  /** 退出清理（静默释放定时器、窗口与 Win10 任务列表压缩状态）。 */
  function dispose() {
    enabled = false;
    stopMonitors();
    clearTimeout(recreateTimer);
    recreateTimer = null;
    destroyWindow();
    legacyLayout.reset();
  }

  /** 更新是否有内容可显示：置为 `false` 时隐藏并在 Windows 10 上恢复任务列表。 */
  function setHasContent(value) {
    const next = Boolean(value);
    const changed = hasContent !== next;
    hasContent = next;
    updateVisibility();
    if (changed && enabled) probeAndApply();
  }

  /** 由渲染进程回报内容测量宽度（CSS px）。 */
  function setContentWidth(px) {
    const width = Number(px);
    if (!Number.isFinite(width) || width <= 0) return;
    const nextWidth = Math.max(1, Math.round(width));
    if (nextWidth === widthCss) return;
    widthCss = nextWidth;
    if (isLegacyWindows() && legacyLayout.isUsable()) {
      // 固定宽度已生效时歌词换长短行不改变窗口宽度，跳过多余的 Win10 布局重算。
      if (fixedStripCss > 0 && currentGap?.legacy) return;
      probeAndApply();
    } else {
      updateVisibility();
    }
  }

  /** 主动同步可见性并触发一次空档重测（例如渲染进程完成挂载上报 ready 时）。 */
  function refresh() {
    updateVisibility();
    return probeAndApply();
  }

  return {
    enable,
    disable,
    dispose,
    isEnabled: () => enabled,
    isRunning: () => process.platform === 'win32' && enabled && isWindowAlive(win),
    isVisible: () => visible,
    getWindow: () => win,
    getState,
    setHasContent,
    setContentWidth,
    send,
    refresh,
  };
}
