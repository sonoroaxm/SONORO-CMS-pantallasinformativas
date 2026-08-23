const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

const mailerTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// CORS preflight
router.options('/api/mailer/send', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Mailer-Key');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(204);
});

router.post('/api/mailer/send', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');

  const key = req.headers['x-mailer-key'];
  if (!key || key !== process.env.MAILER_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, subject, html, from_name } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Faltan campos: to, subject, html' });
  }

  try {
    await mailerTransport.sendMail({
      from: `"${from_name || 'SONORO AV'}" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html
    });
    console.log('✅ Mailer: enviado a', to);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Mailer:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
