export type DetectedPcdCategory = 'customer_identity' | 'customer_contact' | 'delivery_address';

const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;
const PHONE_PATTERN = /(?:\+?\d[\s().-]?){8,}/;
const IDENTITY_LABEL_PATTERN = /\b(?:nom|pr[ée]nom)\s*(?:du|de)?\s*(?:client|cliente)?\s*:/i;
const CONTACT_LABEL_PATTERN = /\b(?:t[ée]l[ée]phone|t[ée]l|mobile|whatsapp)\s*:/i;
const ADDRESS_PATTERN = /\b(?:adresse|domicile|quartier|rue|avenue|boulevard|livraison)\b/i;

/**
 * Small deterministic MVP detector. It intentionally covers only explicit
 * labels and common contact/address forms; it is not semantic DLP.
 */
export function detectPcdCategories(text: string): DetectedPcdCategory[] {
  const categories = new Set<DetectedPcdCategory>();

  if (IDENTITY_LABEL_PATTERN.test(text)) {
    categories.add('customer_identity');
  }

  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text) || CONTACT_LABEL_PATTERN.test(text)) {
    categories.add('customer_contact');
  }

  if (ADDRESS_PATTERN.test(text) && /\d|:/.test(text)) {
    categories.add('delivery_address');
  }

  return [...categories];
}
