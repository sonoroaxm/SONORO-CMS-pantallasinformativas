// Events v1 — E4 Certificados (autenticado productor/organizador)
// P-2: todo filtro por user_id · P-3: mutaciones ≥2 tablas con withTransaction
'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const path    = require('path');
const fs      = require('fs');
const { withTransaction } = require('../db/withTransaction');
const { generateCertificatePdf } = require('../services/certificatePdf');
const { sendCertificateEmail } = require('../services/email');

const CANVAS_DIR = path.join(__dirname, '../../uploads/certificate-canvases');
const PDF_DIR    = path.join(__dirname, '../../uploads/certificates');
fs.mkdirSync(CANVAS_DIR, { recursive: true });
fs.mkdirSync(PDF_DIR,    { recursive: true });

// Convierte req.files.canvas (express-fileupload global) → req.file estilo multer.
// express-fileupload consume el body antes que cualquier multer, así que usamos
// el mismo pipeline que el resto del CMS.
async function uploadCanvas(req, res, next) {
  try {
    const f = req.files && req.files.canvas;
    if (!f) return next();
    if (!/^image\/(png|jpe?g)$/i.test(f.mimetype || '')) {
      return res.status(400).json({ error: 'Formato no soportado (usa PNG o JPG)' });
    }
    if (f.size > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Archivo > 10 MB' });
    }
    const ext = (path.extname(f.name || '').toLowerCase()) || '.png';
    const filename = `canvas-${req.user?.id || 0}-${Date.now()}${ext}`;
    const dest = path.join(CANVAS_DIR, filename);
    await f.mv(dest);
    req.file = { path: dest, filename, mimetype: f.mimetype, size: f.size };
    next();
  } catch (err) {
    console.error('[certs] uploadCanvas', err);
    res.status(500).json({ error: 'Error al subir canvas' });
  }
}

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

async function assertEventOwned(pool, eventId, userId) {
  const r = await pool.query(
    `SELECT id, name, timezone, starts_at, ends_at, user_id, slug
       FROM events.events WHERE id=$1 AND user_id=$2`,
    [eventId, userId]
  );
  if (!r.rows[0]) { const e = new Error('Evento no encontrado'); e.httpStatus = 404; throw e; }
  return r.rows[0];
}

// hours_total: suma duración (horas) de sesiones atendidas (registration_sessions.status='attended')
// Si no hay sesiones atendidas y hay check-in general, cae al total de duración del evento.
async function computeHoursTotal(client, eventId, registrationId, sessionId) {
  if (sessionId) {
    const r = await client.query(
      `SELECT EXTRACT(EPOCH FROM (ends_at - starts_at))/3600.0 AS h
         FROM events.event_sessions WHERE id=$1 AND event_id=$2`,
      [sessionId, eventId]
    );
    return Number(r.rows[0]?.h || 0);
  }
  const r = await client.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (s.ends_at - s.starts_at))/3600.0), 0) AS h
       FROM events.registration_sessions rs
       JOIN events.event_sessions s ON s.id = rs.session_id
      WHERE rs.registration_id = $1 AND rs.status = 'attended'`,
    [registrationId]
  );
  let h = Number(r.rows[0].h || 0);
  if (h === 0) {
    const r2 = await client.query(
      `SELECT COUNT(*)::int AS c FROM events.registration_checkins WHERE registration_id=$1`,
      [registrationId]
    );
    if (r2.rows[0].c > 0) {
      const r3 = await client.query(
        `SELECT EXTRACT(EPOCH FROM (ends_at - starts_at))/3600.0 AS h
           FROM events.events WHERE id=$1`, [eventId]);
      h = Number(r3.rows[0]?.h || 0);
    }
  }
  return Math.round(h * 100) / 100;
}

async function registrationIsEligible(client, templateRow, registrationId) {
  if (!templateRow.requires_checkin) return { ok: true };
  if (templateRow.scope === 'session') {
    const r = await client.query(
      `SELECT 1 FROM events.registration_sessions
        WHERE registration_id=$1 AND session_id=$2 AND status='attended'`,
      [registrationId, templateRow.session_id]
    );
    return { ok: !!r.rows[0], reason: r.rows[0] ? null : 'No asistió a la sesión' };
  }
  // scope event
  const rc = await client.query(
    `SELECT COUNT(*)::int AS c FROM events.registration_checkins WHERE registration_id=$1`,
    [registrationId]
  );
  if (rc.rows[0].c === 0) return { ok: false, reason: 'Sin check-in' };
  if (templateRow.min_sessions_attended) {
    const rs = await client.query(
      `SELECT COUNT(*)::int AS c FROM events.registration_sessions
        WHERE registration_id=$1 AND status='attended'`,
      [registrationId]
    );
    if (rs.rows[0].c < templateRow.min_sessions_attended) {
      return { ok: false, reason: `Mínimo ${templateRow.min_sessions_attended} sesiones` };
    }
  }
  return { ok: true };
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL
      || process.env.CMS_URL
      || `${req.protocol}://${req.get('host')}`;
}

// ───────── Templates CRUD ─────────

router.get('/:id/certificate-templates', auth, async (req, res) => {
  try {
    const pool = global.pool;
    await assertEventOwned(pool, req.params.id, req.user.id);
    const r = await pool.query(
      `SELECT t.*,
              (SELECT COUNT(*)::int FROM events.certificates c WHERE c.template_id=t.id AND c.revoked_at IS NULL) AS issued_count
         FROM events.certificate_templates t
        WHERE t.event_id=$1 AND t.user_id=$2
        ORDER BY t.created_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json({ templates: r.rows });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] list templates', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/certificate-templates', auth, uploadCanvas, async (req, res) => {
  try {
    const pool = global.pool;
    await assertEventOwned(pool, req.params.id, req.user.id);
    const { name, scope = 'event', session_id, page_size = 'letter', body_text,
            requires_checkin = 'true', min_sessions_attended } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    if (!['event','session'].includes(scope)) return res.status(400).json({ error: 'scope inválido' });
    if (!['letter','half_letter'].includes(page_size)) return res.status(400).json({ error: 'page_size inválido' });
    if (scope === 'session' && !session_id) return res.status(400).json({ error: 'session_id requerido' });

    const canvasPath = req.file ? req.file.path : null;
    const cols = ['event_id','user_id','name','scope','session_id','page_size','canvas_path',
                  'requires_checkin','min_sessions_attended'];
    const vals = [req.params.id, req.user.id, name, scope, session_id || null, page_size, canvasPath,
                  String(requires_checkin) !== 'false',
                  min_sessions_attended ? parseInt(min_sessions_attended, 10) : null];
    if (body_text) { cols.push('body_text'); vals.push(body_text); }
    const ph = vals.map((_, i) => `$${i+1}`).join(',');
    const r = await pool.query(
      `INSERT INTO events.certificate_templates (${cols.join(',')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    res.status(201).json({ template: r.rows[0] });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] create template', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

router.patch('/certificate-templates/:tplId', auth, uploadCanvas, async (req, res) => {
  try {
    const pool = global.pool;
    const existing = await pool.query(
      `SELECT * FROM events.certificate_templates WHERE id=$1 AND user_id=$2`,
      [req.params.tplId, req.user.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const t = existing.rows[0];
    const name     = req.body.name     ?? t.name;
    const scope    = req.body.scope    ?? t.scope;
    const sessionId= req.body.session_id ?? t.session_id;
    const pageSize = req.body.page_size ?? t.page_size;
    const bodyText = req.body.body_text ?? t.body_text;
    const reqChk   = req.body.requires_checkin != null ? String(req.body.requires_checkin) !== 'false' : t.requires_checkin;
    const minSes   = req.body.min_sessions_attended != null
                       ? (req.body.min_sessions_attended === '' ? null : parseInt(req.body.min_sessions_attended, 10))
                       : t.min_sessions_attended;
    const active   = req.body.active   != null ? String(req.body.active) !== 'false' : t.active;
    const canvasPath = req.file ? req.file.path : t.canvas_path;

    const r = await pool.query(
      `UPDATE events.certificate_templates
          SET name=$1, scope=$2, session_id=$3, page_size=$4, canvas_path=$5,
              body_text=$6, requires_checkin=$7, min_sessions_attended=$8,
              active=$9, updated_at=NOW()
        WHERE id=$10 AND user_id=$11
      RETURNING *`,
      [name, scope, sessionId, pageSize, canvasPath, bodyText, reqChk, minSes, active,
       req.params.tplId, req.user.id]
    );
    res.json({ template: r.rows[0] });
  } catch (err) {
    console.error('[certs] patch template', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

router.delete('/certificate-templates/:tplId', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const used = await pool.query(
      `SELECT COUNT(*)::int AS c FROM events.certificates
        WHERE template_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [req.params.tplId, req.user.id]
    );
    if (used.rows[0].c > 0) {
      // soft disable
      await pool.query(
        `UPDATE events.certificate_templates SET active=FALSE, updated_at=NOW()
          WHERE id=$1 AND user_id=$2`,
        [req.params.tplId, req.user.id]
      );
      return res.json({ ok: true, soft: true });
    }
    await pool.query(
      `DELETE FROM events.certificate_templates WHERE id=$1 AND user_id=$2`,
      [req.params.tplId, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[certs] delete template', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ───────── Emisión ─────────

async function issueOne(client, { template, event, registrationId, issuedBy, manual, publicBase }) {
  const regR = await client.query(
    `SELECT r.id, r.attendee_id, a.name AS attendee_name, a.email AS attendee_email
       FROM events.registrations r
       JOIN events.attendees a ON a.id = r.attendee_id
      WHERE r.id=$1 AND r.event_id=$2 AND r.user_id=$3`,
    [registrationId, event.id, template.user_id]
  );
  if (!regR.rows[0]) throw Object.assign(new Error('Registro no encontrado'), { httpStatus: 404 });
  const registration = regR.rows[0];

  if (!manual) {
    const elig = await registrationIsEligible(client, template, registrationId);
    if (!elig.ok) throw Object.assign(new Error(elig.reason || 'No elegible'), { httpStatus: 409 });
  }

  let session = null;
  if (template.scope === 'session' && template.session_id) {
    const s = await client.query(
      `SELECT id, name, starts_at, ends_at FROM events.event_sessions WHERE id=$1`,
      [template.session_id]
    );
    session = s.rows[0] || null;
  }

  const hoursTotal = await computeHoursTotal(client, event.id, registrationId, template.session_id);

  const ins = await client.query(
    `INSERT INTO events.certificates
       (template_id, registration_id, event_id, session_id, user_id, hours_total,
        issued_by, manual_override)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (template_id, registration_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid))
     WHERE revoked_at IS NULL
     DO NOTHING
     RETURNING *`,
    [template.id, registrationId, event.id, template.session_id || null, template.user_id,
     hoursTotal, issuedBy || null, !!manual]
  );
  let cert = ins.rows[0];
  if (!cert) {
    const ex = await client.query(
      `SELECT * FROM events.certificates
        WHERE template_id=$1 AND registration_id=$2
          AND COALESCE(session_id,'00000000-0000-0000-0000-000000000000'::uuid)=COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
          AND revoked_at IS NULL`,
      [template.id, registrationId, template.session_id || null]
    );
    cert = ex.rows[0];
    return { cert, created: false, registration };
  }

  const pdfPath = path.join(PDF_DIR, `${cert.id}.pdf`);
  await generateCertificatePdf({
    template, event, registration, session,
    hoursTotal,
    verifyUrl: `${publicBase}/verify/${cert.token}`,
    issuedAt: cert.issued_at,
    outPath: pdfPath,
  });
  await client.query(`UPDATE events.certificates SET pdf_path=$1 WHERE id=$2`, [pdfPath, cert.id]);
  cert.pdf_path = pdfPath;
  return { cert, created: true, registration };
}

router.post('/:id/certificates/issue', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const event = await assertEventOwned(pool, req.params.id, req.user.id);
    const { template_id, registration_ids, send_email = false } = req.body;
    if (!template_id) return res.status(400).json({ error: 'template_id requerido' });

    const tplR = await pool.query(
      `SELECT * FROM events.certificate_templates WHERE id=$1 AND user_id=$2 AND event_id=$3`,
      [template_id, req.user.id, event.id]
    );
    const template = tplR.rows[0];
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (!template.active) return res.status(409).json({ error: 'Plantilla inactiva' });

    let ids = Array.isArray(registration_ids) ? registration_ids : null;
    if (!ids || ids.length === 0) {
      const r = await pool.query(
        `SELECT id FROM events.registrations WHERE event_id=$1 AND user_id=$2 AND status='confirmed'`,
        [event.id, req.user.id]
      );
      ids = r.rows.map(x => x.id);
    }

    const publicBase = publicBaseUrl(req);
    const results = { issued: [], skipped: [], errors: [] };

    for (const regId of ids) {
      try {
        const out = await withTransaction(pool, (client) =>
          issueOne(client, { template, event, registrationId: regId, issuedBy: req.user.id, manual: false, publicBase })
        );
        if (out.created) {
          results.issued.push({ registration_id: regId, cert_id: out.cert.id, token: out.cert.token });
          if (send_email && out.registration.attendee_email) {
            try {
              await sendCertificateEmail({
                to: out.registration.attendee_email,
                attendeeName: out.registration.attendee_name,
                eventName: event.name,
                certUrl: `${publicBase}/cert/${out.cert.token}`,
                pdfPath: out.cert.pdf_path,
              });
              await pool.query(`UPDATE events.certificates SET email_sent_at=NOW() WHERE id=$1`, [out.cert.id]);
            } catch (e) { console.error('[certs] email', e.message); }
          }
        } else {
          results.skipped.push({ registration_id: regId, reason: 'ya emitido' });
        }
      } catch (e) {
        results.errors.push({ registration_id: regId, reason: e.message });
      }
    }
    res.json(results);
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] issue', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/:id/certificates/issue-one', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const event = await assertEventOwned(pool, req.params.id, req.user.id);
    const { template_id, registration_id, manual = false, send_email = false } = req.body;
    if (!template_id || !registration_id) return res.status(400).json({ error: 'template_id y registration_id requeridos' });
    const tplR = await pool.query(
      `SELECT * FROM events.certificate_templates WHERE id=$1 AND user_id=$2 AND event_id=$3`,
      [template_id, req.user.id, event.id]
    );
    const template = tplR.rows[0];
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const publicBase = publicBaseUrl(req);
    const out = await withTransaction(pool, (client) =>
      issueOne(client, { template, event, registrationId: registration_id, issuedBy: req.user.id, manual: !!manual, publicBase })
    );

    if (send_email && out.registration.attendee_email && out.created) {
      try {
        await sendCertificateEmail({
          to: out.registration.attendee_email,
          attendeeName: out.registration.attendee_name,
          eventName: event.name,
          certUrl: `${publicBase}/cert/${out.cert.token}`,
          pdfPath: out.cert.pdf_path,
        });
        await pool.query(`UPDATE events.certificates SET email_sent_at=NOW() WHERE id=$1`, [out.cert.id]);
      } catch (e) { console.error('[certs] email', e.message); }
    }

    res.json({ certificate: out.cert, created: out.created });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] issue-one', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// Lista certificados emitidos
router.get('/:id/certificates', auth, async (req, res) => {
  try {
    const pool = global.pool;
    await assertEventOwned(pool, req.params.id, req.user.id);
    const r = await pool.query(
      `SELECT c.id, c.token, c.hours_total, c.issued_at, c.revoked_at, c.email_sent_at,
              c.pdf_path IS NOT NULL AS has_pdf,
              c.template_id, t.name AS template_name, t.scope, t.page_size,
              c.registration_id, a.name AS attendee_name, a.email AS attendee_email,
              c.session_id, s.name AS session_name
         FROM events.certificates c
         JOIN events.certificate_templates t ON t.id = c.template_id
         JOIN events.registrations r         ON r.id = c.registration_id
         JOIN events.attendees a             ON a.id = r.attendee_id
    LEFT JOIN events.event_sessions s        ON s.id = c.session_id
        WHERE c.event_id=$1 AND c.user_id=$2
        ORDER BY c.issued_at DESC`,
      [req.params.id, req.user.id]
    );
    res.json({ certificates: r.rows });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] list', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Certificados por registration (para subpestaña Registros)
router.get('/:id/registrations/:regId/certificates', auth, async (req, res) => {
  try {
    const pool = global.pool;
    await assertEventOwned(pool, req.params.id, req.user.id);
    const r = await pool.query(
      `SELECT c.id, c.token, c.hours_total, c.issued_at, c.revoked_at, c.email_sent_at,
              c.template_id, t.name AS template_name, t.scope,
              c.session_id, s.name AS session_name
         FROM events.certificates c
         JOIN events.certificate_templates t ON t.id = c.template_id
    LEFT JOIN events.event_sessions s        ON s.id = c.session_id
        WHERE c.event_id=$1 AND c.user_id=$2 AND c.registration_id=$3
        ORDER BY c.issued_at DESC`,
      [req.params.id, req.user.id, req.params.regId]
    );
    res.json({ certificates: r.rows });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] list by reg', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/certificates/:certId/revoke', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const r = await pool.query(
      `UPDATE events.certificates SET revoked_at=NOW(), revoke_reason=$1
        WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL
      RETURNING *`,
      [req.body.reason || null, req.params.certId, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Certificado no encontrado o ya revocado' });
    res.json({ certificate: r.rows[0] });
  } catch (err) {
    console.error('[certs] revoke', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.post('/certificates/:certId/resend-email', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const r = await pool.query(
      `SELECT c.*, a.email AS attendee_email, a.name AS attendee_name, e.name AS event_name
         FROM events.certificates c
         JOIN events.registrations r ON r.id = c.registration_id
         JOIN events.attendees a     ON a.id = r.attendee_id
         JOIN events.events e        ON e.id = c.event_id
        WHERE c.id=$1 AND c.user_id=$2 AND c.revoked_at IS NULL`,
      [req.params.certId, req.user.id]
    );
    const cert = r.rows[0];
    if (!cert) return res.status(404).json({ error: 'Certificado no encontrado' });
    if (!cert.attendee_email) return res.status(400).json({ error: 'Asistente sin email' });
    const publicBase = publicBaseUrl(req);
    await sendCertificateEmail({
      to: cert.attendee_email,
      attendeeName: cert.attendee_name,
      eventName: cert.event_name,
      certUrl: `${publicBase}/cert/${cert.token}`,
      pdfPath: cert.pdf_path,
    });
    await pool.query(`UPDATE events.certificates SET email_sent_at=NOW() WHERE id=$1`, [cert.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[certs] resend', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

// Descarga PDF (auth)
router.get('/certificates/:certId/pdf', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const r = await pool.query(
      `SELECT pdf_path, token FROM events.certificates WHERE id=$1 AND user_id=$2`,
      [req.params.certId, req.user.id]
    );
    const row = r.rows[0];
    if (!row || !row.pdf_path || !fs.existsSync(row.pdf_path)) return res.status(404).json({ error: 'PDF no disponible' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="certificado-${row.token}.pdf"`);
    fs.createReadStream(row.pdf_path).pipe(res);
  } catch (err) {
    console.error('[certs] pdf', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Preview sin emitir — stream PDF con watermark
router.post('/:id/certificate-templates/:tplId/preview', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const event = await assertEventOwned(pool, req.params.id, req.user.id);
    const t = await pool.query(
      `SELECT * FROM events.certificate_templates WHERE id=$1 AND user_id=$2 AND event_id=$3`,
      [req.params.tplId, req.user.id, event.id]
    );
    const template = t.rows[0];
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

    let session = null;
    if (template.scope === 'session' && template.session_id) {
      const s = await pool.query(`SELECT id,name,starts_at,ends_at FROM events.event_sessions WHERE id=$1`, [template.session_id]);
      session = s.rows[0] || null;
    }
    const outPath = path.join(PDF_DIR, `preview-${template.id}-${Date.now()}.pdf`);
    await generateCertificatePdf({
      template, event,
      registration: { attendee_name: req.body?.sample_name || 'Nombre del Asistente', email: '' },
      session,
      hoursTotal: req.body?.sample_hours != null ? Number(req.body.sample_hours) : 8,
      verifyUrl: `${publicBaseUrl(req)}/verify/preview`,
      issuedAt: new Date(),
      outPath,
      watermark: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview.pdf"`);
    fs.createReadStream(outPath).pipe(res).on('close', () => {
      fs.unlink(outPath, () => {});
    });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('[certs] preview', err);
    res.status(500).json({ error: err.message || 'Error interno' });
  }
});

module.exports = router;
