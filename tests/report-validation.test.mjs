import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhoto, validateCoordinates, validateReport, exportReportHTML } from '../reports.mjs';

const report = { title: 'Pemeriksaan blok', observedAt: '2026-10-11T14:30', latitude: -0.449, longitude: 117.215, notes: 'Tidak terlihat asap.' };
test('accepts bounded image formats and rejects disguised unsupported types or oversize files', () => {
  assert.doesNotThrow(() => validatePhoto({ type: 'image/jpeg', size: 100 }));
  for (const file of [null, { type: 'image/svg+xml', size: 5 }, { type: 'image/png', size: 0 }, { type: 'image/webp', size: 10 * 1024 * 1024 + 1 }]) assert.throws(() => validatePhoto(file));
});
test('validates real WITA dates and required trimmed fields', () => {
  assert.equal(validateReport({ ...report, title: '  Patroli  ' }).title, 'Patroli');
  for (const changes of [{ title: ' ' }, { latitude: undefined }, { longitude: undefined }, { observedAt: '2026-02-30T12:00' }, { observedAt: '2026-10-11T25:00' }, { observedAt: 'invalid' }, { notes: 'x'.repeat(3001) }]) assert.throws(() => validateReport({ ...report, ...changes }));
});

test('requires a finite numeric point and preserves valid zero and geographic limits', () => {
  assert.deepEqual(validateCoordinates({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
  for (const coordinates of [{ latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 }, { latitude: 0, longitude: 117.2 }]) {
    assert.deepEqual(validateCoordinates(coordinates), coordinates);
    assert.equal(validateReport({ ...report, ...coordinates }).latitude, coordinates.latitude);
  }
  for (const coordinates of [undefined, {}, { latitude: 0 }, { latitude: null, longitude: 0 }, { latitude: '', longitude: 0 }, { latitude: '0', longitude: '117' }, { latitude: 0, longitude: NaN }, { latitude: Infinity, longitude: 0 }, { latitude: -90.01, longitude: 0 }, { latitude: 0, longitude: 180.01 }]) assert.throws(() => validateCoordinates(coordinates));
});

test('exports legacy text locations but requires map points for new reports', () => {
  const oldReport = { title: 'Laporan lama', observedAt: report.observedAt, location: 'Blok A <utara>', notes: report.notes };
  assert.throws(() => validateReport(oldReport));
  const html = exportReportHTML(oldReport, 'data:image/png;base64,aGVsbG8=');
  assert.ok(html.includes('Blok A &lt;utara&gt;'));
  assert.ok(html.includes('laporan lama'));
  assert.throws(() => exportReportHTML({ ...oldReport, latitude: NaN, longitude: 117 }, 'data:image/png;base64,aGVsbG8='));
});
test('exports escaped user content and restricts self-contained photo URLs', () => {
  const html = exportReportHTML({ ...report, title: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)> & "test"' }, 'data:image/png;base64,aGVsbG8=');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('14.30 WITA'));
  assert.ok(html.includes('data:image/png;base64,aGVsbG8='));
  assert.ok(html.includes('-0.449000, 117.215000'));
  assert.ok(html.includes('https://www.openstreetmap.org/?mlat=-0.449'));
  assert.throws(() => exportReportHTML(report, 'javascript:alert(1)'));
  assert.throws(() => exportReportHTML(report, 'data:image/svg+xml;base64,aGVsbG8='));
});

test('exports a zero coordinate point and explicit outside-AOI context without inventing a text location', () => {
  const html = exportReportHTML({ ...report, latitude: 0, longitude: 0, insideAOI: false }, 'data:image/png;base64,aGVsbG8=');
  assert.ok(html.includes('0.000000, 0.000000'));
  assert.ok(html.includes('Di luar batas AOI KHDTK'));
  assert.ok(!html.includes('Lokasi / blok'));
});
