// Events v1 — Rutas staff operativo (check-in, redemption)
// Auth: JWT CMS o X-Staff-Pin (implementado en E2)
// Fase: E0 skeleton — endpoints se implementan en E2+

const express = require('express');
const router = express.Router();

// Health check E0
router.get('/health', (req, res) => {
  res.json({ module: 'events-staff', status: 'ok', phase: 'E0' });
});

module.exports = router;
