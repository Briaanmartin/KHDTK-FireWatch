// Shared only within this page. IndexedDB remains the source of saved reports.
let reports = Object.freeze([]);
const listeners = new Set();

export function getReports() {
  return reports;
}

export function publishReports(savedReports) {
  // Report fields are scalar values, plus an immutable photo Blob. Preserve the
  // Blob while keeping gallery edits and map consumers from changing the state.
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
