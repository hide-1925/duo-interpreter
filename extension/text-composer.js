/* Reused by the extension popup and the in-page subtitle surface. */
globalThis.DuoTextComposer=function(container,button){
  const doc=container.ownerDocument,form=doc.createElement('form');form.className='duo-text-composer';form.hidden=true;
  const select=doc.createElement('select');select.setAttribute('aria-label','入力の話者');
  for(const [value,label] of [['auto','話者 自動'],['A','A'],['B','B']]){const o=doc.createElement('option');o.value=value;o.textContent=label;select.append(o);}
  const input=doc.createElement('textarea');input.rows=2;input.maxLength=12000;input.placeholder='入力してEnterで送信（Shift+Enterで改行）';input.setAttribute('aria-label','翻訳するテキスト');
  const send=doc.createElement('button');send.type='submit';send.textContent='送信';
  const status=doc.createElement('span');status.setAttribute('role','status');form.append(select,input,send,status);container.append(form);
  button.setAttribute('aria-expanded','false');button.addEventListener('click',()=>{form.hidden=!form.hidden;button.setAttribute('aria-expanded',String(!form.hidden));if(!form.hidden)input.focus();});
  for(const type of ['pointerdown','click','keydown','keyup'])form.addEventListener(type,e=>e.stopPropagation());
  let pendingId=null,pendingText='';
  form.addEventListener('submit',async e=>{e.preventDefault();if(send.disabled||!input.value.trim())return;
    const text=input.value;if(text!==pendingText||!pendingId){pendingId=crypto.randomUUID();pendingText=text;}
    send.disabled=true;status.textContent='送信中…';
    try{const result=await chrome.runtime.sendMessage({type:'DUO_TEXT_SUBMIT',text,seat:select.value,requestId:pendingId});if(!result?.ok)throw Error(result?.error||'HTML本体に接続できません');if(input.value===text)input.value='';pendingId=null;status.textContent='';}
    catch(error){status.textContent=String(error.message||error);}finally{send.disabled=false;}
  });
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit();}if(e.key==='Escape'){form.hidden=true;button.setAttribute('aria-expanded','false');button.focus();}});
  return form;
};
