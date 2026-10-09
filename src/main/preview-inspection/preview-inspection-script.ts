/**
 * Main-owned read-only Preview inspection script (Stage 27).
 *
 * The Worker never supplies JavaScript. This is the ONLY script that
 * may reach Electron executeJavaScript for Preview inspection. It
 * inspects DOM/document properties only and never mutates the page:
 * no navigation, no events, no attribute writes, no history, no
 * storage, no input values. The service sanitizes its raw output
 * (bounds, privacy, same-origin hrefs) before returning to the
 * Worker. Provider/model/renderer may not modify this script.
 */
export const MAIN_OWNED_PREVIEW_INSPECTION_SCRIPT = `(() => {
  const doc = document;
  const title = String(doc.title || '').slice(0, 500);
  const ready = String(doc.readyState || '');
  const pageUrl = String(doc.URL || '');
  const root = doc.body || doc.documentElement;
  const rawText = root && typeof root.innerText === 'string' ? root.innerText : '';
  const seen = doc.querySelectorAll('h1,h2,h3,h4,h5,h6,button,a,input,textarea,select,[role]');
  const out = [];
  const limit = 100;
  let count = 0;
  for (const el of seen) {
    if (count >= limit) break;
    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute ? (el.getAttribute('role') || null) : null;
    const kind = el.getAttribute ? (el.getAttribute('type') || null) : null;
    const label = el.getAttribute ? (el.getAttribute('name') || null) : null;
    const aria = el.getAttribute ? (el.getAttribute('aria-label') || null) : null;
    const hold = el.getAttribute ? (el.getAttribute('placeholder') || null) : null;
    let link = null;
    const rawHref = el.getAttribute ? el.getAttribute('href') : null;
    if (typeof rawHref === 'string' && rawHref !== '') link = rawHref;
    let wording = '';
    if (typeof el.innerText === 'string') wording = el.innerText;
    else if (typeof el.alt === 'string') wording = el.alt;
    out.push({ tag, role, type: kind, name: label, ariaLabel: aria, placeholder: hold, text: String(wording || ''), href: link });
    count += 1;
  }
  return { title, readyState: ready, url: pageUrl, visibleText: String(rawText || ''), elements: out };
})()`
