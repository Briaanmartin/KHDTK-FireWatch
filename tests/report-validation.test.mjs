import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePhoto, validateReport, exportReportHTML } from '../reports.mjs';

const report = { title: 'Pemeriksaan blok', observedAt: '2026-10-11T14:30', location: 'Blok A', notes: 'Tidak terlihat asap.' };
test('accepts bounded image formats and rejects disguised unsupported types or oversize files', () => {
  assert.doesNotThrow(() => validatePhoto({ type: 'image/jpeg', size: 100 }));
  for (const file of [null, { type: 'image/svg+xml', size: 5 }, { type: 'image/png', size: 0 }, { type: 'image/webp', size: 10 * 1024 * 1024 + 1 }]) assert.throws(() => validatePhoto(file));
});
test('validates real WITA dates and required trimmed fields', () => {
  assert.equal(validateReport({ ...report, title: '  Patroli  ' }).title, 'Patroli');
  for (const changes of [{ title: ' ' }, { location: ' ' }, { observedAt: '2026-02-30T12:00' }, { observedAt: '2026-10-11T25:00' }, { observedAt: 'invalid' }, { notes: 'x'.repeat(3001) }]) assert.throws(() => validateReport({ ...report, ...changes }));
});
test('exports escaped user content and restricts self-contained photo URLs', () => {
  const html = exportReportHTML({ ...report, title: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)> & "test"' }, 'data:image/png;base64,aGVsbG8=');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('14.30 WITA'));
  assert.ok(html.includes('data:image/png;base64,aGVsbG8='));
  assert.throws(() => exportReportHTML(report, 'javascript:alert(1)'));
  assert.throws(() => exportReportHTML(report, 'data:image/svg+xml;base64,aGVsbG8='));
});
