'use strict';
const { db } = require('../db');

const STATUS_LABELS = {
  asignado: 'Asignado (sin confirmar)',
  confirmado: 'Asistencia confirmada',
  en_curso: 'En curso (check-in)',
  pendiente_reporte: 'Pendiente progress report',
  completado: 'Completado',
  ausente: 'Ausente',
  excusado: 'Excusado',
};
const MODALITY_LABELS = { video: 'Video', presencial: 'Presencial', zoom: 'Zoom' };

/** Progreso de un empleado: % de horas completadas sobre lo asignado (o la meta, si es mayor). */
function employeeProgress(employeeId) {
  const rows = db.prepare(`
    SELECT a.status, t.hours_credit FROM assignments a JOIN trainings t ON t.id = a.training_id
    WHERE a.employee_id = ? AND t.cancelled = 0`).all(employeeId);
  const emp = db.prepare('SELECT required_hours FROM users WHERE id = ?').get(employeeId) || {};
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
  let assignedHours = 0, completedHours = 0;
  for (const r of rows) {
    counts[r.status]++;
    if (r.status === 'excusado') continue;
    assignedHours += r.hours_credit;
    if (r.status === 'completado') completedHours += r.hours_credit;
  }
  const target = Math.max(assignedHours, emp.required_hours || 0);
  const pct = target > 0 ? Math.round((completedHours / target) * 100) : 0;
  const attended = counts.completado + counts.pendiente_reporte + counts.en_curso;
  const finished = attended + counts.ausente;
  const attendancePct = finished > 0 ? Math.round((attended / finished) * 100) : 100;
  const inCompliance = counts.ausente === 0 && counts.pendiente_reporte === 0 &&
    !db.prepare("SELECT 1 FROM compliance_alerts WHERE employee_id = ? AND status = 'abierta'").get(employeeId);
  return { total: rows.length, counts, assignedHours, completedHours, requiredHours: emp.required_hours || 0, target, pct, attendancePct, inCompliance };
}

function companyProgress(companyId) {
  const emps = db.prepare("SELECT id, name, job_title FROM users WHERE role = 'employee' AND active = 1 AND company_id = ? ORDER BY name").all(companyId);
  const list = emps.map((e) => ({ ...e, progress: employeeProgress(e.id) }));
  const avg = list.length ? Math.round(list.reduce((s, e) => s + e.progress.pct, 0) / list.length) : 0;
  const compliant = list.filter((e) => e.progress.inCompliance).length;
  const openAlerts = db.prepare("SELECT COUNT(*) c FROM compliance_alerts WHERE company_id = ? AND status = 'abierta'").get(companyId).c;
  return { employees: list, avg, compliant, total: list.length, openAlerts };
}

/** Checklist de redundancia por asignación: confirmó → check-in → finalizó → reporte → verificado */
function checklist(a, report) {
  return [
    { label: 'Confirmó asistencia', done: !!a.confirmed_at, at: a.confirmed_at, extra: a.confirmed_via },
    { label: 'Check-in al entrenamiento', done: !!a.checked_in_at, at: a.checked_in_at },
    { label: 'Finalizó / check-out', done: !!a.checked_out_at, at: a.checked_out_at },
    { label: 'Progress report sometido', done: !!report, at: report?.submitted_at },
    { label: 'Verificado por Portilla Law', done: !!a.verified_at, at: a.verified_at },
  ];
}

module.exports = { employeeProgress, companyProgress, checklist, STATUS_LABELS, MODALITY_LABELS };
