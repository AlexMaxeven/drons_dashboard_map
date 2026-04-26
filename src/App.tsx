import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';

import { FleetProvider } from './fleet/FleetContext';
import { DashboardPage } from './pages/DashboardPage';
import { MapPage } from './pages/MapPage';
import { ReportsPage } from './pages/ReportsPage';

export function App() {
  return (
    <FleetProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <div className="container-fluid px-0">
          <header className="sticky-top border-bottom" style={{ zIndex: 5000 }}>
            <div className="bg-dark">
              <div className="container-fluid px-3 py-2">
                <div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
                  <Link to="/" className="text-decoration-none text-white d-inline-flex align-items-center gap-2">
                    <span className="d-inline-flex align-items-center justify-content-center rounded-2 bg-primary-subtle text-primary-emphasis fw-semibold px-2 py-1">
                      MAP
                    </span>
                    <span className="fw-semibold">GeoFleet Control</span>
                    <span className="badge text-bg-secondary">Demo</span>
                  </Link>

                  <nav className="d-flex gap-2 flex-wrap">
                    <NavLink
                      to="/"
                      end
                      className={({ isActive }) =>
                        `btn btn-sm ${isActive ? 'btn-primary' : 'btn-outline-light'}`
                      }
                    >
                      Dashboard
                    </NavLink>
                    <NavLink
                      to="/map"
                      className={({ isActive }) =>
                        `btn btn-sm ${isActive ? 'btn-primary' : 'btn-outline-light'}`
                      }
                    >
                      Map
                    </NavLink>
                    <NavLink
                      to="/reports"
                      className={({ isActive }) =>
                        `btn btn-sm ${isActive ? 'btn-primary' : 'btn-outline-light'}`
                      }
                    >
                      Reports
                    </NavLink>
                  </nav>
                </div>
              </div>
            </div>
          </header>

          <main className="container-fluid px-3 py-3">
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="*" element={<div className="alert alert-warning">Not found</div>} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </FleetProvider>
  );
}

