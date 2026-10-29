import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard" },
  { to: "/monitor", label: "Plant Monitor" },
  { to: "/anomaly", label: "Anomaly Detection" },
  { to: "/database", label: "Database Explorer" },
  { to: "/aspen", label: "Aspen Integration" },
  { to: "/ems", label: "AI Energy Management" },
];

export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Main Navigation">
      <div className="sidebar-header">
        <span className="sidebar-brand-title">SOFC Plant</span>
        <span className="sidebar-brand-subtitle">100 kW Utility System</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) => `sidebar-link${isActive ? " active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div><strong>Status:</strong> Active</div>
        <div style={{ marginTop: 4, fontSize: 12 }}>Baseline Rev 1.0</div>
      </div>
    </aside>
  );
}
