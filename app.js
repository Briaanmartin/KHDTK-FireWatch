'use strict';
const data = [
 {id:'FW-001',area:'KHDTK A',time:'11 Okt 2026 · 08:20',confidence:'Tinggi',x:160,y:65},
 {id:'FW-002',area:'KHDTK A',time:'11 Okt 2026 · 08:20',confidence:'Sedang',x:245,y:140},
 {id:'FW-003',area:'KHDTK B',time:'11 Okt 2026 · 09:45',confidence:'Tinggi',x:520,y:70},
 {id:'FW-004',area:'KHDTK B',time:'11 Okt 2026 · 09:45',confidence:'Rendah',x:580,y:150},
 {id:'FW-005',area:'KHDTK C',time:'11 Okt 2026 · 10:10',confidence:'Sedang',x:765,y:170},
 {id:'FW-006',area:'KHDTK C',time:'11 Okt 2026 · 10:10',confidence:'Tinggi',x:810,y:240}
];
const $ = id => document.getElementById(id);
const colors = {Tinggi:'#d76637',Sedang:'#d5a43a',Rendah:'#7e9875'};
function filtered(){return data.filter(d => ($('area').value==='all'||d.area===$('area').value)&&($('confidence').value==='all'||d.confidence===$('confidence').value)&&(d.id+' '+d.area).toLowerCase().includes($('search').value.trim().toLowerCase()));}
function render(){const items=filtered();$('total').textContent=items.length;$('high').textContent=items.filter(d=>d.confidence==='Tinggi').length;$('empty').hidden=items.length>0;$('rows').innerHTML=items.map(d=>`<tr><td>${d.id}</td><td>${d.area}</td><td>${d.time}</td><td><i class="dot" style="background:${colors[d.confidence]}"></i>${d.confidence}</td><td><span class="pill">Contoh · perlu verifikasi</span></td></tr>`).join('');$('markers').innerHTML=items.map(d=>`<g><circle cx="${d.x}" cy="${d.y}" r="13" fill="${colors[d.confidence]}" opacity=".18"/><circle cx="${d.x}" cy="${d.y}" r="5" fill="${colors[d.confidence]}" stroke="white" stroke-width="2"><title>${d.id} · ${d.area} · ${d.confidence} (demo)</title></circle></g>`).join('');}
['area','confidence','search'].forEach(id=>$(id).addEventListener('input',render));
$('reset').addEventListener('click',()=>{$('area').value='all';$('confidence').value='all';$('search').value='';render();});
$('export').addEventListener('click',()=>{const quote=v=>'"'+String(v).replaceAll('"','""')+'"';const rows=[['ID','Kawasan','Waktu demo WITA','Kepercayaan','Jenis data'],...filtered().map(d=>[d.id,d.area,d.time,d.confidence,'DEMO'])];const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'}));const a=document.createElement('a');a.href=url;a.download='khdtk-firewatch-demo.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
render();
