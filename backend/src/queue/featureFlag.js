// Queue v2 — middleware de feature flag (G-1 criterio #7).
// Bloquea endpoints autenticados con JWT cuando el flag no está habilitado en
// users.features. El JWT trae features ya resueltas (ver authenticateToken).
// Debe colocarse INMEDIATAMENTE despues de authenticateToken — no antes:
// asume req.user poblado. Para endpoints duales (admin + kiosko via
// requireAdminOrKiosk) usar guard inline solo en el path admin.

function requireFeatureFlag(flag) {
  return function featureFlagGuard(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const enabled = req.user.features && req.user.features[flag] === true;
    if (!enabled) {
      return res.status(403).json({ error: 'FEATURE_DISABLED', feature: flag });
    }
    return next();
  };
}

module.exports = { requireFeatureFlag };
