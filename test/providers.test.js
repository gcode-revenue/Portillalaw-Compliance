'use strict';
process.env.DB_PATH = ':memory:';
Object.assign(process.env, {
  HEYMARKET_SECRET_ID: 'sid123', HEYMARKET_SECRET_KEY: 'skey456', HEYMARKET_INBOX_ID: '42', HEYMARKET_CREATOR_ID: '7', HEYMARKET_WEBHOOK_TOKEN: 'hooktoken',
  MS_TENANT_ID: 'tenant', MS_CLIENT_ID: 'client', MS_CLIENT_SECRET: 'secret', MS_SENDER: 'cumplimiento@portillalaw.com',
  WHATSAPP_TOKEN: 'watoken', WHATSAPP_PHONE_NUMBER_ID: '999', WHATSAPP_TEMPLATE: 'aviso_portilla', WHATSAPP_VERIFY_TOKEN: 'verifyme', WHATSAPP_APP_SECRET: 'appsecret',
});
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { db } = require('../src/db');
const providers = require('../src/services/providers');
const { notifyUser } = require('../src/services/notify');

const calls = [];
providers._setFetch(async (url, opts = {}) => {
  calls.push({ url, opts });
  if (url.includes('login.microsoftonline.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'mstoken', expires_in: 3600 }) };
  if (url.includes('graph.microsoft.com')) return { ok: true, status: 202, text: async () => '' };
  if (url.includes('graph.facebook.com')) return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid' }] }) };
  if (url.includes('heymarket')) return { ok: true, status: 200, text: async () => '{"id":1}' };
  throw new Error('URL inesperada ' + url);
});

test('teléfonos de PR a formato internacional', () => {
  assert.strictEqual(providers.phoneDigits('787-555-1234'), '17875551234');
  assert.strictEqual(providers.phoneDigits('+1 (939) 555-1234'), '19395551234');
  assert.strictEqual(providers.phoneDigits('555'), '');
});

test('Heymarket: JWT HS256 con iss=SecretID firmado con "ID||KEY"', () => {
  const h = providers.heymarket.authHeader(1_700_000_000_000).replace('Bearer ', '');
  const [head, payload, sig] = h.split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.deepStrictEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'sid123', iat: 1_700_000_000 });
  assert.strictEqual(sig, crypto.createHmac('sha256', 'sid123||skey456').update(`${head}.${payload}`).digest('base64url'));
});

test('un recordatorio sale por Microsoft 365, Heymarket y WhatsApp', async () => {
  calls.length = 0;
  const u = { id: 1, name: 'Ana López', email: 'ana@t.com', phone: '787-555-1002', notify_email: 1, notify_sms: 1, notify_whatsapp: 1, active: 1 };
  db.prepare("INSERT INTO users (id, name, email, phone, password_hash, role) VALUES (1, 'Ana López', 'ana@t.com', '787-555-1002', 'x', 'employee')").run();
  const r = await notifyUser(u, { kind: 'recordatorio', subject: 'Recordatorio', text: 'Tu entrenamiento comienza en 1 hora.',
    sms: 'Portilla Law: "OSHA" comienza en 1 hora. Haz check-in aqui:', actions: [{ label: 'Check-in', url: 'https://portal.portillalaw.com/t/abc' }] });
  assert.deepStrictEqual(r.map((x) => `${x.channel}:${x.status}`), ['email:enviado', 'sms:enviado', 'whatsapp:enviado']);
  const mail = calls.find((c) => c.url.includes('/sendMail'));
  assert.match(mail.url, /users\/cumplimiento%40portillalaw\.com\/sendMail/);
  assert.strictEqual(JSON.parse(mail.opts.body).message.toRecipients[0].emailAddress.address, 'ana@t.com');
  const hm = calls.find((c) => c.url.includes('heymarket'));
  assert.strictEqual(hm.url, 'https://api.heymarket.com/v1/message/send');
  const hb = JSON.parse(hm.opts.body);
  assert.deepStrictEqual({ inbox_id: hb.inbox_id, creator_id: hb.creator_id, phone_number: hb.phone_number }, { inbox_id: 42, creator_id: 7, phone_number: '17875551002' });
  assert.match(hb.text, /check-in aqui: https:\/\/portal\.portillalaw\.com\/t\/abc/);
  const wa = JSON.parse(calls.find((c) => c.url.includes('graph.facebook.com')).opts.body);
  assert.strictEqual(wa.to, '17875551002');
  assert.strictEqual(wa.template.name, 'aviso_portilla');
  assert.deepStrictEqual(wa.template.components[0].parameters.map((p) => p.text), ['Ana', '"OSHA" comienza en 1 hora. Haz check-in aqui.', 'https://portal.portillalaw.com/t/abc']);
});

test('respuestas: SI confirma, STOP detiene el canal, otro texto llega a Portilla Law', () => {
  const { handleInbound } = require('../src/routes/public');
  db.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (2, 'Admin', 'admin@t.com', 'x', 'admin')").run();
  const t = db.prepare("INSERT INTO trainings (title, modality, starts_at, duration_min) VALUES ('OSHA', 'presencial', ?, 60)").run(new Date(Date.now() + 86400000).toISOString()).lastInsertRowid;
  const a = db.prepare('INSERT INTO assignments (training_id, employee_id) VALUES (?, 1)').run(t).lastInsertRowid;
  assert.match(handleInbound('+17875551002', 'Sí', 'whatsapp'), /confirmada/);
  assert.strictEqual(db.prepare('SELECT status, confirmed_via FROM assignments WHERE id = ?').get(a).confirmed_via, 'respuesta WhatsApp');
  assert.match(handleInbound('17875551002', '¿A qué hora es?', 'sms'), /recibimos/);
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE recipient_id = 2 AND body = '¿A qué hora es?'").get());
  assert.match(handleInbound('7875551002', 'STOP', 'sms'), /no recibirás más mensajes por SMS/);
  assert.strictEqual(db.prepare('SELECT notify_sms FROM users WHERE id = 1').get().notify_sms, 0);
  assert.match(handleInbound('7870000000', 'SI', 'sms'), /no pudimos identificar/);
  assert.match(handleInbound('7870000000', 'AYUDA', 'sms'), /STOP para cancelar/);
});

test('webhooks: token de Heymarket y firma/verificación de WhatsApp', async () => {
  const app = require('../src/server');
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await fetch(`${base}/webhooks/heymarket?token=malo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403);
    r = await fetch(`${base}/webhooks/heymarket?token=hooktoken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number: '17875551002', text: 'hola' }) });
    assert.strictEqual(r.status, 200);
    r = await fetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verifyme&hub.challenge=12345`);
    assert.strictEqual(await r.text(), '12345');
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '17875551002', text: { body: 'hola' } }] } }] }] });
    r = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=mal' }, body });
    assert.strictEqual(r.status, 403);
    const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(body).digest('hex');
    r = await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
    assert.strictEqual(r.status, 200);
  } finally { srv.close(); }
});
