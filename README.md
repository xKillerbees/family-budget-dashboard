# Family Budget Dashboard

A personal finance dashboard built with React and Recharts. Track monthly spending across checking and credit card accounts, visualize budget vs. actual by category, import bank statements via PDF (Claude AI), and get AI-powered budget tips.

**All data lives in your browser's localStorage — nothing is ever sent to a server or stored in this repo.**

---

## Live Demo

> [https://roberthsherman.github.io/family-budget-dashboard](https://roberthsherman.github.io/family-budget-dashboard)

*(May take a moment to load on first visit after a new deployment.)*

---

## Features

- Month-by-month budget vs. actual by spending category
- Separate tracking for checking and credit card transactions
- Normalized spending view (strips one-time large expenses)
- Debt payoff tracker with projected payoff dates
- PDF bank statement import with AI auto-categorization (Claude API)
- Manual transaction entry
- AI budget tips tab (Claude API)
- All settings and data persisted to localStorage

---

## Quick Start (No Install)

Just visit the live demo link above. No account, no install, no data leaves your browser.

---

## Local Development

```bash
git clone https://github.com/roberthsherman/family-budget-dashboard.git
cd family-budget-dashboard
npm install
npm run dev
```

App opens at `http://localhost:5173/family-budget-dashboard/`

To build for production:

```bash
npm run build
```

Output goes to `dist/`.

---

## API Key Setup (Optional)

The dashboard can import PDF bank statements and generate budget tips using the Claude AI API.

1. Get a free API key at [console.anthropic.com](https://console.anthropic.com) → API Keys
2. Open the dashboard → **Settings** tab
3. Paste your key and click Save

The key is stored only in your browser's localStorage. It is never committed to the repo.

---

## Adding Transactions

### Option A — Import PDF Statement
1. Go to the **Import** tab
2. Upload a PDF bank statement (checking or credit card)
3. Claude reads the statement and auto-categorizes each transaction
4. Review, edit, and confirm

### Option B — Manual Entry
1. Go to the **Transactions** tab
2. Click **Add Transaction**
3. Fill in date, description, amount, category, and month

---

## Customization

Open `src/budget-dashboard-clean.jsx` and edit these constants near the top of the file:

### Budget targets per category
```js
const SUMMARY_ROWS = [
  { cat:"Housing", kc:2500, ... },  // kc = your budget target
  ...
]
```

### Debt payoff tracker
```js
const PAYOFFS_INIT = [
  { name:"Car Loan", balance:12000, rate:6.9, minPay:285 },
  ...
]
```

### One-time large expenses (excluded from normalized view)
```js
const ONE_TIMES = [
  { name:"Plumbing Repair", amount:165.00, cat:"Housing" },
]
```

---

## Deploying Your Own Copy

1. Fork this repo
2. Go to your fork's **Settings → Pages → Source → GitHub Actions**
3. Push any change to `main` — the workflow builds and deploys automatically
4. Your dashboard will be live at `https://<your-username>.github.io/family-budget-dashboard`

---

## Tech Stack

- [React 18](https://react.dev)
- [Recharts](https://recharts.org)
- [Vite](https://vitejs.dev)
- [Claude API](https://anthropic.com) (optional, for PDF import and AI tips)
- GitHub Actions + GitHub Pages (CI/CD)

---

## Privacy

This app is entirely client-side. No backend, no analytics, no cookies. Your financial data never leaves your browser.
