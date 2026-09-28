export interface RateQuoteRequest {
  pickupPincode: string;
  deliveryPincode: string;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
  declaredValuePaise: number;
  cod: boolean;
}

export interface CourierOption {
  courierId: number;
  courierName: string;
  /** Freight the store pays Shiprocket, in paise */
  ratePaise: number;
  etdDays: number | null;
  rating: number | null;
  /** Shiprocket's own recommendation for this route */
  recommended: boolean;
}

export interface ShipmentItem {
  name: string;
  sku: string;
  units: number;
  sellingPricePaise: number;
  hsn?: string;
  taxRateBps?: number;
}

export interface CreateShipmentRequest {
  orderNumber: string;
  orderDate: Date;
  pickupLocation: string;
  customer: {
    name: string;
    phone: string;
    address: string;
    address2?: string;
    city: string;
    state: string;
    pincode: string;
    email?: string;
  };
  items: ShipmentItem[];
  paymentMethod: 'Prepaid' | 'COD';
  subTotalPaise: number;
  shippingPaise: number;
  discountPaise: number;
  weightKg: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
}

export interface CreatedShipment {
  shiprocketOrderId: string;
  shipmentId: string;
}

export interface AwbAssignment {
  awb: string;
  courierId: number;
  courierName: string;
}

export interface TrackingEvent {
  status: string;
  location: string | null;
  at: Date;
}

export interface TrackingInfo {
  awb: string;
  currentStatus: string;
  trackingUrl: string;
  events: TrackingEvent[];
}

export interface ShiprocketClient {
  readonly mode: 'mock' | 'live';
  /** Courier serviceability + rates, cheapest first */
  getRates(request: RateQuoteRequest): Promise<CourierOption[]>;
  createOrder(request: CreateShipmentRequest): Promise<CreatedShipment>;
  assignAwb(shipmentId: string, courierId?: number): Promise<AwbAssignment>;
  requestPickup(shipmentId: string): Promise<void>;
  /** Generates the pickup manifest for a shipment (Shiprocket asks for it after pickup) */
  generateManifest(shipmentId: string): Promise<void>;
  /** Cancels a Shiprocket order (before pickup) */
  cancelOrder(shiprocketOrderId: string): Promise<void>;
  track(awb: string): Promise<TrackingInfo>;
  verifyWebhookToken(token: string | undefined): boolean;
}
