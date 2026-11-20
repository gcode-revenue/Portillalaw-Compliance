'use strict';
const express = require('express');
const { db } = require('../db');
const { requireLogin, isStaff } = require('../auth');
const { employeeProgress, companyProgress, checklist } = require('../services/progress');
const { checkInWindow } = require('../services/compliance');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const u = req.user;
  const nowIso = new Date().toISOString();
  if (isStaff(u)) {
    const companies = db.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY name').all()
      .map((c) => ({ ...c, prog: companyProgress(c.id) }));
    const upcoming = db.prepare(`SELECT t.*, c.name company_name,
        (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id) assigned,
        (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id AND a.status <> 'asignado') confirmed
      FROM trainings t LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.cancelled = 0 AND datetime(t.starts_at, '+' || t.duration_min || ' minutes') >= datetime(?) ORDER BY t.starts_at LIMIT 10`).all(nowIso);
    const alerts = db.prepare(`SELECT ca.*, u.name emp_name, c.name company_name FROM compliance_alerts ca
      LEFT JOIN users u ON u.id = ca.employee_id LEFT JOIN companies c ON c.id = ca.company_id
      WHERE ca.status = 'abierta' ORDER BY ca.created_at DESC LIMIT 10`).all();
    const stats = {
      companies: companies.length,
      employees: db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'employee' AND active = 1").get().c,
      avg: companies.length ? Math.round(companies.reduce((s, c) => s + c.prog.avg, 0) / companies.length) : 0,
      pendingReports: db.prepare("SELECT COUNT(*) c FROM assignments WHERE status = 'pendiente_reporte'").get().c,
      unreviewed: db.prepare('SELECT COUNT(*) c FROM progress_reports WHERE reviewed_at IS NULL').get().c,
    };
    return res.render('dash_staff', { title: 'Panel de control', companies, upcoming, alerts, stats });
  }
  if (u.role === 'employer') {
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(u.company_id);
    const prog = company ? companyProgress(company.id) : { employees: [], avg: 0, compliant: 0, total: 0, openAlerts: 0 };
    const upcoming = db.prepare(`SELECT DISTINCT t.* FROM trainings t JOIN assignments a ON a.training_id = t.id JOIN users e ON e.id = a.employee_id
      WHERE e.company_id = ? AND t.cancelled = 0 AND t.starts_at >= ? ORDER BY t.starts_at LIMIT 10`).all(u.company_id, nowIso);
    const alerts = db.prepare(`SELECT ca.*, u.name emp_name FROM compliance_alerts ca LEFT JOIN users u ON u.id = ca.employee_id
      WHERE ca.company_id = ? AND ca.status = 'abierta' ORDER BY ca.created_at DESC`).all(u.company_id);
    return res.render('dash_employer', { title: 'Mi empresa', company, prog, upcoming, alerts });
  }
  // Empleado
  const progress = employeeProgress(u.id);
  const assignments = db.prepare(`SELECT a.*, t.title, t.modality, t.starts_at, t.duration_min, t.location, t.meeting_url, t.hours_credit, t.instructor,
      (SELECT id FROM progress_reports p WHERE p.assignment_id = a.id) report_id,
      (SELECT submitted_at FROM progress_reports p WHERE p.assignment_id = a.id) report_at
    FROM assignments a JOIN trainings t ON t.id = a.training_id
    WHERE a.employee_id = ? AND t.cancelled = 0 ORDER BY t.starts_at DESC`).all(u.id)
    .map((a) => ({ ...a, window: checkInWindow(a), checklist: checklist(a, a.report_id ? { submitted_at: a.report_at } : null) }));
  const upcoming = assignments.filter((a) => ['asignado', 'confirmado', 'en_curso'].includes(a.status)).reverse();
  const actionNeeded = assignments.filter((a) => a.status === 'pendiente_reporte' || (a.status === 'asignado'));
  const history = assignments.filter((a) => !['asignado', 'confirmado', 'en_curso'].includes(a.status));
  res.render('dash_employee', { title: 'Mis entrenamientos', progress, upcoming, history, actionNeeded });
});

module.exports = router;
