import { createContext, useContext } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import AnomalyPage from "./pages/AnomalyPage";
import AspenPage from "./pages/AspenPage";
import DashboardPage from "./pages/DashboardPage";
import DatabasePage from "./pages/DatabasePage";
import EmsPage from "./pages/EmsPage";
import MonitorPage from "./pages/MonitorPage";
import { useMonitor } from "./useMonitor";

export type MonitorContextType = ReturnType<typeof useMonitor>;

export const MonitorContext = createContext<MonitorContextType | null>(null);

export function useMonitorContext(): MonitorContextType {
  const ctx = useContext(MonitorContext);
  if (!ctx) {
    throw new Error("useMonitorContext must be used within MonitorContext.Provider");
  }
  return ctx;
}

export function AppContent() {
  return (
    <div className="app-container">
      <Sidebar />
      <div className="main-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/monitor" element={<MonitorPage />} />
          <Route path="/anomaly" element={<AnomalyPage />} />
          <Route path="/database" element={<DatabasePage />} />
          <Route path="/aspen" element={<AspenPage />} />
          <Route path="/ems" element={<EmsPage />} />
        </Routes>
      </div>
    </div>
  );
}

export default function App() {
  const monitor = useMonitor();

  return (
    <MonitorContext.Provider value={monitor}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </MonitorContext.Provider>
  );
}
