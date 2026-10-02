// btn-locker 共通ストレージモジュール (content / popup / options / background で共有)
//
// 保存キー:
//   btn-locker:locks:v2  Record<topOrigin, Array<{ s, f, n }>>
//     s = セレクタ (Shadow DOM 内は "ホスト >>> 内部" 形式), f = フレームのオリジン, n = ボタン名(最大40文字)
//   btn-locker:pause:v1  { global: boolean, sites: string[] }  (sites はトップのオリジン)
//   btn-locker:locks:v1  旧形式 Record<origin, string[]> (読み取り・移行のみ。移行後は削除)

import { browser } from 'wxt/browser';

export const LOCKS_KEY = 'btn-locker:locks:v2';
export const LOCKS_KEY_V1 = 'btn-locker:locks:v1';
export const PAUSE_KEY = 'btn-locker:pause:v1';

export const LIMITS = {
  maxFileBytes: 1_000_000,
  maxOrigins: 500,
  maxPerOrigin: 500,
  maxTotal: 5000,
  maxSelector: 500,
  maxName: 40,
  maxSites: 1000,
  maxOriginLength: 300,
} as const;

export interface LockEntry {
  s: string;
  f: string;
  n: string;
}
export type LockDB = Record<string, LockEntry[]>;
export interface PauseState {
  global: boolean;
  sites: string[];
}

export function isOriginString(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.maxOriginLength) return false;
  if (v === 'null') return true; // サンドボックス iframe / file:// の不透明オリジン
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v;
  } catch {
    return false;
  }
}

function isEntry(v: unknown): v is LockEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.s === 'string' &&
    e.s.length > 0 &&
    e.s.length <= LIMITS.maxSelector &&
    typeof e.f === 'string' &&
    typeof e.n === 'string'
  );
}

// 保存データの読み取り用 (寛容): 不正な要素は捨てる
function sanitizeDB(raw: unknown): LockDB {
  const out: LockDB = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [origin, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries = list.filter(isEntry).map((e) => ({ s: e.s, f: e.f, n: e.n.slice(0, LIMITS.maxName) }));
    if (entries.length) out[origin] = entries;
  }
  return out;
}

function convertV1(raw: unknown): LockDB {
  const out: LockDB = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [origin, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries = list
      .filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= LIMITS.maxSelector)
      .map((s) => ({ s, f: origin, n: '' }));
    if (entries.length) out[origin] = entries;
  }
  return out;
}

function mergeInto(base: LockDB, add: LockDB): void {
  for (const [origin, list] of Object.entries(add)) {
    const cur = (base[origin] ??= []);
    for (const e of list) {
      if (!cur.some((c) => c.s === e.s && c.f === e.f)) cur.push(e);
    }
  }
}

// 読み取り・更新・書き込みは Web Locks で直列化する。ロックは「オリジン単位」で共有されるため、
// 拡張機能のオリジンで動く popup / options / service worker の間では共有される。
// content script はページのオリジンで動くので共有されない (実測済み) → content からの書き込みは
// runtime.sendMessage で background に集約し、background 側 (拡張機能のオリジン) で実行する。
const LOCK_NAME = 'btn-locker:storage';
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(LOCK_NAME, () => fn()) as Promise<T>;
  }
  // Web Locks が無い環境のフォールバック: コンテキスト内のみ直列化
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** 書き込み用の読み取り: v1 が残っていれば v2 へ統合する (削除は呼び出し側の set と同時に行う) */
async function readForWrite(): Promise<{ db: LockDB; hadV1: boolean }> {
  const got = await browser.storage.local.get([LOCKS_KEY, LOCKS_KEY_V1]);
  const db = got[LOCKS_KEY] !== undefined ? sanitizeDB(got[LOCKS_KEY]) : {};
  const hadV1 = got[LOCKS_KEY_V1] !== undefined;
  if (hadV1) mergeInto(db, convertV1(got[LOCKS_KEY_V1]));
  return { db, hadV1 };
}

async function writeLocks(db: LockDB, hadV1: boolean): Promise<void> {
  await browser.storage.local.set({ [LOCKS_KEY]: db });
  if (hadV1) await browser.storage.local.remove(LOCKS_KEY_V1);
}

/** v2 を読む。v2 が無く v1 だけある場合は v1 を (メモリ上で) 変換して返す。書き込みはしない */
export async function readLocks(): Promise<LockDB> {
  const got = await browser.storage.local.get([LOCKS_KEY, LOCKS_KEY_V1]);
  if (got[LOCKS_KEY] !== undefined) return sanitizeDB(got[LOCKS_KEY]);
  if (got[LOCKS_KEY_V1] !== undefined) return convertV1(got[LOCKS_KEY_V1]);
  return {};
}

/** v1 → v2 の移行 (冪等)。v1 が無ければ何もしない。v2 が既にあれば重複を除いてマージする */
export function migrateV1(): Promise<void> {
  return enqueue(async () => {
    const { db, hadV1 } = await readForWrite();
    if (!hadV1) return;
    await writeLocks(db, true);
  });
}

export function mutateLocks(
  top: string,
  f: string,
  op: { add?: LockEntry[]; remove?: string[] },
): Promise<void> {
  return enqueue(async () => {
    const { db, hadV1 } = await readForWrite();
    let list = db[top] ?? [];
    if (op.remove?.length) {
      const rm = new Set(op.remove);
      list = list.filter((e) => !(e.f === f && rm.has(e.s)));
    }
    for (const a of op.add ?? []) {
      if (list.length >= LIMITS.maxPerOrigin) break;
      if (!list.some((e) => e.s === a.s && e.f === a.f)) list.push(a);
    }
    if (list.length) db[top] = list;
    else delete db[top];
    await writeLocks(db, hadV1);
  });
}

/** 指定トップオリジンの全ロック (全フレーム分) を削除 */
export function clearLocks(top: string): Promise<void> {
  return enqueue(async () => {
    const { db, hadV1 } = await readForWrite();
    delete db[top];
    await writeLocks(db, hadV1);
  });
}

function sanitizePause(raw: unknown): PauseState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    global: r.global === true,
    sites: Array.isArray(r.sites) ? r.sites.filter((s): s is string => typeof s === 'string') : [],
  };
}

export async function readPause(): Promise<PauseState> {
  const got = await browser.storage.local.get(PAUSE_KEY);
  return sanitizePause(got[PAUSE_KEY]);
}

export function setGlobalPaused(on: boolean): Promise<void> {
  return enqueue(async () => {
    const p = await readPause();
    p.global = on;
    await browser.storage.local.set({ [PAUSE_KEY]: p });
  });
}

export function setSitePaused(site: string, on: boolean): Promise<void> {
  return enqueue(async () => {
    const p = await readPause();
    const sites = p.sites.filter((s) => s !== site);
    if (on) sites.push(site);
    await browser.storage.local.set({ [PAUSE_KEY]: { global: p.global, sites } });
  });
}

export function isPausedFor(p: PauseState, topOrigin: string): boolean {
  return p.global || p.sites.includes(topOrigin);
}

export function countLocks(db: LockDB): number {
  return Object.values(db).reduce((n, l) => n + l.length, 0);
}

/** インポート結果の書き込み。mode=merge は既存に加え、replace は置き換える。上限超過は Error */
export function applyImport(
  data: { locks: LockDB; pause: PauseState },
  mode: 'merge' | 'replace',
): Promise<{ locks: number }> {
  return enqueue(async () => {
    let locks: LockDB;
    let pause: PauseState;
    if (mode === 'replace') {
      locks = data.locks;
      pause = { global: data.pause.global, sites: [...data.pause.sites] };
    } else {
      locks = (await readForWrite()).db;
      mergeInto(locks, data.locks);
      const cur = await readPause();
      pause = {
        global: cur.global || data.pause.global,
        sites: [...new Set([...cur.sites, ...data.pause.sites])],
      };
    }
    if (
      Object.keys(locks).length > LIMITS.maxOrigins ||
      Object.values(locks).some((l) => l.length > LIMITS.maxPerOrigin) ||
      countLocks(locks) > LIMITS.maxTotal ||
      pause.sites.length > LIMITS.maxSites
    ) {
      throw new Error('limit');
    }
    await browser.storage.local.set({ [LOCKS_KEY]: locks, [PAUSE_KEY]: pause });
    await browser.storage.local.remove(LOCKS_KEY_V1);
    return { locks: countLocks(locks) };
  });
}
