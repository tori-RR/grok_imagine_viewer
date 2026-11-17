import "./i18n_test_helpers.mjs";
// Behaviour checks execute functions extracted from the shipped zero-build IIFE.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const originalHarness = readFileSync(new URL('./frontend_behavior.mjs', import.meta.url), 'utf8');
const scanner = originalHarness.slice(originalHarness.indexOf('const REGEX_PRECEDERS'), originalHarness.indexOf('const failures'));
const extract = new Function('assert', 'source', scanner+'\nreturn extract;')(assert, source);
const build = (names, scope, result) => new Function(...Object.keys(scope), names.map(n=>extract(n)).join('\n')+'\nreturn '+result+';')(...Object.values(scope));
let passed=0;
async function check(name, run) { await run(); passed++; console.log('ok  '+name); }

await check('A/B keys work on the seek slider without taking its arrow keys',()=>{
  const calls=[];
  const keys=build(['typingTarget','previewKeys'],{
    state:{preview:{open:true}},loopOn:false,
    setLoopPoint:x=>calls.push(x),clearAbLoop:()=>calls.push('clear'),onLoopIconClick:()=>calls.push('loop'),
    stepPreview:()=>calls.push('step'),stepCombo:()=>calls.push('combo'),togglePreviewPlay:()=>calls.push('play')
  },'previewKeys');
  for(const key of ['[',']','\\','L']) keys({key,target:{tagName:'INPUT',id:'cpSeek',type:'range'},preventDefault(){},stopPropagation(){}});
  assert.deepEqual(calls,['a','b','clear','loop']);
  keys({key:'ArrowRight',target:{tagName:'INPUT',id:'cpSeek',type:'range'},preventDefault(){throw Error('slider arrow captured');}});
  assert.equal(calls.length,4);
});
await check('text entry, composition and modifier keys remain protected',()=>{
  const keys=build(['typingTarget','previewKeys'],{state:{preview:{open:true}},setLoopPoint:()=>{throw Error('text entry stolen');}},'previewKeys');
  keys({key:'[',target:{tagName:'INPUT',type:'text'}});
  keys({key:'[',isComposing:true,target:{tagName:'VIDEO'}});
  keys({key:'[',ctrlKey:true,target:{tagName:'VIDEO'}});
});
await check('group badges are a removable union, separate from group-owned fields',()=>{
  const state={meta:{groups:{'combos/g':{fav:false,dislike:false,tags:['own']}},items:{a:{fav:true,tags:['ACG']},b:{tags:['ACG','role']}}}};
  const flags=build(['groupOwnFlags','groupFlags'],{state,groupKey:(s,f)=>s+'/'+f},'groupFlags');
  const entry={memberIds:['a','b']};
  assert.deepEqual(flags('combos','g',entry).tags,['own','ACG','role']);
  assert.equal(flags('combos','g',entry).fav,true);
  state.meta.items.a={fav:false,tags:[]}; state.meta.items.b={tags:['role']};
  assert.deepEqual(flags('combos','g',entry).tags,['own','role']);
  assert.equal(flags('combos','g',entry).fav,false);
  assert.deepEqual(state.meta.groups['combos/g'].tags,['own']);
});
await check('combo order uses latest child but flat and other orders do not',()=>{
  const rows=[{id:'a',created:'2026-08-01T00:00:00Z',latestItemCreatedAt:'2026-09-11T00:00:00Z'},{id:'b',created:'2026-09-01T00:00:00Z',latestItemCreatedAt:'2026-09-10T00:00:00Z'}];
  const sort=build(['timeValue','stableRowId','sortWall'],{timeValueCache:new Map(),sortMode:()=> 'desc'},'sortWall');
  assert.deepEqual(sort(rows,'group','combos').map(x=>x.id),['a','b']);
  assert.deepEqual(sort(rows,'item').map(x=>x.id),['b','a']);
  assert.deepEqual(sort(rows,'group','_other').map(x=>x.id),['b','a']);
  assert.equal(rows[0].created,'2026-08-01T00:00:00Z');
});
function comboLoader(api) {
  const body=extract('clearComboCache')+'\n'+extract('loadCombo');
  return new Function('api',`let state={root:'A',meta:{revision:1}}, rootGeneration=1, comboCacheEpoch=0; const comboRequests=new Map(),comboResponses=new Map(); ${body}; return {loadCombo,clearComboCache, switchRoot(){state.root='B';rootGeneration++}}`)(api);
}
await check('same combo requests coalesce and the response is cached',async()=>{
  let done,calls=0;const loader=comboLoader(()=>{calls++;return new Promise(r=>done=r);});
  const a=loader.loadCombo('combos','g'),b=loader.loadCombo('combos','g');
  assert.equal(calls,1);done({ok:true,root:'A',items:[]});await Promise.all([a,b]);
  await loader.loadCombo('combos','g');assert.equal(calls,1);
});
await check('same-root refresh rejects stale combo replies and old cleanup',async()=>{
  const resolves=[]; const loader=comboLoader(()=>new Promise(r=>resolves.push(r)));
  const a=loader.loadCombo('combos','g');loader.clearComboCache();const b=loader.loadCombo('combos','g');
  resolves[0]({ok:true,root:'A',items:['old']});assert.equal((await a).stale,true);
  const c=loader.loadCombo('combos','g');assert.equal(resolves.length,2);
  resolves[1]({ok:true,root:'A',items:['new']});assert.deepEqual((await b).items,['new']);assert.deepEqual((await c).items,['new']);
});
await check('a late reply after a real library switch is rejected',async()=>{
  let done;const loader=comboLoader(()=>new Promise(r=>done=r));
  const task=loader.loadCombo('combos','g');loader.switchRoot();done({ok:true,root:'A'});assert.equal((await task).stale,true);
});
await check('group hydration keeps the current media selection and playback',()=>{
  const item={id:'b',url:'/b.mp4',file:'b.mp4',size:40};let preserve=false;
  const state={preview:{open:true,section:'combos',folder:'g',items:[item],index:0,savedId:'b'}};
  const show=build(['openComboPreview'],{state,currentPreviewItem:()=>item,previewStill:()=>true,
    stopHoverVideo(){},closeLightbox(){},$:()=>({}),document:{body:{classList:{add(){}}}},mountFilmstrip(){},paintPreview:v=>preserve=v,previewToken:()=> 'token',setStatus(){}
  },'openComboPreview');
  show({section:'combos',folder:'g',card:{},items:[{id:'a'},item]},0,{gen:1,token:'token'});
  assert.equal(preserve,true);assert.equal(state.preview.index,1);assert.equal(state.preview.savedId,'b');
});
await check('metadata-only repaint does not reset A/B or the media element',()=>{
  let reset=0,load=0;
  const node={classList:{remove(){load++;},add(){load++;}},removeAttribute(){load++;}};
  const paint=build(['paintPreview'],{state:{preview:{items:[{id:'a',media:'video'}],index:0,card:{}},volume:{}},
    $:()=>node,clearAbLoop:()=>reset++,bindPreviewMediaLoad:()=>load++,paintScrub(){},titleOf:()=>'',fmtDate:()=>'',syncPreviewNav(){},paintLoopBar(){},paintPreviewFlags(){},paintFilmCurrent(){},rememberPreviewItem(){}
  },'paintPreview');
  paint(true);assert.equal(reset,0);assert.equal(load,0);
});
await check('thumbnail URLs opt in without changing raw media URLs',()=>{
  let prepares=0;
  const url=build(['coverUrlFor'],{rootGeneration:4,coverSession:'test',prepareCover:()=>prepares++},'coverUrlFor');
  assert.match(url('combos','g','a'),/thumb=1&scope=test-4/);
  assert.match(url('combos','g','a',0,true),/as=media/);
  assert.equal(prepares,1);
});
console.log(`${passed} GPT6PRO behavior tests passed`);
