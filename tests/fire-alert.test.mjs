import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveFireAlert} from '../fire-alert.mjs';

const now=Date.parse('2026-10-12T04:00:00Z'),hour=3_600_000;
const iso=time=>new Date(time).toISOString();
const ready=()=>({state:'ready',checked_at:iso(now),window_start:iso(now-168*hour),sources:['VIIRS_SNPP_NRT','VIIRS_NOAA20_NRT','VIIRS_NOAA21_NRT'].map(id=>({id,state:'ready',last_success_at:iso(now),source_updated_at:iso(now-hour)}))});
const detection=(properties={})=>({properties:{detected_at:iso(now-hour),inside:false,distance_km:12,confidence:'nominal',...properties}});
const derive=(features=[],status=ready(),extra={})=>deriveFireAlert({features,status,now,...extra});

test('no fresh detections means Pantau, with no claim of safety',()=>{
  const alert=derive();assert.equal(alert.key,'pantau');assert.equal(alert.insideCount,0);assert.equal(alert.nearbyCount,0);
  assert.match(alert.description,/tidak menjamin kawasan bebas api/);
});
test('geographic categories distinguish nearby observations from inside, irrespective of confidence or record count',()=>{
  assert.equal(derive([detection({confidence:'high'})]).key,'waspada');
  assert.equal(derive(Array.from({length:100},()=>detection())).key,'waspada');
  const alert=derive([detection(),detection({inside:true,distance_km:0,confidence:'low'})]);
  assert.equal(alert.key,'siaga');assert.equal(alert.insideCount,1);assert.equal(alert.nearbyCount,1);
});
test('24 hour interval includes exact endpoints, excludes older and future observations',()=>{
  const alert=derive([
    detection({detected_at:iso(now-24*hour),inside:true}),
    detection({detected_at:iso(now)}),
    detection({detected_at:iso(now-24*hour-1),inside:true}),
    detection({detected_at:iso(now+1),inside:true}),
  ]);
  assert.equal(alert.insideCount,1);assert.equal(alert.nearbyCount,1);assert.equal(alert.latestDetectedAt,iso(now));
});
test('dates with WITA offsets and UTC identify the same absolute 24 hour window',()=>{
  const result=derive([detection({detected_at:'2026-10-11T12:00:00+08:00'}),detection({detected_at:'2026-10-11T11:59:59+08:00'})]);
  assert.equal(result.nearbyCount,1);
});
test('distance is measured from the boundary and 25 km is inclusive',()=>{
  const alert=derive([detection({distance_km:25}),detection({distance_km:25.001})]);
  assert.equal(alert.nearbyCount,1);
  assert.equal(derive([detection({distance_km:25.001})]).key,'pantau');
});
test('missing, failed, partial, or failed-load data never produce a zero-detection category',()=>{
  assert.equal(deriveFireAlert({now}).key,'unknown');
  assert.equal(deriveFireAlert({now,status:ready()}).countsAvailable,false);
  for(const state of ['error','partial','loading']){
    const result=derive([detection({inside:true})],{...ready(),state});
    assert.equal(result.key,'unknown');assert.equal(result.insideCount,1);assert.equal(result.countsAvailable,true);
    assert.match(result.description,/Tercatat 1 deteksi dalam KHDTK/);
  }
  assert.equal(derive([],ready(),{loadError:true}).key,'unknown');
});
test('six hour freshness expires in long-lived tabs even if the fetched state was ready',()=>{
  assert.equal(derive([],ready(),{now:now+6*hour+1}).key,'unknown');
  assert.equal(derive([],{...ready(),checked_at:iso(now-6*hour-1)}).key,'unknown');
  assert.equal(derive([],{...ready(),checked_at:iso(now+hour)}).key,'unknown');
});
test('unavailable or old individual sources keep ready-looking top level status unknown',()=>{
  for(const source of [
    {state:'error',last_success_at:iso(now)},
    {state:'ready',last_success_at:iso(now-7*hour)},
    {state:'ready',last_success_at:iso(now),source_updated_at:iso(now-7*hour)},
  ]) {const status=ready();Object.assign(status.sources[1],source);assert.equal(derive([],status).key,'unknown');}
  assert.equal(derive([],{...ready(),sources:[]}).key,'unknown');
  assert.equal(derive([],{...ready(),sources:ready().sources.slice(0,2)}).key,'unknown');
});
test('a data window shorter than 24 hours is incomplete',()=>{
  assert.equal(derive([],{...ready(),window_start:iso(now-12*hour)}).key,'unknown');
  assert.equal(derive([],{...ready(),window_start:undefined}).key,'unknown');
});
test('retained stale observations remain visible but do not assign an alert category',()=>{
  const alert=derive([detection({inside:true,stale:true})]);
  assert.equal(alert.key,'unknown');assert.equal(alert.insideCount,1);
  assert.equal(derive([detection({stale:true,detected_at:iso(now-25*hour)})]).key,'pantau');
});
test('malformed relevant observations cannot silently become a safe-looking zero',()=>{
  for(const properties of [{detected_at:'bad'},{detected_at:'2026-10-12T03:00:00'},{inside:undefined},{distance_km:NaN},{distance_km:-1}]){
    assert.equal(derive([detection(properties)]).key,'unknown');
  }
});
test('classification does not mutate input detections or source status',()=>{
  const features=[detection(),detection({inside:true})],status=ready(),before=JSON.stringify({features,status});
  derive(features,status);assert.equal(JSON.stringify({features,status}),before);
});
