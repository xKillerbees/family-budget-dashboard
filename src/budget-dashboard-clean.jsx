import { useState, useEffect, useMemo, useCallback, createContext, useContext, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, ReferenceLine, LineChart, Line, AreaChart, Area, CartesianGrid, Legend, LabelList } from "recharts";

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
  { cat:"Giving & Tithe",  checking:0, cc:0, norm:0, kc:600,  icon:"🙏", color:"#7c6af7", oneTime:0, notes:"" },
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
  { label:"Remove One-Times", spend:JAN_ACTUAL - ONE_TIME_TOTAL,                            note:"Excludes irregular expenses" },
  { label:"Normalize",        spend:NORM_TOTAL,                                              note:"Recurring baseline only" },
  { label:"+ Reduce Variable",spend:NORM_TOTAL - 0,                            note:"Reduce variable spending — biggest lever" },
  { label:"+ Car Loan",       spend:NORM_TOTAL - 460,                             note:"Jul 2026 · −$460/mo" },
  { label:"+ Credit Card",    spend:NORM_TOTAL - 460 - 151.22,                    note:"Jan 2027 · −$151/mo" },
  { label:"+ Auto Loan ✅",    spend:NORM_TOTAL - 460 - 151.22 - 507.03,          note:"Mar 2029 · first SURPLUS" },
  { label:"+ Student Loan",   spend:NORM_TOTAL - 460 - 151.22 - 507.03 - 201.09, note:"Long-term · max surplus" },
];

// ABA: $35/visit, $7,000 individual OOP cap, resets every Jan 1
// Visits/mo = daysPerWeek × (52/12)
function buildABASchedule(daysPerWeek, settings) {
  const COST_PER_VISIT = settings?.costPerVisit ?? 35;
  const OOP_CAP = settings?.oopCap ?? 7000;
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
  { id:"p1", name:"Car Loan",     payment:460.00,  balance:2280,   origBalance:2280,   manualBalance:0, icon:"🚗", balanceStr:"$2,280",  date:"Jul 2026",  months:"5 left",  pct:95, color:"#22c55e", keywords:"" },
  { id:"p2", name:"Credit Card",  payment:151.22,  balance:1586,   origBalance:1586,   manualBalance:0, icon:"💳", balanceStr:"$1,586",  date:"Jan 2027",  months:"11 left", pct:65, color:"#a78bfa", keywords:"" },
  { id:"p3", name:"Auto Loan",    payment:507.03,  balance:17670,  origBalance:17670,  manualBalance:0, icon:"🚙", balanceStr:"$17,670", date:"Mar 2029",  months:"37 left", pct:30, color:"#64748b", keywords:"" },
  { id:"p4", name:"Student Loan", payment:201.09,  balance:25000,  origBalance:25000,  manualBalance:0, icon:"🎓", balanceStr:"$25,000", date:"Long-term", months:"TBD",     pct:5,  color:"#475569", keywords:"" },
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


const fmt  = (n, d=2) => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:d,maximumFractionDigits:d}).format(Math.abs(n));
const BG="#0d1117",SURFACE="#161b27",BORDER="#1e2535",MUTED="#475569",DIM="#334155",TEXT="#e2e8f0",ACCENT="#a78bfa";

function useWindowWidth() {
  const [w,setW] = useState(typeof window!=="undefined"?window.innerWidth:900);
  useEffect(()=>{ const fn=()=>setW(window.innerWidth); window.addEventListener("resize",fn); return()=>window.removeEventListener("resize",fn); },[]);
  return w;
}

function confirmDeleteAction(message) {
  if (typeof window === "undefined") return true;
  return window.confirm(message || "Delete this item? This cannot be undone.");
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
function parseMoneyValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const cleaned = String(value ?? "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[$,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  if (!cleaned) return NaN;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}
function stripCodeFences(text) {
  return String(text || "").replace(/```json|```/gi, "").trim();
}
function extractAnthropicText(data) {
  return (Array.isArray(data?.content) ? data.content : [])
    .map(block => block?.type === "text" ? block.text || "" : "")
    .join("\n")
    .trim();
}
function getStoredAnthropicKey() {
  try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; }
}
function normalizeTxnSubcategory(value) {
  return String(value || "").trim();
}
function normalizeSubcategoryOptions(options = []) {
  const list = Array.isArray(options) ? options : [options];
  const seen = new Set();
  return list
    .map(normalizeTxnSubcategory)
    .filter(Boolean)
    .filter(option => {
      const key = option.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function normalizeSubcategoriesByCat(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .map(([cat, options]) => [String(cat || "").trim(), normalizeSubcategoryOptions(options)])
      .filter(([cat, options]) => cat && options.length),
  );
}
function collectTxnSubcategoriesByCat(txns = []) {
  const grouped = {};
  txns.forEach(txn => {
    const cat = String(txn?.cat || "").trim();
    const subcat = normalizeTxnSubcategory(txn?.subcat);
    if (!cat || !subcat) return;
    grouped[cat] = [...(grouped[cat] || []), subcat];
  });
  return normalizeSubcategoriesByCat(grouped);
}
function getConfiguredSubcategoryOptions(subcatsByCat = {}, cat = "") {
  return normalizeSubcategoryOptions(subcatsByCat?.[cat] || []);
}
function getCategorySubcategoryOptions(subcatsByCat = {}, cat = "", currentValue = "") {
  const options = getConfiguredSubcategoryOptions(subcatsByCat, cat);
  const current = normalizeTxnSubcategory(currentValue);
  if (!current) return options;
  return options.some(option => option.toLowerCase() === current.toLowerCase()) ? options : [current, ...options];
}
function coerceTxnSubcategoryForCategory(subcatsByCat = {}, cat = "", value = "", { allowLegacy = false } = {}) {
  const current = normalizeTxnSubcategory(value);
  if (!current) return "";
  const options = getConfiguredSubcategoryOptions(subcatsByCat, cat);
  const match = options.find(option => option.toLowerCase() === current.toLowerCase());
  if (match) return match;
  return allowLegacy ? current : "";
}
function getReceiptBudgetCats(allCats = []) {
  const spendCats = allCats.filter(cat => cat !== "Income" && cat !== "Transfer");
  return spendCats.length ? spendCats : allCats;
}
function inferDataUrlMediaType(dataUrl, fallback = "image/jpeg") {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,/i);
  return match?.[1] || fallback;
}
function readFirstReceiptField(payload = {}, keys = []) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}
function parsePositiveReceiptMoney(payload = {}, keys = []) {
  const value = parseMoneyValue(readFirstReceiptField(payload, keys));
  return Number.isFinite(value) && Math.abs(value) > 0 ? Math.abs(value) : NaN;
}
function normalizeReceiptTotalLabel(value) {
  return String(value || "").trim();
}
function isReceiptCreditLikeLabel(label = "") {
  return /\b(reward|rewards|cash\s*back|rebate|coupon|discount|saving|savings|credit|points?)\b/i.test(String(label || ""));
}
function parseFlexibleDateParts(raw, fallbackYear = null) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^\d{4}$/.test(text)) {
    return { year: Number(text), month: null, day: null };
  }
  const monthYearMatch = text.match(/^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}$/i);
  if (monthYearMatch) {
    return { year: Number(text.match(/\d{4}$/)?.[0]), month: null, day: null };
  }
  let match = text.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) {
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }
  match = text.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2}|\d{4}))?$/);
  if (match) {
    const rawYear = match[3];
    const year = rawYear
      ? (rawYear.length === 4 ? Number(rawYear) : (Number(rawYear) >= 70 ? 1900 + Number(rawYear) : 2000 + Number(rawYear)))
      : Number(fallbackYear);
    return {
      year: Number.isFinite(year) ? year : null,
      month: Number(match[1]),
      day: Number(match[2]),
    };
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate(),
  };
}
function normalizeReceiptDateValue(raw, fallbackYear = null) {
  const parts = parseFlexibleDateParts(raw, fallbackYear);
  if (!parts?.month || !parts?.day) return { iso: "", mmdd: "", year: Number.isFinite(fallbackYear) ? Number(fallbackYear) : null };
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const year = Number(parts.year);
  return {
    iso: Number.isFinite(year) ? `${year}-${mm}-${dd}` : "",
    mmdd: `${mm}/${dd}`,
    year: Number.isFinite(year) ? year : null,
  };
}
function chooseReceiptTotal(payload = {}, expectedTotal = null, fallbackItemsTotal = 0) {
  const hintedTotal = Math.abs(parseMoneyValue(expectedTotal));
  if (Number.isFinite(hintedTotal) && hintedTotal > 0) {
    return { amount: hintedTotal, note: "Matched to entered amount" };
  }
  const paidTotal = parsePositiveReceiptMoney(payload, ["paid_total", "paidTotal", "net_total", "netTotal", "final_total", "finalTotal", "charged_total", "chargedTotal", "card_total", "cardTotal"]);
  const genericTotal = parsePositiveReceiptMoney(payload, ["total", "purchase_total", "purchaseTotal"]);
  const totalLabel = normalizeReceiptTotalLabel(readFirstReceiptField(payload, ["total_label", "totalLabel", "paid_total_label", "paidTotalLabel", "total_source_label", "totalSourceLabel"]));
  const preCreditTotal = parsePositiveReceiptMoney(payload, ["pre_credit_total", "preCreditTotal", "gross_total", "grossTotal"]);
  const creditApplied = parsePositiveReceiptMoney(payload, ["credit_applied", "creditApplied", "reward_credit", "rewardCredit", "reward_applied", "rewardApplied", "discount_applied", "discountApplied", "coupon_total", "couponTotal", "member_savings", "memberSavings"]);
  const subtotal = parsePositiveReceiptMoney(payload, ["subtotal"]);
  const tax = parsePositiveReceiptMoney(payload, ["tax", "sales_tax", "salesTax"]);
  const labelIsCreditLike = isReceiptCreditLikeLabel(totalLabel);
  const computedNet = Number.isFinite(preCreditTotal)
    ? roundMoney(Math.max(0, preCreditTotal - (Number.isFinite(creditApplied) ? creditApplied : 0)))
    : NaN;
  const subtotalPlusTax = Number.isFinite(subtotal)
    ? roundMoney(subtotal + (Number.isFinite(tax) ? tax : 0))
    : NaN;

  if (Number.isFinite(paidTotal) && paidTotal > 0) {
    return { amount: paidTotal, note: totalLabel || "Paid total from receipt" };
  }
  if (Number.isFinite(genericTotal) && genericTotal > 0 && !labelIsCreditLike) {
    return { amount: genericTotal, note: totalLabel || "Total from receipt" };
  }
  if (Number.isFinite(computedNet) && computedNet > 0) {
    const pieces = [];
    if (Number.isFinite(preCreditTotal) && preCreditTotal > 0) pieces.push(money2(preCreditTotal));
    if (Number.isFinite(creditApplied) && creditApplied > 0) pieces.push(`-${money2(creditApplied)}`);
    return {
      amount: computedNet,
      note: pieces.length > 1 ? `${pieces.join(" ")} reward-adjusted total` : "Computed net total",
    };
  }
  if (Number.isFinite(genericTotal) && genericTotal > 0 && labelIsCreditLike) {
    throw new Error("AI matched a reward/credit line instead of the paid total. Enter the card total first or re-parse the receipt.");
  }
  if (Number.isFinite(subtotalPlusTax) && subtotalPlusTax > 0) {
    return { amount: subtotalPlusTax, note: "Subtotal plus tax" };
  }
  return {
    amount: roundMoney(Math.abs(Number(fallbackItemsTotal) || 0)),
    note: "Summed from parsed receipt items",
  };
}
function buildReceiptBudgetBucketDesc(merchant = "", cat = "", subcat = "") {
  const cleanMerchant = String(merchant || "").trim();
  const cleanCat = String(cat || "").trim();
  const cleanSubcat = normalizeTxnSubcategory(subcat);
  const bucketLabel = cleanSubcat || cleanCat || "purchase";
  if (!cleanMerchant) return bucketLabel;
  return `${cleanMerchant} ${bucketLabel.toLowerCase()}`.replace(/\s+/g, " ").trim();
}
function collapseReceiptItemsByBudgetBucket(items = [], merchant = "") {
  const groups = new Map();
  items.forEach((item, idx) => {
    const cat = String(item?.cat || "").trim();
    const subcat = normalizeTxnSubcategory(item?.subcat);
    const amount = roundMoney(Math.abs(Number(item?.amount) || 0));
    if (!cat || amount <= 0) return;
    const key = `${cat.toLowerCase()}|||${subcat.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amount = roundMoney(existing.amount + amount);
      return;
    }
    groups.set(key, {
      desc: buildReceiptBudgetBucketDesc(merchant, cat, subcat) || String(item?.desc || "").trim() || `Receipt item ${idx + 1}`,
      amount,
      cat,
      subcat,
    });
  });
  const collapsed = [...groups.values()];
  if (collapsed.length <= 1) return collapsed;
  const collapsedTotal = roundMoney(collapsed.reduce((sum, item) => sum + item.amount, 0));
  return distributeReceiptAmounts(collapsed, collapsedTotal).map((item, idx) => ({
    desc: item.desc || `Receipt item ${idx + 1}`,
    amount: item.amount,
    cat: item.cat,
    subcat: item.subcat,
  }));
}
function collapseReceiptAuditRowsByBudgetBucket(rows = [], merchant = "") {
  const groups = new Map();
  rows.forEach((row, idx) => {
    const cat = String(row?.cat || "").trim();
    const subcat = normalizeTxnSubcategory(row?.subcat);
    const itemsTotal = roundMoney(Math.abs(Number(row?.itemsTotal) || 0));
    const tax = roundMoney(Math.abs(Number(row?.tax) || 0));
    const rewardApplied = roundMoney(Math.abs(Number(row?.rewardApplied) || 0));
    const computedFinal = roundMoney(Math.max(0, itemsTotal + tax - rewardApplied));
    const finalTotal = roundMoney(Math.abs(Number(row?.finalTotal) || 0)) || computedFinal;
    if (!cat || finalTotal <= 0) return;
    const key = `${cat.toLowerCase()}|||${subcat.toLowerCase()}`;
    const existing = groups.get(key) || {
      cat,
      subcat,
      label: buildReceiptBudgetBucketDesc(merchant, cat, subcat) || `Receipt bucket ${idx + 1}`,
      itemsTotal: 0,
      tax: 0,
      rewardApplied: 0,
      finalTotal: 0,
      reason: "",
    };
    existing.itemsTotal = roundMoney(existing.itemsTotal + itemsTotal);
    existing.tax = roundMoney(existing.tax + tax);
    existing.rewardApplied = roundMoney(existing.rewardApplied + rewardApplied);
    existing.finalTotal = roundMoney(existing.finalTotal + finalTotal);
    if (!existing.reason && String(row?.reason || "").trim()) existing.reason = String(row.reason).trim();
    groups.set(key, existing);
  });
  return [...groups.values()].sort((left, right) => right.finalTotal - left.finalTotal);
}
function normalizeReceiptObservedTotals(payload = {}, totalChoice = null) {
  const subtotal = parsePositiveReceiptMoney(payload, ["subtotal"]);
  const tax = parsePositiveReceiptMoney(payload, ["tax", "sales_tax", "salesTax"]);
  const preCreditTotal = parsePositiveReceiptMoney(payload, ["pre_credit_total", "preCreditTotal", "gross_total", "grossTotal"]);
  const creditApplied = parsePositiveReceiptMoney(payload, ["credit_applied", "creditApplied", "reward_credit", "rewardCredit", "reward_applied", "rewardApplied", "discount_applied", "discountApplied", "coupon_total", "couponTotal", "member_savings", "memberSavings"]);
  const paidTotal = parsePositiveReceiptMoney(payload, ["paid_total", "paidTotal", "net_total", "netTotal", "final_total", "finalTotal", "charged_total", "chargedTotal", "card_total", "cardTotal"]);
  const totalLabel = normalizeReceiptTotalLabel(readFirstReceiptField(payload, ["total_label", "totalLabel", "paid_total_label", "paidTotalLabel", "total_source_label", "totalSourceLabel"]));
  return {
    subtotal: Number.isFinite(subtotal) ? subtotal : 0,
    tax: Number.isFinite(tax) ? tax : 0,
    preCreditTotal: Number.isFinite(preCreditTotal) ? preCreditTotal : 0,
    creditApplied: Number.isFinite(creditApplied) ? creditApplied : 0,
    paidTotal: Number.isFinite(paidTotal) ? paidTotal : roundMoney(Math.abs(Number(totalChoice?.amount) || 0)),
    totalLabel,
  };
}
function normalizeReceiptAuditRows(payload = {}, { receiptCats = [], fallbackCat = "", items = [], merchant = "" } = {}) {
  const auditPayload = payload?.audit && typeof payload.audit === "object" && !Array.isArray(payload.audit) ? payload.audit : {};
  const rawRows = Array.isArray(payload?.audit_rows) ? payload.audit_rows
    : (Array.isArray(payload?.auditRows) ? payload.auditRows
      : (Array.isArray(auditPayload.rows) ? auditPayload.rows : []));
  const baseRows = rawRows.length ? rawRows : items.map(item => ({
    cat: item.cat,
    subcat: item.subcat,
    items_total: item.amount,
    final_total: item.amount,
    reason: "Derived from parsed split",
  }));
  const normalized = baseRows
    .map((row, idx) => {
      const rawCat = String(row?.cat || row?.category || row?.budget_category || row?.budgetCategory || "").trim();
      const cat = receiptCats.includes(rawCat) ? rawCat : (rawCat || fallbackCat);
      if (!cat) return null;
      const subcat = normalizeTxnSubcategory(row?.subcat || row?.subcategory);
      const itemsTotalRaw = Math.abs(parseMoneyValue(row?.items_total ?? row?.itemsTotal ?? row?.items ?? row?.base_total ?? row?.baseTotal ?? row?.merchandise_total ?? row?.merchandiseTotal));
      const taxRaw = Math.abs(parseMoneyValue(row?.tax ?? row?.tax_allocated ?? row?.taxAllocated));
      const rewardRaw = Math.abs(parseMoneyValue(row?.reward_applied ?? row?.rewardApplied ?? row?.credit_applied ?? row?.creditApplied ?? row?.discount_applied ?? row?.discountApplied ?? row?.reward ?? row?.discount));
      const finalRaw = Math.abs(parseMoneyValue(row?.final_total ?? row?.finalTotal ?? row?.amount ?? row?.total ?? row?.value));
      const itemsTotal = Number.isFinite(itemsTotalRaw) ? itemsTotalRaw : 0;
      const tax = Number.isFinite(taxRaw) ? taxRaw : 0;
      const rewardApplied = Number.isFinite(rewardRaw) ? rewardRaw : 0;
      const fallbackFinal = roundMoney(Math.max(0, itemsTotal + tax - rewardApplied));
      const finalTotal = Number.isFinite(finalRaw) && finalRaw > 0 ? finalRaw : fallbackFinal;
      if (finalTotal <= 0) return null;
      return {
        cat,
        subcat,
        label: buildReceiptBudgetBucketDesc(merchant, cat, subcat) || String(row?.label || row?.desc || row?.name || `${cat} ${idx + 1}`).trim(),
        itemsTotal,
        tax,
        rewardApplied,
        finalTotal,
        reason: String(row?.reason || row?.note || row?.explanation || "").trim(),
      };
    })
    .filter(Boolean);
  return collapseReceiptAuditRowsByBudgetBucket(normalized, merchant);
}
function normalizeReceiptAuditWarnings(payload = {}, { expectedTotal = null, totalChoice = null, observed = {} } = {}) {
  const auditPayload = payload?.audit && typeof payload.audit === "object" && !Array.isArray(payload.audit) ? payload.audit : {};
  const warnings = [
    ...(Array.isArray(payload?.warnings) ? payload.warnings : []),
    ...(Array.isArray(payload?.audit_warnings) ? payload.audit_warnings : []),
    ...(Array.isArray(auditPayload?.warnings) ? auditPayload.warnings : []),
  ]
    .map(item => String(item || "").trim())
    .filter(Boolean);

  const hintedTotal = Math.abs(parseMoneyValue(expectedTotal));
  if (!(Number.isFinite(hintedTotal) && hintedTotal > 0)) {
    warnings.unshift("AI estimated the charged total from the receipt. Review and adjust the split before saving if needed.");
  }

  const subtotalPlusTax = Number.isFinite(observed?.subtotal)
    ? roundMoney((Number(observed?.subtotal) || 0) + (Number(observed?.tax) || 0))
    : NaN;
  const chosenAmount = Number.isFinite(Number(totalChoice?.amount)) ? roundMoney(Number(totalChoice.amount)) : NaN;
  const creditApplied = Number.isFinite(observed?.creditApplied) ? Number(observed.creditApplied) : NaN;
  if (Number.isFinite(subtotalPlusTax) && Number.isFinite(chosenAmount) && Math.abs(subtotalPlusTax - chosenAmount) > 0.99 && !(Number.isFinite(creditApplied) && creditApplied > 0)) {
    warnings.unshift("Parsed charged total does not match subtotal plus tax. Double-check missing receipt sections or misread totals.");
  }

  const unique = [];
  const seen = new Set();
  warnings.forEach(text => {
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(text);
    }
  });
  return unique;
}
function distributeReceiptAmounts(items, targetTotal = null) {
  const cleaned = items
    .map(item => ({ ...item, amount: Math.abs(Number(item?.amount) || 0) }))
    .filter(item => item.amount > 0);
  if (!cleaned.length) return [];
  const rawCents = cleaned.map(item => Math.max(1, Math.round(item.amount * 100)));
  const rawTotalCents = rawCents.reduce((sum, cents) => sum + cents, 0);
  const hintedCents = Math.round(Math.abs(Number(targetTotal) || 0) * 100);
  const targetCents = hintedCents > 0 ? hintedCents : rawTotalCents;
  if (targetCents <= 0 || rawTotalCents <= 0) return [];
  if (targetCents === rawTotalCents) {
    return cleaned.map((item, idx) => ({ ...item, amount: rawCents[idx] / 100 }));
  }
  const scaled = rawCents.map(cents => (cents / rawTotalCents) * targetCents);
  const floors = scaled.map(value => Math.floor(value));
  let remainder = targetCents - floors.reduce((sum, cents) => sum + cents, 0);
  scaled
    .map((value, idx) => ({ idx, frac: value - floors[idx] }))
    .sort((left, right) => right.frac - left.frac)
    .forEach(entry => {
      if (remainder > 0) {
        floors[entry.idx] += 1;
        remainder -= 1;
      }
    });
  return cleaned
    .map((item, idx) => ({ ...item, amount: floors[idx] / 100 }))
    .filter(item => item.amount > 0);
}
function normalizeReceiptAiResult(raw, {
  allCats = [],
  expectedTotal = null,
  merchantHint = "",
  dateHint = "",
  fallbackYear = null,
} = {}) {
  const receiptCats = getReceiptBudgetCats(allCats);
  const fallbackCat = receiptCats.includes("Snacks/Misc") ? "Snacks/Misc" : (receiptCats[0] || "Snacks/Misc");
  const payload = Array.isArray(raw) ? { items: raw } : (raw && typeof raw === "object" ? raw : {});
  const merchant = String(payload.merchant || merchantHint || "").trim();
  const dateInfo = normalizeReceiptDateValue(payload.date || dateHint, fallbackYear);
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : (Array.isArray(payload.lines)
      ? payload.lines
      : (Array.isArray(payload.splits)
        ? payload.splits
        : (Array.isArray(payload.category_totals)
          ? payload.category_totals
          : (Array.isArray(payload.categoryTotals)
            ? payload.categoryTotals
            : (Array.isArray(payload.categories) ? payload.categories : [])))));
  const detailedItems = rawItems
    .map((item, idx) => {
      const amount = Math.abs(parseMoneyValue(item?.amount ?? item?.total ?? item?.value));
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const rawCat = String(item?.cat || item?.category || item?.budget_category || item?.budgetCategory || "").trim();
      const cat = receiptCats.includes(rawCat) ? rawCat : fallbackCat;
      const desc = String(item?.desc || item?.name || item?.label || item?.title || rawCat || `${merchant || "Receipt"} item ${idx + 1}`).trim();
      const subcat = normalizeTxnSubcategory(item?.subcat || item?.subcategory);
      return {
        desc: desc || `${merchant || "Receipt"} item ${idx + 1}`,
        amount,
        cat,
        subcat,
      };
    })
    .filter(Boolean);
  if (!detailedItems.length) throw new Error("No receipt items were returned.");
  const cleanedItems = collapseReceiptItemsByBudgetBucket(detailedItems, merchant);
  if (!cleanedItems.length) throw new Error("No receipt items were usable.");
  const itemTotal = cleanedItems.reduce((sum, item) => sum + item.amount, 0);
  const totalChoice = chooseReceiptTotal(payload, expectedTotal, itemTotal);
  const targetTotal = totalChoice.amount;
  const items = distributeReceiptAmounts(cleanedItems, targetTotal);
  if (!items.length) throw new Error("No receipt items were usable.");
  const observedTotals = normalizeReceiptObservedTotals(payload, totalChoice);
  const auditRows = normalizeReceiptAuditRows(payload, { receiptCats, fallbackCat, items, merchant });
  const auditWarnings = normalizeReceiptAuditWarnings(payload, { expectedTotal, totalChoice, observed: observedTotals });
  return {
    merchant,
    dateIso: dateInfo.iso,
    txnDate: dateInfo.mmdd,
    year: dateInfo.year,
    total: roundMoney(items.reduce((sum, item) => sum + item.amount, 0)),
    totalNote: totalChoice.note || "",
    audit: {
      observedTotals,
      rows: auditRows,
      warnings: auditWarnings,
    },
    items,
  };
}
function buildReceiptSplitDesc(merchant, desc) {
  const cleanMerchant = String(merchant || "").trim();
  const cleanDesc = String(desc || "").trim();
  if (!cleanMerchant) return cleanDesc || "Receipt item";
  if (!cleanDesc) return cleanMerchant;
  const merchantTokens = buildMerchantSignature(cleanMerchant).tokens || [];
  const descTokens = buildMerchantSignature(cleanDesc).tokens || [];
  if (merchantTokens.some(token => descTokens.includes(token))) return cleanDesc;
  return `${cleanMerchant} ${cleanDesc}`.replace(/\s+/g, " ").trim();
}
async function requestReceiptParseFromAI({
  imageDataUrl,
  allCats = [],
  expectedTotal = null,
  merchantHint = "",
  dateHint = "",
  fallbackYear = null,
} = {}) {
  const apiKey = getStoredAnthropicKey();
  if (!apiKey) throw new Error("Set your Anthropic API key in Settings to use AI receipt parsing.");
  if (!imageDataUrl) throw new Error("Upload a receipt image first.");
  const receiptCats = getReceiptBudgetCats(allCats);
  const mediaType = inferDataUrlMediaType(imageDataUrl);
  const base64 = String(imageDataUrl).split(",")[1];
  const prompt = `Parse this shopping receipt for a household budget app.
Allowed budget categories: ${receiptCats.join(", ")}.
Merchant hint: ${merchantHint || "none"}.
Date hint: ${dateHint || "none"}.
Total hint: ${Number.isFinite(Number(expectedTotal)) && Number(expectedTotal) > 0 ? `$${Number(expectedTotal).toFixed(2)}` : "none"}.

Return ONLY strict JSON with this exact shape:
{"merchant":"Store name","date":"YYYY-MM-DD","paid_total":123.45,"pre_credit_total":140.00,"credit_applied":16.00,"total_label":"TOTAL","audit":{"observed_totals":{"subtotal":130.00,"tax":10.00,"pre_credit_total":140.00,"credit_applied":16.00,"paid_total":124.00},"rows":[{"cat":"Groceries","items_total":100.00,"tax":7.00,"reward_applied":12.00,"final_total":95.00,"reason":"Food items"},{"cat":"Shopping","items_total":30.00,"tax":3.00,"reward_applied":4.00,"final_total":29.00,"reason":"Household goods"}],"warnings":["If uncertain, review before saving."]},"items":[{"desc":"Costco groceries","amount":96.25,"cat":"Groceries"},{"desc":"Costco shopping","amount":27.20,"cat":"Shopping"}]}

Rules:
- Read the merchant, purchase date, and final paid total from the image when visible.
- "paid_total" is the net amount actually charged after reward credits, coupons, or discounts.
- If the receipt shows both a pre-credit total and a reward/coupon/credit line, return the pre-credit value in "pre_credit_total", the credit amount in "credit_applied", and the final charged amount in "paid_total".
- "total_label" should be the nearby label text used for "paid_total" such as "TOTAL", "DEBIT TOTAL", "VISA TOTAL", or "AMOUNT DUE".
- Never use labels like "CC Reward", "Reward", "Savings", "Coupon", or "Discount" as the final paid total.
- Include the full receipt, including continued sections like "Bottom of Basket", "BOB Count", or lower receipt segments.
- Return final budget totals, not intermediate clusters.
- Prefer one line per final budget category or category+subcategory bucket that will actually be saved in the app.
- Do not return multiple rows for the same category unless they belong to different explicit subcategories.
- For warehouse receipts like Costco or Sam's, usually return only 2 to 4 final budget rows, such as Groceries, Shopping, Household, or Pets if those categories exist in the allowed list.
- Food, beverages, produce, meat, pantry, frozen items, and supplements belong in Groceries unless a more specific allowed category exists.
- Pet food/litter, filters, household supplies, paper goods, personal care, diapers, clothing, and other non-food goods belong in Shopping unless a more specific allowed category exists.
- Every item amount must be positive.
- If tax, discounts, or fees appear, distribute them into the final positive item amounts so the item amounts sum exactly to the total.
- Also return an "audit" block that shows how you allocated subtotal, tax, and reward/discount amounts across the final budget rows.
- Use only the allowed categories.
- Make descriptions concise, store-aware, and bucket-level, such as "Costco groceries" or "Costco shopping".
- If the image is ambiguous, use the hints as fallback.
- Do not include markdown, comments, or explanation.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1400,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `AI request failed (${res.status})`);
  }
  const rawText = stripCodeFences(extractAnthropicText(data));
  if (!rawText) throw new Error("AI returned an empty receipt parse.");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("AI returned invalid receipt JSON.");
  }
  return normalizeReceiptAiResult(parsed, { allCats, expectedTotal, merchantHint, dateHint, fallbackYear });
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
function CashFlowSankey({ viewMode, breakdown = "category" }) {
  const [hovered, setHovered] = useState(null);
  const { summaryRows, checkTxns, ccTxns, takeHome, selectedMonth, selectedYear } = useBudget();
  const width = useWindowWidth();
  const isMobile = width < 768;

  const spendTxns = useMemo(() => ([
    ...checkTxns.filter(t =>
      t.month === selectedMonth
      && deriveTxnYear(t, selectedYear) === selectedYear
      && t.cat !== "Income"
      && t.cat !== "Transfer"
      && Number(t.amount) > 0
    ),
    ...ccTxns.filter(t =>
      t.month === selectedMonth
      && deriveTxnYear(t, selectedYear) === selectedYear
      && Number(t.amount) > 0
    ),
  ]), [checkTxns, ccTxns, selectedMonth, selectedYear]);

  const categories = useMemo(() => {
    if (breakdown !== "subcategory") {
      return summaryRows.map(r => ({
        id: r.cat,
        name: r.cat,
        meta: "",
        value: viewMode === "norm" ? r.norm : (r.checking + r.cc),
        color: r.color,
        icon: r.icon,
      }));
    }
    const actualWeights = new Map();
    spendTxns.forEach(txn => {
      const subcat = normalizeTxnSubcategory(txn.subcat) || "Unassigned";
      const key = `${txn.cat}|||${subcat}`;
      actualWeights.set(key, (actualWeights.get(key) || 0) + Math.abs(Number(txn.amount) || 0));
    });
    const rows = [];
    summaryRows.forEach(r => {
      const total = viewMode === "norm" ? r.norm : (r.checking + r.cc);
      if (total <= 0) return;
      const weighted = [...actualWeights.entries()]
        .filter(([key]) => key.startsWith(`${r.cat}|||`))
        .map(([key, amount]) => ({ desc: key.split("|||")[1], amount }));
      if (!weighted.length) {
        rows.push({
          id: `${r.cat}|||unassigned`,
          name: "Unassigned",
          meta: r.cat,
          value: total,
          color: r.color,
          icon: r.icon,
        });
        return;
      }
      distributeReceiptAmounts(weighted, total).forEach(item => {
        rows.push({
          id: `${r.cat}|||${item.desc}`,
          name: item.desc,
          meta: r.cat,
          value: item.amount,
          color: r.color,
          icon: r.icon,
        });
      });
    });
    return rows;
  }, [breakdown, summaryRows, spendTxns, viewMode]);

  const totalIncome = Math.max(0, takeHome || 0);
  const allDest = categories.filter(c => c.value > 0);
  const totalSpend  = allDest.reduce((s, c) => s + c.value, 0);

  // ── Canvas ─────────────────────────────────────────────────────────────────
  const W = 1000, H = 680;
  const ff = "'DM Sans',system-ui,sans-serif";
  const srcLabelFs = isMobile ? 18 : 11;
  const srcValueFs = isMobile ? 30 : 18;
  const srcPctFs = isMobile ? 16 : 10;
  const destNameFs = isMobile ? 22 : 12;
  const destMetaFs = isMobile ? 16 : 10;
  const pctStr = v => totalIncome > 0 ? `${((v / totalIncome) * 100).toFixed(1)}%` : "n/a";
  const NUM = allDest.length;
  const totalVal = allDest.reduce((s, d) => s + d.value, 0);
  const safeTotalVal = Math.max(totalVal, 1);

  // ── SOURCE: one solid bar, sliced purely by proportion (no gaps, no minimum) 
  const SRC_X = 16, SRC_W = 14;
  const SRC_Y = 30, SRC_H = H - 60;
  const srcScale = SRC_H / safeTotalVal;
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
  const DST_W = 14;
  const LABEL_W = 240;
  const RIGHT_PAD = 18;
  const DST_X = W - LABEL_W - RIGHT_PAD - DST_W;
  const LABEL_X = DST_X + DST_W + 14;
  const DST_GAP = 5, DST_MIN = 12;
  const sqrtVals = allDest.map(d => Math.sqrt(d.value));
  const sqrtTotal = Math.max(1, sqrtVals.reduce((s, v) => s + v, 0));
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
      id: d.id,
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
    <div style={{ width:"100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"auto", maxHeight:"calc(100vh - 220px)", display:"block" }}>
        <defs>
          {allDest.map(d => (
            <linearGradient key={d.id} id={`sg-${d.id.replace(/[^a-zA-Z0-9_-]/g,"_")}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor={d.color} stopOpacity="0.12"/>
              <stop offset="100%" stopColor={d.color} stopOpacity="0.62"/>
            </linearGradient>
          ))}
        </defs>

        {/* Bands first (behind nodes) */}
        {bands.map((b, i) => (
          <path key={i} d={b.path}
            fill={hovered===b.id ? b.color : `url(#sg-${b.id.replace(/[^a-zA-Z0-9_-]/g,"_")})`}
            opacity={hovered===null ? 1 : hovered===b.id ? 0.75 : 0.07}
            style={{ transition:"opacity .2s", cursor:"pointer" }}
            onMouseEnter={() => setHovered(b.id)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}

        {/* Source bar on top */}
        <rect x={SRC_X} y={SRC_Y} width={SRC_W} height={SRC_H} rx={6} fill={ACCENT}/>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+20} fontFamily={ff} fill="#cbd5e1" fontSize={srcLabelFs} fontWeight={800}>Paychecks</text>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+(isMobile?52:38)} fontFamily={ff} fill={ACCENT} fontSize={srcValueFs} fontWeight={900}>{fmt(totalIncome)}</text>
        <text x={SRC_X+SRC_W+10} y={SRC_Y+(isMobile?74:54)} fontFamily={ff} fill="#cbd5e1" fontSize={srcPctFs}>{totalIncome > 0 ? "100%" : "0%"}</text>

        {/* Dest nodes + labels */}
        {destNodes.map((d, i) => {
          const ly  = labelY[i];
          const mid = d.y + d.h / 2;
          const isH = hovered === d.id;
          return (
            <g key={d.id}
              onMouseEnter={() => setHovered(d.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor:"pointer" }}>
              {Math.abs(ly - mid) > 4 && (
                <line x1={DST_X+DST_W+3} y1={mid} x2={LABEL_X-4} y2={ly}
                  stroke={d.color} strokeWidth={1} strokeOpacity={0.4}/>
              )}
              <rect x={DST_X} y={d.y} width={DST_W} height={d.h} rx={3}
                fill={d.color} opacity={isH ? 1 : 0.85}
                style={{ transition:"opacity .15s" }}/>
              <text x={LABEL_X} y={ly-5}
                fontFamily={ff} fontSize={destNameFs} fontWeight={isH?800:700}
                fill={isH ? d.color : "#e5e7eb"}>
                {d.icon} {d.name}
              </text>
              <text x={LABEL_X} y={ly+10}
                fontFamily={ff} fontSize={destMetaFs} fill={isH ? d.color : "#cbd5e1"}>
                {d.meta ? `${d.meta} · ` : ""}{fmt(d.value)} ({pctStr(d.value)})
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize:11, color:DIM, textAlign:"center", marginTop:4 }}>
        Hover a band to highlight · {viewMode==="norm" ? "normalized recurring spend" : `${selectedMonth} actual spend`} · {breakdown==="subcategory" ? "subcategory breakdown" : "category breakdown"}
      </div>
    </div>
  );
}


// ── SUMMARY ───────────────────────────────────────────────────────────────────
function Summary({wide, isMobile}) {
  const [view, setView] = useState("actual");
  const [flowBreakdown, setFlowBreakdown] = useState("category");
  const [expandedCat, setExpandedCat] = useState(null);
  const {
    summaryRows, checkTxns, ccTxns, janActual, normTotal, normSurplus, takeHome,
    selectedMonth, selectedYear, oneTimes, recurringItems, hideZeroSummaryCats,
  } = useBudget();

  // Merge all transactions for the expandable drill-down
  const ALL_TXNS = useMemo(() => [
    ...checkTxns.filter(t => t.cat !== "Transfer" && t.cat !== "Income"),
    ...ccTxns,
  ], [checkTxns, ccTxns]);
  const RECURRING_TXNS = useMemo(() => [
    ...checkTxns.map(t => ({ ...t, src: "checking" })),
    ...ccTxns.map(t => ({ ...t, src: "cc" })),
  ].filter(isSpendTxn), [checkTxns, ccTxns]);

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
  const breakdownRows = hideZeroSummaryCats
    ? sortedSummaryRows.filter(r => (view==="norm" ? r.norm : (r.checking + r.cc)) !== 0)
    : sortedSummaryRows;
  const summaryCols = "26px minmax(0,1.85fr) minmax(0,0.75fr) minmax(0,0.55fr) minmax(0,1.25fr) minmax(72px,0.95fr)";
  const recurringPlannedTotal = summaryRows.reduce((s, r) => s + (r.recurringPlanned || 0), 0);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card glow="#ef4444">
        <Label>{selectedMonth} Snapshot</Label>
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
          <Label>Cash Flow · {view==="norm"?"Normalized":`${selectedMonth} Actual`}</Label>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <div style={{fontSize:11,color:DIM}}>Income → {flowBreakdown==="subcategory" ? "Subcategories" : "Categories"}</div>
            <div style={{display:"flex",gap:6}}>
              {[["category","Categories"],["subcategory","Subcategories"]].map(([mode,label]) => (
                <button key={mode} onClick={() => setFlowBreakdown(mode)} style={{
                  padding:"5px 12px",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",
                  background:flowBreakdown===mode?ACCENT+"22":BG, color:flowBreakdown===mode?ACCENT:MUTED,
                  border:`1px solid ${flowBreakdown===mode?ACCENT:BORDER}`, transition:"all .15s",
                }}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {flowBreakdown==="subcategory" && view==="norm" && (
          <div style={{fontSize:11,color:MUTED,marginBottom:10}}>
            Normalized subcategories are allocated using this month&apos;s actual subcategory mix inside each category.
          </div>
        )}
        <CashFlowSankey viewMode={view} breakdown={flowBreakdown}/>
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
              {breakdownRows.map((r,i)=>{
                const displayVal = view==="norm" ? r.norm : (r.checking+r.cc);
                const over = r.kc && displayVal > r.kc;
                const pct  = takeHome > 0 ? (displayVal / takeHome) * 100 : 0;
                const targetPct = r.kc > 0 ? Math.min((displayVal / r.kc) * 100, 100) : 0;
                const mobileBarPct = r.kc > 0 ? targetPct : Math.min(pct * 2.5, 100);
                const targetDelta = r.kc ? (r.kc - displayVal) : null;
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
                          {r.recurringPlanned>0&&view==="norm"&&<div style={{marginTop:2}}><Tag color="#22c55e">+{fmt(r.recurringPlanned)} planned</Tag></div>}
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
                      <PBar pct={mobileBarPct} color={r.color} h={4}/>
                      {r.kc && (
                        <div style={{marginTop:8}}>
                          <div style={{fontSize:11,color:targetDelta >= 0 ? "#22c55e" : "#ef4444",marginTop:4,fontWeight:700,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>
                            {targetDelta >= 0 ? `${fmt(targetDelta)} remains` : `${fmt(Math.abs(targetDelta))} over`} ({Math.round((displayVal / r.kc) * 100)}%)
                          </div>
                        </div>
                      )}
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
                            {getTxnDisplayNote(t.note)&&<div style={{fontSize:11,color:DIM,marginTop:2}}>{getTxnDisplayNote(t.note)}</div>}
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
                <div style={{display:"grid",gridTemplateColumns:summaryCols,columnGap:6,padding:"9px 12px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
                  {["","Category","Checking","CC",view==="norm"?"Normalized":"Actual","KC Avg"].map((h,i)=>(
                    <div key={i} style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".4px",textAlign:i>1?"right":"left"}}>{h}</div>
                  ))}
                </div>
                {breakdownRows.map((r,i)=>{
                  const displayVal = view==="norm" ? r.norm : (r.checking+r.cc);
                  const over = r.kc && displayVal > r.kc;
                  const targetDelta = r.kc ? (r.kc - displayVal) : null;
                  const targetPct = r.kc > 0 ? Math.min((displayVal / r.kc) * 100, 100) : 0;
                  const isOpen = expandedCat === r.cat;
                  const txns = txnsFor(r.cat);
                  return (
                    <div key={r.cat}>
                      {/* Main row — clickable */}
                      <div onClick={()=>setExpandedCat(isOpen?null:r.cat)}
                        style={{display:"grid",gridTemplateColumns:summaryCols,columnGap:6,padding:"10px 12px",
                          borderBottom:`1px solid ${isOpen?r.color+"44":BORDER}`,
                          background:isOpen?r.color+"0d":i%2===0?SURFACE:BG,
                          alignItems:"center",cursor:"pointer",transition:"background .15s"}}>
                        <span style={{fontSize:16}}>{r.icon}</span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{display:"flex",flexDirection:"column",gap:4,flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:isOpen?700:500,color:isOpen?r.color:TEXT}}>{r.cat}</div>
                            {r.kc && (
                              <div style={{width:"72%",maxWidth:150,minWidth:90}}>
                                <PBar pct={targetPct} color={r.color} h={2}/>
                              </div>
                            )}
                          </div>
                          {r.recurringPlanned>0&&view==="norm"&&<Tag color="#22c55e">+{fmt(r.recurringPlanned)} planned</Tag>}
                          {r.oneTime>0&&view==="actual"&&<Tag color="#f59e0b">−{fmt(r.oneTime)} one-time</Tag>}
                          <span style={{fontSize:10,color:isOpen?r.color:MUTED,marginLeft:"auto",transition:"transform .2s",display:"inline-block",transform:isOpen?"rotate(180deg)":"none"}}>▾</span>
                        </div>
                        <div style={{textAlign:"right",fontSize:12,color:r.checking>0?"#94a3b8":DIM,fontVariantNumeric:"tabular-nums"}}>{r.checking>0?fmt(r.checking):"—"}</div>
                        <div style={{textAlign:"right",fontSize:12,color:r.cc>0?"#94a3b8":DIM,fontVariantNumeric:"tabular-nums"}}>{r.cc>0?fmt(r.cc):"—"}</div>
                        <div style={{textAlign:"right",fontSize:14,fontWeight:700,color:isOpen?r.color:TEXT,fontVariantNumeric:"tabular-nums"}}>
                          {displayVal === 0 ? "$0" : fmt(displayVal)}
                          {r.kc && (
                            <div style={{fontSize:10,color:targetDelta >= 0 ? "#22c55e" : "#ef4444",fontWeight:700,marginTop:2,whiteSpace:"nowrap"}}>
                              {targetDelta >= 0 ? `${fmt(targetDelta)} remains` : `${fmt(Math.abs(targetDelta))} over`}
                            </div>
                          )}
                        </div>
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
                                {getTxnDisplayNote(t.note)&&<div style={{fontSize:10,color:DIM,marginTop:1}}>{getTxnDisplayNote(t.note)}</div>}
                                {(hasTxnNoteFlag(t.note, "ONE-TIME") || hasTxnNoteFlag(t.note, "RECURRING")) && (
                                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:2}}>
                                    {hasTxnNoteFlag(t.note, "ONE-TIME")&&<Tag color="#f59e0b">one-time</Tag>}
                                    {hasTxnNoteFlag(t.note, "RECURRING")&&<Tag color="#22c55e">recurring</Tag>}
                                  </div>
                                )}
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
                <div style={{display:"grid",gridTemplateColumns:summaryCols,columnGap:6,padding:"11px 12px",borderTop:`2px solid ${BORDER}`,background:BG}}>
                  <div/><div style={{fontSize:13,fontWeight:800,color:MUTED}}>Total</div>
                  <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(checkTotal)}</div>
                  <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(ccTotal)}</div>
                  <div style={{textAlign:"right",fontSize:14,fontWeight:900,color:MUTED,fontVariantNumeric:"tabular-nums"}}>{fmt(view==="norm"?normTotal:janActual)}</div>
                  <div/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:summaryCols,columnGap:6,padding:"11px 12px",background:BG}}>
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
            <Label>Recurring Planning Items</Label>
            {recurringItems.length === 0
              ? <div style={{fontSize:12,color:MUTED}}>No recurring planning items yet — mark a transaction as recurring in Transactions.</div>
              : recurringItems.map((item, i)=>(
                <div key={buildRecurringItemKey(item) || i} style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${BORDER}`,gap:10}}>
                  <div>
                    <div style={{fontSize:13,color:MUTED}}>{item.name}</div>
                    <div style={{fontSize:11,color:DIM}}>
                      {item.cat} · {recurringSourceLabel(item.src)} · starts {formatMonthYearLabel(item.startMonth || selectedMonth, item.startYear || selectedYear)}
                    </div>
                    <div style={{fontSize:11,color:DIM}}>
                      {summarizeRecurringItemDates(item, RECURRING_TXNS, selectedYear)}
                    </div>
                  </div>
                  <span style={{fontSize:14,fontWeight:700,color:"#22c55e",fontVariantNumeric:"tabular-nums"}}>{fmt(item.amount)}</span>
                </div>
              ))
            }
            {recurringItems.length > 0 && (
            <div style={{display:"flex",justifyContent:"space-between",paddingTop:10}}>
              <span style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>{selectedMonth} planned add-in</span>
              <span style={{fontSize:15,fontWeight:900,color:"#22c55e",fontVariantNumeric:"tabular-nums"}}>{fmt(recurringPlannedTotal)}</span>
            </div>
            )}
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
  { label:"2nd Tithe / Feast", emoji:"🙏" },
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

function Scenarios({ wide, isMobile, activeTab: activeTabProp, setActiveTab: setActiveTabProp }) {
  const { payoffs, normSurplus, takeHome, t2CarryIn, groceryGoal, checkTxns, ccTxns, selectedMonth, showTithe, showABA } = useBudget();
  const t2Balance = t2CarryIn;

  const [plans, setPlans] = useState([
    {
      id: mkPlanId(), name:"Summer Vacation", emoji:"🏖️",
      startingFunds: t2Balance,
      fundLabel: "Available Funds",
      items: [
        { id:mkItemId(), desc:"Hotel / Lodging",  amount:1200, cat:"Lodging" },
        { id:mkItemId(), desc:"Groceries & food", amount:400,  cat:"Food" },
        { id:mkItemId(), desc:"Gas / travel",     amount:200,  cat:"Transport" },
      ]
    }
  ]);
  const [localActiveTab, setLocalActiveTab] = useState("impact");
  const activeTab = activeTabProp ?? localActiveTab;
  const setActiveTab = setActiveTabProp ?? setLocalActiveTab;

  useEffect(() => {
    if (activeTab === "tithe" && !showTithe) setActiveTab("impact");
    if (activeTab === "aba" && !showABA) setActiveTab("impact");
  }, [activeTab, setActiveTab, showTithe, showABA]);

  // ── Plan CRUD ──────────────────────────────────────────────────────────────
  const addPlan = () => setPlans(prev => [...prev, {
    id: mkPlanId(), name:"New Plan", emoji:"📋",
    startingFunds: 1000, fundLabel:"Available Funds",
    items: [],
  }]);

  const updatePlan = (pid, field, val) =>
    setPlans(prev => prev.map(p => p.id===pid ? {...p, [field]:val} : p));

  const removePlan = pid => {
    if (!confirmDeleteAction("Delete this scenario plan?")) return;
    setPlans(prev => prev.filter(p => p.id !== pid));
  };

  const addItem = pid => setPlans(prev => prev.map(p =>
    p.id!==pid ? p : {...p, items:[...p.items, {id:mkItemId(), desc:"", amount:0, cat:"Misc"}]}
  ));

  const updateItem = (pid, iid, field, val) => setPlans(prev => prev.map(p =>
    p.id!==pid ? p : {...p, items: p.items.map(it => it.id!==iid ? it : {...it,[field]:val})}
  ));

  const removeItem = (pid, iid) => {
    if (!confirmDeleteAction("Delete this scenario line item?")) return;
    setPlans(prev => prev.map(p =>
      p.id!==pid ? p : {...p, items: p.items.filter(it => it.id!==iid)}
    ));
  };

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
  const removeCustomStep = (id) => {
    if (!confirmDeleteAction("Delete this custom impact step?")) return;
    saveCustomSteps(customSteps.filter(s => s.id !== id));
  };
  // ── Waterfall data — reorderable over-budget categories + payoffs + custom ─────────
  const { summaryRows: wfRows, waterfallDisabled } = useBudget();
  const baseImpactSteps = useMemo(() => {
    const overspend = wfRows.flatMap(r => {
      if (!r.kc) return [];
      const save = (r.checking + r.cc) - r.kc;
      if (save <= 0) return [];
      return [{ id: "cat_" + r.cat, label: r.cat + " overspend", payment: save, color: r.color, type: "overspend" }];
    });
    const payoffSteps = payoffs.map(p => ({ id: "payoff_" + p.id, label: p.name, payment: p.payment, color: p.color, type: "payoff" }));
    const manualSteps = customSteps.map(s => ({ id: s.id, label: s.label, payment: s.payment, color: s.color, type: "custom" }));
    return [...overspend, ...payoffSteps, ...manualSteps];
  }, [wfRows, payoffs, customSteps]);

  const [impactOrder, setImpactOrder] = useState(() => ls.getJSON("budget_impactOrder", []));
  useEffect(() => {
    const ids = baseImpactSteps.map(s => s.id);
    setImpactOrder(prev => {
      const keep = prev.filter(id => ids.includes(id));
      const add = ids.filter(id => !keep.includes(id));
      return [...keep, ...add];
    });
  }, [baseImpactSteps]);
  useEffect(() => { ls.setJSON("budget_impactOrder", impactOrder); }, [impactOrder]);

  const moveImpactStep = (id, dir) => {
    setImpactOrder(prev => {
      const idx = prev.indexOf(id);
      if (idx < 0) return prev;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
      return next;
    });
  };

  const stepById = useMemo(() => {
    const map = {};
    baseImpactSteps.forEach(s => { map[s.id] = s; });
    return map;
  }, [baseImpactSteps]);

  const orderedImpactSteps = useMemo(
    () => impactOrder.map(id => stepById[id]).filter(Boolean).filter(s => !waterfallDisabled.includes(s.id)),
    [impactOrder, stepById, waterfallDisabled]
  );

  const waterfallSteps = useMemo(() => {
    let remaining = Math.abs(normSurplus);
    const steps = [{ id:"gap", label:"Current gap", spend: remaining, surplus: normSurplus, color:"#ef4444", payment: 0, type: "gap" }];
    orderedImpactSteps.forEach(s => {
      remaining -= s.payment;
      steps.push({ ...s, spend: remaining, surplus: -remaining });
    });
    return steps;
  }, [orderedImpactSteps, normSurplus]);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* Tab switcher */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {[
          ["impact","📊 Budget Impact"],
          ["planner","🗓 Trip / Event Planner"],
          ...(showTithe ? [["tithe","🙏 Tithe"]] : []),
          ...(showABA ? [["aba","🧩 ABA"]] : []),
        ].map(([t,l])=>(
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
                      {["🏖️","✈️","🏕️","🎉","🎪","📋"].map(e=>(
                        <button key={e} onClick={()=>updatePlan(plan.id,"emoji",e)} style={{background:"transparent",border:"none",fontSize:16,cursor:"pointer",opacity:plan.emoji===e?1:.4,padding:"2px"}}>{e}</button>
                      ))}
                      <button onClick={()=>removePlan(plan.id)} style={{marginLeft:4,padding:"3px 8px",borderRadius:6,fontSize:11,cursor:"pointer",background:"#ef444411",color:"#ef4444",border:"1px solid #ef444422"}}>✕</button>
                    </div>
                  </div>

                  {/* Starting funds */}
                  <div style={{padding:"10px 12px",background:BG,borderRadius:10,border:`1px solid ${BORDER}`,marginBottom:14}}>
                    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>Starting Funds</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <span style={{fontSize:16,color:MUTED}}>$</span>
                      <input type="number" value={plan.startingFunds}
                        onChange={e=>updatePlan(plan.id,"startingFunds",parseFloat(e.target.value)||0)}
                        style={{background:"transparent",border:"none",color:TEXT,fontSize:20,fontWeight:900,width:"100%",outline:"none",fontVariantNumeric:"tabular-nums"}}/>
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
      {activeTab==="impact" && (
        <>
          <Card glow="#818cf8">
            <Label>Budget Impact Waterfall · Overages + payoffs + custom reductions</Label>
            <div style={{fontSize:13,color:MUTED,marginTop:4}}>Reorder steps to model what to tackle first. The chart and totals update automatically.</div>
          </Card>

          <Card>
            <Label>Monthly Surplus Step-Down</Label>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={waterfallSteps} barSize={wide?32:20} margin={{left:0,right:12,top:20,bottom:waterfallSteps.length>8?20:6}}>
                <XAxis
                  dataKey="label"
                  tick={{fontSize:waterfallSteps.length>8?10:(wide?11:9),fill:"#93a4c3"}}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={v => {
                    const s = String(v || "");
                    const max = waterfallSteps.length > 8 ? 10 : 14;
                    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
                  }}
                  interval={0}
                  angle={0}
                  textAnchor="middle"
                  height={30}
                  tickMargin={8}
                  minTickGap={6}
                />
                <YAxis tick={{fontSize:11,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(Math.abs(v)/1000).toFixed(0)}k`} width={52}/>
                <ReferenceLine y={0} stroke={ACCENT} strokeDasharray="4 3" label={{value:"Break-even",fill:ACCENT,fontSize:10,position:"right"}}/>
                <Tooltip content={<Tip/>} cursor={{fill:"transparent"}}/>
                <Bar dataKey="surplus" name="Monthly Surplus" radius={[5,5,0,0]}>
                  <LabelList
                    dataKey="surplus"
                    position="top"
                    formatter={v => `${v >= 0 ? "+" : "-"}${fmt(Math.abs(v))}`}
                    style={{fontSize:10,fontWeight:700,fill:MUTED}}
                  />
                  {waterfallSteps.map((d,i)=><Cell key={i} fill={d.color} opacity={0.9}/>)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:12}}>
            {waterfallSteps.slice(1).map((step,i)=>{
              const sur = step.surplus;
              const col = step.color;
              return (
                <Card key={i} style={{border:`1px solid ${col}33`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:8,height:36,borderRadius:4,background:col}}/>
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:TEXT}}>{step.label}</div>
                        <div style={{fontSize:12,color:MUTED}}>+{fmt(step.payment)}/mo freed</div>
                      </div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:22,fontWeight:900,color:sur>=0?"#22c55e":"#ef4444",fontVariantNumeric:"tabular-nums"}}>{sur>=0?"+":"−"}{fmt(Math.abs(sur))}</div>
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

          <Card>
            <Label>Step Order</Label>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {orderedImpactSteps.length === 0 && (
                <div style={{fontSize:12,color:MUTED}}>No active steps. Re-enable items in Settings or add a custom step.</div>
              )}
              {orderedImpactSteps.map((s, i) => (
                <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",border:`1px solid ${s.color}33`,background:BG,borderRadius:10}}>
                  <div style={{width:10,height:22,borderRadius:4,background:s.color,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,color:TEXT,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.label}</div>
                    <div style={{fontSize:11,color:MUTED}}>+{fmt(s.payment)}/mo</div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={() => moveImpactStep(s.id, -1)} disabled={i===0} style={{padding:"4px 8px",borderRadius:8,fontSize:11,fontWeight:700,background:BG,color:i===0?DIM:MUTED,border:`1px solid ${BORDER}`,cursor:i===0?"default":"pointer"}}>Up</button>
                    <button onClick={() => moveImpactStep(s.id, 1)} disabled={i===orderedImpactSteps.length-1} style={{padding:"4px 8px",borderRadius:8,fontSize:11,fontWeight:700,background:BG,color:i===orderedImpactSteps.length-1?DIM:MUTED,border:`1px solid ${BORDER}`,cursor:i===orderedImpactSteps.length-1?"default":"pointer"}}>Down</button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {activeTab==="tithe" && showTithe && (
        <TitheTracker wide={wide} isMobile={isMobile}/>
      )}

      {activeTab==="aba" && showABA && (
        <ABAPlanner wide={wide}/>
      )}
    </div>
  );
}

// ── ABA PLANNER ───────────────────────────────────────────────────────────────
function ABAPlanner({wide}) {
  const [sel, setSel] = useState(0);
  const opt = ABA_OPTIONS[sel];
  const { abaSettings } = useBudget();
  const { schedule, annualCost, capHit, fullMonthCost } = useMemo(()=>buildABASchedule(opt.daysPerWeek, abaSettings),[sel, abaSettings]);

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
              The {fmt(abaSettings.oopCap)} individual OOP max is per insurance year. After Dec 31 the counter resets — copays start again from $0. Hit the cap before year-end and the remaining months are free.
            </div>
          </div>
        </div>
      </Card>

      {/* Schedule picker */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        {ABA_OPTIONS.map((o,i)=>{
          const {annualCost:ac,capHit:ch,fullMonthCost:fmc} = buildABASchedule(o.daysPerWeek, abaSettings);
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
              <div style={{fontSize:11,color:ch?"#f59e0b":"#64748b",marginTop:3}}>{ch?"Cap hits ":"No cap — "}{ch?buildABASchedule(o.daysPerWeek, abaSettings).schedule.find(m=>m.status!=="full")?.month+" each yr":"pays all year"}</div>
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
              <span style={{fontSize:13,color:"#f59e0b",fontWeight:600}}>⚡ Hits {fmt(abaSettings.oopCap)} OOP cap · {freeMonths2026.join(" & ")} are free each year</span>
            </div>
          ) : (
            <div style={{marginTop:12,padding:"10px 14px",background:"#ef444412",borderRadius:10,border:"1px solid #ef444433"}}>
              <span style={{fontSize:13,color:"#ef4444",fontWeight:600}}>
                ⚠️ Never hits OOP cap — annual cost {fmt(annualCost)} vs {fmt(abaSettings.oopCap)} cap ({fmt(Math.abs(abaSettings.oopCap-annualCost))} {annualCost < abaSettings.oopCap ? "under cap/yr" : "over cap/yr"})
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

// Defined at module level so React doesn't remount it on every parent re-render
const FieldInput = ({label, val, onChange, type="text", placeholder=""}) => (
  <div>
    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:4}}>{label}</div>
    <input type={type} value={val} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
  </div>
);

function Payoffs({wide}) {
  const { payoffs, setPayoffs, normSurplus, checkTxns, ccTxns, selectedMonth } = useBudget();
  const width = useWindowWidth();
  const isCompactMobile = width < 460;
  const [enabled, setEnabled] = useState(() => {
    try {
      const s = ls.get("budget_payoffEnabled");
      if (s) return new Set(JSON.parse(s));
    } catch {}
    return new Set(payoffs.map(p => p.id));
  });
  useEffect(() => { ls.setJSON("budget_payoffEnabled", [...enabled]); }, [enabled]);
  const [editId,    setEditId]   = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [auditOpenId, setAuditOpenId] = useState(null);
  const [adding,  setAdding]    = useState(false);
  const [newDebt, setNewDebt]   = useState({ name:"", payment:"", balance:"", manualBalance:"", icon:"💳", color:"#22c55e", keywords:"" });

  const toggle = id => setEnabled(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });

  const updateField = (id, field, val) =>
    setPayoffs(prev => prev.map(p => p.id===id ? {...p, [field]:val} : p));

  const removePayoff = id => {
    if (!confirmDeleteAction("Delete this payoff account?")) return;
    setPayoffs(prev => prev.filter(p => p.id !== id));
    setEnabled(prev => { const n=new Set(prev); n.delete(id); return n; });
    if(editId===id) { setEditId(null); setEditDraft({}); }
  };

  const addPayoff = () => {
    if(!newDebt.name || !newDebt.payment) return;
    const id = "p" + Date.now();
    const origBal = parseFloat((newDebt.balance||"0").replace(/[$,]/g,""))||0;
    const p = {
      id,
      name:        newDebt.name,
      payment:     parseFloat(newDebt.payment)||0,
      balance:       origBal,
      origBalance:   origBal,
      manualBalance: parseFloat(newDebt.manualBalance) || 0,
      icon:          newDebt.icon || "💳",
      balanceStr:    newDebt.balance || "$0",
      color:         newDebt.color,
      keywords:      newDebt.keywords || "",
    };
    setPayoffs(prev => [...prev, p]);
    setEnabled(prev => new Set([...prev, id]));
    setNewDebt({ name:"", payment:"", balance:"", manualBalance:"", icon:"💳", color:"#22c55e", keywords:"" });
    setAdding(false);
  };

  const allTxns = [...checkTxns, ...ccTxns].filter(t => !t.excludeFromTags);

  // Compute live balance, progress, and time-to-payoff for a debt
  const getPayoffStats = (p) => {
    const orig    = p.origBalance || p.balance || 0;
    const pmt     = parseFloat(p.payment) || 0;
    const manual  = parseFloat(p.manualBalance) || 0;
    const kws     = (p.keywords || "").split(",").map(k => k.trim().toLowerCase()).filter(Boolean);
    const mkDate  = (mo) => {
      if (mo === null) return "TBD";
      if (mo <= 0) return "Paid off!";
      const d = new Date(); d.setMonth(d.getMonth() + mo);
      return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + d.getFullYear();
    };
    const matchedTxns = kws.length ? allTxns.filter(t => {
      const hay = `${t.desc || ""} ${t.note || ""}`.toLowerCase();
      return kws.some(kw => hay.includes(kw));
    }) : [];
    const paid = matchedTxns.reduce((s, t) => s + Math.abs(parseFloat(t.amount) || 0), 0);
    // Priority: manual override > keyword-computed > origBalance
    const currentBalance = manual > 0 ? manual : (kws.length && orig > 0 ? Math.max(0, orig - paid) : orig);
    const auto = !manual && kws.length > 0 && orig > 0;
    const pct  = orig > 0 ? Math.min(100, Math.round(((orig - currentBalance) / orig) * 100)) : 0;
    const monthsLeft = (pmt > 0 && currentBalance > 0) ? Math.ceil(currentBalance / pmt) : (currentBalance <= 0 ? 0 : null);
    return { currentBalance, pct, paid, auto, monthsLeft, payoffDate: mkDate(monthsLeft), matchedTxns };
  };

  const totalRelief  = payoffs.filter(p=>enabled.has(p.id)).reduce((s,p)=>s+p.payment,0);
  const projSurplus  = normSurplus + totalRelief;
  const projColor    = projSurplus>=0?"#22c55e":projSurplus>-500?"#f59e0b":"#ef4444";
  const gapBase      = Math.max(1, Math.abs(normSurplus));
  const barData      = payoffs.map(p=>({name:p.name, payment:p.payment, active:enabled.has(p.id), color:p.color}));

  // FieldInput is at module level

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Hero */}
      <Card glow={projColor}>
        <Label>Projected Surplus · Toggle debts to model payoff scenarios</Label>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:12,marginBottom:16}}>
          <div>
            <div style={{fontSize:12,color:MUTED,marginBottom:4}}>With selected payoffs</div>
            <div style={{fontSize:wide?42:34,fontWeight:900,color:projColor,letterSpacing:"-1.5px",fontVariantNumeric:"tabular-nums",lineHeight:1,transition:"color .3s"}}>
              {projSurplus>=0?"+":"−"}{fmt(Math.abs(projSurplus))}/mo
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6,textAlign:"right"}}>
            {[["Gap today","-"+fmt(Math.abs(normSurplus)),"#ef4444"],["Payoff relief","+"+fmt(totalRelief),"#22c55e"]].map(([k,v,c])=>(
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
              {projSurplus>=0?"100% — surplus reached!":Math.round((totalRelief/gapBase)*100)+"% of way to break-even"}
            </span>
          </div>
          <PBar pct={Math.min(100,Math.round((totalRelief/gapBase)*100))} color={projColor} h={8}/>
        </div>
      </Card>

      {/* Bar chart */}
      <Card>
        <Label>Monthly Relief by Debt</Label>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={barData} barSize={wide?36:24} margin={{left:0,right:10,top:20,bottom:0}}>
            <XAxis dataKey="name" tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false}/>
            <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`} width={52}/>
            <Tooltip content={<Tip/>} cursor={{fill:"transparent"}}/>
            <Bar dataKey="payment" name="Monthly relief" radius={[5,5,0,0]}>
              <LabelList dataKey="payment" position="top" formatter={v => v > 0 ? fmt(v) : ""} style={{fontSize:10,fontWeight:700,fill:MUTED}} />
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
          const isAudit = auditOpenId === p.id;
          const stats  = getPayoffStats(isEdit ? editDraft : p);
          return (
            <Card key={p.id} style={{opacity:isOn?1:0.6,transition:"opacity .2s",border:`1px solid ${isEdit?p.color+"66":BORDER}`}}>
              {/* Header row */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:isEdit?14:12,gap:8,flexWrap:isCompactMobile?"wrap":"nowrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0,flexBasis:isCompactMobile?"100%":"auto"}}>
                  <div style={{width:36,height:36,borderRadius:10,background:p.color+"22",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,position:"relative"}}>
                    {isEdit
                      ? <EmojiInput value={editDraft.icon || "💳"} onChange={v=>setEditDraft(d=>({...d,icon:v}))}
                          inputStyle={{width:36,height:36,background:"none",border:"none",fontSize:20,outline:"none",textAlign:"center",cursor:"pointer",borderRadius:10}}/>
                      : <span style={{fontSize:20}}>{p.icon || "💳"}</span>
                    }
                  </div>
                  {isEdit
                    ? <input value={editDraft.name || ""} onChange={e=>setEditDraft(d=>({...d,name:e.target.value}))}
                        style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"5px 10px",color:TEXT,fontSize:16,fontWeight:700,width:140,outline:"none",minWidth:0}}/>
                    : <div style={{minWidth:0}}>
                        <div style={{fontSize:15,fontWeight:700,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.name}</div>
                      </div>
                  }
                </div>
                 <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0,flexWrap:isCompactMobile?"wrap":"nowrap",width:isCompactMobile?"100%":"auto",paddingLeft:isCompactMobile?46:0}}>
                  {!isEdit && <Tag color={p.color}>{stats.payoffDate}</Tag>}
                  <button onClick={() => {
                    if (isEdit) {
                      setPayoffs(prev => prev.map(q => q.id === p.id ? {...q, ...editDraft} : q));
                      setEditId(null); setEditDraft({});
                    } else {
                      setEditId(p.id); setEditDraft({...p});
                    }
                  }} style={{
                    padding:isCompactMobile?"4px 8px":"3px 9px",borderRadius:8,fontSize:isCompactMobile?10:11,fontWeight:700,cursor:"pointer",
                    background:isEdit?p.color+"22":BORDER,color:isEdit?p.color:MUTED,
                    border:`1px solid ${isEdit?p.color:BORDER}`,transition:"all .15s",whiteSpace:"nowrap",
                  }}>{isEdit?"Done":"Edit"}</button>
                  <button onClick={()=>toggle(p.id)} style={{
                    padding:isCompactMobile?"4px 8px":"3px 9px",borderRadius:8,fontSize:isCompactMobile?10:11,fontWeight:700,cursor:"pointer",
                    background:isOn?p.color+"22":BORDER,color:isOn?p.color:MUTED,
                    border:`1px solid ${isOn?p.color:BORDER}`,transition:"all .15s",whiteSpace:"nowrap",
                  }}>{isOn?"✓":"Off"}</button>
                  <button onClick={()=>setAuditOpenId(isAudit ? null : p.id)} style={{
                    padding:isCompactMobile?"4px 8px":"3px 9px",borderRadius:8,fontSize:isCompactMobile?10:11,fontWeight:700,cursor:"pointer",
                    background:isAudit?p.color+"22":BORDER,color:isAudit?p.color:MUTED,
                    border:`1px solid ${isAudit?p.color:BORDER}`,transition:"all .15s",whiteSpace:"nowrap",
                  }}>Audit ({stats.matchedTxns.length})</button>
                </div>
              </div>
              {!isEdit && (
                <div style={{display:"flex",alignItems:"center",gap:6,marginTop:-4,marginBottom:10,paddingLeft:46}}>
                  <span style={{fontSize:12,color:MUTED}}>Balance: {fmt(stats.currentBalance)}</span>
                  {stats.auto && <span style={{fontSize:10,background:p.color+"22",color:p.color,borderRadius:4,padding:"1px 5px",fontWeight:700}}>auto</span>}
                </div>
              )}

              {/* Edit mode fields */}
              {isEdit ? (
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                  <FieldInput label="Monthly Payment $" val={editDraft.payment ?? ""}
                    onChange={v=>setEditDraft(d=>({...d,payment:parseFloat(v)||0}))} type="number" placeholder="460"/>
                  <FieldInput label="Orig. Balance $" val={editDraft.origBalance ?? editDraft.balance ?? ""}
                    onChange={v=>{const n=parseFloat(v)||0; setEditDraft(d=>({...d,origBalance:n,balance:n}));}} type="number" placeholder="12000"/>
                  <FieldInput label="Current Balance $ (override)" val={editDraft.manualBalance || ""}
                    onChange={v=>setEditDraft(d=>({...d,manualBalance:parseFloat(v)||0}))} type="number" placeholder="Leave blank for auto"/>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>Icon</div>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <EmojiInput value={editDraft.icon || "💳"} onChange={v=>setEditDraft(d=>({...d,icon:v}))}
                        inputStyle={{width:44,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"5px 4px",color:TEXT,fontSize:20,outline:"none",textAlign:"center",cursor:"pointer"}}/>
                      <span style={{fontSize:10,color:MUTED}}>Click to pick · or press <kbd style={{background:"#1e2535",border:`1px solid ${BORDER}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontFamily:"monospace"}}>Win + .</kbd></span>
                    </div>
                  </div>
                  <div style={{gridColumn:"1/-1"}}>
                    <FieldInput label="Filter Keywords (comma-separated)" val={editDraft.keywords || ""}
                      onChange={v=>setEditDraft(d=>({...d,keywords:v}))} placeholder="car loan, capital one, auto pay"/>
                    <div style={{fontSize:10,color:MUTED,marginTop:4}}>Transactions whose description matches any keyword count as payments. Overridden by manual current balance if set.</div>
                  </div>
                  {/* Computed preview — updates live as draft fields change, chart updates on Done */}
                  {(() => {
                    const s = getPayoffStats(editDraft);
                    const col = editDraft.color || p.color;
                    return (
                      <div style={{gridColumn:"1/-1",background:BG,borderRadius:8,padding:"10px 12px",border:`1px solid ${BORDER}`}}>
                        <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:8}}>Computed</div>
                        <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                          <div>
                            <div style={{fontSize:10,color:MUTED,marginBottom:2}}>Current Balance</div>
                            <div style={{fontSize:14,fontWeight:700,color:col}}>
                              {fmt(s.currentBalance)}
                              {s.auto && <span style={{marginLeft:5,fontSize:10,background:col+"22",color:col,borderRadius:4,padding:"1px 4px"}}>auto</span>}
                            </div>
                          </div>
                          <div>
                            <div style={{fontSize:10,color:MUTED,marginBottom:2}}>Months Left</div>
                            <div style={{fontSize:14,fontWeight:700,color:col}}>{s.monthsLeft !== null ? s.monthsLeft : "TBD"}</div>
                          </div>
                          <div>
                            <div style={{fontSize:10,color:MUTED,marginBottom:2}}>Payoff Date</div>
                            <div style={{fontSize:14,fontWeight:700,color:col}}>{s.payoffDate}</div>
                          </div>
                          <div>
                            <div style={{fontSize:10,color:MUTED,marginBottom:2}}>Progress</div>
                            <div style={{fontSize:14,fontWeight:700,color:col}}>{s.pct}%</div>
                          </div>
                        </div>
                        
                      </div>
                    );
                  })()}
                  <div>
                    <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px",marginBottom:6}}>Color</div>
                    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                      {PAYOFF_COLORS.map(c=>(
                        <button key={c} onClick={()=>setEditDraft(d=>({...d,color:c}))} style={{
                          width:20,height:20,borderRadius:5,background:c,border:`2px solid ${(editDraft.color||"")===c?"white":"transparent"}`,
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
                  <div style={{fontSize:12,color:MUTED}}>{stats.monthsLeft !== null ? stats.monthsLeft + " mo left" : "TBD"}</div>
                </div>
              )}

              <PBar pct={stats.pct} color={isOn?p.color:MUTED} h={7}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                <span style={{fontSize:11,color:DIM}}>Progress toward payoff</span>
                <span style={{fontSize:11,color:DIM}}>{stats.pct}%</span>
              </div>
              {isAudit && (
                <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${BORDER}`}}>
                  {(p.keywords || "").trim().length === 0 ? (
                    <div style={{fontSize:11,color:MUTED}}>No keywords set. Add keywords in Edit mode to enable transaction matching.</div>
                  ) : (
                    <>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontSize:11,color:MUTED,fontWeight:700}}>Matched transactions ({stats.matchedTxns.length})</span>
                        <span style={{fontSize:11,color:p.color,fontWeight:700}}>Counted: {fmt(stats.paid)}</span>
                      </div>
                      {stats.matchedTxns.length === 0 ? (
                        <div style={{fontSize:11,color:MUTED}}>No matching transactions found for current keywords.</div>
                      ) : (
                        <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:150,overflowY:"auto"}}>
                          {stats.matchedTxns.map((t,i)=>(
                            <div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11}}>
                              <span style={{color:MUTED,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",flex:1}}>
                                {t.month} · {t.date} · {t.desc}
                              </span>
                              <span style={{color:p.color,fontWeight:700,flexShrink:0}}>{fmt(Math.abs(t.amount || 0))}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
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
              <FieldInput label="Orig. Balance $" val={newDebt.balance} onChange={v=>setNewDebt(p=>({...p,balance:v}))} placeholder="12000"/>
              <FieldInput label="Current Balance $ (optional override)" val={newDebt.manualBalance} onChange={v=>setNewDebt(p=>({...p,manualBalance:v}))} type="number" placeholder="Leave blank for auto"/>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <div style={{fontSize:10,color:MUTED,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>Icon</div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <EmojiInput value={newDebt.icon} onChange={v=>setNewDebt(p=>({...p,icon:v}))}
                    inputStyle={{width:44,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"5px 4px",color:TEXT,fontSize:20,outline:"none",textAlign:"center",cursor:"pointer"}}/>
                  <span style={{fontSize:10,color:MUTED}}><kbd style={{background:"#1e2535",border:`1px solid ${BORDER}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontFamily:"monospace"}}>Win + .</kbd> for more</span>
                </div>
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
              <div style={{gridColumn:"1/-1"}}>
                <FieldInput label="Filter Keywords (comma-separated)" val={newDebt.keywords} onChange={v=>setNewDebt(p=>({...p,keywords:v}))} placeholder="car loan, capital one, auto pay"/>
                <div style={{fontSize:10,color:MUTED,marginTop:4}}>Transactions matching these keywords auto-compute balance and payoff date. Optional.</div>
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
function Categories({wide, isMobile, activeTab: activeTabProp, setActiveTab: setActiveTabProp}) {
  const { summaryRows, selectedMonth, checkTxns, ccTxns, groceryGoal, setGroceryGoal } = useBudget();
  const [localActiveTab, setLocalActiveTab] = useState("spending");
  const activeTab = activeTabProp ?? localActiveTab;
  const setActiveTab = setActiveTabProp ?? setLocalActiveTab;
  const [selectedCat, setSelectedCat] = useState("Groceries");
  const [selectedVendors, setSelectedVendors] = useState([]);
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

  // Reset selection/expand when category changes
  useEffect(() => { setSelectedVendors([]); setExpandedVendor(null); }, [cat]);

  const total = vendors.reduce((s,x) => s + x.total, 0);
  const selectedTotal = selectedVendors.length
    ? vendors.filter(v => selectedVendors.includes(v.name)).reduce((s, v) => s + v.total, 0)
    : total;
  const goal = isGroceries ? groceryGoal : (catRow ? catRow.kc : null);
  const gap = goal ? total - goal : null;
  const gapColor = gap == null ? color : gap > 0 ? "#ef4444" : "#22c55e";

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {[["spending","📂 Spending Categories"],["income","💵 Income"]].map(([tab,label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            padding:"9px 18px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",
            background:activeTab===tab?ACCENT+"22":BG,color:activeTab===tab?ACCENT:MUTED,
            border:`1px solid ${activeTab===tab?ACCENT:BORDER}`,transition:"all .15s",
          }}>{label}</button>
        ))}
      </div>

      {activeTab === "income" ? <IncomePage wide={wide}/> : (
        <>
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
          <div style={{fontSize:14}}>Import a statement from <strong style={{color:ACCENT}}>Transactions</strong> using <strong style={{color:ACCENT}}>📥 Import Statement</strong> — transactions categorized as <strong>{cat}</strong> will appear here automatically.</div>
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
            <Label>{isGroceries?"Spending by Store":"Spending by Vendor"} · Click to select multiple</Label>
            <ResponsiveContainer width="100%" height={190}>
              <BarChart data={vendors.map(s=>({name:s.name,amount:s.total}))} barSize={wide?36:24} margin={{left:0,right:10,top:20,bottom:0}}
                onClick={d=>{
                  if(d?.activeTooltipIndex==null) return;
                  const vendor = vendors[d.activeTooltipIndex]?.name;
                  if(!vendor) return;
                  setSelectedVendors(prev => prev.includes(vendor) ? prev.filter(v => v !== vendor) : [...prev, vendor]);
                }}>
                <XAxis dataKey="name" tick={{fontSize:9,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>v.slice(0,7)} interval={0}/>
                <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${v}`} width={52}/>
                <Tooltip content={<Tip/>} cursor={{fill:"transparent"}}/>
                <Bar dataKey="amount" name="Spend" radius={[5,5,0,0]} cursor="pointer">
                  <LabelList
                    dataKey="amount"
                    position="top"
                    formatter={v => v > 0 ? fmt(v) : ""}
                    style={{fontSize:10,fontWeight:700,fill:MUTED}}
                  />
                  {vendors.map((s,i)=>(
                    <Cell key={i} fill={s.color} opacity={selectedVendors.length===0||selectedVendors.includes(s.name)?1:0.2}/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {selectedVendors.length > 0 && (
              <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:12,color:MUTED}}>
                  Selected: <strong style={{color:TEXT}}>{selectedVendors.length}</strong> vendor{selectedVendors.length!==1?"s":""} · {fmt(selectedTotal)} of {fmt(total)}
                </span>
                <button onClick={()=>setSelectedVendors([])} style={{padding:"2px 8px",borderRadius:6,background:BORDER,border:`1px solid ${BORDER}`,color:MUTED,fontSize:11,cursor:"pointer"}}>Clear</button>
              </div>
            )}
          </Card>

          {/* Vendor/store rows with expandable transactions */}
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <Label>{isGroceries?"By Store":"By Vendor"}</Label>
              {selectedVendors.length > 0 && <Tag color={color}>Selected {selectedVendors.length} · {fmt(selectedTotal)}</Tag>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:wide?"1fr 1fr":"1fr",gap:wide?"0 32px":0}}>
              {vendors.map(s=>{
                const pct=(s.total/total)*100;
                const isSpot=selectedVendors.includes(s.name);
                const isOther=selectedVendors.length>0&&!isSpot;
                const isExp=expandedVendor===s.name;
                return (
                  <div key={s.name} style={{
                    marginBottom:8,borderRadius:12,overflow:"hidden",
                    border:`1px solid ${isSpot?s.color+"44":isExp?s.color+"33":"transparent"}`,
                    background:isSpot?s.color+"12":isExp?s.color+"08":"transparent",
                    opacity:isOther?0.35:1,transition:"all .2s",
                  }}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",cursor:"pointer"}}
                      onClick={()=>setSelectedVendors(prev => prev.includes(s.name) ? prev.filter(v => v !== s.name) : [...prev, s.name])}>
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
                                {getTxnDisplayNote(t.note)&&<div style={{fontSize:10,color:DIM,marginTop:1}}>{getTxnDisplayNote(t.note)}</div>}
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
        </>
      )}
    </div>
  );
}

// Stable CatSelect — defined outside TxnTable so it doesn't remount every render
function CatSelect({ t, src, updateTxnCat }) {
  const { allCats, catColorsAll } = useBudget();
  const color = catColorsAll[t.cat] || MUTED;
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

function SubcatSelect({ cat, value, onChange, placeholder = "No subcategory", style, includeCurrent = true }) {
  const { subcatsByCat } = useBudget();
  const options = getCategorySubcategoryOptions(subcatsByCat, cat, includeCurrent ? value : "");
  const normalizedValue = normalizeTxnSubcategory(value);
  const selectValue = normalizedValue && options.some(option => option.toLowerCase() === normalizedValue.toLowerCase()) ? normalizedValue : "";
  return (
    <select value={selectValue} onChange={e => onChange(e.target.value)} style={style}>
      <option value="">{options.length ? placeholder : "No subcategories"}</option>
      {options.map(option => <option key={option} value={option} style={{background:"#161b27"}}>{option}</option>)}
    </select>
  );
}

// ── SPLIT TRANSACTION MODAL ───────────────────────────────────────────────────
function SplitModal({ txn, src, onClose }) {
  const { replaceTxn, allCats, subcatsByCat } = useBudget();
  const receiptCats = getReceiptBudgetCats(allCats);
  const fallbackSplitCat = receiptCats.includes("Snacks/Misc") ? "Snacks/Misc" : (receiptCats[0] || allCats[0]);
  const [parts, setParts] = useState([
    { desc: txn.desc, amount: txn.amount, cat: txn.cat, subcat: normalizeTxnSubcategory(txn.subcat) },
    { desc: "", amount: 0, cat: fallbackSplitCat, subcat: "" },
  ]);
  const [parsing, setParsing] = useState(false);
  const [parseErr, setParseErr] = useState(null);
  const [imgPreview, setImgPreview] = useState(null);

  const total = parts.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const remaining = txn.amount - total;
  const isBalanced = Math.abs(remaining) < 0.01;

  const updatePart = (i, field, val) =>
    setParts(prev => prev.map((p, idx) => {
      if (idx !== i) return p;
      const next = { ...p, [field]: val };
      if (field === "cat") next.subcat = coerceTxnSubcategoryForCategory(subcatsByCat, val, p.subcat);
      return next;
    }));
  const addPart = () => setParts(prev => [...prev, { desc: "", amount: 0, cat: fallbackSplitCat, subcat: "" }]);
  const removePart = (i) => {
    if (!confirmDeleteAction("Remove this split line?")) return;
    setParts(prev => prev.filter((_, idx) => idx !== i));
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setImgPreview(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const parseReceipt = async () => {
    if (!imgPreview) { setParseErr("Upload a receipt image first."); return; }
    setParsing(true); setParseErr(null);
    try {
      const parsed = await requestReceiptParseFromAI({
        imageDataUrl: imgPreview,
        allCats,
        expectedTotal: txn.amount,
        merchantHint: txn.desc,
        dateHint: txn.date,
        fallbackYear: deriveTxnYear(txn),
      });
      setParts(parsed.items.map(item => ({
        desc: item.desc || "",
        amount: item.amount,
        cat: allCats.includes(item.cat) ? item.cat : fallbackSplitCat,
        subcat: coerceTxnSubcategoryForCategory(subcatsByCat, allCats.includes(item.cat) ? item.cat : fallbackSplitCat, item.subcat),
      })));
    } catch (e) { setParseErr("Parse failed: " + e.message); }
    setParsing(false);
  };

  const confirm = () => {
    if (!isBalanced) return;
    const splits = parts.filter(p => parseFloat(p.amount) > 0).map(p => ({
      desc: p.desc || txn.desc,
      amount: parseFloat(p.amount),
      cat: p.cat,
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, p.cat, p.subcat, { allowLegacy: true }),
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
          <div style={{overflowX:"auto"}}>
            <div style={{minWidth:520}}>
              <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 90px 120px 130px 28px",gap:6,padding:"0 2px",marginBottom:6}}>
                {["Description","Amount","Category","Subcategory",""].map(h => <div key={h} style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>{h}</div>)}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {parts.map((p, i) => (
                  <div key={i} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 90px 120px 130px 28px",gap:6,alignItems:"center"}}>
                    <input value={p.desc} onChange={e => updatePart(i, "desc", e.target.value)} placeholder={txn.desc}
                      style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
                    <input type="number" value={p.amount || ""} onChange={e => updatePart(i, "amount", e.target.value)} step="0.01" min="0" placeholder="0.00"
                      style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%",fontVariantNumeric:"tabular-nums"}}/>
                    <select value={p.cat} onChange={e => updatePart(i, "cat", e.target.value)}
                      style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 8px",color:TEXT,fontSize:12,outline:"none",width:"100%"}}>
                      {allCats.map(c => <option key={c} style={{background:"#161b27"}}>{c}</option>)}
                    </select>
                    <SubcatSelect cat={p.cat} value={p.subcat} onChange={val => updatePart(i, "subcat", val)} includeCurrent
                      style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 8px",color:TEXT,fontSize:12,outline:"none",width:"100%"}}/>
                    <button onClick={() => removePart(i)} disabled={parts.length <= 1}
                      style={{background:"#ef444415",border:"none",borderRadius:6,color:parts.length<=1?BORDER:"#ef4444",fontSize:13,cursor:parts.length<=1?"default":"pointer",padding:"4px 0",width:28,textAlign:"center"}}>✕</button>
                  </div>
                ))}
              </div>
            </div>
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
  const {
    checkTxns, ccTxns,
    updateTxnCat, updateTxn, deleteTxn, replaceTxn,
    selectedMonth, selectedYear, availableMonths, addTxns,
    allCats, catColorsAll, subcatsByCat, toggleTxnTagging,
    mobileTxnActionMenu, oneTimes, setOneTimes, recurringItems, setRecurringItems,
  } = useBudget();
  const [splitTxn, setSplitTxn] = useState(null); // txn being split
  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState({ date:"", desc:"", amount:"", note:"", subcat:"", cat:"" });
  const allTxns = src === "checking" ? checkTxns : ccTxns;

  const [monthFilter, setMonthFilter] = useState(selectedMonth);
  const [catFilter,   setCatFilter]   = useState("All");
  const [search,      setSearch]      = useState("");
  const [sortBy,      setSortBy]      = useState("date_desc");
  const [openMenuId,  setOpenMenuId]  = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const desktopTxnCols = "70px minmax(220px,1fr) 130px 180px 290px 70px";
  const desktopTxnMinW = 1050;
  const money2 = useCallback((n) => new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(Number(n) || 0)), []);

  // Keep monthFilter in sync when global month changes
  useEffect(() => { setMonthFilter(selectedMonth); }, [selectedMonth]);

  const filtered = allTxns
    .filter(t => t.month === monthFilter)
    .filter(t => catFilter === "All" || t.cat === catFilter)
    .filter(t => !search || t.desc.toLowerCase().includes(search.toLowerCase()) || t.cat.toLowerCase().includes(search.toLowerCase()) || normalizeTxnSubcategory(t.subcat).toLowerCase().includes(search.toLowerCase()) || (t.note || "").toLowerCase().includes(search.toLowerCase()))
    .slice()
    .sort((a,b) => {
      if (sortBy === "date_asc") return a.date.localeCompare(b.date);
      if (sortBy === "date_desc") return b.date.localeCompare(a.date);
      if (sortBy === "amount_asc") return a.amount - b.amount;
      if (sortBy === "amount_desc") return b.amount - a.amount;
      if (sortBy === "desc_asc") return (a.desc || "").localeCompare(b.desc || "");
      if (sortBy === "desc_desc") return (b.desc || "").localeCompare(a.desc || "");
      return 0;
    });

  const visibleTotal = filtered.filter(t => t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t) => s + t.amount, 0);

  // ── Manual add form ──────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [newDate, setNewDate] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAmt,  setNewAmt]  = useState("");
  const [newCat,  setNewCat]  = useState(allCats[0]);
  const [newSubcat, setNewSubcat] = useState("");
  const [addAttempted, setAddAttempted] = useState(false);
  const [addFeedback, setAddFeedback] = useState(null); // {type:"error"|"success", text:string}
  const [receiptImgPreview, setReceiptImgPreview] = useState(null);
  const [receiptParsing, setReceiptParsing] = useState(false);
  const [receiptParseErr, setReceiptParseErr] = useState(null);
  const [receiptParts, setReceiptParts] = useState([]);
  const [receiptMeta, setReceiptMeta] = useState({
    merchant: "",
    dateIso: "",
    total: 0,
    totalNote: "",
    audit: { observedTotals: {}, rows: [], warnings: [] },
  });
  const receiptCats = getReceiptBudgetCats(allCats);
  const fallbackReceiptCat = receiptCats.includes("Snacks/Misc") ? "Snacks/Misc" : (receiptCats[0] || allCats[0]);
  useEffect(() => { if (addFeedback) setAddFeedback(null); }, [monthFilter, catFilter, search, sortBy, showAdd]); // eslint-disable-line react-hooks/exhaustive-deps
  const receiptAllocatedTotal = roundMoney(receiptParts.reduce((sum, part) => sum + (parseFloat(part.amount) || 0), 0));
  const enteredReceiptTotal = parseFloat(newAmt);
  const receiptTargetTotal = receiptParts.length
    ? (Number.isFinite(enteredReceiptTotal) ? roundMoney(enteredReceiptTotal) : receiptAllocatedTotal)
    : 0;
  const receiptRemaining = roundMoney(receiptTargetTotal - receiptAllocatedTotal);
  const receiptBalanced = !receiptParts.length || Math.abs(receiptRemaining) < 0.01;
  const receiptAuditObserved = receiptMeta.audit?.observedTotals || {};
  const receiptAuditRows = Array.isArray(receiptMeta.audit?.rows) ? receiptMeta.audit.rows : [];
  const receiptAuditWarnings = Array.isArray(receiptMeta.audit?.warnings) ? receiptMeta.audit.warnings : [];
  const currentSplitSummary = useMemo(() => collapseReceiptAuditRowsByBudgetBucket(
    receiptParts.map(part => ({
      cat: part.cat,
      subcat: part.subcat,
      itemsTotal: parseFloat(part.amount) || 0,
      finalTotal: parseFloat(part.amount) || 0,
    })),
    receiptMeta.merchant || newDesc,
  ), [receiptParts, receiptMeta.merchant, newDesc]);
  const hasReceiptObservedTotals = !!receiptAuditObserved.totalLabel
    || ["subtotal", "tax", "preCreditTotal", "creditApplied", "paidTotal"].some(key => Number(receiptAuditObserved?.[key]) > 0);

  const resetReceiptDraft = () => {
    setReceiptImgPreview(null);
    setReceiptParsing(false);
    setReceiptParseErr(null);
    setReceiptParts([]);
    setReceiptMeta({
      merchant: "",
      dateIso: "",
      total: 0,
      totalNote: "",
      audit: { observedTotals: {}, rows: [], warnings: [] },
    });
  };

  const updateReceiptPart = (idx, field, value) => {
    setReceiptParts(prev => prev.map((part, partIdx) => {
      if (partIdx !== idx) return part;
      const next = { ...part, [field]: value };
      if (field === "cat") next.subcat = coerceTxnSubcategoryForCategory(subcatsByCat, value, part.subcat);
      return next;
    }));
  };
  const addReceiptPart = () => setReceiptParts(prev => [...prev, { desc: "", amount: 0, cat: fallbackReceiptCat, subcat: "" }]);
  const removeReceiptPart = (idx) => {
    if (!confirmDeleteAction("Remove this receipt split line?")) return;
    setReceiptParts(prev => prev.filter((_, partIdx) => partIdx !== idx));
  };
  const handleReceiptUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setReceiptParseErr(null);
    const reader = new FileReader();
    reader.onload = ev => setReceiptImgPreview(String(ev.target?.result || ""));
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  const parseReceiptForAdd = async () => {
    if (!receiptImgPreview) { setReceiptParseErr("Upload a receipt image first."); return; }
    setReceiptParsing(true);
    setReceiptParseErr(null);
    setAddFeedback(null);
    try {
      const parsed = await requestReceiptParseFromAI({
        imageDataUrl: receiptImgPreview,
        allCats,
        expectedTotal: parseFloat(newAmt),
        merchantHint: newDesc,
        dateHint: newDate,
        fallbackYear: selectedYear,
      });
      setReceiptMeta({
        merchant: parsed.merchant || "",
        dateIso: parsed.dateIso || "",
        total: parsed.total || 0,
        totalNote: parsed.totalNote || "",
        audit: parsed.audit || { observedTotals: {}, rows: [], warnings: [] },
      });
      setReceiptParts(parsed.items.map(item => ({
        desc: item.desc || "",
        amount: item.amount,
        cat: allCats.includes(item.cat) ? item.cat : fallbackReceiptCat,
        subcat: coerceTxnSubcategoryForCategory(subcatsByCat, allCats.includes(item.cat) ? item.cat : fallbackReceiptCat, item.subcat),
      })));
      if (!newDesc.trim() && parsed.merchant) setNewDesc(parsed.merchant);
      if (!newDate && parsed.dateIso) setNewDate(parsed.dateIso);
      if ((newAmt === "" || Number.isNaN(parseFloat(newAmt))) && parsed.total > 0) setNewAmt(parsed.total.toFixed(2));
    } catch (err) {
      setReceiptParseErr("Parse failed: " + err.message);
    }
    setReceiptParsing(false);
  };

  const submitManual = () => {
    setAddAttempted(true);
    const missing = [];
    if (!newDate) missing.push("Date");
    if (!receiptParts.length && !newDesc.trim()) missing.push("Description");
    if (!receiptParts.length && Number.isNaN(parseFloat(newAmt))) missing.push("Amount");
    if (missing.length) {
      setAddFeedback({ type: "error", text: `Required: ${missing.join(", ")}` });
      return;
    }
    const dateParts = newDate.split("-");
    if (!dateParts || dateParts.length !== 3) {
      setAddFeedback({ type: "error", text: "Date is required in YYYY-MM-DD format." });
      return;
    }
    const mm = dateParts[1];
    const dd = dateParts[2];
    const monthIdx = Math.max(0, Math.min(11, Number(mm) - 1));
    const month = APP_MONTHS[monthIdx] || selectedMonth;
    const date = `${mm}/${dd}`;
    if (receiptParts.length) {
      if (!receiptBalanced) {
        setAddFeedback({ type: "error", text: `Receipt split must match ${money2(receiptTargetTotal)} before saving.` });
        return;
      }
      const merchantLabel = newDesc.trim() || receiptMeta.merchant || "";
      const cleanedParts = receiptParts
        .map((part, idx) => {
          const amount = roundMoney(parseFloat(part.amount));
          if (!Number.isFinite(amount) || amount <= 0) return null;
          return {
            desc: buildReceiptSplitDesc(merchantLabel, String(part.desc || "").trim() || `item ${idx + 1}`),
            amount,
            cat: allCats.includes(part.cat) ? part.cat : fallbackReceiptCat,
            subcat: coerceTxnSubcategoryForCategory(subcatsByCat, allCats.includes(part.cat) ? part.cat : fallbackReceiptCat, part.subcat),
          };
        })
        .filter(Boolean);
      if (!cleanedParts.length) {
        setAddFeedback({ type: "error", text: "Receipt split has no valid lines to save." });
        return;
      }
      const splitParentDesc = merchantLabel || "Receipt purchase";
      const splitParentAmount = roundMoney(receiptTargetTotal > 0 ? receiptTargetTotal : cleanedParts.reduce((sum, part) => sum + part.amount, 0));
      const splitGroupId = cleanedParts.length > 1 ? makeTxnId("sg", new Set()) : "";
      addTxns(src, cleanedParts.map(part => ({
        date,
        desc: part.desc,
        amount: part.amount,
        cat: part.cat,
        subcat: part.subcat,
        month,
        note: "",
        ...(cleanedParts.length > 1 ? {
          splitGroupId,
          splitParentId: splitGroupId,
          splitParentDesc,
          splitParentAmount,
        } : {}),
      })));
      setNewDesc(""); setNewAmt(""); setNewDate(""); setNewCat(allCats[0]); setNewSubcat("");
      resetReceiptDraft();
      setAddAttempted(false);
      setAddFeedback({ type: "success", text: `Saved ${cleanedParts.length} split transactions to ${month}.` });
      setShowAdd(false);
      return;
    }
    const amount = parseFloat(newAmt);
    addTxns(src, [{ date, desc: newDesc.trim(), amount, cat: newCat, subcat: coerceTxnSubcategoryForCategory(subcatsByCat, newCat, newSubcat), month, note: "" }]);
    setNewDesc(""); setNewAmt(""); setNewDate(""); setNewCat(allCats[0]); setNewSubcat("");
    resetReceiptDraft();
    setAddAttempted(false);
    setAddFeedback({ type: "success", text: `Saved transaction to ${month}.` });
    setShowAdd(false);
  };

  const beginEdit = (t) => {
    setEditId(t.id);
    setEditDraft({ date: t.date || "", desc: t.desc || "", amount: String(t.amount ?? ""), note: t.note || "", subcat: normalizeTxnSubcategory(t.subcat), cat: t.cat || "" });
  };
  const cancelEdit = () => {
    setEditId(null);
    setEditDraft({ date:"", desc:"", amount:"", note:"", subcat:"", cat:"" });
  };
  const saveEdit = () => {
    const amt = parseFloat(editDraft.amount);
    if (!editId || !editDraft.desc.trim() || Number.isNaN(amt)) return;
    updateTxn(src, editId, {
      date: editDraft.date.trim(),
      desc: editDraft.desc.trim(),
      amount: amt,
      note: editDraft.note || "",
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, editDraft.cat, editDraft.subcat, { allowLegacy: true }),
    });
    cancelEdit();
  };
  useEffect(() => {
    if (!editId) return;
    const currentTxn = allTxns.find(t => t.id === editId);
    if (!currentTxn || currentTxn.cat === editDraft.cat) return;
    setEditDraft(prev => ({
      ...prev,
      cat: currentTxn.cat || "",
      subcat: normalizeTxnSubcategory(currentTxn.subcat),
    }));
  }, [editId, editDraft.cat, allTxns]);

  const isOneTimeTxn = useCallback((t) => {
    const hasNoteFlag = hasTxnNoteFlag(t.note, "ONE-TIME");
    if (hasNoteFlag) return true;
    return oneTimes.some(o =>
      (o.cat || "") === (t.cat || "") &&
      (o.name || "").trim().toLowerCase() === (t.desc || "").trim().toLowerCase() &&
      Math.abs((Number(o.amount) || 0) - Math.abs(Number(t.amount) || 0)) < 0.01
    );
  }, [oneTimes]);

  const toggleOneTimeTxn = useCallback((t) => {
    const current = isOneTimeTxn(t);
    if (current) {
      setOneTimes(prev => prev.filter(o => !(
        (o.cat || "") === (t.cat || "") &&
        (o.name || "").trim().toLowerCase() === (t.desc || "").trim().toLowerCase() &&
        Math.abs((Number(o.amount) || 0) - Math.abs(Number(t.amount) || 0)) < 0.01
      )));
    } else {
      setOneTimes(prev => {
        const exists = prev.some(o =>
          (o.cat || "") === (t.cat || "") &&
          (o.name || "").trim().toLowerCase() === (t.desc || "").trim().toLowerCase() &&
          Math.abs((Number(o.amount) || 0) - Math.abs(Number(t.amount) || 0)) < 0.01
        );
        if (exists) return prev;
        return [...prev, { name: t.desc || "One-time expense", amount: Math.abs(Number(t.amount) || 0), cat: t.cat }];
      });
    }

    const nextNote = withTxnNoteFlag(t.note, "ONE-TIME", !current);
    updateTxn(src, t.id, { date: t.date, desc: t.desc, amount: t.amount, note: nextNote });
  }, [isOneTimeTxn, setOneTimes, updateTxn, src]);

  const isRecurringTxn = useCallback((t) => {
    const hasNoteFlag = hasTxnNoteFlag(t.note, "RECURRING");
    if (hasNoteFlag) return true;
    const txnSig = fingerprintTxnDesc(t.desc || "");
    return recurringItems.some(item =>
      (item.cat || "") === (t.cat || "")
      && (item.src || "") === src
      && Math.abs((Number(item.amount) || 0) - Math.abs(Number(t.amount) || 0)) < 0.01
      && fingerprintTxnDesc(item.name || "") === txnSig
    );
  }, [recurringItems, src]);

  const toggleRecurringTxn = useCallback((t) => {
    const current = isRecurringTxn(t);
    const nextItem = {
      name: t.desc || "Recurring expense",
      amount: Math.abs(Number(t.amount) || 0),
      cat: t.cat,
      src,
      startDate: t.date || "",
      startMonth: deriveTxnMonth(t) || selectedMonth,
      startYear: deriveTxnYear(t, selectedYear) || selectedYear,
    };
    const nextKey = buildRecurringItemKey(nextItem);
    if (current) {
      setRecurringItems(prev => {
        const matchIdx = prev.findIndex(item => recurringTxnMatchesItem({ ...t, src }, item));
        if (matchIdx < 0) return prev.filter(item => buildRecurringItemKey(item) !== nextKey);
        return prev.filter((_, idx) => idx !== matchIdx);
      });
    } else {
      setRecurringItems(prev => prev.some(item => buildRecurringItemKey(item) === nextKey) ? prev : [...prev, nextItem]);
    }
    const nextNote = withTxnNoteFlag(t.note, "RECURRING", !current);
    updateTxn(src, t.id, { date: t.date, desc: t.desc, amount: t.amount, note: nextNote });
  }, [isRecurringTxn, selectedMonth, selectedYear, setRecurringItems, src, updateTxn]);

  const requestDeleteTxn = useCallback((t) => {
    setPendingDelete({ id: t.id, desc: t.desc || "Transaction", date: t.date || "", amount: Number(t.amount) || 0 });
  }, []);

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {splitTxn && <SplitModal txn={splitTxn} src={src} onClose={() => setSplitTxn(null)}/>}
      {pendingDelete && (
        <div style={{position:"fixed",inset:0,background:"#000000aa",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}
          onClick={e => { if (e.target === e.currentTarget) setPendingDelete(null); }}>
          <div style={{width:"100%",maxWidth:420,background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:14,padding:"16px 16px 14px"}}>
            <div style={{fontSize:16,fontWeight:800,color:TEXT,marginBottom:8}}>Delete transaction?</div>
            <div style={{fontSize:12,color:MUTED,lineHeight:1.5,marginBottom:12}}>
              {pendingDelete.date ? `${pendingDelete.date} · ` : ""}{pendingDelete.desc} · {money2(pendingDelete.amount)}
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button onClick={() => setPendingDelete(null)}
                style={{padding:"7px 12px",borderRadius:8,background:BG,color:MUTED,border:`1px solid ${BORDER}`,fontSize:12,fontWeight:700}}>Cancel</button>
              <button onClick={() => {
                deleteTxn(src, pendingDelete.id, { force: true });
                setPendingDelete(null);
                setOpenMenuId(null);
              }}
                style={{padding:"7px 12px",borderRadius:8,background:"#ef4444",color:"white",border:"none",fontSize:12,fontWeight:800}}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Manual add */}
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <button onClick={()=>setShowAdd(v=>!v)}
          style={{padding:"8px 18px",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",
            background:showAdd?ACCENT+"22":SURFACE, color:showAdd?ACCENT:MUTED,
            border:`1px solid ${showAdd?ACCENT:BORDER}`,transition:"all .15s"}}>
          {showAdd ? "✕ Cancel" : "+ Add Transaction"}
        </button>
      </div>
      {addFeedback && (
        <div style={{
          fontSize:12,
          borderRadius:8,
          padding:"8px 10px",
          background:addFeedback.type==="error" ? "#ef444411" : "#22c55e11",
          color:addFeedback.type==="error" ? "#ef4444" : "#22c55e",
          border:`1px solid ${addFeedback.type==="error" ? "#ef444433" : "#22c55e33"}`,
          display:"flex",
          alignItems:"center",
          justifyContent:"space-between",
          gap:8,
        }}>
          <span>{addFeedback.text}</span>
          <button onClick={() => setAddFeedback(null)}
            style={{background:"transparent",border:`1px solid ${addFeedback.type==="error" ? "#ef444455" : "#22c55e55"}`,borderRadius:6,color:addFeedback.type==="error" ? "#ef4444" : "#22c55e",fontSize:11,padding:"2px 7px",cursor:"pointer"}}>
            Dismiss
          </button>
        </div>
      )}
      {showAdd && (
        <Card glow={ACCENT}>
          <Label>➕ New Transaction</Label>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"flex-end"}}>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:"0 0 140px"}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Date</span>
                <input type="date" value={newDate} onChange={e=>{ setNewDate(e.target.value); if (addFeedback) setAddFeedback(null); }}
                  style={{background:BG,border:`1px solid ${addAttempted && !newDate ? "#ef4444" : BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%",colorScheme:"dark"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:"1 1 160px"}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Description</span>
                <input value={newDesc} onChange={e=>{ setNewDesc(e.target.value); if (addFeedback) setAddFeedback(null); }} placeholder="Merchant or payee"
                  style={{background:BG,border:`1px solid ${addAttempted && !receiptParts.length && !newDesc.trim() ? "#ef4444" : BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:"0 0 100px"}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Amount ($)</span>
                <input type="number" value={newAmt} onChange={e=>{ setNewAmt(e.target.value); if (addFeedback) setAddFeedback(null); }} placeholder="0.00" step="0.01"
                  style={{background:BG,border:`1px solid ${addAttempted && !receiptParts.length && Number.isNaN(parseFloat(newAmt)) ? "#ef4444" : BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:"1 1 140px"}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Category</span>
                <select value={newCat} onChange={e=>{ const nextCat = e.target.value; setNewCat(nextCat); setNewSubcat(prev => coerceTxnSubcategoryForCategory(subcatsByCat, nextCat, prev)); if (addFeedback) setAddFeedback(null); }}
                  style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}>
                  {allCats.map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4,flex:"1 1 140px"}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase"}}>Subcategory</span>
                <SubcatSelect cat={newCat} value={newSubcat} onChange={val=>{ setNewSubcat(val); if (addFeedback) setAddFeedback(null); }} includeCurrent={false}
                  style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
              </div>
              <button onClick={submitManual}
                style={{padding:"8px 20px",borderRadius:8,background:ACCENT,color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer",flexShrink:0,alignSelf:"flex-end"}}>
                {receiptParts.length ? `Save ${receiptParts.length} Split${receiptParts.length === 1 ? "" : "s"}` : "Save"}
              </button>
            </div>

            <div style={{fontSize:11,color:MUTED}}>
              Date is required and determines the month automatically. Use a negative amount for credits/refunds. When a receipt split is present, the header category and subcategory are ignored and each parsed row saves separately.
            </div>

            <div style={{background:BG,borderRadius:12,padding:"14px 16px",border:`1px solid #06b6d422`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap",marginBottom:8}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#06b6d4",marginBottom:4}}>📷 AI Receipt Upload (optional)</div>
                  <div style={{fontSize:11,color:MUTED}}>Upload a Costco or store receipt and AI will build editable split lines for you. If you already know the card total, enter it in Amount first and the split will be forced to match it exactly.</div>
                </div>
                {receiptParts.length > 0 && (
                  <button onClick={() => { setReceiptParts([]); setReceiptParseErr(null); }}
                    style={{padding:"6px 10px",borderRadius:8,background:"#33415522",color:MUTED,border:`1px solid ${BORDER}`,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                    Clear Split
                  </button>
                )}
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <label style={{padding:"7px 14px",borderRadius:8,background:"#06b6d422",color:"#06b6d4",border:"1px solid #06b6d444",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                  📷 {receiptImgPreview ? "Change Receipt" : "Upload Receipt"}
                  <input type="file" accept="image/*" capture="environment" onChange={handleReceiptUpload} style={{display:"none"}}/>
                </label>
                {receiptImgPreview && (
                  <button onClick={parseReceiptForAdd} disabled={receiptParsing}
                    style={{padding:"7px 14px",borderRadius:8,background:receiptParsing?"#1e2535":"#8b5cf622",color:receiptParsing?MUTED:"#8b5cf6",border:`1px solid ${receiptParsing?"#1e2535":"#8b5cf644"}`,fontSize:12,fontWeight:700,cursor:receiptParsing?"default":"pointer",whiteSpace:"nowrap"}}>
                    {receiptParsing ? "⏳ Parsing receipt…" : receiptParts.length ? "✨ Re-parse Receipt" : "✨ Parse with AI"}
                  </button>
                )}
                {receiptImgPreview && (
                  <button onClick={resetReceiptDraft}
                    style={{padding:"7px 12px",borderRadius:8,background:"#33415522",color:MUTED,border:`1px solid ${BORDER}`,fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>
                    Remove Receipt
                  </button>
                )}
                {receiptImgPreview && <img src={receiptImgPreview} alt="receipt preview" style={{height:48,borderRadius:6,border:`1px solid ${BORDER}`,objectFit:"cover"}}/>}
              </div>
              {(receiptMeta.merchant || receiptMeta.dateIso || receiptMeta.total > 0) && (
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
                  {receiptMeta.merchant && <Tag color="#06b6d4">{receiptMeta.merchant}</Tag>}
                  {receiptMeta.dateIso && <Tag color="#8b5cf6">{receiptMeta.dateIso}</Tag>}
                  {receiptMeta.total > 0 && <Tag color="#22c55e">{money2(receiptMeta.total)}</Tag>}
                </div>
              )}
              {receiptMeta.totalNote && (
                <div style={{fontSize:11,color:MUTED,marginTop:8}}>
                  Total source: {receiptMeta.totalNote}
                </div>
              )}
              {receiptParts.length > 0 && (
                <div style={{marginTop:12,padding:"12px 14px",borderRadius:10,background:"#0b1220",border:`1px solid ${BORDER}`}}>
                  <div style={{fontSize:12,fontWeight:800,color:TEXT,marginBottom:4}}>Review Before Saving</div>
                  <div style={{fontSize:11,color:MUTED,marginBottom:10}}>
                    These are the parsed results used to build the editable split. Review them here, then change any amount or category below before saving.
                  </div>

                  {hasReceiptObservedTotals && (
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                      {Number(receiptAuditObserved.subtotal) > 0 && <Tag color="#475569">Subtotal {money2(receiptAuditObserved.subtotal)}</Tag>}
                      {Number(receiptAuditObserved.tax) > 0 && <Tag color="#0ea5e9">Tax {money2(receiptAuditObserved.tax)}</Tag>}
                      {Number(receiptAuditObserved.preCreditTotal) > 0 && <Tag color="#f59e0b">Pre-credit {money2(receiptAuditObserved.preCreditTotal)}</Tag>}
                      {Number(receiptAuditObserved.creditApplied) > 0 && <Tag color="#ef4444">Reward/Discount {money2(receiptAuditObserved.creditApplied)}</Tag>}
                      {Number(receiptAuditObserved.paidTotal) > 0 && <Tag color="#22c55e">Paid total {money2(receiptAuditObserved.paidTotal)}</Tag>}
                      {receiptAuditObserved.totalLabel && <Tag color="#8b5cf6">{receiptAuditObserved.totalLabel}</Tag>}
                    </div>
                  )}

                  {receiptAuditWarnings.length > 0 && (
                    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
                      {receiptAuditWarnings.map((warning, idx) => (
                        <div key={`${warning}-${idx}`} style={{fontSize:11,color:"#fbbf24",background:"#f59e0b11",borderRadius:8,padding:"7px 10px",border:"1px solid #f59e0b22"}}>
                          {warning}
                        </div>
                      ))}
                    </div>
                  )}

                  {receiptAuditRows.length > 0 && (
                    <div style={{marginBottom:10}}>
                      <div style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase",marginBottom:6}}>AI Audit Allocation</div>
                      <div style={{overflowX:"auto"}}>
                        <div style={{minWidth:540}}>
                          <div style={{display:"grid",gridTemplateColumns:"minmax(140px,1fr) 84px 84px 108px 92px",gap:8,padding:"0 2px 6px"}}>
                            {["Category","Items","Tax","Reward Applied","Final"].map(label => (
                              <div key={label} style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>{label}</div>
                            ))}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:6}}>
                            {receiptAuditRows.map((row, idx) => (
                              <div key={`${row.cat}-${row.subcat}-${idx}`} style={{display:"grid",gridTemplateColumns:"minmax(140px,1fr) 84px 84px 108px 92px",gap:8,alignItems:"center",background:BG,borderRadius:8,padding:"8px 10px"}}>
                                <div>
                                  <div style={{fontSize:12,color:TEXT,fontWeight:700}}>{row.subcat ? `${row.cat} / ${row.subcat}` : row.cat}</div>
                                  {row.reason && <div style={{fontSize:10,color:MUTED,marginTop:2}}>{row.reason}</div>}
                                </div>
                                <div style={{fontSize:12,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{money2(row.itemsTotal)}</div>
                                <div style={{fontSize:12,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{money2(row.tax)}</div>
                                <div style={{fontSize:12,color:"#fca5a5",fontVariantNumeric:"tabular-nums"}}>-{money2(row.rewardApplied)}</div>
                                <div style={{fontSize:12,color:"#22c55e",fontWeight:800,fontVariantNumeric:"tabular-nums"}}>{money2(row.finalTotal)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {currentSplitSummary.length > 0 && (
                    <div>
                      <div style={{fontSize:11,color:MUTED,fontWeight:700,textTransform:"uppercase",marginBottom:6}}>Current Split Summary</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {currentSplitSummary.map((row, idx) => (
                          <div key={`${row.cat}-${row.subcat}-${idx}`} style={{padding:"8px 10px",borderRadius:8,background:BG,border:`1px solid ${BORDER}`}}>
                            <div style={{fontSize:11,color:MUTED}}>{row.subcat ? `${row.cat} / ${row.subcat}` : row.cat}</div>
                            <div style={{fontSize:13,color:"#22c55e",fontWeight:800,fontVariantNumeric:"tabular-nums"}}>{money2(row.finalTotal)}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontSize:11,color:MUTED,marginTop:8}}>Edit the split lines below and this summary updates live before you save.</div>
                    </div>
                  )}
                </div>
              )}
              {receiptParseErr && <div style={{fontSize:11,color:"#f59e0b",marginTop:8,padding:"6px 10px",background:"#f59e0b11",borderRadius:6}}>{receiptParseErr}</div>}
            </div>

            {receiptParts.length > 0 && (
              <>
                <div style={{marginTop:2}}>
                  <div style={{overflowX:"auto"}}>
                    <div style={{minWidth:650}}>
                      <div style={{display:"grid",gridTemplateColumns:"minmax(170px,1fr) 96px 150px 130px 28px",gap:6,padding:"0 2px",marginBottom:6}}>
                        {["Receipt Split","Amount","Category","Subcategory",""].map(h => (
                          <div key={h} style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".4px"}}>{h}</div>
                        ))}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:6}}>
                        {receiptParts.map((part, idx) => (
                          <div key={idx} style={{display:"grid",gridTemplateColumns:"minmax(170px,1fr) 96px 150px 130px 28px",gap:6,alignItems:"center"}}>
                            <input value={part.desc} onChange={e => updateReceiptPart(idx, "desc", e.target.value)} placeholder={newDesc || "Receipt item"}
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%"}}/>
                            <input type="number" step="0.01" min="0" value={part.amount || ""} onChange={e => updateReceiptPart(idx, "amount", e.target.value)}
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none",width:"100%",fontVariantNumeric:"tabular-nums"}}/>
                            <select value={part.cat} onChange={e => updateReceiptPart(idx, "cat", e.target.value)}
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 8px",color:TEXT,fontSize:12,outline:"none",width:"100%"}}>
                              {allCats.map(cat => <option key={cat} style={{background:"#161b27"}}>{cat}</option>)}
                            </select>
                            <SubcatSelect cat={part.cat} value={part.subcat} onChange={val => updateReceiptPart(idx, "subcat", val)} includeCurrent={false}
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 8px",color:TEXT,fontSize:12,outline:"none",width:"100%"}}/>
                            <button onClick={() => removeReceiptPart(idx)} disabled={receiptParts.length <= 1}
                              style={{background:"#ef444415",border:"none",borderRadius:6,color:receiptParts.length<=1?BORDER:"#ef4444",fontSize:13,cursor:receiptParts.length<=1?"default":"pointer",padding:"4px 0",width:28,textAlign:"center"}}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={addReceiptPart}
                    style={{background:"transparent",border:`1px dashed ${BORDER}`,borderRadius:8,color:MUTED,fontSize:12,cursor:"pointer",padding:"7px 14px",fontFamily:"inherit"}}>
                    + Add Split Line
                  </button>
                  <div style={{fontSize:11,color:MUTED,alignSelf:"center"}}>Parsed lines save as separate transactions on the selected date.</div>
                </div>

                <div style={{background:BG,borderRadius:10,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",border:`1px solid ${receiptBalanced?"#22c55e33":receiptRemaining!==receiptTargetTotal?"#f59e0b33":BORDER}`}}>
                  <div>
                    <div style={{fontSize:11,color:MUTED}}>Split total</div>
                    <div style={{fontSize:16,fontWeight:900,color:receiptBalanced?"#22c55e":"#f59e0b",fontVariantNumeric:"tabular-nums"}}>{money2(receiptAllocatedTotal)}</div>
                  </div>
                  {!receiptBalanced && (
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:11,color:MUTED}}>Difference vs amount field</div>
                      <div style={{fontSize:14,fontWeight:800,color:"#f59e0b",fontVariantNumeric:"tabular-nums"}}>{receiptRemaining > 0 ? "+" : ""}{money2(receiptRemaining)}</div>
                    </div>
                  )}
                  {receiptBalanced && <div style={{fontSize:13,color:"#22c55e",fontWeight:700}}>✓ Ready to save</div>}
                </div>
              </>
            )}
          </div>
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
            <option value="date_desc">Date (newest)</option>
            <option value="date_asc">Date (oldest)</option>
            <option value="amount_desc">Amount (high)</option>
            <option value="amount_asc">Amount (low)</option>
            <option value="desc_asc">Description (A-Z)</option>
            <option value="desc_desc">Description (Z-A)</option>
          </select>
        </div>
        <div style={{fontSize:12,color:MUTED,marginTop:8}}>
          {filtered.length === 0
            ? <span style={{color:"#f59e0b"}}>No transactions for {monthFilter} — import a statement to add data</span>
            : <>{filtered.length} transactions · <span style={{color:"#f97316",fontWeight:700}}>{money2(visibleTotal)}</span></>
          }
        </div>
      </Card>

      <Card style={{padding:0,overflow:isMobile?"visible":"hidden"}}>
        {isMobile ? (
          /* ── MOBILE: card rows ── */
          <>
            {filtered.map((t,i)=>{
              const isIncome   = t.cat==="Income";
              const isTransfer = t.cat==="Transfer";
              const isReturn   = t.amount<0;
              const canPlanTxn = !isIncome && !isTransfer && !isReturn;
              const isOneTime  = isOneTimeTxn(t);
              const isRecurring = isRecurringTxn(t);
              const catColor   = catColorsAll[t.cat]||MUTED;
              const amtColor   = isIncome?"#22c55e":isReturn?"#22c55e":isTransfer?MUTED:TEXT;
              const useCompactActions = !!mobileTxnActionMenu;

              return (
                <div key={t.id || `${src}-${i}`} style={{
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
                      {useCompactActions ? (
                        <div style={{position:"relative"}}>
                          <button onClick={() => setOpenMenuId(prev => prev===t.id ? null : t.id)}
                            style={{background:"#33415522",border:`1px solid ${BORDER}`,borderRadius:6,color:MUTED,fontSize:11,cursor:"pointer",padding:"2px 8px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>
                            Options
                          </button>
                          {openMenuId === t.id && (
                            <div style={{position:"absolute",right:0,bottom:"calc(100% + 6px)",zIndex:60,background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:8,padding:6,minWidth:132,display:"flex",flexDirection:"column",gap:4,boxShadow:"0 10px 22px #0008"}}>
                              <button onClick={() => { editId===t.id ? saveEdit() : beginEdit(t); if (editId===t.id) setOpenMenuId(null); }}
                                style={{background:"#22c55e15",border:"none",borderRadius:5,color:"#22c55e",fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                {editId===t.id ? "Save edit" : "Edit"}
                              </button>
                              {editId===t.id && (
                                <button onClick={() => { cancelEdit(); setOpenMenuId(null); }}
                                  style={{background:"#33415522",border:"none",borderRadius:5,color:MUTED,fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                  Cancel edit
                                </button>
                              )}
                              {canPlanTxn && (
                                <button onClick={() => { setSplitTxn(t); setOpenMenuId(null); }}
                                  style={{background:"#06b6d415",border:"none",borderRadius:5,color:"#06b6d4",fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                  Split
                                </button>
                              )}
                              {canPlanTxn && (
                                <button onClick={() => { toggleRecurringTxn(t); setOpenMenuId(null); }}
                                  style={{background:isRecurring?"#22c55e22":"#33415522",border:"none",borderRadius:5,color:isRecurring?"#22c55e":MUTED,fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                  {isRecurring ? "Unmark recurring" : "Mark recurring"}
                                </button>
                              )}
                              {canPlanTxn && (
                                <button onClick={() => { toggleOneTimeTxn(t); setOpenMenuId(null); }}
                                  style={{background:isOneTime?"#f59e0b22":"#33415522",border:"none",borderRadius:5,color:isOneTime?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                  {isOneTime ? "Unmark one-time" : "Mark one-time"}
                                </button>
                              )}
                              <button onClick={() => { toggleTxnTagging(src, t.id); setOpenMenuId(null); }}
                                style={{background:t.excludeFromTags?"#f59e0b22":"#33415522",border:"none",borderRadius:5,color:t.excludeFromTags?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                {t.excludeFromTags ? "Enable tagging" : "Exclude from tags"}
                              </button>
                              <button onClick={() => {
                                requestDeleteTxn(t);
                                setOpenMenuId(null);
                              }}
                                style={{background:"#ef444415",border:"none",borderRadius:5,color:"#ef4444",fontSize:11,cursor:"pointer",padding:"5px 8px",textAlign:"left",fontWeight:700}}>
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          <button onClick={() => editId===t.id ? saveEdit() : beginEdit(t)} title="Edit"
                            style={{background:"#22c55e15",border:"none",borderRadius:4,color:"#22c55e",fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>
                            {editId===t.id ? "Save" : "Edit"}
                          </button>
                          {editId===t.id && (
                            <button onClick={cancelEdit} title="Cancel"
                              style={{background:"#33415522",border:"none",borderRadius:4,color:MUTED,fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>Cancel</button>
                          )}
                          {canPlanTxn && (
                            <button onClick={() => setSplitTxn(t)} title="Split"
                              style={{background:"#06b6d415",border:"none",borderRadius:4,color:"#06b6d4",fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>Split</button>
                          )}
                          {canPlanTxn && (
                            <button onClick={() => toggleRecurringTxn(t)} title={isRecurring ? "Unmark recurring" : "Mark recurring"}
                              style={{background:isRecurring?"#22c55e22":"#33415522",border:"none",borderRadius:4,color:isRecurring?"#22c55e":MUTED,fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>
                              Recurring
                            </button>
                          )}
                          {canPlanTxn && (
                            <button onClick={() => toggleOneTimeTxn(t)} title={isOneTime ? "Unmark one-time" : "Mark one-time"}
                              style={{background:isOneTime?"#f59e0b22":"#33415522",border:"none",borderRadius:4,color:isOneTime?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>
                              One-time
                            </button>
                          )}
                          <button onClick={() => toggleTxnTagging(src, t.id)} title={t.excludeFromTags ? "Include in tagging" : "Exclude from tagging"}
                            style={{background:t.excludeFromTags?"#f59e0b22":"#33415522",border:"none",borderRadius:4,color:t.excludeFromTags?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"1px 6px",lineHeight:1.5,flexShrink:0,fontWeight:700}}>
                            {t.excludeFromTags ? "NoTag" : "Tag"}
                          </button>
                          <button onClick={() => requestDeleteTxn(t)}
                            title="Delete transaction"
                            style={{background:"#ef444415",border:"none",borderRadius:4,color:"#ef4444",fontSize:12,cursor:"pointer",padding:"1px 5px",lineHeight:1.5,flexShrink:0}}>Del</button>
                        </>
                      )}
                    </div>
                  </div>
                  {/* Bottom row: description + amount */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      {editId===t.id ? (
                        <div style={{display:"flex",flexDirection:"column",gap:6}}>
                          <div style={{display:"grid",gridTemplateColumns:"80px 1fr 90px",gap:6}}>
                            <input value={editDraft.date} onChange={e=>setEditDraft(d=>({...d,date:e.target.value}))} placeholder="MM/DD"
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                            <input value={editDraft.desc} onChange={e=>setEditDraft(d=>({...d,desc:e.target.value}))} placeholder="Description"
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                            <input type="number" step="0.01" value={editDraft.amount} onChange={e=>setEditDraft(d=>({...d,amount:e.target.value}))}
                              style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                          </div>
                          <input value={editDraft.note} onChange={e=>setEditDraft(d=>({...d,note:e.target.value}))} placeholder="Note (optional)"
                            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                          <SubcatSelect cat={t.cat} value={editDraft.subcat} onChange={val=>setEditDraft(d=>({...d,subcat:val}))} includeCurrent
                            style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                        </div>
                      ) : (
                        <>
                          <div style={{fontSize:14,fontWeight:500,color:isIncome?"#22c55e":TEXT,lineHeight:1.3}}>
                            {t.desc}
                            {normalizeTxnSubcategory(t.subcat)&&<span style={{marginLeft:6}}><Tag color={catColor}>{normalizeTxnSubcategory(t.subcat)}</Tag></span>}
                            {isRecurring&&<span style={{marginLeft:6}}><Tag color="#22c55e">recurring</Tag></span>}
                            {isOneTime&&<span style={{marginLeft:6}}><Tag color="#f59e0b">one-time</Tag></span>}
                            {t.excludeFromTags&&<span style={{marginLeft:6}}><Tag color="#f59e0b">excluded</Tag></span>}
                          </div>
                          {getTxnDisplayNote(t.note)&&(
                            <div style={{fontSize:11,color:DIM,marginTop:2}}>{getTxnDisplayNote(t.note)}</div>
                          )}
                        </>
                      )}
                    </div>
                    <div style={{fontSize:16,fontWeight:800,color:amtColor,fontVariantNumeric:"tabular-nums",flexShrink:0}}>
                      {isIncome||isReturn?"+":""}{money2(t.amount)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div style={{padding:"12px 16px",background:"#0f141e",borderTop:`2px solid ${BORDER}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:700,color:MUTED}}>Total spend</span>
              <span style={{fontSize:16,fontWeight:900,color:"#f97316",fontVariantNumeric:"tabular-nums"}}>{money2(visibleTotal)}</span>
            </div>
          </>
        ) : (
          /* ── DESKTOP: 4-col table ── */
          <>
            <div style={{overflowX:"auto"}}>
              <div style={{display:"grid",gridTemplateColumns:desktopTxnCols,columnGap:10,padding:"10px 16px",background:BG,borderBottom:`1px solid ${BORDER}`,minWidth:desktopTxnMinW}}>
                {["Date","Description","Amount","Category","",""].map(h=>(
                  <div key={h} style={{fontSize:11,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px"}}>{h}</div>
                ))}
              </div>
              {filtered.map((t,i)=>{
                const isIncome=t.cat==="Income", isTransfer=t.cat==="Transfer", isReturn=t.amount<0;
                const canPlanTxn = !isIncome && !isTransfer && !isReturn;
                const isOneTime=isOneTimeTxn(t);
                const isRecurring=isRecurringTxn(t);
                const isEditing = editId === t.id;
                const catColor = catColorsAll[t.cat] || MUTED;
                return (
                  <div key={t.id || `${src}-${i}`} style={{display:"grid",gridTemplateColumns:desktopTxnCols,columnGap:10,padding:"10px 16px",borderBottom:`1px solid ${BORDER}`,background:isIncome?"#22c55e07":isTransfer?"#33415507":i%2===0?SURFACE:BG,opacity:isTransfer?.5:1,minWidth:desktopTxnMinW}}>
                    <div style={{fontSize:12,color:MUTED,alignSelf:"center"}}>
                      {isEditing
                        ? <input value={editDraft.date} onChange={e=>setEditDraft(d=>({...d,date:e.target.value}))} placeholder="MM/DD"
                            style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                        : t.date}
                    </div>
                    <div style={{alignSelf:"center",paddingRight:12}}>
                      {isEditing ? (
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          <input value={editDraft.desc} onChange={e=>setEditDraft(d=>({...d,desc:e.target.value}))}
                            style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                          <SubcatSelect cat={t.cat} value={editDraft.subcat} onChange={val=>setEditDraft(d=>({...d,subcat:val}))} includeCurrent
                            style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:11,outline:"none"}}/>
                          <input value={editDraft.note} onChange={e=>setEditDraft(d=>({...d,note:e.target.value}))} placeholder="Note (optional)"
                            style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:11,outline:"none"}}/>
                        </div>
                      ) : (
                        <>
                          <div style={{fontSize:13,color:isIncome?"#22c55e":TEXT,fontWeight:isIncome?700:400,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            {t.desc}{normalizeTxnSubcategory(t.subcat)&&<Tag color={catColor}>{normalizeTxnSubcategory(t.subcat)}</Tag>}{isRecurring&&<Tag color="#22c55e">recurring</Tag>}{isOneTime&&<Tag color="#f59e0b">one-time</Tag>}
                            {t.excludeFromTags&&<Tag color="#f59e0b">excluded</Tag>}
                          </div>
                          {getTxnDisplayNote(t.note)&&<div style={{fontSize:11,color:DIM,marginTop:2}}>{getTxnDisplayNote(t.note)}</div>}
                        </>
                      )}
                    </div>
                    <div style={{fontSize:14,fontWeight:700,alignSelf:"center",fontVariantNumeric:"tabular-nums",color:isIncome?"#22c55e":isReturn?"#22c55e":isTransfer?MUTED:TEXT}}>
                      {isEditing
                        ? <input type="number" step="0.01" value={editDraft.amount} onChange={e=>setEditDraft(d=>({...d,amount:e.target.value}))}
                            style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"4px 6px",color:TEXT,fontSize:12,outline:"none"}}/>
                        : <>{isIncome||isReturn?"+":""}{money2(t.amount)}</>}
                    </div>
                    <div style={{alignSelf:"center"}}><CatSelect t={t} src={src} updateTxnCat={updateTxnCat}/></div>
                    <div style={{alignSelf:"center",display:"flex",gap:5,justifyContent:"flex-start",whiteSpace:"nowrap",flexWrap:"wrap"}}>
                      <button onClick={() => isEditing ? saveEdit() : beginEdit(t)} title="Edit"
                        style={{background:"#22c55e15",border:"none",borderRadius:4,color:"#22c55e",fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.4,fontWeight:700}}>
                        {isEditing ? "Save" : "Edit"}
                      </button>
                      {canPlanTxn && (
                        <button onClick={() => setSplitTxn(t)} title="Split transaction"
                          style={{background:"#06b6d415",border:"none",borderRadius:4,color:"#06b6d4",fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.4,fontWeight:700}}>Split</button>
                      )}
                      {!isEditing && (
                        <button onClick={() => toggleTxnTagging(src, t.id)} title={t.excludeFromTags ? "Include in tagging" : "Exclude from tagging"}
                          style={{background:t.excludeFromTags?"#f59e0b22":"#33415522",border:"none",borderRadius:4,color:t.excludeFromTags?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.4,fontWeight:700}}>
                          {t.excludeFromTags ? "NoTag" : "Tag"}
                        </button>
                      )}
                      {canPlanTxn && !isEditing && (
                        <button onClick={() => toggleRecurringTxn(t)} title={isRecurring ? "Unmark recurring" : "Mark recurring"}
                          style={{background:isRecurring?"#22c55e22":"#33415522",border:"none",borderRadius:4,color:isRecurring?"#22c55e":MUTED,fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.4,fontWeight:700}}>
                          Recurring
                        </button>
                      )}
                      {canPlanTxn && !isEditing && (
                        <button onClick={() => toggleOneTimeTxn(t)} title={isOneTime ? "Unmark one-time" : "Mark one-time"}
                          style={{background:isOneTime?"#f59e0b22":"#33415522",border:"none",borderRadius:4,color:isOneTime?"#f59e0b":MUTED,fontSize:11,cursor:"pointer",padding:"2px 7px",lineHeight:1.4,fontWeight:700}}>
                          One-time
                        </button>
                      )}
                    </div>
                    <div style={{alignSelf:"center"}}>
                      {isEditing ? (
                        <button onClick={cancelEdit} title="Cancel edit"
                          style={{background:"#33415522",border:"none",borderRadius:4,color:MUTED,fontSize:11,cursor:"pointer",padding:"2px 6px",lineHeight:1.5,fontWeight:700}}>Cancel</button>
                      ) : (
                        <button onClick={() => requestDeleteTxn(t)} title="Delete"
                          style={{background:"#ef444415",border:"none",borderRadius:4,color:"#ef4444",fontSize:13,cursor:"pointer",padding:"2px 6px",lineHeight:1.5}}>Del</button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div style={{display:"grid",gridTemplateColumns:desktopTxnCols,columnGap:10,padding:"12px 16px",background:"#0f141e",borderTop:`2px solid ${BORDER}`,minWidth:desktopTxnMinW}}>
                <div/>
                <div style={{fontSize:13,fontWeight:700,color:MUTED}}>Total spend (excl. income & transfers)</div>
                <div style={{fontSize:15,fontWeight:900,color:"#f97316",fontVariantNumeric:"tabular-nums"}}>{money2(visibleTotal)}</div>
                <div/><div/><div/>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ── RECOMMENDATIONS ───────────────────────────────────────────────────────────

function TransactionsPage({ wide, isMobile }) {
  const [source, setSource] = useState("checking");
  const [showImport, setShowImport] = useState(false);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <Card>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
          <Label>Transactions</Label>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>
            <div style={{display:"inline-flex",gap:6,padding:4,borderRadius:12,background:BG,border:`1px solid ${BORDER}`}}>
              <button onClick={()=>setSource("checking")} style={{
                padding:"8px 14px",borderRadius:9,fontSize:13,fontWeight:800,cursor:"pointer",
                background:source==="checking"?ACCENT+"22":"transparent",color:source==="checking"?ACCENT:MUTED,
                border:`1px solid ${source==="checking"?ACCENT:BORDER}`,transition:"all .15s",boxShadow:source==="checking"?"inset 0 0 0 1px "+ACCENT+"55":"none"
              }}>
                🏦 Checking
              </button>
              <button onClick={()=>setSource("cc")} style={{
                padding:"8px 14px",borderRadius:9,fontSize:13,fontWeight:800,cursor:"pointer",
                background:source==="cc"?ACCENT+"22":"transparent",color:source==="cc"?ACCENT:MUTED,
                border:`1px solid ${source==="cc"?ACCENT:BORDER}`,transition:"all .15s",boxShadow:source==="cc"?"inset 0 0 0 1px "+ACCENT+"55":"none"
              }}>
                💳 Credit Card
              </button>
            </div>
            <button onClick={() => setShowImport(v => !v)} style={{
              padding:"8px 14px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",
              background:showImport ? "#06b6d422" : "#22c55e22",
              color:showImport ? "#06b6d4" : "#22c55e",
              border:`1px solid ${showImport ? "#06b6d455" : "#22c55e55"}`,
              transition:"all .15s",
            }}>
              {showImport ? "✕ Hide Import" : "📥 Import Statement"}
            </button>
          </div>
        </div>
      </Card>
      {showImport && <StatementImporter wide={wide} isMobile={isMobile}/>}
      <TxnTable src={source} isMobile={isMobile}/>
    </div>
  );
}

function IncomePage({ wide }) {
  const { checkTxns, ccTxns, selectedMonth, availableMonths, takeHome } = useBudget();
  const allIncomeTxns = [...checkTxns, ...ccTxns].filter(t => t.cat === "Income");
  const incomeInflow = (t) => Math.abs(Number(t?.amount) || 0);
  const incomeHoverFill = "#22c55e12";
  const hasRealIncome = allIncomeTxns.length > 0;
  const demoBase = takeHome > 0 ? takeHome : 7862;
  const demoMonthIncomeTxns = [
    { desc: "Primary Job", amount: Math.round(demoBase * 0.82), month: selectedMonth },
    { desc: "Side Income", amount: Math.round(demoBase * 0.12), month: selectedMonth },
    { desc: "Other Income", amount: Math.round(demoBase * 0.06), month: selectedMonth },
  ];
  const monthIncomeTxns = hasRealIncome
    ? allIncomeTxns.filter(t => t.month === selectedMonth)
    : demoMonthIncomeTxns;
  const monthIncome = monthIncomeTxns.reduce((s,t)=>s+incomeInflow(t),0);
  const sourceRows = Object.entries(monthIncomeTxns.reduce((acc,t)=>{ acc[t.desc]=(acc[t.desc]||0)+incomeInflow(t); return acc; }, {}))
    .map(([name,total])=>({name,total})).sort((a,b)=>b.total-a.total);
  const monthSeries = hasRealIncome
    ? availableMonths.map(m => {
        const total = allIncomeTxns.filter(t => t.month === m).reduce((s,t)=>s+incomeInflow(t),0);
        return { month: m.slice(0,3), total };
      })
    : APP_MONTHS.map((m, idx) => ({ month: m.slice(0,3), total: Math.round(demoBase * (0.94 + ((idx % 4) * 0.03))) }));
  const avgIncome = monthSeries.length ? monthSeries.reduce((s,m)=>s+m.total,0)/monthSeries.length : 0;
  const delta = monthIncome - takeHome;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card glow="#22c55e">
        <Label>Income Overview � {selectedMonth}</Label>
        {!hasRealIncome && (
          <div style={{fontSize:11,color:"#f59e0b",marginBottom:8}}>Showing sample income data until income transactions are added.</div>
        )}
        <div style={{display:"grid",gridTemplateColumns:wide?"repeat(4,1fr)":"1fr 1fr",gap:10}}>
          {[["This month",fmt(monthIncome),"#22c55e"],["Take-home target",fmt(takeHome),ACCENT],["Avg monthly",fmt(avgIncome),"#06b6d4"],["Delta",`${delta>=0?"+":"-"}${fmt(Math.abs(delta))}`,delta>=0?"#22c55e":"#ef4444"]].map(([k,v,c])=>(
            <div key={k} style={{background:BG,borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:10,color:MUTED,marginBottom:3}}>{k}</div>
              <div style={{fontSize:16,fontWeight:900,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <Label>Income Trend</Label>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={monthSeries} margin={{left:8,right:8,top:12,bottom:0}}>
            <XAxis dataKey="month" tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false}/>
            <YAxis tick={{fontSize:10,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`${Math.round(v)}`}/>
            <Tooltip content={<Tip/>} cursor={{ fill: incomeHoverFill }}/>
            <Bar dataKey="total" fill="#22c55e" radius={[6,6,0,0]}/>
            <ReferenceLine y={takeHome} stroke={ACCENT} strokeDasharray="4 3"/>
          </BarChart>
        </ResponsiveContainer>
      </Card>
      <Card>
        <Label>Income Sources � {selectedMonth}</Label>
        {sourceRows.length===0 ? <div style={{fontSize:13,color:MUTED}}>No income transactions yet for this month.</div> : sourceRows.map((r,i)=>(
          <div key={r.name+i} style={{display:"flex",justifyContent:"space-between",padding:"8px 2px",borderBottom:`1px solid ${i===sourceRows.length-1?"transparent":BORDER}`}}>
            <span style={{fontSize:13,color:TEXT}}>{r.name}</span>
            <span style={{fontSize:14,fontWeight:800,color:"#22c55e",fontVariantNumeric:"tabular-nums"}}>{fmt(r.total)}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function MealPlanningPage({ wide }) {
  const { checkTxns, ccTxns, selectedMonth } = useBudget();
  const [weeklyBudget, setWeeklyBudget] = useState(() => Number(ls.get("budget_mealWeeklyBudget") || 250));
  const [listByMonth, setListByMonth] = useState(() => ls.getJSON("budget_mealListsByMonth", {}));
  const [householdSize, setHouseholdSize] = useState(() => Number(ls.get("budget_meal_household") || 4));
  const [planDays, setPlanDays] = useState(() => Number(ls.get("budget_meal_days") || 7));
  const [mealStyle, setMealStyle] = useState(() => ls.get("budget_meal_style") || "family-friendly, balanced");
  const [storeText, setStoreText] = useState(() => ls.get("budget_meal_stores") || "Walmart, Aldi, Costco");
  const [zipCode, setZipCode] = useState(() => ls.get("budget_meal_zip") || "");
  const [goalText, setGoalText] = useState(() => ls.get("budget_meal_goals") || "high protein dinners, simple lunches, low waste");
  const [copyMsg, setCopyMsg] = useState("");
  const [generating, setGenerating] = useState(false);
  const [planErr, setPlanErr] = useState(null);
  const [aiPlanByMonth, setAiPlanByMonth] = useState(() => ls.getJSON("budget_meal_ai_plan_by_month", {}));
  const [aiResponsesByMonth, setAiResponsesByMonth] = useState(() => ls.getJSON("budget_meal_ai_responses_by_month", {}));

  useEffect(() => { ls.set("budget_mealWeeklyBudget", String(weeklyBudget)); }, [weeklyBudget]);
  useEffect(() => { ls.setJSON("budget_mealListsByMonth", listByMonth); }, [listByMonth]);
  useEffect(() => { ls.set("budget_meal_household", String(householdSize)); }, [householdSize]);
  useEffect(() => { ls.set("budget_meal_days", String(planDays)); }, [planDays]);
  useEffect(() => { ls.set("budget_meal_style", mealStyle); }, [mealStyle]);
  useEffect(() => { ls.set("budget_meal_stores", storeText); }, [storeText]);
  useEffect(() => { ls.set("budget_meal_zip", zipCode); }, [zipCode]);
  useEffect(() => { ls.set("budget_meal_goals", goalText); }, [goalText]);
  useEffect(() => { ls.setJSON("budget_meal_ai_plan_by_month", aiPlanByMonth); }, [aiPlanByMonth]);
  useEffect(() => { ls.setJSON("budget_meal_ai_responses_by_month", aiResponsesByMonth); }, [aiResponsesByMonth]);

  const foodTxns = [...checkTxns, ...ccTxns].filter(t => t.month===selectedMonth && (t.cat==="Groceries" || t.cat==="Dining Out"));
  const grocery = foodTxns.filter(t=>t.cat==="Groceries").reduce((s,t)=>s+t.amount,0);
  const dining = foodTxns.filter(t=>t.cat==="Dining Out").reduce((s,t)=>s+t.amount,0);
  const total = grocery + dining;
  const plannedMonth = weeklyBudget * 4.33;
  const remaining = plannedMonth - total;
  const spentPct = plannedMonth > 0 ? Math.min(100, (total / plannedMonth) * 100) : 0;
  const stores = storeText.split(",").map(x=>x.trim()).filter(Boolean);
  const activeResponses = aiResponsesByMonth[selectedMonth] || [];

  const normalizeUrl = (u) => {
    let s = String(u || "").trim();
    if (!s) return "";
    s = s.replace(/[),.;]+$/g, "");
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    if (/\.\.\.|<|>|\s/.test(s)) return "";
    try {
      const parsed = new URL(s);
      if (!/^https?:$/i.test(parsed.protocol)) return "";
      if (!parsed.hostname || !parsed.hostname.includes(".")) return "";
      if (/^(example\.com|localhost)$/i.test(parsed.hostname)) return "";
      return parsed.toString();
    } catch {
      return "";
    }
  };
  const recipeSearchLink = (mealName) => {
    const q = encodeURIComponent(`${String(mealName || "easy meal").trim()} recipe`);
    return `https://www.google.com/search?q=${q}`;
  };
  const fallbackProofLinks = (itemName, storeNames = [], zip = "") => {
    const safeItem = String(itemName || "grocery item").trim() || "grocery item";
    const area = String(zip || "").trim();
    const localHint = area ? ` near ${area}` : "";
    const perStore = (storeNames || [])
      .map(sn => String(sn || "").trim())
      .filter(Boolean)
      .slice(0, 4)
      .map(sn => `https://www.google.com/search?q=${encodeURIComponent(`${sn} ${safeItem} price${localHint}`)}`);
    return [
      ...perStore,
      `https://www.google.com/search?q=${encodeURIComponent(`${safeItem} price${localHint}`)}`,
    ];
  };
  function normalizePlan(parsed) {
    const asPosNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const meals = Array.isArray(parsed?.meals) ? parsed.meals.map((m) => ({
      ...m,
      recipe_links: {
        breakfast: normalizeUrl(m?.recipe_links?.breakfast || "") || recipeSearchLink(m?.breakfast || "breakfast"),
        lunch: normalizeUrl(m?.recipe_links?.lunch || "") || recipeSearchLink(m?.lunch || "lunch"),
        dinner: normalizeUrl(m?.recipe_links?.dinner || "") || recipeSearchLink(m?.dinner || "dinner"),
      },
    })) : [];
    const grocery_items = Array.isArray(parsed?.grocery_items) ? parsed.grocery_items.map((it) => {
      const sc = it?.store_costs && typeof it.store_costs === "object" ? it.store_costs : {};
      const aiLinks = Array.isArray(it?.price_proof_links)
        ? it.price_proof_links.map(normalizeUrl).filter(Boolean)
        : [];
      const fallbackLinks = fallbackProofLinks(it?.item, [it?.best_store, ...Object.keys(sc), ...stores], zipCode);
      const links = [...fallbackLinks, ...aiLinks].filter((lnk, idx, arr) => arr.indexOf(lnk) === idx).slice(0, 6);
      return {
        ...it,
        meal_usage: String(it?.meal_usage || "").trim() || "Not specified by AI",
        store_costs: sc,
        price_proof_links: links,
      };
    }) : [];
    const weeklyFromModel = asPosNum(parsed?.estimated_weekly_total);
    const monthlyFromModel = asPosNum(parsed?.estimated_monthly_total);
    const monthlyFromWeekly = weeklyFromModel ? Number((weeklyFromModel * 4.33).toFixed(2)) : 0;
    const monthlyMismatch = weeklyFromModel && monthlyFromModel && Math.abs(monthlyFromModel - monthlyFromWeekly) > Math.max(25, monthlyFromWeekly * 0.25);
    return {
      ...parsed,
      generated_at: new Date().toISOString(),
      estimated_weekly_total: weeklyFromModel,
      estimated_monthly_total: monthlyMismatch ? monthlyFromWeekly : (monthlyFromModel || monthlyFromWeekly),
      meals,
      grocery_items,
    };
  }
  const activePlan = useMemo(() => {
    const raw = aiPlanByMonth[selectedMonth];
    return raw ? normalizePlan(raw) : null;
  }, [aiPlanByMonth, selectedMonth, storeText, zipCode]);
  const aiMonthlyEstimate = Number(activePlan?.estimated_monthly_total || 0);
  const aiDelta = plannedMonth - aiMonthlyEstimate;
  const recipeCoveragePct = Math.round((((activePlan?.meals || []).filter(m => (m?.recipe_links?.breakfast || m?.recipe_links?.lunch || m?.recipe_links?.dinner)).length) / Math.max(1, (activePlan?.meals || []).length)) * 100);
  const copyShoppingList = async () => {
    const aiItems = (activePlan?.grocery_items || []).map(it => `- ${it.item}${it.quantity ? ` (${it.quantity})` : ""}${it.best_store ? ` [Best: ${it.best_store}${it.best_cost!=null ? ` ${fmt(it.best_cost)}` : ""}]` : ""}`);
    const txt = [...aiItems].join("\n").trim();
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setCopyMsg("Copied shopping list");
      setTimeout(() => setCopyMsg(""), 1800);
    } catch {
      setCopyMsg("Copy failed");
      setTimeout(() => setCopyMsg(""), 1800);
    }
  };
  const generatePlan = async () => {
    if (!ANTHROPIC_API_KEY) { setPlanErr("Add an Anthropic API key in Settings to use AI meal planning."); return; }
    setGenerating(true);
    setPlanErr(null);
    const debugResponses = [];
    let promptUsed = "";
    const parseAiJson = (rawText) => {
      const raw = String(rawText || "").trim();
      if (!raw) throw new Error("AI returned an empty response.");
      const normalized = raw
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u00A0/g, " ");
      const unfenced = normalized.replace(/```json|```/gi, "").trim();
      const stripJsonComments = (text) => {
        let out = "";
        let inStr = false;
        let esc = false;
        let i = 0;
        while (i < text.length) {
          const ch = text[i];
          const next = text[i + 1];
          if (inStr) {
            out += ch;
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === "\"") inStr = false;
            i += 1;
            continue;
          }
          if (ch === "\"") {
            inStr = true;
            out += ch;
            i += 1;
            continue;
          }
          if (ch === "/" && next === "/") {
            i += 2;
            while (i < text.length && text[i] !== "\n") i += 1;
            continue;
          }
          if (ch === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
            i = Math.min(text.length, i + 2);
            continue;
          }
          out += ch;
          i += 1;
        }
        return out.trim();
      };
      const attempts = [];
      const maybeAdd = (s) => {
        const v = String(s || "").trim();
        if (v && !attempts.includes(v)) attempts.push(v);
      };
      maybeAdd(unfenced);
      const firstBrace = unfenced.indexOf("{");
      const lastBrace = unfenced.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) maybeAdd(unfenced.slice(firstBrace, lastBrace + 1));
      const fenceMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch?.[1]) maybeAdd(fenceMatch[1]);
      const extractBalanced = (text, openCh, closeCh) => {
        const out = [];
        let depth = 0;
        let start = -1;
        let inStr = false;
        let esc = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === "\"") inStr = false;
            continue;
          }
          if (ch === "\"") { inStr = true; continue; }
          if (ch === openCh) {
            if (depth === 0) start = i;
            depth += 1;
          } else if (ch === closeCh && depth > 0) {
            depth -= 1;
            if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
          }
        }
        return out;
      };
      extractBalanced(unfenced, "{", "}").forEach(maybeAdd);
      extractBalanced(unfenced, "[", "]").forEach(maybeAdd);
      const unwrapPlanLikeObject = (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        if (Array.isArray(value.meals) || Array.isArray(value.grocery_items)) return value;
        const nested = value.raw_model_response || value.response || value.data || value.result;
        if (nested == null) return null;
        if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
        if (typeof nested === "string") {
          try {
            const parsedNested = JSON.parse(nested.trim());
            if (parsedNested && typeof parsedNested === "object" && !Array.isArray(parsedNested)) return parsedNested;
          } catch {}
        }
        return null;
      };
      for (const candidate of attempts) {
        const cleaned = stripJsonComments(candidate.replace(/^\uFEFF/, ""));
        const candidatesToParse = [cleaned, cleaned.replace(/,\s*([}\]])/g, "$1")];
        for (const text of candidatesToParse) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const unwrapped = unwrapPlanLikeObject(parsed);
              return unwrapped || parsed;
            }
          } catch {}
        }
      }

      const findKeyValueStart = (text, key) => {
        const needle = `"${key}"`;
        let idx = text.indexOf(needle);
        while (idx >= 0) {
          let i = idx + needle.length;
          while (i < text.length && /\s/.test(text[i])) i += 1;
          if (text[i] !== ":") {
            idx = text.indexOf(needle, idx + 1);
            continue;
          }
          i += 1;
          while (i < text.length && /\s/.test(text[i])) i += 1;
          return i;
        }
        return -1;
      };
      const extractBalancedFrom = (text, start, openCh, closeCh) => {
        if (start < 0 || text[start] !== openCh) return null;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === "\"") inStr = false;
            continue;
          }
          if (ch === "\"") { inStr = true; continue; }
          if (ch === openCh) depth += 1;
          else if (ch === closeCh) {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
          }
        }
        return null;
      };
      const parseStringProp = (text, key) => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
        if (!m) return "";
        try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
      };
      const parseNumberProp = (text, key) => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
        if (!m) return 0;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : 0;
      };
      const parseArrayProp = (text, key) => {
        const start = findKeyValueStart(text, key);
        const arrText = extractBalancedFrom(text, start, "[", "]");
        if (!arrText) return [];
        try {
          const parsed = JSON.parse(arrText);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };
      const recovered = (() => {
        const meals = parseArrayProp(unfenced, "meals");
        const grocery_items = parseArrayProp(unfenced, "grocery_items");
        if (!meals.length && !grocery_items.length) return null;
        return {
          summary: parseStringProp(unfenced, "summary") || "Recovered AI meal plan from partial response.",
          generated_at: parseStringProp(unfenced, "generated_at") || new Date().toISOString(),
          estimated_weekly_total: parseNumberProp(unfenced, "estimated_weekly_total"),
          estimated_monthly_total: parseNumberProp(unfenced, "estimated_monthly_total"),
          meals,
          grocery_items,
          prep_tips: parseArrayProp(unfenced, "prep_tips"),
          waste_reduction_tips: parseArrayProp(unfenced, "waste_reduction_tips"),
        };
      })();
      if (recovered) return recovered;

      throw new Error("AI response was not valid JSON.");
    };
    const callAnthropic = async (userPrompt, maxTokens = 3000) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:maxTokens, messages:[{role:"user",content:userPrompt}] }),
      });
      const data = await res.json();
      if (!res.ok) {
        const apiMsg = data?.error?.message || data?.error?.type || `HTTP ${res.status}`;
        throw new Error(`AI request failed: ${apiMsg}`);
      }
      const raw = (data.content || []).map(b => b?.text || "").join("\n").trim();
      return { raw, stopReason: data?.stop_reason || "" };
    };
    const parseResponseOrThrow = (response, label) => {
      try {
        return parseAiJson(response?.raw || "");
      } catch (err) {
        if (String(response?.stopReason || "").toLowerCase() === "max_tokens") {
          throw new Error(`${label} was truncated (max tokens).`);
        }
        throw err;
      }
    };
    try {
      const prompt = `Create a practical grocery meal plan JSON for a US household.
Month: ${selectedMonth}
Household size: ${householdSize}
Planning days: ${planDays}
ZIP code: ${zipCode || "Not provided"}
Weekly budget target: $${weeklyBudget}
Monthly budget target: $${plannedMonth.toFixed(2)}
Current groceries + dining spend this month: $${total.toFixed(2)}
Remaining budget for this month: $${Math.max(0, remaining).toFixed(2)}
Preferred stores: ${stores.join(", ") || "Any major US grocery stores"}
Meal style: ${mealStyle}
Goals: ${goalText}
Notes from user for this month: ${(listByMonth[selectedMonth] || "None").trim() || "None"}

Use realistic US grocery price estimates based on recent market averages. For each grocery item include estimated prices by listed store, quantity, and which store is cheapest.
Hard constraints:
1) Keep estimated_monthly_total at or below the Monthly budget target.
2) If the target is tight, reduce complexity and choose lower-cost ingredients first.
3) Prioritize reusing ingredients across meals to cut waste and stay under budget.
4) Include concise substitutions for expensive items.
5) Every day must include recipe links for breakfast/lunch/dinner.
6) Every grocery item must include at least one price_proof_links URL to show where the price came from.
7) Prefer store-specific proof links close to the ZIP code when possible.
8) Keep output compact: use at most 20 grocery items and at most 4 tips in each tips array.
9) Every grocery item must set meal_usage with explicit meal references (example: "Mon dinner tacos, Tue lunch bowls").

Return ONLY valid JSON with this shape:
{
  "summary": "short summary",
  "generated_at": "ISO timestamp",
  "estimated_weekly_total": number,
  "estimated_monthly_total": number,
  "meals": [{"day":"Mon","breakfast":"...","lunch":"...","dinner":"...","recipe_links":{"breakfast":"https://...","lunch":"https://...","dinner":"https://..."}}],
  "grocery_items": [
    {"item":"Chicken breast","quantity":"4 lb","category":"Protein","store_costs":{"Walmart":14.5,"Aldi":13.2},"best_store":"Aldi","best_cost":13.2,"meal_usage":"2 dinners + 1 lunch","price_proof_links":["https://...","https://..."]}
  ],
  "prep_tips": ["..."],
  "waste_reduction_tips": ["..."]
}`;
      promptUsed = prompt;

      const initial = await callAnthropic(prompt, 5200);
      const { raw } = initial;
      debugResponses.push({ label: "raw_model_response", text: raw });
      let parsedJson;
      let responseToSave = raw;
      try {
        parsedJson = parseResponseOrThrow(initial, "AI response");
      } catch {
        const repairPrompt = `You are a strict JSON formatter.
Convert the following text into strict valid JSON only.
Do not add markdown, comments, code fences, or extra text.
If any field is unknown, use empty strings/arrays instead of omitting keys.

TEXT TO REPAIR:
${raw}`;
        const repairedPass1 = await callAnthropic(repairPrompt, 5200);
        debugResponses.push({ label: "repair_pass_1", text: repairedPass1.raw });
        try {
          parsedJson = parseResponseOrThrow(repairedPass1, "AI repair pass 1");
          responseToSave = repairedPass1.raw;
        } catch {
          const repairPrompt2 = `Return ONLY minified strict JSON object that matches the expected meal-plan schema keys.
No prose. No markdown.

RAW INPUT:
${raw}`;
          const repairedPass2 = await callAnthropic(repairPrompt2, 5200);
          debugResponses.push({ label: "repair_pass_2", text: repairedPass2.raw });
          parsedJson = parseResponseOrThrow(repairedPass2, "AI repair pass 2");
          responseToSave = repairedPass2.raw;
        }
      }
      const debugBlob = debugResponses
        .filter(x => String(x?.text || "").trim())
        .map((x, i) => `--- ${x.label || `response_${i + 1}`} ---\n${String(x.text || "").trim()}`)
        .join("\n\n");
      const parsed = normalizePlan(parsedJson);
      setAiPlanByMonth(prev => ({ ...prev, [selectedMonth]: parsed }));
      setAiResponsesByMonth(prev => ({
        ...prev,
        [selectedMonth]: [
          {
            at: new Date().toISOString(),
            prompt,
            response: debugBlob || responseToSave.trim(),
            summary: parsed?.summary || "AI meal plan response",
          },
          ...(prev[selectedMonth] || []),
        ].slice(0, 6),
      }));
    } catch (e) {
      const msg = String(e?.message || "");
      const debugBlob = debugResponses
        .filter(x => String(x?.text || "").trim())
        .map((x, i) => `--- ${x.label || `response_${i + 1}`} ---\n${String(x.text || "").trim()}`)
        .join("\n\n");
      if (debugBlob) {
        setAiResponsesByMonth(prev => ({
          ...prev,
          [selectedMonth]: [
            {
              at: new Date().toISOString(),
              prompt: promptUsed || "Prompt unavailable.",
              response: debugBlob,
              summary: `AI failure debug (${msg || "unknown error"})`,
            },
            ...(prev[selectedMonth] || []),
          ].slice(0, 6),
        }));
      }
      if (/max tokens|truncated/i.test(msg)) {
        setPlanErr("AI response was truncated. Reduce goals text or stores and try again.");
      } else if (/not valid json|empty response/i.test(msg)) {
        setPlanErr("AI returned an invalid format after repair attempts. Try again.");
      } else if (msg) {
        setPlanErr(msg);
      } else {
        setPlanErr("Could not generate meal plan. Please try again.");
      }
    }
    setGenerating(false);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <Card glow="#22c55e">
        <Label>Meal Planner · {selectedMonth}</Label>
        <div style={{display:"grid",gridTemplateColumns:wide?"repeat(4,1fr)":"1fr 1fr",gap:10}}>
          {[["Groceries",fmt(grocery),"#f97316"],["Dining out",fmt(dining),"#10b981"],["Food total",fmt(total),TEXT],["Vs plan",`${remaining>=0?"+":"−"}${fmt(Math.abs(remaining))}`,remaining>=0?"#22c55e":"#ef4444"]].map(([k,v,c])=>(
            <div key={k} style={{background:BG,borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:10,color:MUTED,marginBottom:3}}>{k}</div>
              <div style={{fontSize:16,fontWeight:900,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
          <Tag color="#06b6d4">ZIP: {zipCode || "not set"}</Tag>
          <Tag color="#a78bfa">Stores: {stores.length || 0}</Tag>
          <Tag color="#22c55e">Recipe links: {recipeCoveragePct}%</Tag>
          {activePlan?.generated_at && <Tag color="#f59e0b">Last AI plan: {new Date(activePlan.generated_at).toLocaleDateString()}</Tag>}
        </div>
      </Card>

      <Card>
        <Label>Monthly Target Tracking</Label>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,gap:8,flexWrap:"wrap"}}>
          <div style={{fontSize:12,color:MUTED}}>Auto-updates as new transactions are added or deleted.</div>
          <div style={{fontSize:12,fontWeight:800,color:remaining>=0?"#22c55e":"#ef4444"}}>
            {remaining>=0 ? `${fmt(remaining)} remaining` : `${fmt(Math.abs(remaining))} over target`}
          </div>
        </div>
        <PBar pct={spentPct} color={remaining>=0?"#22c55e":"#ef4444"} h={7}/>
        <div style={{display:"grid",gridTemplateColumns:wide?"repeat(4,1fr)":"1fr 1fr",gap:8,marginTop:10}}>
          {[
            ["Monthly target", fmt(plannedMonth), ACCENT],
            ["Spent so far", fmt(total), TEXT],
            ["AI est. month", aiMonthlyEstimate>0 ? fmt(aiMonthlyEstimate) : "—", aiDelta>=0?"#22c55e":"#ef4444"],
            ["AI vs target", aiMonthlyEstimate>0 ? `${aiDelta>=0?"+":"−"}${fmt(Math.abs(aiDelta))}` : "—", aiDelta>=0?"#22c55e":"#ef4444"],
          ].map(([k,v,c]) => (
            <div key={k} style={{background:BG,borderRadius:9,padding:"8px 10px"}}>
              <div style={{fontSize:10,color:MUTED,marginBottom:3}}>{k}</div>
              <div style={{fontSize:14,fontWeight:900,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <Label>AI Grocery + Meal Plan</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:10}}>Generates weekly meals, recipe links, grocery images, and source links proving estimated prices by store.</div>
        <div style={{display:"grid",gridTemplateColumns:wide?"repeat(2,1fr)":"1fr",gap:10}}>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Weekly budget</div>
            <input type="number" value={weeklyBudget} onChange={e=>setWeeklyBudget(Math.max(0, Number(e.target.value)||0))} placeholder="e.g. 250" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Household size</div>
            <input type="number" value={householdSize} onChange={e=>setHouseholdSize(Math.max(1, Number(e.target.value)||1))} placeholder="People eating these meals" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Plan days</div>
            <input type="number" value={planDays} onChange={e=>setPlanDays(Math.max(1, Math.min(14, Number(e.target.value)||7)))} placeholder="How many days to plan" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Stores</div>
            <input value={storeText} onChange={e=>setStoreText(e.target.value)} placeholder="Walmart, Aldi, Costco" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>ZIP code (for local price context)</div>
            <input value={zipCode} onChange={e=>setZipCode(e.target.value.replace(/[^\d-]/g, "").slice(0, 10))} placeholder="e.g. 73120" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Meal style</div>
            <input value={mealStyle} onChange={e=>setMealStyle(e.target.value)} placeholder="family-friendly, balanced" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>Goals / constraints</div>
            <input value={goalText} onChange={e=>setGoalText(e.target.value)} placeholder="high protein dinners, simple lunches, low waste" style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,width:"100%"}}/>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",marginTop:12,flexWrap:"wrap"}}>
          <button onClick={generatePlan} disabled={generating} style={{padding:"8px 14px",borderRadius:9,background:generating?"#334155":"#22c55e22",color:generating?MUTED:"#22c55e",border:`1px solid ${generating?"#334155":"#22c55e55"}`,fontWeight:800,fontSize:12,cursor:generating?"wait":"pointer"}}>
            {generating ? "Generating..." : "Generate AI Meal Plan"}
          </button>
          <span style={{fontSize:12,color:MUTED}}>Monthly target from weekly budget: <strong style={{color:ACCENT}}>{fmt(plannedMonth)}</strong></span>
        </div>
        {planErr && <div style={{fontSize:12,color:"#f59e0b",marginTop:10}}>{planErr}</div>}
      </Card>

      {activePlan && (
        <>
          <Card>
            <Label>Plan Summary</Label>
            <div style={{fontSize:13,color:MUTED,marginBottom:8}}>{activePlan.summary || "AI meal plan"}</div>
            <div style={{display:"grid",gridTemplateColumns:wide?"repeat(3,1fr)":"1fr 1fr",gap:10}}>
              {[
                ["AI weekly estimate", fmt(activePlan.estimated_weekly_total || 0), "#22c55e"],
                ["AI monthly estimate", fmt(activePlan.estimated_monthly_total || 0), "#06b6d4"],
                ["Your weekly target", fmt(weeklyBudget), ACCENT]
              ].map(([k,v,c])=>(
                <div key={k} style={{background:BG,borderRadius:10,padding:"10px 12px"}}>
                  <div style={{fontSize:10,color:MUTED,marginBottom:3}}>{k}</div>
                  <div style={{fontSize:16,fontWeight:900,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <Label>Weekly Meals</Label>
            {(activePlan.meals || []).length===0 ? <div style={{fontSize:12,color:MUTED}}>No meals returned.</div> : (activePlan.meals || []).map((m,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:wide?"90px 1fr 1fr 1fr":"1fr",gap:8,padding:"8px 2px",borderBottom:`1px solid ${i===activePlan.meals.length-1?"transparent":BORDER}`}}>
                <div style={{fontSize:12,fontWeight:700,color:ACCENT}}>{m.day || `Day ${i+1}`}</div>
                <div style={{fontSize:12,color:TEXT}}>
                  <strong style={{color:MUTED}}>Breakfast:</strong> {m.breakfast || "-"}
                  {m?.recipe_links?.breakfast && <a href={m.recipe_links.breakfast} target="_blank" rel="noreferrer" style={{marginLeft:6,color:"#22c55e",fontSize:11}}>Recipe</a>}
                </div>
                <div style={{fontSize:12,color:TEXT}}>
                  <strong style={{color:MUTED}}>Lunch:</strong> {m.lunch || "-"}
                  {m?.recipe_links?.lunch && <a href={m.recipe_links.lunch} target="_blank" rel="noreferrer" style={{marginLeft:6,color:"#22c55e",fontSize:11}}>Recipe</a>}
                </div>
                <div style={{fontSize:12,color:TEXT}}>
                  <strong style={{color:MUTED}}>Dinner:</strong> {m.dinner || "-"}
                  {m?.recipe_links?.dinner && <a href={m.recipe_links.dinner} target="_blank" rel="noreferrer" style={{marginLeft:6,color:"#22c55e",fontSize:11}}>Recipe</a>}
                </div>
              </div>
            ))}
          </Card>

          <Card>
            <Label>Grocery List + Store Cost Estimates</Label>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:8}}>
              <div style={{fontSize:11,color:MUTED}}>Each item includes price proof links when available.</div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <button onClick={copyShoppingList} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:BG,color:TEXT,fontSize:11,cursor:"pointer"}}>Copy shopping list</button>
                {copyMsg && <span style={{fontSize:11,color:"#22c55e"}}>{copyMsg}</span>}
              </div>
            </div>
            {(activePlan.grocery_items || []).length===0 ? <div style={{fontSize:12,color:MUTED}}>No grocery list returned.</div> : (
              <div style={{overflowX:"auto",border:`1px solid ${BORDER}`,borderRadius:10}}>
                <table style={{width:"100%",minWidth:900,borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:BG}}>
                      {["Item","Qty","Category","Meals it supports","Best Store","Store Costs","Price Proofs"].map(h => (
                        <th key={h} style={{padding:"9px 10px",textAlign:"left",fontSize:10,fontWeight:800,color:MUTED,textTransform:"uppercase",letterSpacing:".4px",borderBottom:`1px solid ${BORDER}`}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(activePlan.grocery_items || []).map((it,i)=>(
                      <tr key={i} style={{background:i%2===0?SURFACE:BG}}>
                        <td style={{padding:"10px",fontSize:13,fontWeight:700,color:TEXT,borderBottom:`1px solid ${BORDER}`}}>{it.item || "Unnamed item"}</td>
                        <td style={{padding:"10px",fontSize:12,color:MUTED,borderBottom:`1px solid ${BORDER}`}}>{it.quantity || "qty n/a"}</td>
                        <td style={{padding:"10px",fontSize:12,color:MUTED,borderBottom:`1px solid ${BORDER}`}}>{it.category || "General"}</td>
                        <td style={{padding:"10px",fontSize:12,color:TEXT,borderBottom:`1px solid ${BORDER}`}}>{it.meal_usage || "Not specified by AI"}</td>
                        <td style={{padding:"10px",fontSize:12,color:"#22c55e",fontWeight:800,borderBottom:`1px solid ${BORDER}`}}>
                          {it.best_store || "n/a"} {it.best_cost!=null ? fmt(it.best_cost) : ""}
                        </td>
                        <td style={{padding:"10px",fontSize:11,color:MUTED,borderBottom:`1px solid ${BORDER}`}}>
                          {Object.entries(it.store_costs || {}).length
                            ? Object.entries(it.store_costs || {}).map(([sn,sv]) => (
                                <div key={sn}>{sn}: {typeof sv === "number" ? fmt(sv) : sv}</div>
                              ))
                            : "n/a"}
                        </td>
                        <td style={{padding:"10px",fontSize:11,borderBottom:`1px solid ${BORDER}`}}>
                          {!!(it.price_proof_links || []).length ? (
                            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                              {(it.price_proof_links || []).slice(0,4).map((lnk, idx)=>(
                                <a key={idx} href={lnk} target="_blank" rel="noreferrer" style={{color:"#06b6d4",textDecoration:"none",background:"#06b6d411",border:"1px solid #06b6d433",borderRadius:999,padding:"2px 8px"}}>
                                  Proof {idx+1}
                                </a>
                              ))}
                            </div>
                          ) : "n/a"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card>
        <Label>Monthly Meal / Grocery Notes</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:8}}>
          Notes are auto-saved by month and included in the AI meal-plan prompt.
        </div>
        <textarea
          value={listByMonth[selectedMonth] || ""}
          onChange={e=>setListByMonth(prev => ({ ...prev, [selectedMonth]: e.target.value }))}
          placeholder="Meal prep ideas, pantry list, low-cost recipes, stores to visit..."
          style={{width:"100%",minHeight:140,resize:"vertical",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",color:TEXT,fontSize:13,outline:"none"}}
        />
      </Card>
      <Card>
        <Label>Saved AI Responses - {selectedMonth}</Label>
        {activeResponses.length === 0 ? (
          <div style={{fontSize:12,color:MUTED}}>No saved meal-plan responses for this month yet.</div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <div style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:12,fontWeight:700,color:TEXT,marginBottom:6}}>Latest raw response (copy/paste for debug)</div>
              <textarea
                readOnly
                value={activeResponses[0]?.response || ""}
                style={{width:"100%",minHeight:150,resize:"vertical",background:"#0b1020",border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:"#cbd5e1",fontSize:11,outline:"none",fontFamily:"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace"}}
              />
            </div>
            {activeResponses.map((r, idx) => (
              <div key={idx} style={{background:BG,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px"}}>
                <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                  <div style={{fontSize:12,fontWeight:700,color:TEXT}}>{r.summary || "AI response"}</div>
                  <div style={{fontSize:11,color:MUTED}}>{new Date(r.at).toLocaleString()}</div>
                </div>
                <details>
                  <summary style={{fontSize:12,color:ACCENT,cursor:"pointer"}}>Show prompt</summary>
                  <div style={{marginTop:8,fontSize:11,color:MUTED,whiteSpace:"pre-wrap"}}>{r.prompt || "No prompt saved."}</div>
                </details>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const RECS = [
  {
    id: "groceries",
    icon: "🛒",
    color: "#f97316",
    title: "Reduce grocery spending with bulk buying",
    impact: "−$200-400/mo",
    tag: "Biggest lever",
    tagColor: "#ef4444",
    summary: "Groceries are often the largest variable expense in a household budget and the easiest to reduce.",
    steps: [
      "Shop at warehouse clubs (Costco, Sam's Club) for proteins, dairy, and household staples — price-per-unit is typically 30–50% lower than regular grocery stores.",
      "Plan meals for the week before shopping and build your list around what's on sale. Avoid shopping without a list.",
      "Batch cook on weekends: a big pot of rice, a protein, and roasted vegetables covers 4–5 lunches and reduces midweek spending.",
      "Freeze bulk proteins immediately after buying. Portion chicken, ground beef, or pork into meal-sized bags — this prevents waste and keeps costs low.",
      "Avoid pre-cut, pre-packaged, or single-serving items — whole heads of lettuce, block cheese, and whole fruit are 2–3× cheaper per serving.",
    ],
  },
  {
    id: "mealplan",
    icon: "🍳",
    color: "#22c55e",
    title: "Feed your household for less with meal planning",
    impact: "Reduces food waste",
    tag: "Practical",
    tagColor: "#22c55e",
    summary: "A simple weekly meal plan eliminates most unplanned food spending and reduces waste.",
    steps: [
      "Rotisserie chicken is one of the best grocery store values — dinner night 1, tacos night 2, soup night 3. One bird = 3 meals.",
      "Include 2 'cheap protein' nights per week: eggs (frittata, breakfast burritos), canned fish (tuna pasta), or beans (chili, soup). Under $2/serving.",
      "Batch cook on Sundays to build a week of lunches without thinking. Reduces both food waste and weekday takeout temptation.",
      "Keep a 'pantry meal' night once a week — use only what's already at home. Forces down odds and ends and skips a shopping trip.",
      "Shop the perimeter of the store first (produce, proteins, dairy) before hitting center aisles where processed, expensive items live.",
    ],
  },
  {
    id: "overspend",
    icon: "🚫",
    color: "#a78bfa",
    title: "Identify and stop your biggest impulse spending habit",
    impact: "−$200-500/mo",
    tag: "Behavior",
    tagColor: "#a78bfa",
    summary: "Most households have one primary 'convenience trap' store or habit that quietly drains the budget.",
    steps: [
      "Review last month's transactions and find the store or category you visited most often without a pre-planned list. That's your leak.",
      "Add friction: delete the app, remove saved payment methods, or switch to cash for that category.",
      "Use the 48-hour rule for any non-food purchase over $20 — add it to a wish list, wait 48 hours, then decide. Most impulse purchases evaporate.",
      "Combine errands into one planned trip per week instead of multiple small trips. Fewer trips = fewer opportunities for unplanned spending.",
      "Set a spending cap for discretionary categories and track it in real time. Awareness alone reduces spending by 15–20%.",
    ],
  },
  {
    id: "debt",
    icon: "💳",
    color: "#22c55e",
    title: "Debt snowball — eliminate payments in order",
    impact: "Frees cash flow",
    tag: "Debt strategy",
    tagColor: "#3b82f6",
    summary: "Every debt you eliminate permanently increases your monthly cash flow. Focus smallest balance first for quick wins.",
    steps: [
      "List all debts by balance (smallest to largest). Pay minimums on everything, then throw every extra dollar at the smallest balance.",
      "When the smallest debt is gone, roll its payment into the next one — your 'snowball' grows with every payoff.",
      "Celebrate each payoff — it's a real milestone. The psychological momentum of paying off a debt keeps you going.",
      "Do NOT take on any new debt while paying off existing balances — no financing deals, no buy-now-pay-later. Every new payment resets the snowball.",
      "Once all consumer debt is gone, redirect those payments to savings and investing. The cash flow improvement is immediate.",
    ],
  },
  {
    id: "dining",
    icon: "🍽️",
    color: "#10b981",
    title: "Set a hard monthly cap on dining out",
    impact: "−$50-200/mo",
    tag: "Quick win",
    tagColor: "#10b981",
    summary: "Dining out is usually the easiest category to trim without feeling deprived — a small plan goes a long way.",
    steps: [
      "Pick a specific number of 'eating out' events per month and stick to it. Four per month is a reasonable starting target.",
      "Coffee shop visits add up quickly — budget them as part of your dining cap, not separately.",
      "Pack lunches for work. Weekday convenience spending is where most unplanned dining dollars go. Batch cook on Sunday.",
      "When dining out, choose restaurants where you can get a satisfying meal for your budget. Save splurge restaurants for genuine celebrations.",
    ],
  },
  {
    id: "subscriptions",
    icon: "📺",
    color: "#6366f1",
    title: "Audit subscriptions and cut to an intentional amount",
    impact: "−$50-150/mo",
    tag: "Easy cut",
    tagColor: "#6366f1",
    summary: "Most households are paying for 3–5 subscriptions they barely use. A quarterly audit finds the waste.",
    steps: [
      "List every recurring charge from the past 3 months. Include streaming, apps, cloud storage, gym memberships, and any annual subscriptions.",
      "For each: Did you use it in the past 30 days? If not, cancel it. You can always re-subscribe.",
      "Rotate streaming services instead of keeping all at once — watch one for a month, cancel, start another. You only need one at a time.",
      "Check whether your library offers free digital services (Libby for ebooks/audiobooks, Kanopy for films) before paying for equivalents.",
      "Set a calendar reminder 3 days before any free trial ends so you can cancel before being charged.",
      "Review all subscriptions quarterly. The goal isn't zero subscriptions — it's only paying for things you actively use and value.",
    ],
  },
  {
    id: "emergency",
    icon: "🛡️",
    color: "#f59e0b",
    title: "Build a starter emergency fund first",
    impact: "Breaks the debt cycle",
    tag: "Foundation",
    tagColor: "#f59e0b",
    summary: "Without a cash buffer, every unexpected expense becomes debt. A $1,000 starter fund stops the bleeding.",
    steps: [
      "Open a dedicated savings account — not your checking. This is your 'don't touch' fund for true emergencies only (car repair, medical bill, appliance failure).",
      "Pause extra debt payments temporarily if needed to build $1,000 cash fast. The interest saved matters less than having a buffer.",
      "Once you have $1,000, resume debt payoff. After consumer debt is gone, grow to a full 3–6 month emergency fund.",
      "Keep the fund in a high-yield savings account (HYSA) — current rates 4–5%. Your emergency fund should earn something while it sits.",
      "Define what counts as an emergency before you need it. Car repairs, medical bills, job loss — yes. Vacation, sale items, concerts — no.",
    ],
  },
];

function Recommendations({ wide, isMobile }) {
  const { checkTxns, ccTxns, selectedMonth, availableMonths, normSurplus, payoffs, takeHome, groceryGoal, familySize, dashName } = useBudget();
  const [expanded, setExpanded] = useState(null);
  const [tipsByMonth, setTipsByMonth] = useState(() => ls.getJSON("budget_ai_tips_by_month", {}));
  const [promptByMonth, setPromptByMonth] = useState(() => ls.getJSON("budget_ai_prompts_by_month", {}));
  const [recs, setRecs]         = useState(() => {
    const saved = ls.getJSON("budget_ai_tips_by_month", {});
    return Array.isArray(saved?.[selectedMonth]) && saved[selectedMonth].length ? saved[selectedMonth] : RECS;
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [refreshErr, setRefreshErr] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const totalImpact = payoffs.reduce((s, p) => s + p.payment, 0);

  // Actual gap = actual income minus actual spending (not normalized)
  const actualIncome = [...checkTxns, ...ccTxns].filter(t => t.month === selectedMonth && t.cat === "Income").reduce((s,t)=>s+t.amount,0) || takeHome;
  const actualSpend  = [...checkTxns,...ccTxns].filter(t => t.month === selectedMonth && t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t)=>s+t.amount,0);
  const actualGap    = actualIncome - actualSpend;

  useEffect(() => {
    const monthTips = tipsByMonth[selectedMonth];
    setRecs(Array.isArray(monthTips) && monthTips.length ? monthTips : RECS);
    setShowPrompt(false);
  }, [selectedMonth, tipsByMonth]);

  const handleRefresh = async () => {
    if (!ANTHROPIC_API_KEY) {
      setRefreshErr("Add your Anthropic API key to the top of App.jsx (ANTHROPIC_API_KEY) to enable AI tips.");
      return;
    }
    setRefreshing(true);
    setRefreshProgress(8);
    setRefreshErr(null);
    const progressTimer = setInterval(() => {
      setRefreshProgress(p => Math.min(92, p + (p < 40 ? 10 : p < 70 ? 6 : 3)));
    }, 300);
    try {
      // Build a spending summary from actual transactions
      const allTxns = [...checkTxns, ...ccTxns].filter(t => t.month === selectedMonth && t.cat !== "Income" && t.cat !== "Transfer");
      const byCat = {};
      allTxns.forEach(t => { byCat[t.cat] = (byCat[t.cat]||0) + t.amount; });
      const spendSummary = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>`${cat}: $${amt.toFixed(2)}`).join(", ");
      const gapStr = normSurplus < 0 ? `monthly gap of $${Math.abs(normSurplus).toFixed(0)}` : `monthly surplus of $${normSurplus.toFixed(0)}`;
      const debtStr = payoffs.map(p=>`${p.name} ($${p.payment}/mo, payoff ${p.date})`).join("; ");
      const selectedIdx = APP_MONTHS.indexOf(selectedMonth);
      const previousMonths = availableMonths
        .filter(m => APP_MONTHS.indexOf(m) >= 0 && APP_MONTHS.indexOf(m) < selectedIdx)
        .slice(-3);
      const prevComparison = previousMonths.length
        ? previousMonths.map(m => {
            const inc = [...checkTxns, ...ccTxns].filter(t => t.month === m && t.cat === "Income").reduce((s,t)=>s+t.amount,0) || takeHome;
            const spd = [...checkTxns, ...ccTxns].filter(t => t.month === m && t.cat !== "Income" && t.cat !== "Transfer").reduce((s,t)=>s+t.amount,0);
            return `${m}: income $${inc.toFixed(2)}, spend $${spd.toFixed(2)}, gap $${(inc - spd).toFixed(2)}`;
          }).join(" | ")
        : "No prior months available yet.";

      const actualGroceries = byCat["Groceries"] || 0;
      const grocerySavings = Math.max(0, actualGroceries - groceryGoal).toFixed(0);
      const prompt = `You are a personal finance advisor for ${dashName}.

CURRENT SITUATION (${selectedMonth}):
- Family size: ${familySize}
- Take-home pay: $${takeHome.toFixed(2)}/mo
- Total spending: $${allTxns.reduce((s,t)=>s+t.amount,0).toFixed(2)}/mo
- Monthly gap (overspending): $${Math.abs(normSurplus).toFixed(0)}/mo (they are NEGATIVE — do NOT suggest savings/investing/emergency funds until this gap is eliminated)
- Spending by category: ${spendSummary}
- Previous month comparison (income/spend/gap): ${prevComparison}

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
        setTipsByMonth(prev => {
          const next = { ...prev, [selectedMonth]: parsed };
          ls.setJSON("budget_ai_tips_by_month", next);
          return next;
        });
        setPromptByMonth(prev => {
          const next = { ...prev, [selectedMonth]: prompt };
          ls.setJSON("budget_ai_prompts_by_month", next);
          return next;
        });
        setRefreshProgress(100);
      } else {
        throw new Error("Invalid response format");
      }
    } catch(e) {
      console.error(e);
      setRefreshErr("Couldn't refresh tips — make sure an API key is available. Showing original tips.");
      setRecs(RECS);
      setRefreshProgress(100);
    }
    clearInterval(progressTimer);
    setTimeout(() => setRefreshProgress(0), 600);
    setRefreshing(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Hero */}
      <Card glow="#22c55e">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:10,marginBottom:12}}>
          <Label style={{marginBottom:0}}>Your Financial Roadmap · {selectedMonth} 2026</Label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <button onClick={()=>setShowPrompt(v=>!v)} style={{
              display:"flex",alignItems:"center",gap:7,padding:"7px 12px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",
              background:"#33415522",color:MUTED,border:`1px solid ${BORDER}`,transition:"all .2s",flexShrink:0,
            }}>
              {showPrompt?"Hide":"Show"} last AI prompt
            </button>
            <button onClick={handleRefresh} disabled={refreshing} style={{
              display:"flex",alignItems:"center",gap:7,padding:"7px 14px",borderRadius:10,fontSize:12,fontWeight:700,cursor:refreshing?"wait":"pointer",
              background:refreshing?"#334155":"#818cf822",color:refreshing?MUTED:"#818cf8",
              border:`1px solid ${refreshing?"#334155":"#818cf844"}`,transition:"all .2s",flexShrink:0,
            }}>
              <span style={{display:"inline-block",animation:refreshing?"spin 1s linear infinite":"none",fontSize:14}}>✨</span>
              {refreshing?"Generating tips…":"Refresh tips with AI"}
            </button>
          </div>
        </div>
        {refreshErr && <div style={{fontSize:12,color:"#f59e0b",marginBottom:10,padding:"8px 12px",background:"#f59e0b11",borderRadius:8,border:"1px solid #f59e0b33"}}>{refreshErr}</div>}
        {(refreshing || refreshProgress > 0) && (
          <div style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:MUTED,marginBottom:6}}>
              <span>AI tip refresh progress</span>
              <span>{Math.round(refreshProgress)}%</span>
            </div>
            <div style={{height:8,borderRadius:99,background:"#1f2937",overflow:"hidden"}}>
              <div style={{height:"100%",width:`${refreshProgress}%`,background:"linear-gradient(90deg,#818cf8,#22d3ee)",transition:"width .25s ease"}}/>
            </div>
          </div>
        )}
        {showPrompt && (
          <div style={{marginBottom:10,padding:"10px 12px",background:BG,border:`1px solid ${BORDER}`,borderRadius:10}}>
            <div style={{fontSize:11,color:MUTED,marginBottom:6}}>Last AI prompt for {selectedMonth}</div>
            <pre style={{margin:0,whiteSpace:"pre-wrap",wordBreak:"break-word",fontSize:11,color:TEXT,lineHeight:1.45,maxHeight:180,overflowY:"auto"}}>
              {promptByMonth[selectedMonth] || "No saved AI prompt yet for this month. Click 'Refresh tips with AI' first."}
            </pre>
          </div>
        )}
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
  const { takeHome, t2CarryIn, setT2CarryIn, checkTxns, ccTxns, availableMonths, selectedMonth, titheSettings } = useBudget();
  const MONTHLY_TH = takeHome * TITHE_RATE;
  const carry = t2CarryIn;
  const setCarry = setT2CarryIn;
  const t1HoverFill = "#7c6af714";
  const t2HoverFill = "#f59e0b14";

  // Derive actual tithe data from transactions by month
  const ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const t1Keys = useMemo(() => (titheSettings.t1Keywords || "").split(",").map(k => k.trim().toLowerCase()).filter(Boolean), [titheSettings.t1Keywords]);
  const t2Keys = useMemo(() => (titheSettings.t2Keywords || "").split(",").map(k => k.trim().toLowerCase()).filter(Boolean), [titheSettings.t2Keywords]);
  const titheText = useCallback((t) => `${t?.desc || ""} ${t?.note || ""}`.toLowerCase(), []);

  // 1st Tithe: Giving & Tithe category spending per month (church transfers + Hillcrest etc)
  const T1_ACTUAL = useMemo(() => {
    return availableMonths.map(month => {
      const paid = [...checkTxns, ...ccTxns]
        .filter(t => {
          if (t.excludeFromTags || t.month !== month || t.cat !== "Giving & Tithe") return false;
          if (t1Keys.length === 0) return true;
          const hay = titheText(t);
          return t1Keys.some(k => hay.includes(k));
        })
        .reduce((s, t) => s + t.amount, 0);
      return { month: SHORT[ORDER.indexOf(month)], paid, notes: "" };
    });
  }, [checkTxns, ccTxns, availableMonths, t1Keys, titheText]);

  // 2nd Tithe: transfers to savings — matched by configurable keywords in desc
  const T2_ACTUAL = useMemo(() => {
    return availableMonths.map(month => {
      const saved = [...checkTxns, ...ccTxns]
        .filter(t => !t.excludeFromTags && t.month === month && t.cat === "Giving & Tithe" && t2Keys.length > 0 &&
          t2Keys.some(k => titheText(t).includes(k)))
        .reduce((s, t) => s + t.amount, 0);
      return { month: SHORT[ORDER.indexOf(month)], saved, notes: "" };
    });
  }, [checkTxns, ccTxns, availableMonths, t2Keys, titheText]);

  const currentMonth = availableMonths.length;

  // ── 1st Tithe YTD ─────────────────────────────────────────────────────────
  const t1YTD    = T1_ACTUAL.reduce((s, m) => s + m.paid, 0);
  const t1Expect = MONTHLY_TH * T1_ACTUAL.length; // what we should have paid
  const t1Over   = t1YTD - t1Expect;              // positive = gave more

  // ── 2nd Tithe: build month-by-month running balance ────────────────────────
  // Feast is October (month index 9). Save Jan–Sep (9 months), spend Oct, save Oct–Dec.
  // Simplified: show projected balance at Oct 1 based on current trend.
  const t2YTDSaved   = T2_ACTUAL.reduce((s, m) => s + m.saved, 0);
  const monthsToFeast = titheSettings.feastMonth - currentMonth; // months remaining before feast
  const t2Projected  = carry + t2YTDSaved + (monthsToFeast * MONTHLY_TH); // if on track
  const t2CurrentBal = carry + t2YTDSaved;

  // Build the full-year savings arc for the bar chart
  // Jan–Sep: accumulate. Oct: spend all. Nov–Dec: start fresh.
  const FEAST_MONTH = titheSettings.feastMonth;
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
    return { month: m, projected: Math.round(balance), actual: actualBal != null ? Math.round(actualBal) : null, isFeast: i === FEAST_MONTH };
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
          <div><strong style={{color:TEXT}}>1st Tithe target:</strong> 10% of monthly take-home = <strong style={{color:ACCENT}}>{fmt(MONTHLY_TH)}/mo</strong>.</div>
          <div><strong style={{color:TEXT}}>2nd Tithe:</strong> 10% saved monthly for the {["January","February","March","April","May","June","July","August","September","October","November","December"][titheSettings.feastMonth]} feast, then reset.</div>
          <div>Current take-home assumption: {fmt(takeHome)}/mo.</div>
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
            <Tooltip content={<Tip/>} cursor={{ fill: t1HoverFill }}/>
            <Bar dataKey="expected" name="Expected" fill={DIM} radius={[4,4,0,0]}/>
            <Bar dataKey="actual"   name="Actual"   radius={[4,4,0,0]}>
              {t1Chart.map((d,i)=><Cell key={i} fill={d.actual!=null?(d.actual>=MONTHLY_TH?"#22c55e":"#f59e0b"):"transparent"}/>)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

                {/* Breakdown — derived from imported transactions */}
        {T1_ACTUAL.some(m => m.paid > 0) && (() => {
          const currentMonthName = selectedMonth;
          const t1Txns = [...checkTxns, ...ccTxns].filter(t =>
            !t.excludeFromTags && t.month === currentMonthName && t.cat === "Giving & Tithe" &&
            (t1Keys.length === 0 || t1Keys.some(k => titheText(t).includes(k)))
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
                    <Tag color={t.id?.startsWith("cc") ? "#6366f1" : "#3b82f6"}>{t.id?.startsWith("cc") ? "Credit Card" : "Checking"}</Tag>
                    <span style={{fontSize:13, fontWeight:700, color:"#7c6af7", fontVariantNumeric:"tabular-nums"}}>{fmt(t.amount)}</span>
                  </div>
                </div>
              ))}
              <div style={{display:"flex", justifyContent:"space-between", padding:"9px 10px",
                borderTop:`1px solid ${BORDER}`, marginTop:4}}>
                <span style={{fontSize:12, fontWeight:700, color:MUTED}}>{currentMonthName} 1st Tithe total</span>
                <span style={{fontSize:14, fontWeight:900, color:"#7c6af7", fontVariantNumeric:"tabular-nums"}}>{fmt(t1Txns.reduce((s,t)=>s+t.amount,0))}</span>
              </div>
            </div>
          );
        })()}
      </Card>

      {/* ── 2ND TITHE ── */}
      <Card>
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:8}}>
          <Label style={{marginBottom:0}}>🏕️ 2nd Tithe — 1st of October Feast (10%)</Label>
          <Tag color="#f59e0b">Feast: {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][titheSettings.feastMonth]} 2026</Tag>
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
            <Tooltip formatter={(v, n) => [fmt(v), n]} content={<Tip/>} cursor={{ fill: t2HoverFill }}/>
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
          const currentMonthName = selectedMonth;
          const t2Txns = [...checkTxns, ...ccTxns].filter(t =>
            !t.excludeFromTags && t.month === currentMonthName && t.cat === "Giving & Tithe" &&
            t2Keys.length > 0 &&
            t2Keys.some(k => titheText(t).includes(k))
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
                    <Tag color={t.id?.startsWith("cc") ? "#6366f1" : "#3b82f6"}>{t.id?.startsWith("cc") ? "Credit Card" : "Checking"}</Tag>
                    <span style={{fontSize:13, fontWeight:700, color:"#f59e0b", fontVariantNumeric:"tabular-nums"}}>{fmt(t.amount)}</span>
                  </div>
                </div>
              )) : (
                <div style={{fontSize:12,color:MUTED,padding:"8px 10px"}}>
                  No 2nd tithe transfers found yet for the current keywords.
                </div>
              )}
              <div style={{display:"flex", justifyContent:"space-between", padding:"9px 10px",
                borderTop:`1px solid ${BORDER}`, marginTop:4}}>
                <span style={{fontSize:12, fontWeight:700, color:MUTED}}>{currentMonthName} 2nd Tithe saved</span>
                <span style={{fontSize:14, fontWeight:900, color:"#f59e0b", fontVariantNumeric:"tabular-nums"}}>{fmt(t2Txns.reduce((s,t)=>s+t.amount,0))}</span>
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
  const { checkTxns, ccTxns, availableMonths, selectedMonth, selectedYear, summaryRows, recurringItems } = useBudget();
  const [focusCat, setFocusCat] = useState(null);

  const MONTH_ORDER = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const chartHoverFill = "#818cf814";
  const chartHoverLine = { stroke: "#818cf866", strokeWidth: 1.5, strokeDasharray: "4 4" };

  // Build per-month totals for each category across all available months
  const trendData = useMemo(() => {
    return availableMonths.map(m => {
      const monthSnapshot = buildMonthBudgetSnapshot({
        month: m,
        year: selectedYear,
        checkTxns,
        ccTxns,
        recurringItems,
      });
      const row = { month: m.slice(0,3) };
      summaryRows.forEach(r => {
        const c = monthSnapshot.spendTxns
          .filter(t => t.cat === r.cat)
          .reduce((s,t) => s + Math.abs(Number(t.amount) || 0), 0);
        row[r.cat] = Math.round(c);
      });
      row._total = Math.round(monthSnapshot.spend);
      row._income = Math.round(monthSnapshot.incomeReceived);
      row._recurring = Math.round(monthSnapshot.recurringSpend);
      row._other = Math.round(monthSnapshot.nonRecurringSpend);
      return row;
    });
  }, [checkTxns, ccTxns, availableMonths, recurringItems, selectedYear, summaryRows]);

  // Month-over-month delta for selected cat
  const deltaData = focusCat && trendData.length >= 2
    ? trendData.map((d,i) => ({
        month: d.month,
        value: d[focusCat] || 0,
        delta: i === 0 ? 0 : ((d[focusCat]||0) - (trendData[i-1][focusCat]||0)),
      }))
    : [];

  const hasMultiple = availableMonths.length >= 2;
  const cashflowData = trendData.map(d => {
    const income = d._income || 0;
    const spend = d._total || 0;
    const net = income - spend;
    const savingsRate = income > 0 ? (net / income) * 100 : 0;
    return { month: d.month, income, spend, net, savingsRate };
  });
  const topTrendCats = useMemo(() => {
    return [...summaryRows]
      .map(r => ({ ...r, total: trendData.reduce((s, d) => s + (d[r.cat] || 0), 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 4)
      .filter(r => r.total > 0);
  }, [summaryRows, trendData]);
  const demoTrendData = useMemo(() => {
    if (hasMultiple) return [];
    const baseMonth = availableMonths[0] || selectedMonth || "January";
    const baseIdx = MONTH_ORDER.indexOf(baseMonth);
    const labels = [0, 1, 2].map(i => {
      const idx = baseIdx >= 0 ? (baseIdx + i) % MONTH_ORDER.length : i;
      return i === 0 ? MONTH_ORDER[idx].slice(0, 3) : `${MONTH_ORDER[idx].slice(0, 3)}*`;
    });
    const baseRow = trendData[0] || {};
    return labels.map((m, i) => {
      const row = { month: m };
      summaryRows.forEach((r, idx) => {
        const base = baseRow[r.cat] || 0;
        const slope = ((idx % 5) - 2) * 0.06;
        const curve = i === 0 ? 1 : 1 + slope * i;
        row[r.cat] = Math.max(0, Math.round(base * curve));
      });
      row._total = summaryRows.reduce((s, r) => s + (row[r.cat] || 0), 0);
      row._income = Math.max(0, Math.round((baseRow._income || 0) * (i === 0 ? 1 : 1 + 0.02 * i)));
      return row;
    });
  }, [hasMultiple, availableMonths, selectedMonth, trendData, summaryRows]);
  const demoTopCats = useMemo(() => {
    if (hasMultiple) return [];
    return [...summaryRows]
      .map(r => ({ ...r, total: demoTrendData.reduce((s, d) => s + (d[r.cat] || 0), 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .filter(r => r.total > 0);
  }, [hasMultiple, summaryRows, demoTrendData]);
  const comparisonLabelWidth = isMobile ? 188 : 180;
  const comparisonValueWidth = isMobile ? 112 : 96;
  const comparisonGrid = `${comparisonLabelWidth}px repeat(${availableMonths.length}, minmax(${comparisonValueWidth}px, 1fr))`;
  const comparisonMinWidth = comparisonLabelWidth + (availableMonths.length * comparisonValueWidth);
  const comparisonPadding = isMobile ? "10px 12px" : "10px 16px";
  const stickyColumnShadow = "10px 0 18px #02061740";

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
                <Tooltip cursor={{ fill: chartHoverFill }} formatter={v=>[fmt(v),"Spending"]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Bar dataKey="_total" name="Total Spend" radius={[6,6,0,0]}>
                  {trendData.map((d,i)=>(
                    <Cell key={i} fill={d.month===selectedMonth.slice(0,3)?"#818cf8":"#818cf844"}/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <Label>Income vs Spending</Label>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={cashflowData} margin={{ left: -14 }}>
                <CartesianGrid stroke={BORDER} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fontSize:11,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} width={40}/>
                <Tooltip cursor={chartHoverLine} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Legend />
                <Area type="monotone" dataKey="income" name="Income" stroke="#22c55e" fill="#22c55e22" />
                <Area type="monotone" dataKey="spend" name="Spending" stroke="#ef4444" fill="#ef444422" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <Label>Recurring vs Other Spend</Label>
            <div style={{fontSize:12,color:MUTED,marginBottom:10}}>
              Recurring includes transactions you marked recurring plus close merchant matches from your recurring planning items.
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={trendData} barCategoryGap="35%">
                <CartesianGrid stroke={BORDER} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fontSize:11,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} width={40}/>
                <Tooltip cursor={{ fill: chartHoverFill }} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Legend />
                <Bar dataKey="_recurring" name="Recurring spend" stackId="split" fill="#22c55e" radius={[5,5,0,0]} />
                <Bar dataKey="_other" name="Other spend" stackId="split" fill="#475569" radius={[5,5,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <Label>Top Category Trends</Label>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData} margin={{ left: -14 }}>
                <CartesianGrid stroke={BORDER} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis tick={{fontSize:11,fill:MUTED}} axisLine={false} tickLine={false} tickFormatter={v=>`$${(v/1000).toFixed(0)}k`} width={40}/>
                <Tooltip cursor={chartHoverLine} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Legend />
                {topTrendCats.map(c => (
                  <Line key={c.cat} type="monotone" dataKey={c.cat} stroke={c.color} strokeWidth={2.5} dot={{r:3}} activeDot={{r:5}} />
                ))}
              </LineChart>
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
                <Tooltip cursor={{ fill: chartHoverFill }} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:11,maxHeight:300,overflowY:"auto"}}/>
                {summaryRows.filter(r => !focusCat || r.cat === focusCat).map((r, ri, arr) => (
                  <Bar key={r.cat} dataKey={r.cat} stackId="a" fill={r.color}
                    opacity={focusCat && focusCat !== r.cat ? 0.15 : 1}
                    radius={ri === arr.length-1 ? [4,4,0,0] : [0,0,0,0]}/>
                ))}
              </BarChart>
            </ResponsiveContainer>
            {/* Category legend — click to focus */}
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:12}}>
              {summaryRows.map(r=>(
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
                  <Tooltip cursor={{ fill: chartHoverFill }} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
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
            <div style={{overflowX:"auto",WebkitOverflowScrolling:"touch"}}>
              {/* Header row */}
              <div style={{display:"grid",gridTemplateColumns:comparisonGrid,padding:comparisonPadding,background:BG,borderBottom:`1px solid ${BORDER}`,minWidth:comparisonMinWidth}}>
                <div style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px",position:"sticky",left:0,background:BG,zIndex:3,boxShadow:stickyColumnShadow}}>Category</div>
                {availableMonths.map(m=>(
                  <div key={m} style={{fontSize:10,fontWeight:700,color:m===selectedMonth?ACCENT:MUTED,textTransform:"uppercase",letterSpacing:".5px",textAlign:"right"}}>{m.slice(0,3)}</div>
                ))}
              </div>
              {summaryRows.map((r,i)=>{
                const rowBg = i%2===0?SURFACE:BG;
                return (
                  <div key={r.cat} style={{display:"grid",gridTemplateColumns:comparisonGrid,padding:isMobile?"11px 12px":"9px 16px",borderBottom:`1px solid ${BORDER}`,background:rowBg,alignItems:"center",minWidth:comparisonMinWidth}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,position:"sticky",left:0,background:rowBg,zIndex:2,boxShadow:stickyColumnShadow,paddingRight:12}}>
                      <div style={{width:8,height:8,borderRadius:2,background:r.color,flexShrink:0}}/>
                      <span style={{fontSize:isMobile?11:12,color:TEXT}}>{r.cat}</span>
                    </div>
                    {availableMonths.map((m,mi)=>{
                      const val = trendData[mi]?.[r.cat]||0;
                      const prev = mi>0 ? (trendData[mi-1]?.[r.cat]||0) : null;
                      const delta = prev!==null ? val-prev : 0;
                      return (
                        <div key={m} style={{textAlign:"right"}}>
                          <div style={{fontSize:isMobile?11:12,fontWeight:700,color:m===selectedMonth?TEXT:MUTED,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{val>0?fmt(val):"—"}</div>
                          {mi>0&&val>0&&<div style={{fontSize:10,color:delta>0?"#ef4444":"#22c55e",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{delta>0?"+":""}{fmt(delta)}</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Totals */}
              <div style={{display:"grid",gridTemplateColumns:comparisonGrid,padding:comparisonPadding,background:BG,borderTop:`2px solid ${BORDER}`,minWidth:comparisonMinWidth}}>
                <div style={{fontSize:12,fontWeight:800,color:MUTED,position:"sticky",left:0,background:BG,zIndex:3,boxShadow:stickyColumnShadow}}>Total</div>
                {trendData.map((d,i)=>(
                  <div key={i} style={{textAlign:"right",fontSize:13,fontWeight:900,color:availableMonths[i]===selectedMonth?ACCENT:MUTED,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmt(d._total)}</div>
                ))}
              </div>
            </div>
          </Card>
        </>
      )}

      {/* Single-month: show demo trend cards + selected month summary */}
      {!hasMultiple && (
        <>
          <Card>
            <Label>Example Trend Preview</Label>
            <div style={{fontSize:12,color:MUTED,marginBottom:10}}>
              These sample projections stay local and preview how trend charts will look after a second month is imported.
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={demoTrendData} margin={{ left: -14 }}>
                <CartesianGrid stroke={BORDER} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis hide />
                <Tooltip cursor={chartHoverLine} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Legend />
                <Area type="monotone" dataKey="_income" name="Income (sample)" stroke="#22c55e" fill="#22c55e22" />
                <Area type="monotone" dataKey="_total" name="Spending (sample)" stroke="#ef4444" fill="#ef444422" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <Label>Example Category Trends</Label>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={demoTrendData} margin={{ left: -14 }}>
                <CartesianGrid stroke={BORDER} strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{fontSize:12,fill:MUTED}} axisLine={false} tickLine={false}/>
                <YAxis hide />
                <Tooltip cursor={chartHoverLine} formatter={(v,n)=>[fmt(v),n]} contentStyle={{background:SURFACE,border:`1px solid ${BORDER}`,borderRadius:10,fontSize:12}}/>
                <Legend />
                {demoTopCats.map(c => (
                  <Line key={c.cat} type="monotone" dataKey={c.cat} stroke={c.color} strokeWidth={2.5} dot={{r:3}} activeDot={{r:5}} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card>
            <Label>{selectedMonth} 2026 � Category Summary</Label>
            <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
              {summaryRows.map(r=>{
                const val = [...checkTxns,...ccTxns].filter(t=>t.month===selectedMonth&&t.cat===r.cat&&t.cat!=="Transfer"&&t.cat!=="Income").reduce((s,t)=>s+t.amount,0);
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
        </>
      )}
    </div>
  );
}


// ── EMOJI INPUT ──────────────────────────────────────────────────────────────
const EMOJI_SUGGESTIONS = [
  "📁","🏠","🚗","💳","🛒","🍳","💊","🧒","📺","✈️",
  "🏥","⛽","🎓","💰","📱","🐾","🌱","🎮","🔧","📚",
  "🎵","🛍️","☕","🐶","💼","🎯","🏦","🎁","🌍","🍕",
  "🏋️","🎨","📷","🚀","❤️","💻","🎪","🎬","🍺","🌿",
];
function EmojiInput({ value, onChange, inputStyle }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const handler = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  return (
    <div ref={wrapRef} style={{position:"relative",display:"inline-block"}}>
      <input value={value} onChange={e=>onChange(e.target.value)} onFocus={()=>setOpen(true)} style={inputStyle}/>
      {open && (
        <div style={{position:"absolute",zIndex:200,top:"calc(100% + 4px)",left:"50%",transform:"translateX(-50%)",
          background:"#161b27",border:`1px solid ${BORDER}`,borderRadius:12,padding:8,
          display:"grid",gridTemplateColumns:"repeat(8,1fr)",gap:1,width:244,
          boxShadow:"0 8px 32px #00000099"}}>
          {EMOJI_SUGGESTIONS.map(e=>(
            <button key={e} onMouseDown={ev=>{ev.preventDefault();onChange(e);setOpen(false);}}
              style={{background:value===e?"#ffffff18":"none",border:"none",fontSize:18,cursor:"pointer",
                padding:"4px 2px",borderRadius:6,lineHeight:1,transition:"background .1s"}}>
              {e}
            </button>
          ))}
          <div style={{gridColumn:"1/-1",borderTop:`1px solid ${BORDER}`,paddingTop:6,marginTop:4,
            fontSize:10,color:MUTED,textAlign:"center"}}>
            or type · paste · <kbd style={{background:"#0d1117",border:`1px solid ${BORDER}`,borderRadius:3,padding:"0 4px",fontFamily:"monospace",fontSize:9}}>Win+.</kbd> for more
          </div>
        </div>
      )}
    </div>
  );
}

// ── SETTINGS ────────────────────────────────────────────────────────────────
function NewCatInput({ onAdd, allCats }) {
  const [val, setVal] = useState("");
  const [icon, setIcon] = useState("📁");
  const [color, setColor] = useState("#94a3b8");
  const submit = () => {
    const name = val.trim();
    if (!name || allCats.map(c=>c.toLowerCase()).includes(name.toLowerCase())) return;
    onAdd({ name, icon: icon || "📁", color: color || "#94a3b8" });
    setVal(""); setIcon("📁"); setColor("#94a3b8");
  };
  return (
    <div>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
        <div style={{width:40,textAlign:"center",fontSize:10,color:MUTED}}>Icon</div>
        <div style={{width:40,textAlign:"center",fontSize:10,color:MUTED}}>Color</div>
        <div style={{flex:1,fontSize:10,color:MUTED}}>Name</div>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <EmojiInput value={icon} onChange={setIcon}
          inputStyle={{width:40,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"6px 4px",color:TEXT,fontSize:18,outline:"none",textAlign:"center",cursor:"pointer"}}/>
        <input type="color" value={color} onChange={e=>setColor(e.target.value)}
          style={{width:40,height:36,background:"transparent",border:`1px solid ${BORDER}`,borderRadius:8,cursor:"pointer",padding:2,flexShrink:0}}/>
        <input value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
          placeholder="New category name…"
          style={{flex:1,minWidth:120,background:BG,border:`1px solid #06b6d4`,borderRadius:8,padding:"7px 12px",color:TEXT,fontSize:13,outline:"none"}}/>
        <button onClick={submit}
          style={{padding:"7px 16px",borderRadius:8,background:"#06b6d4",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
          + Add
        </button>
      </div>
    </div>
  );
}

function Settings({ isMobile }) {
  const {
    takeHome, setTakeHome,
    oneTimes, setOneTimes, recurringItems, setRecurringItems,
    budgetKc, setBudgetKc,
    t2CarryIn, setT2CarryIn,
    groceryGoal, setGroceryGoal,
    familySize, setFamilySize,
    clearTxns, addTxns, checkTxns, ccTxns,
    payoffs, setPayoffs,
    summaryRows,
    waterfallDisabled, setWaterfallDisabled,
    dashName, setDashName,
    showTithe, setShowTithe,
    showABA,   setShowABA,
    readabilityMode, setReadabilityMode,
    uiScale, setUiScale,
    hideZeroSummaryCats, setHideZeroSummaryCats,
    mobileTxnActionMenu, setMobileTxnActionMenu,
    customCats, setCustomCats, allCats,
    subcatsByCat, setSubcatsByCat,
    abaSettings, setAbaSettings,
    titheSettings, setTitheSettings,
    retargetCat,
  } = useBudget();

  const [deletingCat, setDeletingCat] = useState(null); // name of custom cat pending delete
  const [moveTo, setMoveTo]           = useState("");

  const handleDeleteClick = (catName) => {
    const txnCount = [...checkTxns, ...ccTxns].filter(t => t.cat === catName).length;
    if (txnCount === 0) {
      if (!confirmDeleteAction(`Delete category \"${catName}\"?`)) return;
      setCustomCats(prev => prev.filter(c => c.name !== catName));
      setSubcatsByCat(prev => {
        const next = { ...prev };
        delete next[catName];
        return next;
      });
    } else {
      // Has transactions — require move-to selection
      const firstOther = allCats.find(c => c !== catName) || "";
      setMoveTo(firstOther);
      setDeletingCat(catName);
    }
  };

  const confirmDelete = () => {
    if (!deletingCat || !moveTo) return;
    if (!confirmDeleteAction(`Move transactions to "${moveTo}" and delete "${deletingCat}"?`)) return;
    retargetCat(deletingCat, moveTo);
    setCustomCats(prev => prev.filter(c => c.name !== deletingCat));
    setSubcatsByCat(prev => {
      const next = { ...prev };
      delete next[deletingCat];
      return next;
    });
    setDeletingCat(null);
    setMoveTo("");
  };

  const [thInput, setThInput]     = useState(takeHome || "");
  const [familyInput, setFamilyInput] = useState(familySize || 4);
  const [t2Input, setT2Input]     = useState(t2CarryIn || "");
  const [otDesc, setOtDesc]       = useState("");
  const [otAmt, setOtAmt]         = useState("");
  const [otCat, setOtCat]         = useState(allCats[0]);
  const [subcatCat, setSubcatCat] = useState(() => allCats.find(c => c !== "Income" && c !== "Transfer") || allCats[0] || "");
  const [subcatInput, setSubcatInput] = useState("");
  const [confirmClear, setConfirmClear] = useState(null);
  const [importErr, setImportErr] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState(() => { try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; } });
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const recurringSourceTxns = useMemo(() => [
    ...checkTxns.map(t => ({ ...t, src: "checking" })),
    ...ccTxns.map(t => ({ ...t, src: "cc" })),
  ].filter(isSpendTxn), [checkTxns, ccTxns]);
  const saveApiKey = () => { try { localStorage.setItem("budget_apikey", apiKeyInput); setApiKeySaved(true); setTimeout(() => setApiKeySaved(false), 2000); } catch {} };
  useEffect(() => { setFamilyInput(familySize || 4); }, [familySize]);
  useEffect(() => {
    if (!allCats.includes(subcatCat)) setSubcatCat(allCats.find(c => c !== "Income" && c !== "Transfer") || allCats[0] || "");
  }, [allCats, subcatCat]);

  const accentSet = "#a78bfa";
  const activeSubcats = getConfiguredSubcategoryOptions(subcatsByCat, subcatCat);

  const addSubcategoryOption = () => {
    const name = normalizeTxnSubcategory(subcatInput);
    if (!subcatCat || !name) return;
    setSubcatsByCat(prev => ({
      ...prev,
      [subcatCat]: normalizeSubcategoryOptions([...(prev[subcatCat] || []), name]),
    }));
    setSubcatInput("");
  };
  const removeSubcategoryOption = (cat, subcat) => {
    setSubcatsByCat(prev => {
      const nextOptions = getConfiguredSubcategoryOptions(prev, cat)
        .filter(option => option.toLowerCase() !== subcat.toLowerCase());
      const next = { ...prev };
      if (nextOptions.length) next[cat] = nextOptions;
      else delete next[cat];
      return next;
    });
  };

  const exportData = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      checkTxns, ccTxns,
      takeHome, t2CarryIn, groceryGoal,
      familySize,
      subcatsByCat,
      oneTimes, recurringItems, budgetKc, payoffs,
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
        if (d.familySize) setFamilySize(Math.max(1, parseInt(d.familySize, 10) || 1));
        if (d.subcatsByCat) setSubcatsByCat(normalizeSubcategoriesByCat(d.subcatsByCat));
        else if (d.checkTxns || d.ccTxns) setSubcatsByCat(collectTxnSubcategoriesByCat([...(d.checkTxns || []), ...(d.ccTxns || [])]));
        if (d.oneTimes)   setOneTimes(d.oneTimes);
        if (d.recurringItems) setRecurringItems(d.recurringItems);
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

      {/* Readability */}
      <Card glow="#22c55e" style={{marginTop:16}}>
        <Label>🔎 Readability</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>
          Improve readability on larger displays by scaling the desktop UI.
        </div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:10}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:TEXT}}>Large Text Mode</div>
            <div style={{fontSize:11,color:MUTED}}>Applies on desktop and widescreen layouts.</div>
          </div>
          <button
            onClick={() => setReadabilityMode(v => !v)}
            style={{
              padding:"5px 16px",
              borderRadius:8,
              fontSize:12,
              fontWeight:800,
              cursor:"pointer",
              transition:"all .15s",
              background:readabilityMode ? "#22c55e22" : BORDER,
              color:readabilityMode ? "#22c55e" : MUTED,
              border:`1px solid ${readabilityMode ? "#22c55e55" : BORDER}`,
            }}
          >
            {readabilityMode ? "✓ On" : "Off"}
          </button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:12,color:MUTED,minWidth:74}}>Font Scale</span>
          <select
            value={String(uiScale)}
            onChange={e => setUiScale(parseFloat(e.target.value) || 1)}
            disabled={!readabilityMode}
            style={{
              width:120,
              background:BG,
              border:`1px solid ${readabilityMode ? "#22c55e55" : BORDER}`,
              borderRadius:8,
              padding:"7px 10px",
              color:readabilityMode ? TEXT : DIM,
              fontSize:13,
              outline:"none",
              opacity:readabilityMode ? 1 : 0.6,
            }}
          >
            <option value="1">100%</option>
            <option value="1.1">110%</option>
            <option value="1.2">120%</option>
            <option value="1.3">130%</option>
          </select>
        </div>
      </Card>

      {/* Feature Toggles */}
      <Card glow="#7c6af7" style={{marginTop:16}}>
        <Label>🔀 Feature Toggles</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>Hide tabs, sub-tabs, and categories you don't need. Data for hidden categories is still tracked — it just won't appear in the relevant views.</div>
        {[
          { key:"tithe", label:"Tithe Tracker", emoji:"🙏", desc:"Giving & Tithe category + Scenarios sub-tab", val:showTithe, set:setShowTithe },
          { key:"aba",   label:"ABA Planner",   emoji:"🧩", desc:"ABA Therapy category + Scenarios sub-tab",   val:showABA,   set:setShowABA   },
          { key:"hideZeroSummary", label:"Hide $0 Summary Rows", emoji:"📉", desc:"Hide zero-amount categories in Summary breakdown", val:hideZeroSummaryCats, set:setHideZeroSummaryCats },
          { key:"mobileTxnActionMenu", label:"Compact Mobile Txn Actions", emoji:"📱", desc:"Show one Options button on mobile transaction rows", val:mobileTxnActionMenu, set:setMobileTxnActionMenu },
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
      <Card glow="#818cf8" style={{marginTop:16}}>
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
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Add categories with a custom icon and color. They appear everywhere categories are listed.</div>
        <div style={{fontSize:11,color:MUTED,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 12px",marginBottom:12,lineHeight:1.6}}>
          <strong style={{color:TEXT}}>Icon tip:</strong> paste any emoji into the icon box.
          {" "}On <strong style={{color:TEXT}}>Windows</strong> press <kbd style={{background:"#1e2535",border:`1px solid ${BORDER}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontFamily:"monospace"}}>Win + .</kbd> to open the emoji picker.
          {" "}On <strong style={{color:TEXT}}>Mac</strong> press <kbd style={{background:"#1e2535",border:`1px solid ${BORDER}`,borderRadius:4,padding:"1px 5px",fontSize:10,fontFamily:"monospace"}}>Ctrl + Cmd + Space</kbd>.
        </div>
        {customCats.length > 0 && (
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom: deletingCat ? 12 : 0}}>
              {customCats.map(c => {
                const isPending = deletingCat === c.name;
                return (
                  <div key={c.name} style={{display:"flex",alignItems:"center",gap:5,
                    background: isPending ? "#ef444422" : c.color+"22",
                    border:`1px solid ${isPending ? "#ef444466" : c.color+"44"}`,
                    borderRadius:99,padding:"3px 10px",transition:"all .15s"}}>
                    <span style={{fontSize:14}}>{c.icon}</span>
                    <span style={{fontSize:12,color: isPending ? "#ef4444" : c.color,fontWeight:600}}>{c.name}</span>
                    <button onClick={() => isPending ? setDeletingCat(null) : handleDeleteClick(c.name)}
                      style={{background:"none",border:"none",color: isPending ? "#ef4444" : c.color,
                        fontSize:12,cursor:"pointer",padding:0,lineHeight:1,opacity:.7}}>
                      {isPending ? "↩" : "✕"}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Move-and-confirm panel — shown when a cat with transactions is being deleted */}
            {deletingCat && (() => {
              const txnCount = [...checkTxns, ...ccTxns].filter(t => t.cat === deletingCat).length;
              const pendingCat = customCats.find(c => c.name === deletingCat);
              return (
                <div style={{padding:"14px 16px",borderRadius:12,background:"#ef444411",border:"1px solid #ef444433"}}>
                  <div style={{fontSize:13,fontWeight:700,color:"#ef4444",marginBottom:8}}>
                    🗑 Delete "{deletingCat}"
                  </div>
                  <div style={{fontSize:12,color:MUTED,marginBottom:12}}>
                    <strong style={{color:TEXT}}>{txnCount} transaction{txnCount !== 1 ? "s" : ""}</strong> are assigned to this category.
                    Choose where to move them before deleting.
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontSize:12,color:MUTED,whiteSpace:"nowrap"}}>Move to:</span>
                    <select value={moveTo} onChange={e => setMoveTo(e.target.value)}
                      style={{flex:"1 1 160px",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,
                        padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}>
                      {allCats.filter(c => c !== deletingCat).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button onClick={confirmDelete} disabled={!moveTo}
                      style={{padding:"7px 16px",borderRadius:8,fontWeight:800,fontSize:13,cursor:"pointer",border:"none",
                        background:moveTo?"#ef4444":"#1e2535",color:moveTo?"white":MUTED,transition:"all .15s",whiteSpace:"nowrap"}}>
                      ✓ Confirm &amp; Delete
                    </button>
                    <button onClick={() => setDeletingCat(null)}
                      style={{padding:"7px 14px",borderRadius:8,fontWeight:600,fontSize:13,cursor:"pointer",
                        background:BG,color:MUTED,border:`1px solid ${BORDER}`}}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
        <NewCatInput onAdd={nc => setCustomCats(prev => prev.some(c => c.name === nc.name) ? prev : [...prev, nc])} allCats={allCats} />
      </Card>

      {/* Subcategories */}
      <Card glow="#38bdf8" style={{marginTop:16}}>
        <Label>🧷 Subcategories</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>
          Manage subcategory options for each category. These appear as dropdown choices when adding, editing, or splitting transactions.
        </div>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,200px) minmax(0,1fr)",gap:10,alignItems:"end"}}>
          <div>
            <div style={{fontSize:11,color:MUTED,marginBottom:6}}>Category</div>
            <select
              value={subcatCat}
              onChange={e => setSubcatCat(e.target.value)}
              style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,outline:"none"}}
            >
              {allCats.filter(c => c !== "Income" && c !== "Transfer").map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{fontSize:11,color:MUTED}}>
            Existing transaction values are preserved. Removing an option only hides it from future selection lists.
          </div>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:12,marginBottom:12}}>
          {activeSubcats.length === 0 && (
            <div style={{fontSize:12,color:DIM}}>No subcategories configured for this category yet.</div>
          )}
          {activeSubcats.map(name => (
            <div
              key={name}
              style={{
                display:"inline-flex",
                alignItems:"center",
                gap:6,
                padding:"6px 10px",
                borderRadius:999,
                border:`1px solid ${BORDER}`,
                background:"#0f172a",
              }}
            >
              <span style={{fontSize:12,color:TEXT}}>{name}</span>
              <button
                onClick={() => removeSubcategoryOption(subcatCat, name)}
                style={{background:"none",border:"none",color:DIM,cursor:"pointer",padding:0,fontSize:12,lineHeight:1}}
                aria-label={`Remove ${name}`}
                title="Remove subcategory"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input
            value={subcatInput}
            onChange={e => setSubcatInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addSubcategoryOption(); } }}
            placeholder="Add subcategory"
            style={{flex:"1 1 240px",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:13,outline:"none"}}
          />
          <button
            onClick={addSubcategoryOption}
            style={{padding:"8px 14px",borderRadius:8,border:"none",background:"#38bdf8",color:"#082f49",fontWeight:800,cursor:"pointer"}}
          >
            + Add
          </button>
        </div>
      </Card>

      {/* ABA Settings — visible only when ABA feature is enabled */}
      {showABA && (
      <Card glow="#8b5cf6" style={{marginTop:16}}>
        <Label>🧩 ABA Therapy Settings</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>Customize cost calculations used in the Scenarios → ABA tab.</div>
        {[
          { key:"costPerVisit", label:"Cost per visit ($)", min:1,   step:5   },
          { key:"oopCap",       label:"Annual out-of-pocket cap ($)", min:100, step:100 },
        ].map(f => (
          <div key={f.key} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <span style={{fontSize:13,color:TEXT,flex:1}}>{f.label}</span>
            <input type="number" value={abaSettings[f.key]} min={f.min} step={f.step}
              onChange={e => setAbaSettings(prev => ({ ...prev, [f.key]: parseFloat(e.target.value) || prev[f.key] }))}
              style={{width:100,background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"5px 8px",color:TEXT,fontSize:13,outline:"none"}}/>
          </div>
        ))}
      </Card>
      )}

      {/* Tithe Settings — visible only when Tithe feature is enabled */}
      {showTithe && (
      <Card glow="#7c6af7" style={{marginTop:16}}>
        <Label>⛪ Tithe Settings</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:14}}>Configure which transactions count as 1st / 2nd Tithe and set the feast month.</div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <div style={{fontSize:12,color:MUTED,marginBottom:6}}>1st Tithe — filter keywords (comma-separated · blank = all Giving &amp; Tithe)</div>
            <input value={titheSettings.t1Keywords}
              onChange={e => setTitheSettings(prev => ({ ...prev, t1Keywords: e.target.value }))}
              placeholder="e.g. hillcrest,church — leave blank to include all"
              style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
          </div>
          <div>
            <div style={{fontSize:12,color:MUTED,marginBottom:6}}>2nd Tithe — filter keywords (comma-separated · matched against transaction description)</div>
            <input value={titheSettings.t2Keywords}
              onChange={e => setTitheSettings(prev => ({ ...prev, t2Keywords: e.target.value }))}
              placeholder="e.g. 8500,2nd tithe,feast"
              style={{width:"100%",background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:"7px 10px",color:TEXT,fontSize:13,outline:"none"}}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:13,color:TEXT,flex:1}}>Feast month</span>
            <select value={titheSettings.feastMonth}
              onChange={e => setTitheSettings(prev => ({ ...prev, feastMonth: parseInt(e.target.value, 10) || 0 }))}
              style={{minWidth:140,background:BG,border:`1px solid ${BORDER}`,borderRadius:6,padding:"6px 10px",color:TEXT,fontSize:13,outline:"none"}}>
              {MONTHS.map((m, idx) => <option key={m} value={idx}>{m}</option>)}
            </select>
          </div>
        </div>
      </Card>
      )}

      {/* Waterfall Visibility */}
      <Card glow="#f97316" style={{marginTop:16}}>
        <Label>Budget Impact Waterfall - Visible Steps</Label>
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
      <Card glow={accentSet} style={{marginTop:16}}>
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

      <Card glow="#22c55e" style={{marginTop:16}}>
        <Label>Family Size</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:10}}>Used in AI tips context and meal-planning recommendations.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input
            type="number" min={1} value={familyInput}
            onChange={e => setFamilyInput(Math.max(1, parseInt(e.target.value, 10) || 1))}
            onBlur={() => setFamilySize(Math.max(1, parseInt(familyInput, 10) || 1))}
            style={{width:120,background:BG,border:`1px solid #22c55e`,borderRadius:8,padding:"8px 10px",color:TEXT,fontSize:15,outline:"none"}}
          />
          <button onClick={() => setFamilySize(Math.max(1, parseInt(familyInput, 10) || 1))}
            style={{padding:"8px 16px",borderRadius:8,background:"#22c55e",color:"#0d1117",fontWeight:800,fontSize:13,border:"none",cursor:"pointer"}}>
            Save
          </button>
        </div>
        <div style={{marginTop:8,fontSize:12,color:"#22c55e"}}>Current: {familySize} {familySize===1 ? "person" : "people"}</div>
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

      {/* Recurring Planning Items */}
      <Card glow="#22c55e" style={{marginTop:16}}>
        <Label>Recurring Planning Items</Label>
        <div style={{fontSize:12,color:MUTED,marginBottom:12}}>Mark a transaction as recurring in Transactions to carry it into future months when the actual charge has not arrived yet.</div>
        {recurringItems.length > 0 ? (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {recurringItems.map((item, i) => (
              <div key={buildRecurringItemKey(item) || i} style={{display:"flex",alignItems:"center",gap:8,background:BG,borderRadius:8,padding:"6px 10px"}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,color:TEXT}}>{item.name}</div>
                  <div style={{fontSize:11,color:MUTED}}>
                    {item.cat} · {recurringSourceLabel(item.src)} · starts {formatMonthYearLabel(item.startMonth, item.startYear)}
                  </div>
                  <div style={{fontSize:11,color:DIM}}>
                    {summarizeRecurringItemDates(item, recurringSourceTxns, item.startYear)}
                  </div>
                </div>
                <span style={{fontSize:12,color:"#22c55e",fontWeight:700}}>${Number(item.amount || 0).toLocaleString()}</span>
                <button onClick={() => {
                  if (!confirmDeleteAction("Delete this recurring planning item?")) return;
                  setRecurringItems(prev => prev.filter((_, j) => j !== i));
                }}
                  style={{background:"#ef444422",color:"#ef4444",border:"none",borderRadius:6,padding:"2px 8px",fontSize:11,cursor:"pointer",fontWeight:700}}>✕</button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{fontSize:12,color:MUTED}}>No recurring planning items yet.</div>
        )}
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
                <button onClick={() => {
                  if (!confirmDeleteAction("Delete this one-time expense?")) return;
                  setOneTimes(prev => prev.filter((_,j) => j !== i));
                }}
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
  const { addTxns, checkTxns, ccTxns, allCats, catColorsAll, selectedYear } = useBudget();

  // Steps: "upload" → "parsing" → "review" → "done"
  const [step, setStep]         = useState("upload");
  const [stmtSrc, setStmtSrc]   = useState("checking");
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState(null);
  const [fileType, setFileType] = useState(null); // "pdf" | "csv"
  const [pdfB64, setPdfB64]     = useState(null);
  const [csvText, setCsvText]   = useState(null);
  const [parseError, setParseError] = useState(null);
  const [parsed, setParsed]     = useState([]); // raw from Claude
  const [reviewed, setReviewed] = useState([]); // user-edited
  const [editingIdx, setEditingIdx] = useState(null);
  const [aiRanOnCsv, setAiRanOnCsv] = useState(false);
  const [runningAI, setRunningAI] = useState(false);
  const [localCsvFailed, setLocalCsvFailed] = useState(false);
  const [localPdfFailed, setLocalPdfFailed] = useState(false);
  const [parsingMode, setParsingMode] = useState("local");

  // ── CSV parser (client-side, no AI needed) ──────────────────────────────────
  const splitCSVLine = (line, delim) => {
    const result = []; let field = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      const afterNext = line[i + 2];
      if (ch === '"' && inQ && next === '"') { field += '"'; i++; continue; }
      if (ch === "\\" && inQ && next === '"') {
        if (afterNext === delim || afterNext === undefined) { inQ = false; i++; continue; }
        field += '"'; i++; continue;
      }
      if (ch === '"') { inQ = !inQ; }
      else if (ch === delim && !inQ) { result.push(field.trim()); field = ""; }
      else { field += ch; }
    }
    result.push(field.trim());
    return result.map(f => f.replace(/^"|"$/g, "").trim());
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
  const normalizeCSVHeader = raw => (raw || "").toLowerCase().replace(/[^a-z]/g, "");
  const cleanCSVNumber = raw => {
    const s = (raw || "").toString().trim().replace(/^"|"$/g, "");
    if (!s) return NaN;
    const n = parseFloat(s.replace(/[$,\s]/g, "").replace(/^\((.+)\)$/, "-$1"));
    return Number.isFinite(n) ? n : NaN;
  };
  const detectCSVDelimiters = lines => {
    return [",", "\t", ";", "|"]
      .map(d => {
        const counts = lines.slice(0, 12).map(line => splitCSVLine(line, d).length);
        const multi = counts.filter(n => n > 1);
        const avg = multi.length ? multi.reduce((sum, n) => sum + n, 0) / multi.length : 0;
        return { d, score: multi.length * 5 + avg };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.d);
  };
  const csvDelimLabel = delim => {
    if (delim === ",") return "comma-delimited";
    if (delim === "\t") return "tab-delimited";
    if (delim === ";") return "semicolon-delimited";
    if (delim === "|") return "pipe-delimited";
    return "unknown-delimited";
  };
  const findCSVHeaderRow = (lines, delim) => {
    let best = { idx: -1, score: 0, headers: [] };
    lines.slice(0, Math.min(lines.length, 12)).forEach((line, idx) => {
      const cols = splitCSVLine(line, delim);
      if (cols.length < 3) return;
      const headers = cols.map(normalizeCSVHeader);
      const score = headers.reduce((sum, h) => {
        if (!h) return sum;
        if (h.includes("date") || h.includes("posted")) sum += 4;
        if (["description","desc","merchant","payee","memo","detail","narration","name"].some(k => h.includes(k))) sum += 3;
        if (h.includes("amount")) sum += 4;
        if (h.includes("debit") || h.includes("withdrawal") || h.includes("charge")) sum += 4;
        if (h.includes("credit") || h.includes("deposit")) sum += 4;
        if (h.includes("balance")) sum += 1;
        if (h.includes("transactionnumber") || h.includes("checknumber") || h.includes("accountnumber")) sum += 1;
        return sum;
      }, 0);
      if (score > best.score) best = { idx, score, headers };
    });
    return best.score >= 6 ? best : { idx: -1, score: 0, headers: [] };
  };
  const buildCSVIndexes = headers => ({
    date: headers.findIndex(h => h.includes("date") || h.includes("posted")),
    desc: headers.findIndex(h => ["description","desc","merchant","payee","narration","detail","name"].some(k => h.includes(k))),
    memo: headers.findIndex(h => h.includes("memo") || h.includes("note")),
    amt: headers.findIndex(h => h === "amount" || h === "amt" || h === "transactionamount"),
    deb: headers.findIndex(h => h.includes("debit") || h.includes("withdrawal") || h.includes("charge")),
    cred: headers.findIndex(h => h.includes("credit") || h.includes("deposit")),
  });
  const inferCSVIndexes = rows => {
    const width = rows.reduce((max, cols) => Math.max(max, cols.length), 0);
    const stats = Array.from({ length: width }, (_, i) => {
      const cells = rows.map(cols => (cols[i] || "").trim()).filter(Boolean);
      return {
        i,
        filled: cells.length,
        dateHits: cells.filter(c => !!parseCSVDate(c)).length,
        decimalHits: cells.filter(c => /[.,]\d{2}\)?$/.test(c)).length,
        textHits: cells.filter(c => !parseCSVDate(c) && !Number.isFinite(cleanCSVNumber(c))).length,
      };
    });
    const date = stats.filter(s => s.dateHits > 0).sort((a, b) => b.dateHits - a.dateHits || a.i - b.i)[0]?.i ?? -1;
    const moneyCols = stats.filter(s => s.i !== date && s.decimalHits > 0).sort((a, b) => a.i - b.i);
    const likelyBalance = moneyCols.filter(s => s.filled >= Math.max(3, rows.length * 0.7)).sort((a, b) => b.i - a.i)[0]?.i ?? -1;
    const amountCols = moneyCols.filter(s => s.i !== likelyBalance);
    const textCols = stats
      .filter(s => s.i !== date && s.i !== likelyBalance && !amountCols.some(col => col.i === s.i) && s.textHits > 0)
      .sort((a, b) => a.i - b.i);
    return {
      date,
      desc: textCols[0]?.i ?? -1,
      memo: textCols[1]?.i ?? -1,
      amt: amountCols.length === 1 ? amountCols[0].i : -1,
      deb: amountCols.length >= 2 ? amountCols[0].i : -1,
      cred: amountCols.length >= 2 ? amountCols[1].i : -1,
    };
  };
  const buildCSVText = (cols, idx) => {
    const primary = (idx.desc >= 0 ? cols[idx.desc] : "").trim();
    const secondary = (idx.memo >= 0 ? cols[idx.memo] : "").trim();
    const pieces = [primary, secondary].filter(Boolean);
    const desc = pieces.join(" ").replace(/\s+/g, " ").trim();
    return {
      desc,
      note: secondary && secondary.toLowerCase() !== primary.toLowerCase() ? secondary.slice(0, 120) : "",
      hintText: `${primary} ${secondary}`.trim().toLowerCase(),
    };
  };
  const parseCSVRows = (lines, delim, headerRow = -1) => {
    const headers = headerRow >= 0 ? splitCSVLine(lines[headerRow], delim).map(normalizeCSVHeader) : [];
    const startIdx = headerRow >= 0
      ? headerRow + 1
      : lines.findIndex(line => {
          const cols = splitCSVLine(line, delim);
          return cols.length >= 3 && cols.some(c => !!parseCSVDate(c)) && cols.some(c => Number.isFinite(cleanCSVNumber(c)));
        });
    if (startIdx < 0) {
      return {
        rows: [],
        reason: headerRow >= 0
          ? "A likely header row was found, but no following data row contained both a parseable date and numeric amount."
          : "No data row contained both a parseable date and numeric amount.",
      };
    }
    const sampleRows = lines
      .slice(startIdx, startIdx + 12)
      .map(line => splitCSVLine(line, delim))
      .filter(cols => cols.length > 1);
    const idx = headerRow >= 0 ? buildCSVIndexes(headers) : inferCSVIndexes(sampleRows);
    if (idx.date < 0) return { rows: [], reason: "Could not identify a date column." };
    if (idx.amt < 0 && idx.deb < 0 && idx.cred < 0) return { rows: [], reason: "Could not identify an amount, debit, or credit column." };
    if (idx.desc < 0 && idx.memo < 0) return { rows: [], reason: "Could not identify a description or memo column." };
    const parsed = lines.slice(startIdx).flatMap(line => {
      const cols = splitCSVLine(line, delim);
      if (cols.length < 2) return [];
      const date = parseCSVDate(cols[idx.date] || "");
      if (!date) return [];
      const { desc, note, hintText } = buildCSVText(cols, idx);
      if (!desc) return [];
      let amount = NaN;
      if (idx.deb >= 0 || idx.cred >= 0) {
        const deb = idx.deb >= 0 ? cleanCSVNumber(cols[idx.deb]) : NaN;
        const cred = idx.cred >= 0 ? cleanCSVNumber(cols[idx.cred]) : NaN;
        if (!Number.isFinite(deb) && !Number.isFinite(cred)) return [];
        amount = (Number.isFinite(deb) ? Math.abs(deb) : 0) - (Number.isFinite(cred) ? Math.abs(cred) : 0);
      } else {
        amount = cleanCSVNumber(cols[idx.amt]);
      }
      if (!Number.isFinite(amount)) return [];
      return [{ date, desc: desc.slice(0, 80), amount, cat: "Snacks/Misc", note, _hintText: hintText }];
    });
    if (idx.amt >= 0 && idx.deb < 0 && idx.cred < 0) {
      const creditHint = /\b(deposit|refund|credit|reversal|interest|cashout|cash out|payment received|received|from:)\b/i;
      const debitHint = /\b(withdrawal|debit|purchase|point of sale|pos|payment|fee|bill pay|autopay|sent|to:|check)\b/i;
      const flipScore = parsed.reduce((score, txn) => {
        if (debitHint.test(txn._hintText) && txn.amount < 0) score += 1;
        if (creditHint.test(txn._hintText) && txn.amount > 0) score += 1;
        if (debitHint.test(txn._hintText) && txn.amount > 0) score -= 1;
        if (creditHint.test(txn._hintText) && txn.amount < 0) score -= 1;
        return score;
      }, 0);
      if (flipScore > 1) parsed.forEach(txn => { txn.amount = -txn.amount; });
    }
    const rows = parsed.map(({ _hintText, ...txn }) => txn);
    if (!rows.length) return { rows: [], reason: "Columns were mapped, but no rows produced a valid date and amount pair." };
    return { rows, reason: "" };
  };
  const parseCSVData = text => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) {
      return {
        rows: [],
        reason: "The CSV has fewer than two non-empty lines, so there is no usable header/data structure to parse.",
      };
    }
    let best = { rows: [], label: "", reason: "" };
    const attempts = [];
    detectCSVDelimiters(lines).forEach(delim => {
      const headerMatch = findCSVHeaderRow(lines, delim);
      if (headerMatch.idx >= 0) {
        const headerAttempt = parseCSVRows(lines, delim, headerMatch.idx);
        attempts.push({
          label: `header scan (${csvDelimLabel(delim)})`,
          rows: headerAttempt.rows,
          reason: headerAttempt.reason,
        });
      } else {
        attempts.push({
          label: `header scan (${csvDelimLabel(delim)})`,
          rows: [],
          reason: "No usable header row with date/description/amount-like columns was found.",
        });
      }
      const fallbackAttempt = parseCSVRows(lines, delim, -1);
      attempts.push({
        label: `statement/export fallback (${csvDelimLabel(delim)})`,
        rows: fallbackAttempt.rows,
        reason: fallbackAttempt.reason,
      });
    });
    attempts.forEach(attempt => {
      if (attempt.rows.length > best.rows.length) best = attempt;
    });
    if (best.rows.length) return { rows: best.rows, reason: "", bestAttempt: best.label, attempts };
    const reasonLines = [...new Set(attempts.map(a => a.reason).filter(Boolean))].slice(0, 3);
    const why = reasonLines.length ? ` Why: ${reasonLines.join(" ")}` : "";
    return {
      rows: [],
      reason: `Local CSV parse could not confidently detect transactions after header scan and fallback inference.${why} You can continue with AI parse.`,
      bestAttempt: "",
      attempts,
    };
  };

  // ── Load file (PDF or CSV) ───────────────────────────────────────────────────
  const loadFile = file => {
    if (!file) return;
    setParseError(null);
    setAiRanOnCsv(false);
    setLocalCsvFailed(false);
    setLocalPdfFailed(false);
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
    return [...checkTxns, ...ccTxns].flatMap(t => {
      if (t.cat && t.cat !== "Transfer" && t.cat !== "Income" && t.desc) {
        const sig = buildMerchantSignature(t.desc);
        if (sig.core) return [{ cat: t.cat, desc: t.desc, sig }];
      }
      return [];
    });
  };

  const findLocalCat = (desc, dict) => {
    const sig = buildMerchantSignature(desc);
    if (!sig.core) return null;
    const scoresByCat = new Map();
    const sampleByCat = new Map();
    dict.forEach(entry => {
      const score = merchantSimilarity(sig, entry.sig);
      if (score < 0.45) return;
      scoresByCat.set(entry.cat, (scoresByCat.get(entry.cat) || 0) + score);
      const sample = sampleByCat.get(entry.cat);
      if (!sample || score > sample.score) sampleByCat.set(entry.cat, { score, desc: entry.desc });
    });
    let bestCat = null;
    let bestScore = 0;
    scoresByCat.forEach((score, cat) => {
      if (score > bestScore) { bestCat = cat; bestScore = score; }
    });
    if (!bestCat || bestScore < 0.58) return null;
    const sample = sampleByCat.get(bestCat);
    return {
      cat: bestCat,
      score: sample?.score || bestScore,
      exact: (sample?.score || bestScore) >= 0.92,
      desc: sample?.desc || "",
    };
  };

  // ── Parse statement: local-first, AI only for unknowns ─────────────────────
  // Step 1: AI extracts raw transactions (dates, amounts, descriptions) — one call
  // Step 2: Match descriptions against existing transaction history locally
  // Step 3: Only send unmatched descriptions to AI for categorization — cheaper
  const [matchStats, setMatchStats] = useState(null); // { local, ai, total }

  const parseCSVAndReview = () => {
    if (!csvText) { setParseError("No CSV loaded."); return; }
    setStep("parsing");
    setParsingMode("local");
    setParseError(null);
    try {
      const dict = buildLocalDict();
      const { rows: raw, reason } = parseCSVData(csvText);
      if (raw.length === 0) {
        setLocalCsvFailed(true);
        setParseError(reason || "Local CSV parse could not confidently detect transactions. You can continue with AI parse.");
        setStep("upload");
        return;
      }
      const withCats = raw.map(t => {
        const localMatch = findLocalCat(t.desc, dict);
        return {
          ...t,
          cat: localMatch?.cat || "Snacks/Misc",
          _localMatch: !!localMatch,
          _localMatchPossible: !!localMatch && !localMatch.exact,
          _localMatchDesc: localMatch?.desc || "",
        };
      });
      const filtered = stmtSrc === "checking" ? withCats : withCats.filter(t => t.cat !== "Income" && t.cat !== "Transfer");
      const localCount = filtered.filter(t => t._localMatch).length;
      setMatchStats({ local: localCount, ai: 0, total: filtered.length, csv: true });
      setParsed(filtered);
      setReviewed(filtered.map(t => ({ ...t, _include: true })));
      setAiRanOnCsv(false);
      setLocalCsvFailed(false);
      setStep("review");
    } catch (err) {
      setLocalCsvFailed(true);
      setParseError("CSV parse failed: " + err.message);
      setStep("upload");
    }
  };

  const parseLocalPdfData = () => {
    if (!pdfB64) return [];
    const raw = atob(pdfB64);
    const printable = raw.replace(/[^\x20-\x7E\r\n]/g, " ");
    const textChunks = [];
    const strMatches = printable.match(/\(([^()]{2,120})\)/g) || [];
    strMatches.forEach(s => {
      const cleaned = s.slice(1, -1).replace(/\\\)/g, ")").replace(/\\\(/g, "(").trim();
      if (cleaned.length >= 2) textChunks.push(cleaned);
    });
    textChunks.push(printable);
    const blob = textChunks.join("\n");
    const lines = blob.split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const out = [];
    lines.forEach(line => {
      const date = line.match(/\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])\b/);
      if (!date) return;
      const amtMatches = [...line.matchAll(/\(?-?\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?/g)];
      if (!amtMatches.length) return;
      const amtRaw = amtMatches[amtMatches.length - 1][0];
      const amount = parseFloat(amtRaw.replace(/[$,()]/g, "").replace(/^\-/, ""));
      if (Number.isNaN(amount) || amount === 0) return;
      let signed = amount;
      if (/\b(cr|credit|refund)\b/i.test(line)) signed = -amount;
      const desc = line
        .replace(date[0], "")
        .replace(/\(?-?\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?/g, "")
        .replace(/\b(balance|running|available|total)\b/ig, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (!desc || desc.length < 3) return;
      out.push({ date: date[0].replace("-", "/"), desc, amount: signed, cat: "Snacks/Misc", note: "" });
    });
    const uniq = [];
    const seen = new Set();
    out.forEach(t => {
      const key = `${t.date}|${t.desc}|${t.amount.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      uniq.push(t);
    });
    return uniq.slice(0, 300);
  };

  const parseLocalPdfAndReview = () => {
    setStep("parsing");
    setParsingMode("local");
    setParseError(null);
    try {
      const dict = buildLocalDict();
      const raw = parseLocalPdfData();
      if (raw.length < 3) {
        setLocalPdfFailed(true);
        setParseError("Local PDF parse could not confidently detect transactions. You can continue with AI parse.");
        setStep("upload");
        return;
      }
      const withCats = raw.map(t => {
        const localMatch = findLocalCat(t.desc, dict);
        return {
          ...t,
          cat: localMatch?.cat || "Snacks/Misc",
          _localMatch: !!localMatch,
          _localMatchPossible: !!localMatch && !localMatch.exact,
          _localMatchDesc: localMatch?.desc || "",
        };
      });
      const filtered = withCats.filter(t => stmtSrc === "checking" ? true : t.cat !== "Income" && t.cat !== "Transfer");
      const localCount = filtered.filter(t => t._localMatch).length;
      setMatchStats({ local: localCount, ai: 0, total: filtered.length, csv: false });
      setParsed(filtered);
      setReviewed(filtered.map(t => ({ ...t, _include: true })));
      setAiRanOnCsv(false);
      setLocalCsvFailed(false);
      setLocalPdfFailed(false);
      setStep("review");
    } catch (err) {
      setLocalPdfFailed(true);
      setParseError("Local PDF parse failed. You can continue with AI parse.");
      setStep("upload");
    }
  };

  const requestAICategories = async (unmatched, apiKey = ANTHROPIC_API_KEY) => {
    if (!unmatched.length) return {};
    const merchantList = unmatched.map(item => `${item.i}: ${item.desc}`).join("\n");
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
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800,
        messages: [{ role: "user", content: catPrompt }]
      })
    });
    const catData = await catRes.json();
    if (catData.error) throw new Error(catData.error.message);
    return JSON.parse((catData.content?.find(b=>b.type==="text")?.text||"{}").replace(/```json|```/g,"").trim());
  };

  const parseWithAI = async () => {
    if (!ANTHROPIC_API_KEY) { setParseError("Add your Anthropic API key in Settings to enable AI import."); return; }
    if (fileType === "pdf" && !pdfB64) { setParseError("No PDF loaded."); return; }
    if (fileType === "csv" && !csvText) { setParseError("No CSV loaded."); return; }
    setStep("parsing");
    setParsingMode("ai");
    setParseError(null);
    try {
      const extractPrompt = fileType === "csv"
        ? `Parse ALL transactions from this ${stmtSrc === "checking" ? "checking account" : "credit card"} CSV export.
The CSV may contain preamble rows, malformed quoting, separate debit/credit columns, or multiple possible layouts.
Return ONLY a JSON array, no markdown. Each object:
- "date": "MM/DD"
- "desc": clean merchant name, max 60 chars
- "amount": positive for charges/debits, negative for deposits/credits/refunds
- "note": brief note or ""
Do NOT include a "cat" field.
Ignore non-transaction metadata rows and balances.`
        : `Parse ALL transactions from this ${stmtSrc === "checking" ? "checking account" : "credit card"} statement.
Return ONLY a JSON array, no markdown. Each object:
- "date": "MM/DD"
- "desc": clean merchant name, max 40 chars (e.g. "Target", "Costco", "McKeever's Market")
- "amount": positive for charges/debits, negative for credits/refunds
- "note": brief note or ""
Do NOT include a "cat" field.`;

      const messageContent = fileType === "csv"
        ? `${extractPrompt}\n\nCSV contents:\n${csvText}`
        : [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfB64 } },
            { type: "text", text: extractPrompt },
          ];

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 4000,
          messages: [{ role: "user", content: messageContent }]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const rawTxns = JSON.parse((data.content.find(b => b.type === "text")?.text || "").replace(/```json|```/g,"").trim());
      if (!Array.isArray(rawTxns)) throw new Error("Extraction failed");
      const normalizedRaw = rawTxns
        .filter(t => t && typeof t === "object")
        .map(t => ({
          date: parseCSVDate(t.date) || fingerprintTxnDate(t.date),
          desc: (t.desc || "").toString().trim().slice(0, 80),
          amount: Number(t.amount),
          note: (t.note || "").toString().trim().slice(0, 120),
        }))
        .filter(t => t.date && t.desc && Number.isFinite(t.amount));
      if (!normalizedRaw.length) throw new Error("AI returned no usable transactions.");

      // ── Step 2: Local category matching ────────────────────────────────────
      const localDict = buildLocalDict();
      const unmatched = []; // { originalIdx, desc }
      const withCats = normalizedRaw.map((t, i) => {
        const localMatch = findLocalCat(t.desc, localDict);
        if (localMatch) {
          return {
            ...t,
            cat: localMatch.cat,
            _localMatch: true,
            _localMatchPossible: !localMatch.exact,
            _localMatchDesc: localMatch.desc || "",
          };
        }
        unmatched.push({ i: String(i), desc: t.desc });
        return { ...t, _localMatch: false };
      });

      // ── Step 3: AI categorizes only unmatched descriptions (small call) ────
      const aiCatMap = await requestAICategories(unmatched, ANTHROPIC_API_KEY);

      // ── Merge and finalize ──────────────────────────────────────────────────
      const txns = withCats.map((t, i) => {
        if (t._localMatch) return t;
        return { ...t, cat: aiCatMap[String(i)] || "Snacks/Misc" };
      });

      const filtered = txns.filter(t => stmtSrc === "checking" ? true : t.cat !== "Income" && t.cat !== "Transfer");
      const localCount = filtered.filter(t => t._localMatch).length;
      setMatchStats({ local: localCount, ai: filtered.length - localCount, total: filtered.length, csv: fileType === "csv" });
      setParsed(filtered);
      setReviewed(filtered.map(t => ({ ...t, _include: true })));
      setAiRanOnCsv(fileType === "csv");
      setLocalCsvFailed(false);
      setLocalPdfFailed(false);
      setStep("review");
    } catch (err) {
      setParseError(`AI ${fileType === "csv" ? "CSV" : "PDF"} parse failed: ${err.message}`);
      setStep("upload");
    }
  };

  const parse = async () => {
    if (fileType === "csv") { parseCSVAndReview(); return; }
    parseLocalPdfAndReview();
  };

  // ── Confirm: push to live state ─────────────────────────────────────────────
  const confirm = () => {
    if (selectedDuplicateCount > 0) {
      const parts = [];
      if (selectedExistingDuplicateCount > 0) parts.push(`${selectedExistingDuplicateCount} already exist in ${stmtSrc === "checking" ? "checking" : "credit card"}`);
      if (selectedImportDuplicateCount > 0) parts.push(`${selectedImportDuplicateCount} repeat in this import`);
      if (!confirmDeleteAction(`You still have ${selectedDuplicateCount} possible duplicate transaction${selectedDuplicateCount === 1 ? "" : "s"} selected${parts.length ? ` (${parts.join("; ")})` : ""}. Import them anyway?`)) return;
    }
    const toAdd = reviewed
      .filter(t => t._include)
      .map(({ _include, ...t }) => ({ ...t, year: selectedYear }));
    addTxns(stmtSrc, toAdd);
    setStep("done");
  };

  // ── Run AI categorization on CSV review (categorizes unmatched transactions) ─
  const runAICategorization = async () => {
    const apiKey = (() => { try { return localStorage.getItem("budget_apikey") || ""; } catch { return ""; } })();
    if (!apiKey) { setParseError("Set your Anthropic API key in Settings first, then try again."); return; }
    const unmatched = reviewed.reduce((acc, t, i) => {
      if (!t._localMatch) acc.push({ i, desc: t.desc });
      return acc;
    }, []);
    if (unmatched.length === 0) { setAiRanOnCsv(true); return; }
    setRunningAI(true); setParseError(null);
    try {
      const merchantList = unmatched.map(x => x.i + ": " + x.desc).join("\n");
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
        "transfers between own accounts, CC payments -> Transfer",
      ].join("\n");
      const catPrompt = [
        "Categorize each merchant into exactly one of: " + allCats.join(", "),
        "", "Rules:", catRules, "",
        "Merchants:", merchantList, "",
        'Return ONLY a JSON object like: {"0":"Groceries","1":"Housing"}',
      ].join("\n");
      const catRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 800,
          messages: [{ role: "user", content: catPrompt }]
        })
      });
      const catData = await catRes.json();
      if (catData.error) throw new Error(catData.error.message);
      const aiCatMap = JSON.parse((catData.content?.find(b=>b.type==="text")?.text||"{}").replace(/```json|```/g,"").trim());
      setReviewed(prev => prev.map((t, i) => {
        const match = unmatched.find(x => x.i === i);
        if (!match) return t;
        const aiCat = aiCatMap[String(i)];
        return aiCat ? { ...t, cat: aiCat } : t;
      }));
      const aiCount = Object.keys(aiCatMap).length;
      setMatchStats(prev => ({ ...(prev||{}), ai: aiCount, local: prev?.local || 0, csv: false }));
      setAiRanOnCsv(true);
    } catch (e) {
      setParseError("AI categorization failed: " + e.message);
    }
    setRunningAI(false);
  };

  const reset = () => {
    setStep("upload"); setFileName(null); setFileType(null); setPdfB64(null); setCsvText(null);
    setParsed([]); setReviewed([]); setParseError(null); setEditingIdx(null);
    setAiRanOnCsv(false); setRunningAI(false); setLocalCsvFailed(false); setLocalPdfFailed(false); setParsingMode("local");
  };

  const duplicateRows = useMemo(() => {
    const prepare = (txn, sourceIndex = null) => {
      const year = deriveTxnYear(txn, selectedYear);
      const date = fingerprintTxnDate(txn?.date);
      const amount = Number(txn?.amount);
      return {
        year,
        date,
        desc: String(txn?.desc || "").trim(),
        amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
        amount,
        exactKey: buildTxnFingerprint(txn, selectedYear),
        merchant: buildMerchantSignature(txn?.desc),
        sourceIndex: Number.isInteger(sourceIndex) ? sourceIndex : null,
      };
    };
    const existingTxns = stmtSrc === "checking" ? checkTxns : ccTxns;
    const existingPrepared = existingTxns
      .map(t => prepare(t))
      .filter(t => t.date && Number.isFinite(t.amountCents) && Number.isFinite(t.year));
    const existingSplitGroups = collectSplitDuplicateGroups(existingTxns, selectedYear)
      .filter(group => group.date && Number.isFinite(group.totalCents) && Number.isFinite(group.year));
    const reviewPrepared = reviewed.map((t, reviewIdx) => prepare({ ...t, year: selectedYear }, reviewIdx));
    const exactCounts = new Map();
    reviewPrepared.forEach(item => {
      if (!item.exactKey) return;
      exactCounts.set(item.exactKey, (exactCounts.get(item.exactKey) || 0) + 1);
    });
    return reviewPrepared.map((item, idx) => {
      const sameSlotExisting = existingPrepared.filter(other =>
        other.year === item.year && other.date === item.date && other.amountCents === item.amountCents
      );
      const sameSlotSplitGroups = existingSplitGroups.filter(other =>
        other.year === item.year && other.date === item.date && other.totalCents === item.amountCents
      );
      const exactExistingMatches = !!item.exactKey ? sameSlotExisting.filter(other => other.exactKey === item.exactKey) : [];
      const possibleExistingMatches = !exactExistingMatches.length
        ? sameSlotExisting.filter(other => merchantSimilarity(item.merchant, other.merchant) >= 0.7)
        : [];
      const exactSplitMatches = !exactExistingMatches.length && !!item.exactKey
        ? sameSlotSplitGroups.filter(other => other.exactKey === item.exactKey)
        : [];
      const possibleSplitMatches = !exactExistingMatches.length && !possibleExistingMatches.length && !exactSplitMatches.length
        ? sameSlotSplitGroups.filter(other => merchantSimilarity(item.merchant, other.merchant) >= 0.7)
        : [];
      const exactImportMatches = !!item.exactKey
        ? reviewPrepared.filter((other, otherIdx) => otherIdx !== idx && other.exactKey === item.exactKey)
        : [];
      const possibleImportMatches = !exactImportMatches.length
        ? reviewPrepared.filter((other, otherIdx) =>
          otherIdx !== idx
          && other.year === item.year
          && other.date === item.date
          && other.amountCents === item.amountCents
          && merchantSimilarity(item.merchant, other.merchant) >= 0.7
        )
        : [];
      const matchesExisting = exactExistingMatches.length > 0;
      const possibleExisting = !matchesExisting && possibleExistingMatches.length > 0;
      const matchesExistingSplit = !matchesExisting && exactSplitMatches.length > 0;
      const possibleExistingSplit = !matchesExisting && !possibleExisting && !matchesExistingSplit && possibleSplitMatches.length > 0;
      const repeatsInImport = !!item.exactKey && (exactCounts.get(item.exactKey) || 0) > 1;
      const possibleRepeatInImport = !repeatsInImport && possibleImportMatches.length > 0;
      const referenceLines = [
        buildDuplicateReferenceLine("Existing match", exactExistingMatches, match => summarizeTxnDuplicateRef(match)),
        buildDuplicateReferenceLine("Possible existing", possibleExistingMatches, match => summarizeTxnDuplicateRef(match)),
        buildDuplicateReferenceLine("Split match", exactSplitMatches, match => summarizeSplitGroupDuplicateRef(match)),
        buildDuplicateReferenceLine("Possible split", possibleSplitMatches, match => summarizeSplitGroupDuplicateRef(match)),
        buildDuplicateReferenceLine("Repeated in import", exactImportMatches, match => summarizeTxnDuplicateRef(match, {
          rowNumber: Number.isInteger(match.sourceIndex) ? match.sourceIndex + 1 : null,
        })),
        buildDuplicateReferenceLine("Possible repeat", possibleImportMatches, match => summarizeTxnDuplicateRef(match, {
          rowNumber: Number.isInteger(match.sourceIndex) ? match.sourceIndex + 1 : null,
        })),
      ].filter(Boolean);
      return {
        matchesExisting,
        possibleExisting,
        matchesExistingSplit,
        possibleExistingSplit,
        repeatsInImport,
        possibleRepeatInImport,
        referenceLines,
        flagged: matchesExisting || possibleExisting || matchesExistingSplit || possibleExistingSplit || repeatsInImport || possibleRepeatInImport,
      };
    });
  }, [stmtSrc, checkTxns, ccTxns, reviewed, selectedYear]);

  const duplicateCount = duplicateRows.filter(r => r.flagged).length;
  const splitDuplicateCount = duplicateRows.filter(r => r.matchesExistingSplit || r.possibleExistingSplit).length;
  const existingDuplicateCount = duplicateRows.filter(r => r.matchesExisting || r.possibleExisting || r.matchesExistingSplit || r.possibleExistingSplit).length;
  const importDuplicateCount = duplicateRows.filter(r => r.repeatsInImport || r.possibleRepeatInImport).length;
  const selectedDuplicateCount = duplicateRows.reduce((sum, r, idx) => sum + (r.flagged && reviewed[idx]?._include ? 1 : 0), 0);
  const selectedExistingDuplicateCount = duplicateRows.reduce((sum, r, idx) => sum + ((r.matchesExisting || r.possibleExisting || r.matchesExistingSplit || r.possibleExistingSplit) && reviewed[idx]?._include ? 1 : 0), 0);
  const selectedImportDuplicateCount = duplicateRows.reduce((sum, r, idx) => sum + ((r.repeatsInImport || r.possibleRepeatInImport) && reviewed[idx]?._include ? 1 : 0), 0);

  const excludeFlaggedDuplicates = () => {
    setReviewed(prev => prev.map((t, idx) => duplicateRows[idx]?.flagged ? { ...t, _include: false } : t));
  };
  const includeFlaggedDuplicates = () => {
    setReviewed(prev => prev.map((t, idx) => duplicateRows[idx]?.flagged ? { ...t, _include: true } : t));
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
            <div style={{fontSize:13,color:MUTED}}>CSV and PDF both parse locally first. If local parsing cannot confidently detect transactions, the app explains why and offers optional AI extraction. AI categorization remains optional in Review.</div>
          </div>
        </div>
      </Card>

      {/* ── STEP: UPLOAD ── */}
      {step === "upload" && (
        <Card>
          {/* Source selector */}
          <div style={{display:"grid",gridTemplateColumns:"1fr",gap:12,marginBottom:20}}>
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
          </div>

          <div style={{marginBottom:16,padding:"12px 14px",borderRadius:12,background:BG,border:`1px solid ${BORDER}`}}>
            <div style={{fontSize:12,fontWeight:800,color:accentImport,marginBottom:8,textTransform:"uppercase",letterSpacing:".5px"}}>How AI is used</div>
            <div style={{fontSize:12,color:MUTED,display:"grid",gap:5}}>
              <div>1. CSV and PDF both start with local parsing in your browser.</div>
              <div>2. CSV import tries header scan, statement-export fallback, and headerless column inference locally before Review.</div>
              <div>3. If local CSV or PDF parsing fails, the error explains why local detection failed before optional AI extraction is offered.</div>
              <div>4. Category matching runs locally first using your existing transactions.</div>
              <div>5. Only if you choose optional AI categorization in Review are unmatched merchant descriptions sent for category suggestions.</div>
              <div>6. You review/edit every row before anything is added to your dashboard.</div>
            </div>
            <div style={{height:1,background:BORDER,margin:"10px 0"}}/>
            <div style={{fontSize:11,color:DIM,display:"grid",gap:4}}>
              <div>Data sent on AI file extraction (optional): raw CSV or PDF contents and statement type.</div>
              <div>Data sent on AI categorization only when you choose it in Review (optional): unmatched merchant descriptions and allowed category names.</div>
              <div>Imported transaction dates drive the month automatically from the file.</div>
              <div>No transactions are imported until you confirm in Review.</div>
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
                  <div style={{fontSize:12,color:MUTED}}>{fileType==="csv"?"CSV ready — local parse first, explained fallback if needed":"PDF ready — local parse first, explained fallback if needed"} · click to change</div></>
              : <><div style={{fontSize:15,fontWeight:600,color:TEXT,marginBottom:6}}>Drop your bank statement here</div>
                  <div style={{fontSize:12,color:MUTED}}>or click to browse · PDF or CSV</div>
                  <div style={{fontSize:11,color:DIM,marginTop:8}}>PDF/CSV: local parse first · AI options are available only when needed.</div></>
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
              ? `📊 Import CSV Locally (AI Optional in Review)`
              : pdfB64
                ? `Local Parse ${stmtSrc === "checking" ? "Checking" : "Credit Card"} Statement`
                : "Upload a PDF or CSV first"
            }
          </button>
          {fileType === "pdf" && localPdfFailed && (
            <button
              onClick={parseWithAI}
              style={{
                marginTop:10,width:"100%",padding:"11px",borderRadius:10,fontSize:13,fontWeight:800,
                background:"#8b5cf622",color:"#8b5cf6",cursor:"pointer",
                border:"1px solid #8b5cf655",transition:"all .2s",
              }}>
              Optional AI PDF Extraction (Send PDF to AI)
            </button>
          )}
          {fileType === "csv" && localCsvFailed && (
            <button
              onClick={parseWithAI}
              style={{
                marginTop:10,width:"100%",padding:"11px",borderRadius:10,fontSize:13,fontWeight:800,
                background:"#8b5cf622",color:"#8b5cf6",cursor:"pointer",
                border:"1px solid #8b5cf655",transition:"all .2s",
              }}>
              Optional AI CSV Extraction (Send CSV to AI)
            </button>
          )}
        </Card>
      )}

      {/* ── STEP: PARSING ── */}
      {step === "parsing" && (
        <Card>
          <div style={{textAlign:"center",padding:"40px 0"}}>
            <div style={{fontSize:48,marginBottom:20,animation:"spin 2s linear infinite",display:"inline-block"}}>⚙️</div>
            <div style={{fontSize:18,fontWeight:700,color:TEXT,marginBottom:8}}>Parsing your statement…</div>
            <div style={{fontSize:13,color:MUTED,marginBottom:24}}>{parsingMode === "ai" ? "AI parsing in progress." : "Running local parser in your browser."}</div>
            <div style={{display:"flex",justifyContent:"center",gap:6}}>
              {(parsingMode === "ai"
                ? [fileType === "csv" ? "Uploading CSV" : "Uploading PDF","AI extraction","Auto-categorizing","Building review"]
                : ["Reading file","Extracting lines","Local categorization","Building review"]).map((s,i)=>(
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
                  {stmtSrc==="checking"?"🏦 Checking":"💳 Credit Card"} · dates come from the file · viewing year {selectedYear}
                </div>
                {matchStats && (
                  <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                    {matchStats.csv && !aiRanOnCsv
                      ? <span style={{fontSize:11,padding:"2px 8px",borderRadius:99,background:"#06b6d422",color:"#06b6d4",border:"1px solid #06b6d444",fontWeight:700}}>
                          📊 CSV parsed locally · AI not used yet
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
                    {!aiRanOnCsv && (
                      <button onClick={runAICategorization} disabled={runningAI}
                        style={{fontSize:11,padding:"3px 10px",borderRadius:99,cursor:runningAI?"default":"pointer",fontWeight:700,
                          background:runningAI?"#1e2535":"#8b5cf622",color:runningAI?MUTED:"#8b5cf6",
                          border:`1px solid ${runningAI?"#1e2535":"#8b5cf644"}`,transition:"all .15s"}}>
                        {runningAI ? "⏳ Running AI…" : "✨ Optional: Run AI Categorization"}
                      </button>
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

          {duplicateCount > 0 && (
            <Card style={{border:"1px solid #f59e0b55",background:"#f59e0b10"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:14,fontWeight:800,color:"#fbbf24"}}>Possible duplicates found</div>
                  <div style={{fontSize:12,color:"#fde68a",marginTop:4}}>
                    {duplicateCount} row{duplicateCount === 1 ? "" : "s"} matched the duplicate check exactly or approximately, including split groups. {selectedDuplicateCount} {selectedDuplicateCount === 1 ? "is" : "are"} still selected.
                  </div>
                  <div style={{fontSize:11,color:"#fcd34d",marginTop:6}}>
                    {existingDuplicateCount} match existing {stmtSrc === "checking" ? "checking" : "credit card"} transactions or split groups in {selectedYear}. {splitDuplicateCount} came from split groups. {importDuplicateCount} repeat inside this import file.
                  </div>
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={excludeFlaggedDuplicates} style={{
                    padding:"8px 12px",borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer",
                    background:"#f59e0b22",color:"#fbbf24",border:"1px solid #f59e0b44",
                  }}>Exclude flagged rows</button>
                  <button onClick={includeFlaggedDuplicates} style={{
                    padding:"8px 12px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",
                    background:BG,color:MUTED,border:`1px solid ${BORDER}`,
                  }}>Re-select flagged rows</button>
                </div>
              </div>
            </Card>
          )}

          {/* Transaction review table */}
          <Card style={{padding:0,overflow:"hidden"}}>
            {/* Header */}
            <div style={{display:"grid",gridTemplateColumns:"36px 60px 1fr 90px 130px",padding:"9px 16px",background:BG,borderBottom:`1px solid ${BORDER}`}}>
              {["✓","Date","Description","Amount","Category"].map((h,i)=>(
                <div key={i} style={{fontSize:10,fontWeight:700,color:MUTED,textTransform:"uppercase",letterSpacing:".5px",textAlign:i>=3?"right":"left"}}>{h}</div>
              ))}
            </div>

            {reviewed.map((t, idx) => {
              const color = catColorsAll[t.cat] || MUTED;
              const isTransfer = t.cat==="Transfer"||t.cat==="Income";
              const duplicateInfo = duplicateRows[idx] || {};
              return (
                <div key={idx} style={{
                  display:"grid",gridTemplateColumns:"36px 60px 1fr 90px 130px",
                  padding:"9px 16px",borderBottom:`1px solid ${BORDER}`,
                  background:!t._include?"#33415511":duplicateInfo.flagged?"#f59e0b12":isTransfer?"#33415508":idx%2===0?SURFACE:BG,
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
                      : <div onClick={()=>setEditingIdx(idx)} style={{cursor:"text"}} title="Click to edit">
                          <div style={{fontSize:13,color:isTransfer?MUTED:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                            {t.desc}
                          </div>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginTop:4}}>
                            {t._localMatch && <span style={{fontSize:9,fontWeight:700,background:"#22c55e22",color:"#22c55e",border:"1px solid #22c55e33",borderRadius:4,padding:"1px 4px"}}>{t._localMatchPossible ? "≈ likely match" : "✓ known"}</span>}
                            {duplicateInfo.matchesExisting && <span style={{fontSize:9,fontWeight:700,background:"#f59e0b22",color:"#fbbf24",border:"1px solid #f59e0b33",borderRadius:4,padding:"1px 4px"}}>⚠ matches existing</span>}
                            {duplicateInfo.possibleExisting && <span style={{fontSize:9,fontWeight:700,background:"#facc1522",color:"#facc15",border:"1px solid #facc1533",borderRadius:4,padding:"1px 4px"}}>≈ possible duplicate</span>}
                            {duplicateInfo.matchesExistingSplit && <span style={{fontSize:9,fontWeight:700,background:"#f9731622",color:"#fdba74",border:"1px solid #f9731633",borderRadius:4,padding:"1px 4px"}}>⚠ matches split group</span>}
                            {duplicateInfo.possibleExistingSplit && <span style={{fontSize:9,fontWeight:700,background:"#fb923c22",color:"#fdba74",border:"1px solid #fb923c33",borderRadius:4,padding:"1px 4px"}}>≈ possible split match</span>}
                            {duplicateInfo.repeatsInImport && <span style={{fontSize:9,fontWeight:700,background:"#fb923c22",color:"#fdba74",border:"1px solid #fb923c33",borderRadius:4,padding:"1px 4px"}}>↺ repeated in file</span>}
                            {duplicateInfo.possibleRepeatInImport && <span style={{fontSize:9,fontWeight:700,background:"#fb923c22",color:"#fdba74",border:"1px solid #fb923c33",borderRadius:4,padding:"1px 4px"}}>≈ possible repeat</span>}
                          </div>
                          {duplicateInfo.referenceLines?.length > 0 && (
                            <div style={{display:"flex",flexDirection:"column",gap:2,marginTop:4}}>
                              {duplicateInfo.referenceLines.map((line, lineIdx) => (
                                <div
                                  key={`${idx}-${lineIdx}`}
                                  title={line}
                                  style={{fontSize:10,color:"#fcd34d",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}
                                >
                                  {line}
                                </div>
                              ))}
                            </div>
                          )}
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
            <div style={{fontSize:20,fontWeight:800,color:TEXT,marginBottom:8}}>Import complete</div>
            <div style={{fontSize:13,color:MUTED,marginBottom:28}}>
              {includedCount} transactions added to Transactions (Checking/Credit Card).<br/>
              Months were derived from the imported transaction dates, and the dashboard has updated.
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
  { id:"summary",      label:"Summary",      emoji:"\u{1F4CB}" },
  { id:"recs",         label:"Tips",         emoji:"\u{1F4A1}" },
  { id:"payoffs",      label:"Payoffs",      emoji:"\u{1F4B3}" },
  { id:"scenarios",    label:"Scenarios",    emoji:"\u{1F4C8}" },
  { id:"categories",   label:"Categories",   emoji:"\u{1F4C2}" },
  { id:"trends",       label:"Trends",       emoji:"\u{1F4CA}" },
  { id:"meals",        label:"Meals",        emoji:"\u{1F37D}\u{FE0F}" },
  { id:"transactions", label:"Transactions", emoji:"\u{1F9FE}" },
  { id:"settings",     label:"Settings",     emoji:"\u{2699}\u{FE0F}" },
];
const PAGES_URL = "https://xkillerbees.github.io/family-budget-dashboard/";
const REPO_URL = "https://github.com/xKillerbees/family-budget-dashboard";
const APP_VERSION = "0.1.20";
const APP_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_ALIAS = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};
function normalizeMonthName(m) {
  const raw = (m || "").toString().trim();
  if (!raw) return "";
  const full = APP_MONTHS.find(x => x.toLowerCase() === raw.toLowerCase());
  if (full) return full;
  return MONTH_ALIAS[raw.toLowerCase()] || raw;
}
function monthFromDateString(dateStr) {
  const s = (dateStr || "").toString().trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2})[\/-]/);
  if (!m) return "";
  const idx = Number(m[1]) - 1;
  return idx >= 0 && idx < 12 ? APP_MONTHS[idx] : "";
}
function yearFromDateString(dateStr) {
  const s = (dateStr || "").toString().trim();
  if (!s) return null;
  const ymd = s.match(/^(\d{4})[-/]\d{1,2}[-/]\d{1,2}$/);
  if (ymd) return Number(ymd[1]);
  const mdy = s.match(/^\d{1,2}[\/-]\d{1,2}[\/-](\d{2}|\d{4})$/);
  if (!mdy) return null;
  const raw = mdy[1];
  if (raw.length === 4) return Number(raw);
  const yy = Number(raw);
  return yy >= 70 ? 1900 + yy : 2000 + yy;
}
function deriveTxnMonth(t) {
  const fromDate = monthFromDateString(t?.date);
  if (fromDate) return fromDate;
  return normalizeMonthName(t?.month) || "January";
}
function deriveTxnYear(t, fallbackYear = null) {
  const fromField = Number(t?.year);
  if (Number.isFinite(fromField) && fromField > 1900 && fromField < 3000) return fromField;
  const fromDate = yearFromDateString(t?.date);
  if (Number.isFinite(fromDate) && fromDate > 1900 && fromDate < 3000) return fromDate;
  return fallbackYear;
}
function formatMonthYearLabel(month, year) {
  const monthLabel = normalizeMonthName(month);
  const yearNum = Number(year);
  return [monthLabel, Number.isFinite(yearNum) ? String(yearNum) : ""].filter(Boolean).join(" ");
}
function getTxnDateMeta(txn, fallbackYear = null) {
  const date = fingerprintTxnDate(txn?.date);
  const mmdd = date.match(/^(\d{2})\/(\d{2})$/);
  if (!mmdd) return null;
  const monthNum = Number(mmdd[1]);
  const dayNum = Number(mmdd[2]);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  const year = deriveTxnYear(txn, fallbackYear);
  return { monthNum, dayNum, year };
}
function txnDateSortValue(txn, fallbackYear = null) {
  const meta = getTxnDateMeta(txn, fallbackYear);
  if (!meta) return -1;
  const yearNum = Number.isFinite(meta.year) ? meta.year : 0;
  return (yearNum * 10000) + (meta.monthNum * 100) + meta.dayNum;
}
function formatTxnDateLabel(txn, fallbackYear = null) {
  const meta = getTxnDateMeta(txn, fallbackYear);
  if (!meta) return (txn?.date || "").toString().trim();
  const monthLabel = APP_MONTHS[meta.monthNum - 1]?.slice(0, 3) || "";
  return Number.isFinite(meta.year) ? `${monthLabel} ${meta.dayNum}, ${meta.year}` : `${monthLabel} ${meta.dayNum}`;
}
const TXN_NOTE_FLAGS = ["ONE-TIME", "RECURRING"];
function hasTxnNoteFlag(note, flag) {
  return new RegExp(`\\b${flag}\\b`, "i").test(note || "");
}
function getTxnDisplayNote(note) {
  let cleaned = (note || "").toString();
  TXN_NOTE_FLAGS.forEach(flag => {
    cleaned = cleaned.replace(new RegExp(`\\b${flag}\\b`, "ig"), " ");
  });
  return cleaned.replace(/\s{2,}/g, " ").trim();
}
function withTxnNoteFlag(note, flag, enabled) {
  const flags = new Set(TXN_NOTE_FLAGS.filter(name => hasTxnNoteFlag(note, name)));
  if (enabled) flags.add(flag);
  else flags.delete(flag);
  const cleaned = getTxnDisplayNote(note);
  return [cleaned, ...TXN_NOTE_FLAGS.filter(name => flags.has(name))].filter(Boolean).join(" ").trim();
}
const MERCHANT_NOISE_PATTERNS = [
  /\bpoint of sale withdrawal\b/g,
  /\bpoint of sale\b/g,
  /\bach payment\b/g,
  /\bach deposit\b/g,
  /\bdeposit internet transfer from\b/g,
  /\bdeposit internet transfer to\b/g,
  /\binternet transfer from\b/g,
  /\binternet transfer to\b/g,
  /\bpayment\b/g,
  /\bdeposit\b/g,
  /\bwithdrawal\b/g,
  /\bpurchase authorization\b/g,
  /\brecurring debit card purchase\b/g,
  /\bdebit card purchase\b/g,
  /\bonline transfer from\b/g,
  /\bonline transfer to\b/g,
];
const MERCHANT_DROP_WORDS = new Set([
  "ach", "point", "sale", "withdrawal", "deposit", "internet", "transfer", "from", "to",
  "payment", "purchase", "card", "debit", "credit", "visa", "direct", "check", "pos",
  "transaction", "trn", "epay", "online", "recurring", "authorization", "autopay", "bill",
  "pay", "received", "cashout", "cash", "out", "fee", "fees", "the", "and", "for", "of",
]);
function normalizeTxnText(desc) {
  return (desc || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function buildMerchantSignature(desc) {
  const normalized = normalizeTxnText(desc);
  if (!normalized) return { base: "", core: "", joined: "", tokens: [] };
  let stripped = normalized;
  MERCHANT_NOISE_PATTERNS.forEach(pattern => { stripped = stripped.replace(pattern, " "); });
  stripped = stripped.replace(/\s+/g, " ").trim();
  const baseTokens = stripped.split(" ").filter(Boolean);
  const tokens = baseTokens.filter(token =>
    token.length > 1
    && !MERCHANT_DROP_WORDS.has(token)
    && !/^\d+$/.test(token)
    && !/^[a-z]{2,4}us$/.test(token)
  );
  const chosen = tokens.length ? tokens : baseTokens.filter(token => token.length > 1).slice(0, 8);
  const unique = [];
  chosen.forEach(token => {
    if (!unique.includes(token)) unique.push(token);
  });
  const core = unique.join(" ").trim();
  return {
    base: normalized,
    core: core || normalized,
    joined: (core || normalized).replace(/\s+/g, ""),
    tokens: unique.length ? unique : normalized.split(" ").filter(Boolean).slice(0, 8),
  };
}
function merchantSimilarity(left, right) {
  const a = typeof left === "string" ? buildMerchantSignature(left) : left;
  const b = typeof right === "string" ? buildMerchantSignature(right) : right;
  if (!a?.core || !b?.core) return 0;
  if (a.core === b.core || a.joined === b.joined) return 1;
  if (a.core.includes(b.core) || b.core.includes(a.core) || a.joined.includes(b.joined) || b.joined.includes(a.joined)) return 0.93;
  const aTokens = a.tokens || [];
  const bTokens = b.tokens || [];
  if (!aTokens.length || !bTokens.length) return 0;
  const common = aTokens.filter(token => bTokens.includes(token));
  const minCover = common.length / Math.min(aTokens.length, bTokens.length);
  const maxCover = common.length / Math.max(aTokens.length, bTokens.length);
  return (minCover * 0.75) + (maxCover * 0.25);
}
function fingerprintTxnDate(dateStr) {
  const s = (dateStr || "").toString().trim();
  if (!s) return "";
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) return `${ymd[2].padStart(2, "0")}/${ymd[3].padStart(2, "0")}`;
  const mdy = s.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2}|\d{4}))?$/);
  if (mdy) return `${mdy[1].padStart(2, "0")}/${mdy[2].padStart(2, "0")}`;
  return s;
}
function fingerprintTxnDesc(desc) {
  return buildMerchantSignature(desc).joined.slice(0, 64);
}
function buildTxnFingerprint(txn, fallbackYear = null) {
  const date = fingerprintTxnDate(txn?.date);
  const desc = fingerprintTxnDesc(txn?.desc);
  const amount = Number(txn?.amount);
  const year = deriveTxnYear(txn, fallbackYear);
  if (!date || !desc || !Number.isFinite(amount) || !Number.isFinite(year)) return null;
  return `${year}|${date}|${Math.round(amount * 100)}|${desc}`;
}
function getTxnSplitGroupKey(txn, fallbackYear = null) {
  const year = deriveTxnYear(txn, fallbackYear);
  const date = fingerprintTxnDate(txn?.date);
  if (!date || !Number.isFinite(year)) return "";
  const splitGroupId = String(txn?.splitGroupId || "").trim();
  if (splitGroupId) return `${year}|${date}|id:${splitGroupId}`;
  const parentDesc = String(txn?.splitParentDesc || "").trim();
  const parentAmount = Number(txn?.splitParentAmount);
  if (parentDesc || Number.isFinite(parentAmount)) {
    return `${year}|${date}|meta:${fingerprintTxnDesc(parentDesc)}|${Number.isFinite(parentAmount) ? Math.round(Math.abs(parentAmount) * 100) : ""}`;
  }
  return "";
}
function collectSplitDuplicateGroups(txns = [], fallbackYear = null) {
  const groups = new Map();
  txns.forEach(txn => {
    const groupKey = getTxnSplitGroupKey(txn, fallbackYear);
    if (!groupKey) return;
    const year = deriveTxnYear(txn, fallbackYear);
    const date = fingerprintTxnDate(txn?.date);
    const amount = Number(txn?.amount);
    const amountCents = Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) : null;
    if (!date || !Number.isFinite(year) || !Number.isFinite(amountCents) || amountCents <= 0) return;
    const parentDesc = String(txn?.splitParentDesc || "").trim();
    const parentAmount = Number(txn?.splitParentAmount);
    const entry = groups.get(groupKey) || {
      year,
      date,
      totalCents: 0,
      txnCount: 0,
      parentDesc,
      parentAmountCents: Number.isFinite(parentAmount) ? Math.round(Math.abs(parentAmount) * 100) : null,
      merchant: buildMerchantSignature(parentDesc || txn?.desc),
    };
    entry.totalCents += amountCents;
    entry.txnCount += 1;
    if (!entry.parentDesc && parentDesc) {
      entry.parentDesc = parentDesc;
      entry.merchant = buildMerchantSignature(parentDesc);
    }
    if (!Number.isFinite(entry.parentAmountCents) && Number.isFinite(parentAmount)) {
      entry.parentAmountCents = Math.round(Math.abs(parentAmount) * 100);
    }
    groups.set(groupKey, entry);
  });
  return [...groups.values()]
    .map(group => ({
      ...group,
      exactKey: group.parentDesc
        ? `${group.year}|${group.date}|${group.totalCents}|${fingerprintTxnDesc(group.parentDesc)}`
        : null,
    }))
    .filter(group => group.txnCount > 1 || Number.isFinite(group.parentAmountCents));
}
function formatDuplicateAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return `${amount < 0 ? "+" : ""}${fmt(amount)}`;
}
function compactDuplicateDesc(desc, max = 56) {
  const text = String(desc || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
function summarizeTxnDuplicateRef(txn, { rowNumber = null } = {}) {
  const parts = [];
  if (Number.isInteger(rowNumber)) parts.push(`row ${rowNumber}`);
  const date = fingerprintTxnDate(txn?.date);
  if (date) parts.push(date);
  const desc = compactDuplicateDesc(txn?.desc);
  if (desc) parts.push(desc);
  const amount = formatDuplicateAmount(txn?.amount);
  if (amount) parts.push(amount);
  return parts.join(" · ");
}
function summarizeSplitGroupDuplicateRef(group) {
  const parts = [];
  const date = fingerprintTxnDate(group?.date);
  if (date) parts.push(date);
  const desc = compactDuplicateDesc(group?.parentDesc || group?.desc);
  if (desc) parts.push(desc);
  if (Number.isFinite(group?.totalCents)) parts.push(fmt(group.totalCents / 100));
  if ((Number(group?.txnCount) || 0) > 1) parts.push(`${group.txnCount} splits`);
  return parts.join(" · ");
}
function buildDuplicateReferenceLine(label, matches, formatter) {
  if (!Array.isArray(matches) || !matches.length) return "";
  const summary = formatter(matches[0]);
  if (!summary) return "";
  const more = matches.length > 1 ? ` (+${matches.length - 1} more)` : "";
  return `${label}: ${summary}${more}`;
}
function monthYearValue(year, month) {
  const safeYear = Number(year);
  const monthIdx = APP_MONTHS.indexOf(normalizeMonthName(month));
  if (!Number.isFinite(safeYear) || monthIdx < 0) return null;
  return (safeYear * 12) + monthIdx;
}
function isRecurringItemActive(item, month, year) {
  const currentValue = monthYearValue(year, month);
  const startValue = monthYearValue(item?.startYear, item?.startMonth);
  if (currentValue == null) return false;
  if (startValue == null) return true;
  return currentValue >= startValue;
}
function buildRecurringItemKey(item) {
  return [
    item?.src || "",
    item?.cat || "",
    Math.round(Math.abs(Number(item?.amount) || 0) * 100),
    fingerprintTxnDesc(item?.name || ""),
    fingerprintTxnDate(item?.startDate || ""),
    Number(item?.startYear) || "",
    normalizeMonthName(item?.startMonth) || "",
  ].join("|");
}
function recurringSourceLabel(src) {
  return src === "cc" ? "Credit Card" : "Checking";
}
function isSpendTxn(txn) {
  const amount = Number(txn?.amount);
  return Number.isFinite(amount) && amount > 0 && txn?.cat !== "Income" && txn?.cat !== "Transfer";
}
function recurringTxnMatchesItem(txn, item) {
  if (!txn || !item) return false;
  if ((txn.cat || "") !== (item.cat || "")) return false;
  if ((item.src || "") && (txn.src || "") !== (item.src || "")) return false;
  const score = merchantSimilarity(txn.desc, item.name);
  if (score < 0.68) return false;
  if (score >= 0.92) return true;
  const txnAmt = Math.abs(Number(txn.amount) || 0);
  const itemAmt = Math.abs(Number(item.amount) || 0);
  return Math.abs(txnAmt - itemAmt) <= Math.max(5, itemAmt * 0.35);
}
function isTxnRecurringSpend(txn, recurringItems = []) {
  if (!isSpendTxn(txn)) return false;
  if (hasTxnNoteFlag(txn.note, "RECURRING")) return true;
  return recurringItems.some(item => recurringTxnMatchesItem(txn, item));
}
function getRecurringItemSeenDates(item, txns = [], fallbackYear = null) {
  const seen = new Map();
  txns.forEach(txn => {
    if (!isSpendTxn(txn) || !recurringTxnMatchesItem(txn, item)) return;
    const label = formatTxnDateLabel(txn, fallbackYear);
    if (!label) return;
    const sortValue = txnDateSortValue(txn, fallbackYear);
    const prevValue = seen.get(label);
    if (prevValue == null || sortValue > prevValue) seen.set(label, sortValue);
  });
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}
function summarizeRecurringItemDates(item, txns = [], fallbackYear = null) {
  const seenDates = getRecurringItemSeenDates(item, txns, fallbackYear);
  if (seenDates.length) {
    const preview = seenDates.slice(0, 3);
    const extra = seenDates.length - preview.length;
    return `Seen: ${preview.join(" · ")}${extra > 0 ? ` · +${extra} more` : ""}`;
  }
  const firstMarked = formatTxnDateLabel({ date: item?.startDate, year: item?.startYear }, fallbackYear ?? item?.startYear);
  if (firstMarked) return `First marked: ${firstMarked}`;
  const startLabel = formatMonthYearLabel(item?.startMonth, item?.startYear ?? fallbackYear);
  return startLabel ? `Starts: ${startLabel}` : "";
}
function buildMonthBudgetSnapshot({
  month, year, checkTxns = [], ccTxns = [], recurringItems = [],
}) {
  const txns = [
    ...checkTxns
      .filter(t => deriveTxnMonth(t) === month && deriveTxnYear(t, year) === year)
      .map(t => ({ ...t, src: "checking" })),
    ...ccTxns
      .filter(t => deriveTxnMonth(t) === month && deriveTxnYear(t, year) === year)
      .map(t => ({ ...t, src: "cc" })),
  ];
  const incomeReceived = txns
    .filter(t => t.cat === "Income")
    .reduce((sum, txn) => sum + Math.abs(Number(txn.amount) || 0), 0);
  const spendTxns = txns.filter(isSpendTxn);
  const spend = spendTxns.reduce((sum, txn) => sum + Math.abs(Number(txn.amount) || 0), 0);
  const recurringSpend = spendTxns
    .filter(txn => isTxnRecurringSpend(txn, recurringItems))
    .reduce((sum, txn) => sum + Math.abs(Number(txn.amount) || 0), 0);
  return {
    txns,
    spendTxns,
    incomeReceived,
    spend,
    recurringSpend,
    nonRecurringSpend: Math.max(0, spend - recurringSpend),
  };
}
function recurringPlanDeltaForCategory({
  cat, selectedMonth, selectedYear, recurringItems, checkTxns, ccTxns,
}) {
  const actualTxns = [
    ...checkTxns
      .filter(t =>
        t.month === selectedMonth
        && deriveTxnYear(t, selectedYear) === selectedYear
        && t.cat === cat
        && t.cat !== "Transfer"
        && t.cat !== "Income"
        && Number(t.amount) > 0
      )
      .map(t => ({ ...t, src: "checking" })),
    ...ccTxns
      .filter(t =>
        t.month === selectedMonth
        && deriveTxnYear(t, selectedYear) === selectedYear
        && t.cat === cat
        && Number(t.amount) > 0
      )
      .map(t => ({ ...t, src: "cc" })),
  ];
  const activeItems = recurringItems
    .filter(item => item.cat === cat && isRecurringItemActive(item, selectedMonth, selectedYear))
    .sort((a, b) => {
      const left = monthYearValue(a.startYear, a.startMonth) ?? 0;
      const right = monthYearValue(b.startYear, b.startMonth) ?? 0;
      return left - right;
    });
  const usedActualIdx = new Set();
  return activeItems.reduce((sum, item) => {
    let bestIdx = -1;
    let bestScore = 0;
    actualTxns.forEach((txn, idx) => {
      if (usedActualIdx.has(idx) || !recurringTxnMatchesItem(txn, item)) return;
      const score = merchantSimilarity(txn.desc, item.name);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      usedActualIdx.add(bestIdx);
      return sum;
    }
    return sum + Math.abs(Number(item.amount) || 0);
  }, 0);
}
function latestMonthFromTxns(checkTxns = [], ccTxns = []) {
  const all = [...checkTxns, ...ccTxns].map(t => deriveTxnMonth(t)).filter(Boolean);
  const unique = [...new Set(all)];
  const months = APP_MONTHS.filter(m => unique.includes(m));
  return months.length ? months[months.length - 1] : "January";
}
function latestYearFromTxns(checkTxns = [], ccTxns = [], fallbackYear = new Date().getFullYear()) {
  const years = [...checkTxns, ...ccTxns]
    .map(t => deriveTxnYear(t))
    .filter(y => Number.isFinite(y));
  if (!years.length) return fallbackYear;
  return Math.max(...years);
}
function makeTxnId(prefix, usedIds = new Set()) {
  let id = "";
  do {
    id = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}
function normalizeTxnIds(txns = [], prefix = "t") {
  const usedIds = new Set();
  let changed = false;
  const next = txns.map(txn => {
    const currentId = typeof txn?.id === "string" ? txn.id.trim() : "";
    if (!currentId || usedIds.has(currentId)) {
      changed = true;
      return { ...txn, id: makeTxnId(prefix, usedIds) };
    }
    usedIds.add(currentId);
    return txn;
  });
  return changed ? next : txns;
}
function hasDuplicateTxnIds(txns = []) {
  const seen = new Set();
  for (const txn of txns) {
    const id = typeof txn?.id === "string" ? txn.id.trim() : "";
    if (!id || seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function BudgetDashboardClean() {
  const [page, setPage] = useState("summary");
  const [scenariosTab, setScenariosTab] = useState("impact");
  const [categoriesTab, setCategoriesTab] = useState("spending");
  const width    = useWindowWidth();
  const isMobile = width < 768;
  const wide     = width >= 1000;
  const props    = { wide, isMobile };
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(() => {
    const stored = parseInt(ls.get("budget_selectedYear") || "", 10);
    if (Number.isFinite(stored)) return stored;
    return latestYearFromTxns(ls.getJSON("budget_checkTxns", []), ls.getJSON("budget_ccTxns", []), currentYear);
  });

  // ── Live transaction state — persisted to localStorage ────────────────────
  const [checkTxns, setCheckTxns] = useState(() => {
    return normalizeTxnIds(
      ls.getJSON("budget_checkTxns", []).map(t => ({ ...t, subcat: normalizeTxnSubcategory(t.subcat), month: deriveTxnMonth(t), year: deriveTxnYear(t, currentYear), excludeFromTags: !!t.excludeFromTags })),
      "c",
    );
  });
  const [ccTxns, setCCTxns] = useState(() => {
    return normalizeTxnIds(
      ls.getJSON("budget_ccTxns", []).map(t => ({ ...t, subcat: normalizeTxnSubcategory(t.subcat), month: deriveTxnMonth(t), year: deriveTxnYear(t, currentYear), excludeFromTags: !!t.excludeFromTags })),
      "cc",
    );
  });

  const [selectedMonth, setSelectedMonth] = useState(() => latestMonthFromTxns(
    ls.getJSON("budget_checkTxns", []),
    ls.getJSON("budget_ccTxns", []),
  ));

  // Settings state — all persisted
  const [takeHome, setTakeHome] = useState(() => {
    const s = ls.get("budget_takeHome");
    return s ? parseFloat(s) : DEFAULT_TAKE_HOME;
  });
  const [oneTimes, setOneTimes] = useState(() => {
    return ls.getJSON("budget_oneTimes", []);
  });
  const [recurringItems, setRecurringItems] = useState(() => {
    return ls.getJSON("budget_recurringItems", []);
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
  const [familySize, setFamilySize] = useState(() => {
    const s = ls.get("budget_familySize"); return s ? Math.max(1, parseInt(s, 10) || 1) : 4;
  });

  // Persist all state to localStorage
  useEffect(() => { ls.setJSON("budget_checkTxns", checkTxns); }, [checkTxns]);
  useEffect(() => { ls.setJSON("budget_ccTxns", ccTxns); }, [ccTxns]);
  useEffect(() => { ls.set("budget_takeHome", String(takeHome)); }, [takeHome]);
  useEffect(() => { ls.setJSON("budget_oneTimes", oneTimes); }, [oneTimes]);
  useEffect(() => { ls.setJSON("budget_recurringItems", recurringItems); }, [recurringItems]);
  useEffect(() => { ls.setJSON("budget_kc", budgetKc); }, [budgetKc]);
  useEffect(() => { ls.set("budget_t2carry", String(t2CarryIn)); }, [t2CarryIn]);
  useEffect(() => { ls.set("budget_groceryGoal", String(groceryGoal)); }, [groceryGoal]);
  useEffect(() => { ls.set("budget_familySize", String(familySize)); }, [familySize]);
  useEffect(() => { ls.set("budget_selectedYear", String(selectedYear)); }, [selectedYear]);
  useEffect(() => {
    if (hasDuplicateTxnIds(checkTxns)) {
      setCheckTxns(prev => normalizeTxnIds(prev, "c"));
    }
  }, [checkTxns]);
  useEffect(() => {
    if (hasDuplicateTxnIds(ccTxns)) {
      setCCTxns(prev => normalizeTxnIds(prev, "cc"));
    }
  }, [ccTxns]);

  // All months that have transaction data
  const availableMonths = useMemo(() => {
    const all = [...checkTxns, ...ccTxns]
      .filter(t => (deriveTxnYear(t, currentYear) || currentYear) === selectedYear)
      .map(t => deriveTxnMonth(t))
      .filter(Boolean);
    const unique = [...new Set(all)];
    const months = APP_MONTHS.filter(m => unique.includes(m));
    return months.length ? months : ["January"];
  }, [checkTxns, ccTxns, selectedYear, currentYear]);
  const availableYears = useMemo(() => {
    const years = [...checkTxns, ...ccTxns]
      .map(t => deriveTxnYear(t))
      .filter(y => Number.isFinite(y));
    const unique = [...new Set(years)].sort((a, b) => a - b);
    return unique.length ? unique : [currentYear];
  }, [checkTxns, ccTxns, currentYear]);
  useEffect(() => {
    if (!availableYears.includes(selectedYear)) setSelectedYear(availableYears[availableYears.length - 1] || currentYear);
  }, [availableYears, selectedYear, currentYear]);
  useEffect(() => {
    if (!availableMonths.includes(selectedMonth)) setSelectedMonth(availableMonths[availableMonths.length - 1] || "January");
  }, [availableMonths, selectedMonth]);

  const [payoffs, setPayoffs] = useState(() => {
    return ls.getJSON("budget_payoffs", PAYOFFS_INIT);
  });
  const [waterfallDisabled, setWaterfallDisabled] = useState(() => ls.getJSON("budget_wfDisabled", []));
  useEffect(() => { ls.setJSON("budget_wfDisabled", waterfallDisabled); }, [waterfallDisabled]);
  useEffect(() => { ls.setJSON("budget_payoffs", payoffs); }, [payoffs]);

  const [dashName, setDashName] = useState(() => ls.get("budget_dashName") || "My Budget");
  const [showTithe, setShowTithe] = useState(() => ls.get("budget_showTithe") !== "0");
  const [showABA, setShowABA]   = useState(() => ls.get("budget_showABA")   !== "0");
  const [readabilityMode, setReadabilityMode] = useState(() => ls.get("budget_readabilityMode") === "1");
  const [uiScale, setUiScale] = useState(() => {
    const n = parseFloat(ls.get("budget_uiScale") || "1");
    const allowed = [1, 1.1, 1.2, 1.3];
    return allowed.includes(n) ? n : 1;
  });
  const [hideZeroSummaryCats, setHideZeroSummaryCats] = useState(() => ls.get("budget_hideZeroSummaryCats") === "1");
  const [mobileTxnActionMenu, setMobileTxnActionMenu] = useState(() => ls.get("budget_mobileTxnActionMenu") !== "0");
  const [customCats, setCustomCats] = useState(() => {
    const raw = ls.getJSON("budget_customCats", []);
    return raw.map(c => typeof c === "string" ? { name: c, icon: "📁", color: "#94a3b8" } : c);
  });
  useEffect(() => { ls.setJSON("budget_customCats", customCats); }, [customCats]);
  const [subcatsByCat, setSubcatsByCat] = useState(() => {
    const stored = normalizeSubcategoriesByCat(ls.getJSON("budget_subcatsByCat", {}));
    if (Object.keys(stored).length) return stored;
    return collectTxnSubcategoriesByCat([
      ...ls.getJSON("budget_checkTxns", []),
      ...ls.getJSON("budget_ccTxns", []),
    ]);
  });
  useEffect(() => { ls.setJSON("budget_subcatsByCat", subcatsByCat); }, [subcatsByCat]);
  const allCats = useMemo(() => [...VALID_CATS, ...customCats.map(c => c.name)], [customCats]);
  const catColorsAll = useMemo(() => {
    const all = { ...CAT_COLORS };
    customCats.forEach(c => { all[c.name] = c.color; });
    return all;
  }, [customCats]);

  const [abaSettings, setAbaSettings] = useState(() => ls.getJSON("budget_abaSettings", { costPerVisit: 35, oopCap: 7000 }));
  useEffect(() => { ls.setJSON("budget_abaSettings", abaSettings); }, [abaSettings]);

  const [titheSettings, setTitheSettings] = useState(() => ls.getJSON("budget_titheSettings", { t1Keywords: "", t2Keywords: "8500,2nd tithe,feast", feastMonth: 9 }));
  useEffect(() => { ls.setJSON("budget_titheSettings", titheSettings); }, [titheSettings]);
  useEffect(() => { ls.set("budget_dashName",  dashName); }, [dashName]);
  useEffect(() => { ls.set("budget_showTithe", showTithe ? "1" : "0"); }, [showTithe]);
  useEffect(() => { ls.set("budget_showABA",   showABA   ? "1" : "0"); }, [showABA]);
  useEffect(() => { ls.set("budget_readabilityMode", readabilityMode ? "1" : "0"); }, [readabilityMode]);
  useEffect(() => { ls.set("budget_uiScale", String(uiScale)); }, [uiScale]);
  useEffect(() => { ls.set("budget_hideZeroSummaryCats", hideZeroSummaryCats ? "1" : "0"); }, [hideZeroSummaryCats]);
  useEffect(() => { ls.set("budget_mobileTxnActionMenu", mobileTxnActionMenu ? "1" : "0"); }, [mobileTxnActionMenu]);

  // Redirect away from tabs that have been toggled off
  useEffect(() => {
    if (!showTithe && page === "tithe") setPage("summary");
    if (!showABA   && page === "aba")   setPage("summary");
    if (!showTithe && scenariosTab === "tithe") setScenariosTab("impact");
    if (!showABA   && scenariosTab === "aba")   setScenariosTab("impact");
    if (page === "tithe" && showTithe) {
      if (scenariosTab !== "tithe") setScenariosTab("tithe");
      setPage("scenarios");
    }
    if (page === "aba" && showABA) {
      if (scenariosTab !== "aba") setScenariosTab("aba");
      setPage("scenarios");
    }
    if (page === "income") {
      if (categoriesTab !== "income") setCategoriesTab("income");
      setPage("categories");
    }
    if (page === "import") setPage("transactions");
  }, [showTithe, showABA, page, scenariosTab, categoriesTab]);

  const updateTxnCat = useCallback((src, id, newCat) => {
    if (src === "checking") setCheckTxns(prev => prev.map(t => t.id === id ? {
      ...t,
      cat: newCat,
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, newCat, t.subcat),
    } : t));
    else                    setCCTxns(prev => prev.map(t => t.id === id ? {
      ...t,
      cat: newCat,
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, newCat, t.subcat),
    } : t));
  }, [subcatsByCat]);

  const updateTxn = useCallback((src, id, patch) => {
    const cleanPatch = {
      ...patch,
      desc: (patch.desc || "").trim(),
      date: (patch.date || "").trim(),
      amount: Number(patch.amount),
      note: patch.note ?? "",
    };
    if (Object.prototype.hasOwnProperty.call(patch, "subcat")) {
      cleanPatch.subcat = normalizeTxnSubcategory(patch.subcat);
    } else {
      delete cleanPatch.subcat;
    }
    if (!cleanPatch.desc || !cleanPatch.date || Number.isNaN(cleanPatch.amount)) return;
    if (src === "checking") setCheckTxns(prev => prev.map(t => t.id === id ? {
      ...t,
      ...cleanPatch,
      month: deriveTxnMonth({ ...t, ...cleanPatch }),
      year: deriveTxnYear({ ...t, ...cleanPatch }, t.year || selectedYear),
    } : t));
    else                    setCCTxns(prev => prev.map(t => t.id === id ? {
      ...t,
      ...cleanPatch,
      month: deriveTxnMonth({ ...t, ...cleanPatch }),
      year: deriveTxnYear({ ...t, ...cleanPatch }, t.year || selectedYear),
    } : t));
  }, [selectedYear]);

  const deleteTxn = useCallback((src, id, opts = {}) => {
    if (!opts.force && !confirmDeleteAction("Delete this transaction?")) return;
    if (src === "checking") setCheckTxns(prev => prev.filter(t => t.id !== id));
    else                    setCCTxns(prev => prev.filter(t => t.id !== id));
  }, []);

  const toggleTxnTagging = useCallback((src, id) => {
    if (src === "checking") setCheckTxns(prev => prev.map(t => t.id === id ? { ...t, excludeFromTags: !t.excludeFromTags } : t));
    else                    setCCTxns(prev => prev.map(t => t.id === id ? { ...t, excludeFromTags: !t.excludeFromTags } : t));
  }, []);

  const clearTxns = useCallback((src) => {
    const label = src === "all" ? "all transactions" : (src === "checking" ? "all checking transactions" : "all credit card transactions");
    if (!confirmDeleteAction(`Delete ${label}? This cannot be undone.`)) return;
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
        const usedIds = new Set(prev.filter(t => t.id !== id).map(t => t.id).filter(Boolean));
        const splitParentDesc = String(base.splitParentDesc || base.desc || "").trim() || "Split purchase";
        const splitParentAmount = roundMoney(Math.abs(Number(base.splitParentAmount) || Number(base.amount) || 0));
        const splitGroupId = String(base.splitGroupId || base.id || "").trim() || makeTxnId("sg", new Set());
        const splitParentId = String(base.splitParentId || base.id || splitGroupId).trim();
        const splits = splitTxns.map(t => ({
          ...base,
          splitGroupId,
          splitParentId,
          splitParentDesc,
          splitParentAmount,
          ...t,
          subcat: normalizeTxnSubcategory(t.subcat),
          id: makeTxnId("c", usedIds),
          note: (t.note||"")+" [split]",
        }));
        return [...prev.slice(0, idx), ...splits, ...prev.slice(idx + 1)];
      });
    } else {
      setCCTxns(prev => {
        const idx = prev.findIndex(t => t.id === id);
        if (idx < 0) return prev;
        const base = prev[idx];
        const usedIds = new Set(prev.filter(t => t.id !== id).map(t => t.id).filter(Boolean));
        const splitParentDesc = String(base.splitParentDesc || base.desc || "").trim() || "Split purchase";
        const splitParentAmount = roundMoney(Math.abs(Number(base.splitParentAmount) || Number(base.amount) || 0));
        const splitGroupId = String(base.splitGroupId || base.id || "").trim() || makeTxnId("sg", new Set());
        const splitParentId = String(base.splitParentId || base.id || splitGroupId).trim();
        const splits = splitTxns.map(t => ({
          ...base,
          splitGroupId,
          splitParentId,
          splitParentDesc,
          splitParentAmount,
          ...t,
          subcat: normalizeTxnSubcategory(t.subcat),
          id: makeTxnId("cc", usedIds),
          note: (t.note||"")+" [split]",
        }));
        return [...prev.slice(0, idx), ...splits, ...prev.slice(idx + 1)];
      });
    }
  }, []);

  // Reassign every transaction in oldCat to newCat across both accounts
  const retargetCat = useCallback((oldCat, newCat) => {
    setCheckTxns(prev => prev.map(t => t.cat === oldCat ? {
      ...t,
      cat: newCat,
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, newCat, t.subcat),
    } : t));
    setCCTxns(prev => prev.map(t => t.cat === oldCat ? {
      ...t,
      cat: newCat,
      subcat: coerceTxnSubcategoryForCategory(subcatsByCat, newCat, t.subcat),
    } : t));
  }, [subcatsByCat]);

  const addTxns = useCallback((src, newTxns) => {
    if (src === "checking") {
      setCheckTxns(prev => {
        const usedIds = new Set(prev.map(t => t.id).filter(Boolean));
        return [...prev, ...newTxns.map(t => ({ ...t, subcat: normalizeTxnSubcategory(t.subcat), month: deriveTxnMonth(t), year: deriveTxnYear(t, selectedYear), excludeFromTags: !!t.excludeFromTags, id: makeTxnId("c", usedIds) }))];
      });
    } else {
      setCCTxns(prev => {
        const usedIds = new Set(prev.map(t => t.id).filter(Boolean));
        return [...prev, ...newTxns.map(t => ({ ...t, subcat: normalizeTxnSubcategory(t.subcat), month: deriveTxnMonth(t), year: deriveTxnYear(t, selectedYear), excludeFromTags: !!t.excludeFromTags, id: makeTxnId("cc", usedIds) }))];
      });
    }
  }, [selectedYear]);

  // ── Derived summary rows — norm auto-computed from actual − one-times + missing recurrings ──────
  const summaryRows = useMemo(() => {
    const baseRows = SUMMARY_ROWS
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
        const recurringPlanned = recurringPlanDeltaForCategory({
          cat: base.cat,
          selectedMonth,
          selectedYear,
          recurringItems,
          checkTxns,
          ccTxns,
        });
        const norm = checking + cc - oneTimeAmt + recurringPlanned;
        const defaultKc = base.cat === "Giving & Tithe"
          ? (takeHome > 0 ? Math.round(takeHome * 0.10) : base.kc)
          : base.kc;
        const kc = budgetKc[base.cat] !== undefined ? budgetKc[base.cat] : defaultKc;
        return { ...base, checking, cc, norm, kc, oneTime: oneTimeAmt, recurringPlanned };
      });
    const customRows = customCats.map(c => {
      const checking = checkTxns
        .filter(t => t.month === selectedMonth && t.cat === c.name && t.cat !== "Transfer" && t.cat !== "Income")
        .reduce((s, t) => s + t.amount, 0);
      const cc = ccTxns
        .filter(t => t.month === selectedMonth && t.cat === c.name)
        .reduce((s, t) => s + t.amount, 0);
      const oneTimeAmt = oneTimes.filter(o => o.cat === c.name).reduce((s, o) => s + o.amount, 0);
      const recurringPlanned = recurringPlanDeltaForCategory({
        cat: c.name,
        selectedMonth,
        selectedYear,
        recurringItems,
        checkTxns,
        ccTxns,
      });
      const norm = checking + cc - oneTimeAmt + recurringPlanned;
      const kc = budgetKc[c.name] !== undefined ? budgetKc[c.name] : null;
      return { cat: c.name, icon: c.icon, color: c.color, checking, cc, norm, kc, oneTime: oneTimeAmt, recurringPlanned, notes: "" };
    });
    return [...baseRows, ...customRows];
  }, [checkTxns, ccTxns, selectedMonth, selectedYear, oneTimes, recurringItems, budgetKc, showTithe, showABA, customCats, takeHome]);

  const janActual   = summaryRows.reduce((s, r) => s + r.checking + r.cc, 0);
  const normTotal   = summaryRows.reduce((s, r) => s + r.norm, 0);
  const normSurplus = takeHome - normTotal;
  const monthSnapshot = useMemo(() => buildMonthBudgetSnapshot({
    month: selectedMonth,
    year: selectedYear,
    checkTxns,
    ccTxns,
    recurringItems,
  }), [selectedMonth, selectedYear, checkTxns, ccTxns, recurringItems]);
  const incomeReceivedSoFar = monthSnapshot.incomeReceived;
  const spentSoFar = monthSnapshot.spend;
  const incomeStillExpected = Math.max(0, takeHome - incomeReceivedSoFar);
  const incomeAboveTarget = Math.max(0, incomeReceivedSoFar - takeHome);
  const planBadgeColor = normSurplus < 0 ? "#ef4444" : "#22c55e";
  const planStatusLabel = normSurplus >= 0 ? "Monthly Plan: On Track" : "Monthly Plan: Needs Attention";
  const planBadgeTitle = normSurplus < 0 ? "Planned Month Shortfall" : "Planned Month Cushion";
  const planBadgeValue = `${normSurplus < 0 ? "−" : "+"}${fmt(Math.abs(normSurplus))}`;
  const incomeProgressText = incomeStillExpected > 0
    ? `Income still expected: ${fmt(incomeStillExpected)}`
    : incomeAboveTarget > 0
      ? `Income above target: +${fmt(incomeAboveTarget)}`
      : "Income target received";
  const incomeProgressRow = incomeStillExpected > 0
    ? { label: "Still expected", value: fmt(incomeStillExpected), color: "#f59e0b" }
    : incomeAboveTarget > 0
      ? { label: "Above target", value: `+${fmt(incomeAboveTarget)}`, color: "#22c55e" }
      : { label: "Income target hit", value: fmt(0), color: "#22c55e" };

  const budget = {
    summaryRows, checkTxns, ccTxns, janActual, normTotal, normSurplus,
    updateTxnCat, updateTxn, deleteTxn, toggleTxnTagging, clearTxns, addTxns, replaceTxn,
    selectedMonth, setSelectedMonth, availableMonths,
    selectedYear, setSelectedYear, availableYears,
    payoffs, setPayoffs,
    waterfallDisabled, setWaterfallDisabled,
    takeHome, setTakeHome,
    oneTimes, setOneTimes,
    recurringItems, setRecurringItems,
    budgetKc, setBudgetKc,
    t2CarryIn, setT2CarryIn,
    groceryGoal, setGroceryGoal,
    familySize, setFamilySize,
    dashName, setDashName,
    showTithe, setShowTithe,
    showABA,   setShowABA,
    readabilityMode, setReadabilityMode,
    uiScale, setUiScale,
    hideZeroSummaryCats, setHideZeroSummaryCats,
    mobileTxnActionMenu, setMobileTxnActionMenu,
    customCats, setCustomCats, allCats, catColorsAll,
    subcatsByCat, setSubcatsByCat,
    abaSettings, setAbaSettings,
    titheSettings, setTitheSettings,
    retargetCat,
  };

  const activePageId = page === "tithe" || page === "aba"
    ? "scenarios"
    : page === "income"
      ? "categories"
      : page;
  const effectiveScenariosTab = page === "tithe"
    ? "tithe"
    : page === "aba"
      ? "aba"
      : scenariosTab;
  const effectiveCategoriesTab = page === "income" ? "income" : categoriesTab;

  const pages = {
    summary:   <Summary        {...props}/>,
    recs:      <Recommendations {...props}/>,
    scenarios: <Scenarios      {...props} activeTab={effectiveScenariosTab} setActiveTab={setScenariosTab}/>,
    payoffs:   <Payoffs        {...props}/>,
    categories: <Categories    {...props} activeTab={effectiveCategoriesTab} setActiveTab={setCategoriesTab}/>,
    trends:    <Trends          {...props}/>,
    meals:     <MealPlanningPage {...props}/>,
    transactions:  <TransactionsPage {...props}/>,
    settings:  <Settings isMobile={isMobile}/>,
  };

  const visibleNav = NAV;
  const auditStart    = visibleNav.findIndex(n => n.id === "transactions");
  const dashboardNav  = visibleNav.slice(0, auditStart);
  const auditNav      = visibleNav.slice(auditStart);
  const mobileRow1Len = Math.ceil(visibleNav.length / 2);
  const mobileRow1    = visibleNav.slice(0, mobileRow1Len);
  const mobileRow2    = visibleNav.slice(mobileRow1Len);

  const gapBadge = (
    <div style={{background:planBadgeColor+"22",border:`1px solid ${planBadgeColor}44`,borderRadius:12,padding:"8px 14px",textAlign:"center",flexShrink:0}}>
      <div style={{fontSize:10,color:planBadgeColor,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px"}}>{planBadgeTitle}</div>
      <div style={{fontSize:20,fontWeight:900,color:planBadgeColor,fontVariantNumeric:"tabular-nums"}}>{planBadgeValue}</div>
    </div>
  );

  const effectiveScale = !isMobile && readabilityMode ? uiScale : 1;
  const scaleStyle = effectiveScale === 1
    ? {}
    : {
        transform: `scale(${effectiveScale})`,
        transformOrigin: "top left",
        width: `calc(100% / ${effectiveScale})`,
        minHeight: `calc(100vh / ${effectiveScale})`,
      };

  return (
    <BudgetCtx.Provider value={budget}>
    <div style={{
      background:BG,
      minHeight:"100vh",
      fontFamily:"'DM Sans',system-ui,sans-serif",
      color:TEXT,
      width:"100%",
      display:"flex",
      flexDirection:"column",
      ...scaleStyle,
    }}>
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
                <div style={{fontSize:11,color:MUTED,marginTop:2}}>{selectedMonth} {selectedYear} · {visibleNav.find(n=>n.id===activePageId)?.label}</div>
              </div>
              {/* Compact gap badge */}
              <div style={{background:planBadgeColor+"22",border:`1px solid ${planBadgeColor}44`,borderRadius:10,padding:"5px 10px",textAlign:"center",flexShrink:0}}>
                <div style={{fontSize:8,color:planBadgeColor,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",lineHeight:1}}>{normSurplus < 0 ? "PLAN SHORTFALL" : "PLAN CUSHION"}</div>
                <div style={{fontSize:16,fontWeight:900,color:planBadgeColor,fontVariantNumeric:"tabular-nums",lineHeight:1.2}}>{planBadgeValue}</div>
                <div style={{fontSize:9,color:incomeStillExpected > 0 ? "#f59e0b" : MUTED,fontWeight:700,lineHeight:1.1}}>
                  {incomeStillExpected > 0 ? `Pending ${fmt(incomeStillExpected)}` : "Target received"}
                </div>
              </div>
            </div>
            {/* Row 2: year selector */}
            <div style={{display:"flex",gap:5,overflowX:"auto",paddingLeft:14,paddingRight:14,paddingBottom:6}}>
              <div style={{fontSize:9,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",flexShrink:0,alignSelf:"center",marginRight:2}}>Year</div>
              {availableYears.map(y=>(
                <button key={y} onClick={()=>setSelectedYear(y)} style={{
                  padding:"4px 10px",borderRadius:7,fontSize:11,fontWeight:700,flexShrink:0,
                  background:selectedYear===y?ACCENT+"22":SURFACE,
                  color:selectedYear===y?ACCENT:MUTED,
                  border:`1px solid ${selectedYear===y?ACCENT:BORDER}`,cursor:"pointer",
                }}>{y}</button>
              ))}
            </div>
            {/* Row 3: month picker */}
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
          <div style={{padding:"16px 14px 120px",flex:1}}>
            {pages[activePageId]}
            <div style={{marginTop:18,textAlign:"center"}}>
              <a href={REPO_URL} target="_blank" rel="noreferrer" style={{fontSize:11,color:DIM,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6}}>
                <span aria-hidden="true">🐙</span>
                <span>Open on GitHub Repo</span>
              </a>
            </div>
          </div>
          <div style={{position:"fixed",bottom:0,left:0,right:0,background:SURFACE+"f8",backdropFilter:"blur(24px)",borderTop:`1px solid ${BORDER}`,zIndex:100,paddingBottom:"max(env(safe-area-inset-bottom,0px),8px)"}}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobileRow1.length},1fr)`, borderBottom: `1px solid ${BORDER}` }}>
            {mobileRow1.map(n => { const a = activePageId===n.id; return (
              <button key={n.id} onClick={() => setPage(n.id)} style={{ padding:"9px 4px 7px", background:"transparent", display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                <span style={{ fontSize:16, opacity:a?1:.35 }}>{n.emoji}</span>
                <span style={{ fontSize:8, fontWeight:a?800:500, color:a?ACCENT:MUTED }}>{n.label}</span>
                {a && <div style={{ width:16, height:2, background:ACCENT, borderRadius:99 }}/>}
              </button>
            ); })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${mobileRow2.length},1fr)` }}>
            {mobileRow2.map(n => { const a = activePageId===n.id; return (
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
        <div style={{display:"flex",width:"100%",height:"100vh",overflow:"hidden"}}>
          <div style={{width:240,background:"#0f141e",borderRight:`1px solid ${BORDER}`,display:"flex",flexDirection:"column",flexShrink:0,overflowY:"auto"}}>
            <div style={{padding:"24px 20px 16px",borderBottom:`1px solid ${BORDER}`}}>
              <div style={{fontSize:20,fontWeight:900,color:ACCENT}}>{dashName}</div>
              <div style={{fontSize:12,color:MUTED,marginTop:3,marginBottom:12}}>{selectedYear}</div>
              <div style={{fontSize:10,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Viewing Year</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10}}>
                {availableYears.map(y=>(
                  <button key={y} onClick={()=>setSelectedYear(y)} style={{
                    padding:"3px 8px",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer",
                    background:selectedYear===y?ACCENT+"22":BG,
                    color:selectedYear===y?ACCENT:MUTED,
                    border:`1px solid ${selectedYear===y?ACCENT:BORDER}`,transition:"all .12s",
                  }}>{y}</button>
                ))}
              </div>
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
            <nav style={{padding:"12px 0"}}>
              <div style={{padding:"16px 20px 6px",fontSize:10,fontWeight:700,color:DIM,textTransform:"uppercase",letterSpacing:".6px"}}>Dashboard</div>
              {dashboardNav.map(n=>{const a=activePageId===n.id;return(
                <button key={n.id} onClick={()=>setPage(n.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 20px",background:a?ACCENT+"12":"transparent",borderLeft:`3px solid ${a?ACCENT:"transparent"}`,color:a?ACCENT:MUTED,fontSize:14,fontWeight:a?700:400,transition:"all .15s",textAlign:"left"}}>
                  <span style={{fontSize:17}}>{n.emoji}</span>{n.label}
                </button>
              );})}
              <div style={{padding:"16px 20px 6px",fontSize:10,fontWeight:700,color:DIM,textTransform:"uppercase",letterSpacing:".6px"}}>Manage</div>
              {auditNav.map(n=>{const a=activePageId===n.id;return(
                <button key={n.id} onClick={()=>setPage(n.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 20px",background:a?ACCENT+"12":"transparent",borderLeft:`3px solid ${a?ACCENT:"transparent"}`,color:a?ACCENT:MUTED,fontSize:14,fontWeight:a?700:400,transition:"all .15s",textAlign:"left"}}>
                  <span style={{fontSize:17}}>{n.emoji}</span>{n.label}
                </button>
              );})}
            </nav>
            <div style={{padding:"16px 20px",borderTop:`1px solid ${BORDER}`}}>
              <div style={{fontSize:11,color:DIM,fontWeight:700,textTransform:"uppercase",letterSpacing:".6px",marginBottom:10}}>Quick Stats · {selectedMonth}</div>
              {[
                ["Take-home target", fmt(takeHome), ACCENT],
                ["Income received", fmt(incomeReceivedSoFar), incomeReceivedSoFar > 0 ? "#22c55e" : MUTED],
                [incomeProgressRow.label, incomeProgressRow.value, incomeProgressRow.color],
                ["Spent so far", fmt(spentSoFar), "#06b6d4"],
                [normSurplus < 0 ? "Plan shortfall" : "Plan cushion", planBadgeValue, planBadgeColor],
              ].map(([k,v,c])=>(
                <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <span style={{fontSize:12,color:MUTED}}>{k}</span>
                  <span style={{fontSize:12,fontWeight:800,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
                </div>
              ))}
              <div style={{fontSize:10,color:DIM,lineHeight:1.5,marginTop:10}}>
                Planned shortfall uses your normalized monthly plan, not whether this month's paycheck has arrived yet.
              </div>
              <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${BORDER}`}}>
                <a href={REPO_URL} target="_blank" rel="noreferrer" style={{fontSize:11,color:DIM,textDecoration:"none",display:"inline-flex",alignItems:"center",gap:6}}>
                  <span aria-hidden="true">🐙</span>
                  <span>Open on GitHub Repo</span>
                </a>
                <div style={{fontSize:10,color:DIM,marginTop:6}}>v{APP_VERSION}</div>
              </div>
            </div>
          </div>
          <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",height:"100vh",overflowY:"auto"}}>
            <div style={{borderBottom:`1px solid ${BORDER}`,padding:"16px 32px",display:"flex",alignItems:"center",justifyContent:"space-between",background:BG+"cc",backdropFilter:"blur(12px)",position:"sticky",top:0,zIndex:10}}>
              <div>
                  <div style={{fontSize:22,fontWeight:800,color:TEXT}}>
                  {visibleNav.find(n=>n.id===activePageId)?.label}
                </div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                  <Tag color={normSurplus>=0 ? "#22c55e" : "#f59e0b"}>
                    {planStatusLabel}
                  </Tag>
                  <Tag color={ACCENT}>Take-home target: {fmt(takeHome)}</Tag>
                  <Tag color={incomeReceivedSoFar > 0 ? "#22c55e" : "#f59e0b"}>Income received: {fmt(incomeReceivedSoFar)}</Tag>
                  {incomeStillExpected > 0
                    ? <Tag color="#f59e0b">Still expected: {fmt(incomeStillExpected)}</Tag>
                    : <Tag color="#22c55e">Income target received</Tag>}
                  <Tag color="#06b6d4">Spent so far: {fmt(spentSoFar)}</Tag>
                </div>
              </div>
              {gapBadge}
            </div>
            <div style={{padding:"28px 32px"}}>{pages[activePageId]}</div>
          </div>
        </div>
      )}
    </div>
    </BudgetCtx.Provider>
  );
}
