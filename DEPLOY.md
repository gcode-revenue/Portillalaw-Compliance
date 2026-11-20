# Poner el portal en funcionamiento

Guía para publicar la plataforma en **https://portal.portillalaw.com** y conectar email (Microsoft 365), SMS (Heymarket), WhatsApp y Zoom.

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

   Los de email (`MS_*`), SMS (`HEYMARKET_*`), WhatsApp (`WHATSAPP_*`) y Zoom pueden quedar vacíos por ahora (ver pasos siguientes). Mientras estén vacíos, el portal funciona y registra esos envíos como "simulado".
5. Presione **Apply**. En 2–4 minutos el portal estará en `https://portilla-portal.onrender.com`. Entre con su correo y contraseña.

**Costo aproximado:** plan Starter ≈ $7/mes + disco de 1 GB ≈ $0.25/mes. El disco guarda la base de datos de forma permanente.

---

## Paso 2 — Usar `portal.portillalaw.com` (GoDaddy, ≈ 10 minutos)

1. En Render → servicio `portilla-portal` → **Settings → Custom Domains → Add Custom Domain** → `portal.portillalaw.com`.
2. En **GoDaddy** → *Mis productos* → `portillalaw.com` → **DNS** → **Agregar nuevo registro**:

   | Tipo | Nombre | Valor | TTL |
   |---|---|---|---|
   | `CNAME` | `portal` | `portilla-portal.onrender.com` | 1 hora |

   No toque los registros `A` (sitio web), `MX`, `TXT` ni `autodiscover` (correo de Microsoft).
3. En Render presione **Verify**. Normalmente queda en menos de una hora y el certificado HTTPS se emite solo.
4. Avíseme y cambio el enlace en portillalaw.com (`portal/index.html`) para que "Portal clientes" lleve al portal.

---

## Paso 3 — Email con Microsoft 365 (≈ 20 minutos, sin aprobaciones externas)

Microsoft retiró la contraseña simple para enviar por SMTP. El portal envía por **Microsoft Graph**, el método que Microsoft recomienda.

> **Si compró Microsoft 365 a través de GoDaddy:** primero confirme que puede entrar a https://entra.microsoft.com como administrador. Si GoDaddy no le da acceso, pida a GoDaddy "acceso de administrador global" o "desfederar" la cuenta.

1. Cree el buzón **cumplimiento@portillalaw.com** en https://admin.microsoft.com (*Usuarios activos → Agregar usuario*, o como *buzón compartido* sin costo de licencia).
2. En **https://entra.microsoft.com** → *Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro*:
   - Nombre: `Portal Portilla Law` · Cuentas: *Solo este directorio* → **Registrar**.
   - Copie **Id. de aplicación (cliente)** → `MS_CLIENT_ID` y **Id. de directorio (inquilino)** → `MS_TENANT_ID`.
3. *Permisos de API → Agregar un permiso → Microsoft Graph → Permisos de aplicación →* **Mail.Send** → **Conceder consentimiento de administrador**.
4. *Certificados y secretos → Nuevo secreto de cliente* (24 meses) → copie el **Valor** → `MS_CLIENT_SECRET`.
5. En Render → *Environment*: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SENDER=cumplimiento@portillalaw.com`.
6. Recomendado (seguridad): limite la app para que sólo pueda enviar desde ese buzón con una *Application Access Policy* de Exchange (su técnico de IT lo hace en 5 minutos con `New-ApplicationAccessPolicy`).
7. Portal → **Configuración → Enviarme una prueba**.

---

## Paso 4 — SMS con Heymarket

### Cómo evitar demoras en la aprobación (10DLC)

Las compañías telefónicas (AT&T, T-Mobile, Verizon) exigen registrar **cualquier** envío automático desde un número de 10 dígitos. Eso aplica aunque los destinatarios sean sus propios empleados y ya hayan dado su consentimiento. Ese consentimiento previo **sí ayuda**: es lo que aprueba la campaña. No se puede omitir el registro, pero sí evitar los rechazos, que son la causa principal de las demoras:

1. **¿Ya usa Heymarket y envía mensajes hoy?** Entonces su marca y su campaña probablemente ya están registradas. Pregunte a Heymarket si puede añadir el caso de uso *"Account Notifications / notificaciones a empleados"* a su campaña actual o a una nueva. Así se puede comenzar en días.
2. **Datos idénticos al IRS:** nombre legal y EIN exactamente como en su carta del IRS (CP 575 / 147C). La diferencia más pequeña causa rechazo.
3. **Sitio web con política de privacidad y términos de SMS:** el revisor visita portillalaw.com. Ya preparé `portillalaw.com/privacidad` y `portillalaw.com/terminos-sms` (pendiente de que se publique la página).
4. **Use exactamente este texto en el registro de la campaña:**

   - **Tipo de campaña:** Account Notification (o Mixed / Low Volume si Heymarket lo sugiere)
   - **Descripción:** *"Portilla Law Firm envía notificaciones operacionales a empleados de patronos participantes del Programa de Aprendizaje Registrado: asignación de adiestramientos, recordatorios de sesiones, confirmación de asistencia y solicitudes de progress report. No se envía publicidad."*
   - **Cómo se obtiene el consentimiento (opt-in):** *"Los empleados autorizan por escrito recibir mensajes de texto al inscribirse en el programa, mediante el formulario de inscripción del patrono y de Portilla Law, que incluye su número celular, la frecuencia de mensajes, que pueden aplicar cargos de datos, y cómo cancelar (STOP). Además pueden activar o desactivar los SMS en su cuenta del portal portal.portillalaw.com. Términos: https://portillalaw.com/terminos-sms"*
   - **Mensajes de ejemplo:**
     1. `Portilla Law: se te asigno "Seguridad OSHA 10" el 25 nov 9:00 AM. Responde SI para confirmar o entra aqui: https://portal.portillalaw.com/t/... Responde STOP para cancelar.`
     2. `Portilla Law: "Seguridad OSHA 10" comienza en 1 hora. Haz check-in aqui: https://portal.portillalaw.com/t/...`
     3. `Portilla Law: completa tu progress report de "Lectura de planos" para que cuente tu entrenamiento: https://portal.portillalaw.com/t/...`
   - **Palabras clave:** SI / CONFIRMO (confirmar), STOP / PARAR (cancelar), HELP / AYUDA.
   - **Enlaces en mensajes:** Sí · **Números de teléfono en mensajes:** No · **Contenido de préstamos, alcohol, etc.:** No.
5. **Guarde evidencia del consentimiento** (formularios firmados). No se envía, pero se lo pueden pedir.

### Conectar Heymarket al portal

1. Heymarket → **Settings → Integrations → API → Create API Secret**. Copie **Secret ID** y **Secret Key** (sólo se muestra una vez) a Render: `HEYMARKET_SECRET_ID`, `HEYMARKET_SECRET_KEY`.
2. En el portal → **Configuración → "Ver bandejas de Heymarket (IDs)"**. Copie el `id` de la bandeja (inbox) a `HEYMARKET_INBOX_ID` y su id de usuario de Heymarket a `HEYMARKET_CREATOR_ID`.
3. Respuestas de los empleados ("SI" confirma; "STOP" detiene SMS): en Heymarket configure un **webhook** de mensajes entrantes a
   `https://portal.portillalaw.com/webhooks/heymarket?token=VALOR_DE_HEYMARKET_WEBHOOK_TOKEN` (el valor lo genera Render en *Environment*). Si Heymarket requiere que su equipo lo active, escriba a help@heymarket.com.
4. **Configuración → Enviarme una prueba.**

> Sobre WhatsApp en Heymarket: según Heymarket, su integración de WhatsApp **sólo permite responder** mensajes que el cliente inicia (y requiere una cuenta de Twilio propia). Por eso el portal envía WhatsApp directamente con la API oficial de Meta (Paso 4B).

---

## Paso 4B — WhatsApp (API oficial de Meta)

Sí es posible. Además, la aprobación de Meta suele ser **más rápida** que el registro de SMS, y en Puerto Rico casi todos usan WhatsApp. Puede ir en paralelo con Heymarket. Mientras SMS se aprueba, WhatsApp y email ya funcionan.

1. **Número:** un número que **no** esté en uso en la app de WhatsApp (puede ser uno nuevo o un fijo de la oficina que reciba llamadas o SMS para el código).
2. https://business.facebook.com → cree o use el **Portfolio comercial** de Portilla Law Firm → *Configuración → Centro de seguridad →* **Verificación del negocio** (nombre legal, dirección, sitio web portillalaw.com y un correo @portillalaw.com). Esto es lo que más tarda, normalmente de días a 2 semanas.
3. https://developers.facebook.com → *Mis apps → Crear app → tipo "Business"* → añada el producto **WhatsApp** → *API Setup* → **Add phone number** (el del punto 1) → copie el **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
4. **Token permanente:** Portfolio comercial → *Usuarios del sistema → Agregar (Admin)* → *Generar token* con permisos `whatsapp_business_messaging` y `whatsapp_business_management` → `WHATSAPP_TOKEN`. En la app: *Configuración básica →* **Clave secreta de la app** → `WHATSAPP_APP_SECRET`.
5. **Plantilla de mensaje** (WhatsApp Manager → *Plantillas → Crear*):
   - Categoría: **Utilidad** · Nombre: `aviso_portilla` · Idioma: **Español**
   - Cuerpo: `Hola {{1}}, Portilla Law le informa: {{2}} Detalles: {{3}}`
   - Ejemplos: `{{1}}` = `Ana` · `{{2}}` = `"Seguridad OSHA 10" comienza en 1 hora. Haz check-in aquí.` · `{{3}}` = `https://portal.portillalaw.com/t/abc123`
   - Las plantillas de utilidad suelen aprobarse en minutos u horas.
6. **Webhook** (para "SI" y respuestas): en la app → *WhatsApp → Configuración → Webhook* → URL `https://portal.portillalaw.com/webhooks/whatsapp`, *Verify token* = valor de `WHATSAPP_VERIFY_TOKEN` en Render → suscribir el campo **messages**.
7. **Configuración → Enviarme una prueba.**

Detalles: cuando el empleado responde, el portal puede contestarle con texto libre durante 24 horas. Los avisos que inicia el portal usan la plantilla. Meta cobra por conversación de utilidad (en EE.UU. y PR, centavos por conversación).

**¿SMS, WhatsApp o ambos?** En *Configuración → Canales al celular* escriba `sms`, `whatsapp` o `sms,whatsapp`. Cada empleado puede desactivar un canal en su cuenta. Si responde STOP, ese canal se detiene automáticamente y Portilla Law recibe un aviso.

---

## Orden recomendado para comenzar a contactar lo antes posible

| Día | Acción | Resultado |
|---|---|---|
| 1 | Render + GoDaddy (Pasos 1–2) + Microsoft 365 (Paso 3) | Portal en vivo y **email funcionando** |
| 1 | Iniciar verificación de negocio en Meta y registro 10DLC en Heymarket, en paralelo | — |
| 1–3 | Plantilla de WhatsApp aprobada (si la verificación de Meta ya existe) | **WhatsApp funcionando** |
| 3–15 | Aprobación 10DLC | **SMS funcionando** |

---

## Paso 5 — Videos de entrenamiento

Los videos se ven **dentro del portal**, con seguimiento de lo que cada empleado vio. El portal **no guarda los archivos de video**: se enlazan desde una de estas plataformas.

| Opción | Costo | Privacidad | Recomendación |
|---|---|---|---|
| **YouTube "No listado"** | Gratis | Cualquiera con el enlace puede verlo | Para empezar |
| **Vimeo** (Starter/Standard) | ≈ $12–25/mes | Puede restringir el video para que **sólo se reproduzca en portal.portillalaw.com** | La mejor para contenido propio |
| Archivo **MP4** en almacenamiento en la nube (Bunny, Cloudflare R2, S3) | Centavos por GB | Enlace privado | Además bloquea el adelanto dentro del reproductor |

Al crear un entrenamiento con modalidad **Video**: pegue el enlace del video, la fecha en que queda disponible, la **fecha límite** y la duración del video.

Cómo funciona el seguimiento:
- Sólo cuenta lo que se ve en reproducción normal; adelantar no suma. Con archivos MP4 el adelanto está bloqueado.
- El video se pausa si el empleado cambia de pestaña.
- Cada 10 minutos aparece **"¿Sigues ahí?"** y el video no continúa hasta que lo confirme.
- Al ver el **90%** se marca completo y se le pide el progress report.
- Recordatorios antes de la **fecha límite**. Si no lo comienza, se le avisa a usted y luego al patrono. Si no lo completa a tiempo, queda **ausente** con alerta.
- Los porcentajes y los tiempos se cambian en **Configuración**.

---

## Paso 6 — Asistencia automática de Zoom

Requiere una cuenta **Zoom Pro o superior** (la que usa para crear las reuniones).

1. Entre a **https://marketplace.zoom.us** con la cuenta administradora → **Develop → Build App** → **Server-to-Server OAuth**.
2. Nombre: "Portal Portilla Law". En **Scopes** añada `report:read:list_meeting_participants:admin` (en cuentas antiguas aparece como `report:read:admin`).
3. Active la app y copie **Account ID**, **Client ID** y **Client Secret** a Render → Environment:

   | Variable | Valor |
   |---|---|
   | `ZOOM_ACCOUNT_ID` | Account ID |
   | `ZOOM_CLIENT_ID` | Client ID |
   | `ZOOM_CLIENT_SECRET` | Client Secret |

4. Al crear un entrenamiento de modalidad **Zoom**, pegue el enlace de la reunión (`https://zoom.us/j/...`).

Cómo funciona:
- Al terminar la reunión, el portal descarga el reporte de participantes de Zoom. Lo intenta cada 10 minutos durante el día.
- Busca a cada empleado por **email**, y si no inició sesión en Zoom, por su **nombre**. Pida a los empleados que entren con su nombre completo.
- Si estuvo conectado al menos el **75%** de la sesión, se marca **presente** con los minutos exactos. Si estuvo menos, queda una nota con los minutos.
- Antes de marcar a alguien ausente, el portal espera 60 minutos por el reporte de Zoom.
- En la página del entrenamiento hay un botón **"Importar ahora"**.

---

## Paso 7 — Cargar su información real

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
