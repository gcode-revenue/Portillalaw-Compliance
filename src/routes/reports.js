'use strict';
const express = require('express');
const { db } = require('../db');
const { requireLogin, requireStaff, canViewCompany, forbidden, isStaff } = require('../auth');
const reports = require('../services/reports');

const router = express.Router();

router.get('/reports', requireLogin, (req, res) => {
  if (!isStaff(req.user)) return req.user.role === 'employer' ? res.redirect(`/reports/weekly/${req.user.company_id}`) : forbidden(res);
  const companies = db.prepare('SELECT id, name FROM companies WHERE active = 1 ORDER BY name').all();
  const sent = db.prepare(`SELECT n.*, u.name user_name, c.name company_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id LEFT JOIN companies c ON c.id = n.company_id
    WHERE n.kind = 'reporte_semanal' AND n.channel = 'email' ORDER BY n.id DESC LIMIT 50`).all();
  res.render('reports', { title: 'Reportes semanales', companies, sent });
});

router.get('/reports/weekly/:companyId', requireLogin, (req, res) => {
  if (!canViewCompany(req.user, req.params.companyId)) return forbidden(res);
  const d = reports.weeklyReportData(Number(req.params.companyId));
  if (!d) return res.status(404).render('error', { title: 'No encontrado', message: 'Compañía no encontrada.' });
  res.render('report_weekly', { title: `Reporte semanal — ${d.company.name}`, d, print: req.query.print === '1' });
});

router.post('/reports/weekly/:companyId/send', requireStaff, async (req, res) => {
  const r = await reports.sendWeeklyReport(Number(req.params.companyId), req.user.id);
  req.flash('ok', `Reporte enviado a ${r.sent} patrono(s).`);
  res.redirect(req.get('referer') || '/reports');
});

router.post('/reports/weekly-all/send', requireStaff, async (req, res) => {
  const n = await reports.sendAllWeeklyReports();
  req.flash('ok', `Reportes semanales enviados a ${n} patrono(s).`);
  res.redirect('/reports');
});

module.exports = router;
