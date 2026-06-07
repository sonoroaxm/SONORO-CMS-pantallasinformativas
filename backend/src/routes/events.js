// Events v1 — Rutas autenticadas (organizador / productor)
// Requiere: authenticateToken (JWT CMS estándar)
// Fase: E0 skeleton — endpoints se implementan en E1+

const express = require('express');
const router = express.Router();

// Health check E0
router.get('/health', (req, res) => {
  res.json({ module: 'events', status: 'ok', phase: 'E0' });
});

module.exports = router;
