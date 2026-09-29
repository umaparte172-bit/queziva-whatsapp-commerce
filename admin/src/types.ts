export type OrderStatus =
  | 'NEW'
  | 'PENDING_REVIEW'
  | 'MODIFIED'
  | 'AWAITING_CUSTOMER_APPROVAL'
  | 'AWAITING_ADDRESS'
  | 'READY_FOR_PAYMENT'
  | 'PAYMENT_REQUESTED'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Admin {
  id: string;
  email: string;
  name: string;
}

export interface OrderListItem {
  id: string;
  requestNumber: string;
  orderNumber: string | null;
  status: OrderStatus;
  version: number;
  customer: { name: string | null; waId: string };
  itemsSummary: string;
  itemImages: { name: string; imageUrl: string | null }[];
  itemCount: number;
  totalPaise: number;
  modified: boolean;
  stockIssue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrderList {
  total: number;
  page: number;
  pageSize: number;
  orders: OrderListItem[];
}

export interface OrderSummary {
  counts: Partial<Record<OrderStatus, number>>;
  stockIssues: number;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  sku: string;
  retailerId: string;
  name: string;
  imageUrl: string | null;
  unitPricePaise: number;
  gstRateBps: number;
  requestedQuantity: number;
  quantity: number;
  addedByAdmin: boolean;
  removed: boolean;
  replacesItemId: string | null;
  availableStock: number | null;
  productActive: boolean;
  stockIssue: boolean;
}

export interface OrderEvent {
  id: string;
  type: string;
  actor: 'SYSTEM' | 'ADMIN' | 'CUSTOMER';
  actorRef: string | null;
  actorName: string | null;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  message: string | null;
  data: { kind?: string; imageUrl?: string } | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  referenceId: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  status: string;
  method: string | null;
  verifiedAt: string | null;
  failureReason: string | null;
  refundedPaise: number;
  razorpayRefundId: string | null;
  createdAt: string;
}

export interface Shipment {
  id: string;
  shiprocketOrderId: string | null;
  shiprocketShipmentId: string | null;
  courierName: string | null;
  awb: string | null;
  trackingUrl: string | null;
  currentStatus: string | null;
  lastEventAt: string | null;
  pickupRequestedAt: string | null;
  notifiedMilestones: string[] | null;
}

export interface OrderAction {
  id:
    | 'start_review'
    | 'approve'
    | 'resend'
    | 'quote_shipping'
    | 'request_payment'
    | 'withdraw_payment'
    | 'create_shipment'
    | 'refresh_tracking'
    | 'mark_delivered'
    | 'retry_refund'
    | 'close_undelivered'
    | 'cancel';
  label: string;
  tone: 'primary' | 'danger' | 'neutral';
}

export interface OrderDetail {
  id: string;
  requestNumber: string;
  orderNumber: string | null;
  status: OrderStatus;
  version: number;
  customer: { id: string; waId: string; name: string | null; lastInboundAt: string | null };
  customerNote: string | null;
  subtotalPaise: number;
  discountPaise: number;
  discountReason: string | null;
  shippingPaise: number;
  taxPaise: number;
  pricesIncludeGst: boolean;
  totalPaise: number;
  shipName: string | null;
  shipPhone: string | null;
  shipHouse: string | null;
  shipStreet: string | null;
  shipLandmark: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipPincode: string | null;
  shippingCourierId: number | null;
  shippingCourierName: string | null;
  shippingEtdDays: number | null;
  shippingQuotedAt: string | null;
  /** What the courier charges the store */
  shippingCostPaise: number | null;
  shippingNote: string | null;
  packageWeightGrams: number | null;
  cancelReason: string | null;
  createdAt: string;
  items: OrderItem[];
  events: OrderEvent[];
  payments: Payment[];
  shipments: Shipment[];
  modified: boolean;
  stockProblems: { itemId: string; message: string }[];
  permissions: { editItems: boolean; editDiscount: boolean; editAddress: boolean; editShipping: boolean };
  actions: OrderAction[];
  /** Set when the change was saved but something around it failed (e.g. WhatsApp sending) */
  warning?: string;
  /** WhatsApp and Razorpay are mocked – payments can be simulated */
  testMode: boolean;
  paidAt: string | null;
}

export interface CourierOption {
  courierId: number;
  courierName: string;
  ratePaise: number;
  customerChargePaise: number;
  etdDays: number | null;
  rating: number | null;
  recommended: boolean;
}

export interface ShippingOptions {
  package: { weightGrams: number; lengthCm: number; breadthCm: number; heightCm: number };
  options: CourierOption[];
  suggestedCourierId: number | null;
}

export type Milestone = 'SHIPPED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERY_ATTEMPT_FAILED' | 'DELIVERED';

export interface Settings {
  notify: Record<Milestone, boolean>;
  feedback: { enabled: boolean; delayHours: number };
  instagramHandle: string;
  reviewUrl: string;
}

export interface SimMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: string;
  status: string | null;
  error: string | null;
  payload: any;
  createdAt: string;
}

export interface SimulatorState {
  customer: { waId: string; name: string | null } | null;
  customers: { waId: string; name: string | null }[];
  catalog: { retailerId: string; name: string; imageUrl: string | null; pricePaise: number; stock: number }[];
  messages: SimMessage[];
  order: { id: string; requestNumber: string; orderNumber: string | null; status: OrderStatus; awb: string | null; canPay: boolean } | null;
  courierStatuses: string[];
}

export interface AddressInput {
  name: string;
  phone: string;
  house: string;
  street: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface Product {
  id: string;
  sku: string;
  retailerId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  pricePaise: number;
  stock: number;
  gstRateBps: number;
  hsnCode: string | null;
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  active: boolean;
}

export type ProductInput = Omit<Product, 'id'>;
