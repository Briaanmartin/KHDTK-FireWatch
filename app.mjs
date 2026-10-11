import {insideBoundary, distanceToBoundaryKm, normalizeConfidence, filterDetections, toCSV} from './core.mjs';
import {fireIcon, FIRE_SVG} from './hotspot-icon.mjs';

const $ = id => document.getElementById(id);
const NAME = 'KHDTK Diklathut Fahutan Unmul Lempake';
const labels = {high:'Tinggi',nominal:'Nominal',low:'Rendah',unknown:'Tidak diketahui'};
const dateFormat = new Intl.DateTimeFormat('id-ID', {timeZone:'Asia/Makassar',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const number = value => new Intl.NumberFormat('id-ID',{maximumFractionDigits:2}).format(value);
const dateText = value => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : 'Belum tersedia';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let map, boundary, info, boundaryLayer, hotspotLayer, currentBase, historyMarker, reportMarker;
let detections = [], visible = [], status, dataLoaded = false, pageSize = 50, loading = false;
const markerById = new Map();

async function json(path) {
  const response = await fetch(path, {cache:'no-cache',signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`Gagal memuat ${path} (${response.status})`);
  return response.json();
}
function notice(message, tone = '') {
  $('system-notice').textContent = message;
  $('system-notice').className = `system-notice ${tone}`;
}
function setupMap() {
  if (!window.L) throw new Error('Pustaka peta gagal dimuat. Silakan muat ulang halaman.');
  map = L.map('map',{zoomControl:false,preferCanvas:false,zoomSnap:.25,scrollWheelZoom:false});
  L.control.zoom({position:'topright'}).addTo(map);
  L.control.scale({imperial:false,position:'bottomleft'}).addTo(map);
  const bases = {
    street: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'})
  };
  for (const layer of Object.values(bases)) {
    layer.on('tileerror',()=>{if(map.hasLayer(layer)) $('tile-notice').hidden=false;});
  }
  currentBase = bases.satellite.addTo(map);
  $('basemap').addEventListener('change',()=>{
    map.removeLayer(currentBase); currentBase = bases[$('basemap').value].addTo(map); $('tile-notice').hidden=true;
  });
  boundaryLayer = L.geoJSON(boundary,{style:{color:'#d43830',weight:3,fill:false}}).addTo(map);
  boundaryLayer.bindPopup(`<span class="popup-label">BATAS DARI SHP</span><br><strong>${NAME}</strong><br>Luas geodesik: ${number(info.areaHa)} ha<br>DGN95 / UTM 50S → WGS 84`);
  boundaryLayer.bindTooltip('Batas KHDTK Lempake');
  const areaBounds=boundaryLayer.getBounds();
  hotspotLayer = L.featureGroup().addTo(map);
  const toggle = (id,layer) => $(id).addEventListener('change',()=>$(id).checked ? layer.addTo(map) : map.removeLayer(layer));
  toggle('show-boundary',boundaryLayer);toggle('show-hotspots',hotspotLayer);
  document.querySelectorAll('[data-fire-icon]').forEach(element=>{element.innerHTML=FIRE_SVG;});
  document.addEventListener('history:show', event=>{
    const feature=event.detail?.feature;
    if(feature?.geometry?.type!=='Point' || !insideBoundary(feature.geometry.coordinates,boundary)) return;
    const [lon,lat]=feature.geometry.coordinates,p=feature.properties || {};
    if(!Number.isFinite(Date.parse(p.detected_at))) return;
    if(historyMarker) map.removeLayer(historyMarker);
    historyMarker=L.marker([lat,lon],{icon:fireIcon(L,p.confidence),title:`Hotspot arsip ${p.satellite || ''} · ${dateText(p.detected_at)} WITA`}).addTo(map);
    historyMarker.bindPopup(`<span class="popup-label">DETEKSI ARSIP TAHUNAN</span><br><strong>${escapeHTML(p.satellite)}</strong><br>${dateText(p.detected_at)} WITA<br>Di dalam AOI KHDTK<br>Kepercayaan: ${labels[normalizeConfidence(p.confidence)]}<br>FRP: ${Number.isFinite(p.frp)?number(p.frp)+' MW':'Tidak tersedia'}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}<br><small>Deteksi satelit; perlu verifikasi kejadian api.</small>`);
    historyMarker.on('popupclose',()=>{if(historyMarker){map.removeLayer(historyMarker);historyMarker=null;}});
    map.setView([lat,lon],15);historyMarker.openPopup();$('map').scrollIntoView({behavior:'smooth',block:'center'});
  });
  document.addEventListener('report:show', event=>{
    const report=event.detail?.report;
    const lat=report?.latitude,lon=report?.longitude;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return;
    if(reportMarker) map.removeLayer(reportMarker);
    const marker=L.marker([lat,lon],{title:'Titik laporan lapangan',icon:L.divIcon({className:'report-point-marker',html:'<span></span>',iconSize:[24,24],iconAnchor:[12,12]})}).addTo(map);
    reportMarker=marker;
    const place=insideBoundary([lon,lat],boundary)?'Di dalam batas KHDTK':'Di luar batas KHDTK';
    marker.bindPopup(`<span class="popup-label">TITIK LAPORAN LAPANGAN</span><br><strong>${escapeHTML(report.title)}</strong><br>${dateText(`${report.observedAt}:00+08:00`)} WITA<br>${place}<br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br><small>Lokasi dipilih pelapor · tersimpan di perangkat ini.</small>`);
    marker.on('popupclose',()=>{map.removeLayer(marker);if(reportMarker===marker) reportMarker=null;});
    map.setView([lat,lon],16);marker.openPopup();$('map').scrollIntoView({behavior:'smooth',block:'center'});
  });
  $('fit-hotspots').addEventListener('click',()=>{
    if (!hotspotLayer.getLayers().length) return;
    $('show-hotspots').checked=true;hotspotLayer.addTo(map);
    map.fitBounds(hotspotLayer.getBounds(),{padding:[40,40],maxZoom:16});
  });
  map.on('mousemove',event=>{$('coordinates').textContent=`${event.latlng.lat.toFixed(5)}, ${event.latlng.lng.toFixed(5)} · WGS 84`;});
  map.on('mouseout',()=>{$('coordinates').textContent='WGS 84 · EPSG:4326';});
  new ResizeObserver(()=>map.invalidateSize({pan:false})).observe($('map'));
  // Open a regional view once; never snap back to or constrain the SHP polygon.
  map.setView(areaBounds.getCenter(),11);
}
function prepareDetections(collection) {
  if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('Format data hotspot tidak valid.');
  return collection.features.filter(f=>f.geometry?.type==='Point' && f.geometry.coordinates.length >= 2 && f.geometry.coordinates.slice(0,2).every(Number.isFinite)).map((feature,index)=>{
    const p = feature.properties || {}, coordinates = feature.geometry.coordinates;
    const inside = insideBoundary(coordinates,boundary);
    const distance = typeof p.distance_km==='number' && Number.isFinite(p.distance_km) ? p.distance_km : distanceToBoundaryKm(coordinates,boundary);
    return {...feature,properties:{...p,id:p.id || `detection-${index}`,inside,distance_km:distance,confidence:normalizeConfidence(p.confidence)}};
  }).filter(f=>f.properties.distance_km<=25).sort((a,b)=>Date.parse(b.properties.detected_at)-Date.parse(a.properties.detected_at));
}
function renderStatus() {
  const checked = Date.parse(status?.checked_at), age = Date.now() - checked;
  const stale = !Number.isFinite(checked) || age > 6*3600000;
  let label='Data NASA FIRMS', tone='', message='Garis merah menunjukkan batas KHDTK. Ikon api menandai hotspot di dalam dan sekitar kawasan hingga 25 km dari batas. Peta dapat dijelajahi bebas; pengamatan NASA FIRMS diperbarui setiap jam.';
  if (status?.state==='error') { label='Sumber belum tersedia';tone='error';message='Pengambilan data hotspot gagal. Jika tersedia, catatan terakhir tetap ditampilkan dengan status data lama. Kondisi kawasan belum dapat disimpulkan dari data ini.'; }
  else if (status?.state==='partial') { label='Sebagian sumber tersedia';tone='warn';message='Sebagian sumber NASA FIRMS gagal diperbarui. Catatan tersimpan dari sumber tersebut ditandai sebagai data lama; cakupan pengamatan belum lengkap.'; }
  else if (stale) { label='Data perlu diperbarui';tone='warn';message='Pembaruan data terakhir sudah lebih dari 6 jam atau waktunya tidak tersedia. Tabel tetap menampilkan catatan dalam periode pilihan; periksa waktu pengamatan.'; }
  $('status-badge').textContent=label;$('status-badge').className=`badge ${tone}`;
  $('checked-at').textContent=`Diperiksa ${dateText(status?.checked_at)} WITA`;
  notice(message,tone);
  $('source-list').replaceChildren();
  for (const source of status?.sources || []) {
    const li=document.createElement('li');
    li.className=source.state==='ready' ? '' : 'failed';
    li.textContent=`${source.name || source.id} · ${source.state==='ready'?'Berhasil diperiksa':'Gagal diperbarui'}`;
    const small=document.createElement('small');
    small.textContent=`Terakhir berhasil: ${dateText(source.last_success_at)} WITA${source.retained_count ? ` · ${source.retained_count} catatan lama disimpan` : ''}`;
    li.append(small);$('source-list').append(li);
  }
}
function render() {
  if (!dataLoaded) return;
  const baseOptions={hours:Number($('period').value),confidence:$('confidence').value};
  visible=filterDetections(detections,baseOptions);
  const inside=visible.filter(f=>f.properties.inside);
  const unavailable=status.state==='error' && !detections.length;
  $('inside-stat').textContent=unavailable?'—':inside.length;
  $('high-stat').textContent=unavailable?'—':inside.filter(f=>f.properties.confidence==='high').length;
  $('latest-stat').textContent=visible.length?dateText(visible[0].properties.detected_at):'Tidak ada deteksi';
  if(unavailable) $('latest-stat').textContent='Belum tersedia';
  $('map-count').textContent=`${visible.length} hotspot · ${inside.length} di dalam KHDTK`;
  $('table-summary').textContent=unavailable?'Data hotspot belum tersedia':`${visible.length} deteksi · hingga 25 km dari batas KHDTK · ${$('period').selectedOptions[0].text} · WITA (UTC+8)`;
  $('export').disabled=!visible.length;$('fit-hotspots').disabled=!visible.length;
  $('empty').hidden=visible.length>0;
  $('empty-title').textContent=unavailable?'Data hotspot belum tersedia':'Tidak ada hotspot pada filter ini';
  $('empty-text').textContent=unavailable?'Periksa status sumber data. Kegagalan pengambilan data tidak berarti tidak ada hotspot.':status.state==='ready'?'Tidak ditemukan deteksi di dalam atau hingga 25 km dari batas KHDTK pada filter ini. Anda dapat memeriksa periode 7 hari.':'Cakupan sumber belum lengkap. Tidak adanya baris pada filter ini belum mewakili seluruh pengamatan.';
  markerById.clear();hotspotLayer.clearLayers();
  for(const feature of visible) {
    const p=feature.properties,[lon,lat]=feature.geometry.coordinates;
    const marker=L.marker([lat,lon],{icon:fireIcon(L,p.confidence),opacity:p.stale?.55:1,title:`Hotspot ${p.satellite || ''} · ${labels[p.confidence]}`});
    const place=p.inside?'Di dalam KHDTK':`${number(p.distance_km)} km dari batas`;
    marker.bindPopup(`<span class="popup-label">HOTSPOT ${escapeHTML(p.instrument)}</span><br><strong>${escapeHTML(p.satellite)}</strong><br>${dateText(p.detected_at)} WITA<br>${place}<br>Kepercayaan: ${labels[p.confidence]}<br>FRP: ${Number.isFinite(p.frp)?number(p.frp)+' MW':'Tidak tersedia'}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}${p.stale?'<br><strong>Data tersimpan · sumber gagal diperbarui</strong>':''}`);
    marker.bindTooltip(`${escapeHTML(p.satellite)} · ${labels[p.confidence]} · ${place}`);
    marker.addTo(hotspotLayer);markerById.set(p.id,marker);
  }
  renderRows();
}
function renderRows() {
  $('rows').replaceChildren();
  for(const feature of visible.slice(0,pageSize)) {
    const p=feature.properties,[lon,lat]=feature.geometry.coordinates,tr=document.createElement('tr');
    const values=[dateText(p.detected_at),p.satellite+(p.stale?' · data lama':''),p.inside?'Dalam KHDTK':`${number(p.distance_km)} km dari batas`,labels[p.confidence],Number.isFinite(p.frp)?number(p.frp):'—',`${lat.toFixed(5)}, ${lon.toFixed(5)}`];
    for(const [index,value] of values.entries()) {
      const td=document.createElement('td');
      if(index===2){const span=document.createElement('span');span.className=`pill ${p.inside?'':'near'}`;span.textContent=value;td.append(span);}
      else if(index===3){const dot=document.createElement('i');dot.className=`dot ${p.confidence}`;td.append(dot,document.createTextNode(value));}
      else td.textContent=value;
      tr.append(td);
    }
    const td=document.createElement('td'),button=document.createElement('button');button.className='secondary';button.textContent='Lihat ↗';button.setAttribute('aria-label',`Lihat hotspot ${p.satellite} ${dateText(p.detected_at)} di peta`);
    button.addEventListener('click',()=>{$('show-hotspots').checked=true;hotspotLayer.addTo(map);map.setView([lat,lon],15);markerById.get(p.id)?.openPopup();$('map').scrollIntoView({behavior:'smooth',block:'center'});});
    td.append(button);tr.append(td);$('rows').append(tr);
  }
  $('more').hidden=pageSize>=visible.length;
}
async function loadHotspots() {
  if(loading) return;
  loading=true;$('refresh').disabled=true;$('refresh').textContent='↻ Memuat…';
  try {
    const collection=await json('data/hotspots.geojson'), newStatus=collection.status;
    if(!newStatus || collection.generated_at!==newStatus.checked_at) throw new Error('Snapshot hotspot dan status tidak cocok.');
    if(!['ready','partial','error'].includes(newStatus.state)) throw new Error('Status sumber tidak valid.');
    detections=prepareDetections(collection);status=newStatus;dataLoaded=true;
    pageSize=50;renderStatus();render();
  } catch(error) {
    notice(`Data hotspot gagal dimuat. ${dataLoaded?'Data yang sudah dimuat tetap tersedia. ':''}Coba muat ulang data.`, 'error');
    $('status-badge').textContent='Gagal memuat data';$('status-badge').className='badge error';
    if(!dataLoaded){$('table-summary').textContent='Data hotspot belum tersedia';$('empty').hidden=false;$('empty-title').textContent='Data hotspot belum tersedia';$('empty-text').textContent='Periksa koneksi lalu muat ulang data.';$('map-count').textContent='Lapisan hotspot belum tersedia';}
    console.error(error);
  } finally {loading=false;$('refresh').disabled=false;$('refresh').textContent='↻ Muat ulang data';}
}
async function start() {
  try {
    [boundary,info]=await Promise.all([json('data/boundary.geojson'),json('data/boundary-info.json')]);
    $('area-stat').textContent=number(info.areaHa);
    $('boundary-description').textContent=`AOI utama berasal dari AOI KRUS.shp, dengan luas geodesik ${number(info.areaHa)} ha. Proyeksi DGN95 / UTM Zona 50S (EPSG:23880) dikonversi ke WGS 84. Garis merah menandai batas SHP pada peta yang dapat dijelajahi bebas; KML tetap tersimpan sebagai data pembanding.`;
    setupMap();
    ['period','confidence'].forEach(id=>$(id).addEventListener('change',()=>{pageSize=50;render();}));
    $('reset').addEventListener('click',()=>{$('period').value='168';$('confidence').value='all';pageSize=50;render();});
    $('more').addEventListener('click',()=>{pageSize+=50;renderRows();});
    $('refresh').addEventListener('click',loadHotspots);
    $('export').addEventListener('click',()=>{
      const url=URL.createObjectURL(new Blob([toCSV(visible)],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='hotspot-khdtk-dan-sekitar.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    await loadHotspots();
    // Keep elapsed-time filters and freshness accurate in long-lived monitoring tabs.
    setInterval(()=>{if(dataLoaded && !document.hidden){renderStatus();render();}},60000);
    setInterval(()=>{if(!document.hidden) loadHotspots();},300000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden) loadHotspots();});
  } catch(error) {
    notice('Batas kawasan atau pustaka peta gagal dimuat. Periksa koneksi lalu muat ulang halaman.','error');
    $('status-badge').textContent='Peta belum tersedia';$('refresh').textContent='↻ Muat ulang halaman';$('refresh').onclick=()=>location.reload();
    console.error(error);
  }
}
start();
