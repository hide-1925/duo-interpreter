'use strict';
// Ephemeral opt-in. Worker restart, navigation, relay failure => no active session.
let conferenceSession=null,lastStoppedConference=null,conferenceError='',conferenceWrites=Promise.resolve(),conferenceLog=[];
function conferenceQueue(fn){const task=conferenceWrites.then(fn);conferenceWrites=task.catch(()=>{});return task;}
function conferenceDiagnostic(data){conferenceLog.push({at:Date.now(),...data});conferenceLog=conferenceLog.slice(-150);}
function conferencePublic(){return {active:conferenceSession?.phase==='active',pending:conferenceSession?.phase==='pending',error:conferenceError,diagnostics:conferenceLog};}
async function conferenceStop(reason,error){const session=conferenceSession;conferenceSession=null;if(!session)return;lastStoppedConference=session;if(error)conferenceError=String(error);clearTimeout(session.timeout);
  await Promise.allSettled([
    chrome.tabs.sendMessage(session.htmlTabId,{type:'DUO_CONFERENCE_HTML',data:{kind:'stop',token:session.token}},{documentId:session.htmlDocumentId}),
    chrome.tabs.sendMessage(session.targetTabId,{type:'DUO_CONFERENCE_TARGET',data:{kind:'stop',token:session.token}},{documentId:session.targetDocumentId})]);
  conferenceDiagnostic({reason,webConferenceMicEnabled:false});await conferenceNotify();
}
async function conferenceNotify(){const state=await getState();if(state.targetTabId)await sendOverlayMessage(state.targetTabId,{type:'DUO_CONFERENCE_STATE',state:conferencePublic()}).catch(()=>{});chrome.runtime.sendMessage({type:'DUO_CONFERENCE_STATE',state:conferencePublic()}).catch(()=>{});}
async function conferenceToggle(sender){
  if(sender.url!==chrome.runtime.getURL('popup.html'))await validateOverlayFrameSender(sender);
  if(conferenceSession){await conferenceStop('user');return {ok:true,...conferencePublic()};}
  conferenceError='';
  const state=await getState();if(!state.htmlTabId||!state.targetTabId)throw Error('HTML本体と会議タブを接続してください');
  const target=await chrome.tabs.get(state.targetTabId);if(!/^https:\/\/(?:teams\.(?:microsoft|live)\.com|teams\.cloud\.microsoft)\//.test(target.url||''))throw Error('会議マイク送出は現在TeamsのWeb版に対応しています');
  const frames=await chrome.webNavigation.getAllFrames({tabId:state.targetTabId});
  const teamsFrames=(frames||[]).filter(f=>/^https:\/\/(?:teams\.(?:microsoft|live)\.com|teams\.cloud\.microsoft)\//.test(f.url||''));
  if(!teamsFrames.length)throw Error('Teamsの会議ページを検出できません。対象タブを選び直してください');
  const frameTarget=teamsFrames.every(f=>f.documentId)?{tabId:state.targetTabId,documentIds:teamsFrames.map(f=>f.documentId)}:{tabId:state.targetTabId,frameIds:teamsFrames.map(f=>f.frameId)};
  const probes=await chrome.scripting.executeScript({target:frameTarget,world:'MAIN',func:()=>({ready:!!window.DuoTeamsAdapter,discovery:window.DuoTeamsAdapter?.discovery?.()||null})});
  conferenceDiagnostic({event:'frame-discovery',frames:probes.map(p=>({frameId:p.frameId??0,documentId:p.documentId,ready:!!p.result?.ready,discovery:p.result?.discovery||null}))});
  const ready=probes.filter(p=>p.result?.ready),eligible=ready.filter(p=>p.result?.discovery?.eligibleCount>0);
  if(!ready.length)throw Error('拡張を更新した後、Teamsタブを再読み込みして会議に参加してください');
  if(eligible.length>1)throw Error('複数の会議音声を検出しました。対象タブで使う会議を1つにしてください');
  const withAudio=ready.filter(p=>p.result?.discovery?.audioSenderCount>0);
  const probe=eligible[0]||(withAudio.length===1?withAudio[0]:ready.find(p=>(p.frameId??0)===0))||ready[0];
  const session={token:crypto.randomUUID(),htmlTabId:state.htmlTabId,htmlDocumentId:state.htmlDocumentId,targetTabId:state.targetTabId,targetDocumentId:probe.documentId,targetFrameId:probe.frameId??0,phase:'pending'};conferenceSession=session;
  session.timeout=setTimeout(()=>conferenceQueue(()=>conferenceStop('connection-timeout','接続がタイムアウトしました。HTML本体のWebプリセットとTTS設定を確認してください')),20000);
  try{const r=await chrome.tabs.sendMessage(session.htmlTabId,{type:'DUO_CONFERENCE_HTML',data:{kind:'start',token:session.token}},{documentId:session.htmlDocumentId});if(!r?.ok)throw Error('HTML本体を再接続してください');}
  catch(error){await conferenceStop('start-error');throw error;}
  await conferenceNotify();return {ok:true,...conferencePublic()};
}
async function conferenceSignal(data,sender){
  if(data?.kind==='diagnostic'&&data.token===lastStoppedConference?.token&&sender.tab?.id===lastStoppedConference.targetTabId&&sender.documentId===lastStoppedConference.targetDocumentId&&sender.frameId===lastStoppedConference.targetFrameId){conferenceDiagnostic(data);if(data.error){conferenceError=data.error;await conferenceNotify();}return {ok:true};}
  const s=conferenceSession;if(!s||data?.token!==s.token)throw Error('会議音声の接続は無効です');
  const fromHtml=sender.tab?.id===s.htmlTabId&&sender.documentId===s.htmlDocumentId&&sender.frameId===0;
  const fromTarget=sender.tab?.id===s.targetTabId&&sender.documentId===s.targetDocumentId&&sender.frameId===s.targetFrameId;
  if(!fromHtml&&!fromTarget)throw Error('会議音声の送信元が一致しません');
  if(data.kind==='error'||data.kind==='stopped'){conferenceDiagnostic({error:data.error||'',reason:data.reason||data.kind});await conferenceStop(data.kind,data.error||(data.reason==='connection-timeout'?'接続がタイムアウトしました':''));return {ok:true};}
  if(data.kind==='offer'&&fromHtml){if(!data.description||JSON.stringify(data.description).length>100000)throw Error('不正なSDPです');await chrome.tabs.sendMessage(s.targetTabId,{type:'DUO_CONFERENCE_TARGET',data},{documentId:s.targetDocumentId});}
  else if(data.kind==='answer'&&fromTarget){await chrome.tabs.sendMessage(s.htmlTabId,{type:'DUO_CONFERENCE_HTML',data},{documentId:s.htmlDocumentId});}
  else if((data.kind==='mode'||data.kind==='gain')&&fromHtml){if(data.kind==='mode'&&!['tts-only','original-plus-tts','original-only'].includes(data.mode))throw Error('Invalid audio mode');await chrome.tabs.sendMessage(s.targetTabId,{type:'DUO_CONFERENCE_TARGET',data},{documentId:s.targetDocumentId});}
  else if(data.kind==='active'&&fromTarget){s.phase='active';clearTimeout(s.timeout);conferenceDiagnostic({webConferenceMicEnabled:true,conferenceAdapter:'teams'});await chrome.tabs.sendMessage(s.htmlTabId,{type:'DUO_CONFERENCE_HTML',data},{documentId:s.htmlDocumentId});await conferenceNotify();}
  else if((data.kind==='diagnostic'||data.kind==='mode-applied')&&fromTarget){conferenceDiagnostic(data);await chrome.tabs.sendMessage(s.htmlTabId,{type:'DUO_CONFERENCE_HTML',data},{documentId:s.htmlDocumentId});}
  else throw Error('不正な会議音声メッセージです');return {ok:true};
}
async function conferenceLease(message,sender){const s=conferenceSession;if(!s||message.token!==s.token||sender.tab?.id!==s.targetTabId||sender.documentId!==s.targetDocumentId||sender.frameId!==s.targetFrameId)return {ok:false};return {ok:true};}
async function teamsSpeakerSignal(data,sender){
  const state=await getState();if(sender.tab?.id!==state.targetTabId||sender.frameId!==0||!/^https:\/\/(?:teams\.(?:microsoft|live)\.com|teams\.cloud\.microsoft)\//.test(sender.url||''))return {ok:false};
  if(!data||JSON.stringify(data).length>250000||!Array.isArray(data.events)||!Array.isArray(data.participants))return {ok:false};
  const current=await chrome.webNavigation.getFrame({tabId:sender.tab.id,frameId:0});if(!current||current.documentId!==sender.documentId)return {ok:false};
  if(state.htmlTabId&&state.htmlDocumentId)await chrome.tabs.sendMessage(state.htmlTabId,{type:'DUO_TEAMS_SPEAKERS',data},{documentId:state.htmlDocumentId}).catch(()=>{});return {ok:true};
}
async function duoTextCommand(message,sender){
  if(sender.url!==chrome.runtime.getURL('popup.html'))await validateOverlayFrameSender(sender);
  const state=await getState();if(!state.htmlTabId)throw Error('HTML本体を接続してください');
  const text=String(message.text||'').trim();if(!text||text.length>12000)throw Error('1〜12000文字で入力してください');
  const [result]=await chrome.scripting.executeScript({target:{tabId:state.htmlTabId,documentIds:[state.htmlDocumentId]},world:'MAIN',func:async(text,mode,id)=>{
    if(typeof window.duoSubmitExternalText!=='function')return {ok:false,error:'HTML本体をv1.46.0以降に更新してください'};
    try{return await window.duoSubmitExternalText(text,mode,id);}catch(error){return {ok:false,error:String(error.message||error)};}
  },args:[text,['A','B'].includes(message.seat)?message.seat:'auto',String(message.requestId||crypto.randomUUID()).slice(0,100)]});
  return result?.result||{ok:false,error:'HTML本体へ入力を送れませんでした'};
}
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading'&&conferenceSession&&[conferenceSession.htmlTabId,conferenceSession.targetTabId].includes(id))conferenceQueue(()=>conferenceStop('navigation'));});
chrome.tabs.onRemoved.addListener(id=>{if(conferenceSession&&[conferenceSession.htmlTabId,conferenceSession.targetTabId].includes(id))conferenceQueue(()=>conferenceStop('tab-closed'));});
