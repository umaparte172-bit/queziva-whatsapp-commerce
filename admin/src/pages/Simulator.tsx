import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { BrandMark, Pagination, ProductThumbnail, StatusBadge, useToast } from '../components';
import { inr } from '../format';
import type { SimMessage, SimulatorState } from '../types';

/**
 * Test-mode customer simulator: a WhatsApp-like phone for one simulated customer. Every tap and
 * message goes through the same webhook processing as real WhatsApp traffic.
 */

const WA_KEY = 'qz.sim.waId';
const NAME_KEY = 'qz.sim.name';

const newWaId = () => `91999${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const read = (k: string, fallback: string) => {
  try {
    return sessionStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: string) => {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

/** Approved-template texts (docs/whatsapp-templates.md) so templates render like on the phone. */
const TEMPLATES: Record<string, { body: string; url?: { text: string; base?: string; fixed?: string } }> = {
  qz_order_update: { body: "Hi {{1}}, we've reviewed your Queziva order {{2}}.\n\nWhat changed: {{3}}\nUpdated product total: {{4}}\n\nPlease confirm to continue. No payment is needed yet." },
  qz_address_request: { body: 'Hi {{1}}, your Queziva order {{2}} is confirmed ✨\n\nPlease tap below to share your delivery address so we can calculate shipping.' },
  qz_order_cancelled: { body: "Hi {{1}}, your Queziva order {{2}} has been cancelled. {{3}}\n\nYou're welcome to order again anytime from our catalogue." },
  qz_payment_request: { body: 'Hi {{1}}, your Queziva order {{2}} is ready. Total payable: {{3}} (including shipping).\n\nTap below to review your order and pay securely on WhatsApp.' },
  qz_order_confirmed: { body: "Hi {{1}}, your payment was successful 🎉\n\nOrder ID: {{2}}\nAmount paid: {{3}}\n\nYour Queziva order is confirmed. We'll share tracking details as soon as it ships." },
  qz_order_dispatched: { body: 'Hi {{1}}, your Queziva order {{2}} has been dispatched 📦\n\nCourier: {{3}}\nAWB: {{4}}\n\nTap below to track your shipment.', url: { text: 'Track Shipment', base: 'https://shiprocket.co/tracking/' } },
  qz_in_transit: { body: 'Hi {{1}}, your Queziva order {{2}} is on its way 🚚 Tap below to see where it is.', url: { text: 'Track Shipment', base: 'https://shiprocket.co/tracking/' } },
  qz_out_for_delivery: { body: 'Hi {{1}}, your Queziva order {{2}} is out for delivery today 🛵 Please keep your phone handy for the courier.', url: { text: 'Track Shipment', base: 'https://shiprocket.co/tracking/' } },
  qz_delivery_attempt: { body: "Hi {{1}}, the courier couldn't deliver your Queziva order {{2}} today. They will try again – reply here if you'd like to share delivery instructions." },
  qz_order_delivered: { body: 'Hi {{1}}, your Queziva order {{2}} has been delivered 🎉\n\nWe hope you love your jewellery! 💎\n\n📹 Please record a continuous unboxing video while opening your parcel. This helps us in case of any issue with the shipment.' },
  qz_feedback_request: { body: "Hi {{1}}! 💎 How are you liking your Queziva jewellery?\n\nWe'd love to hear your feedback – just reply to this message. And tag us on Instagram when you wear your pieces, we love sharing our customers' looks!", url: { text: 'Follow on Instagram', fixed: 'https://instagram.com/queziva' } },
};

/** Titles of template quick-reply buttons, matched by the payload action. */
const QUICK_REPLY_TITLES: Record<string, string> = { accept: 'Accept Updated Order', cancel: 'Cancel Order', address: 'Share Address', pay: 'Review & Pay' };

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

export function SimulatorPage() {
  const toast = useToast();
  const [waId, setWaId] = useState(() => read(WA_KEY, newWaId()));
  const [name, setName] = useState(() => read(NAME_KEY, 'Priya Sharma'));
  const [state, setState] = useState<SimulatorState | null>(null);
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  useEffect(() => write(WA_KEY, waId), [waId]);
  useEffect(() => write(NAME_KEY, name), [name]);

  // Poll so admin actions in the dashboard show up on the phone.
  useEffect(() => {
    let cancelled = false;
    const load = () => api.sim.state(waId).then((s) => !cancelled && setState(s)).catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [waId]);

  useEffect(() => {
    const count = state?.messages.length ?? 0;
    if (count !== lastCount.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    lastCount.current = count;
  }, [state]);

  const act = useCallback(
    async (fn: () => Promise<SimulatorState>, done?: string) => {
      setBusy(true);
      try {
        setState(await fn());
        if (done) toast(done);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong', 'error');
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const tap = (id: string, title: string, onTemplate: boolean) => act(() => api.sim.button(waId, id, title, onTemplate));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Customer simulator</h1>
          <div className="muted" style={{ marginTop: 4 }}>
            Play the customer on WhatsApp. Everything goes through the real workflow; the dashboard updates as you go.
          </div>
        </div>
        <span className="tag warn">Test mode – no real messages or payments</span>
      </div>

      <div className="sim">
        <Phone state={state} name={name} busy={busy} chatRef={chatRef} onTap={tap} act={act} waId={waId} />

        <div className="stack">
          <CustomerPanel
            waId={waId}
            name={name}
            state={state}
            onName={setName}
            onSwitch={(id, n) => {
              setWaId(id);
              if (n) setName(n);
              setState(null);
            }}
          />
          <CartPanel state={state} busy={busy} onSend={(items) => act(() => api.sim.cart(waId, name, items), 'Cart sent')} />
          {state?.order && <OrderPanel state={state} busy={busy} waId={waId} act={act} />}
        </div>
      </div>
    </>
  );
}

// ── Phone ──────────────────────────────────────────────────

function Phone(props: {
  state: SimulatorState | null;
  name: string;
  busy: boolean;
  waId: string;
  chatRef: React.RefObject<HTMLDivElement | null>;
  onTap: (id: string, title: string, onTemplate: boolean) => void;
  act: (fn: () => Promise<SimulatorState>, done?: string) => Promise<void>;
}) {
  const { state, busy, waId, act } = props;
  const [text, setText] = useState('');
  const catalog = new Map(state?.catalog.map((c) => [c.retailerId, c.name]) ?? []);

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const t = text.trim();
    setText('');
    act(() => api.sim.text(waId, t));
  };

  return (
    <div className="phone">
      <div className="phone-top">
        <div className="phone-avatar">
          <BrandMark />
        </div>
        <div>
          <div className="who">Queziva</div>
          <div className="sub">Business account · you are {props.name}</div>
        </div>
      </div>
      <div className="chat" ref={props.chatRef}>
        {!state?.messages.length && <div className="sim-note">Send a cart from the catalogue on the right to start.</div>}
        {state?.messages.map((m) =>
          m.direction === 'INBOUND' ? (
            <InboundBubble key={m.id} m={m} catalog={catalog} />
          ) : (
            <OutboundBubble key={m.id} m={m} busy={busy} onTap={props.onTap} waId={waId} act={act} />
          ),
        )}
      </div>
      <form className="phone-input" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" aria-label="Type a message as the customer" />
        <button type="submit" aria-label="Send" disabled={busy}>
          ➤
        </button>
      </form>
    </div>
  );
}

function InboundBubble({ m, catalog }: { m: SimMessage; catalog: Map<string, string> }) {
  const p = m.payload ?? {};
  let body: string;
  if (p.type === 'text') body = p.text?.body ?? '';
  else if (p.type === 'order') {
    const items = (p.order?.product_items ?? []) as { product_retailer_id: string; quantity: number }[];
    body = `🛒 Cart\n${items.map((i) => `${catalog.get(i.product_retailer_id) ?? i.product_retailer_id} × ${i.quantity}`).join('\n')}`;
  } else if (p.type === 'interactive' && p.interactive?.type === 'nfm_reply') body = '📍 Delivery address shared';
  else if (p.type === 'interactive') body = `↩ ${p.interactive?.button_reply?.title ?? p.interactive?.list_reply?.title ?? 'Reply'}`;
  else if (p.type === 'button') body = `↩ ${p.button?.text ?? 'Reply'}`;
  else body = `(${m.type})`;
  return (
    <div className="bubble out">
      {body}
      <span className="time">{time(m.createdAt)} ✓✓</span>
    </div>
  );
}

function OutboundBubble(props: {
  m: SimMessage;
  busy: boolean;
  waId: string;
  onTap: (id: string, title: string, onTemplate: boolean) => void;
  act: (fn: () => Promise<SimulatorState>, done?: string) => Promise<void>;
}) {
  const { m, busy, onTap } = props;
  const p = m.payload ?? {};
  const failed = m.status === 'failed';
  const content = (() => {
    switch (p.kind) {
      case 'text':
        return <>{p.body}</>;
      case 'image':
        return (
          <>
            <img className="bubble-product-image" src={p.imageUrl} alt="Product" />
            {p.caption && <div>{p.caption}</div>}
          </>
        );
      case 'buttons':
        return (
          <>
            {p.header && <div className="header">{p.header}</div>}
            {p.body}
            {p.footer && <div className="footer">{p.footer}</div>}
            <div className="bubble-actions">
              {p.buttons.map((b: { id: string; title: string }) => (
                <button key={b.id} disabled={busy} onClick={() => onTap(b.id, b.title, false)}>
                  ↩ {b.title}
                </button>
              ))}
            </div>
          </>
        );
      case 'cta_url':
        return (
          <>
            {p.body}
            <div className="bubble-actions">
              <a href={p.url} target="_blank" rel="noreferrer">
                ↗ {p.buttonText}
              </a>
            </div>
          </>
        );
      case 'address':
        return <AddressBubble p={p} busy={busy} onSubmit={(values) => props.act(() => api.sim.address(props.waId, values), 'Address sent')} />;
      case 'order_details':
        return <OrderDetailsBubble od={p.order} busy={busy} onPay={(outcome) => props.act(() => api.sim.pay(props.waId, outcome), outcome === 'captured' ? 'Paid' : 'Payment failed')} />;
      case 'order_status':
        return (
          <>
            <div className="kind">Order update · {p.status?.status}</div>
            {p.status?.body}
          </>
        );
      case 'template':
        return <TemplateBubble t={p.template} busy={busy} onTap={onTap} />;
      default:
        return <>({m.type})</>;
    }
  })();
  return (
    <div className={`bubble in ${failed ? 'failed' : ''}`}>
      {content}
      {failed && <div className="footer" style={{ color: '#d93025' }}>Not delivered: {m.error}</div>}
      <span className="time">{time(m.createdAt)}</span>
    </div>
  );
}

function TemplateBubble({ t, busy, onTap }: { t: any; busy: boolean; onTap: (id: string, title: string, onTemplate: boolean) => void }) {
  const components: any[] = t?.components ?? [];
  const values: string[] = components.find((c) => c.type === 'body')?.parameters?.map((x: any) => x.text) ?? [];
  const def = TEMPLATES[t?.name];
  const body = def ? def.body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '') : values.join(' · ');
  const quickReplies = components.filter((c) => c.sub_type === 'quick_reply').map((c) => String(c.parameters?.[0]?.payload ?? ''));
  const urlSuffix = components.find((c) => c.sub_type === 'url')?.parameters?.[0]?.text;
  const url = def?.url && (def.url.fixed ?? `${def.url.base}${urlSuffix ?? ''}`);
  return (
    <>
      <div className="kind">Template · {t?.name}</div>
      {body}
      {(quickReplies.length > 0 || url) && (
        <div className="bubble-actions">
          {quickReplies.map((payload) => {
            const title = QUICK_REPLY_TITLES[payload.split(':')[1] ?? ''] ?? 'Reply';
            return (
              <button key={payload} disabled={busy} onClick={() => onTap(payload, title, true)}>
                ↩ {title}
              </button>
            );
          })}
          {url && (
            <a href={url} target="_blank" rel="noreferrer">
              ↗ {def!.url!.text}
            </a>
          )}
        </div>
      )}
    </>
  );
}

const ADDRESS_FIELDS: [string, string, string][] = [
  ['name', 'name', 'Full name'],
  ['phone_number', 'phoneNumber', 'Mobile'],
  ['house_number', 'houseNumber', 'Flat / house no.'],
  ['building_name', 'buildingName', 'Building'],
  ['address', 'address', 'Street / area'],
  ['landmark_area', 'landmarkArea', 'Landmark'],
  ['city', 'city', 'City'],
  ['state', 'state', 'State'],
  ['in_pin_code', 'inPinCode', 'Pincode'],
];

function AddressBubble({ p, busy, onSubmit }: { p: any; busy: boolean; onSubmit: (values: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(ADDRESS_FIELDS.map(([field, prefillKey]) => [field, (p.prefill?.[prefillKey] as string) ?? ''])),
  );
  const errors: Record<string, string> = p.validationErrors ?? {};
  return (
    <>
      {p.body}
      {!open ? (
        <div className="bubble-actions">
          <button disabled={busy} onClick={() => setOpen(true)}>
            📍 Provide address
          </button>
        </div>
      ) : (
        <form
          className="sim-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())));
            setOpen(false);
          }}
        >
          {ADDRESS_FIELDS.map(([field, , label]) => (
            <input
              key={field}
              placeholder={label}
              aria-label={label}
              value={values[field] ?? ''}
              style={errors[field] ? { borderColor: '#d93025' } : undefined}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
            />
          ))}
          {Object.entries(errors).map(([f, msg]) => (
            <div key={f} className="err">
              {msg}
            </div>
          ))}
          <button className="btn btn-sm btn-primary" type="submit" disabled={busy} style={{ gridColumn: '1 / -1' }}>
            Send address
          </button>
        </form>
      )}
    </>
  );
}

function OrderDetailsBubble({ od, busy, onPay }: { od: any; busy: boolean; onPay: (outcome: 'captured' | 'failed') => void }) {
  if (!od) return null;
  return (
    <>
      {od.body}
      <div className="od">
        {od.items.map((i: any) => (
          <div className="od-row" key={i.retailerId}>
            <span>
              {i.name} × {i.quantity}
            </span>
            <span>{inr(i.amountPaise * i.quantity)}</span>
          </div>
        ))}
        <div className="od-row" style={{ marginTop: 6 }}>
          <span>Subtotal</span>
          <span>{inr(od.subtotalPaise)}</span>
        </div>
        {od.discountPaise > 0 && (
          <div className="od-row">
            <span>{od.discountDescription ?? 'Discount'}</span>
            <span>−{inr(od.discountPaise)}</span>
          </div>
        )}
        <div className="od-row">
          <span>{od.shippingDescription ?? 'Shipping'}</span>
          <span>{od.shippingPaise ? inr(od.shippingPaise) : 'Free'}</span>
        </div>
        <div className="od-row">
          <span>{od.taxDescription ?? 'Tax'}</span>
          <span>{inr(od.taxPaise)}</span>
        </div>
        <div className="od-row od-total">
          <span>Total</span>
          <span>{inr(od.totalPaise)}</span>
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
          Ref {od.referenceId}
        </div>
      </div>
      {od.footer && <div className="footer">{od.footer}</div>}
      <div className="bubble-actions">
        <button className="pay-btn" disabled={busy} onClick={() => onPay('captured')}>
          Pay {inr(od.totalPaise)}
        </button>
        <button disabled={busy} onClick={() => onPay('failed')} style={{ fontSize: 12, color: '#667781' }}>
          Simulate a failed payment
        </button>
      </div>
    </>
  );
}

// ── Side panels ────────────────────────────────────────────

function CustomerPanel(props: {
  waId: string;
  name: string;
  state: SimulatorState | null;
  onName: (n: string) => void;
  onSwitch: (waId: string, name?: string) => void;
}) {
  const others = props.state?.customers.filter((c) => c.waId !== props.waId) ?? [];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Customer</h2>
        <button className="btn btn-sm" onClick={() => props.onSwitch(newWaId(), 'Demo Customer')}>
          New customer
        </button>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="sim-name">WhatsApp name</label>
            <input id="sim-name" className="input" value={props.name} onChange={(e) => props.onName(e.target.value)} />
          </div>
          <div className="field">
            <label>Number</label>
            <div className="mono" style={{ padding: '7px 0' }}>+{props.waId}</div>
          </div>
        </div>
        {others.length > 0 && (
          <div className="field">
            <label htmlFor="sim-switch">Switch to an earlier simulated customer</label>
            <select
              id="sim-switch"
              className="input"
              value=""
              onChange={(e) => {
                const c = others.find((o) => o.waId === e.target.value);
                if (c) props.onSwitch(c.waId, c.name ?? undefined);
              }}
            >
              <option value="">Choose…</option>
              {others.map((c) => (
                <option key={c.waId} value={c.waId}>
                  {c.name ?? 'Customer'} (+{c.waId})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

function CartPanel({ state, busy, onSend }: { state: SimulatorState | null; busy: boolean; onSend: (items: { retailerId: string; quantity: number }[]) => void }) {
  const pageSize = 10;
  const [qty, setQty] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (state?.catalog ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.retailerId.toLowerCase().includes(q));
  }, [state?.catalog, query]);
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  useEffect(() => setPage(1), [query]);
  useEffect(() => setPage((current) => Math.min(current, pages)), [pages]);
  const visibleProducts = matches.slice((page - 1) * pageSize, page * pageSize);
  const items = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([retailerId, quantity]) => ({ retailerId, quantity }));
  return (
    <div className="card">
      <div className="card-head catalog-head">
        <div>
          <h2>WhatsApp catalogue</h2>
          <div className="cell-sub">{matches.length} product{matches.length === 1 ? '' : 's'}</div>
        </div>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || items.length === 0}
          onClick={() => {
            onSend(items);
            setQty({});
          }}
        >
          Send cart ({items.reduce((n, i) => n + i.quantity, 0)})
        </button>
      </div>
      <div className="card-body">
        <input
          className="input catalog-search"
          type="search"
          placeholder="Search name or SKU…"
          aria-label="Search simulator catalogue"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {visibleProducts.map((p) => (
          <div className="catalog-row" key={p.retailerId}>
            <span className="product-identity">
              <ProductThumbnail imageUrl={p.imageUrl} name={p.name} size="sm" />
              <span>
                <span className="cell-title">{p.name}</span>
                <span className="cell-sub catalog-sku">{p.retailerId}</span>
                <div className="cell-sub">
                  {inr(p.pricePaise)} · {p.stock} in stock
                </div>
              </span>
            </span>
            <span className="qty">
              <button className="icon-btn" aria-label={`Fewer ${p.name}`} onClick={() => setQty({ ...qty, [p.retailerId]: Math.max(0, (qty[p.retailerId] ?? 0) - 1) })}>
                −
              </button>
              <span className="value">{qty[p.retailerId] ?? 0}</span>
              <button className="icon-btn" aria-label={`More ${p.name}`} onClick={() => setQty({ ...qty, [p.retailerId]: (qty[p.retailerId] ?? 0) + 1 })}>
                +
              </button>
            </span>
            <span className="num muted">{qty[p.retailerId] ? inr(p.pricePaise * qty[p.retailerId]!) : ''}</span>
          </div>
        ))}
        {state && matches.length === 0 && <div className="empty compact">No matching products.</div>}
        <p className="faint" style={{ marginBottom: 0 }}>
          Tip: order more than is in stock to try the “only 1 available” flow.
        </p>
      </div>
      <Pagination page={page} pageSize={pageSize} total={matches.length} onPage={setPage} />
    </div>
  );
}

function OrderPanel({ state, busy, waId, act }: { state: SimulatorState; busy: boolean; waId: string; act: (fn: () => Promise<SimulatorState>, done?: string) => Promise<void> }) {
  const o = state.order!;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Latest order</h2>
        <a className="btn btn-sm" href={`#/orders/${o.id}`}>
          Open in dashboard →
        </a>
      </div>
      <div className="card-body stack" style={{ gap: 14 }}>
        <div className="row">
          <span className="mono cell-title">{o.orderNumber ?? o.requestNumber}</span>
          <StatusBadge status={o.status} />
          {o.awb && <span className="mono faint">AWB {o.awb}</span>}
        </div>
        {o.awb && (
          <div className="field">
            <label>Courier updates (as Shiprocket would send them)</label>
            <div className="row">
              {state.courierStatuses.map((s) => (
                <button key={s} className="btn btn-sm" disabled={busy} onClick={() => act(() => api.sim.courier(waId, s), `Courier: ${s.toLowerCase()}`)}>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label>Skip ahead (runs reminders, timeouts and follow-ups that would be due)</label>
          <div className="row">
            {[13, 49, 73].map((h) => (
              <button key={h} className="btn btn-sm" disabled={busy} onClick={() => act(() => api.sim.fastForward(waId, h), `Skipped ${h} hours ahead`)}>
                +{h} h
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
