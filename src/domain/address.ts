import type { ParsedAddress } from '../integrations/whatsapp/webhook.js';

/** A validated Indian delivery address, as stored on the order. */
export interface DeliveryAddress {
  name: string;
  /** 10-digit Indian mobile number */
  phone: string;
  /** House / flat number, floor, tower, building */
  house: string;
  /** Street / area / locality */
  street: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
}

/**
 * Validation errors keyed by the WhatsApp address_message field names, so the form can be
 * re-sent with the problems highlighted next to the right fields.
 */
export type AddressErrors = Partial<Record<'name' | 'phone_number' | 'in_pin_code' | 'house_number' | 'address' | 'city' | 'state', string>>;

/** Normalises Indian mobile numbers: +91 98765 43210 / 09876543210 / 919876543210 → 9876543210 */
export function normaliseIndianMobile(input: string | undefined): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

export function isValidPincode(pincode: string | undefined): boolean {
  return /^[1-9]\d{5}$/.test(pincode ?? '');
}

const clean = (value: string | undefined, max = 200) => value?.replace(/\s+/g, ' ').trim().slice(0, max) || undefined;

export interface AddressFields {
  name?: string;
  phone?: string;
  house?: string;
  street?: string;
  landmark?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export function validateAddress(fields: AddressFields): { address?: DeliveryAddress; errors: AddressErrors } {
  const errors: AddressErrors = {};
  const name = clean(fields.name, 100);
  const phone = normaliseIndianMobile(fields.phone);
  const house = clean(fields.house);
  const street = clean(fields.street, 300);
  const city = clean(fields.city, 100);
  const state = clean(fields.state, 100);
  const pincode = fields.pincode?.replace(/\s/g, '');

  if (!name || name.length < 2) errors.name = 'Please enter the full name of the person receiving the parcel';
  if (!phone) errors.phone_number = 'Please enter a valid 10-digit mobile number';
  if (!house) errors.house_number = 'Please enter your house / flat number';
  if (!street) errors.address = 'Please enter your street or area';
  if (!city) errors.city = 'Please enter your city';
  if (!state) errors.state = 'Please enter your state';
  if (!isValidPincode(pincode)) errors.in_pin_code = 'Please enter a valid 6-digit pincode';

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    address: { name: name!, phone: phone!, house: house!, street: street!, landmark: clean(fields.landmark), city: city!, state: state!, pincode: pincode! },
  };
}

/** Maps the WhatsApp native address form reply onto our address fields. */
export function fromWhatsAppAddress(parsed: ParsedAddress): AddressFields {
  const house = [
    parsed.houseNumber,
    parsed.floorNumber && `Floor ${parsed.floorNumber}`,
    parsed.towerNumber && `Tower ${parsed.towerNumber}`,
    parsed.buildingName,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    name: parsed.name,
    phone: parsed.phoneNumber,
    house: house || undefined,
    street: parsed.address,
    landmark: parsed.landmarkArea,
    city: parsed.city,
    state: parsed.state,
    pincode: parsed.pincode,
  };
}

export function formatAddress(a: DeliveryAddress): string {
  return [a.name, a.house, a.street, a.landmark, `${a.city}, ${a.state} ${a.pincode}`, `📞 ${a.phone}`].filter(Boolean).join('\n');
}
