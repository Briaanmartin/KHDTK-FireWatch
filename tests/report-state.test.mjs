import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicReport, fetchPublicReports } from '../reports.mjs';

let moduleId = 0;
const freshState = () => import(`../report-state.mjs?test=${++moduleId}`);
const report = (id, coordinates = {}) => ({
  id, title: `Pengamatan ${id}`, observedAt: '2026-10-12T08:00',
  latitude: -0.449, longitude: 117.215, notes: 'Kondisi lapangan', ...coordinates
});

test('subscriber mounted before storage load receives the later saved reports', async () => {
  const state = await freshState(), received = [];
  const unsubscribe = state.subscribeReports(reports => received.push(reports));
  assert.deepEqual(received, [[]]);
  state.publishReports([report('one')]);
  assert.equal(received.length, 2);
  assert.equal(received[1][0].id, 'one');
  unsubscribe();
});

test('subscriber mounted after storage load immediately receives existing reports', async () => {
  const state = await freshState();
  state.publishReports([report('existing')]);
  let current;
  state.subscribeReports(reports => { current = reports; });
  assert.equal(current[0].id, 'existing');
  assert.equal(current, state.getReports());
});

test('save and deletion replace the complete snapshot and unsubscribe stops updates', async () => {
  const state = await freshState(), ids = [];
  const unsubscribe = state.subscribeReports(reports => ids.push(reports.map(item => item.id)));
  state.publishReports([report('one')]);
  state.publishReports([report('two'), report('one')]);
  state.publishReports([report('two')]);
  state.publishReports([]);
  unsubscribe();
  state.publishReports([report('after-unsubscribe')]);
  assert.deepEqual(ids, [[], ['one'], ['two', 'one'], ['two'], []]);
});

test('snapshots preserve zero coordinates, legacy records, and the photo Blob', async () => {
  const state = await freshState(), photo = new Blob(['photo bytes'], { type: 'image/jpeg' });
  const legacy = { id: 'old', title: 'Laporan lama', location: 'Blok utara', photo };
  state.publishReports([{ ...report('zero', { latitude: 0, longitude: 0 }), photo }, legacy]);
  const [point, old] = state.getReports();
  assert.equal(point.latitude, 0);
  assert.equal(point.longitude, 0);
  assert.equal(point.photo, photo);
  assert.equal(point.notes, 'Kondisi lapangan');
  assert.equal(old.location, 'Blok utara');
  assert.equal(old.latitude, undefined);
  assert.equal(old.photo, photo);
});

test('producer and consumer cannot unintentionally mutate an existing snapshot', async () => {
  const state = await freshState(), original = report('one'), input = [original];
  state.publishReports(input);
  const snapshot = state.getReports();
  original.title = 'Changed in gallery';
  input.push(report('two'));
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].title, 'Pengamatan one');
  assert.throws(() => { snapshot[0].title = 'Changed by map'; }, TypeError);
  assert.throws(() => { snapshot.push(report('three')); }, TypeError);
  state.publishReports([]);
  assert.equal(snapshot.length, 1);
});

test('public status distinguishes first load, success, and failed refresh while replaying the latest state', async () => {
  const state = await freshState(), received = [];
  const unsubscribe = state.subscribeReportStatus(value => received.push(value));
  assert.equal(received[0].state, 'loading');
  assert.equal(received[0].hasLoaded, false);
  state.publishReportStatus({ state: 'ready', publicCount: 2, hasLoaded: true, message: 'Loaded' });
  state.publishReportStatus({ state: 'error', publicCount: 2, hasLoaded: true, message: 'Refresh failed' });
  let replay;
  const stop = state.subscribeReportStatus(value => { replay = value; });
  assert.equal(replay, state.getReportStatus());
  assert.equal(replay.publicCount, 2);
  assert.equal(replay.state, 'error');
  assert.throws(() => { replay.publicCount = 0; }, TypeError);
  unsubscribe(); stop();
  state.publishReportStatus({ state: 'ready', publicCount: 0, hasLoaded: true, message: 'Empty' });
  assert.equal(received.length, 3);
});

const serviceUrl = 'https://reports.example.test';
const publicReport = (id, extra = {}) => ({ ...report(id), createdAt: '2026-10-12T01:00:00Z', photoUrl: `/api/reports/${id}/photo`, ...extra });

test('public reports retain plain text and only allow the matching service photo URL', () => {
  const item = normalizePublicReport(publicReport('one', { title: '<img onerror=alert(1)>', notes: '<script>text</script>' }), serviceUrl);
  assert.equal(item.photoUrl, `${serviceUrl}/api/reports/one/photo`);
  assert.equal(item.title, '<img onerror=alert(1)>');
  for (const photoUrl of ['https://other.example.test/api/reports/one/photo', '/api/reports/two/photo', '/api/reports/one/photo?url=external', 'javascript:alert(1)', '//reports.example.test@other.example.test/api/reports/one/photo']) {
    assert.throws(() => normalizePublicReport(publicReport('one', { photoUrl }), serviceUrl), /foto/);
  }
  assert.throws(() => normalizePublicReport(publicReport('../one'), serviceUrl), /ID/);
  assert.throws(() => normalizePublicReport(publicReport('one', { latitude: 91 }), serviceUrl), /Koordinat/);
});

test('public reports follow cursor pages anonymously and deduplicate IDs', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => requests.length === 1
      ? { reports: [publicReport('one')], nextCursor: 'page 2&value' }
      : { reports: [publicReport('one'), publicReport('two', { createdAt: '2026-10-12T02:00:00Z' })], nextCursor: null } };
  };
  const loaded = await fetchPublicReports(serviceUrl, fetcher);
  assert.deepEqual(loaded.map(item => item.id), ['two', 'one']);
  assert.equal(new URL(requests[1].url).searchParams.get('cursor'), 'page 2&value');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('public report errors do not return a false empty or partial snapshot', async () => {
  await assert.rejects(fetchPublicReports(serviceUrl, async () => ({ ok: false })), /belum dapat dimuat/);
  await assert.rejects(fetchPublicReports(serviceUrl, async () => ({ ok: true, json: async () => ({ reports: null }) })), /Format/);
  await assert.rejects(fetchPublicReports(serviceUrl, async () => ({ ok: true, json: async () => ({ reports: [publicReport('one')], nextCursor: 'repeat' }) })), /Halaman/);
});
