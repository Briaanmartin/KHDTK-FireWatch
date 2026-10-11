import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pointInRing, insideGeometry, insideBoundary, distanceToBoundaryKm,
  normalizeConfidence, filterDetections, toCSV,
} from '../core.mjs';

const square = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
const hole = [[0.004, 0.004], [0.006, 0.004], [0.006, 0.006], [0.004, 0.006], [0.004, 0.004]];
const polygon = coordinates => ({ type: 'Polygon', coordinates });
const collection = (...geometries) => ({
  type: 'FeatureCollection',
  features: geometries.map(geometry => ({ type: 'Feature', properties: {}, geometry })),
});
const actualBoundary = JSON.parse(readFileSync(new URL('../data/boundary.geojson', import.meta.url), 'utf8'));

test('point in ring includes outer edges and vertices for either winding', () => {
  for (const ring of [square, [...square].reverse()]) {
    assert.equal(pointInRing([0.005, 0.005], ring), true);
    assert.equal(pointInRing([0, 0.005], ring), true);
    assert.equal(pointInRing([0.01, 0.01], ring), true);
    assert.equal(pointInRing([0.01001, 0.005], ring), false);
    assert.equal(pointInRing([-0.00001, 0], ring), false);
  }
});

test('concave rings reject points inside their bounding box but outside the polygon', () => {
  const concave = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3], [0, 0]];
  assert.equal(pointInRing([0.5, 2], concave), true);
  assert.equal(pointInRing([2, 2], concave), false);
});

test('polygon holes exclude their interior and perimeter', () => {
  const geometry = polygon([square, hole]);
  assert.equal(insideGeometry([0.002, 0.005], geometry), true);
  assert.equal(insideGeometry([0.005, 0.005], geometry), false);
  assert.equal(insideGeometry([0.004, 0.005], geometry), false);
  assert.equal(insideGeometry([0, 0.005], geometry), true);
});

test('multipolygons evaluate all components and preserve holes', () => {
  const shifted = square.map(([x, y]) => [x + 0.02, y]);
  const geometry = { type: 'MultiPolygon', coordinates: [[square, hole], [shifted]] };
  assert.equal(insideGeometry([0.025, 0.005], geometry), true);
  assert.equal(insideGeometry([0.005, 0.005], geometry), false);
  assert.equal(insideGeometry([0.015, 0.005], geometry), false);
  assert.equal(insideGeometry([0.005, 0.005], { type: 'Point', coordinates: [0.005, 0.005] }), false);
});

test('feature collections check every boundary feature', () => {
  const shifted = square.map(([x, y]) => [x + 0.02, y]);
  const boundary = collection(polygon([square]), polygon([shifted]));
  assert.equal(insideBoundary([0.025, 0.005], boundary), true);
  assert.equal(insideBoundary([0.015, 0.005], boundary), false);
});

test('real SHP polygon contains the Lempake centroid and rejects an enclosing-box corner', () => {
  assert.equal(insideBoundary([117.2152940492985, -0.44883709711744263], actualBoundary), true);
  // This point falls within the SHP bounding box but outside its angled perimeter.
  assert.equal(insideBoundary([117.2033, -0.4385], actualBoundary), false);
  assert.equal(insideBoundary([117.24, -0.45], actualBoundary), false);
  assert.equal(insideBoundary([-0.44883709711744263, 117.2152940492985], actualBoundary), false);
});

test('distance is zero inside the boundary and on its perimeter', () => {
  const boundary = collection(polygon([square]));
  assert.equal(distanceToBoundaryKm([0.005, 0.005], boundary), 0);
  assert.equal(distanceToBoundaryKm([0.01, 0.005], boundary), 0);
  assert.equal(distanceToBoundaryKm([117.2152940492985, -0.44883709711744263], actualBoundary), 0);
});

test('distance finds the nearest edge or endpoint in kilometres', () => {
  const boundary = collection(polygon([square]));
  // 0.01 degree of longitude near the equator is approximately 1.112 km.
  assert.ok(Math.abs(distanceToBoundaryKm([0.02, 0.005], boundary) - 1.11195) < 0.0001);
  // A point beyond both north/east extents is nearest to the corner.
  assert.ok(Math.abs(distanceToBoundaryKm([0.02, 0.02], boundary) - 1.57254) < 0.0001);
});

test('distance considers interior hole boundaries and all multipolygon components', () => {
  const donut = collection(polygon([square, hole]));
  assert.ok(Math.abs(distanceToBoundaryKm([0.005, 0.005], donut) - 0.111195) < 0.00001);
  const shifted = square.map(([x, y]) => [x + 0.02, y]);
  const multi = collection({ type: 'MultiPolygon', coordinates: [[square], [shifted]] });
  assert.ok(Math.abs(distanceToBoundaryKm([0.018, 0.005], multi) - 0.22239) < 0.00001);
});

test('confidence normalization handles published category labels and unknown values', () => {
  for (const value of ['h', 'HIGH', 'tinggi']) assert.equal(normalizeConfidence(value), 'high');
  for (const value of ['n', 'Nominal', 'medium', 'sedang']) assert.equal(normalizeConfidence(value), 'nominal');
  for (const value of ['l', 'LOW', 'rendah']) assert.equal(normalizeConfidence(value), 'low');
  for (const value of [null, undefined, '', 'unavailable']) assert.equal(normalizeConfidence(value), 'unknown');
});

const now = Date.parse('2026-10-11T12:00:00.000Z');
function detection(id, offsetMs, confidence = 'high', inside = true) {
  return {
    type: 'Feature', id,
    geometry: { type: 'Point', coordinates: [117.215, -0.449] },
    properties: {
      detected_at: new Date(now + offsetMs).toISOString(), satellite: 'NOAA-20',
      instrument: 'VIIRS', confidence, inside, frp: 12.5,
      distance_km: inside ? 0 : 1.23456, source: 'NASA FIRMS',
    },
  };
}

test('time filter includes both interval endpoints and excludes future or invalid timestamps', () => {
  const hours = 24;
  const invalid = detection('invalid', 0);
  invalid.properties.detected_at = 'not-a-timestamp';
  const features = [
    detection('lower-endpoint', -hours * 3600000),
    detection('one-ms-too-old', -hours * 3600000 - 1),
    detection('now', 0), detection('one-ms-in-future', 1), invalid,
  ];
  assert.deepEqual(filterDetections(features, { now, hours }).map(f => f.id), ['lower-endpoint', 'now']);
});

test('confidence, scope, and time filters combine without mutating detections', () => {
  const features = [
    detection('high-inside', -3600000), detection('high-outside', -3600000, 'high', false),
    detection('nominal-inside', -3600000, 'nominal'), detection('old-inside', -169 * 3600000),
  ];
  const before = JSON.stringify(features);
  assert.deepEqual(filterDetections(features, { now, confidence: 'high', scope: 'inside' }).map(f => f.id), ['high-inside']);
  assert.deepEqual(filterDetections(features, { now, scope: 'outside' }).map(f => f.id), ['high-outside']);
  assert.deepEqual(filterDetections(features, { now, confidence: 'nominal' }).map(f => f.id), ['nominal-inside']);
  assert.equal(filterDetections(features, { now }).length, 3);
  assert.equal(JSON.stringify(features), before);
});

test('CSV retains coordinates and UTC time, rounds distance, and escapes quotes/newlines', () => {
  const feature = detection('csv', -3600000, 'high', false);
  feature.properties.source = 'FIRMS, "VIIRS"\nrecord';
  const csv = toCSV([feature]);
  assert.ok(csv.startsWith('\uFEFF"waktu_utc","satelit","sensor","kepercayaan","frp_mw","longitude","latitude","dalam_khdtk","jarak_batas_km","sumber","data_lama"\r\n'));
  assert.ok(csv.endsWith('"2026-10-11T11:00:00.000Z","NOAA-20","VIIRS","high","12.5","117.215","-0.449","false","1.235","FIRMS, ""VIIRS""\nrecord","false"'));
});

test('CSV explicitly marks retained stale detections as data_lama true', () => {
  const feature = detection('retained', -3600000);
  feature.properties.stale = true;
  const csv = toCSV([feature]);
  assert.ok(csv.endsWith('"NASA FIRMS","true"'));
  assert.equal(csv.split('\r\n')[1].split(',').length, 11);
});

test('CSV with no detections still exports the complete header', () => {
  const csv = toCSV([]);
  assert.ok(csv.startsWith('\uFEFF"waktu_utc"'));
  assert.ok(csv.endsWith('"data_lama"'));
  assert.equal(csv.includes('\r\n'), false);
  assert.equal(csv.split(',').length, 11);
});
