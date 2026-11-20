# Poner el portal en funcionamiento

Guía para publicar la plataforma en **https://portal.portillalaw.com** y conectar email y SMS.

---

## Paso 1 — Publicar en Render (≈ 15 minutos)

1. Cree una cuenta en **https://render.com**: "Get Started" → entrar con GitHub.
2. Autorice a Render a ver el repositorio `gcode-revenue/Portillalaw-Compliance`.
3. En Render: **New → Blueprint** → elija `Portillalaw-Compliance`. Render lee el archivo `render.yaml` y prepara todo solo.
4. Le pedirá los valores marcados como secretos. Para empezar sólo son obligatorios estos tres:

   | Variable | Qué poner |
   |---|---|
   | `ADMIN_EMAIL` | Su correo de entrada como presidente |
   | `ADMIN_PASSWORD` | Una contraseña segura (mín. 8 caracteres) |
   | `ADMIN_PHONE` | Su celular, para recibir alertas por SMS |

   Los de email (`SMTP_*`) y SMS (`TWILIO_*`) pueden quedar vacíos por ahora (ver pasos 3 y 4).
5. Presione **Apply**. En 2–4 minutos el portal estará en `https://portilla-portal.onrender.com`. Entre con su correo y contraseña.

**Costo aproximado:** plan Starter ≈ $7/mes + disco de 1 GB ≈ $0.25/mes. El disco guarda la base de datos de forma permanente.

---

## Paso 2 — Usar `portal.portillalaw.com` (≈ 10 minutos + propagación)

1. En Render → servicio `portilla-portal` → **Settings → Custom Domains → Add** → `portal.portillalaw.com`.
2. En el lugar donde está registrado el dominio portillalaw.com (GoDaddy, Namecheap, Cloudflare, etc.) añada **un** registro:

   | Tipo | Nombre / Host | Valor |
   |---|---|---|
   | `CNAME` | `portal` | `portilla-portal.onrender.com` |

   No toque los registros `A` del sitio web ni los `MX` del correo.
3. Cuando Render muestre el dominio como verificado (de minutos a pocas horas), el certificado HTTPS se emite automáticamente.
4. En el sitio web (`Portillalaw-website`, archivo `portal/index.html`) cambiar:
   ```js
   var PORTAL_URL = "https://portal.portillalaw.com/login";
   ```
   Desde ese momento los botones "Portal clientes" e "Iniciar sesión" de portillalaw.com llevan al portal.

---

## Paso 3 — Conectar el email (recordatorios, alertas, reportes semanales)

Recomendación: crear un buzón dedicado, por ejemplo **cumplimiento@portillalaw.com**, para que los envíos automáticos no salgan de un correo personal.

En Render → `portilla-portal` → **Environment**, complete según su proveedor de correo:

**Microsoft 365 / Outlook**

| Variable | Valor |
|---|---|
| `SMTP_HOST` | `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `cumplimiento@portillalaw.com` |
| `SMTP_PASS` | contraseña del buzón |
| `MAIL_FROM` | `Portilla Law Cumplimiento <cumplimiento@portillalaw.com>` |

> En el centro de administración de Microsoft 365 hay que habilitar **"Authenticated SMTP"** para ese buzón (Usuarios → buzón → Correo → Administrar aplicaciones de correo electrónico).

**Google Workspace**

| Variable | Valor |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `cumplimiento@portillalaw.com` |
| `SMTP_PASS` | una **contraseña de aplicación** (Cuenta de Google → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones) |

Guarde. Render reinicia el servicio solo. Luego, en el portal: **Configuración → "Enviarme un email y SMS de prueba"**.

---

## Paso 4 — Conectar SMS con Twilio

1. Cree una cuenta en **https://www.twilio.com** y compre un número local (787 o 939). Cuesta aprox. $1.15/mes; cada SMS aprox. $0.01 más cargos de operadora.
2. **Registro A2P 10DLC (obligatorio en EE.UU./PR):** en Twilio → Messaging → Regulatory Compliance, registre la marca (Portilla Law Firm) y una campaña de tipo *"Account Notifications"*. Twilio tarda de días a 2–3 semanas en aprobarla. Sin este registro las operadoras bloquean los SMS.
3. En Render → Environment:

   | Variable | Valor |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | Account SID (página principal de Twilio) |
   | `TWILIO_AUTH_TOKEN` | Auth Token |
   | `TWILIO_FROM` | el número comprado, formato `+17875551234` |

4. Para que los empleados puedan **responder "SI"** y confirmar asistencia: Twilio → Phone Numbers → su número → *A message comes in* → Webhook **POST** a:
   ```
   https://portal.portillalaw.com/webhooks/twilio
   ```
5. Pruebe con **Configuración → "Enviarme un email y SMS de prueba"**.

---

## Paso 5 — Cargar su información real

Dentro del portal, como presidente:

1. **Usuarios → + Personal Portilla Law**: su equipo. Marque 🔒 *Gastos* sólo para quien usted designe.
2. **Compañías → + Nueva compañía** por cada cliente, y luego **+ Patrono** (el dueño o la persona de recursos humanos).
3. **+ Empleado** para cada aprendiz, con su celular y su meta de horas. Cada uno recibe su acceso por email.
4. **Entrenamientos → + Nuevo** (video, presencial o Zoom) → **Asignar y notificar**. Desde ese momento los recordatorios, alertas y reportes semanales funcionan solos.

---

## Mantenimiento

- **Respaldos:** Render → `portilla-portal` → Disks → Snapshots (Render guarda copias diarias del disco).
- **Actualizaciones:** cada cambio subido a la rama configurada en `render.yaml` se publica automáticamente.
- **Bitácora:** el menú *Comunicaciones* muestra cada email y SMS enviado, con su estado (`enviado`, `fallido`, `simulado`). `simulado` significa que todavía falta conectar ese canal.
