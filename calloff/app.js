/* Call Off List. Everything lives on this phone and works with no signal.
   Every add, edit and delete also waits in a line here ("outbox") and goes to the master sheet
   as soon as there's service. The sheet keeps every change forever. */
(function(){
"use strict";
const KEY="calloff-v1";
const DEFAULT_LISTS={staff:["Trish","Aliki","Savannah","Stephanie","Fred","Lea","Kaylie"],shifts:["AM","MID","PM","AUDIT"],reasons:["Sick","Car trouble","Car accident","Family","Personal","No call/no show","Other"],notice:["Same day","1 day","2+ days","No notice"]};
// The call offs from the Excel list. They're already on the master sheet under these same IDs.
const SEEDS=[
 {id:"seed-1",date:"2026-11-21",name:"Lea",shift:"Night",reason:"Car accident",notice:"No notice",coveredBy:"",notes:"got in car accident on way to work",createdAt:"2026-11-21T05:00:01Z"},
 {id:"seed-2",date:"2026-11-22",name:"Lea",shift:"AM",reason:"Car trouble",notice:"1 day",coveredBy:"Afisa",notes:"car down",createdAt:"2026-11-22T05:00:01Z"},
 {id:"seed-3",date:"2026-11-23",name:"Lea",shift:"AM",reason:"Car trouble",notice:"1 day",coveredBy:"Afisa",notes:"bringing car to mechanic",createdAt:"2026-11-23T05:00:01Z"},
 {id:"seed-4",date:"2026-11-23",name:"Kaylie",shift:"",reason:"Sick",notice:"Same day",coveredBy:"",notes:"sick call off 6am for 730am shift",createdAt:"2026-11-23T05:00:02Z"}];
const SYNC_URL=((window.CO_CONFIG||{}).syncUrl||"").trim();

function loadStore(){
  try{const raw=localStorage.getItem(KEY);if(raw){const d=JSON.parse(raw);if(d&&Array.isArray(d.entries))return d}}catch(e){/* fall through to a fresh start */}
  return {entries:SEEDS.map(e=>({...e})),lists:structuredClone(DEFAULT_LISTS),me:"",outbox:[],lastSync:null,lastErr:""};
}
const store=loadStore();
store.lists=Object.assign(structuredClone(DEFAULT_LISTS),store.lists||{});
store.outbox=store.outbox||[];
function persist(){try{localStorage.setItem(KEY,JSON.stringify(store));return true}catch(e){toast("This phone's storage is full. Changes may not stay.");return false}}

const S={get entries(){return store.entries},get lists(){return store.lists},tab:"home",loaded:true,
  logPerson:"all",logReason:"all",logMonth:"all",cal:null,calSel:null,person:null,readOnly:false,syncing:false,installEvt:null};
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isStandalone=()=>{try{return window.matchMedia("(display-mode: standalone)").matches||navigator.standalone===true}catch(e){return false}};
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
function deviceName(){const u=navigator.userAgent;if(/iphone/i.test(u))return"iPhone";if(/ipad/i.test(u))return"iPad";if(/android/i.test(u))return"Android phone";if(/windows/i.test(u))return"Windows computer";if(/mac/i.test(u))return"Mac";return"Browser"}
function newId(p){return p+"-"+Date.now().toString(36).toUpperCase()+"-"+Math.random().toString(36).slice(2,7).toUpperCase()}
function fmtStamp(iso){if(!iso)return"never";const d=new Date(iso);return d.toLocaleDateString(undefined,{month:"short",day:"numeric"})+", "+d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}
const MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_L=["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function startOfMonth(d){return new Date(d.getFullYear(),d.getMonth(),1)}
function iso(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
function parse(s){const [y,m,d]=String(s).split("-").map(Number);return new Date(y,(m||1)-1,d||1)}
function ym(s){return String(s).slice(0,7)}
const todayIso=()=>iso(new Date());
function norm(v){return String(v??"").trim()}
function same(a,b){return norm(a).toLowerCase()===norm(b).toLowerCase()}
function reasonColor(r){const k=norm(r).toLowerCase();
  if(k.includes("no call"))return"var(--r-ncns)";if(k.includes("sick"))return"var(--r-sick)";if(k.includes("car"))return"var(--r-car)";
  if(k.includes("family"))return"var(--r-family)";if(k.includes("personal"))return"var(--r-personal)";return"var(--r-other)"}
const isNCNS=e=>norm(e.reason).toLowerCase().includes("no call");
function sorted(){return [...S.entries].sort((a,b)=>b.date.localeCompare(a.date)||String(b.createdAt||"").localeCompare(String(a.createdAt||"")))}
function forPerson(n){return S.entries.filter(e=>same(e.name,n))}
function thisMonth(list){const k=ym(todayIso());return list.filter(e=>ym(e.date)===k)}
function last90(list){const c=new Date();c.setDate(c.getDate()-90);const k=iso(c);return list.filter(e=>e.date>=k)}
function level(n){const m=thisMonth(forPerson(n)).length,ncns=forPerson(n).some(isNCNS);
  if(m>=3||ncns&&m>=1)return["high","High"];if(m>=2)return["watch","Watch"];return["ok","OK"]}
function allPeople(){const set=[...S.lists.staff];S.entries.forEach(e=>{if(e.name&&!set.some(n=>same(n,e.name)))set.push(norm(e.name))});return set}
function countBy(list,key){const m=new Map();list.forEach(e=>{const v=norm(e[key])||"—";const k=[...m.keys()].find(x=>same(x,v))||v;m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1])}
function fmtLong(s){const d=parse(s);return DOW[d.getDay()]+", "+MONTHS[d.getMonth()]+" "+d.getDate()+", "+d.getFullYear()}
function daysAgo(s){const ms=parse(todayIso())-parse(s);const n=Math.round(ms/864e5);return n===0?"today":n===1?"yesterday":n+" days ago"}

/* ---------- tabs ---------- */
const ICONS={home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',log:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',cal:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',people:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',set:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'};
const TABS=[["home","Home"],["log","Log"],["cal","Calendar"],["people","People"],["set","More"]];
function renderTabs(){$("#tabs").innerHTML=TABS.map(([k,l])=>`<button type="button" data-tab="${k}" ${S.tab===k?'aria-current="page"':""}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${l}</button>`).join("")}
function go(t){S.tab=t;if(t!=="people")S.person=null;try{history.replaceState(null,"","#"+t)}catch(e){}render();window.scrollTo(0,0)}

/* ---------- views ---------- */
function itemHTML(e){const d=parse(e.date);
  return `<button class="item" type="button" data-edit="${esc(e.id)}"><div class="date-chip"><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()]}</span></div>
  <div style="min-width:0"><div class="who">${esc(e.name)} ${e.shift?`<span class="muted" style="font-weight:500">· ${esc(e.shift)}</span>`:""}</div>
  <div class="meta">${esc(e.notice||"")}${e.coveredBy&&e.coveredBy!=="-"?` · covered by ${esc(e.coveredBy)}`:""}${e.notes?` · ${esc(e.notes)}`:""}</div></div>
  <span class="tag"><span class="dot" style="background:${reasonColor(e.reason)}"></span>${esc(e.reason||"—")}</span></button>`}
function emptyHTML(title,body){return `<div class="empty"><b>${esc(title)}</b>${esc(body)}</div>`}
function loadingNote(){return S.tab==="home"?installBanner():""}
function vHome(){
  const all=S.entries,m=thisMonth(all),d90=last90(all);
  const ncnsM=m.filter(isNCNS).length,noNotice=m.filter(e=>norm(e.notice).toLowerCase().includes("no notice")||norm(e.notice).toLowerCase()==="same day").length;
  const watch=allPeople().map(n=>[n,level(n)]).filter(x=>x[1][0]!=="ok");
  const recent=sorted().slice(0,6);
  const mk=MONTHS_L[new Date().getMonth()];
  return `<div class="view">${loadingNote()}
  <button class="log-btn" type="button" data-new><span class="plus">+</span>Log a call off</button>
  <div><div class="label" style="margin-bottom:8px">${mk}</div><div class="stats">
    <div class="stat"><b class="num">${m.length}</b><span>Call offs</span></div>
    <div class="stat"><b class="num">${new Set(m.map(e=>norm(e.name).toLowerCase())).size}</b><span>People</span></div>
    <div class="stat"><b class="num">${noNotice}</b><span>Short notice</span></div>
    <div class="stat"><b class="num">${ncnsM}</b><span>No call/no show</span></div></div></div>
  <section class="card"><div class="row between" style="margin-bottom:6px"><h2>Needs attention</h2><span class="label">This month</span></div>
    ${watch.length?`<div class="list">${watch.map(([n,l])=>{const c=thisMonth(forPerson(n)).length;return `<button class="item" type="button" data-person="${esc(n)}" style="grid-template-columns:1fr auto"><div><div class="who">${esc(n)}</div><div class="meta">${c} this month · ${forPerson(n).length} total</div></div><span class="flag ${l[0]}">${l[1]}</span></button>`}).join("")}</div>`
      :`<p class="muted" style="margin:0">Nobody has 2 or more call offs this month.</p>`}</section>
  <section class="card"><div class="row between" style="margin-bottom:4px"><h2>Recent</h2><button class="back" type="button" data-tab="log">See all</button></div>
    ${recent.length?`<div class="list">${recent.map(itemHTML).join("")}</div>`:emptyHTML(S.loaded?"No call offs yet":"Loading the list…",S.loaded?"Tap Log a call off to add the first one.":"")}</section>
  <section class="card"><div class="row between" style="margin-bottom:10px"><h2>Last 90 days by reason</h2><span class="muted num">${d90.length}</span></div>${barsHTML(countBy(d90,"reason"),true)}</section>
  </div>`}

function barsHTML(pairs,color){if(!pairs.length)return `<p class="muted" style="margin:0">Nothing logged yet.</p>`;const max=Math.max(...pairs.map(p=>p[1]));
  return `<div class="bars">${pairs.map(([k,v])=>`<div class="bar"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><div class="track"><div class="fill" style="width:${v/max*100}%;${color?`background:${reasonColor(k)}`:""}"></div></div><b class="num">${v}</b></div>`).join("")}</div>`}

function vLog(){
  const months=[...new Set(S.entries.map(e=>ym(e.date)))].sort().reverse();
  let list=sorted();
  if(S.logPerson!=="all")list=list.filter(e=>same(e.name,S.logPerson));
  if(S.logReason!=="all")list=list.filter(e=>same(e.reason,S.logReason));
  if(S.logMonth!=="all")list=list.filter(e=>ym(e.date)===S.logMonth);
  const groups=[];list.forEach(e=>{const k=ym(e.date);let g=groups.find(x=>x.k===k);if(!g)groups.push(g={k,items:[]});g.items.push(e)});
  const reasons=[...new Set([...S.lists.reasons,...S.entries.map(e=>norm(e.reason)).filter(Boolean)].map(r=>r))].filter((r,i,a)=>a.findIndex(x=>same(x,r))===i);
  return `<div class="view">${loadingNote()}
  <div class="filters">
    <select class="chip" id="fPerson" aria-label="Person"><option value="all">Everyone</option>${allPeople().map(n=>`<option ${same(S.logPerson,n)?"selected":""}>${esc(n)}</option>`).join("")}</select>
    <select class="chip" id="fReason" aria-label="Reason"><option value="all">All reasons</option>${reasons.map(r=>`<option ${same(S.logReason,r)?"selected":""}>${esc(r)}</option>`).join("")}</select>
    <select class="chip" id="fMonth" aria-label="Month"><option value="all">All months</option>${months.map(k=>{const d=parse(k+"-01");return `<option value="${k}" ${S.logMonth===k?"selected":""}>${MONTHS_L[d.getMonth()]} ${d.getFullYear()}</option>`}).join("")}</select>
  </div>
  <div class="muted num" style="font-size:13px">${list.length} call off${list.length===1?"":"s"} shown · tap one to edit</div>
  ${groups.length?groups.map(g=>{const d=parse(g.k+"-01");return `<section class="card"><div class="row between"><h2>${MONTHS_L[d.getMonth()]} ${d.getFullYear()}</h2><span class="muted num">${g.items.length}</span></div><div class="list">${g.items.map(itemHTML).join("")}</div></section>`}).join("")
   :`<div class="card">${emptyHTML(S.loaded?"Nothing matches":"Loading the list…",S.loaded?"Try another filter, or log a call off.":"")}</div>`}
  </div>`}

function vCal(){
  const m=S.cal,y=m.getFullYear(),mo=m.getMonth(),days=new Date(y,mo+1,0).getDate(),lead=m.getDay();
  const k=iso(m).slice(0,7),inMonth=S.entries.filter(e=>ym(e.date)===k);
  let cells=DOW.map(d=>`<div class="dow">${d[0]}</div>`).join("");
  for(let i=0;i<lead;i++)cells+=`<div class="day out" aria-hidden="true"></div>`;
  for(let d=1;d<=days;d++){const di=iso(new Date(y,mo,d)),es=inMonth.filter(e=>e.date===di);
    cells+=`<button type="button" class="day ${di===todayIso()?"today":""} ${S.calSel===di?"sel":""}" data-day="${di}" aria-label="${fmtLong(di)}, ${es.length} call offs"><span class="n">${d}</span>${es.slice(0,3).map(e=>`<span class="who" style="background:${reasonColor(e.reason)}">${esc(e.name)}</span>`).join("")}${es.length>3?`<span class="n">+${es.length-3}</span>`:""}</button>`}
  const sel=S.calSel&&ym(S.calSel)===k?inMonth.filter(e=>e.date===S.calSel):null;
  // year grid
  const people=allPeople(),yr=y;
  const grid=`<table class="grid"><thead><tr><th>Name</th>${MONTHS.map(x=>`<th>${x[0]}${x[1]}</th>`).join("")}<th>Yr</th></tr></thead><tbody>${people.map(n=>{const pe=forPerson(n).filter(e=>e.date.startsWith(yr+"-"));let tot=0;
    return `<tr><td>${esc(n)}</td>${MONTHS.map((_,i)=>{const c=pe.filter(e=>parse(e.date).getMonth()===i).length;tot+=c;return `<td class="num ${c>=2?"hot":""}">${c||""}</td>`}).join("")}<td class="num"><b>${tot||""}</b></td></tr>`}).join("")}</tbody></table>`;
  return `<div class="view">${loadingNote()}
  <div class="month-head"><button class="icon-btn" type="button" data-cal="-1" aria-label="Previous month">‹</button><h2>${MONTHS_L[mo]} ${y}</h2><button class="icon-btn" type="button" data-cal="1" aria-label="Next month">›</button></div>
  <div class="row muted" style="font-size:13px;gap:14px;flex-wrap:wrap"><span class="num">${inMonth.length} call off${inMonth.length===1?"":"s"}</span><button class="back" type="button" data-cal="0">Today</button></div>
  <div class="cal">${cells}</div>
  ${sel?`<section class="card"><h2>${fmtLong(S.calSel)}</h2>${sel.length?`<div class="list">${sel.map(itemHTML).join("")}</div>`:`<p class="muted" style="margin:8px 0 0">No call offs this day.</p>`}<div style="margin-top:10px"><button class="btn" type="button" data-new-date="${S.calSel}">+ Log for this day</button></div></section>`:""}
  <section class="card"><div class="row between" style="margin-bottom:8px"><h2>${yr} at a glance</h2><span class="label">red = 2+</span></div><div class="grid-wrap">${grid}</div></section>
  </div>`}

function spark(name){const now=new Date();let out="";for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1),k=iso(d).slice(0,7);const c=forPerson(name).filter(e=>ym(e.date)===k).length;out+=`<i class="${c?"on":""}" style="height:${Math.min(100,c*34+10)}%" title="${MONTHS[d.getMonth()]}: ${c}"></i>`}return `<div class="spark" aria-label="Last 6 months">${out}</div>`}

function vPeople(){
  if(S.person)return vPerson(S.person);
  const ppl=allPeople().map(n=>({n,all:forPerson(n),m:thisMonth(forPerson(n)),l:level(n)})).sort((a,b)=>b.m.length-a.m.length||b.all.length-a.all.length||a.n.localeCompare(b.n));
  return `<div class="view">${loadingNote()}<div class="muted" style="font-size:13px">Tap a name for the full breakdown. Bars show the last 6 months.</div>
  <div class="people">${ppl.map(p=>{const last=sorted().find(e=>same(e.name,p.n));return `<button class="person" type="button" data-person="${esc(p.n)}"><div class="row between"><span class="nm">${esc(p.n)}</span><span class="flag ${p.l[0]}">${p.l[1]}</span></div>
    <div class="line"><span>This month</span><b class="num">${p.m.length}</b></div><div class="line"><span>Total</span><b class="num">${p.all.length}</b></div>
    <div class="line"><span>Last</span><b>${last?MONTHS[parse(last.date).getMonth()]+" "+parse(last.date).getDate():"—"}</b></div>${spark(p.n)}</button>`}).join("")}</div></div>`}

function vPerson(n){
  const all=sorted().filter(e=>same(e.name,n)),m=thisMonth(all),d90=last90(all),l=level(n);
  const covered=S.entries.filter(e=>same(e.coveredBy,n)).length;
  const wk=[0,0,0,0,0,0,0];all.forEach(e=>wk[parse(e.date).getDay()]++);const wmax=Math.max(1,...wk);
  const ncns=all.filter(isNCNS).length;
  // longest gap / streaks: consecutive days
  let runs=0;for(let i=0;i<all.length-1;i++){if((parse(all[i].date)-parse(all[i+1].date))/864e5===1)runs++}
  const yr=new Date().getFullYear();
  return `<div class="view">
  <button class="back" type="button" data-back>‹ All people</button>
  <div class="hero-p"><div><h2>${esc(n)}</h2><div class="muted">${all.length?`Last call off ${daysAgo(all[0].date)}`:"No call offs logged"}</div></div><span class="flag ${l[0]}">${l[1]}</span></div>
  <div class="stats"><div class="stat"><b class="num">${m.length}</b><span>This month</span></div><div class="stat"><b class="num">${d90.length}</b><span>Last 90 days</span></div>
    <div class="stat"><b class="num">${all.filter(e=>e.date.startsWith(yr+"-")).length}</b><span>${yr}</span></div><div class="stat"><b class="num">${all.length}</b><span>All time</span></div></div>
  <div class="stats"><div class="stat"><b class="num">${ncns}</b><span>No call/no show</span></div><div class="stat"><b class="num">${runs}</b><span>Back-to-back days</span></div>
    <div class="stat"><b class="num">${all.filter(e=>{const v=norm(e.notice).toLowerCase();return v.includes("no notice")||v==="same day"}).length}</b><span>Short notice</span></div><div class="stat"><b class="num">${covered}</b><span>Covered for others</span></div></div>
  <div class="two"><section class="card"><h2 style="margin-bottom:10px">By reason</h2>${barsHTML(countBy(all,"reason"),true)}</section>
    <section class="card"><h2 style="margin-bottom:10px">By notice</h2>${barsHTML(countBy(all,"notice"))}</section>
    <section class="card"><h2 style="margin-bottom:10px">By shift</h2>${barsHTML(countBy(all,"shift"))}</section>
    <section class="card"><h2 style="margin-bottom:10px">Who covered</h2>${barsHTML(countBy(all.filter(e=>norm(e.coveredBy)&&norm(e.coveredBy)!=="-"),"coveredBy"))}</section></div>
  <section class="card"><h2 style="margin-bottom:10px">Day of the week</h2><div class="week">${wk.map((c,i)=>`<div class="col"><div class="colbar"><i style="height:${c/wmax*100}%"></i></div><b class="num" style="color:var(--ink)">${c}</b>${DOW[i]}</div>`).join("")}</div></section>
  <section class="card"><div class="row between"><h2>Every call off</h2><button class="btn" type="button" data-new-person="${esc(n)}">+ Log</button></div>${all.length?`<div class="list">${all.map(itemHTML).join("")}</div>`:emptyHTML("Nothing yet","")}</section>
  </div>`}

function vSet(){
  const sec=(key,title,help)=>`<section class="card"><h2>${title}</h2><p class="muted" style="margin:4px 0 10px;font-size:13px">${help}</p>
    <div class="edit-list">${S.lists[key].map((v,i)=>`<span class="tag">${esc(v)}<button type="button" data-rm="${key}:${i}" aria-label="Remove ${esc(v)}" ${S.readOnly?"disabled":""}>×</button></span>`).join("")}</div>
    <form class="add-row" data-add="${key}"><input class="input" id="add-${key}" placeholder="Add…" ${S.readOnly?"disabled":""}><button class="btn" type="submit" ${S.readOnly?"disabled":""}>Add</button></form></section>`;
  return `<div class="view">${backupCard()}
  ${sec("staff","Staff","Who can be picked when logging. Removing a name keeps their past call offs.")}
  ${sec("shifts","Shifts","Shift choices on the log form.")}
  ${sec("reasons","Reasons","No call/no show and anything with “sick” or “car” get their own colors.")}
  ${sec("notice","Notice given","How much warning they gave.")}
  <section class="card"><h2>How flags work</h2><p class="muted" style="margin:6px 0 0;font-size:13px"><b>Watch</b> means 2 call offs this month. <b>High</b> means 3 or more this month, or any no call/no show with a call off this month.</p></section>
  </div>`}

/* ---------- sheet (log / edit) ---------- */
let form=null;
function openSheet(entry,preset){
  form=entry?{...entry}:{id:null,date:(preset&&preset.date)||todayIso(),name:(preset&&preset.name)||"",shift:"",reason:"",notice:"",coveredBy:"",notes:""};
  form.armed=false;drawSheet();}
function choiceGroup(key,opts){return `<div class="choices">${opts.map(o=>`<button type="button" class="choice" data-pick="${key}" data-val="${esc(o)}" aria-pressed="${same(form[key],o)}">${esc(o)}</button>`).join("")}</div>`}
function drawSheet(){
  const staff=allPeople(),cover=[...new Set([...staff,...S.entries.map(e=>norm(e.coveredBy)).filter(v=>v&&v!=="-")])];
  $("#sheetHost").innerHTML=`<div class="scrim" data-close><div class="sheet" role="dialog" aria-modal="true" aria-label="${form.id?"Edit call off":"Log a call off"}">
   <div class="grab"></div><div class="row between"><h2 style="font-size:19px">${form.id?"Edit call off":"Log a call off"}</h2><button class="icon-btn" type="button" data-x aria-label="Close">×</button></div>
   <div class="field"><span class="label">Who</span>${choiceGroup("name",staff)}</div>
   <div class="field"><label class="label" for="fDate">Date</label><input class="input" type="date" id="fDate" value="${esc(form.date)}"></div>
   <div class="field"><span class="label">Shift</span>${choiceGroup("shift",S.lists.shifts)}</div>
   <div class="field"><span class="label">Reason</span>${choiceGroup("reason",S.lists.reasons)}</div>
   <div class="field"><span class="label">Notice given</span>${choiceGroup("notice",S.lists.notice)}</div>
   <div class="field"><label class="label" for="fCover">Covered by</label><input class="input" id="fCover" list="coverList" value="${esc(form.coveredBy==="-"?"":form.coveredBy)}" placeholder="Name, or leave blank if nobody"><datalist id="coverList">${cover.map(c=>`<option value="${esc(c)}">`).join("")}</datalist></div>
   <div class="field"><label class="label" for="fNotes">Notes</label><textarea class="input" id="fNotes" placeholder="e.g. called at 6am for 7:30 shift">${esc(form.notes)}</textarea></div>
   <div id="formErr"></div>
   <div class="sheet-actions">${form.id?`<button class="btn danger ${form.armed?"armed":""}" type="button" data-del>${form.armed?"Tap again to delete":"Delete"}</button>`:""}
     <div class="right"><button class="btn" type="button" data-x>Cancel</button><button class="btn primary" type="button" data-save ${S.readOnly?"disabled":""}>${form.id?"Save changes":"Save"}</button></div></div>
  </div></div>`}
function closeSheet(){$("#sheetHost").innerHTML="";form=null}
function readForm(){form.date=$("#fDate").value;form.coveredBy=norm($("#fCover").value);form.notes=norm($("#fNotes").value)}
/* ---------- install + backup ---------- */
function installBanner(){
  if(isStandalone())return"";
  if(isIOS())return `<div class="banner"><img src="icons/icon-192.png" alt="" width="40" height="40" style="border-radius:10px;flex:none"><div><b>Put it on your Home Screen first</b>Tap the Share button <span aria-hidden="true">(square with the arrow)</span>, then <b style="display:inline">Add to Home Screen</b>. Open it from there from now on, so all your call offs stay together.</div></div>`;
  if(S.installEvt)return `<div class="banner"><img src="icons/icon-192.png" alt="" width="40" height="40" style="border-radius:10px;flex:none"><div style="flex:1"><b>Install the app</b>Puts Call Offs on your home screen. Works with no signal.</div><button class="btn primary" type="button" data-install>Install</button></div>`;
  return `<div class="banner"><img src="icons/icon-192.png" alt="" width="40" height="40" style="border-radius:10px;flex:none"><div><b>Add it to your home screen</b>Tap the browser menu (⋮), then <b style="display:inline">Add to Home screen</b> or <b style="display:inline">Install app</b>.</div></div>`;
}
function syncState(){
  if(!SYNC_URL)return["wait",store.outbox.length?store.outbox.length+" waiting":"Backup off"];
  if(store.outbox.length)return[store.lastErr&&navigator.onLine?"err":"wait",store.outbox.length+" waiting"];
  if(store.lastErr)return["err","Backup failed"];
  return["ok","Backed up"];
}
function backupCard(){
  const [cls,label]=syncState();
  const why=!SYNC_URL?"The master sheet link isn't set up yet. Everything is saved on this phone and will go to the sheet once it is."
    :store.outbox.length&&!navigator.onLine?"No signal. Changes are saved on this phone and go to the master sheet when there's service."
    :store.lastErr?"The last try didn't go through. It tries again by itself every minute.":"Every change is on the master sheet.";
  return `<section class="card"><div class="row between" style="margin-bottom:8px"><h2>Master sheet backup</h2><span class="sync ${cls}"><i></i><span>${esc(label)}</span></span></div>
  <p class="muted" style="margin:0 0 10px;font-size:13px">${esc(why)}</p>
  <dl class="kv"><dt>Last backup</dt><dd>${esc(fmtStamp(store.lastSync))}</dd><dt>Waiting to send</dt><dd class="num">${store.outbox.length}</dd><dt>Using this phone</dt><dd>${esc(store.me||"—")}</dd></dl>
  <div class="row" style="margin-top:12px;flex-wrap:wrap"><button class="btn primary" type="button" data-sync ${SYNC_URL?"":"disabled"}>Back up now</button><button class="btn" type="button" data-rename>Change name</button></div>
  <details style="margin-top:12px"><summary class="muted" style="font-size:13px;cursor:pointer">Restore from the master sheet</summary>
    <p class="muted" style="font-size:13px;margin:8px 0">For a new phone. Replaces what's on this phone with the master sheet's list. Needs the restore code.</p>
    <form class="add-row" data-restore><input class="input" id="restoreCode" inputmode="numeric" autocomplete="off" placeholder="Restore code"><button class="btn" type="submit" ${SYNC_URL?"":"disabled"}>Restore</button></form>
    <div id="restoreMsg"></div></details></section>`;
}
function paintSync(){const [cls,label]=syncState();const p=$("#syncPill");p.className="sync "+cls;p.querySelector("span").textContent=label}

function render(){renderTabs();
  const n=S.entries.length;$("#sub").textContent=`${n} call off${n===1?"":"s"} logged`;
  paintSync();
  $("#main").innerHTML={home:vHome,log:vLog,cal:vCal,people:vPeople,set:vSet}[S.tab]()}

/* ---------- changes ---------- */
function queue(op){op.opId=newId("C");op.at=new Date().toISOString();op.by=store.me||"Unknown";op.device=deviceName();store.outbox.push(op)}
function save(){readForm();
  if(!form.name){$("#formErr").innerHTML=`<div class="note">Pick who called off.</div>`;return}
  if(!form.date){$("#formErr").innerHTML=`<div class="note">Pick a date.</div>`;return}
  const e={id:form.id||newId("E"),date:form.date,name:form.name,shift:form.shift||"",reason:form.reason||"",notice:form.notice||"",coveredBy:form.coveredBy||"",notes:form.notes||"",createdAt:form.createdAt||new Date().toISOString()};
  const wasNew=!form.id;
  if(wasNew){store.entries.push(e);queue({t:"add",entry:e})}
  else{const i=store.entries.findIndex(x=>x.id===e.id);const before=store.entries[i];
    const changed=["date","name","shift","reason","notice","coveredBy","notes"].some(k=>norm(before&&before[k])!==norm(e[k]));
    if(i>=0)store.entries[i]=e;else store.entries.push(e);
    if(changed)queue({t:"edit",entry:e})}
  persist();closeSheet();render();toast(wasNew?"Call off saved":"Changes saved");sync()}
function del(){if(!form.armed){readForm();form.armed=true;drawSheet();return}
  const i=store.entries.findIndex(x=>x.id===form.id);
  if(i>=0){const e=store.entries[i];store.entries.splice(i,1);queue({t:"delete",entry:e})}
  persist();closeSheet();render();toast("Call off deleted. The master sheet keeps a copy.");sync()}
let tt;function toast(m){$("#toastHost").innerHTML=`<div class="toast" role="status">${esc(m)}</div>`;clearTimeout(tt);tt=setTimeout(()=>$("#toastHost").innerHTML="",2600)}
function saveLists(changed){queue({t:"lists",lists:structuredClone(store.lists),changed});persist();toast("List updated");sync()}

/* ---------- the trip to the master sheet ---------- */
async function sync(){
  if(!SYNC_URL||S.syncing||!store.outbox.length)return;
  if(!navigator.onLine){paintSync();return}
  S.syncing=true;
  try{
    while(store.outbox.length){
      const batch=store.outbox.slice(0,40);
      const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),30000);
      let res;
      try{res=await fetch(SYNC_URL,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({ops:batch}),signal:ctl.signal})}finally{clearTimeout(to)}
      const out=await res.json();
      if(!out||!out.ok)throw new Error((out&&out.error)||"The sheet said no");
      const done=new Set(out.done||[]);
      store.outbox=store.outbox.filter(o=>!done.has(o.opId));
      store.lastSync=new Date().toISOString();store.lastErr="";persist();
      if(!done.size)break;
    }
  }catch(e){store.lastErr=String(e&&e.message||e);persist()}
  finally{S.syncing=false;paintSync();if(S.tab==="set"&&!form)render()}
}
async function restore(code){
  const msg=t=>{const m=$("#restoreMsg");if(m)m.innerHTML=`<div class="note" style="margin-top:8px">${esc(t)}</div>`};
  if(!code){msg("Type the restore code.");return}
  if(store.outbox.length){await sync();if(store.outbox.length){msg("This phone has changes the sheet doesn't have yet. Get signal and tap Back up now first, so nothing is lost.");return}}
  try{
    const r=await fetch(SYNC_URL+"?action=restore&code="+encodeURIComponent(code));const out=await r.json();
    if(!out.ok){msg(out.error==="code"?"That restore code isn't right.":"The sheet couldn't send the list. Try again.");return}
    store.entries=(out.entries||[]).map(e=>({...e,createdAt:e.createdAt||""}));
    const L=out.lists||{};["staff","shifts","reasons","notice"].forEach(k=>{if(Array.isArray(L[k])&&L[k].length)store.lists[k]=L[k]});
    persist();render();toast(`Restored ${store.entries.length} call offs from the master sheet`);
  }catch(e){msg("Couldn't reach the master sheet. Check your signal and try again.")}
}

/* ---------- who's using it ---------- */
function askName(){
  const sugg=["Alyssa",...S.lists.staff].filter((v,i,a)=>a.findIndex(x=>same(x,v))===i);
  $("#welcomeHost").innerHTML=`<div class="welcome"><div class="card"><img src="icons/icon-192.png" alt=""><h2 style="font-size:20px">Who's using this app?</h2>
  <p class="muted" style="margin:0;font-size:14px">Your name goes next to every change on the master sheet, so there's a record of who logged what.</p>
  <div class="choices">${sugg.map(n=>`<button type="button" class="choice" data-me="${esc(n)}" aria-pressed="${same(store.me,n)}">${esc(n)}</button>`).join("")}</div>
  <form class="add-row" data-me-form><input class="input" id="meInput" placeholder="Or type your name" value="${esc(store.me)}" autocomplete="name"><button class="btn primary" type="submit">Done</button></form></div></div>`}
function setMe(n){n=norm(n);if(!n)return;store.me=n;persist();$("#welcomeHost").innerHTML="";render()}

/* ---------- events ---------- */
document.addEventListener("click",e=>{
  const t=e.target.closest("button,[data-close]");if(!t)return;
  if(t.matches("[data-close]")&&e.target!==t)return;
  if(t.matches("[data-close]")||t.dataset.x!==undefined){closeSheet();return}
  if(t.dataset.me){setMe(t.dataset.me);return}
  if(t.dataset.tab){go(t.dataset.tab);return}
  if(t.dataset.new!==undefined){openSheet(null);return}
  if(t.dataset.newDate){openSheet(null,{date:t.dataset.newDate});return}
  if(t.dataset.newPerson){openSheet(null,{name:t.dataset.newPerson});return}
  if(t.dataset.edit){const en=S.entries.find(x=>x.id===t.dataset.edit);if(en)openSheet(en);return}
  if(t.dataset.person){S.tab="people";S.person=t.dataset.person;render();window.scrollTo(0,0);return}
  if(t.dataset.back!==undefined){S.person=null;render();return}
  if(t.dataset.cal!==undefined){const v=+t.dataset.cal;S.cal=v===0?startOfMonth(new Date()):new Date(S.cal.getFullYear(),S.cal.getMonth()+v,1);if(v===0)S.calSel=todayIso();render();return}
  if(t.dataset.day){S.calSel=S.calSel===t.dataset.day?null:t.dataset.day;render();return}
  if(t.dataset.pick){readForm();const k=t.dataset.pick;form[k]=same(form[k],t.dataset.val)?"":t.dataset.val;form.armed=false;drawSheet();return}
  if(t.dataset.save!==undefined){save();return}
  if(t.dataset.del!==undefined){del();return}
  if(t.dataset.rm){const [k,i]=t.dataset.rm.split(":");const gone=S.lists[k].splice(+i,1)[0];render();saveLists(`${({staff:"Staff",shifts:"Shifts",reasons:"Reasons",notice:"Notice"})[k]}: removed ${gone}`);return}
  if(t.dataset.sync!==undefined){store.lastErr="";sync().then(()=>toast(store.outbox.length?"Still waiting. Check your signal.":"Backed up to the master sheet"));return}
  if(t.dataset.rename!==undefined){askName();return}
  if(t.dataset.install!==undefined&&S.installEvt){S.installEvt.prompt();S.installEvt.userChoice.finally(()=>{S.installEvt=null;render()});return}
});
document.addEventListener("change",e=>{
  if(e.target.id==="fPerson"){S.logPerson=e.target.value;render()}
  if(e.target.id==="fReason"){S.logReason=e.target.value;render()}
  if(e.target.id==="fMonth"){S.logMonth=e.target.value;render()}
});
document.addEventListener("submit",e=>{
  if(e.target.closest("[data-me-form]")){e.preventDefault();setMe($("#meInput").value);return}
  if(e.target.closest("[data-restore]")){e.preventDefault();restore(norm($("#restoreCode").value));return}
  const f=e.target.closest("[data-add]");if(!f)return;e.preventDefault();const k=f.dataset.add,inp=f.querySelector("input"),v=norm(inp.value);
  if(!v||S.lists[k].some(x=>same(x,v)))return;S.lists[k].push(v);render();saveLists(`${({staff:"Staff",shifts:"Shifts",reasons:"Reasons",notice:"Notice"})[k]}: added ${v}`)});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&form)closeSheet()});
window.addEventListener("hashchange",()=>{const h=location.hash.slice(1);if(TABS.some(t=>t[0]===h)&&h!==S.tab){S.tab=h;S.person=null;render()}});
window.addEventListener("online",()=>{paintSync();sync()});
window.addEventListener("offline",paintSync);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")sync()});
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();S.installEvt=e;if(S.tab==="home"&&!form)render()});
window.addEventListener("storage",e=>{if(e.key===KEY)location.reload()});

/* ---------- start ---------- */
S.cal=startOfMonth(new Date());
(function(){const h=location.hash.slice(1);if(TABS.some(t=>t[0]===h))S.tab=h})();
render();
if(!store.me)askName();
try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist()}catch(e){/* optional */}
if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js").catch(()=>{/* still works online */})}
sync();
setInterval(()=>{if(document.visibilityState==="visible")sync()},60000);
})();
