import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Dialog, Pagination, ProductThumbnail, useToast } from '../components';
import { inr, parseRupees, rupeesInput } from '../format';
import type { Product, ProductInput } from '../types';

export function ProductsPage() {
  const pageSize = 20;
  const toast = useToast();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(
    () =>
      api
        .products({ q: search.trim() || undefined, includeInactive: showInactive })
        .then((r) => setProducts(r.products))
        .catch((e: Error) => toast(e.message, 'error')),
    [search, showInactive, toast],
  );

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => setPage(1), [search, showInactive]);
  const total = products?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => setPage((current) => Math.min(current, pages)), [pages]);
  const visibleProducts = useMemo(() => products?.slice((page - 1) * pageSize, page * pageSize), [products, page]);

  const update = async (p: Product, change: Partial<ProductInput>, message: string): Promise<boolean> => {
    try {
      const { product } = await api.updateProduct(p.id, change);
      setProducts((list) => list?.map((x) => (x.id === product.id ? product : x)) ?? null);
      toast(message);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', 'error');
      return false;
    }
  };

  return (
    <>
      <div className="page-head products-head">
        <h1>Products &amp; stock</h1>
        <div className="row products-tools">
          <input className="input search" type="search" placeholder="Search name or SKU…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search products" />
          <label className="row muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + Add product
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: -8, marginBottom: 16 }}>
        The catalogue ID must match the item’s Content ID in the WhatsApp catalogue, so incoming carts link to the right product.
      </p>

      <div className="card">
        <div className="table-wrap">
          <table className="product-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Price</th>
                <th className="num">Stock</th>
                <th className="num">GST</th>
                <th className="num">Weight</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleProducts?.map((p) => (
                <tr key={p.id}>
                  <td data-label="Product">
                    <div className="product-identity">
                      <ProductThumbnail imageUrl={p.imageUrl} name={p.name} />
                      <div>
                        <div className={`cell-title ${p.active ? '' : 'strike'}`}>{p.name}</div>
                        <div className="cell-sub mono">
                          {p.sku}
                          {p.retailerId !== p.sku && <> · catalogue {p.retailerId}</>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num" data-label="Price">{inr(p.pricePaise)}</td>
                  <td className="num" data-label="Stock">
                    <StockInput product={p} onSave={(stock) => update(p, { stock }, `${p.name}: stock set to ${stock}`)} />
                  </td>
                  <td className="num muted" data-label="GST">{p.gstRateBps / 100}%</td>
                  <td className="num muted" data-label="Weight">{p.weightGrams} g</td>
                  <td data-label="Status">
                    <button className="btn-link" onClick={() => update(p, { active: !p.active }, `${p.name} ${p.active ? 'deactivated' : 'activated'}`)}>
                      {p.active ? <span className="tag">Active</span> : <span className="tag warn">Inactive</span>}
                    </button>
                  </td>
                  <td className="num product-actions" data-label="Actions">
                    <button className="btn-link" onClick={() => setEditing(p)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {products?.length === 0 && <div className="empty">No products found.</div>}
          {!products && <div className="empty">Loading products…</div>}
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onPage={setPage} />
      </div>

      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            toast(`${saved.name} saved`);
            load();
          }}
        />
      )}
    </>
  );
}

function StockInput({ product, onSave }: { product: Product; onSave: (stock: number) => Promise<boolean> }) {
  const [value, setValue] = useState(String(product.stock));
  useEffect(() => setValue(String(product.stock)), [product.stock]);

  const commit = async () => {
    // An empty field is not 0 – someone clearing it to retype must not wipe the stock.
    const stock = value.trim() === '' ? NaN : Number(value);
    if (!Number.isInteger(stock) || stock < 0) {
      setValue(String(product.stock));
      return;
    }
    if (stock !== product.stock && !(await onSave(stock))) setValue(String(product.stock));
  };

  return (
    <input
      className={`input input-sm num ${product.stock === 0 ? 'strike' : ''}`}
      style={{ width: 80 }}
      type="number"
      min={0}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setValue(String(product.stock));
      }}
      aria-label={`Stock for ${product.name}`}
    />
  );
}

function ProductForm({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: (p: Product) => void }) {
  const [form, setForm] = useState({
    sku: product?.sku ?? '',
    retailerId: product?.retailerId ?? '',
    name: product?.name ?? '',
    imageUrl: product?.imageUrl ?? '',
    price: product ? rupeesInput(product.pricePaise) : '',
    stock: String(product?.stock ?? 0),
    gst: String((product?.gstRateBps ?? 300) / 100),
    hsnCode: product?.hsnCode ?? '7117',
    weightGrams: String(product?.weightGrams ?? 100),
    lengthCm: String(product?.lengthCm ?? 10),
    breadthCm: String(product?.breadthCm ?? 10),
    heightCm: String(product?.heightCm ?? 5),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [key]: e.target.value });
    setError(null); // an old message would point at a field that's already been fixed
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pricePaise = parseRupees(form.price);
    if (pricePaise === null) return setError('Enter a valid price, e.g. 649');
    const numbers = { stock: form.stock, gst: form.gst, weight: form.weightGrams, length: form.lengthCm, breadth: form.breadthCm, height: form.heightCm };
    const blank = Object.entries(numbers).find(([, v]) => v.trim() === '' || !Number.isFinite(Number(v)));
    if (blank) return setError(`Enter a number for ${blank[0] === 'gst' ? 'GST %' : blank[0]}`);
    const input: Partial<ProductInput> = {
      sku: form.sku.trim(),
      retailerId: form.retailerId.trim() || undefined,
      name: form.name.trim(),
      imageUrl: form.imageUrl.trim() || null,
      pricePaise,
      stock: Number(form.stock),
      gstRateBps: Math.round(Number(form.gst) * 100),
      hsnCode: form.hsnCode.trim() || null,
      weightGrams: Number(form.weightGrams),
      lengthCm: Number(form.lengthCm),
      breadthCm: Number(form.breadthCm),
      heightCm: Number(form.heightCm),
    };
    setBusy(true);
    setError(null);
    try {
      // Editing sends only what changed: stock in particular moves with every sale, and writing
      // back the number this dialog was opened with would undo those sales.
      const changes = product
        ? (Object.fromEntries(
            Object.entries(input).filter(([k, v]) => (product as unknown as Record<string, unknown>)[k] !== v && !(k === 'retailerId' && v === undefined)),
          ) as Partial<ProductInput>)
        : input;
      if (product && Object.keys(changes).length === 0) return onSaved(product);
      const { product: saved } = product ? await api.updateProduct(product.id, changes) : await api.createProduct(input);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={product ? `Edit ${product.name}` : 'Add product'} onClose={onClose}>
      <form className="stack" style={{ gap: 12, marginTop: 12 }} onSubmit={submit}>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input id="p-name" className="input" required value={form.name} onChange={set('name')} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="p-image">Image URL</label>
          <input id="p-image" className="input" type="url" placeholder="https://queziva.com/catalogue/SKU.jpg" value={form.imageUrl} onChange={set('imageUrl')} />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="p-sku">SKU</label>
            <input id="p-sku" className="input mono" required value={form.sku} onChange={set('sku')} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="p-rid">Catalogue ID</label>
            <input id="p-rid" className="input mono" placeholder="Same as SKU" value={form.retailerId} onChange={set('retailerId')} />
          </div>
        </div>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="p-price">Price (₹)</label>
            <input id="p-price" className="input" inputMode="decimal" required value={form.price} onChange={set('price')} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="p-stock">Stock</label>
            <input id="p-stock" className="input" type="number" min={0} required value={form.stock} onChange={set('stock')} />
          </div>
          <div className="field" style={{ width: 80 }}>
            <label htmlFor="p-gst">GST %</label>
            <input id="p-gst" className="input" inputMode="decimal" value={form.gst} onChange={set('gst')} />
          </div>
          <div className="field" style={{ width: 90 }}>
            <label htmlFor="p-hsn">HSN</label>
            <input id="p-hsn" className="input" value={form.hsnCode} onChange={set('hsnCode')} />
          </div>
        </div>
        <div className="field">
          <label>Packed weight (g) and box size (cm) – used for Shiprocket rates</label>
          <div className="row">
            <input className="input" style={{ width: 90 }} type="number" min={1} value={form.weightGrams} onChange={set('weightGrams')} aria-label="Weight in grams" />
            <input className="input" style={{ width: 70 }} type="number" min={1} value={form.lengthCm} onChange={set('lengthCm')} aria-label="Length" />
            ×
            <input className="input" style={{ width: 70 }} type="number" min={1} value={form.breadthCm} onChange={set('breadthCm')} aria-label="Breadth" />
            ×
            <input className="input" style={{ width: 70 }} type="number" min={1} value={form.heightCm} onChange={set('heightCm')} aria-label="Height" />
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save product'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
