# Portilla Law · Plataforma de Cumplimiento

Plataforma interna para gestionar el ciclo completo del **Programa de Aprendizaje Registrado (Apprenticeship)** distribuido mediante Conexión Laboral en Puerto Rico: propuesta → planificación → adiestramiento (video, presencial, Zoom) → cumplimiento → certificación → facturación.

## Accesos por rol

| Función | Presidente (admin) | Personal Portilla Law | Patrono (cliente) | Empleado |
|---|:-:|:-:|:-:|:-:|
| Ver progreso y cumplimiento | Todas las compañías | Todas las compañías | Su compañía | Su propio progreso |
| Crear/editar compañías y entrenamientos, asignar empleados | ✔ | ✔ | — | — |
| Añadir empleados | ✔ | ✔ | ✔ (los suyos) | — |
| Mensajes (individual y masivo, + email/SMS) | ✔ | ✔ | Portilla Law y sus empleados | Portilla Law y su patrono |
| Marcar asistencia, verificar reportes | ✔ | ✔ | Excusar / notas | — |
| Alertas de cumplimiento | ✔ | ✔ | Su compañía | — |
| Reporte semanal | ✔ | ✔ | Su compañía | — |
| **Gastos 🔒** | ✔ | Sólo si el presidente lo designa | **Nunca** | **Nunca** |
| Configuración de automatizaciones, auditoría | ✔ | — | — | — |

## Automatización de cumplimiento (motor que corre cada minuto)

1. **Asignación** → email + SMS con enlace de confirmación de un clic (o responder **SI** al SMS).
2. **Recordatorios** 24 h, 12 h, 1 h, 30 min y 5 min antes (configurable). Si el empleado no ha confirmado, el recordatorio lo exige.
3. **Sin confirmar** a 24 h → alerta a Portilla Law; a 12 h → aviso al patrono.
4. **Check-in** (plataforma o enlace) desde 15 min antes. El personal también puede marcar asistencia verificada (lista presencial / registro de Zoom).
5. **Al terminar sin check-in → AUSENTE**: alerta y aviso inmediato a Portilla Law, patrono (email + SMS) y empleado.
6. **Con check-in → progress report** obligatorio, con seguimientos a las 24 y 48 h; a las 72 h alerta a Portilla Law y al patrono.
7. **Checklist de redundancia** por entrenamiento: confirmó → check-in → finalizó → progress report → verificado por Portilla Law.
8. **Gauge de progreso**: horas completadas / máximo(horas asignadas, meta del empleado).
9. **Reporte semanal** a cada patrono todos los lunes 8:00 AM (hora PR), también imprimible/PDF y enviable a demanda.
10. **Bitácora de comunicaciones** y **registro de auditoría**: constancia de cada mensaje y acción para fines de cumplimiento y facturación.

Sin credenciales SMTP/Twilio los envíos quedan como *simulado* en la bitácora, así que todo funciona en desarrollo.

## Ejecutar

Requiere Node.js 22.13+ (usa SQLite integrado; sin servidor de base de datos).

```bash
npm install
cp .env.example .env      # completar SMTP / Twilio para envíos reales
npm run seed              # datos de demostración (contraseña: Portilla2026!)
npm start                 # http://localhost:3000
npm test
```

Usuarios de demostración: `admin@portillalaw.com` (presidente), `staff@portillalaw.com`, `finanzas@portillalaw.com` (personal con acceso a gastos), `patrono@constructoracaribe.com`, `empleado@demo.com`.

## Estructura

```
src/server.js              app Express + tareas programadas (node-cron)
src/db.js                  esquema SQLite y configuración
src/auth.js                sesiones, roles y permisos
src/services/compliance.js motor de recordatorios, ausencias y reportes
src/services/notify.js     email (SMTP) / SMS (Twilio) + bitácora
src/services/progress.js   cálculo de progreso y cumplimiento
src/services/reports.js    reporte semanal al patrono
src/routes/                pantallas por módulo
views/                     plantillas EJS (español)
```

## Producción

- Definir `APP_SECRET`, `APP_URL`, `COOKIE_SECURE=true` y servir detrás de HTTPS.
- Una sola instancia del proceso (el motor de cumplimiento corre dentro de la app).
- Respaldar `data/portilla.db` diariamente.
