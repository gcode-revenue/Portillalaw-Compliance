'use strict';
// GASTOS — acceso exclusivo del presidente (admin) y del personal que él designe
// (usuarios "staff" con can_view_expenses = 1). Patronos y empleados nunca lo ven.
const express = require('express');
const { db, audit } = require('../db');
const { requireExpenses } = require('../auth');

const router = express.Router();
const CATEGORIES = { instructor: 'Instructor / facilitador', local: 'Local / facilidades', materiales: 'Materiales', plataforma: 'Plataforma (Zoom, video, LMS)', transporte: 'Transporte', alimentos: 'Alimentos', certificacion: 'Certificación', otro: 'Otro' };

router.use('/expenses', requireExpenses);

router.get('/expenses', (req, res) => {
  const f = { company: Number(req.query.company) || null, from: req.query.from || '', to: req.query.to || '' };
  let sql = `SELECT e.*, c.name company_name, t.title training_title, u.name creator FROM expenses e
    LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN trainings t ON t.id = e.training_id LEFT JOIN users u ON u.id = e.created_by WHERE 1=1`;
  const p = [];
  if (f.company) { sql += ' AND e.company_id = ?'; p.push(f.company); }
  if (f.from) { sql += ' AND e.incurred_on >= ?'; p.push(f.from); }
  if (f.to) { sql += ' AND e.incurred_on <= ?'; p.push(f.to); }
  const list = db.prepare(sql + ' ORDER BY e.incurred_on DESC, e.id DESC').all(...p);
  const total = list.reduce((s, e) => s + e.amount, 0);
  const byCompany = {}, byCategory = {};
  for (const e of list) {
    byCompany[e.company_name || 'General'] = (byCompany[e.company_name || 'General'] || 0) + e.amount;
    byCategory[CATEGORIES[e.category] || e.category] = (byCategory[CATEGORIES[e.category] || e.category] || 0) + e.amount;
  }
  const companies = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  const trainings = db.prepare('SELECT id, title, starts_at FROM trainings ORDER BY starts_at DESC LIMIT 200').all();
  res.render('expenses', { title: 'Gastos', list, total, byCompany, byCategory, companies, trainings, CATEGORIES, f });
});

router.get('/expenses.csv', requireExpenses, (req, res) => {
  const list = db.prepare(`SELECT e.incurred_on, c.name company, t.title training, e.category, e.vendor, e.description, e.amount FROM expenses e
    LEFT JOIN companies c ON c.id = e.company_id LEFT JOIN trainings t ON t.id = e.training_id ORDER BY e.incurred_on`).all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Fecha,Compañía,Entrenamiento,Categoría,Suplidor,Descripción,Monto', ...list.map((r) => [r.incurred_on, r.company, r.training, CATEGORIES[r.category] || r.category, r.vendor, r.description, r.amount.toFixed(2)].map(esc).join(','))].join('\n');
  audit(req.user.id, 'exportar_gastos', 'expense', null);
  res.attachment('gastos-portilla-law.csv').type('text/csv').send('﻿' + csv);
});

router.post('/expenses', (req, res) => {
  const b = req.body;
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !b.incurred_on || !CATEGORIES[b.category]) { req.flash('error', 'Fecha, categoría y monto válido son requeridos.'); return res.redirect('/expenses'); }
  const r = db.prepare('INSERT INTO expenses (company_id, training_id, category, description, vendor, amount, incurred_on, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(b.company_id ? Number(b.company_id) : null, b.training_id ? Number(b.training_id) : null, b.category, b.description || null, b.vendor || null, amount, b.incurred_on, req.user.id);
  audit(req.user.id, 'crear_gasto', 'expense', r.lastInsertRowid, { amount });
  req.flash('ok', 'Gasto registrado.');
  res.redirect('/expenses');
});

router.post('/expenses/:id/delete', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  audit(req.user.id, 'eliminar_gasto', 'expense', Number(req.params.id));
  req.flash('ok', 'Gasto eliminado.');
  res.redirect('/expenses');
});

module.exports = router;
