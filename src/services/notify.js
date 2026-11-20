'use strict';
// Capa de envío: Email (Microsoft 365/Graph o SMTP), SMS (Heymarket o Twilio) y WhatsApp (Meta).
// Si no hay credenciales configuradas, el mensaje se registra como "simulado" en la
// bitácora de comunicaciones para que el sistema sea 100% funcional en desarrollo.
const nodemailer = require('nodemailer');
const { db, getSetting } = require('../db');
const providers = require('./providers');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const FROM = process.env.MAIL_FROM || 'Portilla Law Cumplimiento <cumplimiento@portillalaw.com>';
function channelsStatus() {
  return {
    email: providers.graph.configured() ? 'Microsoft 365 conectado' : transporter ? 'SMTP configurado' : 'Simulado (sin conectar)',
    sms: providers.heymarket.configured() ? 'Heymarket conectado' : providers.twilio.configured() ? 'Twilio conectado' : 'Simulado (sin conectar)',
    whatsapp: providers.whatsapp.configured() ? 'WhatsApp conectado' : 'No conectado',
  };
}
/** Canales al celular activos para la organización (Configuración → mobile_channels). */
function mobileChannels() {
  return String(getSetting('mobile_channels') || 'sms,whatsapp').split(',').map((x) => x.trim()).filter(Boolean);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function emailHtml(subject, text, actions = []) {
  const btns = actions.map((a) =>
    `<a href="${escapeHtml(a.url)}" style="display:inline-block;margin:4px 6px 4px 0;padding:10px 16px;background:${a.color || '#0b3d63'};color:#fff;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(a.label)}</a>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #e3e7ee;border-radius:8px;overflow:hidden">
  <div style="background:#0b3d63;color:#fff;padding:16px 20px;font-size:18px;font-weight:700">Portilla Law · Cumplimiento</div>
  <div style="padding:20px;color:#1d2733;line-height:1.5">
    <h2 style="margin-top:0;font-size:18px">${escapeHtml(subject)}</h2>
    <p style="white-space:pre-line">${escapeHtml(text)}</p>
    ${btns ? `<div style="margin-top:16px">${btns}</div>` : ''}
  </div>
  <div style="background:#f4f6f9;color:#6b7785;padding:12px 20px;font-size:12px">Programa de Aprendizaje Registrado · Este es un mensaje automatizado de cumplimiento.</div></div>`;
}

function alreadySent(dedupeKey) {
  return dedupeKey ? !!db.prepare('SELECT 1 FROM notifications WHERE dedupe_key = ?').get(dedupeKey) : false;
}

function log(row) {
  try {
    return db.prepare(`INSERT INTO notifications (user_id, assignment_id, company_id, kind, dedupe_key, channel, destination, subject, body, status, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(row.user_id ?? null, row.assignment_id ?? null, row.company_id ?? null, row.kind,
      row.dedupe_key ?? null, row.channel, row.destination ?? null, row.subject ?? null, row.body ?? null, row.status, row.error ?? null).lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null; // otro proceso ya lo envió
    throw e;
  }
}

async function sendEmail(to, subject, text, actions, html) {
  if (providers.graph.configured()) {
    const withLinks = html || emailHtml(subject, text, actions);
    await providers.graph.send(to, subject, withLinks);
    return { status: 'enviado' };
  }
  if (!transporter) return { status: 'simulado' };
  await transporter.sendMail({ from: FROM, to, subject, text: text + (actions?.length ? '\n\n' + actions.map((a) => `${a.label}: ${a.url}`).join('\n') : ''), html: html || emailHtml(subject, text, actions) });
  return { status: 'enviado' };
}

async function sendSms(to, body) {
  if (providers.heymarket.configured()) { await providers.heymarket.send(to, body); return { status: 'enviado' }; }
  if (providers.twilio.configured()) { await providers.twilio.send(to, body); return { status: 'enviado' }; }
  return { status: 'simulado' };
}

async function sendWhatsApp(to, name, message, link) {
  await providers.whatsapp.sendTemplate(to, name, message, link);
  return { status: 'enviado' };
}

/**
 * Notifica a un usuario por sus canales preferidos (email y/o SMS) y deja constancia.
 * opts: { kind, subject, text, sms, actions:[{label,url}], assignmentId, companyId, dedupeKey, channels }
 */
async function notifyUser(user, opts) {
  if (!user || !user.active) return [];
  const mobile = mobileChannels();
  const channels = (opts.channels || ['email', 'sms', 'whatsapp'])
    .filter((c) => c === 'email' || mobile.includes(c))
    .filter((c) => c !== 'whatsapp' || providers.whatsapp.configured()); // WhatsApp sólo si está conectado
  const results = [];
  for (const channel of channels) {
    const wants = channel === 'email' ? user.notify_email && user.email
      : channel === 'sms' ? user.notify_sms && user.phone
      : (user.notify_whatsapp ?? 1) && user.phone;
    const key = opts.dedupeKey ? `${opts.dedupeKey}:${channel}:${user.id}` : null;
    if (key && alreadySent(key)) continue;
    const destination = channel === 'email' ? user.email : user.phone;
    const body = channel === 'sms'
      ? (opts.sms || opts.text) + (opts.actions?.[0] ? ` ${opts.actions[0].url}` : '')
      : opts.text;
    const base = { user_id: user.id, assignment_id: opts.assignmentId, company_id: opts.companyId ?? user.company_id,
      kind: opts.kind, dedupe_key: key, channel, destination, subject: opts.subject, body };
    if (!wants) { log({ ...base, status: 'omitido', error: 'Canal desactivado o sin dato de contacto' }); continue; }
    // Reservar la clave antes de enviar para evitar envíos dobles
    const logId = log({ ...base, status: 'pendiente' });
    if (!logId) continue;
    let status, error = null;
    try {
      ({ status } = channel === 'email' ? await sendEmail(destination, opts.subject, opts.text, opts.actions, opts.html)
        : channel === 'sms' ? await sendSms(destination, body)
        : await sendWhatsApp(destination, String(user.name || '').split(' ')[0], (opts.sms || opts.subject || '').replace(/^Portilla Law:\s*/, '').replace(/[:\s]+$/, '.'), opts.actions?.[0]?.url));
    } catch (e) { status = 'fallido'; error = e.message; }
    db.prepare('UPDATE notifications SET status = ?, error = ? WHERE id = ?').run(status, error, logId);
    results.push({ channel, status, error });
  }
  return results;
}

// Mensaje interno en la plataforma (bandeja de mensajes) + opcionalmente email/SMS
async function internalMessage({ senderId = null, recipient, subject, body, alsoEmail = false, alsoSms = false, kind = 'mensaje', assignmentId, dedupeKey }) {
  if (dedupeKey && alreadySent(`${dedupeKey}:interna:${recipient.id}`)) return;
  db.prepare('INSERT INTO messages (sender_id, recipient_id, subject, body, also_email, also_sms) VALUES (?,?,?,?,?,?)')
    .run(senderId, recipient.id, subject, body, alsoEmail ? 1 : 0, alsoSms ? 1 : 0);
  log({ user_id: recipient.id, assignment_id: assignmentId, company_id: recipient.company_id, kind, channel: 'interna',
    destination: recipient.name, subject, body, status: 'enviado', dedupe_key: dedupeKey ? `${dedupeKey}:interna:${recipient.id}` : null });
  const channels = [alsoEmail && 'email', alsoSms && 'sms', alsoSms && 'whatsapp'].filter(Boolean);
  if (channels.length) {
    await notifyUser(recipient, { kind, subject, text: body, sms: `${subject}: ${body}`.slice(0, 300), channels, assignmentId,
      dedupeKey, actions: [{ label: 'Abrir en la plataforma', url: `${APP_URL}/messages` }] });
  }
}

module.exports = { notifyUser, internalMessage, channelsStatus, mobileChannels, APP_URL, escapeHtml, emailHtml };
