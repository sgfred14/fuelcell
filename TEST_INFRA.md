# E2E Test Infra: SOFC Production Frontend

## Test Philosophy
- Opaque-box, requirement-driven. Derived from `ORIGINAL_REQUEST.md` and user-facing specifications.
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise Combinatorial + Real-World Workload Testing.
- Progressive testability: Tests verify functional components at lowest necessary coupling.

## Feature Inventory
| # | Feature | Source (Requirement) | Tier 1 (Unit/Comp) | Tier 2 (Feature/State) | Tier 3 (Routing/Flows) | Tier 4 (System/Build) |
|---|---------|----------------------|:------------------:|:----------------------:|:----------------------:|:---------------------:|
| 1 | Database Connection Status & Metrics | R1 | 5 | 5 | ✓ | ✓ |
| 2 | Tabbed Collection Browser & Tables | R1 | 5 | 5 | ✓ | ✓ |
| 3 | Formatted JSON Document Inspector | R1 | 5 | 5 | ✓ | ✓ |
| 4 | Database Flush & Reconnect Actions | R1 | 5 | 5 | ✓ | ✓ |
| 5 | Aspen COM / Digital Twin Status | R2 | 5 | 5 | ✓ | ✓ |
| 6 | Process Values Pull & Baseline Table | R2 | 5 | 5 | ✓ | ✓ |
| 7 | Side-by-Side Model Reconciliation | R2 | 5 | 5 | ✓ | ✓ |
| 8 | Aspen Diagnostic Suggestions & Optimization | R2 | 5 | 5 | ✓ | ✓ |
| 9 | 24h Predictive Forecast Charts | R3 | 5 | 5 | ✓ | ✓ |
| 10 | TOU Tariff & Economic Cost Charts | R3 | 5 | 5 | ✓ | ✓ |
| 11 | Stack Degradation Horizon & RUL Badge | R3 | 5 | 5 | ✓ | ✓ |
| 12 | Dispatch Table & Advisory Alerts | R3 | 5 | 5 | ✓ | ✓ |
| 13 | Interactive Optimization Controls | R3 | 5 | 5 | ✓ | ✓ |
| 14 | Sidebar Navigation & Routing | R4 | 5 | 5 | ✓ | ✓ |
| 15 | TypeScript Types & Clean Build | R4 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- Test Runner: Vitest (`vitest run`) in `frontend/`
- Testing Library: `@testing-library/react`, `@testing-library/jest-dom`
- TypeScript Typecheck: `tsc --noEmit`
- Production Build Validation: `npm run build` (`tsc --noEmit && vite build`)
- Directory layout for tests: `frontend/src/test/` and `frontend/src/__tests__/`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Operator inspects live telemetry, detects warning, switches to Database Explorer to view raw JSON tick | F1, F2, F3, F14 | Medium |
| 2 | Plant engineer triggers Aspen verification, views baseline tolerance deviations, and runs optimization | F5, F6, F7, F8, F14 | High |
| 3 | Energy manager analyzes 24h TOU tariff peaks, evaluates SOFC dispatch savings, and inspects degradation curve | F9, F10, F11, F12, F13, F14 | High |
| 4 | Full application end-to-end routing walk across all 6 views with simulated backend offline & recovery | All 15 features | High |
| 5 | Production bundle compilation, tree-shaking, and type verification pass | All features | High |

## Coverage Thresholds
- Tier 1: >=5 per feature area (Unit and component render tests)
- Tier 2: >=5 per feature area (Boundary, state transitions, filters, empty/error handling)
- Tier 3: Pairwise interaction and cross-feature routing navigation
- Tier 4: Real-world workflows and production build verification
- **Total test count: >= 35 existing tests + comprehensive coverage for new features**
