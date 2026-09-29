import type {
  AddressInput,
  Admin,
  OrderDetail,
  OrderList,
  OrderStatus,
  OrderSummary,
  Product,
  ProductInput,
  Settings,
  ShippingOptions,
  SimulatorState,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const unauthenticatedListeners = new Set<() => void>();

/** Called whenever the server says the session is gone, so the app can show the sign-in screen. */
export function onUnauthenticated(listener: () => void): () => void {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, 'NETWORK');
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const error = json?.error ?? {};
    if (res.status === 401 && !path.startsWith('/auth/login')) unauthenticatedListeners.forEach((l) => l());
    throw new ApiError(error.message ?? `Request failed (${res.status})`, res.status, error.code ?? 'ERROR');
  }
  return json as T;
}

async function uploadProductImage(file: File): Promise<{ imageUrl: string }> {
  let res: Response;
  try {
    res = await fetch('/api/admin/product-images', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type },
      body: file,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0, 'NETWORK');
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const error = json?.error ?? {};
    if (res.status === 401) unauthenticatedListeners.forEach((listener) => listener());
    throw new ApiError(error.message ?? `Upload failed (${res.status})`, res.status, error.code ?? 'ERROR');
  }
  return json as { imageUrl: string };
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== false) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const api = {
  login: (email: string, password: string) => request<{ admin: Admin }>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  me: () => request<{ admin: Admin; simulator: boolean }>('GET', '/auth/me'),

  orders: (p: { statuses?: OrderStatus[]; q?: string; stockIssues?: boolean; page?: number }) =>
    request<OrderList>(
      'GET',
      `/orders${qs({ status: p.statuses?.join(','), q: p.q, stockIssues: p.stockIssues ? 1 : undefined, page: p.page })}`,
    ),
  summary: () => request<OrderSummary>('GET', '/orders/summary'),
  order: (id: string) => request<OrderDetail>('GET', `/orders/${id}`),

  setQuantity: (o: OrderDetail, itemId: string, quantity: number) =>
    request<OrderDetail>('PATCH', `/orders/${o.id}/items/${itemId}`, { expectedVersion: o.version, quantity }),
  removeItem: (o: OrderDetail, itemId: string) =>
    request<OrderDetail>('POST', `/orders/${o.id}/items/${itemId}/remove`, { expectedVersion: o.version }),
  addItem: (o: OrderDetail, productId: string, quantity: number) =>
    request<OrderDetail>('POST', `/orders/${o.id}/items`, { expectedVersion: o.version, productId, quantity }),
  replaceItem: (o: OrderDetail, itemId: string, productId: string) =>
    request<OrderDetail>('POST', `/orders/${o.id}/items/${itemId}/replace`, { expectedVersion: o.version, productId }),
  setDiscount: (o: OrderDetail, discountPaise: number, reason?: string) =>
    request<OrderDetail>('PUT', `/orders/${o.id}/discount`, { expectedVersion: o.version, discountPaise, reason }),
  shippingOptions: (o: OrderDetail) => request<ShippingOptions>('GET', `/orders/${o.id}/shipping-options`),
  setCourier: (o: OrderDetail, courierId: number) =>
    request<OrderDetail>('PUT', `/orders/${o.id}/shipping`, { expectedVersion: o.version, courierId }),
  setManualShipping: (o: OrderDetail, manualChargePaise: number, reason: string) =>
    request<OrderDetail>('PUT', `/orders/${o.id}/shipping`, { expectedVersion: o.version, manualChargePaise, reason }),
  setAddress: (o: OrderDetail, address: AddressInput) =>
    request<OrderDetail>('PUT', `/orders/${o.id}/address`, { expectedVersion: o.version, ...address }),
  closeUndelivered: (o: OrderDetail, input: { reason: string; restock: boolean; refund: boolean }) =>
    request<OrderDetail>('POST', `/orders/${o.id}/close`, { expectedVersion: o.version, ...input }),
  testPayment: (o: OrderDetail, outcome: 'captured' | 'failed') =>
    request<OrderDetail>('POST', `/orders/${o.id}/test-payment`, { outcome }),
  addNote: (o: OrderDetail, note: string) => request<OrderDetail>('POST', `/orders/${o.id}/notes`, { note }),
  action: (o: OrderDetail, action: string, reason?: string) =>
    request<OrderDetail>('POST', `/orders/${o.id}/actions/${action}`, { expectedVersion: o.version, reason }),

  sim: {
    state: (waId: string) => request<SimulatorState>('GET', `/simulator?waId=${waId}`),
    cart: (waId: string, name: string, items: { retailerId: string; quantity: number }[]) =>
      request<SimulatorState>('POST', '/simulator/cart', { waId, name, items }),
    text: (waId: string, text: string) => request<SimulatorState>('POST', '/simulator/text', { waId, text }),
    button: (waId: string, id: string, title: string, onTemplate: boolean) =>
      request<SimulatorState>('POST', '/simulator/button', { waId, id, title, onTemplate }),
    address: (waId: string, values: Record<string, string>) => request<SimulatorState>('POST', '/simulator/address', { waId, values }),
    pay: (waId: string, outcome: 'captured' | 'failed') => request<SimulatorState>('POST', '/simulator/pay', { waId, outcome }),
    courier: (waId: string, status: string) => request<SimulatorState>('POST', '/simulator/courier', { waId, status }),
    fastForward: (waId: string, hours: number) => request<SimulatorState>('POST', '/simulator/fast-forward', { waId, hours }),
  },

  settings: () => request<{ settings: Settings }>('GET', '/settings'),
  saveSettings: (s: Settings) => request<{ settings: Settings }>('PUT', '/settings', s),

  products: (p: { q?: string; includeInactive?: boolean } = {}) =>
    request<{ products: Product[] }>('GET', `/products${qs({ q: p.q, includeInactive: p.includeInactive ? 1 : undefined })}`),
  uploadProductImage,
  createProduct: (input: Partial<ProductInput>) => request<{ product: Product }>('POST', '/products', input),
  updateProduct: (id: string, input: Partial<ProductInput>) => request<{ product: Product }>('PATCH', `/products/${id}`, input),
};
