'use strict';
// Proveedores de envío:
//  - Email: Microsoft 365 vía Microsoft Graph (recomendado) o SMTP genérico
//  - SMS:   Heymarket (recomendado) o Twilio
//  - WhatsApp: API oficial de WhatsApp Cloud (Meta)
const crypto = require('node:crypto');

let fetchImpl = (...a) => fetch(...a);
const env = (k) => (process.env[k] || '').trim();

/** "787-555-1234" -> "17875551234" (dígitos con código de país; PR/EE.UU. = 1) */
function phoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '1' + d;
  if (d.length === 11 && d.startsWith('1')) return d;
  return d.length >= 11 ? d : '';
}

// ---------------- Microsoft 365 (Graph) ----------------
const graph = {
  configured: () => !!(env('MS_TENANT_ID') && env('MS_CLIENT_ID') && env('MS_CLIENT_SECRET') && env('MS_SENDER')),
  token: null,
  async getToken() {
    if (this.token && this.token.exp > Date.now() + 60000) return this.token.value;
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(env('MS_TENANT_ID'))}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env('MS_CLIENT_ID'), client_secret: env('MS_CLIENT_SECRET'), scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Microsoft login ${res.status}: ${j.error_description || j.error || ''}`.slice(0, 220));
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return this.token.value;
  },
  async send(to, subject, html) {
    const tk = await this.getToken();
    const res = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env('MS_SENDER'))}/sendMail`, {
      method: 'POST', headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`Microsoft Graph ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

// ---------------- Heymarket (SMS) ----------------
// Autenticación: JWT HS256 con iss = Secret ID, iat = ahora, firmado con "SecretID||SecretKey"
// (vence a los 5 minutos). También acepta la API key estática anterior (HEYMARKET_API_KEY).
const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const heymarket = {
  base: () => env('HEYMARKET_API_URL') || 'https://api.heymarket.com',
  configured: () => !!((env('HEYMARKET_SECRET_ID') && env('HEYMARKET_SECRET_KEY')) || env('HEYMARKET_API_KEY')) && !!env('HEYMARKET_INBOX_ID') && !!env('HEYMARKET_CREATOR_ID'),
  authHeader(now = Date.now()) {
    if (env('HEYMARKET_SECRET_ID') && env('HEYMARKET_SECRET_KEY')) {
      const unsigned = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: env('HEYMARKET_SECRET_ID'), iat: Math.floor(now / 1000) })}`;
      const sig = crypto.createHmac('sha256', `${env('HEYMARKET_SECRET_ID')}||${env('HEYMARKET_SECRET_KEY')}`).update(unsigned).digest('base64url');
      return `Bearer ${unsigned}.${sig}`;
    }
    return `Bearer ${env('HEYMARKET_API_KEY')}`;
  },
  async request(method, path, body) {
    const res = await fetchImpl(`${this.base()}${path}`, {
      method, headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Heymarket ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  },
  async send(phone, text) {
    const to = phoneDigits(phone);
    if (!to) throw new Error('Número de teléfono inválido');
    return this.request('POST', '/v1/message/send', {
      inbox_id: Number(env('HEYMARKET_INBOX_ID')) || env('HEYMARKET_INBOX_ID'),
      creator_id: Number(env('HEYMARKET_CREATOR_ID')) || env('HEYMARKET_CREATOR_ID'),
      phone_number: to, text,
    });
  },
  inboxes() { return this.request('GET', '/v1/inboxes'); },
};

// ---------------- Twilio (SMS, alternativo) ----------------
const twilio = {
  configured: () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM')),
  async send(phone, body) {
    const sid = env('TWILIO_ACCOUNT_SID');
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: '+' + phoneDigits(phone), From: env('TWILIO_FROM'), Body: body }),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
};

// ---------------- WhatsApp Cloud API (Meta) ----------------
// Los mensajes que inicia la empresa deben usar una PLANTILLA aprobada por Meta.
// Plantilla sugerida (categoría "Utilidad", idioma español):
//   "Hola {{1}}, Portilla Law le informa: {{2}} Detalles: {{3}}"
const clean = (s, max) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max) || '-';
const whatsapp = {
  configured: () => !!(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID') && env('WHATSAPP_TEMPLATE')),
  url: () => `https://graph.facebook.com/${env('WHATSAPP_API_VERSION') || 'v21.0'}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`,
  async post(body) {
    const res = await fetchImpl(this.url(), {
      method: 'POST', headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${j.error?.message || ''}`.slice(0, 220));
    return j;
  },
  /** Mensaje con plantilla: nombre, mensaje y enlace */
  sendTemplate(phone, name, message, link) {
    const to = phoneDigits(phone);
    if (!to) throw new Error('Número de teléfono inválido');
    return this.post({
      to, type: 'template',
      template: { name: env('WHATSAPP_TEMPLATE'), language: { code: env('WHATSAPP_TEMPLATE_LANG') || 'es' },
        components: [{ type: 'body', parameters: [clean(name, 60), clean(message, 700), clean(link || process.env.APP_URL || 'portal', 300)].map((text) => ({ type: 'text', text })) }] },
    });
  },
  /** Texto libre: sólo permitido dentro de las 24 h después de que el empleado escribió */
  sendText(phone, text) { return this.post({ to: phoneDigits(phone), type: 'text', text: { body: String(text).slice(0, 4000) } }); },
  verifySignature(rawBody, header) {
    const secret = env('WHATSAPP_APP_SECRET');
    if (!secret) return true;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
    const got = String(header || '');
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  },
};

module.exports = { graph, heymarket, twilio, whatsapp, phoneDigits, _setFetch: (f) => { fetchImpl = f; graph.token = null; } };
