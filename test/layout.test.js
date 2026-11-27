import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampWindowWidth,
  computeLegacyTaskbarLayout,
  computeLegacyVerticalTaskbarLayout,
  DOCK_MARGIN_CSS,
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
