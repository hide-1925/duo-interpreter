/* Isolated, metadata-only Teams DOM sensor. Never reads captions or transcript. */
(() => {
  'use strict';
  if(window!==window.top||window.__duoTeamsSpeakers)return;window.__duoTeamsSpeakers=true;
  const START_MS=200,END_MS=300,OUTLINE='[data-tid="voice-level-stream-outline"]';
  const TILE='[data-participant-id],[data-tid="participant-tile"],[data-tid="video-tile"],[data-tid="roster-list-item"]';
  const NAME='[data-tid="participant-name"],[data-tid="display-name"],[data-tid="roster-list-item-name"]';
  const session=crypto.randomUUID(),registry=new Map(),nodes=new WeakMap(),stable=new Map();
  let seq=0,lastSend=0,events=[],stopped=false;
  function visible(el){return !!el&&el.isConnected&&el.getAttribute('aria-hidden')!=='true'&&getComputedStyle(el).display!=='none'&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0;}
  function participant(tile,now){
    const raw=tile.getAttribute('data-participant-id')||tile.getAttribute('data-user-id');
    let key=(raw&&stable.get(raw))||nodes.get(tile);
    if(!key){key='teams-'+String(++seq).padStart(3,'0');nodes.set(tile,key);if(raw)stable.set(raw,key);registry.set(key,{speakerKey:key,displayName:'',firstSeenAt:now,lastSeenAt:now,candidate:0,absent:0,startedAt:0});}
    const p=registry.get(key);p.lastSeenAt=now;
    const nameNode=tile.querySelector(NAME),name=(nameNode?.textContent||'').trim().slice(0,160);
    if(name&&name!==p.displayName){p.displayName=name;events.push({kind:'speaker-name-resolved',speakerKey:key,displayName:name,observedAt:now});}
    return p;
  }
  async function scan(){
    if(stopped)return;const now=Date.now(),seen=new Set();let available=false;
    document.querySelectorAll(TILE).forEach(tile=>{if(visible(tile)){participant(tile,now);available=true;}});
    document.querySelectorAll(OUTLINE).forEach(outline=>{
      if(!visible(outline)||outline.getAttribute('data-active')==='false')return;
      const tile=outline.closest(TILE);if(!tile)return;available=true;const p=participant(tile,now);seen.add(p.speakerKey);
      p.absent=0;if(!p.candidate)p.candidate=now;
      if(!p.startedAt&&now-p.candidate>=START_MS){p.startedAt=p.candidate;events.push({kind:'speaker-start',speakerKey:p.speakerKey,displayName:p.displayName,observedAt:p.startedAt,source:'teams-dom-outline'});if(!p.displayName)events.push({kind:'speaker-name-missing',speakerKey:p.speakerKey,observedAt:now});}
    });
    registry.forEach(p=>{if(seen.has(p.speakerKey))return;p.candidate=0;if(p.startedAt){if(!p.absent)p.absent=now;if(now-p.absent>=END_MS){events.push({kind:'speaker-end',speakerKey:p.speakerKey,observedAt:p.absent});p.startedAt=0;p.absent=0;}}});
    if(!events.length&&now-lastSend<2000)return;lastSend=now;
    const data={session,available,observedAt:now,participants:Array.from(registry.values()).slice(-500).map(({speakerKey,displayName,firstSeenAt,lastSeenAt})=>({speakerKey,displayName,firstSeenAt,lastSeenAt})),active:Array.from(registry.values()).filter(p=>p.startedAt).map(p=>({speakerKey:p.speakerKey,startedAt:p.startedAt})),events:events.splice(0,200)};
    try{await chrome.runtime.sendMessage({type:'DUO_TEAMS_SPEAKERS',data});}catch(_){/* Metadata failure must not interrupt audio. */}
  }
  const timer=setInterval(scan,100);addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);},{once:true});
})();
