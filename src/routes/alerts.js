'use strict';
const express = require('express');
const { db, audit } = require('../db');
const { requireRole, isStaff, forbidden } = require('../auth');

const router = express.Router();
const TYPE_LABELS = { ausencia: 'Ausencia', sin_confirmar: 'Sin confirmar asistencia', sin_reporte: 'Progress report vencido', sin_respuesta: 'Sin respuesta' };

router.get('/alerts', requireRole('admin', 'staff', 'employer'), (req, res) => {
  const status = req.query.status === 'resuelta' ? 'resuelta' : 'abierta';
  let sql = `SELECT ca.*, u.name emp_name, u.phone emp_phone, c.name company_name, t.title training_title, t.starts_at, r.name resolver
    FROM compliance_alerts ca LEFT JOIN users u ON u.id = ca.employee_id LEFT JOIN companies c ON c.id = ca.company_id
    LEFT JOIN assignments a ON a.id = ca.assignment_id LEFT JOIN trainings t ON t.id = a.training_id LEFT JOIN users r ON r.id = ca.resolved_by
    WHERE ca.status = ?`;
  const params = [status];
  if (!isStaff(req.user)) { sql += ' AND ca.company_id = ?'; params.push(req.user.company_id); }
  res.render('alerts', { title: 'Alertas de cumplimiento', alerts: db.prepare(sql + ' ORDER BY ca.created_at DESC LIMIT 300').all(...params), status, TYPE_LABELS });
});

router.post('/alerts/:id/resolve', requireRole('admin', 'staff', 'employer'), (req, res) => {
  const a = db.prepare('SELECT * FROM compliance_alerts WHERE id = ?').get(req.params.id);
  if (!a || (!isStaff(req.user) && a.company_id !== req.user.company_id)) return forbidden(res);
  db.prepare("UPDATE compliance_alerts SET status = 'resuelta', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?")
    .run(req.body.resolution || 'Resuelta', req.user.id, new Date().toISOString(), a.id);
  audit(req.user.id, 'resolver_alerta', 'alert', a.id, { resolution: req.body.resolution });
  req.flash('ok', 'Alerta resuelta.');
  res.redirect(req.get('referer') || '/alerts');
});

module.exports = router;
module.exports.TYPE_LABELS = TYPE_LABELS;
