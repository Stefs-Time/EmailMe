'use strict';

/**
 * Local SMTP server for development and tests (never for production).
 * Accepts mail and keeps it in memory; special recipient prefixes simulate
 * receiving-server answers:
 *   hard-...@  -> 550 5.1.1 user unknown           (permanent)
 *   soft-...@  -> 452 4.2.2 mailbox full            (temporary)
 *   policy-...@ -> 550 5.7.1 rejected by policy     (needs review)
 *
 * Run standalone: node test/helpers/smtpSink.js [port]
 */
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

function startSink({ port = 0, user = 'sink', pass = 'sink-pass' } = {}) {
  const messages = [];
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === user && auth.password === pass) return cb(null, { user });
      return cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onRcptTo(addr, _session, cb) {
      const a = addr.address.toLowerCase();
      if (a.startsWith('hard-')) return cb(Object.assign(new Error('5.1.1 <' + a + '>: Recipient address rejected: User unknown'), { responseCode: 550 }));
      if (a.startsWith('soft-')) return cb(Object.assign(new Error('4.2.2 Mailbox full, try again later'), { responseCode: 452 }));
      if (a.startsWith('policy-')) return cb(Object.assign(new Error('5.7.1 Message rejected due to local policy'), { responseCode: 550 }));
      return cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        const parsed = await simpleParser(raw);
        messages.push({ envelope: session.envelope, raw: raw.toString('utf8'), parsed });
        cb();
      });
    },
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.server.address().port, user, pass, messages, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startSink };

if (require.main === module) {
  startSink({ port: Number(process.argv[2] || 2525) }).then((s) => {
    console.log(`SMTP sink on 127.0.0.1:${s.port} (user "${s.user}", password "${s.pass}")`);
    setInterval(() => {
      while (s.messages.length) {
        const m = s.messages.shift();
        console.log(`→ ${m.envelope.rcptTo.map((r) => r.address).join(', ')} | ${m.parsed.subject}`);
      }
    }, 1000);
  });
}
