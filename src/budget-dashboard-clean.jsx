import { useState, useEffect, useMemo, useCallback, createContext, useContext } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, ReferenceLine } from "recharts";

// ── YOUR ANTHROPIC API KEY ────────────────────────────────────────────────────
// Get one at https://console.anthropic.com → API Keys
// This enables: PDF statement import with auto-categorization + AI budget tips
// API key stored in localStorage so it survives file replacements — set via Settings tab
const ANTHROPIC_API_KEY = (() => { try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; } })();
// Safe localStorage wrapper — gracefully falls back when unavailable (e.g. artifact sandboxes)
const ls = {
  get: (key, fallback = null) => { try { const v = localStorage.getItem(key); return v !== null ? v : fallback; } catch { return fallback; } },
  set: (key, val) => { try { localStorage.setItem(key, val); } catch {} },
  getJSON: (key, fallback) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  setJSON: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
};

// ── CHECKING TRANSACTIONS ─────────────────────────────────────────────────────
// Add your checking transactions here. Each entry needs:
// date, desc, amount, cat, note, month
// Categories: Income | Transfer | Giving & Tithe | Housing | Groceries | Medical |
//             ABA Therapy | Transportation | Shopping | Debt Service | Dining Out |
//             Subscriptions | Kids & Family | Entertainment | Snacks/Misc
const CHECKING_TXNS = [
  // Example (delete this and add real transactions):
  // { date:"01/15", desc:"Payroll",   amount:3930.78, cat:"Income",   note:"", month:"January" },
  // { date:"01/29", desc:"Mortgage",  amount:1602.23, cat:"Housing",  note:"", month:"January" },
];

// ── CC TRANSACTIONS ─────────────────────────────────────────────────────────────
const CC_TXNS = [
  // Add credit card transactions here (same format as checking)
];

// ── BUDGET DATA ───────────────────────────────────────────────────────────────
const DEFAULT_TAKE_HOME = 0;

const SUMMARY_ROWS = [
  // These auto-calculate from transactions above once you add them.
  // You can also set manual budgets (kc field) per category.
  { cat:"Giving & Tithe",  checking:0, cc:0, norm:0, kc:0,    icon:"⛪", color:"#7c6af7", oneTime:0, notes:"" },
  { cat:"Housing",         checking:0, cc:0, norm:0, kc:2500, icon:"🏠", color:"#3b82f6", oneTime:0, notes:"" },
  { cat:"Groceries",       checking:0, cc:0, norm:0, kc:1200, icon:"🛒", color:"#f97316", oneTime:0, notes:"" },
  { cat:"Medical",         checking:0, cc:0, norm:0, kc:350,  icon:"🏥", color:"#ec4899", oneTime:0, notes:"" },
  { cat:"ABA Therapy",     checking:0, cc:0, norm:0, kc:null, icon:"🧩", color:"#8b5cf6", oneTime:0, notes:"" },
  { cat:"Transportation",  checking:0, cc:0, norm:0, kc:900,  icon:"🚗", color:"#06b6d4", oneTime:0, notes:"" },
  { cat:"Shopping",        checking:0, cc:0, norm:0, kc:250,  icon:"🛍️", color:"#f59e0b", oneTime:0, notes:"" },
  { cat:"Debt Service",    checking:0, cc:0, norm:0, kc:450,  icon:"💳", color:"#ef4444", oneTime:0, notes:"" },
  { cat:"Dining Out",      checking:0, cc:0, norm:0, kc:300,  icon:"🍽️", color:"#10b981", oneTime:0, notes:"" },
  { cat:"Subscriptions",   checking:0, cc:0, norm:0, kc:130,  icon:"📺", color:"#6366f1", oneTime:0, notes:"" },
  { cat:"Kids & Family",   checking:0, cc:0, norm:0, kc:600,  icon:"👶", color:"#84cc16", oneTime:0, notes:"" },
  { cat:"Snacks/Misc",     checking:0, cc:0, norm:0, kc:75,   icon:"🍿", color:"#94a3b8", oneTime:0, notes:"" },
];

const ONE_TIMES = [
  // Add one-time large expenses here so they don't skew your normalized budget
  // { name:"Plumbing Repair", amount:165.00, cat:"Housing" },
];
const ONE_TIME_TOTAL = ONE_TIMES.reduce((s,x) => s+x.amount, 0);
const NORM_TOTAL     = SUMMARY_ROWS.reduce((s,r) => s+r.norm, 0);
const JAN_ACTUAL     = SUMMARY_ROWS.reduce((s,r) => s+r.checking+r.cc, 0);
const NORM_SURPLUS   = 0; // computed dynamically in App context

// Scenario stack — each spend value is absolute monthly
const SCENARIO_DEFS = [
  { label:"Jan Actual",       spend:JAN_ACTUAL,                                             note:"All one-time items included" },
  { label:"Remove One-Times", spend:JAN_ACTUAL - ONE_TIME_TOTAL,                            note:"Surgery, plumbing, 2025 ABA" },
  { label:"Normalize ABA",    spend:NORM_TOTAL,                                              note:"Recurring baseline" },
  { label:"+ Grocery Goal",   spend:NORM_TOTAL - 0,                            note:"Save $1,473/mo — biggest lever" },
  { label:"+ Goodleap",       spend:NORM_TOTAL - 460,                             note:"Jul 2026 · −$460/mo" },
  { label:"+ Wells Fargo",    spend:NORM_TOTAL - 460 - 151.22,                    note:"Jan 2027 · −$151/mo" },
  { label:"+ Honda ✅",        spend:NORM_TOTAL - 460 - 151.22 - 507.03,          note:"Mar 2029 · first SURPLUS" },
  { label:"+ Student Loan",   spend:NORM_TOTAL - 460 - 151.22 - 507.03 - 201.09, note:"Long-term · max surplus" },
];

// ABA: $35/visit, $7,000 individual OOP cap, resets every Jan 1
// Visits/mo = daysPerWeek × (52/12)
function buildABASchedule(daysPerWeek) {
  const COST_PER_VISIT = 35;
  const OOP_CAP = 7000;
  const visitsPerMonth = daysPerWeek * (52 / 12);
  const fullMonthCost = Math.round(visitsPerMonth * COST_PER_VISIT);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const schedule = [];
  for (let year = 2026; year <= 2027; year++) {
    let cumCost = 0;
    for (let m = 0; m < 12; m++) {
      const remaining = Math.max(0, OOP_CAP - cumCost);
      const thisCost  = Math.min(fullMonthCost, remaining);
      cumCost += thisCost;
      schedule.push({
        month: MONTHS[m], cost: thisCost, year,
        full: fullMonthCost,
        status: thisCost === 0 ? "free" : thisCost < fullMonthCost ? "partial" : "full",
      });
    }
  }
  const annualCost = schedule.slice(0,12).reduce((s,m) => s+m.cost, 0);
  const capHit     = annualCost < OOP_CAP ? false : true;
  const capMonthIdx = schedule.findIndex(m => m.status === "free" || m.status === "partial");
  return { schedule, annualCost, capHit, fullMonthCost };
}

const ABA_OPTIONS = [
  { label:"5 days/wk", daysPerWeek:5 },
  { label:"MWF",       daysPerWeek:3 },
  { label:"Tue/Thu",   daysPerWeek:2 },
];

const PAYOFFS_INIT = [
  { id:"p1", name:"Goodleap",     payment:460.00,  balance:2280,   balanceStr:"$2,280",  date:"Jul 2026",  months:"5 left",  pct:95, color:"#22c55e" },
  { id:"p2", name:"Wells Fargo",  payment:151.22,  balance:1586,   balanceStr:"$1,586",  date:"Jan 2027",  months:"11 left", pct:65, color:"#a78bfa" },
  { id:"p3", name:"Honda",        payment:507.03,  balance:17670,  balanceStr:"$17,670", date:"Mar 2029",  months:"37 left", pct:30, color:"#64748b" },
  { id:"p4", name:"Student Loan", payment:201.09,  balance:25000,  balanceStr:"$25,000", date:"Long-term", months:"TBD",     pct:5,  color:"#475569" },
];

const CAT_COLORS = {
  "Giving & Tithe":"#7c6af7","Housing":"#3b82f6","Groceries":"#f97316","Medical":"#ec4899",
  "ABA Therapy":"#8b5cf6","Transportation":"#06b6d4","Shopping":"#f59e0b","Debt Service":"#ef4444",
  "Dining Out":"#10b981","Subscriptions":"#6366f1","Kids & Family":"#84cc16","Snacks/Misc":"#94a3b8",
  "Income":"#22c55e","Transfer":"#334155",
};

// All valid categories available in the category picker
const VALID_CATS = [
  "Giving & Tithe","Housing","Groceries","Medical","ABA Therapy","Transportation",
  "Shopping","Debt Service","Dining Out","Subscriptions","Kids & Family","Snacks/Misc",
  "Transfer","Income",
];

// React context — shares live transaction state + computed summaries across all tabs
const BudgetCtx = createContext(null);
const useBudget = () => useContext(BudgetCtx);


const fmt  = (n, d=0) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:d}).format(Math.abs(n));
const BG="#0d1117",SURFACE="#161b27",BORDER="#1e2535",MUTED="#475569",DIM="#334155",TEXT="#e2e8f0",ACCENT="#a78bfa";

function useWindowWidth() {
  const [w,setW] = useState(typeof window!=="undefined"?window.innerWidth:900);
  useEffect(()=>{ const fn=()=>setW(window.innerWidth); window.addEventListener("resize",fn); return()=>window.removeEventListener("resize",fn); },[]);
  return w;
}

// ── ATOMS ─────────────────────────────────────────────────────────────────────
const Card = ({children,style,glow,onClick,selected}) => (
  <div onClick={onClick} style={{
    background:glow?glow+"07":SURFACE, borderRadius:18,
    border:`1px solid ${selected?"#a78bfa":(glow?glow+"44":BORDER)}`,
    padding:"18px", boxShadow:selected?"0 0 0 2px #a78bfa44":(glow?`0 0 28px ${glow}12`:"none"),
    cursor:onClick?"pointer":"default", transition:"border .15s, box-shadow .15s",
    ...style
  }}>{children}</div>
);
const Label = ({children}) => <div style={{fontSize:11,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".8px",marginBottom:12}}>{children}</div>;
const Tag   = ({children,color}) => <span style={{display:"inline-block",padding:"2px 9px",borderRadius:99,fontSize:11,fontWeight:700,background:color+"22",color,lineHeight:1.6,whiteSpace:"nowrap"}}>{children}</span>;
const PBar  = ({pct,color,h=6}) => (
  <div style={{height:h,borderRadius:99,background:DIM,overflow:"hidden"}}>
    <div style={{height:"100%",width:`${Math.min(Math.abs(pct),100)}%`,background:color,borderRadius:99,transition:"width .5s cubic-bezier(.4,0,.2,1)"}}/>
  </div>
);
const HR = () => <div style={{height:1,background:BORDER,margin:"12px 0"}}/>;
const Tip = ({active,payload,label}) => {
  if(!active||!payload?.length) return null;
  return (
    <div style={{background:"#1e2535",border:`1px solid ${BORDER}`,borderRadius:10,padding:"8px 12px",fontSize:12}}>
      <div style={{color:MUTED,marginBottom:2}}>{label}</div>
      {payload.map((p,i)=><div key={i} style={{color:p.color||ACCENT,fontWeight:700}}>{fmt(p.value)}</div>)}
    </div>
  );
};

// Slider atom
const Slider = ({min,max,step=10,value,onChange,color="#a78bfa"}) => (
  <div style={{position:"relative",padding:"4px 0"}}>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}
      style={{width:"100%",accentColor:color,height:4,cursor:"pointer"}}/>
  </div>
);

// ── CASH FLOW SANKEY ──────────────────────────────────────────────────────────
function CashFlowSankey({ viewMode }) {
  const [hovered, setHovered] = useState(null);
  const { summaryRows } = useBudget();

  const categories = summaryRows.map(r => ({
    name:  r.cat,
    value: viewMode === "norm" ? r.norm : (r.checking + r.cc),
    color: r.color,
    icon:  r.icon,
  }));

  const { takeHome } = useBudget();
  const totalIncome = takeHome;
  const totalSpend  = categories.reduce((s, c) => s + c.value, 0);
  const surplus     = totalIncome - totalSpend;
  const allDest = categories;

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const W = 1000, H = 680;
  const ff = "'DM Sans',system-ui,sans-serif";
  const pctStr = v => ((v / totalIncome) * 100).toFixed(1) + "%";
  const NUM = allDest.length;
  const totalVal = allDest.reduce((s, d) => s + d.value, 0);

  // ── SOURCE: one solid bar, sliced purely by proportion (no gaps, no minimum) 
  const SRC_X = 16, SRC_W = 14;
  const SRC_Y = 30, SRC_H = H - 60;
  const srcScale = SRC_H / totalVal;
  // Cumulative source slice tops
  let srcCur = SRC_Y;
  const srcSlices = allDest.map(d => {
    const h = d.value * srcScale;
    const s = { top: srcCur, bot: srcCur + h, h };
    srcCur += h;
    return s;
  });

  // ── DEST: sqrt-scaled heights — much better visual differentiation ───────────
  // Pure proportional makes tiny cats invisible; pure minimum makes all look equal.
  // sqrt(value) compresses the range: Medical(426)→20.6 vs Snacks(48)→6.9 = 3× diff
  const DST_X = 570, DST_W = 14;
  const DST_GAP = 5, DST_MIN = 12;
  const sqrtVals = allDest.map(d => Math.sqrt(d.value));
  const sqrtTotal = sqrtVals.reduce((s, v) => s + v, 0);
  const dTotalPad = DST_GAP * (NUM - 1);
  const dAvailH = SRC_H - dTotalPad;
  const destNodes = (() => {
    // First pass: assign sqrt-proportional heights with minimum floor
    const rawH = sqrtVals.map(v => Math.max(DST_MIN, (v / sqrtTotal) * dAvailH));
    // Normalise so they sum to exactly dAvailH
    const rawSum = rawH.reduce((s, h) => s + h, 0);
    const finalH = rawH.map(h => (h / rawSum) * dAvailH);
    let cur = SRC_Y;
    return allDest.map((d, i) => {
      const node = { ...d, y: cur, h: finalH[i] };
      cur += finalH[i] + DST_GAP;
      return node;
    });
  })();

  // ── BANDS: source slice → dest node — mismatch in heights = real S-curves ──
  const bands = destNodes.map((d, i) => {
    const s = srcSlices[i];
    // Source side: proportional (small categories = tiny slice)
    const x1 = SRC_X + SRC_W;
    const y1t = s.top, y1b = s.bot;
    // Dest side: guaranteed minimum (small categories = fat node)
    const x2 = DST_X;
    const y2t = d.y, y2b = d.y + d.h;
    // S-curve: horizontal tangents at both endpoints
    const mid = (x1 + x2) / 2;
    return {
      name: d.name, color: d.color,
      path:
        `M${x1} ${y1t} C${mid} ${y1t},${mid} ${y2t},${x2} ${y2t}` +
        ` L${x2} ${y2b} C${mid} ${y2b},${mid} ${y1b},${x1} ${y1b}Z`,
    };
  });

  // ── LABELS: stack to prevent overlap ───────────────────────────────────────
  const LGAP = 36;
  const lpos = destNodes.map(d => d.y + d.h / 2);
  for (let i = 1; i < lpos.length; i++)
    if (lpos[i] < lpos[i-1] + LGAP) lpos[i] = lpos[i-1] + LGAP;
  for (let i = lpos.length - 2; i >= 0; i--)
    if (lpos[i] > lpos[i+1] - LGAP) lpos[i] = lpos[i+1] - LGAP;
  const labelY = lpos.map(y => Math.max(40, Math.min(H - 12, y)));

  return (
    <div style={{ width:"100%", overflowX:"auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"auto", display:"block" }}>
        <defs>
          {allDest.map(d => (
            <linearGradient key={d.name} id={`sg-${d.name.replace(/[\s&/]/g,"_")}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor={d.color} stopOpacity="0.12"/>
              <stop offset="100%" stopColor={d.color} stopOpacity="0.62"/>
            </linearGradient>
          ))}
        </defs>

        {/* Bands first (behind nodes) */}
        {bands.map((b, i) => (
          <path key={i} d={b.path}
            fill={hovered===b.name ? b.color : `url(#sg-${b.name.replace(/[\s&/]/g,"_")})`}
            opacity={hovered===null ? 1 : hovered===b.name ? 0.75 : 0.07}
            style={{ transition:"opacity .2s", cursor:"pointer" }}
            onMouseEnter={() => setHovered(b.name)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}

        {/* Source bar on top */}
        <rect x={SRC_X} y={SRC_Y} width={SRC_W} height={SRC_H} rx={6} fill={ACCENT}/>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+20} fontFamily={ff} fill="#94a3b8" fontSize={11} fontWeight={700}>Paychecks</text>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+38} fontFamily={ff} fill={ACCENT} fontSize={18} fontWeight={900}>{fmt(totalIncome)}</text>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+54} fontFamily={ff} fill={MUTED} fontSize={10}>100%</text>

        {/* Dest nodes + labels */}
        {destNodes.map((d, i) => {
          const ly  = labelY[i];
          const mid = d.y + d.h / 2;
          const isH = hovered === d.name;
          return (
            <g key={d.name}
              onMouseEnter={() => setHovered(d.name)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor:"pointer" }}>
              {Math.abs(ly - mid) > 4 && (
                <line x1={DST_X+DST_W+3} y1={mid} x2={DST_X+DST_W+10} y2={ly}
                  stroke={d.color} strokeWidth={1} strokeOpacity={0.4}/>
              )}
              <rect x={DST_X} y={d.y} width={DST_W} height={d.h} rx={3}
                fill={d.color} opacity={isH ? 1 : 0.85}
                style={{ transition:"opacity .15s" }}/>
              <text x={DST_X+DST_W+14} y={ly-5}
                fontFamily={ff} fontSize={12} fontWeight={isH?700:500}
                fill={isH ? d.color : TEXT}>
                {d.icon} {d.name}
              </text>
              <text x={DST_X+DST_W+14} y={ly+10}
                fontFamily={ff} fontSize={10} fill={isH ? d.color : MUTED}>
                {fmt(d.value)} ({pctStr(d.value)})
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize:11, color:DIM, textAlign:"center", marginTop:4 }}>
        Hover a band to highlight · {viewMode==="norm" ? "normalized recurring spend" : "January actual spend"}
      </div>
    </div>
  );
}


// ── SUMMARY ───────────────────────────────────────────────────────────────────
function Summary({wide, isMobile}) {
  const [view, setView] = useState("norm");
  const [expandedCat, setExpandedCat] = useState(null);
  const { summaryRows, checkTxns, ccTxns, janActual, normTotal, normSurplus, takeHome, selectedMonth, dashName, oneTimes } = useBudget();

  // Merge all transactions for the expandable drill-down
  const ALL_TXNS = useMemo(() => [
    ...checkTxns.filter(t => t.cat !== "Transfer" && t.cat !== "Income"),
    ...ccTxns,
  ], [checkTxns, ccTxns]);

  const txnsFor = cat => [
    ...checkTxns.filter(t => t.month === selectedMonth && t.cat === cat && t.cat !== "Transfer" && t.cat !== "Income"),
    ...ccTxns.filter(t => t.month === selectedMonth && t.cat === cat),
  ].sort((a,b) => a.date.localeCompare(b.date));

  const checkTotal = summaryRows.reduce((s,r)=>s+r.checking,0);
  const ccTotal    = summaryRows.reduce((s,r)=>s+r.cc,0);
  const donutData  = summaryRows
    .map(r=>({name:r.cat, value:view==="norm"?r.norm:(r.checking+r.cc), fill:r.color}))
    .filter(d => d.value > 0)
    .sort((a,b) => b.value - a.value);

  // Category breakdown sorted by display value descending
  const sortedSummaryRows = [...summaryRows].sort((a,b) => {
    const va = view==="norm" ? a.norm : (a.checking+a.cc);
    const vb = view==="norm" ? b.norm : (b.checking+b.cc);
    return vb - va;
  });
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card glow="#ef4444">
        <Label>{selectedMonth} 2026 · {dashName}</Label>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:14}}>
          {[
            ["Take-Home",    fmt(takeHome),                  ACCENT],
            ["Checking Spend",fmt(checkTotal),                "#3b82f6"],
            ["CC Spend",     fmt(ccTotal),                    "#6366f1"],
            ["Total Actual", fmt(janActual),                 "#ef4444"],
            ["Recurring",    fmt(normTotal),                  "#f97316"],
            ["Gap",          "−"+fmt(Math.abs(normSurplus)), "#ef4444"],
          ].map(([k,v,c])=>(
            <div key={k} style={{background:BG,borderRadius:12,padding:"12px 14px"}}>
              <div style={{fontSize:11,color:MUTED,marginBottom:4}}>{k}</div>
              <div style={{fontSize:18,fontWeight:900,color:c,letterSpacing:"-0.5px",fontVariantNumeric:"tabular-nums"}}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Cash Flow Sankey */}
      <Card>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <Label>Cash Flow · {view==="norm"?"Normalized":"January Actual"}</Label>
          <div style={{fontSize:11,color:DIM}}>Income → Categories</div>
        </div>
        <CashFlowSankey viewMode={view}/>
      </Card>

      <div style={{display:"grid",gridTemplateColumns:wide?"1.6fr 1fr":"1fr",gap:16}}>
        {/* Table / Card list */}
        <Card style={{padding:0,overflow:"hidden"}}>
          <div style={{padding:"14px 16px 10px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <Label>Category Breakdown</Label>
            <div style={{display:"flex",gap:6}}>
              {[["norm","Normalized"],["actual","Actual"]].map(([v,l])=>(
                <button key={v} onClick={()=>setView(v)} style={{
                  padding:"5px 12px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                  background:view===v?ACCENT+"22":BG, color:view===v?ACCENT:MUTED,
                  border:`1px solid ${view===v?ACCENT:BORDER}`, transition:"all .15s",
                }}>{l}</button>
              ))}
            </div>
          </div>

          {isMobile ? (
            /* ── MOBILE: card rows, no column overflow ── */
            <>
              {sortedSummaryRows.map((r,i)=>{
                const displayVal = view==="norm" ? r.norm : (r.checking+r.cc);
                const over = r.kc && displayVal > r.kc;
                const pct  = takeHome > 0 ? (displayVal / takeHome) * 100 : 0;
                const isOpen = expandedCat === r.cat;
                const txns = txnsFor(r.cat);
                return (
                  <div key={r.cat} style={{borderBottom:`1px solid ${isOpen?r.color+"44":BORDER}`}}>
                    {/* Main row */}
                    <div onClick={()=>setExpandedCat(isOpen?null:r.cat)}
                      style={{padding:"12px 16px",background:isOpen?r.color+"0d":i%2===0?SURFACE:BG,cursor:"pointer"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:7}}>
                        <div style={{width:32,height:32,borderRadius:10,background:r.color+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          <span style={{fontSize:17}}>{r.icon}</span>
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:14,fontWeight:isOpen?700:600,color:isOpen?r.color:TEXT}}>{r.cat}</div>
                          {r.oneTime>0&&view==="actual"&&<div style={{marginTop:2}}><Tag color="#f59e0b">−{fmt(r.oneTime)} one-time</Tag></div>}
                        </div>
                        <div style={{textAlign:"right",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
                          <div>
                            <div style={{fontSize:17,fontWeight:900,color:isOpen?r.color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(displayVal)}</div>
                            <div style={{fontSize:11,color:MUTED}}>{pct.toFixed(1)}%</div>
                          </div>
                          <span style={{fontSize:14,color:isOpen?r.color:MUTED,transition:"transform .2s",display:"inline-block",transform:isOpen?"rotate(180deg)":"none"}}>▾</span>
                        </div>
                      </div>
                      <PBar pct={pct*2.5} color={r.color} h={4}/>
                      <div style={{display:"flex",gap:6,marginTop:7,flexWrap:"wrap"}}>
                        {r.checking>0 && <span style={{fontSize:11,color:"#3b82f6",background:"#3b82f611",padding:"2px 8px",borderRadius:99,fontVariantNumeric:"tabular-nums"}}>🏦 {fmt(r.checking)}</span>}
                        {r.cc>0       && <span style={{fontSize:11,color:"#6366f1",background:"#6366f111",padding:"2px 8px",borderRadius:99,fontVariantNumeric:"tabular-nums"}}>💳 {fmt(r.cc)}</span>}
                        {r.kc         && <Tag color={over?"#ef4444":"#22c55e"}>KC {fmt(r.kc)}</Tag>}
                      </div>
                    </div>
                    {/* Expanded transactions — split Checking / CC */}
                    {isOpen && (()=>{
                      const chkTxns = txns.filter(t => t.id?.startsWith("c") && !t.id?.startsWith("cc"));
                      const ccTxnList = txns.filter(t => t.id?.startsWith("cc"));
                      const MobileTxnRows = ({list}) => list.length === 0
                        ? <div style={{padding:"10px 16px",fontSize:12,color:DIM,fontStyle:"italic"}}>No transactions</div>
                        : list.map((t,j) => (
                          <div key={j} style={{padding:"9px 16px",borderBottom:`1px solid ${r.color}15`,background:j%2===0?"transparent":r.color+"07"}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                              <span style={{fontSize:11,color:MUTED}}>{t.date}</span>
                              <span style={{fontSize:14,fontWeight:700,color:t.amount<0?"#22c55e":TEXT,fontVariantNumeric:"tabular-nums"}}>
                                {t.amount<0?"+":""}{fmt(t.amount)}
                              </span>
                            </div>
                            <div style={{fontSize:13,color:TEXT}}>{t.desc}</div>
                            {t.note&&!t.note.includes("ONE-TIME")&&<div style={{fontSize:11,color:DIM,marginTop:2}}>{t.note}</div>}
                          </div>
                        ));
                      const MobileSectionHeader = ({label, total, accent, count}) => (
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                          padding:"7px 16px",background:accent+"18",borderTop:`1px solid ${accent}33`,borderBottom:`1px solid ${accent}33`}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontSize:11,fontWeight:800,color:accent,textTransform:"uppercase",letterSpacing:".4px"}}>{label}</span>
                            <span style={{fontSize:10,color:accent,opacity:.7}}>{count} txn{count!==1?"s":""}</span>
                          </div>
                          <span style={{fontSize:13,fontWeight:800,color:accent,fontVariantNumeric:"tabular-nums"}}>{fmt(total)}</span>
                        </div>
                      );
                      return (
                        <div style={{background:r.color+"09",borderTop:`1px solid ${r.color}33`}}>
                          <MobileSectionHeader label="🏦 Checking" accent="#3b82f6"
                            count={chkTxns.length} total={chkTxns.reduce((s,t)=>s+t.amount,0)}/>
                          <MobileTxnRows list={chkTxns}/>
                          <MobileSectionHeader label="💳 Credit Card" accent="#6366f1"
                            count={ccTxnList.length} total={ccTxnList.reduce((s,t)=>s+t.amount,0)}/>
                          <MobileTxnRows list={ccTxnList}/>
                          <div style={{padding:"9px 16px",display:"flex",justifyContent:"space-between",borderTop:`1px solid ${r.color}22`}}>
                            <span style={{fontSize:12,color:r.color,fontWeight:700}}>{txns.length} total</span>
                            <span style={{fontSize:13,fontWeight:900,color:r.color,fontVariantNumeric:"tabular-nums"}}>{fmt(txns.reduce((s,t)=>s+t.amount,0))}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
              {/* Mobile totals */}
              <div style={{padding:"12px 16px",background:BG,borderTop:`2px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:14,fontWeight:700,color:MUTED}}>Total</span>
                <span style={{fontSize:17,fontWeight:900,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(view==="norm"?normTotal:janActual)}</span>
              </div>
              <div style={{padding:"10px 16px",background:BG,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:14,fontWeight:700,color:normSurplus<0?"#ef4444":"#22c55e"}}>vs Take-Home</span>
                <span style={{fontSize:17,fontWeight:900,color:normSurplus<0?"#ef4444":"#22c55e",fontVariantNumeric:"tabular-nums"}}>
                  {normSurplus<0?"−":"+"}{fmt(Math.abs(view==="norm"?normSurplus:takeHome-janActual))}
                </span>
              </div>
            </>
          ) : (
            /* ── DESKTOP: full 6-col table ── */
            <>
              <div style={{display:"grid",gridTemplateColumns:"28px 1fr 70px 70px 80px 80px",gap:0,padding:"9px 14px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
                {["","Category","Checking","CC",view==="norm"?"Normalized":"Actual","KC Avg"].map((h,i)=>(
                  <div key={i} style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".4px",textAlign:i>1?"right":"left"}}>{h}</div>
                ))}
              </div>
              {sortedSummaryRows.map((r,i)=>{
                const displayVal = view==="norm" ? r.norm : (r.checking+r.cc);
                const over = r.kc && displayVal > r.kc;
                const isOpen = expandedCat === r.cat;
                const txns = txnsFor(r.cat);
                return (
                  <div key={r.cat}>
                    {/* Main row — clickable */}
                    <div onClick={()=>setExpandedCat(isOpen?null:r.cat)}
                      style={{display:"grid",gridTemplateColumns:"28px 1fr 70px 70px 80px 80px",gap:0,padding:"10px 14px",
                        borderBottom:`1px solid ${isOpen?r.color+"44":BORDER}`,
                        background:isOpen?r.color+"0d":i%2===0?SURFACE:BG,
                        alignItems:"center",cursor:"pointer",transition:"background .15s"}}>
                      <span style={{fontSize:16}}>{r.icon}</span>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{fontSize:13,fontWeight:isOpen?700:500,color:isOpen?r.color:TEXT}}>{r.cat}</div>
                        {r.oneTime>0&&view==="actual"&&<Tag color="#f59e0b">−{fmt(r.oneTime)} one-time</Tag>}
                        <span style={{fontSize:10,color:isOpen?r.color:MUTED,marginLeft:"auto",transition:"transform .2s",display:"inline-block",transform:isOpen?"rotate(180deg)":"none"}}>▾</span>
                      </div>
                      <div style={{textAlign:"right",fontSize:12,color:r.checking>0?"#94a3b8":DIM,fontVariantNumeric:"tabular-nums"}}>{r.checking>0?fmt(r.checking):"—"}</div>
                      <div style={{textAlign:"right",fontSize:12,color:r.cc>0?"#94a3b8":DIM,fontVariantNumeric:"tabular-nums"}}>{r.cc>0?fmt(r.cc):"—"}</div>
                      <div style={{textAlign:"right",fontSize:14,fontWeight:700,color:isOpen?r.color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(displayVal)}</div>
                      <div style={{textAlign:"right"}}>{r.kc?<Tag color={over?"#ef4444":"#22c55e"}>{fmt(r.kc)}</Tag>:<span style={{color:DIM,fontSize:12}}>—</span>}</div>
                    </div>
                    {/* Expanded transaction list — split Checking / CC */}
                    {isOpen && (()=>{
                      const chkTxns = txns.filter(t => t.id?.startsWith("c") && !t.id?.startsWith("cc"));
                      const ccTxnList = txns.filter(t => t.id?.startsWith("cc"));
                      const TxnRows = ({list, accent}) => list.length === 0
                        ? <div style={{padding:"8px 14px 8px 42px",fontSize:12,color:DIM,fontStyle:"italic"}}>No transactions</div>
                        : list.map((t,j) => (
                          <div key={j} style={{display:"grid",gridTemplateColumns:"50px 1fr 90px",padding:"8px 14px 8px 42px",
                            borderBottom:`1px solid ${r.color}12`,background:j%2===0?"transparent":r.color+"06",alignItems:"center"}}>
                            <div style={{fontSize:11,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{t.date}</div>
                            <div>
                              <div style={{fontSize:12,color:TEXT}}>{t.desc}</div>
                              {t.note&&!t.note.includes("ONE-TIME")&&<div style={{fontSize:10,color:DIM,marginTop:1}}>{t.note}</div>}
                              {t.note?.includes("ONE-TIME")&&<Tag color="#f59e0b">one-time</Tag>}
                            </div>
                            <div style={{textAlign:"right",fontSize:13,fontWeight:700,
                              color:t.amount<0?"#22c55e":TEXT,fontVariantNumeric:"tabular-nums"}}>
                              {t.amount<0?"+":""}{fmt(t.amount)}
                            </div>
                          </div>
                        ));
                      const SectionHeader = ({label, total, accent, count}) => (
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                          padding:"6px 14px 6px 42px",background:accent+"18",borderBottom:`1px solid ${accent}33`}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:11,fontWeight:800,color:accent,textTransform:"uppercase",letterSpacing:".5px"}}>{label}</span>
                            <span style={{fontSize:10,color:accent,opacity:.7}}>{count} txn{count!==1?"s":""}</span>
                          </div>
                          <span style={{fontSize:13,fontWeight:800,color:accent,fontVariantNumeric:"tabular-nums"}}>{fmt(total)}</span>
                        </div>
                      );
                      return (
                        <div style={{background:r.color+"07",borderBottom:`2px solid ${r.color}33`}}>
                          {/* Checking section */}
                          <SectionHeader label="🏦 Checking" accent="#3b82f6"
                            count={chkTxns.length}
                            total={chkTxns.reduce((s,t)=>s+t.amount,0)}/>
                          <TxnRows list={chkTxns} accent="#3b82f6"/>
                          {/* CC section */}
                          <SectionHeader label="💳 Credit Card" accent="#6366f1"
                            count={ccTxnList.length}
                            total={ccTxnList.reduce((s,t)=>s+t.amount,0)}/>
                          <TxnRows list={ccTxnList} accent="#6366f1"/>
                          {/* Combined footer */}
                          <div style={{display:"flex",justifyContent:"space-between",padding:"9px 14px 9px 42px",
                            borderTop:`1px solid ${r.color}22`}}>
                            <span style={{fontSize:12,fontWeight:700,color:r.color}}>{txns.length} total transactions</span>
                            <span style={{fontSize:13,fontWeight:900,color:r.color,fontVariantNumeric:"tabular-nums"}}>
                              {fmt(txns.reduce((s,t)=>s+t.amount,0))}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
              <div style={{display:"grid",gridTemplateColumns:"28px 1fr 70px 70px 80px 80px",gap:0,padding:"11px 14px",borderTop:`2px solid ${BORDER}`,background:BG}}>
                <div/><div style={{fontSize:13,fontWeight:800,color:MUTED}}>Total</div>
                <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(checkTotal)}</div>
                <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(ccTotal)}</div>
                <div style={{textAlign:"right",fontSize:14,fontWeight:900,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(view==="norm"?normTotal:janActual)}</div>
                <div/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"28px 1fr 70px 70px 80px 80px",gap:0,padding:"11px 14px",background:BG}}>
                <div/><div style={{fontSize:13,fontWeight:800,color:normSurplus<0?"#ef4444":"#22c55e"}}>vs Take-Home</div>
                <div/><div/>
                <div style={{textAlign:"right",fontSize:14,fontWeight:900,color:normSurplus<0?"#ef4444":"#22c55e",fontVariantNumeric:"tabular-nums"}}>
                  {normSurplus<0?"−":"+"}{fmt(Math.abs(view==="norm"?normSurplus:takeHome-janActual))}
                </div>
                <div/>
              </div>
            </>
          )}
        </Card>

        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <Label>Spend Breakdown · {view==="norm"?"Normalized":"Actual"}</Label>
            <div style={{display:"flex",justifyContent:"center"}}>
              <PieChart width={200} height={200}>
                <Pie data={donutData} cx={95} cy={95} innerRadius={50} outerRadius={90} dataKey="value" stroke="none" paddingAngle={2}>
                  {donutData.map((d,i)=><Cell key={i} fill={d.fill}/>)}
                </Pie>
                <Tooltip content={<Tip/>}/>
              </PieChart>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {donutData.map(d=>(
                <div key={d.name} style={{display:"flex",alignItems:"center",gap:7}}>
                  <div style={{width:8,height:8,borderRadius:2,background:d.fill,flexShrink:0}}/>
                  <span style={{fontSize:12,color:"#94a3b8",flex:1}}>{d.name}</span>
                  <span style={{fontSize:12,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(d.value)}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <Label>One-Time Items (excluded from recurring)</Label>
            {oneTimes.length === 0
              ? <div style={{fontSize:12,color:MUTED}}>No one-time items yet — add them in Settings.</div>
              : oneTimes.map((t,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${BORDER}`}}>
                  <div><div style={{fontSize:13,color:MUTED}}>{t.name}</div><div style={{fontSize:11,color:DIM}}>{t.cat}</div></div>
                  <span style={{fontSize:14,fontWeight:700,color:"#f59e0b",fontVariantNumeric:"tabular-nums"}}>{fmt(t.amount)}</span>
                </div>
              ))
            }
            {oneTimes.length > 0 && (
            <div style={{display:"flex",justifyContent:"space-between",paddingTop:10}}>
              <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>Total excluded</span>
              <span style={{fontSize:15,fontWeight:900,color:"#f59e0b",fontVariantNumeric:"tabular-nums"}}>{fmt(oneTimes.reduce((s,o)=>s+o.amount,0))}</span>
            </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── SCENARIOS / TRIP PLANNER ──────────────────────────────────────────────────
let _planId = 1;
const mkPlanId = () => "plan" + (_planId++);
let _itemId = 100;
const mkItemId = () => "item" + (_itemId++);

const PLAN_PRESETS = [
  { label:"2nd Tithe / Feast", emoji:"⛪" },
  { label:"Monthly Surplus",   emoji:"📅" },
  { label:"Custom Amount",     emoji:"✏️" },
];

const ITEM_CATS = [
  { label:"Lodging",    emoji:"🏠", color:"#3b82f6" },
  { label:"Food",       emoji:"🍽️", color:"#f97316" },
  { label:"Transport",  emoji:"🚗", color:"#06b6d4" },
  { label:"Activities", emoji:"🎯", color:"#8b5cf6" },
  { label:"Shopping",   emoji:"🛍️", color:"#f59e0b" },
  { label:"Misc",       emoji:"📦", color:"#94a3b8" },
];

function Scenarios({ wide, isMobile }) {
  const { payoffs, normSurplus, takeHome, t2CarryIn, groceryGoal, checkTxns, ccTxns, selectedMonth, showTithe } = useBudget();
  const t2Balance = t2CarryIn;

  const [plans, setPlans] = useState([
    {
      id: mkPlanId(), name:"Feast of Tabernacles", emoji:"⛪",
      startingFunds: t2Balance,
      fundLabel: "2nd Tithe Balance",
      items: [
        { id:mkItemId(), desc:"Airbnb / Lodging", amount:1200, cat:"Lodging" },
        { id:mkItemId(), desc:"Groceries & food", amount:400,  cat:"Food" },
        { id:mkItemId(), desc:"Gas / travel",     amount:200,  cat:"Transport" },
      ]
    }
  ]);
  const [activeTab, setActiveTab] = useState("planner"); // "planner" | "waterfall"

  // ── Plan CRUD ──────────────────────────────────────────────────────────────
  const addPlan = () => setPlans(prev => [...prev, {
    id: mkPlanId(), name:"New Plan", emoji:"📋",
    startingFunds: 1000, fundLabel:"Available Funds",
    items: [],
  }]);

  const updatePlan = (pid, field, val) =>
    setPlans(prev => prev.map(p => p.id===pid ? {...p, [field]:val} : p));

  const removePlan = pid =>
    setPlans(prev => prev.filter(p => p.id !== pid));

  const addItem = pid => setPlans(prev => prev.map(p =>
    p.id!==pid ? p : {...p, items:[...p.items, {id:mkItemId(), desc:"", amount:0, cat:"Misc"}]}
  ));

  const updateItem = (pid, iid, field, val) => setPlans(prev => prev.map(p =>
    p.id!==pid ? p : {...p, items: p.items.map(it => it.id!==iid ? it : {...it,[field]:val})}
  ));

  const removeItem = (pid, iid) => setPlans(prev => prev.map(p =>
    p.id!==pid ? p : {...p, items: p.items.filter(it => it.id!==iid)}
  ));

  // ── Custom scenario steps ────────────────────────────────────────────────
  const [customSteps, setCustomSteps] = useState(() => {
    try { const s = localStorage.getItem("budget_customScenarios"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [newStepLabel, setNewStepLabel] = useState("");
  const [newStepAmt, setNewStepAmt] = useState("");
  const [newStepColor, setNewStepColor] = useState("#8b5cf6");
  const saveCustomSteps = (steps) => { setCustomSteps(steps); try { localStorage.setItem("budget_customScenarios", JSON.stringify(steps)); } catch {} };
  const addCustomStep = () => {
    if (!newStepLabel || !newStepAmt) return;
    const step = { id: "cs" + Date.now(), label: newStepLabel, payment: parseFloat(newStepAmt) || 0, color: newStepColor };
    saveCustomSteps([...customSteps, step]);
    setNewStepLabel(""); setNewStepAmt("");
  };
  const removeCustomStep = (id) => saveCustomSteps(customSteps.filter(s => s.id !== id));
  // ── Waterfall data — auto over-budget categories + payoffs + custom ─────────
  const { summaryRows: wfRows, waterfallDisabled } = useBudget();
  const waterfallSteps = useMemo(() => {
    let remaining = Math.abs(normSurplus);
    const steps = [
      { id:"gap", label:"Current gap", spend: remaining, surplus: normSurplus, color:"#ef4444" },
    ];
    // Auto: any category that has a KC target and is over it
    wfRows.forEach(r => {
      if (!r.kc) return;
      const actual = r.checking + r.cc;
      const save = actual - r.kc;
      if (save <= 0) return;
      const stepId = "cat_" + r.cat;
      if (waterfallDisabled.includes(stepId)) return;
      remaining = remaining - save;
      steps.push({ id: stepId, label: r.cat + " →$" + r.kc.toLocaleString(), spend: remaining, surplus: -(remaining), color: r.color, payment: save, auto: true, cat: r.cat });
    });
    // Payoffs
    payoffs.forEach(p => {
      if (waterfallDisabled.includes("payoff_" + p.id)) return;
      remaining = remaining - p.payment;
      steps.push({ id:"payoff_"+p.id, label:p.name, spend: remaining, surplus: -(remaining), color:p.color, payment:p.payment });
    });
    // Custom steps
    customSteps.forEach(s => {
      if (waterfallDisabled.includes(s.id)) return;
      remaining = remaining - s.payment;
      steps.push({ id:s.id, label:s.label, spend: remaining, surplus: -(remaining), color:s.color, payment:s.payment });
    });
    return steps;
  }, [wfRows, payoffs, customSteps, waterfallDisabled, normSurplus, groceryGoal, checkTxns, ccTxns, selectedMonth]);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* Tab switcher */}
      <div style={{display:"flex",gap:8}}>
        {[["planner","🗓 Trip / Event Planner"],["waterfall","📊 Payoff Waterfall"]].map(([t,l])=>(
          <button key={t} onClick={()=>setActiveTab(t)} style={{
            padding:"9px 18px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",
            background:activeTab===t?ACCENT+"22":BG,color:activeTab===t?ACCENT:MUTED,
            border:`1px solid ${activeTab===t?ACCENT:BORDER}`,transition:"all .15s",
          }}>{l}</button>
        ))}
      </div>

      {/* ── PLANNER TAB ── */}
      {activeTab==="planner" && (
        <>
          <Card glow="#22d3ee">
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:24}}>🗓</span>
              <div>
                <Label style={{marginBottom:2}}>What-If Budget Planner</Label>
                <div style={{fontSize:13,color:MUTED}}>Plan trips, events, or spending scenarios. Set your starting funds, add items, and see exactly what's left.</div>
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:12,flexWrap:"wrap"}}>
              {showTithe && (
              <div style={{padding:"10px 14px",borderRadius:10,background:"#22c55e11",border:"1px solid #22c55e33",fontSize:12,color:"#22c55e",fontWeight:700}}>
                ⛪ 2nd Tithe: {fmt(t2Balance)}
              </div>
              )}
              <div style={{padding:"10px 14px",borderRadius:10,background:normSurplus<0?"#ef444411":"#22c55e11",border:`1px solid ${normSurplus<0?"#ef444433":"#22c55e33"}`,fontSize:12,color:normSurplus<0?"#ef4444":"#22c55e",fontWeight:700}}>
                📅 Monthly surplus: {normSurplus>=0?"+":"−"}{fmt(Math.abs(normSurplus))}
              </div>
            </div>
          </Card>

          <div style={{display:"grid",gridTemplateColumns:wide&&plans.length>1?"1fr 1fr":"1fr",gap:16}}>
            {plans.map(plan => {
              const totalSpend = plan.items.reduce((s,it)=>s+(parseFloat(it.amount)||0),0);
              const remaining  = plan.startingFunds - totalSpend;
              const remColor   = remaining>=0?"#22c55e":remaining>-200?"#f59e0b":"#ef4444";
              return (
                <Card key={plan.id} style={{border:`1px solid ${remaining>=0?"#22c55e33":remaining>-200?"#f59e0b33":"#ef444433"}`}}>
                  {/* Plan header */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flex:1,minWidth:0}}>
                      <span style={{fontSize:20}}>{plan.emoji}</span>
                      <input value={plan.name} onChange={e=>updatePlan(plan.id,"name",e.target.value)}
                        style={{background:"transparent",border:"none",borderBottom:`1px solid ${BORDER}`,color:TEXT,fontSize:15,fontWeight:700,flex:1,minWidth:0,outline:"none",paddingBottom:2}}/>
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      {["⛪","📅","🏕️","✈️","🎪","📋"].map(e=>(
                        <button key={e} onClick={()=>updatePlan(plan.id,"emoji",e)} style={{background:"transparent",border:"none",fontSize:16,cursor:"pointer",opacity:plan.emoji===e?1:.4,padding:"2px"}}>{e}</button>
                      ))}
                      <button onClick={()=>removePlan(plan.id)} style={{marginLeft:4,padding:"3px 8px",borderRadius:6,fontSize:11,cursor:"pointer",background:"#ef444411",color:"#ef4444",border:"1px solid #ef444422"}}>✕</button>
                    </div>
                  </div>

                  {/* Starting funds */}
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14,padding:"10px 12px",background:BG,borderRadius:10,border:`1px solid ${BORDER}`}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Starting Funds</div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:16,color:MUTED}}>$</span>
                        <input type="number" value={plan.startingFunds}
                          onChange={e=>updatePlan(plan.id,"startingFunds",parseFloat(e.target.value)||0)}
                          style={{background:"transparent",border:"none",color:TEXT,fontSize:20,fontWeight:900,width:"100%",outline:"none",fontVariantNumeric:"tabular-nums"}}/>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:4,flexWrap:"wrap",justifyContent:"flex-end"}}>
                      {showTithe && <button onClick={()=>updatePlan(plan.id,"startingFunds",t2Balance)} style={{padding:"4px 8px",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer",background:"#7c6af722",color:"#7c6af7",border:"1px solid #7c6af733"}}>⛪ 2nd Tithe</button>}
                      <button onClick={()=>updatePlan(plan.id,"startingFunds",Math.max(0,normSurplus))} style={{padding:"4px 8px",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer",background:"#22c55e22",color:"#22c55e",border:"1px solid #22c55e33"}}>📅 Surplus</button>
                    </div>
                  </div>

                  {/* Items */}
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                    {plan.items.map(item => {
                      const catMeta = ITEM_CATS.find(c=>c.label===item.cat)||ITEM_CATS[5];
                      return (
                        <div key={item.id} style={{display:"grid",gridTemplateColumns:"28px 1fr 80px 32px",gap:6,alignItems:"center",padding:"7px 10px",borderRadius:10,background:BG,border:`1px solid ${BORDER}`}}>
                          <select value={item.cat} onChange={e=>updateItem(plan.id,item.id,"cat",e.target.value)}
                            style={{background:"transparent",border:"none",fontSize:16,cursor:"pointer",color:catMeta.color,padding:0,width:28,outline:"none",appearance:"none"}}>
                            {ITEM_CATS.map(c=><option key={c.label} value={c.label}>{c.emoji}</option>)}
                          </select>
                          <input value={item.desc} onChange={e=>updateItem(plan.id,item.id,"desc",e.target.value)}
                            placeholder="Description…"
                            style={{background:"transparent",border:"none",color:TEXT,fontSize:13,outline:"none"}}/>
                          <div style={{display:"flex",alignItems:"center",gap:2}}>
                            <span style={{color:MUTED,fontSize:12}}>$</span>
                            <input type="number" value={item.amount} onChange={e=>updateItem(plan.id,item.id,"amount",parseFloat(e.target.value)||0)}
                              style={{background:"transparent",border:"none",color:TEXT,fontSize:13,fontWeight:700,width:"100%",outline:"none",fontVariantNumeric:"tabular-nums",textAlign:"right"}}/>
                          </div>
                          <button onClick={()=>removeItem(plan.id,item.id)} style={{background:"transparent",border:"none",color:MUTED,fontSize:14,cursor:"pointer",padding:0}}>✕</button>
                        </div>
                      );
                    })}
                    <button onClick={()=>addItem(plan.id)} style={{padding:"7px",borderRadius:10,border:`1px dashed ${BORDER}`,background:"transparent",color:MUTED,fontSize:12,cursor:"pointer",fontWeight:600}}>
                      + Add item
                    </button>
                  </div>

                  {/* Running total */}
                  <div style={{borderTop:`1px solid ${BORDER}`,paddingTop:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:12,color:MUTED}}>Total planned spend</span>
                      <span style={{fontSize:14,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(totalSpend)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:13,fontWeight:700,color:MUTED}}>Remaining</span>
                      <span style={{fontSize:26,fontWeight:900,color:remColor,fontVariantNumeric:"tabular-nums",letterSpacing:"-0.5px"}}>
                        {remaining>=0?"+":"−"}{fmt(Math.abs(remaining))}
                      </span>
                    </div>
                    <PBar pct={Math.min(100,(totalSpend/plan.startingFunds)*100)} color={remColor} h={6}/>
                    <div style={{fontSize:11,color:MUTED,marginTop:4}}>
                      {Math.round((totalSpend/plan.startingFunds)*100)}% of {fmt(plan.startingFunds)} budgeted
                    </div>
                  </div>
                </Card>
              );
            })}

            {/* Add new plan */}
            <button onClick={addPlan} style={{
              border:`2px dashed ${BORDER}`,borderRadius:18,padding:"32px",textAlign:"center",cursor:"pointer",
              background:"transparent",color:MUTED,fontSize:13,fontWeight:600,
              display:"flex",flexDirection:"column",alignItems:"center",gap:8,minHeight:120,
            }}>
              <span style={{fontSize:28}}>+</span>
              <span>New Plan</span>
              <span style={{fontSize:11,color:DIM}}>Trip, event, or spending scenario</span>
            </button>
          </div>
        </>
      )}

      {/* ── WATERFALL TAB ── */}
      {activeTab==="waterfall" && (
        <>
          <Card glow="#818cf8">
            <Label>Payoff Waterfall · Updates live from Payoffs tab</Label>
            <div style={{fontSize:13,color:MUTED,marginTop:4}}>Each bar shows monthly surplus after that debt disappears. Edit balances and payments in the Payoffs tab — this chart updates automatically.</div>
          </Card>

          <Card>
            <Label>Monthly Surplus Step-Down</Label>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={waterfallSteps} barSize={wide?32:20} margin={{left:-14}}>
                <XAxis dataKey="label" tick={{fontSize:wide?11:9,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>v.slice(0,12)} interval={0}/>
                <YAxis tick={{fontSize:11,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(Math.abs(v)/1000).toFixed(0)}k`} width={38}/>
                <ReferenceLine y={0} stroke={ACCENT} strokeDasharray="4 3" label={{value:"Break-even",fill:ACCENT,fontSize:10,position:"right"}}/>
                <Tooltip content={<Tip/>}/>
                <Bar dataKey="surplus" name="Monthly Surplus" radius={[5,5,0,0]}>
                  {waterfallSteps.map((d,i)=>{
                    const col = d.surplus>=0?"#22c55e":d.surplus>-500?"#f59e0b":"#ef4444";
                    return <Cell key={i} fill={d.color||col} opacity={0.85}/>;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:12}}>
            {waterfallSteps.slice(1).map((step,i)=>{
              const sur = step.surplus;
              const col = sur>=0?"#22c55e":sur>-500?"#f59e0b":"#ef4444";
              const payoff = payoffs[i];
              return (
                <Card key={i} style={{border:`1px solid ${col}33`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:8,height:36,borderRadius:4,background:payoff?.color||col}}/>
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:TEXT}}>{step.label} paid off</div>
                        <div style={{fontSize:12,color:MUTED}}>+{fmt(step.payment)}/mo freed</div>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:22,fontWeight:900,color:col,fontVariantNumeric:"tabular-nums"}}>{sur>=0?"+":"−"}{fmt(Math.abs(sur))}</div>
                      <div style={{fontSize:11,color:MUTED}}>monthly surplus</div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* ── Custom scenario steps ── */}
          <Card glow="#8b5cf6">
            <Label>➕ Add Custom Scenario Step</Label>
            <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Add "what-if" savings like stopping ABA, reducing a category, or a pay raise.</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div style={{flex:2,minWidth:140}}>
                <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Label</div>
                <input value={newStepLabel} onChange={e=>setNewStepLabel(e.target.value)} placeholder="Stop ABA therapy"
                  style={{width:"100%",background:BG,border:"1px solid #8b5cf644",borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
              </div>
              <div style={{flex:1,minWidth:100}}>
                <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>$/mo saved</div>
                <input type="number" value={newStepAmt} onChange={e=>setNewStepAmt(e.target.value)} placeholder="683"
                  style={{width:"100%",background:BG,border:"1px solid #8b5cf644",borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center",paddingBottom:2}}>
                {["#8b5cf6","#06b6d4","#22c55e","#f59e0b","#ec4899","#ef4444"].map(c=>(
                  <button key={c} onClick={()=>setNewStepColor(c)} style={{width:20,height:20,borderRadius:5,background:c,border:`2px solid ${newStepColor===c?"white":"transparent"}`,cursor:"pointer",padding:0,flexShrink:0}}/>
                ))}
              </div>
              <button onClick={addCustomStep} style={{padding:"8px 16px",borderRadius:8,background:"#8b5cf6",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer",whiteSpace:"nowrap"}}>
                + Add Step
              </button>
            </div>
            {customSteps.length > 0 && (
              <div style={{marginTop:14,borderTop:"1px solid #1e2535",paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
                <div style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Custom Steps</div>
                {customSteps.map(s=>(
                  <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:BG,borderRadius:8,border:`1px solid ${s.color}33`}}>
                    <div style={{width:10,height:10,borderRadius:3,background:s.color,flexShrink:0}}/>
                    <span style={{flex:1,fontSize:13,color:TEXT}}>{s.label}</span>
                    <span style={{fontSize:13,fontWeight:700,color:"#22c55e",fontVariantNumeric:"tabular-nums"}}>+{new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(s.payment)}/mo</span>
                    <button onClick={()=>removeCustomStep(s.id)} style={{background:"transparent",border:"none",color:MUTED,fontSize:14,cursor:"pointer",padding:"0 4px"}}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ── ABA PLANNER ───────────────────────────────────────────────────────────────
function ABAPlanner({wide}) {
  const [sel, setSel] = useState(0);
  const opt = ABA_OPTIONS[sel];
  const { schedule, annualCost, capHit, fullMonthCost } = useMemo(()=>buildABASchedule(opt.daysPerWeek),[sel]);

  const capMonthLabel = useMemo(()=>{
    if(!capHit) return "No cap this year";
    const first = schedule.findIndex(m=>m.status!=="full");
    return first>=0 ? schedule[first].month+" "+schedule[first].year : "Dec";
  },[schedule,capHit]);

  // Annotation: which months are free
  const freeMonths2026 = schedule.filter(m=>m.year===2026&&m.status==="free").map(m=>m.month);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card glow="#f59e0b">
        <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
          <span style={{fontSize:20}}>📅</span>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#f59e0b",marginBottom:3}}>OOP Max Resets Every January 1</div>
            <div style={{fontSize:13,color:MUTED,lineHeight:1.6}}>
              The $7,000 individual OOP max is per insurance year. After Dec 31 the counter resets — copays start again from $0. Hit the cap before year-end and the remaining months are free.
            </div>
          </div>
        </div>
      </Card>

      {/* Schedule picker */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        {ABA_OPTIONS.map((o,i)=>{
          const {annualCost:ac,capHit:ch,fullMonthCost:fmc} = buildABASchedule(o.daysPerWeek);
          const avgMonthly = ac / 12;
          return (
            <button key={i} onClick={()=>setSel(i)} style={{
              padding:wide?"20px 12px":"14px 8px", borderRadius:16,
              background:sel===i?ACCENT+"18":SURFACE,
              border:`2px solid ${sel===i?ACCENT:BORDER}`,
              cursor:"pointer", textAlign:"center", transition:"all .2s",
            }}>
              <div style={{fontSize:wide?15:13,fontWeight:700,color:sel===i?ACCENT:"#64748b",marginBottom:5}}>{o.label}</div>
              <div style={{fontSize:wide?26:22,fontWeight:900,color:TEXT,letterSpacing:"-0.5px",fontVariantNumeric:"tabular-nums"}}>{fmt(avgMonthly)}</div>
              <div style={{fontSize:11,color:MUTED,marginTop:3}}>avg/month</div>
              <div style={{fontSize:11,color:"#64748b",marginTop:2}}>({fmt(fmc)}/mo full rate)</div>
              <div style={{fontSize:11,color:ch?"#f59e0b":"#64748b",marginTop:3}}>{ch?"Cap hits ":"No cap — "}{ch?buildABASchedule(o.daysPerWeek).schedule.find(m=>m.status!=="full")?.month+" each yr":"pays all year"}</div>
              <div style={{fontSize:11,color:ch?"#94a3b8":"#22c55e",marginTop:2,fontWeight:700}}>{fmt(ac)}/yr</div>
            </button>
          );
        })}
      </div>

      <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:16}}>
        {/* Detail card */}
        <Card glow="#8b5cf6">
          <Label>Selected: {opt.label}</Label>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[
              ["Monthly Cost",  fmt(fullMonthCost),  ACCENT],
              ["Cap Status",    capMonthLabel,         capHit?"#f59e0b":"#64748b"],
              ["Annual Cost",   fmt(annualCost),       capHit?"#94a3b8":"#22c55e"],
              ["Annual Avg/mo", fmt(annualCost/12),    "#94a3b8"],
            ].map(([k,v,c])=>(
              <div key={k} style={{background:BG,borderRadius:12,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:MUTED,marginBottom:4}}>{k}</div>
                <div style={{fontSize:18,fontWeight:800,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
              </div>
            ))}
          </div>
          {capHit ? (
            <div style={{marginTop:12,padding:"10px 14px",background:"#f59e0b12",borderRadius:10,border:"1px solid #f59e0b33"}}>
              <span style={{fontSize:13,color:"#f59e0b",fontWeight:600}}>⚡ Hits $7k OOP cap · {freeMonths2026.join(" & ")} are free each year</span>
            </div>
          ) : (
            <div style={{marginTop:12,padding:"10px 14px",background:"#ef444412",borderRadius:10,border:"1px solid #ef444433"}}>
              <span style={{fontSize:13,color:"#ef4444",fontWeight:600}}>
                ⚠️ Never hits OOP cap — annual cost {fmt(annualCost)} vs {fmt(7000)} for 5-day ({fmt(annualCost-7000)} MORE/yr)
              </span>
            </div>
          )}
        </Card>

        {/* Dynamic chart */}
        <Card>
          <Label>2026–2027 Monthly Cost · {opt.label}</Label>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={schedule} barSize={14} margin={{left:-14}}>
              <XAxis dataKey="month" tick={{fontSize:9,fill:MUTED}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`} width={38} domain={[0,fullMonthCost*1.1]}/>
              <Tooltip content={<Tip/>} formatter={(v,_,p)=>[fmt(v),p.payload.year+" · "+p.payload.status]}/>
              <Bar dataKey="cost" name="ABA Cost" radius={[4,4,0,0]}>
                {schedule.map((d,i)=>(
                  <Cell key={i} fill={d.status==="free"?"#22c55e":d.status==="partial"?"#f59e0b":d.year===2027?"#7c6af7":"#8b5cf6"}/>
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{display:"flex",flexWrap:"wrap",gap:12,marginTop:8}}>
            {[["#8b5cf6","2026 full"],["#7c6af7","2027 full"],["#f59e0b","Cap month (partial)"],["#22c55e","Free!"]].map(([c,l])=>(
              <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:8,height:8,borderRadius:2,background:c}}/>
                <span style={{fontSize:10,color:MUTED}}>{l}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <Label>Clinical Note</Label>
        <p style={{fontSize:14,color:"#64748b",lineHeight:1.75}}>
          ABA is dose-dependent. The 5-day schedule hits the $7k OOP cap fastest each year ({freeMonths2026.length>0?freeMonths2026.join(" & ")+" are free each Nov-Dec":"no free months at this schedule"}). After Jan 1 the counter resets and copays resume from $0. Fewer weekly days reduces monthly cost but means you never hit the cap — and paradoxically pay <strong style={{color:"#ef4444"}}>more annually</strong> than the 5-day schedule. Check with Success on the Spectrum before adjusting.
        </p>
      </Card>
    </div>
  );
}

// ── PAYOFFS ───────────────────────────────────────────────────────────────────
const PAYOFF_COLORS = ["#22c55e","#a78bfa","#64748b","#475569","#f59e0b","#ef4444","#06b6d4","#ec4899","#3b82f6","#10b981"];

function Payoffs({wide}) {
  const { payoffs, setPayoffs, normSurplus, groceryGoal, checkTxns, ccTxns, selectedMonth, takeHome } = useBudget();
  const [enabled, setEnabled] = useState(() => {
    try {
      const s = ls.get("budget_payoffEnabled");
      if (s) return new Set(JSON.parse(s));
    } catch {}
    return new Set(payoffs.map(p => p.id));
  });
  useEffect(() => { ls.setJSON("budget_payoffEnabled", [...enabled]); }, [enabled]);
  const [editId,  setEditId]    = useState(null);
  const [adding,  setAdding]    = useState(false);
  const [newDebt, setNewDebt]   = useState({ name:"", payment:"", balance:"", date:"", months:"", pct:50, color:"#22c55e" });

  const toggle = id => setEnabled(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });

  const updateField = (id, field, val) =>
    setPayoffs(prev => prev.map(p => p.id===id ? {...p, [field]:val} : p));

  const removePayoff = id => {
    setPayoffs(prev => prev.filter(p => p.id !== id));
    setEnabled(prev => { const n=new Set(prev); n.delete(id); return n; });
    if(editId===id) setEditId(null);
  };

  const addPayoff = () => {
    if(!newDebt.name || !newDebt.payment) return;
    const id = "p" + Date.now();
    const p = {
      id,
      name:     newDebt.name,
      payment:  parseFloat(newDebt.payment)||0,
      balance:  parseFloat((newDebt.balance||"0").replace(/[$,]/g,""))||0,
      balanceStr: newDebt.balance || "$0",
      date:     newDebt.date || "TBD",
      months:   newDebt.months || "TBD",
      pct:      parseInt(newDebt.pct)||50,
      color:    newDebt.color,
    };
    setPayoffs(prev => [...prev, p]);
    setEnabled(prev => new Set([...prev, id]));
    setNewDebt({ name:"", payment:"", balance:"", date:"", months:"", pct:50, color:"#22c55e" });
    setAdding(false);
  };

  const totalRelief  = payoffs.filter(p=>enabled.has(p.id)).reduce((s,p)=>s+p.payment,0);
  const actualGroceries = [...checkTxns, ...ccTxns].filter(t => t.month === selectedMonth && t.cat === "Groceries").reduce((s,t) => s+t.amount, 0);
  const grocerySave  = Math.max(0, actualGroceries - groceryGoal);
  const projSurplus  = normSurplus + grocerySave + totalRelief;
  const projColor    = projSurplus>=0?"#22c55e":projSurplus>-500?"#f59e0b":"#ef4444";
  const barData      = payoffs.map(p=>({name:p.name, payment:p.payment, active:enabled.has(p.id), color:p.color}));

  const FieldInput = ({label, val, onChange, type="text", placeholder=""}) => (
    <div>
      <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>{label}</div>
      <input type={type} value={val} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
    </div>
  );

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Hero */}
      <Card glow={projColor}>
        <Label>Projected Surplus · Toggle debts to model payoff scenarios</Label>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontSize:12,color:MUTED,marginBottom:4}}>With grocery goal + selected payoffs</div>
            <div style={{fontSize:wide?42:34,fontWeight:900,color:projColor,letterSpacing:"-1.5px",fontVariantNumeric:"tabular-nums",lineHeight:1,transition:"color .3s"}}>
              {projSurplus>=0?"+":"−"}{fmt(Math.abs(projSurplus))}/mo
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6,textAlign:"right"}}>
            {[["Gap today","−"+fmt(Math.abs(normSurplus)),"#ef4444"],["Grocery fix","+"+fmt(grocerySave),"#22c55e"],["Payoff relief","+"+fmt(totalRelief),"#22c55e"]].map(([k,v,c])=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:13,color:MUTED}}>{k}</span>
                <span style={{fontSize:16,fontWeight:800,color:c,fontVariantNumeric:"tabular-nums",transition:"all .3s"}}>{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
            <span style={{fontSize:11,color:MUTED}}>Gap closed</span>
            <span style={{fontSize:11,color:projColor,fontWeight:700}}>
              {projSurplus>=0?"100% — surplus reached!":Math.round(((normSurplus+grocerySave+totalRelief)/Math.abs(normSurplus))*100)+"% of way to break-even"}
            </span>
          </div>
          <PBar pct={Math.min(100,Math.round(((grocerySave+totalRelief)/Math.abs(normSurplus))*100))} color={projColor} h={8}/>
        </div>
      </Card>

      {/* Bar chart */}
      <Card>
        <Label>Monthly Relief by Debt</Label>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={barData} barSize={wide?36:24} margin={{left:-14}}>
            <XAxis dataKey="name" tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false}/>
            <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`} width={38}/>
            <Tooltip content={<Tip/>}/>
            <Bar dataKey="payment" name="Monthly relief" radius={[5,5,0,0]}>
              {barData.map((d,i)=><Cell key={i} fill={d.color} opacity={d.active?1:0.2}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Debt cards */}
      <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:12}}>
        {payoffs.map(p => {
          const isOn   = enabled.has(p.id);
          const isEdit = editId === p.id;
          return (
            <Card key={p.id} style={{opacity:isOn?1:0.6,transition:"opacity .2s",border:`1px solid ${isEdit?p.color+"66":BORDER}`}}>
              {/* Header row */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:isEdit?14:12}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:36,height:36,borderRadius:10,background:p.color+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <span style={{fontSize:15,fontWeight:900,color:p.color}}>💳</span>
                  </div>
                  {isEdit
                    ? <input value={p.name} onChange={e=>updateField(p.id,"name",e.target.value)}
                        style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"5px 10px",color:TEXT,fontSize:16,fontWeight:700,width:140,outline:"none"}}/>
                    : <div>
                        <div style={{fontSize:15,fontWeight:700,color:TEXT}}>{p.name}</div>
                        <div style={{fontSize:12,color:MUTED}}>Balance: {p.balanceStr || fmt(p.balance)}</div>
                      </div>
                  }
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {!isEdit && <Tag color={p.color}>{p.date}</Tag>}
                  <button onClick={()=>setEditId(isEdit?null:p.id)} style={{
                    padding:"3px 9px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer",
                    background:isEdit?p.color+"22":BORDER,color:isEdit?p.color:MUTED,
                    border:`1px solid ${isEdit?p.color:BORDER}`,transition:"all .15s",
                  }}>{isEdit?"Done":"Edit"}</button>
                  <button onClick={()=>toggle(p.id)} style={{
                    padding:"3px 9px",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer",
                    background:isOn?p.color+"22":BORDER,color:isOn?p.color:MUTED,
                    border:`1px solid ${isOn?p.color:BORDER}`,transition:"all .15s",
                  }}>{isOn?"✓":"Off"}</button>
                </div>
              </div>

              {/* Edit mode fields */}
              {isEdit ? (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                  <FieldInput label="Monthly Payment $" val={p.payment}
                    onChange={v=>updateField(p.id,"payment",parseFloat(v)||0)} type="number" placeholder="460"/>
                  <FieldInput label="Current Balance" val={p.balanceStr}
                    onChange={v=>updateField(p.id,"balanceStr",v)} placeholder="$2,280"/>
                  <FieldInput label="Payoff Date" val={p.date}
                    onChange={v=>updateField(p.id,"date",v)} placeholder="Jul 2026"/>
                  <FieldInput label="Time Remaining" val={p.months}
                    onChange={v=>updateField(p.id,"months",v)} placeholder="5 left"/>
                  <div>
                    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Progress %</div>
                    <input type="range" min={0} max={100} value={p.pct}
                      onChange={e=>updateField(p.id,"pct",parseInt(e.target.value))}
                      style={{"--thumb":p.color,width:"100%"}}/>
                    <div style={{fontSize:11,color:p.color,textAlign:"right"}}>{p.pct}%</div>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:6}}>Color</div>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {PAYOFF_COLORS.map(c=>(
                        <button key={c} onClick={()=>updateField(p.id,"color",c)} style={{
                          width:20,height:20,borderRadius:5,background:c,border:`2px solid ${p.color===c?"white":"transparent"}`,
                          cursor:"pointer",padding:0,flexShrink:0,
                        }}/>
                      ))}
                    </div>
                  </div>
                  <div style={{gridColumn:"1/-1",display:"flex",justifyContent:"flex-end"}}>
                    <button onClick={()=>removePayoff(p.id)} style={{
                      padding:"5px 12px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                      background:"#ef444411",color:"#ef4444",border:"1px solid #ef444433",
                    }}>🗑 Remove</button>
                  </div>
                </div>
              ) : (
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:24,fontWeight:900,color:p.color,fontVariantNumeric:"tabular-nums"}}>{fmt(p.payment)}/mo</div>
                  <div style={{fontSize:12,color:MUTED}}>{p.months}</div>
                </div>
              )}

              <PBar pct={p.pct} color={isOn?p.color:MUTED} h={7}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                <span style={{fontSize:11,color:DIM}}>Progress toward payoff</span>
                <span style={{fontSize:11,color:DIM}}>{p.pct}%</span>
              </div>
            </Card>
          );
        })}

        {/* Add new debt card */}
        {adding ? (
          <Card style={{border:`1px solid ${BORDER}`}}>
            <div style={{fontSize:14,fontWeight:700,color:TEXT,marginBottom:12}}>New Debt</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <FieldInput label="Name" val={newDebt.name} onChange={v=>setNewDebt(p=>({...p,name:v}))} placeholder="Car loan"/>
              <FieldInput label="Monthly Payment $" val={newDebt.payment} onChange={v=>setNewDebt(p=>({...p,payment:v}))} type="number" placeholder="250"/>
              <FieldInput label="Balance" val={newDebt.balance} onChange={v=>setNewDebt(p=>({...p,balance:v}))} placeholder="$12,000"/>
              <FieldInput label="Payoff Date" val={newDebt.date} onChange={v=>setNewDebt(p=>({...p,date:v}))} placeholder="Dec 2027"/>
              <FieldInput label="Time Remaining" val={newDebt.months} onChange={v=>setNewDebt(p=>({...p,months:v}))} placeholder="22 left"/>
              <div>
                <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Progress %</div>
                <input type="range" min={0} max={100} value={newDebt.pct}
                  onChange={e=>setNewDebt(p=>({...p,pct:parseInt(e.target.value)}))}
                  style={{"--thumb":newDebt.color,width:"100%"}}/>
                <div style={{fontSize:11,color:newDebt.color,textAlign:"right"}}>{newDebt.pct}%</div>
              </div>
              <div>
                <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:6}}>Color</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {PAYOFF_COLORS.map(c=>(
                    <button key={c} onClick={()=>setNewDebt(p=>({...p,color:c}))} style={{
                      width:20,height:20,borderRadius:5,background:c,border:`2px solid ${newDebt.color===c?"white":"transparent"}`,
                      cursor:"pointer",padding:0,flexShrink:0,
                    }}/>
                  ))}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={addPayoff} style={{flex:1,padding:"9px",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",background:ACCENT+"22",color:ACCENT,border:`1px solid ${ACCENT}44`}}>+ Add Debt</button>
              <button onClick={()=>setAdding(false)} style={{padding:"9px 14px",borderRadius:9,fontSize:13,cursor:"pointer",background:BG,color:MUTED,border:`1px solid ${BORDER}`}}>Cancel</button>
            </div>
          </Card>
        ) : (
          <button onClick={()=>setAdding(true)} style={{
            border:`2px dashed ${BORDER}`,borderRadius:18,padding:"28px",textAlign:"center",cursor:"pointer",
            background:"transparent",color:MUTED,fontSize:13,fontWeight:600,
            display:"flex",flexDirection:"column",alignItems:"center",gap:8,
          }}>
            <span style={{fontSize:28}}>+</span>
            <span>Add New Debt</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ── CATEGORIES (universal category drill-down, replaces dedicated Groceries tab) ──
function Categories({wide, isMobile}) {
  const { summaryRows, selectedMonth, checkTxns, ccTxns, groceryGoal, setGroceryGoal } = useBudget();
  const [selectedCat, setSelectedCat] = useState("Groceries");
  const [spotlight, setSpotlight] = useState(null);
  const [expandedVendor, setExpandedVendor] = useState(null);

  const catRow = summaryRows.find(r => r.cat === selectedCat) || summaryRows[0];
  const cat = catRow ? catRow.cat : "Groceries";
  const color = catRow ? catRow.color : "#f97316";
  const isGroceries = cat === "Groceries";

  const STORE_META = {
    "target":{ icon:"🎯", color:"#ef4444" }, "costco":{ icon:"🏪", color:"#3b82f6" },
    "sprouts":{ icon:"🌿", color:"#22c55e" }, "mckeever":{ icon:"🛍️", color:"#f59e0b" },
    "whole foods":{ icon:"🌾", color:"#10b981" }, "wholefds":{ icon:"🌾", color:"#10b981" },
    "dollar general":{ icon:"💰", color:"#f97316" }, "hy-vee":{ icon:"🏬", color:"#a78bfa" },
    "hyvee":{ icon:"🏬", color:"#a78bfa" }, "aldi":{ icon:"🛒", color:"#06b6d4" },
    "amazon":{ icon:"📦", color:"#94a3b8" }, "walmart":{ icon:"🔵", color:"#0ea5e9" },
    "price chopper":{ icon:"🏬", color:"#7c6af7" }, "trader joe":{ icon:"🌻", color:"#fbbf24" },
    "save a lot":{ icon:"💲", color:"#84cc16" },
  };
  const PALETTE = ["#a78bfa","#f97316","#10b981","#ec4899","#06b6d4","#f59e0b","#8b5cf6","#22c55e","#ef4444","#3b82f6"];

  const vendors = useMemo(() => {
    const txns = [...checkTxns, ...ccTxns].filter(t => t.month === selectedMonth && t.cat === cat);
    const map = {};
    txns.forEach(t => {
      const desc = t.desc.toLowerCase();
      let vendorName = t.desc;
      if (isGroceries) {
        for (const key of Object.keys(STORE_META)) {
          if (desc.includes(key)) { vendorName = key.split(" ").map(w=>w[0].toUpperCase()+w.slice(1)).join(" "); break; }
        }
      }
      if (!map[vendorName]) map[vendorName] = { total:0, txns:[] };
      map[vendorName].total += t.amount;
      map[vendorName].txns.push(t);
    });
    return Object.entries(map).map(([name, data], i) => {
      let meta = { icon: catRow ? catRow.icon : "🛒", color: PALETTE[i % PALETTE.length] };
      if (isGroceries) {
        const mk = Object.keys(STORE_META).find(k => name.toLowerCase().includes(k));
        if (mk) meta = STORE_META[mk];
      }
      return { name, total: data.total, txns: data.txns, ...meta };
    }).sort((a,b) => b.total - a.total);
  }, [checkTxns, ccTxns, selectedMonth, cat]); // eslint-disable-line

  // Reset spotlight/expand when category changes
  useEffect(() => { setSpotlight(null); setExpandedVendor(null); }, [cat]);

  const total = vendors.reduce((s,x) => s + x.total, 0);
  const goal = isGroceries ? groceryGoal : (catRow ? catRow.kc : null);
  const gap = goal ? total - goal : null;
  const gapColor = gap == null ? color : gap > 0 ? "#ef4444" : "#22c55e";

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Category selector pill row */}
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {summaryRows.map(r => {
          const active = selectedCat === r.cat;
          return (
            <button key={r.cat} onClick={() => setSelectedCat(r.cat)} style={{
              display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:10,
              fontSize:12,fontWeight:active?700:500,cursor:"pointer",
              background:active?r.color+"22":SURFACE, color:active?r.color:MUTED,
              border:`1px solid ${active?r.color+"66":BORDER}`,transition:"all .15s",
            }}>
              <span style={{fontSize:14}}>{r.icon}</span>{r.cat}
            </button>
          );
        })}
      </div>

      {vendors.length === 0 ? (
        <div style={{padding:"40px 24px",textAlign:"center",color:MUTED,background:SURFACE,borderRadius:18,border:`1px solid ${BORDER}`}}>
          <div style={{fontSize:40,marginBottom:12}}>{catRow ? catRow.icon : "📂"}</div>
          <div style={{fontSize:18,fontWeight:700,color:TEXT,marginBottom:8}}>No {cat} transactions yet</div>
          <div style={{fontSize:14}}>Import a statement on the <strong style={{color:ACCENT}}>📥 Import</strong> tab — transactions categorized as <strong>{cat}</strong> will appear here automatically.</div>
        </div>
      ) : (
        <>
          {/* Hero */}
          <Card glow={color}>
            <Label>{selectedMonth} · {vendors.length} {isGroceries?"Store":"Vendor"}{vendors.length!==1?"s":""}</Label>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div style={{fontSize:wide?42:34,fontWeight:900,color,letterSpacing:"-1.5px",fontVariantNumeric:"tabular-nums"}}>{fmt(total)}</div>
              {gap != null && <Tag color={gapColor}>{gap>0?"+":"−"}{fmt(Math.abs(gap))} vs goal</Tag>}
            </div>
            {goal != null && (
              <>
                <PBar pct={(total/Math.max(total,goal*2))*100} color={color} h={10}/>
                <div style={{position:"relative",marginTop:6,height:16}}>
                  <div style={{position:"absolute",left:`${(goal/Math.max(total,goal*2))*100}%`,top:0,transform:"translateX(-50%)"}}>
                    <div style={{width:2,height:8,background:ACCENT,margin:"0 auto"}}/>
                    <div style={{fontSize:9,color:ACCENT,whiteSpace:"nowrap",textAlign:"center",marginTop:1}}>goal</div>
                  </div>
                </div>
                <HR/>
              </>
            )}
            {isGroceries && (
              <div style={{marginBottom:4}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{fontSize:13,color:MUTED}}>Monthly goal</span>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:16,fontWeight:900,color:ACCENT,fontVariantNumeric:"tabular-nums"}}>{fmt(groceryGoal)}</span>
                    <input type="number" value={groceryGoal} onChange={e=>setGroceryGoal(Math.max(200,Number(e.target.value)))}
                      style={{width:80,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"4px 8px",color:TEXT,fontSize:13,textAlign:"right"}}/>
                  </div>
                </div>
                <Slider min={500} max={3000} step={50} value={groceryGoal} onChange={setGroceryGoal} color="#a78bfa"/>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                  <span style={{fontSize:10,color:DIM}}>$500</span>
                  <span style={{fontSize:10,color:DIM}}>KC avg $1,200</span>
                  <span style={{fontSize:10,color:DIM}}>$3,000</span>
                </div>
              </div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:12}}>
              {[
                goal!=null ? ["Goal",fmt(goal),ACCENT] : null,
                ["Actual",fmt(total),color],
                isGroceries ? ["KC Avg","$1,200","#94a3b8"] : null,
              ].filter(Boolean).map(([k,v,c])=>(
                <div key={k} style={{background:BG,borderRadius:10,padding:"10px 12px"}}>
                  <div style={{fontSize:10,color:MUTED,marginBottom:3}}>{k}</div>
                  <div style={{fontSize:16,fontWeight:900,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Bar chart */}
          <Card>
            <Label>{isGroceries?"Spending by Store":"Spending by Vendor"} · Click to spotlight</Label>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={vendors.map(s=>({name:s.name,amount:s.total}))} barSize={wide?36:24} margin={{left:-14}}
                onClick={d=>{ if(d?.activeTooltipIndex!=null) setSpotlight(vendors[d.activeTooltipIndex]?.name||null); }}>
                <XAxis dataKey="name" tick={{fontSize:9,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>v.slice(0,7)} interval={0}/>
                <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`} width={38}/>
                <Tooltip content={<Tip/>}/>
                <Bar dataKey="amount" name="Spend" radius={[5,5,0,0]} cursor="pointer">
                  {vendors.map((s,i)=>(
                    <Cell key={i} fill={s.color} opacity={spotlight===null||spotlight===s.name?1:0.2}/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {spotlight && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12,color:MUTED}}>Spotlighting: <strong style={{color:TEXT}}>{spotlight}</strong></span>
                <button onClick={()=>setSpotlight(null)} style={{padding:"2px 8px",borderRadius:6,background:BORDER,border:`1px solid ${BORDER}`,color:MUTED,fontSize:11,cursor:"pointer"}}>Clear ✕</button>
              </div>
            )}
          </Card>

          {/* Vendor/store rows with expandable transactions */}
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <Label>{isGroceries?"By Store":"By Vendor"}</Label>
              {spotlight && <Tag color={color}>Spotlighting {spotlight}</Tag>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:wide?"0 32px":0}}>
              {vendors.map(s=>{
                const pct=(s.total/total)*100;
                const isSpot=spotlight===s.name;
                const isOther=spotlight!==null&&spotlight!==s.name;
                const isExp=expandedVendor===s.name;
                return (
                  <div key={s.name} style={{
                    marginBottom:8,borderRadius:12,overflow:"hidden",
                    border:`1px solid ${isSpot?s.color+"44":isExp?s.color+"33":"transparent"}`,
                    background:isSpot?s.color+"12":isExp?s.color+"08":"transparent",
                    opacity:isOther?0.35:1,transition:"all .2s",
                  }}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",cursor:"pointer"}}
                      onClick={()=>setSpotlight(isSpot?null:s.name)}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:10,height:10,borderRadius:3,background:s.color,flexShrink:0}}/>
                        <span style={{fontSize:20}}>{s.icon}</span>
                        <div>
                          <span style={{fontSize:15,fontWeight:600,color:isSpot?s.color:TEXT}}>{s.name}</span>
                          {isSpot && <div style={{fontSize:11,color:s.color}}>{pct.toFixed(0)}% of total</div>}
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:16,fontWeight:800,color:isSpot?s.color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(s.total)}</span>
                        <span style={{fontSize:11,color:MUTED}}>{pct.toFixed(0)}%</span>
                        <button onClick={e=>{e.stopPropagation();setExpandedVendor(isExp?null:s.name);}}
                          style={{background:s.color+"22",border:`1px solid ${s.color}44`,borderRadius:6,color:s.color,fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.6}}>
                          {isExp?"▲":"▼"} {s.txns.length}
                        </button>
                      </div>
                    </div>
                    <div style={{padding:"0 10px 8px"}}>
                      <PBar pct={pct*3} color={s.color} h={4}/>
                    </div>
                    {isExp && (
                      <div style={{borderTop:`1px solid ${s.color}22`}}>
                        {s.txns.slice().sort((a,b)=>a.date.localeCompare(b.date)).map((t,j)=>(
                          <div key={j} style={{
                            display:"flex",justifyContent:"space-between",alignItems:"center",
                            padding:"7px 14px",borderBottom:`1px solid ${s.color}10`,
                            background:j%2===0?"transparent":s.color+"06",
                          }}>
                            <div style={{display:"flex",gap:12,alignItems:"center"}}>
                              <span style={{fontSize:11,color:MUTED,minWidth:32}}>{t.date}</span>
                              <div>
                                <div style={{fontSize:12,color:TEXT}}>{t.desc}</div>
                                {t.note&&!t.note.includes("ONE-TIME")&&<div style={{fontSize:10,color:DIM,marginTop:1}}>{t.note}</div>}
                              </div>
                            </div>
                            <span style={{fontSize:13,fontWeight:700,color:t.amount<0?"#22c55e":TEXT,fontVariantNumeric:"tabular-nums",flexShrink:0}}>
                              {t.amount<0?"+":""}{fmt(t.amount)}
                            </span>
                          </div>
                        ))}
                        <div style={{display:"flex",justifyContent:"space-between",padding:"8px 14px",background:s.color+"10"}}>
                          <span style={{fontSize:11,fontWeight:700,color:s.color}}>{s.txns.length} transaction{s.txns.length!==1?"s":""}</span>
                          <span style={{fontSize:13,fontWeight:900,color:s.color,fontVariantNumeric:"tabular-nums"}}>{fmt(s.total)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <HR/>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:13,color:MUTED,fontWeight:700}}>Total {cat}</span>
              <span style={{fontSize:16,fontWeight:900,color,fontVariantNumeric:"tabular-nums"}}>{fmt(total)}</span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// Stable CatSelect — defined outside TxnTable so it doesn't remount every render
function CatSelect({ t, src, updateTxnCat }) {
  const { allCats } = useBudget();
  const color = CAT_COLORS[t.cat] || MUTED;
  return (
    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
      <select
        className="cat-pick"
        value={t.cat}
        onChange={e => updateTxnCat(src, t.id, e.target.value)}
        style={{ background: color+"22", border:`1px solid ${color}55`, color, paddingRight:22 }}
      >
        {allCats.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <span style={{position:"absolute",right:6,pointerEvents:"none",fontSize:9,color,opacity:.7}}>▾</span>
    </div>
  );
}

// ── SPLIT TRANSACTION MODAL ───────────────────────────────────────────────────
function SplitModal({ txn, src, onClose }) {
  const { replaceTxn, allCats } = useBudget();
  const [parts, setParts] = useState([
    { desc: txn.desc, amount: txn.amount, cat: txn.cat },
    { desc: "", amount: 0, cat: allCats[0] },
  ]);
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState(null);
  const [imgFile, setImgFile] = useState(null);
  const [imgPreview, setImgPreview] = useState(null);

  const total = parts.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const remaining = txn.amount - total;
  const isBalanced = Math.abs(remaining) < 0.01;

  const updatePart = (i, field, val) =>
    setParts(prev => prev.map((p, idx) => idx === i ? { ...p, [field]: val } : p));
  const addPart = () => setParts(prev => [...prev, { desc: "", amount: 0, cat: allCats[0] }]);
  const removePart = (i) => setParts(prev => prev.filter((_, idx) => idx !== i));

  const handleImageUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    setImgFile(file);
    const reader = new FileReader();
    reader.onload = ev => setImgPreview(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const parseReceipt = async () => {
    const apiKey = (() => { try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; } })();
    if (!apiKey) { setParseErr("Set your Anthropic API key in Settings to use AI receipt parsing."); return; }
    if (!imgPreview) { setParseErr("Upload a receipt image first."); return; }
    setParsing(true); setParseErr(null);
    try {
      const base64 = imgPreview.split(",")[1];
      const mediaType = imgFile?.type || "image/jpeg";
      const prompt = `This is a receipt for a purchase totaling $${txn.amount.toFixed(2)} from "${txn.desc}".
Parse every line item from the receipt image and assign each one to the most appropriate budget category from this list: ${allCats.join(", ")}.
Return ONLY a valid JSON array with no markdown fences, no explanation, just the array:
[{"desc":"item name or group","amount":1.23,"cat":"Groceries"}]
IMPORTANT: The amounts MUST sum to exactly ${txn.amount.toFixed(2)}. Group small items by category if needed.`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1024,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ]}]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content[0].text.trim().replace(/^```[\w]*|```$/gm, "").trim();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("No items parsed from receipt");
      // Normalize so total matches exactly
      const rawTotal = parsed.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      const scale = txn.amount / rawTotal;
      const normalized = parsed.map((p, i, arr) => {
        if (i === arr.length - 1) {
          const soFar = arr.slice(0,-1).reduce((s,x) => s + Math.round(parseFloat(x.amount)*scale*100)/100, 0);
          return { ...p, amount: Math.round((txn.amount - soFar) * 100) / 100 };
        }
        return { ...p, amount: Math.round(parseFloat(p.amount) * scale * 100) / 100 };
      });
      setParts(normalized.map(p => ({ desc: p.desc || "", amount: p.amount, cat: allCats.includes(p.cat) ? p.cat : allCats[0] })));
    } catch (e) { setParseErr("Parse failed: " + e.message); }
    setParsing(false);
  };

  const confirm = () => {
    if (!isBalanced) return;
    const splits = parts.filter(p => parseFloat(p.amount) > 0).map(p => ({
      desc: p.desc || txn.desc,
      amount: parseFloat(p.amount),
      cat: p.cat,
    }));
    replaceTxn(src, txn.id, splits);
    onClose();
  };

  return (
    <div style={{position:"fixed",inset:0,background:"#000000bb",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{background:"#161b27",border:`1px solid ${BORDER}`,borderRadius:18,padding:"24px",maxWidth:560,width:"100%",maxHeight:"90vh",overflowY:"auto",boxShadow:"0 24px 64px #000a"}}>
        {/* Header */}
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:TEXT}}>✂️ Split Transaction</div>
            <div style={{fontSize:12,color:MUTED,marginTop:3}}>{txn.desc} · <span style={{color:"#f97316",fontWeight:700}}>{new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(txn.amount)}</span> · {txn.date}</div>
          </div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:MUTED,fontSize:20,cursor:"pointer",padding:"0 4px",lineHeight:1}}>✕</button>
        </div>

        {/* AI Receipt Parse */}
        <div style={{background:BG,borderRadius:12,padding:"14px 16px",marginBottom:16,border:`1px solid #06b6d422`}}>
          <div style={{fontSize:12,fontWeight:700,color:"#06b6d4",marginBottom:8}}>📷 AI Receipt Import (optional)</div>
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>Take a photo of the receipt and AI will parse each line item and auto-categorize it. The total will be matched exactly to ${txn.amount.toFixed(2)}.</div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <label style={{padding:"7px 14px",borderRadius:8,background:"#06b6d422",color:"#06b6d4",border:"1px solid #06b6d444",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
              📷 {imgPreview ? "Change Image" : "Upload Receipt"}
              <input type="file" accept="image/*" capture="environment" onChange={handleImageUpload} style={{display:"none"}}/>
            </label>
            {imgPreview && (
              <button onClick={parseReceipt} disabled={parsing}
                style={{padding:"7px 14px",borderRadius:8,background:parsing?"#1e2535":"#8b5cf622",color:parsing?MUTED:"#8b5cf6",border:`1px solid ${parsing?"#1e2535":"#8b5cf644"}`,fontSize:12,fontWeight:700,cursor:parsing?"default":"pointer",whiteSpace:"nowrap"}}>
                {parsing ? "⏳ Parsing receipt…" : "✨ Parse with AI"}
              </button>
            )}
            {imgPreview && <img src={imgPreview} alt="receipt preview" style={{height:44,borderRadius:6,border:`1px solid ${BORDER}`,objectFit:"cover"}}/>}
          </div>
          {parseErr && <div style={{fontSize:11,color:"#f59e0b",marginTop:8,padding:"6px 10px",background:"#f59e0b11",borderRadius:6}}>{parseErr}</div>}
        </div>

        {/* Split rows */}
        <div style={{marginBottom:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 90px 130px 28px",gap:6,padding:"0 2px",marginBottom:6}}>
            {["Description","Amount","Category",""].map(h => <div key={h} style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>{h}</div>)}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {parts.map((p, i) => (
              <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 90px 130px 28px",gap:6,alignItems:"center"}}>
                <input value={p.desc} onChange={e => updatePart(i, "desc", e.target.value)} placeholder={txn.desc}
                  style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
                <input type="number" value={p.amount || ""} onChange={e => updatePart(i, "amount", e.target.value)} step="0.01" min="0" placeholder="0.00"
                  style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%",fontVariantNumeric:"tabular-nums"}}/>
                <select value={p.cat} onChange={e => updatePart(i, "cat", e.target.value)}
                  style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 8px",color:TEXT,fontSize:12,outline:"none",width:"100%"}}>
                  {allCats.map(c => <option key={c} style={{background:"#161b27"}}>{c}</option>)}
                </select>
                <button onClick={() => removePart(i)} disabled={parts.length <= 1}
                  style={{background:"#ef444415",border:"none",borderRadius:6,color:parts.length<=1?BORDER:"#ef4444",fontSize:13,cursor:parts.length<=1?"default":"pointer",padding:"4px 0",width:28,textAlign:"center"}}>✕</button>
              </div>
            ))}
          </div>
        </div>

        <button onClick={addPart}
          style={{background:"transparent",border:`1px dashed ${BORDER}`,borderRadius:8,color:MUTED,fontSize:12,cursor:"pointer",padding:"7px 14px",width:"100%",marginBottom:16,fontFamily:"inherit"}}>
          + Add Line
        </button>

        {/* Balance indicator */}
        <div style={{background:BG,borderRadius:10,padding:"10px 16px",marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"center",border:`1px solid ${isBalanced?"#22c55e33":remaining!==txn.amount?"#f59e0b33":BORDER}`}}>
          <div>
            <div style={{fontSize:11,color:MUTED}}>Total allocated</div>
            <div style={{fontSize:16,fontWeight:900,color:isBalanced?"#22c55e":"#f59e0b",fontVariantNumeric:"tabular-nums"}}>
              {new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(total)}
            </div>
          </div>
          {!isBalanced && (
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11,color:MUTED}}>Unallocated</div>
              <div style={{fontSize:14,fontWeight:800,color:"#f59e0b",fontVariantNumeric:"tabular-nums"}}>{remaining > 0 ? "+" : ""}{new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(remaining)}</div>
            </div>
          )}
          {isBalanced && <div style={{fontSize:13,color:"#22c55e",fontWeight:700}}>✓ Balanced</div>}
        </div>

        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{padding:"9px 20px",borderRadius:9,background:BG,color:MUTED,border:`1px solid ${BORDER}`,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={confirm} disabled={!isBalanced}
            style={{padding:"9px 22px",borderRadius:9,background:isBalanced?"#8b5cf6":"#1e2535",color:isBalanced?"white":MUTED,border:"none",fontSize:13,fontWeight:800,cursor:isBalanced?"pointer":"default",transition:"all .15s",fontFamily:"inherit"}}>
            ✓ Confirm Split
          </button>
        </div>
      </div>
    </div>
  );
}

// ── TRANSACTION TABLE ─────────────────────────────────────────────────────────
function TxnTable({ src, isMobile }) {
  const { checkTxns, ccTxns, updateTxnCat, deleteTxn, replaceTxn, selectedMonth, availableMonths, addTxns, allCats } = useBudget();
  const [splitTxn, setSplitTxn] = useState(null); // txn being split
  const allTxns = src === "checking" ? checkTxns : ccTxns;

  const [monthFilter, setMonthFilter] = useState(selectedMonth);
  const [catFilter,   setCatFilter]   = useState("All");
  const [search,      setSearch]      = useState("");
  const [sortBy,      setSortBy]      = useState("date");

  // Keep monthFilter in sync when global month changes
  useEffect(() => { setMonthFilter(selectedMonth); }, [selectedMonth]);

  const filtered = allTxns
    .filter(t => t.month === monthFilter)
    .filter(t => catFilter === "All" || t.cat === catFilter)
    .filter(t => !search || t.desc.toLowerCase().includes(search.toLowerCase()) || t.cat.toLowerCase().includes(search.toLowerCase()))
    .slice()
    .sort((a,b) => sortBy === "date" ? a.date.localeCompare(b.date) : b.amount - a.amount);

  const visibleTotal = filtered.filter(t => t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t) => s + t.amount, 0);

  // ── Manual add form ──────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAmt,  setNewAmt]  = useState("");
  const [newCat,  setNewCat]  = useState(allCats[0]);
  const [newMon,  setNewMon]  = useState(monthFilter);
  useEffect(() => { setNewMon(monthFilter); }, [monthFilter]);

  const submitManual = () => {
    const amount = parseFloat(newAmt);
    if (!newDesc.trim() || isNaN(amount)) return;
    const date = newDate.trim() || "01/01";
    addTxns(src, [{ date, desc: newDesc.trim(), amount, cat: newCat, month: newMon, note: "" }]);
    setNewDesc(""); setNewAmt(""); setNewDate("");
    setShowAdd(false);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {splitTxn && <SplitModal txn={splitTxn} src={src} onClose={() => setSplitTxn(null)}/>}

      {/* Manual add */}
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <button onClick={()=>setShowAdd(v=>!v)}
          style={{padding:"8px 18px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",
            background:showAdd?ACCENT+"22":SURFACE, color:showAdd?ACCENT:MUTED,
            border:`1px solid ${showAdd?ACCENT:BORDER}`,transition:"all .15s"}}>
          {showAdd ? "✕ Cancel" : "+ Add Transaction"}
        </button>
      </div>
      {showAdd && (
        <Card glow={ACCENT}>
          <Label>➕ New Transaction</Label>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"flex-end"}}>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:"0 0 auto"}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Month</span>
              <select value={newMon} onChange={e=>setNewMon(e.target.value)}
                style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}>
                {MONTHS.map(m=><option key={m}>{m}</option>)}
              </select>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:"0 0 80px"}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Date (MM/DD)</span>
              <input value={newDate} onChange={e=>setNewDate(e.target.value)} placeholder="01/15"
                style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:"1 1 160px"}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Description</span>
              <input value={newDesc} onChange={e=>setNewDesc(e.target.value)} placeholder="Merchant or payee"
                style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:"0 0 100px"}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Amount ($)</span>
              <input type="number" value={newAmt} onChange={e=>setNewAmt(e.target.value)} placeholder="0.00" step="0.01"
                style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:4,flex:"1 1 140px"}}>
              <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Category</span>
              <select value={newCat} onChange={e=>setNewCat(e.target.value)}
                style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}>
                {allCats.map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <button onClick={submitManual}
              style={{padding:"8px 20px",borderRadius:8,background:ACCENT,color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer",flexShrink:0,alignSelf:"flex-end"}}>
              Save
            </button>
          </div>
          <div style={{fontSize:11,color:MUTED,marginTop:8}}>Tip: use a negative amount for credits/refunds.</div>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          {/* Month tabs */}
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {availableMonths.map(m => (
              <button key={m} onClick={()=>setMonthFilter(m)} style={{
                padding:"5px 10px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                background:monthFilter===m?ACCENT+"22":BG,
                color:monthFilter===m?ACCENT:MUTED,
                border:`1px solid ${monthFilter===m?ACCENT:BORDER}`,transition:"all .12s",
              }}>{m.slice(0,3)}</button>
            ))}
          </div>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 12px",color:TEXT,fontSize:13,flex:"1 1 120px",minWidth:80}}/>
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)}
            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,flex:"1 1 110px",minWidth:80}}>
            <option value="All">All Categories</option>
            {allCats.map(c=><option key={c}>{c}</option>)}
          </select>
          <select value={sortBy} onChange={e=>setSortBy(e.target.value)}
            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,flex:"0 0 auto"}}>
            <option value="date">By Date</option>
            <option value="amount">By Amount</option>
          </select>
        </div>
        <div style={{fontSize:12,color:MUTED,marginTop:8}}>
          {filtered.length === 0
            ? <span style={{color:"#f59e0b"}}>No transactions for {monthFilter} — import a statement to add data</span>
            : <>{filtered.length} transactions · <span style={{color:"#f97316",fontWeight:700}}>{fmt(visibleTotal)}</span></>
          }
        </div>
      </Card>

      <Card style={{padding:0,overflow:"hidden"}}>
        {isMobile ? (
          /* ── MOBILE: card rows ── */
          <>
            {filtered.map((t,i)=>{
              const isIncome   = t.cat==="Income";
              const isTransfer = t.cat==="Transfer";
              const isReturn   = t.amount<0;
              const isOneTime  = t.note?.includes("ONE-TIME");
              const catColor   = CAT_COLORS[t.cat]||MUTED;
              const amtColor   = isIncome?"#22c55e":isReturn?"#22c55e":isTransfer?MUTED:TEXT;

              return (
                <div key={i} style={{
                  padding:"11px 14px",
                  borderBottom:`1px solid ${BORDER}`,
                  background:isIncome?"#22c55e07":isTransfer?"#33415505":i%2===0?SURFACE:BG,
                  opacity:isTransfer?0.5:1,
                }}>
                  {/* Top row: date + category tag + delete */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                    <span style={{fontSize:12,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{t.date}</span>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <CatSelect t={t} src={src} updateTxnCat={updateTxnCat}/>
                      {!isIncome && !isTransfer && (
                        <button onClick={() => setSplitTxn(t)} title="Split"
                          style={{background:"#06b6d415",border:"none",borderRadius:4,color:"#06b6d4",fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>✂</button>
                      )}
                      <button onClick={() => deleteTxn(src, t.id)}
                        title="Delete transaction"
                        style={{background:"#ef444415",border:"none",borderRadius:4,color:"#ef4444",fontSize:12,cursor:"pointer",padding:"1px 5px",lineHeight:1.5,flexShrink:0}}>✕</button>
                    </div>
                  </div>
                  {/* Bottom row: description + amount */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:500,color:isIncome?"#22c55e":TEXT,lineHeight:1.3}}>
                        {t.desc}
                        {isOneTime&&<span style={{marginLeft:6}}><Tag color="#f59e0b">one-time</Tag></span>}
                      </div>
                      {t.note&&!t.note.includes("ONE-TIME")&&(
                        <div style={{fontSize:11,color:DIM,marginTop:2}}>{t.note}</div>
                      )}
                    </div>
                    <div style={{fontSize:16,fontWeight:800,color:amtColor,fontVariantNumeric:"tabular-nums",flexShrink:0}}>
                      {isIncome||isReturn?"+":""}{fmt(t.amount)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div style={{padding:"12px 16px",background:"#0f141e",borderTop:`2px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:700,color:MUTED}}>Total spend</span>
              <span style={{fontSize:16,fontWeight:900,color:"#f97316",fontVariantNumeric:"tabular-nums"}}>{fmt(visibleTotal)}</span>
            </div>
          </>
        ) : (
          /* ── DESKTOP: 4-col table ── */
          <>
            <div style={{display:"grid",gridTemplateColumns:"60px 1fr 90px 120px 54px 36px",padding:"10px 16px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
              {["Date","Description","Amount","Category","",""].map(h=>(
                <div key={h} style={{fontSize:11,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px"}}>{h}</div>
              ))}
            </div>
            {filtered.map((t,i)=>{
              const isIncome=t.cat==="Income", isTransfer=t.cat==="Transfer", isReturn=t.amount<0;
              const isOneTime=t.note?.includes("ONE-TIME");
              const catColor=CAT_COLORS[t.cat]||MUTED;
              return (
                <div key={i} style={{display:"grid",gridTemplateColumns:"60px 1fr 90px 120px 54px 36px",padding:"10px 16px",borderBottom:`1px solid ${BORDER}`,background:isIncome?"#22c55e07":isTransfer?"#33415507":i%2===0?SURFACE:BG,opacity:isTransfer?.5:1}}>
                  <div style={{fontSize:12,color:MUTED,alignSelf:"center"}}>{t.date}</div>
                  <div style={{alignSelf:"center",paddingRight:12}}>
                    <div style={{fontSize:13,color:isIncome?"#22c55e":TEXT,fontWeight:isIncome?700:400,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      {t.desc}{isOneTime&&<Tag color="#f59e0b">one-time</Tag>}
                    </div>
                    {t.note&&!t.note.includes("ONE-TIME")&&<div style={{fontSize:11,color:DIM,marginTop:2}}>{t.note}</div>}
                  </div>
                  <div style={{fontSize:14,fontWeight:700,alignSelf:"center",fontVariantNumeric:"tabular-nums",color:isIncome?"#22c55e":isReturn?"#22c55e":isTransfer?MUTED:TEXT}}>
                    {isIncome||isReturn?"+":""}{fmt(t.amount)}
                  </div>
                  <div style={{alignSelf:"center"}}><CatSelect t={t} src={src} updateTxnCat={updateTxnCat}/></div>
                  <div style={{alignSelf:"center"}}>
                    {!isIncome && !isTransfer && (
                      <button onClick={() => setSplitTxn(t)} title="Split transaction"
                        style={{background:"#06b6d415",border:"none",borderRadius:4,color:"#06b6d4",fontSize:11,cursor:"pointer",padding:"2px 6px",lineHeight:1.5,fontWeight:700}}>✂</button>
                    )}
                  </div>
                  <div style={{alignSelf:"center"}}>
                    <button onClick={() => deleteTxn(src, t.id)} title="Delete"
                      style={{background:"#ef444415",border:"none",borderRadius:4,color:"#ef4444",fontSize:13,cursor:"pointer",padding:"2px 6px",lineHeight:1.5}}>✕</button>
                  </div>
                </div>
              );
            })}
            <div style={{display:"grid",gridTemplateColumns:"60px 1fr 90px 120px 54px 36px",padding:"12px 16px",background:"#0f141e",borderTop:`2px solid ${BORDER}`}}>
              <div/>
              <div style={{fontSize:13,fontWeight:700,color:MUTED}}>Total spend (excl. income & transfers)</div>
              <div style={{fontSize:15,fontWeight:900,color:"#f97316",fontVariantNumeric:"tabular-nums"}}>{fmt(visibleTotal)}</div>
              <div/><div/><div/>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ── RECOMMENDATIONS ───────────────────────────────────────────────────────────
const RECS = [
  {
    id: "groceries",
    icon: "🛒",
    color: "#f97316",
    title: "Go Costco-first, everything else second",
    impact: "−$1,473/mo",
    tag: "Biggest lever",
    tagColor: "#ef4444",
    summary: "You spent $2,473 on groceries across 9 stores in January. Your single biggest opportunity.",
    steps: [
      "Plan a weekly Costco haul covering proteins, dairy, produce, and household goods in bulk. Costco price-per-unit on staples is 30–50% cheaper than Target or Sprouts.",
      "Cut Target grocery runs entirely — $989 in January alone, often convenience-driven. Target's food prices are retail, not grocery. Shop Target only for clothing/household, not food.",
      "Keep one secondary store (Sprouts or ALDI) for fresh produce mid-week if needed. ALDI is the cheapest per-unit for produce in KC.",
      "Freeze bulk Costco meat immediately after buying. Portion and freeze chicken thighs, ground beef, and pork shoulder — these are your cheapest protein sources.",
      "Build a standing list: proteins for the week, a starch (rice/pasta/potatoes), two vegetables, snacks for kids. Costco run once a week, that's it.",
    ],
  },
  {
    id: "mealplan",
    icon: "🍳",
    color: "#22c55e",
    title: "Budget cooking: feed 5 for under $1,000/mo",
    impact: "Enables $1k goal",
    tag: "Practical",
    tagColor: "#22c55e",
    summary: "Family of 5 can eat well at $200/week with a few repeatable systems.",
    steps: [
      "Costco rotisserie chicken ($5) is your best friend — dinner night 1, chicken tacos night 2, chicken soup night 3. One bird = 3 meals for 5 people.",
      "Two 'cheap protein' nights per week: eggs (frittata, breakfast burritos), canned fish (tuna pasta, salmon patties), or beans (black bean soup, chili). Under $2/serving.",
      "Batch cook on Sundays: big pot of rice, a protein, roasted vegetables. Builds 4-5 lunch options for the week without thinking.",
      "Dutch oven pork shoulder ($12-15 at Costco, 4-5 lbs) becomes pulled pork sandwiches, tacos, rice bowls across 2-3 dinners.",
      "Stop buying pre-cut, packaged, or individual-serving items. Whole heads of lettuce, block cheese (slice yourself), whole fruit — 2-3x cheaper than pre-prepared.",
      "Keep a 'pantry meal' night using only what's already home. Forces using up odds and ends and skips a shopping trip.",
    ],
  },
  {
    id: "overspend",
    icon: "🚫",
    color: "#a78bfa",
    title: "Stop the Target spiral",
    impact: "−$500-800/mo",
    tag: "Behavior",
    tagColor: "#a78bfa",
    summary: "Target is a psychological spending trap. $989 in January was mostly non-essential drift.",
    steps: [
      "Delete the Target app. Convenience apps remove friction — friction is your friend when overspending.",
      "No 'quick Target run.' It doesn't exist. Average Target trip spend is 40% higher than intended. If you need one thing, order pickup only and go straight to that item.",
      "Combine Target trips with an explicit list and a dollar cap. Write it before you go, don't exceed it. Same for any store.",
      "Route spending through Costco default — if Costco doesn't carry it, ask whether you actually need it now or can wait.",
      "Use the 48-hour rule for any non-food Target purchase over $20: add it to a wish list, wait 48 hours, then decide. Most impulse purchases evaporate.",
    ],
  },
  {
    id: "debt",
    icon: "💳",
    color: "#22c55e",
    title: "Debt snowball — your payoff order",
    impact: "+$1,319/mo eventually",
    tag: "Debt strategy",
    tagColor: "#3b82f6",
    summary: "You have $1,319/mo in debt payments that will disappear on this timeline if you stay the course.",
    steps: [
      "Goodleap (garage door): $460/mo — gone July 2026. Only 5 payments left. This is your first big win — $460/mo freed in ~5 months.",
      "Wells Fargo: $151/mo — paid off Jan 2027. After Goodleap, redirect that $460 as extra payment here to accelerate payoff.",
      "Honda: $507/mo — paid off Mar 2029. This is the big one. When it's gone, your cash flow improves by over $500/mo overnight.",
      "Student Loan: $201/mo — long-term. Lowest priority unless you get a windfall. Federal loans have income-driven options if things get tight.",
      "Do NOT take on any new debt — no new car, no financing deals, no BNPL (Afterpay). Every new payment resets the snowball.",
    ],
  },
  {
    id: "dining",
    icon: "🍽️",
    color: "#10b981",
    title: "Dining out: set a hard $150/mo cap",
    impact: "−$94/mo",
    tag: "Quick win",
    tagColor: "#10b981",
    summary: "You spent $244 dining out in January. Not terrible, but cuttable to $150 with a plan.",
    steps: [
      "Pick 4 'dining out' events per month — one per week. Budget $35-40 each. That's your allowance.",
      "Coffee shops ($37 in January) count against the cap. Dutch Bros and Summer Moon are $5-8 per visit — that's a dining out event.",
      "Pack lunches. This is where most unplanned dining spend hides — workday convenience. Batch cook on Sunday, bring leftovers.",
      "For family meals out, Chipotle and Cava ($25-30 total for 2 adults) are your budget-friendly choices. Pearl Tavern at $87 is a once-in-a-while, not monthly.",
    ],
  },
  {
    id: "subscriptions",
    icon: "📺",
    color: "#6366f1",
    title: "Subscription audit: cut to $100/mo",
    impact: "−$120+/mo",
    tag: "Easy cut",
    tagColor: "#6366f1",
    summary: "You're paying $225+/mo in subscriptions across checking and credit card. $100/mo is achievable without losing much.",
    steps: [
      "YouTube TV ($73): This is your biggest sub. If you're mainly using it for sports, consider canceling between seasons — it's month-to-month. Pair with free Tubi or Pluto TV for filler content.",
      "YouTube Premium ($23): Keep only if the household uses it daily for ad-free viewing. If you have YouTube TV, Premium adds limited extra value for most households.",
      "Max/HBO ($16): Rotate with Disney+. Watch one for a month, cancel, subscribe to the other. You only need one at a time.",
      "Disney+ ($8): Keep during kids' peak usage months (summer, school breaks). Cancel the rest of the year.",
      "Audible ($15): Cancel and use Libby (free through KC library) for audiobooks. KC library has a solid digital collection.",
      "Review all subscriptions quarterly. Cancel anything unused in the past 30 days. Set a calendar reminder before free trials convert.",
    ],
  },
  {
    id: "emergency",
    icon: "🛡️",
    color: "#f59e0b",
    title: "Build a $1,000 starter emergency fund",
    impact: "Breaks the HELOC cycle",
    tag: "Foundation",
    tagColor: "#f59e0b",
    summary: "You used a HELOC bridge twice in January because cash flow timing was tight. A small buffer breaks this.",
    steps: [
      "Target $1,000 in a dedicated savings account — not your checking. This is your 'don't touch' fund for true emergencies.",
      "Your HELOC bridge in January was $2,200 × 2 — using home equity to smooth paycheck timing is a risk. If the HELOC gets frozen or called, that breaks.",
      "Once surplus improves (after Goodleap payoff in July), route $460/mo to savings for 2-3 months to build a proper 1-month emergency fund (~$2,500).",
      "After that, Dave Ramsey's Baby Steps 4-6 apply: invest 15% for retirement, kids' college, pay off house early.",
    ],
  },
];

function Recommendations({ wide, isMobile }) {
  const [expanded, setExpanded] = useState(null);
  const [recs, setRecs]         = useState(RECS);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(null);
  const { checkTxns, ccTxns, selectedMonth, normSurplus, payoffs, takeHome, groceryGoal, dashName } = useBudget();

  const totalImpact = payoffs.reduce((s, p) => s + p.payment, 0);

  // Actual gap = actual income minus actual spending (not normalized)
  const actualIncome = checkTxns.filter(t => t.month === selectedMonth && t.cat === "Income").reduce((s,t)=>s+t.amount,0) || takeHome;
  const actualSpend  = [...checkTxns,...ccTxns].filter(t => t.month === selectedMonth && t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t)=>s+t.amount,0);
  const actualGap    = actualIncome - actualSpend;

  const handleRefresh = async () => {
    if (!ANTHROPIC_API_KEY) {
      setRefreshErr("Add your Anthropic API key to the top of App.jsx (ANTHROPIC_API_KEY) to enable AI tips.");
      return;
    }
    setRefreshing(true);
    setRefreshErr(null);
    try {
      // Build a spending summary from actual transactions
      const allTxns = [...checkTxns, ...ccTxns].filter(t => t.month === selectedMonth && t.cat !== "Income" && t.cat !== "Transfer");
      const byCat = {};
      allTxns.forEach(t => { byCat[t.cat] = (byCat[t.cat]||0) + t.amount; });
      const spendSummary = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>`${cat}: $${amt.toFixed(2)}`).join(", ");
      const gapStr = normSurplus < 0 ? `monthly gap of $${Math.abs(normSurplus).toFixed(0)}` : `monthly surplus of $${normSurplus.toFixed(0)}`;
      const debtStr = payoffs.map(p=>`${p.name} ($${p.payment}/mo, payoff ${p.date})`).join("; ");

      const actualGroceries = byCat["Groceries"] || 0;
      const grocerySavings = Math.max(0, actualGroceries - groceryGoal).toFixed(0);
      const prompt = `You are a personal finance advisor for ${dashName}.

CURRENT SITUATION (${selectedMonth}):
- Take-home pay: $${takeHome.toFixed(2)}/mo
- Total spending: $${allTxns.reduce((s,t)=>s+t.amount,0).toFixed(2)}/mo
- Monthly gap (overspending): $${Math.abs(normSurplus).toFixed(0)}/mo (they are NEGATIVE — do NOT suggest savings/investing/emergency funds until this gap is eliminated)
- Spending by category: ${spendSummary}

STATED GOALS:
- Grocery target: $${groceryGoal}/mo (currently spending $${actualGroceries.toFixed(0)}/mo — $${grocerySavings} over goal)
- Priority: eliminate the monthly gap first, then accelerate debt payoff
- No retirement or emergency fund advice until they reach break-even

ACTIVE DEBTS (monthly payments that free up cash when paid off):
${debtStr}

RULES FOR YOUR RECOMMENDATIONS:
1. Every tip must directly reduce the monthly gap or accelerate debt payoff
2. Do NOT suggest emergency funds, retirement, or investing while they have a monthly deficit
3. Reference EXACT dollar amounts from their actual spending above
4. Grocery tip must target their stated goal of $${groceryGoal}/mo, not a different number
5. Prioritize highest-impact categories first (biggest overspend relative to reasonable targets)
6. Debt payoff tips should reference which debts free up the most cash soonest

Generate exactly 7 actionable recommendations as a JSON array. Each item must have:
- id: short snake_case string
- icon: single emoji
- color: hex color string
- title: short punchy title (max 8 words)
- impact: dollar or % savings estimate (e.g. "−$150/mo")
- tag: 1-2 word label
- tagColor: hex color string
- summary: 1-2 sentence summary (max 40 words)
- steps: array of 3-5 specific action strings, each max 40 words, referencing actual numbers from their spending

Return ONLY a valid JSON array, no markdown, no explanation.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:3000,
          messages:[{role:"user",content:prompt}],
        }),
      });
      const data = await res.json();
      const raw = data.content?.[0]?.text || "";
      const clean = raw.replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(clean);
      if (Array.isArray(parsed) && parsed.length > 0) {
        setRecs(parsed);
      } else {
        throw new Error("Invalid response format");
      }
    } catch(e) {
      console.error(e);
      setRefreshErr("Couldn't refresh tips — make sure an API key is available. Showing original tips.");
      setRecs(RECS);
    }
    setRefreshing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero */}
      <Card glow="#22c55e">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:12}}>
          <Label style={{marginBottom:0}}>Your Financial Roadmap · {selectedMonth} 2026</Label>
          <button onClick={handleRefresh} disabled={refreshing} style={{
            display:"flex",alignItems:"center",gap:7,padding:"7px 14px",borderRadius:10,fontSize:12,fontWeight:700,cursor:refreshing?"wait":"pointer",
            background:refreshing?"#334155":"#818cf822",color:refreshing?MUTED:"#818cf8",
            border:`1px solid ${refreshing?"#334155":"#818cf844"}`,transition:"all .2s",flexShrink:0,
          }}>
            <span style={{display:"inline-block",animation:refreshing?"spin 1s linear infinite":"none",fontSize:14}}>✨</span>
            {refreshing?"Generating tips…":"Refresh tips with AI"}
          </button>
        </div>
        {refreshErr && <div style={{fontSize:12,color:"#f59e0b",marginBottom:10,padding:"8px 12px",background:"#f59e0b11",borderRadius:8,border:"1px solid #f59e0b33"}}>{refreshErr}</div>}
        <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(3,1fr)" : "1fr 1fr", gap: 12, marginBottom: 14 }}>
          {[
            ["#1 Lever",     recs[0]?.title || "Cut groceries to goal", "#f97316"],
            ["Debt relief",  fmt(totalImpact)+"/mo when paid", "#22c55e"],
            ["Monthly gap", (normSurplus < 0 ? "−" : "+")+fmt(Math.abs(normSurplus)), normSurplus < 0 ? "#ef4444" : "#22c55e"],
          ].map(([k,v,c]) => (
            <div key={k} style={{ background: BG, borderRadius: 12, padding: "12px 14px" }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{k}</div>
              <div style={{ fontSize: 15, fontWeight: 900, color: c, lineHeight: 1.3 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.7 }}>
          These recommendations are specific to your {dashName} budget. Hit "Refresh tips with AI" to regenerate based on your latest {selectedMonth} data.
        </div>
      </Card>

      {/* Rec cards */}
      {recs.map(r => {
        const isOpen = expanded === r.id;
        return (
          <Card key={r.id} glow={isOpen ? r.color : undefined} selected={isOpen}
            onClick={() => setExpanded(isOpen ? null : r.id)}
            style={{ cursor: "pointer" }}>
            {/* Header row */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 14, background: r.color+"22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 22 }}>{r.icon}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 5 }}>
                  <span style={{ fontSize: isMobile ? 14 : 16, fontWeight: 700, color: TEXT }}>{r.title}</span>
                  <Tag color={r.tagColor}>{r.tag}</Tag>
                </div>
                <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>{r.summary}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: isMobile ? 14 : 16, fontWeight: 900, color: r.color, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{r.impact}</div>
                <div style={{ fontSize: 18, color: MUTED, marginTop: 4, transition: "transform .2s", transform: isOpen ? "rotate(180deg)" : "none" }}>▾</div>
              </div>
            </div>

            {/* Expanded steps */}
            {isOpen && (
              <div style={{ marginTop: 16, borderTop: `1px solid ${r.color}33`, paddingTop: 16 }}>
                {r.steps.map((step, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, marginBottom: 14, alignItems: "flex-start" }}>
                    <div style={{ width: 26, height: 26, borderRadius: 8, background: r.color+"22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                      <span style={{ fontSize: 12, fontWeight: 900, color: r.color }}>{i+1}</span>
                    </div>
                    <p style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.7, margin: 0 }}>{step}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────────────────────────
// ── TITHE TRACKER ─────────────────────────────────────────────────────────────
// 1st Tithe: 10% to church each month
// 2nd Tithe: 10% saved Jan→Sep, spent all at Feast of Tabernacles (1st of Oct trip)
//            then saved Oct→Dec, carry into next year

const TITHE_RATE   = 0.10;

const ALL_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function TitheTracker({ wide, isMobile }) {
  const { takeHome, t2CarryIn, setT2CarryIn, checkTxns, ccTxns, availableMonths } = useBudget();
  const MONTHLY_TH = takeHome * TITHE_RATE;
  const carry = t2CarryIn;
  const setCarry = setT2CarryIn;

  // Derive actual tithe data from transactions by month
  const ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // 1st Tithe: Giving & Tithe category spending per month (church transfers + Hillcrest etc)
  const T1_ACTUAL = useMemo(() => {
    return availableMonths.map(month => {
      const paid = [...checkTxns, ...ccTxns]
        .filter(t => t.month === month && t.cat === "Giving & Tithe")
        .reduce((s, t) => s + t.amount, 0);
      return { month: SHORT[ORDER.indexOf(month)], paid, notes: "" };
    });
  }, [checkTxns, ccTxns, availableMonths]);

  // 2nd Tithe: transfers to savings (XXXX8500) — tagged as "Giving & Tithe" with "2nd Tithe" or "XXXX8500" in desc
  const T2_ACTUAL = useMemo(() => {
    return availableMonths.map(month => {
      const saved = checkTxns
        .filter(t => t.month === month && t.cat === "Giving & Tithe" &&
          (t.desc.toLowerCase().includes("8500") || t.desc.toLowerCase().includes("2nd tithe") || t.desc.toLowerCase().includes("feast")))
        .reduce((s, t) => s + t.amount, 0);
      return { month: SHORT[ORDER.indexOf(month)], saved, notes: "" };
    });
  }, [checkTxns, availableMonths]);

  const currentMonth = availableMonths.length;

  // ── 1st Tithe YTD ─────────────────────────────────────────────────────────
  const t1YTD    = T1_ACTUAL.reduce((s, m) => s + m.paid, 0);
  const t1Expect = MONTHLY_TH * T1_ACTUAL.length; // what we should have paid
  const t1Over   = t1YTD - t1Expect;              // positive = gave more

  // ── 2nd Tithe: build month-by-month running balance ────────────────────────
  // Feast is October (month index 9). Save Jan–Sep (9 months), spend Oct, save Oct–Dec.
  // Simplified: show projected balance at Oct 1 based on current trend.
  const t2YTDSaved   = T2_ACTUAL.reduce((s, m) => s + m.saved, 0);
  const monthsToFeast = 9 - currentMonth; // months remaining before October
  const t2Projected  = carry + t2YTDSaved + (monthsToFeast * MONTHLY_TH); // if on track
  const t2CurrentBal = carry + t2YTDSaved;

  // Build the full-year savings arc for the bar chart
  // Jan–Sep: accumulate. Oct: spend all. Nov–Dec: start fresh.
  const FEAST_MONTH = 9; // October = index 9
  const t2Chart = ALL_MONTHS.map((m, i) => {
    let balance = 0;
    if (i < FEAST_MONTH) {
      // Saving phase: carry + contributions up to and including this month
      balance = carry + MONTHLY_TH * (i + 1);
    } else if (i === FEAST_MONTH) {
      balance = 0; // spent at feast
    } else {
      // Post-feast saving
      balance = MONTHLY_TH * (i - FEAST_MONTH);
    }
    const isActual = i < T2_ACTUAL.length;
    const actualBal = isActual ? carry + T2_ACTUAL.slice(0,i+1).reduce((s,x)=>s+x.saved,0) : null;
    return { month: m, projected: Math.round(balance), actual: actualBal ? Math.round(actualBal) : null, isFeast: i === FEAST_MONTH };
  });

  // ── 1st tithe full-year expected vs actual ─────────────────────────────────
  const t1Chart = ALL_MONTHS.map((m, i) => {
    const actual = T1_ACTUAL[i];
    return {
      month: m,
      expected: Math.round(MONTHLY_TH),
      actual: actual ? Math.round(actual.paid) : null,
    };
  });

  const statCard = (label, val, sub, color) => (
    <div style={{background:BG, borderRadius:14, padding:"14px 16px", border:`1px solid ${color}33`}}>
      <div style={{fontSize:11, color:MUTED, marginBottom:4}}>{label}</div>
      <div style={{fontSize:22, fontWeight:900, color, fontVariantNumeric:"tabular-nums", marginBottom:2}}>{val}</div>
      <div style={{fontSize:11, color:MUTED}}>{sub}</div>
    </div>
  );

  return (
    <div style={{display:"flex", flexDirection:"column", gap:16}}>

      {/* Header */}
      <Card glow="#7c6af7">
        <Label>Tithe Tracker · 2026</Label>
        <div style={{fontSize:13, color:MUTED, lineHeight:1.7, marginBottom:12}}>
          1st Tithe = 10% to church monthly · 2nd Tithe = 10% saved for 1st of October feast, then spent and restarted.
          Take-home is {fmt(takeHome)}/mo so each tithe is <strong style={{color:ACCENT}}>{fmt(MONTHLY_TH)}/mo</strong>.
        </div>
        <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}>
          <span style={{fontSize:13, color:MUTED}}>2nd Tithe account balance (carry-in from 2025):</span>
          <div style={{display:"flex", alignItems:"center", gap:6, background:BG, borderRadius:10, padding:"4px 10px", border:`1px solid ${BORDER}`}}>
            <span style={{color:MUTED, fontSize:13}}>$</span>
            <input type="number" value={carry} onChange={e=>setCarry(Number(e.target.value))}
              style={{background:"transparent", border:"none", color:ACCENT, fontWeight:700, fontSize:15, width:80, outline:"none", fontVariantNumeric:"tabular-nums"}}/>
          </div>
        </div>
      </Card>

      {/* ── 1ST TITHE ── */}
      <Card>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:8}}>
          <Label style={{marginBottom:0}}>⛪ 1st Tithe — Church (10%)</Label>
          <Tag color={t1Over >= 0 ? "#22c55e" : "#ef4444"}>
            YTD {t1Over >= 0 ? "+" : ""}{fmt(t1Over)} vs expected
          </Tag>
        </div>

        <div style={{display:"grid", gridTemplateColumns:wide?"repeat(3,1fr)":"1fr 1fr", gap:10, marginBottom:18}}>
          {statCard("Monthly target", fmt(MONTHLY_TH), "10% of take-home", "#7c6af7")}
          {statCard("YTD paid", fmt(t1YTD), `${T1_ACTUAL.length} month${T1_ACTUAL.length!==1?"s":""} on record`, "#7c6af7")}
          {statCard("Full-year target", fmt(MONTHLY_TH * 12), "if income stays flat", MUTED)}
        </div>

        {/* Monthly bar chart */}
        <div style={{fontSize:11, color:MUTED, marginBottom:8}}>Monthly · expected vs actual</div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={t1Chart} barGap={2} barCategoryGap="30%">
            <XAxis dataKey="month" tick={{fontSize:10, fill:MUTED}} axisLine={false} tickLine={false}/>
            <YAxis hide domain={[0, MONTHLY_TH * 1.5]}/>
            <Tooltip content={<Tip/>}/>
            <Bar dataKey="expected" name="Expected" fill={DIM} radius={[4,4,0,0]}/>
            <Bar dataKey="actual"   name="Actual"   radius={[4,4,0,0]}>
              {t1Chart.map((d,i)=><Cell key={i} fill={d.actual!=null?(d.actual>=MONTHLY_TH?"#22c55e":"#f59e0b"):"transparent"}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

                {/* Breakdown — derived from imported transactions */}
        {T1_ACTUAL.some(m => m.paid > 0) && (() => {
          const currentMonthName = availableMonths[availableMonths.length - 1] || "January";
          const t1Txns = [...checkTxns, ...ccTxns].filter(t =>
            t.month === currentMonthName && t.cat === "Giving & Tithe"
          );
          if (t1Txns.length === 0) return null;
          return (
            <div style={{marginTop:14, borderTop:`1px solid ${BORDER}`, paddingTop:14}}>
              <div style={{fontSize:11, color:MUTED, marginBottom:8}}>{currentMonthName.toUpperCase()} BREAKDOWN</div>
              {t1Txns.map((t,i)=>(
                <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"7px 10px", borderRadius:8, background:i%2===0?SURFACE:BG, marginBottom:3}}>
                  <div style={{fontSize:12, color:TEXT}}>{t.desc}</div>
                  <div style={{display:"flex", alignItems:"center", gap:10}}>
                    <Tag color="#3b82f6">Checking</Tag>
                    <span style={{fontSize:13, fontWeight:700, color:"#7c6af7", fontVariantNumeric:"tabular-nums"}}>{fmt(t.amount)}</span>
                  </div>
                </div>
              ))}
              <div style={{display:"flex", justifyContent:"space-between", padding:"9px 10px",
                borderTop:`1px solid ${BORDER}`, marginTop:4}}>
                <span style={{fontSize:12, fontWeight:700, color:MUTED}}>{currentMonthName} 1st Tithe total</span>
                <span style={{fontSize:14, fontWeight:900, color:"#7c6af7", fontVariantNumeric:"tabular-nums"}}>{fmt(t1YTD)}</span>
              </div>
            </div>
          );
        })()}
      </Card>

      {/* ── 2ND TITHE ── */}
      <Card>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:8}}>
          <Label style={{marginBottom:0}}>🏕️ 2nd Tithe — 1st of October Feast (10%)</Label>
          <Tag color="#f59e0b">Feast: Oct 2026</Tag>
        </div>

        <div style={{display:"grid", gridTemplateColumns:wide?"repeat(4,1fr)":"1fr 1fr", gap:10, marginBottom:18}}>
          {statCard("Carry-in (2025 saving)", fmt(carry), "Oct–Dec 2025 balance", "#f59e0b")}
          {statCard("Saved so far (2026)", fmt(t2YTDSaved), `${T2_ACTUAL.length} month${T2_ACTUAL.length!==1?"s":""} of saving`, "#f59e0b")}
          {statCard("Current balance", fmt(t2CurrentBal), "carry-in + 2026 YTD", "#f59e0b")}
          {statCard("Projected at Oct 1", fmt(t2Projected), `if $${Math.round(MONTHLY_TH)}/mo continues`, "#22c55e")}
        </div>

        {/* Progress bar to feast */}
        <div style={{marginBottom:18}}>
          <div style={{display:"flex", justifyContent:"space-between", fontSize:11, color:MUTED, marginBottom:6}}>
            <span>Balance progress toward Oct 1</span>
            <span>{fmt(t2CurrentBal)} of {fmt(t2Projected)} projected</span>
          </div>
          <div style={{height:10, borderRadius:99, background:DIM, overflow:"hidden", position:"relative"}}>
            <div style={{height:"100%", width:`${Math.min(100,(t2CurrentBal/t2Projected)*100).toFixed(1)}%`,
              background:"linear-gradient(90deg,#f59e0b,#fbbf24)", borderRadius:99, transition:"width .5s"}}/>
          </div>
          <div style={{fontSize:11, color:"#f59e0b", marginTop:4}}>
            {monthsToFeast} months of saving remaining · {fmt(monthsToFeast * MONTHLY_TH)} more expected
          </div>
        </div>

        {/* Full-year arc chart */}
        <div style={{fontSize:11, color:MUTED, marginBottom:8}}>Account balance through the year · projected vs actual</div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={t2Chart} barGap={3} barCategoryGap="25%">
            <XAxis dataKey="month" tick={{fontSize:10, fill:MUTED}} axisLine={false} tickLine={false}/>
            <YAxis hide/>
            <Tooltip formatter={(v, n) => [fmt(v), n]} content={<Tip/>}/>
            {/* Projected bars */}
            <Bar dataKey="projected" name="Projected balance" radius={[4,4,0,0]}>
              {t2Chart.map((d,i) => (
                <Cell key={i}
                  fill={d.isFeast ? "#ef444444" : i > FEAST_MONTH ? "#f59e0b44" : "#f59e0b33"}/>
              ))}
            </Bar>
            {/* Actual bars overlaid */}
            <Bar dataKey="actual" name="Actual balance" radius={[4,4,0,0]}>
              {t2Chart.map((d,i)=><Cell key={i} fill="#f59e0b"/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* 2nd Tithe breakdown — derived from imported transactions */}
        {(() => {
          const currentMonthName = availableMonths[availableMonths.length - 1] || "January";
          const t2Txns = checkTxns.filter(t =>
            t.month === currentMonthName && t.cat === "Giving & Tithe" &&
            (t.desc.toLowerCase().includes("8500") ||
             t.desc.toLowerCase().includes("2nd tithe") ||
             t.desc.toLowerCase().includes("feast"))
          );
          if (t2Txns.length === 0 && t2YTDSaved === 0) return null;
          return (
            <div style={{marginTop:14, borderTop:`1px solid ${BORDER}`, paddingTop:14}}>
              <div style={{fontSize:11, color:MUTED, marginBottom:8}}>{currentMonthName.toUpperCase()} BREAKDOWN · 2nd Tithe savings transactions</div>
              {t2Txns.length > 0 ? t2Txns.map((t,i)=>(
                <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"7px 10px", borderRadius:8, background:i%2===0?SURFACE:BG, marginBottom:3}}>
                  <div style={{fontSize:12, color:TEXT}}>{t.desc}</div>
                  <div style={{display:"flex", alignItems:"center", gap:10}}>
                    <Tag color="#3b82f6">Checking</Tag>
                    <span style={{fontSize:13, fontWeight:700, color:"#f59e0b", fontVariantNumeric:"tabular-nums"}}>{fmt(t.amount)}</span>
                  </div>
                </div>
              )) : (
                <div style={{fontSize:12,color:MUTED,padding:"8px 10px"}}>
                  No 2nd tithe transfers found yet. Transactions with "8500", "2nd tithe", or "feast" in the description will appear here.
                </div>
              )}
              <div style={{display:"flex", justifyContent:"space-between", padding:"9px 10px",
                borderTop:`1px solid ${BORDER}`, marginTop:4}}>
                <span style={{fontSize:12, fontWeight:700, color:MUTED}}>{currentMonthName} 2nd Tithe saved</span>
                <span style={{fontSize:14, fontWeight:900, color:"#f59e0b", fontVariantNumeric:"tabular-nums"}}>{fmt(t2YTDSaved)}</span>
              </div>
            </div>
          );
        })()}

        {/* Oct feast callout */}
        <div style={{marginTop:14, padding:"12px 16px", borderRadius:12,
          background:"#ef444411", border:"1px solid #ef444433",
          display:"flex", alignItems:"center", gap:12}}>
          <span style={{fontSize:24}}>🏕️</span>
          <div>
            <div style={{fontSize:13, fontWeight:700, color:"#ef4444"}}>October — Feast spending</div>
            <div style={{fontSize:12, color:MUTED, marginTop:2}}>
              Projected feast fund: <strong style={{color:"#22c55e"}}>{fmt(t2Projected)}</strong> available Oct 1.
              After spending, balance resets to $0 and Nov/Dec saving begins.
            </div>
          </div>
        </div>
      </Card>

    </div>
  );
}


// ── STATEMENT IMPORTER ────────────────────────────────────────────────────────
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_CODES = ["01","02","03","04","05","06","07","08","09","10","11","12"];

const PARSE_PROMPT = (src, month) => `You are a bank statement parser for a family budget app.

Parse ALL transactions from this ${src === "checking" ? "checking account" : "credit card"} statement for ${month}.

Return ONLY a JSON array — no markdown, no explanation, nothing else. Each object must have:
- "date": string "MM/DD" format
- "desc": string — merchant/description (keep concise, max 40 chars)
- "amount": number — POSITIVE for expenses/charges, NEGATIVE for credits/returns/refunds
- "cat": string — MUST be exactly one of: ${allCats.filter(c=>c!=="Income"&&c!=="Transfer").join(", ")}
- "note": string — brief note if useful, empty string otherwise

Categorization rules:
- Mortgage, rent, utilities (electric, gas, water, internet, phone), home repairs → "Housing"
- Church giving, tithe transfers (XXXX5748 or XXXX8500) → "Giving & Tithe"
- Grocery stores, supermarkets, warehouse clubs (food only) → "Groceries"
- Restaurants, cafes, fast food, coffee shops → "Dining Out"
- Doctors, hospitals, pharmacy, therapy, medical → "Medical"
- ABA therapy, Success on Spectrum → "ABA Therapy"
- Gas stations (fuel), auto payment, auto insurance → "Transportation"
- Amazon, retail stores, online shopping (non-grocery) → "Shopping"
- Netflix, Hulu, Disney+, Spotify, subscriptions → "Subscriptions"
- Kids activities, school, children's stores → "Kids & Family"
- Snacks at gas stations, misc small purchases → "Snacks/Misc"
- Loan payments, credit card payments, insurance premiums → "Debt Service"
- Paycheck deposits, income → "Income"
- HELOC draws, transfers between own accounts → "Transfer"

Return ONLY the JSON array. Example format:
[{"date":"02/01","desc":"Costco","amount":187.43,"cat":"Groceries","note":""},{"date":"02/03","desc":"Mortgage","amount":1602.23,"cat":"Housing","note":""}]`;

// ── TRENDS ────────────────────────────────────────────────────────────────────
function Trends({ wide, isMobile }) {
  const { checkTxns, ccTxns, availableMonths, selectedMonth, setSelectedMonth } = useBudget();
  const [focusCat, setFocusCat] = useState(null);

  const MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  // Build per-month totals for each category across all available months
  const trendData = useMemo(() => {
    return availableMonths.map(m => {
      const row = { month: m.slice(0,3) };
      SUMMARY_ROWS.forEach(r => {
        const c = [...checkTxns, ...ccTxns]
          .filter(t => t.month === m && t.cat === r.cat && t.cat !== "Transfer" && t.cat !== "Income")
          .reduce((s,t) => s + t.amount, 0);
        row[r.cat] = Math.round(c);
      });
      row._total = SUMMARY_ROWS.reduce((s,r) => s + (row[r.cat]||0), 0);
      row._income = checkTxns.filter(t => t.month===m && t.cat==="Income").reduce((s,t)=>s+t.amount,0);
      return row;
    });
  }, [checkTxns, ccTxns, availableMonths]);

  // Month-over-month delta for selected cat
  const deltaData = focusCat && trendData.length >= 2
    ? trendData.map((d,i) => ({
        month: d.month,
        value: d[focusCat] || 0,
        delta: i === 0 ? 0 : ((d[focusCat]||0) - (trendData[i-1][focusCat]||0)),
      }))
    : [];

  const hasMultiple = availableMonths.length >= 2;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* Header */}
      <Card glow="#818cf8">
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:hasMultiple?12:0}}>
          <div style={{width:44,height:44,borderRadius:14,background:"#818cf822",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>📊</div>
          <div>
            <Label style={{marginBottom:2}}>Month-over-Month Trends</Label>
            <div style={{fontSize:13,color:MUTED}}>
              {hasMultiple
                ? `${availableMonths.length} months of data · click a category to focus`
                : "Import a second month to unlock trend graphs — only January is available so far"}
            </div>
          </div>
        </div>
        {!hasMultiple && (
          <div style={{marginTop:12,padding:"14px 16px",borderRadius:12,background:"#818cf811",border:"1px solid #818cf833",fontSize:13,color:"#818cf8"}}>
            💡 Use the <strong>📥 Import</strong> tab to upload your February statement. Once it's added, all trend charts will populate automatically.
          </div>
        )}
      </Card>

      {hasMultiple && (
        <>
          {/* Total spending per month */}
          <Card>
            <Label>Total Spending by Month</Label>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={trendData} barCategoryGap="35%">
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis hide/>
                <Tooltip formatter={v=>[fmt(v),"Spending"]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Bar dataKey="_total" name="Total Spend" radius={[6,6,0,0]}>
                  {trendData.map((d,i)=>(
                    <Cell key={i} fill={d.month===selectedMonth.slice(0,3)?"#818cf8":"#818cf844"}/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Category breakdown stacked by month */}
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <Label style={{marginBottom:0}}>Category Breakdown by Month</Label>
              {focusCat && (
                <button onClick={()=>setFocusCat(null)} style={{fontSize:12,color:MUTED,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"4px 10px",cursor:"pointer"}}>
                  ✕ Clear focus
                </button>
              )}
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={trendData} barCategoryGap="30%" barGap={2}>
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis hide/>
                <Tooltip formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:11,maxHeight:300,overflowY:"auto"}}/>
                {SUMMARY_ROWS.filter(r => !focusCat || r.cat === focusCat).map(r => (
                  <Bar key={r.cat} dataKey={r.cat} stackId="a" fill={r.color}
                    opacity={focusCat && focusCat !== r.cat ? 0.15 : 1}
                    radius={r.cat === SUMMARY_ROWS[SUMMARY_ROWS.length-1].cat ? [4,4,0,0] : [0,0,0,0]}/>
                ))}
              </BarChart>
            </ResponsiveContainer>
            {/* Category legend — click to focus */}
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:12}}>
              {SUMMARY_ROWS.map(r=>(
                <button key={r.cat} onClick={()=>setFocusCat(focusCat===r.cat?null:r.cat)} style={{
                  display:"flex",alignItems:"center",gap:5,padding:"3px 8px",borderRadius:99,cursor:"pointer",
                  background:focusCat===r.cat?r.color+"33":BG,
                  border:`1px solid ${focusCat===r.cat?r.color:BORDER}`,
                  color:focusCat===r.cat?r.color:MUTED,fontSize:11,fontWeight:focusCat===r.cat?700:400,
                  transition:"all .15s",
                }}>
                  <div style={{width:8,height:8,borderRadius:2,background:r.color,flexShrink:0}}/>
                  {r.cat}
                </button>
              ))}
            </div>
          </Card>

          {/* Focused category month-over-month delta */}
          {focusCat && deltaData.length >= 2 && (
            <Card>
              <Label>{focusCat} · Month-over-Month Change</Label>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={deltaData} barCategoryGap="40%">
                  <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                  <YAxis hide/>
                  <Tooltip formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                  <ReferenceLine y={0} stroke={BORDER}/>
                  <Bar dataKey="delta" name="Change vs prior month" radius={[4,4,0,0]}>
                    {deltaData.map((d,i)=>(
                      <Cell key={i} fill={d.delta>0?"#ef4444":d.delta<0?"#22c55e":"#334155"}/>
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{display:"flex",gap:10,marginTop:8,fontSize:11,color:MUTED}}>
                <span style={{color:"#22c55e"}}>● Down = spending less</span>
                <span style={{color:"#ef4444"}}>● Up = spending more</span>
              </div>
            </Card>
          )}

          {/* Per-category table comparison */}
          <Card style={{padding:0,overflow:"hidden"}}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${BORDER}`}}>
              <Label style={{marginBottom:0}}>Side-by-Side Comparison</Label>
            </div>
            {/* Header row */}
            <div style={{display:"grid",gridTemplateColumns:`180px repeat(${availableMonths.length},1fr)`,padding:"8px 16px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
              <div style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px"}}>Category</div>
              {availableMonths.map(m=>(
                <div key={m} style={{fontSize:10,fontWeight:700,color:m===selectedMonth?ACCENT:MUTED,textTransform:"uppercase",letterSpacing:".5px",textAlign:"right"}}>{m.slice(0,3)}</div>
              ))}
            </div>
            {SUMMARY_ROWS.map((r,i)=>(
              <div key={r.cat} style={{display:"grid",gridTemplateColumns:`180px repeat(${availableMonths.length},1fr)`,padding:"9px 16px",borderBottom:`1px solid ${BORDER}`,background:i%2===0?SURFACE:BG,alignItems:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:2,background:r.color,flexShrink:0}}/>
                  <span style={{fontSize:12,color:TEXT}}>{r.cat}</span>
                </div>
                {availableMonths.map((m,mi)=>{
                  const val = trendData[mi]?.[r.cat]||0;
                  const prev = mi>0 ? (trendData[mi-1]?.[r.cat]||0) : null;
                  const delta = prev!==null ? val-prev : 0;
                  return (
                    <div key={m} style={{textAlign:"right"}}>
                      <div style={{fontSize:12,fontWeight:700,color:m===selectedMonth?TEXT:MUTED,fontVariantNumeric:"tabular-nums"}}>{val>0?fmt(val):"—"}</div>
                      {mi>0&&val>0&&<div style={{fontSize:10,color:delta>0?"#ef4444":"#22c55e",fontVariantNumeric:"tabular-nums"}}>{delta>0?"+":""}{fmt(delta)}</div>}
                    </div>
                  );
                })}
              </div>
            ))}
            {/* Totals */}
            <div style={{display:"grid",gridTemplateColumns:`180px repeat(${availableMonths.length},1fr)`,padding:"10px 16px",background:BG,borderTop:`2px solid ${BORDER}`}}>
              <div style={{fontSize:12,fontWeight:800,color:MUTED}}>Total</div>
              {trendData.map((d,i)=>(
                <div key={i} style={{textAlign:"right",fontSize:13,fontWeight:900,color:availableMonths[i]===selectedMonth?ACCENT:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(d._total)}</div>
              ))}
            </div>
          </Card>
        </>
      )}

      {/* Always show: single-month summary even with one month */}
      {!hasMultiple && (
        <Card>
          <Label>January 2026 · Category Summary</Label>
          <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
            {SUMMARY_ROWS.map(r=>{
              const val = [...checkTxns,...ccTxns].filter(t=>t.month==="January"&&t.cat===r.cat&&t.cat!=="Transfer"&&t.cat!=="Income").reduce((s,t)=>s+t.amount,0);
              if(!val) return null;
              return (
                <div key={r.cat} style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:8,height:8,borderRadius:2,background:r.color,flexShrink:0}}/>
                  <span style={{fontSize:13,color:TEXT,flex:1}}>{r.cat}</span>
                  <span style={{fontSize:13,fontWeight:700,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(val)}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}


// ── SETTINGS ────────────────────────────────────────────────────────────────
function NewCatInput({ onAdd, allCats }) {
  const [val, setVal] = useState("");
  const submit = () => {
    const name = val.trim();
    if (!name || allCats.map(c=>c.toLowerCase()).includes(name.toLowerCase())) return;
    onAdd(name);
    setVal("");
  };
  return (
    <div style={{display:"flex",gap:8}}>
      <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
        placeholder="New category name…"
        style={{flex:1,background:BG,border:`1px solid #06b6d4`,borderRadius:8,padding:"7px 12px",color:TEXT,fontSize:13,outline:"none"}}/>
      <button onClick={submit}
        style={{padding:"7px 16px",borderRadius:8,background:"#06b6d4",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
        + Add
      </button>
    </div>
  );
}

function Settings({ isMobile }) {
  const {
    takeHome, setTakeHome,
    oneTimes, setOneTimes,
    budgetKc, setBudgetKc,
    t2CarryIn, setT2CarryIn,
    groceryGoal, setGroceryGoal,
    clearTxns, addTxns, checkTxns, ccTxns,
    payoffs, setPayoffs,
    summaryRows,
    waterfallDisabled, setWaterfallDisabled,
    dashName, setDashName,
    showTithe, setShowTithe,
    showABA,   setShowABA,
    customCats, setCustomCats, allCats,
  } = useBudget();

  const [thInput, setThInput]     = useState(takeHome || "");
  const [t2Input, setT2Input]     = useState(t2CarryIn || "");
  const [otDesc, setOtDesc]       = useState("");
  const [otAmt, setOtAmt]         = useState("");
  const [otCat, setOtCat]         = useState(allCats[0]);
  const [confirmClear, setConfirmClear] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState(() => { try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; } });
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const saveApiKey = () => { try { localStorage.setItem("budget_apikey", apiKeyInput); setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); } catch {} };

  const accentSet = "#a78bfa";

  const exportData = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      checkTxns, ccTxns,
      takeHome, t2CarryIn, groceryGoal,
      oneTimes, budgetKc, payoffs,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `${(dashName||"my-budget").toLowerCase().replace(/[^a-z0-9]+/g,"-")}-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const importData = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const d = JSON.parse(ev.target.result);
        if (!d.version) throw new Error("Not a budget backup file");
        if (d.checkTxns) { clearTxns("checking"); setTimeout(() => addTxns("checking", d.checkTxns), 50); }
        if (d.ccTxns)    { clearTxns("cc");       setTimeout(() => addTxns("cc", d.ccTxns), 50); }
        if (d.takeHome)   setTakeHome(d.takeHome);
        if (d.t2CarryIn !== undefined) setT2CarryIn(d.t2CarryIn);
        if (d.groceryGoal) setGroceryGoal(d.groceryGoal);
        if (d.oneTimes)   setOneTimes(d.oneTimes);
        if (d.budgetKc)   setBudgetKc(d.budgetKc);
        if (d.payoffs)    setPayoffs(d.payoffs);
        setImportErr("✓ Restored successfully — " + (d.checkTxns?.length||0) + " checking + " + (d.ccTxns?.length||0) + " CC transactions");
      } catch(err) { setImportErr("Import failed: " + err.message); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const saveNum = (setter, val) => {
    const n = parseFloat(val);
    if (!isNaN(n)) setter(n);
  };

  return (
    <div style={{padding: isMobile ? "16px 14px" : "24px 28px", maxWidth:680, margin:"0 auto"}}>
      <div style={{fontSize:20,fontWeight:900,color:accentSet,marginBottom:20}}>⚙️ Settings</div>

      {/* Dashboard Name */}
      <Card glow={accentSet}>
        <Label>🏷️ Dashboard Name</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:10}}>Shown in the header and sidebar. Use your family name, initials, or anything you like.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input
            value={dashName}
            onChange={e => setDashName(e.target.value)}
            placeholder="e.g. Smith Budget"
            style={{flex:1,background:BG,border:`1px solid ${accentSet}`,borderRadius:8,padding:"8px 12px",color:TEXT,fontSize:15,outline:"none"}}
          />
        </div>
      </Card>

      {/* Feature Toggles */}
      <Card glow="#7c6af7" style={{marginTop:16}}>
        <Label>🔀 Feature Toggles</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>Hide tabs and categories you don't need. Data for hidden categories is still tracked — it just won't appear in the nav or summary.</div>
        {[
          { key:"tithe", label:"Tithe Tracker", emoji:"⛪", desc:"Giving & Tithe category + Tithe tab", val:showTithe, set:setShowTithe },
          { key:"aba",   label:"ABA Planner",   emoji:"🧩", desc:"ABA Therapy category + ABA tab",   val:showABA,   set:setShowABA   },
        ].map(f => (
          <div key={f.key} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:10,background:BG,border:`1px solid ${f.val?"#7c6af744":BORDER}`,marginBottom:8,opacity:f.val?1:0.6,transition:"all .15s"}}>
            <span style={{fontSize:20}}>{f.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:TEXT}}>{f.label}</div>
              <div style={{fontSize:11,color:MUTED}}>{f.desc}</div>
            </div>
            <button onClick={() => f.set(v => !v)}
              style={{padding:"5px 16px",borderRadius:8,fontSize:12,fontWeight:800,cursor:"pointer",transition:"all .15s",
                background:f.val?"#7c6af722":BORDER, color:f.val?"#7c6af7":MUTED,
                border:`1px solid ${f.val?"#7c6af755":BORDER}`}}>
              {f.val ? "✓ On" : "Off"}
            </button>
          </div>
        ))}
      </Card>

      {/* API Key */}
      <Card glow="#818cf8">
        <Label>🔑 Anthropic API Key</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Stored in your browser localStorage — survives JSX file replacements. Required for AI tips and PDF statement import.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input type="password" value={apiKeyInput} onChange={e=>setApiKeyInput(e.target.value)}
            placeholder="sk-ant-api03-..."
            style={{flex:1,background:BG,border:`1px solid ${"#818cf8"}`,borderRadius:8,padding:"8px 12px",color:TEXT,fontSize:13,outline:"none",fontFamily:"monospace"}}/>
          <button onClick={saveApiKey}
            style={{padding:"8px 16px",borderRadius:8,background:apiKeySaved?"#22c55e":"#818cf8",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer",transition:"background .3s",whiteSpace:"nowrap"}}>
            {apiKeySaved?"✓ Saved!":"Save Key"}
          </button>
        </div>
        {apiKeyInput && <div style={{fontSize:11,color:"#22c55e",marginTop:8}}>✓ Key loaded · {apiKeyInput.slice(0,12)}•••</div>}
      </Card>

      {/* Custom Categories */}
      <Card glow="#06b6d4" style={{marginTop:16}}>
        <Label>🏷️ Custom Categories</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Add your own spending categories. They'll appear everywhere categories are listed.</div>
        {customCats.length > 0 && (
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
            {customCats.map((c,i) => (
              <div key={c} style={{display:"flex",alignItems:"center",gap:5,background:"#06b6d411",border:"1px solid #06b6d433",borderRadius:99,padding:"3px 10px"}}>
                <span style={{fontSize:12,color:"#06b6d4",fontWeight:600}}>{c}</span>
                <button onClick={() => setCustomCats(prev => prev.filter((_,j) => j !== i))}
                  style={{background:"none",border:"none",color:"#06b6d4",fontSize:12,cursor:"pointer",padding:0,lineHeight:1,opacity:.7}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <NewCatInput onAdd={name => setCustomCats(prev => prev.includes(name) ? prev : [...prev, name])} allCats={allCats} />
      </Card>

      {/* Waterfall Visibility */}
      <Card glow="#f97316" style={{marginTop:16}}>
        <Label>📊 Payoff Waterfall — Visible Steps</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>
          Each over-budget category and debt automatically appears as a waterfall step. Toggle any off to hide it from the chart.
        </div>
        {(() => {
          // All possible waterfall step IDs
          const allSteps = [
            ...summaryRows.filter(r => r.kc && (r.checking + r.cc) > r.kc).map(r => ({
              id: "cat_" + r.cat, label: r.cat + " →$" + (r.kc||0).toLocaleString(),
              color: r.color, save: (r.checking + r.cc) - r.kc, type:"cat"
            })),
            ...payoffs.map(p => ({ id:"payoff_"+p.id, label:p.name, color:p.color, save:p.payment, type:"payoff" })),
            ...(() => { try { const s = localStorage.getItem("budget_customScenarios"); return s ? JSON.parse(s) : []; } catch { return []; } })()
              .map(s => ({ id:s.id, label:s.label, color:s.color, save:s.payment, type:"custom" })),
          ];
          if (allSteps.length === 0) return <div style={{fontSize:13,color:MUTED}}>No over-budget categories or debts yet — add transactions to see steps here.</div>;
          return (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {allSteps.map(step => {
                const isOn = !waterfallDisabled.includes(step.id);
                return (
                  <div key={step.id} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,background:BG,border:`1px solid ${isOn?step.color+"33":BORDER}`,opacity:isOn?1:0.5,transition:"all .15s"}}>
                    <div style={{width:10,height:10,borderRadius:3,background:step.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,color:TEXT,fontWeight:600}}>{step.label}</div>
                      <div style={{fontSize:11,color:MUTED,textTransform:"capitalize"}}>{step.type === "cat" ? "over-budget category" : step.type === "payoff" ? "debt payoff" : "custom step"} · +{new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(step.save)}/mo</div>
                    </div>
                    <button onClick={() => setWaterfallDisabled(prev => isOn ? [...prev, step.id] : prev.filter(x => x !== step.id))}
                      style={{padding:"4px 12px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",transition:"all .15s",
                        background:isOn?step.color+"22":BORDER, color:isOn?step.color:MUTED,
                        border:`1px solid ${isOn?step.color+"44":BORDER}`}}>
                      {isOn ? "✓ Shown" : "Hidden"}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </Card>

      {/* Backup & Restore */}
      <Card glow="#06b6d4" style={{marginTop:16}}>
        <Label>💾 Backup & Restore</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>
          Export all transactions + settings to a JSON file. If you stop Vite your <strong style={{color:TEXT}}>localStorage data stays</strong> — it's tied to the browser, not Vite. But export regularly as a backup in case you clear your browser or switch machines.
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <button onClick={exportData}
            style={{padding:"8px 18px",borderRadius:8,background:"#06b6d422",color:"#06b6d4",border:"1px solid #06b6d444",fontSize:13,fontWeight:800,cursor:"pointer"}}>
            ⬇ Export JSON backup
          </button>
          <label style={{padding:"8px 18px",borderRadius:8,background:"#a78bfa22",color:"#a78bfa",border:"1px solid #a78bfa44",fontSize:13,fontWeight:800,cursor:"pointer"}}>
            ⬆ Restore from backup
            <input type="file" accept=".json" onChange={importData} style={{display:"none"}}/>
          </label>
        </div>
        {importErr && (
          <div style={{marginTop:10,fontSize:12,color:importErr.startsWith("✓")?"#22c55e":"#ef4444",fontWeight:700}}>{importErr}</div>
        )}
      </Card>


      {/* Take-Home */}
      <Card glow={accentSet}>
        <Label>Monthly Take-Home Pay</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:10}}>Your net pay after taxes each month. Used to compute surplus/gap.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{color:MUTED,fontSize:16}}>$</span>
          <input
            type="number" value={thInput}
            onChange={e => setThInput(e.target.value)}
            onBlur={() => saveNum(setTakeHome, thInput)}
            placeholder="e.g. 7861.55"
            style={{flex:1,background:BG,border:`1px solid ${accentSet}`,borderRadius:8,padding:"8px 12px",color:TEXT,fontSize:15,outline:"none"}}
          />
          <button onClick={() => saveNum(setTakeHome, thInput)}
            style={{padding:"8px 16px",borderRadius:8,background:accentSet,color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
            Save
          </button>
        </div>
        <div style={{marginTop:8,fontSize:12,color:accentSet}}>Current: {takeHome > 0 ? `$${takeHome.toLocaleString()}` : "Not set"}</div>
      </Card>

      {/* 2nd Tithe Carry-In — only visible when Tithe feature is on */}
      {showTithe && (
      <Card glow="#22c55e" style={{marginTop:16}}>
        <Label>2nd Tithe Opening Balance</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:10}}>Balance in your feast savings account at the start of this year.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{color:MUTED,fontSize:16}}>$</span>
          <input
            type="number" value={t2Input}
            onChange={e => setT2Input(e.target.value)}
            onBlur={() => saveNum(setT2CarryIn, t2Input)}
            placeholder="e.g. 4843.86"
            style={{flex:1,background:BG,border:`1px solid #22c55e`,borderRadius:8,padding:"8px 12px",color:TEXT,fontSize:15,outline:"none"}}
          />
          <button onClick={() => saveNum(setT2CarryIn, t2Input)}
            style={{padding:"8px 16px",borderRadius:8,background:"#22c55e",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
            Save
          </button>
        </div>
        <div style={{marginTop:8,fontSize:12,color:"#22c55e"}}>Current: {t2CarryIn > 0 ? `$${t2CarryIn.toLocaleString()}` : "Not set"}</div>
      </Card>
      )}

      {/* Budget Targets per Category */}
      <Card glow="#f97316" style={{marginTop:16}}>
        <Label>Monthly Budget Targets</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Set your target spending limit per category. Leave blank for no limit.</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {summaryRows.map(r => (
            <div key={r.cat} style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:14,width:140,color:TEXT,flexShrink:0}}>{r.icon} {r.cat}</span>
              <span style={{color:MUTED}}>$</span>
              <input
                type="number"
                defaultValue={budgetKc[r.cat] !== undefined ? budgetKc[r.cat] : (r.kc || "")}
                onBlur={e => {
                  const v = e.target.value.trim();
                  setBudgetKc(prev => ({ ...prev, [r.cat]: v === "" ? null : parseFloat(v) }));
                }}
                placeholder="no limit"
                style={{width:90,background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"5px 8px",color:TEXT,fontSize:13,outline:"none"}}
              />
              <span style={{fontSize:11,color:MUTED}}>/ mo</span>
            </div>
          ))}
        </div>
      </Card>

      {/* One-Time Expenses */}
      <Card glow="#ec4899" style={{marginTop:16}}>
        <Label>One-Time Expenses</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Large one-time items are excluded from your normalized ("recurring") budget.</div>
        {oneTimes.length > 0 && (
          <div style={{marginBottom:12,display:"flex",flexDirection:"column",gap:6}}>
            {oneTimes.map((o, i) => (
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,background:BG,borderRadius:8,padding:"6px 10px"}}>
                <span style={{flex:1,fontSize:13,color:TEXT}}>{o.name}</span>
                <span style={{fontSize:12,color:"#ec4899",fontWeight:700}}>${o.amount.toLocaleString()}</span>
                <span style={{fontSize:11,color:MUTED}}>{o.cat}</span>
                <button onClick={() => setOneTimes(prev => prev.filter((_,j) => j !== i))}
                  style={{background:"#ef444422",color:"#ef4444",border:"none",borderRadius:6,padding:"2px 8px",fontSize:11,cursor:"pointer",fontWeight:700}}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          <input value={otDesc} onChange={e => setOtDesc(e.target.value)} placeholder="Description"
            style={{flex:2,minWidth:120,background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"6px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
          <input value={otAmt} onChange={e => setOtAmt(e.target.value)} placeholder="Amount" type="number"
            style={{width:90,background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"6px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
          <select value={otCat} onChange={e => setOtCat(e.target.value)}
            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"6px 10px",color:TEXT,fontSize:13,outline:"none"}}>
            {allCats.filter(c => c !== "Income" && c !== "Transfer").map(c => <option key={c}>{c}</option>)}
          </select>
          <button onClick={() => {
            if (!otDesc || !otAmt) return;
            setOneTimes(prev => [...prev, { name: otDesc, amount: parseFloat(otAmt), cat: otCat }]);
            setOtDesc(""); setOtAmt("");
          }} style={{padding:"6px 14px",borderRadius:6,background:"#ec4899",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
            + Add
          </button>
        </div>
      </Card>

      {/* Danger Zone */}
      <Card glow="#ef4444" style={{marginTop:16}}>
        <Label style={{color:"#ef4444"}}>Danger Zone</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Permanently deletes imported transactions. Cannot be undone.</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[
            { label:"Clear Checking", src:"checking", count:checkTxns.length },
            { label:"Clear Credit Card", src:"cc", count:ccTxns.length },
            { label:"Clear ALL Transactions", src:"all", count:checkTxns.length + ccTxns.length },
          ].map(({ label, src, count }) => (
            <div key={src}>
              {confirmClear === src ? (
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:12,color:"#ef4444"}}>Delete {count} txns?</span>
                  <button onClick={() => { clearTxns(src); setConfirmClear(null); }}
                    style={{padding:"5px 10px",borderRadius:6,background:"#ef4444",color:"white",border:"none",cursor:"pointer",fontSize:12,fontWeight:800}}>Yes, Delete</button>
                  <button onClick={() => setConfirmClear(null)}
                    style={{padding:"5px 10px",borderRadius:6,background:SURFACE,color:MUTED,border:`1px solid ${BORDER}`,cursor:"pointer",fontSize:12}}>Cancel</button>
                </div>
              ) : (
                <button onClick={() => setConfirmClear(src)}
                  style={{padding:"7px 14px",borderRadius:8,background:"#ef444415",color:"#ef4444",border:"1px solid #ef444433",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                  🗑 {label} ({count})
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}


function StatementImporter({ wide, isMobile }) {
  const { addTxns, checkTxns, ccTxns, allCats } = useBudget();

  // Steps: "upload" → "parsing" → "review" → "done"
  const [step, setStep]         = useState("upload");
  const [stmtSrc, setStmtSrc]   = useState("checking");
  const [month, setMonth]       = useState(MONTHS[1]); // Feb default
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState(null);
  const [fileType, setFileType] = useState(null); // "pdf" | "csv"
  const [pdfB64, setPdfB64]     = useState(null);
  const [csvText, setCsvText]   = useState(null);
  const [parseError, setParseError] = useState(null);
  const [parsed, setParsed]     = useState([]); // raw from Claude
  const [reviewed, setReviewed] = useState([]); // user-edited
  const [editingIdx, setEditingIdx] = useState(null);

  // ── CSV parser (client-side, no AI needed) ──────────────────────────────────
  const splitCSVLine = (line, delim) => {
    const result = []; let field = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === delim && !inQ) { result.push(field.trim()); field = ""; }
      else { field += line[i]; }
    }
    result.push(field.trim());
    return result.map(f => f.replace(/^"|"$/g, ""));
  };
  const parseCSVDate = raw => {
    if (!raw) return null;
    raw = raw.trim().replace(/^"|"$/g, "");
    let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}$/);
    if (m) return `${m[1].padStart(2,"0")}/${m[2].padStart(2,"0")}`;
    m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) return `${m[2].padStart(2,"0")}/${m[3].padStart(2,"0")}`;
    return null;
  };
  const parseCSVData = text => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const delim = [",", "\t", ";"].reduce((best, d) => {
      const n = (lines[0].match(new RegExp(d === "." ? "\\." : d, "g")) || []).length;
      return n > best.n ? { d, n } : best;
    }, { d: ",", n: 0 }).d;
    const headers = splitCSVLine(lines[0], delim).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
    const hasHeaders = headers.some(h => h.includes("date") || h.includes("desc") || h.includes("amount"));
    const dataStart = hasHeaders ? 1 : 0;
    const idx = {
      date: headers.findIndex(h => h.includes("date") || h.includes("posted") || h === "trans"),
      desc: headers.findIndex(h => ["description","desc","name","merchant","payee","memo","detail","narration"].some(k => h.includes(k))),
      amt:  headers.findIndex(h => h === "amount" || h === "amt"),
      deb:  headers.findIndex(h => h.includes("debit") || h.includes("withdrawal") || h.includes("charge")),
      cred: headers.findIndex(h => h.includes("credit") || h.includes("deposit")),
    };
    const cleanNum = s => parseFloat((s || "").replace(/[$,\s]/g, "").replace(/\((.+)\)/, "-$1"));
    return lines.slice(dataStart).flatMap(line => {
      const cols = splitCSVLine(line, delim);
      if (cols.length < 2) return [];
      const date = parseCSVDate(cols[idx.date >= 0 ? idx.date : 0]);
      if (!date) return [];
      const desc = (cols[idx.desc >= 0 ? idx.desc : 1] || "").trim().slice(0, 60);
      if (!desc) return [];
      let amount;
      if (idx.amt >= 0) { amount = cleanNum(cols[idx.amt]); }
      else if (idx.deb >= 0 || idx.cred >= 0) {
        const deb = idx.deb >= 0 ? cleanNum(cols[idx.deb]) : 0;
        const cred = idx.cred >= 0 ? cleanNum(cols[idx.cred]) : 0;
        amount = (isNaN(deb) ? 0 : deb) - (isNaN(cred) ? 0 : cred);
      } else {
        for (let j = cols.length - 1; j >= 0; j--) {
          const n = cleanNum(cols[j]); if (!isNaN(n)) { amount = n; break; }
        }
      }
      if (amount === undefined || isNaN(amount)) return [];
      return [{ date, desc, amount, cat: "Snacks/Misc", note: "" }];
    });
  };

  // ── Load file (PDF or CSV) ───────────────────────────────────────────────────
  const loadFile = file => {
    if (!file) return;
    setParseError(null);
    if (file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv") {
      setFileName(file.name); setFileType("csv");
      setPdfB64(null);
      const reader = new FileReader();
      reader.onload = e => setCsvText(e.target.result);
      reader.readAsText(file);
    } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      setFileName(file.name); setFileType("pdf");
      setCsvText(null);
      const reader = new FileReader();
      reader.onload = e => setPdfB64(e.target.result.split(",")[1]);
      reader.readAsDataURL(file);
    } else {
      setParseError("Please upload a PDF or CSV file.");
    }
  };

  const onDrop = e => {
    e.preventDefault();
    setDragOver(false);
    loadFile(e.dataTransfer.files[0]);
  };

  // ── Build a local category dictionary from existing transactions ──────────
  const buildLocalDict = () => {
    const dict = {}; // normalized desc → cat
    [...checkTxns, ...ccTxns].forEach(t => {
      if (t.cat && t.cat !== "Transfer" && t.cat !== "Income" && t.desc) {
        const key = t.desc.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().slice(0, 30);
        if (key) dict[key] = t.cat;
      }
    });
    return dict;
  };

  const normalizeDesc = desc =>
    desc.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().slice(0, 30);

  const findLocalCat = (desc, dict) => {
    const norm = normalizeDesc(desc);
    // Exact match
    if (dict[norm]) return dict[norm];
    // Partial match — check if any known key is contained in the desc or vice versa
    for (const [key, cat] of Object.entries(dict)) {
      if (norm.includes(key) || key.includes(norm)) return cat;
    }
    return null;
  };

  // ── Parse statement: local-first, AI only for unknowns ─────────────────────
  // Step 1: AI extracts raw transactions (dates, amounts, descriptions) — one call
  // Step 2: Match descriptions against existing transaction history locally
  // Step 3: Only send unmatched descriptions to AI for categorization — cheaper
  const [matchStats, setMatchStats] = useState(null); // { local, ai, total }

  const parseCSVAndReview = () => {
    if (!csvText) { setParseError("No CSV loaded."); return; }
    setStep("parsing");
    setParseError(null);
    try {
      const dict = buildLocalDict();
      const raw = parseCSVData(csvText);
      if (raw.length === 0) { setParseError("No transactions found. Check the CSV format."); setStep("upload"); return; }
      const withCats = raw.map(t => {
        const localCat = findLocalCat(t.desc, dict);
        return { ...t, cat: localCat || "Snacks/Misc", _localMatch: !!localCat };
      });
      const filtered = stmtSrc === "checking" ? withCats : withCats.filter(t => t.cat !== "Income" && t.cat !== "Transfer");
      const localCount = filtered.filter(t => t._localMatch).length;
      setMatchStats({ local: localCount, ai: 0, total: filtered.length, csv: true });
      setParsed(filtered);
      setReviewed(filtered.map(t => ({ ...t, _include: true })));
      setStep("review");
    } catch (err) {
      setParseError("CSV parse failed: " + err.message);
      setStep("upload");
    }
  };

  const parse = async () => {
    if (fileType === "csv") { parseCSVAndReview(); return; }
    if (!ANTHROPIC_API_KEY) { setParseError("Add your Anthropic API key to the top of App.jsx to enable AI import."); return; }
    if (!pdfB64) { setParseError("No PDF loaded."); return; }
    setStep("parsing");
    setParseError(null);
    try {
      // ── Call 1: Extract raw transactions (no categorization) ───────────────
      const extractPrompt = `Parse ALL transactions from this ${stmtSrc === "checking" ? "checking account" : "credit card"} statement for ${month}.
Return ONLY a JSON array, no markdown. Each object:
- "date": "MM/DD"
- "desc": clean merchant name, max 40 chars (e.g. "Target", "Costco", "McKeever's Market")
- "amount": positive for charges/debits, negative for credits/refunds
- "note": brief note or ""
Do NOT include a "cat" field.`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
            { type: "text", text: extractPrompt },
          ]}]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const rawTxns = JSON.parse((data.content.find(b => b.type === "text")?.text || "").replace(/```json|```/g,"").trim());
      if (!Array.isArray(rawTxns)) throw new Error("Extraction failed");

      // ── Step 2: Local category matching ────────────────────────────────────
      const localDict = buildLocalDict();
      const unmatched = []; // { originalIdx, desc }
      const withCats = rawTxns.map((t, i) => {
        const localCat = findLocalCat(t.desc, localDict);
        if (localCat) return { ...t, cat: localCat, _localMatch: true };
        unmatched.push({ i: String(i), desc: t.desc });
        return { ...t, _localMatch: false };
      });

      // ── Step 3: AI categorizes only unmatched descriptions (small call) ────
      let aiCatMap = {};
      if (unmatched.length > 0) {
        const merchantList = unmatched.map(function(item) { return item.i + ": " + item.desc; }).join("\n");
        const catRules = [
          "grocery stores, supermarkets, Costco, Walmart food -> Groceries",
          "restaurants, fast food, cafes -> Dining Out",
          "mortgage, utilities, electric, gas bill, water, internet, phone, home repair -> Housing",
          "gas stations fuel, auto insurance, car payment -> Transportation",
          "Amazon shopping, retail stores, online shopping non-grocery -> Shopping",
          "Netflix, Hulu, Disney+, Spotify, YouTube, subscriptions -> Subscriptions",
          "doctors, hospitals, pharmacy, therapy, medical -> Medical",
          "ABA therapy, Success on Spectrum -> ABA Therapy",
          "kids activities, school, children stores -> Kids & Family",
          "loan payments, credit card payments -> Debt Service",
          "church, tithe, giving -> Giving & Tithe",
          "gas station snacks, misc small purchases -> Snacks/Misc",
          "paycheck deposits -> Income",
          "transfers between own accounts, CC payments -> Transfer"
        ].join("\n");
        const catPrompt = [
          "Categorize each merchant into exactly one of: " + allCats.join(", "),
          "",
          "Rules:",
          catRules,
          "",
          "Merchants:",
          merchantList,
          "",
          'Return ONLY a JSON object like: {"0":"Groceries","1":"Housing"}'
        ].join("\n");
        const catRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800,
            messages: [{ role: "user", content: catPrompt }]
          })
        });
        const catData = await catRes.json();
        aiCatMap = JSON.parse((catData.content?.find(b=>b.type==="text")?.text||"{}").replace(/```json|```/g,"").trim());
      }

      // ── Merge and finalize ──────────────────────────────────────────────────
      const txns = withCats.map((t, i) => {
        if (t._localMatch) return t;
        return { ...t, cat: aiCatMap[String(i)] || "Snacks/Misc" };
      });

      const filtered = txns.filter(t => stmtSrc === "checking" ? true : t.cat !== "Income" && t.cat !== "Transfer");
      const localCount = filtered.filter(t => t._localMatch).length;
      setMatchStats({ local: localCount, ai: filtered.length - localCount, total: filtered.length });
      setParsed(filtered);
      setReviewed(filtered.map(t => ({ ...t, _include: true })));
      setStep("review");
    } catch (err) {
      setParseError("Parse failed: " + err.message);
      setStep("upload");
    }
  };

  // ── Confirm: push to live state ─────────────────────────────────────────────
  const confirm = () => {
    const toAdd = reviewed
      .filter(t => t._include)
      .map(({ _include, ...t }) => ({ ...t, month }));
    addTxns(stmtSrc, toAdd);
    setStep("done");
  };

  const reset = () => {
    setStep("upload"); setFileName(null); setFileType(null); setPdfB64(null); setCsvText(null);
    setParsed([]); setReviewed([]); setParseError(null); setEditingIdx(null);
  };

  const includedCount = reviewed.filter(t => t._include).length;
  const includedTotal = reviewed.filter(t => t._include && t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t)=>s+t.amount,0);

  // ── RENDER ──────────────────────────────────────────────────────────────────
  const accentImport = "#22d3ee";

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16,maxWidth:900}}>

      {/* Header */}
      <Card glow={accentImport}>
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:6}}>
          <div style={{width:44,height:44,borderRadius:14,background:accentImport+"22",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>📥</div>
          <div>
            <Label style={{marginBottom:2}}>Import Statement</Label>
            <div style={{fontSize:13,color:MUTED}}>Upload a bank or credit card PDF — Claude will parse every transaction and auto-categorize it. Review before confirming.</div>
          </div>
        </div>
      </Card>

      {/* ── STEP: UPLOAD ── */}
      {step === "upload" && (
        <Card>
          {/* Source + Month selectors */}
          <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:12,marginBottom:20}}>
            <div>
              <div style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>Statement Type</div>
              <div style={{display:"flex",gap:8}}>
                {[["checking","🏦 Checking"],["cc","💳 Credit Card"]].map(([v,l])=>(
                  <button key={v} onClick={()=>setStmtSrc(v)} style={{
                    flex:1,padding:"10px 14px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",
                    background:stmtSrc===v?accentImport+"22":BG,
                    color:stmtSrc===v?accentImport:MUTED,
                    border:`1px solid ${stmtSrc===v?accentImport:BORDER}`,transition:"all .15s"
                  }}>{l}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>Month</div>
              <select value={month} onChange={e=>setMonth(e.target.value)}
                style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 14px",color:TEXT,fontSize:13,outline:"none"}}>
                {MONTHS.map(m=><option key={m} value={m}>{m} 2026</option>)}
              </select>
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={onDrop}
            onClick={()=>document.getElementById("pdf-input").click()}
            style={{
              border:`2px dashed ${dragOver?accentImport:fileName?accentImport+"66":BORDER}`,
              borderRadius:16,padding:"40px 24px",textAlign:"center",cursor:"pointer",
              background:dragOver?accentImport+"09":fileName?accentImport+"05":BG,
              transition:"all .2s",
            }}>
            <input id="pdf-input" type="file" accept=".pdf,.csv" style={{display:"none"}}
              onChange={e=>loadFile(e.target.files[0])}/>
            <div style={{fontSize:40,marginBottom:12}}>{fileName?"✅":fileType==="csv"?"📊":"📄"}</div>
            {fileName
              ? <><div style={{fontSize:15,fontWeight:700,color:accentImport,marginBottom:4}}>{fileName}</div>
                  <div style={{fontSize:12,color:MUTED}}>{fileType==="csv"?"CSV ready — no AI needed":"Ready to parse · click to change"} · click to change</div></>
              : <><div style={{fontSize:15,fontWeight:600,color:TEXT,marginBottom:6}}>Drop your bank statement here</div>
                  <div style={{fontSize:12,color:MUTED}}>or click to browse · PDF or CSV</div>
                  <div style={{fontSize:11,color:DIM,marginTop:8}}>PDF: AI-powered extraction · CSV: instant client-side parse (no AI needed)</div></>
            }
          </div>

          {parseError && (
            <div style={{marginTop:12,padding:"10px 14px",borderRadius:10,background:"#ef444411",border:"1px solid #ef444433",fontSize:13,color:"#ef4444"}}>
              ⚠️ {parseError}
            </div>
          )}

          <button
            onClick={parse}
            disabled={!pdfB64 && !csvText}
            style={{
              marginTop:16,width:"100%",padding:"13px",borderRadius:12,fontSize:15,fontWeight:800,
              background:(pdfB64||csvText)?`linear-gradient(135deg,${accentImport},#818cf8)`:"#1e2535",
              color:(pdfB64||csvText)?BG:DIM,cursor:(pdfB64||csvText)?"pointer":"not-allowed",
              border:"none",transition:"all .2s",letterSpacing:".2px",
            }}>
            {csvText
              ? `📊 Import ${month} CSV (no AI needed)`
              : pdfB64
                ? `✨ Parse ${month} ${stmtSrc === "checking" ? "Checking" : "Credit Card"} Statement`
                : "Upload a PDF or CSV first"
            }
          </button>
        </Card>
      )}

      {/* ── STEP: PARSING ── */}
      {step === "parsing" && (
        <Card>
          <div style={{textAlign:"center",padding:"40px 0"}}>
            <div style={{fontSize:48,marginBottom:20,animation:"spin 2s linear infinite",display:"inline-block"}}>⚙️</div>
            <div style={{fontSize:18,fontWeight:700,color:TEXT,marginBottom:8}}>Parsing your statement…</div>
            <div style={{fontSize:13,color:MUTED,marginBottom:24}}>Claude is reading every transaction and categorizing it.</div>
            <div style={{display:"flex",justifyContent:"center",gap:6}}>
              {["Reading PDF","Extracting transactions","Auto-categorizing","Building review"].map((s,i)=>(
                <div key={i} style={{fontSize:11,color:accentImport,background:accentImport+"15",padding:"4px 10px",borderRadius:99,border:`1px solid ${accentImport}33`}}>{s}</div>
              ))}
            </div>
          </div>
          <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
        </Card>
      )}

      {/* ── STEP: REVIEW ── */}
      {step === "review" && (
        <>
          {/* Summary bar */}
          <Card>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontSize:16,fontWeight:800,color:TEXT}}>Review {parsed.length} transactions</div>
                <div style={{fontSize:12,color:MUTED,marginTop:2}}>
                  {stmtSrc==="checking"?"🏦 Checking":"💳 Credit Card"} · {month} 2026 · Uncheck any you want to exclude
                </div>
                {matchStats && (
                  <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap"}}>
                    {matchStats.csv
                      ? <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:"#06b6d422",color:"#06b6d4",border:"1px solid #06b6d444",fontWeight:700}}>
                          📊 CSV parsed client-side · no AI used
                        </span>
                      : <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:"#22c55e22",color:"#22c55e",border:"1px solid #22c55e44",fontWeight:700}}>
                          ✓ {matchStats.local} matched locally (free)
                        </span>
                    }
                    {matchStats.ai > 0 && (
                      <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:"#818cf822",color:"#818cf8",border:"1px solid #818cf844",fontWeight:700}}>
                        ✨ {matchStats.ai} categorized by AI
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:11,color:MUTED}}>Including</div>
                  <div style={{fontSize:18,fontWeight:900,color:accentImport,fontVariantNumeric:"tabular-nums"}}>{includedCount} txns · {fmt(includedTotal)}</div>
                </div>
                <button onClick={confirm} style={{
                  padding:"10px 20px",borderRadius:10,fontSize:14,fontWeight:800,cursor:"pointer",
                  background:`linear-gradient(135deg,${accentImport},#818cf8)`,color:BG,border:"none",
                }}>✓ Add to Dashboard</button>
                <button onClick={reset} style={{padding:"10px 14px",borderRadius:10,fontSize:13,fontWeight:600,cursor:"pointer",background:BG,color:MUTED,border:`1px solid ${BORDER}`}}>Start over</button>
              </div>
            </div>
          </Card>

          {/* Transaction review table */}
          <Card style={{padding:0,overflow:"hidden"}}>
            {/* Header */}
            <div style={{display:"grid",gridTemplateColumns:"36px 60px 1fr 90px 130px",padding:"9px 16px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
              {["✓","Date","Description","Amount","Category"].map((h,i)=>(
                <div key={i} style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px",textAlign:i>=3?"right":"left"}}>{h}</div>
              ))}
            </div>

            {reviewed.map((t, idx) => {
              const color = CAT_COLORS[t.cat] || MUTED;
              const isTransfer = t.cat==="Transfer"||t.cat==="Income";
              return (
                <div key={idx} style={{
                  display:"grid",gridTemplateColumns:"36px 60px 1fr 90px 130px",
                  padding:"9px 16px",borderBottom:`1px solid ${BORDER}`,
                  background:!t._include?"#33415511":isTransfer?"#33415508":idx%2===0?SURFACE:BG,
                  opacity:t._include?1:0.45,alignItems:"center",transition:"all .15s",
                }}>
                  {/* Checkbox */}
                  <input type="checkbox" checked={t._include} onChange={e=>{
                    setReviewed(prev=>prev.map((r,i)=>i===idx?{...r,_include:e.target.checked}:r));
                  }} style={{width:16,height:16,cursor:"pointer",accentColor:accentImport}}/>

                  {/* Date */}
                  <div style={{fontSize:12,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{t.date}</div>

                  {/* Description + note */}
                  <div style={{paddingRight:8}}>
                    {editingIdx===idx
                      ? <input
                          autoFocus
                          value={t.desc}
                          onChange={e=>setReviewed(prev=>prev.map((r,i)=>i===idx?{...r,desc:e.target.value}:r))}
                          onBlur={()=>setEditingIdx(null)}
                          style={{width:"100%",background:BG,border:`1px solid ${accentImport}`,borderRadius:6,padding:"3px 8px",color:TEXT,fontSize:13,outline:"none"}}
                        />
                      : <div onClick={()=>setEditingIdx(idx)} style={{fontSize:13,color:isTransfer?MUTED:TEXT,cursor:"text",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}} title="Click to edit">
                          {t.desc}
                          {t._localMatch && <span style={{marginLeft:5,fontSize:9,fontWeight:700,background:"#22c55e22",color:"#22c55e",border:"1px solid #22c55e33",borderRadius:4,padding:"1px 4px"}}>✓ known</span>}
                        </div>
                    }
                    {t.note&&<div style={{fontSize:10,color:DIM,marginTop:1}}>{t.note}</div>}
                  </div>

                  {/* Amount */}
                  <div style={{textAlign:"right",fontSize:13,fontWeight:700,fontVariantNumeric:"tabular-nums",
                    color:t.amount<0?"#22c55e":isTransfer?MUTED:TEXT}}>
                    {t.amount<0?"+":""}{fmt(t.amount)}
                  </div>

                  {/* Category select */}
                  <div style={{textAlign:"right"}}>
                    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}}>
                      <select
                        className="cat-pick"
                        value={t.cat}
                        onChange={e=>setReviewed(prev=>prev.map((r,i)=>i===idx?{...r,cat:e.target.value}:r))}
                        style={{background:color+"22",border:`1px solid ${color}55`,color,paddingRight:22}}
                      >
                        {allCats.map(c=><option key={c} value={c}>{c}</option>)}
                      </select>
                      <span style={{position:"absolute",right:6,pointerEvents:"none",fontSize:9,color,opacity:.7}}>▾</span>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Review footer */}
            <div style={{padding:"12px 16px",background:BG,borderTop:`2px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:12,color:MUTED}}>{includedCount} of {reviewed.length} transactions selected</div>
              <div style={{fontSize:14,fontWeight:900,color:accentImport,fontVariantNumeric:"tabular-nums"}}>{fmt(includedTotal)}</div>
            </div>
          </Card>

          <button onClick={confirm} style={{
            width:"100%",padding:"14px",borderRadius:12,fontSize:15,fontWeight:800,
            background:`linear-gradient(135deg,${accentImport},#818cf8)`,color:BG,
            border:"none",cursor:"pointer",letterSpacing:".2px",
          }}>✓ Add {includedCount} transactions to Dashboard</button>
        </>
      )}

      {/* ── STEP: DONE ── */}
      {step === "done" && (
        <Card>
          <div style={{textAlign:"center",padding:"40px 0"}}>
            <div style={{fontSize:56,marginBottom:16}}>🎉</div>
            <div style={{fontSize:20,fontWeight:800,color:TEXT,marginBottom:8}}>{month} imported!</div>
            <div style={{fontSize:13,color:MUTED,marginBottom:28}}>
              {includedCount} transactions added to Checking and Credit Card tabs.<br/>
              The Summary, Sankey, and Category Breakdown have all updated.
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
              <button onClick={reset} style={{
                padding:"11px 22px",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",
                background:accentImport+"22",color:accentImport,border:`1px solid ${accentImport}44`,
              }}>Import Another Statement</button>
              <button onClick={reset} style={{
                padding:"11px 22px",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",
                background:BG,color:MUTED,border:`1px solid ${BORDER}`,
              }}>Done</button>
            </div>
          </div>
        </Card>
      )}

    </div>
  );
}


const NAV = [
  { id:"summary",   label:"Summary",    emoji:"📋" },
  { id:"recs",      label:"Tips",       emoji:"💡" },
  { id:"tithe",     label:"Tithe",      emoji:"⛪" },
  { id:"scenarios", label:"Scenarios",  emoji:"📈" },
  { id:"aba",       label:"ABA",        emoji:"🧩" },
  { id:"payoffs",   label:"Payoffs",    emoji:"💳" },
  { id:"categories", label:"Categories", emoji:"📂" },
  { id:"trends",    label:"Trends",     emoji:"📊" },
  { id:"import",    label:"Import",     emoji:"📥" },
  { id:"checking",  label:"Checking",   emoji:"🏦" },
  { id:"cc",        label:"Credit Card",emoji:"💰" },
  { id:"settings",  label:"Settings",   emoji:"⚙️" },
];

// ── APP ───────────────────────────────────────────────────────────────────────
export default function BudgetDashboardClean() {
  const [page, setPage] = useState("summary");
  const width    = useWindowWidth();
  const isMobile = width < 768;
  const wide     = width >= 1000;
  const props    = { wide, isMobile };

  // ── Live transaction state — persisted to localStorage ────────────────────
  const [checkTxns, setCheckTxns] = useState(() => {
    return ls.getJSON("budget_checkTxns", []);
  });
  const [ccTxns, setCCTxns] = useState(() => {
    return ls.getJSON("budget_ccTxns", []);
  });

  const [selectedMonth, setSelectedMonth] = useState("January");

  // Settings state — all persisted
  const [takeHome, setTakeHome] = useState(() => {
    const s = ls.get("budget_takeHome");
    return s ? parseFloat(s) : DEFAULT_TAKE_HOME;
  });
  const [oneTimes, setOneTimes] = useState(() => {
    return ls.getJSON("budget_oneTimes", []);
  });
  const [budgetKc, setBudgetKc] = useState(() => {
    return ls.getJSON("budget_kc", {});
  });
  const [t2CarryIn, setT2CarryIn] = useState(() => {
    const s = ls.get("budget_t2carry"); return s ? parseFloat(s) : 0;
  });
  const [groceryGoal, setGroceryGoal] = useState(() => {
    const s = ls.get("budget_groceryGoal"); return s ? parseFloat(s) : 1200;
  });

  // Persist all state to localStorage
  useEffect(() => { ls.setJSON("budget_checkTxns", checkTxns); }, [checkTxns]);
  useEffect(() => { ls.setJSON("budget_ccTxns", ccTxns); }, [ccTxns]);
  useEffect(() => { ls.set("budget_takeHome", String(takeHome)); }, [takeHome]);
  useEffect(() => { ls.setJSON("budget_oneTimes", oneTimes); }, [oneTimes]);
  useEffect(() => { ls.setJSON("budget_kc", budgetKc); }, [budgetKc]);
  useEffect(() => { ls.set("budget_t2carry", String(t2CarryIn)); }, [t2CarryIn]);
  useEffect(() => { ls.set("budget_groceryGoal", String(groceryGoal)); }, [groceryGoal]);

  // All months that have transaction data
  const availableMonths = useMemo(() => {
    const all = [...checkTxns, ...ccTxns].map(t => t.month).filter(Boolean);
    const unique = [...new Set(all)];
    const order = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return order.filter(m => unique.includes(m));
  }, [checkTxns, ccTxns]);

  const [payoffs, setPayoffs] = useState(() => {
    return ls.getJSON("budget_payoffs", PAYOFFS_INIT);
  });
  const [waterfallDisabled, setWaterfallDisabled] = useState(() => ls.getJSON("budget_wfDisabled", []));
  useEffect(() => { ls.setJSON("budget_wfDisabled", waterfallDisabled); }, [waterfallDisabled]);
  useEffect(() => { ls.setJSON("budget_payoffs", payoffs); }, [payoffs]);

  const [dashName, setDashName] = useState(() => ls.get("budget_dashName") || "My Budget");
  const [showTithe, setShowTithe] = useState(() => ls.get("budget_showTithe") !== "0");
  const [showABA, setShowABA]   = useState(() => ls.get("budget_showABA")   !== "0");
  const [customCats, setCustomCats] = useState(() => ls.getJSON("budget_customCats", []));
  useEffect(() => { ls.setJSON("budget_customCats", customCats); }, [customCats]);
  const allCats = useMemo(() => [...VALID_CATS, ...customCats], [customCats]);
  useEffect(() => { ls.set("budget_dashName",  dashName); }, [dashName]);
  useEffect(() => { ls.set("budget_showTithe", showTithe ? "1" : "0"); }, [showTithe]);
  useEffect(() => { ls.set("budget_showABA",   showABA   ? "1" : "0"); }, [showABA]);

  // Redirect away from tabs that have been toggled off
  useEffect(() => {
    if (!showTithe && page === "tithe") setPage("summary");
    if (!showABA   && page === "aba")   setPage("summary");
  }, [showTithe, showABA, page]);

  const updateTxnCat = useCallback((src, id, newCat) => {
    if (src === "checking") setCheckTxns(prev => prev.map(t => t.id === id ? { ...t, cat: newCat } : t));
    else                    setCCTxns(prev => prev.map(t => t.id === id ? { ...t, cat: newCat } : t));
  }, []);

  const deleteTxn = useCallback((src, id) => {
    if (src === "checking") setCheckTxns(prev => prev.filter(t => t.id !== id));
    else                    setCCTxns(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearTxns = useCallback((src) => {
    if (src === "all")      { setCheckTxns([]); setCCTxns([]); }
    else if (src === "checking") setCheckTxns([]);
    else                    setCCTxns([]);
  }, []);

  const replaceTxn = useCallback((src, id, splitTxns) => {
    // Removes the original transaction and inserts split children in its place
    if (src === "checking") {
      setCheckTxns(prev => {
        const idx = prev.findIndex(t => t.id === id);
        if (idx < 0) return prev;
        const base = prev[idx];
        const splits = splitTxns.map((t, i) => ({ ...base, ...t, id: `c${Date.now()}${i}`, note: (t.note||"")+" [split]" }));
        return [...prev.slice(0, idx), ...splits, ...prev.slice(idx + 1)];
      });
    } else {
      setCCTxns(prev => {
        const idx = prev.findIndex(t => t.id === id);
        if (idx < 0) return prev;
        const base = prev[idx];
        const splits = splitTxns.map((t, i) => ({ ...base, ...t, id: `cc${Date.now()}${i}`, note: (t.note||"")+" [split]" }));
        return [...prev.slice(0, idx), ...splits, ...prev.slice(idx + 1)];
      });
    }
  }, []);

  const addTxns = useCallback((src, newTxns) => {
    if (src === "checking") {
      setCheckTxns(prev => {
        const nextIdx = prev.length;
        return [...prev, ...newTxns.map((t, i) => ({ ...t, id: `c${nextIdx + i}` }))];
      });
    } else {
      setCCTxns(prev => {
        const nextIdx = prev.length;
        return [...prev, ...newTxns.map((t, i) => ({ ...t, id: `cc${nextIdx + i}` }))];
      });
    }
  }, []);

  // ── Derived summary rows — norm auto-computed from actual − one-times ──────
  const summaryRows = useMemo(() => SUMMARY_ROWS
    .filter(base => {
      if (base.cat === "Giving & Tithe" && !showTithe) return false;
      if (base.cat === "ABA Therapy"    && !showABA)   return false;
      return true;
    })
    .map(base => {
      const checking = checkTxns
        .filter(t => t.month === selectedMonth && t.cat === base.cat && t.cat !== "Transfer" && t.cat !== "Income")
        .reduce((s, t) => s + t.amount, 0);
      const cc = ccTxns
        .filter(t => t.month === selectedMonth && t.cat === base.cat)
        .reduce((s, t) => s + t.amount, 0);
      const oneTimeAmt = oneTimes.filter(o => o.cat === base.cat).reduce((s, o) => s + o.amount, 0);
      const norm = checking + cc - oneTimeAmt;
      const kc = budgetKc[base.cat] !== undefined ? budgetKc[base.cat] : base.kc;
      return { ...base, checking, cc, norm, kc };
    }), [checkTxns, ccTxns, selectedMonth, oneTimes, budgetKc, showTithe, showABA]);

  const janActual   = summaryRows.reduce((s, r) => s + r.checking + r.cc, 0);
  const normTotal   = summaryRows.reduce((s, r) => s + r.norm, 0);
  const normSurplus = takeHome - normTotal;

  const budget = {
    summaryRows, checkTxns, ccTxns, janActual, normTotal, normSurplus,
    updateTxnCat, deleteTxn, clearTxns, addTxns, replaceTxn,
    selectedMonth, setSelectedMonth, availableMonths,
    payoffs, setPayoffs,
    waterfallDisabled, setWaterfallDisabled,
    takeHome, setTakeHome,
    oneTimes, setOneTimes,
    budgetKc, setBudgetKc,
    t2CarryIn, setT2CarryIn,
    groceryGoal, setGroceryGoal,
    dashName, setDashName,
    showTithe, setShowTithe,
    showABA,   setShowABA,
    customCats, setCustomCats, allCats,
  };

  const pages = {
    summary:   <Summary        {...props}/>,
    recs:      <Recommendations {...props}/>,
    tithe:     <TitheTracker   {...props}/>,
    scenarios: <Scenarios      {...props}/>,
    aba:       <ABAPlanner     {...props}/>,
    payoffs:   <Payoffs        {...props}/>,
    categories: <Categories    {...props}/>,
    trends:    <Trends          {...props}/>,
    import:    <StatementImporter {...props}/>,
    checking:  <TxnTable src="checking" isMobile={isMobile}/>,
    cc:        <TxnTable src="cc"       isMobile={isMobile}/>,
    settings:  <Settings isMobile={isMobile}/>,
  };

  const visibleNav = NAV.filter(n => {
    if (n.id === "tithe" && !showTithe) return false;
    if (n.id === "aba"   && !showABA)   return false;
    return true;
  });
  const auditStart    = visibleNav.findIndex(n => n.id === "checking");
  const dashboardNav  = visibleNav.slice(0, auditStart);
  const auditNav      = visibleNav.slice(auditStart);
  const mobileRow1Len = Math.ceil(visibleNav.length / 2);
  const mobileRow1    = visibleNav.slice(0, mobileRow1Len);
  const mobileRow2    = visibleNav.slice(mobileRow1Len);

  const gapBadge = (
    <div style={{background:"#ef444422",border:"1px solid #ef444444",borderRadius:12,padding:"8px 14px",textAlign:"center",flexShrink:0}}>
      <div style={{fontSize:10,color:"#ef4444",fontWeight:700,textTransform:"uppercase",letterSpacing:".5px"}}>Gap</div>
      <div style={{fontSize:20,fontWeight:900,color:"#ef4444",fontVariantNumeric:"tabular-nums"}}>−{fmt(Math.abs(normSurplus))}</div>
    </div>
  );

  return (
    <BudgetCtx.Provider value={budget}>
    <div style={{background:BG,minHeight:"100vh",fontFamily:"'DM Sans',system-ui,sans-serif",color:TEXT,width:"100%",display:"flex",flexDirection:"column"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700;9..40,900&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        html,body,#root{width:100%;max-width:100% !important;margin:0 !important;padding:0 !important;overflow-x:hidden;}
        ::-webkit-scrollbar{width:5px;}::-webkit-scrollbar-thumb{background:#1e2535;border-radius:99px;}
        button{font-family:inherit;border:none;cursor:pointer;}
        input::placeholder{color:#475569;}option{background:#161b27;}
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;background:#1e2535;border-radius:99px;outline:none;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--thumb,#a78bfa);cursor:pointer;}
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        select.cat-pick{border-radius:99px;font-weight:700;font-size:11px;padding:3px 10px 3px 8px;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none;font-family:inherit;}
      `}</style>

      {isMobile ? (
        <>
          <div style={{position:"sticky",top:0,zIndex:100,background:BG+"f0",backdropFilter:"blur(20px)",borderBottom:`1px solid ${BORDER}`,paddingTop:10,paddingBottom:6}}>
            {/* Row 1: title + compact gap */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingLeft:14,paddingRight:14,marginBottom:8}}>
              <div>
                <div style={{fontSize:17,fontWeight:900,color:ACCENT,lineHeight:1}}>{dashName}</div>
                <div style={{fontSize:11,color:MUTED,marginTop:2}}>{selectedMonth} 2026 · {visibleNav.find(n=>n.id===page)?.label}</div>
              </div>
              {/* Compact gap badge */}
              <div style={{background:"#ef444422",border:"1px solid #ef444444",borderRadius:10,padding:"5px 10px",textAlign:"center",flexShrink:0}}>
                <div style={{fontSize:9,color:"#ef4444",fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",lineHeight:1}}>GAP</div>
                <div style={{fontSize:16,fontWeight:900,color:"#ef4444",fontVariantNumeric:"tabular-nums",lineHeight:1.2}}>−{fmt(Math.abs(normSurplus))}</div>
              </div>
            </div>
            {/* Row 2: month picker */}
            <div style={{display:"flex",gap:5,overflowX:"auto",paddingLeft:14,paddingRight:14,paddingBottom:4}}>
              <div style={{fontSize:9,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",flexShrink:0,alignSelf:"center",marginRight:2}}>Month</div>
              {availableMonths.map(m=>(
                <button key={m} onClick={()=>setSelectedMonth(m)} style={{
                  padding:"4px 10px",borderRadius:7,fontSize:11,fontWeight:700,flexShrink:0,
                  background:selectedMonth===m?ACCENT+"22":SURFACE,
                  color:selectedMonth===m?ACCENT:MUTED,
                  border:`1px solid ${selectedMonth===m?ACCENT:BORDER}`,cursor:"pointer",
                }}>{m.slice(0,3)}</button>
              ))}
            </div>
          </div>
          <div style={{padding:"16px 14px 120px",flex:1}}>{pages[page]}</div>
          <div style={{position:"fixed",bottom:0,left:0,right:0,background:SURFACE+"f8",backdropFilter:"blur(24px)",borderTop:`1px solid ${BORDER}`,zIndex:100,paddingBottom:"max(env(safe-area-inset-bottom,0px),8px)"}}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobileRow1.length},1fr)`, borderBottom: `1px solid ${BORDER}` }}>
            {mobileRow1.map(n => { const a = page===n.id; return (
              <button key={n.id} onClick={() => setPage(n.id)} style={{ padding:"9px 4px 7px", background:"transparent", display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <span style={{ fontSize:16, opacity:a?1:.35 }}>{n.emoji}</span>
                <span style={{ fontSize:8, fontWeight:a?800:500, color:a?ACCENT:MUTED }}>{n.label}</span>
                {a && <div style={{ width:16, height:2, background:ACCENT, borderRadius:99 }}/>}
              </button>
            ); })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobileRow2.length},1fr)` }}>
            {mobileRow2.map(n => { const a = page===n.id; return (
              <button key={n.id} onClick={() => setPage(n.id)} style={{ padding:"9px 4px 7px", background:"transparent", display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <span style={{ fontSize:20, opacity:a?1:.35 }}>{n.emoji}</span>
                <span style={{ fontSize:9, fontWeight:a?800:500, color:a?ACCENT:MUTED, textAlign:"center", lineHeight:1.2 }}>{n.label}</span>
                {a && <div style={{ width:16, height:2, background:ACCENT, borderRadius:99 }}/>}
              </button>
            ); })}
          </div>
          </div>
        </>
      ) : (
        <div style={{display:"flex",width:"100%",minHeight:"100vh"}}>
          <div style={{width:240,background:"#0f141e",borderRight:`1px solid ${BORDER}`,display:"flex",flexDirection:"column",position:"sticky",top:0,height:"100vh",overflowY:"auto",flexShrink:0}}>
            <div style={{padding:"24px 20px 16px",borderBottom:`1px solid ${BORDER}`}}>
              <div style={{fontSize:20,fontWeight:900,color:ACCENT}}>{dashName}</div>
              <div style={{fontSize:12,color:MUTED,marginTop:3,marginBottom:12}}>2026</div>
              {/* Month picker in sidebar */}
              <div style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Viewing Month</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                {availableMonths.map(m=>(
                  <button key={m} onClick={()=>setSelectedMonth(m)} style={{
                    padding:"3px 8px",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",
                    background:selectedMonth===m?ACCENT+"22":BG,
                    color:selectedMonth===m?ACCENT:MUTED,
                    border:`1px solid ${selectedMonth===m?ACCENT:BORDER}`,transition:"all .12s",
                  }}>{m.slice(0,3)}</button>
                ))}
              </div>
            </div>
            <nav style={{flex:1,padding:"12px 0"}}>
              <div style={{padding:"16px 20px 6px",fontSize:10,fontWeight:700,color:DIM,textTransform:"uppercase",letterSpacing:".6px"}}>Dashboard</div>
              {dashboardNav.map(n=>{const a=page===n.id;return(
                <button key={n.id} onClick={()=>setPage(n.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 20px",background:a?ACCENT+"12":"transparent",borderLeft:`3px solid ${a?ACCENT:"transparent"}`,color:a?ACCENT:MUTED,fontSize:14,fontWeight:a?700:400,transition:"all .15s",textAlign:"left"}}>
                  <span style={{fontSize:17}}>{n.emoji}</span>{n.label}
                </button>
              );})}
              <div style={{padding:"16px 20px 6px",fontSize:10,fontWeight:700,color:DIM,textTransform:"uppercase",letterSpacing:".6px"}}>Audit / Transactions</div>
              {auditNav.map(n=>{const a=page===n.id;return(
                <button key={n.id} onClick={()=>setPage(n.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 20px",background:a?ACCENT+"12":"transparent",borderLeft:`3px solid ${a?ACCENT:"transparent"}`,color:a?ACCENT:MUTED,fontSize:14,fontWeight:a?700:400,transition:"all .15s",textAlign:"left"}}>
                  <span style={{fontSize:17}}>{n.emoji}</span>{n.label}
                </button>
              );})}
            </nav>
            <div style={{padding:"16px 20px",borderTop:`1px solid ${BORDER}`}}>
              <div style={{fontSize:11,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>Quick Stats · {selectedMonth}</div>
              {[["Take-home",fmt(takeHome),ACCENT],["Spending",fmt(janActual),"#ef4444"],["Gap",fmt(Math.abs(normSurplus)),"#ef4444"]].map(([k,v,c])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:12,color:MUTED}}>{k}</span>
                  <span style={{fontSize:12,fontWeight:800,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",overflowY:"auto"}}>
            <div style={{borderBottom:`1px solid ${BORDER}`,padding:"16px 32px",display:"flex",alignItems:"center",justifyContent:"space-between",background:BG+"cc",backdropFilter:"blur(12px)",position:"sticky",top:0,zIndex:10}}>
              <div>
                <div style={{fontSize:22,fontWeight:800,color:TEXT}}>{visibleNav.find(n=>n.id===page)?.label}</div>
                <div style={{fontSize:12,color:MUTED,marginTop:2}}>{selectedMonth} 2026 · {dashName}</div>
              </div>
              {gapBadge}
            </div>
            <div style={{padding:"28px 32px"}}>{pages[page]}</div>
          </div>
        </div>
      )}
    </div>
    </BudgetCtx.Provider>
  );
}
