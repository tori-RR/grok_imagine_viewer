import "./i18n_test_helpers.mjs";
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const harness = readFileSync(new URL('./frontend_behavior.mjs', import.meta.url), 'utf8');
const scanner = harness.slice(harness.indexOf('const REGEX_PRECEDERS'), harness.indexOf('const failures'));
const extract = new Function('assert', 'source', scanner + '\nreturn extract;')(assert, source);
const members = new Function('const flatGroupIndexes = new WeakMap();'+extract('flatGroupMembers')+';return flatGroupMembers;')();
let reads=0;
const rows=Array.from({length:10000},(_,i)=>({id:String(i),get section(){reads++;return 'combos';},folder:'g'+(i%100),url:'/media/'+i}));
assert.equal(members(rows,'combos','g1').length,100);
const firstReads=reads;
for(let i=0;i<100;i++) members(rows,'combos','g'+i);
assert.equal(reads,firstReads, 'repeat group lookup must not re-scan the flat library');
const local=members(rows,'combos','g1');local.pop();
assert.equal(members(rows,'combos','g1').length,100, 'preview list mutations must stay local');
const newer=rows.filter(row=>row.id!=='1');
assert.equal(members(newer,'combos','g1').length,99);
assert.equal(members([{id:'other',section:'combos',folder:'g1'}],'combos','g1')[0].id,'other');
assert.equal(members(null,'combos','g1').length,0);
console.log('ok  flat snapshot index scans once; replacement, group isolation and preview copies remain safe');

await import('../static/player-settings.js');
const text=globalThis.GivPlayer.coverAccelText({covers:true,candidateBackend:'cuda',lastAttempt:{backend:'cuda',succeeded:true}});
assert.match(text,/候选/);assert.match(text,/不等于已验证/);assert.match(text,/缩放：CPU/);assert.match(text,/JPEG 编码：CPU/);
assert.match(globalThis.GivPlayer.coverAccelText({covers:false}),/未找到 FFmpeg/);
console.log('ok  cover UI distinguishes candidate decode, command evidence, scaling and encoding');

const settingsSource = readFileSync(new URL('../static/player-settings.js', import.meta.url), 'utf8');
const settingsExtract = new Function('assert','source',scanner+'\nreturn extract;')(assert, settingsSource);
const calls=[], errors=[], changes=[];
const nodes={accelToggle:{checked:true,disabled:false},accelBackend:{value:'auto',disabled:false,options:[{value:'auto'},{value:'cuda'},{value:'vaapi'}]},accelHint:{textContent:''}};
const api=(_url,options)=>new Promise((resolve,reject)=>calls.push({options,resolve,reject}));
const controller=new Function('api','$','error','adapter','coverAccelText',`
  let coverVersion=0,coverConfirmed=null,coverTail=Promise.resolve();
  ${['coverRequest','paintCoverAccel','loadCoverAccel','saveCoverAccel'].map(n=>settingsExtract(n)).join('\n')}
  return {loadCoverAccel,saveCoverAccel,paintCoverAccel,invalidate(){coverVersion++;}};
`)(api,id=>nodes[id],e=>errors.push(e),{accelChanged:data=>changes.push(data)},globalThis.GivPlayer.coverAccelText);
const tick=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
const state={mode:'auto',backendPreference:'auto',candidateBackend:'cuda',availableBackends:['cuda'],covers:true,ok:true};
const first=controller.loadCoverAccel();await tick();
controller.invalidate();
const latest=controller.loadCoverAccel();await tick();
assert.equal(calls.length,1,'reads and writes share one ordered request queue');
calls[0].resolve({...state,mode:'compat'});await first;await tick();
assert.equal(nodes.accelToggle.checked,true,'closed dialog response cannot repaint new dialog');
assert.equal(calls.length,2);calls[1].resolve(state);await latest;
assert.equal(nodes.accelBackend.options[2].disabled,true);
nodes.accelToggle.checked=false;
const failed=controller.saveCoverAccel();await tick();
assert.equal(nodes.accelToggle.disabled,true);
calls[2].reject(new Error('fixture'));await failed;
assert.equal(nodes.accelToggle.checked,true,'failed save restores last confirmed state');
assert.equal(nodes.accelToggle.disabled,false);
assert.equal(changes.length,0);assert.equal(errors.length,1);
console.log('ok  cover policy serializes I/O, rejects stale modal results and restores failed saves');

{
  const notices=[], pending=[];
  const state={root:'A',meta:{groups:{}},library:{combos:[{folder:'g'}]},preview:{section:'combos',folder:'g',items:[{id:'one',media:'image'}],index:0,savedId:''}};
  const view=new Function('state','groupKey','putMeta','setStatus','t','translate',`let rootGeneration=1;${extract('rememberPreviewItem')};return {run:rememberPreviewItem,switchRoot(){state.root='B';rootGeneration++;}};`)(
    state,()=> 'combos/g',()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),text=>notices.push(text),globalThis.t,x=>x);
  view.run();assert.equal(pending.length,1);assert.equal(state.preview.savedId,'one');
  pending[0].reject(new Error('fixture failure'));await tick();
  assert.equal(state.preview.savedId,'','failed persistence must remain retryable');assert.match(notices[0],/fixture failure/);
  view.run();assert.equal(pending.length,2);view.switchRoot();pending[1].reject(new Error('old root failure'));await tick();
  assert.equal(notices.length,1,'late old-root failures must not overwrite the current status');
  console.log('ok  last-viewed persistence failures are visible, retryable and root scoped');
}

{
  const state={root:'A',metaKnown:true,meta:{groups:{g:{fav:true}},items:{},tags:['keep']}};
  let reply={ok:true,root:'A',metaKnown:false,meta:{version:2,revision:0,groups:{},items:{},tags:[]}};
  const view=new Function('state','api','safeRevision',`let sideStateLoadGen=0,metaRevisionRoot='A',metaRevision=2;const applyViews=()=>{};${extract('applyMeta')};${extract('loadSideState')};return {load:loadSideState};`)(
    state,async url=>url==='/api/meta'?reply:{ok:true,root:'A',views:{}},n=>Number.isSafeInteger(n)&&n>=0?n:null);
  await view.load('A');assert.equal(state.metaKnown,false);assert.equal(state.meta.groups.g.fav,true);assert.deepEqual(state.meta.tags,['keep']);
  const filter=new Function('state','currentView','catsMode',extract('catPass')+';return catPass;')(state,()=>({cats:['fav']}),()=> 'custom');
  assert.equal(filter({fav:false,tags:[]}),true,'unknown favorites must not establish an empty filtered library');
  const put=new Function('state','t',extract('putMeta')+';return putMeta;')(state,globalThis.t);
  await assert.rejects(put({addTag:'x'},'A'),/元数据无法核验/);
  reply={ok:true,root:'A',metaKnown:true,meta:{version:2,revision:3,groups:{},items:{},tags:['restored']}};
  await view.load('A');assert.equal(state.metaKnown,true);assert.deepEqual(state.meta.tags,['restored']);assert.equal(filter({fav:false,tags:[]}),false);
  console.log('ok  unreadable metadata preserves known flags, disables writes and recovers on a verified reload');
}

{
  const selected=[{kind:'trash',item:{id:'modern'}},{kind:'trash',item:{id:'early',legacy:true}},{kind:'item',item:{id:'media'}}];
  const ids=new Function('selectedTargets',extract('selectedTrashIds')+';return selectedTrashIds;')(()=>selected);
  assert.deepEqual(ids(),['modern'],'read-only legacy diagnostics must never enter bulk restore/purge');
  const readonly={};const tile=new Function('legacyTrashTile',extract('trashTile')+';return trashTile;')(()=>readonly);
  assert.equal(tile({legacy:true}),readonly,'legacy entries must bypass selection and destructive action controls');
  const messages=[], mounted=[];const state={root:'A',library:{ok:true}};
  let response={ok:false,error:'fixture unreadable'};
  const render=new Function('state','withLoading','api','showMessage','t','setStatus','mountWall','trashTile','wallSignature','minWidthFor','currentView',`let renderGen=1;${extract('renderTrash')};return renderTrash;`)(
    state,async(_,run)=>run(),async()=>response,text=>messages.push(text),globalThis.t,()=>{},rows=>mounted.push(rows),()=>{},()=>'',()=>100,()=>({}));
  await render(1);assert.equal(messages[0],'fixture unreadable');assert.equal(mounted.length,0);
  response={ok:true,items:[],legacyItems:[{id:'early',legacy:true}],warnings:1};await render(1);
  assert.equal(mounted[0][0].id,'early');assert.equal(state.wallItems.length,1);
  console.log('ok  legacy trash is discoverable without destructive selection; read faults never become a false empty trash');
}

{
  const entry={folder:'g',count:9,images:3,videos:6,coverId:'keep-cover',coverUrl:'/keep-cover',tags:[],created:''};
  const state={cards:new Map(),library:{combos:[entry]},filter:'all',grid:{refresh(){}}};
  const dropped=[],warnings=[];
  const warning = new Function('t',extract('trashReadWarning')+';return trashReadWarning;')(globalThis.t);
  const apply=new Function('state','libListFor','cardKey','comboTileKey','sameTagList','dropGroupsFromWall','resortWallSoon','trashReadWarning','setStatus',extract('applyCardRows')+';return applyCardRows;')(
    state,()=>state.library.combos,(_,f)=>f,(_,f)=>f,()=>true,(_,groups)=>dropped.push(...groups),()=>{},warning,(text)=>warnings.push(text));
  apply('combos',[{folder:'g',count:0,countKnown:false,state:'unavailable',warnings:['trash_records_corrupt'],unavailableIds:['uncertain'],memberIds:['keep-cover']}]);
  assert.equal(entry.count,9,'unknown visibility must preserve last known count');
  assert.equal(entry.images,3);assert.equal(entry.videos,6);assert.equal(entry.coverId,'keep-cover');
  assert.equal(entry.countKnown,false);assert.equal(entry.unavailable,true);assert.deepEqual(dropped,[]);
  assert.deepEqual(entry.unavailableIds,['uncertain']);assert.equal(warnings.length,1);
  const filter=new Function('state','groupFlags','catPass',extract('comboFilterPass')+';return comboFilterPass;')(state,()=>({}),()=>true);
  for(const mode of ['all','image','video']) {state.filter=mode;assert.equal(filter({folder:'g',count:0,images:0,videos:0,countKnown:false},'combos'),true);}
  entry.coverId='deleted-A';entry.coverUrl='/decoded-cached-A';entry.coverReady=true;entry.lastViewedId='deleted-A';
  apply('combos',[{folder:'g',countKnown:false,state:'unavailable',memberIds:['visible-C'],unavailableIds:['broken-B'],coverId:'visible-C',coverMedia:'image',coverFile:'C.jpg',coverUrl:'/verified-C',coverReady:true,warnings:['trash_records_corrupt']}]);
  assert.equal(entry.count,9);assert.equal(entry.coverId,'visible-C');assert.equal(entry.coverUrl,'/verified-C');assert.equal(entry.coverReady,true);
  assert.deepEqual(entry.memberIds,['visible-C']);assert.equal(entry.lastViewedId,'');assert.equal(state.cards.get('g').coverId,'visible-C','cached rows must not keep the confirmed deleted thumbnail');
  apply('combos',[{folder:'g',countKnown:false,state:'unavailable',memberIds:[],unavailableIds:['broken-B'],coverId:'deleted-A',coverUrl:'/must-not-reuse'}]);
  assert.equal(entry.count,9);assert.equal(entry.coverId,'');assert.equal(entry.coverUrl,'');assert.equal(entry.coverReady,false);
  apply('combos',[{folder:'g',count:2,images:1,videos:1,state:'available',tags:[],created:''}]);
  assert.equal(entry.count,2);assert.equal(entry.countKnown,true);assert.equal(entry.unavailable,false);assert.deepEqual(entry.warnings,[]);
  apply('combos',[{folder:'g',count:0,images:0,videos:0,tags:[],created:''}]);
  assert.deepEqual(dropped,['g'],'a genuinely known empty group must still disappear');
  assert.equal(warning({warnings:['other']}),'');
  console.log('ok  uncertain trash visibility preserves tiles/counts/covers, reports warnings and recovers after valid reads');
}

{
  const body=extract('loadCombo');
  const notices=[];
  const load=new Function('api','t','trashReadWarning','setStatus',`const state={root:'A',meta:{revision:1}};let rootGeneration=1,comboCacheEpoch=0;const comboResponses=new Map(),comboRequests=new Map();${body};return loadCombo;`)(
    async()=>({ok:true,root:'A',items:[],card:{countKnown:false},warnings:['trash_records_corrupt']}),globalThis.t,
    new Function('t',extract('trashReadWarning')+';return trashReadWarning;')(globalThis.t),text=>notices.push(text));
  const response=await load('combos','g');
  assert.equal(response.ok,false,'an entirely unknown group must not open as an empty preview');
  assert.equal(response.code,'trash_record_corrupt');assert.equal(notices.length,1);
  console.log('ok  entirely blocked trash visibility produces a visible preview error');
}

{
  let calls=0;
  const state={root:'A',flat:null,flatPromise:null};
  const notices=[];
  const ensure=new Function('state','api','t','setStatus',`let rootGeneration=1;${extract('ensureFlat')};return ensureFlat;`)(state,
    async()=>{calls++;return {ok:false,code:'trash_unavailable',error:'回收站记录暂时无法读取，未将图库判为空。'};},globalThis.t,text=>notices.push(text));
  assert.deepEqual(await ensure(),[]);
  assert.equal(state.flat,null,'trash I/O failure must not become a successful cached empty wall');
  assert.deepEqual(await ensure(),[]);
  assert.equal(calls,2,'a transient unreadable trash index must remain retryable');assert.equal(notices.length,2);
  console.log('ok  trash directory failures stay visible and do not cache an empty flat wall');
}

function flatReadHarness(api) {
  const state={root:'A',library:{ok:true},flat:null,flatIncomplete:null,flatPromise:null,filter:'all',grid:null,ratios:new Map()};
  const messages=[],notices=[],walls=[];
  const code=`let rootGeneration=1,renderGen=1;${extract('trashReadWarning')};${extract('ensureFlat')};${extract('renderFlat')};return {ensureFlat,renderFlat,switchRoot(root){rootGeneration++;renderGen++;state.root=root;state.flat=null;state.flatPromise=null;state.flatIncomplete=null;}};`;
  const functions=new Function('state','api','t','setStatus','clearFlatReadWarning','showMessage','withLoading','sortWall','itemFilterPass','matchesQuery','currentView','wallSignature','mountWall','minWidthFor','isMasonry','mediaTile','mediaTileKey',code)(
    state,api,globalThis.t,text=>notices.push(text),()=>notices.push(''),text=>messages.push(text),(_,run)=>run(),items=>items,()=>state.filter!=='none',()=>true,()=>({}),()=>'',items=>walls.push(items),()=>100,()=>false,item=>item,item=>item.id);
  return {...functions,state,messages,notices,walls};
}

{
  const partial={ok:true,root:'A',items:[{id:'visible-C'}],warnings:['trash_records_corrupt'],unavailableGroups:[{folder:'g',unavailableIds:['broken-B']}]};
  const repaired={ok:true,root:'A',items:[{id:'visible-C'},{id:'repaired-B'}]};
  let calls=0;
  const f=flatReadHarness(async()=>++calls===1 ? partial : repaired);
  assert.deepEqual((await f.ensureFlat()).map(x=>x.id),['visible-C']);
  assert.equal(f.state.flat,null,'a partial response is usable but not a complete cached snapshot');
  assert.equal(f.state.flatIncomplete.root,'A');
  assert.deepEqual((await f.ensureFlat()).map(x=>x.id),['visible-C','repaired-B']);
  assert.equal(calls,2);assert.equal(f.state.flatIncomplete,null);assert.equal(f.notices.at(-1),'','a repaired complete read clears the old read-failure message');await f.ensureFlat();assert.equal(calls,2,'a repaired complete snapshot may be cached');
  console.log('ok  partial flat reads retain visible items, retry after repair and then cache only complete data');
}

{
  let calls=0;
  const f=flatReadHarness(async()=>++calls===1 ? {ok:true,root:'A',items:[],warnings:['trash_records_corrupt'],unavailableGroups:[{folder:'g'}]} : {ok:true,root:'A',items:[]});
  await f.renderFlat();
  assert.match(f.messages.at(-1),/暂不可用|unavailable/);assert.match(f.messages.at(-1),/重试|retry/);
  assert.equal(f.state.flat,null);
  await f.renderFlat();
  assert.equal(calls,2);assert.equal(f.state.flatIncomplete,null);assert.equal(f.messages.at(-1),globalThis.t('没有匹配的媒体。'),'a confirmed complete empty result has the ordinary empty-state message');
  console.log('ok  all-unknown flat reads show retry diagnostics instead of a false empty library');
}

{
  const f=flatReadHarness(async()=>({ok:true,root:'A',items:[{id:'visible-C'}],warnings:['trash_records_corrupt'],unavailableGroups:[{folder:'g'}]}));
  f.state.filter='none';await f.renderFlat();
  assert.match(f.messages.at(-1),/暂不可用|unavailable/);assert.notEqual(f.messages.at(-1),globalThis.t('没有匹配的媒体。'),'filtering a partial list cannot establish no matches');
  let calls=0;
  const directory=flatReadHarness(async()=>++calls===1 ? {ok:false,code:'trash_unavailable'} : {ok:true,root:'A',items:[{id:'repaired'}]});
  await directory.renderFlat();assert.match(directory.messages.at(-1),/重试|retry/);assert.equal(directory.state.flat,null);
  await directory.renderFlat();assert.equal(calls,2);assert.equal(directory.state.flatIncomplete,null);assert.equal(directory.walls.at(-1)[0].id,'repaired');
  console.log('ok  filtered partial lists and directory faults stay unavailable until a successful complete retry');
}

{
  let finishOld,calls=0;
  const f=flatReadHarness(()=>++calls===1 ? new Promise(resolve=>{finishOld=resolve;}) : Promise.resolve({ok:true,root:'B',items:[{id:'visible-B'}],unavailableGroups:[{folder:'B'}]}));
  const old=f.ensureFlat();f.switchRoot('B');assert.equal(f.state.flatIncomplete,null);await f.ensureFlat();
  const current=f.state.flatIncomplete,noticeCount=f.notices.length;
  finishOld({ok:true,root:'A',items:[],unavailableGroups:[{folder:'old-A'}]});await old;
  assert.equal(f.state.flatIncomplete,current);assert.equal(f.state.flatIncomplete.root,'B');assert.equal(f.notices.length,noticeCount,'late old-root errors must not paint new-root warnings');
  assert.match(extract('applyLibrary'),/state\.flatIncomplete = null/);assert.match(extract('refreshAfterChange'),/state\.flatIncomplete = null/);
  console.log('ok  root changes clear incompleteness and late old-root responses cannot overwrite the current read state');
}

{
  const box={textContent:globalThis.t('部分素材暂不可用，当前列表可能不完整。请刷新重试。')};
  const cleared=[];
  const clear=new Function('$','t','setStatus',extract('clearFlatReadWarning')+';return clearFlatReadWarning;')(()=>box,globalThis.t,text=>cleared.push(text));
  clear();assert.deepEqual(cleared,['']);
  box.textContent='newer download progress';clear();assert.deepEqual(cleared,[''],'successful reads cannot erase a newer unrelated status');
  console.log('ok  successful complete retries clear only their own stale failure notice');
}
