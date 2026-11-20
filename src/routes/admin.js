'use strict';
const express = require('express');
const { db, getSetting, setSetting, audit, DEFAULT_SETTINGS } = require('../db');
const { requireRole, requireStaff } = require('../auth');
const { channelsStatus, notifyUser } = require('../services/notify');
const zoom = require('../services/zoom');
const compliance = require('../services/compliance');

const router = express.Router();

// Bitácora de comunicaciones (todo email / SMS / mensaje automatizado)
router.get('/communications', requireStaff, (req, res) => {
  const kind = req.query.kind || '';
  const list = db.prepare(`SELECT n.*, u.name user_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id
    ${kind ? 'WHERE n.kind = ?' : ''} ORDER BY n.id DESC LIMIT 300`).all(...(kind ? [kind] : []));
  const kinds = db.prepare('SELECT DISTINCT kind FROM notifications ORDER BY kind').all().map((r) => r.kind);
  res.render('communications', { title: 'Bitácora de comunicaciones', list, kinds, kind, channels: channelsStatus() });
});

router.get('/audit', requireRole('admin'), (req, res) => {
  const list = db.prepare('SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300').all();
  res.render('audit', { title: 'Registro de auditoría', list });
});

const EDITABLE = {
  reminder_offsets_min: 'Recordatorios antes del entrenamiento (minutos, separados por coma)',
  checkin_open_min: 'El check-in abre X minutos antes',
  absence_grace_min: 'Minutos de gracia tras finalizar antes de marcar AUSENTE',
  report_followup_hours: 'Seguimientos del progress report (horas tras finalizar)',
  report_overdue_hours: 'Alerta de progress report vencido (horas)',
  unconfirmed_alert_min: 'Alerta a Portilla Law si no confirmó (minutos antes)',
  unconfirmed_employer_min: 'Aviso al patrono si no confirmó (minutos antes)',
  weekly_report_cron: 'Horario del reporte semanal (cron, hora PR; requiere reinicio)',
  org_name: 'Nombre de la organización',
  video_min_pct: 'Videos: % mínimo que debe verse para completarlo',
  video_presence_check_min: 'Videos: preguntar "¿Sigues ahí?" cada X minutos (0 = nunca)',
  zoom_min_attendance_pct: 'Zoom: % de la sesión conectado para contar asistencia',
  zoom_report_wait_min: 'Zoom: minutos de espera por el reporte antes de marcar ausente',
};

router.get('/settings', requireRole('admin'), (req, res) => {
  const values = Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, getSetting(k)]));
  res.render('settings', { title: 'Configuración de automatizaciones', values, EDITABLE, DEFAULT_SETTINGS, channels: { ...channelsStatus(), zoom: zoom.configured() ? 'Zoom conectado' : 'No conectado' } });
});

router.post('/settings', requireRole('admin'), (req, res) => {
  for (const k of Object.keys(EDITABLE)) if (req.body[k] !== undefined) setSetting(k, String(req.body[k]).trim());
  audit(req.user.id, 'editar_configuracion', 'settings', null, req.body);
  req.flash('ok', 'Configuración guardada.');
  res.redirect('/settings');
});

router.post('/settings/run-now', requireStaff, async (req, res) => {
  const r = await compliance.tick();
  req.flash('ok', `Motor de cumplimiento ejecutado (${r.processed ?? 0} asignaciones revisadas).`);
  res.redirect(req.get('referer') || '/');
});

// Prueba de conexiones: envía un email y un SMS de prueba al usuario actual
router.post('/settings/test-notify', requireRole('admin'), async (req, res) => {
  const r = await notifyUser({ ...req.user, notify_email: 1, notify_sms: 1, active: 1 }, {
    kind: 'prueba', subject: 'Prueba de conexión — Portal Portilla Law',
    text: 'Si recibe este mensaje, el envío automático de recordatorios está funcionando.',
    sms: 'Portilla Law: prueba de SMS del portal de cumplimiento. Funciona correctamente.',
  });
  const txt = r.map((x) => `${x.channel.toUpperCase()}: ${x.status}${x.error ? ' (' + x.error + ')' : ''}`).join(' · ') || 'Sin canales (añada su teléfono en Mi cuenta para probar SMS).';
  req.flash(r.some((x) => x.status === 'fallido') ? 'error' : 'ok', `Prueba enviada a ${req.user.email} / ${req.user.phone || 'sin teléfono'} → ${txt}`);
  res.redirect('/settings');
});

module.exports = router;
