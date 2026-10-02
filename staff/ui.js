// スタッフの画面で共通の部品。
// 下から出る画面（パソコンでは真ん中）。一覧はすっきり、操作は押すと出るこの画面で（docs/UX_STRUCTURE.md 1-4）
export const sheet = (esc, title, body, closeAction, opts = {}) => `<div class="overlay" data-action="${closeAction}"></div><section class="bsheet${opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="bsheet-head"><strong>${esc(title)}</strong><button class="icon" data-action="${closeAction}" aria-label="閉じる">×</button></div><div class="bsheet-body">${body}</div></section>`;
// 一覧の1行（押すと下から出る画面を開く）。title と note は HTML（呼ぶ側で esc する）
// 押すとほかの画面へ移る行
export const rowLink = (href, title, note, side = '') => `<a class="todo" href="${href}"><span class="b"><strong>${title}</strong><small class="muted">${note}</small></span>${side}<span class="go">›</span></a>`;
export const rowButton = (esc, action, data, title, note) => `<button type="button" class="todo" data-action="${action}"${Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}><span class="b"><strong>${title}</strong><small class="muted">${note}</small></span><span class="go">›</span></button>`;
// 段階のあるスライダー（離散スライダー）。options は [値, 表示] を小さい順に。まだ選んでいないときは薄く出し、触ると決まる
// 値は hidden の name に入る（フォームで送る）。前の記録の自由な値は「前: …」と出して、動かすまで残す
export function slider(esc, { name, label, value, options, compact }) {
  const i = options.findIndex(o => o[0] === value), set = i >= 0, legacy = value && !set;
  const t = set ? i / (options.length - 1) : 0;
  const shown = set ? options[i][1] : legacy ? '前: ' + value : compact ? '—' : 'まだ選んでいません';
  const box = `<div class="slider${compact ? ' sm' : ''}${set ? '' : ' unset'}" style="--t:${t}"><div class="slider-track"><span class="fill"></span>${options.map((o, k) => `<i class="${set && k <= i ? 'on' : ''}" style="--k:${k / (options.length - 1)}"></i>`).join('')}</div>
    <input type="range" min="0" max="${options.length - 1}" step="1" value="${set ? i : 0}" data-slider='${esc(JSON.stringify(options))}' aria-label="${esc(label)}" aria-valuetext="${esc(shown)}"></div>`;
  // 小さい版: 1行に「ラベル・スライダー・値」
  if (compact) return `<div class="slider-wrap rec-line"><span class="k">${esc(label)}</span>${box}<strong class="slider-value">${esc(shown)}</strong><input type="hidden" name="${esc(name)}" value="${esc(value || '')}"></div>`;
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
