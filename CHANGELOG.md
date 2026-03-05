# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-03-05

### Added
- Month-scoped AI tips storage and retrieval (`budget_ai_tips_by_month`).
- "Show last AI prompt" toggle in Tips for selected month prompt transparency.
- Payoff "Audit" panel listing keyword-matched transactions and counted totals.
- Per-bar value labels on Categories vendor chart, Payoffs relief chart, and Scenarios step-down chart.
- GitHub source link shown in app shell as credits.

### Changed
- Import and transaction month handling now normalizes month names and derives month from transaction date when possible.
- Viewing month auto-switches to first available month if current selection is not present.
- Payoff card header layout reorganized so balance/auto metadata sits below title/actions.
- Categories spotlight UI now shows selected vendor total and share of category total.
- Sankey excludes zero-value destinations and handles zero-income percentages safely.

### Fixed
- Category/transaction/payoff chart left-axis clipping and far-left spacing issues.
- Chart hover highlight background set to transparent where it obscured visuals.
- Desktop transaction action button overlap in transaction tables.
- Encoding-related icon/text corruption regressions in the dashboard source.
