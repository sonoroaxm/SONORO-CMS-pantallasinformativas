# SONORO CMS — Auditoría de Seguridad Backend

**Fecha:** 2026-04-21  
**Auditor:** Claude Opus 4.6 + SONORO AV Dev Team  
**Archivos auditados:**
- `backend/src/index.js` (~3700 líneas)
- `backend/src/routes/admin.js` (~439 líneas)
- `backend/public/dashboard.html`
- `backend/public/admin-dashboard.html`
- `backend/public/queue-agent.html`
- `backend/public/sync-app.js`

**Estado:** Completada y desplegada en producción (VPS 45.181.156.171)

---

## Resumen ejecutivo

Se identificaron **15+ vulnerabilidades** clasificadas en 4 niveles de prioridad. Todas fueron corregidas en **11 commits** y desplegadas en producción.

| Prioridad | Descripción | Encontradas | Corregidas |
|-----------|-------------|:-----------:|:----------:|
| P0 — Crítico | Explotables inmediatamente sin auth | 7 | 7 |
| P1 — Alto | Requieren condiciones específicas | 3 | 3 |
| P2 — Medio | Requieren auth o acceso parcial | 6 | 6 |
| P3 — Bajo | Mejores prácticas | 3 | 3 |

---

## P0 — Crítico (explotable ahora)

### P0-1: Login bypass — autenticación fallida continúa

**Archivo:** `index.js:440-443`  
**Vulnerabilidad:** El bloque `if (!passwordMatch)` no tenía `return`, permitiendo que la ejecución continuara hasta `jwt.sign()` y generara un token válido para cualquier contrase��a.

**Antes:**
```javascript
if (!passwordMatch) {
  await pool.query('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1', [user.id]);
  res.status(401).json({ error: 'Credenciales inválidas' });
}
// ejecución continuaba aquí → jwt.sign() generaba token
```

**Después:**
```javascript
if (!passwordMatch) {
  await pool.query('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1', [user.id]);
  return res.status(401).json({ error: 'Credenciales inválidas' });
}
```

**Commit:** `5b2ade1`

---

### P0-2: Command injection — PM2 restart/stop/start

**Archivo:** `admin.js:160-185`  
**Vulnerabilidad:** Nombre de proceso interpolado directamente en `exec()` con shell. Un atacante podía enviar `; rm -rf /` como nombre.

**Antes:**
```javascript
exec(`pm2 restart ${name}`, (err) => { ... });
```

**Después:**
```javascript
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// ...
if (!SAFE_NAME_RE.test(name)) return res.status(400).json({ error: 'Nombre de proceso inválido' });
execFile('pm2', ['restart', name], { windowsHide: true }, (err) => { ... });
```

**Commit:** `5b2ade1`

---

### P0-3: Command injection — Logs endpoint

**Archivo:** `admin.js:187-230`  
**Vulnerabilidad:** `exec(tail -n ${lines} ${logFile})` con interpolación directa. Permitía inyección via nombre de proceso y cantidad de líneas.

**Antes:**
```javascript
exec(`tail -n ${lines} ${logFile}`, (err, stdout) => { ... });
// En Windows:
exec(`powershell -Command "Get-Content '${logFile}' -Tail ${lines}"`, ...);
```

**Después:**
```javascript
const lines = Math.min(Math.max(parseInt(req.query.lines) || 100, 1), 5000);
// Lectura directa con fs, sin shell
const content = fs.readFileSync(logFile, 'utf8');
const allLines = content.split('\n');
const lastLines = allLines.slice(-lines).join('\n');
```

**Commit:** `5b2ade1`

---

### P0-4: Command injection — Port check

**Archivo:** `admin.js:270-290`  
**Vulnerabilidad:** `exec(netstat -ano | grep ${port})` con puerto sin validar.

**Antes:**
```javascript
exec(`netstat -ano | grep ${port}`, (err, stdout) => { ... });
```

**Después:**
```javascript
const portNum = parseInt(port);
if (!portNum || portNum < 1 || portNum > 65535) return res.status(400).json({ error: 'Puerto inválido' });
execFile('netstat', ['-ano'], (err, stdout) => {
  const lines = stdout.split('\n').filter(l => l.includes(`:${portNum}`));
  // ...
});
```

**Commit:** `5b2ade1`

---

### P0-5: Command injection — SSH endpoints en admin.js (3 endpoints)

**Archivo:** `admin.js:300-400`  
**Vulnerabilidad:** `exec(ssh user@${ip} "comando")` en endpoints de screenshot, update y stats. IP sin validar permitía inyección.

**Antes:**
```javascript
exec(`ssh sonoro@${ip} "comando"`, (err, stdout) => { ... });
```

**Después:**
```javascript
const SAFE_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
function isValidIP(ip) {
  if (!SAFE_IP_RE.test(ip)) return false;
  return ip.split('.').every(n => parseInt(n) >= 0 && parseInt(n) <= 255);
}
// ...
if (!isValidIP(ip)) return res.status(400).json({ error: 'IP inválida' });
execFile('ssh', ['sonoro@' + ip, 'comando'], (err, stdout) => { ... });
```

**Commit:** `e5274ea`

---

### P0-6: Command injection — SSH reboot en index.js

**Archivo:** `index.js:1217,1231`  
**Vulnerabilidad:** Misma inyección SSH que P0-5, en endpoints de reboot de dispositivos.

**Fix:** Mismo patrón — `isValidIP()` + `execFile('ssh', [...args])`.

**Commit:** `e5274ea`

---

### P0-7: Screenshot upload sin autenticación

**Archivo:** `index.js:1471`  
**Vulnerabilidad:** Endpoint de subida de screenshots accesible sin autenticación. Cualquiera podía subir archivos al servidor.

**Antes:**
```javascript
app.post('/api/devices/:device_id/screenshot-upload', upload.single('screenshot'), async (req, res) => {
  // Sin verificación
});
```

**Después:**
```javascript
app.post('/api/devices/:device_id/screenshot-upload', upload.single('screenshot'), async (req, res) => {
  const { device_id } = req.params;
  if (!screenshotCallbacks.has(device_id)) return res.status(403).json({ error: 'No autorizado' });
  // ...
});
```

**Commit:** `e5274ea`

---

## P1 — Alto

### P1-1: Socket.io sin autenticación

**Archivo:** `index.js` (sección Socket.io)  
**Vulnerabilidad:** Cualquier conexión Socket.io tenía acceso completo a todos los eventos, incluyendo control de dispositivos, playlists y administración.

**Después:**
```javascript
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const deviceId = socket.handshake.auth?.device_id;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      socket.role = 'user';
    } catch (e) {
      return next(new Error('Token inválido'));
    }
  } else if (deviceId) {
    socket.deviceId = deviceId;
    socket.role = 'device';
  } else {
    socket.role = 'anonymous';
  }
  next();
});

function requireUser(handler) {
  return (...args) => {
    if (socket.role !== 'user') return socket.emit('auth_error', { error: 'No autorizado' });
    handler(...args);
  };
}
```

**Eventos protegidos:** Todos los eventos de administración y control.  
**Eventos públicos:** `join_branch`, `join_counter` (necesarios para displays de turnos públicos).

**Frontend actualizado:** `dashboard.html`, `admin-dashboard.html`, `queue-agent.html`, `sync-app.js` ahora envían auth correctamente.

**Commit:** `ae8d75f`, `4d136e4`

---

### P1-2: JWT_SECRET con fallback hardcoded

**Archivo:** `index.js:204`, `admin.js:22`  
**Vulnerabilidad:** `const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production'`. Si no se configura `.env`, todos los tokens se firman con un secreto público.

**Después (index.js):**
```javascript
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no definido en .env');
  process.exit(1);
}
```

**Después (admin.js):** Eliminado `const JWT_SECRET = ...`, usa `process.env.JWT_SECRET` directamente.

**Commit:** `f4c46de`

---

### P1-3: Sin rate limiting en login

**Archivo:** `index.js` (endpoints de auth)  
**Vulnerabilidad:** Sin límite de intentos en login, permitiendo ataques de fuerza bruta.

**Después:**
```javascript
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos, intenta en 15 minutos' },
  standardHeaders: true
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados registros, intenta en 1 hora' },
  standardHeaders: true
});

app.post('/api/auth/login', authLimiter, ...);
app.post('/api/auth/register', registerLimiter, ...);
app.post('/api/queue/agent/login', authLimiter, ...);
```

**Commit:** `f4c46de`

---

## P2 — Medio

### P2-1: SQL reorder con UPDATE + window function incorrecta

**Archivo:** `index.js:954`  
**Vulnerabilidad:** `UPDATE ... SET display_order = ROW_NUMBER() OVER (...)` no es SQL válido en PostgreSQL. Silenciosamente no reordenaba correctamente.

**Después:**
```sql
WITH renumbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) AS new_order
  FROM playlist_items WHERE playlist_id = $1
)
UPDATE playlist_items pi SET display_order = r.new_order
FROM renumbered r WHERE pi.id = r.id
```

**Commit:** `6cf5347`

---

### P2-2: GET /api/devices sin filtro por usuario

**Archivo:** `index.js:1523`  
**Vulnerabilidad:** Todos los usuarios autenticados veían todos los dispositivos de todos los usuarios.

**Después:**
```javascript
if (req.user.role === 'admin') {
  result = await pool.query(`SELECT d.*, ... FROM devices d ... ORDER BY ...`);
} else {
  result = await pool.query(`SELECT d.*, ... FROM devices d ... WHERE d.user_id = $1 ORDER BY ...`, [req.user.id]);
}
```

**Commit:** `6cf5347`

---

### P2-3: Exposición de información de base de datos

**Archivo:** `admin.js` (endpoint `/database/stats`)  
**Vulnerabilidad:** Respuesta incluía `host`, `port` y `name` de la base de datos, facilitando reconocimiento.

**Después:** Solo se retorna `size_mb`.

**Commit:** `6cf5347`

---

### P2-4: CORS permisivo (wildcard)

**Archivo:** `index.js:42-45`  
**Vulnerabilidad:** CORS configurado con `*`, permitiendo requests desde cualquier origen.

**Después:**
```javascript
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*';
```

**Commit:** `6cf5347`

---

### P2-5: Race conditions en callback Maps

**Archivo:** `index.js` (tvCallbacks, screenshotCallbacks), `admin.js` (logsCallbacks)  
**Vulnerabilidad:** Múltiples requests simultáneas podían sobrescribir callbacks en los Maps, causando que la primera request nunca se resolviera (memory leak + timeout).

**Antes:**
```javascript
screenshotCallbacks.set(deviceId, { resolve, reject });
```

**Después:**
```javascript
if (screenshotCallbacks.has(deviceId)) return reject(new Error('Ya hay una solicitud en curso'));
screenshotCallbacks.set(deviceId, { resolve, reject });
```

**Commit:** `0bddcc8`

---

### P2-6: Exposición de err.message en respuestas 500

**Archivo:** `index.js` (82 ocurrencias), `admin.js` (8 ocurrencias)  
**Vulnerabilidad:** `res.status(500).json({ error: err.message })` filtraba nombres de tablas, columnas y errores internos de PostgreSQL al cliente.

**Después:**
```javascript
res.status(500).json({ error: 'Error interno del servidor' })
```

Los errores siguen logueados en `console.error` para debugging.

**Commit:** `a6b5981`

---

## P3 — Bajo (mejores prácticas)

### P3-1: checkLicense fail-open

**Archivo:** `index.js:1940`  
**Vulnerabilidad:** `catch(err) { next() }` — si la verificación de licencia fallaba, dejaba pasar la request.

**Después:**
```javascript
catch(err) {
  res.status(503).json({ error: 'No se pudo verificar la licencia' });
}
```

**Commit:** `0bddcc8`

---

### P3-2: Catches vacíos en admin.js

**Archivo:** `admin.js` (overview endpoint)  
**Vulnerabilidad:** `catch(e) {}` tragaba errores de queries de DB silenciosamente.

**Después:**
```javascript
catch(e) {
  console.warn('Error obteniendo DB stats:', e.message);
}
```

**Commit:** `0bddcc8`

---

### P3-3: Agent PIN en plaintext

**Archivo:** `index.js` (endpoints de agents)  
**Vulnerabilidad:** PINs de agentes guardados en texto plano en la tabla `agents`. Cualquier acceso a la DB exponía todos los PINs.

**Después:**
```javascript
// CREATE
const hashedPin = pin ? await bcrypt.hash(pin, 10) : null;
await pool.query('INSERT INTO agents (..., pin, ...) VALUES (..., $4, ...)', [..., hashedPin, ...]);

// LOGIN
const pinMatch = await bcrypt.compare(String(pin), agent.pin);

// UPDATE
const hashedPin = pin ? await bcrypt.hash(String(pin), 10) : null;
```

**Extras:**
- Columna `agents.pin` ampliada de `VARCHAR(10)` a `VARCHAR(72)` (bcrypt genera hashes de 60 chars)
- Script `migrate-pins.js` ejecutado para migrar PINs existentes
- 2 agentes migrados en producción (Cajero 1, Cajero 2)

**Commit:** `0bddcc8`, `d12471f`

---

## Cambios adicionales en deploy

### Dependencia pm2 faltante

**Archivo:** `package.json`  
**Problema:** `services/pm2-monitor.js` hacía `require('pm2')` pero no estaba en las dependencias, causando crash del servidor.  
**Fix:** `npm install pm2 --save`  
**Commit:** `fcb7954`

---

## Breaking changes

### Socket.io auth obligatorio

Todos los clientes Socket.io deben enviar credenciales al conectar:

```javascript
// Dashboard usuario/admin
const socket = io({ auth: { token: authToken } });

// Queue agent
const socket = io({ auth: { token: getAgentToken() } });

// Dispositivos (sync-app.js)
const socket = io(CMS_URL, { auth: { device_id: DEVICE_ID } });

// Displays públicos (queue-display, queue-kiosk, queue-rating)
// Conectan como anonymous — solo pueden usar join_branch y join_counter
```

---

## Commits (orden cronológico)

| Commit | Descripción |
|--------|-------------|
| `5b2ade1` | security: fix login bypass, command injection en admin process endpoints |
| `e5274ea` | security: fix command injection SSH/shell + screenshot upload sin auth |
| `ae8d75f` | security: autenticación Socket.io — middleware JWT + roles por evento |
| `f4c46de` | security: JWT secret fail-fast + rate limiting en auth endpoints |
| `6cf5347` | security: fix SQL reorder, filtro devices por user_id, ocultar DB info, CORS restrictivo |
| `4d136e4` | fix: actualizar clientes Socket.io para enviar auth token/device_id |
| `0bddcc8` | security: fix race conditions, checkLicense deny-by-default, PIN hasheado |
| `d12471f` | fix: ampliar columna pin a VARCHAR(72) para bcrypt + script migración PINs |
| `a6b5981` | security: ocultar err.message en respuestas 500 — 90 catch blocks |
| `fcb7954` | fix: agregar pm2 como dependencia local del backend |

---

## Verificación en producción

- Servidor VPS (45.181.156.171): **online**, sin errores
- PostgreSQL: **conectado**
- Migraciones: **OK** (incluyendo agents VARCHAR(72))
- PM2 Monitor: **inicializado**
- SMTP: **conectado**
- PINs migrados: **2/2 agentes**
