'use strict';
const express = require('express');
const { db, audit } = require('../db');
const { requireLogin, requireStaff, isStaff, forbidden } = require('../auth');
const { localInputToIso } = require('../util/time');
const compliance = require('../services/compliance');
const { checklist } = require('../services/progress');
const { notifyUser } = require('../services/notify');

const router = express.Router();

function canSeeTraining(u, t) {
  if (isStaff(u)) return true;
  if (u.role === 'employer') {
    return t.company_id === u.company_id || !!db.prepare('SELECT 1 FROM assignments a JOIN users e ON e.id = a.employee_id WHERE a.training_id = ? AND e.company_id = ?').get(t.id, u.company_id);
  }
  return !!db.prepare('SELECT 1 FROM assignments WHERE training_id = ? AND employee_id = ?').get(t.id, u.id);
}

router.get('/trainings', requireLogin, (req, res) => {
  const u = req.user;
  const scope = req.query.scope === 'past' ? 'past' : 'upcoming';
  const nowIso = new Date().toISOString();
  const cond = scope === 'past' ? "datetime(t.starts_at) < datetime(?)" : "datetime(t.starts_at, '+' || t.duration_min || ' minutes') >= datetime(?)";
  let sql = `SELECT t.*, c.name company_name,
      (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id) assigned,
      (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id AND a.status IN ('confirmado','en_curso','pendiente_reporte','completado')) confirmed,
      (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id AND a.status = 'completado') completed,
      (SELECT COUNT(*) FROM assignments a WHERE a.training_id = t.id AND a.status = 'ausente') absent
    FROM trainings t LEFT JOIN companies c ON c.id = t.company_id WHERE ${cond}`;
  const params = [nowIso];
  if (u.role === 'employer') { sql += ' AND (t.company_id = ? OR t.id IN (SELECT a.training_id FROM assignments a JOIN users e ON e.id = a.employee_id WHERE e.company_id = ?))'; params.push(u.company_id, u.company_id); }
  if (u.role === 'employee') { sql += ' AND t.id IN (SELECT training_id FROM assignments WHERE employee_id = ?)'; params.push(u.id); }
  sql += scope === 'past' ? ' ORDER BY t.starts_at DESC LIMIT 200' : ' ORDER BY t.starts_at LIMIT 200';
  res.render('trainings', { title: 'Entrenamientos', trainings: db.prepare(sql).all(...params), scope });
});

router.get('/trainings/new', requireStaff, (req, res) => {
  const companies = db.prepare('SELECT id, name FROM companies WHERE active = 1 ORDER BY name').all();
  res.render('training_form', { title: 'Nuevo entrenamiento', t: { modality: 'zoom', duration_min: 60, hours_credit: 1, company_id: Number(req.query.company) || null }, companies });
});

function trainingFields(b) {
  return [b.title, b.description || null, b.modality, localInputToIso(b.starts_at), Number(b.duration_min) || 60,
    Number(b.hours_credit) || 0, b.location || null, b.meeting_url || null, b.instructor || null, b.company_id ? Number(b.company_id) : null];
}

router.post('/trainings', requireStaff, (req, res) => {
  const b = req.body;
  if (!b.title || !b.starts_at || !['video', 'presencial', 'zoom'].includes(b.modality)) { req.flash('error', 'Título, modalidad y fecha son requeridos.'); return res.redirect('/trainings/new'); }
  const r = db.prepare(`INSERT INTO trainings (title, description, modality, starts_at, duration_min, hours_credit, location, meeting_url, instructor, company_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...trainingFields(b), req.user.id);
  audit(req.user.id, 'crear_entrenamiento', 'training', r.lastInsertRowid, { title: b.title });
  req.flash('ok', 'Entrenamiento creado. Ahora asigna a los empleados.');
  res.redirect(`/trainings/${r.lastInsertRowid}`);
});

router.get('/trainings/:id', requireLogin, (req, res) => {
  const t = db.prepare('SELECT t.*, c.name company_name FROM trainings t LEFT JOIN companies c ON c.id = t.company_id WHERE t.id = ?').get(req.params.id);
  if (!t) return res.status(404).render('error', { title: 'No encontrado', message: 'Entrenamiento no encontrado.' });
  if (!canSeeTraining(req.user, t)) return forbidden(res);
  let rosterSql = `SELECT a.*, u.name emp_name, u.email, u.phone, c.name company_name, p.id report_id, p.submitted_at report_at
    FROM assignments a JOIN users u ON u.id = a.employee_id LEFT JOIN companies c ON c.id = u.company_id
    LEFT JOIN progress_reports p ON p.assignment_id = a.id WHERE a.training_id = ?`;
  const params = [t.id];
  if (req.user.role === 'employer') { rosterSql += ' AND u.company_id = ?'; params.push(req.user.company_id); }
  if (req.user.role === 'employee') { rosterSql += ' AND u.id = ?'; params.push(req.user.id); }
  const roster = db.prepare(rosterSql + ' ORDER BY u.name').all(...params)
    .map((a) => ({ ...a, checklist: checklist(a, a.report_id ? { submitted_at: a.report_at } : null) }));
  let candidates = [];
  if (isStaff(req.user)) {
    candidates = db.prepare(`SELECT u.id, u.name, c.name company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.role = 'employee' AND u.active = 1 AND u.id NOT IN (SELECT employee_id FROM assignments WHERE training_id = ?)
      ${t.company_id ? 'AND u.company_id = ?' : ''} ORDER BY c.name, u.name`).all(...(t.company_id ? [t.id, t.company_id] : [t.id]));
  }
  res.render('training', { title: t.title, t, roster, candidates, window: compliance.checkInWindow(t) });
});

router.get('/trainings/:id/edit', requireStaff, (req, res) => {
  const t = db.prepare('SELECT * FROM trainings WHERE id = ?').get(req.params.id);
  if (!t) return res.redirect('/trainings');
  const companies = db.prepare('SELECT id, name FROM companies ORDER BY name').all();
  res.render('training_form', { title: `Editar ${t.title}`, t, companies });
});

router.post('/trainings/:id', requireStaff, async (req, res) => {
  const old = db.prepare('SELECT * FROM trainings WHERE id = ?').get(req.params.id);
  if (!old) return res.redirect('/trainings');
  const f = trainingFields(req.body);
  db.prepare(`UPDATE trainings SET title=?, description=?, modality=?, starts_at=?, duration_min=?, hours_credit=?, location=?, meeting_url=?, instructor=?, company_id=? WHERE id=?`)
    .run(...f, old.id);
  audit(req.user.id, 'editar_entrenamiento', 'training', old.id);
  if (f[3] !== old.starts_at) {
    // Cambió la fecha: reiniciar recordatorios y avisar a los participantes
    db.prepare("DELETE FROM notifications WHERE kind = 'recordatorio' AND assignment_id IN (SELECT id FROM assignments WHERE training_id = ?)").run(old.id);
    const people = db.prepare("SELECT u.*, a.id aid FROM assignments a JOIN users u ON u.id = a.employee_id WHERE a.training_id = ? AND a.status IN ('asignado','confirmado')").all(old.id);
    for (const p of people) {
      await notifyUser(p, { kind: 'cambio_fecha', subject: `Cambio de fecha: "${f[0]}"`, assignmentId: p.aid,
        text: `Hola ${p.name},\n\nEl entrenamiento "${f[0]}" fue reprogramado para el ${res.locals.fmt(f[3])}.`,
        sms: `Portilla Law: "${f[0]}" fue reprogramado para el ${res.locals.fmt(f[3])}.`, actions: [{ label: 'Confirmar asistencia', url: compliance.links({ id: p.aid }).confirm }] });
    }
  }
  req.flash('ok', 'Entrenamiento actualizado.');
  res.redirect(`/trainings/${old.id}`);
});

router.post('/trainings/:id/cancel', requireStaff, async (req, res) => {
  const t = db.prepare('SELECT * FROM trainings WHERE id = ?').get(req.params.id);
  if (!t) return res.redirect('/trainings');
  db.prepare('UPDATE trainings SET cancelled = 1 WHERE id = ?').run(t.id);
  audit(req.user.id, 'cancelar_entrenamiento', 'training', t.id);
  const people = db.prepare("SELECT u.*, a.id aid FROM assignments a JOIN users u ON u.id = a.employee_id WHERE a.training_id = ? AND a.status IN ('asignado','confirmado')").all(t.id);
  for (const p of people) {
    await notifyUser(p, { kind: 'cancelacion', subject: `Cancelado: "${t.title}"`, assignmentId: p.aid,
      text: `Hola ${p.name},\n\nEl entrenamiento "${t.title}" del ${res.locals.fmt(t.starts_at)} fue CANCELADO. Te notificaremos la nueva fecha.`,
      sms: `Portilla Law: "${t.title}" del ${res.locals.fmt(t.starts_at)} fue CANCELADO.` });
  }
  req.flash('ok', 'Entrenamiento cancelado y participantes notificados.');
  res.redirect(`/trainings/${t.id}`);
});

router.post('/trainings/:id/assign', requireStaff, async (req, res) => {
  const ids = [].concat(req.body.employee_ids || []).map(Number).filter(Boolean);
  const ins = db.prepare('INSERT OR IGNORE INTO assignments (training_id, employee_id) VALUES (?, ?)');
  const created = [];
  for (const id of ids) { const r = ins.run(req.params.id, id); if (r.changes) created.push(r.lastInsertRowid); }
  audit(req.user.id, 'asignar_entrenamiento', 'training', Number(req.params.id), { employees: ids });
  for (const aid of created) await compliance.notifyAssigned(aid);
  req.flash('ok', `${created.length} empleado(s) asignado(s) y notificado(s).`);
  res.redirect(`/trainings/${req.params.id}`);
});

// --- Acciones sobre una asignación ---
function loadAssignment(id) {
  return db.prepare(`SELECT a.*, t.title, t.starts_at, t.duration_min, u.company_id, u.name emp_name
    FROM assignments a JOIN trainings t ON t.id = a.training_id JOIN users u ON u.id = a.employee_id WHERE a.id = ?`).get(id);
}
function back(req, res, a) { res.redirect(req.get('referer') || `/trainings/${a.training_id}`); }

// Empleado: confirmar / check-in desde la plataforma
router.post('/assignments/:id/confirm', requireLogin, (req, res) => {
  const a = loadAssignment(req.params.id);
  if (!a || (a.employee_id !== req.user.id && !isStaff(req.user))) return forbidden(res);
  compliance.confirmAssignment(a.id, a.employee_id === req.user.id ? 'plataforma' : `staff: ${req.user.name}`);
  audit(req.user.id, 'confirmar_asistencia', 'assignment', a.id);
  req.flash('ok', 'Asistencia confirmada.');
  back(req, res, a);
});
router.post('/assignments/:id/checkin', requireLogin, (req, res) => {
  const a = loadAssignment(req.params.id);
  if (!a || a.employee_id !== req.user.id) return forbidden(res);
  const r = compliance.checkIn(a.id);
  audit(req.user.id, 'check_in', 'assignment', a.id, r);
  req.flash(r.ok ? 'ok' : 'error', r.ok ? 'Check-in registrado. ¡Buen entrenamiento!' : r.error);
  back(req, res, a);
});
router.get('/assignments/:id/report', requireLogin, (req, res) => {
  const a = loadAssignment(req.params.id);
  if (!a || a.employee_id !== req.user.id) return forbidden(res);
  res.render('report_form', { title: 'Progress report', a, error: null, action: `/assignments/${a.id}/report` });
});
router.post('/assignments/:id/report', requireLogin, (req, res) => {
  const a = loadAssignment(req.params.id);
  if (!a || a.employee_id !== req.user.id) return forbidden(res);
  const r = compliance.submitReport(a.id, req.user.id, req.body);
  if (!r.ok) return res.render('report_form', { title: 'Progress report', a, error: r.error, action: `/assignments/${a.id}/report` });
  audit(req.user.id, 'someter_reporte', 'assignment', a.id);
  req.flash('ok', '¡Progress report sometido! El entrenamiento cuenta para tu progreso.');
  res.redirect('/');
});

// Staff / patrono: control de asistencia y cumplimiento
router.post('/assignments/:id/status', requireLogin, (req, res) => {
  const a = loadAssignment(req.params.id);
  if (!a) return forbidden(res);
  const u = req.user;
  const action = req.body.action;
  const employerAllowed = u.role === 'employer' && a.company_id === u.company_id && ['excusar', 'nota'].includes(action);
  if (!isStaff(u) && !employerAllowed) return forbidden(res);
  const now = new Date().toISOString();
  const note = req.body.note ? `[${res.locals.fmt(now)} ${u.name}] ${req.body.note}` : null;
  switch (action) {
    case 'presente': // asistencia verificada manualmente (lista de asistencia presencial, registro de Zoom)
      db.prepare(`UPDATE assignments SET checked_in_at = COALESCE(checked_in_at, ?), confirmed_at = COALESCE(confirmed_at, ?),
        status = CASE WHEN EXISTS (SELECT 1 FROM progress_reports WHERE assignment_id = assignments.id) THEN 'completado'
                      WHEN datetime(?) > datetime(?, '+' || ? || ' minutes') THEN 'pendiente_reporte' ELSE 'en_curso' END WHERE id = ?`)
        .run(now, now, now, a.starts_at, a.duration_min, a.id);
      db.prepare("UPDATE compliance_alerts SET status='resuelta', resolution='Asistencia verificada manualmente', resolved_by=?, resolved_at=? WHERE assignment_id=? AND type IN ('ausencia','sin_confirmar') AND status='abierta'").run(u.id, now, a.id);
      break;
    case 'ausente':
      db.prepare("UPDATE assignments SET status = 'ausente' WHERE id = ?").run(a.id);
      db.prepare("INSERT OR IGNORE INTO compliance_alerts (type, assignment_id, employee_id, company_id, message) VALUES ('ausencia',?,?,?,?)")
        .run(a.id, a.employee_id, a.company_id, `${a.emp_name} no asistió a "${a.title}" (marcado por ${u.name}).`);
      break;
    case 'excusar':
      db.prepare("UPDATE assignments SET status = 'excusado' WHERE id = ?").run(a.id);
      db.prepare("UPDATE compliance_alerts SET status='resuelta', resolution='Ausencia excusada', resolved_by=?, resolved_at=? WHERE assignment_id=? AND status='abierta'").run(u.id, now, a.id);
      break;
    case 'completar': // completar manualmente (p.ej. reporte entregado en papel)
      db.prepare("UPDATE assignments SET status='completado', completed_at=?, checked_in_at=COALESCE(checked_in_at, ?), checked_out_at=COALESCE(checked_out_at, ?) WHERE id=?").run(now, now, now, a.id);
      db.prepare("UPDATE compliance_alerts SET status='resuelta', resolution='Completado manualmente', resolved_by=?, resolved_at=? WHERE assignment_id=? AND status='abierta'").run(u.id, now, a.id);
      break;
    case 'verificar':
      db.prepare('UPDATE assignments SET verified_by = ?, verified_at = ? WHERE id = ?').run(u.id, now, a.id);
      db.prepare('UPDATE progress_reports SET reviewed_by = ?, reviewed_at = ?, review_notes = COALESCE(?, review_notes) WHERE assignment_id = ?').run(u.id, now, req.body.note || null, a.id);
      break;
    case 'reabrir':
      db.prepare("UPDATE assignments SET status = 'asignado', checked_in_at = NULL, checked_out_at = NULL, completed_at = NULL WHERE id = ?").run(a.id);
      db.prepare('DELETE FROM notifications WHERE assignment_id = ? AND kind = ?').run(a.id, 'recordatorio');
      break;
    case 'quitar':
      db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
      break;
    case 'nota':
      break;
    default:
      return forbidden(res);
  }
  if (note && action !== 'quitar') db.prepare("UPDATE assignments SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ?").run(note, a.id);
  audit(u.id, `asignacion_${action}`, 'assignment', a.id, { note: req.body.note });
  req.flash('ok', 'Asignación actualizada.');
  back(req, res, a);
});

module.exports = router;
