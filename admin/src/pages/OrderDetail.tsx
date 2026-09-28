import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Dialog, ProductPicker, StatusBadge, useToast } from '../components';
import { ago, inr, parseRupees, phone, rupeesInput, STATUS_LABELS, when } from '../format';
import type { AddressInput, OrderAction, OrderDetail, OrderEvent, OrderItem, Product, ShippingOptions } from '../types';

export function OrderDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [closing, setClosing] = useState(false);

  const load = useCallback(async () => {
    try {
      let o = await api.order(id);
      if (o.status === 'NEW') {
        // Opening a new order marks it as being reviewed – before any button can be used, so it never
        // races the admin's first click. If it was already picked up (e.g. a second tab), just reload.
        o = await api.action(o, 'start_review').catch(() => api.order(id));
      }
      setOrder(o);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the order');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /** Runs a change; on a conflict (someone else edited) reloads so the admin sees the latest order. */
  const run = useCallback(
    async (change: () => Promise<OrderDetail>, success?: string) => {
      setBusy(true);
      try {
        const next = await change();
        setOrder(next);
        if (next.warning) toast(next.warning, 'error');
        else if (success) toast(success);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong', 'error');
        // Wait for the fresh order before re-enabling the buttons, so a quick retry uses the new version.
        if (e instanceof ApiError && e.status === 409) await load();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, toast],
  );

  if (loadError) {
    return (
      <>
        <a className="back" href="#/orders">← All orders</a>
        <div className="alert alert-danger">{loadError}</div>
      </>
    );
  }
  if (!order) return <div className="empty">Loading order…</div>;

  const SUCCESS: Partial<Record<OrderAction['id'], string>> = {
    approve: order.modified ? 'Revised order sent to the customer for approval' : 'Order approved – customer asked for their address',
    resend: 'WhatsApp message sent again',
    request_payment: `Payment request for ${inr(order.totalPaise)} sent on WhatsApp`,
    withdraw_payment: 'Payment request withdrawn – you can edit the order again',
    create_shipment: 'Shipment created in Shiprocket',
    refresh_tracking: 'Tracking checked with Shiprocket',
    mark_delivered: 'Marked as delivered – customer notified',
    retry_refund: 'Refund initiated – customer notified',
  };

  const onAction = (action: OrderAction) => {
    if (action.id === 'cancel') setCancelling(true);
    else if (action.id === 'close_undelivered') setClosing(true);
    else if (action.id === 'request_payment') setConfirmingPayment(true);
    else if (action.id === 'mark_delivered') {
      if (window.confirm('Mark this order as delivered? The customer gets the delivered message and the feedback follow-up is scheduled.')) {
        run(() => api.action(order, action.id), SUCCESS[action.id]);
      }
    }
    else run(() => api.action(order, action.id), SUCCESS[action.id]);
  };

  const paidStatus = order.paidAt !== null && order.status !== 'CANCELLED';

  return (
    <>
      <a className="back" href="#/orders">← All orders</a>
      <div className="page-head">
        <div>
          <div className="detail-title">
            <h1 className="mono">{order.orderNumber ?? order.requestNumber}</h1>
            <StatusBadge status={order.status} />
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            Received {when(order.createdAt)}
            {order.orderNumber && <> · Request {order.requestNumber}</>}
          </div>
        </div>
        <div className="row">
          {order.actions.map((a) => (
            <button
              key={a.id}
              className={`btn ${a.tone === 'primary' ? 'btn-primary' : a.tone === 'danger' ? 'btn-danger' : ''}`}
              disabled={busy || (a.id === 'approve' && order.stockProblems.length > 0)}
              title={a.id === 'approve' && order.stockProblems.length > 0 ? 'Fix stock issues first' : undefined}
              onClick={() => onAction(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="stack" style={{ marginBottom: 16 }}>
        {order.stockProblems.length > 0 && (
          <div className="alert alert-warn" role="alert">
            <div>
              <strong>Stock needs attention before this order can be approved</strong>
              <ul>
                {order.stockProblems.map((p) => (
                  <li key={p.itemId}>{p.message}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {order.modified && order.permissions.editItems && order.status !== 'AWAITING_CUSTOMER_APPROVAL' && (
          <div className="alert alert-info">
            This order differs from what the customer asked for. The customer must accept the changes before
            they are asked for payment.
          </div>
        )}
        {order.status === 'AWAITING_CUSTOMER_APPROVAL' && (
          <div className="alert alert-info">
            Waiting for the customer to accept the revised order. Editing it again will withdraw this version.
          </div>
        )}
        {order.status === 'READY_FOR_PAYMENT' && (
          <div className="alert alert-info">
            Shipping is calculated. Check the final amount below – you can still change the courier, shipping charge,
            discount or address. Requesting payment on WhatsApp is the next step.
          </div>
        )}
        {order.status === 'PAYMENT_REQUESTED' && (
          <div className="alert alert-info">
            <div style={{ flex: 1 }}>
              Waiting for the customer to pay {inr(order.totalPaise)} on WhatsApp. To change anything, withdraw the payment
              request first.
              {order.testMode && (
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="tag">Test mode</span>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.testPayment(order, 'captured'), 'Simulated payment received')}>
                    Simulate successful payment
                  </button>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.testPayment(order, 'failed'), 'Simulated failed payment')}>
                    Simulate failed payment
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {order.status === 'PAID' && (
          <div className="alert alert-info">Paid and verified with Razorpay. The Shiprocket shipment is being created.</div>
        )}
        {order.status === 'CANCELLED' && (
          <div className="alert alert-danger">Cancelled{order.cancelReason ? `: ${order.cancelReason}` : ''}</div>
        )}
      </div>

      <div className="grid-detail">
        <div className="stack">
          <ItemsCard order={order} busy={busy} run={run} />
          <TotalsCard order={order} busy={busy} run={run} />
          <HistoryCard events={order.events} />
        </div>
        <div className="stack">
          <CustomerCard order={order} />
          <DeliveryCard order={order} busy={busy} run={run} />
          <PaymentCard order={order} />
          <NotesCard order={order} busy={busy} run={run} />
        </div>
      </div>

      {closing && (
        <CloseUndeliveredDialog
          order={order}
          busy={busy}
          onClose={() => setClosing(false)}
          onConfirm={async (input) => {
            if (await run(() => api.closeUndelivered(order, input), 'Order closed')) setClosing(false);
          }}
        />
      )}
      {cancelling && (
        <CancelDialog
          refundPaise={paidStatus ? order.totalPaise : null}
          onClose={() => setCancelling(false)}
          onConfirm={async (reason) => {
            if (await run(() => api.action(order, 'cancel', reason), paidStatus ? 'Order cancelled and refund started' : 'Order cancelled')) {
              setCancelling(false);
            }
          }}
          busy={busy}
        />
      )}
      {confirmingPayment && (
        <Dialog title={`Request ${inr(order.totalPaise)}?`} onClose={() => setConfirmingPayment(false)}>
          <p className="muted" style={{ marginTop: 0 }}>
            {order.customer.name ?? 'The customer'} will get the order on WhatsApp with a <strong>Pay Now</strong> button for{' '}
            {inr(order.totalPaise)} (products {inr(order.subtotalPaise)}
            {order.discountPaise ? `, discount −${inr(order.discountPaise)}` : ''}, shipping{' '}
            {order.shippingPaise ? inr(order.shippingPaise) : 'free'}
            {order.pricesIncludeGst ? ', GST included' : `, GST ${inr(order.taxPaise)}`}).
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmingPayment(false)}>
              Not yet
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => run(() => api.action(order, 'request_payment'), SUCCESS.request_payment).then((ok) => ok && setConfirmingPayment(false))}
            >
              Send payment request
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

type Run = (change: () => Promise<OrderDetail>, success?: string) => Promise<boolean>;

// ── Items ──────────────────────────────────────────────────
function ItemsCard({ order, busy, run }: { order: OrderDetail; busy: boolean; run: Run }) {
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const editable = order.permissions.editItems;
  const byId = new Map(order.items.map((i) => [i.id, i]));
  const inOrder = order.items.filter((i) => !i.removed).map((i) => i.productId);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Items</h2>
        {editable && !adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)} disabled={busy}>
            + Add product
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="num">Requested</th>
              <th className="num">Quantity</th>
              <th className="num">In stock</th>
              <th className="num">Price</th>
              <th className="num">Total</th>
              {editable && <th />}
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                replaced={item.replacesItemId ? byId.get(item.replacesItemId) : undefined}
                editable={editable}
                busy={busy}
                replacing={replacing === item.id}
                onReplace={() => setReplacing(replacing === item.id ? null : item.id)}
                onQuantity={(q) => run(() => api.setQuantity(order, item.id, q))}
                onRemove={() => run(() => api.removeItem(order, item.id), `${item.name} removed`)}
                onPickReplacement={(p) =>
                  run(() => api.replaceItem(order, item.id, p.id), `Replaced with ${p.name}`).then(() => setReplacing(null))
                }
                exclude={inOrder}
              />
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddItem order={order} busy={busy} run={run} exclude={inOrder} onDone={() => setAdding(false)} />}
    </div>
  );
}

function ItemRow(props: {
  item: OrderItem;
  replaced?: OrderItem;
  editable: boolean;
  busy: boolean;
  replacing: boolean;
  exclude: (string | null)[];
  onQuantity: (q: number) => void;
  onRemove: () => void;
  onReplace: () => void;
  onPickReplacement: (p: Product) => void;
}) {
  const { item, replaced, editable, busy } = props;
  const changed = !item.removed && !item.addedByAdmin && item.quantity !== item.requestedQuantity;
  return (
    <>
      <tr className={item.removed ? 'removed' : ''}>
        <td>
          <div className={`cell-title ${item.removed ? 'strike' : ''}`}>{item.name}</div>
          <div className="row" style={{ marginTop: 2 }}>
            <span className="cell-sub mono">{item.sku}</span>
            {item.removed && <span className="tag">Removed</span>}
            {item.addedByAdmin && !replaced && <span className="tag brand">Added by admin</span>}
            {replaced && <span className="tag brand">Replaces {replaced.name}</span>}
            {changed && <span className="tag brand">Changed</span>}
          </div>
        </td>
        <td className="num">{item.requestedQuantity || <span className="faint">—</span>}</td>
        <td className="num">
          {editable && !item.removed ? (
            <span className="qty">
              <button className="icon-btn" aria-label="Decrease quantity" disabled={busy || item.quantity <= 1} onClick={() => props.onQuantity(item.quantity - 1)}>
                −
              </button>
              <span className="value">{item.quantity}</span>
              <button className="icon-btn" aria-label="Increase quantity" disabled={busy} onClick={() => props.onQuantity(item.quantity + 1)}>
                +
              </button>
            </span>
          ) : (
            <span className={item.removed ? 'faint' : ''}>{item.quantity}</span>
          )}
        </td>
        <td className="num">
          {item.availableStock === null ? (
            <span className="tag warn">Unknown</span>
          ) : item.stockIssue ? (
            <span className="tag warn">{item.availableStock}</span>
          ) : (
            <span className="muted">{item.availableStock}</span>
          )}
        </td>
        <td className="num">{inr(item.unitPricePaise)}</td>
        <td className="num">{item.removed ? <span className="faint">—</span> : inr(item.unitPricePaise * item.quantity)}</td>
        {editable && (
          <td className="num">
            {!item.removed && (
              <span className="row" style={{ justifyContent: 'flex-end', gap: 12 }}>
                <button className="btn-link" disabled={busy} onClick={props.onReplace}>
                  {props.replacing ? 'Close' : 'Replace'}
                </button>
                <button className="btn-link danger" disabled={busy} onClick={props.onRemove}>
                  Remove
                </button>
              </span>
            )}
          </td>
        )}
      </tr>
      {props.replacing && (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
            <div className="field">
              <label>Replace {item.name} with</label>
              <ProductPicker autoFocus onPick={props.onPickReplacement} exclude={props.exclude} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AddItem({ order, busy, run, exclude, onDone }: { order: OrderDetail; busy: boolean; run: Run; exclude: (string | null)[]; onDone: () => void }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState(1);
  return (
    <div className="card-body" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label>Product</label>
          {product ? (
            <div className="row">
              <strong>{product.name}</strong>
              <span className="faint">
                {inr(product.pricePaise)} · {product.stock} in stock
              </span>
              <button className="btn-link" onClick={() => setProduct(null)}>
                Change
              </button>
            </div>
          ) : (
            <ProductPicker autoFocus onPick={setProduct} exclude={exclude} />
          )}
        </div>
        <div className="field" style={{ width: 90 }}>
          <label htmlFor="add-qty">Quantity</label>
          <input id="add-qty" className="input" type="number" min={1} max={999} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <button
          className="btn btn-primary"
          disabled={!product || busy}
          onClick={() => product && run(() => api.addItem(order, product.id, quantity), `${product.name} added`).then((ok) => ok && onDone())}
        >
          Add
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Totals & discount ──────────────────────────────────────
function TotalsCard({ order, busy, run }: { order: OrderDetail; busy: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [changingShipping, setChangingShipping] = useState(false);
  const parsed = parseRupees(amount || '0');
  const shippingKnown = Boolean(order.shippingQuotedAt);

  const startEdit = () => {
    setAmount(order.discountPaise ? rupeesInput(order.discountPaise) : '');
    setReason(order.discountReason ?? '');
    setEditing(true);
  };

  const save = async () => {
    if (parsed === null) return;
    if (await run(() => api.setDiscount(order, parsed, reason.trim() || undefined), 'Discount updated')) setEditing(false);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Amount</h2>
        <div className="row">
          {/* Also without a quote: when Shiprocket is down, the manual charge is the way forward. */}
          {order.permissions.editShipping && (
            <button className="btn btn-sm" onClick={() => setChangingShipping(true)} disabled={busy}>
              Change shipping
            </button>
          )}
          {order.permissions.editDiscount && !editing && (
            <button className="btn btn-sm" onClick={startEdit} disabled={busy}>
              {order.discountPaise ? 'Edit discount' : 'Add discount'}
            </button>
          )}
        </div>
      </div>
      <div className="card-body">
        {editing && (
          <div className="row" style={{ alignItems: 'flex-end', marginBottom: 16 }}>
            <div className="field" style={{ width: 130 }}>
              <label htmlFor="disc">Discount (₹)</label>
              <input id="disc" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <label htmlFor="disc-reason">Reason (internal)</label>
              <input id="disc-reason" className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={busy || parsed === null} onClick={save}>
              Save
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {parsed === null && <div className="faint" style={{ width: '100%' }}>Enter an amount like 50 or 49.50</div>}
          </div>
        )}
        <div className="totals">
          <span className="muted">Product subtotal</span>
          <span className="num">{inr(order.subtotalPaise)}</span>
          <span className="muted">
            Discount{order.discountReason ? <span className="faint"> · {order.discountReason}</span> : null}
          </span>
          <span className="num">{order.discountPaise ? `− ${inr(order.discountPaise)}` : '—'}</span>
          <span className="muted">
            Shipping{order.shippingCourierName ? <span className="faint"> · {order.shippingCourierName}</span> : null}
            {order.shippingNote && <div className="faint" style={{ fontSize: 12.5 }}>{order.shippingNote}</div>}
          </span>
          <span className="num">
            {shippingKnown ? (order.shippingPaise === 0 ? 'Free' : inr(order.shippingPaise)) : <span className="faint">After address</span>}
          </span>
          <span className="muted">GST {order.pricesIncludeGst ? '(included in prices)' : ''}</span>
          <span className="num">{order.pricesIncludeGst ? <span className="faint">{inr(order.taxPaise)} incl.</span> : inr(order.taxPaise)}</span>
          <span className="grand">{shippingKnown ? 'Total payable' : 'Total so far'}</span>
          <span className="grand num">{inr(order.totalPaise)}</span>
        </div>
      </div>
      {changingShipping && <ShippingDialog order={order} busy={busy} run={run} onClose={() => setChangingShipping(false)} />}
    </div>
  );
}

function ShippingDialog({ order, busy, run, onClose }: { order: OrderDetail; busy: boolean; run: Run; onClose: () => void }) {
  const [data, setData] = useState<ShippingOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(order.shippingCourierId);
  const [manual, setManual] = useState('');
  const [reason, setReason] = useState('');
  const manualPaise = manual.trim() ? parseRupees(manual) : null;

  useEffect(() => {
    api
      .shippingOptions(order)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [order]);

  const done = (ok: boolean) => ok && onClose();

  return (
    <Dialog title="Shipping" onClose={onClose}>
      {error && <div className="alert alert-danger">{error}</div>}
      {!data && !error && <p className="muted">Getting live rates from Shiprocket…</p>}
      {data && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Parcel {data.package.weightGrams} g · {data.package.lengthCm}×{data.package.breadthCm}×{data.package.heightCm} cm to{' '}
            {order.shipPincode}
          </p>
          {data.options.length === 0 && <div className="alert alert-warn">No courier delivers to this pincode.</div>}
          <div className="stack" style={{ gap: 6 }}>
            {data.options.map((o) => (
              <label key={o.courierId} className="card" style={{ padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                <input type="radio" name="courier" checked={selected === o.courierId} onChange={() => setSelected(o.courierId)} />
                <span style={{ flex: 1 }}>
                  <span className="cell-title">{o.courierName}</span>
                  {o.courierId === data.suggestedCourierId && <span className="tag brand" style={{ marginLeft: 6 }}>Suggested</span>}
                  {o.courierId === order.shippingCourierId && <span className="tag" style={{ marginLeft: 6 }}>Current</span>}
                  <div className="cell-sub">
                    {o.etdDays ? `${o.etdDays} days` : 'Delivery time unknown'}
                    {o.rating ? ` · rated ${o.rating}` : ''} · costs you {inr(o.ratePaise)}
                  </div>
                </span>
                <span className="num">
                  <div className="cell-title">{o.customerChargePaise === 0 ? 'Free' : inr(o.customerChargePaise)}</div>
                  <div className="cell-sub">customer pays</div>
                </span>
              </label>
            ))}
          </div>
          <div className="dialog-actions" style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              disabled={busy || selected === null || data.options.length === 0}
              onClick={() => selected !== null && run(() => api.setCourier(order, selected), 'Courier updated').then(done)}
            >
              Use this courier
            </button>
          </div>
        </>
      )}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
        <div className="cell-title" style={{ marginBottom: 8 }}>
          Or set what the customer pays
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 110 }}>
            <label htmlFor="ship-manual">Amount (₹)</label>
            <input id="ship-manual" className="input" inputMode="decimal" placeholder="0" value={manual} onChange={(e) => setManual(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 150 }}>
            <label htmlFor="ship-reason">Reason</label>
            <input id="ship-reason" className="input" value={reason} maxLength={200} placeholder="e.g. Free shipping – repeat customer" onChange={(e) => setReason(e.target.value)} />
          </div>
          <button
            className="btn"
            disabled={busy || manualPaise === null || !reason.trim()}
            onClick={() => manualPaise !== null && run(() => api.setManualShipping(order, manualPaise, reason.trim()), 'Shipping charge updated').then(done)}
          >
            Set charge
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ── Side panels ────────────────────────────────────────────
function CustomerCard({ order }: { order: OrderDetail }) {
  const c = order.customer;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Customer</h2>
      </div>
      <div className="card-body">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{c.name ?? <span className="faint">Unknown</span>}</dd>
          <dt>WhatsApp</dt>
          <dd>
            <a href={`https://wa.me/${c.waId}`} target="_blank" rel="noreferrer">
              {phone(c.waId)}
            </a>
          </dd>
          <dt>Last message</dt>
          <dd>{c.lastInboundAt ? ago(c.lastInboundAt) : <span className="faint">—</span>}</dd>
          {order.customerNote && (
            <>
              <dt>Note</dt>
              <dd>“{order.customerNote}”</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function DeliveryCard({ order, busy, run }: { order: OrderDetail; busy: boolean; run: Run }) {
  const [editing, setEditing] = useState(false);
  const lines = [
    order.shipHouse,
    order.shipStreet,
    order.shipLandmark,
    [order.shipCity, order.shipState].filter(Boolean).join(', '),
    order.shipPincode,
  ].filter(Boolean);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Delivery</h2>
        {order.permissions.editAddress && !editing && (
          <button className="btn btn-sm" onClick={() => setEditing(true)} disabled={busy}>
            {order.shipName ? 'Edit' : 'Enter manually'}
          </button>
        )}
      </div>
      <div className="card-body">
        {editing ? (
          <AddressForm
            order={order}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={(address) => run(() => api.setAddress(order, address), 'Address saved').then((ok) => ok && setEditing(false))}
          />
        ) : order.shipName ? (
          <>
            <div className="cell-title">{order.shipName}</div>
            {order.shipPhone && <div className="muted">{order.shipPhone}</div>}
            <div style={{ marginTop: 6 }}>
              {lines.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
            {order.shippingQuotedAt && (
              <div className="faint" style={{ marginTop: 8 }}>
                {order.packageWeightGrams ? `Parcel ${order.packageWeightGrams} g` : 'Parcel'}
                {order.shippingCostPaise !== null && <> · courier cost {inr(order.shippingCostPaise)}</>}
                {order.shippingEtdDays ? <> · about {order.shippingEtdDays} days</> : null}
              </div>
            )}
          </>
        ) : order.status === 'AWAITING_ADDRESS' ? (
          <span className="faint">Waiting for the customer to share their address on WhatsApp.</span>
        ) : (
          <span className="faint">Collected on WhatsApp after the order is approved.</span>
        )}
        {order.shipments.map((s) => (
          <div key={s.id} style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <dl className="kv">
              <dt>Courier</dt>
              <dd>{s.courierName ?? '—'}</dd>
              <dt>AWB</dt>
              <dd className="mono">{s.awb ?? '—'}</dd>
              <dt>Status</dt>
              <dd>
                <strong>{s.currentStatus ? s.currentStatus.toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—'}</strong>
                {s.lastEventAt && <span className="faint"> · {ago(s.lastEventAt)}</span>}
              </dd>
              <dt>Shiprocket</dt>
              <dd className="mono">{s.shiprocketOrderId ?? '—'}</dd>
              {(s.notifiedMilestones?.length ?? 0) > 0 && (
                <>
                  <dt>Customer told</dt>
                  <dd>
                    {s.notifiedMilestones!
                      .map((m) => MILESTONE_LABEL[m.split('@')[0]!] ?? m)
                      .filter((v, i, all) => all.indexOf(v) === i)
                      .join(', ')}
                  </dd>
                </>
              )}
            </dl>
            {s.trackingUrl && s.awb && (
              <a className="btn btn-sm" style={{ marginTop: 10 }} href={s.trackingUrl} target="_blank" rel="noreferrer">
                Track shipment ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AddressForm({ order, busy, onSave, onCancel }: { order: OrderDetail; busy: boolean; onSave: (a: AddressInput) => void; onCancel: () => void }) {
  const [a, setA] = useState<AddressInput>({
    name: order.shipName ?? order.customer.name ?? '',
    phone: order.shipPhone ?? order.customer.waId.replace(/^91/, ''),
    house: order.shipHouse ?? '',
    street: order.shipStreet ?? '',
    landmark: order.shipLandmark ?? '',
    city: order.shipCity ?? '',
    state: order.shipState ?? '',
    pincode: order.shipPincode ?? '',
  });
  const field = (key: keyof AddressInput, label: string, props: { inputMode?: 'numeric' | 'tel'; maxLength?: number } = {}) => (
    <div className="field">
      <label htmlFor={`addr-${key}`}>{label}</label>
      <input id={`addr-${key}`} className="input" value={a[key] ?? ''} onChange={(e) => setA({ ...a, [key]: e.target.value })} {...props} />
    </div>
  );
  return (
    <form
      className="stack"
      style={{ gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...a, landmark: a.landmark?.trim() || undefined });
      }}
    >
      {field('name', 'Full name')}
      {field('phone', 'Mobile number', { inputMode: 'tel', maxLength: 14 })}
      {field('house', 'House / flat number')}
      {field('street', 'Street / area')}
      {field('landmark', 'Landmark (optional)')}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>{field('city', 'City')}</div>
        <div style={{ width: 100 }}>{field('pincode', 'Pincode', { inputMode: 'numeric', maxLength: 6 })}</div>
      </div>
      {field('state', 'State')}
      <div className="row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          Save address
        </button>
        <button className="btn btn-sm" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const MILESTONE_LABEL: Record<string, string> = {
  SHIPPED: 'Dispatched',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERY_ATTEMPT_FAILED: 'Delivery attempt failed',
  DELIVERED: 'Delivered',
};

const PAYMENT_LABEL: Record<string, string> = {
  CREATED: 'Waiting for customer',
  PENDING: 'Processing',
  CAPTURED: 'Paid',
  FAILED: 'Attempt failed',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partly refunded',
  CANCELLED: 'Request withdrawn',
  REFUND_PENDING: 'Refund in progress',
  REFUND_FAILED: 'Refund failed – retry',
};

const PAYMENT_TONE: Record<string, string> = {
  CAPTURED: 'brand',
  FAILED: 'warn',
  REFUNDED: 'warn',
  PARTIALLY_REFUNDED: 'warn',
  REFUND_PENDING: 'warn',
  REFUND_FAILED: 'warn',
};

function PaymentCard({ order }: { order: OrderDetail }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Payment</h2>
      </div>
      <div className="card-body">
        {order.payments.length === 0 ? (
          <span className="faint">Requested on WhatsApp once the address and shipping are confirmed.</span>
        ) : (
          order.payments.map((p, i) => (
            <dl className="kv" key={p.id} style={{ marginBottom: 10, paddingTop: i ? 10 : 0, borderTop: i ? '1px solid var(--border)' : undefined }}>
              <dt>Status</dt>
              <dd>
                <span className={`tag ${PAYMENT_TONE[p.status] ?? ''}`}>{PAYMENT_LABEL[p.status] ?? p.status}</span>
                {p.verifiedAt && p.status === 'CAPTURED' && <span className="faint"> · verified with Razorpay</span>}
              </dd>
              <dt>Amount</dt>
              <dd>{inr(p.amountPaise)}</dd>
              {p.refundedPaise > 0 && (
                <>
                  <dt>Refunded</dt>
                  <dd>
                    {inr(p.refundedPaise)} {p.razorpayRefundId && <span className="mono faint">{p.razorpayRefundId}</span>}
                  </dd>
                </>
              )}
              <dt>Reference</dt>
              <dd className="mono">{p.referenceId}</dd>
              <dt>Razorpay ID</dt>
              <dd className="mono">{p.razorpayPaymentId ?? '—'}</dd>
              {p.method && (
                <>
                  <dt>Method</dt>
                  <dd>{p.method.toUpperCase()}</dd>
                </>
              )}
              {p.failureReason && (
                <>
                  <dt>Note</dt>
                  <dd>{p.failureReason}</dd>
                </>
              )}
            </dl>
          ))
        )}
      </div>
    </div>
  );
}

function NotesCard({ order, busy, run }: { order: OrderDetail; busy: boolean; run: Run }) {
  const [note, setNote] = useState('');
  return (
    <div className="card">
      <div className="card-head">
        <h2>Internal note</h2>
      </div>
      <div className="card-body stack" style={{ gap: 8 }}>
        <textarea
          className="input"
          rows={3}
          placeholder="Only visible to the team"
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          aria-label="Internal note"
        />
        <div>
          <button
            className="btn btn-sm"
            disabled={busy || !note.trim()}
            onClick={() => run(() => api.addNote(order, note.trim()), 'Note added').then((ok) => ok && setNote(''))}
          >
            Add note
          </button>
        </div>
      </div>
    </div>
  );
}

// ── History ────────────────────────────────────────────────
function describe(e: OrderEvent): string {
  if (e.type === 'STATUS_CHANGED' && e.toStatus) {
    const to = STATUS_LABELS[e.toStatus];
    return e.message ? `${to} — ${e.message}` : `Moved to ${to}`;
  }
  if (e.type === 'CREATED') return e.message ?? 'Order received';
  return e.message ?? e.type.replace(/_/g, ' ').toLowerCase();
}

function actorLabel(e: OrderEvent): string {
  if (e.actor === 'ADMIN') return e.actorName ?? 'Admin';
  if (e.actor === 'CUSTOMER') return 'Customer';
  return 'System';
}

function HistoryCard({ events }: { events: OrderEvent[] }) {
  const [showMessages, setShowMessages] = useState(false);
  const visible = [...events].reverse().filter((e) => showMessages || e.type !== 'MESSAGE_SENT');
  return (
    <div className="card">
      <div className="card-head">
        <h2>History</h2>
        <label className="row faint" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={showMessages} onChange={(e) => setShowMessages(e.target.checked)} />
          Show WhatsApp messages
        </label>
      </div>
      <div className="card-body">
        <ul className="timeline">
          {visible.map((e) => (
            <li key={e.id} className={e.type === 'ERROR' ? 'error' : e.actor.toLowerCase()}>
              <div style={{ whiteSpace: 'pre-line' }}>{describe(e)}</div>
              <div className="meta">
                {actorLabel(e)} · {when(e.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CloseUndeliveredDialog({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: OrderDetail;
  busy: boolean;
  onClose: () => void;
  onConfirm: (input: { reason: string; restock: boolean; refund: boolean }) => void;
}) {
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(true);
  return (
    <Dialog title="Close – not delivered" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        For a parcel that will not reach the customer: returned to you (RTO), lost or damaged. The order is closed and can’t be reopened.
      </p>
      <textarea
        className="input"
        style={{ width: '100%' }}
        rows={2}
        autoFocus
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Returned – customer refused delivery"
        aria-label="Reason"
      />
      <label className="row" style={{ gap: 8, marginTop: 10 }}>
        <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
        Put the items back in stock (parcel is back with you)
      </label>
      <label className="row" style={{ gap: 8, marginTop: 6 }}>
        <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
        Refund {inr(order.totalPaise)} to the customer and tell them on WhatsApp
      </label>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Keep open
        </button>
        <button
          className="btn btn-primary"
          style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
          disabled={busy || !reason.trim()}
          onClick={() => onConfirm({ reason: reason.trim(), restock, refund })}
        >
          Close order
        </button>
      </div>
    </Dialog>
  );
}

function CancelDialog({
  onClose,
  onConfirm,
  busy,
  refundPaise,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  /** Set for paid orders: the amount that will be refunded */
  refundPaise: number | null;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog title={refundPaise !== null ? 'Cancel and refund this order?' : 'Cancel this order?'} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        {refundPaise !== null ? (
          <>
            The Shiprocket shipment will be cancelled, <strong>{inr(refundPaise)} refunded in full</strong> through Razorpay,
            and the stock put back. The customer is told on WhatsApp. This can’t be undone.
          </>
        ) : (
          <>The order will be closed and can’t be reopened. Add a reason for the record.</>
        )}
      </p>
      <textarea className="input" style={{ width: '100%' }} rows={3} autoFocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Out of stock, customer asked to cancel" aria-label="Cancellation reason" />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Keep order
        </button>
        <button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy || !reason.trim()} onClick={() => onConfirm(reason.trim())}>
          {refundPaise !== null ? 'Cancel & refund' : 'Cancel order'}
        </button>
      </div>
    </Dialog>
  );
}
