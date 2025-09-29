// netlify/functions/drive-log.js
const FETCH_TIMEOUT_MS = 8000;
const withTimeout = (p, ms) => new Promise(res => {
  const id = setTimeout(() => res({ ok:false, text:'TIMEOUT' }), ms);
  p.then(res).catch(e => res({ ok:false, text:'ERR:'+String(e) })).finally(()=>clearTimeout(id));
});

export async function handler(event) {
  try {
    const WEBHOOK = process.env.LOG_WEBHOOK_URL;  // chỉ dùng biến này
    const TOKEN   = process.env.LOG_TOKEN;        // token cho Apps Script

    if (!WEBHOOK || !TOKEN) return { statusCode:200, body:'SKIP_LOG: missing env' };

    let payload = {};
    if (event.body) { try { payload = JSON.parse(event.body); } catch { payload = { raw:event.body }; } }
    if (!event.body || !String(event.body).trim()) return { statusCode:200, body:'SKIP_LOG: empty body' };

    const d=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh'}));
    const pad=n=>String(n).padStart(2,'0');
    const date=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const time=`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const esc=s=>{const v=(s??'').toString().replace(/\r?\n/g,' ').trim();return /[",]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;};
    const row=[date,time,esc(payload.session||'web'),esc(payload.ip||''),esc(payload.ua||''),
               esc(payload.assistantId||''),esc(payload.threadId||''),esc(payload.runId||''),
               esc(payload.user||''),esc(payload.assistant||'')].join(',');

    const isGAS = /script\.google\.com\/macros\/s\//.test(WEBHOOK);
    const url   = isGAS ? `${WEBHOOK}?t=${encodeURIComponent(TOKEN)}` : WEBHOOK;
    const opts  = isGAS
      ? { method:'POST', headers:{'Content-Type':'text/plain'}, body: row }
      : { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) };

    const result = await withTimeout(fetch(url,opts).then(async r=>({ok:r.ok,text:await r.text()})), FETCH_TIMEOUT_MS);
    return { statusCode:200, body: result.ok ? result.text : `LOG_FAIL:${result.text}` };
  } catch (e) {
