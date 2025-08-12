// Auto Insights Dashboard – ensures at least 4 charts show, hides blank cards,
// fixes Plotly detection & small-multiples bug, and keeps alignment tight.

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

const fileInput = $("fileInput");
const dropArea = $("dropArea");
const summarySection = $("summary");
const insightsSection = $("insights");
const rawSection = $("raw");
const summaryCards = $("summaryCards");
const datasetPreview = $("datasetPreview");
const narrativesDiv = $("narratives");
const exportPdfBtn = $("exportPdfBtn");
const dataTable = $("dataTable");
const metricsSection = $("metrics");
const metricsCards = $("metricsCards");
const resetBtn = $("resetBtn");
const brushBtn = $("brushBtn");
const clearFilterBtn = $("clearFilterBtn");

const annotWrapper = $("annotWrapper");
const annotCanvas = $("annotCanvas");
const annotDock = $("annotDock");
const annotToggle = $("annotToggle");
const annotPanel = $("annotPanel");
const markerBtn = $("markerBtn");
const eraserBtn = $("eraserBtn");
const paletteToggle = $("paletteToggle");
const palettePop = $("palettePop");
const widthRange = $("widthRange");
const widthVal = $("widthVal");
const clearAnnotsBtn = $("clearAnnots");
const swatches = () => Array.from(document.querySelectorAll(".swatch"));

let globalData = { headers: [], rows: [] };
let chartInstances = [];
let activeDateCol = null;
let globalDateFilter = null;
let brushLinkEnabled = false;

const toNumber = v => (v===null || v===undefined || v==="" ? null : (Number.isFinite(+v) ? +v : null));
const round = (n, p=2) => Math.round((n + Number.EPSILON) * 10 ** p) / 10 ** p;
const isDateString = s => { if(!s && s!==0) return false; const d=new Date(s); return !isNaN(d.valueOf()); };
const arrayMean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const arrayStd  = a => { if(!a.length) return 0; const m=arrayMean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/a.length); };
const ymKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

if (window?.chartjs_plugin_zoom) Chart.register(window.chartjs_plugin_zoom);
else if (window['chartjs-plugin-zoom']) Chart.register(window['chartjs-plugin-zoom']);

/* ---------- helpers to show/hide/measure cards ---------- */
function cardOf(idOrEl){ const el = typeof idOrEl==='string' ? $(idOrEl) : idOrEl; return el ? el.closest('.chart-card') : null; }
function showCard(idOrEl){ const c=cardOf(idOrEl); if(c) c.classList.add('show'); }
function hideCard(idOrEl){ const c=cardOf(idOrEl); if(!c) return; c.querySelectorAll('.chart-explainer').forEach(n=>n.remove()); c.classList.remove('show'); }
function prepareCanvas(id){ const el=$(id); if(!el) return null; el.style.display="block"; showCard(el); return el; }
function preparePlotContainer(id){ const el=$(id); if(!el) return null; showCard(el); return el; }
function countShown(){ return [...document.querySelectorAll('.chart-card.show')].length; }

// robust detection => only show non-empty cards
function cleanupEmptyCards(){
  document.querySelectorAll('.chart-card').forEach(card => {
    const canvases=[...card.querySelectorAll('canvas')];
    const hasChart = canvases.some(cv => cv._chart && cv._chart.data && cv._chart.data.datasets && cv._chart.data.datasets.length>0);
    const hasPlotly = !!card.querySelector('.js-plotly-plot');
    const hasBullets = card.querySelector('#bulletsWrap')?.children.length>0;
    const hasSM = card.querySelector('#smallMultiples')?.children.length>0;
    const show = hasChart || hasPlotly || hasBullets || hasSM;
    card.classList.toggle('show', show);
  });
  document.querySelectorAll('.charts-grid').forEach(grid=>{
    const anyShown=[...grid.children].some(c=>c.classList.contains('show')); grid.style.display=anyShown?'grid':'none';
  });
}
function addExplainer(canvasId, text){
  const container=$(canvasId)?.parentElement; if(!container) return;
  const el=document.createElement('div'); el.className='chart-explainer'; el.textContent=text; container.appendChild(el);
}

/* ---------------- progress bar for upload --------------- */
let progressRoot=null, progressBar=null, progressLabel=null, progressRight=null;
function ensureProgressUI(){
  if (progressRoot) return;
  const wrap=document.createElement('div');
  wrap.className='progress-wrap';
  wrap.innerHTML=`<div class="progress"><div class="bar" style="width:0%"></div></div>
                  <div class="progress-meta"><span id="progressLabel">Waiting for file…</span><span id="progressRight"></span></div>`;
  $("uploader").appendChild(wrap);
  progressRoot=wrap;
  progressBar=wrap.querySelector('.bar');
  progressLabel=wrap.querySelector('#progressLabel');
  progressRight=wrap.querySelector('#progressRight');
}
function setProgress(pct,left="",right=""){ ensureProgressUI(); progressBar.style.width=`${Math.min(100,Math.max(0,pct))}%`; if(left)progressLabel.textContent=left; if(right)progressRight.textContent=right; }
function resetProgress(){ if(!progressBar)return; progressBar.style.width='0%'; progressLabel.textContent='Waiting for file…'; progressRight.textContent=''; }

/* ---------------- file input / dragdrop ----------------- */
dropArea.addEventListener("click", () => fileInput.click());
dropArea.addEventListener("dragover", e=>{ e.preventDefault(); dropArea.style.opacity=.85; });
dropArea.addEventListener("dragleave", ()=> dropArea.style.opacity=1);
dropArea.addEventListener("drop", e=>{ e.preventDefault(); dropArea.style.opacity=1; const f=e.dataTransfer.files[0]; if(f) handleFile(f); });
fileInput.addEventListener("change", e=>{ const f=e.target.files[0]; if(f) handleFile(f); });

function handleFile(file){
  if (file.size>MAX_FILE_BYTES){ alert(`File too large. Max ${(MAX_FILE_BYTES/1048576).toFixed(0)} MB.`); return; }
  resetProgress();
  const name=file.name.toLowerCase();
  if (name.endsWith('.csv')) readCSVWithProgress(file);
  else if (name.endsWith('.xlsx') || name.endsWith('.xls')) readXLSXWithProgress(file);
  else alert('Unsupported file type. Upload CSV or XLSX.');
}
function readCSVWithProgress(file){
  ensureProgressUI();
  const reader=new FileReader();
  reader.onprogress=e=>{ if(e.lengthComputable){ const pct=e.loaded/file.size*100; setProgress(pct,'Reading CSV…',`${Math.round(pct)}%`);} };
  reader.onloadstart=()=> setProgress(0,'Reading CSV…','0%');
  reader.onload=e=>{
    setProgress(100,'Parsing CSV (worker)…','');
    Papa.parse(e.target.result,{ header:true, skipEmptyLines:true, worker:true,
      complete: res=>{ setProgress(100,'CSV ready ✔',`${res.data.length.toLocaleString()} rows`); processParsed(res.data); setTimeout(resetProgress,1200); },
      error: err=>{ alert('CSV parse error: '+err.message); resetProgress(); }
    });
  };
  reader.onerror=()=>{ alert('Failed to read CSV file.'); resetProgress(); };
  reader.readAsText(file);
}
function readXLSXWithProgress(file){
  ensureProgressUI();
  const reader=new FileReader();
  reader.onprogress=e=>{ if(e.lengthComputable){ const pct=e.loaded/file.size*100; setProgress(pct,'Reading XLSX…',`${Math.round(pct)}%`);} };
  reader.onloadstart=()=> setProgress(0,'Reading XLSX…','0%');
  reader.onload=e=>{
    setProgress(100,'Parsing XLSX…','');
    try{
      const data=new Uint8Array(e.target.result);
      const wb=XLSX.read(data,{type:'array'});
      const sheet=wb.Sheets[wb.SheetNames[0]];
      const json=XLSX.utils.sheet_to_json(sheet,{defval:''});
      setProgress(100,'XLSX ready ✔',`${json.length.toLocaleString()} rows`);
      processParsed(json); setTimeout(resetProgress,1200);
    }catch(err){ alert('XLSX parse error: '+err.message); resetProgress(); }
  };
  reader.onerror=()=>{ alert('Failed to read XLSX file.'); resetProgress(); };
  reader.readAsArrayBuffer(file);
}

function processParsed(arr){
  if (!arr || arr.length===0){ alert('No rows found in file.'); return; }
  const headers=Object.keys(arr[0]);
  const rows=arr.map(r=>{ const o={}; headers.forEach(h=>o[h]=r[h]??""); return o; });
  globalData={ headers, rows };
  buildSummary(globalData);
  exportPdfBtn.disabled=false;
}

/* ---------------- summary / metrics -------------------- */
function buildSummary({ headers, rows }){
  datasetPreview.textContent=JSON.stringify(rows.slice(0,10), null, 2);
  const colInfo=buildColInfo(globalData);

  summaryCards.innerHTML="";
  addSummaryCard("Rows", rows.length);
  addSummaryCard("Columns", headers.length);
  addSummaryCard("Numeric cols", colInfo.filter(c=>c.type==="numeric").length);
  addSummaryCard("Date cols", colInfo.filter(c=>c.type==="date").length);
  addSummaryCard("Categorical cols", colInfo.filter(c=>c.type==="categorical").length);
  summarySection.classList.remove("hidden");

  renderTable(headers, rows);
  rawSection.classList.remove("hidden");

  const { stats, extras, timeExtras, dateColName } = generateInsights(colInfo, rows);
  activeDateCol = dateColName || null;
  brushBtn.disabled = !activeDateCol;
  renderMetrics(stats, rows, colInfo, extras, timeExtras);
  metricsSection.classList.remove("hidden");
}
function buildColInfo({ headers, rows }){
  return headers.map(h=>{
    const vals=rows.map(r=>r[h]);
    const numCount=vals.filter(v=>v!=="" && Number.isFinite(Number(v))).length;
    const dateCount=vals.filter(isDateString).length;
    const type = numCount/rows.length>0.6 ? "numeric" : (dateCount/rows.length>0.6 ? "date" : "categorical");
    return { name:h, type, vals };
  });
}
function addSummaryCard(title, value){
  const div=document.createElement('div');
  div.className='card-small';
  div.innerHTML=`<strong style="color:var(--accent)">${value}</strong><div style="font-size:12px;color:var(--muted)">${title}</div>`;
  summaryCards.appendChild(div);
}
function renderTable(headers, rows){
  dataTable.innerHTML="";
  const thead=document.createElement('thead'), thr=document.createElement('tr');
  headers.forEach(h=>{ const th=document.createElement('th'); th.textContent=h; thr.appendChild(th); });
  thead.appendChild(thr); dataTable.appendChild(thead);
  const tbody=document.createElement('tbody');
  rows.slice(0,200).forEach(r=>{
    const tr=document.createElement('tr');
    headers.forEach(h=>{ const td=document.createElement('td'); td.textContent=r[h]; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  dataTable.appendChild(tbody);
}
function renderMetrics(stats, rows, colInfo, extras, timeExtras){
  const totalCells=colInfo.length*rows.length;
  const missingCells=colInfo.reduce((a,c)=> a+(stats[c.name]?.missing||0), 0);
  const completeness= totalCells ? (1-missingCells/totalCells)*100 : 100;
  const outlierCols=Object.keys(stats).filter(k=>stats[k].type==="numeric" && stats[k].outliers>0).length;
  const skewedCols=Object.keys(stats).filter(k=>stats[k].type==="numeric" && Math.abs(stats[k].skew)>=0.8).length;

  const cards=[
    { label:"Completeness", value:`${round(completeness,1)}%`, cls: completeness>=95?"ok":(completeness>=85?"warn":"bad") },
    { label:"Rows", value: rows.length.toLocaleString(), cls:"ok" },
    { label:"Columns", value: colInfo.length, cls:"ok" },
    { label:"Duplicates", value: extras.duplicates.toLocaleString(), cls: extras.duplicates?"warn":"ok" },
    { label:"Outlier Columns", value: outlierCols, cls: outlierCols?"warn":"ok" },
    { label:"Skewed Columns", value: skewedCols, cls: skewedCols?"warn":"ok" },
  ];
  if (timeExtras?.momPct !== undefined) cards.push({ label:"MoM Δ", value:`${(timeExtras.momPct>=0?"+":"")}${round(timeExtras.momPct,1)}%`, cls: timeExtras.momPct>=0?"ok":"bad" });
  if (timeExtras?.yoyPct !== undefined) cards.push({ label:"YoY Δ", value:`${(timeExtras.yoyPct>=0?"+":"")}${round(timeExtras.yoyPct,1)}%`, cls: timeExtras.yoyPct>=0?"ok":"bad" });
  if (timeExtras?.range) cards.push({ label:"Date Range", value: timeExtras.range, cls:"ok" });

  metricsCards.innerHTML="";
  cards.forEach(c=>{
    const el=document.createElement('div');
    el.className=`metric ${c.cls}`;
    el.innerHTML=`<div class="label">${c.label}</div><div class="value">${c.value}</div>`;
    metricsCards.appendChild(el);
  });
}

/* ---------------- insights + charts ------------------- */
function quantile(arr,q){ if(!arr.length) return null; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const base=Math.floor(pos), rest=pos-base; return a[base] + (a[base+1]-a[base] || 0)*rest; }
const rollingMean = (arr,w)=>{ if(!arr.length||w<=1) return arr.slice(); const out=[]; let sum=0; for(let i=0;i<arr.length;i++){ sum+=arr[i]; if(i>=w) sum-=arr[i-w]; out.push(i>=w-1? sum/Math.min(i+1,w):null);} return out; };
const linreg=(xs,ys)=>{ const n=xs.length; if(n<2) return {slope:0,intercept:arrayMean(ys)}; const mx=arrayMean(xs), my=arrayMean(ys); let num=0,den=0; for(let i=0;i<n;i++){ num+=(xs[i]-mx)*(ys[i]-my); den+=(xs[i]-mx)**2; } const slope=den===0?0:num/den; return {slope, intercept: my - slope*mx }; };

function generateInsights(colInfo, rows){
  insightsSection.classList.remove("hidden");
  narrativesDiv.innerHTML="";
  const stats={};

  colInfo.forEach(c=>{
    if (c.type==="numeric"){
      const nums=c.vals.map(toNumber).filter(v=>v!==null);
      const count=nums.length, mean=arrayMean(nums);
      const sorted=nums.slice().sort((a,b)=>a-b);
      const median=count?(count%2?sorted[(count-1)/2]:(sorted[count/2-1]+sorted[count/2])/2):0;
      const min=count?sorted[0]:null, max=count?sorted[sorted.length-1]:null;
      const p10=quantile(nums,0.10), p90=quantile(nums,0.90), p95=quantile(nums,0.95);
      const missing=c.vals.filter(v=>v===""||v===null).length;
      const stdDev=arrayStd(nums);
      const outliers=nums.filter(v => Math.abs(v-mean) > 3*stdDev).length;
      const skew=stdDev?3*(mean-median)/stdDev:0;
      const cv = (mean!==0) ? stdDev/Math.abs(mean) : 0;
      stats[c.name]={ type:"numeric", count, mean, median, min, max, p10, p90, p95, missing, stdDev, outliers, skew, cv, nums };
    }else{
      const freq={}; c.vals.forEach(v=>{ const k=(v===null||v==="")?"__MISSING__":String(v); freq[k]=(freq[k]||0)+1; });
      const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
      stats[c.name]={ type:c.type, distinct:entries.length, top:entries[0]||["",0], missing:freq["__MISSING__"]||0, freqEntries: entries.slice(0,30) };
    }
  });

  const narratives=[];
  const totalCells=colInfo.length*rows.length;
  const missingCells=colInfo.reduce((a,c)=>a+(stats[c.name]?.missing||0),0);
  const completeness= totalCells ? (1-missingCells/totalCells)*100 : 100;
  narratives.push({ type:"quality", icon:"🧪", text:`Data completeness: ${round(completeness,1)}%`, badge:`${round(completeness,1)}%` });

  const constantCols = colInfo.map(c=>c.name).filter(n => {
    const s=stats[n]; if(!s) return false;
    if (s.type==="numeric") return s.min===s.max;
    return s.distinct===1;
  });
  if (constantCols.length) narratives.push({ type:"quality", icon:"⚙️", text:`Constant columns (${constantCols.length}). e.g. ${constantCols.slice(0,3).join(", ")}.` });

  const keyLike=colInfo.filter(c=>{
    const s=stats[c.name]; if(!s) return false;
    const distinct=s.type==="numeric"? new Set(s.nums).size : s.distinct;
    return distinct/rows.length>0.9 && rows.length>10;
  }).map(c=>c.name);
  if (keyLike.length) narratives.push({ type:"quality", icon:"🧷", text:`High-uniqueness fields (likely IDs): ${keyLike.slice(0,3).join(", ")}.` });

  colInfo.filter(c=>c.type!=="numeric").forEach(c=>{
    const [val,count]=stats[c.name].top; if(!val) return; const pct=count/rows.length;
    if (pct>0.8) narratives.push({ type:"category", icon:"🏷️", text:`'${c.name}' dominated by '${val}' (${round(pct*100,1)}%).` });
    else if (pct>0.5) narratives.push({ type:"category", icon:"🏷️", text:`'${c.name}' majority value '${val}' (${round(pct*100,1)}%).` });
  });

  const skewed = Object.entries(stats).filter(([k,v])=>v.type==="numeric" && Math.abs(v.skew)>=1).map(([k,v])=>`${k} (skew=${round(v.skew,2)})`);
  if (skewed.length) narratives.push({ type:"quality", icon:"↔️", text:`Skewed distributions: ${skewed.slice(0,3).join(", ")}.` });

  const outlierCols=Object.keys(stats).filter(k=>stats[k].type==="numeric"&&stats[k].outliers>0);
  if (outlierCols.length) narratives.push({ type:"outliers", icon:"📌", text:`Outliers in ${outlierCols.length} numeric col(s). Notable: ${outlierCols.slice(0,2).map(k=>`${k} (${stats[k].outliers})`).join(", ")}.`, badge:"3σ" });

  const dateCols = colInfo.filter(c=>c.type==="date").map(c=>c.name);
  const numericCols = colInfo.filter(c=>c.type==="numeric").map(c=>c.name);
  let timeExtras=null, dateColName=null;

  if (dateCols.length && numericCols.length){
    const dCol=dateCols[0], nCol=numericCols[0]; dateColName=dCol;
    const pts=rows.map(r=>({ d:new Date(r[dCol]), v:toNumber(r[nCol]) })).filter(p=>!isNaN(p.d)&&p.v!==null).sort((a,b)=>a.d-b.d);
    if (pts.length>2){
      const first=pts[0].v, last=pts.at(-1).v;
      const growth = first!==0 ? ((last-first)/Math.abs(first))*100 : null;
      narratives.push({ type: last>=first?"trend-up":"trend-down", icon:last>=first?"📈":"📉", text:`'${nCol}' ${last>=first?"increased":"decreased"} from ${round(first)} to ${round(last)} (${dCol}).`, badge:growth!==null?`${round(growth)}%`:undefined });

      // MoM / YoY
      const map=new Map();
      pts.forEach(p=>{ const k=ymKey(p.d); const o=map.get(k)||{sum:0,count:0}; o.sum+=p.v; o.count++; map.set(k,o); });
      const series=Array.from(map.entries()).map(([k,v])=>({k, y:v.sum/v.count})).sort((a,b)=>a.k.localeCompare(b.k));
      let momPct, yoyPct;
      if (series.length>=2){ const [p,c]=series.slice(-2).map(e=>e.y); if (p!==0) momPct=(c-p)/Math.abs(p)*100; }
      if (series.length>=13){ const lastK=series.at(-1).k; const prevKey=`${String(+lastK.slice(0,4)-1)}-${lastK.slice(5)}`; const prev=series.find(e=>e.k===prevKey); if (prev && prev.y!==0) yoyPct=(series.at(-1).y-prev.y)/Math.abs(prev.y)*100; }
      timeExtras={ range:`${pts[0].d.toISOString().slice(0,10)} → ${pts.at(-1).d.toISOString().slice(0,10)}`, momPct, yoyPct };
    }
  }

  // Correlations
  if (numericCols.length>=2){
    const corr=computeCorrelationsFromCols(numericCols, rows);
    if (corr && corr.labels.length>1){
      const pairs=[]; for(let i=0;i<corr.labels.length;i++){ for(let j=i+1;j<corr.labels.length;j++){ pairs.push({a:corr.labels[i], b:corr.labels[j], r:corr.matrix[i][j]}); } }
      pairs.sort((p,q)=>Math.abs(q.r)-Math.abs(p.r));
      const top=pairs.slice(0,3).map(p=>`${p.a}↔${p.b} (r=${round(p.r,2)})`).join("; ");
      narratives.push({ type:"corr", icon:"🔗", text:`Top correlations: ${top}.` });
    }
  }

  renderNarratives(narratives);
  buildAllCharts(rows, colInfo, dateCols, numericCols);
  return { stats, extras:{ duplicates: countDuplicates(rows) }, timeExtras, dateColName };
}
function countDuplicates(rows){ const seen=new Set(); let dup=0; rows.forEach(r=>{ const k=JSON.stringify(r); if(seen.has(k)) dup++; else seen.add(k); }); return dup; }
function renderNarratives(items){
  narrativesDiv.innerHTML="";
  items.forEach(obj=>{
    const card=document.createElement('div'); card.className=`insight-card insight--${obj.type}`;
    const icon=document.createElement('div'); icon.className='insight-icon'; icon.textContent=obj.icon||'💡';
    const text=document.createElement('div'); text.className='insight-text'; text.textContent=obj.text;
    const meta=document.createElement('div'); meta.className='insight-meta';
    if (obj.badge){ const b=document.createElement('span'); b.className='insight-badge'; b.textContent=obj.badge; meta.appendChild(b); }
    card.append(icon,text,meta); narrativesDiv.appendChild(card);
  });
}

/* ----------------- brush filter ----------------------- */
function getFilteredRows(rows){ if(!globalDateFilter||!activeDateCol) return rows; const {min,max}=globalDateFilter; return rows.filter(r=>{ const d=new Date(r[activeDateCol]); return !isNaN(d)&&d>=min&&d<=max; }); }
function setGlobalFilterFromChart(chart){
  if (!brushLinkEnabled || !activeDateCol) return;
  const scale=chart.scales?.x; if(!scale) return;
  const labels=chart._xLabels||chart.data.labels||[];
  const fromIdx=Math.max(0,Math.floor(scale.min ?? 0));
  const toIdx=Math.min(labels.length-1, Math.ceil(scale.max ?? labels.length-1));
  const min=new Date(labels[fromIdx]), max=new Date(labels[toIdx]); if(isNaN(min)||isNaN(max)) return;
  globalDateFilter={min,max}; clearFilterBtn.classList.remove('hidden');
  buildAllCharts(globalData.rows, buildColInfo(globalData), getDateCols(), getNumericCols());
}
brushBtn.addEventListener("click",()=>{ brushLinkEnabled=!brushLinkEnabled; brushBtn.textContent=brushLinkEnabled?"Brush: ON (Shift+Drag)":"Brush Filter (Shift+Drag)"; if(brushLinkEnabled) alert("Hold Shift and drag on a time chart to filter all charts."); });
clearFilterBtn.addEventListener("click",()=>{ globalDateFilter=null; clearFilterBtn.classList.add('hidden'); buildAllCharts(globalData.rows, buildColInfo(globalData), getDateCols(), getNumericCols()); });
function getDateCols(){ return buildColInfo(globalData).filter(c=>c.type==="date").map(c=>c.name); }
function getNumericCols(){ return buildColInfo(globalData).filter(c=>c.type==="numeric").map(c=>c.name); }

/* ------------------- charts core ---------------------- */
const chartOptionsBase={ responsive:true, maintainAspectRatio:true, aspectRatio:1.6 };
function clearCharts(){
  chartInstances.forEach(c=>{ try{ c.destroy?.(); }catch(e){} }); chartInstances=[];
  ["chartCanvas1","chartCanvas2","chartCanvas3","chartCanvas4","chartCanvas5","chartCanvas6","chartPareto","chartControl"].forEach(id=>{ const cv=$(id); if(cv){ cv.style.display='none'; hideCard(cv); }});
  ["heatmap","boxplot","waterfall"].forEach(id=>{ const el=$(id); if(el){ el.innerHTML=""; hideCard(el); }});
  const bw=$("bulletsWrap"); if (bw) bw.innerHTML=""; hideCard("kpiBullets");
  const sm=$("smallMultiples"); if (sm) sm.innerHTML=""; cleanupEmptyCards();
}
function withZoomSyncOptions(options, chartRef){
  return {
    ...options,
    plugins: {
      ...(options.plugins||{}),
      zoom: {
        pan:{enabled:true,mode:'x'},
        zoom:{ wheel:{enabled:true}, pinch:{enabled:true}, drag:{enabled:true, modifierKey:'shift'}, mode:'x',
          onZoomComplete:({chart})=>{ if(brushLinkEnabled){ setGlobalFilterFromChart(chart); try{ chart.resetZoom(); }catch(e){} } }
        }
      }
    }
  };
}
function buildAllCharts(allRows, colInfo, dateCols, numericCols){
  clearCharts();
  const rows=getFilteredRows(allRows);
  const categoricalCols=colInfo.filter(c=>c.type==="categorical").map(c=>c.name);
  const used={ date:new Set(), num:new Set(), cat:new Set() };

  // First pass (try to place 4+ immediately)
  if (dateCols.length && numericCols.length){ if (renderTimeSeriesWithRolling(rows,dateCols[0],numericCols[0],"chartCanvas1",`${numericCols[0]} over ${dateCols[0]}`)) { used.date.add(dateCols[0]); used.num.add(numericCols[0]); addExplainer("chartCanvas1","Trend with rolling average. Shift+Drag to brush filter."); } }
  if (numericCols.length>=2){ if (renderScatterWithTrend(rows,numericCols[0],numericCols[1],"chartCanvas2",`${numericCols[0]} vs ${numericCols[1]}`)) { used.num.add(numericCols[0]); used.num.add(numericCols[1]); addExplainer("chartCanvas2","Relationship with best-fit line."); } }
  if (categoricalCols.length && numericCols.length){ if (renderBarCategory(rows,categoricalCols[0],numericCols[0],"chartCanvas3",`${numericCols[0]} by ${categoricalCols[0]}`)) { used.cat.add(categoricalCols[0]); used.num.add(numericCols[0]); addExplainer("chartCanvas3","Group averages for contrast."); } }
  if (numericCols.length){ if (renderHistogram(rows, (numericCols.find(n=>!used.num.has(n))||numericCols[0]), "chartCanvas4", `Distribution`)) { used.num.add(numericCols[0]); addExplainer("chartCanvas4","Distribution shape for skew/tails."); } }

  // Nice-to-haves (render if possible)
  if (categoricalCols.length){ renderDoughnutTopCategories(rows,categoricalCols[0],"chartCanvas5",`Top ${categoricalCols[0]} categories`); }
  if (dateCols.length && numericCols.length){ renderWeekdayPattern(rows,dateCols[0],numericCols[0],"chartCanvas6",`Weekday pattern of ${numericCols[0]}`); }

  if (numericCols.length>=2){ const corr=computeCorrelationsFromCols(numericCols,rows); if(corr && corr.matrix) renderHeatmap(corr.labels,corr.matrix,"heatmap"); }
  if (numericCols.length) renderMultiBoxPlot(rows, numericCols.slice(0,4), "boxplot", "Box plots (selected metrics)");
  if (categoricalCols.length) renderPareto(rows, categoricalCols[0], "chartPareto", `Pareto on ${categoricalCols[0]}`);
  // guard
  if (dateCols.length && numericCols.length){
    renderWaterfallMonthly(rows,dateCols[0],numericCols[0],"waterfall","Waterfall: month-to-month contributions");
    renderControlChart(rows,dateCols[0],numericCols[0],"chartControl",`Control chart: ${numericCols[0]}`);
    renderKpiBullets(rows,dateCols[0],numericCols[0]);
    renderSmallMultiples(rows,dateCols[0],numericCols[0],categoricalCols[0]);
  }

  // Fallback: guarantee minimum of 4 visible charts
  ensureMinimumCharts(4, rows, dateCols, numericCols, categoricalCols, used);

  cleanupEmptyCards();
}

/* ------- ensure minimum N charts (fallback pass) ------- */
function nextFreeCanvasId(){
  const ids=["chartCanvas1","chartCanvas2","chartCanvas3","chartCanvas4","chartCanvas5","chartCanvas6","chartPareto","chartControl"];
  for (const id of ids){ const card=cardOf(id); if (card && !card.classList.contains('show')) return id; }
  return null;
}
function ensureMinimumCharts(minCount, rows, dateCols, numericCols, categoricalCols, used){
  let shown=countShown();
  if (shown>=minCount) return;

  // 1) Extra histograms (fast + always possible with numeric)
  for (const col of numericCols){
    if (shown>=minCount) break;
    if (used.num.has(col)) continue;
    const id=nextFreeCanvasId(); if(!id) break;
    if (renderHistogram(rows, col, id, `Distribution of ${col}`)) { used.num.add(col); shown=countShown(); }
  }

  // 2) Pairwise scatters
  for (let i=0;i<numericCols.length && shown<minCount;i++){
    for (let j=i+1;j<numericCols.length && shown<minCount;j++){
      const x=numericCols[i], y=numericCols[j];
      const id=nextFreeCanvasId(); if(!id) break;
      if (renderScatterWithTrend(rows, x, y, id, `${x} vs ${y}`)) { used.num.add(x); used.num.add(y); shown=countShown(); }
    }
  }

  // 3) Category count bars
  for (const cat of categoricalCols){
    if (shown>=minCount) break;
    if (used.cat.has(cat)) continue;
    const id=nextFreeCanvasId(); if(!id) break;
    if (renderBarCounts(rows, cat, id, `Counts of ${cat}`)) { used.cat.add(cat); shown=countShown(); }
  }
}

/* ---------------- renderers (return true/false) ------- */
function detectFrequency(dates){
  if (dates.length<2) return "unknown";
  const diffs=[]; for(let i=1;i<dates.length;i++){ diffs.push(Math.abs((dates[i]-dates[i-1])/(1000*60*60*24))); }
  const med = quantile(diffs,0.5)||0;
  if (med<=1.5) return "daily"; if (med<=10) return "weekly"; if (med<=45) return "monthly"; if (med<=400) return "yearly"; return "irregular";
}
function renderTimeSeriesWithRolling(rows, dateCol, numCol, canvasId, title){
  const pairs=rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]) })).filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  const canvas=prepareCanvas(canvasId); if (!pairs.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=pairs.map(p=>p.d.toISOString().slice(0,10)), data=pairs.map(p=>p.v);
  const w=( ()=>{ const f=detectFrequency(pairs.map(p=>p.d)); return f==="daily"?7:(f==="weekly"?4:3); })();
  const roll=rollingMean(data,w).map(v=>v===null?null:round(v,2));
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"line",
    data:{ labels, datasets:[
      { label:title, data, borderColor:"#6ee7b7", backgroundColor:"rgba(110,231,183,0.08)", tension:0.25 },
      { label:`${w}-period rolling avg`, data:roll, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", borderDash:[6,4], tension:0.2, spanGaps:true }
    ]},
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{ display:true } }, interaction:{ mode:'index', intersect:false } }, canvas)
  });
  canvas._chart._xLabels=labels; setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderScatterWithTrend(rows,xCol,yCol,canvasId,title){
  const pts=rows.map(r=>{ const x=toNumber(r[xCol]), y=toNumber(r[yCol]); return (x!==null&&y!==null)?{x,y}:null; }).filter(Boolean);
  const canvas=prepareCanvas(canvasId); if(!pts.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y); const {slope,intercept}=linreg(xs,ys);
  const minX=Math.min(...xs), maxX=Math.max(...xs); const line=[{x:minX,y:slope*minX+intercept},{x:maxX,y:slope*maxX+intercept}];
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"scatter",
    data:{ datasets:[ {label:title,data:pts,pointBackgroundColor:"#60a5fa"}, {type:"line",label:"Trendline",data:line,parsing:false,segment:{borderDash:[6,4]},borderColor:"#6ee7b7",pointRadius:0}]},
    options: withZoomSyncOptions({ ...chartOptionsBase, parsing:false, scales:{x:{title:{display:true,text:xCol}}, y:{title:{display:true,text:yCol}} } }, canvas)
  });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderBarCategory(rows,catCol,numCol,canvasId,title){
  const canvas=prepareCanvas(canvasId);
  const agg={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); const v=toNumber(r[numCol]); if(!agg[k]) agg[k]={sum:0,count:0}; if(v!==null){ agg[k].sum+=v; agg[k].count++; }});
  const entries=Object.entries(agg).map(([k,v])=>({k,avg:v.count?v.sum/v.count:0})).sort((a,b)=>b.avg-a.avg).slice(0,20);
  if (!entries.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=entries.map(e=>e.k), data=entries.map(e=>round(e.avg,2));
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"bar", data:{ labels, datasets:[{ label:title, data, backgroundColor:"#f59e0b"}] }, options: withZoomSyncOptions({ ...chartOptionsBase, indexAxis:'y', plugins:{legend:{display:false}} }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderBarCounts(rows,catCol,canvasId,title){
  const canvas=prepareCanvas(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,20);
  if (!entries.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=entries.map(e=>e[0]), data=entries.map(e=>e[1]);
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"bar", data:{labels, datasets:[{label:title, data, backgroundColor:"#60a5fa"}]}, options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{legend:{display:false}} }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderHistogram(rows,col,canvasId,title){
  const canvas=prepareCanvas(canvasId);
  const vals=rows.map(r=>toNumber(r[col])).filter(v=>v!==null); if(!vals.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const min=Math.min(...vals), max=Math.max(...vals), bins=12, binSize=(max-min)/bins || 1, counts=Array(bins).fill(0);
  vals.forEach(v=>{ const idx=Math.min(bins-1, Math.floor((v-min)/binSize)); counts[idx]+=1; });
  const labels=counts.map((_,i)=>`${round(min+i*binSize,2)}-${round(min+(i+1)*binSize,2)}`);
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"bar", data:{labels, datasets:[{label:title, data:counts, backgroundColor:"#a78bfa"}]}, options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{legend:{display:false}} }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderDoughnutTopCategories(rows,catCol,canvasId,title){
  const canvas=prepareCanvas(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8); if(!entries.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=entries.map(e=>e[0]), data=entries.map(e=>e[1]);
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"doughnut", data:{labels, datasets:[{label:title, data}]}, options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{position:'bottom'} } }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderWeekdayPattern(rows,dateCol,numCol,canvasId,title){
  const canvas=prepareCanvas(canvasId);
  const pts=rows.map(r=>({d:new Date(r[dateCol]), v:toNumber(r[numCol])})).filter(p=>!isNaN(p.d)&&p.v!==null);
  if(!pts.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const agg=new Array(7).fill(0).map(()=>({sum:0,count:0})); pts.forEach(p=>{ const i=p.d.getDay(); agg[i].sum+=p.v; agg[i].count++; });
  const labels=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"], data=agg.map(a=>a.count?a.sum/a.count:0);
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"bar", data:{labels, datasets:[{label:title, data, backgroundColor:"#6ee7b7"}]}, options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{legend:{display:false}} }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}

/* ------------- Plotly charts (return true/false) ------ */
function renderMultiBoxPlot(rows, cols, containerId, title){
  const el=preparePlotContainer(containerId);
  const traces=cols.map(c=>{ const v=rows.map(r=>toNumber(r[c])).filter(x=>x!==null); return v.length?{y:v,type:'box',name:c,boxpoints:'outliers'}:null; }).filter(Boolean);
  if (!traces.length){ hideCard(el); return false; }
  Plotly.newPlot(el, traces, { title, margin:{l:50,r:20,t:30,b:30}, autosize:true, height:220 }, { responsive:true }); return true;
}
function renderHeatmap(labels,matrix,containerId){
  const el=preparePlotContainer(containerId); if (!labels?.length){ hideCard(el); return false; }
  const data=[{ z:matrix, x:labels, y:labels, type:'heatmap', colorscale:'RdBu', zmin:-1, zmax:1, colorbar:{ title:'r' } }];
  const layout={ margin:{l:80,r:30,t:30,b:80}, autosize:true, title:'Correlation Heatmap', height:220 };
  Plotly.newPlot(el, data, layout, { responsive:true }); return true;
}
function renderPareto(rows, catCol, canvasId, title){
  const canvas=prepareCanvas(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12); if(!entries.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=entries.map(e=>e[0]), counts=entries.map(e=>e[1]), total=counts.reduce((a,b)=>a+b,0);
  const cum=[]; let s=0; counts.forEach(v=>{ s+=v; cum.push(round((s/total)*100,1)); });
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"bar", data:{ labels, datasets:[
    { label:"Count", data:counts, backgroundColor:"#60a5fa", yAxisID:'y' },
    { type:"line", label:"Cumulative %", data:cum, yAxisID:'y1', borderColor:"#6ee7b7", pointRadius:2, tension:0.2 }
  ]}, options: withZoomSyncOptions({ ...chartOptionsBase, scales:{ y:{beginAtZero:true}, y1:{position:'right',min:0,max:100,ticks:{callback:v=>v+"%"}, grid:{drawOnChartArea:false} } } }, canvas) });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderWaterfallMonthly(rows, dateCol, numCol, containerId, title){
  const el=preparePlotContainer(containerId); el.innerHTML="";
  const pts=rows.map(r=>({d:new Date(r[dateCol]), v:toNumber(r[numCol])})).filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  if (pts.length<3){ hideCard(el); return false; }
  const map=new Map(); pts.forEach(p=>{ const k=ymKey(p.d); const o=map.get(k)||{sum:0,count:0}; o.sum+=p.v; o.count++; map.set(k,o); });
  const series=Array.from(map.entries()).map(([k,v])=>({k, y:v.sum/v.count})).sort((a,b)=>a.k.localeCompare(b.k)); if (series.length<3){ hideCard(el); return false; }
  const x=[], measure=[], y=[]; x.push(series[0].k); measure.push("absolute"); y.push(series[0].y); for(let i=1;i<series.length;i++){ x.push(series[i].k); measure.push("relative"); y.push(round(series[i].y-series[i-1].y,2)); } x.push("Total"); measure.push("total"); y.push(series.at(-1).y);
  Plotly.newPlot(el, [{ type:"waterfall", x, measure, y, decreasing:{marker:{color:"#f87171"}}, increasing:{marker:{color:"#34d399"}}, totals:{marker:{color:"#60a5fa"}} }], { title, margin:{l:50,r:20,t:30,b:30}, autosize:true, height:220 }, { responsive:true });
  return true;
}
function renderControlChart(rows, dateCol, numCol, canvasId, title){
  const canvas=prepareCanvas(canvasId);
  const pts=rows.map(r=>({d:new Date(r[dateCol]), v:toNumber(r[numCol])})).filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  if (!pts.length){ if(canvas){canvas.style.display="none"; hideCard(canvas);} return false; }
  const labels=pts.map(p=>p.d.toISOString().slice(0,10)), data=pts.map(p=>p.v), mean=arrayMean(data), sd=arrayStd(data), ucl=mean+3*sd, lcl=mean-3*sd;
  const pointBg=data.map(v=>(v>ucl||v<lcl)?"#f87171":"#6ee7b7");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(canvas.getContext("2d"),{ type:"line", data:{labels, datasets:[
    { label:title, data, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", tension:0.1, pointBackgroundColor:pointBg, pointRadius:2 },
    { label:"Mean", data:labels.map(()=>mean), borderColor:"#e5e7eb", borderDash:[4,4], pointRadius:0 },
    { label:"UCL (+3σ)", data:labels.map(()=>ucl), borderColor:"#f87171", borderDash:[6,4], pointRadius:0 },
    { label:"LCL (-3σ)", data:labels.map(()=>lcl), borderColor:"#f87171", borderDash:[6,4], pointRadius:0 }
  ]}, options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{legend:{display:true}}, interaction:{mode:'index', intersect:false} }, canvas) });
  canvas._chart._xLabels=labels; setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart); return true;
}
function renderKpiBullets(rows, dateCol, numCol){
  const wrap=$("bulletsWrap"); wrap.innerHTML="";
  const vals=rows.map(r=>toNumber(r[numCol])).filter(v=>v!==null);
  if (!vals.length){ hideCard('kpiBullets'); return false; }
  showCard('kpiBullets');
  const current=round(vals.at(-1),2), p90=round(quantile(vals,0.9),2), avg=round(arrayMean(vals),2), max=Math.max(...vals,p90,avg)*1.1;
  [{ label:`${numCol} (current)`, value: current, target: p90 }, { label:`${numCol} (average)`, value: avg, target: p90 }, { label:`Target (P90)`, value: p90, target: p90 }]
  .forEach((b,i)=>{ const host=document.createElement('div'); host.className='bullet'; host.innerHTML=`<canvas id="bullet${i}"></canvas>`; wrap.appendChild(host); renderBulletChart(`bullet${i}`, b.label, b.value, b.target, max); });
  return true;
}
function renderBulletChart(canvasId,label,value,target,maxVal){
  const canvas=prepareCanvas(canvasId); const ctx=canvas.getContext("2d");
  const targetLine={ id:'targetLine', afterDatasetsDraw(chart){ const {ctx, chartArea:{top,bottom}, scales:{x}}=chart; const xPos=x.getPixelForValue(target); ctx.save(); ctx.strokeStyle="#f59e0b"; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(xPos,top); ctx.lineTo(xPos,bottom); ctx.stroke(); ctx.restore(); } };
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"bar", data:{ labels:[label], datasets:[{ label:"Value", data:[value], backgroundColor:"#6ee7b7", borderRadius:8, barPercentage:0.8 }]}, options:{ responsive:true, maintainAspectRatio:true, aspectRatio:2.4, indexAxis:'y', scales:{ x:{ min:0, max:maxVal }, y:{ display:true } }, plugins:{ legend:{display:false}, zoom:false } }, plugins:[targetLine] });
  setTimeout(()=>canvas._chart.resize(),0); chartInstances.push(canvas._chart);
}
function renderSmallMultiples(rows, dateCol, numCol, catCol){
  const root=$("smallMultiples"); root.innerHTML=""; const parent=root.closest('.chart-card'); if(!catCol){ if(parent) parent.classList.remove('show'); return false; }
  const valid=rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]), c:String(r[catCol]||"(missing)") })).filter(p=>!isNaN(p.d)&&p.v!==null);
  if(!valid.length){ if(parent) parent.classList.remove('show'); return false; }
  const freq={}; valid.forEach(p=>{ freq[p.c]=(freq[p.c]||0)+1; }); const topCats=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0]);
  topCats.forEach((cat,idx)=>{ const div=document.createElement('div'); div.className='mini-chart'; const id=`sm${idx}`; div.innerHTML=`<small style="color:#dbeafe">${cat}</small><canvas id="${id}"></canvas>`; root.appendChild(div);
    const subset=valid.filter(p=>p.c===cat).sort((a,b)=>a.d-b.d); const map=new Map(); subset.forEach(p=>{ const k=p.d.toISOString().slice(0,10); const o=map.get(k)||{sum:0,count:0}; o.sum+=p.v; o.count++; map.set(k,o); });
    const labels=[...map.keys()], data=labels.map(k=>round(map.get(k).sum/map.get(k).count,2));
    prepareCanvas(id);
    const cv=document.getElementById(id);
    if (cv._chart) cv._chart.destroy();
    cv._chart=new Chart(cv.getContext("2d"),{ type:"line", data:{labels, datasets:[{ label:numCol, data, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", pointRadius:0, tension:0.2 }]}, options: withZoomSyncOptions({ responsive:true, maintainAspectRatio:true, aspectRatio:2.0, plugins:{ legend:{display:false} } }, cv) });
    setTimeout(()=>cv._chart.resize(),0); chartInstances.push(cv._chart);
  });
  if (!topCats.length || !root.children.length){ if(parent) parent.classList.remove('show'); return false; }
  if (parent) parent.classList.add('show'); return true;
}

/* --------------- correlation helpers ------------------ */
function computeCorrelationsFromCols(numericCols, rows){
  if (numericCols.length<2) return null;
  const arrays=numericCols.map(c=>rows.map(r=>toNumber(r[c])));
  const n=numericCols.length, matrix=Array.from({length:n},()=>Array(n).fill(0));
  for (let i=0;i<n;i++){ for (let j=0;j<n;j++){ const ai=arrays[i], aj=arrays[j]; const paired=[]; for(let t=0;t<ai.length;t++){ const a=ai[t], b=aj[t]; if(a!==null&&b!==null) paired.push([a,b]); } if(paired.length<2){ matrix[i][j]=0; continue; } const xs=paired.map(p=>p[0]), ys=paired.map(p=>p[1]); matrix[i][j]=pearson(xs,ys); } }
  return { labels:numericCols, matrix };
}
function pearson(x,y){ if(x.length<2) return 0; const n=x.length, mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n; let num=0,dx=0,dy=0; for(let i=0;i<n;i++){ num+=(x[i]-mx)*(y[i]-my); dx+=(x[i]-mx)**2; dy+=(y[i]-my)**2; } const denom=Math.sqrt(dx*dy); return denom===0?0:num/denom; }

/* ------------------ export & reset -------------------- */
exportPdfBtn.addEventListener("click", async()=>{
  exportPdfBtn.disabled=true; exportPdfBtn.textContent="Preparing PDF...";
  try{
    const node=document.querySelector("main");
    const canvas=await html2canvas(node,{scale:2, backgroundColor:'#071121'});
    const img=canvas.toDataURL('image/png');
    const { jsPDF }=window.jspdf;
    const pdf=new jsPDF({ orientation:'landscape', unit:'pt', format:[canvas.width, canvas.height]});
    pdf.addImage(img,'PNG',0,0,canvas.width,canvas.height);
    pdf.save('insights-report.pdf');
  } catch(e){ alert("PDF export failed: "+e.message); }
  finally{ exportPdfBtn.textContent="Export Report (PDF)"; exportPdfBtn.disabled=false; }
});
resetBtn.addEventListener("click", ()=>{
  globalData={ headers:[], rows:[] }; fileInput.value="";
  summarySection.classList.add("hidden"); insightsSection.classList.add("hidden"); rawSection.classList.add("hidden"); metricsSection.classList.add("hidden");
  summaryCards.innerHTML=""; metricsCards.innerHTML=""; datasetPreview.textContent=""; dataTable.innerHTML=""; narrativesDiv.innerHTML="";
  clearCharts(); resetProgress(); clearHighlights(); closeDock(); window.scrollTo({top:0,behavior:"smooth"});
  activeDateCol=null; globalDateFilter=null; brushLinkEnabled=false; brushBtn.disabled=true; clearFilterBtn.classList.add("hidden"); brushBtn.textContent="Brush Filter (Shift+Drag)";
});

/* ------------------- annotation dock ------------------ */
let annotMode="off", isDrawing=false, ctxA=null, dpr=window.devicePixelRatio||1, markerColor="rgba(255,235,59,0.55)", markerWidth=12;
function sizeAnnotCanvas(){ const w=window.innerWidth, h=window.innerHeight; annotCanvas.width=Math.floor(w*dpr); annotCanvas.height=Math.floor(h*dpr); annotCanvas.style.width=w+"px"; annotCanvas.style.height=h+"px"; ctxA=annotCanvas.getContext("2d"); ctxA.setTransform(dpr,0,0,dpr,0,0); }
function setAnnotMode(mode){ annotMode=mode; annotWrapper.classList.remove("active","marker","eraser","hidden"); markerBtn.classList.toggle("active",mode==="marker"); eraserBtn.classList.toggle("active",mode==="eraser"); if(mode==="off"){ annotWrapper.classList.add("hidden"); return; } annotWrapper.classList.add("active",mode); sizeAnnotCanvas(); }
function clearHighlights(){ if(!ctxA) return; ctxA.clearRect(0,0,annotCanvas.width,annotCanvas.height); }
function startDraw(x,y){ if(annotMode==="off") return; isDrawing=true; ctxA.lineCap="round"; ctxA.lineJoin="round"; ctxA.lineWidth=annotMode==="marker"?markerWidth:Math.max(markerWidth*1.6,20); if(annotMode==="marker"){ ctxA.globalCompositeOperation="source-over"; ctxA.strokeStyle=markerColor; } else { ctxA.globalCompositeOperation="destination-out"; ctxA.strokeStyle="rgba(0,0,0,1)"; } ctxA.beginPath(); ctxA.moveTo(x,y); }
function continueDraw(x,y){ if(!isDrawing) return; ctxA.lineTo(x,y); ctxA.stroke(); }
function endDraw(){ if(!isDrawing) return; isDrawing=false; ctxA.closePath(); }
function getXY(evt){ const r=annotCanvas.getBoundingClientRect(); const cx=evt.touches?evt.touches[0].clientX:evt.clientX; const cy=evt.touches?evt.touches[0].clientY:evt.clientY; return { x: cx-r.left, y: cy-r.top }; }
annotCanvas.addEventListener("mousedown",e=>{ if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); startDraw(x,y); });
annotCanvas.addEventListener("mousemove",e=>{ if(annotMode==="off") return; const {x,y}=getXY(e); continueDraw(x,y); });
window.addEventListener("mouseup", endDraw);
annotCanvas.addEventListener("touchstart",e=>{ if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); startDraw(x,y); }, {passive:false});
annotCanvas.addEventListener("touchmove",e=>{ if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); continueDraw(x,y); }, {passive:false});
annotCanvas.addEventListener("touchend", endDraw);

// dock
function openDock(){ annotPanel.classList.add("animate-in"); annotPanel.classList.remove("hidden","animate-out"); showDock(); }
function closeDock(){ annotPanel.classList.remove("animate-in"); annotPanel.classList.add("animate-out"); setTimeout(()=>{ annotPanel.classList.add("hidden"); annotPanel.classList.remove("animate-out"); },160); paletteHide(); }
annotToggle.addEventListener("click",()=>{ if(annotPanel.classList.contains("hidden")) openDock(); else closeDock(); });
markerBtn.addEventListener("click",()=>{ if(annotMode==="marker"){ clearHighlights(); setAnnotMode("off"); } else setAnnotMode("marker"); });
eraserBtn.addEventListener("click",()=> setAnnotMode(annotMode==="eraser"?"off":"eraser"));
function paletteShow(){ palettePop.classList.remove("hidden","pop-out"); palettePop.classList.add("pop-in"); }
function paletteHide(){ if(palettePop.classList.contains("hidden")) return; palettePop.classList.remove("pop-in"); palettePop.classList.add("pop-out"); setTimeout(()=>{ palettePop.classList.add("hidden"); palettePop.classList.remove("pop-out"); },120); }
paletteToggle.addEventListener("click",e=>{ e.stopPropagation(); if(palettePop.classList.contains("hidden")) paletteShow(); else paletteHide(); });
document.addEventListener("click",e=>{ if(!palettePop.contains(e.target) && !paletteToggle.contains(e.target)) paletteHide(); });
swatches().forEach((btn,i)=>{ if(i===0) btn.classList.add("active"); btn.addEventListener("click",()=>{ swatches().forEach(b=>b.classList.remove("active")); btn.classList.add("active"); markerColor=btn.dataset.color; }); });
widthRange.addEventListener("input",()=>{ markerWidth=parseInt(widthRange.value,10); widthVal.textContent=`${markerWidth}px`; });
clearAnnotsBtn.addEventListener("click", clearHighlights);

// dock visibility on scroll/move
let hideTimer=null;
function hideDock(){ annotDock.classList.add("dock-hidden"); paletteHide(); }
function showDock(){ annotDock.classList.remove("dock-hidden"); }
window.addEventListener("scroll",()=>{ hideDock(); clearTimeout(hideTimer); hideTimer=setTimeout(showDock,600); }, {passive:true});
window.addEventListener("mousemove", showDock, {passive:true});
window.addEventListener("touchstart", showDock, {passive:true});

/* --------------------- init --------------------------- */
(function init(){
  summarySection.classList.add("hidden"); insightsSection.classList.add("hidden"); rawSection.classList.add("hidden"); metricsSection.classList.add("hidden");
  sizeAnnotCanvas(); setTimeout(showDock,300);
})();
