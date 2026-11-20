'use strict';
const express = require('express');
const { db, audit } = require('../db');
const { requireLogin, requireStaff, canViewCompany, forbidden } = require('../auth');
const { companyProgress } = require('../services/progress');

const router = express.Router();
const PROPOSAL_STATUS = { planificacion: 'Planificación', sometida: 'Propuesta sometida', aprobada: 'Aprobada', en_ejecucion: 'En ejecución (adiestramientos)', facturacion: 'Facturación / certificación', cerrada: 'Cerrada' };

router.get('/companies', requireStaff, (req, res) => {
  const companies = db.prepare('SELECT * FROM companies ORDER BY active DESC, name').all().map((c) => ({ ...c, prog: companyProgress(c.id) }));
  res.render('companies', { title: 'Compañías clientes', companies, PROPOSAL_STATUS });
});

router.get('/companies/new', requireStaff, (req, res) => res.render('company_form', { title: 'Nueva compañía', c: {}, PROPOSAL_STATUS }));

function fields(b) {
  return [b.name, b.contact_name || null, b.contact_email || null, b.contact_phone || null, b.address || null,
    b.program_name || 'Programa de Aprendizaje Registrado', b.proposal_status || 'planificacion', b.proposal_notes || null];
}

router.post('/companies', requireStaff, (req, res) => {
  if (!req.body.name) { req.flash('error', 'El nombre es requerido.'); return res.redirect('/companies/new'); }
  const r = db.prepare(`INSERT INTO companies (name, contact_name, contact_email, contact_phone, address, program_name, proposal_status, proposal_notes)
    VALUES (?,?,?,?,?,?,?,?)`).run(...fields(req.body));
  audit(req.user.id, 'crear_compania', 'company', r.lastInsertRowid, { name: req.body.name });
  req.flash('ok', 'Compañía creada. Ahora añade al patrono y sus empleados.');
  res.redirect(`/companies/${r.lastInsertRowid}`);
});

router.get('/companies/:id', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  if (!canViewCompany(req.user, id)) return forbidden(res);
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!c) return res.status(404).render('error', { title: 'No encontrado', message: 'Compañía no encontrada.' });
  const prog = companyProgress(id);
  const employers = db.prepare("SELECT * FROM users WHERE role = 'employer' AND company_id = ? ORDER BY name").all(id);
  const inactive = db.prepare("SELECT * FROM users WHERE role = 'employee' AND active = 0 AND company_id = ? ORDER BY name").all(id);
  const trainings = db.prepare(`SELECT DISTINCT t.* FROM trainings t LEFT JOIN assignments a ON a.training_id = t.id LEFT JOIN users e ON e.id = a.employee_id
    WHERE t.company_id = ? OR e.company_id = ? ORDER BY t.starts_at DESC LIMIT 25`).all(id, id);
  res.render('company', { title: c.name, c, prog, employers, inactive, trainings, PROPOSAL_STATUS });
});

router.get('/companies/:id/edit', requireStaff, (req, res) => {
  const c = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/companies');
  res.render('company_form', { title: `Editar ${c.name}`, c, PROPOSAL_STATUS });
});

router.post('/companies/:id', requireStaff, (req, res) => {
  db.prepare(`UPDATE companies SET name=?, contact_name=?, contact_email=?, contact_phone=?, address=?, program_name=?, proposal_status=?, proposal_notes=?, active=? WHERE id=?`)
    .run(...fields(req.body), req.body.active ? 1 : 0, req.params.id);
  audit(req.user.id, 'editar_compania', 'company', Number(req.params.id));
  req.flash('ok', 'Compañía actualizada.');
  res.redirect(`/companies/${req.params.id}`);
});

module.exports = router;
module.exports.PROPOSAL_STATUS = PROPOSAL_STATUS;
