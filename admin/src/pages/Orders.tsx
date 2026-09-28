import { useEffect, useState } from 'react';
import { api } from '../api';
import { StatusBadge, useToast } from '../components';
import { ago, inr, phone } from '../format';
import { navigate } from '../router';
import type { OrderList, OrderStatus, OrderSummary } from '../types';

interface Filter {
  key: string;
  label: string;
  statuses?: OrderStatus[];
  stockIssues?: boolean;
}

const FILTERS: Filter[] = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs review', statuses: ['NEW', 'PENDING_REVIEW'] },
  { key: 'stock', label: 'Stock issues', stockIssues: true },
  { key: 'modified', label: 'Modified', statuses: ['MODIFIED'] },
  { key: 'approval', label: 'Customer approval', statuses: ['AWAITING_CUSTOMER_APPROVAL'] },
  { key: 'address', label: 'Awaiting address', statuses: ['AWAITING_ADDRESS'] },
  { key: 'ready', label: 'Ready for payment', statuses: ['READY_FOR_PAYMENT'] },
  { key: 'payment', label: 'Waiting for payment', statuses: ['PAYMENT_REQUESTED'] },
  { key: 'paid', label: 'Paid', statuses: ['PAID'] },
  { key: 'processing', label: 'Processing', statuses: ['PROCESSING'] },
  { key: 'shipped', label: 'Shipped', statuses: ['SHIPPED'] },
  { key: 'transit', label: 'In transit', statuses: ['IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
  { key: 'delivered', label: 'Delivered', statuses: ['DELIVERED'] },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['CANCELLED'] },
];

const FILTER_KEY = 'qz.orders.filter';

function readFilter(): string {
  try {
    return sessionStorage.getItem(FILTER_KEY) ?? 'review';
  } catch {
    return 'review';
  }
}

function countFor(filter: Filter, summary: OrderSummary | null): number | null {
  if (!summary) return null;
  if (filter.stockIssues) return summary.stockIssues;
  const statuses = filter.statuses ?? (Object.keys(summary.counts) as OrderStatus[]);
  return statuses.reduce((n, s) => n + (summary.counts[s] ?? 0), 0);
}

export function OrdersPage({ summary }: { summary: OrderSummary | null }) {
  const toast = useToast();
  const [filterKey, setFilterKey] = useState(readFilter);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrderList | null>(null);
  const [loading, setLoading] = useState(true);

  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0]!;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [filterKey, debounced]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .orders({
          // Searching looks across every status so an order is always found.
          statuses: debounced ? undefined : filter.statuses,
          stockIssues: debounced ? undefined : filter.stockIssues,
          q: debounced || undefined,
          page,
        })
        .then((d) => !cancelled && setData(d))
        .catch((e) => !cancelled && toast(e.message, 'error'))
        .finally(() => !cancelled && setLoading(false));
    setLoading(true);
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [filter, debounced, page, toast]);

  const choose = (key: string) => {
    setFilterKey(key);
    try {
      sessionStorage.setItem(FILTER_KEY, key);
    } catch {
      /* private mode */
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="page-head">
        <h1>Orders</h1>
        <input
          className="input search"
          type="search"
          placeholder="Search ID, phone or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search orders"
        />
      </div>

      {!debounced && (
        <div className="chips" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => {
            const count = countFor(f, summary);
            return (
              <button
                key={f.key}
                role="tab"
                aria-selected={f.key === filter.key}
                className={`chip ${f.key === filter.key ? 'active' : ''} ${f.stockIssues && count ? 'warn' : ''}`}
                onClick={() => choose(f.key)}
              >
                {f.label}
                {count !== null && <span className="count">{count}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {data?.orders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                  <td>
                    <a href={`#/orders/${o.id}`} className="cell-title mono" onClick={(e) => e.stopPropagation()}>
                      {o.orderNumber ?? o.requestNumber}
                    </a>
                    {o.orderNumber && <div className="cell-sub mono">{o.requestNumber}</div>}
                  </td>
                  <td>
                    <div className="cell-title">{o.customer.name ?? 'Unknown'}</div>
                    <div className="cell-sub">{phone(o.customer.waId)}</div>
                  </td>
                  <td style={{ maxWidth: 340 }}>
                    <div>{o.itemsSummary || <span className="faint">No items</span>}</div>
                    <div className="row" style={{ marginTop: 4 }}>
                      {o.stockIssue && <span className="tag warn">Stock issue</span>}
                      {o.modified && <span className="tag brand">Changed by admin</span>}
                    </div>
                  </td>
                  <td className="num">{inr(o.totalPaise)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="muted" title={new Date(o.createdAt).toLocaleString('en-IN')}>
                    {ago(o.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.orders.length === 0 && (
            <div className="empty">{debounced ? `No orders match “${debounced}”.` : 'No orders here right now.'}</div>
          )}
          {!data && loading && <div className="empty">Loading orders…</div>}
        </div>
        {data && pages > 1 && (
          <div className="pager">
            <span className="muted">
              Page {page} of {pages} · {data.total} orders
            </span>
            <div className="row">
              <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
