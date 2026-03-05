# Family Budget Dashboard

React + Vite budget dashboard for tracking spending, payoffs, scenarios, and monthly trends.

## Live Demo

- [https://xkillerbees.github.io/family-budget-dashboard/](https://xkillerbees.github.io/family-budget-dashboard/)

## Privacy

- All transactions, settings, and API keys are stored in browser `localStorage`.
- CSV/PDF import runs local-first.
- AI is optional and only used after explicit user action.

## Core Features

- Summary dashboard with category totals, targets, progress bars, Sankey flow, and breakdown charts.
- Checking and Credit Card transaction pages:
  - Add, edit, split, and delete transactions
  - Month/category/search filters
- Month-aware data model:
  - Transaction month can be derived from transaction date (`MM/DD`)
  - Viewing month auto-adjusts to available imported months
- Payoffs:
  - Debt cards with projected payoff timing
  - Keyword-based payment matching
  - Audit panel to review matched transactions used for payoff progress
- Scenarios:
  - Reorderable waterfall/impact steps
  - Dynamic surplus step-down visualization
- Categories:
  - Vendor/store breakdown, spotlight mode, and spotlight totals
- Trends:
  - Multi-month trend charts when 2+ months exist
  - Example preview charts when only one month exists
- Import:
  - Local CSV/PDF parsing and review workflow
  - Optional AI fallback parsing when local parse is insufficient

## AI Features

AI is used in two places:

1. Import fallback parsing (optional)
2. Tips/recommendations refresh (optional)

Tips are saved per month, and the UI can display the last AI prompt used for the selected month.

## Repository

- GitHub: https://github.com/xKillerbees/family-budget-dashboard
- Changelog: https://github.com/xKillerbees/family-budget-dashboard/blob/main/CHANGELOG.md

## Local Development

```bash
git clone https://github.com/xKillerbees/family-budget-dashboard.git
cd family-budget-dashboard
npm install
npm run dev
```

## Build

```bash
npm run build
```

Build output is generated in `dist/`.
