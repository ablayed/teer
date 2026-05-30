import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(hmacHeader, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
