'use strict';
// Reporte semanal al cliente (patrono): progreso de cada empleado, asistencia,
// ausencias, progress reports pendientes y próximos entrenamientos.
const { db, audit } = require('../db');
const { companyProgress, STATUS_LABELS } = require('./progress');
const { notifyUser, internalMessage, APP_URL, escapeHtml } = require('./notify');
const { fmt, fmtDate } = require('../util/time');

function weeklyReportData(companyId, now = new Date()) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
  if (!company) return null;
  const end = new Date(now);
  const start = new Date(end.getTime() - 7 * 864e5);
  const nextEnd = new Date(end.getTime() + 7 * 864e5);
  const prog = companyProgress(companyId);
  const q = db.prepare(`SELECT a.status, t.title, t.starts_at, t.hours_credit FROM assignments a JOIN trainings t ON t.id = a.training_id
    WHERE a.employee_id = ? AND t.cancelled = 0 AND t.starts_at >= ? AND t.starts_at < ? ORDER BY t.starts_at`);
  const employees = prog.employees.map((e) => {
    const week = q.all(e.id, start.toISOString(), end.toISOString());
    const upcoming = q.all(e.id, end.toISOString(), nextEnd.toISOString());
    return {
      ...e,
      week,
      upcoming,
      weekCompleted: week.filter((w) => w.status === 'completado').length,
      weekMissed: week.filter((w) => w.status === 'ausente').length,
      weekPendingReport: week.filter((w) => w.status === 'pendiente_reporte').length,
    };
  });
  const alerts = db.prepare(`SELECT ca.*, u.name emp_name FROM compliance_alerts ca LEFT JOIN users u ON u.id = ca.employee_id
    WHERE ca.company_id = ? AND ca.status = 'abierta' ORDER BY ca.created_at DESC`).all(companyId);
  return { company, start, end, prog, employees, alerts };
}

function weeklyReportText(d) {
  const lines = [
    `Reporte semanal de cumplimiento — ${d.company.name}`,
    `Periodo: ${fmtDate(d.start.toISOString())} al ${fmtDate(d.end.toISOString())}`,
    '',
    `Progreso promedio: ${d.prog.avg}% · Empleados en cumplimiento: ${d.prog.compliant}/${d.prog.total} · Alertas abiertas: ${d.prog.openAlerts}`,
    '',
  ];
  for (const e of d.employees) {
    lines.push(`• ${e.name}: ${e.progress.pct}% completado (${e.progress.completedHours}/${e.progress.target} h) — ` +
      `${e.progress.inCompliance ? 'EN CUMPLIMIENTO' : 'REQUIERE ATENCIÓN'}. Semana: ${e.weekCompleted} completados, ${e.weekMissed} ausencias, ${e.weekPendingReport} reportes pendientes. Próximos: ${e.upcoming.length}.`);
  }
  if (d.alerts.length) {
    lines.push('', 'Alertas abiertas:');
    for (const a of d.alerts) lines.push(`- ${a.message}`);
  }
  lines.push('', `Vea el detalle completo en la plataforma: ${APP_URL}/reports/weekly/${d.company.id}`);
  return lines.join('\n');
}

function weeklyReportHtml(d) {
  const color = (p) => (p >= 80 ? '#1b7f4b' : p >= 50 ? '#c98a00' : '#b42318');
  const rows = d.employees.map((e) => `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(e.name)}<br><small style="color:#6b7785">${escapeHtml(e.job_title || '')}</small></td>
    <td style="padding:8px;border-bottom:1px solid #eee"><div style="background:#eef1f5;border-radius:4px;width:120px"><div style="background:${color(e.progress.pct)};width:${Math.min(e.progress.pct, 100) * 1.2}px;height:10px;border-radius:4px"></div></div>${e.progress.pct}%</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${e.weekCompleted}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;color:${e.weekMissed ? '#b42318' : 'inherit'}">${e.weekMissed}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${e.weekPendingReport}</td>
    <td style="padding:8px;border-bottom:1px solid #eee">${e.progress.inCompliance ? '✅ En cumplimiento' : '⚠️ Requiere atención'}</td></tr>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:auto">
  <div style="background:#0b3d63;color:#fff;padding:16px 20px;font-size:18px;font-weight:700">Portilla Law · Reporte semanal de cumplimiento</div>
  <div style="padding:16px 20px">
  <h2 style="margin:0 0 4px">${escapeHtml(d.company.name)}</h2>
  <p style="color:#6b7785;margin:0 0 16px">${fmtDate(d.start.toISOString())} – ${fmtDate(d.end.toISOString())}</p>
  <p><b>Progreso promedio:</b> ${d.prog.avg}% &nbsp;·&nbsp; <b>En cumplimiento:</b> ${d.prog.compliant}/${d.prog.total} &nbsp;·&nbsp; <b>Alertas abiertas:</b> ${d.prog.openAlerts}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="background:#f4f6f9;text-align:left">
  <th style="padding:8px">Empleado</th><th style="padding:8px">Progreso</th><th style="padding:8px">Completados</th><th style="padding:8px">Ausencias</th><th style="padding:8px">Reportes pend.</th><th style="padding:8px">Estado</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" style="padding:8px">Sin empleados registrados.</td></tr>'}</tbody></table>
  ${d.alerts.length ? `<h3>Alertas abiertas</h3><ul>${d.alerts.map((a) => `<li>${escapeHtml(a.message)}</li>`).join('')}</ul>` : ''}
  <p><a href="${APP_URL}/reports/weekly/${d.company.id}" style="display:inline-block;padding:10px 16px;background:#0b3d63;color:#fff;border-radius:6px;text-decoration:none">Ver reporte completo</a></p>
  </div></div>`;
}

async function sendWeeklyReport(companyId, actorId = null, now = new Date()) {
  const d = weeklyReportData(companyId, now);
  if (!d) return { sent: 0 };
  const text = weeklyReportText(d);
  const subject = `Reporte semanal de cumplimiento — ${d.company.name}`;
  const weekKey = d.end.toISOString().slice(0, 10);
  const recipients = db.prepare("SELECT * FROM users WHERE role = 'employer' AND active = 1 AND company_id = ?").all(companyId);
  for (const r of recipients) {
    const key = actorId ? `weekly:${companyId}:${Date.now()}` : `weekly:${companyId}:${weekKey}`;
    await internalMessage({ recipient: r, subject, body: text, kind: 'reporte_semanal', dedupeKey: key });
    await notifyUser(r, { kind: 'reporte_semanal', subject, text, html: weeklyReportHtml(d), channels: ['email'], dedupeKey: key,
      actions: [{ label: 'Ver reporte completo', url: `${APP_URL}/reports/weekly/${companyId}` }] });
  }
  audit(actorId, 'enviar_reporte_semanal', 'company', companyId, { recipients: recipients.length });
  return { sent: recipients.length };
}

async function sendAllWeeklyReports() {
  const companies = db.prepare('SELECT id FROM companies WHERE active = 1').all();
  let total = 0;
  for (const c of companies) total += (await sendWeeklyReport(c.id)).sent;
  return total;
}

module.exports = { weeklyReportData, weeklyReportText, weeklyReportHtml, sendWeeklyReport, sendAllWeeklyReports, STATUS_LABELS, fmt };
