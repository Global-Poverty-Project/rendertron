'use strict';

export const BASIC_AUTH_HEADER = 'x-rendertron-basic-auth';
export const BASIC_AUTH_ORIGINS_ENV = 'RENDER_BASIC_AUTH_ORIGINS';
export const INVALID_HEADER_BODY = 'invalid X-Rendertron-Basic-Auth header';
export const ORIGIN_NOT_ALLOWED_BODY =
  'X-Rendertron-Basic-Auth is not allowed for this origin';

const MIN_TOKEN_LENGTH = 4;
const MAX_TOKEN_LENGTH = 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type BasicAuthOrigins = {
  origins: string[];
  invalidCount: number;
};

export function originOf(href: string): string | null {
  try {
    return new URL(href).origin;
  } catch (err) {
    return null;
  }
}

export function parseBasicAuthOrigins(raw: string | undefined): BasicAuthOrigins {
  const origins: string[] = [];
  let invalidCount = 0;
  for (const part of (raw || '').split(',')) {
    const entry = part.trim();
    if (!entry) {
      continue;
    }
    if (originOf(entry) === entry) {
      origins.push(entry);
    } else {
      invalidCount++;
    }
  }
  return { origins, invalidCount };
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function parseBasicAuthHeader(value: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length < MIN_TOKEN_LENGTH ||
    value.length > MAX_TOKEN_LENGTH ||
    value.length % 4 !== 0 ||
    !TOKEN_PATTERN.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    return null;
  }
  const text = decoded.toString('utf8');
  if (text.indexOf(':') < 1 || hasControlCharacter(text)) {
    return null;
  }
  return value;
}
