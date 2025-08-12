/* Dataset Analyzer — Preprocessing v1.7
   + Upload progress bar
   + Small processing progress bar (per-step)
   + NEW Dataset Information block (summary + per-column stats)
   - Pipeline builder (enable/disable, reorder, params)
   - IQR capping, encoding, scaling
   - Stratified & time-based splits
   - Before/After diff
   - Import/Export pipeline JSON
*/

const $ = (id) => document.getElementById(id);

/* ------------ State ------------ */
let inData = { headers: [], rows: [] };      // original
let outData = { headers: [], rows: [] };     // after pipeline
let inferredTypes = {};                      // {col: 'numeric'|'categorical'|'date'|'boolean'|'text'}

/* Controls */
const btnUseCached = $("btnUseCached");
const btnImportPipe = $("btnImportPipe");
const btnExportPipe = $("btnExportPipe");
const btnApply = $("btnApply");
const btnDownload = $("btnDownload");
const btnSendToDashboard = $("btnSendToDashboard");
const ppFile = $("ppFile");
const tblIn = $("tblIn");
const tblOut = $("tblOut");
const pipeList = $("pipeList");
const strataLabel = $("strataLabel");
const strataPct = $("strataPct");
const timeDateCol = $("timeDateCol");
const timePct = $("timePct");
const pipeImportFile = $("pipeImportFile");
const stepChooser = $("stepChooser");
const btnAddSelected = $("btnAddSelected");

/* Progress UI refs */
const uploadBar = $("uploadBar");
const uploadLabel = $("uploadLabel");
const uploadRight = $("uploadRight");
const procBar = $("procBar");
const procLabel = $("procLabel");
const procRight = $("procRight");

/* Dataset Info UI refs */
const infoSource = $("infoSource");
const dsBadges = $("dsBadges");
const colInfoTable = $("colInfoTable");

/* ------------ Helpers ------------ */
const toNum = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(+v) ? +v : null));
const round = (n, p = 6) => Math.round((n + Number.EPSILON) * 10 ** p) / 10 ** p;
const uniq = (arr) => Array.from(new Set(arr));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const tick = () => new Promise((r) => setTimeout(r, 0));

function detectTypes(headers, rows) {
  const types = {};
  for (const h of headers) {
    const vals = rows.map((r) => r[h]);
    const nums = vals.filter((v) => v !== "" && Number.isFinite(Number(v))).length;
    const dates = vals.filter((v) => v && !isNaN(new Date(v))).length;
    const bools = vals.filter((v) => ["true", "false", "0", "1", 0, 1, true, false].includes(String(v).toLowerCase())).length;
    let t = "categorical";
    if (rows.length && nums / rows.length > 0.6) t = "numeric";
    else if (rows.length && dates / rows.length > 0.6) t = "date";
    else if (rows.length && bools / rows.length > 0.6) t = "boolean";
    types[h] = t;
  }
  return types;
}

function renderSelectOptions(sel, items, placeholder = "") {
  sel.innerHTML = "";
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = placeholder;
    sel.appendChild(opt);
  }
  items.forEach((it) => {
    const opt = document.createElement("option");
    opt.value = it; opt.textContent = it;
    sel.appendChild(opt);
  });
}

function setMeta() {
  $("metaRows").textContent = `Rows: ${inData.rows.length}`;
  $("metaCols").textContent = `Cols: ${inData.headers.length}`;
  $("metaRowsOut").textContent = `Rows: ${outData.rows.length}`;
  $("metaColsOut").textContent = `Cols: ${outData.headers.length}`;
}

function previewTable(table, headers, rows, diffAgainst = null) {
  table.innerHTML = "";
  if (!headers.length) return;
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  headers.forEach((h) => {
    const th = document.createElement("th"); th.textContent = h; trh.appendChild(th);
  });
  thead.appendChild(trh); table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const n = Math.min(30, rows.length);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const tr = document.createElement("tr");
    headers.forEach((h) => {
      const td = document.createElement("td");
      td.textContent = r[h];
      if (diffAgainst) {
        const b = diffAgainst[i] || {};
        if (!(h in b)) td.classList.add("added");
        else if (String(b[h]) !== String(r[h])) td.classList.add("changed");
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

/* ---------- Badges (top-right card) ---------- */
function setBadges(data) {
  const { headers, rows } = data;
  const el = $("qualityBadges");
  if (!el) return;
  el.innerHTML = "";
  if (!rows.length || !headers.length) return;

  // completeness
  const total = headers.length * rows.length;
  let missing = 0;
  rows.forEach((r) => headers.forEach((h) => { if (r[h] === "" || r[h] == null) missing++; }));
  const complete = total ? (1 - missing / total) * 100 : 100;

  // duplicates
  const seen = new Set(); let dup = 0;
  rows.forEach((r) => { const k = JSON.stringify(r); if (seen.has(k)) dup++; else seen.add(k); });

  // skewed numeric
  const types = detectTypes(headers, rows);
  const numCols = headers.filter((h) => types[h] === "numeric");
  const skewed = [];
  numCols.forEach((c) => {
    const vals = rows.map((r) => toNum(r[c])).filter((v) => v !== null).sort((a, b) => a - b);
    if (vals.length < 3) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
    const skew = (3 * (mean - median)) / sd;
    if (Math.abs(skew) >= 0.8) skewed.push(c);
  });

  const badges = [
    `Completeness: ${round(complete, 1)}%`,
    `Rows: ${rows.length.toLocaleString()}`,
    `Columns: ${headers.length}`,
    `Duplicates: ${dup}`,
    `Skewed cols: ${skewed.length}`
  ];
  badges.forEach((b) => {
    const span = document.createElement("span");
    span.className = "badge"; span.textContent = b;
    el.appendChild(span);
  });
}

/* ---------- NEW: Dataset Information (summary + per-column) ---------- */
function setInfoBadges(data) {
  dsBadges.innerHTML = "";
  const { headers, rows } = data;
  if (!rows.length || !headers.length) return;

  const types = detectTypes(headers, rows);
  const numCount = headers.filter(h => types[h] === "numeric").length;
  const catCount = headers.filter(h => types[h] === "categorical").length;
  const dateCount = headers.filter(h => types[h] === "date").length;
  const boolCount = headers.filter(h => types[h] === "boolean").length;

  // completeness + duplicates
  const total = headers.length * rows.length;
  let missing = 0;
  rows.forEach(r => headers.forEach(h => { if (r[h] === "" || r[h] == null) missing++; }));
  const complete = total ? (1 - missing / total) * 100 : 100;

  const seen = new Set(); let dup = 0;
  rows.forEach(r => { const k = JSON.stringify(r); if (seen.has(k)) dup++; else seen.add(k); });

  const badges = [
    `Rows: ${rows.length.toLocaleString()}`,
    `Cols: ${headers.length}`,
    `Complete: ${round(complete,1)}%`,
    `Duplicates: ${dup}`,
    `Numeric: ${numCount}`,
    `Categorical: ${catCount}`,
    `Date: ${dateCount}`,
    `Boolean: ${boolCount}`
  ];
  badges.forEach(text => {
    const s = document.createElement("span");
    s.className = "badge"; s.textContent = text;
    dsBadges.appendChild(s);
  });
}

function renderColInfo(data) {
  colInfoTable.innerHTML = "";
  const { headers, rows } = data;
  if (!rows.length || !headers.length) return;

  const types = detectTypes(headers, rows);

  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  ["Column","Type","Missing %","Unique","Example / Top","Min","Mean","Max"].forEach(h => {
    const th = document.createElement("th"); th.textContent = h; trh.appendChild(th);
  });
  thead.appendChild(trh); colInfoTable.appendChild(thead);

  const tbody = document.createElement("tbody");
  headers.forEach((col) => {
    const t = types[col];
    const row = document.createElement("tr");

    // Missing %
    const miss = rows.filter(r => r[col] === "" || r[col] == null).length;
    const missPct = rows.length ? round((miss/rows.length)*100, 1) : 0;

    // Unique (non-empty)
    const uniqVals = new Set(rows.map(r => r[col]).filter(v => v !== "" && v != null));
    const uniqCount = uniqVals.size;

    // Example / Top
    let example = "";
    if (t === "numeric") {
      example = "";
    } else if (t === "date") {
      const ds = rows.map(r => new Date(r[col])).filter(d => !isNaN(d));
      if (ds.length) {
        const minD = new Date(Math.min(...ds)), maxD = new Date(Math.max(...ds));
        example = `${minD.toISOString().slice(0,10)} → ${maxD.toISOString().slice(0,10)}`;
      }
    } else {
      const freq = {};
      rows.forEach(r => { const k = String(r[col] ?? ""); if (k) freq[k] = (freq[k]||0)+1; });
      const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k} (${v})`);
      example = top.join(", ");
    }

    // Numeric stats
    let min="", mean="", max="";
    if (t === "numeric") {
      const vals = rows.map(r => toNum(r[col])).filter(v => v !== null);
      if (vals.length) {
        min = round(Math.min(...vals), 6);
        max = round(Math.max(...vals), 6);
        mean = round(vals.reduce((a,b)=>a+b,0)/vals.length, 6);
      }
    } else if (t === "date") {
      const ds = rows.map(r => new Date(r[col])).filter(d => !isNaN(d));
      if (ds.length) {
        min = new Date(Math.min(...ds)).toISOString().slice(0,10);
        max = new Date(Math.max(...ds)).toISOString().slice(0,10);
      }
    }

    const cells = [
      col,
      t,
      `${missPct}%`,
      String(uniqCount),
      example,
      String(min),
      String(mean),
      String(max)
    ];
    cells.forEach(v => { const td=document.createElement("td"); td.textContent = v; row.appendChild(td); });
    tbody.appendChild(row);
  });
  colInfoTable.appendChild(tbody);
}

function renderDatasetInfo() {
  const src = (infoSource?.value || "after");
  const data = (src === "after" && outData.rows.length) ? outData : inData;
  setInfoBadges(data);
  renderColInfo(data);
}

/* ---------- Upload progress helpers ---------- */
function setUploadProgress(pct, left = "", right = "") {
  uploadBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (left) uploadLabel.textContent = left;
  if (right || right === "") uploadRight.textContent = right;
}
function resetUploadProgress() {
  setUploadProgress(0, "Waiting for file…", "");
}

/* ---------- File loading + upload progress ---------- */
ppFile.addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const name = f.name.toLowerCase();

  if (name.endsWith(".csv")) {
    const reader = new FileReader();
    reader.onloadstart = () => setUploadProgress(0, "Reading CSV…", "0%");
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setUploadProgress(pct, "Reading CSV…", `${pct}%`);
      }
    };
    reader.onload = (ev) => {
      setUploadProgress(100, "Parsing CSV…", "");
      Papa.parse(ev.target.result, {
        header: true, skipEmptyLines: true, complete: (res) => {
          const headers = Object.keys(res.data[0] || {});
          const rows = res.data.map((r) => { const o = {}; headers.forEach((h) => (o[h] = r[h] ?? "")); return o; });
          inData = { headers, rows }; outData = { headers: [...headers], rows: [...rows] };
          inferredTypes = detectTypes(headers, rows);
          refreshAll();
          setUploadProgress(100, "Uploaded ✓", `${rows.length.toLocaleString()} rows`);
          setTimeout(() => resetUploadProgress(), 1500);
        },
        error: (err) => {
          uploadLabel.textContent = "Parse error";
          uploadRight.textContent = err?.message || "CSV";
        }
      });
    };
    reader.onerror = () => { uploadLabel.textContent = "Read error"; uploadRight.textContent = ""; };
    reader.readAsText(f);
  } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const reader = new FileReader();
    reader.onloadstart = () => setUploadProgress(0, "Reading XLSX…", "0%");
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        setUploadProgress(pct, "Reading XLSX…", `${pct}%`);
      }
    };
    reader.onload = (ev) => {
      setUploadProgress(100, "Parsing XLSX…", "");
      const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const headers = Object.keys(json[0] || {});
      const rows = json.map((r) => { const o = {}; headers.forEach((h) => (o[h] = r[h] ?? "")); return o; });
      inData = { headers, rows }; outData = { headers: [...headers], rows: [...rows] };
      inferredTypes = detectTypes(headers, rows);
      refreshAll();
      setUploadProgress(100, "Uploaded ✓", `${rows.length.toLocaleString()} rows`);
      setTimeout(() => resetUploadProgress(), 1500);
    };
    reader.onerror = () => { uploadLabel.textContent = "Read error"; uploadRight.textContent = ""; };
    reader.readAsArrayBuffer(f);
  } else {
    alert("Please load a CSV or XLSX file.");
  }
});

btnUseCached.addEventListener("click", () => {
  try {
    const cached = localStorage.getItem("da_data");
    if (!cached) return alert("No dataset found in Dashboard cache.");
    const obj = JSON.parse(cached);
    if (!obj?.headers?.length || !obj?.rows?.length) return alert("Cached dataset is empty.");
    inData = obj; outData = { headers: [...obj.headers], rows: [...obj.rows] };
    inferredTypes = detectTypes(inData.headers, inData.rows);
    refreshAll();
    setUploadProgress(100, "Loaded from Dashboard ✓", `${inData.rows.length.toLocaleString()} rows`);
    setTimeout(() => resetUploadProgress(), 1500);
  } catch { alert("Unable to read cached dataset."); }
});

/* ---------- Pipeline steps (unchanged) ---------- */
const STEP_LIBRARY = {
  dropMissingAny: {
    name: "Drop rows with ANY missing",
    editor: ({ params }) => `
      <label>Columns (optional, comma-separated): <input type="text" data-key="cols" value="${params.cols || ""}" placeholder="empty = all columns"></label>
    `,
    apply: (data, { cols }) => {
      const headers = data.headers;
      const colsArr = (cols || "").split(",").map(s => s.trim()).filter(Boolean);
      const target = colsArr.length ? colsArr : headers;
      const rows = data.rows.filter(r => !target.some(h => r[h] === "" || r[h] == null));
      return { headers: data.headers, rows };
    },
    defaultParams: { cols: "" }
  },
  fillNumeric: {
    name: "Fill numeric missing",
    editor: ({ params }) => `
      <label>Strategy
        <select data-key="strategy">
          <option value="mean" ${params.strategy==="mean"?"selected":""}>Mean</option>
          <option value="median" ${params.strategy==="median"?"selected":""}>Median</option>
        </select>
      </label>
      <label>Columns (optional): <input type="text" data-key="cols" value="${params.cols || ""}" placeholder="empty = all numeric"></label>
    `,
    apply: (data, { strategy, cols }) => {
      const types = detectTypes(data.headers, data.rows);
      const allNum = data.headers.filter(h => types[h] === "numeric");
      const target = (cols || "").split(",").map(s=>s.trim()).filter(Boolean);
      const colsUse = target.length ? target : allNum;
      if (!colsUse.length) return data;

      const stats = {};
      colsUse.forEach(c => {
        const nums = data.rows.map(r => toNum(r[c])).filter(v => v !== null).sort((a,b)=>a-b);
        if (!nums.length) { stats[c] = { mean: 0, median: 0 }; return; }
        const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
        const mid = Math.floor(nums.length/2);
        const median = nums.length%2 ? nums[mid] : (nums[mid-1]+nums[mid])/2;
        stats[c] = { mean, median };
      });

      const rows = data.rows.map(r => {
        const o = { ...r };
        colsUse.forEach(c => {
          if (o[c] === "" || o[c] == null) {
            o[c] = strategy === "median" ? stats[c].median : stats[c].mean;
          }
        });
        return o;
      });
      return { headers: data.headers, rows };
    },
    defaultParams: { strategy: "median", cols: "" }
  },
  fillCategorical: {
    name: "Fill categorical missing (mode)",
    editor: ({ params }) => `
      <label>Columns (optional): <input type="text" data-key="cols" value="${params.cols || ""}" placeholder="empty = all categorical"></label>
    `,
    apply: (data, { cols }) => {
      const types = detectTypes(data.headers, data.rows);
      const allCat = data.headers.filter(h => types[h] !== "numeric" && types[h] !== "date");
      const target = (cols || "").split(",").map(s=>s.trim()).filter(Boolean);
      const colsUse = target.length ? target : allCat;

      const modes = {};
      colsUse.forEach(c => {
        const f = {};
        data.rows.forEach(r => { const k = String(r[c] ?? ""); if (k) f[k] = (f[k] || 0) + 1; });
        let best = "", cnt = -1;
        Object.entries(f).forEach(([k,v]) => { if (v > cnt){ best = k; cnt = v; } });
        modes[c] = best;
      });

      const rows = data.rows.map(r => {
        const o = { ...r };
        colsUse.forEach(c => {
          if (o[c] === "" || o[c] == null) o[c] = modes[c];
        });
        return o;
      });
      return { headers: data.headers, rows };
    },
    defaultParams: { cols: "" }
  },
  dropDuplicates: {
    name: "Drop duplicate rows",
    editor: () => `<div class="mini">Exact duplicate detection over all columns.</div>`,
    apply: (data) => {
      const seen = new Set(); const rows = [];
      data.rows.forEach(r => { const k = JSON.stringify(r); if (seen.has(k)) return; seen.add(k); rows.push(r); });
      return { headers: data.headers, rows };
    },
    defaultParams: {}
  },
  dropSparseCols: {
    name: "Drop sparse columns",
    editor: ({ params }) => `
      <label>Max missing % allowed <input type="number" min="1" max="99" data-key="pct" value="${params.pct}"></label>
    `,
    apply: (data, { pct }) => {
      const thr = clamp(Number(pct) / 100, 0.01, 0.99);
      const keep = data.headers.filter(h => {
        const miss = data.rows.filter(r => r[h] === "" || r[h] == null).length / data.rows.length;
        return miss < thr;
      });
      const rows = data.rows.map(r => Object.fromEntries(keep.map(h => [h, r[h]])));
      return { headers: keep, rows };
    },
    defaultParams: { pct: 60 }
  },
  capOutliersIQR: {
    name: "IQR outlier capping",
    editor: ({ params, columns }) => {
      const opts = columns.map(c => `<option value="${c}" ${params.cols?.includes(c) ? "selected":""}>${c}</option>`).join("");
      return `
        <label>Columns
          <select data-key="cols" multiple size="5" style="min-width:180px">${opts}</select>
        </label>
        <div class="mini">Leave empty to cap ALL numeric columns.</div>
      `;
    },
    apply: (data, { cols }) => {
      const types = detectTypes(data.headers, data.rows);
      const allNum = data.headers.filter(h => types[h] === "numeric");
      const colsUse = (cols && cols.length) ? cols : allNum;
      if (!colsUse.length) return data;

      const cap = (vals) => {
        const s = vals.slice().sort((a,b)=>a-b);
        const q1 = s[Math.floor(s.length*0.25)];
        const q3 = s[Math.floor(s.length*0.75)];
        const iqr = q3 - q1;
        return { lo: q1 - 1.5*iqr, hi: q3 + 1.5*iqr };
      };

      const bounds = {};
      colsUse.forEach(c => {
        const v = data.rows.map(r => toNum(r[c])).filter(x=>x!==null);
        if (v.length >= 4) bounds[c] = cap(v);
      });

      const rows = data.rows.map(r => {
        const o = { ...r };
        colsUse.forEach(c => {
          if (!(c in bounds)) return;
          const v = toNum(o[c]); if (v === null) return;
          o[c] = Math.min(Math.max(v, bounds[c].lo), bounds[c].hi);
        });
        return o;
      });
      return { headers: data.headers, rows };
    },
    defaultParams: { cols: [] }
  },
  encode: {
    name: "Encode categoricals",
    editor: ({ params }) => `
      <label>Method
        <select data-key="method">
          <option value="label" ${params.method==="label"?"selected":""}>Label</option>
          <option value="onehot" ${params.method==="onehot"?"selected":""}>One-Hot</option>
        </select>
      </label>
      <label>Top N per column (one-hot) <input type="number" min="1" max="50" data-key="topN" value="${params.topN}"></label>
    `,
    apply: (data, { method, topN }) => {
      const types = detectTypes(data.headers, data.rows);
      const catCols = data.headers.filter(h => types[h] !== "numeric" && types[h] !== "date");
      if (!catCols.length) return data;

      if (method === "label") {
        const maps = {};
        catCols.forEach(c => {
          const vals = uniq(data.rows.map(r => String(r[c] ?? "")));
          const m = new Map(); vals.forEach((v,i)=>m.set(v, i));
          maps[c] = m;
        });
        const rows = data.rows.map(r => {
          const o = { ...r };
          catCols.forEach(c => { o[c] = (maps[c].get(String(o[c] ?? "")) ?? 0); });
          return o;
        });
        return { headers: data.headers, rows };
      } else {
        let headers = data.headers.slice();
        let rows = data.rows.map(r => ({ ...r }));
        catCols.forEach(c => {
          const freq = {};
          data.rows.forEach(r => { const k = String(r[c] ?? ""); freq[k] = (freq[k] || 0) + 1; });
          const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, clamp(Number(topN)||10, 1, 50)).map(e=>e[0]);
          top.forEach(v => headers.push(`${c}__${v}`.replace(/\s+/g, "_")));
          rows.forEach(r => {
            top.forEach(v => { r[`${c}__${v}`.replace(/\s+/g,"_")] = String(r[c] ?? "") === v ? 1 : 0; });
            delete r[c];
          });
          headers = headers.filter(h => h !== c);
        });
        return { headers, rows };
      }
    },
    defaultParams: { method: "onehot", topN: 10 }
  },
  scale: {
    name: "Scale numeric",
    editor: ({ params }) => `
      <label>Mode
        <select data-key="mode">
          <option value="none" ${params.mode==="none"?"selected":""}>None</option>
          <option value="standard" ${params.mode==="standard"?"selected":""}>Standard (z-score)</option>
          <option value="minmax" ${params.mode==="minmax"?"selected":""}>Min-Max [0,1]</option>
        </select>
      </label>
    `,
    apply: (data, { mode }) => {
      if (mode === "none") return data;
      const types = detectTypes(data.headers, data.rows);
      const numCols = data.headers.filter(h => types[h] === "numeric");
      if (!numCols.length) return data;
      const stats = {};
      numCols.forEach(c => {
        const vals = data.rows.map(r => toNum(r[c])).filter(v => v !== null);
        const min = Math.min(...vals), max = Math.max(...vals);
        const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
        const sd = Math.sqrt(vals.reduce((s,v)=>s+(v-mean)*(v-mean),0)/vals.length) || 1;
        stats[c] = { min, max, mean, sd };
      });
      const rows = data.rows.map(r => {
        const o = { ...r };
        numCols.forEach(c => {
          const v = toNum(o[c]); if (v === null) return;
          if (mode === "standard") o[c] = round((v - stats[c].mean) / stats[c].sd, 6);
          else if (mode === "minmax") o[c] = round((v - stats[c].min) / (stats[c].max - stats[c].min || 1), 6);
        });
        return o;
      });
      return { headers: data.headers, rows };
    },
    defaultParams: { mode: "none" }
  }
};

/* Pipeline model */
let pipeline = [];

/* ---------- UI: pipeline list ---------- */
function renderPipeline() {
  pipeList.innerHTML = "";
  pipeline.forEach((step, idx) => {
    const def = STEP_LIBRARY[step.id];
    const wrapper = document.createElement("div");
    wrapper.className = "pipe-row";

    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "pipe-title";
    const enableId = `enable_${idx}`;
    title.innerHTML = `<input type="checkbox" id="${enableId}" ${step.enabled ? "checked":""} /> ${def.name} <small>#${idx+1}</small>`;
    left.appendChild(title);

    const body = document.createElement("div");
    body.className = "pipe-body";
    let editorHTML = "";
    if (step.id === "capOutliersIQR") {
      const numCols = inData.headers.filter(h => inferredTypes[h] === "numeric");
      editorHTML = def.editor({ params: step.params, columns: numCols });
    } else {
      editorHTML = def.editor({ params: step.params });
    }
    body.innerHTML = editorHTML;
    left.appendChild(body);

    const right = document.createElement("div");
    right.className = "pipe-controls";
    right.innerHTML = `
      <button data-act="up" title="Move up">↑</button>
      <button data-act="down" title="Move down">↓</button>
      <button data-act="del" title="Delete">✕</button>
    `;

    setTimeout(() => {
      const en = document.getElementById(enableId);
      en?.addEventListener("change", () => { step.enabled = !!en.checked; });
      body.querySelectorAll("[data-key]").forEach(el => {
        el.addEventListener("input", () => {
          const key = el.getAttribute("data-key");
          if (el.tagName === "SELECT" && el.multiple) {
            step.params[key] = Array.from(el.selectedOptions).map(o => o.value);
          } else {
            step.params[key] = el.value;
          }
        });
      });
    }, 0);

    right.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        const act = btn.getAttribute("data-act");
        if (act === "up" && idx > 0) {
          const t = pipeline[idx-1]; pipeline[idx-1] = pipeline[idx]; pipeline[idx] = t; renderPipeline();
        } else if (act === "down" && idx < pipeline.length - 1) {
          const t = pipeline[idx+1]; pipeline[idx+1] = pipeline[idx]; pipeline[idx] = t; renderPipeline();
        } else if (act === "del") {
          pipeline.splice(idx,1); renderPipeline();
        }
      });
    });

    wrapper.appendChild(left);
    wrapper.appendChild(right);
    pipeList.appendChild(wrapper);
  });
}

/* Populate dropdown + add selected */
function populateStepChooser() {
  const order = ["dropDuplicates","dropSparseCols","dropMissingAny","fillNumeric","fillCategorical","capOutliersIQR","encode","scale"];
  stepChooser.innerHTML = `<option value="">+ Select a step to add…</option>`;
  order.forEach((id) => {
    if (!STEP_LIBRARY[id]) return;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${STEP_LIBRARY[id].name} (${id})`;
    stepChooser.appendChild(opt);
  });
  Object.keys(STEP_LIBRARY).forEach((id) => {
    if (order.includes(id)) return;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${STEP_LIBRARY[id].name} (${id})`;
    stepChooser.appendChild(opt);
  });
}
btnAddSelected.addEventListener("click", () => {
  const id = stepChooser.value;
  if (!id) { alert("Select a step first."); return; }
  const def = STEP_LIBRARY[id];
  const params = JSON.parse(JSON.stringify(def.defaultParams || {}));
  pipeline.push({ id, enabled: true, params });
  renderPipeline();
  stepChooser.value = ""; // reset
});

/* ---------- Import/Export pipeline ---------- */
btnExportPipe.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(pipeline, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "pipeline.json"; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
});
btnImportPipe.addEventListener("click", () => pipeImportFile.click());
pipeImportFile.addEventListener("change", (e) => {
  const f = e.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const obj = JSON.parse(ev.target.result);
      if (!Array.isArray(obj)) throw new Error("Invalid pipeline format.");
      pipeline = obj.filter(s => STEP_LIBRARY[s.id]).map(s => ({
        id: s.id,
        enabled: !!s.enabled,
        params: { ...(STEP_LIBRARY[s.id].defaultParams||{}), ...(s.params||{}) }
      }));
      renderPipeline();
    } catch (err) { alert("Failed to import: " + err.message); }
  };
  reader.readAsText(f);
});

/* ---------- Processing progress + async pipeline ---------- */
function setProcProgress(pct, left = "", right = "") {
  procBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (left) procLabel.textContent = left;
  if (right || right === "") procRight.textContent = right;
}
async function runPipelineAsync(data, pipe) {
  const active = pipe.filter(s => s.enabled);
  const total = active.length || 1;
  let acc = data;
  let i = 0;

  for (const step of active) {
    const def = STEP_LIBRARY[step.id];
    setProcProgress((i/total)*100, `Running: ${def.name}`, `${i}/${total}`);
    await tick();
    try {
      acc = def.apply(acc, step.params);
    } catch (e) {
      console.error("Step failed:", step.id, e);
      setProcProgress((i/total)*100, `Failed: ${def.name}`, "");
      alert(`Step failed: ${def.name}\n${e.message}`);
      break;
    }
    i++;
    setProcProgress((i/total)*100, `Completed: ${def.name}`, `${i}/${total}`);
    await tick();
  }

  if (i === active.length) setProcProgress(100, "Finished ✓", `${i}/${total}`);
  setTimeout(() => setProcProgress(0, "Idle", ""), 1200);
  return acc;
}

btnApply.addEventListener("click", async () => {
  if (!inData.rows.length) return alert("Load a dataset first.");
  btnApply.disabled = true; btnDownload.disabled = true; btnSendToDashboard.disabled = true;
  setProcProgress(0, "Starting…", "");
  outData = await runPipelineAsync(inData, pipeline);
  setMeta(); setBadges(outData);
  renderTablesWithDiff();
  enableActions();
  renderDatasetInfo(); // refresh info (After)
  btnApply.disabled = false;
});

/* ---------- Splits + Download ---------- */
function stratifiedSplit(rows, labelCol, testPct = 0.2) {
  const byClass = {};
  rows.forEach(r => (byClass[r[labelCol]] ??= []).push(r));
  const train = [], test = [];
  Object.values(byClass).forEach(arr => {
    const copy = arr.slice().sort(() => Math.random()-0.5);
    const n = Math.floor(copy.length * testPct);
    test.push(...copy.slice(0,n));
    train.push(...copy.slice(n));
  });
  return { train, test };
}
function timeSplit(rows, dateCol, testPct = 0.2) {
  const valid = rows.map(r => ({ r, d: new Date(r[dateCol]) })).filter(p => !isNaN(p.d));
  valid.sort((a,b) => a.d - b.d);
  const n = valid.length, t = Math.max(1, Math.floor(n * testPct));
  const test = valid.slice(-t).map(p => p.r);
  const train = valid.slice(0, n - t).map(p => p.r);
  return { train, test };
}
function toCSV({ headers, rows }) {
  const lines = [];
  lines.push(headers.map(h => JSON.stringify(h)).join(","));
  for (const r of rows) lines.push(headers.map(h => JSON.stringify(r[h] ?? "")).join(","));
  return lines.join("\n");
}
function download(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}
btnDownload.addEventListener("click", () => {
  if (!outData.rows.length) return alert("Nothing to download. Click Apply Steps first.");
  const mode = (document.querySelector("input[name=dlmode]:checked") || {}).value || "single";
  if (mode === "single") {
    download("processed.csv", toCSV(outData)); return;
  }
  if (mode === "stratified") {
    const label = strataLabel.value;
    if (!label) return alert("Choose a label column for stratification.");
    const pct = clamp(Number(strataPct.value)/100, 0.01, 0.9);
    const { train, test } = stratifiedSplit(outData.rows, label, pct);
    download("train.csv", toCSV({ headers: outData.headers, rows: train }));
    download("test.csv",  toCSV({ headers: outData.headers, rows: test  }));
    return;
  }
  if (mode === "time") {
    const dateCol = timeDateCol.value;
    if (!dateCol) return alert("Choose a date column for time-based split.");
    const pct = clamp(Number(timePct.value)/100, 0.01, 0.9);
    const { train, test } = timeSplit(outData.rows, dateCol, pct);
    download("train.csv", toCSV({ headers: outData.headers, rows: train }));
    download("test.csv",  toCSV({ headers: outData.headers, rows: test  }));
    return;
  }
});

btnSendToDashboard.addEventListener("click", () => {
  if (!outData.rows.length) return alert("Apply steps first.");
  try {
    localStorage.setItem("da_data", JSON.stringify(outData));
    window.location.href = "index.html";
  } catch (e) {
    alert("Failed to cache dataset for dashboard: " + e.message);
  }
});

/* ---------- Preview with diff ---------- */
function renderTablesWithDiff() {
  previewTable(tblIn, inData.headers, inData.rows);
  previewTable(tblOut, outData.headers, outData.rows, inData.rows);
}

/* ---------- Enable/disable controls ---------- */
function enableActions() {
  const hasIn = inData.rows.length > 0;
  const hasOut = outData.rows.length > 0;
  btnApply.disabled = !hasIn;
  btnDownload.disabled = !hasOut;
  btnSendToDashboard.disabled = !hasOut;

  renderSelectOptions(strataLabel, inData.headers, "-- choose --");
  const dateCols = inData.headers.filter(h => inferredTypes[h] === "date");
  renderSelectOptions(timeDateCol, dateCols, "-- choose --");

  // update dataset info selector default
  if (infoSource) {
    infoSource.value = hasOut ? "after" : "before";
  }
}

/* ---------- Page refresh ---------- */
function refreshAll() {
  setMeta();
  setBadges(inData);            // top-right quick badges (original to start)
  previewTable(tblIn, inData.headers, inData.rows);
  previewTable(tblOut, outData.headers, outData.rows);
  inferredTypes = detectTypes(inData.headers, inData.rows);
  renderPipeline();
  enableActions();
  renderDatasetInfo();          // fill dataset info block
}

/* ---------- Init ---------- */
(function init() {
  pipeline = [
    { id: "dropDuplicates", enabled: true,  params: {} },
    { id: "dropSparseCols", enabled: false, params: { pct: 60 } },
    { id: "dropMissingAny", enabled: false, params: { cols: "" } },
    { id: "fillNumeric",    enabled: true,  params: { strategy: "median", cols: "" } },
    { id: "fillCategorical",enabled: true,  params: { cols: "" } },
    { id: "capOutliersIQR", enabled: false, params: { cols: [] } },
    { id: "encode",         enabled: true,  params: { method: "onehot", topN: 10 } },
    { id: "scale",          enabled: false, params: { mode: "none" } }
  ];
  renderPipeline();
  populateStepChooser();

  // preload from dashboard if available
  try {
    const cached = localStorage.getItem("da_data");
    if (cached) {
      const obj = JSON.parse(cached);
      if (obj?.headers?.length && obj?.rows?.length) {
        inData = obj; outData = { headers: [...obj.headers], rows: [...obj.rows] };
        inferredTypes = detectTypes(inData.headers, inData.rows);
      }
    }
  } catch {}
  refreshAll();

  // wire dataset info source switch
  infoSource?.addEventListener("change", renderDatasetInfo);

  resetUploadProgress();
})();
