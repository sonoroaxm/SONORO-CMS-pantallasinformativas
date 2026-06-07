// Events v1 — Rutas públicas (registro, QR lookup)
// Sin auth — rate limit propio por endpoint
// Fase: E0 skeleton — endpoints se implementan en E1+

const express = require('express');
const router = express.Router();

// Health check E0
router.get('/health', (req, res) => {
  res.json({ module: 'events-public', status: 'ok', phase: 'E0' });
});

module.exports = router;
