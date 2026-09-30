'use strict';
/* ストリーミング認識の一時資格情報の発行だけを中継する（STTマルチプロバイダ開発仕様書 §8.3 relay）。

   HTML 本体（GitHub Pages のタブ）から各社の発行元を直接呼ぶと、発行元が CORS を許さない
   会社では応答を読めない。拡張は host_permissions にある発行元へは CORS に関係なく要求を
   送れるので、ここが発行だけを肩代わりする。

   「何でも投げられる中継」にしないために縛る。
     1. 中継先は下の表の固定 URL だけ。ページが渡せるのは会社名とキーだけで、
        URL・メソッド・ヘッダ・本文は選べない
     2. 呼べるのは拡張自身のページと、登録済みの HTML 本体のタブだけ（turn-proxy.js の
        turnSenderAllowed と同じ）
     3. 返すのは HTTP の状態と応答の本文（上限つき）だけ。Cookie を送らない
   キーと応答の本文はここでは記録しない。音声はここを通らない（WebSocket はページから直接）。

   表の値は app.js の各 Adapter の credential と同じにする（test-stt-relay.cjs が突き合わせる）。
   OpenAI はブラウザからの発行を受け付けるので、ここには入れない。 */

const STT_RELAY_ISSUERS={
  elevenlabs:{url:'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',method:'POST',
    header:'xi-api-key',prefix:'',body:null},
  assemblyai:{url:'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60',method:'GET',
    header:'Authorization',prefix:'',body:null},
  soniox:{url:'https://api.soniox.com/v1/auth/temporary-api-key',method:'POST',
    header:'Authorization',prefix:'Bearer ',
    body:'{"usage_type":"transcribe_websocket","expires_in_seconds":60,"single_use":true}'}
};
const STT_RELAY_MAX_REPLY=16384;     /* 一時資格情報の応答は数百バイト */
const STT_RELAY_TIMEOUT_MS=12000;    /* ページ側の発行の待ち時間と同じ */

async function sttRelayToken(message,sender){
  if(!await turnSenderAllowed(sender))return {ok:false,denied:true,error:'この経路からは中継できません'};
  const request=message&&message.request;
  if(!request||typeof request!=='object')return {ok:false,denied:true,error:'要求の形が不正です'};
  const provider=typeof request.provider==='string'?request.provider:'';
  const issuer=Object.prototype.hasOwnProperty.call(STT_RELAY_ISSUERS,provider)?STT_RELAY_ISSUERS[provider]:null;
  if(!issuer)return {ok:false,denied:true,error:'この会社の一時キーは中継しません'};
  const key=typeof request.key==='string'?request.key.trim():'';
  if(!key||key.length>512||/[\s]/.test(key))return {ok:false,denied:true,error:'キーの形が不正です'};
  const headers={[issuer.header]:issuer.prefix+key};
  if(issuer.body)headers['Content-Type']='application/json';
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),STT_RELAY_TIMEOUT_MS);
  try{
    const init={method:issuer.method,cache:'no-store',credentials:'omit',headers,signal:controller.signal};
    if(issuer.body)init.body=issuer.body;
    const response=await fetch(issuer.url,init);
    const text=await response.text();
    if(text.length>STT_RELAY_MAX_REPLY)return {ok:false,status:response.status,error:'応答が大きすぎます'};
    return {ok:true,status:response.status,text};
  }catch(error){
    return {ok:false,status:0,unreachable:true,
      error:controller.signal.aborted?'時間内に応答がありません'
        :String((error&&error.message)||error).slice(0,120)};
  }finally{clearTimeout(timer);}
}
