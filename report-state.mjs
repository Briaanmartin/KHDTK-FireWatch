// Shared only within this page. Public reports come from the online service;
// private local drafts remain in IndexedDB and are never uploaded by this state.
let reports = Object.freeze([]);
const listeners = new Set();
let status = Object.freeze({ state: 'loading', publicCount: 0, hasLoaded: false, message: 'Memuat laporan online…' });
const statusListeners = new Set();

export function getReports() {
  return reports;
}

export function publishReports(savedReports) {
  // Report fields are scalar values, plus an immutable photo Blob for local
  // drafts. Keep gallery edits and map consumers from changing the snapshot.
  reports = Object.freeze(savedReports.map(report => Object.freeze({ ...report })));
  for (const listener of listeners) listener(reports);
}

export function subscribeReports(listener) {
  listeners.add(listener);
  // Either the map or IndexedDB can finish first; the map always receives the
  // latest snapshot without waiting for another report to be saved.
  listener(reports);
  return () => listeners.delete(listener);
}

export function getReportStatus() { return status; }

export function publishReportStatus(nextStatus) {
  status = Object.freeze({ ...nextStatus });
  for (const listener of statusListeners) listener(status);
}

export function subscribeReportStatus(listener) {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}
