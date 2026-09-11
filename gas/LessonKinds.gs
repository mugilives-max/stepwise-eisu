/* 授業の種類(通常・演習・講習・英検対策など)。固定の一覧を lessonKinds シートで管理し、
 * 月間計画(plans.kind)と授業(slots.kind)に付ける。空文字は「通常」を意味する
 * (既存データとの互換のため、通常は空で保存し、承認 JSON にも含めない)。
 * 標準の時間・料金は第2段階(種類別の料金計算)で使う。ここでは保存と表示だけ。 */
var LESSON_KIND_COLS_ = ['name', 'standardMin', 'standardFee', 'active', 'sortOrder', 'updatedAt'];
var LESSON_KIND_DEFAULT_ = '通常';

function ensureLessonKindsSheet_() {
  var ss = ss_(), sh = ss.getSheetByName('lessonKinds');
  if (!sh) {
    sh = ss.insertSheet('lessonKinds');
    sh.appendRow(LESSON_KIND_COLS_);
    sh.appendRow([LESSON_KIND_DEFAULT_, '', '', 'true', 1, new Date()]);
    memoClear_();
  }
  return sh;
}
// slots 13列目・plans 11列目に kind を追加する(既存行は空=通常)
function ensureKindColumns_() {
  var sh = ss_().getSheetByName('slots');
  if (sh && sh.getRange(1, 13).getValue() !== 'kind') sh.getRange(1, 13).setValue('kind');
  var ph = ss_().getSheetByName('plans');
  if (ph && ph.getRange(1, 11).getValue() !== 'kind') ph.getRange(1, 11).setValue('kind');
}
function kindNorm_(k) { k = String(k == null ? '' : k).trim(); return k === LESSON_KIND_DEFAULT_ ? '' : k; }
function kindLabel_(subject, kind) { var k = kindNorm_(kind); return String(subject || '') + (k ? '（' + k + '）' : ''); }
function lessonKinds_() {
  var rows = ss_().getSheetByName('lessonKinds') ? readRows_('lessonKinds') : [];
  var out = rows.map(function (r, i) { return { r: r, i: i }; }).filter(function (x) { return String(x.r.name || '').trim(); }).map(function (x) {
    var r = x.r;
    return { name: String(r.name).trim(), standardMin: r.standardMin === '' || r.standardMin == null ? null : Number(r.standardMin), standardFee: r.standardFee === '' || r.standardFee == null ? null : Number(r.standardFee),
      active: !(String(r.active) === 'false' || r.active === false), sortOrder: Number(r.sortOrder) || (x.i + 1), _row: x.i + 2 };
  });
  if (!out.some(function (k) { return k.name === LESSON_KIND_DEFAULT_; })) out.unshift({ name: LESSON_KIND_DEFAULT_, standardMin: null, standardFee: null, active: true, sortOrder: 0, _row: 0 });
  out.sort(function (a, b) { if (a.name === LESSON_KIND_DEFAULT_) return -1; if (b.name === LESSON_KIND_DEFAULT_) return 1; return (a.sortOrder - b.sortOrder) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  return out;
}
function lessonKindsPublic_() { return lessonKinds_().map(function (k) { return { name: k.name, standardMin: k.standardMin, standardFee: k.standardFee, active: k.active }; }); }
function kindValid_(k) { k = kindNorm_(k); return !k || lessonKinds_().some(function (x) { return x.name === k && x.active; }); }
function kindError_() { return { error: '授業の種類は ' + lessonKinds_().filter(function (k) { return k.active; }).map(function (k) { return k.name; }).join('・') + ' から選んでください', errorCode: 'kindInvalid' }; }

// 先生: 種類の追加・変更。名前は変更しない(計画・授業が名前で参照する)。使わなくなった種類は active=false。「通常」は無効にできない
function lessonKindSave_(req) {
  var name = String(req.name || '').trim();
  if (!name || name.length > 20 || /^[=+@-]/.test(name) || /[（）()]/.test(name)) return { error: '種類の名前は20文字以内で、かっこを含めずに入力してください' };
  var min = req.standardMin === '' || req.standardMin == null ? '' : Number(req.standardMin), fee = req.standardFee === '' || req.standardFee == null ? '' : Number(req.standardFee);
  if (min !== '' && !(Number.isInteger(min) && min >= 30 && min <= 480)) return { error: '標準の時間は30〜480分の整数で入力してください' };
  if (fee !== '' && !(Number.isInteger(fee) && fee >= 0 && fee <= 1000000)) return { error: '標準の料金は0〜1,000,000円の整数で入力してください' };
  var active = !(req.active === false || String(req.active) === 'false');
  if (name === LESSON_KIND_DEFAULT_ && !active) return { error: '「通常」は無効にできません' };
  var sh = ensureLessonKindsSheet_(), kinds = lessonKinds_(), found = kinds.filter(function (k) { return k.name === name && k._row; })[0];
  var row = [name, min, fee, active ? 'true' : 'false', found ? found.sortOrder : kinds.length + 1, new Date()];
  if (found) sh.getRange(found._row, 1, 1, LESSON_KIND_COLS_.length).setValues([row]); else sh.appendRow(row);
  memoClear_();
  addLog_('先生が授業の種類を' + (found ? '変更' : '追加') + '(' + name + (active ? '' : '・無効') + ')');
  return { ok: true, lessonKinds: lessonKindsPublic_() };
}
