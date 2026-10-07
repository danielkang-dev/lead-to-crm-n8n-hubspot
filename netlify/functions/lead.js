/*
  Lead form proxy: browser -> here -> n8n -> HubSpot CRM.

  Why this exists at all, given CLAUDE.md forbids "any dynamic backend
  beyond the existing n8n -> HubSpot webhook contract": this function
  stores nothing, has no database, and adds no new contract. It
  validates a submission and forwards it to the same n8n webhook the
  contract already names. It is transport, not a backend.

  What it buys over posting to n8n straight from the page:
   - the webhook URL stays in an env var instead of page source, where
     it would be an open, curl-able write endpoint into a CRM
   - validation happens somewhere the submitter cannot edit
   - the browser gets one stable JSON shape to render states from,
     instead of whatever n8n returns through CORS

  Field contract is locked (RAF-COPY-SOURCE-OF-TRUTH.md, Page 7):
    first_name (req) - last_name (req) - email (req) - phone -
    company - message - marketing_consent - honeypot
*/

const REQUIRED = ['first_name', 'last_name', 'email'];

const MAX_LENGTHS = {
  first_name: 100,
  last_name: 100,
  email: 254, // RFC 5321 maximum forward-path length
  phone: 40,
  company: 200,
  message: 5000,
};

const ALLOWED = Object.keys(MAX_LENGTHS);

/*
  Deliberately permissive. Server-side email validation exists to catch
  obvious garbage and cap length, not to adjudicate RFC 5322 — every
  strict regex on the internet rejects addresses that genuinely deliver.
  Whether the address is real is a question only a confirmation email
  can answer, and that is out of scope here.
*/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'Malformed request.' });
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json(400, { ok: false, error: 'Malformed request.' });
  }

  /*
    Honeypot: a field hidden from sighted users and skipped by keyboard
    focus, so anything that fills it is automating the form.

    Return a normal success. Telling a bot it was caught just tells it
    which field to leave alone next time — the submission is dropped
    silently instead.
  */
  if (typeof payload.honeypot === 'string' && payload.honeypot.trim() !== '') {
    return json(200, { ok: true });
  }

  const clean = {};
  for (const field of ALLOWED) {
    const raw = payload[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      return json(400, { ok: false, error: `Invalid value for ${field}.` });
    }
    const trimmed = raw.trim();
    if (trimmed.length > MAX_LENGTHS[field]) {
      return json(400, {
        ok: false,
        error: `${field} is too long (max ${MAX_LENGTHS[field]}).`,
      });
    }
    if (trimmed) clean[field] = trimmed;
  }

  const missing = REQUIRED.filter((field) => !clean[field]);
  if (missing.length) {
    return json(400, {
      ok: false,
      error: 'Please complete the required fields.',
      fields: missing,
    });
  }

  if (!EMAIL.test(clean.email)) {
    return json(400, {
      ok: false,
      error: 'Please enter a valid email address.',
      fields: ['email'],
    });
  }

  // Unticked is the default and the locked contract's stated state, so
  // consent is true only on an explicit opt-in.
  clean.marketing_consent = payload.marketing_consent === true;

  const endpoint = process.env.N8N_WEBHOOK_URL;
  if (!endpoint) {
    // Misconfiguration, not user error. Never surface the cause.
    console.error('N8N_WEBHOOK_URL is not set; dropping submission.');
    return json(503, {
      ok: false,
      error: 'The form is not available right now. Please email us instead.',
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.N8N_WEBHOOK_SECRET) {
    headers['x-webhook-token'] = process.env.N8N_WEBHOOK_SECRET;
  }

  // Never let a hung n8n hold the function open to its own timeout.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(clean),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Log the upstream detail; return a generic message. HubSpot and n8n
      // errors can name modules, fields and record ids.
      console.error('n8n rejected the lead:', response.status, detail.slice(0, 500));
      return json(502, {
        ok: false,
        error: 'We could not submit your message. Please try again shortly.',
      });
    }

    return json(200, { ok: true });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    console.error('Failed to reach n8n:', reason);
    return json(502, {
      ok: false,
      error: 'We could not submit your message. Please try again shortly.',
    });
  } finally {
    clearTimeout(timeout);
  }
};
