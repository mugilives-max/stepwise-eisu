// スタッフの画面で共通の部品。
// 下から出る画面（パソコンでは真ん中）。一覧はすっきり、操作は押すと出るこの画面で（docs/UX_STRUCTURE.md 1-4）
export const sheet = (esc, title, body, closeAction, opts = {}) => `<div class="overlay" data-action="${closeAction}"></div><section class="bsheet${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="bsheet-head"><strong>${esc(title)}</strong><button class="icon" data-action="${closeAction}" aria-label="閉じる">×</button></div><div class="bsheet-body">${body}</div></section>`;
// 一覧の1行（押すと下から出る画面を開く）。title と note は HTML（呼ぶ側で esc する）
// 押すとほかの画面へ移る行
export const rowLink = (href, title, note, side = '') => `<a class="todo" href="${href}"><span class="b"><strong>${title}</strong><small class="muted">${note}</small></span>${side}<span class="go">›</span></a>`;
export const rowButton = (esc, action, data, title, note) => `<button type="button" class="todo" data-action="${action}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}><span class="b"><strong>${title}</strong><small class="muted">${note}</small></span><span class="go">›</span></button>`;
// 段階のあるスライダー（離散スライダー）。options は [値, 表示] を小さい順に。まだ選んでいないときは薄く出し、触ると決まる
// 値は hidden の name に入る（フォームで送る）。前の記録の自由な値は「前: …」と出して、動かすまで残す
// 行の頭の色つきアイコン（iPhone の設定の形）。文字の見出しの代わり
export const ICON = {
  range: '<path d="M4 6c2.5-1.2 5.3-1.2 8 .8 2.7-2 5.5-2 8-.8v12c-2.5-1.2-5.3-1.2-8 .8-2.7-2-5.5-2-8-.8z"/><path d="M12 6.8v12"/>',
  understanding: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3.5a5.5 5.5 0 0 0-3.3 9.9c.7.6 1 1.4 1 2.3v.3h4.6v-.3c0-.9.3-1.7 1-2.3A5.5 5.5 0 0 0 12 3.5z"/>',
  comment: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  homework: '<rect x="5.5" y="4.5" width="13" height="16" rx="2"/><path d="M9 4.5h6v2.5H9zM9 13l2 2 4-4"/>',
  next: '<path d="M6 21V4.5h10.5l-2 3.8 2 3.7H6"/>',
  accuracy: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6"/>',
  pencil: '<path d="M5 19l1-4 9.5-9.5a2.1 2.1 0 0 1 3 3L9 18z"/><path d="M14 7l3 3"/>',
  parent: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="10" r="2.2"/><path d="M15.5 14.6c2.2.1 4 1.4 4.5 4"/>',
  memo: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 11h6M9 15h4"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  file: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5V8h4M9.5 12.5h5M9.5 16h5"/>',
  yen: '<path d="M7 4l5 7 5-7M12 11v9M8 13h8M8 16.5h8"/>',
  plan: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4M9 14.5l2 2 4-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  video: '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
};
export const iconBox = (k, label) => `<span class="ibox i-${k}" role="img" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg></span>`;
export const miniIcon = (k, on, label) => `<span class="mini-i${on ? ' on' : ''}" title="${label}" aria-label="${label}${on ? 'あり' : 'なし'}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg></span>`;
export function slider(esc, { name, label, value, options, compact, icon }) {
  const i = options.findIndex(o => o[0] === value), set = i >= 0, legacy = value && !set;
  const t = set ? i / (options.length - 1) : 0;
  const shown = set ? options[i][1] : legacy ? '前: ' + value : compact ? '—' : 'まだ選んでいません';
  const box = `<div class="slider${compact ? ' sm' : ''}${set ? '' : ' unset'}" style="--t:${t}"><div class="slider-track"><span class="fill"></span>${options.map((o, k) => `<i class="${set && k <= i ? 'on' : ''}" style="--k:${k / (options.length - 1)}"></i>`).join('')}</div>
    <input type="range" min="0" max="${options.length - 1}" step="1" value="${set ? i : 0}" data-slider='${esc(JSON.stringify(options))}' aria-label="${esc(label)}" aria-valuetext="${esc(shown)}"></div>`;
  // 小さい版: 1行に「ラベル・スライダー・値」
  if (compact) return `<div class="slider-wrap rec-line">${icon ? iconBox(icon, esc(label)) : `<span class="k">${esc(label)}</span>`}${box}<strong class="slider-value">${esc(shown)}</strong><input type="hidden" name="${esc(name)}" value="${esc(value || '')}"></div>`;
  return `<div class="slider-wrap"><div class="field-label slider-head"><span>${esc(label)}</span><strong class="slider-value">${esc(shown)}</strong></div>
    <div class="slider${set ? '' : ' unset'}" style="--t:${t}"><div class="slider-track"><span class="fill"></span>${options.map((o, k) => `<i class="${set && k <= i ? 'on' : ''}" style="--k:${k / (options.length - 1)}"></i>`).join('')}</div>
    <input type="range" min="0" max="${options.length - 1}" step="1" value="${set ? i : 0}" data-slider='${esc(JSON.stringify(options))}' aria-label="${esc(label)}" aria-valuetext="${esc(shown)}"></div>
    <input type="hidden" name="${esc(name)}" value="${esc(value || '')}"></div>`;
}
// スライダーを動かしたとき（描き直さずに、その場で見た目と値を変える）
export function sliderInput(el) {
  const options = JSON.parse(el.dataset.slider), k = Number(el.value), wrap = el.closest('.slider-wrap'), box = el.closest('.slider');
  box.style.setProperty('--t', k / (options.length - 1)); box.classList.remove('unset');
  box.querySelectorAll('.slider-track i').forEach((d, j) => d.classList.toggle('on', j <= k));
  wrap.querySelector('input[type=hidden]').value = options[k][0];
  wrap.querySelector('.slider-value').textContent = options[k][1]; el.setAttribute('aria-valuetext', options[k][1]);
}
