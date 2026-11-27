/**
 * 任务栏小组件纯几何布局与可见性状态判定模块。
 *
 * 零 Electron / 原生绑定 / DOM 依赖，可在任意平台上使用 `node --test` 直接测试。
 */

export const MIN_TEXT_CSS = 160;
export const WINDOW_PADDING_CSS = 12;
export const MIN_WINDOW_CSS = 184;
export const DOCK_MARGIN_CSS = 8;
export const MIN_GAP_CSS = 200;

/** 推荐的固定组件条长度（CSS px）：固定长度可避免内容变化时窗口反复 resize。 */
export const FIXED_STRIP_CSS = 400;

/**
 * 确定组件应优先停靠的任务栏半侧。
 * Windows 11 居中任务栏（`taskbarAl !== 0`）左侧通常留有空档；
 * Windows 11 左对齐任务栏（`taskbarAl === 0`）及 Windows 10 均优先使用右侧空档。
 *
 * @param {{ osBuild: number, taskbarAl?: number | null }} params
 * @returns {'left' | 'right'}
 */
export function sideFor({ osBuild, taskbarAl }) {
  if (osBuild < 22000) return 'right';
  return taskbarAl === 0 ? 'right' : 'left';
}

/**
 * 判定任务栏组件窗口当前是否应当可见。
 * UIA 探测空档与托盘左侧兜底位置任一可用即可显示；全屏、禁用、无内容或窗口失效时隐藏。
 *
 * @param {{
 *   enabled: boolean,
 *   hasContent?: boolean,
 *   hasSong?: boolean,
 *   fullscreen: boolean,
 *   hasGap: boolean,
 *   hasFallback: boolean,
 *   windowAlive: boolean
 * }} params
 * @returns {boolean}
 */
export function shouldShow({
  enabled,
  hasContent,
  hasSong,
  fullscreen,
  hasGap,
  hasFallback,
  windowAlive,
}) {
  const activeContent = hasContent !== undefined ? hasContent : hasSong;
  return Boolean(enabled && activeContent && !fullscreen && (hasGap || hasFallback) && windowAlive);
}

/**
 * 判断一次新的探测请求是否可合并到进行中的探测里。
 * 仅当窗口与任务栏句柄对（`${hwnd}:${trayHwnd}`）完全相同时才合并；窗口重建后必须发起新探测。
 */
export function shouldCoalesceProbe(inFlightKey, requestedKey) {
  if (inFlightKey === null || inFlightKey === undefined) return false;
  if (requestedKey === null || requestedKey === undefined) return false;
  return inFlightKey === requestedKey;
}

/**
 * 计算 Windows 10 横排任务栏（底部/顶部）的布局方案（所有输入与输出均为物理像素）。
 *
 * 当经典任务列表（`MSTaskSwWClass`）占据右端空间时，从右侧压缩任务列表腾出空位，
 * 将组件摆放在空位内；若任务列表右侧原本就有足够空间，则 `taskList` 返回 `null`（不移动）。
 * - 返回的 `strip` 坐标相对 `Shell_TrayWnd` 客户区；
 * - 返回的 `taskList` 坐标相对 `ReBarWindow32` 客户区（供 `MoveWindow` 使用）。
 */
export function computeLegacyTaskbarLayout({
  rebarClientOrigin,
  rebarClientSize,
  taskbarClientOrigin,
  taskListRect,
  stripWidthPx,
  reserveWidthPx = null,
  gapPx = DOCK_MARGIN_CSS,
  marginPx = DOCK_MARGIN_CSS,
  rightLimitPx = null,
}) {
  if (!rebarClientOrigin || !rebarClientSize || !taskbarClientOrigin) return null;

  const rebarWidth = Math.trunc(rebarClientSize.width);
  const rebarHeight = Math.trunc(rebarClientSize.height);
  const width = Math.trunc(stripWidthPx);
  if (rebarWidth <= 0 || rebarHeight <= 0 || width <= 0) return null;

  const right =
    rightLimitPx !== null && Number.isFinite(rightLimitPx)
      ? Math.min(rebarWidth, Math.trunc(rightLimitPx))
      : rebarWidth;
  // 按预留宽度而非瞬时内容宽度压缩任务列表，避免内容变化时任务栏图标左右跳动。
  const reserve =
    reserveWidthPx !== null && Number.isFinite(reserveWidthPx)
      ? Math.max(width, Math.trunc(reserveWidthPx))
      : width;
  const needed = reserve + marginPx + gapPx;
  if (right <= 0 || needed > right || width + marginPx > right) return null;

  const stripLeft = right - marginPx - width;
  let taskList = null;

  if (taskListRect) {
    const taskListWidth = taskListRect.right - taskListRect.left;
    const taskListHeight = taskListRect.bottom - taskListRect.top;
    if (taskListWidth > 0 && taskListHeight > 0) {
      const x = taskListRect.left - rebarClientOrigin.x;
      const y = taskListRect.top - rebarClientOrigin.y;
      const freeRight = right - (x + taskListWidth);
      if (freeRight < needed) {
        const newWidth = taskListWidth + freeRight - needed;
        if (newWidth <= 0) return null;
        taskList = { x, y, width: newWidth, height: taskListHeight };
      }
    }
  }

  return {
    strip: {
      x: rebarClientOrigin.x + stripLeft - taskbarClientOrigin.x,
      y: rebarClientOrigin.y - taskbarClientOrigin.y,
      width,
      height: rebarHeight,
    },
    taskList,
  };
}

/**
 * 计算 Windows 10 竖排任务栏（左侧/右侧）的布局方案（所有坐标均为物理像素）。
 *
 * 在任务列表底部腾出纵向空间，组件横向占满 ReBar 宽度并贴在任务列表与托盘区之间。
 * - 返回的 `strip` 坐标相对 `Shell_TrayWnd` 客户区；
 * - 返回的 `taskList` 坐标相对 `ReBarWindow32` 客户区。
 */
export function computeLegacyVerticalTaskbarLayout({
  rebarClientOrigin,
  rebarClientSize,
  taskbarClientOrigin,
  taskListRect,
  stripLengthPx,
  reserveLengthPx = null,
  gapPx = DOCK_MARGIN_CSS,
  marginPx = DOCK_MARGIN_CSS,
  bottomLimitPx = null,
}) {
  if (!rebarClientOrigin || !rebarClientSize || !taskbarClientOrigin) return null;

  const rebarWidth = Math.trunc(rebarClientSize.width);
  const rebarHeight = Math.trunc(rebarClientSize.height);
  const length = Math.trunc(stripLengthPx);
  if (rebarWidth <= 0 || rebarHeight <= 0 || length <= 0) return null;

  const bottom =
    bottomLimitPx !== null && Number.isFinite(bottomLimitPx)
      ? Math.min(rebarHeight, Math.trunc(bottomLimitPx))
      : rebarHeight;
  if (bottom <= 0) return null;

  const reserve =
    reserveLengthPx !== null && Number.isFinite(reserveLengthPx)
      ? Math.max(length, Math.trunc(reserveLengthPx))
      : length;
  const needed = reserve + marginPx + gapPx;
  if (needed > bottom || length + marginPx > bottom) return null;

  const stripTop = bottom - marginPx - length;
  let taskList = null;

  if (taskListRect) {
    const taskListWidth = taskListRect.right - taskListRect.left;
    const taskListHeight = taskListRect.bottom - taskListRect.top;
    if (taskListWidth > 0 && taskListHeight > 0) {
      const x = taskListRect.left - rebarClientOrigin.x;
      const y = taskListRect.top - rebarClientOrigin.y;
      const freeBottom = bottom - (y + taskListHeight);
      if (freeBottom < needed) {
        const newHeight = taskListHeight + freeBottom - needed;
        if (newHeight <= 0) return null;
        taskList = { x, y, width: taskListWidth, height: newHeight };
      }
    }
  }

  return {
    strip: {
      x: rebarClientOrigin.x - taskbarClientOrigin.x,
      y: rebarClientOrigin.y + stripTop - taskbarClientOrigin.y,
      width: rebarWidth,
      height: length,
    },
    taskList,
  };
}

function pickWidest(gaps, side, taskbarWidth) {
  const half = taskbarWidth / 2;
  const candidates = gaps.filter((gap) => (side === 'left' ? gap.left < half : gap.right > half));
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (const gap of candidates.slice(1)) {
    const wider = gap.width > best.width;
    const tie = gap.width === best.width;
    if (wider || (tie && (side === 'left' ? gap.left < best.left : gap.right > best.right))) {
      best = gap;
    }
  }
  return best;
}

/**
 * 从任务栏按钮矩形列表中计算水平方向的空闲区间，并选出优先半侧中最宽的可用空档。
 * 若首选半侧无满足 `minGapCss` 的空档，则自动降级尝试另一半侧。
 * 所有几何参数须使用同一单位（调用方通常传入 CSS px）。
 *
 * @param {{
 *   taskbarWidth: number,
 *   taskbarHeight: number,
 *   buttons: readonly { x: number, w: number, h: number }[],
 *   side: 'left' | 'right',
 *   minGapCss?: number
 * }} params
 * @returns {{ left: number, right: number } | null}
 */
export function selectGap({
  taskbarWidth,
  taskbarHeight,
  buttons,
  side,
  minGapCss = MIN_GAP_CSS,
}) {
  const intervals = [];
  for (const button of buttons ?? []) {
    // 忽略高度不足任务栏一半的装饰性子控件或 1px 占位按钮
    if (button.w <= 1 || button.h < taskbarHeight * 0.5) continue;
    const left = Math.max(0, button.x);
    const right = Math.min(taskbarWidth, button.x + button.w);
    if (right <= left) continue;
    intervals.push({ left, right });
  }
  intervals.sort((a, b) => a.left - b.left);

  // 合并重叠或间距 <= 2 的相邻按钮区间
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.left <= last.right + 2) {
      last.right = Math.max(last.right, interval.right);
    } else {
      merged.push({ ...interval });
    }
  }

  const gaps = [];
  let cursor = 0;
  for (const interval of merged) {
    gaps.push({ left: cursor, right: interval.left, width: interval.left - cursor });
    cursor = Math.max(cursor, interval.right);
  }
  gaps.push({ left: cursor, right: taskbarWidth, width: taskbarWidth - cursor });

  const usable = gaps.filter((gap) => gap.width >= minGapCss);
  const chosen =
    pickWidest(usable, side, taskbarWidth) ??
    pickWidest(usable, side === 'left' ? 'right' : 'left', taskbarWidth);

  return chosen ? { left: chosen.left, right: chosen.right } : null;
}

/**
 * 将组件窗口宽度夹紧到可用空档范围内（留出两侧停靠边距）。
 * 当可用宽度低于 `minWindowCss` 时返回 `0`，提示调用方隐藏组件而非裁切挤压。
 */
export function clampWindowWidth({
  contentWidthCss,
  gapWidthCss,
  minWindowCss = MIN_WINDOW_CSS,
  windowPaddingCss = WINDOW_PADDING_CSS,
  dockMarginCss = DOCK_MARGIN_CSS,
}) {
  const maxW = gapWidthCss - 2 * dockMarginCss;
  if (maxW < minWindowCss) return 0;
  return Math.min(
    Math.max(Math.ceil(contentWidthCss + 2 * windowPaddingCss), minWindowCss),
    maxW
  );
}
