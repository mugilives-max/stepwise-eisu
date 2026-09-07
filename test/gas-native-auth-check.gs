/**
 * エディタ実行用・一時検証。公開Web APIへ追加しない。
 * Code.gsの現行実関数と同梱暗号処理を、毎回新規作成する架空台帳だけで確認する。
 * setup()/ensureSchema_()/doPost()は呼ばない（getActive直参照と共有schemaキャッシュを避ける）。
 * 出力は結果boolean・計時・新規台帳URLのみ。パスワード/コード/トークン/ハッシュは出力しない。
 * 作成した台帳は削除しない。本番の先生資格情報・Script Properties・既存台帳は読まない。
 */
function stepwiseNativeAuthCheck() {
  var app = null, ledger = null, stage = 'create_test_spreadsheets';
  var started = Date.now(), checks = {}, timings = [], hashReference = '';
  var original = {
    memo: MEMO_, ss: ss_, ledger: ledger_, hash: parentPasswordHash_,
    notify: notify_, mail: mailStudent_, offerMail: offerMailToStudent_,
    createCalendar: createCalEvent_, deleteCalendar: deleteCalEvent_, meet: addMeet_
  };
  var studentId = 'native-auth-check-student', studentCode = 'native-auth-check-student-code';
  var studentName = '【テスト】認証検証';
  var fixtureAdminToken = 'native-auth-check-admin-token';
  var fixturePassword = 'NativeAuthCheck-only-20260907!';
  var fixtureWrongPassword = 'NativeAuthCheck-wrong-20260907!';
  var sideEffectCalls = 0;

  function check(condition, code) {
    checks[code] = !!condition;
    if (!condition) { var err = new Error(code); err.nativeAuthCheckCode = code; throw err; }
  }
  function deniedSideEffect() {
    sideEffectCalls++;
    var err = new Error('unexpected_mail_or_calendar_call');
    err.nativeAuthCheckCode = 'unexpected_mail_or_calendar_call';
    throw err;
  }
  function refresh() { MEMO_.rows = {}; MEMO_.lrows = {}; }
  function sheetsResult() {
    return {
      app: app ? { id: app.getId(), url: app.getUrl() } : null,
      ledger: ledger ? { id: ledger.getId(), url: ledger.getUrl() } : null
    };
  }
  function snapshot(book, names) {
    return JSON.stringify(names.map(function (name) { return book.getSheetByName(name).getDataRange().getValues(); }));
  }

  try {
    // 最初のスプレッドシート操作は必ず新規作成。既存ブックIDを開かない。
    var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss');
    app = SpreadsheetApp.create('【テスト】認証検証 予約 ' + stamp);
    ledger = SpreadsheetApp.create('【テスト】認証検証 台帳 ' + stamp);
    stage = 'isolate_dependencies';
    MEMO_ = { ss: app, ledger: ledger, rows: {}, lrows: {} };
    ss_ = function () { return app; };
    ledger_ = function () { return ledger; };
    notify_ = deniedSideEffect; mailStudent_ = deniedSideEffect; offerMailToStudent_ = deniedSideEffect;
    createCalEvent_ = deniedSideEffect; deleteCalEvent_ = deniedSideEffect; addMeet_ = deniedSideEffect;
    parentPasswordHash_ = function (pass, salt) {
      var begin = Date.now();
      var derived = original.hash(pass, salt);
      timings.push({ operation: stage, iterations: PARENT_PASSWORD_ITERATIONS_, elapsedMS: Date.now() - begin,
        hashFormatOK: /^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/.test(derived),
        matchesStoredHash: hashReference ? parentEqual_(derived, hashReference) : null });
      return derived;
    };
    check(PARENT_PASSWORD_ITERATIONS_ === 600000, 'iterations_600000');
    check(ss_().getId() === app.getId() && ledger_().getId() === ledger.getId(), 'test_dependencies_only');

    stage = 'initialize_test_schemas';
    var schema = {
      config: ['key', 'value'],
      students: ['id', 'name', 'active', 'email', 'code', 'rate30', 'monthly', 'parentToken', 'parentExp'],
      slots: ['id', 'date', 'start', 'min', 'status', 'studentId', 'done', 'eventId', 'meetUrl', 'subject', 'req'],
      blocked: ['id', 'studentId', 'date', 'note', 'start', 'end'],
      teacherOff: ['id', 'date', 'note', 'start', 'end'],
      wishes: ['id', 'studentId', 'date', 'start', 'end', 'note', 'createdAt', 'kind'],
      events: ['id', 'studentId', 'date', 'dateTo', 'title', 'createdAt', 'kind'],
      plans: ['id', 'studentId', 'ym', 'subject', 'count', 'status', 'proposedAt', 'approvedAt', 'approvedVia', 'memo'],
      tasks: ['id', 'studentId', 'type', 'title', 'due', 'createdAt', 'createdBy', 'doneAt'],
      log: ['time', 'message'], mcpLog: ['time', 'requestId', 'client', 'op', 'target', 'params', 'result', 'ms'],
      parents: PARENT_AUTH_COLUMNS_.slice()
    };
    Object.keys(schema).forEach(function (name) { ensureSheet_(app, name, schema[name]); });
    Object.keys(LEDGER_COLS).forEach(function (name) { ensureSheet_(ledger, name, LEDGER_COLS[name]); });
    app.getSheetByName('students').getRange(2, 1, 1, 9).setNumberFormat('@').setValues([
      [studentId, studentName, 'true', '', studentCode, '1500', '', '', '']
    ]);
    var fixtureConfig = {
      passHash: 'native-check-placeholder-not-a-real-teacher-hash', passSalt: 'native-check-placeholder-salt',
      adminToken: fixtureAdminToken, adminTokenExp: String(Date.now() + 3600000),
      calendarSync: 'off', emailNotify: 'off', teacherEmail: ''
    };
    Object.keys(fixtureConfig).forEach(function (key) { setConfig_(key, fixtureConfig[key]); });
    ensureParentAuthSheet_(); refresh();
    check(isTestStudent_(findStudentByCode_(studentCode)), 'fixture_is_test_student');
    var unchangedSheets = ['config', 'students', 'slots', 'blocked', 'teacherOff', 'wishes', 'events', 'plans', 'tasks'];
    var beforeApp = snapshot(app, unchangedSheets), beforeLedger = snapshot(ledger, Object.keys(LEDGER_COLS));

    stage = 'issue_setup_code';
    var unauth = adminParentIssueSetupCode_({ studentId: studentId, token: 'invalid-native-fixture-token' });
    check(!!unauth.badAuth, 'invalid_admin_token_rejected');
    var issue = adminParentIssueSetupCode_({ studentId: studentId, token: fixtureAdminToken });
    check(issue.ok && /^\d{6}$/.test(issue.setupCode), 'setup_code_issued');
    refresh();
    var issuedRecord = parentRecord_(studentId);
    check(issuedRecord.setupHash === parentDigest_('setup', studentId, issue.setupCode), 'setup_hash_matches');
    check(issuedRecord.setupHash !== issue.setupCode, 'setup_code_not_stored_plain');

    stage = 'parent_setup';
    var setupResult = parentSetup_({ k: studentCode, setupCode: issue.setupCode, pass: fixturePassword });
    check(setupResult.ok && !!setupResult.ptoken, 'parent_setup_succeeds');
    refresh(); hashReference = String(parentRecord_(studentId).passHash);
    check(/^pbkdf2-sha256\$600000\$[a-f0-9]{64}$/.test(hashReference), 'stored_password_hash_format');
    check(!parentRecord_(studentId).setupHash, 'setup_code_consumed');
    check(!!parentSetup_({ k: studentCode, setupCode: issue.setupCode, pass: fixturePassword }).error, 'consumed_setup_code_rejected');

    stage = 'login_wrong_password';
    var wrong = parentLogin_({ k: studentCode, pass: fixtureWrongPassword });
    check(!!wrong.error && !wrong.ptoken, 'wrong_password_rejected');
    refresh(); check(Number(parentRecord_(studentId).failCount) === 1, 'failed_login_counted');

    stage = 'login_correct_password';
    var login = parentLogin_({ k: studentCode, pass: fixturePassword });
    check(login.ok && !!login.ptoken, 'correct_password_succeeds');
    refresh();
    var current = parentRecord_(studentId);
    check(current.passHash === hashReference, 'password_hash_unchanged');
    check(Number(current.failCount) === 0, 'failed_login_count_reset');
    check(current.tokenHash === parentDigest_('session', studentId, login.ptoken), 'token_hash_matches');
    check(current.tokenHash !== login.ptoken, 'token_not_stored_plain');
    check(!!parentData_({ k: studentCode, ptoken: setupResult.ptoken }).parentAuthRequired, 'old_session_rejected');

    stage = 'read_parent_data';
    var data = parentData_({ k: studentCode, ptoken: login.ptoken });
    check(data.ok && data.data && data.data.name === studentName, 'parent_data_succeeds');
    var publicData = JSON.stringify(data.data);
    check(publicData.indexOf(hashReference) < 0 && publicData.indexOf(login.ptoken) < 0 &&
      publicData.indexOf(fixturePassword) < 0 && publicData.indexOf(issue.setupCode) < 0, 'parent_data_has_no_auth_secrets');

    stage = 'logout';
    check(parentLogout_({ k: studentCode, ptoken: login.ptoken }).ok, 'logout_succeeds');
    refresh();
    check(!!parentData_({ k: studentCode, ptoken: login.ptoken }).parentAuthRequired, 'logged_out_session_rejected');

    stage = 'session_expiry';
    var fresh = parentIssueSession_(parentRecord_(studentId));
    check(fresh.ok, 'session_reissued');
    check(parentLogout_({ k: studentCode, ptoken: login.ptoken }).ok, 'stale_logout_succeeds');
    refresh();
    check(parentData_({ k: studentCode, ptoken: fresh.ptoken }).ok, 'stale_logout_keeps_new_session');
    var expired = parentRecord_(studentId); expired.tokenExpiresAt = Date.now() - 1; parentWrite_(expired); refresh();
    check(!!parentData_({ k: studentCode, ptoken: fresh.ptoken }).parentAuthRequired, 'expired_session_rejected');

    stage = 'assert_no_side_effects';
    check(sideEffectCalls === 0, 'no_mail_or_calendar_calls');
    check(beforeApp === snapshot(app, unchangedSheets), 'unrelated_app_sheets_unchanged');
    check(beforeLedger === snapshot(ledger, Object.keys(LEDGER_COLS)), 'ledger_sheets_unchanged');
    check(timings.length === 3 && timings.every(function (x) { return x.iterations === 600000 && x.hashFormatOK; }), 'three_native_600000_derivations');
    check(timings[1].matchesStoredHash === false && timings[2].matchesStoredHash === true, 'derived_hash_match_checks');
    var result = { ok: true, elapsedMS: Date.now() - started, checks: checks, derivations: timings, testSpreadsheets: sheetsResult() };
    Logger.log(JSON.stringify(result));
    return result;
  } catch (err) {
    // 生の例外文/レスポンスは出さない。想定外エラーにも秘密が混入しない形で工程を記録する。
    var failure = { ok: false, error: { stage: stage, code: err.nativeAuthCheckCode || 'unexpected_error', type: String(err.name || 'Error') }, testSpreadsheets: sheetsResult() };
    Logger.log(JSON.stringify(failure));
    return failure;
  } finally {
    MEMO_ = original.memo; ss_ = original.ss; ledger_ = original.ledger; parentPasswordHash_ = original.hash;
    notify_ = original.notify; mailStudent_ = original.mail; offerMailToStudent_ = original.offerMail;
    createCalEvent_ = original.createCalendar; deleteCalEvent_ = original.deleteCalendar; addMeet_ = original.meet;
  }
}
