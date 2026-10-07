// スタッフの画面: 家族と生徒（教室管理者）。家族を先に登録し、その下に生徒を登録する。
// ctx は app.js から渡す共通の道具（call / say / render / run / esc / busy / notice）。
// 一覧はすっきり、直す・足す・生徒ごとの操作は押すと下から出る画面で（famSheet = { mode, id }）。
import { sheet, rowButton, rowLink } from '/staff/ui.js?v=20261008-launch1';
const STATUS = { invited: ['warn', '招待前・登録待ち'], active: ['', '利用中'], stopped: ['gray', '停止'] };
const STUDENT_STATUS = { enrolled: ['', '在籍'], paused: ['warn', '休会'], left: ['gray', '退会'] };
const MODE = { '': '未設定', in_person: '対面', online: 'オンライン' };
let list = null, detail = null, query = '', shown = null, famSheet = null;

export function resetFamilies() { list = null; detail = null; shown = null; famSheet = null; }

const tag = ([cls, label]) => `<span class="tag ${cls}">${label}</span>`;
const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
const match = (f, q) => !q || [f.name, f.guardianName, f.email, ...f.students.map(s => s.name + (s.familyKana || '') + (s.givenKana || ''))].join(' ').toLowerCase().includes(q.toLowerCase());

export function familiesPage(ctx) {
  const { esc } = ctx;
  if (!list) { load(ctx); return '<p class="muted" style="margin-top:20px">読み込んでいます…</p>'; }
  let h = ctx.notice();
  h += `<div class="row" style="margin-top:10px"><label class="search" style="flex:1;margin:0"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input type="search" placeholder="名前・ふりがな・メールで探す" value="${esc(query)}" data-input="fam-query" aria-label="家族を探す"></label><button class="primary" data-action="fam-sheet" data-mode="create"${ctx.dis()}>家族を登録</button></div>`;
  const shownList = list.filter(f => match(f, query));
  h += `<div class="sec-title">${shownList.length}家族</div><div class="group">` + shownList.map(f => rowLink('#family=' + encodeURIComponent(f.id), `${esc(f.name)} ${tag(STATUS[f.status] || ['gray', f.status])}${f.testOnly ? '<span class="tag gray">テスト</span>' : ''}`,
    `${f.students.length ? f.students.map(s => `${esc(s.name)}（${esc(s.grade || '学年なし')}）${s.status === 'enrolled' ? '' : tag(STUDENT_STATUS[s.status])}`).join('、') : '生徒がいません'}<br>${esc(f.guardianName || '保護者名なし')}・${esc(f.email || 'メールなし')}`)).join('') + '</div>';
  if (famSheet && famSheet.mode === 'create') h += sheet(esc, '家族を登録', `<form class="stack" data-form="fam-create">${familyInputs(esc, {})}<button class="primary"${ctx.dis()}>登録する</button><p class="small muted">登録したあと、この家族の画面で生徒を足し、保護者ページの招待を送れます。</p></form>`, 'fam-close');
  return h;
}

function familyInputs(esc, f) {
  return `<label>家族の表示名（例: 山田家）<input name="name" maxlength="60" required value="${esc(f.name || '')}"></label>
    <label>保護者の名前<input name="guardianName" maxlength="60" value="${esc(f.guardianName || '')}"></label>
    <label>保護者のメールアドレス（保護者ページのログインと連絡に使う）<input type="email" name="email" value="${esc(f.email || '')}"></label>
    <label>電話<input name="phone" maxlength="30" value="${esc(f.phone || '')}"></label>
    <label>メモ（教室だけが見る）<input name="note" maxlength="1000" value="${esc(f.note || '')}"></label>`;
}
function studentInputs(esc, s) {
  const opt = (map, v) => Object.entries(map).map(([k, x]) => `<option value="${k}"${k === v ? ' selected' : ''}>${Array.isArray(x) ? x[1] : x}</option>`).join('');
  return `<div class="row"><label style="flex:1">姓<input name="familyName" maxlength="40" value="${esc(s.familyName || '')}"></label><label style="flex:1">名<input name="givenName" maxlength="40" value="${esc(s.givenName || '')}"></label></div>
    <div class="row"><label style="flex:1">せい<input name="familyKana" maxlength="40" value="${esc(s.familyKana || '')}"></label><label style="flex:1">めい<input name="givenKana" maxlength="40" value="${esc(s.givenKana || '')}"></label></div>
    <div class="row"><label style="flex:1">学年<input name="grade" maxlength="20" value="${esc(s.grade || '')}"></label><label style="flex:2">学校<input name="school" maxlength="60" value="${esc(s.school || '')}"></label></div>
    <label>受講科目（メモ）<input name="subjects" maxlength="100" value="${esc(s.subjects || '')}"></label>
    <div class="row"><label style="flex:1">基本単価（30分・円）<input type="number" name="baseRate30" min="0" max="100000" step="10" value="${esc(s.baseRate30 ?? 0)}"></label>
      <label style="flex:1">授業の形式（初期値）<select name="deliveryMode">${opt(MODE, s.deliveryMode || '')}</select></label></div>
    <div class="row"><label style="flex:1">在籍<select name="status">${opt(STUDENT_STATUS, s.status || 'enrolled')}</select></label><label style="flex:1">入塾日<input type="date" name="enrolledOn" value="${esc(s.enrolledOn || '')}"></label></div>
    <label>メモ（教室だけが見る）<input name="note" maxlength="1000" value="${esc(s.note || '')}"></label>`;
}

export const familyBar = () => detail && detail.name ? { title: detail.name, sub: '家族', right: '' } : { title: '家族', sub: '', right: '' };
export function familyDetailPage(ctx, id) {
  const { esc } = ctx;
  if (!detail || detail.id !== id) { loadDetail(ctx, id); return '<p class="muted" style="margin-top:24px">読み込んでいます…</p>'; }
  const f = detail;
  let h = `<p style="margin:12px 0 0">${tag(STATUS[f.status] || ['gray', f.status])}${f.testOnly ? '<span class="tag gray">テスト</span>' : ''}<span class="small muted">契約は家族ごと。兄弟は同じ家族に入れます。</span></p>${ctx.notice()}`;
  if (shown) h += `<div class="notice ok"><p>${esc(shown.text)}</p>${shown.url ? `<p class="copy">${esc(shown.url)}</p><button data-action="copy" data-text="${esc(shown.url)}">リンクをコピー</button>` : ''}</div>`;
  h += '<div class="sec-title">保護者</div><div class="group">' + rowButton(esc, 'fam-sheet', { mode: 'family', id: f.id }, esc(f.guardianName || '保護者名なし'), `${esc(f.email || 'メールなし')}${f.phone ? '・' + esc(f.phone) : ''}・保護者ページ ${f.hasPassword ? '登録済み' : '未登録'}${f.note ? '<br>メモ: ' + esc(f.note) : ''}`) + '</div>';
  h += `<div class="row" style="margin-top:10px"><button data-action="pv-open" data-kind="family" data-id="${esc(f.id)}">保護者ページを見る（プレビュー）</button>${f.email && f.status !== 'stopped' ? `<button data-action="fam-invite"${ctx.dis()}>${f.hasPassword ? '登録のやり直しを案内する' : '保護者ページの招待を送る'}</button>` : ''}
    ${f.status === 'stopped' ? `<button data-action="fam-status" data-status="${f.hasPassword ? 'active' : 'invited'}"${ctx.dis()}>再開する</button>` : `<button class="danger" data-action="fam-status" data-status="stopped"${ctx.dis()}>停止する</button>`}</div>`;
  h += `<div class="sec-title">生徒 <span class="count gray">${f.students.length}</span></div><div class="group">` + f.students.map(s => rowButton(esc, 'fam-sheet', { mode: 'student', id: s.id }, `${esc(s.name)} ${tag(STUDENT_STATUS[s.status])}${s.testOnly ? '<span class="tag gray">テスト</span>' : ''}`,
    `${esc(s.grade || '学年なし')}・${esc(s.school || '学校なし')}・${MODE[s.deliveryMode || '']}・基本単価 ${yen(s.baseRate30)}（30分）`)).join('') + '</div>';
  h += `<p style="margin-top:10px"><button data-action="fam-sheet" data-mode="add"${ctx.dis()}>＋ 生徒を足す</button></p>`;
  return h + familySheet(ctx, f);
}
function familySheet(ctx, f) {
  const { esc } = ctx, m = famSheet && famSheet.mode;
  if (!m || m === 'create') return '';
  if (m === 'family') return sheet(esc, '保護者の情報を直す', `<form class="stack" data-form="fam-update">${familyInputs(esc, f)}<button class="primary"${ctx.dis()}>保存</button></form>`, 'fam-close');
  if (m === 'add') return sheet(esc, '生徒を足す', `<form class="stack" data-form="stu-create">${studentInputs(esc, { status: 'enrolled' })}<button class="primary"${ctx.dis()}>この家族に生徒を足す</button></form>`, 'fam-close');
  const s = f.students.find(x => x.id === famSheet.id); if (!s) return '';
  if (m === 'edit') return sheet(esc, s.name + ' を直す', `<form class="stack" data-form="stu-update" data-id="${esc(s.id)}" data-version="${s.version}">${studentInputs(esc, s)}<div class="row"><button class="primary"${ctx.dis()}>保存</button><button type="button" data-action="fam-sheet" data-mode="student" data-id="${esc(s.id)}">やめる</button></div></form>`, 'fam-close');
  if (m === 'move') return sheet(esc, s.name + ' を別の家族へ移す', `<form class="stack" data-form="stu-move" data-id="${esc(s.id)}" data-version="${s.version}"><label>移す先の家族<select name="familyId">${(list || []).filter(x => x.id !== f.id).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label><div class="row"><button class="primary"${ctx.dis()}>移す</button><button type="button" data-action="fam-sheet" data-mode="student" data-id="${esc(s.id)}">やめる</button></div></form>`, 'fam-close');
  return sheet(esc, s.name, `<p class="small muted" style="margin-top:0">${esc(s.grade || '学年なし')}・${esc(s.school || '学校なし')}・${MODE[s.deliveryMode || '']}・基本単価 ${yen(s.baseRate30)}（30分）${s.note ? '<br>メモ: ' + esc(s.note) : ''}</p>
    <div class="stack"><a class="btn" href="#student=${encodeURIComponent(s.id)}">生徒の画面を開く</a>
    <button data-action="fam-sheet" data-mode="edit" data-id="${esc(s.id)}"${ctx.dis()}>登録内容を直す</button>
    <button data-action="pv-open" data-kind="student" data-id="${esc(s.id)}">生徒ページを見る（プレビュー）</button>
    <button data-action="copy" data-text="${esc(s.link)}">専用リンクをコピー</button>
    <button data-action="stu-newlink" data-id="${esc(s.id)}" data-version="${s.version}"${ctx.dis()}>専用リンクを作り直す</button>
    <button data-action="fam-sheet" data-mode="move" data-id="${esc(s.id)}"${ctx.dis()}>別の家族へ移す</button></div>`, 'fam-close');
}

async function load(ctx) {
  const r = await ctx.call('admin/families/list');
  if (!r.ok) { list = []; if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error'); } else list = r.families;
  ctx.render();
}
async function loadDetail(ctx, id) {
  detail = { id, loading: true };
  const r = await ctx.call('admin/families/get', { id });
  if (!r.ok) { detail = null; if (!ctx.handleAuth(r)) { ctx.say(r.error.message, 'error'); location.hash = '#families'; } }
  else { detail = r.family; if (!list) load(ctx); }
  ctx.render();
}
const values = el => Object.fromEntries(new FormData(el).entries());
const studentBody = v => ({ ...v, baseRate30: Number(v.baseRate30 || 0) });

// 送信（フォーム）。扱ったら true
export async function familiesSubmit(ctx, kind, el) {
  const v = values(el);
  let r;
  if (kind === 'fam-create') {
    r = await ctx.call('admin/families/create', v);
    if (r.ok) { famSheet = null; list = null; location.hash = '#family=' + encodeURIComponent(r.family.id); ctx.say('家族を登録しました。続けて生徒を足してください', 'ok'); return true; }
  } else if (kind === 'fam-update') {
    r = await ctx.call('admin/families/update', { id: detail.id, version: detail.version, ...v });
    if (r.ok) { famSheet = null; detail = null; list = null; ctx.say('保存しました', 'ok'); return true; }
  } else if (kind === 'stu-create') {
    r = await ctx.call('admin/students/create', { familyId: detail.id, ...studentBody(v) });
    if (r.ok) { famSheet = null; detail = null; list = null; ctx.say(r.student.name + ' さんを足しました', 'ok'); return true; }
  } else if (kind === 'stu-update') {
    r = await ctx.call('admin/students/update', { id: el.dataset.id, version: Number(el.dataset.version), ...studentBody(v) });
    if (r.ok) { famSheet = null; detail = null; list = null; ctx.say('保存しました', 'ok'); return true; }
  } else if (kind === 'stu-move') {
    r = await ctx.call('admin/students/move', { id: el.dataset.id, version: Number(el.dataset.version), familyId: v.familyId });
    if (r.ok) { famSheet = null; detail = null; list = null; ctx.say(r.student.name + ' さんを移しました', 'ok'); return true; }
  } else return false;
  if (!ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}

// 押す（ボタン）。扱ったら true
export async function familiesClick(ctx, a, b) {
  let r;
  if (a === 'fam-sheet') { famSheet = { mode: b.dataset.mode, id: b.dataset.id || '' }; ctx.say(''); return true; }
  if (a === 'fam-close') { famSheet = null; return true; }
  if (a === 'fam-invite') {
    r = await ctx.call('admin/families/invite', { id: detail.id });
    if (r.ok) { shown = { text: r.mailHeld ? '招待のリンクを作りました。まだ切り替え前のため、メールは実際には送っていません。試すときはこのリンクを使ってください（7日有効・1回だけ）。' : '招待のメールを送りました。届かないときは、このリンクを LINE などで渡してください（7日有効・1回だけ）。', url: r.inviteUrl }; ctx.say(''); return true; }
  } else if (a === 'fam-status') {
    if (b.dataset.status === 'stopped' && !confirm('この家族を停止しますか？ 保護者ページにログインできなくなります。')) return true;
    r = await ctx.call('admin/families/update', { id: detail.id, version: detail.version, status: b.dataset.status });
    if (r.ok) { detail = null; list = null; ctx.say('状態を変えました', 'ok'); return true; }
  } else if (a === 'stu-newlink') {
    if (!confirm('専用リンクを作り直しますか？ 今のリンクはすぐに使えなくなります。生徒に新しいリンクを渡してください。')) return true;
    r = await ctx.call('admin/students/newLink', { id: b.dataset.id, version: Number(b.dataset.version) });
    if (r.ok) { famSheet = null; detail = null; shown = { text: r.student.name + ' さんの新しい専用リンクです。', url: r.student.link }; ctx.say(''); return true; }
  } else return false;
  if (r && !ctx.handleAuth(r)) ctx.say(r.error.message, 'error');
  return true;
}
export function familiesInput(ctx, name, el) {
  if (name !== 'fam-query') return false;
  query = el.value; const pos = el.selectionStart; ctx.render();
  const again = document.querySelector('[data-input="fam-query"]'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  return true;
}
export function leaveFamilies() { shown = null; famSheet = null; }
