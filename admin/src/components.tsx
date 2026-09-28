import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { inr, STATUS_LABELS, STATUS_TONE } from './format';
import type { OrderStatus, Product } from './types';

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3 27 13 16 29 5 13Z" fill="var(--brand)" />
      <path d="M5 13h22M16 3l-4.5 10L16 29l4.5-16L16 3" fill="none" stroke="var(--surface)" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge tone-${STATUS_TONE[status]}`}>{STATUS_LABELS[status]}</span>;
}

// ── Toasts ─────────────────────────────────────────────────
type Toast = { id: number; message: string; tone: 'info' | 'error' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ── Dialog ─────────────────────────────────────────────────
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ── Product picker ─────────────────────────────────────────
export function ProductPicker({
  onPick,
  exclude = [],
  placeholder = 'Search products by name or SKU…',
  autoFocus,
}: {
  onPick: (p: Product) => void;
  exclude?: (string | null)[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.products().then((r) => setProducts(r.products)).catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => !exclude.includes(p.id))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      .slice(0, 8);
  }, [products, query, exclude]);

  return (
    <div className="picker" ref={ref}>
      <input
        className="input"
        style={{ width: '100%' }}
        value={query}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        aria-label="Search products"
      />
      {open && (
        <div className="picker-list" role="listbox">
          {matches.length === 0 && <div className="faint" style={{ padding: '8px 10px' }}>No matching products</div>}
          {matches.map((p) => (
            <button
              key={p.id}
              type="button"
              className="picker-option"
              role="option"
              aria-selected="false"
              onClick={() => {
                onPick(p);
                setQuery('');
                setOpen(false);
              }}
            >
              <span>
                <span className="cell-title">{p.name}</span> <span className="cell-sub mono">{p.sku}</span>
              </span>
              <span className="num">
                {inr(p.pricePaise)} · <span className={p.stock === 0 ? 'strike' : ''}>{p.stock} in stock</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
