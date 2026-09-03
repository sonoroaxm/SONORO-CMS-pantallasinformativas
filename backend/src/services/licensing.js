// LICENSES-V1 — helpers de licenciamiento
// Framework: docs/LICENSES-V1.md
// Estrategia dual-read: consulta primero tabla `licenses` (nueva); si no hay
// filas para el usuario, cae al legacy `users.license_status/license_end/license_type`
// para no romper usuarios pre-migración.

const PRODUCTS = ['smart_tv', 'windows', 'player'];

// Mapeo legacy → nuevo (mismo criterio que 2026-09-02-licenses-v1-data.sql)
const LEGACY_TYPE_TO_PRODUCT = {
  rpi: 'player',
  windows: 'windows',
  cms: 'player',
  cms_queue: 'player',
  queue: 'player',
  cms_sencilla: 'player',
  cms_doble: 'player',
  cms_pro: 'player',
};

// Resuelve estado de licencia efectivo para un usuario (opcionalmente para un device concreto).
// Devuelve shape estable para consumo desde middleware y endpoint /api/devices/:id/license.
async function resolveLicense(pool, { userId, deviceId = null }) {
  // 1) Nueva tabla `licenses` — filtro por device si aplica
  const params = [userId];
  let whereDevice = '';
  if (deviceId) {
    params.push(deviceId);
    whereDevice = 'AND (device_id = $2 OR device_id IS NULL)';
  }
  const q = await pool.query(
    `SELECT product, status, end_date, is_trial, trial_days
       FROM licenses
      WHERE user_id = $1
        AND status = 'active'
        ${whereDevice}
      ORDER BY end_date DESC NULLS LAST`,
    params
  );

  if (q.rows.length) {
    const now = Date.now();
    // Preferir fila con device_id exacto si existe; si no, la primera
    const preferred = deviceId
      ? (q.rows.find(r => r.device_id === deviceId) || q.rows[0])
      : q.rows[0];
    const endMs = preferred.end_date ? new Date(preferred.end_date).getTime() : null;
    const isExpired = endMs !== null && endMs < now;
    const daysLeft = endMs !== null
      ? Math.ceil((endMs - now) / (1000 * 60 * 60 * 24))
      : null;
    return {
      source: 'licenses',
      active: !isExpired,
      status: isExpired ? 'expired' : 'active',
      product: preferred.product,
      end_date: preferred.end_date,
      days_left: daysLeft,
      is_trial: !!preferred.is_trial,
      trial_days: preferred.trial_days || null,
    };
  }

  // 2) Fallback legacy — users.license_*
  const u = await pool.query(
    `SELECT license_status, license_end, license_type, role
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!u.rows.length) return null;
  const { license_status, license_end, license_type, role } = u.rows[0];

  // Admin bypass total — sin importar tabla o fallback
  if (role === 'admin') {
    return {
      source: 'admin_bypass',
      active: true,
      status: 'active',
      product: null,
      end_date: null,
      days_left: null,
      is_trial: false,
      trial_days: null,
    };
  }

  const now = Date.now();
  const endMs = license_end ? new Date(license_end).getTime() : null;
  const isExpired = endMs !== null && endMs < now;
  const daysLeft = endMs !== null
    ? Math.ceil((endMs - now) / (1000 * 60 * 60 * 24))
    : null;

  return {
    source: 'legacy_users',
    active: !isExpired && license_status === 'active',
    status: isExpired ? 'expired' : (license_status || 'unknown'),
    product: LEGACY_TYPE_TO_PRODUCT[license_type] || null,
    legacy_license_type: license_type,  // conservado por retrocompatibilidad
    end_date: license_end,
    days_left: daysLeft,
    is_trial: false,
    trial_days: null,
  };
}

// Lookup pricing_catalog para (product, currency)
async function getPricing(pool, product, currency) {
  const r = await pool.query(
    `SELECT monthly, annual, second_plus, hw_upfront, free_months
       FROM pricing_catalog
      WHERE product = $1 AND currency = $2`,
    [product, currency]
  );
  return r.rows[0] || null;
}

// Calcula precio con reglas LICENSES-V1 §2.2/2.3:
//   - 2ª+ licencia del mismo producto: usar second_plus como unit_price (equivale a −20%)
//   - Anual (12+ meses): −15% adicional sobre subtotal
//   - Player: hw_upfront cobrado aparte (año 1 en HW), free_months aplican al grant
//
// Args: { product, currency, months, annual, isSecondPlus }
// Retorna: { unit_price, discount_pct, amount, hw_upfront }
async function computePrice(pool, { product, currency, months, annual = false, isSecondPlus = false }) {
  const p = await getPricing(pool, product, currency);
  if (!p) throw new Error(`pricing_catalog: no rate for ${product}/${currency}`);

  const unitPrice = isSecondPlus ? Number(p.second_plus) : Number(p.monthly);
  let subtotal = unitPrice * months;
  let discountPct = 0;
  if (annual && months >= 12) {
    discountPct = 15;
    subtotal = subtotal * 0.85;
  }
  return {
    unit_price: Number(unitPrice.toFixed(2)),
    discount_pct: discountPct,
    amount: Number(subtotal.toFixed(2)),
    hw_upfront: Number(p.hw_upfront || 0),
    free_months: p.free_months || 0,
  };
}

// ¿El usuario ya usó su trial? (anti-abuso §1.6) — Fase 4: 1 trial por usuario total
async function hasUsedTrial(pool, userId /* , product */) {
  const r = await pool.query(
    `SELECT 1 FROM licenses WHERE user_id = $1 AND is_trial = TRUE LIMIT 1`,
    [userId]
  );
  return r.rows.length > 0;
}

// ¿Es "2ª+ del mismo producto"? Cuenta licencias no-trial existentes del usuario para ese product
async function isSecondPlusForProduct(pool, userId, product) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM licenses
      WHERE user_id = $1 AND product = $2 AND is_trial = FALSE`,
    [userId, product]
  );
  return r.rows[0].n >= 1;
}

module.exports = {
  PRODUCTS,
  LEGACY_TYPE_TO_PRODUCT,
  resolveLicense,
  getPricing,
  computePrice,
  hasUsedTrial,
  isSecondPlusForProduct,
};
