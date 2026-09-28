import { useEffect, useState } from 'react';
import { api, onUnauthenticated } from './api';
import { BrandMark } from './components';
import { Login } from './pages/Login';
import { OrderDetailPage } from './pages/OrderDetail';
import { OrdersPage } from './pages/Orders';
import { ProductsPage } from './pages/Products';
import { SettingsPage } from './pages/Settings';
import { SimulatorPage } from './pages/Simulator';
import { useRoute } from './router';
import type { Admin, OrderSummary } from './types';

export function App() {
  const [admin, setAdmin] = useState<Admin | null | undefined>(undefined);
  const [simulator, setSimulator] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setAdmin(r.admin);
        setSimulator(r.simulator);
      })
      .catch(() => setAdmin(null));
    return onUnauthenticated(() => setAdmin(null));
  }, []);

  if (admin === undefined) return <div className="boot">Loading…</div>;
  if (!admin) {
    const signedIn = async (a: Admin) => {
      // The simulator flag comes from /auth/me; if that check fails, sign in anyway without it.
      const me = await api.me().catch(() => null);
      setSimulator(me?.simulator ?? false);
      setAdmin(a);
    };
    return <Login onLogin={signedIn} />;
  }
  return <Shell admin={admin} simulator={simulator} onSignedOut={() => setAdmin(null)} />;
}

function Shell({ admin, simulator, onSignedOut }: { admin: Admin; simulator: boolean; onSignedOut: () => void }) {
  const route = useRoute();
  const [summary, setSummary] = useState<OrderSummary | null>(null);

  // Keep the "needs review" badge fresh so new WhatsApp orders are noticed.
  useEffect(() => {
    const load = () => api.summary().then(setSummary).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [route]);

  const needsReview = (summary?.counts.NEW ?? 0) + (summary?.counts.PENDING_REVIEW ?? 0);

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Queziva</div>
            <div className="brand-sub">Orders</div>
          </div>
        </div>
        <a className={`nav-link ${route.page === 'orders' || route.page === 'order' ? 'active' : ''}`} href="#/orders">
          Orders {needsReview > 0 && <span className="nav-count" title="Waiting for review">{needsReview}</span>}
        </a>
        <a className={`nav-link ${route.page === 'products' ? 'active' : ''}`} href="#/products">
          Products &amp; stock
        </a>
        <a className={`nav-link ${route.page === 'settings' ? 'active' : ''}`} href="#/settings">
          Settings
        </a>
        {simulator && (
          <a className={`nav-link ${route.page === 'simulator' ? 'active' : ''}`} href="#/simulator">
            Customer simulator <span className="tag">Test</span>
          </a>
        )}
        <div className="sidebar-foot">
          <div className="who">{admin.name}</div>
          <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
            {admin.email}
          </div>
          <button className="btn-link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {route.page === 'orders' && <OrdersPage summary={summary} />}
        {route.page === 'order' && <OrderDetailPage key={route.id} id={route.id} />}
        {route.page === 'products' && <ProductsPage />}
        {route.page === 'settings' && <SettingsPage />}
        {route.page === 'simulator' && simulator && <SimulatorPage />}
      </main>
    </div>
  );
}
