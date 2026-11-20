'use strict';
// Motor de cumplimiento: corre cada minuto y automatiza TODAS las comunicaciones.
//  1. Recordatorios antes del entrenamiento (24h, 12h, 1h, 30m, 5m — configurable)
//  2. Alerta si el empleado no ha confirmado asistencia (a admin y luego al patrono)
//  3. Al terminar: sin check-in => AUSENTE + alerta a Portilla Law, patrono y empleado
//  4. Con check-in => solicita progress report, seguimientos y alerta si vence
const { db, numList, getSetting, audit } = require('../db');
const { notifyUser, internalMessage, APP_URL } = require('./notify');
const { makeToken } = require('../util/tokens');
const { fmt, addMin } = require('../util/time');
const zoom = require('./zoom');

const MIN = 60000;

function staffUsers() {
  return db.prepare("SELECT * FROM users WHERE role IN ('admin','staff') AND active = 1").all();
}
function employerUsers(companyId) {
  if (!companyId) return [];
  return db.prepare("SELECT * FROM users WHERE role = 'employer' AND active = 1 AND company_id = ?").all(companyId);
}

function links(a) {
  return {
    confirm: `${APP_URL}/t/${makeToken('confirm', a.id)}`,
    checkin: `${APP_URL}/t/${makeToken('checkin', a.id)}`,
    report: `${APP_URL}/t/${makeToken('report', a.id)}`,
  };
}

function remainingText(ms) {
  const m = Math.round(ms / MIN);
  if (m >= 90) return `${Math.round(m / 60)} horas`;
  if (m >= 55) return '1 hora';
  return `${Math.max(m, 1)} minutos`;
}

function openAlert(type, a, message) {
  const r = db.prepare(`INSERT OR IGNORE INTO compliance_alerts (type, assignment_id, employee_id, company_id, message)
    VALUES (?,?,?,?,?)`).run(type, a.id, a.employee_id, a.company_id, message);
  return r.changes > 0;
}

async function notifyStaff(subject, body, a, key) {
  for (const s of staffUsers()) {
    await internalMessage({ recipient: s, subject, body, kind: 'alerta', assignmentId: a.id, dedupeKey: key, alsoEmail: true });
  }
}
async function notifyEmployers(subject, body, a, key, sms = false) {
  for (const e of employerUsers(a.company_id)) {
    await internalMessage({ recipient: e, subject, body, kind: 'alerta', assignmentId: a.id, dedupeKey: key, alsoEmail: true, alsoSms: sms });
  }
}

function activeAssignments() {
  return db.prepare(`
    SELECT a.*, t.title, t.modality, t.starts_at, t.due_at, t.duration_min, t.location, t.meeting_url, t.zoom_meeting_id, t.hours_credit,
           (SELECT pct FROM video_progress vp WHERE vp.assignment_id = a.id) AS video_pct,
           u.name AS emp_name, u.company_id, u.email, u.phone, u.notify_email, u.notify_sms, u.active AS emp_active
    FROM assignments a
    JOIN trainings t ON t.id = a.training_id
    JOIN users u ON u.id = a.employee_id
    WHERE t.cancelled = 0 AND u.active = 1
      AND a.status IN ('asignado','confirmado','en_curso','pendiente_reporte')`).all();
}

function empOf(a) {
  return { id: a.employee_id, name: a.emp_name, email: a.email, phone: a.phone, notify_email: a.notify_email,
    notify_sms: a.notify_sms, active: a.emp_active, company_id: a.company_id };
}

const isVideo = (a) => a.modality === 'video';
/** Fin del entrenamiento: para videos, la fecha límite; para sesiones, inicio + duración. */
function endOf(a) {
  return isVideo(a) && a.due_at ? new Date(a.due_at).getTime() : new Date(a.starts_at).getTime() + a.duration_min * MIN;
}
/** Momento al que apuntan los recordatorios: inicio de la sesión, o fecha límite del video. */
function anchorOf(a) { return isVideo(a) ? endOf(a) : new Date(a.starts_at).getTime(); }
const watchUrl = (a) => `${APP_URL}/assignments/${a.id}/watch`;

function whereText(a) {
  if (a.modality === 'presencial') return `Lugar: ${a.location || 'por confirmar'}`;
  if (a.modality === 'zoom') return `Zoom: ${a.meeting_url || 'enlace por enviar'}`;
  return `Video en el portal: ${watchUrl(a)}`;
}

async function processReminders(a, now) {
  if (isVideo(a)) return processVideoReminders(a, now);
  const start = new Date(a.starts_at).getTime();
  if (now >= start || !['asignado', 'confirmado'].includes(a.status)) return;
  const offsets = numList('reminder_offsets_min').sort((x, y) => x - y);
  // El recordatorio "vigente" es el offset más pequeño cuya hora ya pasó.
  const due = offsets.filter((off) => now >= start - off * MIN);
  if (!due.length) return;
  const off = due[0];
  const l = links(a);
  const left = remainingText(start - now);
  const confirmed = a.status === 'confirmado';
  const subject = `Recordatorio: "${a.title}" comienza en ${left}`;
  const text = `Hola ${a.emp_name},\n\nTu entrenamiento "${a.title}" (${a.modality}) comienza en ${left} — ${fmt(a.starts_at)}.\n${whereText(a)}\n\n` +
    (confirmed ? 'Ya confirmaste tu asistencia. Recuerda hacer CHECK-IN al comenzar.' : 'IMPORTANTE: aún no has confirmado tu asistencia. Confírmala ahora.');
  const actions = confirmed
    ? [{ label: 'Hacer check-in', url: l.checkin, color: '#1b7f4b' }]
    : [{ label: 'Confirmar asistencia', url: l.confirm, color: '#1b7f4b' }];
  if (a.meeting_url && a.modality !== 'presencial') actions.push({ label: a.modality === 'zoom' ? 'Entrar a Zoom' : 'Ver video', url: a.meeting_url });
  const sms = confirmed
    ? `Portilla Law: "${a.title}" comienza en ${left}. Haz check-in aqui:`
    : `Portilla Law: "${a.title}" comienza en ${left}. Responde SI o confirma aqui:`;
  await notifyUser(empOf(a), { kind: 'recordatorio', subject, text, sms, actions, assignmentId: a.id, dedupeKey: `rem:${a.id}:${off}` });
}

/** Videos: recordar la fecha límite mientras no lo haya completado. */
async function processVideoReminders(a, now) {
  const due = endOf(a);
  if (now >= due || now < new Date(a.starts_at).getTime() || !['asignado', 'confirmado', 'en_curso'].includes(a.status)) return;
  const offsets = numList('reminder_offsets_min').sort((x, y) => x - y);
  const dueOffsets = offsets.filter((off) => now >= due - off * MIN);
  if (!dueOffsets.length) return;
  const off = dueOffsets[0];
  const left = remainingText(due - now);
  const pct = a.video_pct || 0;
  const subject = `Recordatorio: te quedan ${left} para completar "${a.title}"`;
  const text = `Hola ${a.emp_name},\n\nTienes hasta el ${fmt(new Date(due).toISOString())} para ver el video "${a.title}" en el portal.\n` +
    (pct > 0 ? `Llevas ${pct}% visto. Debes ver al menos ${getSetting('video_min_pct')}% para que cuente.` : 'Aún no lo has comenzado.') +
    '\n\nAl terminar, completa tu progress report.';
  await notifyUser(empOf(a), {
    kind: 'recordatorio', subject, text,
    sms: `Portilla Law: te quedan ${left} para ver "${a.title}"${pct ? ` (llevas ${pct}%)` : ''}. Velo aqui:`,
    actions: [{ label: pct > 0 ? 'Continuar el video' : 'Ver el video', url: watchUrl(a), color: '#1b7f4b' }],
    assignmentId: a.id, dedupeKey: `rem:${a.id}:${off}`,
  });
}

async function processUnconfirmed(a, now) {
  if (isVideo(a)) {
    if (a.checked_in_at || !['asignado', 'confirmado'].includes(a.status) || now < new Date(a.starts_at).getTime()) return;
  } else if (a.status !== 'asignado') return;
  const start = anchorOf(a);
  if (now >= start) return;
  const created = new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime();
  if (now - created < 60 * MIN) return; // dar al menos 1 hora para responder
  const alertMin = Number(getSetting('unconfirmed_alert_min'));
  const employerMin = Number(getSetting('unconfirmed_employer_min'));
  if (now >= start - alertMin * MIN) {
    const what = isVideo(a)
      ? `${a.emp_name} no ha comenzado el video "${a.title}" (fecha límite ${fmt(new Date(start).toISOString())}).`
      : `${a.emp_name} no ha confirmado asistencia a "${a.title}" (${fmt(a.starts_at)}).`;
    if (openAlert('sin_confirmar', a, what)) {
      await notifyStaff(`${isVideo(a) ? 'Video sin comenzar' : 'Sin confirmar'}: ${a.emp_name}`, `${what}\nComunícate con el empleado para asegurar el cumplimiento.`, a, `unc:${a.id}`);
    }
  }
  if (now >= start - employerMin * MIN) {
    const what = isVideo(a)
      ? `Su empleado(a) ${a.emp_name} aún no ha comenzado el video de adiestramiento "${a.title}", cuya fecha límite es ${fmt(new Date(start).toISOString())}.`
      : `Su empleado(a) ${a.emp_name} aún no ha confirmado su asistencia al entrenamiento "${a.title}" (${fmt(a.starts_at)}).`;
    await notifyEmployers(`Empleado ${isVideo(a) ? 'sin comenzar video' : 'sin confirmar'}: ${a.emp_name}`,
      `${what}\nLe agradecemos recordarle la importancia de completarlo para mantener el cumplimiento del programa.`, a, `unc-emp:${a.id}`);
  }
}

async function processEnded(a, now) {
  const end = endOf(a);
  const grace = Number(getSetting('absence_grace_min')) * MIN;
  if (!['asignado', 'confirmado', 'en_curso'].includes(a.status) || now < end + grace) return;
  // Zoom: esperar el reporte de participantes antes de declarar una ausencia
  if (a.modality === 'zoom' && !a.checked_in_at && zoom.configured() && zoom.meetingIdFrom(a) &&
      now < end + Number(getSetting('zoom_report_wait_min')) * MIN) return;

  if (a.checked_in_at && !isVideo(a)) {
    const hasReport = db.prepare('SELECT 1 FROM progress_reports WHERE assignment_id = ?').get(a.id);
    const newStatus = hasReport ? 'completado' : 'pendiente_reporte';
    db.prepare(`UPDATE assignments SET status = ?, checked_out_at = COALESCE(checked_out_at, ?), completed_at = CASE WHEN ? = 'completado' THEN ? ELSE completed_at END WHERE id = ?`)
      .run(newStatus, new Date(end).toISOString(), newStatus, new Date(now).toISOString(), a.id);
    a.status = newStatus;
    return;
  }
  // Sin check-in (o video sin completar a la fecha límite): ausencia
  db.prepare("UPDATE assignments SET status = 'ausente' WHERE id = ?").run(a.id);
  db.prepare("UPDATE compliance_alerts SET status = 'resuelta', resolution = 'Reemplazada por alerta de ausencia', resolved_at = ? WHERE assignment_id = ? AND type = 'sin_confirmar' AND status = 'abierta'")
    .run(new Date(now).toISOString(), a.id);
  audit(null, 'marcar_ausente_auto', 'assignment', a.id, { training: a.title });
  a.status = 'ausente';
  const missed = isVideo(a)
    ? `${a.emp_name} no completó el video "${a.title}" antes de la fecha límite (${a.video_pct || 0}% visto).`
    : `${a.emp_name} no asistió a "${a.title}" (${fmt(a.starts_at)}).`;
  if (openAlert('ausencia', a, missed)) {
    const body = `${isVideo(a) ? missed : `${a.emp_name} NO registró asistencia al entrenamiento "${a.title}" del ${fmt(a.starts_at)}.`}\nEl empleado queda FUERA DE CUMPLIMIENTO hasta que se reprograme o se excuse la ausencia.`;
    await notifyStaff(`AUSENCIA: ${a.emp_name} — ${a.title}`, body, a, `abs:${a.id}`);
    await notifyEmployers(`Ausencia de empleado: ${a.emp_name}`, body, a, `abs-emp:${a.id}`, true);
    await notifyUser(empOf(a), {
      kind: 'ausencia', subject: isVideo(a) ? `No completaste el video "${a.title}"` : `No registramos tu asistencia a "${a.title}"`,
      text: `Hola ${a.emp_name},\n\n${isVideo(a) ? `No completaste el video "${a.title}" antes de la fecha límite (${a.video_pct || 0}% visto).` : `No registramos tu asistencia al entrenamiento "${a.title}" del ${fmt(a.starts_at)}.`} Esto afecta tu cumplimiento con el Programa de Aprendizaje.\nSi asististe o tuviste una situación, comunícate con Portilla Law hoy mismo respondiendo en la plataforma.`,
      sms: `Portilla Law: no registramos tu asistencia a "${a.title}". Comunicate con nosotros hoy.`,
      actions: [{ label: 'Escribir a Portilla Law', url: `${APP_URL}/messages/new` }], assignmentId: a.id, dedupeKey: `abs-ee:${a.id}`,
    });
  }
}

async function processReports(a, now) {
  if (a.status !== 'pendiente_reporte') return;
  // Los seguimientos cuentan desde que terminó (al completar un video, puede ser antes de la fecha límite)
  const end = a.checked_out_at ? Math.min(new Date(a.checked_out_at).getTime(), endOf(a)) : endOf(a);
  const l = links(a);
  const steps = [0, ...numList('report_followup_hours')];
  const due = steps.filter((h) => now >= end + h * 3600000);
  if (due.length) {
    const h = due[due.length - 1];
    await notifyUser(empOf(a), {
      kind: 'solicitud_reporte',
      subject: h === 0 ? `Completa tu progress report: "${a.title}"` : `Seguimiento: tu progress report de "${a.title}" está pendiente`,
      text: `Hola ${a.emp_name},\n\nGracias por participar en "${a.title}". Para que el entrenamiento cuente para tu certificación debes completar tu progress report (toma 2 minutos).`,
      sms: `Portilla Law: completa tu progress report de "${a.title}" para que cuente tu entrenamiento:`,
      actions: [{ label: 'Completar progress report', url: l.report, color: '#1b7f4b' }],
      assignmentId: a.id, dedupeKey: `rep:${a.id}:${h}`,
    });
  }
  const overdue = Number(getSetting('report_overdue_hours'));
  if (now >= end + overdue * 3600000 &&
      openAlert('sin_reporte', a, `${a.emp_name} no ha sometido el progress report de "${a.title}".`)) {
    const body = `${a.emp_name} asistió a "${a.title}" (${fmt(a.starts_at)}) pero NO ha sometido su progress report luego de ${overdue} horas.`;
    await notifyStaff(`Progress report vencido: ${a.emp_name}`, body, a, `repod:${a.id}`);
    await notifyEmployers(`Progress report pendiente: ${a.emp_name}`, body, a, `repod-emp:${a.id}`);
  }
}

let running = false;
async function tick(nowDate = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const now = new Date(nowDate).getTime();
  let processed = 0;
  try {
    try { await zoom.syncPending(now); } catch (e) { console.error('[zoom]', e); }
    for (const a of activeAssignments()) {
      try {
        await processEnded(a, now);
        await processReminders(a, now);
        await processUnconfirmed(a, now);
        await processReports(a, now);
        processed++;
      } catch (e) {
        console.error(`[cumplimiento] error en asignación ${a.id}:`, e);
      }
    }
  } finally { running = false; }
  return { processed };
}

/** Acciones del empleado (desde la plataforma, enlace firmado o SMS). */
function confirmAssignment(id, via) {
  const r = db.prepare(`UPDATE assignments SET status = 'confirmado', confirmed_at = ?, confirmed_via = ?
    WHERE id = ? AND status = 'asignado'`).run(new Date().toISOString(), via, id);
  if (r.changes) {
    db.prepare("UPDATE compliance_alerts SET status = 'resuelta', resolution = 'El empleado confirmó', resolved_at = ? WHERE assignment_id = ? AND type = 'sin_confirmar' AND status = 'abierta'")
      .run(new Date().toISOString(), id);
  }
  return r.changes > 0;
}

function checkInWindow(t, now = Date.now()) {
  if (isVideo(t)) {
    const open = new Date(t.starts_at).getTime(), close = endOf(t);
    return { open, close, isOpen: now >= open && now <= close };
  }
  const open = new Date(t.starts_at).getTime() - Number(getSetting('checkin_open_min')) * MIN;
  const close = new Date(t.starts_at).getTime() + t.duration_min * MIN;
  return { open, close, isOpen: now >= open && now <= close };
}

function checkIn(id, now = Date.now()) {
  const a = db.prepare('SELECT a.*, t.starts_at, t.due_at, t.modality, t.duration_min FROM assignments a JOIN trainings t ON t.id = a.training_id WHERE a.id = ?').get(id);
  if (!a) return { ok: false, error: 'Asignación no encontrada' };
  if (isVideo(a)) return { ok: false, error: 'En los entrenamientos en video la asistencia se registra automáticamente al ver el video en el portal.' };
  if (a.checked_in_at) return { ok: true, already: true };
  if (!['asignado', 'confirmado'].includes(a.status)) return { ok: false, error: 'Esta asignación ya no admite check-in.' };
  const w = checkInWindow(a, now);
  if (!w.isOpen) return { ok: false, error: `El check-in está disponible desde ${fmt(new Date(w.open).toISOString())} hasta ${fmt(new Date(w.close).toISOString())}.` };
  db.prepare(`UPDATE assignments SET status = 'en_curso', checked_in_at = ?, confirmed_at = COALESCE(confirmed_at, ?), confirmed_via = COALESCE(confirmed_via, 'check-in'), attendance_source = COALESCE(attendance_source, 'check-in') WHERE id = ?`)
    .run(new Date(now).toISOString(), new Date(now).toISOString(), id);
  db.prepare("UPDATE compliance_alerts SET status = 'resuelta', resolution = 'El empleado hizo check-in', resolved_at = ? WHERE assignment_id = ? AND type = 'sin_confirmar' AND status = 'abierta'")
    .run(new Date(now).toISOString(), id);
  return { ok: true };
}

function submitReport(assignmentId, employeeId, data) {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND employee_id = ?').get(assignmentId, employeeId);
  if (!a) return { ok: false, error: 'Asignación no encontrada' };
  if (!a.checked_in_at) return { ok: false, error: 'No hay check-in registrado para este entrenamiento. Comunícate con Portilla Law.' };
  if (db.prepare('SELECT 1 FROM progress_reports WHERE assignment_id = ?').get(assignmentId)) return { ok: false, error: 'Ya sometiste el progress report de este entrenamiento.' };
  if (!data.summary || data.summary.trim().length < 20) return { ok: false, error: 'Describe lo aprendido (mínimo 20 caracteres).' };
  const nowIso = new Date().toISOString();
  db.prepare(`INSERT INTO progress_reports (assignment_id, employee_id, attended_full, summary, applied_how, questions, rating, hours_reported)
    VALUES (?,?,?,?,?,?,?,?)`).run(assignmentId, employeeId, data.attended_full ? 1 : 0, data.summary.trim(), data.applied_how || null,
    data.questions || null, data.rating ? Number(data.rating) : null, data.hours_reported ? Number(data.hours_reported) : null);
  db.prepare(`UPDATE assignments SET status = CASE WHEN status IN ('en_curso','pendiente_reporte') THEN 'completado' ELSE status END,
    checked_out_at = COALESCE(checked_out_at, ?), completed_at = CASE WHEN status IN ('en_curso','pendiente_reporte') THEN ? ELSE completed_at END WHERE id = ?`)
    .run(nowIso, nowIso, assignmentId);
  db.prepare("UPDATE compliance_alerts SET status = 'resuelta', resolution = 'Progress report sometido', resolved_at = ? WHERE assignment_id = ? AND type = 'sin_reporte' AND status = 'abierta'")
    .run(nowIso, assignmentId);
  return { ok: true };
}

/** Notificación inmediata al asignar un entrenamiento. */
async function notifyAssigned(assignmentId) {
  const a = db.prepare(`SELECT a.*, t.title, t.modality, t.starts_at, t.due_at, t.duration_min, t.location, t.meeting_url,
      u.name AS emp_name, u.company_id, u.email, u.phone, u.notify_email, u.notify_sms, u.active AS emp_active
    FROM assignments a JOIN trainings t ON t.id = a.training_id JOIN users u ON u.id = a.employee_id WHERE a.id = ?`).get(assignmentId);
  if (!a) return;
  if (isVideo(a)) {
    const due = fmt(new Date(endOf(a)).toISOString());
    return notifyUser(empOf(a), {
      kind: 'asignacion', subject: `Nuevo video de adiestramiento: "${a.title}"`,
      text: `Hola ${a.emp_name},\n\nSe te asignó el video de adiestramiento "${a.title}" (${a.duration_min} min). Puedes verlo en el portal desde el ${fmt(a.starts_at)} hasta el ${due}.\n\nDebes ver al menos ${getSetting('video_min_pct')}% del video (adelantarlo no cuenta) y luego completar tu progress report. Recibirás recordatorios antes de la fecha límite.`,
      sms: `Portilla Law: tienes un video de adiestramiento "${a.title}" para ver antes del ${due}:`,
      actions: [{ label: 'Ver el video', url: watchUrl(a), color: '#1b7f4b' }],
      assignmentId: a.id, dedupeKey: `asg:${a.id}`,
    });
  }
  await notifyUser(empOf(a), {
    kind: 'asignacion', subject: `Nuevo entrenamiento asignado: "${a.title}"`,
    text: `Hola ${a.emp_name},\n\nSe te asignó el entrenamiento "${a.title}" (${a.modality}) para el ${fmt(a.starts_at)}.\n${whereText(a)}\n\nPor favor confirma tu asistencia. Recibirás recordatorios 24 horas, 12 horas, 1 hora, 30 minutos y 5 minutos antes.`,
    sms: `Portilla Law: se te asigno "${a.title}" el ${fmt(a.starts_at)}. Responde SI o confirma aqui:`,
    actions: [{ label: 'Confirmar asistencia', url: links(a).confirm, color: '#1b7f4b' }],
    assignmentId: a.id, dedupeKey: `asg:${a.id}`,
  });
}

module.exports = { tick, confirmAssignment, checkIn, checkInWindow, submitReport, notifyAssigned, links, staffUsers, employerUsers, addMin, endOf };
