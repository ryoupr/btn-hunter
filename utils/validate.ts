// インポートファイルの厳密なスキーマ検証 (JSON.parse 済みの値を検証し、安全に再構築して返す)
// 形式: { app: 'btn-locker', format: 1, exportedAt?: string, locks: LockDB, pause: PauseState }

import {
  LIMITS,
  isOriginString,
  type LockDB,
  type LockEntry,
  type PauseState,
} from './storage';

export class ImportError extends Error {
  constructor(public detail: string) {
    super(detail);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertKeys(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ImportError(`${where}: unknown key`);
  }
}

export function validateImport(raw: unknown): { locks: LockDB; pause: PauseState } {
  if (!isPlainObject(raw)) throw new ImportError('root');
  assertKeys(raw, ['app', 'format', 'exportedAt', 'locks', 'pause'], 'root');
  if (raw.app !== 'btn-locker') throw new ImportError('app');
  if (raw.format !== 1) throw new ImportError('format');
  if (raw.exportedAt !== undefined && (typeof raw.exportedAt !== 'string' || raw.exportedAt.length > 64)) {
    throw new ImportError('exportedAt');
  }

  // locks
  if (!isPlainObject(raw.locks)) throw new ImportError('locks');
  const origins = Object.keys(raw.locks);
  if (origins.length > LIMITS.maxOrigins) throw new ImportError('locks: too many origins');
  const locks: LockDB = Object.create(null) as LockDB;
  let total = 0;
  for (const origin of origins) {
    if (!isOriginString(origin)) throw new ImportError('locks: bad origin');
    const list = (raw.locks as Record<string, unknown>)[origin];
    if (!Array.isArray(list)) throw new ImportError(`locks[${origin}]`);
    if (list.length > LIMITS.maxPerOrigin) throw new ImportError(`locks[${origin}]: too many entries`);
    const out: LockEntry[] = [];
    list.forEach((e, i) => {
      const where = `locks[${origin}][${i}]`;
      if (!isPlainObject(e)) throw new ImportError(where);
      assertKeys(e, ['s', 'f', 'n'], where);
      if (typeof e.s !== 'string' || e.s.length === 0 || e.s.length > LIMITS.maxSelector) {
        throw new ImportError(`${where}.s`);
      }
      if (!isOriginString(e.f)) throw new ImportError(`${where}.f`);
      if (typeof e.n !== 'string' || e.n.length > LIMITS.maxName) throw new ImportError(`${where}.n`);
      out.push({ s: e.s, f: e.f, n: e.n });
    });
    total += out.length;
    if (total > LIMITS.maxTotal) throw new ImportError('locks: too many entries');
    if (out.length) locks[origin] = out;
  }

  // pause
  if (!isPlainObject(raw.pause)) throw new ImportError('pause');
  assertKeys(raw.pause, ['global', 'sites'], 'pause');
  if (typeof raw.pause.global !== 'boolean') throw new ImportError('pause.global');
  if (!Array.isArray(raw.pause.sites) || raw.pause.sites.length > LIMITS.maxSites) {
    throw new ImportError('pause.sites');
  }
  const sites: string[] = [];
  for (const s of raw.pause.sites) {
    if (!isOriginString(s)) throw new ImportError('pause.sites: bad origin');
    if (!sites.includes(s)) sites.push(s);
  }

  return { locks: { ...locks }, pause: { global: raw.pause.global, sites } };
}
