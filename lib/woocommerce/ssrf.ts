// R2.4 / commit 3 — garde SSRF WooCommerce.
//
// Pur et injectable : aucun env, Supabase ou Server Action. La résolution
// complète précède chaque appel et la connexion reçoit une adresse déjà validée.

import { lookup } from 'node:dns/promises';
import { WooCommerceUrlError, parseWooCommerceRequestUrl } from '@/lib/woocommerce/url';

export const WOO_MAX_REDIRECTS = 3;
export const WOO_REQUEST_TIMEOUT_MS = 10_000;
export const WOO_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;

export type ResolvedAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type PinnedHttpsTarget = {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  readonly address: ResolvedAddress;
};

export type WooCommerceSsrfErrorCode = 'ssrf_rejected' | 'dns_failed';

export class WooCommerceSsrfError extends Error {
  readonly code: WooCommerceSsrfErrorCode;

  constructor(code: WooCommerceSsrfErrorCode = 'ssrf_rejected') {
    super(code);
    this.name = 'WooCommerceSsrfError';
    this.code = code;
  }
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split('.');

  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }

  return octets.reduce((result, octet) => result * 256 + octet, 0);
}

function inIpv4Range(value: number, start: string, end: string): boolean {
  const first = ipv4ToNumber(start);
  const last = ipv4ToNumber(end);
  return first !== null && last !== null && value >= first && value <= last;
}

function isForbiddenIpv4(value: string): boolean {
  const number = ipv4ToNumber(value);
  if (number === null) {
    return true;
  }

  return [
    ['0.0.0.0', '0.255.255.255'],
    ['10.0.0.0', '10.255.255.255'],
    ['100.64.0.0', '100.127.255.255'],
    ['127.0.0.0', '127.255.255.255'],
    ['169.254.0.0', '169.254.255.255'],
    ['172.16.0.0', '172.31.255.255'],
    ['192.0.0.0', '192.0.0.255'],
    ['192.0.2.0', '192.0.2.255'],
    ['192.88.99.0', '192.88.99.255'],
    ['192.168.0.0', '192.168.255.255'],
    ['198.18.0.0', '198.19.255.255'],
    ['198.51.100.0', '198.51.100.255'],
    ['203.0.113.0', '203.0.113.255'],
    ['224.0.0.0', '255.255.255.255'],
  ].some(([start, end]) => inIpv4Range(number, start, end));
}

function expandIpv6(value: string): string[] | null {
  if (value.includes('%')) {
    return null;
  }

  const [left, right, ...extra] = value.split('::');
  if (extra.length > 0) {
    return null;
  }

  const expandPart = (part: string): string[] => {
    if (!part) {
      return [];
    }

    const pieces = part.split(':');
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/i.test(piece))) {
      return [];
    }

    return pieces;
  };

  const leftParts = expandPart(left);
  const rightParts = right === undefined ? [] : expandPart(right);
  if ((!left && !right) || (leftParts.length === 0 && left !== '')) {
    return null;
  }

  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < (right === undefined ? 0 : 1)) {
    return null;
  }

  return [...leftParts, ...Array.from({ length: missing }, () => '0'), ...rightParts];
}

function ipv6ToBigInt(value: string): bigint | null {
  const embeddedIpv4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  const normalized = embeddedIpv4
    ? `${embeddedIpv4[1]}${Math.floor((ipv4ToNumber(embeddedIpv4[2]) ?? -1) / 65536).toString(16)}:${(
        (ipv4ToNumber(embeddedIpv4[2]) ?? -1) % 65536
      ).toString(16)}`
    : value;
  const groups = expandIpv6(normalized);
  if (!groups || groups.length !== 8) {
    return null;
  }

  return groups.reduce((result, group) => (result << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function inIpv6Range(value: bigint, prefix: bigint, bits: number): boolean {
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return (value & mask) === prefix;
}

function isForbiddenIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  const number = ipv6ToBigInt(normalized);
  if (number === null) {
    return true;
  }

  const mappedPrefix = 0xffffn;
  if (number >> 32n === mappedPrefix) {
    const mappedIpv4 = Number(number & 0xffffffffn);
    const octets = [
      (mappedIpv4 >>> 24) & 0xff,
      (mappedIpv4 >>> 16) & 0xff,
      (mappedIpv4 >>> 8) & 0xff,
      mappedIpv4 & 0xff,
    ].join('.');
    if (isForbiddenIpv4(octets)) {
      return true;
    }
  }

  return (
    number === 0n ||
    number === 1n ||
    inIpv6Range(number, 0xfc000000000000000000000000000000n, 7) ||
    inIpv6Range(number, 0xfe800000000000000000000000000000n, 10) ||
    inIpv6Range(number, 0xff000000000000000000000000000000n, 8) ||
    inIpv6Range(number, 0x20010db8000000000000000000000000n, 32) ||
    inIpv6Range(number, 0x20010000000000000000000000000000n, 23)
  );
}

export function isForbiddenAddress(value: string, family: 4 | 6): boolean {
  return family === 4 ? isForbiddenIpv4(value) : isForbiddenIpv6(value);
}

export async function resolveAllAddresses(hostname: string): Promise<readonly ResolvedAddress[]> {
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
  } catch {
    throw new WooCommerceSsrfError('dns_failed');
  }
}

function hostnameForLookup(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Résout toutes les adresses, refuse l'ensemble si une seule est interdite, puis en épingle une. */
export async function validateAndPinHttpsTarget(
  input: string | URL,
  resolver: DnsResolver = resolveAllAddresses,
): Promise<PinnedHttpsTarget> {
  let url: URL;

  try {
    url = parseWooCommerceRequestUrl(String(input));
  } catch (error) {
    if (error instanceof WooCommerceUrlError) {
      throw new WooCommerceSsrfError();
    }
    throw new WooCommerceSsrfError();
  }

  const hostname = hostnameForLookup(url);
  if (!hostname || hostname.includes('%')) {
    throw new WooCommerceSsrfError();
  }

  const resolverHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(resolverHostname);
  } catch (error) {
    if (error instanceof WooCommerceSsrfError) {
      throw error;
    }
    throw new WooCommerceSsrfError('dns_failed');
  }
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) =>
        (address.family !== 4 && address.family !== 6) ||
        isForbiddenAddress(address.address, address.family),
    )
  ) {
    throw new WooCommerceSsrfError();
  }

  const address = addresses[0];
  return {
    url,
    hostname,
    port: Number(url.port || 443),
    address,
  };
}
