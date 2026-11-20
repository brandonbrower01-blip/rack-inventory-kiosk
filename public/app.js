(function(){
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S={items:[],log:[],loaded:false,online:true,view:'inventory',q:'',sort:'name',openId:null};
const TYPE_LABEL={take:'Taken',return:'Returned',restock:'Restocked',adjust:'Count corrected',add:'New item',remove:'Item removed',lockout:'Device locked out','pin-changed':'PIN changed'};
// Equipment tracked one by one (printers, laptops / desktops); config shared with the server.
const KINDS=window.ASSET_KINDS;
const KLIST=Object.values(KINDS);
const A={};for(const K of KLIST)A[K.key]={list:[],repairs:[],history:[],q:''};
const kindByView=v=>KLIST.find(K=>K.view===v);
const kindByCode=code=>KLIST.find(K=>String(code||'').toUpperCase().startsWith(K.prefix));
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
    const kindCalls=KLIST.flatMap(K=>[api('GET',K.api.list),api('GET',K.api.repairs),api('GET',K.api.history)]);
    const [items,log,...kd]=await Promise.all([api('GET','/api/items'),api('GET','/api/log?limit=1000'),...kindCalls]);
    S.items=items;S.log=log;
    KLIST.forEach((K,i)=>{const st=A[K.key];st.list=kd[i*3];st.repairs=kd[i*3+1];st.history=kd[i*3+2]});
    S.loaded=true;
    if(S.redrawAsset&&!$('#scrim').hidden)S.redrawAsset();
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
const belowMin=it=>it.minQty!=null&&(it.qty||0)<it.minQty;
function stockPill(it){return (it.qty||0)<=0?'<span class="pill out">Out</span>':belowMin(it)?'<span class="pill low">Below min</span>':''}
const signed=e=>{const d=e.type==='adjust'?e.delta:(e.type==='take'?-e.qty:e.qty);return (d<0?'−':'+')+Math.abs(d||0)};

/* ---------- Inventory view ---------- */
function renderInventory(){
  const outCount=S.items.filter(i=>(i.qty||0)<=0).length;
  const lowCount=S.items.filter(belowMin).length;
  const q=S.q.trim().toLowerCase();
  const list=S.items.filter(i=>!q||(String(i.name)+' '+(i.code||'')+' '+(i.mro||'')+' '+(i.partNumber||'')).toLowerCase().includes(q));
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
  else if(S.items.length)$('#summary').textContent=`${list.length} of ${S.items.length} items`+(outCount?` · ${outCount} out of stock`:'')+(lowCount?` · ${lowCount} below minimum`:'');
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
function render(){const K=kindByView(S.view);S.view==='inventory'?renderInventory():K?renderAssets(K):renderActivity()}

/* ---------- Panels ---------- */
function openPanel(html,label){
  // Swap in a fresh panel element so click handlers from the previous popup can't fire again.
  const old=$('#panel');const p=old.cloneNode(false);old.replaceWith(p);p.innerHTML=html;
  if(S.stopCam){S.stopCam();S.stopCam=null}
  S.partScan=null;S.assetScan=null;S.redrawAsset=null;p.setAttribute('aria-label',label||'');$('#scrim').hidden=false;document.body.style.overflow='hidden';
  const f=p.querySelector('[autofocus]');if(f)setTimeout(()=>f.focus(),30)}
function closePanel(){if(S.stopCam){S.stopCam();S.stopCam=null}S.partScan=null;S.assetScan=null;S.redrawAsset=null;$('#scrim').hidden=true;$('#panel').innerHTML='';document.body.style.overflow='';S.openId=null}
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
      ${it.minQty!=null||it.maxQty!=null?`<div class="meta" style="margin-top:4px">${it.minQty!=null?`<span>Min <b>${it.minQty}</b></span>`:''}${it.maxQty!=null?`<span>Max <b>${it.maxQty}</b></span>`:''}</div>`:''}
      ${it.code||it.mro||it.partNumber?`<div class="meta" style="margin-top:4px">${it.code?`<span>Barcode <b>${esc(it.code)}</b></span>`:''}${it.mro?`<span>MRO <b>${esc(it.mro)}</b></span>`:''}${it.partNumber?`<span>Part # <b>${esc(it.partNumber)}</b></span>`:''}</div>`:''}
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
      <div class="field"><label for="edMro">MRO number</label><input id="edMro" maxlength="80" value="${esc(it&&it.mro||'')}" placeholder="Optional"></div>
      <div class="field"><label for="edPart">Part number</label><input id="edPart" maxlength="80" value="${esc(it&&it.partNumber||'')}" placeholder="Optional"></div>
    </div>
    <div class="row2">
      <div class="field"><label for="edQty">${isNew?'Starting count':'Count on hand'}</label><input id="edQty" type="number" inputmode="numeric" min="0" step="1" value="${it?it.qty||0:0}"></div>
      <div class="field"><label for="edUnit">Unit</label><input id="edUnit" value="${esc(it?it.unit||'pcs':'pcs')}" placeholder="pcs, boxes, ft"></div>
    </div>
    <div class="row2">
      <div class="field"><label for="edMin">Minimum on hand</label><input id="edMin" type="number" inputmode="numeric" min="0" step="1" value="${it&&it.minQty!=null?it.minQty:''}" placeholder="Optional"></div>
      <div class="field"><label for="edMax">Maximum on hand</label><input id="edMax" type="number" inputmode="numeric" min="0" step="1" value="${it&&it.maxQty!=null?it.maxQty:''}" placeholder="Optional"></div>
    </div>
    <p class="after" style="margin:-8px 0 0">When the count drops below the minimum, the item goes on the order report, which orders enough to get back up to the maximum.</p>
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
    const body={name,unit:v('#edUnit')||'pcs',qty:Math.max(0,Math.floor(Number(v('#edQty'))||0)),minQty:v('#edMin'),maxQty:v('#edMax'),mro:v('#edMro'),partNumber:v('#edPart')};
    if(body.minQty!==''&&body.maxQty!==''&&Number(body.maxQty)<Number(body.minQty)){toast('Maximum must be at least the minimum.');p.querySelector('#edMax').focus();return}
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
  document.querySelectorAll('main>section[id^="view-"]').forEach(sec=>sec.hidden=sec.id!=='view-'+v);
  $('#addBtn').hidden=v!=='inventory';
  try{history.replaceState(null,'','#'+v)}catch(e){}render()}
const viewFromHash=()=>{const h=location.hash.slice(1);return h==='activity'||kindByView(h)?h:'inventory'};
document.querySelector('.tabs').addEventListener('click',e=>{const t=e.target.closest('.tab');if(t)setView(t.dataset.view)});
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
// 1xxxxx = item RK-xxxx; each equipment kind has its own leading digit (2 = PR- printers, 3 = PC- computers).
const CODE_NUM=Object.assign({'RK-':'1'},...KLIST.map(K=>({[K.prefix]:K.numPrefix})));
const NUM_CODE=Object.fromEntries(Object.entries(CODE_NUM).map(([p,n])=>[n,p]));
const PREFIX_RE=new RegExp('('+Object.keys(CODE_NUM).map(p=>p.slice(0,-1)).join('|')+')\\W?(\\d{3,8})','i');
function parseCode(text){
  const t=String(text||'').trim();
  const n=t.match(/^(\d)(\d{5})$/);
  if(n&&NUM_CODE[n[1]])return NUM_CODE[n[1]]+String(Number(n[2])).padStart(4,'0');
  const m=t.match(PREFIX_RE);
  return m?m[1].toUpperCase()+'-'+m[2]:null;
}
function barcodeData(code){
  const m=String(code).match(/^([A-Z]+-)(\d+)$/);
  if(m&&CODE_NUM[m[1]]&&Number(m[2])<=99999)return CODE_NUM[m[1]]+String(Number(m[2])).padStart(5,'0');
  return null;
}
function handleScan(text){
  const code=parseCode(text);
  if(!code){toast('That barcode isn’t one of ours.');return}
  const K=kindByCode(code);
  if(K){
    const x=A[K.key].list.find(y=>String(y.code).toUpperCase()===code);
    if(!x){toast(`No ${K.label} with barcode ${code}. It may have been removed.`);return}
    if(S.assetScan){S.assetScan(K,x);return}
    if(S.view!==K.view)setView(K.view);
    closePanel();openAsset(K,x.id);toast(`Scanned ${x.code}: ${x.name}`);return;
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
// Tape labels (laptops / desktops): fixed tape width, length grows to fit the text and barcode.
function tapeLabelHTML(it,K){
  const lines=[it.serial&&('S/N '+it.serial),it.hostname,it.assetTag&&('Asset '+it.assetTag)].filter(Boolean);
  return `<div class="label tape" style="height:${K.tapeIn}in"><div class="t-text"><div class="t1">${esc(it.model||it.type||K.Label)}</div>${lines.map(l=>`<div class="t2">${esc(l)}</div>`).join('')}</div>
    <div class="t-bar"><div class="l-bar">${code128Svg(it.code)}</div><div class="l-code">${esc(it.code)}</div></div></div>`;
}
function labelHTML(it){
  const TK=kindByCode(it.code);
  if(TK&&TK.tapeIn)return tapeLabelHTML(it,TK);
  // Printer labels leave out the name (it changes when a printer moves); scanning shows the current name.
  if(String(it.code).startsWith('PR-'))return `<div class="label"><div class="l-name l-fit">${esc(it.model||'Label printer')}</div>
    ${it.serial?`<div class="l-sub l-fit">S/N ${esc(it.serial)}</div>`:''}
    <div class="l-bar">${code128Svg(it.code)}</div><div class="l-code">${esc(it.code)}</div></div>`;
  return `<div class="label"><div class="l-name l-fit l-split">${esc(it.name)}</div><div class="l-sub l-fit" hidden></div>
    <div class="l-bar">${code128Svg(it.code)}</div><div class="l-code">${esc(it.code)}</div></div>`;
}
const pref={get(k,d){try{return localStorage.getItem(k)||d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
async function printLabels(ids,format){
  const list=ids.map(id=>S.items.find(i=>i.id===id)||KLIST.map(K=>A[K.key].list.find(x=>x.id===id)).find(Boolean)).filter(Boolean);
  if(!list.length){toast('Choose at least one label to print.');return false}
  const area=$('#printArea');
  area.className='fmt-'+format;
  // Portrait: each 2 x 1 in label is turned 90 degrees onto a 1 in wide x 2 in tall page.
  area.innerHTML=list.map(it=>format==='roll'?`<div class="lrot">${labelHTML(it)}</div>`:labelHTML(it)).join('');
  area.style.display='block';fitLabelText(area);area.style.display='';
  $('#pageSize').textContent=format==='sheet'?'@page{size:letter;margin:0.5in}':format==='roll-land'?'@page{size:2in 1in;margin:0}':'@page{size:1in 2in;margin:0}';
  if(format==='tape'){
    // Each tape label gets its own page, exactly as long as that label.
    area.style.display='block';
    const css=[...area.querySelectorAll('.label')].map((el,i)=>{
      const len=Math.ceil((el.getBoundingClientRect().width/96)*20)/20, h=parseFloat(el.style.height)||0.7;
      el.style.page='tape'+i;return `@page tape${i}{size:${len}in ${h}in;margin:0}`}).join('\n');
    area.style.display='';
    $('#pageSize').textContent=css;
  }
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  window.print();
  try{await api('POST','/api/labels-printed',{ids:list.map(i=>i.id)})}catch(e){}
  refresh();
  return true;
}
async function openLabels(ids,opts){
  opts=opts||{};
  const tape=!!(opts.kind&&KINDS[opts.kind]&&KINDS[opts.kind].tapeIn);
  const fmtKey=tape?'labelFormat-'+opts.kind:'labelFormat';
  let fmt=pref.get(fmtKey,tape?'tape':'roll');if(tape&&fmt!=='tape'&&fmt!=='sheet')fmt='tape';if(!tape&&fmt==='tape')fmt='roll';
  const single=ids&&ids.length===1;
  const pick=!ids;
  const K=opts.kind?KINDS[opts.kind]:null,isPr=!!K;
  const noun=K?K.label:'item';
  const items=[...(K?A[K.key].list:S.items)].sort((a,b)=>String(a.name).localeCompare(b.name));
  if(pick)ids=items.filter(i=>!i.labelPrintedAt).map(i=>i.id);
  const one=single?items.find(i=>i.id===ids[0]):null;
  const blurb=isPr?(opts.justAdded?`Stick it on the ${noun}. Scanning it opens this ${noun}’s history.`:single?`Scanning this label opens the ${noun}’s history.`:`One label per ${noun}. ${K.Label}s without a printed label are ticked.`)
    :(opts.justAdded?'Stick the label on the shelf or bin. Scanning it opens this item.':single?'Scanning this label opens the item.':'One label per item. Items without a printed label are ticked.');
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${opts.justAdded?(isPr?K.Label+' added. Print its label?':'Item added. Print its label?'):single?'Print label':isPr?`Print ${noun} labels`:'Print labels'}</h2>
      <div class="meta">${blurb}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <div class="stack">
    ${one?`<div class="lpreview">${labelHTML(one)}</div>`:`<div class="picklist">
      <label class="pickall"><input type="checkbox" id="pickAll"> <b>Select all</b> <span class="when" id="pickCount"></span></label>
      ${items.map(i=>`<label><input type="checkbox" value="${esc(i.id)}" ${ids.includes(i.id)?'checked':''}> <span class="pname">${esc(i.name)}</span> <span class="when">${esc(i.code)}</span> ${i.labelPrintedAt?'<span class="pill okp">Printed</span>':'<span class="pill low">Needs label</span>'}</label>`).join('')||`<p class="summary">No ${noun}s yet.</p>`}
    </div>`}
    <div class="field"><label for="lblFmt">Print on</label>
      <select id="lblFmt">${tape?`<option value="tape" selected>Label tape, ${KINDS[opts.kind].tapeIn} in wide (length fits the label)</option>`:`<option value="roll" ${fmt==='roll'?'selected':''}>Label printer, 2 × 1 in, portrait (turned 90°)</option>
      <option value="roll-land" ${fmt==='roll-land'?'selected':''}>Label printer, 2 × 1 in, landscape</option>`}
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
    const f=p.querySelector('#lblFmt').value;pref.set(fmtKey,f);
    const chosen=one?[one.id]:boxes().filter(b=>b.checked).map(b=>b.value);
    if(await printLabels(chosen,f)){closePanel();toast(chosen.length===1?'Label sent to the printer':`${chosen.length} labels sent to the printer`)}
  };
}

/* ---------- Scan screen (scanner or camera) ---------- */
function openScan(){
  const canCam=('BarcodeDetector' in window)&&window.isSecureContext&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
  openPanel(`<div class="phead"><div style="min-width:0"><h2>Scan a label</h2><div class="meta">Scan an item's label to take it out or put it back, or a printer or computer label to see its history.</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="scanForm" autocomplete="off">
    <div class="field"><label for="scanInput">Scan now, or type the code</label>
      <input id="scanInput" placeholder="RK-0001, PR-0001 or PC-0001" autofocus autocapitalize="characters" spellcheck="false"></div>
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

/* ---------- Order report: items below their minimum ---------- */
function orderRows(){
  return S.items.filter(belowMin)
    .sort((a,b)=>String(a.name).localeCompare(b.name));
}
function orderTable(rows){
  return `<table class="otable"><thead><tr><th>MRO number</th><th>Part number</th><th>Item</th><th>Barcode</th><th class="r">On hand</th><th class="r">Min</th><th class="r">Max</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td class="mono">${r.mro?esc(r.mro):'<span class="when">none</span>'}</td><td class="mono">${r.partNumber?esc(r.partNumber):'<span class="when">none</span>'}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.code)}</td><td class="r">${r.qty||0}</td><td class="r">${r.minQty}</td><td class="r">${r.maxQty==null?'—':r.maxQty}</td></tr>`).join('')}</tbody></table>`;
}
function openOrder(){
  const rows=orderRows();
  const noLevels=!S.items.some(i=>i.minQty!=null);
  openPanel(`<div class="phead"><div style="min-width:0"><h2>Order report</h2>
      <div class="meta">${rows.length?`${rows.length} ${rows.length===1?'item is':'items are'} below minimum.`:'Nothing is below its minimum right now.'}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <div class="stack">
    ${rows.length?`<div class="tablebox">${orderTable(rows)}</div>`:`<p class="after">${noLevels?'No items have a minimum set yet. Open an item, press Edit item and fill in Minimum on hand and Maximum on hand.':'Every item with a minimum has enough on hand.'}</p>`}
    ${rows.length?`<div class="foot"><button class="btn" type="button" data-act="print">Print</button><button class="btn primary" type="button" data-act="csv">Download CSV</button></div>`:''}
  </div>`,'Order report');
  const p=$('#panel');
  p.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
    if(b.dataset.act==='close')closePanel();
    else if(b.dataset.act==='csv')download('/api/export/order.csv');
    else if(b.dataset.act==='print'){
      const area=$('#printArea');area.className='fmt-order';
      area.innerHTML=`<h1>Order report</h1><p>${esc(new Date().toLocaleString())} · ${rows.length} ${rows.length===1?'item':'items'} below minimum</p>${orderTable(orderRows())}`;
      $('#pageSize').textContent='@page{size:letter;margin:0.5in}';
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.print();
    }});
}
$('#orderBtn').onclick=openOrder;

/* ---------- Equipment tracked one by one: printers, laptops / desktops ---------- */
// Fields, wording and repair types for each kind come from /asset-kinds.js (shared with the server).
const fieldLabel=f=>f.hist||f.label.replace(/ \(optional\)$/i,'');
const money=v=>v==null||v===''?'':Number(v).toLocaleString(undefined,{style:'currency',currency:'USD'});
const fmtDay=d=>{if(!d)return'';const [y,m,dd]=d.split('-').map(Number);return new Date(y,m-1,dd).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})};
const todayStr=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const byNewest=(a,b)=>String(b.date).localeCompare(String(a.date))||(b.createdAt||0)-(a.createdAt||0);
const uniq=list=>[...new Set(list.filter(Boolean))];
function partsText(r){return (r.inventoryParts||[]).map(x=>`${x.qty} × ${x.itemName}`).concat(r.parts?[r.parts]:[]).join(', ')}
function fillSelect(sel,options,allLabel){const cur=sel.value;sel.innerHTML=`<option value="">${allLabel}</option>`+options.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if([...sel.options].some(o=>o.value===cur))sel.value=cur}
const hasField=(K,key)=>K.fields.some(f=>f.key===key);
const STATUS_PILL={'In use':'okp','Spare':'spare','In repair':'low','Retired':'out'};
function assetPills(K,x){
  const out=[];
  if(x.status)out.push(`<span class="pill ${STATUS_PILL[x.status]||'spare'}">${esc(x.status)}</span>`);
  if(x.warrantyEnd&&x.warrantyEnd<todayStr()&&x.status!=='Retired')out.push('<span class="pill low">Warranty ended</span>');
  return out.join(' ');
}
function assetText(K,x){return K.fields.map(f=>x[f.key]).concat([x.code]).join(' ').toLowerCase()}

// Build each kind's tab and screen from its config.
for(const K of KLIST){
  const tab=document.createElement('button');
  tab.className='tab';tab.setAttribute('role','tab');tab.id='tab-'+K.view;tab.dataset.view=K.view;tab.setAttribute('aria-selected','false');tab.textContent=K.tab;
  document.querySelector('.tabs').appendChild(tab);
  const sec=document.createElement('section');sec.id='view-'+K.view;sec.hidden=true;sec.dataset.kind=K.key;
  const selFilters=K.fields.filter(f=>f.filter);
  sec.innerHTML=`<div class="tools">
      <div class="search">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input data-r="q" type="search" placeholder="Search ${K.plural}: ${esc(K.fields.filter(f=>f.type!=='date'&&f.type!=='textarea'&&f.type!=='select').slice(0,5).map(f=>fieldLabel(f).toLowerCase()).join(', '))}, ${K.prefix} code" autocomplete="off" aria-label="Search ${K.plural} and repairs">
      </div>
    </div>
    <div class="tools">
      <div class="field"><label>${K.Label}</label><select data-r="dev"><option value="">All ${K.plural}</option></select></div>
      ${selFilters.map(f=>`<div class="field"><label>${esc(f.label)}</label><select data-r="f" data-key="${f.key}"><option value="">All</option>${f.options.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select></div>`).join('')}
      <div class="field"><label>Repair type</label><select data-r="type"><option value="">All types</option></select></div>
      <span style="flex:1"></span>
      <button class="btn" type="button" data-r="add">Add ${K.label}</button>
      <button class="btn" type="button" data-r="labels">Print ${K.label} labels</button>
      <button class="btn" type="button" data-r="csv">Export (CSV)</button>
      <button class="btn primary" type="button" data-r="log">Log a repair</button>
    </div>
    <p class="summary" data-r="summary"></p>
    <div class="grid pgrid" data-r="grid"></div>
    <div class="empty" data-r="empty" hidden>
      <h2>${esc(K.emptyTitle)}</h2>
      <p>${esc(K.emptyText)}</p>
      <div><button class="btn primary" type="button" data-r="add2">Add a ${K.label}</button></div>
    </div>
    <h3 class="sect" data-r="histHead">Repair history</h3>
    <div class="tablebox" data-r="tableBox"><table>
      <thead><tr><th>Date</th><th>${K.Label}</th><th>Repair</th><th>Done by</th><th>Parts</th><th>Cost</th><th>Notes</th></tr></thead>
      <tbody data-r="body"></tbody>
    </table></div>`;
  $('main').appendChild(sec);
  const r=k=>sec.querySelector(`[data-r="${k}"]`);
  r('grid').addEventListener('click',e=>{const c=e.target.closest('[data-aid]');if(c)openAsset(K,c.dataset.aid)});
  r('body').addEventListener('click',e=>{const tr=e.target.closest('[data-rid]');if(tr)openRepair(K,tr.dataset.rid)});
  r('add').onclick=r('add2').onclick=()=>openAssetEdit(K,null);
  r('labels').onclick=()=>openLabels(null,{kind:K.key});
  r('log').onclick=()=>openRepair(K,null);
  sec.querySelectorAll('select').forEach(s=>s.addEventListener('change',()=>renderAssets(K)));
  r('q').addEventListener('input',e=>{A[K.key].q=e.target.value;renderAssets(K)});
  r('q').addEventListener('keydown',e=>{if(e.key==='Enter'&&parseCode(e.target.value)){e.preventDefault();const v=e.target.value;e.target.value='';A[K.key].q='';renderAssets(K);handleScan(v)}});
  r('csv').onclick=()=>{const qs=new URLSearchParams();if(r('dev').value)qs.set('id',r('dev').value);if(r('type').value)qs.set('type',r('type').value);
    download(K.api.repairsCsv+(qs.toString()?'?'+qs:''))};
}

function renderAssets(K){
  const sec=$('#view-'+K.view),r=k=>sec.querySelector(`[data-r="${k}"]`);
  const st=A[K.key],ID=K.idField,NAME=K.nameField,REMOVED=K.removedField;
  const all=[...st.list].sort((a,b)=>String(a.name).localeCompare(b.name));
  const removed=uniq(st.repairs.filter(x=>x[REMOVED]).map(x=>x[ID])).map(id=>{const x=st.repairs.find(y=>y[ID]===id);return [id,x[NAME]+' (removed)']});
  fillSelect(r('dev'),all.map(x=>[x.id,x.name]).concat(removed),'All '+K.plural);
  fillSelect(r('type'),uniq(K.repairTypes.concat(st.repairs.map(x=>x.type))).filter(t=>st.repairs.some(x=>x.type===t)).map(t=>[t,t]),'All types');
  const fd=r('dev').value,ft=r('type').value;
  const fsel=[...sec.querySelectorAll('[data-r="f"]')].filter(s=>s.value).map(s=>[s.dataset.key,s.value]);
  const q=st.q.trim().toLowerCase();
  const passSel=x=>fsel.every(([k,v])=>x[k]===v);
  const assetMatch=x=>!q||assetText(K,x).includes(q);
  const repMatch=x=>{if(!q)return true;const a=st.list.find(y=>y.id===x[ID]);
    return (a&&assetText(K,a).includes(q))||[x[NAME],x.type,x.doneBy,x.notes,partsText(x)].join(' ').toLowerCase().includes(q)};
  const rows=st.repairs.filter(x=>(!fd||x[ID]===fd)&&(!ft||x.type===ft)&&repMatch(x)&&(!fsel.length||(()=>{const a=st.list.find(y=>y.id===x[ID]);return a&&passSel(a)})())).sort(byNewest);
  const empty=S.loaded&&!st.list.length&&!st.repairs.length;
  r('empty').hidden=!empty;
  ['grid','histHead','tableBox','summary'].forEach(k=>r(k).hidden=empty);
  r('log').disabled=!st.list.length;
  const shown=all.filter(x=>(!fd||x.id===fd)&&passSel(x)&&(assetMatch(x)||(q&&rows.some(y=>y[ID]===x.id))));
  r('grid').innerHTML=((q||fsel.length)&&!shown.length?`<p class="summary">No ${K.plural} match.</p>`:'')+shown.map(x=>{
    const mine=st.repairs.filter(y=>y[ID]===x.id).sort(byNewest);const last=mine[0];
    const line=[x.type,x.model,x.serial&&('S/N '+x.serial)].filter(Boolean).join(' · ');
    return `<button class="pcard" type="button" data-aid="${esc(x.id)}">
      <span class="pn">${esc(x.name)}</span><span class="pm" style="font-family:var(--f-mono)">${esc(x.code||'')}${x.labelPrintedAt?'':' · <span class="pill low">Needs label</span>'}</span>
      <span class="pm">${esc(line||'No model or serial yet')}</span>
      ${hasField(K,'assignedTo')?`<span class="pm">${x.assignedTo?'Assigned to <b>'+esc(x.assignedTo)+'</b>':'Not assigned'}</span>`:''}
      ${x.location?`<span class="pm">${esc(x.location)}</span>`:''}
      ${assetPills(K,x)?`<span class="pm">${assetPills(K,x)}</span>`:''}
      <span class="pl"><span><b>${mine.length}</b> ${mine.length===1?'repair':'repairs'}</span><span>${last?`Last: ${esc(fmtDay(last.date))}`:'No repairs logged'}</span></span>
    </button>`}).join('');
  const total=rows.reduce((s,x)=>s+(Number(x.cost)||0),0);
  r('summary').textContent=`${st.list.length} ${st.list.length===1?K.label:K.plural} · ${rows.length} ${rows.length===1?'repair':'repairs'}${fd||ft||q||fsel.length?' shown':''}`+(total?` · ${money(total)} spent`:'');
  r('body').innerHTML=rows.length?rows.map(x=>`<tr class="click" data-rid="${esc(x.id)}">
    <td class="when">${esc(fmtDay(x.date))}</td><td>${esc(x[NAME])}${x[REMOVED]?' <span class="when">(removed)</span>':''}</td>
    <td><span class="rtype">${esc(x.type)}</span></td><td>${esc(x.doneBy||'—')}</td><td>${esc(partsText(x))}</td>
    <td class="money">${esc(money(x.cost))}</td><td>${esc(x.notes||'')}</td></tr>`).join('')
    :`<tr><td colspan="7" style="color:var(--muted);padding:24px 12px">${st.repairs.length?'No repairs match these filters.':`No repairs logged yet. Press Log a repair after fixing a ${K.label}.`}</td></tr>`;
}

const EVENT_TAG={created:['Added','add'],edited:['Changed','adjust'],removed:['Removed','lockout'],'label-printed':['Label','pin-changed'],
  'repair-logged':['Repair','restock'],'repair-edited':['Repair edited','adjust'],'repair-moved':['Repair moved','adjust'],'repair-deleted':['Repair deleted','take']};
function fmtStamp(ms){return new Date(ms).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}
function changeLine(c){
  if(c.from&&c.to)return `<li><b>${esc(c.label)}:</b> <s>${esc(c.from)}</s> → ${esc(c.to)}</li>`;
  if(c.to)return `<li><b>${esc(c.label)}:</b> ${esc(c.to)}</li>`;
  return `<li><b>${esc(c.label)}:</b> <s>${esc(c.from)}</s></li>`;
}
function openAsset(K,id,tab){
  const st=A[K.key],ID=K.idField;
  if(!st.list.some(x=>x.id===id))return;
  let view=tab||'history';
  const draw=()=>{
    const cur=st.list.find(x=>x.id===id);if(!cur){closePanel();return}
    const mine=st.repairs.filter(x=>x[ID]===id).sort(byNewest);
    const total=mine.reduce((s,x)=>s+(Number(x.cost)||0),0);
    const events=st.history.filter(e=>e[ID]===id).sort((a,b)=>b.at-a.at);
    const scroll=$('#panel').scrollTop;
    const details=K.fields.filter(f=>f.key!=='name'&&f.key!=='notes'&&cur[f.key]).map(f=>`<span>${esc(fieldLabel(f))} <b>${esc(f.type==='date'?fmtDay(cur[f.key]):cur[f.key])}</b></span>`).join('');
    openPanel(`<div class="phead"><div style="min-width:0"><h2>${esc(cur.name)}</h2>
        <div class="meta">${cur.code?`<span>Barcode <b>${esc(cur.code)}</b></span>`:''}${details}</div>
        <div class="meta" style="margin-top:4px">${assetPills(K,cur)}<span><b>${mine.length}</b> ${mine.length===1?'repair':'repairs'}</span>${total?`<span>Total <b>${esc(money(total))}</b></span>`:''}<span><b>${events.length}</b> history ${events.length===1?'entry':'entries'}</span></div></div>
      <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
    ${cur.notes?`<p class="after" style="margin-top:12px">${esc(cur.notes)}</p>`:''}
    <div class="stack"><button class="btn primary big" type="button" data-act="log">Log a repair</button>
      <div class="seg seg-neutral" role="group" aria-label="Show"><button type="button" data-view="history" aria-pressed="${view==='history'}">Full history</button><button type="button" data-view="repairs" aria-pressed="${view==='repairs'}">Repairs only</button></div></div>
    <div class="hist">
    ${view==='repairs'?(mine.length?`<ul class="rlist">${mine.map(x=>`<li data-rid="${esc(x.id)}"><span class="rd">${esc(fmtDay(x.date))}</span><span><span class="rtype">${esc(x.type)}</span>${x.cost!=null?` <span class="money">${esc(money(x.cost))}</span>`:''}</span>
        <span class="rx">${esc([x.doneBy&&('By '+x.doneBy),partsText(x)&&('Parts: '+partsText(x)),x.notes].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>`
        :`<p class="after">No repairs logged for this ${K.label} yet.</p>`)
      :(events.length?`<ol class="timeline">${events.map(e=>{const t=EVENT_TAG[e.type]||[e.type,'adjust'];const live=e.repairId&&st.repairs.some(x=>x.id===e.repairId);
        return `<li ${live?`data-rid="${esc(e.repairId)}" class="tl-click"`:''}><div class="tl-head"><span class="tag ${t[1]}">${esc(t[0])}</span><span class="when">${esc(fmtStamp(e.at))}</span></div>
          <div class="tl-sum">${esc(e.summary)}</div>
          ${(e.changes||[]).length?`<ul class="tl-changes">${e.changes.map(changeLine).join('')}</ul>`:''}
          <div class="tl-who">${esc([e.by&&('By '+e.by),e.device&&('from '+e.device),e.backfilled&&'recorded before history tracking started'].filter(Boolean).join(' · '))}</div></li>`}).join('')}</ol>`
        :'<p class="after">No history yet.</p>')}
    </div>
    <div class="foot"><button class="btn" type="button" data-act="label">Print label</button><button class="btn" type="button" data-act="export">Export history</button><button class="btn" type="button" data-act="edit">Edit ${K.label}</button></div>`,cur.name);
    const p=$('#panel');p.scrollTop=scroll;
    p.addEventListener('click',e=>{const li=e.target.closest('[data-rid]');if(li){openRepair(K,li.dataset.rid);return}
      const b=e.target.closest('button');if(!b)return;
      if(b.dataset.view){view=b.dataset.view;draw();return}
      const a=b.dataset.act;
      if(a==='close')closePanel();else if(a==='log')openRepair(K,null,id);else if(a==='edit')openAssetEdit(K,id);
      else if(a==='label')openLabels([id],{kind:K.key});
      else if(a==='export')download(K.api.historyCsv+'?id='+encodeURIComponent(id))});
    S.redrawAsset=draw;
  };
  draw();
}

function fieldInput(K,f,x,isNew){
  const id='af-'+f.key,v=x?(x[f.key]||''):(isNew&&f.default)||'';
  const lbl=`<label for="${id}">${esc(f.label)}</label>`;
  if(f.type==='select')return `<div class="field">${lbl}<select id="${id}"><option value="">Not set</option>${f.options.map(o=>`<option ${o===v?'selected':''}>${esc(o)}</option>`).join('')}</select></div>`;
  if(f.type==='textarea')return `<div class="field">${lbl}<textarea id="${id}" rows="2" maxlength="${f.max||1000}" placeholder="${esc(f.placeholder||'')}">${esc(v)}</textarea></div>`;
  if(f.type==='date')return `<div class="field">${lbl}<input id="${id}" type="date" value="${esc(v)}"></div>`;
  const sugg=f.suggest?uniq(f.suggest.concat(A[K.key].list.map(y=>y[f.key]))):null;
  return `<div class="field">${lbl}<input id="${id}" maxlength="${f.max||80}" value="${esc(v)}" placeholder="${esc(f.placeholder||'')}" ${f.required?'required':''} ${f.key==='name'?'autofocus':''} ${sugg?`list="${id}-l"`:''}>
    ${sugg?`<datalist id="${id}-l">${sugg.map(s=>`<option value="${esc(s)}">`).join('')}</datalist>`:''}</div>`;
}
function openAssetEdit(K,id){
  const st=A[K.key];
  const x=id?st.list.find(y=>y.id===id):null;const isNew=!x;
  const count=x?st.repairs.filter(r=>r[K.idField]===x.id).length:0;
  const name=K.fields.find(f=>f.key==='name'),notes=K.fields.filter(f=>f.type==='textarea'),rest=K.fields.filter(f=>f!==name&&f.type!=='textarea');
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${isNew?'Add '+K.label:'Edit '+K.label}</h2><div class="meta">${isNew?`Add a ${K.label} so you can track it and log repairs against it.`:'Every change is recorded in its history.'}</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="afForm" autocomplete="off">
    ${fieldInput(K,name,x,isNew)}
    <div class="row2">${rest.map(f=>fieldInput(K,f,x,isNew)).join('')}</div>
    ${notes.map(f=>fieldInput(K,f,x,isNew)).join('')}
    <div class="field"><label for="afBy">Your name (for the ${K.label}'s history)</label><input id="afBy" list="afByList" maxlength="80" placeholder="Optional">
      <datalist id="afByList">${uniq(recentPeople().concat(st.repairs.map(r=>r.doneBy))).map(n=>`<option value="${esc(n)}">`).join('')}</datalist></div>
    <button class="btn primary big" type="submit" id="afGo">${isNew?'Add '+K.label:'Save changes'}</button>
    <div class="foot">${isNew?'<span></span>':`<button class="btn danger" type="button" data-act="del">Remove ${K.label}</button>`}<button class="btn ghost" type="button" data-act="${isNew?'close':'back'}">Cancel</button></div>
    <div id="delBox" hidden class="confirm"><span style="flex:1 1 200px">Remove <b>${esc(x?x.name:'')}</b>? Its ${count} repair ${count===1?'record stays':'records stay'} in the history.</span><button class="btn danger" type="button" data-act="delYes">Remove</button><button class="btn" type="button" data-act="delNo">Keep</button></div>
  </form>`,isNew?'Add '+K.label:'Edit '+K.label);
  const p=$('#panel');
  p.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;const a=b.dataset.act;
    if(a==='close')closePanel();else if(a==='back')openAsset(K,id);
    else if(a==='del')p.querySelector('#delBox').hidden=false;else if(a==='delNo')p.querySelector('#delBox').hidden=true;
    else if(a==='delYes'){b.disabled=true;try{await api('DELETE',K.api.list+'/'+id+'?by='+encodeURIComponent(p.querySelector('#afBy').value.trim()));closePanel();toast(`Removed ${x.name}`);refresh()}catch(err){toast(err.message);b.disabled=false}}});
  p.querySelector('#afForm').addEventListener('submit',async e=>{e.preventDefault();
    const body={by:p.querySelector('#afBy').value.trim()};
    for(const f of K.fields)body[f.key]=p.querySelector('#af-'+f.key).value.trim();
    if(!body.name)return;const go=p.querySelector('#afGo');go.disabled=true;go.textContent='Saving…';
    try{const saved=isNew?await api('POST',K.api.list,body):await api('PUT',K.api.list+'/'+id,body);
      await refresh();if(isNew){openLabels([saved.id],{kind:K.key,justAdded:true})}else{toast('Saved');openAsset(K,saved.id)}}
    catch(err){toast(err.message);go.disabled=false;go.textContent=isNew?'Add '+K.label:'Save changes'}});
}

function openRepair(K,id,assetId){
  const st=A[K.key],ID=K.idField,NAME=K.nameField,REMOVED=K.removedField;
  const r=id?st.repairs.find(x=>x.id===id):null;const isNew=!r;
  if(isNew&&!st.list.length){toast(`Add a ${K.label} first.`);openAssetEdit(K,null);return}
  const devSel=$('#view-'+K.view).querySelector('[data-r="dev"]').value;
  const pid=r?r[ID]:(assetId||(devSel&&st.list.some(x=>x.id===devSel)?devSel:''));
  const list=[...st.list].sort((a,b)=>String(a.name).localeCompare(b.name));
  const people=uniq(st.repairs.slice().sort(byNewest).map(x=>x.doneBy).concat(recentPeople()));
  const types=uniq(K.repairTypes.concat(st.repairs.map(x=>x.type)));
  openPanel(`<div class="phead"><div style="min-width:0"><h2>${isNew?'Log a repair':'Edit repair'}</h2><div class="meta">Record what was fixed on a ${K.label}.</div></div>
    <button class="btn ghost close" type="button" data-act="close" aria-label="Close">${CLOSE}</button></div>
  <form class="stack" id="rpForm" autocomplete="off">
    <div class="row2">
      <div class="field"><label for="rpAsset">${K.Label}</label><select id="rpAsset" required>
        ${!pid?`<option value="">Choose a ${K.label}…</option>`:''}
        ${r&&r[REMOVED]?`<option value="${esc(r[ID])}" selected>${esc(r[NAME])} (removed)</option>`:''}
        ${list.map(x=>`<option value="${esc(x.id)}" ${x.id===pid?'selected':''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="rpDate">Date</label><input id="rpDate" type="date" required value="${esc(r?r.date:todayStr())}" max="${todayStr()}"></div>
    </div>
    <div class="field"><label for="rpType">Type of repair</label><input id="rpType" required list="typeList" maxlength="80" value="${esc(r?r.type:'')}" placeholder="Pick one or type your own" ${pid?'autofocus':''}>
      <datalist id="typeList">${types.map(t=>`<option value="${esc(t)}">`).join('')}</datalist>
      <div class="quick" style="margin-top:6px">${K.repairTypes.slice(0,6).map(t=>`<button type="button" class="chip" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>
    <div class="row2">
      <div class="field"><label for="rpBy">Done by <span id="byNeed" class="when"></span></label><input id="rpBy" list="byList" maxlength="80" value="${esc(r?r.doneBy:'')}" placeholder="Name or repair shop">
        <datalist id="byList">${people.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label for="rpCost">Cost (optional)</label><input id="rpCost" type="number" inputmode="decimal" min="0" step="0.01" value="${r&&r.cost!=null?esc(r.cost):''}" placeholder="0.00"></div>
    </div>
    <div class="field"><span class="lbl">Parts from inventory (optional)</span>
      <div id="partRows" class="partrows"></div>
      <div class="quick" style="align-items:center"><button class="btn" type="button" data-act="addPart">+ Add a part</button><span class="after">or scan a part's barcode now</span></div>
      <div class="after" id="partNote"></div></div>
    <div class="field"><label for="rpParts">Other parts, not in inventory (optional)</label><input id="rpParts" maxlength="300" value="${esc(r?r.parts:'')}" placeholder="e.g. Ordered from vendor"></div>
    <div class="field"><label for="rpNotes">What happened / what was done</label><textarea id="rpNotes" rows="3" maxlength="2000" placeholder="${esc(K.repairPlaceholder)}">${esc(r?r.notes:'')}</textarea></div>
    ${isNew?'':`<div class="field"><label for="rpEditBy">Your name (for the ${K.label}'s history)</label><input id="rpEditBy" list="byList" maxlength="80" placeholder="Optional. Who is changing this record?"></div>`}
    <button class="btn primary big" type="submit" id="rpGo">${isNew?'Save repair':'Save changes'}</button>
    <div class="foot">${isNew?'<span></span>':'<button class="btn danger" type="button" data-act="del">Delete record</button>'}<button class="btn ghost" type="button" data-act="close">Cancel</button></div>
    <div id="delBox" hidden class="confirm"><span style="flex:1 1 200px">Delete this repair record? This can't be undone.${r&&(r.inventoryParts||[]).length?`<label class="retparts"><input type="checkbox" id="retParts" checked> Put its parts back in inventory (${esc(partsText({inventoryParts:r.inventoryParts}))})</label>`:''}</span><button class="btn danger" type="button" data-act="delYes">Delete</button><button class="btn" type="button" data-act="delNo">Keep</button></div>
  </form>`,isNew?'Log a repair':'Edit repair');
  const p=$('#panel');
  // Parts taken from inventory. When editing, this repair's own parts count as available again.
  const orig=new Map(((r&&r.inventoryParts)||[]).map(x=>[x.itemId,x.qty]));
  let parts=((r&&r.inventoryParts)||[]).map(x=>({itemId:x.itemId,qty:x.qty,name:x.itemName}));
  const sortedItems=()=>[...S.items].sort((a,b)=>String(a.name).localeCompare(b.name));
  const avail=iid=>{const it=S.items.find(i=>i.id===iid);return it?(it.qty||0)+(orig.get(iid)||0):(orig.get(iid)||0)};
  const usedElsewhere=(iid,idx)=>parts.reduce((t,x,i)=>i!==idx&&x.itemId===iid?t+x.qty:t,0);
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
  S.assetScan=(K2,x)=>{if(K2!==K){toast(`That's a ${K2.label} label. This repair is for a ${K.label}.`);return}
    const sel=p.querySelector('#rpAsset');if(![...sel.options].some(o=>o.value===x.id))return;sel.value=x.id;toast(`${K.Label}: ${x.name}`)};
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
      try{await api('DELETE',K.api.repairs+'/'+id+(qs.toString()?'?'+qs:''));closePanel();toast(back?'Repair deleted and parts put back':'Repair record deleted');refresh()}catch(err){toast(err.message);b.disabled=false}}});
  p.querySelector('#rpForm').addEventListener('submit',async e=>{e.preventDefault();const v=s=>p.querySelector(s).value.trim();
    const body={[ID]:v('#rpAsset'),date:v('#rpDate'),type:v('#rpType'),doneBy:v('#rpBy'),cost:v('#rpCost'),parts:v('#rpParts'),notes:v('#rpNotes'),
      inventoryParts:parts.filter(x=>x.itemId).map(x=>({itemId:x.itemId,qty:x.qty})),by:isNew?'':v('#rpEditBy')};
    if(!body[ID]){toast(`Choose which ${K.label} was repaired.`);return}
    if(parts.some(x=>!x.itemId)){toast('Choose a part for each row, or remove the empty row.');return}
    if(body.inventoryParts.some(x=>x.qty>(orig.get(x.itemId)||0))&&!body.doneBy){toast('Enter who did the repair. They’re logged as taking the parts.');p.querySelector('#rpBy').focus();return}
    const go=p.querySelector('#rpGo');go.disabled=true;go.textContent='Saving…';
    try{const saved=isNew?await api('POST',K.api.repairs,body):await api('PUT',K.api.repairs+'/'+id,body);
      await refresh();closePanel();
      const n=(saved.inventoryParts||[]).length;
      toast(isNew?`Repair logged for ${saved[NAME]}`+(n?`. ${n===1?'Part':'Parts'} taken from inventory.`:''):'Repair updated')}
    catch(err){toast(err.message);go.disabled=false;go.textContent=isNew?'Save repair':'Save changes'}});
}

(async function boot(){
  setView(viewFromHash());
  drawDots();
  try{const st=await api('GET','/api/auth/status');
    if(st.loggedIn&&!st.lockedUntil){await refresh();connectLive()}else{S.loaded=true;render();showLogin(st)}}
  catch(e){S.loaded=true;S.online=false;setLive(false);notice(e.message);render()}
})();
})();
