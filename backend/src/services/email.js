/**
 * ============================================================
 * SONORO AV — Servicio de Email
 * backend/src/services/email.js
 * ============================================================
 */

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'mail.sonoro.com.co',
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: true, // true para puerto 465
  auth: {
    user: process.env.SMTP_USER || 'daniel@sonoro.com.co',
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

const CMS_URL  = process.env.CMS_URL  || 'https://cms.sonoro.com.co';
const FROM     = process.env.SMTP_FROM || 'SONORO CMS <daniel@sonoro.com.co>';

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
                Si tienes dudas escríbenos a <a href="mailto:daniel@sonoro.com.co" style="color:#FF1B8D;text-decoration:none;">daniel@sonoro.com.co</a>
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

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendLicenseRenewedEmail, sendLicenseExpiringEmail, sendAgentCredentialsEmail, verifyConnection };

