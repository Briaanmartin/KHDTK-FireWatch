const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DB_NAME = 'khdtk-firewatch-field-reports';

export function validatePhoto(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('Pilih foto JPEG, PNG, atau WebP.');
  if (!file.size || file.size > MAX_BYTES) throw new Error('Ukuran foto harus lebih dari 0 dan maksimal 10 MB.');
}

export function validateReport({ title, observedAt, location, notes }) {
  const clean = { title: String(title || '').trim(), observedAt: String(observedAt || ''), location: String(location || '').trim(), notes: String(notes || '').trim() };
  if (!clean.title || clean.title.length > 120) throw new Error('Isi judul laporan, maksimal 120 karakter.');
  if (!clean.location || clean.location.length > 160) throw new Error('Isi lokasi atau blok pengamatan, maksimal 160 karakter.');
  if (clean.notes.length > 3000) throw new Error('Catatan maksimal 3.000 karakter.');
  const instant = Date.parse(`${clean.observedAt}:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(clean.observedAt) || !Number.isFinite(instant) || new Date(instant + 8 * 3600000).toISOString().slice(0, 16) !== clean.observedAt) throw new Error('Isi tanggal dan jam pengamatan yang valid dalam WITA.');
  return clean;
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatObserved = value => new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Makassar' }).format(new Date(`${value}:00+08:00`)) + ' WITA';

export function exportReportHTML(report, photoDataURL) {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photoDataURL)) throw new Error('Foto tidak dapat disertakan dalam ekspor.');
  const safe = Object.fromEntries(Object.entries(validateReport(report)).map(([key, value]) => [key, escapeHTML(value)]));
  return `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe.title} · Laporan lapangan</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#233d33;background:#f3f5f0;margin:0;padding:30px}main{max-width:900px;margin:auto;background:white;border-top:6px solid #b32624;padding:28px;border-radius:8px}h1{line-height:1.2}img{display:block;max-width:100%;max-height:80vh;margin:24px auto;object-fit:contain}p{overflow-wrap:anywhere}.notes{white-space:pre-wrap}.meta,footer{color:#66766a;font-size:14px}footer{border-top:1px solid #ddd;padding-top:18px}@media print{body{padding:0;background:white}main{padding:10px}img{max-height:55vh}}</style><main><p class="meta">FIREWATCH · LAPORAN LAPANGAN</p><h1>${safe.title}</h1><p>KHDTK Diklathut Fahutan Unmul Lempake</p><p><strong>Pengamatan:</strong> ${escapeHTML(formatObserved(report.observedAt))}<br><strong>Lokasi / blok:</strong> ${safe.location}</p><img src="${photoDataURL}" alt="Foto pengamatan lapangan"><h2>Catatan pengamatan</h2><p class="notes">${safe.notes || 'Tidak ada catatan tambahan.'}</p><footer>Laporan diisi oleh pengguna dan diekspor dari penyimpanan browser. Isi laporan belum diverifikasi dan tidak otomatis dikirim ke tim.</footer></main></html>`;
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
    <div class="panel-head reports-heading"><div><p class="eyebrow">DOKUMENTASI & VERIFIKASI</p><h2 id="reports-heading">Foto laporan lapangan</h2><p>Catat kondisi kawasan melalui foto dan hasil pengamatan Anda.</p></div><span class="reports-device">Tersimpan di perangkat</span></div>
    <div class="reports-notice">Laporan tersimpan hanya di browser dan perangkat ini, serta tidak otomatis dikirim ke tim. Unduh salinan laporan untuk dibagikan atau dicadangkan. Menghapus data browser dapat menghapus laporan.</div>
    <div class="reports-layout">
      <form id="report-form"><fieldset id="report-fields"><legend class="report-form-title">Tambah laporan</legend>
        <label class="report-label" for="report-photo">Foto lapangan <span aria-hidden="true">*</span></label>
        <div class="report-upload"><span class="report-camera" aria-hidden="true">▧</span><strong>Pilih foto pengamatan</strong><span>JPEG, PNG, atau WebP · maksimal 10 MB</span><input id="report-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="report-photo-note"></div>
        <p id="report-photo-note" class="micro">Gunakan foto kondisi lapangan yang ingin Anda dokumentasikan.</p>
        <figure id="report-preview-wrap" class="report-preview" hidden><img id="report-preview" alt="Pratinjau foto yang dipilih"><figcaption id="report-filename"></figcaption></figure>
        <label class="report-label" for="report-title">Judul laporan <span aria-hidden="true">*</span></label><input id="report-title" name="title" maxlength="120" placeholder="Contoh: Pemeriksaan blok utara" required>
        <div class="report-form-row"><div><label class="report-label" for="report-observed">Waktu pengamatan (WITA) <span aria-hidden="true">*</span></label><input id="report-observed" name="observedAt" type="datetime-local" required></div><div><label class="report-label" for="report-location">Lokasi / blok <span aria-hidden="true">*</span></label><input id="report-location" name="location" maxlength="160" placeholder="Nama blok atau titik pengamatan" required></div></div>
        <label class="report-label" for="report-notes">Catatan pengamatan</label><textarea id="report-notes" name="notes" rows="4" maxlength="3000" placeholder="Kondisi vegetasi, asap / api, atau hasil pemeriksaan…"></textarea>
        <div class="report-form-actions"><button id="report-save" type="submit" disabled>Simpan di perangkat</button><button class="secondary" type="reset">Kosongkan</button></div>
      </fieldset></form>
      <div class="reports-gallery"><div class="reports-gallery-head"><h3>Laporan tersimpan</h3><span id="reports-count">0 laporan</span></div><div id="reports-list"></div></div>
    </div><p id="report-status" class="report-status" role="status" aria-live="polite">Menyiapkan penyimpanan perangkat…</p>`;
  const $ = selector => root.querySelector(selector);
  const form = $('#report-form'), fields = $('#report-fields'), save = $('#report-save'), list = $('#reports-list');
  const preview = $('#report-preview'), previewWrap = $('#report-preview-wrap'), status = $('#report-status');
  let database, reports = [], photo, previewURL, selection = 0, decoding = false, busy = false;
  const cardURLs = new Set(), downloadURLs = new Set();
  const feedback = (message, error = false) => { status.textContent = message; status.classList.toggle('is-error', error); };
  const updateSave = () => { save.disabled = !database || !photo || decoding || busy; };
  const currentWita = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
  $('#report-observed').value = currentWita();
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
      feedback(database ? 'Foto siap. Lengkapi pengamatan lalu simpan di perangkat.' : 'Foto siap, tetapi penyimpanan browser belum tersedia. Foto belum disimpan.', !database);
    } catch (error) {
      if (token === selection) feedback(error.name === 'EncodingError' ? 'Berkas tidak dapat dibuka sebagai foto. Pilih JPEG, PNG, atau WebP yang valid.' : error.message, true);
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (token === selection) { decoding = false; updateSave(); }
    }
  });
  form.addEventListener('reset', () => {
    ++selection; decoding = false; clearPreview();
    queueMicrotask(() => { $('#report-observed').value = currentWita(); });
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || decoding) return;
    try {
      if (!database) throw new Error('Penyimpanan belum tersedia. Laporan belum disimpan.');
      validatePhoto(photo);
      const data = validateReport(Object.fromEntries(new FormData(form)));
      const report = { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString(), photo };
      busy = true; fields.disabled = true; updateSave(); feedback('Menyimpan foto dan laporan…');
      await transaction(database, 'readwrite', store => store.add(report));
      reports.unshift(report); renderReports(); form.reset();
      feedback('Laporan berhasil disimpan di perangkat ini. Unduh HTML untuk salinan yang dapat dibagikan.');
    } catch (error) {
      feedback(error.name === 'QuotaExceededError' ? 'Penyimpanan perangkat penuh. Laporan belum disimpan; foto dan isian tetap tersedia.' : `Laporan belum disimpan. ${error.message || 'Penyimpanan browser tidak dapat diakses.'}`, true);
    } finally { busy = false; fields.disabled = false; updateSave(); }
  });
  function node(tag, className, text) {
    const element = document.createElement(tag); if (className) element.className = className;
    if (text !== undefined) element.textContent = text; return element;
  }
  function renderReports() {
    cardURLs.forEach(url => URL.revokeObjectURL(url)); cardURLs.clear(); list.replaceChildren();
    $('#reports-count').textContent = `${reports.length} laporan`;
    if (!reports.length) {
      const empty = node('div', 'reports-empty');
      empty.append(node('span', 'reports-empty-icon', '▧'), node('h4', '', 'Belum ada laporan lapangan'), node('p', '', 'Tambahkan foto pertama untuk mendokumentasikan kondisi KHDTK.'));
      list.append(empty); return;
    }
    for (const report of reports) {
      const card = node('article', 'report-card'), image = node('img');
      image.src = URL.createObjectURL(report.photo); cardURLs.add(image.src); image.alt = `Foto: ${report.title}`; image.loading = 'lazy';
      const body = node('div', 'report-card-body');
      body.append(node('p', 'report-card-date', formatObserved(report.observedAt)), node('h4', '', report.title), node('p', 'report-card-location', report.location));
      if (report.notes) body.append(node('p', 'report-card-notes', report.notes));
      const actions = node('div', 'report-card-actions'), download = node('button', 'secondary', '↓ Unduh HTML'), remove = node('button', 'report-delete', 'Hapus');
      download.type = remove.type = 'button'; actions.append(download, remove);
      const confirm = node('div', 'report-confirm'); confirm.hidden = true;
      const yes = node('button', 'report-confirm-yes', 'Ya, hapus'), cancel = node('button', 'secondary', 'Batal');
      yes.type = cancel.type = 'button'; confirm.append(node('p', '', 'Hapus laporan ini dari perangkat?'), yes, cancel);
      remove.addEventListener('click', () => { confirm.hidden = false; remove.hidden = true; cancel.focus(); });
      cancel.addEventListener('click', () => { confirm.hidden = true; remove.hidden = false; remove.focus(); });
      yes.addEventListener('click', async () => {
        yes.disabled = cancel.disabled = true;
        try {
          await transaction(database, 'readwrite', store => store.delete(report.id));
          reports = reports.filter(item => item.id !== report.id); renderReports();
          feedback('Laporan dihapus dari perangkat ini.'); $('#reports-heading').tabIndex = -1; $('#reports-heading').focus({ preventScroll: true });
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
    renderReports(); updateSave(); feedback('Penyimpanan perangkat siap. Laporan Anda tidak otomatis dikirim ke tim.');
  } catch (error) { database?.close(); database = undefined; updateSave(); feedback(`Penyimpanan perangkat tidak tersedia. ${error.message || 'Periksa pengaturan browser lalu muat ulang.'} Foto dan isian belum disimpan.`, true); }
  window.addEventListener('pagehide', event => { if (event.persisted) return; if (previewURL) URL.revokeObjectURL(previewURL); cardURLs.forEach(url => URL.revokeObjectURL(url)); downloadURLs.forEach(url => URL.revokeObjectURL(url)); database?.close(); });
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('field-reports');
  if (root) mountReports(root);
}
