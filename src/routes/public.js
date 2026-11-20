'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, audit } = require('../db');
const { requireLogin } = require('../auth');
const { verifyToken } = require('../util/tokens');
const compliance = require('../services/compliance');

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
  db.prepare('UPDATE users SET phone = ?, notify_email = ?, notify_sms = ? WHERE id = ?')
    .run(b.phone || null, b.notify_email ? 1 : 0, b.notify_sms ? 1 : 0, req.user.id);
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
function validTwilioSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // modo desarrollo
  const url = `${(process.env.APP_URL || '').replace(/\/$/, '')}${req.originalUrl}`;
  const data = url + Object.keys(req.body).sort().map((k) => k + req.body[k]).join('');
  const expected = require('node:crypto').createHmac('sha1', token).update(data).digest('base64');
  const got = String(req.get('x-twilio-signature') || '');
  return got.length === expected.length && require('node:crypto').timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
router.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
  if (!validTwilioSignature(req)) return res.status(403).send('Firma inválida');
  const from = String(req.body.From || '').replace(/\D/g, '').slice(-10);
  const body = String(req.body.Body || '').trim().toUpperCase();
  let reply = 'Portilla Law: no pudimos identificar tu número. Comunícate con nosotros.';
  const u = from && db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 1 AND substr(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''), -10) = ?").get(from);
  if (u) {
    const next = db.prepare(`SELECT a.id, t.title FROM assignments a JOIN trainings t ON t.id = a.training_id
      WHERE a.employee_id = ? AND a.status = 'asignado' AND t.cancelled = 0 AND t.starts_at > ? ORDER BY t.starts_at LIMIT 1`).get(u.id, new Date().toISOString());
    if (['SI', 'SÍ', 'S', 'YES', '1', 'CONFIRMO'].includes(body)) {
      if (next) { compliance.confirmAssignment(next.id, 'respuesta SMS'); reply = `Portilla Law: confirmada tu asistencia a "${next.title}". ¡Gracias!`; }
      else reply = 'Portilla Law: no tienes entrenamientos pendientes de confirmar.';
    } else {
      db.prepare("INSERT INTO messages (sender_id, recipient_id, subject, body) SELECT ?, id, 'Respuesta por SMS', ? FROM users WHERE role IN ('admin','staff') AND active = 1")
        .run(u.id, String(req.body.Body || '').slice(0, 1000));
      reply = 'Portilla Law: recibimos tu mensaje. Te contactaremos pronto.';
    }
  }
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply.replace(/[<&>]/g, '')}</Message></Response>`);
});

module.exports = router;
