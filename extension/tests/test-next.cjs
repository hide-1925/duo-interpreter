const path=require('node:path');
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict'),crypto=require('crypto');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8').split('var APP_VERSION =')[0];
const events=[],entries=[];
const context={crypto,console,Map,Set,WeakMap,Date,setTimeout,clearTimeout,setInterval:()=>0,window:{addEventListener(){}},document:{querySelectorAll:()=>[]},CFG:{sttProvider:'openai',ttsMode:'aivis'},S:{entries},SEG:{active:null,queue:[]},manualSayKey:'',dlog:(...a)=>events.push(a),$:()=>null,seatName:s=>'Seat '+s,minutesRefreshStatus(){},refreshTtsBtn(){},store:{set(){}},toast(){},stopSpeaking(){},performance};
const c=vm.createContext(context);vm.runInContext(source,c);c.duoRelayList=()=>{};
const run=s=>vm.runInContext(s,c),tests=[];const test=(n,f)=>{f();tests.push(n);};
const job={sourceScope:'local',sourceParticipantId:'p1',sourceEndpointId:'local-mic',utteranceId:'u',sessionId:'s',playbackIntent:'automatic',ttsType:'translated'};
test('Web and Many to Many use one remote endpoint and permit conference adapters',()=>{for(const p of ['web','many_to_many']){const s=c.duoSessionConfig(p);assert(s.conferenceAvailable);assert.equal(s.bindings.p2,'conference-audio');}});
test('Three participants with the same language can switch local identity by configuration alone',()=>{c.duoSession=c.duoSessionConfig('many_to_many');c.duoSession.participants.p3={participantId:'p3'};c.duoSession.bindings.p3='conference-audio';c.duoSession.view.C='p3';for(const [seat,allowed] of [['A',true],['B',false],['C',false]])assert.equal(c.AudioRoutingPolicy.resolve({...job,...c.AudioEndpointManager.origin(seat,false),sourceLanguage:'ja',outputLanguage:'ja'}).conferenceMic,allowed);c.duoSession.bindings.p1='conference-audio';c.duoSession.bindings.p2='local-mic';for(const [seat,allowed] of [['A',false],['B',true],['C',false]])assert.equal(c.AudioRoutingPolicy.resolve({...job,...c.AudioEndpointManager.origin(seat,false)}).conferenceMic,allowed);});
test('Policy denies missing identity and every manual replay',()=>{for(const mode of ['tts-only','original-plus-tts','original-only']){c.conferenceAudioState.mode=mode;assert(!c.AudioRoutingPolicy.resolve({...job,playbackIntent:'manual-replay'}).conferenceMic);assert(!c.AudioRoutingPolicy.resolve({...job,utteranceId:null}).conferenceMic);}});
test('Only automatic local audio is eligible by default in on and mix',()=>{for(const mode of ['tts-only','original-plus-tts']){c.conferenceAudioState.mode=mode;assert(c.AudioRoutingPolicy.resolve(job).conferenceMic);assert(!c.AudioRoutingPolicy.resolve({...job,sourceScope:'remote',speakerId:'x'}).conferenceMic);}});
test('Remote relay requires opt-in, selected identity, translation and automatic intent',()=>{const s=c.conferenceAudioState;s.mode='tts-only';s.relay=true;s.relayParticipants.add('x');const r={...job,sourceScope:'remote',speakerId:'x'};assert(c.AudioRoutingPolicy.resolve(r).conferenceMic);for(const override of [{speakerId:null},{speakerId:'y'},{ttsType:'original'},{playbackIntent:'manual-replay'}])assert(!c.AudioRoutingPolicy.resolve({...r,...override}).conferenceMic);s.mode='original-only';assert(!c.AudioRoutingPolicy.resolve(r).conferenceMic);s.mode='tts-only';assert(c.AudioRoutingPolicy.resolve(r).conferenceMic);});
/* streaming TTS は PCM バッファごとに ConferenceMicBus.connect へ来る。実測ログでは
   61秒・475件の半分近くが同じ2行の繰り返しで埋まっていた。1時間の記録では trace 上限
   40,000 行に早々に届き、肝心の行が落ちる。判定は job と bus の状態だけで決まるので、
   結果が変わったときだけ書く。ルーティング自体はバッファごとに行う（実際の接続なので）。 */
test('The same job logs its route once, however many buffers the stream produces',()=>{
  c.conferenceAudioState.mode='tts-only';c.conferenceAudioState.relay=false;
  c.ConferenceMicBus.lastRoute={};c.ConferenceMicBus.lastRouteN=0;
  events.length=0;
  const streamed={...job,jobId:'tts-1'};
  for(let i=0;i<40;i++)c.ConferenceMicBus.noteRoute(streamed,{conferenceMic:false});
  const lines=events.length;
  assert.equal(lines,0,'noteRoute itself never logs');
  let wrote=0;
  for(let i=0;i<40;i++)if(c.ConferenceMicBus.noteRoute({...streamed,jobId:'tts-2'},{conferenceMic:false}))wrote++;
  assert.equal(wrote,1,'40 buffers of one job must produce one entry, not 40');
});
test('A different job, and a changed destination, are still reported',()=>{
  c.ConferenceMicBus.lastRoute={};c.ConferenceMicBus.lastRouteN=0;
  const a={...job,jobId:'tts-a'},b={...job,jobId:'tts-b'};
  assert.equal(c.ConferenceMicBus.noteRoute(a,{conferenceMic:false}),true);
  assert.equal(c.ConferenceMicBus.noteRoute(b,{conferenceMic:false}),true,'each job is reported once');
  assert.equal(c.ConferenceMicBus.noteRoute(a,{conferenceMic:false}),false);
  assert.equal(c.ConferenceMicBus.noteRoute(a,{conferenceMic:true}),true,
    'a job that starts reaching the conference mic is a new fact');
  c.ConferenceMicBus.enabled=true;
  assert.equal(c.ConferenceMicBus.noteRoute(a,{conferenceMic:true}),true,
    'and so is the bus being switched on underneath it');
  c.ConferenceMicBus.enabled=false;
});
test('The memo is bounded, so a long meeting cannot grow it without limit',()=>{
  c.ConferenceMicBus.lastRoute={};c.ConferenceMicBus.lastRouteN=0;
  for(let i=0;i<600;i++)c.ConferenceMicBus.noteRoute({...job,jobId:'tts-'+i},{conferenceMic:false});
  assert.ok(Object.keys(c.ConferenceMicBus.lastRoute).length<=257,
    'got '+Object.keys(c.ConferenceMicBus.lastRoute).length);
  assert.ok(c.ConferenceMicBus.lastRouteN<=257);
});
test('A job with no id is always reported rather than silently dropped',()=>{
  c.ConferenceMicBus.lastRoute={};c.ConferenceMicBus.lastRouteN=0;
  assert.equal(c.ConferenceMicBus.noteRoute({...job,jobId:''},{conferenceMic:false}),true);
  assert.equal(c.ConferenceMicBus.noteRoute({...job,jobId:''},{conferenceMic:false}),true);
});
const now=Date.now(),entry={id:'e1',utteranceId:'u1',seat:'B',ts:new Date(now).toISOString(),startedAt:now,endedAt:now+2000,origin:{sourceEndpointId:'conference-audio',presetId:'many_to_many'},srcText:'test',dstText:'translation'};entries.push(entry);
function batch(events,participants=[{speakerKey:'p1',displayName:'Yamada'},{speakerKey:'p2',displayName:'Smith'}]){c.duoSpeakerEvent({session:'meeting',available:true,observedAt:now,participants,events});}
test('Delayed metadata attributes existing card from utterance time, not response time',()=>{batch([{kind:'speaker-start',speakerKey:'p1',observedAt:now},{kind:'speaker-end',speakerKey:'p1',observedAt:now+2000}]);assert.equal(entry.speaker.displayName,'Yamada');assert.equal(entry.speaker.id,'meeting:p1');assert.equal(entry.srcText,'test');assert.equal(entry.dstText,'translation');});
test('Manual edit is locked through further automatic events; reset restores automatic identity',()=>{c.duoSpeakerSet(entry,'meeting:p2');assert(entry.speaker.manuallyLocked);batch([]);assert.equal(entry.speaker.displayName,'Smith');c.duoSpeakerSet(entry,'auto');assert(!entry.speaker.manuallyLocked);assert.equal(entry.speaker.displayName,'Yamada');});
test('Simultaneous speakers stay ambiguous without a forced single identity',()=>{batch([{kind:'speaker-start',speakerKey:'p2',observedAt:now+100},{kind:'speaker-end',speakerKey:'p2',observedAt:now+1800}]);assert.equal(entry.speaker.id,null);assert.equal(entry.speaker.displayName,'複数話者');assert.equal(entry.speaker.candidates.length,2);});
test('Name resolution updates identity without translation or text mutation',()=>{c.DuoSpeakers.timeline=c.DuoSpeakers.timeline.filter(t=>t.id==='meeting:p1');batch([],[{speakerKey:'p1',displayName:'山田 太郎'}]);assert.equal(entry.speaker.displayName,'山田 太郎');assert.equal(entry.dstText,'translation');});
test('Same display name never merges independent participant IDs',()=>{batch([],[{speakerKey:'p1',displayName:'Alex'},{speakerKey:'p2',displayName:'Alex'}]);assert.equal(c.DuoSpeakers.registry.size,2);assert.notEqual(c.DuoSpeakers.registry.get('meeting:p1').speakerKey,c.DuoSpeakers.registry.get('meeting:p2').speakerKey);});
test('Adjacent padded overlap is low confidence',()=>{const r=c.duoSpeakerResolve({...entry,startedAt:now+2200,endedAt:now+2500},now+4000);assert.equal(r.quality,'low');assert.equal(r.confidence,.2);});
test('No speaker metadata falls back without blocking text processing',()=>{const e={...entry,id:'missing',speaker:null,speakerSession:null};c.DuoSpeakers.available=false;c.DuoSpeakers.session=null;c.duoSpeakerUpdate(e);assert.equal(c.duoSpeakerName(e),'Seat B');});
test('Manual export is authoritative and revisions enter minutes fingerprint',()=>{c.duoSpeakerSet(entry,'meeting:p2');const x=c.duoSpeakerExport(entry);assert.equal(x.speaker,'Alex');assert(x.speakerAttribution.manuallyCorrected);assert(x.speakerAttribution.revision>0);assert(source.includes('revision:s.revision'));const full=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');assert(full.includes('schemaVersion:2'));assert(full.includes('cards.push(Object.assign(duoSpeakerExport(e)'));assert(full.includes("'speaker_revision'"));});
test('Automatic off skips all old cards on resume; manual intent remains routable locally',()=>{c.duoSession=c.duoSessionConfig('web');c.conferenceAudioState.connected=true;c.conferenceAudioState.mode='original-only';assert(!c.duoAutomaticAllowed(entry));c.conferenceAudioState.mode='tts-only';c.conferenceAudioState.resumeAfter=now+3000;assert(!c.duoAutomaticAllowed(entry));assert(c.duoAutomaticAllowed({...entry,startedAt:now+3001}));});
test('Legacy and segment manual jobs are tagged before synthesis',()=>{c.manualSayKey='e1:A';let j=c.duoTtsJob('e1:A');assert.equal(j.playbackIntent,'manual-replay');c.manualSayKey='';c.SEG.active={manual:true};j=c.duoTtsJob('e1:A');assert.equal(j.playbackIntent,'manual-replay');c.SEG.active=null;j=c.duoTtsJob('e1:A');assert.equal(j.playbackIntent,'automatic');});
console.log(JSON.stringify({passed:tests.length,tests},null,2));
