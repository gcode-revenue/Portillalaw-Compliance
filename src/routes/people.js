'use strict';
const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('../db');
const { requireLogin, requireRole, isStaff, canViewEmployee, forbidden } = require('../auth');
const { employeeProgress, checklist } = require('../services/progress');
const { notifyUser, APP_URL } = require('../services/notify');

const router = express.Router();

function tempPassword() { return crypto.randomBytes(6).toString('base64url'); }

async function sendWelcome(u, password) {
  await notifyUser(u, {
    kind: 'bienvenida', channels: ['email'], subject: 'Tu acceso a la plataforma de cumplimiento de Portilla Law',
    text: `Hola ${u.name},\n\nSe creó tu cuenta en la plataforma de cumplimiento del Programa de Aprendizaje Registrado.\n\nUsuario: ${u.email}\nContraseña temporal: ${password}\n\nPor favor cámbiala al entrar en "Mi cuenta".`,
    actions: [{ label: 'Entrar a la plataforma', url: `${APP_URL}/login` }],
  });
}

// --- Gestión de usuarios (admin) ---
router.get('/users', requireRole('admin', 'staff'), (req, res) => {
  const users = db.prepare('SELECT u.*, c.name company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id ORDER BY u.role, u.name').all();
  res.render('users', { title: 'Usuarios y accesos', users });
});

router.get('/users/new', requireRole('admin', 'staff', 'employer'), (req, res) => {
  const companies = isStaff(req.user) ? db.prepare('SELECT id, name FROM companies WHERE active = 1 ORDER BY name').all() : [];
  res.render('user_form', { title: 'Nuevo usuario', u: { role: req.query.role || 'employee', company_id: Number(req.query.company) || req.user.company_id }, companies });
});

function allowedRole(actor, role) {
  if (actor.role === 'admin') return ['admin', 'staff', 'employer', 'employee'].includes(role);
  if (actor.role === 'staff') return ['employer', 'employee'].includes(role);
  if (actor.role === 'employer') return role === 'employee';
  return false;
}

router.post('/users', requireRole('admin', 'staff', 'employer'), async (req, res) => {
  const b = req.body;
  const role = b.role || 'employee';
  if (!allowedRole(req.user, role)) return forbidden(res);
  const companyId = req.user.role === 'employer' ? req.user.company_id : (b.company_id ? Number(b.company_id) : null);
  if (!b.name || !b.email) { req.flash('error', 'Nombre y correo son requeridos.'); return res.redirect(req.get('referer') || '/users/new'); }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(b.email.trim())) { req.flash('error', 'Ya existe un usuario con ese correo.'); return res.redirect(req.get('referer') || '/users/new'); }
  const password = b.password || tempPassword();
  const r = db.prepare(`INSERT INTO users (name, email, phone, password_hash, role, company_id, job_title, required_hours, can_view_expenses)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(b.name.trim(), b.email.trim(), b.phone || null, bcrypt.hashSync(password, 10), role,
    ['employer', 'employee'].includes(role) ? companyId : null, b.job_title || null, Number(b.required_hours) || 0,
    req.user.role === 'admin' && role === 'staff' && b.can_view_expenses ? 1 : 0);
  audit(req.user.id, 'crear_usuario', 'user', r.lastInsertRowid, { role, email: b.email });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  await sendWelcome(u, password);
  req.flash('ok', `Usuario creado. Contraseña temporal: ${password} (también enviada por email).`);
  res.redirect(role === 'employee' ? `/employees/${u.id}` : companyId ? `/companies/${companyId}` : '/users');
});

router.get('/users/:id/edit', requireRole('admin', 'staff', 'employer'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.redirect('/');
  if (!isStaff(req.user) && !(u.role === 'employee' && u.company_id === req.user.company_id)) return forbidden(res);
  if (req.user.role === 'staff' && ['admin', 'staff'].includes(u.role) && u.id !== req.user.id) return forbidden(res);
  const companies = isStaff(req.user) ? db.prepare('SELECT id, name FROM companies ORDER BY name').all() : [];
  res.render('user_form', { title: `Editar ${u.name}`, u, companies });
});

router.post('/users/:id', requireRole('admin', 'staff', 'employer'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.redirect('/');
  if (!isStaff(req.user) && !(u.role === 'employee' && u.company_id === req.user.company_id)) return forbidden(res);
  if (req.user.role === 'staff' && ['admin', 'staff'].includes(u.role) && u.id !== req.user.id) return forbidden(res);
  const b = req.body;
  const role = req.user.role === 'admin' && b.role ? b.role : u.role;
  const companyId = isStaff(req.user) ? (b.company_id ? Number(b.company_id) : null) : u.company_id;
  // Sólo el presidente (admin) puede conceder acceso a gastos
  const canExp = req.user.role === 'admin' ? (role === 'staff' && b.can_view_expenses ? 1 : 0) : u.can_view_expenses;
  db.prepare(`UPDATE users SET name=?, email=?, phone=?, role=?, company_id=?, job_title=?, required_hours=?, can_view_expenses=?, notify_email=?, notify_sms=?, notify_whatsapp=?, active=? WHERE id=?`)
    .run(b.name, b.email, b.phone || null, role, companyId, b.job_title || null, Number(b.required_hours) || 0, canExp,
      b.notify_email ? 1 : 0, b.notify_sms ? 1 : 0, b.notify_whatsapp ? 1 : 0, u.id === req.user.id ? 1 : (b.active ? 1 : 0), u.id);
  if (b.password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(b.password, 10), u.id);
  audit(req.user.id, 'editar_usuario', 'user', u.id, { can_view_expenses: canExp, role });
  req.flash('ok', 'Usuario actualizado.');
  res.redirect(u.role === 'employee' ? `/employees/${u.id}` : isStaff(req.user) ? '/users' : '/');
});

// --- Ficha del empleado ---
router.get('/employees/:id', requireLogin, (req, res) => {
  const emp = db.prepare("SELECT u.*, c.name company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ? AND u.role = 'employee'").get(req.params.id);
  if (!emp) return res.status(404).render('error', { title: 'No encontrado', message: 'Empleado no encontrado.' });
  if (!canViewEmployee(req.user, emp)) return forbidden(res);
  const progress = employeeProgress(emp.id);
  const assignments = db.prepare(`SELECT a.*, t.title, t.modality, t.starts_at, t.due_at, t.duration_min, t.hours_credit,
      (SELECT pct FROM video_progress vp WHERE vp.assignment_id = a.id) video_pct,
      (SELECT presence_checks FROM video_progress vp WHERE vp.assignment_id = a.id) presence_checks,
      p.id report_id, p.summary, p.applied_how, p.questions, p.rating, p.submitted_at report_at, p.reviewed_at, p.review_notes
    FROM assignments a JOIN trainings t ON t.id = a.training_id LEFT JOIN progress_reports p ON p.assignment_id = a.id
    WHERE a.employee_id = ? AND t.cancelled = 0 ORDER BY t.starts_at DESC`).all(emp.id)
    .map((a) => ({ ...a, checklist: checklist(a, a.report_id ? { submitted_at: a.report_at } : null) }));
  const alerts = db.prepare('SELECT * FROM compliance_alerts WHERE employee_id = ? ORDER BY created_at DESC LIMIT 20').all(emp.id);
  const comms = isStaff(req.user) ? db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(emp.id) : [];
  res.render('employee', { title: emp.name, emp, progress, assignments, alerts, comms });
});

module.exports = router;
