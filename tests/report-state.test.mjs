import test from 'node:test';
import assert from 'node:assert/strict';

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
