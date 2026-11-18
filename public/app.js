(function(){
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S={items:[],log:[],printers:[],repairs:[],printerLog:[],rq:'',loaded:false,online:true,view:'inventory',q:'',sort:'name',openId:null};
const TYPE_LABEL={take:'Taken',return:'Returned',restock:'Restocked',adjust:'Count corrected',add:'New item',remove:'Item removed',lockout:'Device locked out','pin-changed':'PIN changed'};
const NO_QTY=new Set(['remove','lockout','pin-changed']);

const MINUS='<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="8.5" width="14" height="3" rx="1" fill="currentColor"/></svg>';
const PLUS='<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="8.5" width="14" height="3" rx="1" fill="currentColor"/><rect x="8.5" y="3" width="3" height="14" rx="1" fill="currentColor"/></svg>';
const CLOSE='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ---------- API ---------- */
async function api(method,url,body,contentType){
  const opt={method,headers:{}};
  if(body!==undefined){
    if(contentType){opt.body=body;opt.headers['Content-Type']=contentType}
    else{opt.body=JSON.stringify(body);opt.headers['Content-Type']='application/json'}
  }
  let res;
  try{res=await fetch(url,opt)}catch(e){throw new Error('Can’t reach the inventory server. Check that it’s running and on the network.')}
  let data=null;try{data=await res.json()}catch(e){}
  if(!url.startsWith('/api/auth/')){
    if(res.status===401){showLogin();throw new Error('Enter the PIN to continue.')}
    if(res.status===423){showLogin(data);throw new Error('This device is locked.')}
  }
  if(!res.ok){const err=new Error((data&&data.error)||('Server error ('+res.status+')'));err.status=res.status;err.data=data;throw err}
  return data;
}
async function refresh(){
  try{
    const [items,log,printers,repairs,printerLog]=await Promise.all([api('GET','/api/items'),api('GET','/api/log?limit=1000'),api('GET','/api/printers'),api('GET','/api/repairs'),api('GET','/api/printer-history')]);
    S.items=items;S.log=log;S.printers=printers;S.repairs=repairs;S.printerLog=printerLog;S.loaded=true;
    if(S.openPrinterId&&!$('#scrim').hidden&&S.redrawPrinter)S.redrawPrinter();
    if(!S.online){S.online=true;notice('')}
  }catch(e){S.loaded=true;S.online=false;setLive(false);notice(e.message)}
  render();
  if(S.openId&&!$('#scrim').hidden){const oh=document.getElementById('onhand');const it=S.items.find(i=>i.id===S.openId);if(oh&&it)oh.textContent=it.qty||0}
}
let refreshTimer=null;
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,150)}
function connectLive(){
  if(S.es)S.es.close();
  if(!window.EventSource){clearInterval(S.poll);S.poll=setInterval(refresh,10000);return}
  const es=S.es=new EventSource('/api/events');
  es.addEventListener('change',scheduleRefresh);
  es.onopen=()=>{setLive(true);refresh()};
  es.onerror=()=>{setLive(false);if(S.online){S.online=false;notice('Lost connection to the inventory server. Reconnecting…')}
    // A closed stream can mean this device was logged out or locked; check.
    api('GET','/api/auth/status').then(st=>{if(!st.loggedIn||st.lockedUntil)showLogin(st)}).catch(()=>{})};
}

/* ---------- Helpers ---------- */
function toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,2600)}
function setLive(on){const l=$('#live');if(!l)return;l.classList.toggle('off',!on);l.lastElementChild.textContent=on?'Live':'Offline';l.title=on?'Synced with the server':'Not connected to the server'}
function notice(msg){const n=$('#notice');if(!msg){n.hidden=true;return}n.textContent=msg;n.hidden=false}
const imgUrl=it=>it&&it.image?it.image:'';
const initials=n=>String(n||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
const fmtWhen=ms=>{const d=new Date(ms);return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})};
function thumbHTML(it){const u=imgUrl(it);return `<div class="thumb"><span class="ph">${esc(initials(it&&it.name))}</span>${u?`<img src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">`:''}</div>`}
function stockPill(it){return (it.qty||0)<=0?'<span class="pill out">Out</span>':''}
const signed=e=>{const d=e.type==='adjust'?e.delta:(e.type==='take'?-e.qty:e.qty);return (d<0?'−':'+')+Math.abs(d||0)};

/* ---------- Inventory view ---------- */
function renderInventory(){
  const outCount=S.items.filter(i=>(i.qty||0)<=0).length;
  const q=S.q.trim().toLowerCase();
  const list=S.items.filter(i=>!q||(String(i.name)+' '+(i.code||'')).toLowerCase().includes(q));
  const cmp={name:(a,b)=>String(a.name).localeCompare(b.name),low:(a,b)=>(a.qty||0)-(b.qty||0)}[S.sort];
  list.sort(cmp);
  $('#grid').innerHTML=list.map(it=>`<button class="card" data-id="${esc(it.id)}" type="button" aria-label="Open ${esc(it.name)}">
    <div class="thumb"><span class="ph">${esc(initials(it.name))}</span>${imgUrl(it)?`<img src="${esc(imgUrl(it))}" alt="" loading="lazy" onerror="this.remove()">`:''}</div>
    <div class="cbody"><div class="cname">${esc(it.name)}</div>
    <div class="crow"><span class="qty">${it.qty||0}<small>${esc(it.unit||'pcs')} left</small></span>${stockPill(it)}</div></div></button>`).join('');
  const showEmpty=S.loaded&&S.online&&S.items.length===0;
  $('#empty').hidden=!showEmpty;
  $('#summary').hidden=showEmpty;
  if(!S.loaded)$('#summary').textContent='Loading inventory…';
  else if(S.items.length)$('#summary').textContent=`${list.length} of ${S.items.length} items`+(outCount?` · ${outCount} out of stock`:'');
  else $('#summary').textContent='';
  if(S.loaded&&S.items.length&&!list.length)$('#grid').innerHTML=`<p class="summary">No items match “${esc(S.q)}”.</p>`;
}

/* ---------- Activity view ---------- */
function dayStart(v){if(!v)return null;const [y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d).getTime()}
function logFilters(){
  const from=dayStart($('#afrom').value),toDay=dayStart($('#ato').value);
  return {q:$('#aq').value.trim(),type:$('#atype').value,from,to:toDay==null?null:toDay+864e5};
}
function filteredLog(){
  const f=logFilters(),q=f.q.toLowerCase();
  return S.log.filter(e=>(!f.type||e.type===f.type)&&(f.from==null||e.at>=f.from)&&(f.to==null||e.at<f.to)&&
    (!q||[e.person,e.itemName,e.note].join(' ').toLowerCase().includes(q)));
}
function renderActivity(){
  const rows=filteredLog();
  $('#logBody').innerHTML=rows.length?rows.map(e=>`<tr>
    <td class="when">${esc(fmtWhen(e.at))}</td><td>${esc(e.person||'—')}</td>
    <td><span class="tag ${esc(e.type)}">${esc(TYPE_LABEL[e.type]||e.type)}</span></td>
    <td class="num">${NO_QTY.has(e.type)?'':signed(e)}</td>
    <td>${esc(e.itemName||'—')}</td><td class="num">${e.after!=null?esc(e.after):''}</td><td>${esc(e.note||'')}${e.type==='lockout'&&e.device?` <span class="when">${esc(e.device)}</span>`:''}</td></tr>`).join('')
    :`<tr><td colspan="7" style="color:var(--muted);padding:24px 12px">${S.log.length?'No activity matches these filters.':'Nothing logged yet. Every take, return and restock shows up here.'}</td></tr>`;
  const taken=rows.filter(e=>e.type==='take').reduce((s,e)=>s+e.qty,0);
  $('#asummary').textContent=`${rows.length} entries${taken?` · ${taken} units taken`:''}`+(S.log.length>=1000?' · showing latest 1,000 (export includes everything)':'');
}
function render(){S.view==='inventory'?renderInventory():S.view==='repairs'?renderRepairs():renderActivity()}

/* ---------- Panels ---------- */
function openPanel(html,label){
  // Swap in a fresh panel element so click handlers from the previous popup can't fire again.
  const old=$('#panel');const p=old.cloneNode(false);old.replaceWith(p);p.innerHTML=html;
  if(S.stopCam){S.stopCam();S.stopCam=null}
  S.partScan=null;S.printerScan=null;S.openPrinterId=null;S.redrawPrinter=null;p.setAttribute('aria-label',label||'');$('#scrim').hidden=false;document.body.style.overflow='hidden';
  const f=p.querySelector('[autofocus]');if(f)setTimeout(()=>f.focus(),30)}
function closePanel(){if(S.stopCam){S.stopCam();S.stopCam=null}S.partScan=null;S.printerScan=null;S.openPrinterId=null;S.redrawPrinter=null;$('#scrim').hidden=true;$('#panel').innerHTML='';document.body.style.overflow='';S.openId=null}
$('#scrim').addEventListener('click',e=>{if(e.target.id==='scrim')closePanel()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#scrim').hidden)closePanel()});

function recentPeople(){const seen=[];for(const e of S.log){const p=(e.person||'').trim();if(p&&!seen.some(x=>x.toLowerCase()===p.toLowerCase()))seen.push(p);if(seen.length>=8)break}return seen}

function openItem(id){
  const it=S.items.find(i=>i.id===id);if(!it)return;
  S.openId=id;
  const people=recentPeople();
  const hist=S.log.filter(e=>e.itemId===id).slice(0,5);
  openPanel(`
  <div class="phead">${thumbHTML(it)}
    <div style="min-width:0"><h2>${esc(it.name)}</h2>
      <div class="meta"><span>On hand <b id="onhand">${it.qty||0}</b> ${esc(it.unit||'pcs')}</span>${stockPill(it)}</div>
      ${it.code?`<div class="meta" style="margin-top:4px"><span>Barcode <b>${esc(it.code)}</b></span></div>`:''}
    </div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button>
  </div>
  <form class="stack" id="txForm" autocomplete="off">
    <div class="seg" role="group" aria-label="What are you doing?">
      <button type="button" class="t" data-mode="take" aria-pressed="true">Take out</button>
      <button type="button" class="r" data-mode="return" aria-pressed="false">Put back / restock</button>
    </div>
    <div id="retKind" hidden class="quick">
      <button type="button" class="chip" data-kind="return" aria-pressed="true">Returning items I took</button>
      <button type="button" class="chip" data-kind="restock" aria-pressed="false">New stock arrived</button>
    </div>
    <div class="field"><span class="lbl">How many?</span>
      <div class="stepper"><button type="button" data-step="-1" aria-label="One less">${MINUS}</button>
        <input id="txQty" type="number" readonly tabindex="-1" min="1" step="1" value="1" aria-label="Quantity" aria-live="polite">
        <button type="button" data-step="1" aria-label="One more">${PLUS}</button></div>
      <div class="after" id="after"></div>
    </div>
    <div class="field"><label for="txWho">Your name</label>
      <input id="txWho" required placeholder="First and last name" list="peopleList" autocapitalize="words">
      <datalist id="peopleList">${people.map(p=>`<option value="${esc(p)}">`).join('')}</datalist>
      ${people.length?`<div class="quick" style="margin-top:6px">${people.map(p=>`<button type="button" class="chip" data-who="${esc(p)}">${esc(p)}</button>`).join('')}</div>`:''}
    </div>
    <div class="field"><label for="txNote">Note or job (optional)</label><input id="txNote" placeholder="e.g. Job #4410, van 3, broken"></div>
    <button class="btn primary big" type="submit" id="txGo">Confirm</button>
  </form>
  ${hist.length?`<div class="hist"><span class="lbl">Recent for this item</span><ul>${hist.map(e=>`<li><span class="tag ${esc(e.type)}">${esc(TYPE_LABEL[e.type]||e.type)}</span><b class="num">${NO_QTY.has(e.type)?'':signed(e)}</b><span>${esc(e.person||'')}</span><span class="when">${esc(fmtWhen(e.at))}</span></li>`).join('')}</ul></div>`:''}
  <div class="foot"><button class="btn" type="button" data-act="label">Print label</button><button class="btn" type="button" data-act="edit">Edit item</button></div>`,it.name);
  const p=$('#panel');let mode='take';
  const qtyEl=p.querySelector('#txQty');
  const cur=()=>(S.items.find(i=>i.id===id)||it).qty||0;
  const upd=()=>{const n=Math.floor(Number(qtyEl.value)||0);const next=mode==='take'?cur()-n:cur()+n;
    const a=p.querySelector('#after'),go=p.querySelector('#txGo');
    p.querySelector('[data-step="-1"]').disabled=n<=1;
    p.querySelector('[data-step="1"]').disabled=mode==='take'&&n>=cur();
    if(mode==='take'&&cur()<=0){a.className='after err';a.innerHTML='None left. If the count is wrong, use Edit item to correct it.';go.disabled=true}
    else if(next<0){a.className='after err';a.innerHTML=`Only <b>${cur()}</b> on hand.`;go.disabled=true}
    else{a.className='after';a.innerHTML=`After this: <b>${next}</b> ${esc(it.unit||'pcs')} left`;go.disabled=false}
    go.textContent=(mode==='take'?'Take ':mode==='restock'?'Restock ':'Return ')+n+' '+(it.unit||'pcs');
  };
  p.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.act==='close')closePanel();
    else if(b.dataset.act==='edit')openEdit(id);
    else if(b.dataset.act==='label')openLabels([id]);
    else if(b.dataset.mode){
      mode=b.dataset.mode==='take'?'take':p.querySelector('[data-kind][aria-pressed="true"]').dataset.kind;
      p.querySelectorAll('[data-mode]').forEach(x=>x.setAttribute('aria-pressed',x===b));p.querySelector('#retKind').hidden=b.dataset.mode==='take';upd()}
    else if(b.dataset.kind){mode=b.dataset.kind;p.querySelectorAll('[data-kind]').forEach(x=>x.setAttribute('aria-pressed',x===b));upd()}
    else if(b.dataset.step){qtyEl.value=Math.max(1,(Math.floor(Number(qtyEl.value))||0)+Number(b.dataset.step));upd()}
    else if(b.dataset.who){p.querySelector('#txWho').value=b.dataset.who}
  });
  p.querySelector('#txForm').addEventListener('submit',async e=>{e.preventDefault();
    const who=p.querySelector('#txWho').value.trim();if(!who){p.querySelector('#txWho').focus();toast('Enter your name first');return}
    const n=Math.floor(Number(qtyEl.value));const go=p.querySelector('#txGo');go.disabled=true;go.textContent='Saving…';
    try{const r=await api('POST',`/api/items/${id}/transactions`,{type:mode,qty:n,person:who,note:p.querySelector('#txNote').value.trim()});
      closePanel();toast(`${mode==='take'?'Took':mode==='restock'?'Restocked':'Returned'} ${n} × ${it.name}. ${r.item.qty} left.`);refresh()}
    catch(err){toast(err.message);refresh().then(()=>{if(S.openId===id)upd()})}
  });
  upd();
}

/* ---------- Add / edit item ---------- */
async function shrink(file){
  try{const bmp=await createImageBitmap(file);const s=Math.min(1,1000/Math.max(bmp.width,bmp.height));
    const c=document.createElement('canvas');c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);
    c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(b=>r(b||file),'image/jpeg',.85))}catch(e){return file}
}
function openEdit(id){
  const it=id?S.items.find(i=>i.id===id):null;const isNew=!it;
  let pendingImage=null;
  openPanel(`
  <div class="phead"><div style="min-width:0"><h2>${isNew?'Add item':'Edit item'}</h2><div class="meta">${isNew?'Put a new item on the racks.':'Changes apply for everyone using the kiosk.'}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="edForm" autocomplete="off">
    <div class="photo">${thumbHTML(it||{name:'?'})}
      <div class="field"><span class="lbl">Photo</span>
        <label class="btn" for="edImg" style="width:max-content">${it&&it.image?'Change photo':'Take or upload photo'}</label>
        <input id="edImg" type="file" accept="image/*" capture="environment" hidden>
        <span class="after" id="imgNote">Clear, close-up shots work best.</span></div></div>
    <div class="field"><label for="edName">Item name</label><input id="edName" required value="${esc(it?it.name:'')}" placeholder="e.g. Cat6 patch cable, 3 ft" autofocus></div>
    <div class="row2">
      <div class="field"><label for="edQty">${isNew?'Starting count':'Count on hand'}</label><input id="edQty" type="number" inputmode="numeric" min="0" step="1" value="${it?it.qty||0:0}"></div>
      <div class="field"><label for="edUnit">Unit</label><input id="edUnit" value="${esc(it?it.unit||'pcs':'pcs')}" placeholder="pcs, boxes, ft"></div>
    </div>
    ${isNew?'':`<div class="field"><label for="edWho">Your name (for the count change, if any)</label><input id="edWho" placeholder="Who is correcting the count?"></div>`}
    <button class="btn primary big" type="submit" id="edGo">${isNew?'Add to inventory':'Save changes'}</button>
    <div class="foot">${isNew?'<span></span>':'<button class="btn danger" type="button" data-act="del">Remove item</button>'}<button class="btn ghost" type="button" data-act="${isNew?'close':'back'}">Cancel</button></div>
    <div id="delBox" hidden class="confirm"><span style="flex:1 1 200px">Remove <b>${esc(it?it.name:'')}</b> from the inventory? Its activity history is kept.</span><button class="btn danger" type="button" data-act="delYes">Remove</button><button class="btn" type="button" data-act="delNo">Keep</button></div>
  </form>`,isNew?'Add item':'Edit item');
  const p=$('#panel');
  p.querySelector('#edImg').addEventListener('change',async e=>{const f=e.target.files&&e.target.files[0];if(!f)return;
    pendingImage=await shrink(f);const u=URL.createObjectURL(pendingImage);
    p.querySelector('.photo .thumb').innerHTML=`<img src="${u}" alt="">`;p.querySelector('#imgNote').textContent='Photo ready. It uploads when you save.'});
  p.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;const a=b.dataset.act;
    if(a==='close')closePanel();else if(a==='back')openItem(id);
    else if(a==='del')p.querySelector('#delBox').hidden=false;else if(a==='delNo')p.querySelector('#delBox').hidden=true;
    else if(a==='delYes'){b.disabled=true;try{await api('DELETE','/api/items/'+id);closePanel();toast(`Removed ${it.name}`);refresh()}catch(err){toast(err.message);b.disabled=false}}
  });
  p.querySelector('#edForm').addEventListener('submit',async e=>{e.preventDefault();
    const go=p.querySelector('#edGo');const v=s=>p.querySelector(s).value.trim();
    const name=v('#edName');if(!name)return;
    const body={name,unit:v('#edUnit')||'pcs',qty:Math.max(0,Math.floor(Number(v('#edQty'))||0))};
    if(!isNew)body.person=v('#edWho');
    go.disabled=true;go.textContent='Saving…';
    try{
      let saved=isNew?await api('POST','/api/items',body):await api('PUT','/api/items/'+id,body);
      if(pendingImage){try{await api('POST',`/api/items/${saved.id}/image`,pendingImage,pendingImage.type||'image/jpeg')}catch(err){toast('Saved, but the photo didn’t upload: '+err.message)}}
      await refresh();
      if(isNew){openLabels([saved.id],{justAdded:true})}else{closePanel();toast('Saved')}
    }catch(err){toast(err.message);go.disabled=false;go.textContent=isNew?'Add to inventory':'Save changes'}
  });
}

/* ---------- Export ---------- */
function download(url){const a=document.createElement('a');a.href=url;a.download='';document.body.appendChild(a);a.click();a.remove()}
$('#expInv').onclick=()=>download('/api/export/inventory.csv');
$('#expLog').onclick=()=>{const f=logFilters();const qs=new URLSearchParams();
  if(f.q)qs.set('q',f.q);if(f.type)qs.set('type',f.type);if(f.from!=null)qs.set('from',f.from);if(f.to!=null)qs.set('to',f.to);
  download('/api/export/activity.csv'+(qs.toString()?'?'+qs:''))};

/* ---------- Wiring ---------- */
function setView(v){S.view=v;document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected',t.dataset.view===v));
  $('#view-inventory').hidden=v!=='inventory';$('#view-activity').hidden=v!=='activity';$('#view-repairs').hidden=v!=='repairs';
  try{history.replaceState(null,'','#'+v)}catch(e){}render()}
const viewFromHash=()=>({'#activity':'activity','#repairs':'repairs'})[location.hash]||'inventory';
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>setView(t.dataset.view));
window.addEventListener('hashchange',()=>setView(viewFromHash()));
$('#q').addEventListener('input',e=>{S.q=e.target.value;renderInventory()});
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter'&&parseCode(e.target.value)){e.preventDefault();const v=e.target.value;e.target.value='';S.q='';renderInventory();handleScan(v)}});
$('#sort').addEventListener('change',e=>{S.sort=e.target.value;renderInventory()});
$('#grid').addEventListener('click',e=>{const c=e.target.closest('.card');if(c)openItem(c.dataset.id)});
['#aq','#atype','#afrom','#ato'].forEach(s=>$(s).addEventListener('input',renderActivity));
$('#addBtn').onclick=()=>openEdit(null);$('#emptyAdd').onclick=()=>openEdit(null);

/* ---------- PIN login ---------- */
const L={pin:'',busy:false,lockedUntil:null,timer:null,shown:false};
const PIN_MAX=8;
function drawDots(){const n=Math.max(4,L.pin.length);$('#dots').innerHTML=Array.from({length:Math.min(PIN_MAX,n)},(_,i)=>`<i class="${i<L.pin.length?'on':''}"></i>`).join('')}
function lmsg(text,err){const m=$('#lmsg');m.textContent=text||'';m.className='lmsg'+(err?' err':'')}
function setKeypad(enabled){document.querySelectorAll('#keypad button').forEach(b=>b.disabled=!enabled)}
function showLogin(st){
  closePanel();
  if(S.es){S.es.close();S.es=null}
  clearInterval(S.poll);setLive(false);
  if(!L.shown){L.shown=true;L.pin='';lmsg('');drawDots()}
  $('#login').hidden=false;document.body.style.overflow='hidden';
  if(st&&st.lockedUntil)startLock(st.lockedUntil,st.now);
  else if(!L.lockedUntil){setKeypad(true);$('#lockBox').hidden=true;
    if(st&&st.attemptsLeft!=null&&st.maxAttempts&&st.attemptsLeft<st.maxAttempts)lmsg(`${st.attemptsLeft} ${st.attemptsLeft===1?'try':'tries'} left before lockout`,true)}
}
function hideLogin(){L.shown=false;L.pin='';$('#login').hidden=true;document.body.style.overflow='';stopLock()}
function startLock(until,serverNow){
  const skew=serverNow?Date.now()-serverNow:0;L.lockedUntil=until+skew;L.pin='';drawDots();lmsg('');
  setKeypad(false);$('#lockBox').hidden=false;$('#lsub').textContent='Locked';
  clearInterval(L.timer);
  const tick=()=>{const ms=L.lockedUntil-Date.now();
    if(ms<=0){stopLock();api('GET','/api/auth/status').then(showLogin).catch(()=>showLogin());return}
    const m=Math.floor(ms/60000),sec=Math.floor(ms/1000)%60;$('#lockTime').textContent=`${m}:${String(sec).padStart(2,'0')}`};
  tick();L.timer=setInterval(tick,1000);
}
function stopLock(){clearInterval(L.timer);L.lockedUntil=null;$('#lockBox').hidden=true;$('#lsub').textContent='Enter the kiosk PIN';setKeypad(true)}
async function submitPin(){
  if(L.busy||L.lockedUntil)return;
  if(L.pin.length<4){lmsg('PIN is 4 to 8 digits',true);return}
  L.busy=true;setKeypad(false);lmsg('Checking…');
  try{await api('POST','/api/auth/login',{pin:L.pin});hideLogin();await refresh();connectLive()}
  catch(err){
    L.pin='';drawDots();const d=$('#dots');d.classList.remove('shake');void d.offsetWidth;d.classList.add('shake');
    if(err.status===423&&err.data){startLock(err.data.lockedUntil,err.data.now)}
    else{setKeypad(true);lmsg(err.message,true)}
  }
  L.busy=false;
}
function pressKey(k){
  if(L.busy||L.lockedUntil)return;
  if(k==='del')L.pin=L.pin.slice(0,-1);
  else if(k==='ok'){submitPin();return}
  else if(/^\d$/.test(k)&&L.pin.length<PIN_MAX)L.pin+=k;
  if(!$('#lmsg').classList.contains('err')||L.pin)lmsg('');
  drawDots();
}
$('#keypad').addEventListener('click',e=>{const b=e.target.closest('[data-k]');if(b)pressKey(b.dataset.k)});
document.addEventListener('keydown',e=>{if($('#login').hidden)return;
  // A barcode scanner types letters (RK-0001 or a link) then Enter. Keep its digits out of the PIN
  // so a scan never counts as a wrong PIN.
  const now=Date.now();
  if(e.key.length===1&&!/^\d$/.test(e.key)){L.scanUntil=now+400;L.pin='';drawDots();lmsg('Enter the PIN first, then scan.',true);e.preventDefault();return}
  if(L.scanUntil&&now<L.scanUntil){L.scanUntil=now+400;e.preventDefault();return}
  if(/^\d$/.test(e.key)&&L.lastKey&&now-L.lastKey<35){L.lastKey=now;L.scanUntil=now+400;L.pin='';drawDots();lmsg('Enter the PIN first, then scan.',true);e.preventDefault();return}
  if(/^\d$/.test(e.key))L.lastKey=now;
  if(/^\d$/.test(e.key))pressKey(e.key);else if(e.key==='Backspace')pressKey('del');else if(e.key==='Enter')pressKey('ok');});
$('#lockBtn').onclick=async()=>{try{await api('POST','/api/auth/logout')}catch(e){}S.items=[];S.log=[];render();showLogin()};

function openChangePin(){
  openPanel(`<div class="phead"><div style="min-width:0"><h2>Change PIN</h2><div class="meta">Every other device will be logged out and need the new PIN.</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="pinForm" autocomplete="off">
    <div class="field"><label for="pinCur">Current PIN</label><input id="pinCur" type="password" inputmode="numeric" pattern="\\d{4,8}" maxlength="8" required autofocus></div>
    <div class="row2">
      <div class="field"><label for="pinNew">New PIN (4–8 digits)</label><input id="pinNew" type="password" inputmode="numeric" pattern="\\d{4,8}" maxlength="8" required></div>
      <div class="field"><label for="pinNew2">Repeat new PIN</label><input id="pinNew2" type="password" inputmode="numeric" pattern="\\d{4,8}" maxlength="8" required></div>
    </div>
    <div class="after err" id="pinErr"></div>
    <button class="btn primary big" type="submit" id="pinGo">Change PIN</button>
  </form>`,'Change PIN');
  const p=$('#panel');p.querySelector('[data-act=close]').onclick=closePanel;
  p.querySelector('#pinForm').addEventListener('submit',async e=>{e.preventDefault();
    const cur=p.querySelector('#pinCur').value,n1=p.querySelector('#pinNew').value,n2=p.querySelector('#pinNew2').value,er=p.querySelector('#pinErr');
    if(!/^\d{4,8}$/.test(n1)){er.textContent='New PIN must be 4 to 8 digits.';return}
    if(n1!==n2){er.textContent='The new PINs don’t match.';return}
    const go=p.querySelector('#pinGo');go.disabled=true;
    try{await api('POST','/api/auth/change-pin',{current:cur,next:n1});closePanel();toast('PIN changed. Other devices were logged out.');connectLive();refresh()}
    catch(err){go.disabled=false;
      if(err.status===423&&err.data){showLogin(err.data)}else{er.textContent=err.message;p.querySelector('#pinCur').value='';p.querySelector('#pinCur').focus()}}
  });
}
$('#pinBtn').onclick=openChangePin;

/* ---------- Barcodes & labels ---------- */
// Label barcodes hold a 6-digit number (Code 128C), which prints narrower and scans more reliably than letters:
// 1xxxxx is item RK-xxxx, 2xxxxx is printer PR-xxxx. Labels printed earlier hold the code itself.
function parseCode(text){
  const t=String(text||'').trim();
  const n=t.match(/^([12])(\d{5})$/);
  if(n)return (n[1]==='1'?'RK-':'PR-')+String(Number(n[2])).padStart(4,'0');
  const m=t.match(/(RK|PR)\W?(\d{3,8})/i);
  return m?m[1].toUpperCase()+'-'+m[2]:null;
}
function barcodeData(code){
  const m=String(code).match(/^(RK|PR)-(\d+)$/);
  if(m&&Number(m[2])<=99999)return (m[1]==='RK'?'1':'2')+String(Number(m[2])).padStart(5,'0');
  return null;
}
function handleScan(text){
  const code=parseCode(text);
  if(!code){toast('That barcode isn’t one of ours.');return}
  if(code.startsWith('PR-')){
    const pr=S.printers.find(x=>String(x.code).toUpperCase()===code);
    if(!pr){toast(`No printer with barcode ${code}. It may have been removed.`);return}
    if(S.printerScan){S.printerScan(pr);return}
    if(S.view!=='repairs')setView('repairs');
    closePanel();openPrinter(pr.id);toast(`Scanned ${pr.code}: ${pr.name}`);return;
  }
  const it=S.items.find(i=>String(i.code).toUpperCase()===code.toUpperCase());
  if(!it){toast(`No item with barcode ${code}. It may have been removed.`);return}
  if(S.partScan){S.partScan(it);return}
  if(S.view!=='inventory')setView('inventory');
  closePanel();openItem(it.id);toast(`Scanned ${it.code}: ${it.name}`);
}
// Keyboard-style USB/Bluetooth scanners: a fast burst of keys ending in Enter, anywhere on the page.
const SC={buf:'',last:0};
document.addEventListener('keydown',e=>{
  if(!$('#login').hidden)return;
  const t=e.target,tag=t&&t.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
  const now=Date.now();
  if(now-SC.last>120)SC.buf='';
  SC.last=now;
  if(e.key==='Enter'){if(SC.buf.length>=4&&parseCode(SC.buf)){e.preventDefault();handleScan(SC.buf)}SC.buf='';return}
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey)SC.buf+=e.key;
});

function fitSvg(svg){
  const w=parseFloat(svg.getAttribute('width')),h=parseFloat(svg.getAttribute('height'));
  if(!svg.getAttribute('viewBox')&&w&&h)svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  svg.removeAttribute('width');svg.removeAttribute('height');
  return svg;
}
// Labels are 2 in wide x 1 in tall. Bars are sized in whole printer dots so they print evenly:
// 0.0197 in is 4 dots at 203 dpi and 6 dots at 300 dpi. Smaller sizes are used only if a long code wouldn't fit.
const LABEL_BAR_MAX_IN=1.76;
const MODULE_SIZES=[0.0197,0.0148,0.00985];
// Shrink single-line label text until it fits (down to 70% of its size), so serial numbers aren't cut off.
function fitLabelText(root){
  // Item names: as many words as fit go on the bold first line; the rest moves to the regular second line.
  root.querySelectorAll('.l-split').forEach(first=>{
    const second=first.nextElementSibling;
    const words=(first.dataset.full||first.textContent).trim().split(/\s+/);
    first.dataset.full=words.join(' ');
    let n=words.length;
    first.textContent=words.join(' ');
    while(n>1&&first.scrollWidth>first.clientWidth+0.5){n--;first.textContent=words.slice(0,n).join(' ')}
    const rest=words.slice(n).join(' ');
    second.textContent=rest;second.hidden=!rest;
  });
  root.querySelectorAll('.l-fit').forEach(el=>{
    el.style.fontSize='';
    const base=parseFloat(getComputedStyle(el).fontSize);let px=base;
    while(el.scrollWidth>el.clientWidth+0.5&&px>base*0.7){px-=base*0.04;el.style.fontSize=px+'px'}
  });
}
function code128Svg(code){
  const data=barcodeData(code);
  const el=document.createElementNS('http://www.w3.org/2000/svg','svg');
  JsBarcode(el,data||code,{format:data?'CODE128C':'CODE128',displayValue:false,margin:0,height:40,width:1,background:'#ffffff',lineColor:'#000000'});
  const modules=parseFloat(el.getAttribute('width'));
  fitSvg(el);el.setAttribute('preserveAspectRatio','none');
  const mod=MODULE_SIZES.find(m=>modules*m<=LABEL_BAR_MAX_IN)||MODULE_SIZES[MODULE_SIZES.length-1];
  el.setAttribute('style',`width:${(modules*mod).toFixed(4)}in`);
  return el.outerHTML;
}
function labelHTML(it){
  // Printer labels leave out the name (it changes when a printer moves); scanning shows the current name.
  if(String(it.code).startsWith('PR-'))return `<div class="label"><div class="l-name l-fit">${esc(it.model||'Label printer')}</div>
    ${it.serial?`<div class="l-sub l-fit">S/N ${esc(it.serial)}</div>`:''}
    <div class="l-bar">${code128Svg(it.code)}</div><div class="l-code">${esc(it.code)}</div></div>`;
  return `<div class="label"><div class="l-name l-fit l-split">${esc(it.name)}</div><div class="l-sub l-fit" hidden></div>
    <div class="l-bar">${code128Svg(it.code)}</div><div class="l-code">${esc(it.code)}</div></div>`;
}
const pref={get(k,d){try{return localStorage.getItem(k)||d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
async function printLabels(ids,format){
  const list=ids.map(id=>S.items.find(i=>i.id===id)||S.printers.find(x=>x.id===id)).filter(Boolean);
  if(!list.length){toast('Choose at least one label to print.');return false}
  const area=$('#printArea');
  area.className='fmt-'+format;
  area.innerHTML=list.map(it=>labelHTML(it)).join('');
  area.style.display='block';fitLabelText(area);area.style.display='';
  $('#pageSize').textContent=format==='sheet'?'@page{size:letter;margin:0.5in}':'@page{size:2in 1in;margin:0}';
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  window.print();
  try{await api('POST','/api/labels-printed',{ids:list.map(i=>i.id)})}catch(e){}
  refresh();
  return true;
}
async function openLabels(ids,opts){
  opts=opts||{};
  const fmt=pref.get('labelFormat','roll');
  const single=ids&&ids.length===1;
  const pick=!ids;
  const isPr=opts.kind==='printer';
  const noun=isPr?'printer':'item';
  const items=[...(isPr?S.printers:S.items)].sort((a,b)=>String(a.name).localeCompare(b.name));
  if(pick)ids=items.filter(i=>!i.labelPrintedAt).map(i=>i.id);
  const one=single?items.find(i=>i.id===ids[0]):null;
  const blurb=isPr?(opts.justAdded?'Stick it on the printer. Scanning it opens this printer’s repair history.':single?'Scanning this label opens the printer’s repair history.':'One label per printer. Printers without a printed label are ticked.')
    :(opts.justAdded?'Stick the label on the shelf or bin. Scanning it opens this item.':single?'Scanning this label opens the item.':'One label per item. Items without a printed label are ticked.');
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${opts.justAdded?(isPr?'Printer added. Print its label?':'Item added. Print its label?'):single?'Print label':isPr?'Print printer labels':'Print labels'}</h2>
      <div class="meta">${blurb}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <div class="stack">
    ${one?`<div class="lpreview">${labelHTML(one)}</div>`:`<div class="picklist">
      <label class="pickall"><input type="checkbox" id="pickAll"> <b>Select all</b> <span class="when" id="pickCount"></span></label>
      ${items.map(i=>`<label><input type="checkbox" value="${esc(i.id)}" ${ids.includes(i.id)?'checked':''}> <span class="pname">${esc(i.name)}</span> <span class="when">${esc(i.code)}</span> ${i.labelPrintedAt?'<span class="pill okp">Printed</span>':'<span class="pill low">Needs label</span>'}</label>`).join('')||`<p class="summary">No ${noun}s yet.</p>`}
    </div>`}
    <div class="field"><label for="lblFmt">Print on</label>
      <select id="lblFmt"><option value="roll" ${fmt==='roll'?'selected':''}>Label printer, 2 × 1 in (one per label)</option>
      <option value="sheet" ${fmt==='sheet'?'selected':''}>Regular paper, Letter (cut out labels)</option></select></div>
    <button class="btn primary big" type="button" id="lblGo">${single?'Print label':'Print selected labels'}</button>
    ${opts.justAdded?'<button class="btn ghost" type="button" data-act="close">Skip for now</button>':''}
  </div>`,'Print labels');
  const p=$('#panel');
  fitLabelText(p);
  p.querySelectorAll('[data-act=close]').forEach(b=>b.onclick=()=>{closePanel();if(opts.justAdded)toast(`Added ${one?one.name:noun}. Print its label any time from the ${noun}.`)});
  const boxes=()=>[...p.querySelectorAll('.picklist input[value]')];
  const count=()=>{const c=boxes().filter(b=>b.checked).length;const pc=p.querySelector('#pickCount');if(pc)pc.textContent=`${c} selected`;const all=p.querySelector('#pickAll');if(all)all.checked=c&&c===boxes().length};
  if(!one){p.querySelector('#pickAll').onchange=e=>{boxes().forEach(b=>b.checked=e.target.checked);count()};p.querySelector('.picklist').addEventListener('change',count);count()}
  p.querySelector('#lblGo').onclick=async()=>{
    const f=p.querySelector('#lblFmt').value;pref.set('labelFormat',f);
    const chosen=one?[one.id]:boxes().filter(b=>b.checked).map(b=>b.value);
    if(await printLabels(chosen,f)){closePanel();toast(chosen.length===1?'Label sent to the printer':`${chosen.length} labels sent to the printer`)}
  };
}

/* ---------- Scan screen (scanner or camera) ---------- */
function openScan(){
  const canCam=('BarcodeDetector' in window)&&window.isSecureContext&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
  openPanel(`<div class="phead"><div style="min-width:0"><h2>Scan a label</h2><div class="meta">Scan an item's label to take it out or put it back, or a printer's label to see its repairs.</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="scanForm" autocomplete="off">
    <div class="field"><label for="scanInput">Scan now, or type the code</label>
      <input id="scanInput" placeholder="RK-0001 or PR-0001" autofocus autocapitalize="characters" spellcheck="false"></div>
    <button class="btn primary big" type="submit">Find item</button>
    ${canCam?`<button class="btn" type="button" id="camBtn">Use camera</button><video id="camVideo" class="camvideo" playsinline muted hidden></video>`
      :`<p class="after">Camera scanning needs Chrome or Edge and the server set up with HTTPS. A USB or Bluetooth barcode scanner works anywhere.</p>`}
  </form>`,'Scan a label');
  const p=$('#panel');
  p.querySelector('[data-act=close]').onclick=closePanel;
  p.querySelector('#scanForm').addEventListener('submit',e=>{e.preventDefault();const v=p.querySelector('#scanInput').value;if(v.trim())handleScan(v)});
  const cam=p.querySelector('#camBtn');
  if(cam)cam.onclick=async()=>{
    const video=p.querySelector('#camVideo');let stream,stop=false,raf;
    try{
      const det=new BarcodeDetector({formats:['code_128']});
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
      video.srcObject=stream;video.hidden=false;await video.play();cam.hidden=true;
      S.stopCam=()=>{stop=true;cancelAnimationFrame(raf);stream.getTracks().forEach(t=>t.stop())};
      let lastTry=0;
      const loop=async(t)=>{if(stop)return;
        if(t-lastTry>250){lastTry=t;try{const codes=await det.detect(video);const hit=codes.find(c=>parseCode(c.rawValue));if(hit){handleScan(hit.rawValue);return}}catch(e){}}
        raf=requestAnimationFrame(loop)};
      raf=requestAnimationFrame(loop);
    }catch(err){toast('Camera not available. Allow camera access, or use a scanner.');if(stream)stream.getTracks().forEach(t=>t.stop())}
  };
}
$('#scanBtn').onclick=openScan;
$('#labelsBtn').onclick=()=>openLabels(null);

/* ---------- Printer repairs ---------- */
const REPAIR_TYPES=['Printhead cleaned','Printhead replaced','Platen roller cleaned','Platen roller replaced','Label jam cleared',
  'Cutter repaired or replaced','Sensor cleaned or calibrated','Firmware updated','Driver reinstalled','Power supply replaced',
  'Cable or port repaired','Feed mechanism repaired','Case or door repaired','Other'];
const PRINTER_MODELS=['Dymo LabelWriter 450','Dymo LabelWriter 550','Dymo LabelWriter 5XL','Brother QL-800','Brother QL-820NWB','Brother QL-1110NWB',
  'Zebra ZD421','Zebra ZD621','Zebra GK420d','Rollo Wireless','Munbyn ITPP941'];
const money=v=>v==null||v===''?'':Number(v).toLocaleString(undefined,{style:'currency',currency:'USD'});
const fmtDay=d=>{if(!d)return'';const [y,m,dd]=d.split('-').map(Number);return new Date(y,m-1,dd).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})};
const todayStr=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const byNewest=(a,b)=>String(b.date).localeCompare(String(a.date))||(b.createdAt||0)-(a.createdAt||0);
const uniq=list=>[...new Set(list.filter(Boolean))];
function partsText(r){return (r.inventoryParts||[]).map(x=>`${x.qty} × ${x.itemName}`).concat(r.parts?[r.parts]:[]).join(', ')}
function fillSelect(sel,options,allLabel){const cur=sel.value;sel.innerHTML=`<option value="">${allLabel}</option>`+options.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if([...sel.options].some(o=>o.value===cur))sel.value=cur}

function renderRepairs(){
  const printers=[...S.printers].sort((a,b)=>String(a.name).localeCompare(b.name));
  const removed=uniq(S.repairs.filter(r=>r.printerRemoved).map(r=>r.printerId)).map(id=>{const r=S.repairs.find(x=>x.printerId===id);return [id,r.printerName+' (removed)']});
  fillSelect($('#rPrinter'),printers.map(p=>[p.id,p.name]).concat(removed),'All printers');
  fillSelect($('#rType'),uniq(REPAIR_TYPES.concat(S.repairs.map(r=>r.type))).filter(t=>S.repairs.some(r=>r.type===t)).map(t=>[t,t]),'All types');
  const fp=$('#rPrinter').value,ft=$('#rType').value;
  const rq=S.rq.trim().toLowerCase();
  const prText=p=>[p.name,p.code,p.model,p.serial,p.location,p.notes].join(' ').toLowerCase();
  const prMatch=p=>!rq||prText(p).includes(rq);
  const repMatch=r=>{if(!rq)return true;const pr=S.printers.find(x=>x.id===r.printerId);
    return (pr&&prText(pr).includes(rq))||[r.printerName,r.type,r.doneBy,r.notes,partsText(r)].join(' ').toLowerCase().includes(rq)};
  const rows=S.repairs.filter(r=>(!fp||r.printerId===fp)&&(!ft||r.type===ft)&&repMatch(r)).sort(byNewest);
  const empty=S.loaded&&!S.printers.length&&!S.repairs.length;
  $('#rempty').hidden=!empty;
  ['#pgrid','#rHistHead','#rTableBox','#rsummary'].forEach(sel=>$(sel).hidden=empty);
  $('#logRepairBtn').disabled=!S.printers.length;
  const shownPrinters=printers.filter(p=>(!fp||p.id===fp)&&(prMatch(p)||(rq&&rows.some(r=>r.printerId===p.id))));
  $('#pgrid').innerHTML=(rq&&!shownPrinters.length?`<p class="summary">No printers match “${esc(S.rq)}”.</p>`:'')+shownPrinters.map(p=>{
    const mine=S.repairs.filter(r=>r.printerId===p.id).sort(byNewest);const last=mine[0];
    return `<button class="pcard" type="button" data-pid="${esc(p.id)}">
      <span class="pn">${esc(p.name)}</span>${p.code?`<span class="pm" style="font-family:var(--f-mono)">${esc(p.code)}${p.labelPrintedAt?'':' · <span class="pill low">Needs label</span>'}</span>`:''}
      <span class="pm">${esc([p.model,p.serial&&('S/N '+p.serial)].filter(Boolean).join(' · ')||'No model or serial yet')}</span>
      ${p.location?`<span class="pm">${esc(p.location)}</span>`:''}
      <span class="pl"><span><b>${mine.length}</b> ${mine.length===1?'repair':'repairs'}</span><span>${last?`Last: ${esc(fmtDay(last.date))}`:'No repairs logged'}</span></span>
    </button>`}).join('');
  const total=rows.reduce((s,r)=>s+(Number(r.cost)||0),0);
  $('#rsummary').textContent=`${S.printers.length} ${S.printers.length===1?'printer':'printers'} · ${rows.length} ${rows.length===1?'repair':'repairs'}${fp||ft||rq?' shown':''}`+(total?` · ${money(total)} spent`:'');
  $('#repairBody').innerHTML=rows.length?rows.map(r=>`<tr class="click" data-rid="${esc(r.id)}">
    <td class="when">${esc(fmtDay(r.date))}</td><td>${esc(r.printerName)}${r.printerRemoved?' <span class="when">(removed)</span>':''}</td>
    <td><span class="rtype">${esc(r.type)}</span></td><td>${esc(r.doneBy||'—')}</td><td>${esc(partsText(r))}</td>
    <td class="money">${esc(money(r.cost))}</td><td>${esc(r.notes||'')}</td></tr>`).join('')
    :`<tr><td colspan="7" style="color:var(--muted);padding:24px 12px">${S.repairs.length?'No repairs match these filters.':'No repairs logged yet. Press Log a repair after fixing a printer.'}</td></tr>`;
}

const EVENT_TAG={created:['Added','add'],edited:['Changed','adjust'],removed:['Removed','lockout'],'label-printed':['Label','pin-changed'],
  'repair-logged':['Repair','restock'],'repair-edited':['Repair edited','adjust'],'repair-moved':['Repair moved','adjust'],'repair-deleted':['Repair deleted','take']};
function fmtStamp(ms){return new Date(ms).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}
function changeLine(c){
  if(c.from&&c.to)return `<li><b>${esc(c.label)}:</b> <s>${esc(c.from)}</s> → ${esc(c.to)}</li>`;
  if(c.to)return `<li><b>${esc(c.label)}:</b> ${esc(c.to)}</li>`;
  return `<li><b>${esc(c.label)}:</b> <s>${esc(c.from)}</s></li>`;
}
function openPrinter(id,tab){
  const pr=S.printers.find(p=>p.id===id);if(!pr)return;
  S.openPrinterId=id;let view=tab||'history';
  const draw=()=>{
    const cur=S.printers.find(p=>p.id===id);if(!cur){closePanel();return}
    const mine=S.repairs.filter(r=>r.printerId===id).sort(byNewest);
    const total=mine.reduce((s,r)=>s+(Number(r.cost)||0),0);
    const events=S.printerLog.filter(e=>e.printerId===id).sort((a,b)=>b.at-a.at);
    const scroll=$('#panel').scrollTop;
    openPanel(`<div class="phead"><div style="min-width:0"><h2>${esc(cur.name)}</h2>
        <div class="meta">${cur.code?`<span>Barcode <b>${esc(cur.code)}</b></span>`:''}${cur.model?`<span>Model <b>${esc(cur.model)}</b></span>`:''}${cur.serial?`<span>S/N <b>${esc(cur.serial)}</b></span>`:''}${cur.location?`<span>${esc(cur.location)}</span>`:''}</div>
        <div class="meta" style="margin-top:4px"><span><b>${mine.length}</b> ${mine.length===1?'repair':'repairs'}</span>${total?`<span>Total <b>${esc(money(total))}</b></span>`:''}<span><b>${events.length}</b> history ${events.length===1?'entry':'entries'}</span></div></div>
      <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
    ${cur.notes?`<p class="after" style="margin-top:12px">${esc(cur.notes)}</p>`:''}
    <div class="stack"><button class="btn primary big" type="button" data-act="log">Log a repair</button>
      <div class="seg seg-neutral" role="group" aria-label="Show"><button type="button" data-view="history" aria-pressed="${view==='history'}">Full history</button><button type="button" data-view="repairs" aria-pressed="${view==='repairs'}">Repairs only</button></div></div>
    <div class="hist">
    ${view==='repairs'?(mine.length?`<ul class="rlist">${mine.map(r=>`<li data-rid="${esc(r.id)}"><span class="rd">${esc(fmtDay(r.date))}</span><span><span class="rtype">${esc(r.type)}</span>${r.cost!=null?` <span class="money">${esc(money(r.cost))}</span>`:''}</span>
        <span class="rx">${esc([r.doneBy&&('By '+r.doneBy),partsText(r)&&('Parts: '+partsText(r)),r.notes].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>`
        :'<p class="after">No repairs logged for this printer yet.</p>')
      :(events.length?`<ol class="timeline">${events.map(e=>{const t=EVENT_TAG[e.type]||[e.type,'adjust'];const live=e.repairId&&S.repairs.some(r=>r.id===e.repairId);
        return `<li ${live?`data-rid="${esc(e.repairId)}" class="tl-click"`:''}><div class="tl-head"><span class="tag ${t[1]}">${esc(t[0])}</span><span class="when">${esc(fmtStamp(e.at))}</span></div>
          <div class="tl-sum">${esc(e.summary)}</div>
          ${(e.changes||[]).length?`<ul class="tl-changes">${e.changes.map(changeLine).join('')}</ul>`:''}
          <div class="tl-who">${esc([e.by&&('By '+e.by),e.device&&('from '+e.device),e.backfilled&&'recorded before history tracking started'].filter(Boolean).join(' · '))}</div></li>`}).join('')}</ol>`
        :'<p class="after">No history yet.</p>')}
    </div>
    <div class="foot"><button class="btn" type="button" data-act="label">Print label</button><button class="btn" type="button" data-act="export">Export history</button><button class="btn" type="button" data-act="edit">Edit printer</button></div>`,cur.name);
    const p=$('#panel');p.scrollTop=scroll;
    p.addEventListener('click',e=>{const li=e.target.closest('[data-rid]');if(li){openRepair(li.dataset.rid);return}
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.view){view=b.dataset.view;draw();return}
      if(b.dataset.act==='close')closePanel();else if(b.dataset.act==='log')openRepair(null,id);else if(b.dataset.act==='edit')openPrinterEdit(id);
      else if(b.dataset.act==='label')openLabels([id],{kind:'printer'});
      else if(b.dataset.act==='export')download('/api/export/printer-history.csv?printer='+encodeURIComponent(id))});
    S.openPrinterId=id;S.redrawPrinter=draw;
  };
  draw();
}

function openPrinterEdit(id){
  const pr=id?S.printers.find(p=>p.id===id):null;const isNew=!pr;
  const count=pr?S.repairs.filter(r=>r.printerId===pr.id).length:0;
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${isNew?'Add printer':'Edit printer'}</h2><div class="meta">${isNew?'Add a label printer so you can log repairs against it.':'Changes show on its repair history too.'}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="prForm" autocomplete="off">
    <div class="field"><label for="prName">Name</label><input id="prName" required maxlength="80" value="${esc(pr?pr.name:'')}" placeholder="e.g. Shipping desk printer" autofocus></div>
    <div class="row2">
      <div class="field"><label for="prModel">Make and model</label><input id="prModel" list="modelList" maxlength="80" value="${esc(pr?pr.model:'')}" placeholder="e.g. Zebra ZD421">
        <datalist id="modelList">${uniq(PRINTER_MODELS.concat(S.printers.map(p=>p.model))).map(m=>`<option value="${esc(m)}">`).join('')}</datalist></div>
      <div class="field"><label for="prSerial">Serial number</label><input id="prSerial" maxlength="80" value="${esc(pr?pr.serial:'')}" placeholder="On the sticker underneath"></div>
    </div>
    <div class="field"><label for="prLoc">Where it is</label><input id="prLoc" maxlength="80" value="${esc(pr?pr.location:'')}" placeholder="e.g. Rack room, bench 2"></div>
    <div class="field"><label for="prNotes">Notes (optional)</label><textarea id="prNotes" rows="2" maxlength="1000" placeholder="Purchase date, warranty, label size it uses…">${esc(pr?pr.notes:'')}</textarea></div>
    <div class="field"><label for="prBy">Your name (for the printer's history)</label><input id="prBy" list="prByList" maxlength="80" placeholder="Optional">
      <datalist id="prByList">${uniq(recentPeople().concat(S.repairs.map(x=>x.doneBy))).map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
    <button class="btn primary big" type="submit" id="prGo">${isNew?'Add printer':'Save changes'}</button>
    <div class="foot">${isNew?'<span></span>':'<button class="btn danger" type="button" data-act="del">Remove printer</button>'}<button class="btn ghost" type="button" data-act="${isNew?'close':'back'}">Cancel</button></div>
    <div id="delBox" hidden class="confirm"><span style="flex:1 1 200px">Remove <b>${esc(pr?pr.name:'')}</b>? Its ${count} repair ${count===1?'record stays':'records stay'} in the history.</span><button class="btn danger" type="button" data-act="delYes">Remove</button><button class="btn" type="button" data-act="delNo">Keep</button></div>
  </form>`,isNew?'Add printer':'Edit printer');
  const p=$('#panel');
  p.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;const a=b.dataset.act;
    if(a==='close')closePanel();else if(a==='back')openPrinter(id);
    else if(a==='del')p.querySelector('#delBox').hidden=false;else if(a==='delNo')p.querySelector('#delBox').hidden=true;
    else if(a==='delYes'){b.disabled=true;try{await api('DELETE','/api/printers/'+id+'?by='+encodeURIComponent(p.querySelector('#prBy').value.trim()));closePanel();toast(`Removed ${pr.name}`);refresh()}catch(err){toast(err.message);b.disabled=false}}});
  p.querySelector('#prForm').addEventListener('submit',async e=>{e.preventDefault();const v=s=>p.querySelector(s).value.trim();
    const body={name:v('#prName'),model:v('#prModel'),serial:v('#prSerial'),location:v('#prLoc'),notes:v('#prNotes'),by:v('#prBy')};
    if(!body.name)return;const go=p.querySelector('#prGo');go.disabled=true;go.textContent='Saving…';
    try{const saved=isNew?await api('POST','/api/printers',body):await api('PUT','/api/printers/'+id,body);
      await refresh();if(isNew){openLabels([saved.id],{kind:'printer',justAdded:true})}else{toast('Saved');openPrinter(saved.id)}}
    catch(err){toast(err.message);go.disabled=false;go.textContent=isNew?'Add printer':'Save changes'}});
}

function openRepair(id,printerId){
  const r=id?S.repairs.find(x=>x.id===id):null;const isNew=!r;
  if(isNew&&!S.printers.length){toast('Add a printer first.');openPrinterEdit(null);return}
  const pid=r?r.printerId:(printerId||($('#rPrinter').value&&S.printers.some(p=>p.id===$('#rPrinter').value)?$('#rPrinter').value:''));
  const printers=[...S.printers].sort((a,b)=>String(a.name).localeCompare(b.name));
  const people=uniq(S.repairs.slice().sort(byNewest).map(x=>x.doneBy).concat(recentPeople()));
  const types=uniq(REPAIR_TYPES.concat(S.repairs.map(x=>x.type)));
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${isNew?'Log a repair':'Edit repair'}</h2><div class="meta">Record what was fixed on a label printer.</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="rpForm" autocomplete="off">
    <div class="row2">
      <div class="field"><label for="rpPrinter">Printer</label><select id="rpPrinter" required>
        ${!pid?'<option value="">Choose a printer…</option>':''}
        ${r&&r.printerRemoved?`<option value="${esc(r.printerId)}" selected>${esc(r.printerName)} (removed)</option>`:''}
        ${printers.map(p=>`<option value="${esc(p.id)}" ${p.id===pid?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="rpDate">Date</label><input id="rpDate" type="date" required value="${esc(r?r.date:todayStr())}" max="${todayStr()}"></div>
    </div>
    <div class="field"><label for="rpType">Type of repair</label><input id="rpType" required list="typeList" maxlength="80" value="${esc(r?r.type:'')}" placeholder="Pick one or type your own" ${pid?'autofocus':''}>
      <datalist id="typeList">${types.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
      <div class="quick" style="margin-top:6px">${REPAIR_TYPES.slice(0,6).map(t=>`<button type="button" class="chip" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label for="rpBy">Done by <span id="byNeed" class="when"></span></label><input id="rpBy" list="byList" maxlength="80" value="${esc(r?r.doneBy:'')}" placeholder="Name or repair shop">
        <datalist id="byList">${people.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label for="rpCost">Cost (optional)</label><input id="rpCost" type="number" inputmode="decimal" min="0" step="0.01" value="${r&&r.cost!=null?esc(r.cost):''}" placeholder="0.00"></div>
    </div>
    <div class="field"><span class="lbl">Parts from inventory (optional)</span>
      <div id="partRows" class="partrows"></div>
      <div class="quick" style="align-items:center"><button class="btn" type="button" data-act="addPart">+ Add a part</button><span class="after">or scan a part's barcode now</span></div>
      <div class="after" id="partNote"></div></div>
    <div class="field"><label for="rpParts">Other parts, not in inventory (optional)</label><input id="rpParts" maxlength="300" value="${esc(r?r.parts:'')}" placeholder="e.g. Belt ordered from vendor"></div>
    <div class="field"><label for="rpNotes">What happened / what was done</label><textarea id="rpNotes" rows="3" maxlength="2000" placeholder="e.g. Faded print on left side. Replaced printhead, ran calibration.">${esc(r?r.notes:'')}</textarea></div>
    ${isNew?'':`<div class="field"><label for="rpEditBy">Your name (for the printer's history)</label><input id="rpEditBy" list="byList" maxlength="80" placeholder="Optional. Who is changing this record?"></div>`}
    <button class="btn primary big" type="submit" id="rpGo">${isNew?'Save repair':'Save changes'}</button>
    <div class="foot">${isNew?'<span></span>':'<button class="btn danger" type="button" data-act="del">Delete record</button>'}<button class="btn ghost" type="button" data-act="close">Cancel</button></div>
    <div id="delBox" hidden class="confirm"><span style="flex:1 1 200px">Delete this repair record? This can't be undone.${r&&(r.inventoryParts||[]).length?`<label class="retparts"><input type="checkbox" id="retParts" checked> Put its parts back in inventory (${esc(partsText({inventoryParts:r.inventoryParts}))})</label>`:''}</span><button class="btn danger" type="button" data-act="delYes">Delete</button><button class="btn" type="button" data-act="delNo">Keep</button></div>
  </form>`,isNew?'Log a repair':'Edit repair');
  const p=$('#panel');
  // Parts taken from inventory. When editing, this repair's own parts count as available again.
  const orig=new Map(((r&&r.inventoryParts)||[]).map(x=>[x.itemId,x.qty]));
  let parts=((r&&r.inventoryParts)||[]).map(x=>({itemId:x.itemId,qty:x.qty,name:x.itemName}));
  const sortedItems=()=>[...S.items].sort((a,b)=>String(a.name).localeCompare(b.name));
  const avail=id=>{const it=S.items.find(i=>i.id===id);return it?(it.qty||0)+(orig.get(id)||0):(orig.get(id)||0)};
  const usedElsewhere=(id,idx)=>parts.reduce((t,x,i)=>i!==idx&&x.itemId===id?t+x.qty:t,0);
  function drawParts(){
    const box=p.querySelector('#partRows');
    box.innerHTML=parts.map((x,i)=>{const gone=x.itemId&&!S.items.some(it=>it.id===x.itemId);const left=x.itemId?avail(x.itemId)-usedElsewhere(x.itemId,i):0;
      return `<div class="partrow" data-i="${i}">
        <select class="pItem" aria-label="Part" ${gone?'disabled':''}><option value="">Choose a part…</option>
          ${gone?`<option value="${esc(x.itemId)}" selected>${esc(x.name)} (no longer in inventory)</option>`:''}
          ${sortedItems().map(it=>{const a=avail(it.id);return `<option value="${esc(it.id)}" ${it.id===x.itemId?'selected':''} ${a<=0&&it.id!==x.itemId?'disabled':''}>${esc(it.name)} · ${esc(it.code)} · ${a} left</option>`}).join('')}</select>
        <div class="pstep"><button type="button" data-pstep="-1" aria-label="One less" ${x.qty<=1||gone?'disabled':''}>${MINUS}</button><span class="pq" aria-live="polite">${x.qty}</span><button type="button" data-pstep="1" aria-label="One more" ${!x.itemId||gone||x.qty>=left?'disabled':''}>${PLUS}</button></div>
        <button type="button" class="btn ghost premove" data-premove aria-label="Remove part" ${gone?'disabled':''}>${CLOSE}</button></div>`}).join('');
    const picked=parts.filter(x=>x.itemId);
    const takes=picked.reduce((t,x)=>t+Math.max(0,x.qty-(orig.get(x.itemId)||0)),0);
    p.querySelector('#partNote').textContent=picked.length?(isNew?`Saving takes ${picked.map(x=>`${x.qty} × ${(S.items.find(i=>i.id===x.itemId)||x).name}`).join(', ')} out of inventory.`:'Changing part quantities takes out or puts back the difference.'):'';
    p.querySelector('#byNeed').textContent=takes?'(required with parts)':'';
  }
  function addPart(itemId){
    if(itemId){const ex=parts.find(x=>x.itemId===itemId);const left=avail(itemId)-usedElsewhere(itemId,-1);
      if(left<=0){toast('None of that part left in inventory.');return}
      if(ex){ex.qty++;}else{const blank=parts.find(x=>!x.itemId);if(blank){blank.itemId=itemId;blank.qty=1}else parts.push({itemId,qty:1})}
      const it=S.items.find(i=>i.id===itemId);toast(`Added part: ${it?it.name:'item'}`)}
    else parts.push({itemId:'',qty:1});
    drawParts();
  }
  S.partScan=it=>addPart(it.id);
  S.printerScan=pr=>{const sel=p.querySelector('#rpPrinter');if(![...sel.options].some(o=>o.value===pr.id))return;sel.value=pr.id;toast(`Printer: ${pr.name}`)};
  p.querySelector('#partRows').addEventListener('change',e=>{const row=e.target.closest('.partrow');if(!row||!e.target.classList.contains('pItem'))return;
    const i=+row.dataset.i;parts[i].itemId=e.target.value;parts[i].qty=1;
    const dup=parts.findIndex((x,j)=>j!==i&&x.itemId&&x.itemId===parts[i].itemId);
    if(dup>=0){parts[dup].qty=Math.min(parts[dup].qty+1,avail(parts[i].itemId));parts.splice(i,1)}
    drawParts()});
  drawParts();
  p.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;const a=b.dataset.act;
    if(b.dataset.type){p.querySelector('#rpType').value=b.dataset.type;return}
    const row=b.closest('.partrow');
    if(row&&b.dataset.pstep){const i=+row.dataset.i,x=parts[i];const left=avail(x.itemId)-usedElsewhere(x.itemId,i);x.qty=Math.max(1,Math.min(left,x.qty+Number(b.dataset.pstep)));drawParts();return}
    if(row&&b.hasAttribute('data-premove')){parts.splice(+row.dataset.i,1);drawParts();return}
    if(a==='addPart'){addPart(null);const sel=p.querySelectorAll('.pItem');if(sel.length)sel[sel.length-1].focus();return}
    if(a==='close')closePanel();
    else if(a==='del')p.querySelector('#delBox').hidden=false;else if(a==='delNo')p.querySelector('#delBox').hidden=true;
    else if(a==='delYes'){b.disabled=true;const ret=p.querySelector('#retParts');const back=!!(ret&&ret.checked);
      const qs=new URLSearchParams();if(back)qs.set('returnParts','1');const who=p.querySelector('#rpEditBy').value.trim();if(who)qs.set('by',who);
      try{await api('DELETE','/api/repairs/'+id+(qs.toString()?'?'+qs:''));closePanel();toast(back?'Repair deleted and parts put back':'Repair record deleted');refresh()}catch(err){toast(err.message);b.disabled=false}}});
  p.querySelector('#rpForm').addEventListener('submit',async e=>{e.preventDefault();const v=s=>p.querySelector(s).value.trim();
    const body={printerId:v('#rpPrinter'),date:v('#rpDate'),type:v('#rpType'),doneBy:v('#rpBy'),cost:v('#rpCost'),parts:v('#rpParts'),notes:v('#rpNotes'),
      inventoryParts:parts.filter(x=>x.itemId).map(x=>({itemId:x.itemId,qty:x.qty})),by:isNew?'':v('#rpEditBy')};
    if(!body.printerId){toast('Choose which printer was repaired.');return}
    if(parts.some(x=>!x.itemId)){toast('Choose a part for each row, or remove the empty row.');return}
    if(body.inventoryParts.some(x=>x.qty>(orig.get(x.itemId)||0))&&!body.doneBy){toast('Enter who did the repair. They’re logged as taking the parts.');p.querySelector('#rpBy').focus();return}
    const go=p.querySelector('#rpGo');go.disabled=true;go.textContent='Saving…';
    try{const saved=isNew?await api('POST','/api/repairs',body):await api('PUT','/api/repairs/'+id,body);
      await refresh();closePanel();
      const n=(saved.inventoryParts||[]).length;
      toast(isNew?`Repair logged for ${saved.printerName}`+(n?`. ${n===1?'Part':'Parts'} taken from inventory.`:''):'Repair updated')}
    catch(err){toast(err.message);go.disabled=false;go.textContent=isNew?'Save repair':'Save changes'}});
}
$('#pgrid').addEventListener('click',e=>{const c=e.target.closest('[data-pid]');if(c)openPrinter(c.dataset.pid)});
$('#repairBody').addEventListener('click',e=>{const tr=e.target.closest('[data-rid]');if(tr)openRepair(tr.dataset.rid)});
$('#addPrinterBtn').onclick=()=>openPrinterEdit(null);
$('#printerLabelsBtn').onclick=()=>openLabels(null,{kind:'printer'});$('#rEmptyAdd').onclick=()=>openPrinterEdit(null);
$('#logRepairBtn').onclick=()=>openRepair(null);
['#rPrinter','#rType'].forEach(sel=>$(sel).addEventListener('change',renderRepairs));
$('#rq').addEventListener('input',e=>{S.rq=e.target.value;renderRepairs()});
$('#rq').addEventListener('keydown',e=>{if(e.key==='Enter'&&parseCode(e.target.value)){e.preventDefault();const v=e.target.value;e.target.value='';S.rq='';renderRepairs();handleScan(v)}});
$('#expRepairs').onclick=()=>{const qs=new URLSearchParams();if($('#rPrinter').value)qs.set('printer',$('#rPrinter').value);if($('#rType').value)qs.set('type',$('#rType').value);
  download('/api/export/repairs.csv'+(qs.toString()?'?'+qs:''))};

(async function boot(){
  setView(viewFromHash());
  drawDots();
  try{const st=await api('GET','/api/auth/status');
    if(st.loggedIn&&!st.lockedUntil){await refresh();connectLive()}else{S.loaded=true;render();showLogin(st)}}
  catch(e){S.loaded=true;S.online=false;setLive(false);notice(e.message);render()}
})();
})();
