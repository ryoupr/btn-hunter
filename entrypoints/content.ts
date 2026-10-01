// btn-locker content script (MVP)
// ロックモード → クリックでロック → シングルクリック阻止 →
// ダブルクリックで Shadow DOM 確認モーダル → 今回だけ実行 / 解除
// 永続化は chrome.storage.local にオリジン単位でセレクタ配列を保存し、
// MutationObserver で SPA の後付けボタンにも再適用する。

export default defineContentScript({
  matches: ['<all_urls>'],
  // document_start: パース開始時点で阻止リスナーを先登録し、
  // ロック適用までの「素通しウィンドウ」を最小化する
  runAt: 'document_start',
  main() {
    const ORIGIN = location.origin;
    const STORE_KEY = 'btn-locker:locks:v1';
    type LockDB = Record<string, string[]>;

    const CLICKABLE = 'button, a, input[type="button"], input[type="submit"], [role="button"]';
    const LOCK_CLASS = 'btn-locker-locked';
    const AIM_CLASS = 'btn-locker-aim';
    const AIMING_CLASS = 'btn-locker-aiming';

    let lockMode = false;
    let locked = new Set<string>();
    const bypass = new WeakSet<Element>();
    // ロック時点の実ノード保持: SPA再描画等でセレクタが陳腐化しても取り逃がさない
    const lockedNodes = new WeakSet<Element>();
    let currentAim: Element | null = null;
    let modalHost: HTMLElement | null = null;
    let toastTimer: number | undefined;

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

    // ---------- storage ----------
    async function loadLocks(): Promise<void> {
      try {
        const got = (await browser.storage.local.get(STORE_KEY)) as Partial<
          Record<string, LockDB[string]>
        >;
        const arr = (got?.[STORE_KEY] as unknown as LockDB | undefined)?.[ORIGIN] ?? [];
        locked = new Set(Array.isArray(arr) ? arr : []);
      } catch {
        locked = new Set();
      }
    }

    async function persistLocks(): Promise<void> {
      try {
        const got = (await browser.storage.local.get(STORE_KEY)) as Partial<
          Record<string, LockDB>
        >;
        const db = ((got?.[STORE_KEY] as unknown as LockDB | undefined) ?? {}) as LockDB;
        db[ORIGIN] = [...locked];
        await browser.storage.local.set({ [STORE_KEY]: db });
      } catch {
        /* storage 利用不可でも動作は継続 */
      }
    }

    // ---------- selector ----------
    function nthOfType(el: Element): number {
      let i = 1;
      let sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName === el.tagName) i++;
        sib = sib.previousElementSibling;
      }
      return i;
    }

    function buildSelector(el: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
        let seg = cur.tagName.toLowerCase();
        const rawClass: unknown =
          typeof cur.className === 'string' ? cur.className : (cur.getAttribute('class') ?? '');
        const cls = typeof rawClass === 'string' ? rawClass.split(/\s+/)[0] : '';
        if (cls && !/btn-locker|active|hover|focus|selected|open/i.test(cls)) {
          seg += `.${CSS.escape(cls)}`;
        }
        seg += `:nth-of-type(${nthOfType(cur)})`;
        parts.unshift(seg);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function describe(el: Element): string {
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const tag = el.tagName.toLowerCase();
      return text ? `<${tag}> "${text}"` : `<${tag}>`;
    }

    // ---------- lock visuals ----------
    function matchesLocked(el: Element): boolean {
      if (el.classList.contains(LOCK_CLASS)) return true;
      for (const sel of locked) {
        try {
          if (el.matches(sel)) return true;
        } catch {
          /* 不正セレクタは無視 */
        }
      }
      return false;
    }

    function applyLocks(): void {
      // 外れた要素の掃除
      document.querySelectorAll(`.${LOCK_CLASS}`).forEach((el) => {
        let still = false;
        for (const sel of locked) {
          try {
            if ((el as Element).matches(sel)) {
              still = true;
              break;
            }
          } catch {
            /* ignore */
          }
        }
        if (!still) el.classList.remove(LOCK_CLASS);
      });
      // 現行ロックの適用
      for (const sel of locked) {
        try {
          document.querySelectorAll(sel).forEach((el) => el.classList.add(LOCK_CLASS));
        } catch {
          /* ignore */
        }
      }
    }

    function unlockSelector(sel: string): void {
      locked.delete(sel);
      void persistLocks();
      try {
        document.querySelectorAll(sel).forEach((el) => el.classList.remove(LOCK_CLASS));
      } catch {
        /* ignore */
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

    // ---------- lock ----------
    function lockElement(el: Element): void {
      const sel = buildSelector(el);
      lockedNodes.add(el);
      locked.add(sel);
      void persistLocks();
      applyLocks();
      toast(t('lockDone', describe(el)));
    }

    function setLockMode(on: boolean): void {
      lockMode = on;
      console.debug('[btn-locker] lockMode =', on);
      document.documentElement.classList.toggle(AIMING_CLASS, on);
      if (!on && currentAim) {
        currentAim.classList.remove(AIM_CLASS);
        currentAim = null;
      }
      toast(on ? t('lockModeOn') : t('lockModeOff'));
    }

    // ---------- modal (Shadow DOM でページCSSと隔離) ----------
    function closeModal(): void {
      modalHost?.remove();
      modalHost = null;
    }

    function openConfirmModal(el: Element, sel: string): void {
      closeModal();
      modalHost = document.createElement('div');
      modalHost.id = 'btn-locker-modal-host';
      modalHost.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);';
      const shadow = modalHost.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          .card { background:#fff; color:#1c1c1e; border-radius:14px; padding:22px 24px;
                  width:400px; max-width:calc(100vw - 32px); box-sizing:border-box;
                  font-family:system-ui,sans-serif; box-shadow:0 12px 40px rgba(0,0,0,.4); }
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
        </style>
        <div class="card">
          <p class="title" dir="auto">${t('modalTitle')}</p>
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
        unlockSelector(sel);
        closeModal();
        toast(t('unlocked'));
      });
      shadow.querySelector('[data-act="run"]')?.addEventListener('click', () => {
        closeModal();
        // capture フェーズの阻止を一度だけ回避して本来のクリックを発火
        bypass.add(el);
        (el as HTMLElement).click();
      });
      modalHost.addEventListener('click', (e) => {
        if (e.target === modalHost) closeModal();
      });
      (document.body ?? document.documentElement).appendChild(modalHost);
    }

    function findLockedSelector(el: Element): string | null {
      for (const sel of locked) {
        try {
          if ((el as Element).matches(sel)) return sel;
        } catch {
          /* ignore */
        }
      }
      return el.classList.contains(LOCK_CLASS) ? buildSelector(el) : null;
    }

    // ---------- event interception (capture phase) ----------
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        const clickable = t?.closest?.(CLICKABLE) as Element | null;
        if (!clickable || !document.contains(clickable)) return;
        if (bypass.has(clickable)) {
          bypass.delete(clickable);
          return; // 「今回だけ実行する」の再発火は通す
        }
        if (lockMode) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          lockElement(clickable);
          return;
        }
        if (lockedNodes.has(clickable) || matchesLocked(clickable)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          // セレクタが陳腐化して実ノードだけ残っている場合は自己修復
          if (!matchesLocked(clickable)) {
            const sel = buildSelector(clickable);
            locked.add(sel);
            void persistLocks();
            applyLocks();
          }
          nudge(clickable);
        }
      },
      true,
    );

    document.addEventListener(
      'dblclick',
      (e) => {
        const t = e.target as Element | null;
        const clickable = t?.closest?.(CLICKABLE) as Element | null;
        if (!clickable || !document.contains(clickable)) return;
        if (lockMode) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          return;
        }
        let sel = findLockedSelector(clickable);
        if (!sel && lockedNodes.has(clickable)) {
          // 同一ノード再訪だがセレクタ不一致 → 自己修復して継続
          sel = buildSelector(clickable);
          locked.add(sel);
          void persistLocks();
          applyLocks();
        }
        if (sel) {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.stopPropagation();
          console.debug('[btn-locker] open modal for', sel);
          openConfirmModal(clickable, sel);
        } else {
          console.debug('[btn-locker] dblclick missed lock:', describe(clickable));
        }
      },
      true,
    );

    // ---------- lock mode exit: 右クリック / Esc ----------
    document.addEventListener(
      'contextmenu',
      (e) => {
        if (!lockMode) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        setLockMode(false);
      },
      true,
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (!lockMode || e.key !== 'Escape') return;
        setLockMode(false);
      },
      true,
    );

    // ---------- lock mode aim highlight ----------
    document.addEventListener(
      'mouseover',
      (e) => {
        if (!lockMode) return;
        const t = e.target as Element | null;
        const clickable = t?.closest?.(CLICKABLE) as Element | null;
        if (currentAim && currentAim !== clickable) currentAim.classList.remove(AIM_CLASS);
        currentAim = clickable;
        if (clickable && document.contains(clickable)) clickable.classList.add(AIM_CLASS);
      },
      true,
    );

    // ---------- SPA support ----------
    let moTimer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(moTimer);
      moTimer = window.setTimeout(applyLocks, 120);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ---------- storage sync (multi-tab) ----------
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORE_KEY]) return;
      void loadLocks().then(applyLocks);
    });

    // ---------- messages (popup / background) ----------
    browser.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; selector?: string };
      if (m?.type === 'btn-locker:toggle') {
        setLockMode(!lockMode);
        return Promise.resolve({ lockMode });
      }
      if (m?.type === 'btn-locker:state') {
        return Promise.resolve({ lockMode, selectors: [...locked], origin: ORIGIN });
      }
      if (m?.type === 'btn-locker:unlock' && typeof m.selector === 'string') {
        unlockSelector(m.selector);
        return Promise.resolve({ ok: true });
      }
      if (m?.type === 'btn-locker:clear') {
        locked.clear();
        void persistLocks();
        document.querySelectorAll(`.${LOCK_CLASS}`).forEach((el) => el.classList.remove(LOCK_CLASS));
        return Promise.resolve({ ok: true });
      }
      return undefined;
    });

    // ---------- init ----------
    void loadLocks().then(applyLocks);
  },
});
