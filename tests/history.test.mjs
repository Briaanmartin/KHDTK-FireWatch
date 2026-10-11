import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_SOURCES, witaYear, mergeIntervals, intersectIntervals, summarizeHistory, historyCSV, historySummaryCSV } from '../history.mjs';

const HOUR = 3600000, DAY = HOUR * 24;
const boundary = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[117, -1], [118, -1], [118, 0], [117, 0], [117, -1]]] } }] };
const record = (time, coordinates = [117.5, -0.5], extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { detected_at: time, satellite: 'S-NPP', instrument: 'VIIRS', confidence: 'high', source: 'NASA FIRMS', product: 'nrt', frp: 3.2, ...extra } });
const archive = (features = [], coverage = []) => ({ type: 'FeatureCollection', schema_version: 1, year: 2026, timezone: 'Asia/Makassar', generated_at: '2026-10-11T15:00:00Z', features, sources: HISTORY_SOURCES.map(source => ({ ...source, coverage })) });
const ms = Date.parse;

test('WITA calendar includes the local new year eight hours before UTC new year', () => {
  assert.equal(witaYear(ms('2025-12-31T15:59:59Z')), 2025);
  assert.equal(witaYear(ms('2025-12-31T16:00:00Z')), 2026);
  const data = archive([
    record('2025-12-31T15:59:59Z'), record('2025-12-31T16:00:00Z'), record('2026-01-01T16:01:00Z'), record('2026-12-31T16:00:00Z'),
  ]);
  const summary = summarizeHistory(data, boundary, ms('2027-01-02T00:00:00Z'));
  assert.equal(summary.count, 2);
  assert.equal(summary.months[0].count, 2);
  assert.equal(summary.detectionDays, 2);
  assert.equal(summary.latest, '2026-01-01T16:01:00Z');
});

test('records are rechecked against geometry, acquisition time, and duplicates, regardless of cached flags', () => {
  const now = ms('2026-10-11T15:00:00Z');
  const valid = record('2026-10-10T05:00:00Z');
  const data = archive([
    valid, { ...valid, properties: { ...valid.properties, id: 'duplicate' } },
    record('2026-10-10T05:00:00Z', [116, -0.5], { inside_aoi: true }),
    record('not-a-time'), record('2026-10-12T00:00:00Z'), record('2026-01-01T00:00:00Z', [NaN, 0]),
    { ...valid, geometry: { type: 'LineString', coordinates: [[117.4, -0.4], [117.5, -0.5]] } },
    record('2026-10-10T05:00:00Z', [117.5, -0.5], { satellite: 'NOAA-20' }), null,
  ]);
  const summary = summarizeHistory(data, boundary, now);
  assert.equal(summary.count, 2);
  assert.equal(summary.detectionDays, 1);
  assert.equal(summary.months[9].state, 'partial');
  assert.ok(summary.features.every(feature => feature.properties.inside_aoi));
});

test('no archive is unknown, an available window with no detections is partial zero, future is distinct', () => {
  const start = '2026-10-04T15:00:00Z', end = '2026-10-11T15:00:00Z';
  const summary = summarizeHistory(archive([], [{ start, end, kind: 'nrt' }]), boundary, ms(end));
  assert.equal(summary.months[0].state, 'unknown');
  assert.equal(summary.months[8].state, 'unknown');
  assert.equal(summary.months[9].state, 'partial');
  assert.equal(summary.months[9].count, 0);
  assert.equal(summary.months[9].covered, 7 * DAY);
  assert.equal(summary.months[10].state, 'future');
  assert.equal(summary.months[11].elapsed, 0);
  assert.equal(summary.complete, false);
  assert.equal(summary.covered, 7 * DAY);
});

test('coverage merges duplicates, clips to the local month, and fully covers only elapsed periods', () => {
  const start = '2025-12-01T00:00:00Z', end = '2026-02-01T16:00:00Z';
  const data = archive([], [{ start, end }, { start: '2026-01-01T00:00:00Z', end: '2026-01-05T00:00:00Z' }]);
  const now = ms('2026-02-02T16:00:00Z');
  const summary = summarizeHistory(data, boundary, now);
  assert.equal(summary.months[0].state, 'complete');
  assert.equal(summary.months[0].covered, 31 * DAY);
  assert.equal(summary.months[1].state, 'partial');
  assert.equal(summary.months[1].covered, DAY);
  assert.equal(summary.months[1].elapsed, 2 * DAY);
  assert.equal(summary.covered, 32 * DAY);
});

test('coverage requires all three sensors and preserves gaps rather than filling first-to-last range', () => {
  const data = archive();
  const start = ms('2026-01-01T00:00:00Z');
  data.sources[0].coverage = [{ start, end: start + 10 * HOUR }];
  data.sources[1].coverage = [{ start: start + HOUR, end: start + 4 * HOUR }, { start: start + 6 * HOUR, end: start + 9 * HOUR }];
  data.sources[2].coverage = [{ start: start + 2 * HOUR, end: start + 8 * HOUR }];
  const summary = summarizeHistory(data, boundary, start + 10 * HOUR);
  assert.equal(summary.covered, 4 * HOUR);
  assert.deepEqual(summary.coverage, [[start + 2 * HOUR, start + 4 * HOUR], [start + 6 * HOUR, start + 8 * HOUR]]);
  assert.equal(summary.complete, false);
  data.sources.pop();
  assert.equal(summarizeHistory(data, boundary, start + 10 * HOUR).covered, 0);
});

test('future coverage is clipped and invalid or reversed intervals contribute nothing', () => {
  const data = archive([], [null, { start: 'bad', end: 'bad' }, { start: '2026-04-01T00:00:00Z', end: '2026-01-01T00:00:00Z' }, { start: '2025-12-31T16:00:00Z', end: '2027-01-01T00:00:00Z' }]);
  const summary = summarizeHistory(data, boundary, ms('2026-01-02T16:00:00Z'));
  assert.equal(summary.covered, 2 * DAY);
  assert.equal(summary.elapsed, 2 * DAY);
  assert.equal(summary.complete, true);
  assert.equal(summary.months[1].state, 'future');
  assert.deepEqual(mergeIntervals([[1, 3], [3, 5], [7, 9], [2, 4]], 2, 8), [[2, 5], [7, 8]]);
  assert.deepEqual(intersectIntervals([[[1, 3]], []]), []);
});

test('CSV contains actual AOI data with WITA time and neutralizes formula-like source fields', () => {
  const summary = summarizeHistory(archive([record('2026-01-01T16:00:00Z', undefined, { source: '=HYPERLINK("https://example.com")' })]), boundary, ms('2026-01-02T00:00:00Z'));
  const csv = historyCSV(summary.features);
  assert.match(csv, /waktu_utc/);
  assert.match(csv, /2 Jan 2026/);
  assert.match(csv, /WITA/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /"-0.5"/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('invalid archive schemas fail visibly instead of reporting a false zero year', () => {
  assert.throws(() => summarizeHistory({ ...archive(), schema_version: 5 }, boundary), /Format arsip/);
  assert.throws(() => summarizeHistory({ ...archive(), timezone: 'UTC' }, boundary), /Format arsip/);
  assert.throws(() => summarizeHistory(archive(), { type: 'FeatureCollection', features: [] }), /Batas kawasan/);
});

test('monthly summary exports partial zero separately from unknown and future blank counts', () => {
  const summary = summarizeHistory(archive([], [{ start: '2026-10-04T15:00:00Z', end: '2026-10-11T15:00:00Z' }]), boundary, ms('2026-10-11T15:00:00Z'));
  const rows = historySummaryCSV(summary).slice(1).split('\r\n').map(line => line.slice(1, -1).split('\",\"'));
  assert.equal(rows.length, 13);
  assert.deepEqual(rows[1].slice(0, 5), ['2026', '1', 'Januari', 'unknown', '']);
  assert.deepEqual(rows[10].slice(0, 6), ['2026', '10', 'Oktober', 'partial', '0', '7']);
  assert.deepEqual(rows[11].slice(0, 5), ['2026', '11', 'November', 'future', '']);
  assert.equal(rows[11][6], '0');
  assert.deepEqual(rows[10].slice(7, 10), ['7', '7', '7']);
  assert.equal(rows[10][10], summary.generatedAt);
  assert.equal(rows[10][11], '2026-10-11T15:00:00.000Z');
  assert.equal(rows[10][12], 'Asia/Makassar');
});

test('monthly summary preserves complete local calendar months and partial per-sensor coverage', () => {
  const data = archive([], [{ start: '2025-12-31T16:00:00Z', end: '2026-02-02T16:00:00Z' }]);
  data.sources[2].coverage = [{ start: '2025-12-31T16:00:00Z', end: '2026-02-01T04:00:00Z' }];
  const summary = summarizeHistory(data, boundary, ms('2026-02-02T16:00:00Z'));
  const rows = historySummaryCSV(summary).slice(1).split('\r\n').map(line => line.slice(1, -1).split('\",\"'));
  assert.deepEqual(rows[1].slice(3, 10), ['complete', '0', '31', '31', '31', '31', '31']);
  assert.deepEqual(rows[2].slice(3, 10), ['partial', '0', '0.5', '2', '2', '2', '0.5']);
  assert.deepEqual(rows[3].slice(3, 7), ['future', '', '0', '0']);
});
