

const $ = id => document.getElementById(id);
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

// DOM
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

// Annotation elements (unchanged from last build)
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

// State
let globalData = { headers: [], rows: [] };
let chartInstances = [];
let activeDateCol = null;          // used for global brush filter
let globalDateFilter = null;       // {min: Date, max: Date} or null
let brushLinkEnabled = false;

// Helpers
const toNumber = v => (v === null || v === undefined || v === "" ? null : (Number.isFinite(+v) ? +v : null));
const round = (n, p=2) => Math.round((n + Number.EPSILON) * 10 ** p) / 10 ** p;
const isDateString = s => { if (!s && s!==0) return false; const d=new Date(s); return !isNaN(d.valueOf()); };
const arrayMean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
const arrayStd = a => { if (!a.length) return 0; const m=arrayMean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/a.length); };
function quantile(arr, q){ if (!arr.length) return null; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const base=Math.floor(pos), rest=pos-base; return a[base] + (a[base+1]-a[base] || 0)*rest; }
function linreg(xs, ys){ const n=xs.length; if (n<2) return {slope:0, intercept:arrayMean(ys)}; const mx=arrayMean(xs), my=arrayMean(ys); let num=0, den=0; for(let i=0;i<n;i++){ num += (xs[i]-mx)*(ys[i]-my); den += (xs[i]-mx)**2; } const slope= den===0 ? 0 : num/den; const intercept = my - slope*mx; return { slope, intercept }; }
function rollingMean(arr, w){ if (!arr.length || w<=1) return arr.slice(); const out=[]; let sum=0; for(let i=0;i<arr.length;i++){ sum+=arr[i]; if(i>=w) sum-=arr[i-w]; out.push(i>=w-1 ? sum/Math.min(i+1,w) : null); } return out; }
function dateDiffDays(d1,d2){ return Math.abs((d2-d1)/(1000*60*60*24)); }
function detectFrequency(dates){ if (dates.length<2) return "unknown"; const diffs=[]; for(let i=1;i<dates.length;i++){ diffs.push(dateDiffDays(dates[i-1], dates[i])); } const med=quantile(diffs,0.5)||0; if (med<=1.5) return "daily"; if (med<=10) return "weekly"; if (med<=45) return "monthly"; if (med<=400) return "yearly"; return "irregular"; }
const ymKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

// Register zoom plugin
if (window?.chartjs_plugin_zoom) {
  Chart.register(window.chartjs_plugin_zoom);
} else if (window['chartjs-plugin-zoom']) {
  Chart.register(window['chartjs-plugin-zoom']);
}

// ------- Progress UI -------
let progressRoot=null, progressBar=null, progressLabel=null, progressRight=null;
function ensureProgressUI(){
  if (progressRoot) return;
  const wrap = document.createElement("div");
  wrap.className = "progress-wrap";
  wrap.innerHTML = `
    <div class="progress"><div class="bar" style="width:0%"></div></div>
    <div class="progress-meta"><span id="progressLabel">Waiting for file…</span><span id="progressRight"></span></div>
  `;
  $("uploader").appendChild(wrap);
  progressRoot = wrap;
  progressBar = wrap.querySelector(".bar");
  progressLabel = wrap.querySelector("#progressLabel");
  progressRight = wrap.querySelector("#progressRight");
}
function setProgress(pct, leftText="", rightText=""){
  ensureProgressUI();
  progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  if (leftText) progressLabel.textContent = leftText;
  if (rightText) progressRight.textContent = rightText;
}
function resetProgress(){
  if (!progressBar) return;
  progressBar.style.width = "0%";
  progressLabel.textContent = "Waiting for file…";
  progressRight.textContent = "";
}

// ------- File input -------
dropArea.addEventListener("click", () => fileInput.click());
dropArea.addEventListener("dragover", e => { e.preventDefault(); dropArea.style.opacity = 0.85; });
dropArea.addEventListener("dragleave", () => dropArea.style.opacity = 1);
dropArea.addEventListener("drop", e => {
  e.preventDefault(); dropArea.style.opacity = 1;
  const f = e.dataTransfer.files[0]; if (f) handleFile(f);
});
fileInput.addEventListener("change", e => { const f=e.target.files[0]; if (f) handleFile(f); });

function handleFile(file){
  if (file.size > MAX_FILE_BYTES) { alert(`File too large. Max ${(MAX_FILE_BYTES/1048576).toFixed(0)} MB.`); return; }
  resetProgress();
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) readCSVWithProgress(file);
  else if (name.endsWith(".xlsx") || name.endsWith(".xls")) readXLSXWithProgress(file);
  else alert("Unsupported file type. Upload CSV or XLSX.");
}

// Parsing with progress
function readCSVWithProgress(file){
  ensureProgressUI();
  const reader = new FileReader();
  reader.onprogress = e => { if (e.lengthComputable){ const pct = (e.loaded/file.size)*100; setProgress(pct, "Reading CSV…", `${Math.round(pct)}%`); } };
  reader.onloadstart = () => setProgress(0, "Reading CSV…", "0%");
  reader.onload = e => {
    setProgress(100, "Parsing CSV (worker)…", "");
    Papa.parse(e.target.result, {
      header:true, skipEmptyLines:true, worker:true,
      complete: res => { setProgress(100, "CSV ready ✔", `${res.data.length.toLocaleString()} rows`); processParsed(res.data); setTimeout(resetProgress, 1200); },
      error: err => { alert("CSV parse error: "+err.message); resetProgress(); }
    });
  };
  reader.onerror = () => { alert("Failed to read CSV file."); resetProgress(); };
  reader.readAsText(file);
}
function readXLSXWithProgress(file){
  ensureProgressUI();
  const reader = new FileReader();
  reader.onprogress = e => { if (e.lengthComputable){ const pct = (e.loaded/file.size)*100; setProgress(pct, "Reading XLSX…", `${Math.round(pct)}%`); } };
  reader.onloadstart = () => setProgress(0, "Reading XLSX…", "0%");
  reader.onload = e => {
    setProgress(100, "Parsing XLSX…", "");
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type:"array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval:"" });
      setProgress(100, "XLSX ready ✔", `${json.length.toLocaleString()} rows`);
      processParsed(json);
      setTimeout(resetProgress, 1200);
    } catch(err){ alert("XLSX parse error: "+err.message); resetProgress(); }
  };
  reader.onerror = () => { alert("Failed to read XLSX file."); resetProgress(); };
  reader.readAsArrayBuffer(file);
}

function processParsed(arr){
  if (!arr || arr.length===0){ alert("No rows found in file."); return; }
  const headers = Object.keys(arr[0]);
  const rows = arr.map(r => { const out={}; headers.forEach(h => out[h] = r[h] ?? ""); return out; });
  globalData = { headers, rows };
  buildSummary(globalData);
  exportPdfBtn.disabled = false;
}

// ------- Summary + metrics -------
function buildSummary({ headers, rows }){
  datasetPreview.textContent = JSON.stringify(rows.slice(0,10), null, 2);
  const colInfo = headers.map(h => {
    const vals = rows.map(r => r[h]);
    const numCount = vals.filter(v => v!=="" && Number.isFinite(Number(v))).length;
    const dateCount = vals.filter(isDateString).length;
    const type = numCount/rows.length > 0.6 ? "numeric" : (dateCount/rows.length > 0.6 ? "date" : "categorical");
    return { name:h, type, vals };
  });

  summaryCards.innerHTML = "";
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
function addSummaryCard(title, value){
  const div = document.createElement("div");
  div.className = "card-small";
  div.innerHTML = `<strong style="color:var(--accent)">${value}</strong><div style="font-size:12px;color:var(--muted)">${title}</div>`;
  summaryCards.appendChild(div);
}
function renderTable(headers, rows){
  dataTable.innerHTML = "";
  const thead = document.createElement("thead");
  const thr = document.createElement("tr");
  headers.forEach(h => { const th=document.createElement("th"); th.textContent=h; thr.appendChild(th); });
  thead.appendChild(thr); dataTable.appendChild(thead);
  const tbody=document.createElement("tbody");
  rows.slice(0,200).forEach(r => {
    const tr=document.createElement("tr");
    headers.forEach(h => { const td=document.createElement("td"); td.textContent=r[h]; tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  dataTable.appendChild(tbody);
}
function renderMetrics(stats, rows, colInfo, extras, timeExtras){
  const totalCells = colInfo.length * rows.length;
  const missingCells = colInfo.reduce((a,c)=> a + (stats[c.name]?.missing || 0), 0);
  const completeness = totalCells ? (1 - missingCells/totalCells) * 100 : 100;
  const outlierCols = Object.keys(stats).filter(k => stats[k].type==="numeric" && stats[k].outliers>0).length;
  const skewedCols = Object.keys(stats).filter(k => stats[k].type==="numeric" && Math.abs(stats[k].skew)>=0.8).length;
  const cards = [
    { label:"Completeness", value:`${round(completeness,1)}%`, cls: completeness>=95?"ok":(completeness>=85?"warn":"bad") },
    { label:"Rows", value: rows.length.toLocaleString(), cls:"ok" },
    { label:"Columns", value: colInfo.length, cls:"ok" },
    { label:"Duplicates", value: extras.duplicates.toLocaleString(), cls: extras.duplicates?"warn":"ok" },
    { label:"Outlier Columns", value: outlierCols, cls: outlierCols?"warn":"ok" },
    { label:"Skewed Columns", value: skewedCols, cls: skewedCols?"warn":"ok" },
  ];
  if (timeExtras?.momPct !== undefined){
    cards.push({ label:"MoM Δ", value:`${(timeExtras.momPct>=0?"+":"")}${round(timeExtras.momPct,1)}%`, cls: timeExtras.momPct>=0?"ok":"bad" });
  }
  if (timeExtras?.yoyPct !== undefined){
    cards.push({ label:"YoY Δ", value:`${(timeExtras.yoyPct>=0?"+":"")}${round(timeExtras.yoyPct,1)}%`, cls: timeExtras.yoyPct>=0?"ok":"bad" });
  }
  if (timeExtras?.range){
    cards.push({ label:"Date Range", value: timeExtras.range, cls:"ok" });
  }
  metricsCards.innerHTML = "";
  cards.forEach(c => {
    const el = document.createElement("div");
    el.className = `metric ${c.cls}`;
    el.innerHTML = `<div class="label">${c.label}</div><div class="value">${c.value}</div>`;
    metricsCards.appendChild(el);
  });
}

// ------- Insights + charts -------
function generateInsights(colInfo, rows){
  insightsSection.classList.remove("hidden");
  narrativesDiv.innerHTML = "";
  const stats = {};

  // Column-wise stats
  colInfo.forEach(c=>{
    if (c.type==="numeric"){
      const nums=c.vals.map(toNumber).filter(v=>v!==null);
      const count=nums.length;
      const mean=arrayMean(nums);
      const sorted=nums.slice().sort((a,b)=>a-b);
      const median=count?(count%2?sorted[(count-1)/2]:(sorted[count/2-1]+sorted[count/2])/2):0;
      const min=count?sorted[0]:null;
      const max=count?sorted[sorted.length-1]:null;
      const p10=quantile(nums,0.10), p90=quantile(nums,0.90), p95=quantile(nums,0.95);
      const missing=c.vals.filter(v=>v===""||v===null).length;
      const stdDev=arrayStd(nums);
      const outliers=nums.filter(v => Math.abs(v-mean) > 3*stdDev).length;
      const skew=stdDev?3*(mean-median)/stdDev:0;
      const cv = (mean!==0) ? stdDev/Math.abs(mean) : 0;
      stats[c.name]={ type:"numeric", count, mean, median, min, max, p10, p90, p95, missing, stdDev, outliers, skew, cv, nums };
    } else {
      const freq={};
      c.vals.forEach(v=>{ const k=(v===null||v==="")?"__MISSING__":String(v); freq[k]=(freq[k]||0)+1; });
      const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]);
      stats[c.name]={ type:c.type, distinct:entries.length, top:entries[0]||["",0], missing:freq["__MISSING__"]||0, freqEntries: entries.slice(0,30) };
    }
  });

  // Duplicates
  const duplicates = (()=>{ const seen=new Set(); let dup=0; rows.forEach(r=>{ const k=JSON.stringify(r); if(seen.has(k)) dup++; else seen.add(k); }); return dup; })();

  // Narratives
  const narratives=[]; const totalCells=colInfo.length*rows.length;
  const missingCells=colInfo.reduce((a,c)=>a+(stats[c.name]?.missing||0),0);
  const completeness= totalCells ? (1-missingCells/totalCells)*100 : 100;
  narratives.push({ type:"quality", icon:"🧪", text:`Data completeness: ${round(completeness,1)}%`, badge:`${round(completeness,1)}%`, tip:"Completeness = non-missing ÷ total." });

  const constantCols = colInfo.map(c=>c.name).filter(n => {
    const s = stats[n]; if (!s) return false;
    if (s.type==="numeric") return s.min === s.max;
    return s.distinct === 1;
  });
  if (constantCols.length) narratives.push({ type:"quality", icon:"⚙️", text:`Constant columns (${constantCols.length}). e.g. ${constantCols.slice(0,3).join(", ")}.` });

  const highCV = Object.entries(stats).filter(([k,v])=>v.type==="numeric" && v.cv>1).map(([k])=>k);
  if (highCV.length) narratives.push({ type:"quality", icon:"📊", text:`High variability (CV>1): ${highCV.slice(0,3).join(", ")}.`, badge:"CV>1" });

  const outlierCols=Object.keys(stats).filter(k=>stats[k].type==="numeric"&&stats[k].outliers>0);
  if (outlierCols.length) narratives.push({ type:"outliers", icon:"📌", text:`Outliers in ${outlierCols.length} numeric column(s). Notable: ${outlierCols.slice(0,2).map(k=>`${k} (${stats[k].outliers})`).join(", ")}.`, badge:"3σ" });

  // Date/time insights + MoM/YoY + monthly seasonality
  const dateCols = colInfo.filter(c=>c.type==="date").map(c=>c.name);
  const numericCols = colInfo.filter(c=>c.type==="numeric").map(c=>c.name);
  let timeExtras=null, dateColName=null;
  if (dateCols.length && numericCols.length){
    const dCol=dateCols[0], nCol=numericCols[0]; dateColName=dCol;
    const pts = rows.map(r=>({ d:new Date(r[dCol]), v:toNumber(r[nCol]) }))
      .filter(p=>!isNaN(p.d.valueOf()) && p.v!==null).sort((a,b)=>a.d-b.d);
    if (pts.length>2){
      const first = pts[0].v, last = pts[pts.length-1].v;
      const growth = first!==0 ? ((last-first)/Math.abs(first))*100 : null;
      const freq = detectFrequency(pts.map(p=>p.d));

      // Weekday avg
      const weekdays = new Array(7).fill(0).map(()=>({sum:0,count:0}));
      pts.forEach(p=>{ const w=p.d.getDay(); weekdays[w].sum+=p.v; weekdays[w].count++; });
      const weekdayAvg = weekdays.map(w=> w.count? w.sum/w.count : null);

      // Monthly seasonality (calendar month)
      const monAgg = new Array(12).fill(0).map(()=>({sum:0,count:0}));
      pts.forEach(p=>{ const m=p.d.getMonth(); monAgg[m].sum += p.v; monAgg[m].count++; });
      const monAvg = monAgg.map(m=> m.count ? m.sum/m.count : null);
      const namesMonth = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

      // Monthly timeline (avg per YYYY-MM)
      const monthlyMap = new Map();
      pts.forEach(p=>{
        const k = ymKey(p.d);
        if (!monthlyMap.has(k)) monthlyMap.set(k, {sum:0,count:0});
        const o = monthlyMap.get(k); o.sum+=p.v; o.count++;
      });
      const monthlySeries = Array.from(monthlyMap.entries())
        .map(([k,v])=>({ k, y: v.count? v.sum/v.count : 0 }))
        .sort((a,b)=> a.k.localeCompare(b.k));

      let momPct, yoyPct;
      if (monthlySeries.length>=2){
        const [prev, curr] = monthlySeries.slice(-2).map(e=>e.y);
        if (prev!==0) momPct = (curr-prev)/Math.abs(prev)*100;
      }
      if (monthlySeries.length>=13){
        const lastPoint = monthlySeries[monthlySeries.length-1];
        const sameMonthPrevYearKey = `${String(+lastPoint.k.slice(0,4)-1)}-${lastPoint.k.slice(5)}`;
        const prevYear = monthlySeries.find(e=>e.k===sameMonthPrevYearKey);
        if (prevYear && prevYear.y!==0) yoyPct = (lastPoint.y - prevYear.y)/Math.abs(prevYear.y)*100;
      }

      timeExtras = {
        range: `${pts[0].d.toISOString().slice(0,10)} → ${pts[pts.length-1].d.toISOString().slice(0,10)}`,
        freq, momPct, yoyPct, monthAverages: monAvg
      };
    }
  }

  renderNarratives(narratives);

  // Charts
  buildAllCharts(rows, colInfo, dateCols, numericCols);

  return { stats, extras:{ duplicates, constantCols, highCV }, timeExtras, dateColName };
}

function renderNarratives(items){
  narrativesDiv.innerHTML="";
  items.forEach(obj=>{
    const card=document.createElement("div");
    card.className=`insight-card insight--${obj.type}`;
    const icon=document.createElement("div"); icon.className="insight-icon"; icon.textContent=obj.icon||"💡";
    const text=document.createElement("div"); text.className="insight-text";
    if (obj.tip){ const span=document.createElement("span"); span.setAttribute("data-tip",obj.tip); span.textContent=obj.text; text.appendChild(span); }
    else text.textContent=obj.text;
    const meta=document.createElement("div"); meta.className="insight-meta";
    if (obj.badge){ const b=document.createElement("span"); b.className="insight-badge"; b.textContent=obj.badge; meta.appendChild(b); }
    card.append(icon,text,meta); narrativesDiv.appendChild(card);
  });
}

// ------- Filtering -------
function getFilteredRows(rows){
  if (!globalDateFilter || !activeDateCol) return rows;
  const {min, max} = globalDateFilter;
  return rows.filter(r => {
    const d = new Date(r[activeDateCol]);
    return !isNaN(d) && d>=min && d<=max;
  });
}
function setGlobalFilterFromChart(chart){
  if (!brushLinkEnabled || !activeDateCol) return;
  const scale = chart.scales?.x;
  if (!scale) return;
  // min/max are indices for category scale; map back to labels → dates
  const labels = chart._xLabels || chart.data.labels || [];
  const fromIdx = Math.max(0, Math.floor(scale.min ?? 0));
  const toIdx = Math.min(labels.length-1, Math.ceil(scale.max ?? labels.length-1));
  const fromLabel = labels[fromIdx], toLabel = labels[toIdx];
  const min = new Date(fromLabel), max = new Date(toLabel);
  if (isNaN(min) || isNaN(max)) return;
  globalDateFilter = { min, max };
  clearFilterBtn.classList.remove("hidden");
  // Rebuild all charts with filtered rows
  buildAllCharts(globalData.rows, buildColInfo(globalData), getDateCols(), getNumericCols());
}
brushBtn.addEventListener("click", () => {
  brushLinkEnabled = !brushLinkEnabled;
  brushBtn.textContent = brushLinkEnabled ? "Brush: ON (Shift+Drag)" : "Brush Filter (Shift+Drag)";
  // show hint
  if (brushLinkEnabled) alert("Brush enabled: Hold Shift and drag on a time chart to filter all charts by the selected date range.");
});
clearFilterBtn.addEventListener("click", () => {
  globalDateFilter = null;
  clearFilterBtn.classList.add("hidden");
  buildAllCharts(globalData.rows, buildColInfo(globalData), getDateCols(), getNumericCols());
});

// ------- Charts -------
let chartOptionsBase={ responsive:true, maintainAspectRatio:true, aspectRatio:1.6 };

function clearCharts(){
  chartInstances.forEach(c=>{ try{ c.destroy?.(); }catch(e){} });
  chartInstances=[];
  ["chartCanvas1","chartCanvas2","chartCanvas3","chartCanvas4","chartCanvas5","chartCanvas6",
   "chartPareto","chartControl"].forEach(id=>{
    const el=$(id); if(el) el.style.display="none";
    const ex=el?.parentElement?.querySelector(".chart-explainer"); if (ex) ex.remove();
  });
  ["heatmap","boxplot","waterfall"].forEach(id=>{ const n=$(id); if(n) n.innerHTML=""; });
  $("bulletsWrap").innerHTML = "";
  $("smallMultiples").innerHTML = "";
}
function addExplainer(canvasId, text){
  const container=document.getElementById(canvasId)?.parentElement; if(!container) return;
  const div=document.createElement("div"); div.className="chart-explainer"; div.textContent=text; container.appendChild(div);
}
function buildColInfo({ headers, rows }){
  return headers.map(h=>{
    const vals = rows.map(r=>r[h]);
    const numCount = vals.filter(v => v!=="" && Number.isFinite(Number(v))).length;
    const dateCount = vals.filter(isDateString).length;
    const type = numCount/rows.length > 0.6 ? "numeric" : (dateCount/rows.length > 0.6 ? "date" : "categorical");
    return { name:h, type, vals };
  });
}
function getDateCols(){ return buildColInfo(globalData).filter(c=>c.type==="date").map(c=>c.name); }
function getNumericCols(){ return buildColInfo(globalData).filter(c=>c.type==="numeric").map(c=>c.name); }
function getCategoricalCols(){ return buildColInfo(globalData).filter(c=>c.type==="categorical").map(c=>c.name); }

function buildAllCharts(allRows, colInfo, dateCols, numericCols){
  clearCharts();
  const rows = getFilteredRows(allRows);
  const categoricalCols = colInfo.filter(c=>c.type==="categorical").map(c=>c.name);

  const used=new Set();

  // 1) Time series with rolling avg OR scatter with trendline
  if (dateCols.length && numericCols.length){
    renderTimeSeriesWithRolling(rows,dateCols[0],numericCols[0],"chartCanvas1",`${numericCols[0]} over ${dateCols[0]}`);
    addExplainer("chartCanvas1", `Trend over time with a rolling average. Hold Shift+Drag to brush-filter all charts.`);
    used.add(dateCols[0]); used.add(numericCols[0]);
  } else if (numericCols.length>=2){
    renderScatterWithTrend(rows,numericCols[0],numericCols[1],"chartCanvas1",`${numericCols[0]} vs ${numericCols[1]}`);
    addExplainer("chartCanvas1", `Dots and a best-fit line indicate the relationship between the two measures.`);
    used.add(numericCols[0]); used.add(numericCols[1]);
  } else if (categoricalCols.length && numericCols.length){
    renderBarCategory(rows,categoricalCols[0],numericCols[0],"chartCanvas1",`${numericCols[0]} by ${categoricalCols[0]}`);
    addExplainer("chartCanvas1", `Averages by group reveal which categories lead or lag.`);
    used.add(categoricalCols[0]); used.add(numericCols[0]);
  } else if (categoricalCols.length){
    renderBarCounts(rows,categoricalCols[0],"chartCanvas1",`Counts of ${categoricalCols[0]}`);
    addExplainer("chartCanvas1", `Distribution of category frequencies.`);
    used.add(categoricalCols[0]);
  }

  // 2) Complementary
  const remainingNumeric=numericCols.filter(n=>!used.has(n));
  const remainingCat=categoricalCols.filter(c=>!used.has(c));
  if (remainingCat.length && remainingNumeric.length){
    renderBarCategory(rows,remainingCat[0],remainingNumeric[0],"chartCanvas2",`${remainingNumeric[0]} by ${remainingCat[0]}`);
    addExplainer("chartCanvas2", `Compare averages across another grouping for contrast.`);
    used.add(remainingCat[0]); used.add(remainingNumeric[0]);
  } else if (remainingNumeric.length>=2){
    renderScatterWithTrend(rows,remainingNumeric[0],remainingNumeric[1],"chartCanvas2",`${remainingNumeric[0]} vs ${remainingNumeric[1]}`);
    addExplainer("chartCanvas2", `Second pairwise relationship with a trendline.`);
    used.add(remainingNumeric[0]); used.add(remainingNumeric[1]);
  } else if (remainingCat.length){
    renderBarCounts(rows,remainingCat[0],"chartCanvas2",`Counts of ${remainingCat[0]}`);
    addExplainer("chartCanvas2", `Category frequencies.`);
    used.add(remainingCat[0]);
  }

  // 3) Histogram
  const histNumeric = numericCols.find(n=>!used.has(n)) || numericCols[0];
  if (histNumeric){
    renderHistogram(rows,histNumeric,"chartCanvas3",`Distribution of ${histNumeric}`);
    addExplainer("chartCanvas3", `Shape of the distribution to spot skew and tails.`);
    used.add(histNumeric);
  }

  // 4) Doughnut
  if (categoricalCols.length){
    renderDoughnutTopCategories(rows,categoricalCols[0],"chartCanvas4",`Top ${categoricalCols[0]} categories`);
    addExplainer("chartCanvas4", `Proportions of the most frequent values.`);
  }

  // 5) Weekday pattern
  if (dateCols.length && numericCols.length){
    renderWeekdayPattern(rows, dateCols[0], numericCols[0], "chartCanvas5", `Weekday pattern of ${numericCols[0]}`);
    addExplainer("chartCanvas5", `Average by day of week to reveal seasonality.`);
  }

  // 6) Month-of-year pattern
  if (dateCols.length && numericCols.length){
    renderMonthPattern(rows, dateCols[0], numericCols[0], "chartCanvas6", `Month-of-year pattern of ${numericCols[0]}`);
    addExplainer("chartCanvas6", `Average by calendar month (all years combined).`);
  }

  // Box plots (Plotly)
  if (numericCols.length) renderMultiBoxPlot(rows,numericCols.slice(0,4),"boxplot","Box plots (selected metrics)");

  // Heatmap
  if (numericCols.length>=2){
    const corr = computeCorrelationsFromCols(numericCols, rows);
    if (corr && corr.matrix) renderHeatmap(corr.labels,corr.matrix,"heatmap");
  }

  // Pareto (top categories)
  if (remainingCat.length || categoricalCols.length){
    const cat = categoricalCols[0] || remainingCat[0];
    if (cat) renderPareto(rows, cat, "chartPareto", `Pareto on ${cat}`);
  }

  // Waterfall (variance explanation between recent periods)
  if (dateCols.length && numericCols.length){
    renderWaterfallMonthly(rows, dateCols[0], numericCols[0], "waterfall", "Waterfall: month-to-month contributions");
  }

  // Control chart (stability)
  if (dateCols.length && numericCols.length){
    renderControlChart(rows, dateCols[0], numericCols[0], "chartControl", `Control chart: ${numericCols[0]}`);
  }

  // KPI bullets
  if (numericCols.length){
    renderKpiBullets(rows, dateCols[0] || null, numericCols[0]);
  }

  // Small multiples (top categories)
  if (dateCols.length && numericCols.length && categoricalCols.length){
    renderSmallMultiples(rows, dateCols[0], numericCols[0], categoricalCols[0]);
  }
}

/* ---------- Chart Renderers (with zoom sync) ---------- */
function withZoomSyncOptions(options, chartRef){
  // Enable wheel/pinch zoom and Shift+Drag; when user completes a drag-zoom, propagate as global filter (if enabled)
  return {
    ...options,
    plugins: {
      ...(options.plugins || {}),
      zoom: {
        limits: { x: { min: 'original', max: 'original' }, y: { min: 'original', max: 'original' } },
        pan: { enabled: true, mode: 'x' },
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          drag: { enabled: true, modifierKey: 'shift' },
          mode: 'x',
          onZoomComplete: ({chart}) => {
            if (brushLinkEnabled) {
              setGlobalFilterFromChart(chart);
              // reset this chart so it doesn't stay zoomed (it behaved like a brush)
              try { chart.resetZoom(); } catch(e){}
            }
          }
        }
      }
    }
  };
}

function renderTimeSeriesWithRolling(rows, dateCol, numCol, canvasId, title){
  const canvas=$(canvasId);
  const pairs=rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]) }))
    .filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  if (!pairs.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=pairs.map(p=>p.d.toISOString().slice(0,10));
  const data=pairs.map(p=>p.v);
  const freq=detectFrequency(pairs.map(p=>p.d));
  const w = freq==="daily" ? 7 : (freq==="weekly" ? 4 : 3);
  const roll = rollingMean(data, w).map(v=> v===null ? null : round(v,2));
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"line",
    data:{ labels,
      datasets:[
        { label:title, data, borderColor:"#6ee7b7", backgroundColor:"rgba(110,231,183,0.08)", tension:0.25 },
        { label:`${w}-period rolling avg`, data:roll, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", borderDash:[6,4], tension:0.2, spanGaps:true }
      ]},
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ ...(chartOptionsBase.plugins||{}), legend:{ display:true } }, interaction:{ mode:'index', intersect:false } }, canvas),
  });
  canvas._chart._xLabels = labels;
  chartInstances.push(canvas._chart);
}

function renderScatterWithTrend(rows, xCol, yCol, canvasId, title){
  const canvas=$(canvasId); canvas.style.display="block";
  const pts=rows.map(r=>{ const x=toNumber(r[xCol]), y=toNumber(r[yCol]); return (x!==null&&y!==null)?{x,y}:null; }).filter(Boolean);
  if (!pts.length){ canvas.style.display="none"; return; }
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const { slope, intercept } = linreg(xs, ys);
  const minX=Math.min(...xs), maxX=Math.max(...xs);
  const line=[{x:minX, y: slope*minX + intercept}, {x:maxX, y: slope*maxX + intercept}];
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"scatter",
    data:{ datasets:[
      { label:title, data:pts, pointBackgroundColor:"#60a5fa" },
      { type:"line", label:"Trendline", data:line, parsing:false, segment:{ borderDash:[6,4] }, borderColor:"#6ee7b7", pointRadius:0 }
    ]},
    options: withZoomSyncOptions({ ...chartOptionsBase, parsing:false, scales:{ x:{ title:{ display:true,text:xCol }}, y:{ title:{ display:true,text:yCol }}}}, canvas)
  });
  chartInstances.push(canvas._chart);
}

function renderBarCategory(rows,catCol,numCol,canvasId,title){
  const canvas=$(canvasId);
  const agg={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); const v=toNumber(r[numCol]);
    if(!agg[k]) agg[k]={sum:0,count:0}; if(v!==null){ agg[k].sum+=v; agg[k].count+=1; }});
  const entries=Object.entries(agg).map(([k,v])=>({k,avg:v.count?v.sum/v.count:0})).sort((a,b)=>b.avg-a.avg).slice(0,20);
  if (!entries.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=entries.map(e=>e.k), data=entries.map(e=>round(e.avg,2));
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"bar",
    data:{ labels, datasets:[{ label:title, data, backgroundColor:"#f59e0b" }]},
    options: withZoomSyncOptions({ ...chartOptionsBase, indexAxis:'y', plugins:{ legend:{ display:false } } }, canvas)
  }); chartInstances.push(canvas._chart);
}
function renderBarCounts(rows,catCol,canvasId,title){
  const canvas=$(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,20);
  if (!entries.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=entries.map(e=>e[0]), data=entries.map(e=>e[1]);
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"bar",
    data:{ labels, datasets:[{ label:title, data, backgroundColor:"#60a5fa" }]},
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{ display:false } } }, canvas)
  }); chartInstances.push(canvas._chart);
}
function renderHistogram(rows,col,canvasId,title){
  const canvas=$(canvasId);
  const vals=rows.map(r=>toNumber(r[col])).filter(v=>v!==null); if (!vals.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const min=Math.min(...vals), max=Math.max(...vals), bins=12, binSize=(max-min)/bins||1, counts=Array(bins).fill(0);
  vals.forEach(v=>{ const idx=Math.min(bins-1, Math.floor((v-min)/binSize)); counts[idx]+=1; });
  const labels=counts.map((_,i)=>`${round(min+i*binSize,2)}-${round(min+(i+1)*binSize,2)}`);
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"bar",
    data:{ labels, datasets:[{ label:title, data:counts, backgroundColor:"#a78bfa" }]},
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{ display:false } } }, canvas)
  }); chartInstances.push(canvas._chart);
}
function renderDoughnutTopCategories(rows,catCol,canvasId,title){
  const canvas=$(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  const entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8); if(!entries.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=entries.map(e=>e[0]), data=entries.map(e=>e[1]);
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart=new Chart(ctx,{ type:"doughnut",
    data:{ labels, datasets:[{ label:title, data }] },
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{ position:'bottom' } } }, canvas)
  }); chartInstances.push(canvas._chart);
}

// Plotly helpers
function renderMultiBoxPlot(rows, cols, containerId, title){
  const el=$(containerId);
  const traces = cols.map(c => {
    const vals=rows.map(r=>toNumber(r[c])).filter(v=>v!==null);
    return vals.length ? { y: vals, type:'box', name: c, boxpoints:'outliers' } : null;
  }).filter(Boolean);
  if (!traces.length){ el.innerHTML=""; return; }
  Plotly.newPlot(el, traces, { title, margin:{l:50,r:20,t:30,b:30}, autosize:true, height:220 }, { responsive:true });
}
function renderHeatmap(labels,matrix,containerId){
  const el=$(containerId); el.innerHTML="";
  const data=[{ z:matrix, x:labels, y:labels, type:'heatmap', colorscale:'RdBu', zmin:-1, zmax:1, colorbar:{ title:'r' } }];
  const layout={ margin:{l:80,r:30,t:30,b:80}, autosize:true, title:'Correlation Heatmap', height:220 };
  Plotly.newPlot(el, data, layout, { responsive:true });
}

// Pareto (bar + cumulative line)
function renderPareto(rows, catCol, canvasId, title){
  const canvas=$(canvasId);
  const freq={}; rows.forEach(r=>{ const k=(r[catCol]==null||r[catCol]==="")?"(missing)":String(r[catCol]); freq[k]=(freq[k]||0)+1; });
  let entries=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12);
  if (!entries.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=entries.map(e=>e[0]);
  const counts=entries.map(e=>e[1]);
  const total = counts.reduce((a,b)=>a+b,0);
  const cum=[]; let s=0; counts.forEach(v=>{ s+=v; cum.push(round((s/total)*100,1)); });
  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [
      { label: "Count", data: counts, backgroundColor:"#60a5fa", yAxisID: 'y' },
      { type: "line", label: "Cumulative %", data: cum, yAxisID: 'y1', borderColor:"#6ee7b7", pointRadius:2, tension:0.2 }
    ]},
    options: withZoomSyncOptions({
      ...chartOptionsBase,
      scales: {
        y: { beginAtZero:true, title:{display:true,text:"Count"} },
        y1: { position:'right', min:0, max:100, ticks:{ callback:v=>v+"%" }, grid:{ drawOnChartArea:false } }
      }
    }, canvas)
  });
  chartInstances.push(canvas._chart);
}

// Waterfall (month-to-month deltas, Plotly)
function renderWaterfallMonthly(rows, dateCol, numCol, containerId, title){
  const el=$(containerId); el.innerHTML="";
  const pts = rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]) }))
    .filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  if (pts.length<3) return;
  // Build monthly average series
  const map=new Map();
  pts.forEach(p=>{ const k=ymKey(p.d); const o=map.get(k)||{sum:0,count:0}; o.sum+=p.v; o.count++; map.set(k,o); });
  const series=Array.from(map.entries()).map(([k,v])=>({k, y:v.sum/v.count})).sort((a,b)=>a.k.localeCompare(b.k));
  if (series.length<3) return;

  // Deltas between months
  const x=[], measure=[], y=[];
  x.push(series[0].k); measure.push("absolute"); y.push(series[0].y);
  for(let i=1;i<series.length;i++){
    x.push(series[i].k); measure.push("relative"); y.push(round(series[i].y - series[i-1].y,2));
  }
  x.push("Total"); measure.push("total"); y.push(series[series.length-1].y);

  Plotly.newPlot(el, [{
    type: "waterfall", x, measure, y,
    decreasing: { marker: { color: "#f87171" } },
    increasing: { marker: { color: "#34d399" } },
    totals: { marker: { color: "#60a5fa" } }
  }], { title, margin:{l:50,r:20,t:30,b:30}, autosize:true, height:220 }, { responsive:true });
}

// Control chart (Shewhart)
function renderControlChart(rows, dateCol, numCol, canvasId, title){
  const canvas=$(canvasId);
  const pts = rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]) }))
    .filter(p=>!isNaN(p.d.valueOf())&&p.v!==null).sort((a,b)=>a.d-b.d);
  if (!pts.length){ canvas.style.display="none"; return; }
  canvas.style.display="block";
  const labels=pts.map(p=>p.d.toISOString().slice(0,10));
  const data=pts.map(p=>p.v);
  const mean = arrayMean(data);
  const sd = arrayStd(data);
  const ucl = mean + 3*sd, lcl = mean - 3*sd;
  const pointBg = data.map(v => (v>ucl || v<lcl) ? "#f87171" : "#6ee7b7");

  const ctx=canvas.getContext("2d");
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(ctx, {
    type:"line",
    data:{ labels, datasets:[
      { label:title, data, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", tension:0.1, pointBackgroundColor: pointBg, pointRadius:2 },
      { label:"Mean", data: labels.map(()=>mean), borderColor:"#e5e7eb", borderDash:[4,4], pointRadius:0 },
      { label:"UCL (+3σ)", data: labels.map(()=>ucl), borderColor:"#f87171", borderDash:[6,4], pointRadius:0 },
      { label:"LCL (-3σ)", data: labels.map(()=>lcl), borderColor:"#f87171", borderDash:[6,4], pointRadius:0 }
    ]},
    options: withZoomSyncOptions({ ...chartOptionsBase, plugins:{ legend:{ display:true } }, interaction:{ mode:'index', intersect:false } }, canvas)
  });
  canvas._chart._xLabels = labels;
  chartInstances.push(canvas._chart);
}

// KPI Bullets: three bullets (Current vs Target)
function renderKpiBullets(rows, dateCol, numCol){
  const wrap = $("bulletsWrap"); wrap.innerHTML = "";
  const vals = rows.map(r=>toNumber(r[numCol])).filter(v=>v!==null);
  if (!vals.length) return;

  // Choose metrics
  const current = round(vals[vals.length-1],2);
  const p90 = round(quantile(vals,0.9),2);
  const avg  = round(arrayMean(vals),2);
  const max  = Math.max(...vals, p90, avg) * 1.1;

  const bullets = [
    { label:`${numCol} (current)`, value: current, target: p90 },
    { label:`${numCol} (average)`, value: avg, target: p90 },
    { label:`Target (P90)`, value: p90, target: p90 }
  ];

  bullets.forEach((b,i)=>{
    const host=document.createElement("div"); host.className="bullet";
    host.innerHTML=`<canvas id="bullet${i}"></canvas>`;
    wrap.appendChild(host);
    renderBulletChart(`bullet${i}`, b.label, b.value, b.target, max);
  });
}

// Bullet (horizontal bar + target marker)
function renderBulletChart(canvasId, label, value, target, maxVal){
  const canvas=$(canvasId);
  const ctx=canvas.getContext("2d");
  const targetLine = {
    id: 'targetLine',
    afterDatasetsDraw(chart, args, pluginOptions) {
      const {ctx, chartArea:{left,right,top,bottom}, scales:{x,y}} = chart;
      const xPos = x.getPixelForValue(target);
      ctx.save();
      ctx.strokeStyle = "#f59e0b"; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(xPos, top); ctx.lineTo(xPos, bottom); ctx.stroke();
      ctx.restore();
    }
  };
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(ctx, {
    type: "bar",
    data: { labels:[label], datasets:[
      { label:"Value", data:[value], backgroundColor:"#6ee7b7", borderRadius:8, barPercentage:0.8 }
    ]},
    options: {
      responsive:true, maintainAspectRatio:true, aspectRatio:2.4,
      indexAxis:'y',
      scales: { x:{ min:0, max:maxVal, ticks:{ callback:v=>String(v) } }, y:{ display:true } },
      plugins:{ legend:{ display:false }, zoom:false }
    },
    plugins:[targetLine]
  });
  chartInstances.push(canvas._chart);
}

// Small multiples: top K categories, time series of numeric
function renderSmallMultiples(rows, dateCol, numCol, catCol){
  const root=$("smallMultiples"); root.innerHTML="";
  const valid = rows.map(r=>({ d:new Date(r[dateCol]), v:toNumber(r[numCol]), c:String(r[catCol]||"(missing)") }))
    .filter(p=>!isNaN(p.d)&&p.v!==null);
  if (!valid.length) return;
  const freq={}; valid.forEach(p=>{ freq[p.c]=(freq[p.c]||0)+1; });
  const topCats=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(e=>e[0]);

  topCats.forEach((cat,idx)=>{
    const div=document.createElement("div"); div.className="mini-chart";
    const id=`sm${idx}`; div.innerHTML=`<small style="color:#dbeafe">${cat}</small><canvas id="${id}"></canvas>`;
    root.appendChild(div);

    const subset=valid.filter(p=>p.c===cat).sort((a,b)=>a.d-b.d);
    // aggregate by day
    const map=new Map();
    subset.forEach(p=>{ const k=p.d.toISOString().slice(0,10); const o=map.get(k)||{sum:0,count:0}; o.sum+=p.v; o.count++; map.set(k,o); });
    const labels=Array.from(map.keys());
    const data=labels.map(k=>round(map.get(k).sum/map.get(k).count,2));

    const canvas=$(id);
    const ctx=canvas.getContext("2d");
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart=new Chart(ctx,{ type:"line",
      data:{ labels, datasets:[{ label:numCol, data, borderColor:"#60a5fa", backgroundColor:"rgba(96,165,250,0.08)", pointRadius:0, tension:0.2 }]},
      options: withZoomSyncOptions({ responsive:true, maintainAspectRatio:true, aspectRatio:2.0, plugins:{ legend:{ display:false } }, interaction:{ intersect:false } }, canvas)
    });
    canvas._chart._xLabels = labels;
    chartInstances.push(canvas._chart);
  });
}

// Correlations (for heatmap)
function computeCorrelationsFromCols(numericCols, rows){
  if (numericCols.length<2) return null;
  const arrays = numericCols.map(col => rows.map(r => toNumber(r[col])));
  const n = numericCols.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i=0;i<n;i++){
    for (let j=0;j<n;j++){
      const ai = arrays[i], aj = arrays[j];
      const paired=[];
      for (let t=0;t<ai.length;t++){ const a=ai[t], b=aj[t]; if(a!==null && b!==null) paired.push([a,b]); }
      if (paired.length<2){ matrix[i][j]=0; continue; }
      const xs=paired.map(p=>p[0]), ys=paired.map(p=>p[1]);
      matrix[i][j]=pearson(xs,ys);
    }
  }
  return { labels:numericCols, matrix };
}
function pearson(x,y){
  if (x.length<2) return 0; const n=x.length;
  const mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){ num+=(x[i]-mx)*(y[i]-my); dx+=(x[i]-mx)**2; dy+=(y[i]-my)**2; }
  const denom=Math.sqrt(dx*dy); return denom===0?0:num/denom;
}

// ------- Export PDF -------
exportPdfBtn.addEventListener("click", async () => {
  exportPdfBtn.disabled=true; exportPdfBtn.textContent="Preparing PDF...";
  try{
    const node=document.querySelector("main");
    const canvas=await html2canvas(node,{ scale:2, backgroundColor:'#071121' });
    const img=canvas.toDataURL('image/png');
    const { jsPDF }=window.jspdf;
    const pdf=new jsPDF({ orientation:'landscape', unit:'pt', format:[canvas.width, canvas.height]});
    pdf.addImage(img,'PNG',0,0,canvas.width,canvas.height);
    pdf.save('insights-report.pdf');
  } catch(e){ alert("PDF export failed: "+e.message); }
  finally{ exportPdfBtn.textContent="Export Report (PDF)"; exportPdfBtn.disabled=false; }
});

// ------- Reset -------
resetBtn.addEventListener("click", () => {
  globalData={ headers:[], rows:[] }; fileInput.value="";
  summarySection.classList.add("hidden");
  insightsSection.classList.add("hidden");
  rawSection.classList.add("hidden");
  metricsSection.classList.add("hidden");
  summaryCards.innerHTML=""; metricsCards.innerHTML="";
  datasetPreview.textContent=""; dataTable.innerHTML="";
  narrativesDiv.innerHTML=""; clearCharts(); resetProgress();
  clearHighlights(); closeDock(); window.scrollTo({ top:0, behavior:"smooth" });
  activeDateCol=null; globalDateFilter=null; brushLinkEnabled=false;
  brushBtn.disabled=true; clearFilterBtn.classList.add("hidden"); brushBtn.textContent="Brush Filter (Shift+Drag)";
});

/* -------------------- Compact Annotation Dock (unchanged) -------------------- */
let annotMode="off"; // "off" | "marker" | "eraser"
let isDrawing=false, ctxA=null, dpr=window.devicePixelRatio||1;
let markerColor="rgba(255,235,59,0.55)";
let markerWidth=12;

function sizeAnnotCanvas(){
  const w=window.innerWidth, h=window.innerHeight;
  annotCanvas.width=Math.floor(w*dpr); annotCanvas.height=Math.floor(h*dpr);
  annotCanvas.style.width=w+"px"; annotCanvas.style.height=h+"px";
  ctxA=annotCanvas.getContext("2d");
  ctxA.setTransform(dpr,0,0,dpr,0,0);
}
function setAnnotMode(mode){
  annotMode=mode;
  annotWrapper.classList.remove("active","marker","eraser","hidden");
  markerBtn.classList.toggle("active", mode==="marker");
  eraserBtn.classList.toggle("active", mode==="eraser");
  if (mode==="off"){ annotWrapper.classList.add("hidden"); return; }
  annotWrapper.classList.add("active", mode);
  sizeAnnotCanvas();
}
function clearHighlights(){ if(!ctxA) return; ctxA.clearRect(0,0,annotCanvas.width,annotCanvas.height); }
function startDraw(x,y){
  if (annotMode==="off") return;
  isDrawing=true;
  ctxA.lineCap="round"; ctxA.lineJoin="round";
  ctxA.lineWidth=annotMode==="marker" ? markerWidth : Math.max(markerWidth*1.6, 20);
  if (annotMode==="marker"){ ctxA.globalCompositeOperation="source-over"; ctxA.strokeStyle=markerColor; }
  else{ ctxA.globalCompositeOperation="destination-out"; ctxA.strokeStyle="rgba(0,0,0,1)"; }
  ctxA.beginPath(); ctxA.moveTo(x,y);
}
function continueDraw(x,y){ if(!isDrawing) return; ctxA.lineTo(x,y); ctxA.stroke(); }
function endDraw(){ if(!isDrawing) return; isDrawing=false; ctxA.closePath(); }
function getXY(evt){ const r=annotCanvas.getBoundingClientRect(); const cx=evt.touches?evt.touches[0].clientX:evt.clientX; const cy=evt.touches?evt.touches[0].clientY:evt.clientY; return { x: cx - r.left, y: cy - r.top }; }

// Mouse/touch
annotCanvas.addEventListener("mousedown", e => { if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); startDraw(x,y); });
annotCanvas.addEventListener("mousemove", e => { if(annotMode==="off") return; const {x,y}=getXY(e); continueDraw(x,y); });
window.addEventListener("mouseup", endDraw);
annotCanvas.addEventListener("touchstart", e => { if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); startDraw(x,y); }, {passive:false});
annotCanvas.addEventListener("touchmove", e => { if(annotMode==="off") return; e.preventDefault(); const {x,y}=getXY(e); continueDraw(x,y); }, {passive:false});
annotCanvas.addEventListener("touchend", endDraw);

// Dock animations
function openDock(){ annotPanel.classList.add("animate-in"); annotPanel.classList.remove("hidden","animate-out"); showDock(); }
function closeDock(){ annotPanel.classList.remove("animate-in"); annotPanel.classList.add("animate-out");
  setTimeout(()=>{ annotPanel.classList.add("hidden"); annotPanel.classList.remove("animate-out"); }, 160); paletteHide(); }
annotToggle.addEventListener("click", () => { if (annotPanel.classList.contains("hidden")) openDock(); else closeDock(); });
markerBtn.addEventListener("click", () => { if (annotMode==="marker"){ clearHighlights(); setAnnotMode("off"); } else { setAnnotMode("marker"); } });
eraserBtn.addEventListener("click", () => { setAnnotMode(annotMode==="eraser" ? "off" : "eraser"); });

// Palette
function paletteShow(){ palettePop.classList.remove("hidden","pop-out"); palettePop.classList.add("pop-in"); }
function paletteHide(){ if (palettePop.classList.contains("hidden")) return; palettePop.classList.remove("pop-in"); palettePop.classList.add("pop-out"); setTimeout(()=>{ palettePop.classList.add("hidden"); palettePop.classList.remove("pop-out"); }, 120); }
paletteToggle.addEventListener("click", e => { e.stopPropagation(); if (palettePop.classList.contains("hidden")) paletteShow(); else paletteHide(); });
document.addEventListener("click", e => { if (!palettePop.contains(e.target) && !paletteToggle.contains(e.target)) paletteHide(); });
swatches().forEach((btn, i) => { if (i===0) btn.classList.add("active"); btn.addEventListener("click", () => { swatches().forEach(b => b.classList.remove("active")); btn.classList.add("active"); markerColor = btn.dataset.color; }); });
widthRange.addEventListener("input", () => { markerWidth = parseInt(widthRange.value, 10); widthVal.textContent = `${markerWidth}px`; });
clearAnnotsBtn.addEventListener("click", clearHighlights);

// Auto-hide dock
let scrollHideTimer=null;
function hideDock(){ annotDock.classList.add("dock-hidden"); paletteHide(); }
function showDock(){ annotDock.classList.remove("dock-hidden"); }
window.addEventListener("scroll", () => { hideDock(); clearTimeout(scrollHideTimer); scrollHideTimer = setTimeout(showDock, 600); }, { passive: true });
window.addEventListener("mousemove", showDock, { passive: true });
window.addEventListener("touchstart", showDock, { passive: true });

// ------- Export PDF -------
exportPdfBtn.addEventListener("click", async () => {
  exportPdfBtn.disabled=true; exportPdfBtn.textContent="Preparing PDF...";
  try{
    const node=document.querySelector("main");
    const canvas=await html2canvas(node,{ scale:2, backgroundColor:'#071121' });
    const img=canvas.toDataURL('image/png');
    const { jsPDF }=window.jspdf;
    const pdf=new jsPDF({ orientation:'landscape', unit:'pt', format:[canvas.width, canvas.height]});
    pdf.addImage(img,'PNG',0,0,canvas.width,canvas.height);
    pdf.save('insights-report.pdf');
  } catch(e){ alert("PDF export failed: "+e.message); }
  finally{ exportPdfBtn.textContent="Export Report (PDF)"; exportPdfBtn.disabled=false; }
});

// ------- Init -------
(function init(){
  summarySection.classList.add("hidden");
  insightsSection.classList.add("hidden");
  rawSection.classList.add("hidden");
  metricsSection.classList.add("hidden");
  sizeAnnotCanvas();
  setTimeout(showDock, 300);
})();
