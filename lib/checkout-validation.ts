export type DeliveryFields = { name: string; phone: string; email: string; pin: string; line1: string; city: string; state: string };
export type DeliveryField = keyof DeliveryFields;

export const DELIVERY_FIELD_ORDER: DeliveryField[] = ['name', 'phone', 'email', 'pin', 'line1', 'city', 'state'];

/** Strips a leading +91 / 91 / 0 so only the 10-digit national number remains. */
export const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
};

const letters = (value: string) => (value.match(/\p{L}/gu) ?? []).length;

/** Returns an inline error message, or '' when the value is acceptable. Deliberately permissive: the server schema stays authoritative. */
export function validateDeliveryField(field: DeliveryField, raw: string): string {
  const value = raw.trim();
  switch (field) {
    case 'name':
      if (!value) return 'Enter your full name.';
      if (value.length < 2 || letters(value) < 2) return 'Name must be at least 2 letters.';
      if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]*$/u.test(value)) return 'Use letters, spaces, apostrophes, hyphens or dots only.';
      return '';
    case 'phone':
      if (!value) return 'Enter your mobile number.';
      return /^[6-9]\d{9}$/.test(normalizePhone(value)) ? '' : 'Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9.';
    case 'email':
      if (!value) return 'Enter your email address.';
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && value.length <= 254 ? '' : 'Enter a valid email address, e.g. name@example.com.';
    case 'pin':
      if (!value) return 'Enter your pincode.';
      return /^[1-9]\d{5}$/.test(value) ? '' : 'Enter a valid 6-digit pincode.';
    case 'line1':
      if (!value) return 'Enter your delivery address.';
      return value.length < 5 ? 'Address looks too short. Add house / flat and street.' : '';
    case 'city':
    case 'state': {
      const label = field === 'city' ? 'city' : 'state';
      if (!value) return `Enter your ${label}.`;
      return value.length < 2 || letters(value) < 2 ? `Enter a valid ${label}.` : '';
    }
  }
}

export function validateDelivery(values: DeliveryFields): Partial<Record<DeliveryField, string>> {
  const errors: Partial<Record<DeliveryField, string>> = {};
  for (const field of DELIVERY_FIELD_ORDER) {
    const message = validateDeliveryField(field, values[field]);
    if (message) errors[field] = message;
  }
  return errors;
}
