const HOUR = 3_600_000;
const WINDOW = 24 * HOUR;
const FRESHNESS = 6 * HOUR;
const CLOCK_TOLERANCE = 5 * 60_000;
const SOURCE_IDS = ['VIIRS_SNPP_NRT','VIIRS_NOAA20_NRT','VIIRS_NOAA21_NRT'];
const CATEGORY = {
  pantau: {label:'Pantau',angle:-60},
  waspada: {label:'Waspada',angle:0},
  siaga: {label:'Siaga',angle:60},
  unknown: {label:'Belum dapat dinilai',angle:0},
};

// These are site-defined observation categories, not a fire-weather index or
// official warning. Inputs are the prepared, unfiltered NASA satellite records.
export function deriveFireAlert({features, status, now = Date.now(), loadError = false} = {}) {
  const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
  const fresh = value => {const time=timestamp(value);return Number.isFinite(time) && time <= now+CLOCK_TOLERANCE && now-time <= FRESHNESS;};
  let insideCount=0, nearbyCount=0, staleRecords=false, invalidRecords=false, latestTime=null;
  const hasRecords=Array.isArray(features);
  for(const feature of hasRecords ? features : []) {
    const p=feature?.properties, time=timestamp(p?.detected_at);
    if(!Number.isFinite(time)){invalidRecords=true;continue;}
    if(time>now || time<now-WINDOW) continue;
    if(p.inside!==true && p.inside!==false){invalidRecords=true;continue;}
    if(p.inside===false && (!Number.isFinite(p.distance_km) || p.distance_km<0)){invalidRecords=true;continue;}
    if(p.inside===false && p.distance_km>25) continue;
    if(p.stale) staleRecords=true;
    if(p.inside) insideCount++; else nearbyCount++;
    latestTime=latestTime===null ? time : Math.max(latestTime,time);
  }

  let unavailable='';
  if(!Number.isFinite(now)) unavailable='Waktu perangkat belum valid. Periksa waktu lalu muat ulang data.';
  else if(loadError) unavailable='Pembaruan gagal. Muat ulang untuk menilai kategori pemantauan.';
  else if(!hasRecords || !status) unavailable='Menunggu data hotspot dan status sumber.';
  else if(status.state==='partial') unavailable='Sebagian sumber belum tersedia. Muat ulang untuk melengkapi pengamatan.';
  else if(status.state!=='ready') unavailable='Sumber hotspot belum tersedia. Coba muat ulang data.';
  else if(!fresh(status.checked_at)) unavailable='Data lebih dari 6 jam atau waktu pembaruannya tidak valid. Muat ulang data.';
  else if(!Array.isArray(status.sources) || SOURCE_IDS.some(id=>!status.sources.some(source=>source.id===id)) || status.sources.some(source=>source.state!=='ready' || !fresh(source.last_success_at))) unavailable='Pembaruan sumber belum lengkap atau sudah lama. Muat ulang data.';
  else if(status.sources.some(source=>source.source_updated_at && !fresh(source.source_updated_at))) unavailable='Berkas sumber belum mutakhir. Periksa kembali pembaruan NASA FIRMS.';
  else if(!Number.isFinite(timestamp(status.window_start)) || timestamp(status.window_start)>now-WINDOW) unavailable='Cakupan data belum mencakup 24 jam terakhir.';
  else if(staleRecords) unavailable='Sebagian deteksi tersimpan berasal dari sumber yang gagal diperbarui.';
  else if(invalidRecords) unavailable='Sebagian catatan deteksi belum dapat dibaca. Muat ulang data.';

  const key=unavailable ? 'unknown' : insideCount ? 'siaga' : nearbyCount ? 'waspada' : 'pantau';
  const evidence=insideCount ? `Tercatat ${insideCount} deteksi dalam KHDTK. ` : nearbyCount ? `Tercatat ${nearbyCount} deteksi di sekitar KHDTK. ` : '';
  const description=unavailable ? evidence+unavailable : (key==='siaga'
    ? `${insideCount} deteksi di dalam KHDTK. Prioritaskan verifikasi lapangan.`
    : key==='waspada' ? `${nearbyCount} deteksi di sekitar KHDTK, hingga 25 km dari batas. Pantau perkembangannya.`
      : 'Belum ada deteksi pada 24 jam terakhir. Tetap pantau; ini tidak menjamin kawasan bebas api.');
  return {...CATEGORY[key],key,description,insideCount,nearbyCount,countsAvailable:hasRecords,
    latestDetectedAt:latestTime===null?null:new Date(latestTime).toISOString(),
    checkedAt:status?.checked_at || null,windowHours:24,bufferKm:25};
}

const TEMPLATE = `
  <div class="fire-alert-gauge" aria-hidden="true">
    <svg viewBox="0 0 360 210" focusable="false">
      <path class="fire-alert-track fire-alert-track--pantau" d="M47 171 A133 133 0 0 1 110 58"/>
      <path class="fire-alert-track fire-alert-track--waspada" d="M117 54 A133 133 0 0 1 243 54"/>
      <path class="fire-alert-track fire-alert-track--siaga" d="M250 58 A133 133 0 0 1 313 171"/>
      <text x="34" y="88" transform="rotate(-54 34 88)">PANTAU</text>
      <text x="180" y="18" text-anchor="middle">WASPADA</text>
      <text x="326" y="88" transform="rotate(54 326 88)" text-anchor="end">SIAGA</text>
      <g data-alert-needle class="fire-alert-needle">
        <path d="M174 170 L180 67 L186 170 Z"/>
        <circle cx="180" cy="170" r="13"/>
        <circle class="fire-alert-pivot" cx="180" cy="170" r="5"/>
      </g>
      <text data-alert-unknown class="fire-alert-unknown" x="180" y="167" text-anchor="middle">—</text>
      <text class="fire-alert-window" x="180" y="207" text-anchor="middle">PENGAMATAN 24 JAM</text>
    </svg>
  </div>
  <div class="fire-alert-content">
    <p class="eyebrow">KATEGORI PEMANTAUAN API</p>
    <div class="fire-alert-live" role="status" aria-live="polite" aria-atomic="true">
      <h2 data-alert-label>Belum dapat dinilai</h2>
      <p data-alert-description class="fire-alert-description">Menunggu data hotspot dan status sumber.</p>
    </div>
    <div data-alert-counts class="fire-alert-counts" hidden>
      <span><strong data-alert-inside>—</strong> dalam KHDTK</span>
      <span><strong data-alert-nearby>—</strong> sekitar ≤25 km</span>
      <small data-alert-count-note hidden>Catatan tersedia · cakupan belum lengkap</small>
    </div>
    <p class="fire-alert-context">Kategori pengamatan versi situs, bukan peringatan resmi. Hotspot perlu verifikasi.</p>
    <details class="fire-alert-method">
      <summary>Dasar kategori</summary>
      <p>Semua kepercayaan deteksi dalam 24 jam terakhir, terpisah dari filter peta dan laporan pengguna. <strong>Pantau:</strong> belum ada deteksi di kawasan dan sekitarnya. <strong>Waspada:</strong> ada deteksi di luar kawasan hingga 25 km dari batas. <strong>Siaga:</strong> ada deteksi di dalam KHDTK. Jumlah deteksi bukan jumlah kejadian kebakaran.</p>
      <p>Data perlu diperbarui paling lambat 6 jam. Jika sumber tidak lengkap atau sudah lama, kategori belum dinilai; jumlah yang tersedia tetap ditampilkan sebagai catatan.</p>
    </details>
  </div>`;

// Mount once, then call the returned updater after a fetch and on each freshness
// tick. Pass all prepared detections, never the map's currently filtered subset.
export function mountFireAlert(container, initial = {}) {
  if(!container) throw new TypeError('Elemen kategori pemantauan tidak ditemukan.');
  container.classList.add('fire-alert');
  container.innerHTML=TEMPLATE;
  container.setAttribute('aria-label','Kategori pemantauan api');
  const find=selector=>container.querySelector(selector);
  let previous='';
  function update(input={}) {
    const result=deriveFireAlert(input), signature=JSON.stringify(result);
    if(signature===previous) return result;
    previous=signature;
    container.dataset.alert=result.key;
    find('[data-alert-label]').textContent=result.label;
    find('[data-alert-description]').textContent=result.description;
    find('[data-alert-counts]').hidden=!result.countsAvailable;
    find('[data-alert-inside]').textContent=result.insideCount;
    find('[data-alert-nearby]').textContent=result.nearbyCount;
    find('[data-alert-counts]').setAttribute('aria-label',result.key==='unknown'?'Catatan tersedia; cakupan belum lengkap':'Deteksi dalam 24 jam terakhir');
    find('[data-alert-count-note]').hidden=result.key!=='unknown';
    find('[data-alert-needle]').style.transform=`rotate(${result.angle}deg)`;
    find('[data-alert-needle]').style.display=result.key==='unknown'?'none':'';
    find('[data-alert-unknown]').style.display=result.key==='unknown'?'':'none';
    return result;
  }
  update(initial);
  return update;
}
