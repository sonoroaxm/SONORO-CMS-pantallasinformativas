/**
 * withTransaction — helper transaccional único para SONORO Queue v2.
 *
 * Define el patrón obligatorio del Framework Queue v2 (sección 3.1).
 * Toda mutación que toque ≥2 filas o ≥2 tablas en endpoints de Queue v2
 * DEBE ejecutarse a través de este helper.
 *
 * El callback recibe un `client` (PoolClient) — usar SIEMPRE `client.query(...)`
 * dentro de la transacción, nunca `pool.query(...)`.
 *
 * Si `fn` lanza, se hace ROLLBACK y se re-lanza el error original.
 * Si `fn` resuelve, se hace COMMIT y se devuelve el valor.
 * En ambos casos el client se libera al pool.
 *
 * Patrón de uso:
 *
 *   const { withTransaction } = require('./db/withTransaction');
 *
 *   const token = await withTransaction(pool, async (client) => {
 *     const cap = await client.query('SELECT ... FOR UPDATE', [...]);
 *     const ins = await client.query('INSERT ... RETURNING *', [...]);
 *     return ins.rows[0];
 *   });
 *
 * Prohibido en Queue v2: llamar `pool.connect()` directo fuera de este módulo.
 */

async function withTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('withTransaction: primer argumento debe ser un Pool válido');
  }
  if (typeof fn !== 'function') {
    throw new Error('withTransaction: segundo argumento debe ser una función async');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('❌ ROLLBACK falló tras error:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
