import { randomInt } from 'node:crypto';
import { NotFoundError } from '../../lib/errors.js';
import { safeEqual } from '../../lib/signature.js';
import type {
  AwbAssignment,
  CourierOption,
  CreateShipmentRequest,
  CreatedShipment,
  RateQuoteRequest,
  ShiprocketClient,
  TrackingInfo,
} from './types.js';

export const MOCK_SHIPROCKET_WEBHOOK_TOKEN = 'mock_shiprocket_webhook_token';

/** Chargeable weight: max(actual, volumetric) where volumetric = L×B×H / 5000 (kg). */
export function chargeableWeightKg(r: Pick<RateQuoteRequest, 'weightKg' | 'lengthCm' | 'breadthCm' | 'heightCm'>) {
  return Math.max(r.weightKg, (r.lengthCm * r.breadthCm * r.heightCm) / 5000);
}

/** Test pincodes: no courier delivers here in the mock. */
export const MOCK_UNSERVICEABLE_PINCODE = '744101';
/** Test pincode: the mock behaves as if the Shiprocket API is down. */
export const MOCK_API_DOWN_PINCODE = '999999';

/**
 * Deterministic stand-in for Shiprocket. Rates depend on zone (how similar the pincodes are)
 * and 500 g weight slabs, roughly like real surface/air pricing. See the MOCK_* pincodes above
 * for the "not serviceable" and "API down" paths.
 */
export class MockShiprocketClient implements ShiprocketClient {
  readonly mode = 'mock' as const;
  readonly orders = new Map<string, CreateShipmentRequest & CreatedShipment & Partial<AwbAssignment>>();

  async getRates(r: RateQuoteRequest): Promise<CourierOption[]> {
    if (r.deliveryPincode === MOCK_API_DOWN_PINCODE) throw new Error('Shiprocket is not responding (mock)');
    if (!/^[1-9]\d{5}$/.test(r.deliveryPincode) || r.deliveryPincode === MOCK_UNSERVICEABLE_PINCODE) return [];

    const zone =
      r.pickupPincode.slice(0, 3) === r.deliveryPincode.slice(0, 3)
        ? { base: 4000, perSlab: 2000, etd: 2 }
        : r.pickupPincode[0] === r.deliveryPincode[0]
          ? { base: 5500, perSlab: 3000, etd: 4 }
          : { base: 7000, perSlab: 4000, etd: 6 };

    const slabs = Math.max(1, Math.ceil(chargeableWeightKg(r) / 0.5));
    const surface = zone.base + (slabs - 1) * zone.perSlab;

    const options: CourierOption[] = [
      { courierId: 101, courierName: 'Delhivery Surface (mock)', ratePaise: surface, etdDays: zone.etd, rating: 4.1, recommended: false },
      {
        courierId: 102,
        courierName: 'Blue Dart Air (mock)',
        ratePaise: Math.round((surface * 1.6) / 100) * 100,
        etdDays: Math.max(1, zone.etd - 2),
        rating: 4.6,
        recommended: true,
      },
    ];
    return options.sort((a, b) => a.ratePaise - b.ratePaise);
  }

  async createOrder(request: CreateShipmentRequest): Promise<CreatedShipment> {
    const created = {
      shiprocketOrderId: String(randomInt(100_000_000, 999_999_999)),
      shipmentId: String(randomInt(100_000_000, 999_999_999)),
    };
    this.orders.set(created.shipmentId, { ...request, ...created });
    return created;
  }

  async assignAwb(shipmentId: string, courierId = 101): Promise<AwbAssignment> {
    const order = this.orders.get(shipmentId);
    if (!order) throw new NotFoundError('Shiprocket shipment', shipmentId);
    const assignment: AwbAssignment = {
      awb: `MOCK${randomInt(10_000_000, 99_999_999)}`,
      courierId,
      courierName: courierId === 102 ? 'Blue Dart Air (mock)' : 'Delhivery Surface (mock)',
    };
    Object.assign(order, assignment);
    return assignment;
  }

  async requestPickup(shipmentId: string): Promise<void> {
    if (!this.orders.has(shipmentId)) throw new NotFoundError('Shiprocket shipment', shipmentId);
  }

  readonly cancelled: string[] = [];
  readonly manifests: string[] = [];

  async generateManifest(shipmentId: string): Promise<void> {
    if (!this.orders.has(shipmentId)) throw new NotFoundError('Shiprocket shipment', shipmentId);
    this.manifests.push(shipmentId);
  }

  async cancelOrder(shiprocketOrderId: string): Promise<void> {
    const exists = [...this.orders.values()].some((o) => o.shiprocketOrderId === shiprocketOrderId);
    if (!exists) throw new NotFoundError('Shiprocket order', shiprocketOrderId);
    this.cancelled.push(shiprocketOrderId);
  }

  async track(awb: string): Promise<TrackingInfo> {
    return {
      awb,
      currentStatus: 'AWB ASSIGNED',
      trackingUrl: `https://shiprocket.co/tracking/${awb}`,
      events: [{ status: 'AWB ASSIGNED', location: null, at: new Date() }],
    };
  }

  verifyWebhookToken(token: string | undefined): boolean {
    return safeEqual(token, MOCK_SHIPROCKET_WEBHOOK_TOKEN);
  }

  reset() {
    this.orders.clear();
  }
}
