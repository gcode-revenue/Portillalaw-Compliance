'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit } = require('../db');
const { requireLogin } = require('../auth');
const { verifyToken } = require('../util/tokens');
const compliance = require('../services/compliance');
const providers = require('../services/providers');
const crypto = require('node:crypto');

const router = express.Router();

// --- Inicio de sesión ---
const attempts = new Map();
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Iniciar sesión', error: null, email: '', next: req.query.next || '/' });
});
router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const rawNext = String(req.body.next || '/');
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\') ? rawNext : '/';
  const key = `${req.ip}:${email}`;
  const tries = attempts.get(key) || { n: 0, until: 0 };
  if (tries.until > Date.now()) return res.status(429).render('login', { title: 'Iniciar sesión', error: 'Demasiados intentos. Espere 15 minutos.', email, next });
  const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    tries.n++; if (tries.n >= 5) { tries.until = Date.now() + 15 * 60000; tries.n = 0; }
    attempts.set(key, tries);
    return res.status(401).render('login', { title: 'Iniciar sesión', error: 'Correo o contraseña incorrectos.', email, next });
  }
  attempts.delete(key);
  req.session.regenerate(() => {
    req.session.userId = u.id;
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), u.id);
    audit(u.id, 'login', 'user', u.id);
    res.redirect(next);
  });
});
router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// --- Mi cuenta ---
router.get('/account', requireLogin, (req, res) => res.render('account', { title: 'Mi cuenta' }));
router.post('/account', requireLogin, (req, res) => {
  const b = req.body;
  db.prepare('UPDATE users SET phone = ?, notify_email = ?, notify_sms = ?, notify_whatsapp = ? WHERE id = ?')
    .run(b.phone || null, b.notify_email ? 1 : 0, b.notify_sms ? 1 : 0, b.notify_whatsapp ? 1 : 0, req.user.id);
  if (b.new_password) {
    if (!bcrypt.compareSync(String(b.current_password || ''), req.user.password_hash)) { req.flash('error', 'La contraseña actual no es correcta.'); return res.redirect('/account'); }
    if (String(b.new_password).length < 8) { req.flash('error', 'La nueva contraseña debe tener al menos 8 caracteres.'); return res.redirect('/account'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.new_password, 10), req.user.id);
  }
  req.flash('ok', 'Cuenta actualizada.');
  res.redirect('/account');
});

// --- Enlaces de un clic desde email / SMS (sin iniciar sesión) ---
router.get('/t/:token', (req, res) => {
  const t = verifyToken(req.params.token);
  if (!t) return res.status(400).render('error', { title: 'Enlace inválido', message: 'El enlace expiró o no es válido. Inicie sesión en la plataforma.' });
  const a = db.prepare(`SELECT a.*, t.title, t.starts_at, t.duration_min, t.modality, t.meeting_url, t.location, u.name emp_name
    FROM assignments a JOIN trainings t ON t.id = a.training_id JOIN users u ON u.id = a.employee_id WHERE a.id = ?`).get(t.assignmentId);
  if (!a) return res.status(404).render('error', { title: 'No encontrado', message: 'Asignación no encontrada.' });
  res.render('token_action', { title: a.title, a, action: t.action, token: req.params.token, result: null, error: null });
});
router.post('/t/:token', (req, res) => {
  const t = verifyToken(req.params.token);
  if (!t) return res.status(400).render('error', { title: 'Enlace inválido', message: 'El enlace expiró o no es válido.' });
  const a = db.prepare(`SELECT a.*, t.title, t.starts_at, t.duration_min, t.modality, t.meeting_url, t.location, u.name emp_name
    FROM assignments a JOIN trainings t ON t.id = a.training_id JOIN users u ON u.id = a.employee_id WHERE a.id = ?`).get(t.assignmentId);
  if (!a) return res.status(404).render('error', { title: 'No encontrado', message: 'Asignación no encontrada.' });
  let result = null, error = null;
  if (t.action === 'confirm') {
    compliance.confirmAssignment(a.id, 'enlace email/SMS');
    result = '¡Asistencia confirmada! Recibirás recordatorios antes del entrenamiento.';
  } else if (t.action === 'checkin') {
    const r = compliance.checkIn(a.id);
    if (r.ok) result = 'Check-in registrado. ¡Buen entrenamiento! Al terminar recibirás el enlace para tu progress report.'; else error = r.error;
  } else if (t.action === 'report') {
    const r = compliance.submitReport(a.id, a.employee_id, req.body);
    if (r.ok) result = '¡Gracias! Tu progress report fue sometido y el entrenamiento cuenta para tu progreso.'; else error = r.error;
  }
  if (result) audit(a.employee_id, `token_${t.action}`, 'assignment', a.id);
  res.render('token_action', { title: a.title, a, action: t.action, token: req.params.token, result, error });
});

// --- Respuestas por SMS (Twilio): "SI" confirma el próximo entrenamiento ---
// --- Respuestas de los empleados por SMS / WhatsApp ---
// "SI" confirma el próximo entrenamiento; "STOP"/"PARAR" detiene ese canal; cualquier otro
// texto llega como mensaje a Portilla Law dentro del portal.
const CONFIRM_WORDS = ['SI', 'SÍ', 'S', 'YES', '1', 'CONFIRMO', 'CONFIRMAR', 'OK'];
const STOP_WORDS = ['STOP', 'PARAR', 'BAJA', 'CANCELAR', 'UNSUBSCRIBE', 'ALTO'];
function handleInbound(fromPhone, rawText, channel) {
  const from = String(fromPhone || '').replace(/\D/g, '').slice(-10);
  const text = String(rawText || '').trim();
  const word = text.toUpperCase().replace(/[.!¡]/g, '').trim();
  const label = channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
  const u = from && db.prepare("SELECT * FROM users WHERE active = 1 AND substr(replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'+',''), -10) = ?").get(from);
  if (!u) return 'Portilla Law: no pudimos identificar tu número. Comunícate con nosotros.';
  if (STOP_WORDS.includes(word)) {
    db.prepare(`UPDATE users SET ${channel === 'whatsapp' ? 'notify_whatsapp' : 'notify_sms'} = 0 WHERE id = ?`).run(u.id);
    db.prepare("INSERT INTO messages (sender_id, recipient_id, subject, body) SELECT ?, id, ?, ? FROM users WHERE role IN ('admin','staff') AND active = 1")
      .run(u.id, `${u.name} detuvo los mensajes por ${label}`, `${u.name} respondió "${text}" y no recibirá más mensajes por ${label}. Seguirá recibiendo email. Si fue un error, puede reactivarlo en su ficha de usuario.`);
    audit(u.id, `baja_${channel}`, 'user', u.id);
    return `Portilla Law: no recibirás más mensajes por ${label}. Seguirás recibiendo tus avisos por email.`;
  }
  if (CONFIRM_WORDS.includes(word)) {
    const next = db.prepare(`SELECT a.id, t.title FROM assignments a JOIN trainings t ON t.id = a.training_id
      WHERE a.employee_id = ? AND a.status = 'asignado' AND t.cancelled = 0 AND t.modality <> 'video' AND t.starts_at > ? ORDER BY t.starts_at LIMIT 1`).get(u.id, new Date().toISOString());
    if (!next) return 'Portilla Law: no tienes entrenamientos pendientes de confirmar.';
    compliance.confirmAssignment(next.id, `respuesta ${label}`);
    audit(u.id, `confirmar_${channel}`, 'assignment', next.id);
    return `Portilla Law: confirmada tu asistencia a "${next.title}". ¡Gracias!`;
  }
  db.prepare("INSERT INTO messages (sender_id, recipient_id, subject, body) SELECT ?, id, ?, ? FROM users WHERE role IN ('admin','staff') AND active = 1")
    .run(u.id, `Respuesta por ${label}`, text.slice(0, 1000));
  return 'Portilla Law: recibimos tu mensaje. Te contactaremos pronto.';
}

function validTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true;
  const url = `${(process.env.APP_URL || '').replace(/\/$/, '')}${req.originalUrl}`;
  const data = url + Object.keys(req.body).sort().map((k) => k + req.body[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const got = String(req.get('x-twilio-signature') || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
router.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
  if (!validTwilioSignature(req)) return res.status(403).send('Firma inválida');
  const reply = handleInbound(req.body.From, req.body.Body, 'sms');
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/[<&>]/g, '')}</Message></Response>`);
});

// Heymarket: configure el webhook de mensajes entrantes a /webhooks/heymarket?token=HEYMARKET_WEBHOOK_TOKEN
router.post('/webhooks/heymarket', async (req, res) => {
  const expected = process.env.HEYMARKET_WEBHOOK_TOKEN || '';
  const got = String(req.query.token || '');
  if (!expected || got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return res.status(403).json({ ok: false });
  const b = req.body || {};
  const msg = b.message || b.data || b;
  const direction = String(msg.direction || b.direction || b.type || '').toLowerCase();
  if (direction.includes('out') || msg.is_outbound || msg.outbound) return res.json({ ok: true, ignored: 'outbound' });
  const phone = msg.phone_number || msg.target || msg.from || msg.contact?.phone_number || b.phone_number || b.contact?.phone_number;
  const text = msg.text ?? msg.body ?? msg.message ?? b.text;
  if (!phone || typeof text !== 'string') return res.json({ ok: true, ignored: 'sin teléfono o texto' });
  const reply = handleInbound(phone, text, 'sms');
  try { if (providers.heymarket.configured()) await providers.heymarket.send(phone, reply); } catch (e) { console.error('[heymarket respuesta]', e.message); }
  res.json({ ok: true });
});

// WhatsApp Cloud API (Meta): verificación del webhook y mensajes entrantes
router.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});
router.post('/webhooks/whatsapp', async (req, res) => {
  if (!providers.whatsapp.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(403);
  res.sendStatus(200); // Meta exige respuesta rápida
  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const m of change.value?.messages || []) {
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        if (!text) continue;
        const reply = handleInbound(m.from, text, 'whatsapp');
        try { await providers.whatsapp.sendText(m.from, reply); } catch (e) { console.error('[whatsapp respuesta]', e.message); }
      }
    }
  }
});

module.exports = router;
module.exports.handleInbound = handleInbound;
