import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLegacyLayoutController,
  createTaskbarWidget,
  getOsBuild,
  isFullscreenRect,
  isLegacyBuild,
} from '../src/index.js';

test('isFullscreenRect checks whether a window rect covers the monitor bounds', () => {
  const monitor = { x: 0, y: 0, width: 2560, height: 1440 };
  assert.equal(
    isFullscreenRect({ left: 0, top: 0, right: 2560, bottom: 1440 }, monitor),
    true
  );
  assert.equal(
    isFullscreenRect({ left: -8, top: -8, right: 2568, bottom: 1448 }, monitor),
    true
  );
  assert.equal(
    isFullscreenRect({ left: 0, top: 0, right: 2559, bottom: 1440 }, monitor),
    false
  );
  assert.equal(isFullscreenRect(null, monitor), false);

  // Secondary monitor with negative X origin
  const secondary = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.equal(
    isFullscreenRect({ left: -1920, top: 0, right: 0, bottom: 1080 }, secondary),
    true
  );
});

test('root module imports cleanly in plain Node without Electron and exposes safe defaults', () => {
  const build = getOsBuild();
  assert.equal(typeof build, 'number');
  if (process.platform === 'win32') {
    assert.ok(build > 0);
  } else {
    assert.equal(build, 0);
    assert.equal(isLegacyBuild(), false);
  }

  const legacy = createLegacyLayoutController();
  assert.equal(legacy.isUsable(), true);
  assert.deepEqual(legacy.apply({ trayHwnd: null, widthCss: 300 }), {
    ok: false,
    reason: 'unsupported',
  });
  assert.deepEqual(legacy.apply({ trayHwnd: 1n, widthCss: 0 }), {
    ok: false,
    reason: 'waiting',
  });
  legacy.reset();

  const host = createTaskbarWidget({ htmlPath: 'widget.html' });
  const state = host.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.running, false);
  assert.equal(state.visible, false);
  assert.equal(host.getWindow(), null);
  host.dispose();
});
