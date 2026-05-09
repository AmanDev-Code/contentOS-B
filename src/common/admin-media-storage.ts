import { HttpException, HttpStatus } from '@nestjs/common';

/** All admin browser and CMS-targeted uploads live under this prefix. */
export const ADMIN_MEDIA_ROOT = 'media/cms/';

export type AdminMediaBrowseScope = 'bucket' | 'cms';

export function parseAdminMediaBrowseScope(
  raw: string | undefined,
): AdminMediaBrowseScope {
  const s = (raw || '').trim().toLowerCase();
  if (s === 'cms') return 'cms';
  return 'bucket';
}

export function sanitizeSegment(segment: string): string {
  return segment
    .replace(/[^\w.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Validates relative path segments; returns normalized `a/b` or `` for root.
 */
export function normalizeCmsRelativePath(relativePath: string): string {
  const raw = (relativePath || '').trim().replace(/^\/+/, '');
  if (!raw) {
    return '';
  }
  const parts = raw.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '..' || p === '.') {
      throw new HttpException('Invalid path', HttpStatus.BAD_REQUEST);
    }
    if (!/^[\w.-]+$/.test(p)) {
      throw new HttpException('Invalid path segment', HttpStatus.BAD_REQUEST);
    }
  }
  return parts.join('/');
}

/**
 * Relative path from bucket root for browsing (no leading slash).
 * Rejects traversal; permissive segments so existing object keys remain reachable.
 */
export function normalizeBucketRelativePath(relativePath: string): string {
  const raw = (relativePath || '').trim().replace(/^\/+/, '');
  if (!raw) {
    return '';
  }
  const parts = raw.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '..' || p === '.') {
      throw new HttpException('Invalid path', HttpStatus.BAD_REQUEST);
    }
    if (p.includes('\\') || p.includes('\0')) {
      throw new HttpException('Invalid path segment', HttpStatus.BAD_REQUEST);
    }
  }
  return parts.join('/');
}

/**
 * Prefix for listObjects under the current folder (always ends with `/`).
 */
export function resolveAdminMediaListingPrefix(relativePath: string): string {
  const norm = normalizeCmsRelativePath(relativePath);
  if (!norm) {
    return ADMIN_MEDIA_ROOT;
  }
  return `${ADMIN_MEDIA_ROOT}${norm}/`;
}

/** Listing prefix for one-level browse (`''` at bucket root). */
export function resolveBrowseListingPrefix(
  scope: AdminMediaBrowseScope,
  relativePath: string,
): string {
  if (scope === 'cms') {
    return resolveAdminMediaListingPrefix(relativePath);
  }
  const norm = normalizeBucketRelativePath(relativePath);
  if (!norm) {
    return '';
  }
  return `${norm}/`;
}

/** Display path for API (`path` query ↔ breadcrumbs); trailing slashes stripped. */
export function browseListingPrefixToRelativePath(
  scope: AdminMediaBrowseScope,
  listingPrefix: string,
): string {
  if (scope === 'cms') {
    return listingPrefixToRelativePath(listingPrefix);
  }
  return listingPrefix.replace(/\/+$/, '');
}

/** Platform admin may delete any object key; blocks traversal-only attacks. */
export function assertValidAdminDeletableObjectKey(key: string): void {
  if (!key || typeof key !== 'string') {
    throw new HttpException('key required', HttpStatus.BAD_REQUEST);
  }
  if (key.includes('..') || key.includes('\0')) {
    throw new HttpException('Invalid key', HttpStatus.BAD_REQUEST);
  }
}

/** Full object key must start with this prefix (folders may end with `/`). */
export function assertKeyUnderAdminMediaRoot(key: string): void {
  if (!key || typeof key !== 'string') {
    throw new HttpException('key required', HttpStatus.BAD_REQUEST);
  }
  if (key.includes('..')) {
    throw new HttpException('Invalid key', HttpStatus.BAD_REQUEST);
  }
  if (!key.startsWith(ADMIN_MEDIA_ROOT)) {
    throw new HttpException(
      'Key outside admin media root',
      HttpStatus.FORBIDDEN,
    );
  }
}

/** Relative folder path for API consumers (no leading slash, no trailing). */
export function listingPrefixToRelativePath(listingPrefix: string): string {
  if (!listingPrefix.startsWith(ADMIN_MEDIA_ROOT)) {
    return '';
  }
  const rest = listingPrefix.slice(ADMIN_MEDIA_ROOT.length);
  return rest.replace(/\/+$/, '');
}

export function buildAdminCmsObjectKey(
  relativePath: string,
  filename: string,
): string {
  const norm = normalizeCmsRelativePath(relativePath);
  const base = norm ? `${ADMIN_MEDIA_ROOT}${norm}/` : ADMIN_MEDIA_ROOT;
  return `${base}${filename}`;
}
