import test from 'node:test';
import assert from 'node:assert';
import {
  formatFps,
  getFpsFontSize,
  stepFpsAnimation,
  computeMinCustomFps,
  computeFpsRows,
  getCustomFpsHint,
  checkCustomVal,
  clampCustomVal,
} from '../app/src/shell/fpsStrip.ts';

test('formatFps: round to at most two decimals', () => {
  assert.strictEqual(formatFps(24), '24');
  assert.strictEqual(formatFps(60), '60');
  assert.strictEqual(formatFps(120), '120');
  assert.strictEqual(formatFps(23.976), '23.98');
  assert.strictEqual(formatFps(29.97), '29.97');
  assert.strictEqual(formatFps(59.94), '59.94');
  assert.strictEqual(formatFps(23.976 * 2), '47.95');
  assert.strictEqual(formatFps(23.976 * 3), '71.93');
  assert.strictEqual(formatFps(23.976 * 4), '95.9');
});

test('computeFpsRows for 24 fps: 48 / 72 / 96 / 60 / 120 / Custom', () => {
  const rows = computeFpsRows(24, null);
  assert.strictEqual(rows.length, 6);
  assert.deepStrictEqual(
    rows.map((r) => r.label),
    ['2×', '3×', '4×', '60', '120', 'Custom']
  );
  assert.strictEqual(rows[0].sublabel, '48 fps');
  assert.strictEqual(rows[1].sublabel, '72 fps');
  assert.strictEqual(rows[2].sublabel, '96 fps');
  assert.strictEqual(rows[3].sublabel, 'fps');
  assert.strictEqual(rows[4].sublabel, 'fps');
  assert.strictEqual(rows[5].sublabel, 'fps');
  assert.strictEqual(rows.every((r) => !r.disabled), true);
});

test('computeFpsRows for 60 fps: 120 / 180 / 240 / 144 / Custom', () => {
  const rows = computeFpsRows(60, null);
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(
    rows.map((r) => r.label),
    ['2×', '3×', '4×', '144', 'Custom']
  );
  assert.strictEqual(rows[0].sublabel, '120 fps');
  assert.strictEqual(rows[1].sublabel, '180 fps');
  assert.strictEqual(rows[2].sublabel, '240 fps');
  assert.strictEqual(rows[3].sublabel, 'fps');
  assert.strictEqual(rows[4].sublabel, 'fps');
});

test('computeFpsRows for 30 fps: 60 / 90 / 120 / 144 / 240 / Custom', () => {
  const rows = computeFpsRows(30, null);
  assert.strictEqual(rows.length, 6);
  assert.deepStrictEqual(
    rows.map((r) => r.label),
    ['2×', '3×', '4×', '144', '240', 'Custom']
  );
  assert.strictEqual(rows[0].sublabel, '60 fps');
  assert.strictEqual(rows[1].sublabel, '90 fps');
  assert.strictEqual(rows[2].sublabel, '120 fps');
});

test('computeFpsRows for 23.976 fps: non-integer source rounding', () => {
  const rows = computeFpsRows(23.976, null);
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(rows[0].sublabel, '47.95 fps');
  assert.strictEqual(rows[1].sublabel, '71.93 fps');
  assert.strictEqual(rows[2].sublabel, '95.9 fps');
  assert.strictEqual(rows[3].label, '60');
  assert.strictEqual(rows[4].label, '120');
});

test('computeFpsRows for high fps: multipliers above 240 are dimmed & disabled', () => {
  const rows = computeFpsRows(100, null);
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(rows[0].label, '2×');
  assert.strictEqual(rows[0].disabled, false);
  assert.strictEqual(rows[1].label, '3×');
  assert.strictEqual(rows[1].disabled, true);
  assert.strictEqual(rows[1].title, 'Above 240 fps');
  assert.strictEqual(rows[2].label, '4×');
  assert.strictEqual(rows[2].disabled, true);
  assert.strictEqual(rows[2].title, 'Above 240 fps');
});

test('computeFpsRows for empty/null sourceFps: default placeholders', () => {
  const rows = computeFpsRows(null, null);
  assert.strictEqual(rows.length, 6);
  assert.strictEqual(rows[0].sublabel, 'Double');
  assert.strictEqual(rows[1].sublabel, 'Triple');
  assert.strictEqual(rows[2].sublabel, 'Quad');
  assert.strictEqual(rows[3].sublabel, 'fps');
  assert.strictEqual(rows[4].sublabel, 'fps');
  assert.strictEqual(rows[5].sublabel, 'fps');
});

test('computeFpsRows with applied custom value: Custom reads <val> fps', () => {
  const rows = computeFpsRows(24, 90);
  assert.strictEqual(rows[5].label, 'Custom');
  assert.strictEqual(rows[5].sublabel, '90 fps');
});

test('checkCustomVal and getCustomFpsHint: hint text rule handles valid, empty, and bounds', () => {
  assert.deepStrictEqual(checkCustomVal('', 24), { err: 'NUMBER' });
  assert.deepStrictEqual(checkCustomVal('abc', 24), { err: 'NUMBER' });
  assert.deepStrictEqual(checkCustomVal('24', 24), { v: 24, err: 'MIN 25' });
  assert.deepStrictEqual(checkCustomVal('10', 24), { v: 10, err: 'MIN 25' });
  assert.deepStrictEqual(checkCustomVal('60', 60), { v: 60, err: 'MIN 61' });
  assert.deepStrictEqual(checkCustomVal('250', 24), { v: 250, err: 'MAX 240' });
  assert.deepStrictEqual(checkCustomVal('90', 24), { v: 90 });
  assert.deepStrictEqual(checkCustomVal('25', 24), { v: 25 });
  assert.deepStrictEqual(checkCustomVal('240', 24), { v: 240 });

  // One short line in mono label style replacing FPS:
  // - Valid: <min>–240 FPS (muted) with en dash (\u2013), NOT hyphen (-)
  const validHint60 = getCustomFpsHint('90', 60);
  assert.deepStrictEqual(validHint60, { text: '61\u2013240 FPS', isError: false, v: 90 });
  assert.strictEqual(validHint60.text.includes('\u2013'), true);
  assert.strictEqual(validHint60.text.includes('-'), false);
  assert.strictEqual(validHint60.text.charCodeAt(2), 8211); // en dash \u2013
  assert.deepStrictEqual(getCustomFpsHint('61', 60), { text: '61\u2013240 FPS', isError: false, v: 61 });
  assert.deepStrictEqual(getCustomFpsHint('240', 60), { text: '61\u2013240 FPS', isError: false, v: 240 });
  assert.deepStrictEqual(getCustomFpsHint('50', 60), { text: 'MIN 61', isError: true, v: 50 });
  assert.deepStrictEqual(getCustomFpsHint('300', 60), { text: 'MAX 240', isError: true, v: 300 });
  assert.deepStrictEqual(getCustomFpsHint('', 60), { text: 'NUMBER', isError: true });
  assert.deepStrictEqual(getCustomFpsHint('abc', 60), { text: 'NUMBER', isError: true });

  // With source 24 (min 25)
  const validHint24 = getCustomFpsHint('90', 24);
  assert.deepStrictEqual(validHint24, { text: '25\u2013240 FPS', isError: false, v: 90 });
  assert.strictEqual(validHint24.text.charCodeAt(2), 8211);
  assert.deepStrictEqual(getCustomFpsHint('20', 24), { text: 'MIN 25', isError: true, v: 20 });
  assert.deepStrictEqual(getCustomFpsHint('250', 24), { text: 'MAX 240', isError: true, v: 250 });
});

test('clampCustomVal: corrects to nearest valid range [minCustomFps, 240]', () => {
  // Source = 24 -> min is 25
  assert.strictEqual(computeMinCustomFps(24), 25);
  assert.strictEqual(clampCustomVal(10, 24), 25);
  assert.strictEqual(clampCustomVal(24, 24), 25);
  assert.strictEqual(clampCustomVal(25, 24), 25);
  assert.strictEqual(clampCustomVal(90, 24), 90);
  assert.strictEqual(clampCustomVal(240, 24), 240);
  assert.strictEqual(clampCustomVal(300, 24), 240);

  // Source = 60 -> min is 61
  assert.strictEqual(computeMinCustomFps(60), 61);
  assert.strictEqual(clampCustomVal(50, 60), 61);
  assert.strictEqual(clampCustomVal(60, 60), 61);
  assert.strictEqual(clampCustomVal(61, 60), 61);
  assert.strictEqual(clampCustomVal(144, 60), 144);
  assert.strictEqual(clampCustomVal(250, 60), 240);

  // Fallback when undefined
  assert.strictEqual(clampCustomVal(undefined, 24, 90), 90);
  assert.strictEqual(clampCustomVal(undefined, 24, null), 25);
});

test('getFpsFontSize: fitting rule by character count of final value', () => {
  // 1-3 chars -> current size (46)
  assert.strictEqual(getFpsFontSize(60), 46);
  assert.strictEqual(getFpsFontSize(120), 46);
  assert.strictEqual(getFpsFontSize(240), 46);
  assert.strictEqual(getFpsFontSize('90'), 46);
  assert.strictEqual(getFpsFontSize(null), 46);
  assert.strictEqual(getFpsFontSize(undefined), 46);

  // 4-5 chars -> smaller size (30)
  // Non-integer sources at most 2 decimals
  assert.strictEqual(getFpsFontSize(95.9), 30); // '95.9' -> 4 chars
  assert.strictEqual(getFpsFontSize(47.95), 30); // '47.95' -> 5 chars
  assert.strictEqual(getFpsFontSize(71.93), 30); // '71.93' -> 5 chars
  assert.strictEqual(getFpsFontSize('100.5'), 30); // 5 chars

  // 6 or more chars -> smaller again (24)
  assert.strictEqual(getFpsFontSize(176.46), 24); // '176.46' -> 6 chars
  assert.strictEqual(getFpsFontSize(239.76), 24); // '239.76' -> 6 chars
  assert.strictEqual(getFpsFontSize('123456'), 24);
  assert.strictEqual(getFpsFontSize('1234567'), 24);
});

test('stepFpsAnimation: whole numbers mid-animation and exact final value on completion', () => {
  // Animating between integer endpoints
  const mid1 = stepFpsAnimation(24, 60, 0.5);
  assert.strictEqual(Number.isInteger(mid1), true);
  assert.strictEqual(stepFpsAnimation(24, 60, 1.0), 60);
  assert.strictEqual(stepFpsAnimation(24, 60, 1.5), 60);

  // Animating to non-integer target (e.g. 71.93)
  const steps = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99];
  for (const p of steps) {
    const val = stepFpsAnimation(24, 71.93, p);
    // Mid-animation must show whole numbers only
    assert.strictEqual(Number.isInteger(val), true, `Progress ${p} produced non-integer ${val}`);
  }

  // Exact target value when complete (progress >= 1.0)
  assert.strictEqual(stepFpsAnimation(24, 71.93, 1.0), 71.93);
  assert.strictEqual(stepFpsAnimation(60, 176.46, 1.0), 176.46);
  assert.strictEqual(stepFpsAnimation(24, 47.95, 1.0), 47.95);
});
