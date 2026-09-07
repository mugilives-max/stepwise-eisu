'use strict';

const { createHarness, TEACHER_TOKEN } = require('../gas-harness.cjs');

// Real public dispatch + real source with isolated sheets. Only MailApp and
// its test guard are replaced for a memory-only mailbox; no network is used.
function createFamilyHarness(options = {}) {
  const h = createHarness({ iterations: 10, ...options });
  const mailbox = [];
  let quota = 100, failure = false, afterSend = false, useTestGuard = false;
  const baseContext = h.context;
  function context() {
    const c = baseContext();
    c.MailApp.getRemainingDailyQuota = () => quota;
    c.MailApp.sendEmail = message => {
      if (failure && !afterSend) throw new Error('Synthetic send failure must not leak challenge=' + message.body);
      mailbox.push(message);
      if (failure) throw new Error('Synthetic send result lost');
    };
    if (!useTestGuard) c.familyTestAccount_ = () => false;
    return c;
  }
  function request(req) {
    return JSON.parse(context().doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  }
  function latestChallenge(query = 'verify') {
    const mail = mailbox.filter(m => m.body.includes('?' + query + '=')).at(-1);
    if (!mail) throw new Error('No synthetic ' + query + ' mail');
    return decodeURIComponent(mail.body.match(new RegExp('\\?' + query + '=([^\\s]+)'))[1]);
  }
  return Object.assign(h, {
    context, request, mailbox, latestChallenge,
    admin: (op, args = {}) => request({ action: 'admin', token: TEACHER_TOKEN, op, ...args }),
    family: (action, args = {}) => request({ action, ...args }),
    setQuota: n => { quota = n; },
    setMailFailure: (enabled, resultLost = false) => { failure = enabled; afterSend = resultLost; },
    enableTestGuard: () => { useTestGuard = true; }
  });
}

module.exports = { createFamilyHarness };
