import './style.css';
import { LIMITS, applyImport, countLocks, readLocks, readPause } from '../../utils/storage';
import { ImportError, validateImport } from '../../utils/validate';

// キー型は messages.json から自動生成される union に合わせる
type I18nKey = Parameters<typeof browser.i18n.getMessage>[0];
const t = (key: I18nKey, sub?: string | string[]): string =>
  browser.i18n.getMessage(key, sub) || key;

// RTL (ar) は既存のポップアップと同じ扱い
if ((browser.i18n.getUILanguage?.() ?? 'en').toLowerCase().startsWith('ar')) {
  document.documentElement.dir = 'rtl';
}
document.documentElement.lang = browser.i18n.getUILanguage?.() ?? 'en';

// 全て DOM API (createElement / textContent) で組み立てる。innerHTML / eval は使わない
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

const status = h('p', { id: 'status' });
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');

function show(kind: 'ok' | 'err', msg: string): void {
  status.className = kind;
  status.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  status.textContent = msg;
}

// ---------- export ----------
async function doExport(): Promise<void> {
  const [locks, pause] = await Promise.all([readLocks(), readPause()]);
  const payload = {
    app: 'btn-locker',
    format: 1,
    exportedAt: new Date().toISOString(),
    locks,
    pause,
  };
  // Blob + a[download]: downloads 権限は不要
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `btn-locker-export-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  show('ok', t('exportDone', String(countLocks(locks))));
}

// ---------- import ----------
async function doImport(file: File | undefined, mode: 'merge' | 'replace'): Promise<void> {
  if (!file) return show('err', t('importNoFile'));
  if (file.size > LIMITS.maxFileBytes) return show('err', t('importTooLarge'));
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return show('err', t('importParseError'));
  }
  try {
    const data = validateImport(raw);
    const res = await applyImport(data, mode);
    show('ok', t('importDone', String(res.locks)));
  } catch (e) {
    const detail = e instanceof ImportError ? e.detail : 'limit';
    show('err', t('importInvalid', detail));
  }
}

// ---------- UI ----------
function radio(value: string, label: string, checked: boolean): HTMLElement {
  const input = h('input', { type: 'radio', name: 'mode', value, checked });
  return h('label', { className: 'opt' }, input, h('span', {}, label));
}

function build(): void {
  const app = document.getElementById('app')!;
  document.title = t('optionsTitle');

  const exportBtn = h('button', { type: 'button', className: 'primary' }, t('exportButton'));
  exportBtn.addEventListener('click', () => void doExport());

  const fileInput = h('input', { type: 'file', id: 'import-file', accept: '.json,application/json' });
  const modeSet = h(
    'fieldset',
    {},
    h('legend', {}, t('importModeLabel')),
    radio('merge', t('importModeMerge'), true),
    radio('replace', t('importModeReplace'), false),
  );
  const importBtn = h('button', { type: 'button', className: 'primary' }, t('importButton'));
  importBtn.addEventListener('click', () => {
    const mode = modeSet.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value;
    void doImport(fileInput.files?.[0], mode === 'replace' ? 'replace' : 'merge');
  });

  app.append(
    h('h1', {}, `🔒 ${t('optionsTitle')}`),
    h('section', {}, h('h2', {}, t('exportHeading')), h('p', {}, t('exportDescription')), exportBtn),
    h(
      'section',
      {},
      h('h2', {}, t('importHeading')),
      h('p', {}, t('importDescription')),
      h('label', { className: 'file', htmlFor: 'import-file' }, t('importFileLabel')),
      fileInput,
      modeSet,
      importBtn,
    ),
    status,
  );
}

build();
