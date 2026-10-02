// セレクタの生成と解決。Shadow DOM 内の要素は独自形式 "ホストのセレクタ >>> 内部のセレクタ" で表す
// (open な shadow root のみ。closed は外部から辿れないため非対応)。
// 通常のセレクタ (v1 データ含む) は ">>>" を含まず、従来どおり document 内の通常セレクタとして扱う。

export const SHADOW_SEP = ' >>> ';

/** クォート内の ' >>> ' では分割しない */
export function splitPath(path: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (path.startsWith(SHADOW_SEP, i)) {
      parts.push(path.slice(start, i));
      i += SHADOW_SEP.length - 1;
      start = i + 1;
    }
  }
  parts.push(path.slice(start));
  return parts;
}

type Root = Document | ShadowRoot;

/** パスに一致する要素を全て返す。辿った shadow root は onRoot で通知する (MutationObserver 用) */
export function queryPath(
  path: string,
  doc: Document = document,
  onRoot?: (root: ShadowRoot) => void,
): Element[] {
  const segs = splitPath(path);
  try {
    let roots: Root[] = [doc];
    for (let i = 0; i < segs.length - 1; i++) {
      const next: Root[] = [];
      for (const r of roots) {
        r.querySelectorAll(segs[i] ?? '').forEach((host) => {
          if (host.shadowRoot) {
            next.push(host.shadowRoot);
            onRoot?.(host.shadowRoot);
          }
        });
      }
      roots = next;
    }
    const out: Element[] = [];
    const last = segs[segs.length - 1] ?? '';
    for (const r of roots) r.querySelectorAll(last).forEach((el) => out.push(el));
    return out;
  } catch {
    return []; // 不正なセレクタは無視
  }
}

function matchSegs(el: Element, segs: string[]): boolean {
  try {
    if (!el.matches(segs[segs.length - 1] ?? '')) return false;
  } catch {
    return false;
  }
  const root = el.getRootNode();
  if (segs.length === 1) return !(root instanceof ShadowRoot);
  if (!(root instanceof ShadowRoot)) return false;
  return matchSegs(root.host, segs.slice(0, -1));
}

export function matchesPath(el: Element, path: string): boolean {
  return matchSegs(el, splitPath(path));
}

// ---------- 生成 ----------

/** 自動生成らしい id (React useId, 数字のみ, 長い16進, ハッシュ風, 主要ライブラリの接頭辞) を除外する */
export function isStableId(id: string): boolean {
  if (!id || id.length > 80) return false;
  if (/^[:«]r?[0-9a-z]+[:»]$/i.test(id)) return false; // React useId (:r1: / «r1»)
  if (/^\d+$/.test(id)) return false;
  if (/[0-9a-f]{8,}/i.test(id)) return false; // 長い16進 / UUID 断片
  if (/(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{12,}/i.test(id)) return false; // ハッシュ風
  if (/^(radix|headlessui|react-aria|rc[-_]|ember\d|mui-|:r)/i.test(id)) return false;
  if (/\d{5,}/.test(id)) return false;
  return true;
}

function attrValue(el: Element, name: string): string | null {
  const v = el.getAttribute(name);
  if (!v || v.length > 100 || /[\u0000-\u001f]/.test(v)) return null;
  return v;
}

function q(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i++;
    sib = sib.previousElementSibling;
  }
  return i;
}

function isUnique(scope: Root, sel: string, el: Element): boolean {
  try {
    const found = scope.querySelectorAll(sel);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

const STATE_CLASS = /btn-locker|active|hover|focus|selected|open/i;

function buildLocal(el: Element, scope: Root): string {
  const tag = el.tagName.toLowerCase();
  const candidates: string[] = [];
  if (el.id && isStableId(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
  for (const a of ['data-testid', 'data-test', 'data-qa']) {
    const v = attrValue(el, a);
    if (v) candidates.push(`[${a}=${q(v)}]`, `${tag}[${a}=${q(v)}]`);
  }
  const name = attrValue(el, 'name');
  if (name) candidates.push(`${tag}[name=${q(name)}]`);
  const aria = attrValue(el, 'aria-label');
  if (aria) candidates.push(`${tag}[aria-label=${q(aria)}]`);
  for (const c of candidates) {
    if (isUnique(scope, c, el)) return c;
  }

  // 構造ベース: 一意になった時点で打ち切る (最短)
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  const doc = el.ownerDocument;
  while (cur && cur !== doc.body && cur !== doc.documentElement && depth < 12) {
    let seg: string;
    if (cur !== el && cur.id && isStableId(cur.id)) {
      seg = `#${CSS.escape(cur.id)}`;
      parts.unshift(seg);
      break;
    }
    seg = cur.tagName.toLowerCase();
    const rawClass: unknown =
      typeof cur.className === 'string' ? cur.className : (cur.getAttribute('class') ?? '');
    const cls =
      typeof rawClass === 'string'
        ? rawClass.split(/\s+/).find((c) => c && !STATE_CLASS.test(c))
        : undefined;
    if (cls) seg += `.${CSS.escape(cls)}`;
    seg += `:nth-of-type(${nthOfType(cur)})`;
    parts.unshift(seg);
    const sel = parts.join(' > ');
    if (isUnique(scope, sel, el)) return sel;
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(' > ');
}

/** 要素を一意に指すパスを作る。shadow root 内なら "ホスト >>> 内部" 形式 (入れ子も可) */
export function buildPath(el: Element): string {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    return buildPath(root.host) + SHADOW_SEP + buildLocal(el, root);
  }
  return buildLocal(el, el.ownerDocument);
}
