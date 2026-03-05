# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026-03-05

### Added
- Transaction add-form validation feedback with required-field messaging and success confirmation.
- Family Size setting in Settings (persisted) and included in AI tips prompt context.
- Month-over-month comparison context in AI tips prompt (prior income/spend/gap summary).
- Transactions add-form feedback supports manual dismiss.

### Changed
- Transactions add form now derives month from selected date (removed redundant month selector).
- Currency display now defaults to cents app-wide (`$X.XX`) for consistency across pages.
- Dashboard credits link now targets GitHub Pages live app URL.
- Meal plan AI prompt now explicitly optimizes against monthly target with tighter cost constraints.

### Fixed
- Encoding/mojibake regressions that broke icons and symbols across summary/settings/navigation.
- Transactions page white-screen regression caused by hook ordering in add-form feedback state.
- Transaction delete flow now consistently prompts via in-app confirmation modal.
- Transactions feedback message now auto-clears on new filter/form actions.

## [0.1.1] - 2026-03-05

### Added
- Settings toggle to hide `$0` categories in the Summary breakdown table/cards.

### Changed
- Summary target delta wording now shows `over` instead of `over target`.
- Categories vendor chart and vendor list support multi-select with aggregated selected totals.
- Desktop layout now uses page scrolling (no internal sidebar scroll container).

### Fixed
- Tithe tracker now reacts correctly to updated keyword settings for both 1st and 2nd tithe calculations.
- 2nd Tithe keyword matching now evaluates both checking and credit-card tithe transactions consistently.
- Tithe month breakdown totals now show current-month matched totals (not YTD in the month footer).

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
