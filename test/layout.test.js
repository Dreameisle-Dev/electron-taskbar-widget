import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampWindowWidth,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  createLegacyLayoutController,
  DOCK_MARGIN_CSS,
  FIXED_STRIP_CSS,
  MIN_WINDOW_CSS,
  selectGap,
  shouldCoalesceProbe,
  shouldShow,
  sideFor,
} from '../src/index.js';

test('sideFor picks left for centered Win11 and right for left-aligned Win11 or Win10', () => {
  assert.equal(sideFor({ osBuild: 22631, taskbarAl: 1 }), 'left');
  assert.equal(sideFor({ osBuild: 22631, taskbarAl: null }), 'left');
  assert.equal(sideFor({ osBuild: 22631, taskbarAl: 0 }), 'right');
  assert.equal(sideFor({ osBuild: 19045, taskbarAl: 1 }), 'right');
  assert.equal(sideFor({ osBuild: 19045, taskbarAl: 0 }), 'right');
});

test('shouldShow enforces all visibility gates and supports hasContent or hasSong', () => {
  const base = {
    enabled: true,
    hasContent: true,
    fullscreen: false,
    hasGap: true,
    hasFallback: false,
    windowAlive: true,
  };
  assert.equal(shouldShow(base), true);
  assert.equal(shouldShow({ ...base, hasGap: false, hasFallback: true }), true);
  assert.equal(shouldShow({ ...base, hasGap: false, hasFallback: false }), false);
  assert.equal(shouldShow({ ...base, enabled: false }), false);
  assert.equal(shouldShow({ ...base, hasContent: false }), false);
  assert.equal(shouldShow({ ...base, fullscreen: true }), false);
  assert.equal(shouldShow({ ...base, windowAlive: false }), false);
  assert.equal(shouldShow({ ...base, hasContent: undefined, hasSong: true }), true);
  assert.equal(shouldShow({ ...base, hasContent: undefined, hasSong: false }), false);
});

test('shouldCoalesceProbe only coalesces matching non-null window keys', () => {
  assert.equal(shouldCoalesceProbe('1:2', '1:2'), true);
  assert.equal(shouldCoalesceProbe('1:2', '3:2'), false);
  assert.equal(shouldCoalesceProbe(null, '1:2'), false);
  assert.equal(shouldCoalesceProbe('1:2', undefined), false);
});

test('selectGap finds widest usable gap on preferred side and falls back to opposite side', () => {
  // Win11 centered taskbar: buttons in the middle (700..1220) and tray on the right (1650..1920)
  const centeredButtons = [
    { x: 0, w: 120, h: 48 }, // widgets button on far left
    { x: 700, w: 48, h: 48 },
    { x: 750, w: 470, h: 48 },
    { x: 1650, w: 270, h: 48 },
    { x: 300, w: 100, h: 10 }, // short non-button decoration, must be ignored
  ];

  const leftGap = selectGap({
    taskbarWidth: 1920,
    taskbarHeight: 48,
    buttons: centeredButtons,
    side: 'left',
  });
  assert.deepEqual(leftGap, { left: 120, right: 700 });

  // Crowded left side (< MIN_GAP_CSS) -> automatically falls back to usable right side
  const crowdedLeft = [
    { x: 0, w: 800, h: 48 },
    { x: 1700, w: 220, h: 48 },
  ];
  const fallbackRight = selectGap({
    taskbarWidth: 1920,
    taskbarHeight: 48,
    buttons: crowdedLeft,
    side: 'left',
  });
  assert.deepEqual(fallbackRight, { left: 800, right: 1700 });

  // No usable gap anywhere -> returns null
  const noRoom = [{ x: 0, w: 1800, h: 48 }];
  assert.equal(
    selectGap({ taskbarWidth: 1920, taskbarHeight: 48, buttons: noRoom, side: 'right' }),
    null
  );
});

test('clampWindowWidth respects min window width, padding, margins, and returns 0 when too narrow', () => {
  assert.equal(clampWindowWidth({ contentWidthCss: 100, gapWidthCss: 500 }), MIN_WINDOW_CSS);
  assert.equal(clampWindowWidth({ contentWidthCss: 300, gapWidthCss: 500 }), 324);
  assert.equal(
    clampWindowWidth({ contentWidthCss: 600, gapWidthCss: 400 }),
    400 - 2 * DOCK_MARGIN_CSS
  );
  assert.equal(clampWindowWidth({ contentWidthCss: 200, gapWidthCss: 150 }), 0);
});

test('computeLegacyTaskbarLayout squeezes task list when needed and skips move when space already exists', () => {
  const squeezed = computeLegacyTaskbarLayout({
    rebarClientOrigin: { x: 100, y: 1040 },
    rebarClientSize: { width: 1500, height: 40 },
    taskbarClientOrigin: { x: 0, y: 1040 },
    taskListRect: { left: 100, top: 1040, right: 1600, bottom: 1080 },
    stripWidthPx: 400,
    reserveWidthPx: 400,
  });

  assert.deepEqual(squeezed, {
    strip: { x: 100 + (1500 - 8 - 400), y: 0, width: 400, height: 40 },
    taskList: { x: 0, y: 0, width: 1500 - (400 + 16), height: 40 },
  });

  // Task list already leaves >= needed space on the right -> taskList is null
  const alreadyFits = computeLegacyTaskbarLayout({
    rebarClientOrigin: { x: 100, y: 1040 },
    rebarClientSize: { width: 1500, height: 40 },
    taskbarClientOrigin: { x: 0, y: 1040 },
    taskListRect: { left: 100, top: 1040, right: 900, bottom: 1080 },
    stripWidthPx: 400,
    reserveWidthPx: 400,
  });

  assert.equal(alreadyFits.taskList, null);
  assert.equal(alreadyFits.strip.width, 400);
});

test('computeLegacyVerticalTaskbarLayout computes vertical strip and task list squeeze', () => {
  const layout = computeLegacyVerticalTaskbarLayout({
    rebarClientOrigin: { x: 0, y: 48 },
    rebarClientSize: { width: 62, height: 900 },
    taskbarClientOrigin: { x: 0, y: 0 },
    taskListRect: { left: 0, top: 48, right: 62, bottom: 948 },
    stripLengthPx: 300,
    reserveLengthPx: 300,
  });

  assert.deepEqual(layout, {
    strip: { x: 0, y: 48 + (900 - 8 - 300), width: 62, height: 300 },
    taskList: { x: 0, y: 0, width: 62, height: 900 - (300 + 16) },
  });
});

test('createLegacyLayoutController keeps fixed length capped on long lyrics and re-squeezes after Explorer reset', () => {
  const TRAY = 65950n;
  const REBAR = 131400n;
  const TASKLIST = 131470n;
  const NOTIFY = 131500n;

  // 模拟 Win10 1920x1080 40px 任务栏（与真实诊断日志一致）
  let liveTaskListRect = { left: 392, top: 1040, right: 1662, bottom: 1080 };
  const moves = [];
  const logs = [];

  const controller = createLegacyLayoutController({
    fixedStripCss: FIXED_STRIP_CSS,
    logger: (message, details) => logs.push({ message, details }),
    native: {
      findTaskbarContainer: () => REBAR,
      findTaskList: () => TASKLIST,
      findTrayNotify: () => NOTIFY,
      isWindow: () => true,
      getTaskbarMetrics: (hwnd) => {
        if (hwnd === TRAY) {
          return {
            screenLeft: 0,
            screenTop: 1040,
            clientWidth: 1920,
            clientHeight: 40,
            vertical: false,
            dpiScale: 1,
          };
        }
        if (hwnd === REBAR) {
          return {
            screenLeft: 392,
            screenTop: 1040,
            clientWidth: 1270,
            clientHeight: 40,
            vertical: false,
            dpiScale: 1,
          };
        }
        return null;
      },
      getWindowRect: (hwnd) => {
        if (hwnd === TASKLIST) return { ...liveTaskListRect };
        if (hwnd === NOTIFY) return { left: 1662, top: 1040, right: 1920, bottom: 1080 };
        return null;
      },
      moveWindow: (hwnd, rect) => {
        moves.push({ hwnd, rect });
        if (hwnd === TASKLIST) {
          liveTaskListRect = {
            left: 392 + rect.x,
            top: 1040 + rect.y,
            right: 392 + rect.x + rect.width,
            bottom: 1040 + rect.y + rect.height,
          };
        }
        return true;
      },
    },
  });

  // 1) 短歌词行：固定预留 400px，任务列表从 1270 压缩到 854
  const first = controller.apply({ trayHwnd: TRAY, widthCss: 300 });
  assert.equal(first.ok, true);
  assert.equal(first.bounds.width, 400);
  assert.equal(first.bounds.x, 1254);
  assert.equal(first.taskListMoved, true);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].rect.width, 854);

  // 2) 长歌词行（482px > 400px）：固定宽度模式必须封顶在 400px，不能再次移动任务列表
  const longLine = controller.apply({ trayHwnd: TRAY, widthCss: 482 });
  assert.equal(longLine.ok, true);
  assert.equal(longLine.bounds.width, 400);
  assert.equal(longLine.bounds.x, 1254);
  assert.equal(longLine.taskListMoved, false);
  assert.equal(moves.length, 1);

  // 3) Explorer 将 MSTaskSwWClass 拉回满宽 1270：下一次 apply 必须检测到实时宽度变化并重新压缩
  liveTaskListRect = { left: 392, top: 1040, right: 1662, bottom: 1080 };
  const afterReset = controller.apply({ trayHwnd: TRAY, widthCss: 300 });
  assert.equal(afterReset.ok, true);
  assert.equal(afterReset.taskListMoved, true);
  assert.equal(moves.length, 2);
  assert.equal(moves[1].rect.width, 854);
  // 目标宽度未变时不重复刷屏日志
  assert.equal(
    logs.filter((entry) => entry.message === 'Win10 layout: task list squeezed for the taskbar widget')
      .length,
    1
  );

  // 4) restore() 恢复任务列表至基线宽度 1270
  controller.restore();
  assert.equal(moves.length, 3);
  assert.equal(moves[2].rect.width, 1270);
});
