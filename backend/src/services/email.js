/**
 * ============================================================
 * SONORO AV — Servicio de Email
 * backend/src/services/email.js
 * ============================================================
 */

const nodemailer = require('nodemailer');
const path = require('path');
const fs   = require('fs');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'mail.sonoro.com.co',
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: true, // true para puerto 465
  auth: {
    user: process.env.SMTP_USER || 'cms@sonoro.com.co',
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: true
  }
});

const CMS_URL  = process.env.CMS_URL  || 'https://cms.sonoro.com.co';
const FROM     = process.env.SMTP_FROM || 'SONORO CMS <cms@sonoro.com.co>';

// ── ESTILOS BASE DEL EMAIL ────────────────────────────────────
function baseTemplate(content) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SONORO CMS</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          
          <!-- HEADER -->
          <tr>
            <td style="background:#0f0f0f;padding:32px 40px;text-align:center;">
              <div style="font-size:28px;font-weight:900;letter-spacing:-1px;background:linear-gradient(135deg,#FF1B8D,#FF8C00,#FFE566);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;display:inline-block;">
                SONORO.
              </div>
              <div style="font-size:10px;color:#666;letter-spacing:3px;text-transform:uppercase;margin-top:4px;">
                CMS · Pantallas Informativas
              </div>
            </td>
          </tr>

          <!-- GRAD BAR -->
          <tr>
            <td style="background:linear-gradient(135deg,#FF1B8D,#FF8C00,#FFE566);height:3px;"></td>
          </tr>

          <!-- CONTENT -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${content}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#f9f9f9;padding:24px 40px;border-top:1px solid #eee;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
                Este correo fue enviado por <strong style="color:#666;">SONORO CMS</strong><br>
                Si tienes dudas escríbenos a <a href="mailto:cms@sonoro.com.co" style="color:#FF1B8D;text-decoration:none;">cms@sonoro.com.co</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── EMAIL DE BIENVENIDA ───────────────────────────────────────
async function sendWelcomeEmail(user) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Bienvenido a SONORO CMS
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>, tu cuenta ha sido creada exitosamente.
      Ya puedes comenzar a gestionar tus reproductores y contenido digital.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tu cuenta</p>
          <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${user.email}</p>
        </td>
      </tr>
    </table>

    <h3 style="margin:0 0 16px;font-size:14px;font-weight:700;color:#0f0f0f;">¿Por dónde empezar?</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="display:inline-block;width:24px;height:24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:800;color:white;margin-right:12px;vertical-align:middle;">1</span>
          <span style="font-size:14px;color:#333;vertical-align:middle;">Sube tu contenido — videos e imágenes</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="display:inline-block;width:24px;height:24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:800;color:white;margin-right:12px;vertical-align:middle;">2</span>
          <span style="font-size:14px;color:#333;vertical-align:middle;">Crea una lista de reproducción</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 0;">
          <span style="display:inline-block;width:24px;height:24px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);border-radius:50%;text-align:center;line-height:24px;font-size:12px;font-weight:800;color:white;margin-right:12px;vertical-align:middle;">3</span>
          <span style="font-size:14px;color:#333;vertical-align:middle;">Activa tu reproductor y asigna la lista</span>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
            Ir al CMS
          </a>
        </td>
      </tr>
    </table>
  `);

  await transporter.sendMail({
    from:    FROM,
    to:      user.email,
    subject: 'Bienvenido a SONORO CMS',
    html
  });

  console.log(`✅ Email de bienvenida enviado a ${user.email}`);
}

// ── EMAIL DE REPRODUCTOR ACTIVADO ────────────────────────────
async function sendDeviceActivatedEmail(user, device) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Reproductor activado
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>, 
      tu reproductor ha sido vinculado correctamente a tu cuenta.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #eee;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Nombre</p>
          <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${device.name || device.device_id}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #eee;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">ID del reproductor</p>
          <p style="margin:0;font-size:13px;color:#666;font-family:monospace;">${device.device_id}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Dirección IP</p>
          <p style="margin:0;font-size:13px;color:#666;font-family:monospace;">${device.ip_address || '—'}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Ahora puedes asignarle una lista de reproducción desde el CMS y comenzará a reproducir tu contenido automáticamente.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
            Gestionar reproductor
          </a>
        </td>
      </tr>
    </table>
  `);

  await transporter.sendMail({
    from:    FROM,
    to:      user.email,
    subject: `Reproductor "${device.name || device.device_id}" activado`,
    html
  });

  console.log(`✅ Email de activación enviado a ${user.email}`);
}

// ── VERIFICAR CONEXIÓN SMTP ───────────────────────────────────
async function verifyConnection() {
  try {
    await transporter.verify();
    console.log('✅ Servidor SMTP conectado');
    return true;
  } catch(e) {
    console.warn('⚠️ SMTP no disponible:', e.message);
    return false;
  }
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, verifyConnection };

// ── EMAIL: LICENCIA RENOVADA ──────────────────────────────────
async function sendLicenseRenewedEmail(user, license) {
  const endDate = new Date(license.new_end).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const typeLabel = license.license_type === 'windows' ? 'Windows' : 'Raspberry Pi';

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Licencia renovada
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>,
      tu licencia ha sido renovada exitosamente.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tipo de licencia</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${typeLabel}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Período renovado</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${license.months} ${license.months === 1 ? 'mes' : 'meses'}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Nuevo vencimiento</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${endDate}</p>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Ir al CMS
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM, to: user.email,
    subject: 'Licencia SONORO CMS renovada',
    html
  });
  console.log(`✅ Email de renovación enviado a ${user.email}`);
}

// ── EMAIL: AVISO DE VENCIMIENTO ───────────────────────────────
async function sendLicenseExpiringEmail(user, daysLeft) {
  const endDate = new Date(user.license_end).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const isUrgent = daysLeft <= 7;

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ${isUrgent ? '⚠️ Tu licencia vence pronto' : 'Aviso de vencimiento de licencia'}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>,
      tu licencia de SONORO CMS vence en <strong style="color:${isUrgent ? '#FF1B8D' : '#FF8C00'};">${daysLeft} días</strong> (${endDate}).
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Cuando la licencia venza, el acceso al CMS será bloqueado y tus reproductores mostrarán la pantalla de SONORO en espera.
      Para renovar, contáctanos a <a href="mailto:${FROM}" style="color:#FF1B8D;">${process.env.SMTP_USER}</a>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="mailto:${process.env.SMTP_USER}?subject=Renovación licencia SONORO CMS" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Solicitar renovación
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM, to: user.email,
    subject: `Tu licencia SONORO CMS vence en ${daysLeft} días`,
    html
  });
  console.log(`✅ Aviso de vencimiento enviado a ${user.email} (${daysLeft} días)`);
}


// ── EMAIL: CREDENCIALES DE AGENTE ────────────────────────────
async function sendAgentCredentialsEmail(agent, branch, cmsUrl) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Bienvenido al sistema de Atención al Usuario
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${agent.name}</strong>,
      has sido registrado como agente de atención en <strong style="color:#0f0f0f;">${branch.name}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Sucursal</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${branch.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tu nombre</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${agent.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tu PIN de acceso</p>
        <p style="margin:0;font-size:28px;color:#FF1B8D;font-weight:900;letter-spacing:8px;">${agent.pin}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Panel de acceso</p>
        <p style="margin:0;font-size:13px;color:#0f0f0f;font-family:monospace;">${cmsUrl}/atencion/agente</p>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:13px;color:#888;line-height:1.6;">
      Abre el enlace en tu navegador, selecciona la sucursal <strong>${branch.name}</strong>, 
      tu nombre y escribe tu PIN para iniciar sesión en tu ventanilla.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${cmsUrl}/atencion/agente" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Ir al panel de agente
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM,
    to: agent.email,
    subject: `Tus credenciales de acceso — SONORO Atención al Usuario`,
    html
  });
  console.log(`✅ Credenciales enviadas a ${agent.email}`);
}

// ── ALERTA CEC — TV apagada en ventana programada ────────────
async function sendCecAlertEmail(user, device, schedule) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      ⚠️ TV apagada en horario programado
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>, uno de tus reproductores
      tiene la TV <strong style="color:#cc0000;">apagada</strong> durante una ventana programada.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f8;border:1px solid #ffcccc;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Dispositivo</p>
          <p style="margin:0 0 16px;font-size:16px;color:#0f0f0f;font-weight:700;">${device.name || device.device_id}</p>
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Ventana programada</p>
          <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${schedule.time_on} – ${schedule.time_off}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
      Verifica que la TV esté encendida o usa el panel de control para enviarle el comando de encendido.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">
            Ir al dashboard
          </a>
        </td>
      </tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM,
    to: user.email,
    subject: `⚠️ TV apagada — ${device.name || device.device_id}`,
    html
  });
  console.log(`✅ CEC alert email enviado a ${user.email} — device: ${device.name}`);
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendLicenseRenewedEmail, sendLicenseExpiringEmail, sendAgentCredentialsEmail, sendCecAlertEmail, verifyConnection };

// ── EMAIL BULK PUSH REPORT ────────────────────────────────────
async function sendBulkPushReport(emails, summary) {
  const { playlist_name, total, updated, notified, errors, filters, timestamp } = summary;
  const date = new Date(timestamp).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const filterDesc = [
    filters.city        ? `Ciudad: <strong>${filters.city}</strong>` : null,
    filters.branch_id   ? `Sede específica` : null,
    filters.orientation ? `Formato: <strong>${filters.orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}</strong>` : null,
  ].filter(Boolean).join(' · ') || 'Todos los dispositivos';

  const errorsHtml = errors.length
    ? `<div style="margin-top:16px;padding:12px 16px;background:#fff3f3;border-left:3px solid #ff1744;border-radius:4px;">
        <div style="font-size:12px;font-weight:700;color:#ff1744;margin-bottom:6px;">Errores (${errors.length})</div>
        ${errors.map(e => `<div style="font-size:12px;color:#666;">${e.device_id}: ${e.error}</div>`).join('')}
       </div>` : '';

  const html = baseTemplate(`
    <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;color:#0f0f0f;">Bulk Push completado</h2>
    <p style="margin:0 0 24px;font-size:13px;color:#888;">${date}</p>

    <div style="background:#f9f9f9;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Playlist enviada</div>
      <div style="font-size:16px;font-weight:800;color:#0f0f0f;">${playlist_name}</div>
      <div style="font-size:12px;color:#888;margin-top:4px;">Filtro aplicado: ${filterDesc}</div>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:12px 16px;background:#f4f4f4;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#0f0f0f;">${total}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Dispositivos</div>
        </td>
        <td width="10"></td>
        <td style="padding:12px 16px;background:#f0fff8;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#00c853;">${updated}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Actualizados</div>
        </td>
        <td width="10"></td>
        <td style="padding:12px 16px;background:#f0f8ff;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#2196f3;">${notified}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Notificados</div>
        </td>
      </tr>
    </table>

    <p style="font-size:12px;color:#999;margin:0 0 4px;">
      Los dispositivos offline aplicarán el cambio automáticamente al reconectarse.
    </p>
    ${errorsHtml}
  `);

  for (const email of emails) {
    await transporter.sendMail({
      from: FROM,
      to: email,
      subject: `Bulk Push completado — ${playlist_name} · ${updated}/${total} dispositivos`,
      html
    });
    console.log(`✅ Reporte Bulk Push enviado a ${email}`);
  }
}


async function sendPasswordResetEmail(user, resetLink) {
  const html = baseTemplate(`
    <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;color:#0f0f0f;">Restablecer contraseña</h2>
    <p style="margin:0 0 24px;font-size:13px;color:#888;">Hola ${user.name || user.email}, recibimos una solicitud para restablecer tu contraseña.</p>

    <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
      <p style="margin:0 0 16px;font-size:14px;color:#555;">Haz clic en el botón para crear una nueva contraseña. Este enlace es válido por <strong>1 hora</strong>.</p>
      <a href="${resetLink}"
         style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#7b61ff,#00f5d4);color:#fff;font-weight:800;font-size:14px;text-decoration:none;border-radius:8px;letter-spacing:0.5px;">
        Restablecer contraseña
      </a>
    </div>

    <p style="font-size:12px;color:#999;margin:0 0 8px;">Si no solicitaste este cambio, ignora este correo. Tu contraseña no será modificada.</p>
    <p style="font-size:11px;color:#bbb;margin:0;">
      Si el botón no funciona, copia este enlace en tu navegador:<br>
      <span style="color:#7b61ff;word-break:break-all;">${resetLink}</span>
    </p>
  `);
  await transporter.sendMail({
    from: FROM,
    to: user.email,
    subject: 'Restablecer contraseña — SONORO CMS',
    html
  });
  console.log(`✅ Email reset password enviado a ${user.email}`);
}

// ── EMAIL: INSCRIPCIÓN RECIBIDA (pendiente de confirmación) ──
async function sendEventPendingEmail(attendee, event, emailConfig = {}) {
  const opts = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString('es-CO', opts);

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ¡Inscripción recibida!
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${attendee.name}</strong>,
      tu inscripción a <strong style="color:#0f0f0f;">${event.name}</strong> ha sido recibida y está
      <strong style="color:#f59e0b;">pendiente de confirmación</strong> por el organizador.
    </p>

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
        Pronto recibirás un correo con tu pase de acceso (código QR) una vez que tu inscripción sea confirmada.
      </p>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Fecha</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      ${event.venue_name ? `
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Lugar</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${event.venue_name}</p>
      </td></tr>` : ''}
    </table>

    <p style="margin:0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      Si no te registraste en este evento, ignora este mensaje.
    </p>
  `);

  const _fromPend = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moP = { from: _fromPend, to: attendee.email, subject: `Inscripción recibida — ${event.name}`, html };
  if (emailConfig.reply_to) moP.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moP);
  console.log(`✅ Email inscripción pendiente enviado a ${attendee.email}`);
}

// ── EMAIL DE CONFIRMACIÓN DE REGISTRO A EVENTO ───────────────
async function sendEventRegistrationEmail(attendee, event, registration, emailConfig = {}) {
  const QRCode  = require('qrcode');
  const qrLink  = `${CMS_URL}/evento/${event.slug}/mi-registro/${registration.qr_token}`;
  const opts    = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString('es-CO', opts);
  const endStr   = new Date(event.ends_at).toLocaleString('es-CO', opts);
  const ticketLabel = (registration.ticket_type || 'general').charAt(0).toUpperCase() + (registration.ticket_type || 'general').slice(1);

  let qrImgHtml = `<p style="margin:0;font-family:monospace;font-size:12px;color:#555;word-break:break-all;">${registration.qr_token}</p>`;
  let attachments = [];
  try {
    const qrBuffer = await QRCode.toBuffer(registration.qr_token, { type: 'png', width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    qrImgHtml = `<img src="cid:event_qr_code" alt="Código QR" width="200" height="200" style="display:block;margin:0 auto;" />`;
    attachments = [{ filename: 'qr.png', content: qrBuffer, cid: 'event_qr_code' }];
  } catch (e) {
    console.error('⚠️ QR generation error:', e.message);
  }

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ¡Tu registro está confirmado!
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${attendee.name}</strong>,
      aquí está tu pase para el evento.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Inicio</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Cierre</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${endStr}</p>
      </td></tr>
      ${event.venue_name ? `
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Lugar</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${event.venue_name}</p>
      </td></tr>` : ''}
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tipo de entrada</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${ticketLabel}</p>
      </td></tr>
    </table>

    <div style="text-align:center;margin:24px 0;background:#fff;border:1px solid #eee;border-radius:8px;padding:20px;">
      <p style="margin:0 0 12px;font-size:13px;color:#666;font-weight:600;">
        Presenta este código QR al ingresar al evento
      </p>
      ${qrImgHtml}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${qrLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Ver mi registro
        </a>
      </td></tr>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      Si no te registraste en este evento, ignora este mensaje.
    </p>
  `);

  const _fromReg = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moR = { from: _fromReg, to: attendee.email, subject: `Tu pase para ${event.name}`, html, attachments };
  if (emailConfig.reply_to) moR.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moR);
  console.log(`✅ Email de registro de evento enviado a ${attendee.email}`);
}

// ── SOLICITUD DE COTIZACIÓN A PROVEEDOR ──────────────────────
async function sendSupplierQuoteEmail({ supplier_name, contact_email, event_name, starts_at, timezone, service_description }, quoteUrl, emailConfig = {}) {
  const dateStr = starts_at
    ? new Date(starts_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric', timeZone: timezone || 'America/Bogota' })
    : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      Solicitud de cotización
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${supplier_name}</strong>,<br>
      Te invitamos a cotizar tus servicios para el siguiente evento:
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0 0 12px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${dateStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Fecha</p>
        <p style="margin:0 0 12px;font-size:14px;color:#333;">${dateStr}</p>` : ''}
        ${service_description ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Servicio solicitado</p>
        <p style="margin:0;font-size:14px;color:#333;">${service_description}</p>` : ''}
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
      Usa el formulario en línea para enviar tu cotización. Puedes incluir precios, condiciones y adjuntar tu propuesta en PDF.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${quoteUrl}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
          Enviar mi cotización →
        </a>
      </td></tr>
    </table>

    <p style="margin:0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      Este enlace es de uso único para ${supplier_name}. No reenvíes este correo.
    </p>
  `);
  const _fromQ = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moQ = { from: _fromQ, to: contact_email, subject: `Solicitud de cotización — ${event_name}`, html };
  if (emailConfig.reply_to) moQ.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moQ);
  console.log(`✅ Email cotización enviado a ${contact_email} (${event_name})`);
}

async function sendSupplierAcceptedEmail({ supplier_name, contact_email, event_name, contracted_amount }, emailConfig = {}) {
  const amountStr = contracted_amount
    ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(contracted_amount)
    : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      Tu cotización ha sido aceptada
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${supplier_name}</strong>,<br>
      Nos complace informarte que tu cotización para el siguiente evento ha sido <strong style="color:#22c55e;">aceptada</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0 0 12px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${amountStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Monto acordado</p>
        <p style="margin:0;font-size:15px;color:#22c55e;font-weight:700;">${amountStr}</p>` : ''}
      </td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      El equipo de producción se comunicará contigo para coordinar los próximos pasos. ¡Gracias por tu propuesta!
    </p>
  `);
  const _fromA = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moA = { from: _fromA, to: contact_email, subject: `Cotización aceptada — ${event_name}`, html };
  if (emailConfig.reply_to) moA.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moA);
  console.log(`✅ Email aceptación enviado a ${contact_email} (${event_name})`);
}


// ── ABONO A PROVEEDOR ────────────────────────────────────────
async function sendSupplierDepositEmail({ supplier_name, contact_email, event_name, deposit_amount, contracted_amount, payment_proof_url }, emailConfig = {}) {
  const fmtCOP = n => n != null ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n) : '';
  const depositStr  = fmtCOP(deposit_amount);
  const pendingAmt  = (contracted_amount != null && deposit_amount != null) ? contracted_amount - deposit_amount : null;
  const pendingStr  = fmtCOP(pendingAmt);
  const proofLine   = payment_proof_url ? '<p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">Se adjunta el comprobante de pago para tu registro.</p>' : '';
  const pendingLine = pendingAmt != null ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Saldo pendiente</p><p style="margin:0;font-size:15px;color:#f59e0b;font-weight:700;">${pendingStr}</p>` : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">Abono registrado</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${supplier_name}</strong>,<br>
      Hemos registrado un abono para tu contrato en el siguiente evento:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0 0 14px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Abono recibido</p>
        <p style="margin:0 0 14px;font-size:18px;color:#3b82f6;font-weight:800;">${depositStr}</p>
        ${pendingLine}
      </td></tr>
    </table>
    ${proofLine}
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      Ante cualquier consulta, responde este correo y nuestro equipo te atenderá.
    </p>
  `);
  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: contact_email, subject: `Abono registrado — ${event_name}`, html };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  if (payment_proof_url) {
    const filePath = path.join(__dirname, '../public', payment_proof_url);
    if (fs.existsSync(filePath)) {
      mo.attachments = [{ filename: 'comprobante_abono.pdf', path: filePath }];
    }
  }
  await transporter.sendMail(mo);
  console.log(`✅ Email abono enviado a ${contact_email} (${event_name})`);
}

// ── PAGO COMPLETO A PROVEEDOR ────────────────────────────────
async function sendSupplierPaidEmail({ supplier_name, contact_email, event_name, contracted_amount, payment_proof_url }, emailConfig = {}) {
  const amountStr = contracted_amount != null ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(contracted_amount) : '';
  const proofLine = payment_proof_url ? '<p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">Se adjunta el comprobante del pago final para tu archivo.</p>' : '';
  const amountLine = amountStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Total pagado</p><p style="margin:0;font-size:18px;color:#10b981;font-weight:800;">${amountStr}</p>` : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">Pago completo registrado</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${supplier_name}</strong>,<br>
      Nos complace informarte que hemos registrado el <strong style="color:#10b981;">pago completo</strong> de tu contrato.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Evento</p>
        <p style="margin:0 0 14px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${amountLine}
      </td></tr>
    </table>
    ${proofLine}
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      ¡Gracias por tu excelente trabajo! Esperamos contar contigo en futuros eventos.
    </p>
  `);
  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: contact_email, subject: `Pago completado — ${event_name}`, html };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  if (payment_proof_url) {
    const filePath = path.join(__dirname, '../public', payment_proof_url);
    if (fs.existsSync(filePath)) {
      mo.attachments = [{ filename: 'comprobante_pago_final.pdf', path: filePath }];
    }
  }
  await transporter.sendMail(mo);
  console.log(`✅ Email pago completo enviado a ${contact_email} (${event_name})`);
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendLicenseRenewedEmail, sendLicenseExpiringEmail, sendAgentCredentialsEmail, sendBulkPushReport, sendPasswordResetEmail, sendEventRegistrationEmail, sendEventPendingEmail, sendSupplierQuoteEmail, sendSupplierAcceptedEmail, sendSupplierDepositEmail, sendSupplierPaidEmail, verifyConnection };
