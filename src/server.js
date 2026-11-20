'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Carga simple de .env (sin dependencias)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (process.env.NODE_ENV === 'production' && !process.env.APP_SECRET) {
  console.error('APP_SECRET es requerido en producción.');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const { getSetting } = require('./db');
const auth = require('./auth');
const time = require('./util/time');
const { STATUS_LABELS, MODALITY_LABELS } = require('./services/progress');
const compliance = require('./services/compliance');
const reports = require('./services/reports');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.use(session({
  store: new auth.SqliteStore(),
  secret: process.env.APP_SECRET || 'dev-secret-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  name: 'pl.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 3600000 },
}));
app.use(auth.sameOrigin);
app.use(auth.loadUser);
app.use((req, res, next) => {
  Object.assign(res.locals, { fmt: time.fmt, fmtDate: time.fmtDate, isoToLocalInput: time.isoToLocalInput, STATUS_LABELS, MODALITY_LABELS,
    path: req.path, orgName: getSetting('org_name'), flash: req.session.flash || null, title: '' });
  delete req.session.flash;
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
});

app.use(require('./routes/public'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/companies'));
app.use(require('./routes/people'));
app.use(require('./routes/trainings'));
app.use(require('./routes/messages'));
app.use(require('./routes/alerts'));
app.use(require('./routes/reports'));
app.use(require('./routes/expenses'));
app.use(require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La página solicitada no existe.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Ocurrió un error inesperado. Intente nuevamente.' });
});

function startJobs() {
  // Motor de cumplimiento: cada minuto
  cron.schedule('* * * * *', () => compliance.tick().catch((e) => console.error('[cumplimiento]', e)));
  // Reporte semanal al cliente
  cron.schedule(getSetting('weekly_report_cron'), () => reports.sendAllWeeklyReports()
    .then((n) => console.log(`[reporte semanal] enviado a ${n} patronos`)).catch((e) => console.error('[reporte semanal]', e)),
  { timezone: time.TZ });
}

if (require.main === module) {
  require('./bootstrap').ensureAdmin();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`Portilla Law · Cumplimiento escuchando en http://localhost:${port}`);
    if (process.env.DISABLE_JOBS !== 'true') startJobs();
  });
}

module.exports = app;
