// btn-locker content script
// ロックモード → クリックでロック → シングルクリック阻止 →
// ダブルクリックで Shadow DOM 確認モーダル → 今回だけ実行 / 解除
// 永続化は chrome.storage.local に「トップのオリジン」単位で {s, f, n} を保存し、
// MutationObserver (ロックがあるときだけ) で SPA の後付けボタンにも再適用する。
// iframe: allFrames で各フレームに注入。自フレームのオリジン(f)のエントリだけを適用する。
// Shadow DOM: composedPath() で open な shadow root 内の要素を検出し、
//   "ホスト >>> 内部" 形式のパスで保存・再解決する (utils/selector.ts)。

import {
  LOCKS_KEY,
  LOCKS_KEY_V1,
  PAUSE_KEY,
  LIMITS,
  isPausedFor,
  readLocks,
  readPause,
  type LockEntry,
  type PauseState,
} from '../utils/storage';
import { buildPath, matchesPath, queryPath } from '../utils/selector';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  // document_start: パース開始時点で阻止リスナーを先登録し、
  // ロック適用までの「素通しウィンドウ」を最小化する
  runAt: 'document_start',
  main() {
    const FRAME_ORIGIN = location.origin;
    const IS_TOP = window === window.top;
    // 保存キーはトップレベルのオリジン。iframe 内では ancestorOrigins の最後の要素 (= トップ)
    const TOP_ORIGIN = IS_TOP
      ? location.origin
      : ((): string => {
          const ao = location.ancestorOrigins;
          return (ao && ao.length > 0 ? ao[ao.length - 1] : '') || location.origin;
        })();

    const CLICKABLE = [
      'button',
      'a',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="image"]',
      'input[type="reset"]',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[onclick]',
    ].join(', ');
    const LOCK_CLASS = 'btn-locker-locked';
    const AIM_CLASS = 'btn-locker-aim';
    const AIMING_CLASS = 'btn-locker-aiming';
    const PRESS_EVENTS = [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'touchstart',
      'touchend',
    ] as const;

    let lockMode = false;
    // このフレームに適用するエントリ (f === FRAME_ORIGIN)
    let mine: LockEntry[] = [];
    // 同じトップオリジンの他フレームのエントリ数 (上限判定は storage 側と同じトップオリジン単位)
    let othersTotal = 0;
    const topTotal = (): number => othersTotal + mine.length;
    let pause: PauseState = { global: false, sites: [] };
    // ロック時点の実ノード → そのノードを指していたセレクタ群。
    // SPA再描画等でセレクタが陳腐化しても取り逃がさず、自己修復時に古いセレクタを整理する
    const lockedNodes = new Map<Element, Set<string>>();
    const appliedNodes = new Set<Element>();
    const styledRoots = new WeakSet<Node>();
    // 「今回だけ実行」中のみ設定。阻止ハンドラ(click / pointer / mouse 系)はこの要素を通す
    let bypassEl: Element | null = null;
    let currentAim: Element | null = null;
    let modalHost: HTMLElement | null = null;
    let modalShadow: ShadowRoot | null = null;
    let modalPrevFocus: Element | null = null;
    let toastTimer: number | undefined;

    const isPaused = (): boolean => isPausedFor(pause, TOP_ORIGIN);

    // i18n: ブラウザ表示言語の messages.json から取得 (該当なし→default_localeのen)
    // キー型は messages.json から自動生成される union に合わせる
    type I18nKey = Parameters<typeof browser.i18n.getMessage>[0];
    const t = (key: I18nKey, sub?: string | string[]): string =>
      browser.i18n.getMessage(key, sub) || key;

    // ---------- styles (programmatic injection: content.css 不要の単一ファイル構成) ----------
    const INJECTED_CSS = `
      .${AIMING_CLASS}, .${AIMING_CLASS} * {
        /* 南京錠カーソル (32x32, ホットスポットは錠前本体の中心) */
        cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cpath d='M10 15V10a6 6 0 0 1 12 0v5' fill='none' stroke='%23fff' stroke-width='6'/%3E%3Cpath d='M10 15V10a6 6 0 0 1 12 0v5' fill='none' stroke='%23c96a00' stroke-width='3'/%3E%3Crect x='5' y='14' width='22' height='16' rx='3.5' fill='%23ff9500' stroke='%23fff' stroke-width='1.5'/%3E%3Ccircle cx='16' cy='20.5' r='2.4' fill='%23fff'/%3E%3Crect x='15' y='21.5' width='2' height='4.5' rx='1' fill='%23fff'/%3E%3C/svg%3E") 16 22, pointer !important;
      }
      .${AIM_CLASS} { outline: 3px solid #ff3b30 !important; outline-offset: 2px !important; }
      .${LOCK_CLASS} {
        filter: grayscale(0.75) !important;
        opacity: 0.55 !important;
        outline: 2px dashed #ff9500 !important;
        outline-offset: 2px !important;
        position: relative;
      }
      .${LOCK_CLASS}::after {
        content: "🔒";
        position: absolute;
        top: -10px;
        right: -10px;
        font-size: 14px;
        line-height: 1;
        background: #fff;
        border: 1px solid #ff9500;
        border-radius: 50%;
        padding: 2px;
        pointer-events: none;
        z-index: 2147483646;
      }
      @keyframes btn-locker-shake {
        0%,100% { transform: translateX(0); }
        25% { transform: translateX(-3px); }
        75% { transform: translateX(3px); }
      }
      .btn-locker-nudge { animation: btn-locker-shake 0.25s ease 2; }
      #btn-locker-toast {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: #1c1c1e; color: #fff; font-size: 13px;
        padding: 10px 16px; border-radius: 10px; z-index: 2147483647;
        box-shadow: 0 4px 16px rgba(0,0,0,.35);
        font-family: system-ui, sans-serif;
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'btn-locker-style';
    styleEl.textContent = INJECTED_CSS;
    (document.head ?? document.documentElement).appendChild(styleEl);

    // shadow root 内の要素にもロック/狙いの見た目を効かせるため、root ごとに style を入れる
    function ensureStyle(el: Element): void {
      const root = el.getRootNode();
      if (!(root instanceof ShadowRoot) || styledRoots.has(root)) return;
      styledRoots.add(root);
      const s = document.createElement('style');
      s.setAttribute('data-btn-locker', '');
      s.textContent = INJECTED_CSS;
      root.appendChild(s);
    }

    // ---------- storage ----------
    async function loadAll(): Promise<void> {
      try {
        const [db, p] = await Promise.all([readLocks(), readPause()]);
        const all = db[TOP_ORIGIN] ?? [];
        mine = all.filter((e) => e.f === FRAME_ORIGIN);
        othersTotal = all.length - mine.length;
        pause = p;
      } catch {
        mine = [];
        othersTotal = 0;
        pause = { global: false, sites: [] };
      }
      // 解除済み(エントリが無くなった)ノードの保持を捨てる
      const live = new Set(mine.map((e) => e.s));
      for (const [node, sels] of lockedNodes) {
        for (const s of sels) if (!live.has(s)) sels.delete(s);
        if (sels.size === 0) lockedNodes.delete(node);
      }
      if (isPaused() && lockMode) setLockMode(false);
      applyLocks();
      syncObserver();
    }

    // 書き込みは background に集約 (Web Locks は content script と拡張機能のオリジン間で共有されない)
    function persist(op: { add?: LockEntry[]; remove?: string[] }): void {
      try {
        void browser.runtime
          .sendMessage({ type: 'btn-locker:mutate', top: TOP_ORIGIN, f: FRAME_ORIGIN, ...op })
          .catch(() => undefined);
      } catch {
        /* 拡張が再読み込みされた直後など。動作は継続 */
      }
    }

    // ---------- naming ----------
    // アイコンのみのボタンでも識別できるよう、アクセシブルネームに近い順で名前を探す
    function accessibleName(el: Element): string {
      const clean = (s: string | null | undefined): string =>
        (s ?? '').trim().replace(/\s+/g, ' ');
      const root = el.getRootNode() as Document | ShadowRoot;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const byIds = labelledBy
          .split(/\s+/)
          .map((id) => clean(root.getElementById?.(id)?.textContent))
          .filter(Boolean)
          .join(' ');
        if (byIds) return byIds;
      }
      const candidates = [
        el.getAttribute('aria-label'),
        el instanceof HTMLInputElement ? el.value : null,
        el.textContent,
        el.getAttribute('title'),
        el.getAttribute('alt'),
        el.querySelector('img[alt]')?.getAttribute('alt'),
        el.querySelector('svg title')?.textContent,
      ];
      for (const c of candidates) {
        const v = clean(c);
        if (v) return v;
      }
      return '';
    }

    function describe(el: Element): string {
      const name = accessibleName(el).slice(0, LIMITS.maxName);
      const tag = el.tagName.toLowerCase();
      return name ? `<${tag}> "${name}"` : `<${tag}>`;
    }

    // ---------- lock visuals ----------
    function isLocked(el: Element): boolean {
      if (lockedNodes.has(el)) return true;
      return mine.some((e) => matchesPath(el, e.s));
    }

    function applyLocks(): void {
      if (isPaused()) {
        // 一時停止中: 見た目を外す (ロックの定義は保持)
        appliedNodes.forEach((el) => el.classList.remove(LOCK_CLASS));
        appliedNodes.clear();
        return;
      }
      const want = new Set<Element>();
      for (const e of mine) {
        for (const el of queryPath(e.s, document, observeRoot)) want.add(el);
      }
      for (const el of lockedNodes.keys()) {
        if (el.isConnected) want.add(el);
        else lockedNodes.delete(el);
      }
      for (const el of appliedNodes) {
        if (!want.has(el)) {
          el.classList.remove(LOCK_CLASS);
          appliedNodes.delete(el);
        }
      }
      for (const el of want) {
        ensureStyle(el);
        el.classList.add(LOCK_CLASS);
        appliedNodes.add(el);
      }
    }

    // ---------- toast / nudge ----------
    function toast(msg: string): void {
      document.getElementById('btn-locker-toast')?.remove();
      window.clearTimeout(toastTimer);
      const div = document.createElement('div');
      div.id = 'btn-locker-toast';
      div.textContent = msg;
      (document.body ?? document.documentElement).appendChild(div);
      toastTimer = window.setTimeout(() => div.remove(), 2200);
    }

    function nudge(el: Element): void {
      el.classList.add('btn-locker-nudge');
      window.setTimeout(() => el.classList.remove('btn-locker-nudge'), 600);
      toast(t('lockedNudge'));
    }

    // ---------- lock / unlock ----------
    function trackNode(el: Element, sel: string): void {
      const set = lockedNodes.get(el) ?? new Set<string>();
      set.add(sel);
      lockedNodes.set(el, set);
    }

    function lockElement(el: Element): void {
      const sel = buildPath(el);
      const name = accessibleName(el).slice(0, LIMITS.maxName) || `<${el.tagName.toLowerCase()}>`;
      const entry: LockEntry = { s: sel, f: FRAME_ORIGIN, n: name };
      if (!mine.some((e) => e.s === sel)) {
        if (topTotal() >= LIMITS.maxPerOrigin) {
          // 上限: 保存せず、lockedNodes にも入れない
          toast(t('lockLimit', String(LIMITS.maxPerOrigin)));
          return;
        }
        mine.push(entry);
      }
      trackNode(el, sel);
      persist({ add: [entry] });
      applyLocks();
      syncObserver();
      toast(t('lockDone', describe(el)));
    }

    // セレクタが陳腐化して実ノードだけ残っている場合の自己修復:
    // 新しいセレクタを追加し、同じ実ノードを指していた古いセレクタのうち
    // どの要素にも一致しなくなったものは置き換える (データを溜めない)
    function healNode(el: Element): string {
      const sel = buildPath(el);
      const olds = lockedNodes.get(el) ?? new Set<string>();
      const stale = [...olds].filter((o) => o !== sel && queryPath(o).length === 0);
      for (const o of stale) olds.delete(o);
      const entry: LockEntry = {
        s: sel,
        f: FRAME_ORIGIN,
        n: accessibleName(el).slice(0, LIMITS.maxName) || `<${el.tagName.toLowerCase()}>`,
      };
      mine = mine.filter((e) => !stale.includes(e.s));
      let add: LockEntry[] = [];
      if (!mine.some((e) => e.s === sel)) {
        if (topTotal() >= LIMITS.maxPerOrigin) {
          if (stale.length) persist({ remove: stale });
          applyLocks();
          return sel; // 上限: 追加しない (ノードは追跡しない)
        }
        mine.push(entry);
        add = [entry];
      }
      trackNode(el, sel);
      persist({ add, remove: stale });
      applyLocks();
      syncObserver();
      return sel;
    }

    function unlockSelector(sel: string): void {
      mine = mine.filter((e) => e.s !== sel);
      for (const [node, sels] of lockedNodes) {
        sels.delete(sel);
        if (sels.size === 0) lockedNodes.delete(node);
      }
      persist({ remove: [sel] });
      applyLocks();
      syncObserver();
    }

    // 「解除」: その要素に一致するエントリをすべて外す (同じ要素を指す別セレクタが残らないように)
    function unlockElement(el: Element, sel: string): void {
      const sels = new Set<string>([sel, ...(lockedNodes.get(el) ?? [])]);
      for (const e of mine) if (matchesPath(el, e.s)) sels.add(e.s);
      lockedNodes.delete(el);
      mine = mine.filter((e) => !sels.has(e.s));
      for (const [node, set] of lockedNodes) {
        for (const x of sels) set.delete(x);
        if (set.size === 0) lockedNodes.delete(node);
      }
      persist({ remove: [...sels] });
      applyLocks();
      syncObserver();
    }

    // ポップアップで selector のエントリが消された後の後始末: そのセレクタが指していた要素に
    // 別のエントリが一致して、まだロックされているならそれも外す
    function unlockedFromPopup(sel: string): void {
      const els = new Set<Element>(queryPath(sel));
      for (const [node, set] of lockedNodes) if (set.has(sel)) els.add(node);
      for (const el of els) unlockElement(el, sel);
      unlockSelector(sel);
    }

    // ロック済みなら、その要素に対応するセレクタを返す (実ノードのみ残っている場合は自己修復)
    function selectorFor(el: Element): string | null {
      for (const e of mine) if (matchesPath(el, e.s)) return e.s;
      if (lockedNodes.has(el)) return healNode(el);
      return null;
    }

    // ---------- lock mode ----------
    function setLockMode(on: boolean): void {
      if (on && isPaused()) {
        if (IS_TOP) toast(t('pausedNotice'));
        return;
      }
      if (lockMode === on) return;
      lockMode = on;
      console.debug('[btn-locker] lockMode =', on, IS_TOP ? '(top)' : '(frame)');
      document.documentElement.classList.toggle(AIMING_CLASS, on);
      if (!on && currentAim) {
        currentAim.classList.remove(AIM_CLASS);
        currentAim = null;
      }
      // トーストは重複を避けるためトップフレームのみ
      if (IS_TOP) toast(on ? t('lockModeOn') : t('lockModeOff'));
    }

    // Esc / 右クリックによる終了: 自フレームを OFF にし、background 経由で全フレームへ伝える
    function exitByUser(): void {
      setLockMode(false);
      try {
        void browser.runtime.sendMessage({ type: 'btn-locker:mode-exit' }).catch(() => undefined);
      } catch {
        /* 拡張が再読み込みされた直後など */
      }
    }

    // ---------- modal (Shadow DOM でページCSSと隔離) ----------
    function closeModal(): void {
      modalHost?.remove();
      modalHost = null;
      modalShadow = null;
      const prev = modalPrevFocus;
      modalPrevFocus = null;
      if (prev && prev.isConnected) (prev as HTMLElement).focus?.();
    }

    function deepActiveElement(): Element | null {
      let a: Element | null = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return a;
    }

    function runOnce(el: Element): void {
      // click だけでなく pointer / mouse 系も本来どおり発火させる。
      // bypassEl が立っている間は、阻止ハンドラが全てこの要素を素通しする。
      bypassEl = el;
      try {
        const r = el.getBoundingClientRect();
        const base = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        };
        const ptr = { pointerType: 'mouse', isPrimary: true, pointerId: 1 };
        el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...ptr, buttons: 1 }));
        el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...ptr, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        if (typeof (el as HTMLElement).click === 'function') (el as HTMLElement).click();
        else el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
      } finally {
        bypassEl = null;
      }
    }

    function openConfirmModal(el: Element, sel: string): void {
      closeModal();
      modalPrevFocus = deepActiveElement();
      modalHost = document.createElement('div');
      modalHost.id = 'btn-locker-modal-host';
      modalHost.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
      const shadow = modalHost.attachShadow({ mode: 'open' });
      modalShadow = shadow;
      shadow.innerHTML = `
        <style>
          .card { background:#fff; color:#1c1c1e; border-radius:14px; padding:22px 24px;
                  width:max-content; min-width:320px; max-width:min(440px, calc(100vw - 32px));
                  box-sizing:border-box; font-family:system-ui,sans-serif; box-shadow:0 12px 40px rgba(0,0,0,.4); }
          .title { font-size:16px; font-weight:700; margin:0 0 8px; }
          .target { font-size:13px; color:#555; background:#f5f5f7; border-radius:8px;
                    padding:8px 10px; margin:0 0 12px; word-break:break-all; }
          .warn { font-size:13px; margin:0 0 16px; }
          .row { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; }
          /* 語の途中で折り返さない（長い言語では行ごと折り返す） */
          button { white-space:nowrap; border-radius:8px; border:1px solid #ccc; padding:8px 12px;
                   font-size:13px; cursor:pointer; background:#fff; color:#1c1c1e; }
          button.primary { background:#ff3b30; border-color:#ff3b30; color:#fff; font-weight:700; }
          button.ghost { background:transparent; }
          button:focus-visible { outline:3px solid #0a84ff; outline-offset:2px; }
        </style>
        <div class="card" role="dialog" aria-modal="true" aria-labelledby="btn-locker-modal-title">
          <p class="title" id="btn-locker-modal-title" dir="auto">${t('modalTitle')}</p>
          <p class="target" dir="auto"></p>
          <p class="warn" dir="auto">${t('modalWarn')}</p>
          <div class="row">
            <button class="ghost" data-act="cancel">${t('modalCancel')}</button>
            <button data-act="unlock">${t('modalUnlock')}</button>
            <button class="primary" data-act="run">${t('modalRun')}</button>
          </div>
        </div>
      `;
      (shadow.querySelector('.target') as HTMLElement).textContent = describe(el);

      shadow.querySelector('[data-act="cancel"]')?.addEventListener('click', closeModal);
      shadow.querySelector('[data-act="unlock"]')?.addEventListener('click', () => {
        unlockElement(el, sel);
        closeModal();
        toast(t('unlocked'));
      });
      shadow.querySelector('[data-act="run"]')?.addEventListener('click', () => {
        closeModal();
        runOnce(el);
      });
      modalHost.addEventListener('click', (e) => {
        if (e.target === modalHost) closeModal();
      });
      (document.body ?? document.documentElement).appendChild(modalHost);
      // 初期フォーカスは「キャンセル」(誤操作で実行されないように)
      (shadow.querySelector('[data-act="cancel"]') as HTMLElement | null)?.focus();
    }

    // ---------- event helpers ----------
    // closest() ではなく composedPath() を使い、open な shadow root 内の要素も扱う
    function pathElements(e: Event): Element[] {
      return e.composedPath().filter((n): n is Element => n instanceof Element);
    }

    function isClickable(el: Element): boolean {
      if (!el.isConnected || el === document.body || el === document.documentElement) return false;
      try {
        return el.matches(CLICKABLE);
      } catch {
        return false;
      }
    }

    const firstClickable = (els: Element[]): Element | null =>
      els.find((el) => isClickable(el)) ?? null;
    const firstLocked = (els: Element[]): Element | null =>
      els.find((el) => isClickable(el) && isLocked(el)) ?? null;

    // モーダル内のイベント / 「今回だけ実行」中の再発火は阻止の対象外
    function exempt(els: Element[]): boolean {
      if (modalHost && els.includes(modalHost)) return true;
      if (bypassEl && els.includes(bypassEl)) return true;
      return false;
    }

    function swallow(e: Event, prevent = true): void {
      if (prevent && e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
    }

    // ---------- event interception (capture phase, window で最優先に受ける) ----------
    // pointerdown / mousedown 等ですり抜けないよう、ロック中の要素(およびロックモードの狙い先)の
    // press 系イベントも止める。touch 系は preventDefault するとスクロール等を壊すため伝播停止のみ。
    for (const type of PRESS_EVENTS) {
      window.addEventListener(
        type,
        (e) => {
          if (isPaused()) return;
          const els = pathElements(e);
          if (exempt(els)) return;
          const target = lockMode ? firstClickable(els) : firstLocked(els);
          if (!target) return;
          swallow(e, !type.startsWith('touch'));
        },
        { capture: true, passive: false },
      );
    }

    window.addEventListener(
      'click',
      (e) => {
        if (isPaused()) return;
        const els = pathElements(e);
        if (exempt(els)) return;
        if (lockMode) {
          const target = firstClickable(els);
          if (!target) return;
          swallow(e);
          lockElement(target);
          return;
        }
        const target = firstLocked(els);
        if (!target) return;
        swallow(e);
        selectorFor(target); // 陳腐化していれば自己修復
        nudge(target);
      },
      true,
    );

    // auxclick (中クリック等): ロックモードの狙い先とロック済みの要素を click と同様に止める
    // (ロック済みリンクを中クリックで新しいタブに開けないようにする)
    window.addEventListener(
      'auxclick',
      (e) => {
        if (isPaused()) return;
        const els = pathElements(e);
        if (exempt(els)) return;
        const target = lockMode ? firstClickable(els) : firstLocked(els);
        if (target) swallow(e);
      },
      true,
    );

    // dragstart: ロック済みリンクのドラッグで新しいタブに開くのを防ぐ (ロックモード中も止める)
    window.addEventListener(
      'dragstart',
      (e) => {
        if (isPaused()) return;
        const els = pathElements(e);
        if (exempt(els)) return;
        const target = lockMode ? firstClickable(els) : firstLocked(els);
        if (target) swallow(e);
      },
      true,
    );

    window.addEventListener(
      'dblclick',
      (e) => {
        if (isPaused()) return;
        const els = pathElements(e);
        if (exempt(els)) return;
        if (lockMode) {
          if (firstClickable(els)) swallow(e);
          return;
        }
        const target = firstLocked(els);
        if (!target) return;
        const sel = selectorFor(target);
        if (!sel) return;
        swallow(e);
        console.debug('[btn-locker] open modal for', sel);
        openConfirmModal(target, sel);
      },
      true,
    );

    // ---------- lock mode exit: 右クリック / Esc ----------
    window.addEventListener(
      'contextmenu',
      (e) => {
        if (!lockMode) return;
        swallow(e);
        exitByUser();
      },
      true,
    );

    window.addEventListener(
      'keydown',
      (e) => {
        // 確認モーダル: Esc で閉じる / Tab はモーダル内に閉じ込める
        if (modalHost && modalShadow) {
          if (e.key === 'Escape') {
            swallow(e);
            closeModal();
            return;
          }
          if (e.key === 'Tab') {
            const items = [...modalShadow.querySelectorAll<HTMLElement>('button')];
            if (items.length === 0) return;
            const active = modalShadow.activeElement as HTMLElement | null;
            const idx = active ? items.indexOf(active) : -1;
            let next: number;
            if (e.shiftKey) next = idx <= 0 ? items.length - 1 : idx - 1;
            else next = idx < 0 || idx === items.length - 1 ? 0 : idx + 1;
            swallow(e);
            items[next]?.focus();
          }
          return;
        }
        if (!lockMode || e.key !== 'Escape') return;
        exitByUser();
      },
      true,
    );

    // ---------- lock mode aim highlight ----------
    window.addEventListener(
      'mouseover',
      (e) => {
        if (!lockMode) return;
        const els = pathElements(e);
        if (modalHost && els.includes(modalHost)) return;
        const clickable = firstClickable(els);
        if (currentAim && currentAim !== clickable) currentAim.classList.remove(AIM_CLASS);
        currentAim = clickable;
        if (clickable) {
          ensureStyle(clickable);
          clickable.classList.add(AIM_CLASS);
        }
      },
      true,
    );

    // ---------- SPA support: ロックがあるときだけ MutationObserver を動かす ----------
    let moTimer: number | undefined;
    let observing = false;
    let observedRoots = new WeakSet<Node>();
    // 拡張機能自身が追加・削除したノード (toast / モーダル / style) だけの変化は無視する
    const isOurs = (n: Node): boolean =>
      n instanceof Element &&
      (n.id === 'btn-locker-toast' ||
        n.id === 'btn-locker-modal-host' ||
        n.id === 'btn-locker-style' ||
        n.hasAttribute('data-btn-locker'));
    const observer = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        const nodes = [...r.addedNodes, ...r.removedNodes];
        return nodes.length === 0 || !nodes.every(isOurs);
      });
      if (!relevant) return;
      window.clearTimeout(moTimer);
      moTimer = window.setTimeout(applyLocks, 120);
    });
    const OBS_OPTS: MutationObserverInit = { childList: true, subtree: true };

    // MutationObserver は shadow 境界を越えないため、辿った open shadow root も個別に監視する
    function observeRoot(root: ShadowRoot): void {
      if (!observing || observedRoots.has(root)) return;
      observedRoots.add(root);
      observer.observe(root, OBS_OPTS);
    }

    function syncObserver(): void {
      const need = !isPaused() && (mine.length > 0 || lockedNodes.size > 0);
      if (need && !observing) {
        observing = true;
        observer.observe(document.documentElement, OBS_OPTS);
      } else if (!need && observing) {
        observing = false;
        observer.disconnect();
        observedRoots = new WeakSet<Node>();
        window.clearTimeout(moTimer);
      }
    }

    // ---------- storage sync (multi-tab / 全フレーム) ----------
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[LOCKS_KEY] || changes[PAUSE_KEY] || changes[LOCKS_KEY_V1]) void loadAll();
    });

    // ---------- messages (popup / background) ----------
    // 応答は sendResponse で返す。リスナーから Promise を返す方式は Chrome 148+ の段階的
    // ロールアウトでしか動かないため使わない（それ以前はレスポンスが undefined になる）。
    // https://developer.chrome.com/docs/extensions/develop/concepts/messaging
    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      const m = msg as { type?: string; on?: unknown; selector?: unknown; f?: unknown };
      if (m?.type === 'btn-locker:state') {
        sendResponse({ lockMode, origin: TOP_ORIGIN, paused: isPaused() });
        return;
      }
      if (m?.type === 'btn-locker:set-lockmode' && typeof m.on === 'boolean') {
        setLockMode(m.on);
        sendResponse({ lockMode });
        return;
      }
      if (m?.type === 'btn-locker:unlock' && typeof m.selector === 'string') {
        if (m.f === FRAME_ORIGIN) unlockedFromPopup(m.selector);
        sendResponse({ ok: true });
        return;
      }
      if (m?.type === 'btn-locker:reload') {
        void loadAll();
        sendResponse({ ok: true });
        return;
      }
    });

    // ---------- init ----------
    void loadAll();
  },
});
