/**
 * Windows 10 经典任务栏布局与任务列表压缩控制器。
 *
 * 在 Windows 10 经典任务栏中，`MSTaskSwWClass`（应用按钮列表）会横跨整个 `ReBarWindow32`，
 * 右侧视觉空白区域仍被任务列表窗口覆盖。本模块通过以下流程为组件腾出真实空间：
 * 1. 记录压缩前的任务列表基线几何；
 * 2. 校验 ReBar 与任务栏客户区一致性（拦截 Explorer 重排期间的瞬态异常 metrics）；
 * 3. 调用 `MoveWindow` 压缩任务列表（横排从右端腾空，竖排从底端腾空），优先使用固定预留长度，
 *    空间不足时自动退回到当前内容长度；
 * 4. 在功能关闭、无内容、DPI/高度变化或退出应用时，将任务列表按当前 ReBar 尺寸等比恢复。
 */

import {
  findTaskbarContainer,
  findTaskList,
  findTrayNotify,
  getTaskbarMetrics,
  getWindowRect,
  isLegacyBuild,
  isWindow,
  moveWindow,
} from './win32.js';
import {
  clampWindowWidth,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  DOCK_MARGIN_CSS,
  FIXED_STRIP_CSS,
} from './layout.js';

let cachedLegacy = null;

/** 当前系统是否为 Windows 10 及更早的经典任务栏构建（结果按进程缓存）。 */
export function isLegacyWindows() {
  if (cachedLegacy === null) cachedLegacy = isLegacyBuild();
  return cachedLegacy;
}

function sameRect(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function stableKey(value) {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    );
  } catch {
    return String(value);
  }
}

function freshState() {
  return {
    trayHwnd: null,
    rebarHwnd: null,
    taskListHwnd: null,
    baseline: null,
    squeezed: false,
    lastRebarWidth: 0,
    lastRebarHeight: 0,
    lastTaskListRect: null,
    // 'stable' 优先按固定长度预留，防止内容变化时图标跳动；任务栏过挤时退回 'content'。
    reserveMode: 'stable',
  };
}

/**
 * 创建独立的 Windows 10 任务列表压缩状态机。
 *
 * @param {{
 *   logger?: (message: string, details?: object | null) => void,
 *   fixedStripCss?: number,
 *   dockMarginCss?: number
 * }} [options]
 */
export function createLegacyLayoutController({
  logger = null,
  fixedStripCss = FIXED_STRIP_CSS,
  dockMarginCss = DOCK_MARGIN_CSS,
  native = null,
} = {}) {
  const win32 = {
    findTaskbarContainer,
    findTaskList,
    findTrayNotify,
    getTaskbarMetrics,
    getWindowRect,
    isWindow,
    moveWindow,
    ...native,
  };
  let usable = true;
  let state = freshState();
  let lastLogKey = '';

  const log = (message, details = null) => {
    if (typeof logger === 'function') logger(message, details);
  };

  function logOnce(message, details) {
    const key = `${message}:${stableKey(details)}`;
    if (key === lastLogKey) return;
    lastLogKey = key;
    log(message, details);
  }

  function clearReservation() {
    state.squeezed = false;
    state.baseline = null;
    state.lastTaskListRect = null;
  }

  /** 将任务列表按压缩前基线与当前 ReBar 尺寸等比恢复；句柄失效时安全清状态。 */
  function restore() {
    const { taskListHwnd, rebarHwnd, baseline, squeezed } = state;
    if (!squeezed || !baseline) {
      clearReservation();
      return;
    }
    if (!taskListHwnd || !win32.isWindow(taskListHwnd) || !rebarHwnd || !win32.isWindow(rebarHwnd)) {
      clearReservation();
      return;
    }

    const rebarMetrics = win32.getTaskbarMetrics(rebarHwnd);
    if (!rebarMetrics) {
      clearReservation();
      return;
    }

    const scaleX = baseline.rebarWidth > 0 ? rebarMetrics.clientWidth / baseline.rebarWidth : 1;
    const scaleY = baseline.rebarHeight > 0 ? rebarMetrics.clientHeight / baseline.rebarHeight : 1;
    const x = Math.max(0, Math.min(rebarMetrics.clientWidth - 1, Math.round(baseline.x * scaleX)));
    const y = Math.max(0, Math.min(rebarMetrics.clientHeight - 1, Math.round(baseline.y * scaleY)));
    const width = Math.max(
      1,
      Math.min(rebarMetrics.clientWidth - x, Math.round(baseline.width * scaleX))
    );
    const height = Math.max(
      1,
      Math.min(rebarMetrics.clientHeight - y, Math.round(baseline.height * scaleY))
    );

    if (win32.moveWindow(taskListHwnd, { x, y, width, height })) {
      log('Win10 layout: task list restored', {
        taskListHwnd: String(taskListHwnd),
        width,
      });
    }
    clearReservation();
  }

  /** 恢复任务列表并清空所有缓存句柄与基线（用于停用、换屏或 Explorer 重启后重置）。 */
  function reset() {
    restore();
    state = freshState();
    usable = true;
    lastLogKey = '';
  }

  /**
   * 尝试在 Windows 10 任务栏中为组件腾出空间，并返回组件相对 `Shell_TrayWnd` 客户区的物理 bounds。
   *
   * 失败原因 `reason`：
   * - `unsupported`：缺少 `ReBarWindow32`/`MSTaskSwWClass` 或读不到 metrics（调用方可回退 UIA）；
   * - `waiting`：内容宽度尚未就绪；
   * - `retry`：Explorer 重排瞬间读到矛盾几何，保持上次布局等待下一轮重试；
   * - `no-space`：任务栏可用空间不足，应隐藏组件；
   * - `move-failed`：`MoveWindow` 调用失败（调用方可回退 UIA）。
   */
  function apply({ trayHwnd, widthCss }) {
    if (!usable || !trayHwnd) return { ok: false, reason: 'unsupported' };
    if (!(Number(widthCss) > 0)) return { ok: false, reason: 'waiting' };

    const tray = trayHwnd;
    const rebarHwnd = win32.findTaskbarContainer(tray);
    if (!rebarHwnd) {
      usable = false;
      logOnce('Win10 layout unsupported: ReBarWindow32 not found', {
        trayHwnd: String(tray),
      });
      return { ok: false, reason: 'unsupported' };
    }

    const taskListHwnd = win32.findTaskList(rebarHwnd);
    if (!taskListHwnd) {
      usable = false;
      logOnce('Win10 layout unsupported: task list not found', {
        rebarHwnd: String(rebarHwnd),
      });
      return { ok: false, reason: 'unsupported' };
    }

    // Explorer 重启或切换任务栏后旧句柄变化：先尝试恢复旧任务列表再重建状态。
    if (
      (state.rebarHwnd && state.rebarHwnd !== rebarHwnd) ||
      (state.taskListHwnd && state.taskListHwnd !== taskListHwnd) ||
      (state.trayHwnd && state.trayHwnd !== tray)
    ) {
      reset();
    }
    state.trayHwnd = tray;
    state.rebarHwnd = rebarHwnd;
    state.taskListHwnd = taskListHwnd;

    let rebarMetrics = win32.getTaskbarMetrics(rebarHwnd);
    if (!rebarMetrics) {
      logOnce('Win10 layout unavailable: rebar metrics missing', {
        rebarHwnd: String(rebarHwnd),
      });
      return { ok: false, reason: 'unsupported' };
    }

    // 高度变化（DPI/小任务栏切换）时恢复基线并重算，避免多次压缩叠加漂移。
    if (state.squeezed && state.baseline && rebarMetrics.clientHeight !== state.lastRebarHeight) {
      restore();
      rebarMetrics = win32.getTaskbarMetrics(rebarHwnd);
      if (!rebarMetrics) return { ok: false, reason: 'unsupported' };
      state.reserveMode = 'stable';
    }

    const taskbarMetrics = win32.getTaskbarMetrics(tray);
    if (!taskbarMetrics) {
      logOnce('Win10 layout unavailable: taskbar metrics missing', {
        trayHwnd: String(tray),
      });
      return { ok: false, reason: 'unsupported' };
    }

    const taskListRect = win32.getWindowRect(taskListHwnd);
    if (!taskListRect) {
      logOnce('Win10 layout unavailable: task list rect missing', {
        taskListHwnd: String(taskListHwnd),
      });
      return { ok: false, reason: 'unsupported' };
    }

    // 校验 ReBar 完整落在任务栏客户区内，过滤 Explorer 瞬态错误几何。
    const rebarOffsetX = rebarMetrics.screenLeft - taskbarMetrics.screenLeft;
    const rebarOffsetY = rebarMetrics.screenTop - taskbarMetrics.screenTop;
    if (
      rebarOffsetX < 0 ||
      rebarOffsetY < 0 ||
      rebarOffsetX + rebarMetrics.clientWidth > taskbarMetrics.clientWidth ||
      rebarOffsetY + rebarMetrics.clientHeight > taskbarMetrics.clientHeight
    ) {
      logOnce('Win10 layout: inconsistent ReBar metrics; keeping the last position', {
        rebar: {
          screenLeft: rebarMetrics.screenLeft,
          screenTop: rebarMetrics.screenTop,
          clientWidth: rebarMetrics.clientWidth,
          clientHeight: rebarMetrics.clientHeight,
        },
        taskbar: {
          screenLeft: taskbarMetrics.screenLeft,
          screenTop: taskbarMetrics.screenTop,
          clientWidth: taskbarMetrics.clientWidth,
          clientHeight: taskbarMetrics.clientHeight,
        },
        taskListRect,
        rebarHwnd: String(rebarHwnd),
      });
      return { ok: false, reason: 'retry' };
    }

    const dpi = rebarMetrics.dpiScale > 0 ? rebarMetrics.dpiScale : 1;
    const vertical =
      taskbarMetrics.vertical === true || rebarMetrics.clientHeight > rebarMetrics.clientWidth;

    const trayRect = win32.getWindowRect(win32.findTrayNotify(tray));
    const rightLimitPx =
      trayRect && trayRect.left > rebarMetrics.screenLeft
        ? trayRect.left - rebarMetrics.screenLeft
        : null;
    const bottomLimitPx =
      trayRect && trayRect.top > rebarMetrics.screenTop
        ? trayRect.top - rebarMetrics.screenTop
        : null;
    const usableLongAxisPx = vertical
      ? bottomLimitPx !== null
        ? Math.min(rebarMetrics.clientHeight, bottomLimitPx)
        : rebarMetrics.clientHeight
      : rightLimitPx !== null
        ? Math.min(rebarMetrics.clientWidth, rightLimitPx)
        : rebarMetrics.clientWidth;
    const usableLongAxisCss = usableLongAxisPx / dpi;

    const stripLengthCss = clampWindowWidth({
      contentWidthCss: widthCss,
      gapWidthCss: usableLongAxisCss,
      dockMarginCss,
    });
    if (stripLengthCss === 0) {
      logOnce('Win10 layout: content does not fit the taskbar', {
        widthCss,
        usableLongAxisCss,
        vertical,
      });
      return { ok: false, reason: 'no-space' };
    }

    // 固定长度模式下将组件长度严格封顶在 `fixedStripCss`（超长文本交给渲染器跑马灯滚动），
    // 防止长歌词把窗口撑宽并反复挤压 Win10 任务栏图标。
    const hasFixedLength = Number.isFinite(fixedStripCss) && fixedStripCss > 0;
    const maxReserveCss = Math.max(0, usableLongAxisCss - 2 * dockMarginCss);
    const effectiveStripCss = hasFixedLength
      ? Math.min(stripLengthCss, fixedStripCss)
      : stripLengthCss;
    const stripLengthPx = Math.max(1, Math.round(effectiveStripCss * dpi));
    const stableReserveCss = hasFixedLength
      ? Math.max(effectiveStripCss, Math.min(fixedStripCss, maxReserveCss))
      : effectiveStripCss;
    const stableReservePx = Math.max(stripLengthPx, Math.round(stableReserveCss * dpi));

    const baseLayoutInput = {
      rebarClientOrigin: {
        x: rebarMetrics.screenLeft,
        y: rebarMetrics.screenTop,
      },
      rebarClientSize: {
        width: rebarMetrics.clientWidth,
        height: rebarMetrics.clientHeight,
      },
      taskbarClientOrigin: {
        x: taskbarMetrics.screenLeft,
        y: taskbarMetrics.screenTop,
      },
      taskListRect,
      gapPx: dockMarginCss,
      marginPx: dockMarginCss,
    };

    const makeLayout = (reservePx) =>
      vertical
        ? computeLegacyVerticalTaskbarLayout({
            ...baseLayoutInput,
            stripLengthPx: reservePx,
            reserveLengthPx: reservePx,
            bottomLimitPx,
          })
        : computeLegacyTaskbarLayout({
            ...baseLayoutInput,
            stripWidthPx: reservePx,
            reserveWidthPx: reservePx,
            rightLimitPx,
          });

    let reservePx = stableReservePx;
    let layout = null;
    if (state.reserveMode === 'stable') {
      layout = makeLayout(reservePx);
      if (!layout) {
        state.reserveMode = 'content';
        log('Win10 layout: stable reserve does not fit; using content length', {
          stripLengthPx,
          stableReservePx,
          vertical,
          rebarWidth: rebarMetrics.clientWidth,
          rebarHeight: rebarMetrics.clientHeight,
          taskListRect,
          rightLimitPx,
          bottomLimitPx,
        });
      }
    }
    if (!layout) {
      reservePx = stripLengthPx;
      layout = makeLayout(reservePx);
    }

    if (!layout) {
      logOnce('Win10 layout: not enough room for the widget', {
        stripLengthPx,
        vertical,
        rebarWidth: rebarMetrics.clientWidth,
        rebarHeight: rebarMetrics.clientHeight,
        taskListRect,
        rightLimitPx,
        bottomLimitPx,
      });
      return { ok: false, reason: 'no-space' };
    }

    // 最终边界守卫：计算结果必须完全落在任务栏与 ReBar 客户区内。
    const stripOutsideTaskbar =
      layout.strip.x < 0 ||
      layout.strip.y < 0 ||
      layout.strip.x + layout.strip.width > taskbarMetrics.clientWidth ||
      layout.strip.y + layout.strip.height > taskbarMetrics.clientHeight;
    const taskListOutsideRebar =
      !!layout.taskList &&
      (layout.taskList.x < 0 ||
        layout.taskList.y < 0 ||
        layout.taskList.x + layout.taskList.width > rebarMetrics.clientWidth ||
        layout.taskList.y + layout.taskList.height > rebarMetrics.clientHeight);
    if (stripOutsideTaskbar || taskListOutsideRebar) {
      logOnce('Win10 layout: computed bounds fall outside the taskbar; keeping the last position', {
        bounds: layout.strip,
        taskList: layout.taskList,
        taskbar: {
          clientWidth: taskbarMetrics.clientWidth,
          clientHeight: taskbarMetrics.clientHeight,
        },
        rebar: {
          clientWidth: rebarMetrics.clientWidth,
          clientHeight: rebarMetrics.clientHeight,
        },
      });
      return { ok: false, reason: 'retry' };
    }

    let taskListMoved = false;
    if (layout.taskList) {
      const currentTaskListRect = {
        x: taskListRect.left - rebarMetrics.screenLeft,
        y: taskListRect.top - rebarMetrics.screenTop,
        width: taskListRect.right - taskListRect.left,
        height: taskListRect.bottom - taskListRect.top,
      };
      if (!state.baseline) {
        state.baseline = {
          ...currentTaskListRect,
          rebarWidth: rebarMetrics.clientWidth,
          rebarHeight: rebarMetrics.clientHeight,
        };
      }
      // 按实时原生几何而非仅按上次目标比对：Explorer 刷新把任务列表拉回满宽时必须重新压缩。
      if (!sameRect(currentTaskListRect, layout.taskList)) {
        if (!win32.moveWindow(taskListHwnd, layout.taskList)) {
          logOnce('Win10 layout: failed to resize the task list', {
            taskListHwnd: String(taskListHwnd),
            target: layout.taskList,
          });
          return { ok: false, reason: 'move-failed' };
        }
        const targetChanged = !sameRect(state.lastTaskListRect, layout.taskList);
        state.lastTaskListRect = layout.taskList;
        taskListMoved = true;
        if (targetChanged) {
          log('Win10 layout: task list squeezed for the taskbar widget', {
            taskListHwnd: String(taskListHwnd),
            oldWidth: state.baseline.width,
            oldHeight: state.baseline.height,
            newWidth: layout.taskList.width,
            newHeight: layout.taskList.height,
            stripLengthPx,
            reservePx,
            vertical,
            bounds: layout.strip,
          });
        }
      }
      state.squeezed = true;
    }

    state.lastRebarWidth = rebarMetrics.clientWidth;
    state.lastRebarHeight = rebarMetrics.clientHeight;
    lastLogKey = '';

    return {
      ok: true,
      bounds: layout.strip,
      stripLengthPx: reservePx,
      contentLengthPx: stripLengthPx,
      vertical,
      taskListMoved,
    };
  }

  return {
    isUsable: () => usable,
    apply,
    restore,
    reset,
  };
}
