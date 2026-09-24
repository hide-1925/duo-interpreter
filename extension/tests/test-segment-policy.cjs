'use strict';
/* 逐次読み上げの数値と、その入力欄の一致を検査する。
 *
 * ここが食い違うと利用者には分からない形で壊れる。入力欄が 50ms 刻みでも、
 * コード側が下限 200ms で丸めていれば、100 と入れた人は 200 で動いているのに
 * 画面には 100 と出たままになる。画面で入れられる値は、そのまま効かなければ
 * ならない。 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..','..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const src=read('extension/app.js').replace(/\r\n/g,'\n');
const html=read('index.html').replace(/\r\n/g,'\n');
const tests=[],test=(n,f)=>{f();tests.push(n);};

/* segNumber(v,f,min,max): 0 以下や数値でないものは既定 f、それ以外は min..max へ丸める。 */
const segNumber=(v,f,min,max)=>{v=Number(v);return isFinite(v)&&v>0?Math.max(min,Math.min(max,v)):f;};
/* コードに書かれている clamp の引数を読む。ここが唯一の出どころ。 */
const clampOf=(prop)=>{
  const m=new RegExp('segNumber\\(CFG\\.'+prop+',([^,]+),(\\d+),(\\d+)\\)').exec(src);
  assert.ok(m,'clamp not found for '+prop);
  return {def:m[1].trim(),min:Number(m[2]),max:Number(m[3])};
};
/* 入力欄の属性を読む。 */
const inputOf=(id)=>{
  const m=new RegExp('<input id="'+id+'"[^>]*>').exec(html);
  assert.ok(m,'input not found: '+id);
  const attr=(name)=>{const a=new RegExp(name+'="([^"]*)"').exec(m[0]);return a?a[1]:null;};
  return {min:attr('min'),max:attr('max'),step:attr('step')};
};

test('the stability field takes 10 ms steps up to 2000',()=>{
  const el=inputOf('segmentStability');
  assert.equal(el.step,'10');
  assert.equal(el.max,'2000');
  assert.equal(el.min,'0','0 stays the sentinel for the mode default');
});
test('every value from the stated floor upwards survives the clamp unchanged',()=>{
  /* 0 は「既定」の合図なので、欄そのものは 1 から入れられる。1〜99 は下限へ
     持ち上げられるので、使える範囲をラベルに書いておく。書いていない範囲を
     黙って丸めるのが、いちばん分かりにくい壊れ方になる。 */
  const c=clampOf('segmentStability');
  assert.equal(c.max,2000,'the clamp must reach the field maximum');
  assert.equal(c.min,100,'the field is usable from 100 ms');
  for(let v=c.min;v<=c.max;v+=10)
    assert.equal(segNumber(v,999,c.min,c.max),v,v+' ms must be used as typed');
  const label=/<label for="segmentStability">([^<]*)<\/label>/.exec(html);
  assert.ok(label,'the field needs a label');
  assert.ok(label[1].indexOf(String(c.min))>=0&&label[1].indexOf(String(c.max))>=0,
    'the usable range must be written on the label: '+label[1]);
});
test('0 still means the mode default, not a clamp to the floor',()=>{
  const c=clampOf('segmentStability');
  assert.equal(segNumber(0,300,c.min,c.max),300,'fast default');
  assert.equal(segNumber('',400,c.min,c.max),400);
  assert.equal(segNumber('abc',400,c.min,c.max),400);
});
test('a value below the floor is raised rather than accepted silently',()=>{
  const c=clampOf('segmentStability');
  assert.equal(segNumber(10,300,c.min,c.max),100);
  assert.equal(segNumber(9999,300,c.min,c.max),2000);
});
test('the mode defaults stay inside the range the field offers',()=>{
  const c=clampOf('segmentStability');
  const m=/stability:segNumber\(CFG\.segmentStability,fast\?(\d+):(\d+),/.exec(src);
  assert.ok(m,'the two mode defaults must stay readable');
  for(const d of [Number(m[1]),Number(m[2])])
    assert.ok(d>=c.min&&d<=c.max,d+' ms is outside '+c.min+'..'+c.max);
});
test('the other segment fields keep the same field-and-clamp agreement',()=>{
  /* 同じ食い違いが隣の欄で起きないようにする。 */
  for(const [id,prop] of [['segmentMin','segmentMin'],['segmentSilence','segmentSilence'],
                          ['segmentDebt','segmentDebt']]){
    const el=inputOf(id),c=clampOf(prop);
    assert.equal(Number(el.max),c.max,id+': the field maximum must match the clamp');
    const step=Number(el.step);
    for(let v=c.min;v<=c.max;v+=step)
      assert.equal(segNumber(v,999,c.min,c.max),v,id+': '+v+' must be used as typed');
  }
});

console.log(JSON.stringify({passed:tests.length,tests},null,2));
