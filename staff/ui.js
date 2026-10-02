// スタッフの画面で共通の部品。
// 下から出る画面（パソコンでは真ん中）。一覧はすっきり、操作は押すと出るこの画面で（docs/UX_STRUCTURE.md 1-4）
export const sheet = (esc, title, body, closeAction) => `<div class="overlay" data-action="${closeAction}"></div><section class="bsheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="bsheet-head"><strong>${esc(title)}</strong><button class="icon" data-action="${closeAction}" aria-label="閉じる">×</button></div><div class="bsheet-body">${body}</div></section>`;
// 一覧の1行（押すと下から出る画面を開く）
export const rowButton = (esc, action, data, title, note) => `<button type="button" class="todo" data-action="${action}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}><span class="b"><strong>${title}</strong><small class="muted">${note}</small></span><span class="go">›</span></button>`;
