// Real Chromium/Web Audio/WebRTC loopback; no Teams account or external service.
// このリポジトリには package.json が無いので playwright はグローバル解決に頼る。
//   NODE_PATH=$(npm root -g) node extension/tests/test-browser.cjs
const http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
let chromium;
try{ ({chromium}=require('playwright')); }
catch(err){
  console.error('playwright を解決できません。NODE_PATH=$(npm root -g) を付けて実行してください。');
  process.exit(2);
}
(async()=>{
 const server=http.createServer((req,res)=>{res.end('<!doctype html><title>Duo local media test</title>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--no-sandbox',
   // mDNS で隠された .local 候補は同一ページ内のループバックで解決できない。実IPを出させる。
   '--disable-features=WebRtcHideLocalIpsWithMdns']});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  for(const f of ['mic-provenance.js','teams.js'])await page.addScriptTag({path:path.join(__dirname,'../conference-adapters',f)});
  const result=await page.evaluate(async()=>{
   const adapter=window.DuoTeamsAdapter,provenance=window.DuoMicProvenance;
   const mic=await navigator.mediaDevices.getUserMedia({audio:true});
   const cloned=mic.clone().getAudioTracks()[0].clone();
   const ac=new AudioContext();await ac.resume();
   const src=ac.createMediaStreamSource(new MediaStream([cloned])),gain=ac.createGain(),dst=ac.createMediaStreamDestination();src.connect(gain).connect(dst);
   const processed=dst.stream.getAudioTracks()[0];
   const pc=new RTCPeerConnection(),other=adapter.createRelayPeer({});
   const sender=pc.addTrack(processed,new MediaStream([processed]));
   /* 候補1つで応答できれば足りる。STUN へ到達できない環境では gathering が
      complete にならないため、完了を待つとここで必ず止まる。製品側の中継も
      v1.4.7 以降は最初の候補で応答する（test-bridge-target.cjs の契約）。 */
   const gather=p=>{
    if(p.iceGatheringState==='complete'||p.localDescription&&/\r\na=candidate:/.test(p.localDescription.sdp))return Promise.resolve();
    return new Promise((resolve,reject)=>{
     const t=setTimeout(()=>reject(Error('ICE timeout: no candidate in 5s (state='+p.iceGatheringState+')')),5000);
     const done=()=>{clearTimeout(t);resolve();};
     p.addEventListener('icecandidate',e=>{if(e.candidate)done();});
     p.addEventListener('icegatheringstatechange',()=>{if(p.iceGatheringState==='complete')done();});
    });
   };
   await pc.setLocalDescription(await pc.createOffer());await gather(pc);await other.setRemoteDescription(pc.localDescription);await other.setLocalDescription(await other.createAnswer());await gather(other);await pc.setRemoteDescription(other.localDescription);
   await new Promise((resolve,reject)=>{if(pc.connectionState==='connected')return resolve();const t=setTimeout(()=>reject(Error('loopback timeout')),5000);pc.addEventListener('connectionstatechange',()=>{if(pc.connectionState==='connected'){clearTimeout(t);resolve();}});});
   const oscillator=ac.createOscillator(),tts=ac.createMediaStreamDestination();oscillator.frequency.value=440;oscillator.connect(tts);oscillator.start();
   const events=[];await adapter.start(tts.stream.getAudioTracks()[0],e=>events.push(e));
   const replaced=sender.track!==processed;
   await new Promise(r=>setTimeout(r,400));let bytes=0;for(const r of (await sender.getStats()).values())if(r.type==='outbound-rtp'&&r.kind==='audio')bytes+=r.bytesSent;
   processed.enabled=false;const mutePreserved=sender.track.enabled===false;await adapter.stop();const restored=sender.track===processed&&!sender.track.enabled;
   const result={cloneProvenance:provenance.inspect(cloned),processedProvenance:provenance.inspect(processed),replaced,mutePreserved,restored,outboundAudioBytes:bytes,discovery:adapter.discovery()};
   oscillator.stop();pc.close();other.close();mic.getTracks().forEach(t=>t.stop());await ac.close();return result;
  });
  assert(result.cloneProvenance.mic);assert(result.processedProvenance.mic);assert(result.replaced);assert(result.mutePreserved);assert(result.restored);assert(result.outboundAudioBytes>0);console.log(JSON.stringify(result,null,2));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
