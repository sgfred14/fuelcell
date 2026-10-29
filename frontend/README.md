# SOFC Utility Monitor - React Dashboard

The frontend application for the Solid Oxide Fuel Cell (SOFC) Plant Utility Monitor. Built with **React 18**, **TypeScript**, and **Vite**, featuring real-time WebSocket telemetry, thermodynamic charts via **Recharts**, interactive plant diagrams, Aspen Plus reconciliation, and an AI-driven Energy Management System (EMS).

---

## Key Features

- **Real-Time Telemetry Dashboard**: Live WebSocket streaming displaying plant balances, 19 utility sensor channels, and 16 physics-informed limit checks.
- **PINN & Autoencoder Anomaly Inspector**: Interactive latent space and residual deviation inspection identifying early process anomalies.
- **Database Explorer**: Direct query interface for telemetry history, fault injection logs, thermodynamic calculation records, and alert lifecycles backed by MongoDB.
- **Aspen Plus Digital Twin Reconciliation**: Comparative analysis of baseline thermodynamic predictions vs. Aspen Plus process models with tolerance tracking.
- **AI Energy Management System (EMS)**: 24-hour predictive load curves, TOU tariff scheduling, and degradation forecasting.
- **Interactive Fault Injection**: Operator controls to inject simulated faults (e.g. blower fade, H₂ restriction, stack temperature overshoot) and measure detector response latency.

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm (comes with Node)

### Installation
```bash
npm install
```

### Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Default configuration:
```env
# URL of the FastAPI backend service
BACKEND_URL=http://127.0.0.1:8000
```

### Development Server
Run Vite with Hot Module Replacement (HMR):
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173). The Vite proxy forwards `/api` and `/ws` requests to `BACKEND_URL`.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start development server on port 5173 with proxy |
| `npm run build` | Typecheck and build production bundle into `dist/` |
| `npm run preview` | Locally preview the production build |
| `npm test` | Run Vitest unit, component, and E2E scenario tests |
| `npm run typecheck` | Validate TypeScript contracts with `tsc --noEmit` |

---

## Architecture & Code Layout

```
src/
├── components/          # Reusable UI components
│   ├── aspen/           # Aspen reconciliation cards & tolerance tables
│   ├── db/              # Database explorer & reconnect modal
│   ├── ems/             # AI EMS cards, load curves & advisory alerts
│   └── ...              # Layouts, metrics, and navigation
├── pages/               # Top-level view routes
│   ├── DashboardPage.tsx
│   ├── AnomalyPage.tsx
│   ├── DatabasePage.tsx
│   ├── AspenPage.tsx
│   ├── EmsPage.tsx
│   └── SettingsPage.tsx
├── lib/                 # Formatting, calculations & client utilities
├── test/                # Mock APIs, test harnesses & contracts
├── types.ts             # TypeScript interfaces for telemetry & backend contracts
├── api.ts               # Typed REST API client
└── App.tsx              # Application root and route configuration
```
