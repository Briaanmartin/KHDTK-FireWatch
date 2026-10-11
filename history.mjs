import { insideBoundary, normalizeConfidence } from './core.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, WITA = 8 * HOUR;
export const HISTORY_SOURCES = [
  { id: 'VIIRS_SNPP_NRT', name: 'VIIRS S-NPP' },
  { id: 'VIIRS_NOAA20_NRT', name: 'VIIRS NOAA-20' },
  { id: 'VIIRS_NOAA21_NRT', name: 'VIIRS NOAA-21' },
];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const number = value => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(value);
const dateTime = value => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Makassar', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value)) + ' WITA';
export const witaYear = (now = Date.now()) => new Date(now + WITA).getUTCFullYear();
const monthStart = (year, month) => Date.UTC(year, month, 1) - WITA;
const intervalTime = value => typeof value === 'number' ? value : Date.parse(value);

/** Merge overlapping archive intervals. These describe stored data, not satellite visibility. */
export function mergeIntervals(intervals, start = -Infinity, end = Infinity) {
  const sorted = (Array.isArray(intervals) ? intervals : []).filter(interval => interval && typeof interval === 'object').map(interval => [
    Math.max(start, intervalTime(interval.start ?? interval[0])),
    Math.min(end, intervalTime(interval.end ?? interval[1])),
  ]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const previous = merged.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** An interval counts as common coverage only when all three configured sensors are available. */
export function intersectIntervals(groups) {
  if (!groups.length) return [];
  let result = mergeIntervals(groups[0]);
  for (const group of groups.slice(1)) {
    const other = mergeIntervals(group), next = [];
    let a = 0, b = 0;
    while (a < result.length && b < other.length) {
      const start = Math.max(result[a][0], other[b][0]), end = Math.min(result[a][1], other[b][1]);
      if (end > start) next.push([start, end]);
      if (result[a][1] < other[b][1]) a++; else b++;
    }
    result = next;
  }
  return result;
}
const duration = intervals => intervals.reduce((total, [start, end]) => total + end - start, 0);

export function summarizeHistory(data, boundary, now = Date.now()) {
  if (data?.type !== 'FeatureCollection' || data.schema_version !== 1 || !Number.isInteger(data.year) || data.timezone !== 'Asia/Makassar' || !Array.isArray(data.features) || !Array.isArray(data.sources)) throw new Error('Format arsip historikal tidak sesuai.');
  if (boundary?.type !== 'FeatureCollection' || !Array.isArray(boundary.features) || !boundary.features.length) throw new Error('Batas kawasan belum tersedia.');
  const year = data.year, start = monthStart(year, 0), end = monthStart(year + 1, 0), through = Math.min(end, now);
  const features = [], seen = new Set();
  for (const feature of data.features) {
    const p = feature?.properties, coords = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'Point' || !Array.isArray(coords) || coords.length < 2 || !coords.slice(0, 2).every(value => typeof value === 'number' && Number.isFinite(value)) || Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) continue;
    const time = typeof p?.detected_at === 'string' ? Date.parse(p.detected_at) : NaN;
    if (!Number.isFinite(time) || time < start || time >= end || time > now || !insideBoundary(coords, boundary)) continue;
    const key = [p.satellite, p.detected_at, coords[0], coords[1]].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    features.push({ ...feature, properties: { ...p, inside_aoi: true, confidence: normalizeConfidence(p.confidence) } });
  }
  features.sort((a, b) => Date.parse(b.properties.detected_at) - Date.parse(a.properties.detected_at));
  const sources = HISTORY_SOURCES.map(expected => {
    const provenance = data.sources.filter(source => source?.id === expected.id).flatMap(source => Array.isArray(source.coverage) ? source.coverage : []).filter(interval => interval && mergeIntervals([interval], start, through).length);
    return { ...expected, provenance, coverage: mergeIntervals(provenance, start, through) };
  });
  const coverage = intersectIntervals(sources.map(source => source.coverage));
  const months = MONTHS.map((name, index) => {
    const a = monthStart(year, index), calendarEnd = monthStart(year, index + 1), b = Math.min(now, calendarEnd);
    const elapsed = Math.max(0, b - a), common = mergeIntervals(coverage, a, b), covered = duration(common);
    const sourceCoverage = sources.map(source => ({ ...source, covered: duration(mergeIntervals(source.coverage, a, b)) }));
    const records = features.filter(feature => { const time = Date.parse(feature.properties.detected_at); return time >= a && time < calendarEnd; });
    const anyCovered = duration(mergeIntervals(sources.flatMap(source => source.coverage), a, b));
    return { index, name, start: a, end: b, elapsed, covered, coverage: common, sourceCoverage, features: records, count: records.length, state: elapsed === 0 ? 'future' : covered >= elapsed ? 'complete' : anyCovered > 0 || records.length ? 'partial' : 'unknown' };
  });
  const elapsed = Math.max(0, through - start), covered = duration(coverage);
  return { year, start, through, generatedAt: data.generated_at, features, sources, coverage, months, elapsed, covered, hasData: features.length > 0 || sources.some(source => source.coverage.length > 0), complete: elapsed > 0 && covered >= elapsed, count: features.length, detectionDays: new Set(features.map(feature => new Date(Date.parse(feature.properties.detected_at) + WITA).toISOString().slice(0, 10))).size, latest: features[0]?.properties.detected_at ?? null };
}

function csvRows(rows) {
  const quote = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) && typeof value !== 'number') text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n');
}

/** Export only validated AOI records; a detection is not a confirmed fire event. */
export function historyCSV(features) {
  return csvRows([['waktu_utc', 'waktu_wita', 'satelit', 'sensor', 'kepercayaan', 'frp_mw', 'longitude', 'latitude', 'dalam_aoi_khdtk', 'produk', 'sumber'], ...features.map(feature => {
    const p = feature.properties;
    return [p.detected_at, dateTime(p.detected_at), p.satellite, p.instrument, p.confidence, p.frp, ...feature.geometry.coordinates.slice(0, 2), true, p.product, p.source];
  })]);
}

/** Unknown and future counts remain blank; zero is exported only for an available archive period. */
export function historySummaryCSV(summary) {
  const days = milliseconds => Number((milliseconds / DAY).toFixed(6));
  return csvRows([['year', 'month', 'month_name_wita', 'archive_status', 'recorded_detections', 'covered_three_sensor_days', 'elapsed_days', 'covered_snpp_days', 'covered_noaa20_days', 'covered_noaa21_days', 'generated_at_utc', 'summary_through_utc', 'timezone', 'scope'], ...summary.months.map(month => [
    summary.year, month.index + 1, month.name, month.state,
    month.state === 'unknown' || month.state === 'future' ? '' : month.count,
    days(month.covered), days(month.elapsed),
    ...HISTORY_SOURCES.map(source => days(month.sourceCoverage.find(item => item.id === source.id)?.covered ?? 0)),
    summary.generatedAt, new Date(summary.through).toISOString(), 'Asia/Makassar', 'Dalam batas SHP KHDTK',
  ])]);
}

function element(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function coverageText(covered, elapsed) {
  if (covered === 0) return `0 dari ${number(elapsed / DAY)} hari`;
  if (covered < DAY) return `${number(covered / HOUR)} dari ${number(elapsed / HOUR)} jam`;
  return `${number(covered / DAY)} dari ${number(elapsed / DAY)} hari`;
}
const stateText = month => ({ future: 'Belum berlangsung', unknown: 'Belum tersedia', partial: 'Arsip sebagian', complete: 'Arsip lengkap' })[month.state];
const rangeText = intervals => intervals.length ? intervals.map(([a, b]) => `${dateTime(a)} – ${dateTime(b)}`).join('; ') : 'Belum tersedia';
function safeSourceURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'nasa.gov' || url.hostname.endsWith('.nasa.gov')) ? url.href : null;
  } catch { return null; }
}

export function mountHistory(host) {
  let summary = null, selectedMonth = new Date(Date.now() + WITA).getUTCMonth(), visibleRows = 30, loading = false;
  host.innerHTML = `<div class="panel-head history-heading"><div><p class="eyebrow">ARSIP DALAM BATAS SHP KHDTK</p><h2 id="history-title">Riwayat api &amp; hotspot</h2><p>Telusuri deteksi satelit per bulan dan ketersediaan arsipnya.</p></div><span id="history-badge" class="history-badge">Memuat arsip…</span></div>
    <div id="history-status" class="history-notice" role="status" aria-live="polite">Memuat riwayat tahun berjalan…</div>
    <div class="history-actions"><button id="history-retry" class="secondary" type="button">↻ Muat ulang riwayat</button><button id="history-export-summary" class="secondary" type="button" disabled>↓ Ringkasan bulanan</button><button id="history-export-year" type="button" disabled>↓ CSV tahun ini</button></div>
    <div id="history-content" hidden>
      <div class="history-stats"><article><span>DETEKSI TEREKAM</span><strong id="history-total">—</strong><small>Dalam periode arsip yang tersedia</small></article><article><span>HARI DENGAN DETEKSI</span><strong id="history-days">—</strong><small>Tanggal lokal WITA · arsip tersedia</small></article><article><span>DETEKSI TERAKHIR</span><strong id="history-latest" class="compact">—</strong><small>Pengamatan satelit di dalam AOI</small></article><article><span>KEBAKARAN TERVERIFIKASI</span><strong class="compact">Belum tersedia</strong><small>Memerlukan catatan kejadian lapangan</small></article></div>
      <div class="history-chart-heading"><div><h3>Deteksi bulanan</h3><p>Pilih bulan untuk melihat catatan dan cakupan arsip.</p></div><p class="history-chart-key"><i></i>Deteksi terekam <span>— Arsip belum tersedia</span></p></div>
      <div class="history-chart-scroll"><div id="history-chart" class="history-chart" role="group" aria-label="Pilih bulan riwayat hotspot"></div></div>
      <p class="history-chart-note">Angka 0 hanya berlaku pada periode data yang tersedia. Bulan tanpa arsip ditampilkan dengan tanda —. Satu kebakaran dapat menghasilkan beberapa deteksi.</p>
      <div class="history-detail-heading"><div><h3 id="history-month-title"></h3><p id="history-month-status"></p></div><button id="history-export-month" class="secondary" type="button" disabled>↓ CSV bulan ini</button></div>
      <div id="history-month-coverage" class="history-month-coverage"></div>
      <div class="table-wrap"><table class="history-table"><caption class="history-visually-hidden">Deteksi hotspot pada bulan yang dipilih, seluruhnya di dalam AOI KHDTK</caption><thead><tr><th>WAKTU (WITA)</th><th>SATELIT</th><th>KEPERCAYAAN</th><th>FRP (MW)</th><th>LINTANG, BUJUR</th><th>PETA</th></tr></thead><tbody id="history-rows"></tbody></table></div>
      <p id="history-empty" class="history-empty"></p><button id="history-more" class="secondary" type="button" hidden>Tampilkan lebih banyak</button>
      <details class="history-coverage-details"><summary>Periode data tersimpan &amp; sumber</summary><p>Cakupan arsip bersama dihitung dari irisan periode data ketiga satelit. Ini adalah ketersediaan arsip, bukan pengamatan satelit tanpa jeda atau jaminan seluruh kebakaran terdeteksi.</p><ul id="history-sources"></ul><p id="history-generated"></p><a href="https://firms.modaps.eosdis.nasa.gov/active_fire/" target="_blank" rel="noopener">Data aktif NASA FIRMS ↗</a><a href="https://firms.modaps.eosdis.nasa.gov/download/" target="_blank" rel="noopener">Arsip NASA FIRMS ↗</a></details>
      <aside class="history-fire-context"><strong>Membaca riwayat api</strong><p>Hotspot adalah anomali panas yang dideteksi satelit; konfirmasi kebakaran memerlukan verifikasi lapangan. Jumlah kejadian kebakaran dan luas area terbakar tahun ini belum tersedia dalam dataset ini. Foto laporan lapangan dapat menjadi dokumentasi pendukung, tetapi tidak otomatis dihitung sebagai kejadian terverifikasi.</p></aside>
    </div>`;
  const $ = id => host.querySelector('#' + id);
  const setText = (id, text) => { $(id).textContent = text; };
  function downloadCSV(content, filename) {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = element('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function download(features, period, complete) {
    if (!features.length) return;
    downloadCSV(historyCSV(features), `KHDTK-Lempake-hotspot-${summary.year}${period}${complete ? '' : '-arsip-parsial'}.csv`);
  }
  function renderMonth() {
    const month = summary.months[selectedMonth];
    setText('history-month-title', `${month.name} ${summary.year}`);
    setText('history-month-status', `${stateText(month)}${month.state === 'future' ? '' : month.state === 'unknown' ? ' · Jumlah deteksi belum diketahui' : ` · ${month.count} deteksi terekam`}`);
    $('history-export-month').disabled = !month.count;
    for (const button of $('history-chart').children) button.setAttribute('aria-pressed', String(Number(button.dataset.month) === selectedMonth));
    const coverageHost = $('history-month-coverage'); coverageHost.replaceChildren();
    if (month.state !== 'future') {
      coverageHost.append(element('p', '', `Cakupan arsip bersama: ${coverageText(month.covered, month.elapsed)} yang telah berjalan.`));
      const sources = element('div', 'history-sensor-coverage');
      for (const source of month.sourceCoverage) sources.append(element('span', '', `${source.name}: ${source.covered > 0 ? source.covered < DAY ? `${number(source.covered / HOUR)} jam` : `${number(source.covered / DAY)} hari` : 'belum tersedia'}`));
      coverageHost.append(sources);
      if (month.coverage.length) {
        const detail = element('details'); detail.append(element('summary', '', 'Lihat tanggal cakupan bersama'), element('p', '', rangeText(month.coverage))); coverageHost.append(detail);
      }
    }
    const rows = $('history-rows'); rows.replaceChildren();
    for (const feature of month.features.slice(0, visibleRows)) {
      const p = feature.properties, tr = element('tr');
      for (const text of [dateTime(p.detected_at), p.satellite || '—', ({high:'Tinggi', nominal:'Nominal', low:'Rendah'})[p.confidence] || 'Tidak diketahui', typeof p.frp === 'number' ? number(p.frp) : '—', feature.geometry.coordinates.slice(0, 2).reverse().map(value => value.toFixed(5)).join(', ')]) tr.append(element('td', '', text));
      const cell = element('td'), show = element('button', 'secondary', 'Lihat'); show.type = 'button'; show.setAttribute('aria-label', `Lihat deteksi ${dateTime(p.detected_at)} di peta`); show.addEventListener('click', () => document.dispatchEvent(new CustomEvent('history:show', { detail: { feature } }))); cell.append(show); tr.append(cell); rows.append(tr);
    }
    $('history-empty').hidden = month.count > 0;
    setText('history-empty', month.state === 'future' ? 'Bulan ini belum berlangsung.' : month.state === 'unknown' ? 'Arsip bulan ini belum tersedia. Jumlah hotspot dan kejadian kebakaran belum dapat disimpulkan.' : month.count ? '' : month.state === 'partial' ? 'Tidak ada deteksi tersimpan pada periode yang tersedia. Bagian bulan yang belum tercakup belum dapat disimpulkan.' : 'Tidak ada deteksi hotspot di dalam AOI pada arsip bulan ini. Ini tidak menjamin tidak ada kebakaran.');
    $('history-more').hidden = month.count <= visibleRows;
  }
  function render() {
    setText('history-title', `Riwayat api & hotspot ${summary.year}`);
    setText('history-badge', summary.complete ? 'Arsip lengkap hingga kini' : 'Arsip tahun ini belum lengkap');
    const coveragePercent = summary.elapsed > 0 ? Math.min(summary.complete ? 100 : 99.9, summary.covered / summary.elapsed * 100) : 0;
    const first = summary.coverage[0]?.[0], last = summary.coverage.at(-1)?.[1];
    setText('history-status', `${summary.complete ? 'Arsip mencakup periode tahun berjalan.' : 'Riwayat tahun berjalan masih parsial; periode tanpa arsip belum dapat disimpulkan.'} Cakupan bersama tiga satelit: ${coverageText(summary.covered, summary.elapsed)} (${number(coveragePercent)}%).${first !== undefined ? ` Data tersedia mulai ${dateTime(first)} hingga ${dateTime(last)}${summary.coverage.length > 1 ? ', dengan jeda; lihat rincian periode di bawah' : ''}.` : ' Belum ada periode arsip bersama ketiga satelit.'}`);
    setText('history-total', summary.hasData ? number(summary.count) : '—'); setText('history-days', summary.hasData ? number(summary.detectionDays) : '—'); setText('history-latest', summary.latest ? dateTime(summary.latest) : summary.hasData ? 'Belum tercatat' : 'Belum tersedia');
    $('history-export-year').disabled = !summary.count;
    $('history-export-summary').disabled = !summary.hasData;
    const chart = $('history-chart'); chart.replaceChildren();
    const max = Math.max(1, ...summary.months.map(month => month.count));
    for (const month of summary.months) {
      const button = element('button', `history-month is-${month.state}`); button.type = 'button'; button.dataset.month = month.index;
      const count = month.state === 'unknown' || month.state === 'future' ? '—' : number(month.count);
      button.setAttribute('aria-label', `${month.name} ${summary.year}, ${stateText(month)}${month.state === 'future' ? '' : `, ${month.state === 'unknown' ? 'jumlah deteksi belum diketahui' : `${month.count} deteksi terekam`}, cakupan bersama ${coverageText(month.covered, month.elapsed)}`}`);
      button.append(element('strong', 'history-bar-value', count));
      const track = element('span', 'history-bar-track'), bar = element('span', 'history-bar'); bar.style.height = `${month.count > 0 ? Math.max(7, month.count / max * 100) : 0}%`; track.append(bar); button.append(track, element('span', 'history-month-name', MONTH_SHORT[month.index]), element('small', 'history-month-state', ({future:'Mendatang',unknown:'Belum tersedia',partial:'Sebagian',complete:'Lengkap'})[month.state]));
      button.addEventListener('click', () => { selectedMonth = month.index; visibleRows = 30; renderMonth(); }); chart.append(button);
    }
    const sources = $('history-sources'); sources.replaceChildren();
    for (const source of summary.sources) {
      const li = element('li'); li.append(element('strong', '', source.name), element('span', '', rangeText(source.coverage)));
      const products = new Set(source.provenance.map(period => period.kind).filter(kind => ['sp', 'nrt'].includes(kind)));
      if (products.size) li.append(element('span', '', [...products].map(kind => kind === 'sp' ? 'SP · produk sains arsip' : 'NRT · data mendekati waktu nyata').join(' / ')));
      const references = [...new Map(source.provenance.filter(period => typeof period.reference === 'string').map(period => [period.reference, period])).values()];
      if (references.length) {
        const details = element('details', 'history-provenance'); details.append(element('summary', '', `Rujukan berkas sumber (${references.length})`));
        for (const period of references) {
          const row = element('p'), reference = safeSourceURL(period.reference), documentation = safeSourceURL(period.documentation);
          const link = element('a', '', reference ? period.reference.split('/').at(-1) + ' ↗' : 'Panduan produk VIIRS NASA ↗');
          if (reference || documentation) { link.href = reference || documentation; link.target = '_blank'; link.rel = 'noopener'; row.append(link); }
          if (!reference && period.reference.startsWith('sftp://fuoco.geog.umd.edu/data/VIIRS/C2/')) row.append(element('code', '', period.reference));
          details.append(row);
        }
        li.append(details);
      }
      sources.append(li);
    }
    setText('history-generated', `Arsip diperbarui: ${Number.isFinite(Date.parse(summary.generatedAt)) ? dateTime(summary.generatedAt) : 'waktu tidak tersedia'}. Angka deteksi hanya berasal dari titik di dalam batas SHP KHDTK.`);
    $('history-content').hidden = false; renderMonth();
  }
  async function refresh() {
    if (loading) return;
    loading = true; $('history-retry').disabled = true;
    setText('history-status', 'Memuat riwayat dan memeriksa batas kawasan…');
    try {
      const year = witaYear();
      const responses = await Promise.all([fetch(`data/history-${year}.json`, { cache: 'no-cache', signal: AbortSignal.timeout(20000) }), fetch('data/boundary.geojson', { cache: 'no-cache', signal: AbortSignal.timeout(20000) })]);
      if (responses.some(response => !response.ok)) throw new Error('Arsip atau batas kawasan tidak dapat diunduh.');
      const [data, boundary] = await Promise.all(responses.map(response => response.json()));
      if (data.year !== year) throw new Error('Tahun arsip tidak sesuai dengan tahun berjalan.');
      summary = summarizeHistory(data, boundary); render();
    } catch (error) {
      setText('history-badge', summary ? 'Pembaruan gagal' : 'Arsip belum termuat');
      setText('history-status', `${summary ? 'Pembaruan riwayat gagal. Catatan terakhir yang berhasil dimuat tetap ditampilkan. ' : 'Riwayat belum dapat dimuat; jumlah hotspot tahunan belum dapat disimpulkan. '}${error.message} Gunakan tombol muat ulang riwayat.`);
    } finally { loading = false; $('history-retry').disabled = false; }
  }
  $('history-retry').addEventListener('click', refresh);
  document.getElementById('refresh')?.addEventListener('click', refresh);
  $('history-export-summary').addEventListener('click', () => { if (summary?.hasData) downloadCSV(historySummaryCSV(summary), `KHDTK-Lempake-ringkasan-bulanan-${summary.year}${summary.complete ? '' : '-arsip-parsial'}.csv`); });
  $('history-export-year').addEventListener('click', () => download(summary.features, '', summary.complete));
  $('history-export-month').addEventListener('click', () => download(summary.months[selectedMonth].features, '-' + String(selectedMonth + 1).padStart(2, '0'), summary.months[selectedMonth].state === 'complete'));
  $('history-more').addEventListener('click', () => { visibleRows += 30; renderMonth(); });
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60000);
  const onVisible = () => { if (!document.hidden) refresh(); };
  document.addEventListener('visibilitychange', onVisible);
  refresh();
  return { refresh, destroy: () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); } };
}

if (typeof document !== 'undefined') {
  const host = document.getElementById('history');
  if (host) mountHistory(host);
}
