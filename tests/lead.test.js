const { handler } = require('../netlify/functions/lead.js');

// Stand in for n8n so nothing leaves the machine.
let received = null;
global.fetch = async (url, opts) => {
  received = { url, headers: opts.headers, body: JSON.parse(opts.body) };
  return { ok: true, status: 200, text: async () => '' };
};

const post = (body) => handler({ httpMethod: 'POST', body: JSON.stringify(body) });

(async () => {
  const t = async (name, fn) => {
    received = null;
    try { await fn(); console.log('PASS ', name); }
    catch (e) { console.log('FAIL ', name, '->', e.message); process.exitCode = 1; }
  };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

  process.env.N8N_WEBHOOK_URL = 'https://n8n.example.test/webhook/raf-lead';
  process.env.N8N_WEBHOOK_SECRET = 'shhh';

  await t('valid submission forwards and returns ok', async () => {
    const r = await post({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', message: 'hello' });
    eq(r.statusCode, 200, 'status');
    eq(JSON.parse(r.body), { ok: true }, 'body');
    if (!received) throw new Error('never forwarded');
    eq(received.headers['x-webhook-token'], 'shhh', 'secret header');
    eq(received.body.marketing_consent, false, 'consent defaults false');
  });

  await t('honeypot is silently accepted and NOT forwarded', async () => {
    const r = await post({ first_name: 'B', last_name: 'O', email: 'b@o.com', honeypot: 'gotcha' });
    eq(r.statusCode, 200, 'status');
    eq(JSON.parse(r.body), { ok: true }, 'body');
    if (received) throw new Error('forwarded a bot submission');
  });

  await t('missing required fields rejected', async () => {
    const r = await post({ first_name: 'Ada' });
    eq(r.statusCode, 400, 'status');
    eq(JSON.parse(r.body).fields, ['last_name', 'email'], 'fields');
    if (received) throw new Error('forwarded an invalid submission');
  });

  await t('bad email rejected', async () => {
    const r = await post({ first_name: 'A', last_name: 'B', email: 'not-an-email' });
    eq(r.statusCode, 400, 'status');
    eq(JSON.parse(r.body).fields, ['email'], 'fields');
  });

  await t('overlong field rejected', async () => {
    const r = await post({ first_name: 'x'.repeat(101), last_name: 'B', email: 'a@b.com' });
    eq(r.statusCode, 400, 'status');
  });

  await t('explicit opt-in is carried through', async () => {
    await post({ first_name: 'A', last_name: 'B', email: 'a@b.com', marketing_consent: true });
    eq(received.body.marketing_consent, true, 'consent');
  });

  await t('unknown fields are stripped', async () => {
    await post({ first_name: 'A', last_name: 'B', email: 'a@b.com', role: 'admin', id: '1' });
    eq(Object.keys(received.body).sort(), ['email','first_name','last_name','marketing_consent'], 'keys');
  });

  await t('GET rejected', async () => {
    const r = await handler({ httpMethod: 'GET' });
    eq(r.statusCode, 405, 'status');
  });

  await t('malformed JSON rejected', async () => {
    const r = await handler({ httpMethod: 'POST', body: '{oops' });
    eq(r.statusCode, 400, 'status');
  });

  await t('missing env var fails closed without leaking cause', async () => {
    delete process.env.N8N_WEBHOOK_URL;
    const r = await post({ first_name: 'A', last_name: 'B', email: 'a@b.com' });
    eq(r.statusCode, 503, 'status');
    if (/N8N|webhook|env/i.test(JSON.parse(r.body).error)) throw new Error('leaked config detail to client');
  });
})();
