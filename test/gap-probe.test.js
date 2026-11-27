import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProbeScript,
  encodePowerShellCommand,
  parseProbeOutput,
} from '../src/gap-probe.js';

test('buildProbeScript only interpolates validated positive safe integers', () => {
  assert.match(buildProbeScript(0), /\$hwndValue = 0\b/);
  assert.match(buildProbeScript(123456n), /\$hwndValue = 123456\b/);
  assert.match(buildProbeScript(-10), /\$hwndValue = 0\b/);
  assert.match(buildProbeScript('123; Write-Host pwned'), /\$hwndValue = 0\b/);
  assert.match(buildProbeScript(Number.MAX_SAFE_INTEGER + 10), /\$hwndValue = 0\b/);
});

test('encodePowerShellCommand encodes script as UTF-16LE Base64', () => {
  const sample = 'Write-Output 42';
  const encoded = encodePowerShellCommand(sample);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), sample);
});

test('parseProbeOutput validates shape, rejects taskbarFound=false, and normalizes fields', () => {
  const valid = parseProbeOutput(
    JSON.stringify({
      buttons: [{ x: 10.9, y: 1040.2, w: 48.5, h: 40.1 }],
      taskbarFound: true,
      taskbarAl: 1,
      lightTaskbar: 0,
      osBuild: 22631,
    })
  );
  assert.deepEqual(valid, {
    buttons: [{ x: 10, y: 1040, w: 48, h: 40 }],
    taskbarAl: 1,
    lightTaskbar: false,
    osBuild: 22631,
  });

  assert.equal(
    parseProbeOutput(
      JSON.stringify({ buttons: [], taskbarFound: false, taskbarAl: 1, lightTaskbar: 1, osBuild: 22631 })
    ),
    null
  );
  assert.equal(parseProbeOutput('not json'), null);
  assert.equal(parseProbeOutput(JSON.stringify({ buttons: [{}], osBuild: 22631 })), null);
  assert.equal(parseProbeOutput(JSON.stringify({ buttons: [], osBuild: 'bad' })), null);
});
