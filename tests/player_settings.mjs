import "./i18n_test_helpers.mjs";
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({URL, console});
vm.runInContext(readFileSync(new URL('../static/player-settings.js', import.meta.url), 'utf8'), context);
const player = context.GivPlayer;
let count = 0;
function test(name, run) { run(); count++; console.log('ok  ' + name); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
test('default bindings retain M, native fullscreen and both requested 150% keys', () => {
  assert.equal(player.DEFAULT_SHORTCUTS.mute, 'KeyM');
  assert.equal(player.DEFAULT_SHORTCUTS.fullscreen, 'Ctrl+KeyF');
  assert.equal(player.DEFAULT_SHORTCUTS.size150, 'Ctrl+Digit3');
  assert.equal(player.DEFAULT_SHORTCUTS.size150Alt, 'Ctrl+Digit4');
  assert.equal(player.DEFAULT_SHORTCUTS.previousGroup, 'Ctrl+ArrowLeft');
  assert.equal(player.DEFAULT_SHORTCUTS.nextGroup, 'Ctrl+ArrowRight');
  assert.equal(player.DEFAULT_SHORTCUTS.seekBack, 'ArrowLeft');
  assert.equal(player.DEFAULT_SHORTCUTS.previousFrame, 'KeyD');
  assert.equal(player.DEFAULT_SHORTCUTS.nextFrame, 'KeyF');
});
test('keyboard recording canonicalizes modifiers and ignores duplicate repeats', () => {
  assert.equal(player.normalizeChord(['KeyM','ControlLeft','KeyM']), 'Ctrl+KeyM');
  assert.equal(player.normalizeChord(['ShiftRight','KeyK','ControlRight']), 'Ctrl+Shift+KeyK');
  assert.equal(player.normalizeChord(['ControlLeft']), '');
});
test('system and browser-reserved combinations are not accepted', () => {
  for (const chord of ['Alt+F4','Ctrl+KeyW','Ctrl+KeyR','Meta+KeyM','Ctrl+Alt+Delete']) assert.equal(player.normalizeChord(chord),'');
  assert.equal(player.normalizeChord('Ctrl+BadCode'), '');
});
test('live keys use exact modifier state and release tracking', () => {
  assert.equal(player.eventChord({code:'KeyM',ctrlKey:true},new Set(['ControlLeft','KeyM'])), 'Ctrl+KeyM');
  assert.equal(player.eventChord({code:'KeyM'},new Set(['KeyM'])), 'KeyM');
  assert.equal(player.eventChord({code:'KeyK',ctrlKey:true},new Set(['ControlLeft','KeyM','KeyK'])), 'Ctrl+KeyK+KeyM');
});
test('contain can enlarge low resolution content and preserve portrait aspect', () => {
  assert.deepEqual(plain(player.containedSize(640,360,1920,1080)),{width:1920,height:1080});
  assert.deepEqual(plain(player.containedSize(1080,1920,800,600)),{width:337.5,height:600});
  assert.equal(player.containedSize(0,1920,800,600),null);
  assert.equal(player.containedSize(Infinity,100,800,600),null);
});
test('only an explicit trusted post URL can reach native Grok navigation', () => {
  const post='https://grok.com/imagine/post/12345678-1234-4321-8123-123456789abc';
  assert.equal(player.safeRemoteUrl(post+'?token=secret#fragment'),post);
  for (const url of ['javascript:alert(1)','https://grok.com.evil.test/imagine/post/12345678-1234-4321-8123-123456789abc','https://user:password@grok.com/imagine/post/12345678-1234-4321-8123-123456789abc','https://grok.com:444/imagine/post/12345678-1234-4321-8123-123456789abc','https://grok.com/imagine/post/------------------------------------']) assert.equal(player.safeRemoteUrl(url),null);
  assert.equal(player.remoteUrlForItem({id:'12345678-1234-4321-8123-123456789abc'}), post);
  assert.equal(player.remoteUrlForItem({id:'12345678-1234-4321-8123-123456789abc', remoteUrl: post + '?token=secret'}), post);
  assert.equal(player.remoteUrlForItem({id:'12345678-1234-4321-8123-123456789abc', conversationId:'019f9fea-c066-7080-b4c7-5ffd2a1d5100'}), post + '?conversation=019f9fea');
  assert.equal(player.remoteUrlForItem({id:'12345678-1234-4321-8123-123456789abc', remoteUrl: post, conversationId:'019f9fea-c066-7080-b4c7-5ffd2a1d5100'}), post + '?conversation=019f9fea');
  assert.equal(player.safeRemoteUrl(post + '?conversation=019f9fea&token=secret'), post + '?conversation=019f9fea');
  assert.equal(player.safeRemoteUrl(post + '?conversation=019f9fea-c066-7080-b4c7-5ffd2a1d5100'), post + '?conversation=019f9fea-c066-7080-b4c7-5ffd2a1d5100');
  assert.equal(player.safeRemoteUrl(post + '?conversation=not-a-conversation'), post);
  assert.equal(player.remoteUrlForItem({id:'not-a-post'}), null);
  assert.equal(player.remoteUrlForItem({id:'javascript:alert(1)'}), null);
});
test('download diagnostics preserve numeric evidence without arbitrary fields', () => {
  const result=plain(player.cleanFailure({assetId:'asset-1',stage:'validation',code:'manifest_size_mismatch',attempt:1,expectedBytes:12,receivedBytes:20,elapsedMs:40,message:'大小不符',cookie:'secret',url:'https://private.example',retryable:false,chain:{prepareFinished:true,nativeDownloadStartSeen:false,tauriFinishedSeen:true,nativeStateChanged:2,blobSha:'abc123def456',permissionHost:'grok.com',url:'blob:https://grok.com/secret'}}));
  assert.equal(result.expectedBytes,12);assert.equal(result.receivedBytes,20);assert.equal(result.elapsedMs,40);
  assert.equal(result.cookie,undefined);assert.equal(result.url,undefined);
  assert.equal(result.chain.blobSha,'abc123def456');
  assert.equal(result.chain.nativeDownloadStartSeen,false);
  assert.equal(result.chain.tauriFinishedSeen,true);
  assert.equal(result.chain.nativeStateChanged,2);
  assert.equal(result.chain.permissionHost,'grok.com');
  assert.equal(result.chain.url,undefined);
  assert.equal(player.cleanPermission({kind:7,host:'grok.com',state:0,duringRun:true,allowed:true,uri:'https://signed.example'}).kind,7);
  assert.equal(player.cleanPermission({kind:7,host:'grok.com',uri:'https://signed.example'}).uri,undefined);
  assert.equal(player.cleanPermission({kind:7,host:'https://evil.example'}),null);
});
test('diagnostic messages cannot reveal credential or URL text', () => {
  const base={assetId:'asset-1',stage:'prepare',code:'network',message:'Bearer secret'};
  assert.equal(player.cleanFailure(base).message,'network');
  assert.equal(player.cleanFailure({...base,message:'https://signed.example'}).message,'network');
  assert.equal(player.cleanFailure({...base,assetId:'../../secret'}),null);
  assert.equal(player.cleanFailure({...base,httpStatus:-1}).httpStatus,undefined);
});
test('home settings button uses the Lucide settings mark', () => {
  const src = readFileSync(new URL('../static/player-settings.js', import.meta.url), 'utf8');
  assert.ok(src.includes('M9.671 4.136a2.34 2.34 0 0 1 4.659 0'), 'settings icon must be Lucide Settings');
  assert.ok(src.includes('["circle", {cx: "12", cy: "12", r: "3"}]'), 'Lucide Settings keeps the inner circle');
});
test('backdrop dismissal rejects inner clicks, drags, cancellation and keyboard clicks', () => {
  const listeners = new Map();
  const dialog = {open: true, closes: 0,
    getBoundingClientRect: () => ({left:100, top:100, right:400, bottom:400}),
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    close() { this.open = false; this.closes++; },
  };
  player.bindDialogBackdrop(dialog);
  const fire = (type, options = {}) => { for (const fn of listeners.get(type) || []) fn({target:dialog, button:0, pointerId:1, clientX:20, clientY:20, detail:1, ...options}); };
  const gesture = (from, to) => { fire('pointerdown', from); fire('pointerup', to); fire('click', to); };
  gesture({clientX:200, clientY:200}, {clientX:200, clientY:200});
  gesture({target:{}}, {});
  gesture({}, {clientX:40});
  fire('pointerdown'); fire('pointercancel'); fire('click');
  fire('click', {detail:0});
  assert.equal(dialog.closes, 0);
  gesture({}, {});
  assert.equal(dialog.closes, 1);
});
test('playback modes report startup strategy and pending restart without claiming measured hardware decode', () => {
  assert.match(player.playbackAccelText({supported:true, requested:'cpu', effective:'auto', restartRequired:true}), /本次启动策略：自动.*CPU 解码.*重启/);
  assert.match(player.playbackAccelText({supported:true, requested:'gpu', effective:'gpu', restartRequired:false}), /不保证.*硬解/);
  assert.match(player.playbackAccelText(null), /浏览器使用自己的/);
});
test('dedup apply is bound to the exact preview and library, not implicit defaults', () => {
  assert.deepEqual(plain(player.dedupRequest('fixture', false)), {expectedRoot:'fixture',apply:false,actions:{}});
  assert.throws(() => player.dedupRequest('fixture', true, {}, null), /重新检查/);
  assert.throws(() => player.dedupRequest('other', true, {}, {root:'fixture',token:'preview'}), /重新检查/);
  assert.deepEqual(plain(player.dedupRequest('fixture', true, {'group':'skip'}, {root:'fixture',token:'preview'})), {expectedRoot:'fixture',apply:true,actions:{group:'skip'},planToken:'preview'});
});
console.log(`${count} player/settings tests passed`);
