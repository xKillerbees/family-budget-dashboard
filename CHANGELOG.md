# Changelog

All notable changes to this project are documented in this file.

## [0.1.13] - 2026-03-08

### Added
- Optional AI CSV extraction fallback after local CSV parsing fails, using the same review workflow as other imports.

### Changed
- Local CSV parse failures now explain why local detection failed before offering the AI fallback path.
- Import help text and README now document the local-first CSV fallback strategy, optional AI extraction, and duplicate-import review warnings.

## [0.1.12] - 2026-03-08

### Added
- Import review now flags possible duplicate transactions by matching date, amount, description, and year against the selected account plus repeated rows inside the current file.

### Changed
- Import review shows a duplicate-warning banner with one-click exclude/re-select actions, and final import now asks for confirmation if flagged duplicate rows are still selected.

## [0.1.11] - 2026-03-05

### Added
- Readability controls in Settings for desktop large-text mode and UI scale presets (`100%`, `110%`, `120%`, `130%`) with local persistence.
- Year selector buttons (mobile + desktop) above month selection, driven from years present in imported transactions.

### Changed
- Desktop layout now uses a fixed app-shell with internal content scrolling so the top header remains pinned while page content scrolls.
- Header content was simplified to remove duplicated dashboard/month text and keep primary page context + gap/status chips.
- Transactions source toggle (`Checking` / `Credit Card`) was restyled into a clearer segmented control with stronger active-state contrast.
- Import section copy was fully rewritten to clearly explain the real CSV/PDF + AI flow, including optional CSV AI categorization and optional PDF AI extraction fallback.

### Fixed
- Transactions white-screen regression caused by an invalid hook dependency reference in the transaction table delete handler.
- Transactions desktop table layout no longer collapses at larger readability scales.
- Summary category breakdown layout now adapts better at larger readability scales with fluid desktop column sizing and reduced overlap.
- Meal-plan link normalization now validates and repairs invalid recipe/price-proof links more safely.
- Grocery list rendering was upgraded to a structured table including explicit meal-usage mapping.

## [0.1.10] - 2026-03-05

### Fixed
- Meal-plan JSON parsing now preserves `https://` URLs when stripping comment-like text, preventing valid AI payloads from being corrupted before parse.
- Meal-plan parsing now only accepts top-level JSON objects (not arrays/fragments), avoiding false-positive parses that produced empty `meals`/`grocery_items` in UI.
- Meal-plan parser now unwraps common wrapper payloads (for example `raw_model_response`) so valid nested plans render correctly in Plan Summary, Weekly Meals, and Grocery List cards.

## [0.1.9] - 2026-03-05

### Changed
- Meal-plan grocery schema and prompt no longer require `image_url`, reducing format failures from over-constrained AI output.
- Grocery list rendering no longer depends on item image URLs.

### Fixed
- Meal-plan debug logging now preserves raw model output and repair-pass outputs in saved responses.
- Latest saved raw AI response is now always visible in a copyable debug text area.
- Settings footer version badge now correctly displays `v0.1.9` to match the package/build version.
- Meal-plan normalization now stamps `generated_at` at save time, avoiding stale model-provided dates in UI tags/history.
- Meal-plan normalization now auto-corrects clearly inconsistent monthly estimates from AI output using the weekly estimate baseline (`weekly * 4.33`).
- Meal-plan JSON parsing now attempts structured recovery from truncated AI output by salvaging balanced `meals` and `grocery_items` arrays.
- Meal-plan generation/repair passes now use higher token budgets and surface truncation-specific errors more reliably.
- Income page now treats `Income` category values as inflow magnitude for monthly totals, source rollups, and trend bars, preventing backward/negative charting for credit-style imports.

## [0.1.8] - 2026-03-05

### Fixed
- Meal-plan parsing now handles additional malformed-output cases (smart quotes, fenced blocks, embedded JSON fragments, trailing commas, and comment artifacts).
- Meal-plan generation now detects truncated AI responses (`max_tokens`) and reports a specific truncation error.
- Meal-plan fallback now uses a two-pass JSON-repair strategy before surfacing format errors.

## [0.1.7] - 2026-03-05

### Fixed
- Meal-plan generation now auto-retries malformed AI output with a JSON-repair pass before failing.
- Saved AI response history now stores the repaired payload when fallback repair is used.

## [0.1.6] - 2026-03-05

### Fixed
- Meals AI generation now surfaces specific API failures instead of only showing a generic retry message.
- Meal-plan response parsing is more resilient to fenced JSON, extra text, and trailing commas.
- Improved fallback error messaging when AI returns empty or invalid JSON payloads.

## [0.1.5] - 2026-03-05

### Added
- Meals AI planner now supports ZIP code context for location-aware price estimates.
- Meals AI output contract now includes recipe links per meal slot plus grocery `image_url` and price-proof links.
- Meals header now shows quick context chips (ZIP, store count, recipe-link coverage, last generated date).
- Grocery list now supports one-click copy/export from generated AI items.

### Changed
- “Open on GitHub Pages” footer links now point to the GitHub repository and are relabeled as `Open on GitHub Repo`.
- Scenario waterfall x-axis labels are centered to bar columns for cleaner alignment.
- Payoffs mobile debt-card headers now wrap and compact action controls on narrow screens.

### Fixed
- Summary target delta text (`remains` / `over`) no longer wraps onto a second line.
- Mobile transaction Options menu no longer gets clipped; it opens above the trigger with higher z-index.
- Sankey text readability improved on mobile with larger, higher-contrast labels/values.
- Meals grocery list layout dead-space reduced by using a compact left-aligned item layout.

## [0.1.4] - 2026-03-05

### Added
- README now includes a direct link to the project changelog on GitHub.

### Fixed
- Tithe keyword matching now evaluates both transaction description and note text for:
  - 1st Tithe monthly/YTD calculations
  - 2nd Tithe monthly/YTD calculations
  - Current-month Tithe breakdown lists

## [0.1.3] - 2026-03-05

### Added
- Restored Live Demo link in README.

### Changed
- Scenario waterfall step-card surplus value now uses sign-based color only (green positive, red negative).
- Scenario waterfall x-axis labels improved for dense data (better contrast, truncation, angled layout).
- Summary breakdown target wording updated from `remaining` to `remains`.

### Fixed
- Transactions list and totals now consistently render cents (`$X.XX`).
- Transaction add-form messages now support manual dismiss and auto-clear on new actions.

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
