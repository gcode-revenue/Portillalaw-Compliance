'use strict';
const express = require('express');
const { db, audit } = require('../db');
const { requireLogin, isStaff } = require('../auth');
const { internalMessage } = require('../services/notify');

const router = express.Router();

/** Contactos permitidos según rol. */
function contacts(u) {
  if (isStaff(u)) return db.prepare(`SELECT u.id, u.name, u.role, c.name company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.active = 1 AND u.id <> ? ORDER BY u.role, c.name, u.name`).all(u.id);
  const roleOther = u.role === 'employer' ? 'employee' : 'employer';
  return db.prepare(`SELECT u.id, u.name, u.role, c.name company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id
    WHERE u.active = 1 AND u.id <> ? AND (u.role IN ('admin','staff') OR (u.role = ? AND u.company_id = ?)) ORDER BY u.role, u.name`).all(u.id, roleOther, u.company_id);
}

/** Grupos para envíos masivos. */
function groups(u) {
  if (isStaff(u)) {
    const list = [{ key: 'all_employers', label: 'Todos los patronos' }, { key: 'all_employees', label: 'Todos los empleados' }];
    for (const c of db.prepare('SELECT id, name FROM companies WHERE active = 1 ORDER BY name').all()) {
      list.push({ key: `company_employees:${c.id}`, label: `Empleados de ${c.name}` }, { key: `company_all:${c.id}`, label: `Todos en ${c.name} (patrono + empleados)` });
    }
    list.push({ key: 'noncompliant', label: 'Empleados con alertas abiertas (fuera de cumplimiento)' });
    return list;
  }
  if (u.role === 'employer') return [{ key: `company_employees:${u.company_id}`, label: 'Todos mis empleados' }];
  return [];
}

function resolveGroup(u, key) {
  if (!groups(u).some((g) => g.key === key)) return [];
  const [k, id] = key.split(':');
  const q = {
    all_employers: ["SELECT * FROM users WHERE role = 'employer' AND active = 1", []],
    all_employees: ["SELECT * FROM users WHERE role = 'employee' AND active = 1", []],
    company_employees: ["SELECT * FROM users WHERE role = 'employee' AND active = 1 AND company_id = ?", [id]],
    company_all: ["SELECT * FROM users WHERE role IN ('employee','employer') AND active = 1 AND company_id = ?", [id]],
    noncompliant: ["SELECT * FROM users WHERE active = 1 AND id IN (SELECT employee_id FROM compliance_alerts WHERE status = 'abierta')", []],
  }[k];
  return q ? db.prepare(q[0]).all(...q[1]) : [];
}

router.get('/messages', requireLogin, (req, res) => {
  const box = req.query.box === 'sent' ? 'sent' : 'inbox';
  const list = box === 'sent'
    ? db.prepare(`SELECT m.*, u.name other_name FROM messages m JOIN users u ON u.id = m.recipient_id WHERE m.sender_id = ? ORDER BY m.id DESC LIMIT 200`).all(req.user.id)
    : db.prepare(`SELECT m.*, COALESCE(u.name, 'Sistema de cumplimiento') other_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.recipient_id = ? ORDER BY m.id DESC LIMIT 200`).all(req.user.id);
  res.render('messages', { title: 'Mensajes', list, box });
});

router.get('/messages/new', requireLogin, (req, res) => {
  const to = Number(req.query.to) || null;
  let reply = null;
  if (req.query.reply) reply = db.prepare('SELECT * FROM messages WHERE id = ? AND recipient_id = ?').get(req.query.reply, req.user.id);
  res.render('message_form', { title: 'Nuevo mensaje', contacts: contacts(req.user), groups: groups(req.user), to: reply ? reply.sender_id : to, reply });
});

router.post('/messages', requireLogin, async (req, res) => {
  const b = req.body;
  if (!b.body) { req.flash('error', 'El mensaje no puede estar vacío.'); return res.redirect('/messages/new'); }
  let recipients = [];
  if (b.group) recipients = resolveGroup(req.user, b.group);
  else {
    const allowed = new Set(contacts(req.user).map((c) => c.id));
    const ids = [].concat(b.to || []).map(Number).filter((id) => allowed.has(id));
    recipients = ids.map((id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)).filter(Boolean);
  }
  if (!recipients.length) { req.flash('error', 'Selecciona al menos un destinatario válido.'); return res.redirect('/messages/new'); }
  for (const r of recipients) {
    await internalMessage({ senderId: req.user.id, recipient: r, subject: b.subject || '(sin asunto)', body: b.body,
      alsoEmail: !!b.also_email, alsoSms: !!b.also_sms });
  }
  audit(req.user.id, 'enviar_mensaje', 'message', null, { recipients: recipients.length, group: b.group || null });
  req.flash('ok', `Mensaje enviado a ${recipients.length} destinatario(s).`);
  res.redirect('/messages?box=sent');
});

router.get('/messages/:id', requireLogin, (req, res) => {
  const m = db.prepare(`SELECT m.*, COALESCE(s.name,'Sistema de cumplimiento') sender_name, r.name recipient_name FROM messages m
    LEFT JOIN users s ON s.id = m.sender_id JOIN users r ON r.id = m.recipient_id WHERE m.id = ? AND (m.recipient_id = ? OR m.sender_id = ?)`).get(req.params.id, req.user.id, req.user.id);
  if (!m) return res.status(404).render('error', { title: 'No encontrado', message: 'Mensaje no encontrado.' });
  if (m.recipient_id === req.user.id && !m.read_at) db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(new Date().toISOString(), m.id);
  res.render('message', { title: m.subject || 'Mensaje', m });
});

module.exports = router;
