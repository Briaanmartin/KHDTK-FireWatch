import { insideBoundary } from './core.mjs';
import { publishReports, publishReportStatus } from './report-state.mjs?v=20261012-public-reports';

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DB_NAME = 'khdtk-firewatch-field-reports';

export function normalizePublicReport(report, baseUrl) {
  if (!report || typeof report.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(report.id)) throw new Error('ID laporan online tidak valid.');
  const clean = validateReport(report);
  const base = new URL(baseUrl), photo = new URL(report.photoUrl, base);
  if (base.protocol !== 'https:' || photo.origin !== base.origin || photo.username || photo.password || photo.pathname !== `/api/reports/${encodeURIComponent(report.id)}/photo` || photo.search || photo.hash) throw new Error('Alamat foto laporan online tidak valid.');
  if (!Number.isFinite(Date.parse(report.createdAt))) throw new Error('Waktu penyimpanan laporan online tidak valid.');
  return { ...clean, id: report.id, createdAt: report.createdAt, photoUrl: photo.href };
}

export async function fetchPublicReports(baseUrl, fetcher = fetch) {
  const records = new Map(), seenCursors = new Set();
  let cursor;
  do {
    const url = new URL('/api/reports', baseUrl);
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetcher(url.href, { cache: 'no-store', credentials: 'omit', mode: 'cors', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Laporan online belum dapat dimuat.');
    const page = await response.json();
    if (!Array.isArray(page.reports)) throw new Error('Format laporan online tidak valid.');
    for (const raw of page.reports) {
      const report = normalizePublicReport(raw, baseUrl);
      records.set(report.id, report);
    }
    cursor = page.nextCursor;
    if (cursor != null && cursor !== '' && (typeof cursor !== 'string' || cursor.length > 512 || seenCursors.has(cursor))) throw new Error('Halaman laporan online tidak valid.');
    if (cursor) seenCursors.add(cursor);
    if (seenCursors.size > 100) throw new Error('Daftar laporan terlalu besar untuk dimuat sekaligus.');
  } while (cursor);
  return [...records.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function validatePhoto(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('Pilih foto JPEG, PNG, atau WebP.');
  if (!file.size || file.size > MAX_BYTES) throw new Error('Ukuran foto harus lebih dari 0 dan maksimal 10 MB.');
}

export function validateCoordinates({ latitude, longitude } = {}) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error('Pilih titik pengamatan pada peta. Koordinat harus berupa lintang dan bujur yang valid.');
  }
  return { latitude, longitude };
}

export function validateReport({ title, observedAt, latitude, longitude, location, notes }, { allowLegacyLocation = false } = {}) {
  const clean = { title: String(title || '').trim(), observedAt: String(observedAt || ''), notes: String(notes || '').trim() };
  if (!clean.title || clean.title.length > 120) throw new Error('Isi judul laporan, maksimal 120 karakter.');
  if (allowLegacyLocation && latitude === undefined && longitude === undefined) {
    clean.location = String(location || '').trim();
    if (!clean.location || clean.location.length > 160) throw new Error('Lokasi laporan lama tidak valid.');
  } else Object.assign(clean, validateCoordinates({ latitude, longitude }));
  if (clean.notes.length > 3000) throw new Error('Catatan maksimal 3.000 karakter.');
  const instant = Date.parse(`${clean.observedAt}:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(clean.observedAt) || !Number.isFinite(instant) || new Date(instant + 8 * 3600000).toISOString().slice(0, 16) !== clean.observedAt) throw new Error('Isi tanggal dan jam pengamatan yang valid dalam WITA.');
  return clean;
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatObserved = value => new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Makassar' }).format(new Date(`${value}:00+08:00`)) + ' WITA';

export function exportReportHTML(report, photoDataURL) {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photoDataURL)) throw new Error('Foto tidak dapat disertakan dalam ekspor.');
  const clean = validateReport(report, { allowLegacyLocation: true });
  const safe = Object.fromEntries(Object.entries(clean).map(([key, value]) => [key, escapeHTML(value)]));
  const locationHTML = clean.latitude !== undefined
    ? `<strong>Titik pengamatan (WGS 84):</strong> ${clean.latitude.toFixed(6)}, ${clean.longitude.toFixed(6)}<br><a href="${escapeHTML(pointURL(clean))}" target="_blank" rel="noopener noreferrer">Buka titik di OpenStreetMap</a>${typeof report.insideAOI === 'boolean' ? `<br>${report.insideAOI ? 'Di dalam' : 'Di luar'} batas AOI KHDTK saat laporan dibuat.` : ''}`
    : `<strong>Lokasi / blok (laporan lama):</strong> ${safe.location}`;
  return `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe.title} · Laporan lapangan</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#233d33;background:#f3f5f0;margin:0;padding:30px}main{max-width:900px;margin:auto;background:white;border-top:6px solid #b32624;padding:28px;border-radius:8px}h1{line-height:1.2}img{display:block;max-width:100%;max-height:80vh;margin:24px auto;object-fit:contain}p{overflow-wrap:anywhere}.notes{white-space:pre-wrap}.meta,footer{color:#66766a;font-size:14px}footer{border-top:1px solid #ddd;padding-top:18px}@media print{body{padding:0;background:white}main{padding:10px}img{max-height:55vh}}</style><main><p class="meta">FIREWATCH · LAPORAN LAPANGAN</p><h1>${safe.title}</h1><p>KHDTK Diklathut Fahutan Unmul Lempake</p><p><strong>Pengamatan:</strong> ${escapeHTML(formatObserved(report.observedAt))}<br>${locationHTML}</p><img src="${photoDataURL}" alt="Foto pengamatan lapangan"><h2>Catatan pengamatan</h2><p class="notes">${safe.notes || 'Tidak ada catatan tambahan.'}</p><footer>Laporan diisi oleh pengguna dan diekspor dari penyimpanan browser. Isi laporan belum diverifikasi dan tidak otomatis dikirim ke tim.</footer></main></html>`;
}

const pointURL = ({ latitude, longitude }) => `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
function savedPoint(report) {
  try { return validateCoordinates(report); } catch { return null; }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Penyimpanan browser tidak tersedia.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('reports', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Tutup tab FireWatch lainnya lalu muat ulang untuk mengaktifkan penyimpanan.'));
  });
}

function transaction(database, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('reports', mode);
    const request = action(tx.objectStore('reports'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () => reject(tx.error || new Error('Penyimpanan dibatalkan.'));
  });
}

const readPhoto = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Foto tidak dapat dibaca.'));
  reader.readAsDataURL(blob);
});

async function mountReports(root) {
  root.setAttribute('aria-labelledby', 'reports-heading');
  root.innerHTML = `
    <div class="panel-head reports-heading"><div><p class="eyebrow">DOKUMENTASI & VERIFIKASI</p><h2 id="reports-heading">Foto laporan lapangan</h2><p>Laporan online, foto, dan titik pengamatan dapat dilihat semua pengunjung.</p></div><span class="reports-device reports-public-badge">Laporan publik</span></div>
    <div class="reports-online-intro"><div><strong>Bagikan pengamatan lapangan</strong><p>Buka halaman laporan online untuk mengirim foto dan memilih titik pada peta. Masuk akun diperlukan untuk mengirim; melihat laporan tidak perlu masuk.</p></div><a id="report-online-link" class="report-online-link" aria-disabled="true" target="_blank" rel="noopener">Kirim laporan online ↗</a></div>
    <div class="reports-public-head"><h3>Laporan online</h3><span id="public-reports-count">Memuat…</span><button id="public-reports-refresh" class="secondary" type="button">Muat ulang laporan</button></div>
    <p id="public-reports-status" class="report-status" role="status" aria-live="polite">Memuat laporan online…</p>
    <div id="public-reports-list" class="reports-public-list"></div>
    <details id="reports-local" class="reports-local"><summary>Laporan lokal sebelumnya <span id="reports-local-count"></span></summary>
    <div class="reports-notice">Laporan lama dan draf di bawah hanya tersimpan di browser ini. Isinya tidak diunggah otomatis. Gunakan Kirim laporan online jika Anda ingin membagikan laporan kepada semua pengunjung. Unduh salinan sebelum menghapus data browser.</div>
    <div class="reports-layout">
      <form id="report-form"><fieldset id="report-fields"><legend class="report-form-title">Buat draf lokal</legend>
        <label class="report-label" for="report-photo">Foto lapangan <span aria-hidden="true">*</span></label>
        <div class="report-upload"><span class="report-camera" aria-hidden="true">▧</span><strong>Pilih foto pengamatan</strong><span>JPEG, PNG, atau WebP · maksimal 10 MB</span><input id="report-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="report-photo-note"></div>
        <p id="report-photo-note" class="micro">Gunakan foto kondisi lapangan yang ingin Anda dokumentasikan.</p>
        <figure id="report-preview-wrap" class="report-preview" hidden><img id="report-preview" alt="Pratinjau foto yang dipilih"><figcaption id="report-filename"></figcaption></figure>
        <label class="report-label" for="report-title">Judul laporan <span aria-hidden="true">*</span></label><input id="report-title" name="title" maxlength="120" placeholder="Contoh: Pemeriksaan blok utara" required>
        <label class="report-label" for="report-observed">Waktu pengamatan (WITA) <span aria-hidden="true">*</span></label><input id="report-observed" name="observedAt" type="datetime-local" required>
        <p id="report-point-label" class="report-label">Titik pengamatan <span aria-hidden="true">*</span></p>
        <p id="report-map-help" class="report-map-help">Ketuk atau klik peta untuk menaruh titik. Geser penanda untuk memperbaiki lokasi. Dengan keyboard, fokuskan peta dan gunakan tombol panah, lalu pilih “Gunakan tengah peta” pada tanda +. Titik boleh berada di dalam maupun di sekitar batas KHDTK.</p>
        <div id="report-map" class="report-map" tabindex="0" role="region" aria-labelledby="report-point-label" aria-describedby="report-map-help"></div>
        <div class="report-map-actions"><button id="report-use-center" class="secondary" type="button" disabled>Gunakan tengah peta</button><button id="report-fit-boundary" class="secondary" type="button" disabled>Lihat batas KHDTK</button><button id="report-clear-point" class="secondary" type="button" disabled>Hapus titik</button></div>
        <p id="report-point-summary" class="report-point-summary" role="status" aria-live="polite">Belum ada titik dipilih.</p>
        <p id="report-map-status" class="report-map-help" role="status">Menyiapkan peta lokasi…</p>
        <label class="report-label" for="report-notes">Catatan pengamatan</label><textarea id="report-notes" name="notes" rows="4" maxlength="3000" placeholder="Kondisi vegetasi, asap / api, atau hasil pemeriksaan…"></textarea>
        <div class="report-form-actions"><button id="report-save" type="submit" disabled>Simpan draf lokal</button><button class="secondary" type="reset">Kosongkan</button></div>
      </fieldset></form>
      <div class="reports-gallery"><div class="reports-gallery-head"><h3>Draf & laporan lokal</h3><span id="reports-count">0 laporan</span></div><div id="reports-list"></div></div>
    </div><p id="report-status" class="report-status" role="status" aria-live="polite">Menyiapkan penyimpanan browser…</p></details>`;
  const $ = selector => root.querySelector(selector);
  const form = $('#report-form'), fields = $('#report-fields'), save = $('#report-save'), list = $('#reports-list');
  const preview = $('#report-preview'), previewWrap = $('#report-preview-wrap'), status = $('#report-status');
  let database, reports = [], reportsLoaded = false, photo, previewURL, selection = 0, decoding = false, busy = false;
  let publicReports = [], publicLoaded = false, publicLoading = false, serviceBaseUrl;
  let point = null, picker, pointMarker, pickerBoundary, boundaryLayer, mapResize;
  const cardURLs = new Set(), downloadURLs = new Set();
  const feedback = (message, error = false) => { status.textContent = message; status.classList.toggle('is-error', error); };
  const updateSave = () => { save.disabled = !database || !photo || decoding || busy; };
  const currentWita = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
  $('#report-observed').value = currentWita();
  const pointRelation = coordinates => pickerBoundary ? `${insideBoundary([coordinates.longitude, coordinates.latitude], pickerBoundary) ? 'Di dalam' : 'Di luar'} batas AOI KHDTK` : 'Batas AOI belum dimuat';
  function publishCombined() {
    publishReports([
      ...publicReports.map(report => ({ ...report, sourceId: report.id, id: `public:${report.id}`, scope: 'public' })),
      ...(reportsLoaded ? reports : []).map(report => ({ ...report, sourceId: report.id, id: `local:${report.id}`, scope: 'local' }))
    ]);
  }
  function showPointButton(report, scope) {
    const coordinates = savedPoint(report);
    if (!coordinates) return null;
    const button = node('button', 'secondary', 'Lihat titik di peta'); button.type = 'button';
    button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('report:show', { detail: { report: { id: `${scope}:${report.id}`, sourceId: report.id, scope, title: report.title, observedAt: report.observedAt, ...coordinates } } })));
    return button;
  }
  function renderPublicReports() {
    const publicList = $('#public-reports-list'); publicList.replaceChildren();
    $('#public-reports-count').textContent = publicLoaded ? `${publicReports.length} laporan publik` : 'Belum dimuat';
    if (publicLoaded && !publicReports.length) {
      const empty = node('div', 'reports-empty reports-public-empty');
      empty.append(node('span', 'reports-empty-icon', '▧'), node('h4', '', 'Belum ada laporan online'), node('p', '', 'Kirim laporan lapangan pertama. Foto dan titik yang Anda terbitkan akan terlihat oleh semua pengunjung.'));
      publicList.append(empty);
    }
    for (const report of publicReports) {
      const card = node('article', 'report-card report-public-card'), image = node('img');
      image.src = report.photoUrl; image.alt = `Foto: ${report.title}`; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      const body = node('div', 'report-card-body'), coordinates = savedPoint(report);
      body.append(node('p', 'report-card-date', `${formatObserved(report.observedAt)} · Publik`), node('h4', '', report.title), node('p', 'report-card-location', `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)} · WGS 84${pickerBoundary ? ` · ${pointRelation(coordinates)}` : ''}`));
      if (report.notes) body.append(node('p', 'report-card-notes', report.notes));
      const actions = node('div', 'report-card-actions'); actions.append(showPointButton(report, 'public'));
      body.append(actions); card.append(image, body); publicList.append(card);
    }
  }
  function setPublicStatus(state, message) {
    const element = $('#public-reports-status'); element.textContent = message; element.classList.toggle('is-error', state === 'error');
    publishReportStatus({ state, publicCount: publicReports.length, hasLoaded: publicLoaded, message });
  }
  async function refreshPublicReports() {
    if (publicLoading) return;
    publicLoading = true; $('#public-reports-refresh').disabled = true;
    setPublicStatus('loading', publicLoaded ? 'Memperbarui laporan online…' : 'Memuat laporan online…');
    if (!publicLoaded) $('#public-reports-count').textContent = 'Memuat…';
    try {
      if (!serviceBaseUrl) {
        const response = await fetch('data/report-service.json', { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Alamat layanan laporan belum tersedia.');
        const configuration = await response.json(), base = new URL(configuration.baseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Alamat layanan laporan tidak valid.');
        serviceBaseUrl = base.origin;
        $('#report-online-link').href = serviceBaseUrl;
        $('#report-online-link').removeAttribute('aria-disabled');
      }
      const loaded = await fetchPublicReports(serviceBaseUrl);
      publicReports = loaded; publicLoaded = true;
      renderPublicReports(); publishCombined();
      setPublicStatus('ready', publicReports.length ? 'Laporan online terbaru ditampilkan di galeri dan peta untuk semua pengunjung.' : 'Belum ada laporan yang diterbitkan. Laporan lokal lama tetap tersimpan pribadi di browser Anda.');
    } catch (error) {
      if (!publicLoaded) $('#public-reports-count').textContent = 'Belum tersedia';
      setPublicStatus('error', publicLoaded
        ? 'Pembaruan laporan online gagal. Laporan yang terakhir dimuat tetap terlihat; coba Muat ulang laporan.'
        : 'Laporan online belum dapat dimuat. Periksa koneksi lalu pilih Muat ulang laporan. Ini bukan berarti belum ada laporan.');
      console.error('Laporan online gagal dimuat:', error);
    } finally { publicLoading = false; $('#public-reports-refresh').disabled = false; }
  }
  $('#public-reports-refresh').addEventListener('click', refreshPublicReports);
  window.addEventListener('focus', refreshPublicReports);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshPublicReports(); });
  void refreshPublicReports();
  function updatePointSummary() {
    $('#report-point-summary').textContent = point ? `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)} · WGS 84 · ${pointRelation(point)}` : 'Belum ada titik dipilih.';
    $('#report-point-summary').classList.toggle('has-point', Boolean(point));
    $('#report-clear-point').disabled = !point;
  }
  function selectPoint(latlng) {
    if (busy) return;
    // Leaflet allows world wrapping. Store the equivalent longitude in WGS 84.
    const wrapped = latlng.wrap();
    point = validateCoordinates({ latitude: Number(wrapped.lat.toFixed(6)), longitude: Number(wrapped.lng.toFixed(6)) });
    if (!pointMarker) {
      pointMarker = L.marker([point.latitude, point.longitude], {
        draggable: true, title: 'Titik pengamatan. Geser untuk mengubah lokasi.',
        icon: L.divIcon({ className: 'report-point-marker', html: '<span></span>', iconSize: [24, 24], iconAnchor: [12, 12] })
      }).addTo(picker);
      pointMarker.on('dragend', () => selectPoint(pointMarker.getLatLng()));
    } else pointMarker.setLatLng([point.latitude, point.longitude]);
    updatePointSummary();
  }
  function clearPoint() {
    point = null;
    if (pointMarker) picker.removeLayer(pointMarker);
    pointMarker = null; updatePointSummary();
  }
  async function setupPicker() {
    const mapStatus = $('#report-map-status');
    try {
      if (!window.L) throw new Error('Pustaka peta gagal dimuat. Muat ulang halaman untuk memilih titik.');
      picker = L.map($('#report-map'), { scrollWheelZoom: false, zoomControl: true, keyboard: true, maxZoom: 19 }).setView([-0.449, 117.215], 15);
      const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
      const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics, GIS User Community' }).addTo(picker);
      L.control.layers({ 'Citra satelit': satellite, 'Peta jalan': streets }, {}, { collapsed: false }).addTo(picker);
      L.control.scale({ imperial: false }).addTo(picker);
      const tileError = () => { mapStatus.textContent = 'Sebagian peta dasar gagal dimuat. Coba ganti lapisan peta atau muat ulang halaman.'; };
      for (const base of [streets, satellite]) base.on('tileerror', () => { if (picker.hasLayer(base)) tileError(); });
      picker.on('click', event => selectPoint(event.latlng));
      $('#report-use-center').disabled = false;
      $('#report-use-center').addEventListener('click', () => selectPoint(picker.getCenter()));
      $('#report-clear-point').addEventListener('click', clearPoint);
      $('#report-fit-boundary').addEventListener('click', () => { if (boundaryLayer) picker.fitBounds(boundaryLayer.getBounds(), { padding: [20, 20], maxZoom: 16 }); });
      if (typeof ResizeObserver !== 'undefined') {
        mapResize = new ResizeObserver(() => picker.invalidateSize({ pan: false })); mapResize.observe($('#report-map'));
      }
      mapStatus.textContent = 'Memuat batas KHDTK…';
      try {
        const response = await fetch('data/boundary.geojson', { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Batas KHDTK gagal dimuat.');
        pickerBoundary = await response.json();
        boundaryLayer = L.geoJSON(pickerBoundary, { style: { color: '#b32624', weight: 3, fill: false }, interactive: false }).addTo(picker);
        if (!boundaryLayer.getBounds().isValid()) throw new Error('Batas KHDTK tidak valid.');
        if (!point) picker.fitBounds(boundaryLayer.getBounds(), { padding: [20, 20], maxZoom: 16 });
        $('#report-fit-boundary').disabled = false;
        mapStatus.textContent = 'Garis merah menunjukkan batas KHDTK. Peta dapat digeser ke lokasi pengamatan.';
        updatePointSummary(); renderReports(); renderPublicReports();
      } catch {
        pickerBoundary = undefined;
        mapStatus.textContent = 'Batas KHDTK belum tersedia. Anda tetap dapat memilih titik pada peta; muat ulang untuk mencoba memuat batas.';
      }
    } catch (error) { mapStatus.textContent = error.message || 'Peta lokasi belum tersedia. Muat ulang halaman untuk mencoba lagi.'; }
  }
  // The old local editor stays available without loading another map until opened.
  let pickerStarted = false;
  $('#reports-local').addEventListener('toggle', () => {
    if (!$('#reports-local').open) return;
    if (!pickerStarted) { pickerStarted = true; void setupPicker(); }
    else picker?.invalidateSize({ pan: false });
  });
  function clearPreview() {
    photo = undefined;
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = undefined; preview.removeAttribute('src'); previewWrap.hidden = true; updateSave();
  }
  $('#report-photo').addEventListener('change', async event => {
    const token = ++selection, file = event.target.files[0];
    clearPreview();
    if (!file) return;
    decoding = true; updateSave(); feedback('Memeriksa foto…');
    let url;
    try {
      validatePhoto(file);
      url = URL.createObjectURL(file);
      const img = new Image(); img.src = url;
      await img.decode();
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('Foto tidak dapat dibuka.');
      if (token !== selection) return;
      photo = file; previewURL = url; url = undefined;
      preview.src = previewURL; previewWrap.hidden = false;
      $('#report-filename').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
      feedback(database ? 'Foto siap. Lengkapi pengamatan lalu simpan sebagai draf lokal.' : 'Foto siap, tetapi penyimpanan browser belum tersedia. Foto belum disimpan.', !database);
    } catch (error) {
      if (token === selection) feedback(error.name === 'EncodingError' ? 'Berkas tidak dapat dibuka sebagai foto. Pilih JPEG, PNG, atau WebP yang valid.' : error.message, true);
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (token === selection) { decoding = false; updateSave(); }
    }
  });
  form.addEventListener('reset', () => {
    ++selection; decoding = false; clearPreview(); clearPoint();
    queueMicrotask(() => { $('#report-observed').value = currentWita(); });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || decoding) return;
    try {
      if (!database) throw new Error('Penyimpanan belum tersedia. Laporan belum disimpan.');
      validatePhoto(photo);
      const data = validateReport({ ...Object.fromEntries(new FormData(form)), ...point });
      const report = { ...data, ...(pickerBoundary ? { insideAOI: insideBoundary([data.longitude, data.latitude], pickerBoundary) } : {}), id: crypto.randomUUID(), createdAt: new Date().toISOString(), photo };
      busy = true; fields.disabled = true; updateSave(); feedback('Menyimpan foto dan draf lokal…');
      await transaction(database, 'readwrite', store => store.add(report));
      reports.unshift(report); renderReports(); form.reset();
      feedback('Draf lokal disimpan di browser ini dan belum dipublikasikan. Gunakan Kirim laporan online untuk membagikan pengamatan.');
    } catch (error) {
      feedback(error.name === 'QuotaExceededError' ? 'Penyimpanan perangkat penuh. Laporan belum disimpan; foto dan isian tetap tersedia.' : `Laporan belum disimpan. ${error.message || 'Penyimpanan browser tidak dapat diakses.'}`, true);
    } finally { busy = false; fields.disabled = false; updateSave(); }
  });
  function node(tag, className, text) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (text !== undefined) element.textContent = text; return element;
  }
  function renderReports() {
    if (reportsLoaded) publishCombined();
    cardURLs.forEach(url => URL.revokeObjectURL(url)); cardURLs.clear(); list.replaceChildren();
    $('#reports-count').textContent = `${reports.length} laporan`;
    $('#reports-local-count').textContent = reports.length ? `· ${reports.length}` : '';
    if (!reports.length) {
      const empty = node('div', 'reports-empty');
      empty.append(node('span', 'reports-empty-icon', '▧'), node('h4', '', 'Belum ada draf lokal'), node('p', '', 'Draf di bagian ini hanya tersedia di browser Anda. Gunakan laporan online untuk berbagi dengan pengunjung lain.'));
      list.append(empty); return;
    }
    for (const report of reports) {
      const card = node('article', 'report-card'), image = node('img');
      image.src = URL.createObjectURL(report.photo); cardURLs.add(image.src); image.alt = `Foto: ${report.title}`; image.loading = 'lazy';
      const body = node('div', 'report-card-body');
      const coordinates = savedPoint(report);
      const locationText = coordinates ? `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)} · WGS 84${pickerBoundary ? ` · ${pointRelation(coordinates)}` : ''}` : `${report.location || 'Lokasi belum tersedia'} · Laporan lama`;
      body.append(node('p', 'report-card-date', formatObserved(report.observedAt)), node('h4', '', report.title), node('p', 'report-card-location', locationText));
      if (report.notes) body.append(node('p', 'report-card-notes', report.notes));
      const actions = node('div', 'report-card-actions'), download = node('button', 'secondary', '↓ Unduh HTML'), remove = node('button', 'report-delete', 'Hapus');
      download.type = remove.type = 'button';
      if (coordinates) actions.append(showPointButton(report, 'local'));
      actions.append(download, remove);
      const confirm = node('div', 'report-confirm'); confirm.hidden = true;
      const yes = node('button', 'report-confirm-yes', 'Ya, hapus'), cancel = node('button', 'secondary', 'Batal');
      yes.type = cancel.type = 'button'; confirm.append(node('p', '', 'Hapus laporan lokal ini dari browser?'), yes, cancel);
      remove.addEventListener('click', () => { confirm.hidden = false; remove.hidden = true; cancel.focus(); });
      cancel.addEventListener('click', () => { confirm.hidden = true; remove.hidden = false; remove.focus(); });
      yes.addEventListener('click', async () => {
        yes.disabled = cancel.disabled = true;
        try {
          await transaction(database, 'readwrite', store => store.delete(report.id));
          reports = reports.filter(item => item.id !== report.id); renderReports();
          feedback('Laporan lokal dihapus dari browser ini.'); $('#reports-heading').tabIndex = -1; $('#reports-heading').focus({ preventScroll: true });
        } catch { feedback('Laporan belum dihapus. Penyimpanan perangkat tidak dapat diakses.', true); yes.disabled = cancel.disabled = false; }
      });
      download.addEventListener('click', async () => {
        download.disabled = true;
        try {
          const html = exportReportHTML(report, await readPhoto(report.photo));
          const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })); downloadURLs.add(url);
          const link = node('a'); link.href = url; link.download = `laporan-${report.observedAt.slice(0, 10)}-${report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) || 'lapangan'}.html`;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => { URL.revokeObjectURL(url); downloadURLs.delete(url); }, 60000);
          feedback('Unduhan HTML disiapkan berisi foto dan catatan. Bagikan berkas unduhan kepada tim bila diperlukan.');
        } catch { feedback('Ekspor gagal. Laporan tetap tersimpan di perangkat; coba unduh lagi.', true); }
        finally { download.disabled = false; }
      });
      body.append(actions, confirm); card.append(image, body); list.append(card);
    }
  }
  renderReports();
  try {
    database = await openDatabase();
    database.onversionchange = () => { database.close(); database = undefined; updateSave(); feedback('Penyimpanan berubah. Muat ulang halaman sebelum menyimpan laporan baru.', true); };
    reports = (await transaction(database, 'readonly', store => store.getAll())).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    reportsLoaded = true;
    renderReports(); updateSave(); feedback('Penyimpanan lokal siap. Draf di bagian ini tetap pribadi dan tidak diunggah otomatis.');
  } catch (error) { database?.close(); database = undefined; updateSave(); feedback(`Penyimpanan perangkat tidak tersedia. ${error.message || 'Periksa pengaturan browser lalu muat ulang.'} Foto dan isian belum disimpan.`, true); }
  window.addEventListener('pagehide', event => { if (event.persisted) return; if (previewURL) URL.revokeObjectURL(previewURL); cardURLs.forEach(url => URL.revokeObjectURL(url)); downloadURLs.forEach(url => URL.revokeObjectURL(url)); database?.close(); mapResize?.disconnect(); picker?.remove(); });
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('field-reports');
  if (root) mountReports(root);
}
