# Family Budget Dashboard

React + Vite budget dashboard for tracking spending, payoffs, scenarios, and monthly trends.

## Live Demo

- [https://xkillerbees.github.io/family-budget-dashboard/](https://xkillerbees.github.io/family-budget-dashboard/)

## Privacy

- All transactions, settings, and API keys are stored in browser `localStorage`.
- CSV/PDF import runs local-first with multiple CSV fallback strategies before any AI path is offered.
- AI is optional and only used after explicit user action for import extraction, import categorization, or tips.

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
  - CSV parsing tries header scan, bank/statement-export fallback, and headerless column inference
  - Duplicate transaction warnings before import confirmation
  - Optional AI extraction fallback for CSV/PDF only when local parsing is insufficient
  - Optional AI categorization in Review for unmatched merchants

## AI Features

AI is used in two places:

1. Import extraction/categorization (optional)
2. Tips/recommendations refresh (optional)

Import extraction stays local-first. If local parsing cannot confidently detect transactions, the app explains the failure reason and lets you optionally send the raw CSV or PDF contents to AI for extraction.

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
