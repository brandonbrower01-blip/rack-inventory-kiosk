(function(){
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const S={items:[],log:[],loaded:false,online:true,view:'inventory',q:'',sort:'name',openId:null};
const TYPE_LABEL={take:'Taken',return:'Returned',restock:'Restocked',adjust:'Count corrected',add:'New item',remove:'Item removed'};

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
  if(!res.ok)throw new Error((data&&data.error)||('Server error ('+res.status+')'));
  return data;
}
async function refresh(){
  try{
    const [items,log]=await Promise.all([api('GET','/api/items'),api('GET','/api/log?limit=1000')]);
    S.items=items;S.log=log;S.loaded=true;
    if(!S.online){S.online=true;notice('')}
  }catch(e){S.loaded=true;S.online=false;setLive(false);notice(e.message)}
  render();
  if(S.openId&&!$('#scrim').hidden){const oh=document.getElementById('onhand');const it=S.items.find(i=>i.id===S.openId);if(oh&&it)oh.textContent=it.qty||0}
}
let refreshTimer=null;
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,150)}
function connectLive(){
  if(!window.EventSource){setInterval(refresh,10000);return}
  const es=new EventSource('/api/events');
  es.addEventListener('change',scheduleRefresh);
  es.onopen=()=>{setLive(true);refresh()};
  es.onerror=()=>{setLive(false);if(S.online){S.online=false;notice('Lost connection to the inventory server. Reconnecting…')}};
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
  const list=S.items.filter(i=>!q||String(i.name).toLowerCase().includes(q));
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
    <td class="num">${e.type==='remove'?'':signed(e)}</td>
    <td>${esc(e.itemName)}</td><td class="num">${e.after!=null?esc(e.after):''}</td><td>${esc(e.note||'')}</td></tr>`).join('')
    :`<tr><td colspan="7" style="color:var(--muted);padding:24px 12px">${S.log.length?'No activity matches these filters.':'Nothing logged yet. Every take, return and restock shows up here.'}</td></tr>`;
  const taken=rows.filter(e=>e.type==='take').reduce((s,e)=>s+e.qty,0);
  $('#asummary').textContent=`${rows.length} entries${taken?` · ${taken} units taken`:''}`+(S.log.length>=1000?' · showing latest 1,000 (export includes everything)':'');
}
function render(){S.view==='inventory'?renderInventory():renderActivity()}

/* ---------- Panels ---------- */
function openPanel(html,label){const p=$('#panel');p.innerHTML=html;p.setAttribute('aria-label',label||'');$('#scrim').hidden=false;document.body.style.overflow='hidden';
  const f=p.querySelector('[autofocus]');if(f)setTimeout(()=>f.focus(),30)}
function closePanel(){$('#scrim').hidden=true;$('#panel').innerHTML='';document.body.style.overflow='';S.openId=null}
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
  ${hist.length?`<div class="hist"><span class="lbl">Recent for this item</span><ul>${hist.map(e=>`<li><span class="tag ${esc(e.type)}">${esc(TYPE_LABEL[e.type]||e.type)}</span><b class="num">${e.type==='remove'?'':signed(e)}</b><span>${esc(e.person||'')}</span><span class="when">${esc(fmtWhen(e.at))}</span></li>`).join('')}</ul></div>`:''}
  <div class="foot"><span></span><button class="btn" type="button" data-act="edit">Edit item</button></div>`,it.name);
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
      const saved=isNew?await api('POST','/api/items',body):await api('PUT','/api/items/'+id,body);
      if(pendingImage){try{await api('POST',`/api/items/${saved.id}/image`,pendingImage,pendingImage.type||'image/jpeg')}catch(err){toast('Saved, but the photo didn’t upload: '+err.message)}}
      closePanel();toast(isNew?`Added ${name}`:'Saved');refresh();
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
  $('#view-inventory').hidden=v!=='inventory';$('#view-activity').hidden=v!=='activity';
  try{history.replaceState(null,'',v==='activity'?'#activity':'#inventory')}catch(e){}render()}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>setView(t.dataset.view));
window.addEventListener('hashchange',()=>setView(location.hash==='#activity'?'activity':'inventory'));
$('#q').addEventListener('input',e=>{S.q=e.target.value;renderInventory()});
$('#sort').addEventListener('change',e=>{S.sort=e.target.value;renderInventory()});
$('#grid').addEventListener('click',e=>{const c=e.target.closest('.card');if(c)openItem(c.dataset.id)});
['#aq','#atype','#afrom','#ato'].forEach(s=>$(s).addEventListener('input',renderActivity));
$('#addBtn').onclick=()=>openEdit(null);$('#emptyAdd').onclick=()=>openEdit(null);
setView(location.hash==='#activity'?'activity':'inventory');
refresh();connectLive();
})();
