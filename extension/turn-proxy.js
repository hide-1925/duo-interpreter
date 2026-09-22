'use strict';
/* 判断層（Jev 等）への往復だけを中継する。

   ページは別オリジンへ POST しても、サーバが Access-Control-Allow-Origin を出さな
   ければ結果を読めない。api.typesafe.ai は実測で「API は動くが CORS 応答ヘッダを
   出さない」だった。拡張は利用者が許可したホストに対してこの制約を受けないので、
   ここが往復を肩代わりする。

   ただし「何でも投げられる中継」を作ると、拡張そのものが CORS 回避の踏み台になる。
   そうならないように4つ縛る。
     1. 中継先は利用者がポップアップで明示的に許可したオリジン1つだけ
     2. HTTPS のみ
     3. 通すヘッダは下の allowlist だけ（Cookie も Origin も持ち込ませない）
     4. 呼べるのは拡張自身のページと、登録済みHTML本体のタブだけ
   本文と鍵はここでは記録しない。記録すると拡張のログに会議の中身が残る。 */

const TURN_ORIGIN_KEY='duoTurnOrigin';
const TURN_MAX_BODY=262144;        /* state は実測 4KB 前後。256KB あれば足りる */
const TURN_MAX_REPLY=1048576;
const TURN_TIMEOUT_MS=30000;
/* Authorization と Content-Type 以外は、経路が実際に使うものだけ。
   HTTP-Referer / X-Title は OpenRouter が任意で受ける識別用。 */
const TURN_HEADER_ALLOW=new Set(['authorization','content-type',
  'x-typesafe-zero-data-retention','x-typesafe-no-training','http-referer','x-title']);

async function getTurnOrigin(){
  const value=(await chrome.storage.local.get(TURN_ORIGIN_KEY))[TURN_ORIGIN_KEY];
  return typeof value==='string'?value:'';
}
function normalizeTurnOrigin(value){
  let u;try{u=new URL(String(value||'').trim());}catch(_){throw new Error('有効なHTTPSのURLを入力してください');}
  if(u.protocol!=='https:'||u.username||u.password)throw new Error('認証情報を含まないHTTPSのURLを入力してください');
  return u.origin;
}
async function setTurnOrigin(value){
  const origin=normalizeTurnOrigin(value);
  if(!await chrome.permissions.contains({origins:[origin+'/*']}))
    throw new Error('この接続先へのアクセスを許可してください');
  await chrome.storage.local.set({[TURN_ORIGIN_KEY]:origin});
  return {ok:true,turn:await turnPermission()};
}
async function clearTurnOrigin(){
  await chrome.storage.local.remove(TURN_ORIGIN_KEY);
  return {ok:true,turn:await turnPermission()};
}
async function turnPermission(){
  const origin=await getTurnOrigin();
  if(!origin)return {origin:'',allowed:false};
  let allowed=false;
  try{allowed=await chrome.permissions.contains({origins:[origin+'/*']});}catch(_){allowed=false;}
  return {origin,allowed};
}
/* 中継を頼めるのは拡張自身のページと、いま登録されているHTML本体のタブだけ。
   Teams 側の内容スクリプトからは頼めない。 */
async function turnSenderAllowed(sender){
  const prefix=chrome.runtime.getURL('');
  if(sender&&typeof sender.url==='string'&&sender.url.startsWith(prefix))return true;
  const state=await getState();
  return !!(sender&&sender.tab&&state.htmlTabId&&sender.tab.id===state.htmlTabId);
}
async function turnFetch(message,sender){
  if(!await turnSenderAllowed(sender))return {ok:false,error:'この経路からは中継できません'};
  const request=message&&message.request;
  if(!request||typeof request!=='object')return {ok:false,error:'要求の形が不正です'};
  const approved=await getTurnOrigin();
  if(!approved)return {ok:false,needsSetup:true,
    error:'判断層の接続先が未設定です。Duoのポップアップで許可してください'};
  let url;try{url=new URL(String(request.url||''));}catch(_){return {ok:false,error:'URLが不正です'};}
  if(url.protocol!=='https:')return {ok:false,error:'HTTPSのみ中継します'};
  if(url.origin!==approved)return {ok:false,needsSetup:true,
    error:'許可されていない接続先です（'+url.origin+'）'};
  if(!await chrome.permissions.contains({origins:[approved+'/*']}))
    return {ok:false,needsSetup:true,error:'この接続先へのアクセス許可が外れています'};
  const body=typeof request.body==='string'?request.body:'';
  if(!body)return {ok:false,error:'送信本文が空です'};
  if(body.length>TURN_MAX_BODY)return {ok:false,error:'送信本文が大きすぎます'};
  const raw=request.headers&&typeof request.headers==='object'?request.headers:{};
  const headers={};
  for(const name of Object.keys(raw)){
    if(!TURN_HEADER_ALLOW.has(name.toLowerCase()))continue;
    const value=raw[name];
    if(typeof value!=='string'||!value||value.length>4096)continue;
    headers[name]=value;
  }
  if(!headers['Content-Type']&&!headers['content-type'])headers['Content-Type']='application/json';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),TURN_TIMEOUT_MS);
  try{
    const response=await fetch(url.href,{method:'POST',cache:'no-store',
      headers,body,signal:controller.signal});
    const text=await response.text();
    if(text.length>TURN_MAX_REPLY)return {ok:false,status:response.status,error:'応答が大きすぎます'};
    return {ok:true,status:response.status,text};
  }catch(error){
    return {ok:false,status:0,unreachable:true,
      error:controller.signal.aborted?'時間内に応答がありません'
        :String((error&&error.message)||error).slice(0,120)};
  }finally{clearTimeout(timer);}
}
