
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const eventsRouter       = require('./routes/events');
const eventsPublicRouter = require('./routes/events-public');
const eventsProductionPublicRouter = require('./routes/events-production-public');
const eventsStaffRouter  = require('./routes/events-staff');
const { exec, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const SAFE_IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
function isValidIP(ip) {
  if (!SAFE_IP_RE.test(ip)) return false;
  return ip.split('.').every(n => parseInt(n) >= 0 && parseInt(n) <= 255);
}
const emailService = require('./services/email');
const { withTransaction } = require('./db/withTransaction');
const queueSerializers = require('./queue/serializers');
const queueValidation  = require('./queue/validation');
const queueSlots       = require('./queue/slots');
const queueTimeBlocks  = require('./queue/timeBlocks');
const { requireFeatureFlag } = require('./queue/featureFlag');


// INICIALIZAR PM2 MONITOR (NUEVO)
// ========================================
const pm2Monitor = require('./services/pm2-monitor');

// Inicializar monitor
pm2Monitor.init().then(() => {
  console.log('✅ PM2 Monitor inicializado');
}).catch(err => {
  console.warn('⚠️  PM2 Monitor no disponible:', err.message);
});

// ⭐ IMPORTAR COLA DE CONVERSION (ACTUALIZADO)
const { videoConversionQueue, addConversionJob, getJobStatus, getQueueStats } = require('./queues/videoConversionQueue');



const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
if (!ALLOWED_ORIGINS.length && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  ALLOWED_ORIGINS no configurado en producción — CORS abierto a todos los orígenes');
}
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
  maxHttpBufferSize: 10e6
});

// ⭐ GUARDAR IO EN GLOBAL PARA QUE LA COLA PUEDA EMITIR EVENTOS
global.io = io;

// Mapa de callbacks pendientes de screenshot por device_id
const screenshotCallbacks = new Map();

// Mapa de callbacks pendientes de TV control por device_id
const tvCallbacks = new Map();

// Funcion TV control via Socket.io + HTTP result
// target: 'tv1' (cec0) | 'tv2' (cec1) | 'all' (ambos, default)
async function doTV(deviceId, action, target = 'all') {
  console.log(`📺 TV ${action}:${target} -> ${deviceId} via Socket.io`);
  return new Promise((resolve, reject) => {
    if (tvCallbacks.has(deviceId)) {
      return reject(new Error('Ya hay una operación TV pendiente para este dispositivo'));
    }
    const timeout = setTimeout(() => {
      tvCallbacks.delete(deviceId);
      reject(new Error(`TV timeout — RPi no respondio en 45s`));
    }, 45000);
    tvCallbacks.set(deviceId, { resolve, reject, timeout, action });
    io.to(`device_${deviceId}`).emit('tv_request', { device_id: deviceId, action, target });
  });
}

// ========================================
// MIDDLEWARE
// ========================================
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload({
  limits: { fileSize: 500 * 1024 * 1024 },
  abortOnLimit: true
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// ✅ Servir uploads con CORS correcto
app.use('/uploads', express.static('uploads', {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.mp4') || filepath.endsWith('.webm')) {
      res.set('Content-Type', 'video/mp4');
      res.set('Accept-Ranges', 'bytes');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'public, max-age=86400');
    } else if (filepath.endsWith('.jpg') || filepath.endsWith('.jpeg') || filepath.endsWith('.png')) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos, intenta en 15 minutos' },
  standardHeaders: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados registros, intenta en 1 hora' },
  standardHeaders: true,
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos, intenta en 1 hora' },
  standardHeaders: true,
});

const activateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de activación, intenta en 15 minutos' },
  standardHeaders: true,
});

// Limiter para endpoints públicos del player (sin JWT) — generoso para sync legítimo,
// restrictivo para enumeración de IDs
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, reintenta en un momento' },
});

const publicBookingCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de agendamiento, reintenta en un momento' },
});

const publicBookingDayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite diario de agendamientos alcanzado, reintenta mañana' },
});

const publicTokenActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, reintenta en un momento' },
});

const playerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas solicitudes, intenta en un momento' },
  standardHeaders: true,
});

const registerDeviceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Demasiados registros de dispositivo, intenta en 15 minutos' },
  standardHeaders: true,
});

console.log('✅ Dashboard: http://localhost:5000/dashboard.html');
console.log('✅ Uploads: http://localhost:5000/uploads/');

// ========================================
// DATABASE (CON POOL - CONEXIONES MÚLTIPLES)
// ========================================
if (!process.env.DB_PASSWORD) {
  console.error('❌ FATAL: DB_PASSWORD no definido en .env');
  process.exit(1);
}
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'cms_signage',
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('connect', () => {
  console.log('🟢 Nueva conexión a PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Error en Pool:', err);
});

pool.query('SELECT 1')
  .then(() => {
    console.log('🗄️ PostgreSQL conectado');
    return pool.query(`
      ALTER TABLE counters ADD COLUMN IF NOT EXISTS rating_enabled BOOLEAN DEFAULT true
    `);
  })
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS tv_schedules (
      id          SERIAL PRIMARY KEY,
      device_id   VARCHAR(100) NOT NULL,
      days        TEXT[]       NOT NULL DEFAULT '{}',
      time_on     TIME         NOT NULL DEFAULT '08:00',
      time_off    TIME         NOT NULL DEFAULT '22:00',
      active      BOOLEAN      NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS content (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title               VARCHAR(255) NOT NULL,
      type                VARCHAR(20) NOT NULL,
      filename            VARCHAR(255),
      file_path           VARCHAR(500),
      thumbnail_path      VARCHAR(500),
      size_bytes          BIGINT DEFAULT 0,
      duration_ms         INTEGER DEFAULT 0,
      width               INTEGER,
      height              INTEGER,
      codec               VARCHAR(50),
      needs_conversion    BOOLEAN DEFAULT false,
      conversion_status   VARCHAR(20) DEFAULT 'none',
      uploaded_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS playlist_items (
      id                   SERIAL PRIMARY KEY,
      playlist_id          INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
      content_id           INTEGER REFERENCES content(id) ON DELETE CASCADE,
      display_order        INTEGER DEFAULT 0,
      duration_override_ms INTEGER,
      CONSTRAINT playlist_items_playlist_content_unique UNIQUE (playlist_id, content_id)
    )
  `))
  .then(() => pool.query(`
    ALTER TABLE playlists
      ADD COLUMN IF NOT EXISTS user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS description   TEXT,
      ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS shuffle_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS repeat_enabled  BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS orientation   VARCHAR(20) DEFAULT 'horizontal'
  `))
  .then(() => pool.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS hdmi0_playlist_id   INTEGER,
      ADD COLUMN IF NOT EXISTS hdmi1_playlist_id   INTEGER,
      ADD COLUMN IF NOT EXISTS display_mode        VARCHAR(20) DEFAULT 'mirror',
      ADD COLUMN IF NOT EXISTS branch_id           UUID,
      ADD COLUMN IF NOT EXISTS tv_status           VARCHAR(20) DEFAULT 'unknown'
  `))
  .then(() => pool.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ
  `))
  .then(() => pool.query(`
    ALTER TABLE branches
      ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb
  `))
  .then(() => pool.query(`
    ALTER TABLE agents ALTER COLUMN pin TYPE VARCHAR(72)
  `).catch(() => {}))
  .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token      VARCHAR(128) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `))
  // S157: quota de almacenamiento por usuario. NULL = ilimitado (super admin).
  .then(() => pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_limit_mb INTEGER DEFAULT 500
  `))
  .then(() => pool.query(`
    UPDATE users SET storage_limit_mb = NULL WHERE email = 'admin@sonoro.com.co'
  `).catch(() => {}))
  // S157: tracking de tamaño en tablas de assets de CI (todavía no funcionales, pero preparadas)
  .then(() => pool.query(`
    ALTER TABLE product_assets ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE creative_pieces ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0
  `).catch(() => {}))
  // S158: normalizar tier 'cms' viejo → 'cms_sencilla' (una sola vez, aditivo)
  .then(() => pool.query(`
    UPDATE users SET license_type = 'cms_sencilla' WHERE license_type = 'cms'
  `).catch(() => {}))
  // S158e: phone en users (para contacto post-alta)
  .then(() => pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)
  `).catch(() => {}))
  // S176: orientación del contenido (detectada automáticamente al encodar HEVC)
  .then(() => pool.query(`
    ALTER TABLE content ADD COLUMN IF NOT EXISTS orientation VARCHAR(20) DEFAULT 'horizontal'
  `).catch(() => {}))
  // S176: ampliar CHECK constraint hevc_status para incluir 'uploading' y 'error'
  .then(() => pool.query(`
    ALTER TABLE content DROP CONSTRAINT IF EXISTS content_hevc_status_check
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE content ADD CONSTRAINT content_hevc_status_check
      CHECK (hevc_status IN ('uploading','pending','processing','ready','failed','not_applicable','error'))
  `).catch(() => {}))
  .then(() => console.log('✅ Migraciones OK (counters + tv_schedules + content + playlist_items + playlists + devices + branches + agents + password_reset_tokens + storage_limit_mb + size_bytes CI + cms_tier_normalize + content_orientation)'))
  .catch(err => console.error('❌ Error PostgreSQL:', err));
emailService.verifyConnection();


// GUARDAR POOL EN GLOBAL PARA ADMIN ROUTES (NUEVO)
global.pool = pool;

// ========================================
// CONFIGURACIÓN JWT
// ========================================
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET no definido en .env');
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.error('❌ FATAL: JWT_SECRET debe tener mínimo 32 caracteres');
  process.exit(1);
}
const JWT_EXPIRES_IN = '24h';

// ========================================
// MIDDLEWARE DE AUTENTICACIÓN
// ========================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('❌ Token inválido:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  });
}

// Validador del kiosko (Queue v2 R1 §2.6 — auth por X-Branch-Token).
// Resuelve la branch a partir del UUID en el header y la deja en req.branch.
// Anti-enumeración (D5 sesión 66): 401 si header ausente, malformado o no
// encuentra branch activa. La diferenciación de "no encontrado" vs "encontrado
// pero fuera de horario / sin appointment" se delega al endpoint para que el
// 401 cubra solo "credencial inválida" y todo el resto sea 200 {confirmed:false}.
const KIOSK_TOKEN_HEADER = 'x-branch-token';
function validateKioskToken(req, res, next) {
  const headerVal = req.headers[KIOSK_TOKEN_HEADER];
  const token = typeof headerVal === 'string' ? headerVal.trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  pool.query(
    `SELECT id, user_id, name, timezone, open_time, close_time,
            operation_mode, appointments_enabled, queue_enabled, active
       FROM branches
      WHERE kiosk_token = $1
      LIMIT 1`,
    [token]
  ).then((r) => {
    if (r.rowCount === 0 || r.rows[0].active === false) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.branch = r.rows[0];
    next();
  }).catch((err) => {
    console.error('❌ validateKioskToken:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  });
}

// Resuelve el modo de autenticación de un endpoint dual (admin + kiosko).
// Si llega X-Branch-Token, valida como kiosko (req.branch). En caso contrario,
// cae a authenticateToken (req.user). Solo uno de los dos termina seteado.
function requireAdminOrKiosk(req, res, next) {
  if (typeof req.headers[KIOSK_TOKEN_HEADER] === 'string') {
    return validateKioskToken(req, res, next);
  }
  return authenticateToken(req, res, next);
}

// ========================================
// FUNCIONES DE UTILIDAD
// ========================================

async function getVideoCodec(filepath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filepath
    ], { windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error('No se pudo detectar codec')); return; }
      resolve(stdout.trim().toLowerCase());
    });
  });
}

async function getVideoDimensions(filepath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      filepath
    ], { windowsHide: true }, (error, stdout) => {
      if (error) { resolve({ width: 1920, height: 1080 }); return; }
      const parts = stdout.trim().split('x');
      resolve({ width: parseInt(parts[0]) || 1920, height: parseInt(parts[1]) || 1080 });
    });
  });
}

async function getVideoDuration(filepath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filepath
    ], { windowsHide: true }, (error, stdout) => {
      if (error) { reject(new Error('No se pudo obtener duración')); return; }
      resolve(Math.round(parseFloat(stdout) * 1000));
    });
  });
}

async function convertVideoToH264(inputPath, outputPath, timeoutMs = 7200000) {
  const { width, height } = await getVideoDimensions(inputPath);
  const isVertical = height > width;

  const scaleFilter = isVertical
    ? "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2"
    : "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2";

  console.log(`🎬 Iniciando conversión: ${inputPath}`);
  console.log(`📐 Dimensiones: ${width}x${height} → modo ${isVertical ? 'VERTICAL' : 'HORIZONTAL'}`);

  return new Promise((resolve, reject) => {
    const ffmpegBin = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
    const child = execFile(ffmpegBin, [
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast', '-profile:v', 'baseline', '-level', '4.1',
      '-vf', scaleFilter,
      '-b:v', '4000k', '-maxrate', '4000k', '-bufsize', '8000k',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outputPath
    ], { windowsHide: true }, (error) => {
      if (error) {
        console.error('❌ Error conversión:', error);
        reject(new Error('Error convertiendo video'));
        return;
      }
      console.log('✅ Conversión completada:', outputPath);
      resolve(outputPath);
    });

    const timeoutHandle = setTimeout(() => {
      console.warn(`⏱️ Timeout en conversión (${timeoutMs}ms)`);
      child.kill();
      reject(new Error('Conversión excedió tiempo límite'));
    }, timeoutMs);

    child.on('exit', () => {
      clearTimeout(timeoutHandle);
    });
  });
}
function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve) => {
    execFile('ffmpeg', [
      '-i', videoPath, '-ss', '1', '-vframes', '1',
      '-vf', 'scale=320:180', '-q:v', '5', '-y', thumbnailPath
    ], { windowsHide: true }, (error) => {
      if (error) {
        console.warn('⚠️ No se pudo generar thumbnail:', error.message);
        resolve(null);
        return;
      }
      console.log('📸 Thumbnail generado:', thumbnailPath);
      resolve(thumbnailPath);
    });
  });
}

function needsConversion(codec) {
  const supportedCodecs = ['h264', 'h.264', 'avc1'];
  return !supportedCodecs.includes(codec);
}

// ========================================
// RUTAS PÚBLICAS
// ========================================

app.get('/', (req, res) => {
  res.json({
    message: 'CMS Signage Backend v2.1 - Con autenticación JWT',
    version: '2.1',
    features: [
      'Autenticación JWT',
      'Conversión automática de videos',
      'Soporte para H.264, H.265, VP9, AV1',
      'Generación de thumbnails',
      'Metadata de videos'
    ]
  });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      database: 'cms_signage',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: 'DB connection failed' });
  }
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ========================================
// AUTENTICACIÓN - LOGIN
// ========================================

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  // S158d: register público cerrado. Las cuentas ahora se crean sólo por admin.
  return res.status(403).json({
    error: 'registro_cerrado',
    message: 'El registro público está deshabilitado. Contacta a SONORO por WhatsApp al +57 314 446 0990 para activar tu cuenta.'
  });
  // eslint-disable-next-line no-unreachable
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' });
    }

    // Verificar que no exista
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email ya registrado' });
    }

    // Hash de contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insertar usuario — features vacías por defecto (admin las asigna luego)
    const defaultFeatures = { turnos: false, analytics: false, dual_hdmi: false, onpremise: false };
    const result = await pool.query(
      `INSERT INTO users (email, password, name, features)
       VALUES ($1, $2, $3, $4) RETURNING id, email, name, features`,
      [email, hashedPassword, name || email, JSON.stringify(defaultFeatures)]
    );

    const user = result.rows[0];

    // Generar JWT
    const regFeatures = user.role === 'admin' ? { turnos: true, analytics: true, dual_hdmi: true } : (user.features || { turnos: false, analytics: false, dual_hdmi: false });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, features: regFeatures },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`✅ Usuario registrado: ${email}`);
    // S158: el email de bienvenida ya NO se envía en el register.
    // Se dispara cuando el admin asigna la primera licencia (endpoint /license/renew).

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, features: regFeatures }
    });
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' });
    }

    // Buscar usuario
    const result = await pool.query('SELECT id, email, password, name, role, features FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const user = result.rows[0];

    // Verificar contraseña
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    // Generar JWT
    const loginFeatures = user.role === 'admin' ? { turnos: true, analytics: true, ...(user.features || {}) } : (user.features || { turnos: false, analytics: false });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, features: loginFeatures },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`✅ Login exitoso: ${email}`);

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, features: loginFeatures }
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// RECUPERACIÓN DE CONTRASEÑA
// ========================================

app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requerido' });
    const result = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, token, expiresAt]
      );
      const resetLink = `${process.env.CMS_URL}/reset-password.html?token=${token}`;
      await emailService.sendPasswordResetEmail(user, resetLink);
      console.log(`🔐 Reset password solicitado: ${email}`);
    }
    res.json({ message: 'Si el email está registrado, recibirás las instrucciones en tu correo' });
  } catch (err) {
    console.error('❌ Error forgot-password:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/reset-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token y contraseña requeridos' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres' });
    const result = await pool.query(
      'SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = $1',
      [token]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Enlace inválido o expirado' });
    const row = result.rows[0];
    if (row.used) return res.status(400).json({ error: 'Este enlace ya fue utilizado' });
    if (new Date() > new Date(row.expires_at)) return res.status(400).json({ error: 'El enlace ha expirado, solicita uno nuevo' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, row.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [row.id]);
    console.log(`✅ Contraseña restablecida user_id=${row.user_id}`);
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('❌ Error reset-password:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// STORAGE QUOTA — S157
// ========================================

// Suma bytes usados por el usuario en todas las tablas de assets.
// NULL en storage_limit_mb = ilimitado (super admin).
async function getUserStorage(userId) {
  const q = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(size_bytes),0) FROM content         WHERE user_id = $1) +
      (SELECT COALESCE(SUM(size_bytes),0) FROM fids_media      WHERE user_id = $1) +
      (SELECT COALESCE(SUM(size_bytes),0) FROM product_assets  WHERE user_id = $1) +
      (SELECT COALESCE(SUM(size_bytes),0) FROM creative_pieces WHERE user_id = $1) AS used_bytes,
      (SELECT storage_limit_mb FROM users WHERE id = $1) AS limit_mb
  `, [userId]);
  const row = q.rows[0] || { used_bytes: 0, limit_mb: 500 };
  const usedBytes = Number(row.used_bytes) || 0;
  const limitMb = row.limit_mb; // puede ser null
  const limitBytes = limitMb === null || limitMb === undefined ? null : limitMb * 1024 * 1024;
  const percent = limitBytes === null ? 0 : Math.min(100, Math.round((usedBytes / limitBytes) * 100));
  return { used_bytes: usedBytes, limit_mb: limitMb, limit_bytes: limitBytes, percent, unlimited: limitBytes === null };
}

// Endpoint público para el dashboard
app.get('/api/user/storage', authenticateToken, async (req, res) => {
  try {
    const info = await getUserStorage(req.user.id);
    res.json({
      used_mb: Math.round(info.used_bytes / 1024 / 1024 * 10) / 10,
      used_bytes: info.used_bytes,
      limit_mb: info.limit_mb,
      percent: info.percent,
      unlimited: info.unlimited
    });
  } catch (err) {
    console.error('❌ Error /api/user/storage:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// S158: GET /api/user/me — perfil del usuario logeado (Mi Cuenta)
app.get('/api/user/me', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT id, email, name, role, license_type, license_status, license_start, license_end, created_at, features
      FROM users WHERE id = $1
    `, [req.user.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const u = q.rows[0];
    const storage = await getUserStorage(u.id);
    const now = new Date();
    const end = u.license_end ? new Date(u.license_end) : null;
    const daysLeft = end ? Math.ceil((end - now) / (1000*60*60*24)) : null;
    const isExpired = end ? end < now : false;
    res.json({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      license_type: u.license_type,
      license_status: isExpired ? 'expired' : (u.license_status || 'active'),
      license_start: u.license_start,
      license_end: u.license_end,
      days_left: daysLeft,
      is_expired: isExpired,
      created_at: u.created_at,
      features: u.features || {},
      storage: {
        used_mb: Math.round(storage.used_bytes / 1024 / 1024 * 10) / 10,
        limit_mb: storage.limit_mb,
        percent: storage.percent,
        unlimited: storage.unlimited
      }
    });
  } catch (err) {
    console.error('❌ Error /api/user/me:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// S158: POST /api/user/change-password — cambio de contraseña propia
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Faltan campos' });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    const q = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const ok = await bcrypt.compare(current_password, q.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    console.log(`🔐 Password cambiado por usuario ${req.user.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error /api/user/change-password:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ========================================
// UPLOAD CON CONVERSIÓN (PROTEGIDO)
// ========================================

app.post('/api/content/upload', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.files.file;
    const userId = req.user.id; // ✅ DEL JWT

    // S157: gate de quota antes de aceptar el upload
    try {
      const storage = await getUserStorage(userId);
      if (!storage.unlimited) {
        const incomingBytes = file.size || 0;
        if (storage.used_bytes + incomingBytes > storage.limit_bytes) {
          const usedMb = Math.round(storage.used_bytes / 1024 / 1024 * 10) / 10;
          return res.status(413).json({
            error: 'storage_limit_exceeded',
            message: `Has alcanzado tu límite de ${storage.limit_mb} MB. Elimina contenido o contacta a SONORO para ampliar tu espacio.`,
            used_mb: usedMb,
            limit_mb: storage.limit_mb,
            incoming_mb: Math.round(incomingBytes / 1024 / 1024 * 10) / 10
          });
        }
      }
    } catch (qErr) {
      console.warn('⚠️ Storage quota check falló, permitiendo upload:', qErr.message);
    }

    const allowedMimes = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'image/jpeg', 'image/png']);

    if (!allowedMimes.has(file.mimetype)) {
      return res.status(400).json({
        error: 'Tipo de archivo no soportado',
        supported: 'Videos (MP4, WebM, MOV, MKV) o Imágenes (JPG, PNG)'
      });
    }

    // Crear directorio
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const processDir = path.join(uploadsDir, 'processing');
    if (!fs.existsSync(processDir)) {
      fs.mkdirSync(processDir, { recursive: true });
    }

    const fileId = uuidv4();
    const tempFilename = `temp-${fileId}-${file.name}`;
    const tempPath = path.join(processDir, tempFilename);

    // Guardar temporal
    await file.mv(tempPath);
    console.log('✅ Archivo temporal guardado:', tempFilename);

    // Responder inmediatamente
    res.json({
      success: true,
      message: 'Archivo recibido. Procesando...',
      fileId: fileId,
      status: 'processing'
    });

    // PROCESAMIENTO EN BACKGROUND
    if (file.mimetype.startsWith('image')) {
      handleImageUpload(tempPath, fileId, file.name, userId);
      return;
    }

    if (file.mimetype.startsWith('video') || file.mimetype === 'video/quicktime' || file.mimetype.includes('matroska')) {
      handleVideoUpload(tempPath, fileId, file.name, userId);
      return;
    }

  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

async function handleImageUpload(tempPath, fileId, originalName, userId) {
  try {
    // Validar dimensiones FHD antes de guardar
    const imgDims = await new Promise((res) => {
      const probe = require('child_process').spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0', tempPath
      ], { stdio: 'pipe' });
      let out = '';
      probe.stdout.on('data', d => { out += d.toString(); });
      probe.on('exit', () => {
        const parts = out.trim().split(',');
        res({ w: parseInt(parts[0]) || 0, h: parseInt(parts[1]) || 0 });
      });
      probe.on('error', () => res({ w: 0, h: 0 }));
    });
    const _ratioImg = imgDims.w / imgDims.h;
    const _is169Img = Math.abs(_ratioImg - 16/9) < 0.02;
    const _is916Img = Math.abs(_ratioImg - 9/16) < 0.02;
    if (!_is169Img && !_is916Img && imgDims.w > 0) {
      fs.unlink(tempPath, () => {});
      const _gcdImg = (a,b) => b ? _gcdImg(b, a%b) : a;
      const _dImg = _gcdImg(imgDims.w, imgDims.h);
      const _ratioStrImg = `${imgDims.w/_dImg}:${imgDims.h/_dImg}`;
      const dimMsg = `Imagen rechazada: tus dimensiones ${imgDims.w}x${imgDims.h} tienen relación ${_ratioStrImg}. Se requiere 16:9 horizontal (ej. 1920x1080, 3840x2160) o 9:16 vertical (ej. 1080x1920, 2160x3840).`;
      io.to('user_' + userId).emit('upload_error', { message: dimMsg });
      console.log('❌ Imagen rechazada por relación de aspecto: ' + imgDims.w + 'x' + imgDims.h);
      return;
    }

    const filename = `${Date.now()}-${originalName}`;
    const finalPath = path.join(process.cwd(), 'uploads', filename);

    fs.renameSync(tempPath, finalPath);

    const imgOrientation = imgDims.h > imgDims.w ? 'vertical' : 'horizontal';
    const result = await pool.query(
      `INSERT INTO content (user_id, title, type, filename, file_path, size_bytes, orientation)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [userId, originalName, 'image', filename, `/uploads/${filename}`, fs.statSync(finalPath).size, imgOrientation]
    );

    console.log('✅ Imagen procesada:', result.rows[0].id);

    // 📼 FIX3-IMG — marcar hevc_status='pending' si el usuario tiene al menos un RPi5
    try {
      const rpi5Check = await pool.query(
        "SELECT id FROM devices WHERE user_id=$1 AND model='rpi5' LIMIT 1",
        [userId]
      );
      if (rpi5Check.rows.length > 0) {
        await pool.query(
          "UPDATE content SET hevc_status='pending' WHERE id=$1",
          [result.rows[0].id]
        );
        console.log('📼 hevc_status=pending marcado para imagen id=' + result.rows[0].id + ' (user tiene RPi5)');
        setImmediate(runHevcWorker);
      }
    } catch (hevcMarkErr) {
      console.error('⚠️ Error marcando hevc_status pending (imagen):', hevcMarkErr.message);
    }

    io.emit('upload_complete', { success: true, content: result.rows[0], fileId });

  } catch (err) {
    console.error('❌ Error procesando imagen:', err);
    io.emit('upload_error', { error: err.message, fileId });
  }
}

async function handleVideoUpload(tempPath, fileId, originalName, userId) {
  try {
    console.log(`\n🎬 Procesando video: ${originalName}`);

    let codec = await getVideoCodec(tempPath);
    console.log(`📺 Codec detectado: ${codec}`);

    let duration = await getVideoDuration(tempPath);
    console.log(`⏱️ Duración: ${(duration / 1000).toFixed(2)}s`);

    // Detectar dimensiones del fuente para orientación (antes de conversión)
    const srcDimsVideo = await new Promise((res) => {
      const { spawn } = require('child_process');
      const probe = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0', tempPath
      ], { stdio: 'pipe' });
      let out = '';
      probe.stdout.on('data', d => { out += d.toString(); });
      probe.on('exit', () => {
        const parts = out.trim().split(',');
        res({ w: parseInt(parts[0]) || 1920, h: parseInt(parts[1]) || 1080 });
      });
      probe.on('error', () => res({ w: 1920, h: 1080 }));
    });
    const srcOrientation = srcDimsVideo.h > srcDimsVideo.w ? 'vertical' : 'horizontal';
    console.log(`📐 Dimensiones: ${srcDimsVideo.w}x${srcDimsVideo.h} → modo ${srcOrientation.toUpperCase()}`);

    // Validar relación de aspecto 16:9 / 9:16 (acepta hasta 4K)
    const _ratioVid = srcDimsVideo.w / srcDimsVideo.h;
    const _is169Vid = Math.abs(_ratioVid - 16/9) < 0.02;
    const _is916Vid = Math.abs(_ratioVid - 9/16) < 0.02;
    if (!_is169Vid && !_is916Vid) {
      fs.unlink(tempPath, () => {});
      const _gcdVid = (a,b) => b ? _gcdVid(b, a%b) : a;
      const _dVid = _gcdVid(srcDimsVideo.w, srcDimsVideo.h);
      const _ratioStrVid = `${srcDimsVideo.w/_dVid}:${srcDimsVideo.h/_dVid}`;
      const dimMsg = `Video rechazado: tus dimensiones ${srcDimsVideo.w}x${srcDimsVideo.h} tienen relación ${_ratioStrVid}. Se requiere 16:9 horizontal (ej. 1920x1080, 3840x2160) o 9:16 vertical (ej. 1080x1920, 2160x3840).`;
      io.to('user_' + userId).emit('upload_error', { message: dimMsg });
      console.log('❌ Video rechazado por relación de aspecto: ' + srcDimsVideo.w + 'x' + srcDimsVideo.h);
      return res.status(400).json({ success: false, message: dimMsg });
    }

    // Insertar en BD inmediatamente con hevc_status='uploading' para que la UI muestre feedback
    const placeholderFilename = `uploading-${fileId}.mp4`;
    const rpi5CheckEarly = await pool.query(
      "SELECT id FROM devices WHERE user_id=$1 AND model='rpi5' LIMIT 1", [userId]
    );
    const hasRpi5 = rpi5CheckEarly.rows.length > 0;
    const earlyResult = await pool.query(
      `INSERT INTO content (user_id, title, type, filename, file_path, size_bytes, duration_ms, hevc_status, orientation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId, originalName, 'video', placeholderFilename, '', fs.statSync(tempPath).size, duration,
       hasRpi5 ? 'uploading' : 'not_applicable', srcOrientation]
    );
    const contentId = earlyResult.rows[0].id;
    console.log('✅ Video pre-registrado en BD id=' + contentId + ' hevc_status=' + earlyResult.rows[0].hevc_status);

    // Emitir upload_complete inmediatamente para que la UI muestre el item con estado "Procesando"
    io.emit('upload_complete', {
      success: true,
      content: earlyResult.rows[0],
      fileId,
      codec,
      duration,
      thumbnail: null
    });

    let finalPath = tempPath;
    let finalFilename = `${Date.now()}-${originalName}`;

    if (needsConversion(codec)) {
      console.log(`⚠️ Video necesita conversión (${codec} → H.264)`);
      finalFilename = `converted-${fileId}.mp4`;
      const convertedPath = path.join(process.cwd(), 'uploads', finalFilename);
      await convertVideoToH264(tempPath, convertedPath);
      finalPath = convertedPath;
    } else {
      console.log('✅ Video ya está en H.264, copiando...');
      finalPath = path.join(process.cwd(), 'uploads', finalFilename);
      fs.renameSync(tempPath, finalPath);
    }

    // Generar thumbnail
    const thumbnailPath = path.join(process.cwd(), 'uploads', `thumb-${fileId}.jpg`);
    await generateThumbnail(finalPath, thumbnailPath);

    // Actualizar registro con path final y thumbnail
    await pool.query(
      `UPDATE content SET filename=$1, file_path=$2, size_bytes=$3, thumbnail_path=$4,
       hevc_status=CASE WHEN hevc_status='uploading' THEN 'pending' ELSE hevc_status END
       WHERE id=$5`,
      [finalFilename, `/uploads/${finalFilename}`, fs.statSync(finalPath).size,
       `/uploads/thumb-${fileId}.jpg`, contentId]
    );

    const result = await pool.query('SELECT * FROM content WHERE id=$1', [contentId]);
    console.log('✅ Video guardado en BD:', contentId);

    if (hasRpi5) {
      console.log('📼 hevc_status=pending marcado para content id=' + contentId + ' (user tiene RPi5)');
      setImmediate(runHevcWorker);
    }

    // Emitir actualización con thumbnail ya disponible
    io.emit('upload_complete', {
      success: true,
      content: result.rows[0],
      fileId,
      codec,
      duration,
      thumbnail: `/uploads/thumb-${fileId}.jpg`
    });

  } catch (err) {
    console.error('❌ Error procesando video:', err);

    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    io.emit('upload_error', {
      error: err.message,
      fileId,
      hint: 'Asegúrate de que el archivo sea un video válido'
    });
  }
}
// ========================================
// GET CONTENT (PROTEGIDO)
// ========================================

app.get('/api/content', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, type, filename, file_path, size_bytes, duration_ms, uploaded_at, hevc_status, orientation, width, height FROM content WHERE user_id = $1 ORDER BY uploaded_at DESC',
      [req.user.id] // ✅ Filtrar por usuario autenticado
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get content error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// DELETE CONTENT (PROTEGIDO)
// ========================================

app.delete('/api/content/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      'SELECT filename, hevc_file_path FROM content WHERE id = $1 AND user_id = $2',
      [id, userId] // ✅ Verificar que sea propietario
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    const filename = result.rows[0].filename;
    const hevcFilePath = result.rows[0].hevc_file_path;
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const filepath = path.join(uploadsDir, filename);

    // Verificar que la ruta resultante siga dentro de uploads (previene path traversal)
    if (!filepath.startsWith(uploadsDir + path.sep)) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }

    // Eliminar archivo
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log('🗑️ Archivo eliminado:', filename);
    }

    // Eliminar thumbnail
    const fileIdString = String(id);
    const thumbId = fileIdString.substring(0, 8);
    const thumbPath = path.join(uploadsDir, `thumb-${thumbId}.jpg`);
    if (fs.existsSync(thumbPath)) {
      fs.unlinkSync(thumbPath);
      console.log('🗑️ Thumbnail eliminado:', `thumb-${thumbId}.jpg`);
    }

    // Eliminar de BD
    await pool.query('DELETE FROM content WHERE id = $1 AND user_id = $2', [id, userId]);

    // Notificar RPi5s del usuario para limpiar archivo HEVC local
    if (hevcFilePath) {
      try {
        const rpi5Devs = await pool.query("SELECT device_id FROM devices WHERE user_id=$1 AND model='rpi5'", [userId]);
        for (const d of rpi5Devs.rows) {
          io.to(`device_${d.device_id}`).emit('cmd_delete_hevc', { hevc_file_path: hevcFilePath, content_id: parseInt(id) });
          console.log(`🗑️ cmd_delete_hevc emitido a ${d.device_id}: ${hevcFilePath}`);
        }
      } catch(e) { console.error('cmd_delete_hevc error:', e); }
    }

    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// RUTAS DE PLAYLISTS
// ========================================

// POST - Crear nueva playlist
app.post('/api/playlists', authenticateToken, async (req, res) => {
  try {
    const { name, description, orientation } = req.body;
    const userId = req.user.id;

    if (!name) {
      return res.status(400).json({ error: 'El nombre de la playlist es requerido' });
    }

    const result = await pool.query(
      `INSERT INTO playlists (user_id, name, description, orientation)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, name, description || '', orientation || 'horizontal']
    );

    res.json({ success: true, playlist: result.rows[0] });
    console.log(`✅ Playlist creada: ${result.rows[0].id} - ${name} (${orientation || 'horizontal'})`);
  } catch (err) {
    console.error('❌ Error creando playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET - Obtener todas las playlists del usuario
app.get('/api/playlists', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT p.*, COUNT(pi.id) as item_count
       FROM playlists p
       LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
       WHERE p.user_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error obteniendo playlists:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET - Obtener una playlist específica con su contenido
app.get('/api/playlists/:playlistId', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
              p.shuffle_enabled, p.repeat_enabled, p.orientation,
              pi.id as item_id, pi.content_id, pi.display_order, pi.duration_override_ms,
              c.title, c.type, c.file_path, c.size_bytes, c.duration_ms, c.uploaded_at
       FROM playlists p
       LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
       LEFT JOIN content c ON pi.content_id = c.id
       WHERE p.id = $1 AND p.user_id = $2
       ORDER BY pi.display_order ASC`,
      [playlistId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist vacía' });
    }

    const playlist = {
      id: result.rows[0].id,
      name: result.rows[0].name,
      description: result.rows[0].description,
      shuffle_enabled: result.rows[0].shuffle_enabled,
      repeat_enabled: result.rows[0].repeat_enabled,
      orientation: result.rows[0].orientation || 'horizontal',
      created_at: result.rows[0].created_at,
      updated_at: result.rows[0].updated_at,
      items: result.rows
        .filter(row => row.item_id !== null)
        .map(row => ({
          item_id: row.item_id,
          content_id: row.content_id,
          display_order: row.display_order,
          duration_override_ms: row.duration_override_ms,
          title: row.title,
          type: row.type,
          file_path: row.file_path,
          size_bytes: row.size_bytes,
          duration_ms: row.duration_override_ms || row.duration_ms,
          uploaded_at: row.uploaded_at
        }))
    };

    res.json(playlist);
  } catch (err) {
    console.error('❌ Error obteniendo playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
// PUT - Actualizar información de playlist
app.put('/api/playlists/:playlistId', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { name, description, shuffle_enabled, repeat_enabled, orientation } = req.body;
    const userId = req.user.id;

    const result = await pool.query(
      `UPDATE playlists
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           shuffle_enabled = COALESCE($3, shuffle_enabled),
           repeat_enabled = COALESCE($4, repeat_enabled),
           orientation = COALESCE($5, orientation),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND user_id = $7
       RETURNING *`,
      [name, description, shuffle_enabled, repeat_enabled, orientation, playlistId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    res.json({ success: true, playlist: result.rows[0] });
    console.log(`✅ Playlist actualizada: ${playlistId} (${result.rows[0].orientation})`);
  } catch (err) {
    console.error('❌ Error actualizando playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
// DELETE - Eliminar playlist
app.delete('/api/playlists/:playlistId', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      'DELETE FROM playlists WHERE id = $1 AND user_id = $2 RETURNING id',
      [playlistId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    res.json({ success: true, message: 'Playlist eliminada' });
    console.log(`✅ Playlist eliminada: ${playlistId}`);
  } catch (err) {
    console.error('❌ Error eliminando playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST - Agregar contenido a una playlist
app.post('/api/playlists/:playlistId/items', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { content_id, duration_override_ms } = req.body;
    const userId = req.user.id;

    const playlistCheck = await pool.query(
      'SELECT id, orientation FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    const contentCheck = await pool.query(
      'SELECT id, orientation FROM content WHERE id = $1 AND user_id = $2',
      [content_id, userId]
    );

    if (contentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contenido no encontrado' });
    }

    // Poka-yoke fail-closed: orientación del contenido debe coincidir con la playlist
    const plOrientation = playlistCheck.rows[0].orientation || 'horizontal';
    const ctOrientation = contentCheck.rows[0].orientation || 'horizontal';
    if (plOrientation !== ctOrientation) {
      return res.status(400).json({
        error: `Orientación incompatible: la lista es ${plOrientation} pero el contenido es ${ctOrientation}. Usa contenido ${plOrientation} en esta lista.`
      });
    }

    const orderResult = await pool.query(
      'SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM playlist_items WHERE playlist_id = $1',
      [playlistId]
    );
    const nextOrder = orderResult.rows[0].next_order;

    const result = await pool.query(
      `INSERT INTO playlist_items (playlist_id, content_id, display_order, duration_override_ms)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (playlist_id, content_id) DO UPDATE SET display_order = $3, duration_override_ms = $4
       RETURNING *`,
      [playlistId, content_id, nextOrder, duration_override_ms || null]
    );

    res.json({ success: true, item: result.rows[0] });
    console.log(`✅ Contenido agregado a playlist: ${playlistId}`);
  } catch (err) {
    console.error('❌ Error agregando contenido a playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE - Eliminar contenido de una playlist
app.delete('/api/playlists/:playlistId/items/:contentId', authenticateToken, async (req, res) => {
  try {
    const { playlistId, contentId } = req.params;
    const userId = req.user.id;

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    const result = await pool.query(
      'DELETE FROM playlist_items WHERE playlist_id = $1 AND content_id = $2 RETURNING id',
      [playlistId, contentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item no encontrado en la playlist' });
    }

    await pool.query(
      `WITH renumbered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY display_order) AS new_order
         FROM playlist_items WHERE playlist_id = $1
       )
       UPDATE playlist_items pi SET display_order = r.new_order
       FROM renumbered r WHERE pi.id = r.id`,
      [playlistId]
    );

    res.json({ success: true, message: 'Contenido eliminado de la playlist' });
    console.log(`✅ Contenido eliminado de playlist: ${playlistId}`);
  } catch (err) {
    console.error('❌ Error eliminando contenido de playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT - Sync completo de items: borra todos y re-inserta en orden exacto
app.put('/api/playlists/:playlistId/items', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { items } = req.body;
    const userId = req.user.id;

    const check = await pool.query(
      'SELECT id, orientation FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Playlist no encontrada' });
    const plOrient = check.rows[0].orientation;

    await pool.query('DELETE FROM playlist_items WHERE playlist_id = $1', [playlistId]);

    for (let i = 0; i < items.length; i++) {
      // Verificar que el content_id pertenece al usuario y que la orientación coincide
      const contentOwner = await pool.query(
        'SELECT id, orientation FROM content WHERE id = $1 AND user_id = $2',
        [items[i].content_id, userId]
      );
      if (!contentOwner.rows.length) continue;
      const ctOr = contentOwner.rows[0].orientation || 'horizontal';
      const plOr = plOrient || 'horizontal';
      if (plOr !== ctOr) {
        console.log(`⚠️ Playlist sync: item ${items[i].content_id} omitido (orientación ${ctOr} ≠ ${plOr})`);
        continue;
      }
      await pool.query(
        'INSERT INTO playlist_items (playlist_id, content_id, display_order, duration_override_ms) VALUES ($1, $2, $3, $4)',
        [playlistId, items[i].content_id, i + 1, items[i].duration_override_ms || null]
      );
    }

    res.json({ success: true, count: items.length });
    console.log(`✅ Items playlist sincronizados: ${playlistId} (${items.length} items)`);
    try {
      const devs = await pool.query("SELECT device_id FROM devices WHERE hdmi0_playlist_id=$1 OR hdmi1_playlist_id=$1", [parseInt(playlistId)]);
      for (const d of devs.rows) { io.to("device_"+d.device_id).emit("cmd_refresh_playlist"); console.log("📺 cmd_refresh_playlist emitido a "+d.device_id); }
    } catch(e) {}
  } catch (err) {
    console.error('❌ Error sincronizando items playlist:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT - Reordenar items en una playlist
app.put('/api/playlists/:playlistId/reorder', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { items } = req.body;
    const userId = req.user.id;

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    for (let i = 0; i < items.length; i++) {
      await pool.query(
        'UPDATE playlist_items SET display_order = $1 WHERE playlist_id = $2 AND content_id = $3',
        [i + 1, playlistId, items[i].content_id]
      );
    }

    res.json({ success: true, message: 'Orden actualizado' });
    console.log(`✅ Playlist reordenada: ${playlistId}`);
  } catch (err) {
    console.error('❌ Error reordenando playlist:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ADMIN ROUTES (NUEVO)
// ========================================
// ========================================
// DEVICE API - RPi4 Management
// ========================================

// POST - Registrar o actualizar dispositivo (sin JWT - llamado desde RPi4)
app.post('/api/devices/register', registerDeviceLimiter, async (req, res) => {
  try {
    const { device_id, name, ip_address, display_mode, hdmi0_playlist_id, hdmi1_playlist_id, platform, player_version, auth_token } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id requerido' });
    }

    // Extraer user_id del auth_token si viene (players Windows)
    let userId = null;
    if (auth_token) {
      try {
        const decoded = jwt.verify(auth_token, process.env.JWT_SECRET);
        userId = decoded.id || null;
      } catch (e) {
        console.warn(`⚠️ auth_token inválido para registro de ${device_id}:`, e.message);
      }
    }

    const result = await pool.query(
      `INSERT INTO devices (device_id, name, ip_address, display_mode, hdmi0_playlist_id, hdmi1_playlist_id, status, last_seen, platform, player_version, user_id)
       VALUES ($1, COALESCE($2::varchar, $1), $3, $4, $5, $6, 'online', CURRENT_TIMESTAMP, $7, $8, $9)
       ON CONFLICT (device_id) DO UPDATE SET
         name = COALESCE($2::varchar, devices.name),
         ip_address = $3,
         status = 'online',
         last_seen = CURRENT_TIMESTAMP,
         platform = COALESCE($7, devices.platform),
         player_version = COALESCE($8, devices.player_version),
         user_id = COALESCE($9, devices.user_id)
       RETURNING *`,
      [device_id, name || null, ip_address, display_mode || 'mirror', hdmi0_playlist_id || null, hdmi1_playlist_id || null, platform || 'rpi', player_version || null, userId]
    );

    res.json({ success: true, device: result.rows[0] });
    console.log(`✅ Dispositivo registrado: ${device_id} (${ip_address}) [${platform || 'rpi'}] user_id=${userId}`);
  } catch (err) {
    console.error('❌ Error registrando dispositivo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET - Obtener configuración de un dispositivo (sin JWT - llamado desde RPi4)
app.get('/api/devices/:device_id/config', playerLimiter, async (req, res) => {
  try {
    const { device_id } = req.params;

    const result = await pool.query(
      `SELECT d.*,
              p0.name as hdmi0_playlist_name,
              p1.name as hdmi1_playlist_name,
              COALESCE(d.branch_id,
                (SELECT id FROM branches WHERE user_id = d.user_id LIMIT 1)
              ) as branch_id
       FROM devices d
       LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
       LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
       WHERE d.device_id = $1`,
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // Actualizar last_seen
    await pool.query(
      `UPDATE devices SET last_seen = CURRENT_TIMESTAMP, status = 'online' WHERE device_id = $1`,
      [device_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ Error obteniendo config dispositivo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ============================================================
// WINDOWS KIOSK PLAYER — endpoints sin JWT (llamados desde el player)
// ============================================================

// GET - Manifiesto de contenido para el Windows Player (caché + sync)
app.get('/api/devices/:device_id/manifest', playerLimiter, async (req, res) => {
  try {
    const { device_id } = req.params;

    const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|win-[0-9a-f]+|rpi-[0-9a-f]+)$/i;
    if (!UUID_RE.test(device_id)) return res.status(400).json({ error: 'device_id inválido' });

    const deviceResult = await pool.query(
      `SELECT d.*, u.features
       FROM devices d
       LEFT JOIN users u ON d.user_id = u.id
       WHERE d.device_id = $1`,
      [device_id]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    const device = deviceResult.rows[0];

    // Obtener playlist activa (hdmi0 para Windows player)
    let playlist = null;
    let assets   = [];
    const playlistId = device.hdmi0_playlist_id;

    if (playlistId) {
      const plResult = await pool.query(
        `SELECT id, name, created_at FROM playlists WHERE id = $1`,
        [playlistId]
      );
      if (plResult.rows.length > 0) {
        playlist = plResult.rows[0];

        // Obtener items desde playlist_items JOIN content
        const itemsResult = await pool.query(
          `SELECT pi.display_order, pi.duration_override_ms,
                  c.filename, c.type, c.duration_ms,
                  c.hevc_file_path, c.hevc_status  -- // RPI5-HEVC-PATCH v1
           FROM playlist_items pi
           JOIN content c ON pi.content_id = c.id
           WHERE pi.playlist_id = $1
           ORDER BY pi.display_order ASC`,
          [playlistId]
        );

        const baseUrl = process.env.CMS_URL || 'https://cms.sonoro.com.co';
        const isRpi5  = device.model === 'rpi5';  // // RPI5-HEVC-PATCH v1
        for (const item of itemsResult.rows) {
          if (!item.filename) continue;
          let filename = item.filename;
          let codec    = 'h264';
          if (isRpi5) {
            if (item.hevc_status === 'ready' && item.hevc_file_path) {
              filename = item.hevc_file_path.replace(/^\/uploads\//, '');
              codec    = 'hevc';
            } else {
              console.log(`  skip HEVC-missing device=${device_id} file=${item.filename} status=${item.hevc_status}`);
              continue;
            }
          }
          const duration = item.duration_override_ms || item.duration_ms || 10000;
          assets.push({
            filename,
            type:     item.type || 'video',
            duration,
            url:      `${baseUrl}/uploads/${filename}`,
            checksum: null,
            codec,
          });
        }
      }
    }

    // Versión: cambia cuando se agregan/quitan items de la playlist
    const version = playlist
      ? `${playlistId}-${assets.map(a => a.filename).join(',')}`
      : 'no-playlist';

    // Actualizar last_seen del dispositivo
    await pool.query(
      `UPDATE devices SET last_seen = CURRENT_TIMESTAMP, status = 'online' WHERE device_id = $1`,
      [device_id]
    );

    const playlistItems = assets.map(a => ({ filename: a.filename, type: a.type, duration: a.duration }));

    res.json({
      version,
      device_id,
      playlist_id:   playlistId || null,
      playlist_name: playlist?.name || null,
      assets,
      playlist_json: playlist ? { id: playlist.id, name: playlist.name, items: playlistItems } : null,
      wake_action:   device.wake_action  || { action: 'return' },
      power_policy:  device.power_policy || {},
      features:      device.features     || {},
      synced_at:     new Date().toISOString(),
    });

    console.log(`📦 Manifest enviado: ${device_id} — ${assets.length} assets`);

  } catch (err) {
    console.error('❌ Error generando manifest:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT - Actualizar wake_action y power_policy de un dispositivo Windows (desde dashboard)
app.put('/api/devices/:device_id/win-policy', authenticateToken, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { wake_action, power_policy } = req.body;

    // Verificar que el dispositivo pertenece al usuario
    const deviceResult = await pool.query(
      `SELECT * FROM devices WHERE device_id = $1 AND user_id = $2`,
      [device_id, req.user.id]
    );

    if (deviceResult.rows.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin permisos sobre este dispositivo' });
    }

    await pool.query(
      `UPDATE devices
       SET wake_action  = COALESCE($1::jsonb, wake_action),
           power_policy = COALESCE($2::jsonb, power_policy)
       WHERE device_id = $3`,
      [
        wake_action  ? JSON.stringify(wake_action)  : null,
        power_policy ? JSON.stringify(power_policy) : null,
        device_id,
      ]
    );

    // Notificar al player vía Socket.io si está conectado
    if (wake_action) {
      io.to(`device_${device_id}`).emit('wake_action_update', wake_action);
    }
    if (power_policy) {
      io.to(`device_${device_id}`).emit('power_policy_update', power_policy);
    }

    res.json({ success: true });
    console.log(`✅ Win policy actualizada: ${device_id}`);

  } catch (err) {
    console.error('❌ Error actualizando win policy:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST - Reiniciar proceso del Windows Player remotamente (via Socket.io)
app.post('/api/devices/:device_id/win-restart', authenticateToken, async (req, res) => {
  try {
    const { device_id } = req.params;
    const ownerCheck = await pool.query('SELECT user_id FROM devices WHERE device_id = $1', [device_id]);
    if (!ownerCheck.rows.length) return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    if (req.user.role !== 'admin' && ownerCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'No autorizado para este dispositivo' });
    }
    io.to(`device_${device_id}`).emit('restart_player', { device_id });
    res.json({ success: true });
    console.log(`🔄 Restart player enviado a: ${device_id}`);
  } catch (err) {
    console.error('❌ Error win-restart:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST - Reboot dispositivo via SSH
app.post('/api/devices/reboot', authenticateToken, requireAdmin, async (req, res) => {
  const { ip, device_id } = req.body;
  let targetId = device_id;
  if (!targetId && ip) {
    if (!isValidIP(ip)) return res.status(400).json({ error: 'IP inválida' });
    const r = await pool.query('SELECT device_id FROM devices WHERE ip_address = $1 ORDER BY last_seen DESC NULLS LAST LIMIT 1', [ip]);
    targetId = r.rows[0]?.device_id;
  }
  if (!targetId) return res.status(400).json({ error: 'device_id o ip requeridos' });
  io.to(`device_${targetId}`).emit('reboot_request', { device_id: targetId });
  console.log(`🔄 Reboot emit → ${targetId}`);
  res.json({ success: true, message: `Reboot enviado a ${targetId}` });
});

// POST - Reboot por device_id
app.post('/api/devices/:device_id/reboot', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  try {
    const result = await pool.query('SELECT device_id FROM devices WHERE device_id = $1', [device_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    io.to(`device_${device_id}`).emit('reboot_request', { device_id });
    console.log(`🔄 Reboot emit → ${device_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reboot error:', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── SCREENSHOT VIA SSH + GRIM (Wayland) ──────────────────────
// Funcion compartida — Socket.io solicita, RPi sube via HTTP POST
async function doScreenshot(ip, deviceId) {
  console.log(`📸 Solicitando screenshot a ${deviceId} via Socket.io + HTTP upload`);
  const screenshotsDir = path.join(process.cwd(), 'uploads', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  const filename = `screenshot-${deviceId}-${Date.now()}.png`;
  const expectedPath = path.join(screenshotsDir, filename);

  return new Promise((resolve, reject) => {
    if (screenshotCallbacks.has(deviceId)) {
      return reject(new Error('Ya hay un screenshot pendiente para este dispositivo'));
    }
    const timeout = setTimeout(() => {
      screenshotCallbacks.delete(deviceId);
      reject(new Error('Screenshot timeout — RPi no respondio en 60s'));
    }, 60000);
    screenshotCallbacks.set(deviceId, { resolve, reject, timeout, expectedPath, filename });
    io.to(`device_${deviceId}`).emit('screenshot_request', { device_id: deviceId, filename });
  });
}

// POST - Screenshot admin (usado por admin-dashboard.html)
app.post('/api/admin/rpi/screenshot', authenticateToken, async (req, res) => {
  const { device_id, ip } = req.body;
  if (!ip) return res.status(400).json({ success: false, error: 'IP requerida' });
  try {
    const screenshot_url = await doScreenshot(ip, device_id || 'device');
    res.json({ success: true, screenshot_url });
  } catch (err) {
    console.error('❌ Screenshot error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST - Screenshot por device_id (usado por dashboard.html)
app.post('/api/devices/:device_id/screenshot', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  try {
    const result = await pool.query('SELECT ip_address, name FROM devices WHERE device_id = $1', [device_id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    const { ip_address: ip, name } = result.rows[0];
    if (!ip) return res.status(400).json({ success: false, error: 'El dispositivo no tiene IP registrada' });
    const screenshot_url = await doScreenshot(ip, device_id);
    res.json({ success: true, screenshot_url, device_name: name, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('❌ Screenshot error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST - Matar player remotamente (Windows kiosk).
// Emite a la sala device_${id}; el player escucha 'kill-player' y hace app.quit().
// Si auto-start al login está activo, el player resucita en el siguiente login.
app.post('/api/devices/:device_id/kill-player', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  try {
    const result = await pool.query('SELECT user_id, name FROM devices WHERE device_id = $1', [device_id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    if (req.user.role !== 'admin' && result.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'No autorizado para este dispositivo' });
    }
    io.to(`device_${device_id}`).emit('kill-player', {
      reason: 'manual',
      issued_by: req.user.id,
      timestamp: new Date().toISOString(),
    });
    console.log(`🔴 kill-player emitido a ${device_id} por user ${req.user.id} (${result.rows[0].name})`);
    res.json({ success: true, device_id, device_name: result.rows[0].name });
  } catch (err) {
    console.error('❌ kill-player error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── CONTROL TV CEC ────────────────────────────────────────────
// POST /api/devices/:device_id/tv/:action — via Socket.io (no SSH)
app.post('/api/devices/:device_id/tv/:action', authenticateToken, async (req, res) => {
  const { device_id, action } = req.params;
  const target = (req.body && req.body.target) || 'all';
  const valid = ['on','off','status','hdmi1','hdmi2','hdmi3','hdmi4','mute','unmute'];
  const validTargets = ['tv1','tv2','all'];
  if (!valid.includes(action))
    return res.status(400).json({ success: false, error: 'Accion invalida. Usar: ' + valid.join(' | ') });
  if (!validTargets.includes(target))
    return res.status(400).json({ success: false, error: 'Target invalido: tv1|tv2|all' });
  try {
    const result = await pool.query(
      `SELECT name FROM devices WHERE device_id = $1
         AND (user_id = $2 OR $3 = 'admin')`,
      [device_id, req.user.id, req.user.role]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    const output = await doTV(device_id, action, target);
    res.json({ success: true, device_id, device_name: result.rows[0].name, action, target, output });
  } catch (err) {
    console.error('TV control error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/rpi/tv — via Socket.io (no SSH)
// body: { device_id, action, target? }  target: tv1|tv2|all (default: all)
app.post('/api/admin/rpi/tv', authenticateToken, requireAdmin, async (req, res) => {
  const { device_id, action, target = 'all' } = req.body;
  const validActions  = ['on','off','status','hdmi1','hdmi2','hdmi3','hdmi4','mute','unmute'];
  const validTargets  = ['tv1','tv2','all'];
  if (!validActions.includes(action))
    return res.status(400).json({ success: false, error: 'Accion invalida' });
  if (!validTargets.includes(target))
    return res.status(400).json({ success: false, error: 'Target invalido: tv1|tv2|all' });
  if (!device_id)
    return res.status(400).json({ success: false, error: 'device_id requerido' });
  try {
    const output = await doTV(device_id, action, target);
    res.json({ success: true, device_id, action, target, output });
  } catch (err) {
    console.error('[Admin] TV control error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TV SCHEDULES ──────────────────────────────────────────────
// GET /api/devices/:device_id/tv-schedule
app.get('/api/devices/:device_id/tv-schedule', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  try {
    const result = await pool.query(
      `SELECT s.* FROM tv_schedules s
       JOIN devices d ON d.device_id = $1
       WHERE s.device_id = $1 AND d.user_id = $2
       ORDER BY s.created_at ASC`,
      [device_id, req.user.id]
    );
    const schedules = result.rows.map(r => ({
      id: r.id,
      days: r.days,
      time_on: r.time_on,
      time_off: r.time_off,
      active: r.active
    }));
    res.json({ success: true, schedules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/:device_id/tv-schedule — guarda todos los schedules y aplica crontab en el RPi
app.post('/api/devices/:device_id/tv-schedule', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  const { schedules } = req.body;
  if (!Array.isArray(schedules))
    return res.status(400).json({ success: false, error: 'schedules debe ser un array' });

  try {
    const devResult = await pool.query(
      'SELECT ip_address FROM devices WHERE device_id = $1 AND user_id = $2',
      [device_id, req.user.id]
    );
    if (!devResult.rows.length)
      return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });

    const ip = devResult.rows[0].ip_address;

    // Borrar schedules anteriores y reinserta
    await pool.query('DELETE FROM tv_schedules WHERE device_id = $1', [device_id]);
    for (const s of schedules) {
      await pool.query(
        `INSERT INTO tv_schedules (device_id, days, time_on, time_off, active)
         VALUES ($1, $2, $3, $4, $5)`,
        [device_id, s.days, s.time_on, s.time_off, s.active !== false]
      );
    }

    // Enviar schedules al RPi via Socket.io para que aplique el crontab localmente
    io.to(`device_${device_id}`).emit('tv_schedule', { device_id, schedules });
    console.log(`📅 Cronograma TV enviado a ${device_id} via Socket.io (${schedules.length} entradas)`);
    res.json({ success: true, count: schedules.length });
  } catch (err) {
    console.error('❌ TV schedule error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/devices/:device_id/tv-result — RPi envia resultado de TV control
app.post('/api/devices/:device_id/tv-result', async (req, res) => {
  const { device_id } = req.params;
  const { action, output, error } = req.body;
  if (!tvCallbacks.has(device_id)) {
    return res.status(403).json({ success: false, error: 'No hay solicitud pendiente para este dispositivo' });
  }
  console.log(`📺 TV result recibido — device: ${device_id} action: ${action} output: ${output}`);
  if (action && !error) {
    // Guardar estado TV (hdmi* = entrada activa, off = apagada)
    if (action.startsWith('hdmi') || action === 'off') {
      pool.query('UPDATE devices SET tv_status = $1 WHERE device_id = $2', [action, device_id]).catch(() => {});
    }
    // TV volvió a estar activa → limpiar alerted_at para la próxima ventana
    if (action.startsWith('hdmi') || action === 'on') {
      pool.query('UPDATE devices SET alerted_at = NULL WHERE device_id = $1', [device_id]).catch(() => {});
    }
  }
  const cb = tvCallbacks.get(device_id);
  if (cb) {
    clearTimeout(cb.timeout);
    tvCallbacks.delete(device_id);
    if (error) cb.reject(new Error(error));
    else cb.resolve(output || action);
  }
  res.json({ success: true });
});

// POST /api/devices/:device_id/tv-info — RPi reporta CEC vendor/OSD + EDID por HDMI
app.post('/api/devices/:device_id/tv-info', async (req, res) => {
  const { device_id } = req.params;
  const { tv_info } = req.body || {};
  if (!tv_info || typeof tv_info !== 'object') {
    return res.status(400).json({ success: false, error: 'tv_info requerido (object)' });
  }
  try {
    const r = await pool.query(
      'UPDATE devices SET tv_info = $1, tv_info_updated_at = NOW() WHERE device_id = $2 RETURNING id',
      [JSON.stringify(tv_info), device_id]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'device no existe' });
    res.json({ success: true });
  } catch (e) {
    console.warn('tv-info error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/rpi/logs — admin solicita logs de un RPi via socket
app.post('/api/admin/rpi/logs', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Solo admin' });
  const { device_id, lines = 100 } = req.body;
  if (!device_id) return res.status(400).json({ success: false, error: 'device_id requerido' });
  if (!global.logsCallbacks) global.logsCallbacks = new Map();
  if (global.logsCallbacks.has(device_id)) {
    const old = global.logsCallbacks.get(device_id);
    clearTimeout(old.timeout);
    global.logsCallbacks.delete(device_id);
  }
  const timeout = setTimeout(() => {
    global.logsCallbacks.delete(device_id);
    if (!res.headersSent) res.status(504).json({ success: false, error: 'Timeout: RPi no respondio en 30s' });
  }, 30000);
  global.logsCallbacks.set(device_id, { res, timeout });
  io.to(`device_${device_id}`).emit('logs_request', { device_id, lines: parseInt(lines) });
  console.log(`📋 logs_request emitido a device_${device_id} (${lines} lineas)`);
});

// POST /api/devices/:device_id/logs-result — RPi envia logs via HTTP
app.post('/api/devices/:device_id/logs-result', async (req, res) => {
  const { device_id } = req.params;
  const { logs, error } = req.body;
  const cb = global.logsCallbacks && global.logsCallbacks.get(device_id);
  if (!cb) return res.status(403).json({ success: false, error: 'No hay solicitud pendiente para este dispositivo' });
  if (cb) {
    clearTimeout(cb.timeout);
    global.logsCallbacks.delete(device_id);
    if (error) cb.res.json({ success: false, error });
    else cb.res.json({ success: true, logs: logs || '' });
  }
  res.json({ success: true });
});

// POST /api/devices/:device_id/stats-result — RPi envia stats via HTTP
app.post('/api/devices/:device_id/stats-result', async (req, res) => {
  const { device_id } = req.params;
  const { temp, fan_state, fan_label, temp_status, error } = req.body;
  const cb = global.statsCallbacks && global.statsCallbacks.get(device_id);
  if (!cb) return res.status(403).json({ success: false, error: 'No hay solicitud pendiente para este dispositivo' });
  if (cb) {
    clearTimeout(cb.timeout);
    global.statsCallbacks.delete(device_id);
    if (error) cb.res.json({ success: false, error });
    else cb.res.json({ success: true, temp, fan_state, fan_label, temp_status });
  }
  res.json({ success: true });
});

// POST /api/devices/:device_id/update-result — RPi confirma actualizacion
app.post('/api/devices/:device_id/update-result', async (req, res) => {
  const { device_id } = req.params;
  const { success: ok, message, error } = req.body;
  const cb = global.updateCallbacks && global.updateCallbacks.get(device_id);
  if (!cb) return res.status(403).json({ success: false, error: 'No hay solicitud pendiente para este dispositivo' });
  if (cb) {
    clearTimeout(cb.timeout);
    global.updateCallbacks.delete(device_id);
    if (error) cb.res.json({ success: false, error });
    else cb.res.json({ success: true, message: message || 'Actualizado correctamente' });
  }
  res.json({ success: true });
});

// POST /api/devices/:device_id/screenshot-upload — RPi sube screenshot via HTTP
app.post('/api/devices/:device_id/screenshot-upload', async (req, res) => {
  const { device_id } = req.params;
  if (!screenshotCallbacks.has(device_id)) {
    return res.status(403).json({ success: false, error: 'No hay solicitud de screenshot pendiente' });
  }
  if (!req.files || !req.files.screenshot) {
    return res.status(400).json({ success: false, error: 'No se recibio archivo' });
  }
  try {
    const screenshotsDir = path.join(process.cwd(), 'uploads', 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const cb = screenshotCallbacks.get(device_id);
    const filename = cb?.filename || `screenshot-${device_id}-${Date.now()}.png`;
    const savePath = path.join(screenshotsDir, filename);
    await req.files.screenshot.mv(savePath);
    const url = `/uploads/screenshots/${filename}`;
    console.log(`📸 Screenshot recibido via HTTP: ${url}`);
    if (cb) {
      clearTimeout(cb.timeout);
      screenshotCallbacks.delete(device_id);
      cb.resolve(url);
    }
    res.json({ success: true, url });
  } catch(e) {
    console.error(`❌ Error guardando screenshot upload: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET - Listar todos los dispositivos (protegido - para el dashboard)
app.get('/api/devices', authenticateToken, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query(
        `SELECT d.*,
                p0.name as hdmi0_playlist_name,
                p1.name as hdmi1_playlist_name
         FROM devices d
         LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
         LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
         ORDER BY CASE WHEN d.platform = 'windows' THEN 1 ELSE 0 END ASC, d.created_at DESC`
      );
    } else {
      result = await pool.query(
        `SELECT d.*,
                p0.name as hdmi0_playlist_name,
                p1.name as hdmi1_playlist_name
         FROM devices d
         LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
         LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
         WHERE d.user_id = $1
         ORDER BY CASE WHEN d.platform = 'windows' THEN 1 ELSE 0 END ASC, d.created_at DESC`,
        [req.user.id]
      );
    }

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error listando dispositivos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT - Actualizar configuración de dispositivo (protegido - desde el dashboard)
app.put('/api/devices/:device_id', authenticateToken, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { name, display_mode, hdmi0_playlist_id, hdmi1_playlist_id,
            orientation_hdmi0, orientation_hdmi1,
            videowall_position, videowall_cols, videowall_rows,
            branch_id } = req.body;

    // Validar licencia para modos premium
    if (['dual', 'videowall'].includes(display_mode) && !req.user.features?.dual_hdmi) {
      return res.status(403).json({
        error: 'El modo dual y videowall requieren licencia Premium. Contacta a SONORO AV.'
      });
    }

    // ── Poka-yoke: validar orientación playlist ↔ device ─────────
    // Si se asigna una playlist a un HDMI, su orientación debe coincidir
    // con orientation_hdmiN. Evita reproducir vertical en pantalla horizontal.
    const curOr = await pool.query(
      'SELECT orientation_hdmi0, orientation_hdmi1 FROM devices WHERE device_id = $1',
      [device_id]
    );
    const effOr0 = orientation_hdmi0 || curOr.rows[0]?.orientation_hdmi0 || 'horizontal';
    const effOr1 = orientation_hdmi1 || curOr.rows[0]?.orientation_hdmi1 || 'horizontal';
    const checkAssign = async (plId, devOr, label) => {
      if (!plId) return null;
      const pl = await pool.query('SELECT orientation, name FROM playlists WHERE id = $1', [plId]);
      if (!pl.rows.length) return null;
      const plOr = pl.rows[0].orientation || 'horizontal';
      if (plOr !== devOr) {
        return `No se puede asignar la playlist "${pl.rows[0].name}" (${plOr}) a ${label} configurado como ${devOr}. Cambia la orientación del dispositivo o selecciona una playlist ${devOr}.`;
      }
      return null;
    };
    const err0 = await checkAssign(hdmi0_playlist_id, effOr0, 'HDMI 1');
    if (err0) return res.status(400).json({ error: err0 });
    const err1 = await checkAssign(hdmi1_playlist_id, effOr1, 'HDMI 2');
    if (err1) return res.status(400).json({ error: err1 });

    const ownerFilter = req.user.role === 'admin' ? '' : 'AND user_id = $12';
    const queryParams = [name, display_mode, hdmi0_playlist_id || null, hdmi1_playlist_id || null,
       orientation_hdmi0, orientation_hdmi1,
       videowall_position || null, videowall_cols || null, videowall_rows || null,
       branch_id || null,
       device_id];
    if (req.user.role !== 'admin') queryParams.push(req.user.id);

    const result = await pool.query(
      `UPDATE devices SET
         name = COALESCE($1, name),
         display_mode = COALESCE($2, display_mode),
         hdmi0_playlist_id = $3,
         hdmi1_playlist_id = $4,
         orientation_hdmi0 = COALESCE($5, orientation_hdmi0),
         orientation_hdmi1 = COALESCE($6, orientation_hdmi1),
         videowall_position = $7,
         videowall_cols = $8,
         videowall_rows = $9,
         branch_id = COALESCE($10, branch_id),
         updated_at = CURRENT_TIMESTAMP
       WHERE device_id = $11 ${ownerFilter}
       RETURNING *`,
      queryParams
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // Notificar al dispositivo via Socket.io
    io.emit(`device-config-update-${device_id}`, result.rows[0]);

    // 📺 FIX2 — cmd_refresh_playlist: notificar al Pi si cambió playlist asignada
    try {
      const devRow2 = await pool.query('SELECT device_id FROM devices WHERE device_id=$1', [device_id]);
      if (devRow2.rows[0]) {
        io.to('device_' + devRow2.rows[0].device_id).emit('cmd_refresh_playlist');
        console.log('📺 cmd_refresh_playlist emitido a device_' + devRow2.rows[0].device_id);
      }
    } catch (emitErr) {
      console.error('⚠️ Error emitiendo cmd_refresh_playlist:', emitErr.message);
    }

    res.json({ success: true, device: result.rows[0] });
    console.log(`✅ Dispositivo actualizado: ${device_id}`);
  } catch (err) {
    console.error('❌ Error actualizando dispositivo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET - Endpoint público para obtener playlist completa (sin JWT - para RPi4 player)
app.get('/api/player/playlist/:playlistId', playerLimiter, async (req, res) => {
  try {
    const { playlistId } = req.params;
    // // RPI5-HEVC-PATCH v1 — ?device_id opcional para aplicar gate HEVC RPi5
    const reqDeviceId = req.query.device_id || null;
    let isRpi5 = false;
    if (reqDeviceId) {
      const d = await pool.query('SELECT model FROM devices WHERE device_id=$1', [reqDeviceId]);
      isRpi5 = d.rows[0]?.model === 'rpi5';
    }

    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.shuffle_enabled, p.repeat_enabled,
              pi.id as item_id, pi.content_id, pi.display_order, pi.duration_override_ms,
              c.title, c.type, c.file_path, c.duration_ms,
              c.hevc_file_path, c.hevc_status
       FROM playlists p
       LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
       LEFT JOIN content c ON pi.content_id = c.id
       WHERE p.id = $1
       ORDER BY pi.display_order ASC`,
      [playlistId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    const playlist = {
      id: result.rows[0].id,
      name: result.rows[0].name,
      shuffle_enabled: result.rows[0].shuffle_enabled,
      repeat_enabled: result.rows[0].repeat_enabled,
      items: result.rows
        .filter(row => row.item_id !== null)
        .filter(row => {
          if (!isRpi5) return true;
          if (row.type === 'video' || row.type === 'image')
            return row.hevc_status === 'ready' && row.hevc_file_path;
          return true;
        })
        .map(row => {
          const useHevc = isRpi5 && (row.type === 'video' || row.type === 'image')
                          && row.hevc_status === 'ready' && row.hevc_file_path;
          return {
            item_id: row.item_id,
            content_id: row.content_id,
            display_order: row.display_order,
            title: row.title,
            type: (useHevc && row.type === 'image') ? 'video' : row.type,
            file_path: useHevc ? row.hevc_file_path : row.file_path,
            codec:     useHevc ? 'hevc' : 'h264',
            duration_ms: row.duration_override_ms || row.duration_ms || 15000
          };
        })
    };

    res.json(playlist);
  } catch (err) {
    console.error('❌ Error obteniendo playlist para player:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});
const adminRoutes = require('./routes/admin');
app.set('io', io);
app.set('db', pool);
app.use('/api/admin', adminRoutes);

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-dashboard.html'));
});

app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-login.html'));
});

app.get('/atencion/agente', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'queue-agent.html'));
});

app.get('/atencion/pantalla', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'queue-display.html'));
});

app.get('/atencion/kiosco', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'queue-kiosk.html'));
});

app.get('/atencion/calificacion', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'queue-rating.html'));
});

app.get('/atencion/reportes', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'queue-reports.html'));
});

// Impresión térmica ESC/POS (stub — se activa si hay impresora configurada)
// Kiosco público: sin JWT, pero valida que branch_id existe y aplica rate limiting
app.post('/api/queue/print', playerLimiter, async (req, res) => {
  try {
    const { branch_id, token_number, service_name, wait_minutes, position, token_id } = req.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id requerido' });
    const branchCheck = await pool.query('SELECT id FROM branches WHERE id = $1', [branch_id]);
    if (!branchCheck.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    // TODO: implementar con librería escpos cuando haya impresora configurada
    console.log(`🖨️  Imprimir tiquete: ${token_number} — ${service_name}`);
    res.json({ success: true, printed: false, message: 'Sin impresora configurada' });
  } catch(err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

console.log('✅ Admin routes registered at /api/admin/');
console.log('✅ Admin dashboard: http://localhost:5000/admin.html');

// ========================================

// ============================================================
// ACTIVATION CODES API
// ============================================================
// ============================================================
// SONORO AV — Activation Codes API
// Agregar en index.js antes de "SOCKET.IO - EVENTOS"
// ============================================================

// ── GENERAR CÓDIGO DE ACTIVACIÓN ────────────────────────────
// Genera un código único para que una RPi se vincule al usuario
app.post('/api/activation-codes', authenticateToken, async (req, res) => {
  try {
    const { device_name } = req.body;
    const userId = req.user.id;

    // Generar código legible: SONORO-XXXX-XXXX
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0,1,I,O para evitar confusión
    const part1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const part2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const code = `SNR-${part1}-${part2}`;

    // S158f: detectar si es el primer código del usuario (para email de guía)
    const priorCount = await pool.query(
      'SELECT COUNT(*)::int AS n FROM activation_codes WHERE user_id = $1',
      [userId]
    );
    const isFirstCode = priorCount.rows[0].n === 0;

    const result = await pool.query(
      `INSERT INTO activation_codes (code, user_id, device_name)
       VALUES ($1, $2, $3)
       RETURNING id, code, device_name, expires_at`,
      [code, userId, device_name || null]
    );

    console.log(`✅ Código de activación generado: ${code} para usuario ${userId}`);

    // S158f: en el primer código, enviar guía de activación por email (fire-and-forget)
    if (isFirstCode) {
      pool.query('SELECT email, name FROM users WHERE id = $1', [userId])
        .then(r => r.rows[0] && emailService.sendActivationGuideEmail(r.rows[0]))
        .catch(e => console.warn('⚠️ Guía de activación email:', e.message));
    }

    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('❌ Error generando código:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── LISTAR CÓDIGOS DEL USUARIO ───────────────────────────────
app.get('/api/activation-codes', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, device_name, used, device_id, created_at, expires_at, used_at
       FROM activation_codes
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ELIMINAR CÓDIGO ──────────────────────────────────────────
app.delete('/api/activation-codes/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM activation_codes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── VALIDAR CÓDIGO (sin JWT — llamado desde RPi) ─────────────
app.post('/api/activate', activateLimiter, async (req, res) => {
  try {
    const { code, device_id, ip_address, display_mode, platform, player_version, model } = req.body;

    if (!code || !device_id) {
      return res.status(400).json({ error: 'code y device_id son requeridos' });
    }

    const normalizedModel = (typeof model === 'string' && ['rpi4', 'rpi5', 'windows'].includes(model.toLowerCase()))
      ? model.toLowerCase()
      : null;

    // Buscar código válido
    const codeResult = await pool.query(
      `SELECT * FROM activation_codes
       WHERE code = $1
         AND used = false
         AND expires_at > CURRENT_TIMESTAMP`,
      [code.toUpperCase().trim()]
    );

    if (codeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Código inválido, ya usado o expirado' });
    }

    const activation = codeResult.rows[0];

    // Registrar o actualizar el dispositivo con el user_id
    const deviceResult = await pool.query(
      `INSERT INTO devices (device_id, name, ip_address, display_mode, user_id, status, last_seen, platform, player_version, model)
       VALUES ($1, $2, $3, $4, $5, 'online', CURRENT_TIMESTAMP, $6, $7, COALESCE($8, 'rpi4'))
       ON CONFLICT (device_id) DO UPDATE SET
         name           = COALESCE($2, devices.name),
         ip_address     = $3,
         user_id        = $5,
         status         = 'online',
         last_seen      = CURRENT_TIMESTAMP,
         platform       = COALESCE($6, devices.platform),
         player_version = COALESCE($7, devices.player_version),
         model          = COALESCE($8, devices.model)
       RETURNING *`,
      [
        device_id,
        activation.device_name || device_id,
        ip_address,
        display_mode || 'mirror',
        activation.user_id,
        platform || null,
        player_version || null,
        normalizedModel,
      ]
    );

    // Marcar código como usado
    await pool.query(
      `UPDATE activation_codes
       SET used = true, device_id = $1, used_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [device_id, activation.id]
    );

    console.log(`✅ RPi activada: ${device_id} → usuario ${activation.user_id}`);

    res.json({
      success: true,
      device: deviceResult.rows[0],
      message: 'Dispositivo activado correctamente'
    });
  } catch (err) {
    console.error('❌ Error en activación:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── OBTENER CONFIG (proteger por user_id) ────────────────────
// Reemplaza el GET /api/devices/:device_id/config existente
// para que solo devuelva config si el dispositivo está activado
app.get('/api/devices/:device_id/config/v2', playerLimiter, async (req, res) => {
  try {
    const { device_id } = req.params;

    const result = await pool.query(
      `SELECT d.*,
              p0.name as hdmi0_playlist_name,
              p1.name as hdmi1_playlist_name
       FROM devices d
       LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
       LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
       WHERE d.device_id = $1`,
      [device_id]
    );

    if (result.rows.length === 0) {
      // Dispositivo no activado aún
      return res.status(404).json({
        error: 'Dispositivo no activado',
        needs_activation: true
      });
    }

    // Actualizar last_seen
    await pool.query(
      `UPDATE devices SET last_seen = CURRENT_TIMESTAMP, status = 'online'
       WHERE device_id = $1`,
      [device_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── LISTAR DISPOSITIVOS DEL USUARIO (reemplaza GET /api/devices) ──
// El existente devuelve TODOS — este filtra por usuario
app.get('/api/my-devices', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*,
              p0.name as hdmi0_playlist_name,
              p1.name as hdmi1_playlist_name
       FROM devices d
       LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
       LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
       WHERE d.user_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});


// ============================================================
// SONORO AV — Licenses & Users Management API
// Agregar en index.js antes de "SOCKET.IO - EVENTOS"
// ============================================================

// ── MIDDLEWARE DE LICENCIA ───────────────────────────────────
// Verifica que el usuario tiene licencia activa
async function checkLicense(req, res, next) {
  try {
    const result = await pool.query(
      'SELECT license_status, license_end, role FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];

    // Admins siempre tienen acceso
    if (user.role === 'admin') return next();

    // Verificar si la licencia venció
    if (user.license_end && new Date(user.license_end) < new Date()) {
      await pool.query(
        "UPDATE users SET license_status = 'expired' WHERE id = $1 AND license_status != 'expired'",
        [req.user.id]
      );
      return res.status(403).json({
        error: 'Licencia vencida',
        license_expired: true,
        license_end: user.license_end
      });
    }

    if (user.license_status === 'suspended') {
      return res.status(403).json({
        error: 'Licencia suspendida',
        license_suspended: true
      });
    }

    next();
  } catch (err) {
    res.status(503).json({ error: 'No se pudo verificar la licencia' });
  }
}

// ── MIDDLEWARE DE ADMIN ──────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    const role = result.rows[0]?.role;
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Acceso restringido a administradores' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows.length || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Acceso restringido al super administrador' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}

// ── GET: Estado de licencia del usuario actual ───────────────
app.get('/api/license/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role, features, license_type, license_status, license_start, license_end
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = result.rows[0];
    const now = new Date();
    const end = user.license_end ? new Date(user.license_end) : null;
    const daysLeft = end ? Math.ceil((end - now) / (1000 * 60 * 60 * 24)) : null;

    res.json({
      ...user,
      days_left: daysLeft,
      is_expired: end ? end < now : false,
      is_active: user.license_status === 'active' && (!end || end >= now)
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ADMIN: Listar todos los usuarios con licencia ────────────
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.name, u.role,
        u.license_type, u.license_status, u.license_start, u.license_end,
        u.created_at, u.features, u.notification_emails, u.storage_limit_mb,
        COUNT(DISTINCT d.id) as device_count,
        COUNT(DISTINCT c.id) as content_count,
        COUNT(DISTINCT p.id) as playlist_count,
        (SELECT COUNT(*) FROM agents a JOIN branches b ON b.id = a.branch_id WHERE b.user_id = u.id) as agent_count,
        (
          (SELECT COALESCE(SUM(size_bytes),0) FROM content         WHERE user_id = u.id) +
          (SELECT COALESCE(SUM(size_bytes),0) FROM fids_media      WHERE user_id = u.id) +
          (SELECT COALESCE(SUM(size_bytes),0) FROM product_assets  WHERE user_id = u.id) +
          (SELECT COALESCE(SUM(size_bytes),0) FROM creative_pieces WHERE user_id = u.id)
        ) as storage_used_bytes
      FROM users u
      LEFT JOIN devices d ON d.user_id = u.id
      LEFT JOIN content c ON c.user_id = u.id
      LEFT JOIN playlists p ON p.user_id = u.id
      WHERE u.role NOT IN ('agent')
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    const now = new Date();
    const users = result.rows.map(u => {
      const usedBytes = Number(u.storage_used_bytes) || 0;
      const limitMb = u.storage_limit_mb;
      const unlimited = limitMb === null || limitMb === undefined;
      const limitBytes = unlimited ? null : limitMb * 1024 * 1024;
      const percent = unlimited ? 0 : Math.min(100, Math.round((usedBytes / limitBytes) * 100));
      return {
        ...u,
        days_left: u.license_end ? Math.ceil((new Date(u.license_end) - now) / (1000 * 60 * 60 * 24)) : null,
        is_expired: u.license_end ? new Date(u.license_end) < now : false,
        storage_used_mb: Math.round(usedBytes / 1024 / 1024 * 10) / 10,
        storage_percent: percent,
        storage_unlimited: unlimited
      };
    });

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// S157: PATCH storage limit por usuario (super admin)
app.patch('/api/admin/users/:userId/storage-limit', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const { storage_limit_mb } = req.body; // number o null (ilimitado)
    const val = (storage_limit_mb === null || storage_limit_mb === undefined || storage_limit_mb === '')
      ? null
      : parseInt(storage_limit_mb, 10);
    if (val !== null && (Number.isNaN(val) || val < 0)) {
      return res.status(400).json({ error: 'storage_limit_mb inválido' });
    }
    await pool.query('UPDATE users SET storage_limit_mb = $1 WHERE id = $2', [val, userId]);
    res.json({ success: true, storage_limit_mb: val });
  } catch (err) {
    console.error('❌ Error PATCH storage-limit:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Refrescar token con features actualizados ────────────────
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, role, features FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = result.rows[0];
    const isAdmin = user.role === 'admin';
    const features = isAdmin
      ? { turnos: true, analytics: true }
      : (user.features || { turnos: false, analytics: false });
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, features },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ success: true, token, user: { ...user, features } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LOCATIONS (Sedes signage) ─────────────────────────────────
// Admin ve todas; cliente ve solo las suyas

app.get('/api/admin/all-locations', authenticateToken, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const q = isAdmin
      ? 'SELECT l.*, u.name AS owner_name, u.email AS owner_email FROM locations l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC'
      : 'SELECT * FROM locations WHERE user_id = $1 ORDER BY created_at DESC';
    const params = isAdmin ? [] : [req.user.id];
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/locations', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM locations WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/locations', authenticateToken, async (req, res) => {
  try {
    const { name, city, country = 'Colombia', user_id } = req.body;
    if (!name || !city) return res.status(400).json({ error: 'name y city requeridos' });
    const ownerId = req.user.role === 'admin' && user_id ? user_id : req.user.id;
    const { rows } = await pool.query(
      'INSERT INTO locations (user_id, name, city, country) VALUES ($1,$2,$3,$4) RETURNING *',
      [ownerId, name, city, country]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/locations/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user.role === 'admin';
    const q = isAdmin
      ? 'DELETE FROM locations WHERE id = $1 RETURNING id'
      : 'DELETE FROM locations WHERE id = $1 AND user_id = $2 RETURNING id';
    const params = isAdmin ? [id] : [id, req.user.id];
    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: 'Sede no encontrada' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/devices/:deviceId/location', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { location_id } = req.body;
    const isAdmin = req.user.role === 'admin';
    const q = isAdmin
      ? 'UPDATE devices SET location_id = $1 WHERE device_id = $2 RETURNING device_id, location_id'
      : 'UPDATE devices SET location_id = $1 WHERE device_id = $2 AND user_id = $3 RETURNING device_id, location_id';
    const params = isAdmin ? [location_id || null, deviceId] : [location_id || null, deviceId, req.user.id];
    const { rows } = await pool.query(q, params);
    if (!rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE dispositivo ───────────────────────────────────────
// ── ADMIN: cambiar model de un device ─────────────────────── // RPI5-MODEL-ADMIN v1
app.patch('/api/admin/devices/:deviceId/model', authenticateToken, requireAdmin, async (req, res) => {
  const { deviceId } = req.params;
  const { model } = req.body || {};
  const allowed = ['rpi4', 'rpi5', 'windows'];
  if (!allowed.includes(model)) {
    return res.status(400).json({ error: `model inválido, debe ser uno de ${allowed.join('|')}` });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE devices SET model=$1 WHERE device_id=$2 RETURNING device_id, model`,
      [model, deviceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'device no encontrado' });
    console.log(`🏷️  device.model actualizado: ${deviceId} → ${model}`);
    res.json({ success: true, ...rows[0] });
  } catch (err) {
    console.error('❌ PATCH device model:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/devices/:deviceId', authenticateToken, requireAdmin, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { rows } = await pool.query('DELETE FROM devices WHERE device_id = $1 RETURNING device_id, name', [deviceId]);
    if (!rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    console.log(`🗑️ Dispositivo eliminado: ${rows[0].name || deviceId}`);
    res.json({ success: true, device_id: rows[0].device_id });
  } catch (err) {
    console.error('❌ Error eliminando dispositivo:', err);
    res.status(500).json({ error: err.message });
  }
});

// RPI5-READINESS-CLIENT v1
app.get('/api/rpi5-readiness/:deviceId', authenticateToken, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const dq = await pool.query(
      `SELECT id, device_id, name, user_id, model, hdmi0_playlist_id, hdmi1_playlist_id
         FROM devices WHERE device_id=$1`, [deviceId]
    );
    if (!dq.rows.length) return res.status(404).json({ error: 'device no encontrado' });
    const device = dq.rows[0];
    if (device.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    if (device.model !== 'rpi5') {
      return res.status(400).json({ error: `device.model='${device.model}', no es rpi5` });
    }
    const totals = await pool.query(
      `SELECT hevc_status, COUNT(*)::int AS n
         FROM content WHERE user_id=$1 AND type='video'
         GROUP BY hevc_status`, [device.user_id]
    );
    const by_status = { ready:0, pending:0, processing:0, failed:0, not_applicable:0 };
    totals.rows.forEach(r => { by_status[r.hevc_status] = r.n; });
    const playlistIds = [device.hdmi0_playlist_id, device.hdmi1_playlist_id].filter(Boolean);
    let assigned = { total:0, playable:0, blocked:[] };
    if (playlistIds.length) {
      const items = await pool.query(
        `SELECT DISTINCT c.id, c.title, c.filename, c.hevc_status, c.hevc_error
           FROM playlist_items pi
           JOIN content c ON pi.content_id = c.id
          WHERE pi.playlist_id = ANY($1::int[]) AND c.type='video'`,
        [playlistIds]
      );
      assigned.total    = items.rows.length;
      assigned.playable = items.rows.filter(r => r.hevc_status === 'ready').length;
      assigned.blocked  = items.rows
        .filter(r => r.hevc_status !== 'ready')
        .map(r => ({
          content_id: r.id, title: r.title, filename: r.filename,
          status: r.hevc_status, error: r.hevc_error
        }));
    }
    res.json({
      device: { device_id: device.device_id, name: device.name, user_id: device.user_id, model: device.model },
      tenant_videos: { total: Object.values(by_status).reduce((a,b)=>a+b, 0), by_status },
      assigned_playlists: { playlist_ids: playlistIds, ...assigned },
      ready_to_pair: assigned.blocked.length === 0
    });
  } catch (err) {
    console.error('rpi5-readiness client GET:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: RPi5 Readiness (estado + trigger reencode) ─────── // RPI5-READINESS-ADMIN v1
app.get('/api/admin/rpi5-readiness/:deviceId', authenticateToken, requireAdmin, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const dq = await pool.query(
      `SELECT id, device_id, name, user_id, model, hdmi0_playlist_id, hdmi1_playlist_id
         FROM devices WHERE device_id=$1`, [deviceId]
    );
    if (!dq.rows.length) return res.status(404).json({ error: 'device no encontrado' });
    const device = dq.rows[0];
    if (device.model !== 'rpi5') {
      return res.status(400).json({ error: `device.model='${device.model}', no es rpi5` });
    }

    const totals = await pool.query(
      `SELECT hevc_status, COUNT(*)::int AS n
         FROM content WHERE user_id=$1 AND type='video'
         GROUP BY hevc_status`, [device.user_id]
    );
    const by_status = { ready:0, pending:0, processing:0, failed:0, not_applicable:0 };
    totals.rows.forEach(r => { by_status[r.hevc_status] = r.n; });

    const playlistIds = [device.hdmi0_playlist_id, device.hdmi1_playlist_id].filter(Boolean);
    let assigned = { total:0, playable:0, blocked:[] };
    if (playlistIds.length) {
      const items = await pool.query(
        `SELECT DISTINCT c.id, c.title, c.filename, c.hevc_status, c.hevc_error
           FROM playlist_items pi
           JOIN content c ON pi.content_id = c.id
          WHERE pi.playlist_id = ANY($1::int[]) AND c.type='video'`,
        [playlistIds]
      );
      assigned.total    = items.rows.length;
      assigned.playable = items.rows.filter(r => r.hevc_status === 'ready').length;
      assigned.blocked  = items.rows
        .filter(r => r.hevc_status !== 'ready')
        .map(r => ({
          content_id: r.id, title: r.title, filename: r.filename,
          status: r.hevc_status, error: r.hevc_error
        }));
    }

    res.json({
      device: {
        device_id: device.device_id, name: device.name,
        user_id: device.user_id, model: device.model
      },
      tenant_videos: {
        total: Object.values(by_status).reduce((a,b)=>a+b, 0),
        by_status
      },
      assigned_playlists: {
        playlist_ids: playlistIds,
        ...assigned
      },
      ready_to_pair: assigned.blocked.length === 0
    });
  } catch (err) {
    console.error('❌ rpi5-readiness GET:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/rpi5-readiness/:deviceId/enqueue', authenticateToken, requireAdmin, async (req, res) => {
  const { deviceId } = req.params;
  const { confirm, expected_count } = req.body || {};
  try {
    const dq = await pool.query(
      `SELECT device_id, user_id, model FROM devices WHERE device_id=$1`, [deviceId]
    );
    if (!dq.rows.length) return res.status(404).json({ error: 'device no encontrado' });
    const device = dq.rows[0];
    if (device.model !== 'rpi5') {
      return res.status(400).json({ error: `device.model='${device.model}', no es rpi5` });
    }

    // Candidatos: videos del tenant en not_applicable o failed (los ready ya están,
    // los pending/processing ya están encolados — no re-encolar).
    const cand = await pool.query(
      `SELECT id, filename, hevc_status
         FROM content
        WHERE user_id=$1 AND type='video'
          AND hevc_status IN ('not_applicable','failed')
        ORDER BY id`,
      [device.user_id]
    );
    const preview = {
      candidate_count: cand.rows.length,
      by_status: {
        not_applicable: cand.rows.filter(r => r.hevc_status === 'not_applicable').length,
        failed:         cand.rows.filter(r => r.hevc_status === 'failed').length
      },
      sample: cand.rows.slice(0, 10).map(r => ({ id: r.id, filename: r.filename, status: r.hevc_status }))
    };

    // dry_run OBLIGATORIO: sin confirm=true → devuelve preview y sale.
    if (confirm !== true) {
      return res.json({
        dry_run: true, ...preview,
        note: 'Para ejecutar: POST con {confirm:true, expected_count:<candidate_count>}. El expected_count debe coincidir exactamente con el preview actual.'
      });
    }

    // Con confirm=true, exigimos expected_count exacto (anti-race).
    if (typeof expected_count !== 'number' || expected_count !== preview.candidate_count) {
      return res.status(409).json({
        error: 'expected_count no coincide con el preview actual',
        expected_count_received: expected_count,
        candidate_count_now:     preview.candidate_count
      });
    }

    if (preview.candidate_count === 0) {
      return res.json({ enqueued: 0, note: 'nada que encolar' });
    }

    const ids = cand.rows.map(r => r.id);
    const upd = await pool.query(
      `UPDATE content
          SET hevc_status='pending',
              hevc_error='enqueued via admin rpi5-readiness (' || $2::text || ') @ ' || NOW()::text
        WHERE id = ANY($1::int[])
        RETURNING id`,
      [ids, deviceId]
    );
    console.log(`📼 rpi5-readiness: encolados ${upd.rows.length} videos del user_id=${device.user_id} vía device=${deviceId}`);
    res.json({ enqueued: upd.rows.length, ids: upd.rows.map(r => r.id) });
  } catch (err) {
    console.error('❌ rpi5-readiness POST:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Actualizar features de un usuario ─────────────────
app.put('/api/admin/users/:userId/features', authenticateToken, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { features } = req.body;
  if (!features) return res.status(400).json({ error: 'features requerido' });
  try {
    const result = await pool.query(
      'UPDATE users SET features = $1 WHERE id = $2 RETURNING id, email, name, features',
      [JSON.stringify(features), userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ success: true, user: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Toggle individual de un feature ───────────────────
app.patch('/api/admin/users/:userId/features/toggle', authenticateToken, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { feature, enabled } = req.body;
  const allowed = ['turnos', 'analytics', 'dual_hdmi', 'onpremise', 'multisede', 'queue_v2_appointments', 'queue_v2_public_booking', 'queue_v2_bulk', 'queue_v2_agent_notes', 'queue_v2_calendars', 'events_v1'];
  if (!feature || !allowed.includes(feature)) return res.status(400).json({ error: 'feature inválido' });
  try {
    const { rows } = await pool.query('SELECT features FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const features = Object.assign({ turnos: false, analytics: false, dual_hdmi: false, onpremise: false, multisede: false }, rows[0].features || {});
    features[feature] = !!enabled;
    const result = await pool.query(
      'UPDATE users SET features = $1 WHERE id = $2 RETURNING id, email, name, features',
      [JSON.stringify(features), userId]
    );
    res.json({ success: true, features: result.rows[0].features });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: Ver dispositivos de un usuario específico ─────────
// ── ADMIN: Agentes de un usuario (tenant) ──────────────────
app.get('/api/admin/users/:userId/agents', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.name, a.active, a.avatar_color,
             b.id as branch_id, b.name as branch_name,
             u.email as user_email, u.id as user_id
      FROM agents a
      JOIN branches b ON b.id = a.branch_id
      JOIN users u ON u.id = a.user_id
      WHERE b.user_id = $1
      ORDER BY b.name, a.name
    `, [req.params.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/admin/users/:userId/devices', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(`
      SELECT d.*,
             p0.name as hdmi0_playlist_name,
             p1.name as hdmi1_playlist_name
      FROM devices d
      LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
      LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
      WHERE d.user_id = $1
      ORDER BY d.created_at DESC
    `, [userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ADMIN: Todos los dispositivos de todos los usuarios ───────
// S172j — acepta super admin y clients con multisede (scoping por user_id automático)
app.get('/api/admin/all-devices', authenticateToken, async (req, res) => {
  try {
    const uRow = await pool.query('SELECT role, features FROM users WHERE id = $1', [req.user.id]);
    if (!uRow.rows.length) return res.status(401).json({ error: 'Usuario no encontrado' });
    const role = uRow.rows[0].role;
    const isAdmin = role === 'admin';
    const isMultisede = (role === 'client' || role === 'user') && uRow.rows[0].features?.multisede === true;
    if (!isAdmin && !isMultisede) {
      return res.status(403).json({ error: 'Acceso restringido' });
    }
    const params = isAdmin ? [] : [req.user.id];
    const where  = isAdmin ? '' : 'WHERE d.user_id = $1';
    const result = await pool.query(`
      SELECT d.*,
             u.email as user_email, u.name as user_name,
             u.license_status, u.license_end,
             p0.name as hdmi0_playlist_name,
             p1.name as hdmi1_playlist_name
      FROM devices d
      LEFT JOIN users u ON d.user_id = u.id
      LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
      LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
      ${where}
      ORDER BY u.name ASC, d.created_at DESC
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ /api/admin/all-devices:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/admin/devices/:device_id/tunnel-status — comprueba si el túnel SSH
// inverso del RPi está activo (VPS localhost:PORT tiene LISTEN).
app.get('/api/admin/devices/:device_id/tunnel-status', authenticateToken, requireAdmin, async (req, res) => {
  const { device_id } = req.params;
  try {
    const r = await pool.query('SELECT tunnel_port FROM devices WHERE device_id = $1', [device_id]);
    const port = r.rows[0]?.tunnel_port || 2222;
    const net = require('net');
    const active = await new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch(_){} resolve(v); } };
      sock.setTimeout(1500);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error',   () => finish(false));
      sock.connect(port, '127.0.0.1');
    });
    res.json({ device_id, port, active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CEC Monitor — disponible para cualquier usuario autenticado ─────────────
// Admin ve todos los dispositivos; otros usuarios solo ven los suyos
app.get('/api/admin/cec-monitor', authenticateToken, async (req, res) => {
  try {
    const DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const now   = new Date();
    const today = DAYS[now.getDay()];
    const timeNow = now.toTimeString().slice(0, 5);

    const isAdmin = req.user.role === 'admin';
    const userFilter = isAdmin ? '' : 'AND d.user_id = $3';
    const params = isAdmin ? [today, timeNow] : [today, timeNow, req.user.id];

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (d.device_id)
        d.device_id, d.name, d.tv_status, d.alerted_at, d.last_seen, d.status AS device_status,
        u.email AS owner_email, u.name AS owner_name,
        s.time_on::text AS time_on, s.time_off::text AS time_off, s.active AS sched_active,
        ($1 = ANY(s.days) AND $2::time >= s.time_on AND $2::time <= s.time_off) AS in_window
      FROM devices d
      JOIN tv_schedules s ON s.device_id = d.device_id
      JOIN users u ON u.id = d.user_id
      WHERE (d.platform IS NULL OR d.platform != 'windows')
      ${userFilter}
      ORDER BY d.device_id, s.active DESC, s.time_on
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Renovar licencia ──────────────────────────────────
// ── S158e: ADMIN crea cliente (con licencia + contraseña temporal + email) ──
app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, license_type, months } = req.body;
    if (!name || !email || !license_type || !months) {
      return res.status(400).json({ error: 'name, email, license_type y months son requeridos' });
    }
    const emailNorm = String(email).trim().toLowerCase();

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [emailNorm]);
    if (exists.rows.length) return res.status(409).json({ error: 'email_ya_existe' });

    // Password temporal 12 chars (alfanum sin ambiguos)
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let tempPassword = '';
    for (let i = 0; i < 12; i++) tempPassword += alphabet[Math.floor(Math.random() * alphabet.length)];
    const hash = await bcrypt.hash(tempPassword, 10);

    const now = new Date();
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + parseInt(months));

    const LICENSE_FEATURES = {
      cms:          { turnos: false, analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_sencilla: { turnos: false, analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_doble:    { turnos: false, analytics: false, dual_hdmi: true,  dual_hdmi_mode: 'mirror',      onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_pro:      { turnos: false, analytics: false, dual_hdmi: true,  dual_hdmi_mode: 'independent', onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_queue:    { turnos: true,  analytics: true,  dual_hdmi: false, onpremise: false, queue_v2_appointments: true,  queue_v2_public_booking: true,  queue_v2_bulk: true,  queue_v2_agent_notes: true,  queue_v2_calendars: false, events_v1: false },
      queue:        { turnos: true,  analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: true,  queue_v2_public_booking: true,  queue_v2_bulk: true,  queue_v2_agent_notes: true,  queue_v2_calendars: false, events_v1: false },
      windows:      { turnos: true,  analytics: false, dual_hdmi: false, onpremise: true,  queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
    };
    const feats = LICENSE_FEATURES[license_type] || {};

    const ins = await pool.query(`
      INSERT INTO users (name, email, password, role, phone, license_type, license_status, license_start, license_end, features, storage_limit_mb)
      VALUES ($1, $2, $3, 'client', $4, $5, 'active', $6, $7, $8::jsonb, 500)
      RETURNING id, name, email, license_type, license_end
    `, [name, emailNorm, hash, phone || null, license_type, now, endDate, JSON.stringify(feats)]);

    const newUser = ins.rows[0];

    // Historial
    try {
      await pool.query(`
        INSERT INTO license_history (user_id, action, months, license_type, old_end, new_end, note, created_by)
        VALUES ($1, 'renew', $2, $3, NULL, $4, 'Alta inicial (admin)', $5)
      `, [newUser.id, months, license_type, endDate, req.user.id]);
    } catch(e) { console.warn('⚠️ license_history insert:', e.message); }

    // Email de bienvenida con credenciales
    try {
      await emailService.sendWelcomeEmail(
        { email: emailNorm, name, license_type },
        license_type,
        { credentials: { email: emailNorm, tempPassword } }
      );
    } catch(e) { console.warn('⚠️ Email bienvenida:', e.message); }

    console.log(`✅ Cliente creado por admin: ${emailNorm} (${license_type}, ${months}m)`);
    res.json({ success: true, user: newUser });
  } catch (err) {
    console.error('❌ Error creando cliente:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/users/:userId/license/renew', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { months, license_type, note } = req.body;

    if (!months || months < 1) {
      return res.status(400).json({ error: 'Meses de renovación requeridos' });
    }

    // Obtener licencia actual
    const userResult = await pool.query(
      'SELECT id, email, name, license_end, license_status FROM users WHERE id = $1',
      [userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = userResult.rows[0];
    const now = new Date();

    // Si la licencia está vencida, renovar desde hoy; si está activa, sumar desde el vencimiento actual
    const baseDate = user.license_end && new Date(user.license_end) > now
      ? new Date(user.license_end)
      : now;

    const newEnd = new Date(baseDate);
    newEnd.setMonth(newEnd.getMonth() + parseInt(months));

    // Actualizar licencia
    const updateResult = await pool.query(`
      UPDATE users SET
        license_status = 'active',
        license_end    = $1,
        license_type   = COALESCE($2, license_type)
      WHERE id = $3
      RETURNING *
    `, [newEnd, license_type || null, userId]);

    // S158: detectar si es la PRIMERA licencia del usuario (antes del INSERT)
    const histCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM license_history WHERE user_id = $1 AND action = 'renew'`,
      [userId]
    );
    const isFirstLicense = histCount.rows[0].n === 0;

    // Registrar en historial
    await pool.query(`
      INSERT INTO license_history (user_id, action, months, license_type, old_end, new_end, note, created_by)
      VALUES ($1, 'renew', $2, $3, $4, $5, $6, $7)
    `, [userId, months, license_type || updateResult.rows[0].license_type,
        user.license_end, newEnd, note || null, req.user.id]);

    // Notificar a los dispositivos del usuario via Socket.io
    const devices = await pool.query('SELECT device_id FROM devices WHERE user_id = $1', [userId]);
    devices.rows.forEach(d => {
      io.emit(`license-updated-${d.device_id}`, { status: 'active', license_end: newEnd });
    });

    // Enviar email de confirmación (renovación) o de bienvenida (primera licencia)
    try {
      if (isFirstLicense) {
        await emailService.sendWelcomeEmail(
          { email: user.email, name: user.name, license_type: updateResult.rows[0].license_type },
          updateResult.rows[0].license_type
        );
      } else {
        await emailService.sendLicenseRenewedEmail(
          { email: user.email, name: user.name },
          { months, new_end: newEnd, license_type: updateResult.rows[0].license_type }
        );
      }
    } catch(e) { console.warn('⚠️ Error enviando email de licencia:', e.message); }

    // ── Auto-asignar features según tipo de licencia ──────────
    // El admin puede sobreescribir después con los checkboxes.
    // Se hace MERGE (||) para no borrar features que ya tenía.
    const LICENSE_FEATURES = {
      cms:          { turnos: false, analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_sencilla: { turnos: false, analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_doble:    { turnos: false, analytics: false, dual_hdmi: true,  dual_hdmi_mode: 'mirror',      onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_pro:      { turnos: false, analytics: false, dual_hdmi: true,  dual_hdmi_mode: 'independent', onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      cms_queue: { turnos: true,  analytics: true,  dual_hdmi: false, onpremise: false, queue_v2_appointments: true,  queue_v2_public_booking: true,  queue_v2_bulk: true,  queue_v2_agent_notes: true,  queue_v2_calendars: false, events_v1: false },
      queue:     { turnos: true,  analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: true,  queue_v2_public_booking: true,  queue_v2_bulk: true,  queue_v2_agent_notes: true,  queue_v2_calendars: false, events_v1: false },
      rpi:       { turnos: false, analytics: false, dual_hdmi: false, onpremise: false, queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
      windows:   { turnos: true,  analytics: false, dual_hdmi: false, onpremise: true,  queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false },
    };
    const finalType = license_type || updateResult.rows[0].license_type;
    if (finalType && LICENSE_FEATURES[finalType]) {
      await pool.query(
        `UPDATE users
         SET features = COALESCE(features, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify(LICENSE_FEATURES[finalType]), userId]
      );
      console.log(`🔑 Features auto-asignados para ${user.email} (${finalType}):`, LICENSE_FEATURES[finalType]);
      // Notificar al usuario para que refresque su JWT
      io.to(`user_${userId}`).emit('features_updated', { features: LICENSE_FEATURES[finalType] });
    }

    console.log(`✅ Licencia renovada: ${user.email} +${months} meses → ${newEnd.toLocaleDateString()}`);
    res.json({ success: true, user: updateResult.rows[0], new_end: newEnd });
  } catch (err) {
    console.error('❌ Error renovando licencia:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ADMIN: Suspender licencia ────────────────────────────────
app.post('/api/admin/users/:userId/license/suspend', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { note } = req.body;

    const userResult = await pool.query('SELECT email, name, license_end FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    const user = userResult.rows[0];

    await pool.query("UPDATE users SET license_status = 'suspended' WHERE id = $1", [userId]);

    // Al suspender: apagar todos los flags Queue v2 en la BD
    const Q2_OFF = { queue_v2_appointments: false, queue_v2_public_booking: false, queue_v2_bulk: false, queue_v2_agent_notes: false, queue_v2_calendars: false, events_v1: false };
    await pool.query(
      "UPDATE users SET features = COALESCE(features, '{}'::jsonb) || $1::jsonb WHERE id = $2",
      [JSON.stringify(Q2_OFF), userId]
    );
    io.to(`user_${userId}`).emit('features_updated', Q2_OFF);

    await pool.query(`
      INSERT INTO license_history (user_id, action, note, created_by)
      VALUES ($1, 'suspend', $2, $3)
    `, [userId, note || null, req.user.id]);

    // Notificar dispositivos
    const devices = await pool.query('SELECT device_id FROM devices WHERE user_id = $1', [userId]);
    devices.rows.forEach(d => {
      io.emit(`license-updated-${d.device_id}`, { status: 'suspended' });
    });

    console.log(`⚠️ Licencia suspendida: ${user.email}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ADMIN: Historial de licencia de un usuario ───────────────
app.get('/api/admin/users/:userId/license/history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lh.*, u.email as admin_email
      FROM license_history lh
      LEFT JOIN users u ON lh.created_by = u.id
      WHERE lh.user_id = $1
      ORDER BY lh.created_at DESC
    `, [req.params.userId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── ADMIN: Eliminar usuario ──────────────────────────────────
app.put('/api/admin/users/:userId/role', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['staff', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Rol invalido. Valores permitidos: staff, user' });
    }
    const check = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.userId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (check.rows[0].role === 'admin') {
      return res.status(403).json({ error: 'No se puede cambiar el rol de un super administrador' });
    }
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.userId]);
    console.log(`✅ Rol actualizado: user_id=${req.params.userId} → ${role}`);
    res.json({ success: true, role });
  } catch (err) {
    console.error('❌ Error cambiando rol:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/admin/users/:userId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // No permitir eliminar al propio admin
    if (parseInt(userId) === req.user.id) {
      return res.status(400).json({ error: 'No puedes eliminar tu propio usuario' });
    }

    const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = userResult.rows[0];

    // Eliminar en cascada (devices, content, playlists, activation_codes, license_history)
    await pool.query('DELETE FROM activation_codes WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM license_history WHERE user_id = $1', [userId]);
    await pool.query('UPDATE devices SET user_id = NULL WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = $1)', [userId]);
    await pool.query('DELETE FROM playlists WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM content WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    console.log(`🗑️ Usuario eliminado: ${user.email} por admin ${req.user.id}`);
    res.json({ success: true, message: `Usuario ${user.email} eliminado` });
  } catch (err) {
    console.error('❌ Error eliminando usuario:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── PERFIL DE USUARIO — Logo y datos ─────────────────────────
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, role, license_type, license_status, license_end, logo_url FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Subir logo del cliente
app.post('/api/user/logo', authenticateToken, async (req, res) => {
  try {
    if (!req.files || !req.files.logo) return res.status(400).json({ error: 'No se recibió archivo' });
    const file = req.files.logo;
    const allowed = ['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'];
    if (!allowed.includes(file.mimetype)) return res.status(400).json({ error: 'Formato no soportado. Usa JPG, PNG, SVG o WebP' });
    if (file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'El logo no debe superar 2MB' });

    const uploadsDir = path.join(process.cwd(), 'uploads', 'logos');
    if (!require('fs').existsSync(uploadsDir)) require('fs').mkdirSync(uploadsDir, { recursive: true });

    const ext      = path.extname(file.name) || '.png';
    const filename = `logo_${req.user.id}${ext}`;
    const filepath = path.join(uploadsDir, filename);
    await file.mv(filepath);

    const logoUrl = `/uploads/logos/${filename}`;
    await pool.query('UPDATE users SET logo_url = $1 WHERE id = $2', [logoUrl, req.user.id]);

    console.log(`✅ Logo subido: ${req.user.id} → ${logoUrl}`);
    res.json({ success: true, logo_url: logoUrl });
  } catch (err) {
    console.error('❌ Error subiendo logo:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── RPi: Verificar licencia del dispositivo ──────────────────
// Llamado desde sync-app.js al arrancar
app.get('/api/devices/:device_id/license', async (req, res) => {
  try {
    const { device_id } = req.params;
    const result = await pool.query(`
      SELECT u.license_status, u.license_end, u.license_type, u.features, u.role
      FROM devices d
      JOIN users u ON d.user_id = u.id
      WHERE d.device_id = $1
    `, [device_id]);

    if (!result.rows.length) {
      return res.json({ status: 'unknown', needs_activation: true });
    }

    const { license_status, license_end, license_type, features, role } = result.rows[0];
    const now = new Date();
    const isExpired = license_end && new Date(license_end) < now;
    const daysLeft = license_end ? Math.ceil((new Date(license_end) - now) / (1000 * 60 * 60 * 24)) : null;

    // Admin siempre tiene todos los features activos
    const resolvedFeatures = role === 'admin'
      ? { turnos: true, analytics: true, dual_hdmi: true, onpremise: true }
      : (features || { turnos: false, analytics: false, dual_hdmi: false, onpremise: false });

    res.json({
      status: isExpired ? 'expired' : license_status,
      license_end,
      license_type,
      days_left: daysLeft,
      active: !isExpired && license_status === 'active',
      features: resolvedFeatures
    });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── CRON: Verificar licencias vencidas y enviar avisos ───────
// Se ejecuta cada 24 horas
setInterval(async () => {
  try {
    const now = new Date();

    // Marcar como expired las que vencieron
    await pool.query(`
      UPDATE users SET license_status = 'expired'
      WHERE license_end < $1 AND license_status = 'active'
    `, [now]);

    // Avisar 30 días antes
    const in30 = new Date(now); in30.setDate(in30.getDate() + 30);
    const expiring30 = await pool.query(`
      SELECT id, email, name, license_end FROM users
      WHERE license_status = 'active'
        AND license_end BETWEEN $1 AND $2
        AND NOT EXISTS (
          SELECT 1 FROM license_history
          WHERE user_id = users.id AND action = 'warning_30d'
            AND created_at > NOW() - INTERVAL '25 days'
        )
    `, [now, in30]);

    for (const user of expiring30.rows) {
      await emailService.sendLicenseExpiringEmail(user, 30).catch(() => {});
      await pool.query(
        "INSERT INTO license_history (user_id, action) VALUES ($1, 'warning_30d')",
        [user.id]
      );
    }

    // Avisar 7 días antes
    const in7 = new Date(now); in7.setDate(in7.getDate() + 7);
    const expiring7 = await pool.query(`
      SELECT id, email, name, license_end FROM users
      WHERE license_status = 'active'
        AND license_end BETWEEN $1 AND $2
        AND NOT EXISTS (
          SELECT 1 FROM license_history
          WHERE user_id = users.id AND action = 'warning_7d'
            AND created_at > NOW() - INTERVAL '5 days'
        )
    `, [now, in7]);

    for (const user of expiring7.rows) {
      await emailService.sendLicenseExpiringEmail(user, 7).catch(() => {});
      await pool.query(
        "INSERT INTO license_history (user_id, action) VALUES ($1, 'warning_7d')",
        [user.id]
      );
    }

    if (expiring30.rows.length || expiring7.rows.length) {
      console.log(`📧 Avisos de licencia enviados: ${expiring30.rows.length} a 30 días, ${expiring7.rows.length} a 7 días`);
    }
  } catch (err) {
    console.error('❌ Error en verificación de licencias:', err.message);
  }
}, 24 * 60 * 60 * 1000); // Cada 24 horas

// ── CRON: Monitor CEC — alerta cuando TV está apagada en ventana programada ──
async function cecMonitor() {
  try {
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const now  = new Date();
    const today   = DAYS[now.getDay()];
    const timeNow = now.toTimeString().slice(0, 5); // HH:MM

    const { rows } = await pool.query(`
      SELECT DISTINCT ON (d.device_id)
        d.device_id, d.name, d.tv_status, d.alerted_at,
        u.email AS owner_email, u.name AS owner_name,
        s.time_on::text AS time_on, s.time_off::text AS time_off
      FROM devices d
      JOIN tv_schedules s ON s.device_id = d.device_id
      JOIN users u ON u.id = d.user_id
      WHERE s.active = true
        AND $1 = ANY(s.days)
        AND $2::time >= s.time_on
        AND $2::time <= s.time_off
        AND (d.platform IS NULL OR d.platform != 'windows')
      ORDER BY d.device_id, s.time_on
    `, [today, timeNow]);

    for (const d of rows) {
      if (d.tv_status !== 'off') continue;

      // 1 alerta por ventana: no re-alertar si alerted_at >= inicio de esta ventana
      if (d.alerted_at) {
        const windowStart = new Date(now);
        const [h, m] = d.time_on.split(':');
        windowStart.setHours(parseInt(h), parseInt(m), 0, 0);
        if (new Date(d.alerted_at) >= windowStart) continue;
      }

      if (!d.owner_email) continue;
      await emailService.sendCecAlertEmail(
        { email: d.owner_email, name: d.owner_name },
        { device_id: d.device_id, name: d.name },
        { time_on: d.time_on, time_off: d.time_off }
      );
      await pool.query('UPDATE devices SET alerted_at = NOW() WHERE device_id = $1', [d.device_id]);
      console.log(`📺 CEC alert → ${d.owner_email} | ${d.name} (${d.device_id})`);
    }
  } catch (err) {
    console.error('❌ cecMonitor error:', err.message);
  }
}
setInterval(cecMonitor, 5 * 60 * 1000);

// ============================================================
// SONORO QUEUE — API completa
// Agregar en index.js antes de "SOCKET.IO - EVENTOS"
// ============================================================

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN — SUCURSALES
// ══════════════════════════════════════════════════════════════

// GET — Listar sucursales del usuario
app.get('/api/queue/branches', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, COUNT(DISTINCT s.id) as service_count, COUNT(DISTINCT c.id) as counter_count
       FROM branches b
       LEFT JOIN services s ON s.branch_id = b.id AND s.active = true
       LEFT JOIN counters c ON c.branch_id = b.id AND c.active = true
       WHERE b.user_id = $1
       GROUP BY b.id ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST — Crear sucursal
app.post('/api/queue/branches', authenticateToken, async (req, res) => {
  try {
    const { name, address, city, phone, timezone, open_time, close_time,
            appointments_enabled, welcome_message, display_playlist_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      `INSERT INTO branches (user_id, name, address, city, phone, timezone,
        open_time, close_time, appointments_enabled, welcome_message, display_playlist_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.id, name, address, city, phone, timezone || 'America/Bogota',
       open_time || '08:00', close_time || '18:00',
       appointments_enabled || false, welcome_message || 'Bienvenido, por favor tome un turno',
       display_playlist_id || null]
    );
    res.json({ success: true, branch: result.rows[0] });
    console.log(`✅ Sucursal creada: ${name}`);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// PUT — Actualizar sucursal
app.put('/api/queue/branches/:id', authenticateToken, async (req, res) => {
  try {
    const { name, address, city, phone, timezone, open_time, close_time,
            appointments_enabled, welcome_message, display_playlist_id, active } = req.body;
    const result = await pool.query(
      `UPDATE branches SET
        name = COALESCE($1, name), address = COALESCE($2, address),
        city = COALESCE($3, city), phone = COALESCE($4, phone),
        timezone = COALESCE($5, timezone), open_time = COALESCE($6, open_time),
        close_time = COALESCE($7, close_time),
        appointments_enabled = COALESCE($8, appointments_enabled),
        welcome_message = COALESCE($9, welcome_message),
        display_playlist_id = $10,
        active = COALESCE($11, active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $12 AND user_id = $13 RETURNING *`,
      [name, address, city, phone, timezone, open_time, close_time,
       appointments_enabled, welcome_message, display_playlist_id || null,
       active, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ success: true, branch: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// DELETE — Eliminar sucursal
app.delete('/api/queue/branches/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM branches WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET — Tickets actualmente en atención (para lower third del queue display)
// Público desde la RPi (sin JWT) para que queue-display.html pueda consultarlo
app.get('/api/queue/branches/:id/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         t.display_number   AS token_number,
         s.name             AS service_name,
         s.color            AS service_color,
         c.display_name     AS counter_name,
         t.called_at
       FROM tickets t
       LEFT JOIN services  s ON t.service_id  = s.id
       LEFT JOIN counters  c ON t.counter_id  = c.id
       WHERE t.branch_id = $1
         AND t.status    = 'serving'
       ORDER BY t.called_at DESC
       LIMIT 8`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error obteniendo tickets activos:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST — Prueba del display de turnos (admin) — emite token_called de prueba a la sala
app.post('/api/queue/branches/:id/test-display', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const testData = {
    token_id:     'test-' + Date.now(),
    token_number: 'A-99',
    service_name: 'Prueba Display',
    counter_name: 'Módulo 1',
    is_priority:  false,
  };
  io.to(`branch_${id}`).emit('token_called', testData);
  console.log(`🧪 Test display emitido a branch_${id}:`, testData);
  res.json({ ok: true, emitted_to: `branch_${id}`, data: testData });
});

// GET — Config visual del display de turnos (público, sin JWT)
// Devuelve theme, brand_color, logo_url, branch_name para queue-display.html
app.get('/api/queue/branches/:id/display-config', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name,
              COALESCE((config->>'display_theme'),    'dark')     AS theme,
              COALESCE((config->>'brand_color'),      '#FF1B8D')  AS brand_color,
              (config->>'logo_url')                              AS logo_url
       FROM branches WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sucursal no encontrada' });
    const row = result.rows[0];
    res.json({
      theme:       row.theme,
      brand_color: row.brand_color,
      logo_url:    row.logo_url  || null,
      branch_name: row.name,
    });
  } catch (err) {
    console.error('❌ Error display-config:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT — Actualizar config visual del display (requiere JWT del dueño)
app.put('/api/queue/branches/:id/display-config', authenticateToken, async (req, res) => {
  try {
    const { theme, brand_color, logo_url } = req.body;

    // Verificar que la sucursal pertenece al usuario
    const own = await pool.query(
      'SELECT id FROM branches WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (own.rows.length === 0) return res.status(403).json({ error: 'Sin acceso a esta sucursal' });

    // Merge de los campos en la columna config JSONB
    await pool.query(
      `UPDATE branches
       SET config = COALESCE(config, '{}'::jsonb)
                   || jsonb_build_object(
                        'display_theme', $1::text,
                        'brand_color',  $2::text,
                        'logo_url',     $3::text
                      )
       WHERE id = $4`,
      [
        theme      || 'dark',
        brand_color || '#FF1B8D',
        logo_url    || null,
        req.params.id,
      ]
    );

    // Notificar al display en tiempo real si está conectado
    io.to(`branch_${req.params.id}`).emit('branch_config_updated', {
      branch_id: req.params.id,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Error actualizando display-config:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN — SERVICIOS
// ══════════════════════════════════════════════════════════════

app.get('/api/queue/branches/:branchId/services', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COUNT(qt.id) FILTER (WHERE qt.status = 'waiting' AND qt.date_key = CURRENT_DATE) as waiting_count
       FROM services s
       LEFT JOIN queue_tokens qt ON qt.service_id = s.id
       WHERE s.branch_id = $1
       GROUP BY s.id ORDER BY s.priority_level DESC, s.name ASC`,
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/queue/branches/:branchId/services', authenticateToken, async (req, res) => {
  try {
    const { name, description, prefix, color, icon, priority_level, avg_attention_min, max_queue_size } = req.body;
    if (!name || !prefix) return res.status(400).json({ error: 'Nombre y prefijo requeridos' });
    const result = await pool.query(
      `INSERT INTO services (branch_id, name, description, prefix, color, icon, priority_level, avg_attention_min, max_queue_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.branchId, name, description, prefix.toUpperCase(),
       color || '#FF1B8D', icon || 'ticket',
       priority_level || 0, avg_attention_min || 10, max_queue_size || 999]
    );
    res.json({ success: true, service: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.put('/api/queue/services/:id', authenticateToken, async (req, res) => {
  try {
    const { name, description, color, icon, priority_level, avg_attention_min, max_queue_size, active, price, currency } = req.body;
    const result = await pool.query(
      `UPDATE services SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        color = COALESCE($3, color), icon = COALESCE($4, icon),
        priority_level = COALESCE($5, priority_level),
        avg_attention_min = COALESCE($6, avg_attention_min),
        max_queue_size = COALESCE($7, max_queue_size),
        active = COALESCE($8, active),
        price = COALESCE($9::numeric, price),
        currency = COALESCE($10, currency)
       WHERE id = $11 RETURNING *`,
      [name, description, color, icon, priority_level, avg_attention_min, max_queue_size, active,
       price !== undefined ? price : null, currency !== undefined ? currency : null, req.params.id]
    );
    // Telemetría service.price.updated (FRAMEWORK §6.1)
    if (result.rows.length && (price !== undefined || currency !== undefined)) {
      const svc = result.rows[0];
      console.log(JSON.stringify({ event: 'service.price.updated', user_id: req.user.id,
        service_id: svc.id, new_price: svc.price, new_currency: svc.currency, changed_by: req.user.id }));
    }
    if (!result.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({ success: true, service: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/queue/services/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE services SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN — VENTANILLAS
// ══════════════════════════════════════════════════════════════

app.get('/api/queue/branches/:branchId/counters', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
        json_agg(DISTINCT s.id) FILTER (WHERE s.id IS NOT NULL) as service_ids,
        json_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL) as service_names,
        (SELECT a.name FROM agent_sessions asess
         JOIN agents a ON a.id = asess.agent_id
         WHERE asess.counter_id = c.id AND asess.active = true LIMIT 1) as current_agent
       FROM counters c
       LEFT JOIN counter_services cs ON cs.counter_id = c.id
       LEFT JOIN services s ON s.id = cs.service_id
       WHERE c.branch_id = $1
       GROUP BY c.id ORDER BY c.name ASC`,
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/queue/branches/:branchId/counters', authenticateToken, async (req, res) => {
  try {
    const { name, display_name, description, service_ids, rating_enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const result = await pool.query(
      `INSERT INTO counters (branch_id, name, display_name, description, rating_enabled)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.branchId, name, display_name || name, description, rating_enabled !== undefined ? rating_enabled : true]
    );
    const counter = result.rows[0];
    if (service_ids && service_ids.length) {
      for (const sid of service_ids) {
        await pool.query(
          'INSERT INTO counter_services (counter_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [counter.id, sid]
        );
      }
    }
    res.json({ success: true, counter });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.put('/api/queue/counters/:id', authenticateToken, async (req, res) => {
  try {
    const { name, display_name, description, active, service_ids, rating_enabled } = req.body;
    const result = await pool.query(
      `UPDATE counters SET
        name = COALESCE($1, name), display_name = COALESCE($2, display_name),
        description = COALESCE($3, description), active = COALESCE($4, active),
        rating_enabled = COALESCE($6, rating_enabled)
       WHERE id = $5 RETURNING *`,
      [name, display_name, description, active, req.params.id, rating_enabled]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ventanilla no encontrada' });
    if (service_ids !== undefined) {
      await pool.query('DELETE FROM counter_services WHERE counter_id = $1', [req.params.id]);
      for (const sid of service_ids) {
        await pool.query(
          'INSERT INTO counter_services (counter_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.id, sid]
        );
      }
    }
    res.json({ success: true, counter: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// DELETE — Eliminar ventanilla
app.delete('/api/queue/counters/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM counter_services WHERE counter_id = $1', [req.params.id]);
    await pool.query('DELETE FROM counters WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// DELETE — Eliminar agente
app.delete('/api/queue/agents/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM agents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE — ACEPTA JWT DE USUARIO O DE AGENTE
// ══════════════════════════════════════════════════════════════
function authenticateAgentOrUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = decoded;
    next();
  });
}

// ══════════════════════════════════════════════════════════════
// ENDPOINTS PÚBLICOS — PANEL DEL AGENTE (sin JWT previo)
// ══════════════════════════════════════════════════════════════

// GET — Sucursales públicas (solo de usuarios con licencia activa)
app.get('/api/queue/public/branches', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.name, b.address, b.city
       FROM branches b
       JOIN users u ON u.id = b.user_id
       WHERE u.license_status = 'active'
       ORDER BY b.name ASC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET — Ventanillas activas de una sucursal (público)
app.get('/api/queue/public/branches/:branchId/counters', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, display_name, rating_enabled FROM counters WHERE branch_id = $1 AND active = true ORDER BY name ASC',
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET — Servicios activos de una sucursal (público — usado por kiosco y pantalla)
app.get('/api/queue/public/branches/:branchId/services', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name, s.prefix, s.color, s.active, s.avg_attention_min, s.priority_level,
              COUNT(qt.id) FILTER (WHERE qt.status = 'waiting' AND qt.date_key = CURRENT_DATE) as waiting_count
       FROM services s
       LEFT JOIN queue_tokens qt ON qt.service_id = s.id
       WHERE s.branch_id = $1 AND s.active = true
       GROUP BY s.id ORDER BY s.priority_level DESC, s.name ASC`,
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET — Agentes activos de una sucursal (público, solo nombre e id)
app.get('/api/queue/public/branches/:branchId/agents', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, avatar_color FROM agents WHERE branch_id = $1 AND active = true ORDER BY name ASC',
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST — Login del agente con PIN → devuelve JWT
app.post('/api/queue/agent/login', authLimiter, async (req, res) => {
  const { agent_id, pin } = req.body;
  if (!agent_id || !pin) return res.status(400).json({ error: 'agent_id y pin requeridos' });
  try {
    const result = await pool.query(
      `SELECT a.*, b.name as branch_name FROM agents a
       JOIN branches b ON b.id = a.branch_id
       WHERE a.id = $1 AND a.active = true`,
      [agent_id]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Agente no encontrado' });
    const agent = result.rows[0];

    const pinMatch = await bcrypt.compare(String(pin), agent.pin);
    if (!pinMatch) {
      return res.status(401).json({ error: 'PIN incorrecto' });
    }

    const token = jwt.sign(
      { id: agent.user_id || agent.id, agent_id: agent.id, branch_id: agent.branch_id, role: 'agent', name: agent.name },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true, token,
      agent: { id: agent.id, name: agent.name, avatar_color: agent.avatar_color, branch_id: agent.branch_id, branch_name: agent.branch_name }
    });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN — AGENTES
// ══════════════════════════════════════════════════════════════

app.get('/api/queue/branches/:branchId/agents', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*,
        (SELECT COUNT(*) FROM agent_sessions WHERE agent_id = a.id) as total_sessions,
        (SELECT COUNT(*) FROM queue_tokens WHERE agent_id = a.id AND date_key = CURRENT_DATE) as today_tokens,
        (SELECT AVG(score) FROM ratings WHERE agent_id = a.id) as avg_rating,
        (SELECT active FROM agent_sessions WHERE agent_id = a.id AND active = true LIMIT 1) as is_online,
        ci.id AS cal_id,
        ci.calendar_id AS cal_calendar_id,
        (ci.id IS NOT NULL) AS has_calendar,
        ci_o.id AS outlook_cal_id,
        ci_o.calendar_id AS outlook_calendar_id,
        (ci_o.id IS NOT NULL) AS has_outlook
       FROM agents a
       LEFT JOIN calendar_integrations ci ON ci.agent_id = a.id AND ci.provider = 'google'
       LEFT JOIN calendar_integrations ci_o ON ci_o.agent_id = a.id AND ci_o.provider = 'outlook'
       WHERE a.branch_id = $1
       ORDER BY a.name ASC`,
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/queue/branches/:branchId/agents', authenticateToken, async (req, res) => {
  try {
    const { name, pin, avatar_color, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    if (!email) return res.status(400).json({ error: 'Email requerido' });

    const bcrypt = require('bcryptjs');
    const hashedPin = pin ? await bcrypt.hash(pin, 10) : null;

    const userResult = await pool.query(
      `INSERT INTO users (email, password, name, role)
       VALUES ($1, $2, $3, 'agent') RETURNING id`,
      [email, hashedPin || '', name]
    );

    const result = await pool.query(
      `INSERT INTO agents (user_id, branch_id, name, pin, avatar_color)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userResult.rows[0].id, req.params.branchId, name, hashedPin, avatar_color || '#FF1B8D']
    );

    // Obtener datos de la sucursal para el email
    const branchResult = await pool.query('SELECT name FROM branches WHERE id = $1', [req.params.branchId]);
    const branch = branchResult.rows[0] || { name: 'SONORO' };
    const cmsUrl = process.env.CMS_URL || `http://localhost:${process.env.PORT || 5000}`;

    // Enviar email con credenciales
    try {
      await emailService.sendAgentCredentialsEmail(
        { name, pin, email },
        branch,
        cmsUrl
      );
    } catch(e) { console.warn('⚠️ Error enviando email de credenciales:', e.message); }

    console.log(`✅ Agente creado: ${name} (${email})`);
    res.json({ success: true, agent: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.put('/api/queue/agents/:id', authenticateToken, async (req, res) => {
  try {
    const { name, pin, avatar_color, active } = req.body;
    const hashedPin = pin ? await bcrypt.hash(String(pin), 10) : null;
    const result = await pool.query(
      `UPDATE agents SET
        name = COALESCE($1, name), pin = COALESCE($2, pin),
        avatar_color = COALESCE($3, avatar_color), active = COALESCE($4, active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [name, hashedPin, avatar_color, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agente no encontrado' });
    res.json({ success: true, agent: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// OPERACIÓN — GENERAR TURNO (desde kiosco/QR)
// ══════════════════════════════════════════════════════════════

// R0 (Queue v2 Framework §5): generación de turno transaccional.
// Race condition pre-existente cerrada con:
//  1) playerLimiter — rate limit del endpoint público
//  2) Advisory lock por (branch_id, service_id, date_key) — serializa la generación
//     del número correlativo dentro del scope de la transacción
//  3) UNIQUE constraint queue_tokens_branch_service_date_token_uniq — backstop a nivel BD
//  4) Retry con backoff en caso de 23505 (último recurso si dos procesos compiten
//     por el mismo advisory lock — improbable pero defensivo)
const TOKEN_INSERT_MAX_RETRIES = 3;
const TOKEN_INSERT_BACKOFF_MS = [50, 100, 200];

// ─────────────────────────────────────────────────────────────
// Helper compartido R0 + R1 (sesión 65): próximo correlativo
// del día para un (branch, service). Aplica MAX(parte numérica)
// para evitar el bug created_at=transaction_start_time bajo
// concurrencia. Debe llamarse DENTRO de una transacción que
// ya tomó el advisory_xact_lock sobre el mismo scope.
// Devuelve el entero (sin prefijo); el caller formatea.
// ─────────────────────────────────────────────────────────────
async function generateNextTokenNumber(client, branchId, serviceId) {
  const r = await client.query(
    `SELECT COALESCE(
       MAX(CAST(regexp_replace(token_number, '\\D', '', 'g') AS INTEGER)),
       0
     ) AS max_num
     FROM queue_tokens
     WHERE branch_id = $1 AND service_id = $2 AND date_key = CURRENT_DATE`,
    [branchId, serviceId]
  );
  return parseInt(r.rows[0].max_num, 10) + 1;
}

app.post('/api/queue/token', playerLimiter, async (req, res) => {
  const { branch_id, service_id, is_priority, client_name, client_phone, channel } = req.body;
  if (!branch_id || !service_id) {
    return res.status(400).json({ error: 'branch_id y service_id requeridos' });
  }

  let attempt = 0;
  let lastError = null;

  while (attempt < TOKEN_INSERT_MAX_RETRIES) {
    try {
      const outcome = await withTransaction(pool, async (client) => {
        // Advisory lock por (branch_id, service_id, día). Se libera al COMMIT/ROLLBACK.
        // Hashtext devuelve int4; concatenamos branch_id + service_id + fecha para clave estable.
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text)
           )`,
          [branch_id, service_id]
        );

        const serviceResult = await client.query(
          'SELECT * FROM services WHERE id = $1 AND active = true',
          [service_id]
        );
        if (!serviceResult.rows.length) {
          const err = new Error('Servicio no encontrado');
          err.httpStatus = 404;
          throw err;
        }
        const service = serviceResult.rows[0];

        const waitingCount = await client.query(
          `SELECT COUNT(*) FROM queue_tokens
           WHERE branch_id = $1 AND service_id = $2
             AND status = 'waiting' AND date_key = CURRENT_DATE`,
          [branch_id, service_id]
        );
        if (parseInt(waitingCount.rows[0].count) >= service.max_queue_size) {
          const err = new Error('Cola llena para este servicio');
          err.httpStatus = 429;
          throw err;
        }

        // Próximo correlativo del día (helper compartido R0+R1, sesión 65).
        // Comportamiento idéntico al inline previo: MAX(parte numérica)
        // protegido por el advisory_xact_lock que tomamos arriba.
        const nextNum = await generateNextTokenNumber(client, branch_id, service_id);

        const tokenNumber = `${service.prefix}${String(nextNum).padStart(3, '0')}`;
        const displayNumber = tokenNumber;

        // ── Slot estimado para el walk-in (S79) ───────────────────────────
        // Busca el primer intervalo libre del día para este servicio,
        // considerando citas confirmadas + walk-ins con estimated_call_at ya asignado.
        const slotMin = service.slot_duration_minutes || service.avg_attention_min || 30;
        const slotMs  = slotMin * 60 * 1000;

        const occupiedRes = await client.query(
          `SELECT scheduled_at AS t FROM appointments
            WHERE branch_id = $1 AND service_id = $2
              AND (scheduled_at AT TIME ZONE 'America/Bogota')::date
                  = (NOW() AT TIME ZONE 'America/Bogota')::date
              AND status IN ('pending','confirmed','attended')
           UNION ALL
           SELECT estimated_call_at AS t FROM queue_tokens
            WHERE branch_id = $1 AND service_id = $2
              AND date_key = CURRENT_DATE
              AND status IN ('waiting','called','attending')
              AND estimated_call_at IS NOT NULL
           ORDER BY t ASC`,
          [branch_id, service_id]
        );
        const occupied = occupiedRes.rows.map(r => new Date(r.t).getTime());

        // Candidato: ahora, redondeado hacia arriba al próximo múltiplo de slotMin
        let candidate = Math.ceil(Date.now() / slotMs) * slotMs;
        for (const occ of occupied) {
          if (candidate >= occ && candidate < occ + slotMs) {
            candidate = occ + slotMs; // Empujar al siguiente slot libre
          }
        }
        const estimatedCallAt = new Date(candidate);
        // ─────────────────────────────────────────────────────────────────

        const insertResult = await client.query(
          `INSERT INTO queue_tokens
             (branch_id, service_id, token_number, display_number,
              is_priority, channel, client_name, client_phone, estimated_call_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [branch_id, service_id, tokenNumber, displayNumber,
           is_priority || false, channel || 'kiosk',
           client_name || null, client_phone || null, estimatedCallAt]
        );
        const token = insertResult.rows[0];

        await client.query(
          `INSERT INTO token_events (token_id, event_type, metadata)
           VALUES ($1, 'created', $2)`,
          [token.id, JSON.stringify({ channel: channel || 'kiosk', is_priority })]
        );

        const estimatedWait =
          (parseInt(waitingCount.rows[0].count)) * service.avg_attention_min;

        return {
          token,
          service,
          tokenNumber,
          displayNumber,
          estimatedWait,
          waitingCount: parseInt(waitingCount.rows[0].count),
        };
      });

      // Fuera de la transacción: notificar Socket.io (efecto secundario externo)
      io.to(`branch_${branch_id}`).emit('new_token', {
        token: outcome.token,
        service_name: outcome.service.name,
        service_color: outcome.service.color,
        waiting_count: outcome.waitingCount + 1,
        estimated_wait: outcome.estimatedWait,
      });

      console.log(
        `🎫 Turno generado: ${outcome.tokenNumber} — ${outcome.service.name}` +
        (attempt > 0 ? ` (retry ${attempt})` : '')
      );
      return res.json({
        success: true,
        token_number: outcome.tokenNumber,
        display_number: outcome.displayNumber,
        service_name: outcome.service.name,
        service_color: outcome.service.color,
        estimated_wait_minutes: outcome.estimatedWait,
        position_in_queue: outcome.waitingCount + 1,
        token_id: outcome.token.id,
      });
    } catch (err) {
      // Errores funcionales devueltos por la transacción con httpStatus
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }

      // 23505 = unique_violation. Solo reintentamos si es nuestra UNIQUE.
      const isConflict =
        err && err.code === '23505' &&
        (err.constraint === 'queue_tokens_branch_service_date_token_uniq');

      if (isConflict && attempt < TOKEN_INSERT_MAX_RETRIES - 1) {
        const backoff = TOKEN_INSERT_BACKOFF_MS[attempt] || 200;
        console.warn(
          `⚠️ queue.token.conflict_retry attempt=${attempt + 1} branch=${branch_id} ` +
          `service=${service_id} backoff=${backoff}ms`
        );
        await new Promise(r => setTimeout(r, backoff));
        attempt++;
        lastError = err;
        continue;
      }

      console.error('❌ Error generando turno:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }

  // Si salimos del while sin return, agotamos retries
  console.error('❌ Agotados retries en /api/queue/token:', lastError);
  return res.status(503).json({ error: 'Servicio temporalmente saturado, reintenta' });
});

// ══════════════════════════════════════════════════════════════
// OPERACIÓN — SESIÓN DEL AGENTE
// ══════════════════════════════════════════════════════════════

// Abrir sesión (agente llega a su ventanilla)
app.post('/api/queue/agent/session/open', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, counter_id, branch_id } = req.body;

    // Cerrar sesión activa anterior si existe
    await pool.query(
      `UPDATE agent_sessions SET active = false, ended_at = CURRENT_TIMESTAMP
       WHERE agent_id = $1 AND active = true`,
      [agent_id]
    );

    const result = await pool.query(
      `INSERT INTO agent_sessions (agent_id, counter_id, branch_id)
       VALUES ($1,$2,$3) RETURNING *`,
      [agent_id, counter_id, branch_id]
    );

    io.to(`branch_${branch_id}`).emit('agent_online', { agent_id, counter_id });
    res.json({ success: true, session: result.rows[0] });
    console.log(`✅ Sesión abierta: agente ${agent_id} en ventanilla ${counter_id}`);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Cerrar sesión
app.post('/api/queue/agent/session/close', authenticateAgentOrUser, async (req, res) => {
  try {
    const { session_id, branch_id } = req.body;
    const result = await pool.query(
      `UPDATE agent_sessions SET active = false, ended_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *, agent_id, counter_id`,
      [session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sesión no encontrada' });
    io.to(`branch_${branch_id}`).emit('agent_offline', {
      agent_id: result.rows[0].agent_id,
      counter_id: result.rows[0].counter_id
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Verificar si una sesión sigue activa (usado al refrescar la página)
app.get('/api/queue/agent/session/:sessionId/status', authenticateAgentOrUser, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT active FROM agent_sessions WHERE id = $1',
      [req.params.sessionId]
    );
    if (!result.rows.length) return res.json({ active: false });
    res.json({ active: result.rows[0].active === true });
  } catch (err) {
    console.error('❌ GET /api/queue/agent/session/:id/status:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Iniciar / terminar pausa
app.post('/api/queue/agent/break/start', authenticateAgentOrUser, async (req, res) => {
  try {
    const { session_id, reason } = req.body;
    const result = await pool.query(
      `INSERT INTO agent_breaks (agent_session_id, reason) VALUES ($1,$2) RETURNING *`,
      [session_id, reason || 'otro']
    );
    res.json({ success: true, break: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/queue/agent/break/end', authenticateAgentOrUser, async (req, res) => {
  try {
    const { break_id } = req.body;
    const result = await pool.query(
      `UPDATE agent_breaks SET
        ended_at = CURRENT_TIMESTAMP,
        duration_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)) / 60
       WHERE id = $1 RETURNING *`,
      [break_id]
    );
    res.json({ success: true, break: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// OPERACIÓN — LLAMAR, ATENDER, FINALIZAR TURNO
// ══════════════════════════════════════════════════════════════

// GET — Cola actual de una ventanilla / sucursal
app.get('/api/queue/branches/:branchId/queue', async (req, res) => {
  try {
    const { service_id, status } = req.query;
    let query = `
      SELECT qt.*, s.name as service_name, s.prefix, s.color as service_color,
             a.name as agent_name, c.display_name as counter_name
      FROM queue_tokens qt
      JOIN services s ON s.id = qt.service_id
      LEFT JOIN agents a ON a.id = qt.agent_id
      LEFT JOIN counters c ON c.id = qt.counter_id
      WHERE qt.branch_id = $1 AND qt.date_key = CURRENT_DATE
    `;
    const params = [req.params.branchId];

    if (service_id) { query += ` AND qt.service_id = $${params.length + 1}`; params.push(service_id); }
    if (status)     { query += ` AND qt.status = $${params.length + 1}`; params.push(status); }
    else            { query += ` AND qt.status IN ('waiting', 'called', 'attending')`; }

    query += ' ORDER BY qt.is_priority DESC, qt.created_at ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST — Llamar siguiente turno
app.post('/api/queue/call-next', authenticateAgentOrUser, async (req, res) => {
  try {
    const { session_id, counter_id, branch_id, service_id } = req.body;

    // Obtener sesión activa del agente
    const sessionResult = await pool.query(
      'SELECT * FROM agent_sessions WHERE id = $1 AND active = true', [session_id]
    );
    if (!sessionResult.rows.length) return res.status(400).json({ error: 'Sesión no activa' });
    const session = sessionResult.rows[0];

    // Obtener servicios de la ventanilla
    const counterServices = await pool.query(
      'SELECT service_id FROM counter_services WHERE counter_id = $1', [counter_id]
    );
    const serviceIds = counterServices.rows.map(r => r.service_id);
    if (service_id) serviceIds.length = 0, serviceIds.push(service_id);

    // Si la ventanilla no tiene servicios específicos, atender todos los del branch
    if (!serviceIds.length) {
      const allServices = await pool.query(
        'SELECT id FROM services WHERE branch_id = $1 AND active = true', [branch_id]
      );
      serviceIds.push(...allServices.rows.map(r => r.id));
    }
    if (!serviceIds.length) return res.status(400).json({ error: 'No hay servicios activos en esta sucursal' });

    // Buscar siguiente turno: UNION de walk-ins/tokens + citas confirmadas sin token
    // Orden: prioridad DESC, luego por tiempo (estimated_call_at o scheduled_at o created_at)
    const candidateResult = await pool.query(
      `SELECT * FROM (
         -- Walk-ins y tokens de confirm-presence ya en cola
         SELECT
           qt.id AS token_id, NULL::uuid AS appt_id,
           qt.branch_id, qt.service_id,
           qt.token_number, qt.display_number,
           qt.is_priority, qt.is_appointment, qt.channel,
           qt.client_name, qt.client_phone, qt.appointment_id,
           qt.created_at,
           COALESCE(qt.estimated_call_at, qt.created_at) AS sort_time,
           s.name AS service_name, s.color AS service_color,
           'token' AS _source
         FROM queue_tokens qt
         JOIN services s ON s.id = qt.service_id
         WHERE qt.branch_id = $1
           AND qt.status = 'waiting'
           AND qt.date_key = CURRENT_DATE
           AND (
             (qt.service_id = ANY($2::uuid[]) AND (qt.counter_id IS NULL OR qt.counter_id = $3))
             OR qt.counter_id = $3
           )
         UNION ALL
         -- Citas confirmadas hoy que aún no tienen token activo
         SELECT
           NULL::uuid AS token_id, a.id AS appt_id,
           a.branch_id, a.service_id,
           NULL AS token_number, NULL AS display_number,
           false AS is_priority, true AS is_appointment, 'appointment'::varchar AS channel,
           a.client_name, a.client_phone, a.id AS appointment_id,
           a.created_at,
           a.scheduled_at AS sort_time,
           s.name AS service_name, s.color AS service_color,
           'appointment' AS _source
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         WHERE a.branch_id = $1
           AND a.status = 'confirmed'
           AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date
               = (NOW() AT TIME ZONE 'America/Bogota')::date
           AND a.service_id = ANY($2::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM queue_tokens qt2
             WHERE qt2.appointment_id = a.id
               AND qt2.status NOT IN ('finished','no_show')
           )
       ) AS candidates
       ORDER BY is_priority DESC, sort_time ASC
       LIMIT 1`,
      [branch_id, serviceIds, counter_id]
    );

    if (!candidateResult.rows.length) return res.json({ success: true, token: null, message: 'No hay turnos en espera' });

    const candidate = candidateResult.rows[0];
    let token;

    if (candidate._source === 'appointment') {
      // Crear token on-the-fly para la cita y llamarla directamente
      token = await withTransaction(pool, async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text))`,
          [candidate.branch_id, candidate.service_id]
        );
        const svcRow = await client.query(
          'SELECT prefix FROM services WHERE id = $1', [candidate.service_id]
        );
        const nextNum = await generateNextTokenNumber(client, candidate.branch_id, candidate.service_id);
        const tokenNumber = `${svcRow.rows[0].prefix}${String(nextNum).padStart(3, '0')}`;

        const ins = await client.query(
          `INSERT INTO queue_tokens
             (branch_id, service_id, token_number, display_number,
              is_priority, is_appointment, channel,
              client_name, client_phone, appointment_id,
              status, counter_id, agent_id, agent_session_id, called_at)
           VALUES ($1,$2,$3,$3,false,true,'appointment',$4,$5,$6,
                   'called',$7,$8,$9,CURRENT_TIMESTAMP)
           RETURNING *`,
          [candidate.branch_id, candidate.service_id, tokenNumber,
           candidate.client_name, candidate.client_phone, candidate.appt_id,
           counter_id, session.agent_id, session_id]
        );
        await client.query(
          `UPDATE appointments SET status='attended' WHERE id=$1`, [candidate.appt_id]
        );
        await client.query(
          `INSERT INTO token_events (token_id, event_type, agent_id, to_counter_id)
           VALUES ($1,'called',$2,$3)`,
          [ins.rows[0].id, session.agent_id, counter_id]
        );
        return { ...ins.rows[0], service_name: candidate.service_name, service_color: candidate.service_color };
      });
    } else {
      // Token existente: envolver en transacción (A-2)
      token = await withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE queue_tokens SET
            status = 'called', counter_id = $1, agent_id = $2,
            agent_session_id = $3, called_at = CURRENT_TIMESTAMP,
            wait_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) / 60
           WHERE id = $4`,
          [counter_id, session.agent_id, session_id, candidate.token_id]
        );
        await client.query(
          `INSERT INTO token_events (token_id, event_type, agent_id, to_counter_id)
           VALUES ($1, 'called', $2, $3)`,
          [candidate.token_id, session.agent_id, counter_id]
        );
        return { ...candidate, id: candidate.token_id };
      });
    }

    // Obtener nombre del agente y ventanilla para mostrar en pantalla
    const agentResult = await pool.query('SELECT name FROM agents WHERE id = $1', [session.agent_id]);
    const counterResult = await pool.query('SELECT display_name FROM counters WHERE id = $1', [counter_id]);

    const callData = {
      token_id: token.id,
      token_number: token.display_number,
      client_name: token.client_name || null,
      service_name: token.service_name,
      service_color: token.service_color,
      counter_name: counterResult.rows[0]?.display_name || 'Ventanilla',
      agent_name: agentResult.rows[0]?.name || '',
      counter_id,
      branch_id,
      is_priority: token.is_priority
    };

    // Emitir a pantalla principal y panel del agente
    io.to(`branch_${branch_id}`).emit('token_called', callData);

    console.log(`📢 Turno llamado: ${token.display_number} → ${counterResult.rows[0]?.display_name}`);
    res.json({ success: true, token: callData });
  } catch (err) {
    console.error('❌ Error llamando turno:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST — Marcar turno como en atención
app.post('/api/queue/tokens/:tokenId/attend', authenticateAgentOrUser, async (req, res) => {
  try {
    await pool.query(
      `UPDATE queue_tokens SET status = 'attending', attended_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [req.params.tokenId]
    );
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id) VALUES ($1, 'attending', $2)`,
      [req.params.tokenId, req.body.agent_id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST — Finalizar turno
app.post('/api/queue/tokens/:tokenId/finish', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id } = req.body;
    const outcome = await withTransaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE queue_tokens SET
          status = 'finished', finished_at = CURRENT_TIMESTAMP,
          attention_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(attended_at, called_at))) / 60
         WHERE id = $1 RETURNING *`,
        [req.params.tokenId]
      );
      if (!result.rows.length) {
        const e = new Error('Turno no encontrado'); e.httpStatus = 404; throw e;
      }
      await client.query(
        `INSERT INTO token_events (token_id, event_type, agent_id) VALUES ($1, 'finished', $2)`,
        [req.params.tokenId, agent_id]
      );
      await client.query(
        `UPDATE agent_sessions SET
          tokens_attended = tokens_attended + 1,
          avg_attention_min = (
            SELECT AVG(attention_minutes) FROM queue_tokens
            WHERE agent_session_id = $1 AND status = 'finished'
          )
         WHERE id = $1`,
        [session_id]
      );
      const token = result.rows[0];
      let apptPayload = null;
      if (token.appointment_id) {
        const apptUp = await client.query(
          `UPDATE appointments SET status = 'completed', agent_id = COALESCE($2::uuid, agent_id)
            WHERE id = $1
            RETURNING id, user_id, branch_id, client_name, agent_id`,
          [token.appointment_id, agent_id || null]
        );
        if (apptUp.rowCount) {
          const appt = apptUp.rows[0];
          let agentName = null;
          if (appt.agent_id) {
            const agRow = await client.query(`SELECT name FROM agents WHERE id = $1`, [appt.agent_id]);
            if (agRow.rowCount) agentName = agRow.rows[0].name;
          }
          apptPayload = { id: appt.id, status: 'completed', agent_id: appt.agent_id, agent_name: agentName, user_id: appt.user_id, branch_id: appt.branch_id };
        }
      }
      return { token, apptPayload };
    });
    if (outcome.apptPayload) {
      const p = outcome.apptPayload;
      const completedPayload = { id: p.id, status: p.status, agent_id: p.agent_id, agent_name: p.agent_name };
      io.to(`user_${p.user_id}`).emit('appointment.completed', completedPayload);
      io.to(`branch_${p.branch_id}`).emit('appointment.completed', completedPayload);
      console.log(JSON.stringify({ event: 'appointment.completed', appt_id: p.id, agent_id: p.agent_id, agent_name: p.agent_name }));
    }
    io.to(`branch_${branch_id}`).emit('token_finished', {
      token_id: req.params.tokenId,
      counter_id: outcome.token.counter_id
    });
    if (outcome.token.rating_enabled !== false) {
      io.to(`counter_${outcome.token.counter_id}`).emit('show_rating', {
        token_id: req.params.tokenId,
        token_number: outcome.token.display_number
      });
    }
    res.json({ success: true });
  } catch (err) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST — Marcar como no presentado
app.post('/api/queue/tokens/:tokenId/no-show', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id } = req.body;
    await withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE queue_tokens SET status = 'no_show', finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [req.params.tokenId]
      );
      await client.query(
        `INSERT INTO token_events (token_id, event_type, agent_id) VALUES ($1, 'no_show', $2)`,
        [req.params.tokenId, agent_id]
      );
      await client.query(
        `UPDATE agent_sessions SET tokens_no_show = tokens_no_show + 1 WHERE id = $1`,
        [session_id]
      );
    });
    io.to(`branch_${branch_id}`).emit('token_no_show', { token_id: req.params.tokenId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST — Transferir turno a otra ventanilla/servicio
app.post('/api/queue/tokens/:tokenId/transfer', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id, to_counter_id, to_service_id, note } = req.body;
    const outcome = await withTransaction(pool, async (client) => {
      const current = await client.query(
        `SELECT * FROM queue_tokens WHERE id = $1 FOR UPDATE`, [req.params.tokenId]
      );
      if (!current.rows.length) {
        const e = new Error('Turno no encontrado'); e.httpStatus = 404; throw e;
      }
      const orig = current.rows[0];
      const targetServiceId = to_service_id || orig.service_id;
      // Lock por (branch, servicio destino, día) — evita correlativo duplicado (A-4)
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text))`,
        [orig.branch_id, targetServiceId]
      );
      const svcRow = await client.query(
        `SELECT prefix FROM services WHERE id = $1`, [targetServiceId]
      );
      const nextNum = await generateNextTokenNumber(client, orig.branch_id, targetServiceId);
      const newTokenNumber = `${svcRow.rows[0]?.prefix || ''}${String(nextNum).padStart(3, '0')}`;
      await client.query(
        `UPDATE queue_tokens SET status = 'transferred', agent_id = NULL, agent_session_id = NULL WHERE id = $1`,
        [req.params.tokenId]
      );
      const newTok = await client.query(
        `INSERT INTO queue_tokens (branch_id, service_id, counter_id, token_number, display_number, status, is_priority, channel, date_key)
         VALUES ($1, $2, $3, $4, $4, 'waiting', $5, 'transfer', CURRENT_DATE) RETURNING id`,
        [orig.branch_id, targetServiceId, to_counter_id, newTokenNumber, orig.is_priority || false]
      );
      await client.query(
        `INSERT INTO token_events (token_id, event_type, agent_id, from_counter_id, to_counter_id, note)
         VALUES ($1, 'transferred', $2, $3, $4, $5)`,
        [req.params.tokenId, agent_id, orig.counter_id, to_counter_id, note]
      );
      await client.query(
        `UPDATE agent_sessions SET tokens_transferred = tokens_transferred + 1 WHERE id = $1`,
        [session_id]
      );
      return { newTokenId: newTok.rows[0].id, newTokenNumber };
    });
    io.to(`branch_${branch_id}`).emit('token_transferred', {
      token_id: req.params.tokenId,
      new_token_id: outcome.newTokenId,
      new_token_number: outcome.newTokenNumber,
      to_counter_id, to_service_id
    });
    res.json({ success: true });
  } catch (err) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// R3 — Notas del agente + Seguimiento
// ══════════════════════════════════════════════════════════════

app.post('/api/queue/tokens/:tokenId/note', authenticateAgentOrUser, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const text = (req.body && req.body.text) ? String(req.body.text).trim().slice(0, 4096) : '';
    if (!text) return res.status(400).json({ error: 'Texto de nota requerido' });
    const check = req.user.role === 'agent'
      ? await pool.query('SELECT id FROM queue_tokens WHERE id = $1 AND branch_id = $2', [tokenId, req.user.branch_id])
      : await pool.query('SELECT qt.id FROM queue_tokens qt JOIN branches b ON b.id = qt.branch_id WHERE qt.id = $1 AND b.user_id = $2', [tokenId, req.user.id]);
    if (!check.rowCount) return res.status(404).json({ error: 'Turno no encontrado' });
    const agentId = req.user.agent_id || null;
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id, metadata) VALUES ($1, 'note_added', $2, $3)`,
      [tokenId, agentId, JSON.stringify({ text })]
    );
    console.log(`📝 agent.note_added token=${tokenId} agent=${agentId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ POST /api/queue/tokens/:tokenId/note:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/queue/tokens/:tokenId/notes', authenticateAgentOrUser, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const result = await pool.query(
      `SELECT te.id, te.created_at, te.metadata->>'text' AS text, a.name AS agent_name
         FROM token_events te LEFT JOIN agents a ON a.id = te.agent_id
        WHERE te.token_id = $1 AND te.event_type = 'note_added'
        ORDER BY te.created_at ASC`,
      [tokenId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ GET /api/queue/tokens/:tokenId/notes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/queue/appointments/:id/notes', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  try {
    const apptId = req.params.id;
    if (!UUID_RE.test(apptId)) return res.status(400).json({ error: 'id inválido' });
    const apptRes = await pool.query(
      'SELECT id FROM appointments WHERE id = $1 AND user_id = $2', [apptId, req.user.id]
    );
    if (!apptRes.rowCount) return res.status(404).json({ error: 'Cita no encontrada' });
    const tokenRes = await pool.query(
      'SELECT id FROM queue_tokens WHERE appointment_id = $1 ORDER BY created_at DESC LIMIT 1', [apptId]
    );
    if (!tokenRes.rowCount) return res.json([]);
    const result = await pool.query(
      `SELECT te.id, te.created_at, te.metadata->>'text' AS text, a.name AS agent_name
         FROM token_events te LEFT JOIN agents a ON a.id = te.agent_id
        WHERE te.token_id = $1 AND te.event_type = 'note_added'
        ORDER BY te.created_at ASC`,
      [tokenRes.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ GET /api/queue/appointments/:id/notes:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/queue/agent/followup', authenticateAgentOrUser, async (req, res) => {
  try {
    const { branch_id, service_id, client_name, client_phone, scheduled_at, parent_token_id } = req.body || {};
    if (!branch_id || !UUID_RE.test(branch_id)) return res.status(400).json({ error: 'branch_id inválido' });
    if (!service_id || !UUID_RE.test(service_id)) return res.status(400).json({ error: 'service_id inválido' });
    if (!parent_token_id || !UUID_RE.test(parent_token_id)) return res.status(400).json({ error: 'parent_token_id requerido' });
    const vName  = queueValidation.validateClientName(client_name);
    if (!vName.ok) return res.status(400).json({ error: vName.error });
    const vPhone = queueValidation.validateClientPhone(client_phone);
    if (!vPhone.ok) return res.status(400).json({ error: vPhone.error });
    const vSched = parseScheduledAt(scheduled_at);
    if (!vSched.ok) return res.status(400).json({ error: vSched.error });

    const branchRow = await pool.query(
      `SELECT b.user_id, u.features->>'queue_v2_appointments' AS feat
         FROM branches b JOIN users u ON u.id = b.user_id WHERE b.id = $1`,
      [branch_id]
    );
    if (!branchRow.rowCount) return res.status(404).json({ error: 'Sucursal no encontrada' });
    if (branchRow.rows[0].feat !== 'true') return res.status(403).json({ error: 'FEATURE_DISABLED', feature: 'queue_v2_appointments' });
    const userId = branchRow.rows[0].user_id;

    const created = await withTransaction(pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2::text || ':' || $3::text))`,
        [branch_id, service_id, vSched.value.toISOString()]
      );
      const svcRes = await client.query(
        `SELECT id, price, currency FROM services WHERE id = $1 AND branch_id = $2`,
        [service_id, branch_id]
      );
      if (!svcRes.rowCount) { const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e; }
      const tkRes = await client.query(
        'SELECT id FROM queue_tokens WHERE id = $1 AND branch_id = $2', [parent_token_id, branch_id]
      );
      if (!tkRes.rowCount) { const e = new Error('parent_token_id no encontrado'); e.httpStatus = 404; throw e; }
      if (await isSlotBlocked(client, branch_id, service_id, vSched.value.toISOString())) {
        const e = new Error('El slot está bloqueado'); e.httpStatus = 409; e.code = 'BLOCKED'; throw e;
      }
      const svc = svcRes.rows[0];
      const ins = await client.query(
        `INSERT INTO appointments
           (user_id, branch_id, service_id, client_name, client_phone, scheduled_at,
            status, origin, parent_token_id, created_by, price_at_booking, currency_at_booking)
         VALUES ($1,$2,$3,$4,$5,$6,'pending','follow_up',$7,$8,$9,$10) RETURNING *`,
        [userId, branch_id, service_id, vName.value, vPhone.value,
         vSched.value.toISOString(), parent_token_id, userId, svc.price ?? null, svc.currency ?? null]
      );
      return ins.rows[0];
    });
    io.to(`user_${created.user_id}`).emit('appointment.created', queueSerializers.serializeForAdmin(created));
    io.to(`branch_${created.branch_id}`).emit('appointment.created', queueSerializers.serializeForBranch(created));
    console.log(`📅 appointment.created(follow_up) id=${created.id} parent=${parent_token_id}`);
    return res.status(201).json(queueSerializers.serializeForAdmin(created));
  } catch (err) {
    if (err && err.httpStatus) { const b = { error: err.message }; if (err.code) b.code = err.code; return res.status(err.httpStatus).json(b); }
    if (err && err.code === '23505') return res.status(409).json({ error: 'Slot ya reservado', code: 'SLOT_TAKEN' });
    console.error('❌ POST /api/queue/agent/followup:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// CALIFICACIÓN
// ══════════════════════════════════════════════════════════════

app.post('/api/queue/ratings', async (req, res) => {
  try {
    const { token_id, score, channel, comment } = req.body;
    if (!token_id || !score) return res.status(400).json({ error: 'token_id y score requeridos' });
    if (score < 1 || score > 5) return res.status(400).json({ error: 'Score debe ser entre 1 y 5' });

    const tokenResult = await pool.query(
      'SELECT branch_id, service_id, agent_id FROM queue_tokens WHERE id = $1',
      [token_id]
    );
    if (!tokenResult.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });
    const { branch_id, service_id, agent_id } = tokenResult.rows[0];

    // Verificar que no haya calificado antes
    const existing = await pool.query('SELECT id FROM ratings WHERE token_id = $1', [token_id]);
    if (existing.rows.length) return res.status(400).json({ error: 'Este turno ya fue calificado' });

    await pool.query(
      `INSERT INTO ratings (token_id, branch_id, service_id, agent_id, score, channel, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [token_id, branch_id, service_id, agent_id, score, channel || 'kiosk', comment || null]
    );

    // Actualizar rating promedio de la sesión del agente
    if (agent_id) {
      await pool.query(
        `UPDATE agent_sessions SET
          avg_rating = (SELECT AVG(r.score) FROM ratings r
                        JOIN queue_tokens qt ON qt.id = r.token_id
                        WHERE qt.agent_id = $1 AND qt.date_key = CURRENT_DATE)
         WHERE agent_id = $1 AND active = true`,
        [agent_id]
      );
    }

    io.to(`branch_${branch_id}`).emit('new_rating', { token_id, score });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// PANTALLA PRINCIPAL — Datos en tiempo real
// ══════════════════════════════════════════════════════════════

app.get('/api/queue/display/:branchId', async (req, res) => {
  try {
    const { branchId } = req.params;

    // Últimos turnos llamados (para mostrar en pantalla)
    const called = await pool.query(
      `SELECT qt.display_number, qt.token_number, qt.status,
              s.name as service_name, s.color as service_color,
              c.display_name as counter_name, a.name as agent_name
       FROM queue_tokens qt
       JOIN services s ON s.id = qt.service_id
       LEFT JOIN counters c ON c.id = qt.counter_id
       LEFT JOIN agents a ON a.id = qt.agent_id
       WHERE qt.branch_id = $1 AND qt.date_key = CURRENT_DATE
         AND qt.status IN ('called','attending')
       ORDER BY qt.called_at DESC LIMIT 10`,
      [branchId]
    );

    // Estadísticas generales del día
    const stats = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'waiting') as waiting,
        COUNT(*) FILTER (WHERE status IN ('called','attending')) as in_progress,
        COUNT(*) FILTER (WHERE status = 'finished') as finished,
        COUNT(*) FILTER (WHERE status = 'no_show') as no_show,
        ROUND(AVG(wait_minutes) FILTER (WHERE wait_minutes IS NOT NULL), 1) as avg_wait,
        ROUND(AVG(attention_minutes) FILTER (WHERE attention_minutes IS NOT NULL), 1) as avg_attention
       FROM queue_tokens
       WHERE branch_id = $1 AND date_key = CURRENT_DATE`,
      [branchId]
    );

    // Config de la sucursal
    const branch = await pool.query(
      `SELECT b.*, p.name as playlist_name, u.public_slug as booking_slug
         FROM branches b
         LEFT JOIN playlists p ON p.id = b.display_playlist_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id = $1`,
      [branchId]
    );

    res.json({
      called_tokens: called.rows,
      stats: stats.rows[0],
      branch: branch.rows[0] || null
    });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ══════════════════════════════════════════════════════════════
// REPORTES DE DESEMPEÑO
// ══════════════════════════════════════════════════════════════

// Reporte por agente — día específico o rango
app.get('/api/queue/reports/agents', authenticateAgentOrUser, async (req, res) => {
  try {
    const { branch_id, date_from, date_to, agent_id } = req.query;
    const from = date_from || new Date().toISOString().split('T')[0];
    const to   = date_to   || new Date().toISOString().split('T')[0];

    let query = `
      SELECT
        a.id, a.name, a.avatar_color,
        COUNT(qt.id) FILTER (WHERE qt.status = 'finished') as tokens_attended,
        COUNT(qt.id) FILTER (WHERE qt.status = 'no_show') as tokens_no_show,
        COUNT(qt.id) FILTER (WHERE qt.status = 'finished' OR qt.status = 'no_show') as tokens_total,
        ROUND(AVG(qt.attention_minutes) FILTER (WHERE qt.status = 'finished'), 1) as avg_attention_min,
        ROUND(AVG(qt.wait_minutes) FILTER (WHERE qt.wait_minutes IS NOT NULL), 1) as avg_wait_min,
        ROUND(AVG(r.score), 2) as avg_rating,
        COUNT(r.id) as total_ratings,
        SUM(EXTRACT(EPOCH FROM (COALESCE(asess.ended_at, CURRENT_TIMESTAMP) - asess.started_at)) / 3600)
          FILTER (WHERE asess.id IS NOT NULL) as total_hours,
        MIN(asess.started_at) as first_session,
        MAX(COALESCE(asess.ended_at, CURRENT_TIMESTAMP)) as last_session
      FROM agents a
      LEFT JOIN queue_tokens qt ON qt.agent_id = a.id AND qt.date_key BETWEEN $2 AND $3
      LEFT JOIN ratings r ON r.agent_id = a.id AND DATE(r.created_at) BETWEEN $2 AND $3
      LEFT JOIN agent_sessions asess ON asess.agent_id = a.id
        AND DATE(asess.started_at) BETWEEN $2 AND $3
      WHERE a.branch_id = $1
    `;
    const params = [branch_id, from, to];

    if (agent_id) { query += ` AND a.id = $${params.length + 1}`; params.push(agent_id); }
    query += ' GROUP BY a.id, a.name, a.avatar_color ORDER BY tokens_attended DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Reporte por horas — para detectar horas pico
app.get('/api/queue/reports/hourly', authenticateToken, async (req, res) => {
  try {
    const { branch_id, date_from, date_to, service_id } = req.query;
    const from = date_from || new Date().toISOString().split('T')[0];
    const to   = date_to   || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as total_tokens,
        COUNT(*) FILTER (WHERE status = 'finished') as attended,
        COUNT(*) FILTER (WHERE status = 'no_show') as no_show,
        ROUND(AVG(wait_minutes), 1) as avg_wait
       FROM queue_tokens
       WHERE branch_id = $1 AND date_key BETWEEN $2 AND $3
         ${service_id ? 'AND service_id = $4' : ''}
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY hour ASC`,
      service_id ? [branch_id, from, to, service_id] : [branch_id, from, to]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Reporte por servicio
app.get('/api/queue/reports/services', authenticateToken, async (req, res) => {
  try {
    const { branch_id, date_from, date_to } = req.query;
    const from = date_from || new Date().toISOString().split('T')[0];
    const to   = date_to   || new Date().toISOString().split('T')[0];

    const result = await pool.query(
      `SELECT
        s.id, s.name, s.prefix, s.color,
        COUNT(qt.id) as total_tokens,
        COUNT(qt.id) FILTER (WHERE qt.status = 'finished') as attended,
        COUNT(qt.id) FILTER (WHERE qt.status = 'no_show') as no_show,
        COUNT(qt.id) FILTER (WHERE qt.status = 'waiting') as still_waiting,
        ROUND(AVG(qt.wait_minutes) FILTER (WHERE qt.wait_minutes IS NOT NULL), 1) as avg_wait,
        ROUND(AVG(qt.attention_minutes) FILTER (WHERE qt.attention_minutes IS NOT NULL), 1) as avg_attention,
        ROUND(AVG(r.score), 2) as avg_rating
       FROM services s
       LEFT JOIN queue_tokens qt ON qt.service_id = s.id AND qt.date_key BETWEEN $2 AND $3
       LEFT JOIN ratings r ON r.service_id = s.id AND DATE(r.created_at) BETWEEN $2 AND $3
       WHERE s.branch_id = $1
       GROUP BY s.id ORDER BY total_tokens DESC`,
      [branch_id, from, to]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Historial completo de turnos del día / rango
app.get('/api/queue/reports/tokens', authenticateToken, async (req, res) => {
  try {
    const { branch_id, date_from, date_to, agent_id, service_id, status, limit, offset } = req.query;
    const from = date_from || new Date().toISOString().split('T')[0];
    const to   = date_to   || new Date().toISOString().split('T')[0];
    const lim  = parseInt(limit)  || 100;
    const off  = parseInt(offset) || 0;

    let where = `WHERE qt.branch_id = $1 AND qt.date_key BETWEEN $2 AND $3`;
    const params = [branch_id, from, to];

    if (agent_id)   { params.push(agent_id);   where += ` AND qt.agent_id = $${params.length}`; }
    if (service_id) { params.push(service_id); where += ` AND qt.service_id = $${params.length}`; }
    if (status)     { params.push(status);     where += ` AND qt.status = $${params.length}`; }

    const result = await pool.query(
      `SELECT qt.*, s.name as service_name, s.color as service_color,
              a.name as agent_name, c.display_name as counter_name,
              r.score as rating_score
       FROM queue_tokens qt
       JOIN services s ON s.id = qt.service_id
       LEFT JOIN agents a ON a.id = qt.agent_id
       LEFT JOIN counters c ON c.id = qt.counter_id
       LEFT JOIN ratings r ON r.token_id = qt.id
       ${where}
       ORDER BY qt.created_at DESC
       LIMIT ${lim} OFFSET ${off}`,
      params
    );

    const total = await pool.query(
      `SELECT COUNT(*) FROM queue_tokens qt ${where}`,
      params
    );

    res.json({ tokens: result.rows, total: parseInt(total.rows[0].count), limit: lim, offset: off });
  } catch (err) { res.status(500).json({ error: 'Error interno del servidor' }); }
});


// R3.5 — Resumen de citas por período (panel de reportes)
app.get('/api/queue/reports/appointments-summary', authenticateToken, async (req, res) => {
  try {
    const { branch_id, date_from, date_to } = req.query;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const from  = date_from || today;
    const to    = date_to   || today;

    const params = [req.user.id, from, to];
    let branchClause = '';
    if (branch_id) { params.push(branch_id); branchClause = `AND a.branch_id = $${params.length}`; }

    const [summary, byService, byHour] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE a.status IN ('pending','confirmed')) AS active_count,
          COUNT(*) FILTER (WHERE a.status IN ('attended','completed')) AS attended_count,
          COUNT(*) FILTER (WHERE a.status NOT IN ('cancelled')) AS total_active,
          COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status IN ('attended','completed')), 0) AS revenue_attended,
          COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status NOT IN ('cancelled')), 0) AS revenue_expected,
          COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status IN ('pending','confirmed','attended','completed')), 0) AS revenue_active,
          COUNT(*) FILTER (WHERE a.status = 'no_show') AS no_show_count,
          COUNT(*) FILTER (WHERE a.status = 'completed') AS completed_count,
          COUNT(*) FILTER (WHERE a.price_at_booking IS NULL AND a.status NOT IN ('cancelled')) AS no_price_count
         FROM appointments a
         WHERE a.user_id = $1
           AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date BETWEEN $2 AND $3
           ${branchClause}`,
        params
      ),
      pool.query(
        `SELECT
          s.name, s.color,
          COUNT(a.id) FILTER (WHERE a.status NOT IN ('cancelled')) AS total,
          COUNT(a.id) FILTER (WHERE a.status IN ('attended','completed')) AS total_attended,
          COUNT(a.id) FILTER (WHERE a.status IN ('pending','confirmed')) AS total_expected,
          COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status IN ('attended','completed')), 0) AS revenue_attended,
          COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status NOT IN ('cancelled')), 0) AS revenue_expected
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         WHERE a.user_id = $1
           AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date BETWEEN $2 AND $3
           ${branchClause}
         GROUP BY s.id, s.name, s.color
         ORDER BY (
           COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status IN ('attended','completed')), 0) +
           COALESCE(SUM(a.price_at_booking) FILTER (WHERE a.status NOT IN ('cancelled')), 0)
         ) DESC`,
        params
      ),
      pool.query(
        `SELECT
          EXTRACT(HOUR FROM a.scheduled_at AT TIME ZONE 'America/Bogota') AS hour,
          COUNT(*) FILTER (WHERE a.status IN ('attended','completed')) AS attended,
          COUNT(*) FILTER (WHERE a.status = 'confirmed') AS confirmed,
          COUNT(*) FILTER (WHERE a.status = 'pending') AS pending,
          COUNT(*) FILTER (WHERE a.status = 'no_show') AS no_show
         FROM appointments a
         WHERE a.user_id = $1
           AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date BETWEEN $2 AND $3
           AND a.status NOT IN ('cancelled')
           ${branchClause}
         GROUP BY hour ORDER BY hour`,
        params
      )
    ]);

    const row = summary.rows[0];
    res.json({
      active_count:     parseInt(row.active_count    || 0),
      attended_count:   parseInt(row.attended_count  || 0),
      total_active:     parseInt(row.total_active    || 0),
      revenue_attended: parseFloat(row.revenue_attended || 0),
      revenue_expected: parseFloat(row.revenue_expected || 0),
      revenue_active:   parseFloat(row.revenue_active   || 0),
      no_show_count:    parseInt(row.no_show_count   || 0),
      no_price_count:   parseInt(row.no_price_count  || 0),
      currency: 'COP',
      by_hour: byHour.rows.map(r => ({
        hour:     parseInt(r.hour),
        attended: parseInt(r.attended || 0),
        confirmed:parseInt(r.confirmed|| 0),
        pending:  parseInt(r.pending  || 0),
        no_show:  parseInt(r.no_show  || 0),
      })),
      by_service: byService.rows.map(r => ({
        name:             r.name,
        color:            r.color,
        total:            parseInt(r.total          || 0),
        total_attended:   parseInt(r.total_attended  || 0),
        total_expected:   parseInt(r.total_expected  || 0),
        revenue_attended: parseFloat(r.revenue_attended || 0),
        revenue_expected: parseFloat(r.revenue_expected || 0),
      }))
    });
  } catch (err) {
    console.error('❌ /api/queue/reports/appointments-summary:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// R1 · CITAS — §2.1–§2.4 (POST / GET / PATCH / DELETE appointments)
// ══════════════════════════════════════════════════════════════
// Framework Queue v2, R1-PLAN v1.3.
//   §2.1  POST   /api/queue/appointments        — crear cita
//   §2.2  GET    /api/queue/appointments        — listar
//   §2.3  PATCH  /api/queue/appointments/:id    — actualizar
//   §2.4  DELETE /api/queue/appointments/:id    — cancelar (soft)
//
// Reglas duras aplicadas:
//   · Principio 1 — todo mutador usa withTransaction()
//   · Principio 2 — toda query filtra por req.user.id
//   · Principio 4 — ADD-only respecto a Queue v1 (cero cambio walk-in)
//   · Principio 5 — TIMESTAMPTZ siempre, UUID para branch/service
//   · §3.1        — eventos Socket.io SOLO post-COMMIT
//   · §3.4        — payloads admin con precio, payloads branch sin precio
//
// Defensas en concurrencia (patrón R0):
//   · advisory lock por (branch_id, service_id, scheduled_at_iso)
//   · UNIQUE parcial appointments_branch_service_slot_uniq como backstop
//   · retry [50,100,200]ms si 23505 (SLOT_TAKEN)
// ══════════════════════════════════════════════════════════════

const APPT_INSERT_MAX_RETRIES = 3;
const APPT_INSERT_BACKOFF_MS  = [50, 100, 200];
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|win-[0-9a-f]+|rpi-[0-9a-f]+)$/i;
const APPT_STATUS_VALID = new Set([
  'pending','confirmed','attended','no_show','cancelled','pending_reschedule'
]);
const APPT_STATUS_PATCHABLE = new Set(['confirmed','cancelled','pending_reschedule']);
const APPT_ACTIVE_STATUSES  = ['pending','confirmed','attended'];

// Helper: chequea time_blocks que cubran el instante scheduled_at.
// Cubre tanto bloques específicos del servicio como bloques "todos"
// (service_id IS NULL). Ejecutar dentro de la transacción.
async function isSlotBlocked(client, branchId, serviceId, scheduledAt) {
  const r = await client.query(
    `SELECT 1 FROM time_blocks
      WHERE branch_id = $1
        AND tstzrange(starts_at, ends_at, '[)') @> $2::timestamptz
        AND (service_id IS NULL OR service_id = $3)
      LIMIT 1`,
    [branchId, scheduledAt, serviceId]
  );
  return r.rowCount > 0;
}

// Helper: parsea y valida scheduled_at + skew permitido (5 min al pasado).
function parseScheduledAt(raw) {
  if (!raw) return { ok: false, error: 'scheduled_at es requerido' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: 'scheduled_at inválido (ISO 8601 requerido)' };
  }
  const skewMs = 5 * 60 * 1000;
  if (d.getTime() < Date.now() - skewMs) {
    return { ok: false, error: 'scheduled_at debe ser futuro' };
  }
  return { ok: true, value: d };
}

// ─────────────────────────────────────────────────────────────
// §2.1 — POST /api/queue/appointments
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/appointments', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const {
    branch_id, service_id,
    client_name, client_phone, client_email, client_id_number,
    scheduled_at, agent_id,
    origin, parent_token_id,
  } = req.body || {};

  if (!branch_id || !UUID_RE.test(branch_id)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  if (!service_id || !UUID_RE.test(service_id)) {
    return res.status(400).json({ error: 'service_id inválido' });
  }

  const vName  = queueValidation.validateClientName(client_name);
  if (!vName.ok)  return res.status(400).json({ error: vName.error });
  const vPhone = queueValidation.validateClientPhone(client_phone);
  if (!vPhone.ok) return res.status(400).json({ error: vPhone.error });
  const vId    = queueValidation.validateClientIdNumber(client_id_number);
  if (!vId.ok)    return res.status(400).json({ error: vId.error });

  const vSched = parseScheduledAt(scheduled_at);
  if (!vSched.ok) return res.status(400).json({ error: vSched.error });

  const originVal = origin || 'admin';
  if (!['admin','follow_up','kiosk_future'].includes(originVal)) {
    return res.status(400).json({ error: 'origin inválido' });
  }
  if (originVal === 'follow_up' && (!parent_token_id || !UUID_RE.test(parent_token_id))) {
    return res.status(400).json({ error: 'parent_token_id requerido para origin=follow_up' });
  }

  let attempt = 0;
  let lastError = null;

  while (attempt < APPT_INSERT_MAX_RETRIES) {
    try {
      const created = await withTransaction(pool, async (client) => {
        // Lock por slot exacto — serializa requests concurrentes al mismo slot.
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtext($1::text || ':' || $2::text || ':' || $3::text)
           )`,
          [branch_id, service_id, vSched.value.toISOString()]
        );

        const branchRes = await client.query(
          `SELECT id FROM branches WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [branch_id, userId]
        );
        if (!branchRes.rowCount) {
          const e = new Error('Sucursal no encontrada'); e.httpStatus = 404; throw e;
        }
        const svcRes = await client.query(
          `SELECT id, price, currency FROM services WHERE id = $1 AND branch_id = $2`,
          [service_id, branch_id]
        );
        if (!svcRes.rowCount) {
          const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e;
        }
        const svc = svcRes.rows[0];

        if (originVal === 'follow_up') {
          const tkRes = await client.query(
            `SELECT qt.id
               FROM queue_tokens qt
               JOIN branches b ON b.id = qt.branch_id
              WHERE qt.id = $1 AND b.user_id = $2`,
            [parent_token_id, userId]
          );
          if (!tkRes.rowCount) {
            const e = new Error('parent_token_id no encontrado'); e.httpStatus = 404; throw e;
          }
        }

        if (await isSlotBlocked(client, branch_id, service_id, vSched.value.toISOString())) {
          const e = new Error('El slot está bloqueado');
          e.httpStatus = 409; e.code = 'BLOCKED'; throw e;
        }

        // Snapshot inmutable de precio/moneda al momento del booking (DoD #3).
        const priceSnapshot    = svc.price ?? null;
        const currencySnapshot = svc.currency ?? null;

        const ins = await client.query(
          `INSERT INTO appointments (
             user_id, branch_id, service_id,
             client_name, client_phone, client_email, client_id_number,
             scheduled_at, status, origin,
             parent_token_id, created_by, agent_id,
             price_at_booking, currency_at_booking
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14
           ) RETURNING *`,
          [
            userId, branch_id, service_id,
            vName.value, vPhone.value, client_email || null, vId.value,
            vSched.value.toISOString(), originVal,
            originVal === 'follow_up' ? parent_token_id : null,
            userId,
            agent_id || null,
            priceSnapshot, currencySnapshot,
          ]
        );
        return ins.rows[0];
      });

      // Post-commit (§3.1): Calendar sync Google + Outlook (non-fatal).
      if (created.agent_id) {
        _syncAllCalendars(created.agent_id, created)
          .then(({ gcal_event_id, outlook_event_id }) => {
            if (gcal_event_id || outlook_event_id) {
              pool.query(
                'UPDATE appointments SET gcal_event_id = $1, outlook_event_id = $2 WHERE id = $3',
                [gcal_event_id || null, outlook_event_id || null, created.id]
              ).catch(e => console.error('⚠️ calendar event_id update:', e.message));
            }
          })
          .catch(e => console.error('⚠️ _syncAllCalendars post-commit (non-fatal):', e.message));
      }
      io.to(`user_${created.user_id}`).emit(
        'appointment.created', queueSerializers.serializeForAdmin(created)
      );
      io.to(`branch_${created.branch_id}`).emit(
        'appointment.created', queueSerializers.serializeForBranch(created)
      );
      console.log(
        `📅 appointment.created id=${created.id} branch=${branch_id} ` +
        `service=${service_id}` + (attempt > 0 ? ` (retry ${attempt})` : '')
      );

      // Fire-and-forget: token publico + email (mismo flujo que booking publico)
      (async () => {
        try {
          const tokRes = await pool.query(
            `INSERT INTO public_appointment_tokens
               (user_id, appointment_id, action_allowed, expires_at)
             VALUES ($1, $2, 'both', NOW() + INTERVAL '7 days')
             ON CONFLICT DO NOTHING
             RETURNING token`,
            [created.user_id, created.id]
          );
          const pubTok = tokRes.rows[0]?.token;
          if (pubTok && created.client_email) {
            const namesRes = await pool.query(
              `SELECT b.name AS branch_name, s.name AS service_name
                 FROM branches b LEFT JOIN services s ON s.id = $2
                WHERE b.id = $1`,
              [created.branch_id, created.service_id]
            );
            const names    = namesRes.rows[0] || {};
            const BASE_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';
            const citaUrl  = `${BASE_URL}/cita/${pubTok}`;
            await emailService.sendAppointmentConfirmation(
              created.client_email,
              { ...created, branch_name: names.branch_name || '', service_name: names.service_name || '' },
              citaUrl
            );
            console.log(`[admin] email -> ${created.client_email} (cita ${created.id})`);
          }
        } catch (emailErr) {
          console.error('email/token fire-and-forget (admin):', emailErr.message);
        }
      })();

      return res.status(201).json(queueSerializers.serializeForAdmin(created));

    } catch (err) {
      if (err && err.httpStatus) {
        const body = { error: err.message };
        if (err.code) body.code = err.code;
        return res.status(err.httpStatus).json(body);
      }

      const isConflict =
        err && err.code === '23505' &&
        err.constraint === 'appointments_branch_service_slot_uniq';

      if (isConflict && attempt < APPT_INSERT_MAX_RETRIES - 1) {
        const backoff = APPT_INSERT_BACKOFF_MS[attempt] || 200;
        console.warn(
          `⚠️ appointment.conflict_retry attempt=${attempt + 1} ` +
          `branch=${branch_id} service=${service_id} backoff=${backoff}ms`
        );
        await new Promise(r => setTimeout(r, backoff));
        attempt++; lastError = err;
        continue;
      }

      if (isConflict) {
        return res.status(409).json({ error: 'Slot ya reservado', code: 'SLOT_TAKEN' });
      }

      console.error('❌ /api/queue/appointments POST:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }

  console.error('❌ Agotados retries en POST /appointments:', lastError);
  return res.status(503).json({ error: 'Servicio temporalmente saturado, reintenta' });
});

// ─────────────────────────────────────────────────────────────
// §2.2 — GET /api/queue/appointments
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/appointments', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { branch_id, date, date_from, date_to, status } = req.query;

    if (!branch_id || !UUID_RE.test(branch_id)) {
      return res.status(400).json({ error: 'branch_id inválido' });
    }

    const _dateRE = /^\d{4}-\d{2}-\d{2}$/;
    const _today  = new Date().toISOString().slice(0, 10);
    const fromKey = (date_from && _dateRE.test(date_from)) ? date_from
                  : (date && _dateRE.test(date)) ? date : _today;
    const toKey   = (date_to && _dateRE.test(date_to)) ? date_to : fromKey;

    let statusList;
    if (status) {
      statusList = String(status).split(',').map(s => s.trim()).filter(Boolean);
      const invalid = statusList.find(s => !APPT_STATUS_VALID.has(s));
      if (invalid) return res.status(400).json({ error: `status inválido: ${invalid}` });
    } else {
      statusList = ['pending','confirmed','attended','no_show','pending_reschedule','completed'];
    }

    let page     = parseInt(req.query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    let pageSize = parseInt(req.query.page_size, 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 50;
    if (pageSize > 200) pageSize = 200;
    const offset = (page - 1) * pageSize;

    const baseParams = [userId, branch_id, fromKey, toKey, statusList];

    const totalRes = await pool.query(
      `SELECT COUNT(*) FROM appointments
        WHERE user_id = $1
          AND branch_id = $2
          AND (scheduled_at AT TIME ZONE 'America/Bogota')::date BETWEEN $3::date AND $4::date
          AND status = ANY($5)`,
      baseParams
    );
    const total = parseInt(totalRes.rows[0].count, 10);

    const rowsRes = await pool.query(
      `SELECT a.*, ag.name AS agent_name
       FROM appointments a
       LEFT JOIN agents ag ON ag.id = a.agent_id
       WHERE a.user_id = $1
         AND a.branch_id = $2
         AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date BETWEEN $3::date AND $4::date
         AND a.status = ANY($5)
       ORDER BY a.scheduled_at ASC, a.id ASC
       LIMIT $6 OFFSET $7`,
      [...baseParams, pageSize, offset]
    );

    return res.json({
      items:     rowsRes.rows.map(queueSerializers.serializeForAdmin),
      page,
      page_size: pageSize,
      total,
    });
  } catch (err) {
    console.error('❌ /api/queue/appointments GET:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// Helper compartido §2.3 + §2.4: aplica un patch dentro de
// una transacción, calcula diff y devuelve {row, prevRow, changes}.
// El caller emite el evento Socket.io que corresponda post-commit.
// ─────────────────────────────────────────────────────────────
async function applyAppointmentPatch(userId, apptId, patch) {
  return withTransaction(pool, async (client) => {
    const lockRes = await client.query(
      `SELECT * FROM appointments
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [apptId, userId]
    );
    if (!lockRes.rowCount) {
      const e = new Error('Cita no encontrada'); e.httpStatus = 404; throw e;
    }
    const prev = lockRes.rows[0];

    const sets = [];
    const vals = [];
    const changes = {};
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (patch.client_name !== undefined) {
      const v = queueValidation.validateClientName(patch.client_name);
      if (!v.ok) { const e = new Error(v.error); e.httpStatus = 400; throw e; }
      if (v.value !== prev.client_name) {
        push('client_name', v.value);
        changes.client_name = [prev.client_name, v.value];
      }
    }
    if (patch.client_phone !== undefined) {
      const v = queueValidation.validateClientPhone(patch.client_phone);
      if (!v.ok) { const e = new Error(v.error); e.httpStatus = 400; throw e; }
      if (v.value !== prev.client_phone) {
        push('client_phone', v.value);
        changes.client_phone = [prev.client_phone, v.value];
      }
    }
    if (patch.client_email !== undefined) {
      const v = patch.client_email === null ? null : String(patch.client_email).trim();
      if (v !== prev.client_email) {
        push('client_email', v);
        changes.client_email = [prev.client_email, v];
      }
    }
    if (patch.agent_id !== undefined) {
      const v = patch.agent_id === null ? null : parseInt(patch.agent_id, 10);
      if (v !== null && !Number.isFinite(v)) {
        const e = new Error('agent_id inválido'); e.httpStatus = 400; throw e;
      }
      if (v !== prev.agent_id) {
        push('agent_id', v);
        changes.agent_id = [prev.agent_id, v];
      }
    }

    let nextScheduledAt = prev.scheduled_at;
    let nextServiceId   = prev.service_id;
    let slotChanged     = false;

    if (patch.scheduled_at !== undefined) {
      const v = parseScheduledAt(patch.scheduled_at);
      if (!v.ok) { const e = new Error(v.error); e.httpStatus = 400; throw e; }
      if (v.value.getTime() !== new Date(prev.scheduled_at).getTime()) {
        nextScheduledAt = v.value.toISOString();
        push('scheduled_at', nextScheduledAt);
        changes.scheduled_at = [prev.scheduled_at, nextScheduledAt];
        slotChanged = true;
      }
    }
    if (patch.service_id !== undefined) {
      if (!UUID_RE.test(patch.service_id)) {
        const e = new Error('service_id inválido'); e.httpStatus = 400; throw e;
      }
      if (patch.service_id !== prev.service_id) {
        const svcRes = await client.query(
          `SELECT id FROM services WHERE id = $1 AND branch_id = $2`,
          [patch.service_id, prev.branch_id]
        );
        if (!svcRes.rowCount) {
          const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e;
        }
        nextServiceId = patch.service_id;
        push('service_id', nextServiceId);
        changes.service_id = [prev.service_id, nextServiceId];
        slotChanged = true;
      }
    }

    if (patch.status !== undefined) {
      if (!APPT_STATUS_PATCHABLE.has(patch.status)) {
        const e = new Error(`status no patchable vía API: ${patch.status}`);
        e.httpStatus = 400; throw e;
      }
      if (patch.status !== prev.status) {
        push('status', patch.status);
        changes.status = [prev.status, patch.status];
      }
    }

    // price_at_booking / currency_at_booking → inmutables (silent ignore §2.3).

    if (slotChanged) {
      if (await isSlotBlocked(client, prev.branch_id, nextServiceId, nextScheduledAt)) {
        const e = new Error('El slot está bloqueado');
        e.httpStatus = 409; e.code = 'BLOCKED'; throw e;
      }
    }

    if (sets.length === 0) {
      return { row: prev, prevRow: prev, changes };
    }

    vals.push(apptId, userId);
    const upd = await client.query(
      `UPDATE appointments SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND user_id = $${vals.length}
        RETURNING *`,
      vals
    );
    return { row: upd.rows[0], prevRow: prev, changes };
  });
}

// ─────────────────────────────────────────────────────────────
// §2.3 — PATCH /api/queue/appointments/:id
// ─────────────────────────────────────────────────────────────
app.patch('/api/queue/appointments/:id', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const apptId = req.params.id;
  if (!UUID_RE.test(apptId)) return res.status(400).json({ error: 'id inválido' });

  try {
    const { row, changes } = await applyAppointmentPatch(userId, apptId, req.body || {});

    if (Object.keys(changes).length > 0) {
      io.to(`user_${row.user_id}`).emit('appointment.updated', {
        ...queueSerializers.serializeForAdmin(row),
        changes,
      });
      io.to(`branch_${row.branch_id}`).emit('appointment.updated', {
        ...queueSerializers.serializeForBranch(row),
        changed_fields: Object.keys(changes),
      });
      console.log(`📅 appointment.updated id=${row.id} fields=${Object.keys(changes).join(',')}`);
    }
    return res.json(queueSerializers.serializeForAdmin(row));
  } catch (err) {
    if (err && err.httpStatus) {
      const body = { error: err.message };
      if (err.code) body.code = err.code;
      return res.status(err.httpStatus).json(body);
    }
    if (err && err.code === '23505' &&
        err.constraint === 'appointments_branch_service_slot_uniq') {
      return res.status(409).json({ error: 'Slot ya reservado', code: 'SLOT_TAKEN' });
    }
    console.error('❌ /api/queue/appointments PATCH:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// §2.4 — DELETE /api/queue/appointments/:id  (soft delete)
// ─────────────────────────────────────────────────────────────
app.delete('/api/queue/appointments/:id', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const apptId = req.params.id;
  if (!UUID_RE.test(apptId)) return res.status(400).json({ error: 'id inválido' });

  try {
    const { row, prevRow, changes } = await applyAppointmentPatch(
      userId, apptId, { status: 'cancelled' }
    );

    if (changes.status) {
      const payload = {
        id:           row.id,
        branch_id:    row.branch_id,
        prev_status:  prevRow.status,
        cancelled_at: row.updated_at,
      };
      io.to(`user_${row.user_id}`).emit('appointment.cancelled', payload);
      io.to(`branch_${row.branch_id}`).emit('appointment.cancelled', payload);
      console.log(`📅 appointment.cancelled id=${row.id} prev=${prevRow.status}`);
    }
    return res.json({ ok: true, id: row.id, status: row.status });
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('❌ /api/queue/appointments DELETE:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// §2.5 — GET /api/queue/appointments/slots
// ─────────────────────────────────────────────────────────────
// Lectura pura (sin transacción). Genera la grilla del día.
//
// Fuentes (verificadas SSH sesión 65):
//   · services.slot_duration_minutes (migración 006) con fallback
//     COALESCE(slot_duration_minutes, avg_attention_min, 30)
//   · branches.open_time / branches.close_time (columnas TIME)
//   · appointments activas del día (status IN pending/confirmed/attended)
//   · time_blocks que cubran el slot (incluye service_id NULL = "todos")
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/appointments/slots', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  try {
    const userId = req.user.id;
    const { branch_id, service_id, date } = req.query;

    if (!branch_id || !UUID_RE.test(branch_id)) {
      return res.status(400).json({ error: 'branch_id inválido' });
    }
    if (!service_id || !UUID_RE.test(service_id)) {
      return res.status(400).json({ error: 'service_id inválido' });
    }
    const _dateRE = /^\d{4}-\d{2}-\d{2}$/;
    const _today  = new Date().toISOString().slice(0, 10);
    const fromKey = (date_from && _dateRE.test(date_from)) ? date_from
                  : (date && _dateRE.test(date)) ? date : _today;
    const toKey   = (date_to && _dateRE.test(date_to)) ? date_to : fromKey;

    // Branch + service: ownership + horario + duración.
    const branchRes = await pool.query(
      `SELECT id, open_time, close_time
         FROM branches
        WHERE id = $1 AND user_id = $2`,
      [branch_id, userId]
    );
    if (!branchRes.rowCount) {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    const branch = branchRes.rows[0];

    const svcRes = await pool.query(
      `SELECT id, slot_duration_minutes, avg_attention_min
         FROM services
        WHERE id = $1 AND branch_id = $2`,
      [service_id, branch_id]
    );
    if (!svcRes.rowCount) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    const svc = svcRes.rows[0];
    const stepMinutes = svc.slot_duration_minutes || svc.avg_attention_min || 30;

    // Citas activas del día → set de ISO strings de scheduled_at.
    const apptRes = await pool.query(
      `SELECT scheduled_at FROM appointments
        WHERE user_id = $1
          AND branch_id = $2
          AND service_id = $3
          AND (scheduled_at AT TIME ZONE 'America/Bogota')::date = $4::date
          AND status = ANY($5)`,
      [userId, branch_id, service_id, dayKey, APPT_ACTIVE_STATUSES]
    );
    const occupied = new Set(
      apptRes.rows.map(r => new Date(r.scheduled_at).toISOString())
    );

    // time_blocks que toquen el día — específicos del servicio o "todos" (NULL).
    const blockRes = await pool.query(
      `SELECT starts_at, ends_at FROM time_blocks
        WHERE branch_id = $1
          AND (service_id IS NULL OR service_id = $2)
          AND tstzrange(starts_at, ends_at, '[)')
              && tstzrange(($3::date)::timestamptz,
                           ($3::date + INTERVAL '1 day')::timestamptz, '[)')`,
      [branch_id, service_id, dayKey]
    );

    const grid = queueSlots.buildSlotsGrid({
      date:          dayKey,
      openTime:      branch.open_time,
      closeTime:     branch.close_time,
      stepMinutes,
      occupiedSet:   occupied,
      blockedRanges: blockRes.rows,
    });

    return res.json(grid);
  } catch (err) {
    console.error('❌ /api/queue/appointments/slots GET:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// §2.6 — POST /api/queue/appointments/:id/confirm-presence
// ─────────────────────────────────────────────────────────────
// Auth dual (sesión 66, decisiones D4+D5):
//   - Admin/agente vía Authorization: Bearer <JWT> → req.user
//   - Kiosko vía X-Branch-Token: <UUID>            → req.branch
// requireAdminOrKiosk decide según presencia del header X-Branch-Token.
//
// Respuesta uniforme anti-enumeración: TODA condición de no-match
// devuelve 200 OK con { confirmed: false }. Solo errores de schema
// (400) o fallo transaccional (500) escapan al patrón.
//
// Diferencias por path:
//   - Admin: branch_id obligatorio en body; userId desde JWT.
//   - Kiosko: branch_id IGNORA body (viene de req.branch.id); userId
//             se obtiene de la branch resuelta; validación adicional
//             de horario (open_time/close_time en timezone de la branch)
//             como defense-in-depth — fuera de horario → no-match.
//
// En match: UPDATE status='attended' + INSERT queue_tokens con
// link al appointment + INSERT token_events + emit appointment.confirmed
// post-commit en user_${id} y branch_${id}. Telemetría incluye confirmed_via.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/appointments/:id/confirm-presence', requireAdminOrKiosk, async (req, res) => {
  const isKiosk = !!req.branch;
  // G-1 #7 — feature flag aplica solo al path admin. El path kiosko (X-Branch-Token)
  // queda abierto: el token de sucursal es la credencial y no porta features JSONB.
  if (!isKiosk) {
    const enabled = req.user && req.user.features && req.user.features.queue_v2_appointments === true;
    if (!enabled) {
      return res.status(403).json({ error: 'FEATURE_DISABLED', feature: 'queue_v2_appointments' });
    }
  }
  const userId = isKiosk ? req.branch.user_id : req.user.id;
  const branch_id = isKiosk ? req.branch.id : (req.body && req.body.branch_id);
  const confirmedVia = isKiosk ? 'kiosk' : 'admin';
  const apptId = req.params.id;
  const { client_id_number } = req.body || {};

  // Validación de schema (única vía que escapa anti-enumeración).
  if (!apptId || !UUID_RE.test(apptId)) {
    return res.status(400).json({ error: 'id inválido' });
  }
  if (!branch_id || !UUID_RE.test(branch_id)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  const vId = queueValidation.validateClientIdNumber(client_id_number);
  if (!vId.ok) return res.status(400).json({ error: vId.error });

  try {
    const outcome = await withTransaction(pool, async (client) => {
      // Match exigente: id + branch + cédula + status='confirmed' + hoy + tenant.
      // El JOIN con branches garantiza el filtro por user_id sin tocar appointments.user_id
      // (cubre el caso de citas legacy si las hubiera). Aun así appointments.user_id es NOT NULL
      // post-migración 002.
      const matchRes = await client.query(
        `SELECT a.*, b.timezone AS branch_tz, b.open_time AS branch_open, b.close_time AS branch_close
           FROM appointments a
           JOIN branches b ON b.id = a.branch_id
          WHERE a.id = $1
            AND a.branch_id = $2
            AND b.user_id = $3
            AND a.user_id = $3
            AND a.client_id_number = $4
            AND a.status = 'confirmed'
            AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date = (NOW() AT TIME ZONE 'America/Bogota')::date
          FOR UPDATE OF a`,
        [apptId, branch_id, userId, vId.value]
      );

      if (!matchRes.rowCount) {
        // No-match: NO se hace nada — la transacción confirma vacía.
        return { confirmed: false };
      }
      const appt = matchRes.rows[0];

      // Defense-in-depth para kiosko: verificar que la hora actual en el
      // timezone de la branch está dentro del rango [open_time, close_time].
      // Si no, tratamos como no-match (anti-enumeración). El admin puede
      // confirmar fuera de horario (excepciones operativas).
      if (isKiosk) {
        const tz = appt.branch_tz || 'America/Bogota';
        const tzCheck = await client.query(
          `SELECT (
             (NOW() AT TIME ZONE $1)::time >= $2::time
             AND (NOW() AT TIME ZONE $1)::time <  $3::time
           ) AS in_window`,
          [tz, appt.branch_open || '00:00:00', appt.branch_close || '23:59:59']
        );
        if (!tzCheck.rows[0].in_window) {
          return { confirmed: false };
        }
      }

      // Servicio para componer el token_number (prefijo) y wait.
      const svcRes = await client.query(
        `SELECT id, prefix, avg_attention_min FROM services WHERE id = $1`,
        [appt.service_id]
      );
      if (!svcRes.rowCount) {
        // Defensivo (no debería pasar — FK). Si pasa, no leakeamos info: no-match.
        return { confirmed: false };
      }
      const svc = svcRes.rows[0];

      // Advisory lock por scope (branch, service, hoy) — mismo patrón R0
      // para serializar la generación de correlativo.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text)
         )`,
        [appt.branch_id, appt.service_id]
      );

      const nextNum = await generateNextTokenNumber(client, appt.branch_id, appt.service_id);
      const tokenNumber = `${svc.prefix}${String(nextNum).padStart(3, '0')}`;

      // INSERT del token vinculado a la cita.
      const tokenRes = await client.query(
        `INSERT INTO queue_tokens
           (branch_id, service_id, token_number, display_number,
            is_priority, is_appointment, channel,
            client_name, client_phone, appointment_id)
         VALUES ($1,$2,$3,$3,false,true,'appointment',$4,$5,$6)
         RETURNING *`,
        [
          appt.branch_id, appt.service_id, tokenNumber,
          appt.client_name, appt.client_phone, appt.id,
        ]
      );
      const token = tokenRes.rows[0];

      // Telemetría queue v1 (consistencia con POST /api/queue/token).
      await client.query(
        `INSERT INTO token_events (token_id, event_type, metadata)
         VALUES ($1, 'appointment_confirmed', $2)`,
        [token.id, JSON.stringify({ appointment_id: appt.id, method: 'cedula', via: confirmedVia })]
      );

      // Transición de la cita.
      const upd = await client.query(
        `UPDATE appointments
            SET status = 'attended'
          WHERE id = $1
        RETURNING *`,
        [appt.id]
      );

      // Cola actual para estimar posición + espera.
      const waitingRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM queue_tokens
          WHERE branch_id = $1 AND service_id = $2
            AND date_key = CURRENT_DATE
            AND status = 'waiting'`,
        [appt.branch_id, appt.service_id]
      );
      const queuePosition = waitingRes.rows[0].n; // el token recién creado entra como 'waiting' → cuenta incluida
      const estimatedWaitMinutes = Math.max(0, (queuePosition - 1) * (svc.avg_attention_min || 0));

      return {
        confirmed: true,
        appointment: upd.rows[0],
        token,
        tokenNumber,
        queuePosition,
        estimatedWaitMinutes,
      };
    });

    if (!outcome.confirmed) {
      return res.json({ confirmed: false });
    }

    // Post-commit: emit appointment.confirmed.
    const payload = {
      id:           outcome.appointment.id,
      branch_id:    outcome.appointment.branch_id,
      token_id:     outcome.token.id,
      token_number: outcome.tokenNumber,
      method:       'cedula',
      via:          confirmedVia,
    };
    io.to(`user_${outcome.appointment.user_id}`).emit('appointment.confirmed', payload);
    io.to(`branch_${outcome.appointment.branch_id}`).emit('appointment.confirmed', payload);

    // También notificamos la cola (paridad con POST /api/queue/token).
    io.to(`branch_${outcome.appointment.branch_id}`).emit('new_token', {
      token: outcome.token,
      is_appointment: true,
      waiting_count: outcome.queuePosition,
      estimated_wait: outcome.estimatedWaitMinutes,
    });

    console.log(
      `📅 appointment.confirmed id=${outcome.appointment.id} token=${outcome.tokenNumber} via=${confirmedVia}`
    );
    return res.json({
      confirmed: true,
      token_number: outcome.tokenNumber,
      estimated_wait_minutes: outcome.estimatedWaitMinutes,
      queue_position: outcome.queuePosition,
    });

  } catch (err) {
    console.error('❌ /api/queue/appointments/:id/confirm-presence:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});


// ─────────────────────────────────────────────────────────────
// R1 §2.6b — POST /api/queue/appointments/:id/confirm-arrival
// Confirma llegada del cliente desde el dashboard (admin), sin
// requerir cédula. Acepta pending OR confirmed. Crea queue_token
// y pasa la cita a 'attended'. Principio P1 (withTransaction).
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/appointments/:id/confirm-arrival',
  authenticateToken,
  requireFeatureFlag('queue_v2_appointments'),
  async (req, res) => {
    const userId = req.user.id;
    const apptId = req.params.id;
    if (!UUID_RE.test(apptId)) {
      return res.status(400).json({ error: 'ID de cita inválido' });
    }

    try {
      const result = await withTransaction(pool, async (client) => {
        const apptRes = await client.query(
          `SELECT a.*, s.prefix, s.avg_attention_min, s.slot_duration_minutes
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           WHERE a.id = $1
             AND a.user_id = $2
             AND a.status IN ('pending','confirmed')
             AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date
                 = (NOW() AT TIME ZONE 'America/Bogota')::date
           FOR UPDATE OF a`,
          [apptId, userId]
        );
        if (!apptRes.rowCount) {
          const e = new Error('Cita no encontrada, ya atendida o no es de hoy');
          e.httpStatus = 404;
          throw e;
        }
        const appt = apptRes.rows[0];

        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text)
           )`,
          [appt.branch_id, appt.service_id]
        );

        const nextNum = await generateNextTokenNumber(client, appt.branch_id, appt.service_id);
        const tokenNumber = `${appt.prefix}${String(nextNum).padStart(3, '0')}`;

        const slotMin = appt.slot_duration_minutes || appt.avg_attention_min || 30;
        const slotMs  = slotMin * 60 * 1000;
        const occupiedRes = await client.query(
          `SELECT scheduled_at AS t FROM appointments
            WHERE branch_id = $1 AND service_id = $2
              AND (scheduled_at AT TIME ZONE 'America/Bogota')::date
                  = (NOW() AT TIME ZONE 'America/Bogota')::date
              AND status IN ('pending','confirmed','attended')
              AND id <> $3
           UNION ALL
           SELECT estimated_call_at AS t FROM queue_tokens
            WHERE branch_id = $1 AND service_id = $2
              AND date_key = CURRENT_DATE
              AND status IN ('waiting','called','attending')
              AND estimated_call_at IS NOT NULL
           ORDER BY t ASC`,
          [appt.branch_id, appt.service_id, apptId]
        );
        const occupied = occupiedRes.rows.map(r => new Date(r.t).getTime());
        let candidate = Math.ceil(Date.now() / slotMs) * slotMs;
        for (const occ of occupied) {
          if (candidate >= occ && candidate < occ + slotMs) candidate = occ + slotMs;
        }
        const estimatedCallAt = new Date(candidate);

        const tokenRes = await client.query(
          `INSERT INTO queue_tokens
             (branch_id, service_id, token_number, display_number,
              is_priority, is_appointment, channel,
              client_name, client_phone, appointment_id, estimated_call_at)
           VALUES ($1,$2,$3,$3,false,true,'appointment',$4,$5,$6,$7)
           RETURNING *`,
          [appt.branch_id, appt.service_id, tokenNumber,
           appt.client_name, appt.client_phone, apptId, estimatedCallAt]
        );
        const token = tokenRes.rows[0];

        await client.query(
          `INSERT INTO token_events (token_id, event_type, metadata)
           VALUES ($1,'appointment_confirmed',$2)`,
          [token.id, JSON.stringify({ appointment_id: apptId, method: 'admin_arrival' })]
        );

        await client.query(
          `UPDATE appointments SET status = 'attended' WHERE id = $1`, [apptId]
        );

        const waitRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM queue_tokens
            WHERE branch_id = $1 AND service_id = $2
              AND date_key = CURRENT_DATE AND status = 'waiting'`,
          [appt.branch_id, appt.service_id]
        );

        return {
          confirmed: true,
          token_number: tokenNumber,
          queue_position: waitRes.rows[0].n,
          estimated_call_at: estimatedCallAt,
          branch_id: appt.branch_id,
        };
      });

      io.to(`branch_${result.branch_id}`).emit('queue_updated', {
        branch_id: result.branch_id,
        action: 'arrival_confirmed',
        token_number: result.token_number,
      });
      io.to(`branch_${result.branch_id}`).emit('appointment.attended', {
        id: req.params.id, token_number: result.token_number, branch_id: result.branch_id,
      });

      return res.json(result);
    } catch (err) {
      if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      console.error('❌ /api/queue/appointments/:id/confirm-arrival:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// R1 §2.6c — POST /api/queue/agent/appointments/:id/confirm-arrival
// Agente confirma llegada física de un cliente con cita.
// Usa authenticateAgentOrUser (token de agente, no admin).
// Deriva user_id del owner desde la sucursal (igual que §A agenda).
// P1: withTransaction | P2: user_id del owner | P4: telemetría.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/agent/appointments/:id/confirm-arrival',
  authenticateAgentOrUser,
  async (req, res) => {
    const agentId  = req.user.agent_id || null;
    const branchId = req.user.branch_id;
    const apptId   = req.params.id;

    if (!branchId || !UUID_RE.test(branchId)) {
      return res.status(400).json({ error: 'branch_id requerido en el token del agente' });
    }
    if (!UUID_RE.test(apptId)) {
      return res.status(400).json({ error: 'ID de cita inválido' });
    }

    try {
      const branchRow = await pool.query(
        `SELECT b.user_id AS owner_id, u.features->>'queue_v2_appointments' AS enabled
         FROM branches b JOIN users u ON u.id = b.user_id WHERE b.id = $1`,
        [branchId]
      );
      if (!branchRow.rowCount || branchRow.rows[0].enabled !== 'true') {
        return res.status(403).json({ error: 'FEATURE_DISABLED' });
      }
      const userId = branchRow.rows[0].owner_id;

      const result = await withTransaction(pool, async (client) => {
        const apptRes = await client.query(
          `SELECT a.*, s.prefix, s.avg_attention_min, s.slot_duration_minutes
           FROM appointments a
           JOIN services s ON s.id = a.service_id
           WHERE a.id = $1
             AND a.user_id = $2
             AND a.branch_id = $3
             AND a.status IN ('pending','confirmed')
             AND (a.scheduled_at AT TIME ZONE 'America/Bogota')::date
                 = (NOW() AT TIME ZONE 'America/Bogota')::date
           FOR UPDATE OF a`,
          [apptId, userId, branchId]
        );
        if (!apptRes.rowCount) {
          const e = new Error('Cita no encontrada, ya atendida o no es de hoy');
          e.httpStatus = 404; throw e;
        }
        const appt = apptRes.rows[0];

        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text))`,
          [appt.branch_id, appt.service_id]
        );

        const nextNum = await generateNextTokenNumber(client, appt.branch_id, appt.service_id);
        const tokenNumber = `${appt.prefix}${String(nextNum).padStart(3, '0')}`;
        const slotMin = appt.slot_duration_minutes || appt.avg_attention_min || 30;
        const slotMs  = slotMin * 60 * 1000;

        const occupiedRes = await client.query(
          `SELECT scheduled_at AS t FROM appointments
            WHERE branch_id = $1 AND service_id = $2
              AND (scheduled_at AT TIME ZONE 'America/Bogota')::date = (NOW() AT TIME ZONE 'America/Bogota')::date
              AND status IN ('pending','confirmed','attended') AND id <> $3
           UNION ALL
           SELECT estimated_call_at AS t FROM queue_tokens
            WHERE branch_id = $1 AND service_id = $2
              AND date_key = CURRENT_DATE AND status IN ('waiting','called','attending')
              AND estimated_call_at IS NOT NULL
           ORDER BY t ASC`,
          [appt.branch_id, appt.service_id, apptId]
        );
        const occupied = occupiedRes.rows.map(r => new Date(r.t).getTime());
        let candidate = Math.ceil(Date.now() / slotMs) * slotMs;
        for (const occ of occupied) {
          if (candidate >= occ && candidate < occ + slotMs) candidate = occ + slotMs;
        }
        const estimatedCallAt = new Date(candidate);

        const tokenRes = await client.query(
          `INSERT INTO queue_tokens
             (branch_id, service_id, token_number, display_number,
              is_priority, is_appointment, channel,
              client_name, client_phone, appointment_id, estimated_call_at)
           VALUES ($1,$2,$3,$3,false,true,'appointment',$4,$5,$6,$7)
           RETURNING *`,
          [appt.branch_id, appt.service_id, tokenNumber,
           appt.client_name, appt.client_phone, apptId, estimatedCallAt]
        );
        const token = tokenRes.rows[0];

        await client.query(
          `INSERT INTO token_events (token_id, event_type, metadata)
           VALUES ($1,'appointment_confirmed',$2)`,
          [token.id, JSON.stringify({ appointment_id: apptId, method: 'agent_arrival', agent_id: agentId })]
        );

        await client.query(
          `UPDATE appointments SET status = 'attended', agent_id = $2 WHERE id = $1`,
          [apptId, agentId]
        );

        const waitRes = await client.query(
          `SELECT COUNT(*)::int AS n FROM queue_tokens
            WHERE branch_id = $1 AND service_id = $2
              AND date_key = CURRENT_DATE AND status = 'waiting'`,
          [appt.branch_id, appt.service_id]
        );

        return {
          confirmed: true,
          token_number: tokenNumber,
          queue_position: waitRes.rows[0].n,
          estimated_call_at: estimatedCallAt,
          branch_id: appt.branch_id,
        };
      });

      io.to(`branch_${result.branch_id}`).emit('queue_updated', {
        branch_id: result.branch_id, action: 'arrival_confirmed', token_number: result.token_number,
      });
      io.to(`branch_${result.branch_id}`).emit('appointment.attended', {
        id: apptId, token_number: result.token_number, branch_id: result.branch_id,
      });

      console.log(JSON.stringify({ event: 'appointment.confirmed', appt_id: apptId,
        agent_id: agentId, token_number: result.token_number }));
      return res.json(result);
    } catch (err) {
      if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
      console.error('❌ /api/queue/agent/appointments/:id/confirm-arrival:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// R1 §2.7 — PATCH /api/queue/branches/:id/operation-mode
// Cambia branches.operation_mode entre los 3 valores permitidos
// ('queue_only' | 'appointments_only' | 'queue_and_appointments')
// bajo withTransaction (es un UPDATE simple pero seguimos el
// patrón obligatorio del framework §3.1) con filtrado de tenancy.
//
// Auth: authenticateToken — solo el dueño del tenant puede mutar
// el modo de operación de sus propias branches.
//
// Emite post-commit `branch.operation_mode.changed` con prev/new
// en las salas user_${userId} y branch_${branchId} (sanitizado
// idéntico — no hay PII en el payload).
// ─────────────────────────────────────────────────────────────
const BRANCH_OPERATION_MODES = ['queue_only', 'appointments_only', 'queue_and_appointments'];

app.patch('/api/queue/branches/:id/operation-mode', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const branchId = req.params.id;
  const { operation_mode } = req.body || {};

  if (!branchId || !UUID_RE.test(branchId)) {
    return res.status(400).json({ error: 'id inválido' });
  }
  if (typeof operation_mode !== 'string' || !BRANCH_OPERATION_MODES.includes(operation_mode)) {
    return res.status(400).json({
      error: `operation_mode debe ser uno de: ${BRANCH_OPERATION_MODES.join(', ')}`,
    });
  }

  try {
    const outcome = await withTransaction(pool, async (client) => {
      // SELECT FOR UPDATE filtrado por tenant: evita race condition si dos
      // clientes del mismo user_id mutan a la vez, y previene cross-tenant.
      const cur = await client.query(
        `SELECT id, user_id, operation_mode
           FROM branches
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [branchId, userId]
      );
      if (cur.rowCount === 0) {
        const e = new Error('Branch no encontrada');
        e.httpStatus = 404;
        throw e;
      }
      const prev = cur.rows[0].operation_mode;

      // No-op explícito: si ya está en el modo solicitado, salimos sin UPDATE
      // ni emit (idempotencia barata, sin escritura inútil).
      if (prev === operation_mode) {
        return { branchId, userId, prev, next: prev, changed: false };
      }

      const upd = await client.query(
        `UPDATE branches
            SET operation_mode = $1,
                updated_at = NOW()
          WHERE id = $2 AND user_id = $3
        RETURNING id, operation_mode, updated_at`,
        [operation_mode, branchId, userId]
      );
      return {
        branchId,
        userId,
        prev,
        next: upd.rows[0].operation_mode,
        updatedAt: upd.rows[0].updated_at,
        changed: true,
      };
    });

    if (outcome.changed) {
      const payload = {
        branch_id:      outcome.branchId,
        previous_mode:  outcome.prev,
        operation_mode: outcome.next,
        updated_at:     outcome.updatedAt,
      };
      io.to(`user_${outcome.userId}`).emit('branch.operation_mode.changed', payload);
      io.to(`branch_${outcome.branchId}`).emit('branch.operation_mode.changed', payload);
      console.log(
        `🔧 branch.operation_mode.changed branch=${outcome.branchId} ${outcome.prev}→${outcome.next}`
      );
    }

    return res.json({
      branch_id:      outcome.branchId,
      operation_mode: outcome.next,
      previous_mode:  outcome.prev,
      changed:        outcome.changed,
    });
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('❌ PATCH /api/queue/branches/:id/operation-mode:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1 §2.6.b — POST /api/queue/branches/:id/kiosk-token/rotate
// Rota el UUID kiosk_token de una branch. Invalida cualquier kiosko
// conectado con el token anterior; el admin debe propagar el nuevo
// a la tablet/pantalla manualmente.
//
// Auth: solo admin (authenticateToken). El nuevo token se devuelve
// EN EL CUERPO HTTP (única exhibición); el evento socket NO lo
// incluye para no filtrarlo en logs ni a otros clientes.
//
// Telemetría: branch.kiosk_token.rotated emitido SOLO en
// user_${userId} (jamás en branch_${id} — los kioskos escuchan ahí
// y no deben recibir el secreto rotado).
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/branches/:id/kiosk-token/rotate', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const branchId = req.params.id;
  if (!branchId || !UUID_RE.test(branchId)) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const outcome = await withTransaction(pool, async (client) => {
      const cur = await client.query(
        `SELECT id, user_id FROM branches WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [branchId, userId]
      );
      if (cur.rowCount === 0) {
        const e = new Error('Branch no encontrada');
        e.httpStatus = 404;
        throw e;
      }
      const upd = await client.query(
        `UPDATE branches
            SET kiosk_token = gen_random_uuid(),
                updated_at  = NOW()
          WHERE id = $1 AND user_id = $2
        RETURNING id, kiosk_token, updated_at`,
        [branchId, userId]
      );
      return {
        branchId,
        userId,
        kioskToken: upd.rows[0].kiosk_token,
        rotatedAt:  upd.rows[0].updated_at,
      };
    });

    // Socket: NO incluir el token. Solo señalar la rotación al admin.
    io.to(`user_${outcome.userId}`).emit('branch.kiosk_token.rotated', {
      branch_id:  outcome.branchId,
      rotated_at: outcome.rotatedAt,
    });
    console.log(`🔑 branch.kiosk_token.rotated branch=${outcome.branchId}`);

    return res.json({
      branch_id:   outcome.branchId,
      kiosk_token: outcome.kioskToken,
      rotated_at:  outcome.rotatedAt,
    });
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('❌ POST /api/queue/branches/:id/kiosk-token/rotate:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1 §2.9 — POST /api/queue/kiosk/confirm-presence
// Confirmación de cita desde kiosco sin ID de cita (solo cédula).
// Auth: validateKioskToken (X-Branch-Token). Sin feature flag —
// el token de sucursal es la credencial. Anti-enumeración: toda
// condición de no-match devuelve 200 { confirmed: false }.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/kiosk/confirm-presence', validateKioskToken, async (req, res) => {
  const branch_id = req.branch.id;
  const userId    = req.branch.user_id;
  const { client_id_number } = req.body || {};

  const vId = queueValidation.validateClientIdNumber(client_id_number);
  if (!vId.ok) return res.status(400).json({ error: vId.error });

  try {
    const outcome = await withTransaction(pool, async (client) => {
      const tz = req.branch.timezone || 'America/Bogota';

      // Defense-in-depth: horario de atención. Fuera de ventana → no-match.
      const tzCheck = await client.query(
        `SELECT (
           (NOW() AT TIME ZONE $1)::time >= $2::time
           AND (NOW() AT TIME ZONE $1)::time <  $3::time
         ) AS in_window`,
        [tz, req.branch.open_time || '00:00:00', req.branch.close_time || '23:59:59']
      );
      if (!tzCheck.rows[0].in_window) {
        return { confirmed: false };
      }

      // Lookup por cédula+branch+hoy (la más reciente si hay varias citas).
      const matchRes = await client.query(
        `SELECT a.*
           FROM appointments a
          WHERE a.branch_id = $1
            AND a.user_id   = $2
            AND a.client_id_number = $3
            AND a.status = 'confirmed'
            AND (a.scheduled_at AT TIME ZONE $4)::date = (NOW() AT TIME ZONE $4)::date
          ORDER BY a.scheduled_at ASC
          LIMIT 1
          FOR UPDATE OF a`,
        [branch_id, userId, vId.value, tz]
      );

      if (!matchRes.rowCount) {
        return { confirmed: false };
      }
      const appt = matchRes.rows[0];

      const svcRes = await client.query(
        `SELECT id, prefix, avg_attention_min FROM services WHERE id = $1`,
        [appt.service_id]
      );
      if (!svcRes.rowCount) return { confirmed: false };
      const svc = svcRes.rows[0];

      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text)
         )`,
        [appt.branch_id, appt.service_id]
      );

      const nextNum     = await generateNextTokenNumber(client, appt.branch_id, appt.service_id);
      const tokenNumber = `${svc.prefix}${String(nextNum).padStart(3, '0')}`;

      const tokenRes = await client.query(
        `INSERT INTO queue_tokens
           (branch_id, service_id, token_number, display_number,
            is_priority, is_appointment, channel,
            client_name, client_phone, appointment_id)
         VALUES ($1,$2,$3,$3,false,true,'kiosk',$4,$5,$6)
         RETURNING *`,
        [appt.branch_id, appt.service_id, tokenNumber,
         appt.client_name, appt.client_phone, appt.id]
      );
      const token = tokenRes.rows[0];

      await client.query(
        `INSERT INTO token_events (token_id, event_type, metadata)
         VALUES ($1, 'appointment_confirmed', $2)`,
        [token.id, JSON.stringify({ appointment_id: appt.id, method: 'cedula', via: 'kiosk' })]
      );

      await client.query(
        `UPDATE appointments SET status = 'attended' WHERE id = $1`,
        [appt.id]
      );

      const waitingRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM queue_tokens
          WHERE branch_id = $1 AND service_id = $2
            AND date_key = CURRENT_DATE
            AND status = 'waiting'`,
        [appt.branch_id, appt.service_id]
      );
      const queuePosition        = waitingRes.rows[0].n;
      const estimatedWaitMinutes = Math.max(0, (queuePosition - 1) * (svc.avg_attention_min || 0));

      return { confirmed: true, appt, token, tokenNumber, queuePosition, estimatedWaitMinutes };
    });

    if (!outcome.confirmed) {
      return res.json({ confirmed: false });
    }

    const payload = {
      id:           outcome.appt.id,
      branch_id:    outcome.appt.branch_id,
      token_id:     outcome.token.id,
      token_number: outcome.tokenNumber,
      method:       'cedula',
      via:          'kiosk',
    };
    io.to(`user_${userId}`).emit('appointment.confirmed', payload);
    io.to(`branch_${outcome.appt.branch_id}`).emit('appointment.confirmed', payload);
    io.to(`branch_${outcome.appt.branch_id}`).emit('new_token', {
      token:          outcome.token,
      is_appointment: true,
      waiting_count:  outcome.queuePosition,
      estimated_wait: outcome.estimatedWaitMinutes,
    });

    console.log(`📅 kiosk.appointment.confirmed id=${outcome.appt.id} token=${outcome.tokenNumber}`);
    return res.json({
      confirmed:              true,
      token_number:           outcome.tokenNumber,
      estimated_wait_minutes: outcome.estimatedWaitMinutes,
      queue_position:         outcome.queuePosition,
    });

  } catch (err) {
    console.error('❌ POST /api/queue/kiosk/confirm-presence:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1 ext. — POST /api/queue/appointments/confirm-by-qr
// Confirmación de presencia escaneando el QR del cliente
// desde el counter del agente (lector HID externo).
// Auth: authenticateAgentOrUser. Multi-tenancy: user_id check.
// El token public_appointment_tokens NO se marca used_at:
// action_allowed cubre reschedule/cancel; confirmar presencia
// es acción del agente, no acción del cliente.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/appointments/confirm-by-qr', authenticateAgentOrUser, async (req, res) => {
  const { token } = req.body || {};
  const userId    = req.user.id;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!token || !uuidRe.test(token)) {
    return res.status(400).json({ error: 'Token QR inválido' });
  }

  try {
    const outcome = await withTransaction(pool, async (client) => {
      // 1. Lookup cita via public token (sin expiración — el agente confirma físicamente)
      const patRes = await client.query(
        `SELECT pat.appointment_id, a.user_id AS appt_user_id,
                a.branch_id, a.service_id, a.status,
                a.client_name, a.client_phone
           FROM public_appointment_tokens pat
           JOIN appointments a ON a.id = pat.appointment_id
          WHERE pat.token = $1`,
        [token]
      );
      if (!patRes.rowCount) {
        const e = new Error('Cita no encontrada para este código QR');
        e.httpStatus = 404; throw e;
      }

      const { appointment_id, appt_user_id, branch_id, service_id,
              status, client_name, client_phone } = patRes.rows[0];

      // 2. Multi-tenancy: agents.user_id es la cuenta del agente, no del tenant.
      //    El tenant real es branches.user_id (ownerUserId).
      let ownerUserId = userId;
      if (req.user.branch_id) {
        const ownerRes = await client.query(
          'SELECT user_id AS owner_id FROM branches WHERE id = $1',
          [req.user.branch_id]
        );
        if (ownerRes.rowCount) ownerUserId = ownerRes.rows[0].owner_id;
      }
      if (appt_user_id !== ownerUserId) {
        const e = new Error('No autorizado'); e.httpStatus = 403; throw e;
      }

      // 3. Estado válido para confirmar
      if (status === 'attended') {
        const e = new Error('La cita ya fue confirmada');
        e.httpStatus = 409; e.code = 'ALREADY_CONFIRMED'; throw e;
      }
      if (!['pending', 'confirmed'].includes(status)) {
        const e = new Error(`La cita no puede confirmarse (estado: ${status})`);
        e.httpStatus = 409; throw e;
      }

      // 4. Advisory lock anti-doble-scan
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text))`,
        [branch_id, service_id]
      );

      // 5. Re-check dentro del lock
      const recheck = await client.query(
        `SELECT status FROM appointments WHERE id = $1`, [appointment_id]
      );
      if (recheck.rows[0]?.status === 'attended') {
        const e = new Error('La cita ya fue confirmada');
        e.httpStatus = 409; e.code = 'ALREADY_CONFIRMED'; throw e;
      }

      // 6. Info del servicio
      const svcRes = await client.query(
        `SELECT id, prefix, avg_attention_min FROM services WHERE id = $1`, [service_id]
      );
      if (!svcRes.rowCount) {
        const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e;
      }
      const svc = svcRes.rows[0];

      // 7. Número de turno
      const nextNum     = await generateNextTokenNumber(client, branch_id, service_id);
      const tokenNumber = `${svc.prefix}${String(nextNum).padStart(3, '0')}`;

      // 8. INSERT queue_token (channel='agent')
      const tokenRes = await client.query(
        `INSERT INTO queue_tokens
           (branch_id, service_id, token_number, display_number,
            is_priority, is_appointment, channel,
            client_name, client_phone, appointment_id)
         VALUES ($1,$2,$3,$3,false,true,'agent',$4,$5,$6)
         RETURNING *`,
        [branch_id, service_id, tokenNumber, client_name, client_phone, appointment_id]
      );
      const queueToken = tokenRes.rows[0];

      // 9. token_event
      await client.query(
        `INSERT INTO token_events (token_id, event_type, agent_id, metadata)
         VALUES ($1,'appointment_confirmed',$2,$3)`,
        [queueToken.id,
         req.user.agent_id || null,
         JSON.stringify({ appointment_id, method: 'qr', via: 'agent_counter' })]
      );

      // 10. appointment → attended
      await client.query(
        `UPDATE appointments SET status = 'attended' WHERE id = $1`, [appointment_id]
      );

      // 11. Posición + espera estimada
      const waitRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM queue_tokens
          WHERE branch_id = $1 AND service_id = $2
            AND date_key = CURRENT_DATE AND status = 'waiting'`,
        [branch_id, service_id]
      );
      const queuePosition        = waitRes.rows[0].n;
      const estimatedWaitMinutes = Math.max(0, (queuePosition - 1) * (svc.avg_attention_min || 0));

      return { appointment_id, branch_id, queueToken, tokenNumber,
               client_name, queuePosition, estimatedWaitMinutes };
    });

    const payload = {
      id: outcome.appointment_id, branch_id: outcome.branch_id,
      token_id: outcome.queueToken.id, token_number: outcome.tokenNumber,
      method: 'qr', via: 'agent_counter',
    };
    io.to(`user_${userId}`).emit('appointment.confirmed', payload);
    io.to(`branch_${outcome.branch_id}`).emit('appointment.confirmed', payload);
    io.to(`branch_${outcome.branch_id}`).emit('new_token', {
      token:          outcome.queueToken,
      is_appointment: true,
      waiting_count:  outcome.queuePosition,
      estimated_wait: outcome.estimatedWaitMinutes,
    });

    console.log(`📅 agent.qr.confirmed id=${outcome.appointment_id} token=${outcome.tokenNumber}`);
    return res.json({
      confirmed:              true,
      token_number:           outcome.tokenNumber,
      client_name:            outcome.client_name,
      estimated_wait_minutes: outcome.estimatedWaitMinutes,
      queue_position:         outcome.queuePosition,
    });

  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
    console.error('❌ POST /api/queue/appointments/confirm-by-qr:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});



// ─────────────────────────────────────────────────────────────
// R1 ext. — POST /api/queue/kiosk/confirm-by-qr
// Confirmacion de presencia por QR desde kiosko de autoservicio.
// Auth: validateKioskToken. Multi-tenancy: branch check.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/kiosk/confirm-by-qr', validateKioskToken, async (req, res) => {
  const { token } = req.body || {};
  const branchId    = req.branch.id;
  const ownerUserId = req.branch.user_id;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!token || !uuidRe.test(token)) {
    return res.status(400).json({ error: 'Token QR invalido' });
  }

  try {
    const outcome = await withTransaction(pool, async (client) => {
      // 1. Lookup cita via public token
      const patRes = await client.query(
        `SELECT pat.appointment_id, a.user_id AS appt_user_id,
                a.branch_id AS appt_branch_id,
                a.service_id, a.status,
                a.client_name, a.client_phone
           FROM public_appointment_tokens pat
           JOIN appointments a ON a.id = pat.appointment_id
          WHERE pat.token = $1`,
        [token]
      );
      if (!patRes.rowCount) {
        const e = new Error('Cita no encontrada para este codigo QR');
        e.httpStatus = 404; throw e;
      }

      const { appointment_id, appt_user_id, appt_branch_id,
              service_id, status, client_name, client_phone } = patRes.rows[0];

      // 2. Multi-tenancy: el kiosko solo confirma citas de su sucursal
      if (appt_branch_id !== branchId || appt_user_id !== ownerUserId) {
        const e = new Error('Esta cita no pertenece a esta sucursal');
        e.httpStatus = 403; throw e;
      }

      // 3. Estado valido para confirmar
      if (status === 'attended') {
        const e = new Error('La cita ya fue confirmada');
        e.httpStatus = 409; e.code = 'ALREADY_CONFIRMED'; throw e;
      }
      if (!['pending', 'confirmed'].includes(status)) {
        const e = new Error(`La cita no puede confirmarse (estado: ${status})`);
        e.httpStatus = 409; throw e;
      }

      // 4. Advisory lock anti-doble-scan
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext($1::text || ':' || $2::text || ':' || CURRENT_DATE::text))`,
        [branchId, service_id]
      );

      // 5. Re-check dentro del lock
      const recheck = await client.query(
        `SELECT status FROM appointments WHERE id = $1`, [appointment_id]
      );
      if (recheck.rows[0]?.status === 'attended') {
        const e = new Error('La cita ya fue confirmada');
        e.httpStatus = 409; e.code = 'ALREADY_CONFIRMED'; throw e;
      }

      // 6. Info del servicio (name y color para la pantalla de confirmacion)
      const svcRes = await client.query(
        `SELECT id, name, prefix, avg_attention_min, color FROM services WHERE id = $1`,
        [service_id]
      );
      if (!svcRes.rowCount) {
        const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e;
      }
      const svc = svcRes.rows[0];

      // 7. Numero de turno
      const nextNum     = await generateNextTokenNumber(client, branchId, service_id);
      const tokenNumber = `${svc.prefix}${String(nextNum).padStart(3, '0')}`;

      // 8. INSERT queue_token (channel=kiosk)
      const tokenRes = await client.query(
        `INSERT INTO queue_tokens
           (branch_id, service_id, token_number, display_number,
            is_priority, is_appointment, channel,
            client_name, client_phone, appointment_id)
         VALUES ($1,$2,$3,$3,false,true,'kiosk',$4,$5,$6)
         RETURNING *`,
        [branchId, service_id, tokenNumber, client_name, client_phone, appointment_id]
      );
      const queueToken = tokenRes.rows[0];

      // 9. token_event
      await client.query(
        `INSERT INTO token_events (token_id, event_type, agent_id, metadata)
         VALUES ($1,'appointment_confirmed',NULL,$2)`,
        [queueToken.id,
         JSON.stringify({ appointment_id, method: 'qr', via: 'kiosk' })]
      );

      // 10. appointment -> attended
      await client.query(
        `UPDATE appointments SET status = 'attended' WHERE id = $1`, [appointment_id]
      );

      // 11. Posicion + espera estimada
      const waitRes = await client.query(
        `SELECT COUNT(*)::int AS n FROM queue_tokens
          WHERE branch_id = $1 AND service_id = $2
            AND date_key = CURRENT_DATE AND status = 'waiting'`,
        [branchId, service_id]
      );
      const queuePosition        = waitRes.rows[0].n;
      const estimatedWaitMinutes = Math.max(0, (queuePosition - 1) * (svc.avg_attention_min || 0));

      return { appointment_id, branchId, queueToken, tokenNumber,
               client_name, queuePosition, estimatedWaitMinutes,
               service_name: svc.name, service_color: svc.color || '#7c3aed' };
    });

    io.to(`branch_${outcome.branchId}`).emit('appointment.confirmed', {
      id: outcome.appointment_id, branch_id: outcome.branchId,
      token_id: outcome.queueToken.id, token_number: outcome.tokenNumber,
      method: 'qr', via: 'kiosk',
    });
    io.to(`branch_${outcome.branchId}`).emit('new_token', {
      token:          outcome.queueToken,
      is_appointment: true,
      waiting_count:  outcome.queuePosition,
      estimated_wait: outcome.estimatedWaitMinutes,
    });

    console.log(`[kiosk.qr] confirmed id=${outcome.appointment_id} token=${outcome.tokenNumber}`);
    return res.json({
      confirmed:              true,
      token_number:           outcome.tokenNumber,
      client_name:            outcome.client_name,
      service_name:           outcome.service_name,
      service_color:          outcome.service_color,
      estimated_wait_minutes: outcome.estimatedWaitMinutes,
      queue_position:         outcome.queuePosition,
    });

  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
    console.error('POST /api/queue/kiosk/confirm-by-qr:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1 §2.8 — CRUD de time_blocks (POST / GET / DELETE)
// ─────────────────────────────────────────────────────────────
// Decisión sesión 60 (B+5.1, firmada):
//   El EXCLUDE constraint en la BD cubre 3/4 casos de overlap
//   (mismo scope). El cuarto caso — service_id NULL vs NOT NULL
//   sobre la misma branch — se valida en app porque NULL no es
//   igual a NULL en EXCLUDE WITH =.
//
// Errores específicos:
//   409 BLOCKED_SAME_SCOPE     — INSERT 23P01 (excluded by EXCLUDE)
//   409 BLOCKED_CROSS_SCOPE    — pre-check cross-NULL falla
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/time-blocks', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const parsed = queueTimeBlocks.validateTimeBlockInput(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { branch_id, service_id, starts_at, ends_at, reason, recurrence } = parsed.value;

  try {
    const out = await withTransaction(pool, async (client) => {
      // Branch del tenant (FOR UPDATE para serializar bloqueos paralelos).
      const br = await client.query(
        `SELECT id FROM branches WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [branch_id, userId]
      );
      if (br.rowCount === 0) {
        const e = new Error('Branch no encontrada'); e.httpStatus = 404; throw e;
      }
      // Verificar service del tenant si se especificó.
      if (service_id) {
        const sv = await client.query(
          `SELECT s.id FROM services s
             JOIN branches b ON b.id = s.branch_id
            WHERE s.id = $1 AND b.user_id = $2`,
          [service_id, userId]
        );
        if (sv.rowCount === 0) {
          const e = new Error('Service no encontrado'); e.httpStatus = 404; throw e;
        }
      }
      // Cross-NULL pre-check (caso que EXCLUDE no cubre):
      //   - Si insertando service_id NULL → conflicta con cualquier bloque
      //     específico que cruce el rango.
      //   - Si insertando service_id NOT NULL → conflicta con cualquier
      //     bloque "todos los servicios" (service_id NULL) que cruce.
      const cross = await client.query(
        `SELECT 1
           FROM time_blocks
          WHERE branch_id = $1
            AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
            AND (
              ($4::uuid IS NULL     AND service_id IS NOT NULL) OR
              ($4::uuid IS NOT NULL AND service_id IS NULL)
            )
          LIMIT 1`,
        [branch_id, starts_at, ends_at, service_id]
      );
      if (cross.rowCount > 0) {
        const e = new Error('BLOCKED_CROSS_SCOPE');
        e.httpStatus = 409;
        e.code = 'BLOCKED_CROSS_SCOPE';
        throw e;
      }
      // INSERT — el EXCLUDE constraint detecta same-scope overlap.
      const ins = await client.query(
        `INSERT INTO time_blocks
           (user_id, branch_id, service_id, starts_at, ends_at, reason, recurrence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $1)
         RETURNING *`,
        [userId, branch_id, service_id, starts_at, ends_at, reason, recurrence]
      );
      return ins.rows[0];
    });

    io.to(`user_${userId}`).emit('time_block.created', {
      id: out.id, branch_id: out.branch_id, service_id: out.service_id,
      starts_at: out.starts_at, ends_at: out.ends_at, recurrence: out.recurrence,
    });
    io.to(`branch_${out.branch_id}`).emit('time_block.created', {
      id: out.id, branch_id: out.branch_id, service_id: out.service_id,
      starts_at: out.starts_at, ends_at: out.ends_at, recurrence: out.recurrence,
    });
    console.log(`⛔ time_block.created id=${out.id} branch=${out.branch_id}`);
    return res.status(201).json(out);
  } catch (err) {
    if (err && err.code === 'BLOCKED_CROSS_SCOPE') {
      return res.status(409).json({ error: 'BLOCKED_CROSS_SCOPE',
        message: 'Otro bloque "todos los servicios" o específico cruza el rango.' });
    }
    if (err && err.code === '23P01') { // EXCLUDE violation
      return res.status(409).json({ error: 'BLOCKED_SAME_SCOPE',
        message: 'Ya existe un bloque solapado en el mismo branch+servicio.' });
    }
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('❌ POST /api/queue/time-blocks:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/queue/time-blocks', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const { branch_id, from, to, service_id } = req.query || {};

  if (!branch_id || !UUID_RE.test(branch_id)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  if (service_id && !UUID_RE.test(service_id)) {
    return res.status(400).json({ error: 'service_id inválido' });
  }
  const fromDate = from ? new Date(from) : null;
  const toDate   = to   ? new Date(to)   : null;
  if (from && !Number.isFinite(fromDate?.getTime())) {
    return res.status(400).json({ error: 'from no es ISO-8601 válido' });
  }
  if (to && !Number.isFinite(toDate?.getTime())) {
    return res.status(400).json({ error: 'to no es ISO-8601 válido' });
  }
  if (fromDate && toDate && toDate <= fromDate) {
    return res.status(400).json({ error: 'to debe ser posterior a from' });
  }

  try {
    // Verificar tenancy: branch debe ser del user.
    const br = await pool.query(
      `SELECT 1 FROM branches WHERE id = $1 AND user_id = $2`,
      [branch_id, userId]
    );
    if (br.rowCount === 0) {
      return res.status(404).json({ error: 'Branch no encontrada' });
    }
    const params = [branch_id, userId];
    let sql = `SELECT * FROM time_blocks
                WHERE branch_id = $1 AND user_id = $2`;
    if (service_id) { params.push(service_id); sql += ` AND service_id = $${params.length}`; }
    if (fromDate)   { params.push(fromDate.toISOString()); sql += ` AND ends_at   >  $${params.length}`; }
    if (toDate)     { params.push(toDate.toISOString());   sql += ` AND starts_at <  $${params.length}`; }
    sql += ` ORDER BY starts_at ASC LIMIT 500`;
    const r = await pool.query(sql, params);
    return res.json({ items: r.rows, count: r.rowCount });
  } catch (err) {
    console.error('❌ GET /api/queue/time-blocks:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/queue/time-blocks/:id', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const out = await withTransaction(pool, async (client) => {
      const cur = await client.query(
        `SELECT id, branch_id FROM time_blocks
          WHERE id = $1 AND user_id = $2
          FOR UPDATE`,
        [id, userId]
      );
      if (cur.rowCount === 0) {
        const e = new Error('Time block no encontrado'); e.httpStatus = 404; throw e;
      }
      const branchId = cur.rows[0].branch_id;
      await client.query(`DELETE FROM time_blocks WHERE id = $1`, [id]);
      return { id, branchId };
    });
    io.to(`user_${userId}`).emit('time_block.deleted', { id: out.id, branch_id: out.branchId });
    io.to(`branch_${out.branchId}`).emit('time_block.deleted', { id: out.id, branch_id: out.branchId });
    console.log(`🗑️  time_block.deleted id=${out.id}`);
    return res.json({ id: out.id, deleted: true });
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    console.error('❌ DELETE /api/queue/time-blocks/:id:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// R2 — Operaciones bulk + bloqueos reactivos
// ══════════════════════════════════════════════════════════════

// Helper: encuentra el próximo slot disponible para una cita,
// buscando desde fromTs hacia adelante hasta maxDays días.
// Requiere un client de transacción (o pool) con acceso a BD.
async function findNextAvailableSlot(client, branchId, serviceId, userId, fromTs, maxDays = 14) {
  const brRes = await client.query(
    `SELECT open_time, close_time FROM branches WHERE id = $1 AND user_id = $2`,
    [branchId, userId]
  );
  if (!brRes.rowCount) return null;
  const { open_time, close_time } = brRes.rows[0];

  const svcRes = await client.query(
    `SELECT slot_duration_minutes, avg_attention_min, max_concurrent_per_slot
     FROM services WHERE id = $1 AND branch_id = $2`,
    [serviceId, branchId]
  );
  if (!svcRes.rowCount) return null;
  const svc = svcRes.rows[0];
  const stepMinutes = svc.slot_duration_minutes || svc.avg_attention_min || 30;
  const maxConcurrent = svc.max_concurrent_per_slot || 1;

  const fromDate = new Date(fromTs);
  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    const searchDate = new Date(fromDate);
    searchDate.setUTCDate(searchDate.getUTCDate() + dayOffset);
    const dayKey = searchDate.toISOString().slice(0, 10);

    const apptRes = await client.query(
      `SELECT scheduled_at FROM appointments
       WHERE user_id = $1 AND branch_id = $2 AND service_id = $3
         AND (scheduled_at AT TIME ZONE 'America/Bogota')::date = $4::date
         AND status = ANY($5)`,
      [userId, branchId, serviceId, dayKey, APPT_ACTIVE_STATUSES]
    );
    const slotCount = {};
    for (const r of apptRes.rows) {
      const k = new Date(r.scheduled_at).toISOString();
      slotCount[k] = (slotCount[k] || 0) + 1;
    }

    const blockRes = await client.query(
      `SELECT starts_at, ends_at FROM time_blocks
       WHERE branch_id = $1
         AND (service_id IS NULL OR service_id = $2)
         AND tstzrange(starts_at, ends_at, '[)')
             && tstzrange(($3::date)::timestamptz, ($3::date + INTERVAL '1 day')::timestamptz, '[)')`,
      [branchId, serviceId, dayKey]
    );

    const grid = queueSlots.buildSlotsGrid({
      date: dayKey,
      openTime: open_time,
      closeTime: close_time,
      stepMinutes,
      occupiedSet: new Set(Object.keys(slotCount).filter(k => slotCount[k] >= maxConcurrent)),
      blockedRanges: blockRes.rows,
    });

    for (const slot of grid) {
      if (!slot.available) continue;
      const slotTs = new Date(slot.time);
      if (slotTs <= new Date()) continue;
      if (dayOffset === 0 && slotTs <= fromDate) continue;
      return slot.time;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// R2 §1 — POST /api/queue/time-blocks/:id/preview
// Preview (sin mutación) de citas afectadas por un bloqueo
// y propuesta de reasignación por cada una.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/time-blocks/:id/preview', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId  = req.user.id;
  const blockId = parseInt(req.params.id, 10);
  if (!Number.isFinite(blockId)) return res.status(400).json({ error: 'id inválido' });

  try {
    const blockRes = await pool.query(
      `SELECT id, branch_id, service_id, starts_at, ends_at, reason
       FROM time_blocks WHERE id = $1 AND user_id = $2`,
      [blockId, userId]
    );
    if (!blockRes.rowCount) return res.status(404).json({ error: 'Bloqueo no encontrado' });
    const block = blockRes.rows[0];

    const apptParams = [userId, block.branch_id, block.starts_at, block.ends_at];
    let apptSQL = `
      SELECT a.id, a.scheduled_at, a.service_id, a.client_name, a.client_phone, a.status,
             s.name AS service_name
      FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id
      WHERE a.user_id = $1 AND a.branch_id = $2
        AND a.status IN ('pending','confirmed')
        AND a.scheduled_at >= $3 AND a.scheduled_at < $4`;
    if (block.service_id) {
      apptSQL += ` AND a.service_id = $5`;
      apptParams.push(block.service_id);
    }
    apptSQL += ` ORDER BY a.scheduled_at`;
    const apptRes = await pool.query(apptSQL, apptParams);

    const affected = [];
    for (const appt of apptRes.rows) {
      const tempClient = await pool.connect();
      let proposedSlot = null;
      try {
        proposedSlot = await findNextAvailableSlot(
          tempClient, block.branch_id, appt.service_id || block.service_id,
          userId, new Date(block.ends_at), 14
        );
      } finally {
        tempClient.release();
      }
      affected.push({
        appointment: {
          id: appt.id, scheduled_at: appt.scheduled_at,
          client_name: appt.client_name, client_phone: appt.client_phone,
          status: appt.status, service_name: appt.service_name,
        },
        proposed_slot: proposedSlot,
      });
    }

    const reschedulable = affected.filter(a => a.proposed_slot !== null).length;
    return res.json({
      block,
      affected,
      summary: { total: affected.length, reschedulable, pending_reschedule: affected.length - reschedulable },
    });
  } catch (err) {
    console.error('❌ POST /api/queue/time-blocks/:id/preview:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R2 §2 — POST /api/queue/time-blocks/:id/apply
// Ejecuta reasignación de citas afectadas por un bloqueo.
// withTransaction + Idempotency-Key opcional.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/time-blocks/:id/apply', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId  = req.user.id;
  const blockId = parseInt(req.params.id, 10);
  if (!Number.isFinite(blockId)) return res.status(400).json({ error: 'id inválido' });

  const idKey    = req.headers['idempotency-key'] || null;
  const endpoint = `time-blocks.apply.${blockId}`;

  try {
    if (idKey) {
      if (!/^[0-9a-f-]{36}$/i.test(idKey)) return res.status(400).json({ error: 'Idempotency-Key debe ser UUID v4' });
      const cached = await pool.query(
        `SELECT response_body, response_status FROM idempotency_keys
         WHERE key = $1 AND user_id = $2 AND endpoint = $3 AND expires_at > NOW()`,
        [idKey, userId, endpoint]
      );
      if (cached.rowCount) return res.status(cached.rows[0].response_status).json(cached.rows[0].response_body);
    }

    const result = await withTransaction(pool, async (client) => {
      const blockRes = await client.query(
        `SELECT id, branch_id, service_id, starts_at, ends_at
         FROM time_blocks WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [blockId, userId]
      );
      if (!blockRes.rowCount) {
        const e = new Error('Bloqueo no encontrado'); e.httpStatus = 404; throw e;
      }
      const block = blockRes.rows[0];

      const apptParams = [userId, block.branch_id, block.starts_at, block.ends_at];
      let apptSQL = `
        SELECT a.id, a.scheduled_at, a.service_id, a.client_email, a.client_name,
               s.name AS service_name, b.name AS branch_name
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
        LEFT JOIN branches b ON b.id = a.branch_id
        WHERE a.user_id = $1 AND a.branch_id = $2
          AND a.status IN ('pending','confirmed')
          AND a.scheduled_at >= $3 AND a.scheduled_at < $4`;
      if (block.service_id) { apptSQL += ` AND a.service_id = $5`; apptParams.push(block.service_id); }
      const apptRes = await client.query(apptSQL, apptParams);

      const movements = [];
      let rescheduled = 0; let pendingReschedule = 0;

      for (const appt of apptRes.rows) {
        const nextSlot = await findNextAvailableSlot(
          client, block.branch_id, appt.service_id, userId, new Date(block.ends_at), 14
        );
        if (nextSlot) {
          await client.query(
            `UPDATE appointments SET scheduled_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextSlot, appt.id]
          );
          await client.query(
            `INSERT INTO appointment_movements
               (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, appt.id, userId, appt.scheduled_at, nextSlot, `Bloqueo #${blockId}`]
          );
          movements.push({ appointment_id: appt.id, from: appt.scheduled_at, to: nextSlot, status: 'rescheduled', client_email: appt.client_email, client_name: appt.client_name, service_name: appt.service_name, branch_name: appt.branch_name, new_scheduled_at: nextSlot });
          rescheduled++;
        } else {
          await client.query(
            `UPDATE appointments SET status = 'pending_reschedule', updated_at = NOW() WHERE id = $1`,
            [appt.id]
          );
          await client.query(
            `INSERT INTO appointment_movements
               (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason)
             VALUES ($1, $2, $3, $4, NULL, $5)`,
            [userId, appt.id, userId, appt.scheduled_at, `Bloqueo #${blockId} — sin slot disponible`]
          );
          movements.push({ appointment_id: appt.id, from: appt.scheduled_at, to: null, status: 'pending_reschedule', client_email: appt.client_email, client_name: appt.client_name, service_name: appt.service_name, branch_name: appt.branch_name });
          pendingReschedule++;
        }
      }
      return { block_id: blockId, movements, summary: { total: apptRes.rowCount, rescheduled, pending_reschedule: pendingReschedule } };
    });

    io.to(`user_${userId}`).emit('time_block.applied', { block_id: blockId, ...result.summary });
    if (result.summary.pending_reschedule > 0) {
      io.to(`user_${userId}`).emit('appointment.pending_reschedule', { count: result.summary.pending_reschedule });
    }
    console.log(`⛔ time_block.applied id=${blockId} rescheduled=${result.summary.rescheduled} pending=${result.summary.pending_reschedule}`);

    // Enviar emails a clientes afectados (best-effort, no bloquea respuesta)
    setImmediate(async () => {
      const jobsWithEmail = result.movements.filter(m => m.client_email);
      if (!jobsWithEmail.length) return;
      const apptIds = jobsWithEmail.map(m => m.appointment_id);
      const tokRes = await pool.query(
        `SELECT DISTINCT ON (appointment_id) appointment_id, token
         FROM public_appointment_tokens WHERE appointment_id = ANY($1::uuid[]) AND expires_at > NOW()
         ORDER BY appointment_id, created_at DESC`, [apptIds]
      ).catch(() => ({ rows: [] }));
      const tokMap = new Map(tokRes.rows.map(r => [r.appointment_id, r.token]));
      const BASE = process.env.CMS_URL || 'https://cms.sonoro.com.co';
      for (const m of jobsWithEmail) {
        const tok = tokMap.get(m.appointment_id);
        const citaUrl = tok ? `${BASE}/cita/${tok}` : null;
        if (m.status === 'rescheduled' && m.new_scheduled_at) {
          emailService.sendAppointmentRescheduled(m.client_email,
            { client_name: m.client_name, scheduled_at: m.new_scheduled_at, service_name: m.service_name, branch_name: m.branch_name },
            m.from, citaUrl
          ).catch(e => console.warn('email reagendacion:', e.message));
        }
      }
    });

    if (idKey) {
      await pool.query(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, response_body, response_status, expires_at)
         VALUES ($1, $2, $3, $4, 200, NOW() + INTERVAL '24 hours') ON CONFLICT (key) DO NOTHING`,
        [idKey, userId, endpoint, result]
      );
    }
    return res.json(result);
  } catch (err) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ POST /api/queue/time-blocks/:id/apply:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R2 §3 — POST /api/queue/appointments/bulk-move
// Mueve/reasigna/cancela múltiples citas en una transacción.
// body: { appointment_ids: UUID[], action: 'move'|'reassign'|'cancel',
//         target?: { scheduled_at } }
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/appointments/bulk-move', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId = req.user.id;
  const { appointment_ids, action, target } = req.body || {};
  const idKey    = req.headers['idempotency-key'] || null;
  const endpoint = 'appointments.bulk-move';

  if (!Array.isArray(appointment_ids) || !appointment_ids.length)
    return res.status(400).json({ error: 'appointment_ids debe ser un array no vacío' });
  if (appointment_ids.length > 200)
    return res.status(400).json({ error: 'Máximo 200 citas por operación bulk' });
  if (!['move', 'reassign', 'cancel'].includes(action))
    return res.status(400).json({ error: 'action debe ser move, reassign o cancel' });
  if (action === 'move') {
    if (!target?.scheduled_at) return res.status(400).json({ error: 'target.scheduled_at requerido para action=move' });
    const d = new Date(target.scheduled_at);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'target.scheduled_at inválido' });
    if (d < new Date()) return res.status(400).json({ error: 'target.scheduled_at debe ser futuro' });
  }
  const UUID_RE_BULK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!appointment_ids.every(id => UUID_RE_BULK.test(id)))
    return res.status(400).json({ error: 'appointment_ids contiene IDs inválidos' });

  try {
    if (idKey) {
      if (!/^[0-9a-f-]{36}$/i.test(idKey)) return res.status(400).json({ error: 'Idempotency-Key debe ser UUID v4' });
      const cached = await pool.query(
        `SELECT response_body, response_status FROM idempotency_keys
         WHERE key = $1 AND user_id = $2 AND endpoint = $3 AND expires_at > NOW()`,
        [idKey, userId, endpoint]
      );
      if (cached.rowCount) return res.status(cached.rows[0].response_status).json(cached.rows[0].response_body);
    }

    const batchId = uuidv4();

    const result = await withTransaction(pool, async (client) => {
      const apptRes = await client.query(
        `SELECT a.id, a.user_id, a.branch_id, a.service_id, a.scheduled_at, a.status,
                a.client_email, a.client_name,
                s.name AS service_name, b.name AS branch_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN branches b ON b.id = a.branch_id
         WHERE a.id = ANY($1::uuid[]) AND a.user_id = $2
           AND a.status IN ('pending','confirmed','pending_reschedule')
         FOR UPDATE OF a`,
        [appointment_ids, userId]
      );
      if (!apptRes.rowCount) {
        const e = new Error('No se encontraron citas válidas'); e.httpStatus = 404; throw e;
      }

      const movements = [];
      let processed = 0; let skipped = 0;

      for (const appt of apptRes.rows) {
        if (action === 'cancel') {
          await client.query(
            `UPDATE appointments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
            [appt.id]
          );
          await client.query(
            `INSERT INTO appointment_movements
               (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason, bulk_batch_id)
             VALUES ($1, $2, $3, $4, NULL, 'Cancelación bulk', $5)`,
            [userId, appt.id, userId, appt.scheduled_at, batchId]
          );
          movements.push({ appointment_id: appt.id, action: 'cancelled', client_email: appt.client_email, client_name: appt.client_name, service_name: appt.service_name, branch_name: appt.branch_name, prev_scheduled_at: appt.scheduled_at });
          processed++;
        } else if (action === 'move') {
          await client.query(
            `UPDATE appointments SET scheduled_at = $1, updated_at = NOW() WHERE id = $2`,
            [target.scheduled_at, appt.id]
          );
          await client.query(
            `INSERT INTO appointment_movements
               (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason, bulk_batch_id)
             VALUES ($1, $2, $3, $4, $5, 'Movimiento bulk', $6)`,
            [userId, appt.id, userId, appt.scheduled_at, target.scheduled_at, batchId]
          );
          movements.push({ appointment_id: appt.id, action: 'moved', to: target.scheduled_at, client_email: appt.client_email, client_name: appt.client_name, service_name: appt.service_name, branch_name: appt.branch_name, prev_scheduled_at: appt.scheduled_at });
          processed++;
        } else {
          const nextSlot = await findNextAvailableSlot(
            client, appt.branch_id, appt.service_id, userId, new Date(), 14
          );
          if (nextSlot) {
            await client.query(
              `UPDATE appointments SET scheduled_at = $1, status = 'confirmed', updated_at = NOW() WHERE id = $2`,
              [nextSlot, appt.id]
            );
            await client.query(
              `INSERT INTO appointment_movements
                 (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason, bulk_batch_id)
               VALUES ($1, $2, $3, $4, $5, 'Reasignación bulk', $6)`,
              [userId, appt.id, userId, appt.scheduled_at, nextSlot, batchId]
            );
            movements.push({ appointment_id: appt.id, action: 'reassigned', to: nextSlot, client_email: appt.client_email, client_name: appt.client_name, service_name: appt.service_name, branch_name: appt.branch_name, prev_scheduled_at: appt.scheduled_at });
            processed++;
          } else {
            await client.query(
              `UPDATE appointments SET status = 'pending_reschedule', updated_at = NOW() WHERE id = $1`,
              [appt.id]
            );
            await client.query(
              `INSERT INTO appointment_movements
                 (user_id, appointment_id, moved_by, prev_scheduled_at, new_scheduled_at, reason, bulk_batch_id)
               VALUES ($1, $2, $3, $4, NULL, 'Reasignación bulk — sin slot', $5)`,
              [userId, appt.id, userId, appt.scheduled_at, batchId]
            );
            movements.push({ appointment_id: appt.id, action: 'pending_reschedule' });
            skipped++;
          }
        }
      }
      return { batch_id: batchId, movements, summary: { processed, skipped, total: apptRes.rowCount } };
    });

    io.to(`user_${userId}`).emit('bulk_move.executed', { batch_id: result.batch_id, action, ...result.summary });
    if (result.summary.skipped > 0) {
      io.to(`user_${userId}`).emit('appointment.pending_reschedule', { count: result.summary.skipped });
    }
    console.log(`📦 bulk_move.executed batch=${result.batch_id} action=${action} processed=${result.summary.processed} skipped=${result.summary.skipped}`);

    // Enviar emails a clientes afectados (best-effort)
    setImmediate(async () => {
      const jobsWithEmail = result.movements.filter(m => m.client_email);
      if (!jobsWithEmail.length) return;
      const apptIds = jobsWithEmail.filter(m => m.action !== 'cancelled').map(m => m.appointment_id);
      const tokMap = new Map();
      if (apptIds.length) {
        const tokRes = await pool.query(
          `SELECT DISTINCT ON (appointment_id) appointment_id, token
           FROM public_appointment_tokens WHERE appointment_id = ANY($1::uuid[]) AND expires_at > NOW()
           ORDER BY appointment_id, created_at DESC`, [apptIds]
        ).catch(() => ({ rows: [] }));
        tokRes.rows.forEach(r => tokMap.set(r.appointment_id, r.token));
      }
      const BASE = process.env.CMS_URL || 'https://cms.sonoro.com.co';
      for (const m of jobsWithEmail) {
        try {
          const tok = tokMap.get(m.appointment_id);
          const citaUrl = tok ? `${BASE}/cita/${tok}` : null;
          if ((m.action === 'moved' || m.action === 'reassigned') && m.to) {
            await emailService.sendAppointmentRescheduled(m.client_email,
              { client_name: m.client_name, scheduled_at: m.to, service_name: m.service_name, branch_name: m.branch_name },
              m.prev_scheduled_at, citaUrl
            );
          } else if (m.action === 'cancelled') {
            await emailService.sendAppointmentCancelled(m.client_email,
              { client_name: m.client_name, scheduled_at: m.prev_scheduled_at, service_name: m.service_name, branch_name: m.branch_name }
            );
          }
        } catch (e) { console.warn('email bulk:', e.message); }
      }
    });

    if (idKey) {
      await pool.query(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, response_body, response_status, expires_at)
         VALUES ($1, $2, $3, $4, 200, NOW() + INTERVAL '24 hours') ON CONFLICT (key) DO NOTHING`,
        [idKey, userId, endpoint, result]
      );
    }
    return res.json(result);
  } catch (err) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ POST /api/queue/appointments/bulk-move:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// R1.5 §A — Agenda del agente (citas del día para su servicio)
// Auth: authenticateAgentOrUser (JWT del agente).
// req.user: { id, agent_id, branch_id, role, name }
// Feature flag: verificado inline via SQL sobre users.features.
// ══════════════════════════════════════════════════════════════
app.get('/api/queue/agent/appointments/today', authenticateAgentOrUser, async (req, res) => {
  const userId   = req.user.id;
  const branchId = req.user.branch_id;
  if (!branchId) {
    return res.status(400).json({ error: 'branch_id requerido en el token del agente' });
  }

  const serviceId = req.query.service_id || null;

  const rawDate   = req.query.date;
  const dateRE    = /^\d{4}-\d{2}-\d{2}$/;
  const queryDate = rawDate && dateRE.test(rawDate) ? rawDate : null;

  try {
    // Resolver owner de la sucursal: el flag vive en su cuenta, no en la del agente
    const branchRow = await pool.query(
      `SELECT b.user_id AS owner_id, u.features->>'queue_v2_appointments' AS enabled
       FROM branches b
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1`,
      [branchId]
    );
    if (!branchRow.rowCount || branchRow.rows[0].enabled !== 'true') {
      return res.status(404).json({ error: 'FEATURE_DISABLED' });
    }
    const ownerUserId = branchRow.rows[0].owner_id;

    const params = [branchId, ownerUserId];
    let dateFilter;
    if (queryDate) {
      params.push(queryDate);
      dateFilter = `(a.scheduled_at AT TIME ZONE 'America/Bogota')::date = $${params.length}::date`;
    } else {
      dateFilter = `(a.scheduled_at AT TIME ZONE 'America/Bogota')::date = (NOW() AT TIME ZONE 'America/Bogota')::date`;
    }

    let serviceFilter = '';
    if (serviceId) {
      params.push(serviceId);
      serviceFilter = `AND a.service_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT
         a.id,
         a.scheduled_at,
         a.client_name,
         a.status,
         s.name   AS service_name,
         s.color  AS service_color,
         CASE WHEN a.client_name IS NOT NULL THEN 'public' ELSE 'walk_in' END AS origin
       FROM appointments a
       JOIN services  s ON s.id = a.service_id
       JOIN branches  b ON b.id = a.branch_id
       WHERE a.branch_id = $1
         AND b.user_id   = $2
         AND ${dateFilter}
         AND a.status NOT IN ('cancelled')
         ${serviceFilter}
       ORDER BY a.scheduled_at ASC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('❌ GET /api/queue/agent/appointments/today:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// R1.5 §B — Walk-ins del día para el tab Citas del admin
// Auth: authenticateToken + requireFeatureFlag('queue_v2_appointments')
// Solo retorna tokens donde appointment_id IS NULL (puro kiosko).
// ══════════════════════════════════════════════════════════════
app.get('/api/queue/branches/:branchId/walkins', authenticateToken, requireFeatureFlag('queue_v2_appointments'), async (req, res) => {
  const userId   = req.user.id;
  const branchId = req.params.branchId;

  const rawDate   = req.query.date;
  const dateRE    = /^\d{4}-\d{2}-\d{2}$/;
  const queryDate = rawDate && dateRE.test(rawDate) ? rawDate : null;

  try {
    const params = [branchId, userId];
    let dateFilter;
    if (queryDate) {
      params.push(queryDate);
      dateFilter = `(t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = $${params.length}::date`;
    } else {
      dateFilter = `(t.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')::date = (NOW() AT TIME ZONE 'America/Bogota')::date`;
    }

    const result = await pool.query(
      `SELECT
         t.id,
         t.token_number,
         t.status,
         t.created_at,
         s.name   AS service_name,
         s.color  AS service_color,
         s.prefix AS service_prefix
       FROM queue_tokens t
       JOIN branches b ON b.id = t.branch_id
       JOIN services s ON s.id = t.service_id
       WHERE t.branch_id      = $1
         AND b.user_id        = $2
         AND t.appointment_id IS NULL
         AND ${dateFilter}
       ORDER BY t.created_at ASC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    console.error('❌ GET /api/queue/branches/:branchId/walkins:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});



// ─────────────────────────────────────────────────────────────
// Helper R1.5: convierte "HH:MM" local (tzName) → "HH:MM" UTC.
// Necesario porque buildSlotsGrid espera horas en UTC pero
// open_time/close_time de branches están en hora local del tenant.
// ─────────────────────────────────────────────────────────────
function localHHMMtoUTCHHMM(timeStr, dateStr, tzName) {
  if (!timeStr || !dateStr) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const guess = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000Z`);
  const parts = {};
  new Intl.DateTimeFormat('en', {
    timeZone: tzName, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(guess).forEach(({ type, value }) => { parts[type] = value; });
  const diffMin = (h * 60 + m) - (parseInt(parts.hour) * 60 + parseInt(parts.minute));
  const adj = new Date(guess.getTime() + diffMin * 60 * 1000);
  return `${String(adj.getUTCHours()).padStart(2,'0')}:${String(adj.getUTCMinutes()).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════
// R1.5 — Reservas públicas /api/queue/public/:slug
// Sin autenticación JWT. Anti-bot: honeypot + timing + habeas data.
// public_booking_mode: 'auto' → confirmed, 'manual' → pending.
// Multi-tenancy: user_id siempre derivado del slug, nunca del body.
// ══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// R1.5 §1 — GET /agendar/:slug  →  booking.html
// ─────────────────────────────────────────────────────────────
// ── Events v1 — Routers (E0) ────────────────────────────────────────────
app.use('/api/events/public', eventsProductionPublicRouter);
app.use('/api/events/public', eventsPublicRouter);
app.use('/api/events/staff',  eventsStaffRouter);
app.use('/api/events',        eventsRouter);

// ── Events v1 — Rutas HTML ───────────────────────────────────────────────
app.get('/evento/invitacion/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento.html'));
});
app.get('/evento/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento.html'));
});
app.get('/evento/:slug/mi-registro/:qr', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento.html'));
});
app.get('/evento/:slug/staff', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento-staff.html'));
});
app.get('/evento/:slug/produccion', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento-produccion.html'));
});
app.get('/evento/:slug/orador/:session_id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento-teleprompter.html'));
});
app.get('/evento/:slug/kiosko', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'evento-kiosko.html'));
});
app.get('/cotizacion/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'cotizacion.html'));
});
app.get('/proveedor-registro/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'proveedor-registro.html'));
});

app.get('/agendar/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'booking.html'));
});

app.get('/politica-datos/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'politica-datos.html'));
});

app.get('/terminos/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'terminos.html'));
});

// ─────────────────────────────────────────────────────────────
// R1.5 §2 — GET /api/queue/public/:slug
// Devuelve tenant + sucursales activas + servicios. Sin auth.
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/public/:slug', publicLimiter, async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
    return res.status(400).json({ error: 'slug inválido' });
  }
  try {
    const userRes = await pool.query(
      `SELECT id, name FROM users WHERE public_slug = $1`,
      [slug]
    );
    if (!userRes.rowCount) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    const user = userRes.rows[0];

    const branchRes = await pool.query(
      `SELECT id, name, address, public_booking_mode, open_time, close_time
         FROM branches
        WHERE user_id = $1
          AND public_booking_mode != 'disabled'
        ORDER BY name`,
      [user.id]
    );
    if (!branchRes.rowCount) {
      return res.status(404).json({ error: 'No hay sucursales disponibles para reservas' });
    }

    const branchIds = branchRes.rows.map(b => b.id);
    const svcRes = await pool.query(
      `SELECT id, branch_id, name, description, color, avg_attention_min, slot_duration_minutes
         FROM services
        WHERE branch_id = ANY($1::uuid[])
        ORDER BY branch_id, name`,
      [branchIds]
    );
    const svcsByBranch = {};
    for (const s of svcRes.rows) {
      (svcsByBranch[s.branch_id] = svcsByBranch[s.branch_id] || []).push(s);
    }

    const branches = branchRes.rows.map(b => ({
      ...b,
      services: svcsByBranch[b.id] || [],
    }));

    return res.json({ tenant: { name: user.name }, branches });
  } catch (err) {
    console.error('❌ GET /api/queue/public/:slug:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §3 — GET /api/queue/public/:slug/slots
// ?branch_id=UUID&service_id=UUID&date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/public/:slug/slots', publicLimiter, async (req, res) => {
  const { slug } = req.params;
  const { branch_id, service_id, date } = req.query;

  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
    return res.status(400).json({ error: 'slug inválido' });
  }
  if (!branch_id || !UUID_RE.test(branch_id)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  if (!service_id || !UUID_RE.test(service_id)) {
    return res.status(400).json({ error: 'service_id inválido' });
  }
  const dayKey = (date && /^\d{4}-\d{2}-\d{2}$/.test(date))
    ? date
    : new Date().toISOString().slice(0, 10);

  try {
    const branchRes = await pool.query(
      `SELECT b.id, b.open_time, b.close_time, b.public_booking_mode,
              COALESCE(b.timezone, 'America/Bogota') AS timezone
         FROM branches b
         JOIN users u ON u.id = b.user_id
        WHERE u.public_slug = $1
          AND b.id = $2
          AND b.public_booking_mode != 'disabled'`,
      [slug, branch_id]
    );
    if (!branchRes.rowCount) {
      return res.status(404).json({ error: 'Sucursal no disponible' });
    }
    const branch = branchRes.rows[0];
    const tz = branch.timezone;

    const svcRes = await pool.query(
      `SELECT id, slot_duration_minutes, avg_attention_min
         FROM services
        WHERE id = $1 AND branch_id = $2`,
      [service_id, branch_id]
    );
    if (!svcRes.rowCount) {
      return res.status(404).json({ error: 'Servicio no encontrado' });
    }
    const svc = svcRes.rows[0];
    const stepMinutes = svc.slot_duration_minutes || svc.avg_attention_min || 30;

    const apptRes = await pool.query(
      `SELECT scheduled_at FROM appointments
        WHERE branch_id = $1
          AND service_id = $2
          AND (scheduled_at AT TIME ZONE 'America/Bogota')::date = $3::date
          AND status = ANY($4)`,
      [branch_id, service_id, dayKey, APPT_ACTIVE_STATUSES]
    );
    const occupied = new Set(
      apptRes.rows.map(r => new Date(r.scheduled_at).toISOString())
    );

    const blockRes = await pool.query(
      `SELECT starts_at, ends_at FROM time_blocks
        WHERE branch_id = $1
          AND (service_id IS NULL OR service_id = $2)
          AND tstzrange(starts_at, ends_at, '[)')
              && tstzrange(($3::date)::timestamptz,
                           ($3::date + INTERVAL '1 day')::timestamptz, '[)')`,
      [branch_id, service_id, dayKey]
    );

    const grid = queueSlots.buildSlotsGrid({
      date:          dayKey,
      openTime:      localHHMMtoUTCHHMM(branch.open_time,  dayKey, tz),
      closeTime:     localHHMMtoUTCHHMM(branch.close_time, dayKey, tz),
      stepMinutes,
      occupiedSet:   occupied,
      blockedRanges: blockRes.rows,
    });

    return res.json(grid);
  } catch (err) {
    console.error('❌ GET /api/queue/public/:slug/slots:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §4 — POST /api/queue/public/:slug/appointments
// Anti-bot: hp_field vacío + timing ≥2 s + habeas_data aceptado.
// public_booking_mode 'auto' → confirmed, 'manual' → pending.
// ─────────────────────────────────────────────────────────────
app.post('/api/queue/public/:slug/appointments', publicBookingCreateLimiter, publicBookingDayLimiter, async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
    return res.status(400).json({ error: 'slug inválido' });
  }

  const {
    branch_id, service_id,
    scheduled_at,
    client_name, client_phone, client_email, client_id_number,
    accepted_habeas_data,
    hp_field,
  } = req.body || {};

  // ── Anti-bot ──────────────────────────────────────────────
  if (hp_field !== '') {
    return res.status(400).json({ error: 'Solicitud rechazada' });
  }
  const formStartedAt = parseInt(req.headers['x-form-started-at'] || '0', 10);
  const elapsedMs = Date.now() - formStartedAt;
  if (!formStartedAt || elapsedMs < 2000) {
    return res.status(400).json({ error: 'Solicitud rechazada' });
  }
  if (accepted_habeas_data !== true) {
    return res.status(400).json({ error: 'Debe aceptar la política de tratamiento de datos' });
  }

  if (!branch_id || !UUID_RE.test(branch_id)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  if (!service_id || !UUID_RE.test(service_id)) {
    return res.status(400).json({ error: 'service_id inválido' });
  }
  const vAt = parseScheduledAt(scheduled_at);
  if (!vAt.ok) return res.status(400).json({ error: vAt.error });

  const vId = queueValidation.validateClientIdNumber(client_id_number);
  if (!vId.ok) return res.status(400).json({ error: vId.error });

  const nameClean = (client_name || '').trim();
  if (!nameClean || nameClean.length > 120) {
    return res.status(400).json({ error: 'Nombre requerido (máx 120 caracteres)' });
  }
  const phoneClean = (client_phone || '').trim() || null;
  const emailClean = (client_email || '').trim().toLowerCase() || null;

  try {
    const outcome = await withTransaction(pool, async (client) => {
      const userRes = await client.query(
        `SELECT id FROM users WHERE public_slug = $1`,
        [slug]
      );
      if (!userRes.rowCount) {
        const e = new Error('Tenant no encontrado'); e.httpStatus = 404; throw e;
      }
      const userId = userRes.rows[0].id;

      const branchRes = await client.query(
        `SELECT id, public_booking_mode
           FROM branches
          WHERE id = $1 AND user_id = $2
            AND public_booking_mode != 'disabled'
          FOR UPDATE`,
        [branch_id, userId]
      );
      if (!branchRes.rowCount) {
        const e = new Error('Sucursal no disponible'); e.httpStatus = 404; throw e;
      }
      const branch = branchRes.rows[0];

      const svcRes = await client.query(
        `SELECT id FROM services WHERE id = $1 AND branch_id = $2`,
        [service_id, branch_id]
      );
      if (!svcRes.rowCount) {
        const e = new Error('Servicio no encontrado'); e.httpStatus = 404; throw e;
      }

      const blocked = await isSlotBlocked(client, branch_id, service_id, vAt.value.toISOString());
      if (blocked) {
        const e = new Error('El horario está bloqueado'); e.httpStatus = 409; throw e;
      }

      const status = branch.public_booking_mode === 'auto' ? 'confirmed' : 'pending';
      const apptRes = await client.query(
        `INSERT INTO appointments
           (user_id, branch_id, service_id,
            client_name, client_phone, client_email, client_id_number,
            scheduled_at, status, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'public')
         RETURNING id, scheduled_at, status`,
        [userId, branch_id, service_id,
         nameClean, phoneClean, emailClean, vId.value,
         vAt.value.toISOString(), status]
      );
      const appt = apptRes.rows[0];

      const tokenRes = await client.query(
        `INSERT INTO public_appointment_tokens
           (user_id, appointment_id, action_allowed, expires_at)
         VALUES ($1,$2,'both', NOW() + INTERVAL '7 days')
         RETURNING token`,
        [userId, appt.id]
      );
      const publicToken = tokenRes.rows[0].token;

      return { appt, publicToken, userId, status };
    });

    console.log(`📅 public.appointment.created id=${outcome.appt.id} slug=${slug} status=${outcome.status}`);

    // Fire-and-forget email — no falla el endpoint si el email falla
    if (emailClean) {
      const _citaUrl = `${process.env.CMS_URL || 'https://cms.sonoro.com.co'}/cita/${outcome.publicToken}`;
      const _apptData = { client_name: nameClean, scheduled_at: outcome.appt.scheduled_at, status: outcome.appt.status };
      (async () => {
        try {
          const nr = await pool.query(
            `SELECT b.name AS branch_name, s.name AS service_name
               FROM branches b, services s
              WHERE b.id = $1 AND s.id = $2`,
            [branch_id, service_id]
          );
          const n = nr.rows[0] || {};
          await emailService.sendAppointmentConfirmation(emailClean,
            { ..._apptData, branch_name: n.branch_name || '', service_name: n.service_name || '' },
            _citaUrl
          );
        } catch(e) { console.warn('⚠️ email cita:', e.message); }
      })();
    }

    return res.status(201).json({
      id:           outcome.appt.id,
      scheduled_at: outcome.appt.scheduled_at,
      status:       outcome.appt.status,
      public_token: outcome.publicToken,
      message:      outcome.status === 'confirmed'
        ? 'Cita confirmada.'
        : 'Cita solicitada. Está pendiente de confirmación.',
    });
  } catch (err) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Horario no disponible. Selecciona otro.' });
    }
    console.error('❌ POST /api/queue/public/:slug/appointments:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §5 — GET /api/queue/tenant/profile
// Devuelve public_slug del tenant autenticado.
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/tenant/profile', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT public_slug FROM users WHERE id = $1`,
      [req.user.id]
    );
    const row = r.rows[0] || {};
    return res.json({ public_slug: row.public_slug || null });
  } catch (err) {
    console.error('❌ GET /api/queue/tenant/profile:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §6 — PATCH /api/queue/tenant/public-slug
// Body: { public_slug: string }
// ─────────────────────────────────────────────────────────────
app.patch('/api/queue/tenant/public-slug', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const slug = (req.body?.public_slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) {
    return res.status(400).json({ error: 'Slug inválido (solo minúsculas, números y guiones, 2–60 caracteres)' });
  }
  try {
    await pool.query(
      `UPDATE users SET public_slug = $1 WHERE id = $2`,
      [slug, userId]
    );
    console.log(`🔗 tenant.public_slug.updated user=${userId} slug=${slug}`);
    return res.json({ public_slug: slug });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ese slug ya está en uso. Elige otro.' });
    }
    console.error('❌ PATCH /api/queue/tenant/public-slug:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §7 — PATCH /api/queue/branches/:id/public-booking-mode
// Body: { public_booking_mode: 'auto'|'manual'|'disabled' }
// ─────────────────────────────────────────────────────────────
app.patch('/api/queue/branches/:id/public-booking-mode', authenticateToken, async (req, res) => {
  const userId   = req.user.id;
  const branchId = req.params.id;
  if (!UUID_RE.test(branchId)) {
    return res.status(400).json({ error: 'branch_id inválido' });
  }
  const mode = req.body?.public_booking_mode;
  if (!['auto', 'manual', 'disabled'].includes(mode)) {
    return res.status(400).json({ error: 'public_booking_mode debe ser auto, manual o disabled' });
  }
  try {
    const r = await pool.query(
      `UPDATE branches SET public_booking_mode = $1
        WHERE id = $2 AND user_id = $3
        RETURNING id`,
      [mode, branchId, userId]
    );
    if (!r.rowCount) {
      return res.status(404).json({ error: 'Sucursal no encontrada' });
    }
    console.log(`🔗 branch.public_booking_mode.updated branch=${branchId} mode=${mode}`);
    return res.json({ id: branchId, public_booking_mode: mode });
  } catch (err) {
    console.error('❌ PATCH /api/queue/branches/:id/public-booking-mode:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §8 — GET /cita/:token  →  cita.html (gestión pública)
// ─────────────────────────────────────────────────────────────
app.get('/cita/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cita.html'));
});

// ─────────────────────────────────────────────────────────────
// R1.5 §9 — GET /api/queue/cita/:token
// Devuelve detalles de la cita para la página pública.
// ─────────────────────────────────────────────────────────────
app.get('/api/queue/cita/:token', publicLimiter, async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) return res.status(400).json({ error: 'token inválido' });
  try {
    const r = await pool.query(
      `SELECT t.action_allowed, t.expires_at, t.used_at,
              a.id AS appointment_id, a.scheduled_at, a.status, a.client_name,
              a.branch_id, a.service_id,
              b.name AS branch_name,
              s.name AS service_name,
              u.public_slug
         FROM public_appointment_tokens t
         JOIN appointments a ON a.id = t.appointment_id
         JOIN branches     b ON b.id = a.branch_id
         JOIN services     s ON s.id = a.service_id
         JOIN users        u ON u.id = a.user_id
        WHERE t.token = $1`,
      [token]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Cita no encontrada' });
    const row = r.rows[0];
    if (row.used_at)                          return res.status(410).json({ error: 'Este enlace ya fue utilizado' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Este enlace ha expirado' });
    return res.json({
      appointment_id: row.appointment_id,
      scheduled_at:   row.scheduled_at,
      status:         row.status,
      client_name:    row.client_name,
      branch_id:      row.branch_id,
      service_id:     row.service_id,
      branch_name:    row.branch_name,
      service_name:   row.service_name,
      public_slug:    row.public_slug,
      action_allowed: row.action_allowed,
      expires_at:     row.expires_at,
    });
  } catch (err) {
    console.error('❌ GET /api/queue/cita/:token:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §10 — DELETE /api/queue/cita/:token
// Cancela la cita y marca el token como usado.
// ─────────────────────────────────────────────────────────────
app.delete('/api/queue/cita/:token', publicTokenActionLimiter, async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) return res.status(400).json({ error: 'token inválido' });
  try {
    await withTransaction(pool, async (client) => {
      const tRes = await client.query(
        `SELECT t.appointment_id, t.action_allowed, t.expires_at, t.used_at,
                a.status
           FROM public_appointment_tokens t
           JOIN appointments a ON a.id = t.appointment_id
          WHERE t.token = $1 FOR UPDATE`,
        [token]
      );
      if (!tRes.rowCount) { const e = new Error('Cita no encontrada'); e.httpStatus = 404; throw e; }
      const row = tRes.rows[0];
      if (row.used_at)                          { const e = new Error('Este enlace ya fue utilizado'); e.httpStatus = 410; throw e; }
      if (new Date(row.expires_at) < new Date()) { const e = new Error('Este enlace ha expirado');     e.httpStatus = 410; throw e; }
      if (!['both', 'cancel'].includes(row.action_allowed)) {
        const e = new Error('Cancelación no permitida para este enlace'); e.httpStatus = 403; throw e;
      }
      if (['cancelled', 'no_show'].includes(row.status)) {
        const e = new Error('La cita ya fue cancelada'); e.httpStatus = 409; throw e;
      }
      await client.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [row.appointment_id]);
      await client.query(`UPDATE public_appointment_tokens SET used_at = NOW() WHERE token = $1`, [token]);
    });
    console.log(`📅 public.appointment.cancelled token=${token}`);
    return res.json({ message: 'Tu cita ha sido cancelada.' });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    console.error('❌ DELETE /api/queue/cita/:token:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────────────────────
// R1.5 §11 — PATCH /api/queue/cita/:token
// Reprograma la cita. El token NO se consume (permite re-agendar).
// Body: { scheduled_at: ISO8601 }
// ─────────────────────────────────────────────────────────────
app.patch('/api/queue/cita/:token', publicTokenActionLimiter, async (req, res) => {
  const { token } = req.params;
  if (!UUID_RE.test(token)) return res.status(400).json({ error: 'token inválido' });
  const vAt = parseScheduledAt(req.body?.scheduled_at);
  if (!vAt.ok) return res.status(400).json({ error: vAt.error });
  try {
    const outcome = await withTransaction(pool, async (client) => {
      const tRes = await client.query(
        `SELECT t.appointment_id, t.action_allowed, t.expires_at, t.used_at,
                a.status, a.branch_id, a.service_id
           FROM public_appointment_tokens t
           JOIN appointments a ON a.id = t.appointment_id
          WHERE t.token = $1 FOR UPDATE`,
        [token]
      );
      if (!tRes.rowCount) { const e = new Error('Cita no encontrada'); e.httpStatus = 404; throw e; }
      const row = tRes.rows[0];
      if (row.used_at)                          { const e = new Error('Este enlace ya fue utilizado'); e.httpStatus = 410; throw e; }
      if (new Date(row.expires_at) < new Date()) { const e = new Error('Este enlace ha expirado');     e.httpStatus = 410; throw e; }
      if (!['both', 'reschedule'].includes(row.action_allowed)) {
        const e = new Error('Modificación no permitida para este enlace'); e.httpStatus = 403; throw e;
      }
      if (['cancelled', 'no_show'].includes(row.status)) {
        const e = new Error('No se puede modificar una cita cancelada'); e.httpStatus = 409; throw e;
      }
      const blocked = await isSlotBlocked(client, row.branch_id, row.service_id, vAt.value.toISOString());
      if (blocked) { const e = new Error('El horario está bloqueado'); e.httpStatus = 409; throw e; }
      const apptRes = await client.query(
        `UPDATE appointments SET scheduled_at = $1 WHERE id = $2 RETURNING scheduled_at`,
        [vAt.value.toISOString(), row.appointment_id]
      );
      return { scheduled_at: apptRes.rows[0].scheduled_at };
    });
    console.log(`📅 public.appointment.rescheduled token=${token}`);
    return res.json({ scheduled_at: outcome.scheduled_at, message: 'Tu cita ha sido reprogramada.' });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Horario no disponible. Selecciona otro.' });
    console.error('❌ PATCH /api/queue/cita/:token:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ══════════════════════════════════════════════════════════════
// SOCKET.IO — Auth middleware + eventos en tiempo real
// ══════════════════════════════════════════════════════════════

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

io.on('connection', (socket) => {
  console.log(`🟢 Cliente conectado: ${socket.id} (${socket.role})`);

  function requireUser(handler) {
    return (...args) => {
      if (socket.role !== 'user') return socket.emit('auth_error', { error: 'No autorizado' });
      handler(...args);
    };
  }

  // ── Eventos de dispositivos ──────────────────────────────

  socket.on('device_register', ({ device_id }) => {
    if (socket.role !== 'device' || socket.deviceId !== device_id) return;
    socket.join(`device_${device_id}`);
    console.log(`📱 ${device_id} unido a sala device_${device_id} (socket: ${socket.id})`);
  });

  socket.on('screenshot_result', ({ device_id, success, image, error }) => {
    if (socket.role !== 'device') return;
    const cb = screenshotCallbacks.get(device_id);
    if (!cb) { console.warn(`📸 Sin callback para ${device_id}`); return; }
    clearTimeout(cb.timeout);
    screenshotCallbacks.delete(device_id);
    if (!success || !image) { cb.reject(new Error(error || 'Screenshot fallido')); return; }
    try {
      const screenshotsDir = path.join(process.cwd(), 'uploads', 'screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const filename = `screenshot-${device_id}-${Date.now()}.png`;
      fs.writeFileSync(path.join(screenshotsDir, filename), Buffer.from(image, 'base64'));
      const url = `/uploads/screenshots/${filename}`;
      console.log(`📸 Screenshot guardado: ${url}`);
      cb.resolve(url);
    } catch(e) { cb.reject(e); }
  });

  socket.on('device_heartbeat', async ({ device_id, status, temp }) => {
    if (socket.role !== 'device') return;
    try {
      socket.join(`device_${device_id}`);
      if (temp !== undefined && temp !== null) {
        await pool.query(`UPDATE devices SET status = $1, last_seen = NOW(), cpu_temp = $3 WHERE device_id = $2`, [status || 'online', device_id, temp]);
      } else {
        await pool.query(`UPDATE devices SET status = $1, last_seen = NOW() WHERE device_id = $2`, [status || 'online', device_id]);
      }
    } catch(e) { console.warn('heartbeat error:', e.message); }
  });

  socket.on('device_sysinfo', async (info) => {
    if (socket.role !== 'device') return;
    if (!info?.device_id || info.temp_celsius == null) return;
    try {
      await pool.query('UPDATE devices SET cpu_temp = $1, last_seen = NOW() WHERE device_id = $2', [info.temp_celsius, info.device_id]);
    } catch(e) { console.warn('sysinfo persist error:', e.message); }
  });

  // device-unhealthy — el watchdog del player Windows lo emite tras 5 reloads
  // consecutivos sin recuperar el renderer. Persistimos el flag; el operador
  // ve el indicador en el dashboard y decide si reinstalar o intervenir.
  socket.on('device-unhealthy', async ({ device_id, total_reloads, timestamp }) => {
    if (socket.role !== 'device') return;
    try {
      await pool.query(
        'UPDATE devices SET unhealthy_at = NOW(), unhealthy_reload_count = $2 WHERE device_id = $1',
        [device_id, total_reloads || null]
      );
      console.warn(`🚨 device-unhealthy: ${device_id} con ${total_reloads} reloads consecutivos`);
    } catch (e) { console.warn('device-unhealthy error:', e.message); }
  });

  // ── Eventos de usuario autenticado ───────────────────────

  socket.on('join_user_room', requireUser(({ user_id }) => {
    if (socket.user.id !== user_id) return;
    socket.join(`user_${user_id}`);
  }));

  socket.on('refresh_features', requireUser(({ user_id, features }) => {
    console.log(`🔄 refresh_features recibido — user_id: ${user_id}`);
    io.to(`user_${user_id}`).emit('features_updated');
  }));

  socket.on('reboot_device', requireUser(async ({ device_id }) => {
    try {
      const result = await pool.query('SELECT device_id FROM devices WHERE device_id = $1', [device_id]);
      if (!result.rows.length) return socket.emit('reboot_result', { success: false, error: 'Dispositivo no encontrado' });
      console.log(`🔄 Reboot emit → ${device_id}`);
      io.to(`device_${device_id}`).emit('reboot_request', { device_id });
      socket.emit('reboot_result', { success: true });
    } catch (err) {
      socket.emit('reboot_result', { success: false, error: err.message });
    }
  }));

  socket.on('start-video-conversion', requireUser(async (data) => {
    try {
      const { contentId, originalPath, outputPath, preset = 'balanced' } = data;
      if (!contentId || !originalPath || !outputPath) {
        return socket.emit('conversion-error', {
          error: 'Faltan parámetros requeridos (contentId, originalPath, outputPath)',
          received: { contentId, originalPath, outputPath }
        });
      }
      const job = await addConversionJob({
        contentId, originalPath, outputPath, preset,
        socketId: socket.id
      });
      socket.emit('conversion-queued', {
        jobId: job.id, contentId,
        message: 'Video encolado para conversión',
        timestamp: new Date()
      });
    } catch (error) {
      console.error(`❌ Error iniciando conversión:`, error.message);
      socket.emit('conversion-error', { error: error.message, timestamp: new Date() });
    }
  }));

  socket.on('get-job-status', requireUser(async (jobId) => {
    try {
      const status = await getJobStatus(jobId);
      socket.emit('job-status', status);
    } catch (error) {
      socket.emit('status-error', { error: error.message });
    }
  }));

  socket.on('get-queue-stats', requireUser(async () => {
    try {
      const stats = await getQueueStats();
      socket.emit('queue-stats', stats);
    } catch (error) {
      socket.emit('stats-error', { error: error.message });
    }
  }));

  // ── Eventos compartidos (dispositivos + usuarios) ────────

  socket.on('token_now_playing', (data) => {
    if (data && data.branch_id) {
      io.to(`branch_${data.branch_id}`).emit('token_now_playing', data);
    }
  });

  socket.on('join_branch', (branchId) => {
    socket.join(`branch_${branchId}`);
    console.log(`📺 Socket unido a sala branch_${branchId}`);
  });

  socket.on('join_counter', (counterId) => {
    socket.join(`counter_${counterId}`);
  });

  socket.on('join_event', async ({ event_id } = {}) => {
    if (!event_id || socket.role !== 'user') {
      return socket.emit('auth_error', { error: 'JWT requerido para join_event' });
    }
    try {
      const isAdmin = socket.user.role === 'admin';
      const ev = await pool.query(
        `SELECT id FROM events.events WHERE id = $1 ${isAdmin ? '' : 'AND user_id = $2'}`,
        isAdmin ? [event_id] : [event_id, socket.user.id]
      );
      if (!ev.rowCount) return socket.emit('auth_error', { error: 'Evento no encontrado o no autorizado' });
      socket.join(`event_${event_id}`);
      socket.join(`event_checkin_${event_id}`);
      socket.join(`event_screen_${event_id}`);
      console.log(`🎪 user_id=${socket.user.id} → salas event_${event_id}`);
    } catch (e) {
      console.error('join_event error:', e.message);
      socket.emit('auth_error', { error: 'Error interno' });
    }
  });

  socket.on('join_event_public', async ({ token } = {}) => {
    if (!token) return socket.emit('auth_error', { error: 'Token requerido' });
    try {
      const r = await pool.query(
        `SELECT event_id FROM events.production_tokens
         WHERE token = $1 AND revoked_at IS NULL LIMIT 1`,
        [token]
      );
      if (!r.rows[0]) return socket.emit('auth_error', { error: 'Token inválido o revocado' });
      const eventId = r.rows[0].event_id;
      socket.join(`event_${eventId}`);
      socket.join(`event_screen_${eventId}`);
      socket.emit('joined_event_public', { event_id: eventId });
    } catch (e) {
      console.error('join_event_public error:', e.message);
      socket.emit('auth_error', { error: 'Error interno' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Cliente desconectado: ${socket.id} (${socket.role})`);
  });
});

// ========================================
// INICIAR SERVIDOR
// ========================================

const PORT = process.env.PORT || 3000;

console.log('🎬 Servicio de conversión de videos inicializado');

// ========================================
// R4 — CALENDAR INTEGRATIONS (Agent OAuth)
// ========================================

const _calOAuthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _calOAuthStates) {
    if (now - v.createdAt > 10 * 60 * 1000) _calOAuthStates.delete(k);
  }
}, 60 * 1000);

async function _googleTokenExchange(code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.CMS_URL}/api/queue/calendar/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Token exchange failed ${r.status}: ${body}`);
  }
  return r.json();
}

async function _googleRevokeToken(accessToken) {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
    });
  } catch (e) {
    console.error('⚠️ Google revoke (non-fatal):', e.message);
  }
}

// POST /api/queue/calendar/agent/:agentId/generate-link — admin genera link de onboarding
app.post('/api/queue/calendar/agent/:agentId/generate-link', authenticateToken, async (req, res) => {
  const agentId = req.params.agentId;
  if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const agentRow = await pool.query(
      `SELECT a.id FROM agents a
       JOIN branches b ON b.id = a.branch_id
       WHERE a.id = $1 AND b.user_id = $2`,
      [agentId, req.user.id]
    );
    if (!agentRow.rows.length) return res.status(404).json({ error: 'Agente no encontrado' });

    const { randomUUID } = require('crypto');
    const token = randomUUID();
    const provider = (req.body && req.body.provider === 'outlook') ? 'outlook' : 'google';
    await pool.query(
      `INSERT INTO calendar_connect_tokens (token, agent_id, provider, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
      [token, agentId, provider]
    );
    res.json({ url: `${process.env.CMS_URL}/calendar-connect/?token=${token}` });
  } catch (err) {
    console.error('❌ generate-link:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/queue/calendar/connect-info/:token — info del agente para la página de conexión
app.get('/api/queue/calendar/connect-info/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.name AS agent_name, cct.provider
       FROM calendar_connect_tokens cct
       JOIN agents a ON a.id = cct.agent_id
       WHERE cct.token = $1 AND cct.expires_at > NOW() AND cct.used_at IS NULL`,
      [req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Link inválido o expirado' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('❌ connect-info:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/queue/calendar/connect-link/:token/auth — inicia OAuth para el agente
app.get('/api/queue/calendar/connect-link/:token/auth', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT agent_id, provider FROM calendar_connect_tokens
       WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [req.params.token]
    );
    if (!result.rows.length) {
      return res.redirect(`${process.env.CMS_URL}/calendar-connect-error/?error=link_invalido`);
    }
    const { agent_id, provider: tokenProvider } = result.rows[0];
    const { randomUUID } = require('crypto');
    const state = randomUUID();
    _calOAuthStates.set(state, { agentId: agent_id, connectToken: req.params.token, provider: tokenProvider, createdAt: Date.now() });

    if (tokenProvider === 'outlook') {
      if (!process.env.AZURE_CLIENT_ID) {
        return res.redirect(`${process.env.CMS_URL}/calendar-connect-error/?error=no_configurado`);
      }
      const params = new URLSearchParams({
        client_id:     process.env.AZURE_CLIENT_ID,
        redirect_uri:  `${process.env.CMS_URL}/api/queue/calendar/outlook/callback`,
        response_type: 'code',
        scope:         'Calendars.ReadWrite offline_access User.Read',
        state,
      });
      return res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.redirect(`${process.env.CMS_URL}/calendar-connect-error/?error=no_configurado`);
    }
    const params = new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      redirect_uri:  `${process.env.CMS_URL}/api/queue/calendar/google/callback`,
      response_type: 'code',
      scope:         'https://www.googleapis.com/auth/calendar.events',
      access_type:   'offline',
      prompt:        'consent',
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch (err) {
    console.error('❌ connect-link/auth:', err);
    res.redirect(`${process.env.CMS_URL}/calendar-connect-error/?error=server_error`);
  }
});

// GET /api/queue/calendar/google/callback — Google redirige aquí tras autorización
app.get('/api/queue/calendar/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const SUCCESS = `${process.env.CMS_URL}/calendar-connect-success/`;
  const ERROR_BASE = `${process.env.CMS_URL}/calendar-connect-error/`;

  if (error) {
    console.error('❌ Google OAuth error:', error);
    return res.redirect(`${ERROR_BASE}?error=${encodeURIComponent(error)}`);
  }

  const stateData = _calOAuthStates.get(state);
  if (!stateData) {
    console.error('❌ OAuth state inválido:', state);
    return res.redirect(`${ERROR_BASE}?error=invalid_state`);
  }
  _calOAuthStates.delete(state);

  const { agentId, connectToken } = stateData;
  try {
    const tokens = await _googleTokenExchange(code);
    const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    let calendarId = 'primary';
    try {
      const calRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (calRes.ok) { const d = await calRes.json(); calendarId = d.id || 'primary'; }
    } catch (e) { /* non-fatal */ }

    await pool.query(
      `INSERT INTO calendar_integrations
         (agent_id, provider, calendar_id, access_token, refresh_token, token_expiry, scope)
       VALUES ($1, 'google', $2,
         pgp_sym_encrypt($3, $4), pgp_sym_encrypt($5, $4), $6, $7)
       ON CONFLICT (agent_id, provider) DO UPDATE SET
         calendar_id = EXCLUDED.calendar_id, access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token, token_expiry = EXCLUDED.token_expiry,
         scope = EXCLUDED.scope, connected_at = NOW()`,
      [agentId, calendarId, tokens.access_token, encKey,
       tokens.refresh_token || '', expiry,
       tokens.scope || 'https://www.googleapis.com/auth/calendar.events']
    );

    await pool.query(
      'UPDATE calendar_connect_tokens SET used_at = NOW() WHERE token = $1',
      [connectToken]
    );

    console.log(`✅ calendar.sync.ok agent=${agentId} provider=google cal=${calendarId}`);
    // Registrar Google Watch Channel (non-fatal, igual que Outlook)
    _registerGoogleWatchChannel(agentId, calendarId, tokens.access_token).catch(e =>
      console.error('⚠️ google watch channel registro:', e.message)
    );
    res.redirect(SUCCESS);
  } catch (err) {
    console.error('❌ /api/queue/calendar/google/callback:', err);
    res.redirect(`${ERROR_BASE}?error=server_error`);
  }
});

// GET /api/queue/calendar/outlook/callback — Microsoft redirige aquí tras autorización
app.get('/api/queue/calendar/outlook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const SUCCESS    = `${process.env.CMS_URL}/calendar-connect-success/`;
  const ERROR_BASE = `${process.env.CMS_URL}/calendar-connect-error/`;

  if (error) {
    console.error('❌ Outlook OAuth error:', error);
    return res.redirect(`${ERROR_BASE}?error=${encodeURIComponent(error)}`);
  }
  const stateData = _calOAuthStates.get(state);
  if (!stateData) {
    console.error('❌ OAuth state inválido (Outlook):', state);
    return res.redirect(`${ERROR_BASE}?error=invalid_state`);
  }
  _calOAuthStates.delete(state);

  const { agentId, connectToken } = stateData;
  try {
    const tokens = await _outlookTokenExchange(code);
    const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    let calendarId = 'primary';
    try {
      const calRes = await fetch(
        'https://graph.microsoft.com/v1.0/me/calendars?$top=1&$filter=isDefaultCalendar eq true',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );
      if (calRes.ok) {
        const d = await calRes.json();
        if (d.value && d.value[0]) calendarId = d.value[0].id || 'primary';
      }
    } catch (e) { /* non-fatal */ }

    await pool.query(
      `INSERT INTO calendar_integrations
         (agent_id, provider, calendar_id, access_token, refresh_token, token_expiry, scope)
       VALUES ($1, 'outlook', $2,
         pgp_sym_encrypt($3, $4), pgp_sym_encrypt($5, $4), $6, $7)
       ON CONFLICT (agent_id, provider) DO UPDATE SET
         calendar_id = EXCLUDED.calendar_id, access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token, token_expiry = EXCLUDED.token_expiry,
         scope = EXCLUDED.scope, connected_at = NOW()`,
      [agentId, calendarId, tokens.access_token, encKey,
       tokens.refresh_token || '', expiry,
       tokens.scope || 'Calendars.ReadWrite offline_access User.Read']
    );
    await pool.query(
      'UPDATE calendar_connect_tokens SET used_at = NOW() WHERE token = $1',
      [connectToken]
    );
    _registerOutlookSubscription(agentId, tokens.access_token)
      .catch(e => console.error('⚠️ outlook.subscription (non-fatal):', e.message));

    console.log(`✅ calendar.sync.ok agent=${agentId} provider=outlook cal=${calendarId}`);
    res.redirect(SUCCESS);
  } catch (err) {
    console.error('❌ /api/queue/calendar/outlook/callback:', err);
    res.redirect(`${ERROR_BASE}?error=server_error`);
  }
});

// DELETE /api/queue/calendar/:integrationId — admin desconecta calendario de un agente
app.delete('/api/queue/calendar/:integrationId', authenticateToken, async (req, res) => {
  const integrationId = parseInt(req.params.integrationId, 10);
  if (!integrationId) return res.status(400).json({ error: 'ID inválido' });
  try {
    const row = await pool.query(
      `SELECT ci.id, ci.provider, pgp_sym_decrypt(ci.access_token, $1) AS at
       FROM calendar_integrations ci
       JOIN agents a ON a.id = ci.agent_id
       JOIN branches b ON b.id = a.branch_id
       WHERE ci.id = $2 AND b.user_id = $3`,
      [process.env.CALENDAR_TOKENS_ENCRYPTION_KEY, integrationId, req.user.id]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Integración no encontrada' });

    const { provider, at } = row.rows[0];
    if (provider === 'google') await _googleRevokeToken(at);
    else if (provider === 'outlook') await _outlookRevokeSubscription(integrationId, at).catch(() => {});
    await pool.query('DELETE FROM calendar_integrations WHERE id = $1', [integrationId]);

    console.log(`✅ calendar.disconnect integration=${integrationId} provider=${provider}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ DELETE /api/queue/calendar:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});


// ══════════════════════════════════════════════════════════════
// R4.1 — GCal helpers: token refresh + event upsert/delete
// ══════════════════════════════════════════════════════════════

async function _googleRefreshToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`Token refresh failed ${r.status}: ${await r.text()}`);
  return r.json();
}

async function _calGetToken(agentId) {
  const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
  if (!encKey) return null;
  const row = await pool.query(
    `SELECT id, calendar_id,
            pgp_sym_decrypt(access_token,  $2) AS access_token,
            pgp_sym_decrypt(refresh_token, $2) AS refresh_token,
            token_expiry
     FROM calendar_integrations
     WHERE agent_id = $1 AND provider = 'google'`,
    [agentId, encKey]
  );
  if (!row.rowCount) return null;
  const ci = row.rows[0];
  // Refresh si expira en <5 min
  if (ci.token_expiry && new Date(ci.token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    try {
      const refreshed = await _googleRefreshToken(ci.refresh_token);
      const newExpiry  = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : null;
      await pool.query(
        `UPDATE calendar_integrations
           SET access_token = pgp_sym_encrypt($1, $3), token_expiry = $2
         WHERE agent_id = $4 AND provider = 'google'`,
        [refreshed.access_token, newExpiry, encKey, agentId]
      );
      ci.access_token = refreshed.access_token;
    } catch (e) {
      console.error(`⚠️ _calGetToken refresh agent=${agentId}:`, e.message);
    }
  }
  return ci;
}

// Crea o actualiza un evento en GCal. Devuelve gcal_event_id o null si no hay calendario.
async function _calUpsertEvent(agentId, appt) {
  const ci = await _calGetToken(agentId);
  if (!ci) return null;

  const scheduledAt = new Date(appt.scheduled_at);
  const endAt       = new Date(scheduledAt.getTime() + 30 * 60 * 1000); // 30 min default
  const calId       = encodeURIComponent(ci.calendar_id || 'primary');

  const eventBody = {
    summary:     `Cita: ${appt.client_name || 'Cliente'}`,
    description: `${appt.service_name || 'Cita SONORO'}\nTel: ${appt.client_phone || ''}`.trim(),
    start: { dateTime: scheduledAt.toISOString(), timeZone: 'America/Bogota' },
    end:   { dateTime: endAt.toISOString(),       timeZone: 'America/Bogota' },
  };

  let method = 'POST';
  let url    = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`;
  if (appt.gcal_event_id) {
    method = 'PUT';
    url    = `${url}/${encodeURIComponent(appt.gcal_event_id)}`;
  }

  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${ci.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody),
  });
  if (!r.ok) {
    console.error(`❌ _calUpsertEvent agent=${agentId} status=${r.status}:`, await r.text());
    return null;
  }
  const ev = await r.json();
  console.log(`✅ calendar.sync.ok agent=${agentId} event=${ev.id}`);
  return ev.id;
}

// Elimina un evento de GCal. Non-fatal — errores solo se loguean.
async function _calDeleteEvent(agentId, gcalEventId) {
  if (!gcalEventId || !agentId) return;
  try {
    const ci = await _calGetToken(agentId);
    if (!ci) return;
    const calId = encodeURIComponent(ci.calendar_id || 'primary');
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(gcalEventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ci.access_token}` } }
    );
    if (!r.ok && r.status !== 404 && r.status !== 410) {
      console.error(`⚠️ _calDeleteEvent agent=${agentId} event=${gcalEventId} status=${r.status}`);
      return;
    }
    console.log(`✅ calendar.event.deleted agent=${agentId} event=${gcalEventId}`);
  } catch (e) {
    console.error(`⚠️ _calDeleteEvent (non-fatal) agent=${agentId}:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// R4 — Outlook Calendar helpers
// ══════════════════════════════════════════════════════════════

async function _outlookTokenExchange(code) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      redirect_uri:  `${process.env.CMS_URL}/api/queue/calendar/outlook/callback`,
      grant_type:    'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`Outlook token exchange failed ${r.status}: ${await r.text()}`);
  return r.json();
}

async function _outlookRefreshToken(refreshToken) {
  const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`Outlook token refresh failed ${r.status}: ${await r.text()}`);
  return r.json();
}

async function _outlookCalGetToken(agentId) {
  const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
  if (!encKey) return null;
  const row = await pool.query(
    `SELECT id, calendar_id,
            pgp_sym_decrypt(access_token,  $2) AS access_token,
            pgp_sym_decrypt(refresh_token, $2) AS refresh_token,
            token_expiry
     FROM calendar_integrations
     WHERE agent_id = $1 AND provider = 'outlook'`,
    [agentId, encKey]
  );
  if (!row.rowCount) return null;
  const ci = row.rows[0];
  if (ci.token_expiry && new Date(ci.token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    try {
      const refreshed = await _outlookRefreshToken(ci.refresh_token);
      const newExpiry = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : null;
      await pool.query(
        `UPDATE calendar_integrations
           SET access_token = pgp_sym_encrypt($1, $3), token_expiry = $2
         WHERE agent_id = $4 AND provider = 'outlook'`,
        [refreshed.access_token, newExpiry, encKey, agentId]
      );
      ci.access_token = refreshed.access_token;
    } catch (e) {
      console.error(`⚠️ _outlookCalGetToken refresh agent=${agentId}:`, e.message);
    }
  }
  return ci;
}

async function _outlookCalUpsertEvent(agentId, appt) {
  const ci = await _outlookCalGetToken(agentId);
  if (!ci) return null;
  const scheduledAt = new Date(appt.scheduled_at);
  const endAt       = new Date(scheduledAt.getTime() + 30 * 60 * 1000);
  const toBogotaDT  = (d) => {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).formatToParts(d).forEach(({type,value}) => { parts[type]=value; });
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const eventBody = {
    subject: `Cita: ${appt.client_name || 'Cliente'}`,
    body:    { contentType: 'text', content: `${appt.service_name || 'Cita SONORO'}\nTel: ${appt.client_phone || ''}`.trim() },
    start:   { dateTime: toBogotaDT(scheduledAt), timeZone: 'America/Bogota' },
    end:     { dateTime: toBogotaDT(endAt),       timeZone: 'America/Bogota' },
  };
  let method = 'POST';
  let url    = 'https://graph.microsoft.com/v1.0/me/events';
  if (appt.outlook_event_id) {
    method = 'PATCH';
    url    = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(appt.outlook_event_id)}`;
  }
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${ci.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody),
  });
  if (!r.ok) {
    console.error(`❌ _outlookCalUpsertEvent agent=${agentId} status=${r.status}:`, await r.text());
    return null;
  }
  if (method === 'PATCH') {
    console.log(`✅ outlook.event.updated agent=${agentId} event=${appt.outlook_event_id}`);
    return appt.outlook_event_id;
  }
  const ev = await r.json();
  console.log(`✅ outlook.sync.ok agent=${agentId} event=${ev.id}`);
  return ev.id;
}

async function _outlookCalDeleteEvent(agentId, outlookEventId) {
  if (!outlookEventId || !agentId) return;
  try {
    const ci = await _outlookCalGetToken(agentId);
    if (!ci) return;
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(outlookEventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${ci.access_token}` } }
    );
    if (!r.ok && r.status !== 404 && r.status !== 410) {
      console.error(`⚠️ _outlookCalDeleteEvent agent=${agentId} event=${outlookEventId} status=${r.status}`);
    }
  } catch (e) {
    console.error(`⚠️ _outlookCalDeleteEvent (non-fatal) agent=${agentId}:`, e.message);
  }
}

async function _outlookRevokeSubscription(integrationId, accessToken) {
  try {
    const row = await pool.query(
      `SELECT cwc.channel_id, cwc.agent_id
       FROM calendar_integrations ci
       LEFT JOIN calendar_watch_channels cwc ON cwc.agent_id = ci.agent_id AND cwc.provider = 'outlook'
       WHERE ci.id = $1`,
      [integrationId]
    );
    if (row.rowCount && row.rows[0].channel_id && accessToken) {
      await fetch(
        `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(row.rows[0].channel_id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
      ).catch(() => {});
      await pool.query(
        `DELETE FROM calendar_watch_channels WHERE agent_id = $1 AND provider = 'outlook'`,
        [row.rows[0].agent_id]
      );
    }
  } catch (e) {
    console.error('⚠️ _outlookRevokeSubscription (non-fatal):', e.message);
  }
}

async function _registerGoogleWatchChannel(agentId, calendarId, accessToken) {
  const { randomBytes, randomUUID } = require('crypto');
  const channelId    = randomUUID();
  const channelToken = randomBytes(32).toString('hex');
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || 'primary')}/events/watch`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: channelId, type: 'web_hook',
        address: `${process.env.CMS_URL}/api/queue/calendar/webhooks/google`,
        token: channelToken, params: { ttl: '604800' },
      }),
    }
  );
  if (!r.ok) throw new Error(`Google watch channel failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  await pool.query(
    `INSERT INTO calendar_watch_channels
       (agent_id, provider, channel_id, resource_id, channel_token, expires_at, calendar_id)
     VALUES ($1, 'google', $2, $3, $4, to_timestamp($5::bigint / 1000.0), $6)
     ON CONFLICT (agent_id, provider) DO UPDATE SET
       channel_id = EXCLUDED.channel_id, resource_id = EXCLUDED.resource_id,
       channel_token = EXCLUDED.channel_token, expires_at = EXCLUDED.expires_at,
       calendar_id = EXCLUDED.calendar_id`,
    [agentId, data.id, data.resourceId || '', channelToken, data.expiration, calendarId || 'primary']
  );
  console.log(`✅ google.watch_channel.registered agent=${agentId} channel=${data.id}`);
}

async function _registerOutlookSubscription(agentId, accessToken) {
  const { randomBytes } = require('crypto');
  const clientState = randomBytes(16).toString('hex');
  const expiresAt   = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
  const r = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType:         'created,updated,deleted',
      notificationUrl:    `${process.env.CMS_URL}/api/queue/calendar/webhooks/outlook`,
      resource:           'me/events',
      expirationDateTime: expiresAt,
      clientState,
    }),
  });
  if (!r.ok) throw new Error(`Outlook subscription failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  await pool.query(
    `INSERT INTO calendar_watch_channels
       (agent_id, provider, channel_id, channel_token, expires_at)
     VALUES ($1, 'outlook', $2, $3, $4)
     ON CONFLICT (agent_id, provider) DO UPDATE SET
       channel_id = EXCLUDED.channel_id, channel_token = EXCLUDED.channel_token,
       expires_at = EXCLUDED.expires_at`,
    [agentId, data.id, clientState, expiresAt]
  );
  console.log(`✅ outlook.subscription.registered agent=${agentId} sub=${data.id}`);
}

// ──────────────────────────────────────────────────────────────
// R4 — Unified calendar sync (Google + Outlook)
// ──────────────────────────────────────────────────────────────

async function _syncAllCalendars(agentId, appt) {
  const [gcalResult, outlookResult] = await Promise.allSettled([
    _calUpsertEvent(agentId, appt).catch(() => null),
    _outlookCalUpsertEvent(agentId, appt).catch(() => null),
  ]);
  return {
    gcal_event_id:    gcalResult.status    === 'fulfilled' ? gcalResult.value    : null,
    outlook_event_id: outlookResult.status === 'fulfilled' ? outlookResult.value : null,
  };
}

async function _deleteAllCalendars(agentId, gcalEventId, outlookEventId) {
  await Promise.allSettled([
    gcalEventId    ? _calDeleteEvent(agentId, gcalEventId).catch(() => {})           : Promise.resolve(),
    outlookEventId ? _outlookCalDeleteEvent(agentId, outlookEventId).catch(() => {}) : Promise.resolve(),
  ]);
}

// ──────────────────────────────────────────────────────────────
// R4.1 — PATCH /api/queue/appointments/:id/agent
// Asigna o reasigna agente a una cita + sincroniza GCal.
// ──────────────────────────────────────────────────────────────
app.patch(
  '/api/queue/appointments/:id/agent',
  authenticateToken,
  requireFeatureFlag('queue_v2_appointments'),
  async (req, res) => {
    const apptId     = req.params.id;
    const newAgentId = (req.body && req.body.agent_id) ? String(req.body.agent_id) : null;
    const UUID_RE_LOCAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!UUID_RE_LOCAL.test(apptId)) {
      return res.status(400).json({ error: 'id de cita inválido' });
    }
    if (newAgentId && !UUID_RE_LOCAL.test(newAgentId)) {
      return res.status(400).json({ error: 'agent_id inválido' });
    }

    try {
      // Verificar ownership + obtener estado actual
      const cur = await pool.query(
        `SELECT a.id, a.agent_id AS old_agent_id, a.gcal_event_id, a.outlook_event_id,
                a.client_name, a.client_phone, a.scheduled_at,
                s.name AS service_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         WHERE a.id = $1 AND a.user_id = $2
           AND a.status IN ('pending','confirmed')`,
        [apptId, req.user.id]
      );
      if (!cur.rowCount) {
        return res.status(404).json({ error: 'Cita no encontrada o no modificable' });
      }
      const appt = cur.rows[0];

      // Verificar que el nuevo agente pertenece a una sucursal del admin
      if (newAgentId) {
        const ag = await pool.query(
          `SELECT a.id FROM agents a
           JOIN branches b ON b.id = a.branch_id
           WHERE a.id = $1 AND b.user_id = $2`,
          [newAgentId, req.user.id]
        );
        if (!ag.rowCount) {
          return res.status(404).json({ error: 'Agente no encontrado' });
        }
      }

      // Borrar eventos de todos los calendarios del agente anterior (non-fatal)
      if (appt.old_agent_id && appt.old_agent_id !== newAgentId) {
        _deleteAllCalendars(appt.old_agent_id, appt.gcal_event_id, appt.outlook_event_id).catch(() => {});
      }

      // Crear eventos en todos los calendarios del nuevo agente (non-fatal)
      let newGcalEventId = null, newOutlookEventId = null;
      if (newAgentId) {
        const synced = await _syncAllCalendars(newAgentId, {
          ...appt, gcal_event_id: null, outlook_event_id: null,
        }).catch(() => ({ gcal_event_id: null, outlook_event_id: null }));
        newGcalEventId    = synced.gcal_event_id;
        newOutlookEventId = synced.outlook_event_id;
      }

      await pool.query(
        'UPDATE appointments SET agent_id = $1, gcal_event_id = $2, outlook_event_id = $3 WHERE id = $4',
        [newAgentId, newGcalEventId, newOutlookEventId, apptId]
      );

      console.log(JSON.stringify({
        event:            'appointment.agent_assigned',
        appt_id:          apptId,
        old_agent_id:     appt.old_agent_id,
        new_agent_id:     newAgentId,
        gcal_event_id:    newGcalEventId,
        outlook_event_id: newOutlookEventId,
      }));

      return res.json({ ok: true, agent_id: newAgentId, gcal_event_id: newGcalEventId, outlook_event_id: newOutlookEventId });
    } catch (err) {
      console.error('❌ PATCH /api/queue/appointments/:id/agent:', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ══════════════════════════════════════════════════════════════
// R4 — WEBHOOK ENDPOINTS (inbound calendar notifications)
// ══════════════════════════════════════════════════════════════


// R4 — procesa eventos de calendario y upserta time_blocks para los "busy"
async function _calProcessBusyEvents(agentId, events, provider) {
  if (!events || !events.length) return;
  try {
    const agentRow = await pool.query(
      `SELECT a.branch_id, b.user_id
         FROM agents a
         JOIN branches b ON b.id = a.branch_id
        WHERE a.id = $1`,
      [agentId]
    );
    if (!agentRow.rowCount) return;
    const { branch_id, user_id } = agentRow.rows[0];

    for (const ev of events) {
      const eventId = ev.id;
      if (!eventId) continue;

      // Evento cancelado / eliminado → borrar time_block
      const isCancelled = ev.status === 'cancelled' || ev.isCancelled === true;
      if (isCancelled) {
        await pool.query(
          `DELETE FROM time_blocks
            WHERE calendar_event_id = $1 AND agent_id = $2 AND calendar_provider = $3`,
          [eventId, agentId, provider]
        );
        console.log(JSON.stringify({ event: 'time_block.deleted', source: 'calendar', agent_id: agentId, calendar_event_id: eventId, provider }));
        continue;
      }

      // Solo eventos "busy" (Google: transparency != 'transparent'; Outlook: showAs != 'free')
      const isBusy = provider === 'google'
        ? (ev.transparency !== 'transparent')
        : (ev.showAs !== 'free' && ev.showAs !== 'oof' && ev.showAs !== 'workingElsewhere');
      if (!isBusy) continue;

      // Parsear start/end (all-day events usan ev.start.date, timed usan ev.start.dateTime)
      const startStr = (provider === 'google')
        ? (ev.start && (ev.start.dateTime || ev.start.date))
        : (ev.start && ev.start.dateTime);
      const endStr = (provider === 'google')
        ? (ev.end && (ev.end.dateTime || ev.end.date))
        : (ev.end && ev.end.dateTime);
      if (!startStr || !endStr) continue;

      const startsAt = new Date(startStr);
      const endsAt   = new Date(endStr);
      if (isNaN(startsAt) || isNaN(endsAt) || endsAt <= startsAt) continue;

      // Ignorar eventos pasados
      if (endsAt <= new Date()) continue;

      const summary = ev.summary || ev.subject || 'Evento de calendario';
      const reason  = `Ocupado: ${summary}`.slice(0, 200);

      // Upsert: delete anterior (mismo event_id+agent) luego insert
      // Uso de DELETE+INSERT en vez de ON CONFLICT porque el EXCLUDE gist
      // no admite ON CONFLICT DO UPDATE.
      await pool.query(
        `DELETE FROM time_blocks
          WHERE calendar_event_id = $1 AND agent_id = $2 AND calendar_provider = $3`,
        [eventId, agentId, provider]
      );
      try {
        await pool.query(
          `INSERT INTO time_blocks
             (user_id, branch_id, agent_id, starts_at, ends_at, reason,
              calendar_event_id, calendar_provider, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
          [user_id, branch_id, agentId, startsAt.toISOString(), endsAt.toISOString(),
           reason, eventId, provider]
        );
        console.log(JSON.stringify({ event: 'time_block.created', source: 'calendar', agent_id: agentId, calendar_event_id: eventId, provider }));
      } catch (insErr) {
        if (insErr.code === '23P01') {
          // Exclusion violation: otro bloque ya cubre este rango para este agente → ignorar
        } else {
          console.error('⚠️ _calProcessBusyEvents insert:', insErr.message);
        }
      }
    }
    console.log(JSON.stringify({ event: 'calendar.webhook.processed', provider, agent_id: agentId, events_count: events.length }));
  } catch (err) {
    console.error('❌ _calProcessBusyEvents:', err.message);
  }
}

// POST /api/queue/calendar/webhooks/google
app.post('/api/queue/calendar/webhooks/google', async (req, res) => {
  const channelId     = req.headers['x-goog-channel-id'];
  const channelToken  = req.headers['x-goog-channel-token'];
  const resourceState = req.headers['x-goog-resource-state'];
  if (!channelId || !channelToken) return res.status(400).end();
  try {
    const row = await pool.query(
      `SELECT agent_id FROM calendar_watch_channels
       WHERE channel_id = $1 AND channel_token = $2 AND provider = 'google'`,
      [channelId, channelToken]
    );
    if (!row.rowCount) {
      console.error(`⚠️ google.webhook.invalid_token channel=${channelId}`);
      return res.status(401).end();
    }
    res.status(200).end();
    if (resourceState === 'sync') return;
    const agentId = row.rows[0].agent_id;
    console.log(JSON.stringify({
      event: 'calendar.webhook.received', provider: 'google',
      channel_id: channelId, agent_id: agentId, resource_state: resourceState,
    }));
    // Fetch eventos recientes del agente y upsert time_blocks
    const ci = await _calGetToken(agentId);
    if (ci) {
      const updatedMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const gEvRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ci.calendar_id)}/events` +
        `?updatedMin=${encodeURIComponent(updatedMin)}&showDeleted=true&singleEvents=true&maxResults=50`,
        { headers: { Authorization: `Bearer ${ci.access_token}` } }
      );
      if (gEvRes.ok) {
        const data = await gEvRes.json();
        await _calProcessBusyEvents(agentId, data.items || [], 'google');
      }
    }
  } catch (err) {
    console.error('❌ google.webhook:', err);
  }
});

// POST /api/queue/calendar/webhooks/outlook
app.post('/api/queue/calendar/webhooks/outlook', async (req, res) => {
  if (req.query.validationToken) {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(req.query.validationToken);
  }
  const notifications = req.body && req.body.value;
  if (!notifications) return res.status(400).end();
  res.status(202).end();
  for (const notification of notifications) {
    const { subscriptionId, clientState } = notification;
    try {
      const row = await pool.query(
        `SELECT agent_id FROM calendar_watch_channels
         WHERE channel_id = $1 AND channel_token = $2 AND provider = 'outlook'`,
        [subscriptionId, clientState]
      );
      if (!row.rowCount) {
        console.error(`⚠️ outlook.webhook.invalid_state sub=${subscriptionId}`);
        continue;
      }
      const agentId = row.rows[0].agent_id;
      console.log(JSON.stringify({
        event: 'calendar.webhook.received', provider: 'outlook',
        subscription_id: subscriptionId, agent_id: agentId,
        change_type: notification.changeType,
      }));
      // Fetch eventos recientes del agente y upsert time_blocks
      const ciO = await _outlookCalGetToken(agentId);
      if (ciO) {
        const updatedMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const oEvRes = await fetch(
          `https://graph.microsoft.com/v1.0/me/events` +
          `?$filter=lastModifiedDateTime ge ${updatedMin}` +
          `&$select=id,subject,start,end,showAs,isCancelled&$top=50`,
          { headers: { Authorization: `Bearer ${ciO.access_token}` } }
        );
        if (oEvRes.ok) {
          const data = await oEvRes.json();
          await _calProcessBusyEvents(agentId, data.value || [], 'outlook');
        }
      }
    } catch (e) {
      console.error('⚠️ outlook.webhook.notification:', e.message);
    }
  }
});

// ══════════════════════════════════════════════════════════════
// R4 — CRON: renovar canales Google Watch + suscripciones Outlook (cada 6h)
// ══════════════════════════════════════════════════════════════
setInterval(async () => {
  const encKey = process.env.CALENDAR_TOKENS_ENCRYPTION_KEY;
  if (!encKey) return;
  try {
    const expiring = await pool.query(
      `SELECT cwc.id, cwc.agent_id, cwc.provider, cwc.channel_id, cwc.calendar_id,
              pgp_sym_decrypt(ci.access_token,  $1) AS access_token,
              pgp_sym_decrypt(ci.refresh_token, $1) AS refresh_token,
              ci.token_expiry
       FROM calendar_watch_channels cwc
       JOIN calendar_integrations ci ON ci.agent_id = cwc.agent_id AND ci.provider = cwc.provider
       WHERE cwc.expires_at < NOW() + INTERVAL '24 hours'`,
      [encKey]
    );
    for (const ch of expiring.rows) {
      try {
        let accessToken = ch.access_token;
        if (ch.token_expiry && new Date(ch.token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
          const refreshed = ch.provider === 'google'
            ? await _googleRefreshToken(ch.refresh_token)
            : await _outlookRefreshToken(ch.refresh_token);
          accessToken = refreshed.access_token;
          const newExpiry = refreshed.expires_in
            ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null;
          await pool.query(
            `UPDATE calendar_integrations SET access_token = pgp_sym_encrypt($1, $3), token_expiry = $2
             WHERE agent_id = $4 AND provider = $5`,
            [refreshed.access_token, newExpiry, encKey, ch.agent_id, ch.provider]
          );
        }
        if (ch.provider === 'google') {
          await _registerGoogleWatchChannel(ch.agent_id, ch.calendar_id || 'primary', accessToken);
          console.log(`✅ cron.google_watch.renewed agent=${ch.agent_id}`);
        } else if (ch.provider === 'outlook') {
          const newExpiry = new Date(Date.now() + 4230 * 60 * 1000).toISOString();
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(ch.channel_id)}`,
            {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ expirationDateTime: newExpiry }),
            }
          );
          if (r.ok) {
            await pool.query(`UPDATE calendar_watch_channels SET expires_at = $1 WHERE id = $2`, [newExpiry, ch.id]);
            console.log(`✅ cron.outlook_subscription.renewed agent=${ch.agent_id}`);
          } else {
            await _registerOutlookSubscription(ch.agent_id, accessToken);
            console.log(`✅ cron.outlook_subscription.re-registered agent=${ch.agent_id}`);
          }
        }
      } catch (e) {
        console.error(`⚠️ cron.calendar_renewal agent=${ch.agent_id} provider=${ch.provider}:`, e.message);
      }
    }
  } catch (e) {
    console.error('⚠️ cron.calendar_renewal:', e.message);
  }
}, 6 * 60 * 60 * 1000);



// ══════════════════════════════════════════════════════════════
// FIDS — Flight Information Display System (F0)
// Proxy + Cache + Cron · Principios P1-P5 · 05/06/2026
// ══════════════════════════════════════════════════════════════

// Mock data para desarrollo (FIDS_DEV_MOCK=true) — aeropuerto AXM
function getFidsMockData(airport, type) {
  const now = new Date();
  const fmt = (offsetMin) => new Date(now.getTime() + offsetMin * 60000).toISOString();
  const departures = [
    { flight_date: now.toISOString().slice(0,10), flight_status: 'scheduled',
      departure: { airport: 'El Eden', iata: 'AXM', icao: 'SKAR', terminal: null, gate: null,
                   scheduled: fmt(30), estimated: fmt(30), actual: null, delay: null },
      arrival:   { airport: 'El Nuevo Dorado International', iata: 'BOG', icao: 'SKBO',
                   scheduled: fmt(90), estimated: null, actual: null },
      airline: { name: 'avianca', iata: 'AV' }, flight: { iata: 'AV9842', codeshared: null } },
    { flight_date: now.toISOString().slice(0,10), flight_status: 'active',
      departure: { airport: 'El Eden', iata: 'AXM', icao: 'SKAR', terminal: null, gate: null,
                   scheduled: fmt(-20), estimated: fmt(-20), actual: fmt(-15), delay: null },
      arrival:   { airport: 'José María Córdova', iata: 'MDE', icao: 'SKRG',
                   scheduled: fmt(40), estimated: null, actual: null },
      airline: { name: 'Clic', iata: 'VE' }, flight: { iata: 'VE4100', codeshared: null } },
    { flight_date: now.toISOString().slice(0,10), flight_status: 'scheduled',
      departure: { airport: 'El Eden', iata: 'AXM', icao: 'SKAR', terminal: null, gate: null,
                   scheduled: fmt(120), estimated: fmt(135), actual: null, delay: 15 },
      arrival:   { airport: 'El Nuevo Dorado International', iata: 'BOG', icao: 'SKBO',
                   scheduled: fmt(180), estimated: null, actual: null },
      airline: { name: 'Wingo', iata: 'P5' }, flight: { iata: 'P5310', codeshared: null } },
    { flight_date: now.toISOString().slice(0,10), flight_status: 'landed',
      departure: { airport: 'El Eden', iata: 'AXM', icao: 'SKAR', terminal: null, gate: null,
                   scheduled: fmt(-120), estimated: fmt(-120), actual: fmt(-118), delay: null },
      arrival:   { airport: 'El Nuevo Dorado International', iata: 'BOG', icao: 'SKBO',
                   scheduled: fmt(-60), estimated: null, actual: fmt(-55) },
      airline: { name: 'LATAM Colombia', iata: 'LA' }, flight: { iata: 'LA543', codeshared: null } },
    { flight_date: now.toISOString().slice(0,10), flight_status: 'cancelled',
      departure: { airport: 'El Eden', iata: 'AXM', icao: 'SKAR', terminal: null, gate: null,
                   scheduled: fmt(200), estimated: fmt(200), actual: null, delay: null },
      arrival:   { airport: 'Alfonso Bonilla Aragón', iata: 'CLO', icao: 'SKCL',
                   scheduled: fmt(240), estimated: null, actual: null },
      airline: { name: 'avianca', iata: 'AV' }, flight: { iata: 'AV211', codeshared: null } },
  ];
  if (type === 'arrivals') {
    return departures.map(f => ({
      ...f,
      departure: { ...f.arrival, iata: f.arrival.iata, scheduled: new Date(new Date(f.departure.scheduled).getTime() - 60*60000).toISOString(), actual: null, delay: null, terminal: null, gate: null },
      arrival:   { ...f.departure, airport: 'El Eden', iata: 'AXM', icao: 'SKAR' },
    }));
  }
  return departures;
}

// GET /fids — sirve la pantalla de vuelos (F1)
app.get('/fids', (req, res) => {
  const path = require('path');
  res.sendFile(path.join(__dirname, '../public/fids.html'));
});

// GET /api/fids/config/:deviceId — config del grupo para un dispositivo (sin auth, llamado por fids.html)
app.get('/api/fids/config/:deviceId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.fids_group_id, d.fids_role,
              fg.airport, fg.type, fg.filters, fg.lower_thirds, fg.name AS group_name
       FROM devices d
       LEFT JOIN fids_groups fg ON fg.id = d.fids_group_id
       WHERE d.device_id = $1`,
      [req.params.deviceId]
    );
    if (!result.rowCount || !result.rows[0].fids_group_id) {
      return res.status(404).json({ error: 'Dispositivo sin grupo FIDS asignado' });
    }
    const row = result.rows[0];
    const cfgAirport = row.airport;
    const cfgType    = row.type; // 'departures' | 'arrivals' | 'combined'

    // Incluir datos iniciales desde caché (P2: sin llamar a AviationStack)
    async function _cfgFlights(t) {
      if (process.env.FIDS_DEV_MOCK === 'true') {
        return { data: getFidsMockData(cfgAirport, t), fetched_at: new Date() };
      }
      const c = await pool.query(
        `SELECT data, fetched_at FROM fids_cache WHERE airport = $1 AND type = $2`,
        [cfgAirport, t]
      );
      return c.rowCount
        ? { data: c.rows[0].data, fetched_at: c.rows[0].fetched_at }
        : { data: [], fetched_at: null };
    }

    let initialData = {};
    if (cfgType === 'combined') {
      const [dep, arr] = await Promise.all([_cfgFlights('departures'), _cfgFlights('arrivals')]);
      initialData = {
        departures: dep.data,
        arrivals:   arr.data,
        fetched_at: dep.fetched_at || arr.fetched_at,
      };
    } else {
      const d = await _cfgFlights(cfgType);
      initialData = { flights: d.data, fetched_at: d.fetched_at };
    }

    res.json({
      group_id:     row.fids_group_id,
      role:         row.fids_role,
      airport:      cfgAirport,
      type:         cfgType,
      filters:      row.filters || {},
      lower_thirds: await (async () => {
        const lt = row.lower_thirds || { mode: 'off' };
        if ((lt.mode === 'overlay_ad' || lt.mode === 'lower_bar') && lt.playlist_id) {
          try {
            const plRes = await pool.query(
              `SELECT m.file_path, m.type,
                      COALESCE(pi.duration_override_ms, m.duration_ms, 5000) AS duration_ms,
                      m.title
               FROM fids_playlist_items pi
               JOIN fids_media m ON m.id = pi.media_id
               WHERE pi.playlist_id = $1
               ORDER BY pi.display_order`,
              [lt.playlist_id]
            );
            lt.playlist_items = plRes.rows.map(r => ({
              file_path:   r.file_path,
              type:        r.type,
              duration_ms: parseInt(r.duration_ms) || 5000,
              title:       r.title || '',
            }));
            console.log(`fids.config.playlist playlist=${lt.playlist_id} items=${(lt.playlist_items||[]).length}`);
          } catch (e2) { console.error('fids.config.playlist:', e2.message); }
        }
        return lt;
      })(),
      group_name:   row.group_name,
      ...initialData,
    });
  } catch (err) {
    console.error('❌ /api/fids/config:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/fids/:airport/:type — proxy con caché (P1: API key solo en backend)
app.get('/api/fids/:airport/:type', authenticateToken, async (req, res) => {
  try {
    const airport = (req.params.airport || '').toUpperCase();
    const type    = req.params.type;
    if (!['departures', 'arrivals'].includes(type)) {
      return res.status(400).json({ error: 'type debe ser departures o arrivals' });
    }

    // P4: verificar que el tenant tiene un grupo para este aeropuerto/tipo
    const authCheck = await pool.query(
      `SELECT id FROM fids_groups WHERE user_id = $1 AND airport = $2 AND type = $3 LIMIT 1`,
      [req.user.id, airport, type]
    );
    if (!authCheck.rowCount) {
      return res.status(403).json({ error: 'Sin grupo FIDS configurado para este aeropuerto/tipo' });
    }

    const ttl = parseInt(process.env.FIDS_CACHE_TTL_SECONDS || '300');

    // P2: verificar caché
    const cached = await pool.query(
      `SELECT data, fetched_at FROM fids_cache WHERE airport = $1 AND type = $2`,
      [airport, type]
    );
    if (cached.rowCount) {
      const age = (Date.now() - new Date(cached.rows[0].fetched_at).getTime()) / 1000;
      if (age < ttl) {
        console.log(`fids.cache.hit airport=${airport} type=${type} age=${Math.round(age)}s`);
        return res.json({ stale: false, fetched_at: cached.rows[0].fetched_at, data: cached.rows[0].data });
      }
    }

    // Mock mode
    if (process.env.FIDS_DEV_MOCK === 'true') {
      const mockData = getFidsMockData(airport, type);
      await pool.query(
        `INSERT INTO fids_cache (airport, type, data, fetched_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (airport, type) DO UPDATE SET data = $3, fetched_at = NOW()`,
        [airport, type, JSON.stringify(mockData)]
      );
      console.log(`fids.cache.mock airport=${airport} type=${type}`);
      return res.json({ stale: false, fetched_at: new Date(), data: mockData });
    }

    // P1: llamada real a AviationStack (HTTP desde Node.js — ok desde server-side)
    const param  = type === 'departures' ? 'dep_iata' : 'arr_iata';
    const apiUrl = `http://api.aviationstack.com/v1/flights?access_key=${process.env.AVIATIONSTACK_KEY}&${param}=${airport}&limit=50`;
    console.log(`fids.proxy.called airport=${airport} type=${type}`);
    const r = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`AviationStack HTTP ${r.status}`);
    const raw = await r.json();
    if (raw.error) throw new Error(`AviationStack: ${raw.error.message}`);

    // P3: deduplicar codeshares antes de cachear
    const flights = (raw.data || []).filter(f => !f.flight.codeshared);

    await pool.query(
      `INSERT INTO fids_cache (airport, type, data, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (airport, type) DO UPDATE SET data = $3, fetched_at = NOW()`,
      [airport, type, JSON.stringify(flights)]
    );
    res.json({ stale: false, fetched_at: new Date(), data: flights });

  } catch (err) {
    console.error(`❌ /api/fids proxy airport=${req.params.airport}:`, err.message);
    // P5: degradación elegante — devolver caché vencida si existe
    try {
      const stale = await pool.query(
        `SELECT data, fetched_at FROM fids_cache WHERE airport = $1 AND type = $2`,
        [(req.params.airport || '').toUpperCase(), req.params.type]
      );
      if (stale.rowCount) {
        console.log(`fids.cache.stale airport=${req.params.airport} type=${req.params.type}`);
        return res.json({ stale: true, fetched_at: stale.rows[0].fetched_at, data: stale.rows[0].data });
      }
    } catch (_) {}
    res.status(502).json({ error: 'Datos de vuelos no disponibles' });
  }
});

// FIDS Cron — refresca aeropuertos activos cada 60s y emite via Socket.io
// F1: soporta type='combined' (expande a dep+arr, emite { type, departures, arrivals })
setInterval(async () => {
  if (process.env.FIDS_DEV_MOCK !== 'true' && !process.env.AVIATIONSTACK_KEY) return;
  try {
    const allGroups = (await pool.query(`SELECT airport, type, id AS group_id FROM fids_groups`)).rows;
    if (!allGroups.length) return;

    const ttl = parseInt(process.env.FIDS_CACHE_TTL_SECONDS || '300');

    // Expandir 'combined' → ['departures','arrivals'] para fetch; deduplicar pares
    const seen = new Set();
    const pairs = [];
    for (const g of allGroups) {
      const types = g.type === 'combined' ? ['departures', 'arrivals'] : [g.type];
      for (const t of types) {
        const k = `${g.airport}:${t}`;
        if (!seen.has(k)) { seen.add(k); pairs.push({ airport: g.airport, type: t }); }
      }
    }

    const fetched = {}; // { 'AXM:departures': { flights, fetchedAt }, ... }

    for (const { airport, type } of pairs) {
      try {
        const cached = await pool.query(
          `SELECT fetched_at FROM fids_cache WHERE airport = $1 AND type = $2`,
          [airport, type]
        );
        if (cached.rowCount) {
          const age = (Date.now() - new Date(cached.rows[0].fetched_at).getTime()) / 1000;
          if (age < ttl) {
            // Caché vigente — leer data para emitir
            const d = await pool.query(
              `SELECT data, fetched_at FROM fids_cache WHERE airport = $1 AND type = $2`,
              [airport, type]
            );
            if (d.rowCount) fetched[`${airport}:${type}`] = { flights: d.rows[0].data, fetchedAt: new Date(d.rows[0].fetched_at) };
            continue;
          }
        }

        let flights;
        if (process.env.FIDS_DEV_MOCK === 'true') {
          flights = getFidsMockData(airport, type);
        } else {
          const param = type === 'departures' ? 'dep_iata' : 'arr_iata';
          const r = await fetch(
            `http://api.aviationstack.com/v1/flights?access_key=${process.env.AVIATIONSTACK_KEY}&${param}=${airport}&limit=50`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!r.ok) { console.error(`fids.cron: AviationStack ${r.status} airport=${airport}`); continue; }
          const raw = await r.json();
          if (raw.error) { console.error(`fids.cron: API error airport=${airport}:`, raw.error.message); continue; }
          flights = (raw.data || []).filter(f => !f.flight.codeshared); // P3: dedup codeshares
          console.log(`fids.proxy.called airport=${airport} type=${type} (cron)`);
        }

        const fetchedAt = new Date();
        await pool.query(
          `INSERT INTO fids_cache (airport, type, data, fetched_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (airport, type) DO UPDATE SET data = $3, fetched_at = NOW()`,
          [airport, type, JSON.stringify(flights)]
        );
        fetched[`${airport}:${type}`] = { flights, fetchedAt };
      } catch (e) {
        console.error(`fids.cron: error airport=${airport} type=${type}:`, e.message);
      }
    }

    // Emitir a cada grupo con formato adecuado (single o combined)
    for (const g of allGroups) {
      if (g.type === 'combined') {
        const dep = fetched[`${g.airport}:departures`];
        const arr = fetched[`${g.airport}:arrivals`];
        if (dep && arr) {
          io.to(`fids_group_${g.group_id}`).emit('fids:update', {
            type: 'combined',
            departures: dep.flights,
            arrivals:   arr.flights,
            fetched_at: dep.fetchedAt,
          });
        }
      } else {
        const d = fetched[`${g.airport}:${g.type}`];
        if (d) {
          io.to(`fids_group_${g.group_id}`).emit('fids:update', {
            type:      g.type,
            flights:   d.flights,
            fetched_at: d.fetchedAt,
          });
        }
      }
    }

    if (pairs.length) {
      console.log(`fids.cron.tick airports=[${pairs.map(p => `${p.airport}:${p.type}`).join(',')}]`);
    }
  } catch (e) {
    console.error('fids.cron.tick error:', e.message);
  }
}, 60 * 1000);


// FIDS Socket.io — dispositivos se unen a su sala de grupo (F1)
io.on('connection', (socket) => {
  socket.on('fids:join', ({ device_id, group_id } = {}) => {
    if (!group_id) return;
    socket.join(`fids_group_${group_id}`);
    console.log(`fids.display.connected device=${device_id} group=${group_id} socket=${socket.id}`);
  });
});


// ════════════════════════════════════════════════════════════
// FIDS F2 — Admin endpoints (SONORO ops only)
// ════════════════════════════════════════════════════════════

// GET /api/admin/fids/groups — lista grupos con device_count
app.get('/api/admin/fids/groups', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.*,
             COUNT(d.id) FILTER (WHERE d.fids_role IS DISTINCT FROM 'slave') AS device_count,
             COUNT(d.id) FILTER (
               WHERE d.fids_role IS DISTINCT FROM 'slave'
               AND d.status = 'online'
               AND d.last_seen > NOW() - INTERVAL '90 seconds'
             )                                                  AS online_count,
             MIN(d.device_id) FILTER (WHERE d.fids_role = 'master') AS sample_device_id,
             COALESCE(
               JSON_AGG(JSON_BUILD_OBJECT('device_id', d.device_id, 'name', d.name) ORDER BY d.id)
               FILTER (WHERE d.fids_role = 'slave'), '[]'::json
             ) AS slaves
      FROM fids_groups g
      LEFT JOIN devices d ON d.fids_group_id = g.id
      GROUP BY g.id
      ORDER BY g.id
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('fids.admin.groups.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/admin/fids/groups — crear grupo
app.post('/api/admin/fids/groups', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, airport, type, filters = {}, lower_thirds = { mode: 'off' } } = req.body;
    if (!name || !airport || !type) return res.status(400).json({ error: 'name, airport y type son obligatorios' });
    const validTypes = ['departures', 'arrivals', 'combined'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `type debe ser uno de: ${validTypes.join(', ')}` });
    const result = await pool.query(
      `INSERT INTO fids_groups (user_id, name, airport, type, filters, lower_thirds)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, name.trim(), airport.toUpperCase(), type, JSON.stringify(filters), JSON.stringify(lower_thirds)]
    );
    console.log(`fids.group.created group=${result.rows[0].id} airport=${airport} type=${type}`);
    res.json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un grupo con ese nombre' });
    console.error('fids.admin.groups.post:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /api/admin/fids/groups/:id — actualizar grupo
app.put('/api/admin/fids/groups/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, airport, type, filters = {}, lower_thirds = { mode: 'off' } } = req.body;
    if (!name || !airport || !type) return res.status(400).json({ error: 'name, airport y type son obligatorios' });
    const result = await pool.query(
      `UPDATE fids_groups SET name=$1, airport=$2, type=$3, filters=$4, lower_thirds=$5
       WHERE id=$6 RETURNING *`,
      [name.trim(), airport.toUpperCase(), type, JSON.stringify(filters), JSON.stringify(lower_thirds), id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Grupo no encontrado' });
    console.log(`fids.group.updated group=${id}`);
    res.json({ success: true, group: result.rows[0] });
  } catch (e) {
    console.error('fids.admin.groups.put:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/groups/:id — eliminar grupo
app.delete('/api/admin/fids/groups/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Desasignar dispositivos primero
    await pool.query(
      `UPDATE devices SET fids_group_id = NULL, fids_role = NULL WHERE fids_group_id = $1`,
      [id]
    );
    const result = await pool.query(`DELETE FROM fids_groups WHERE id = $1`, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Grupo no encontrado' });
    console.log(`fids.group.deleted group=${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('fids.admin.groups.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/admin/fids/groups/:id/slave — generar enlace esclavo
app.post('/api/admin/fids/groups/:id/slave', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const group = await pool.query('SELECT id, name FROM fids_groups WHERE id = $1', [groupId]);
    if (!group.rowCount) return res.status(404).json({ error: 'Grupo no encontrado' });
    const existing = await pool.query(
      "SELECT device_id, name FROM devices WHERE fids_group_id = $1 AND fids_role = 'slave' LIMIT 1",
      [groupId]
    );
    if (existing.rowCount) {
      return res.json({ device_id: existing.rows[0].device_id, name: existing.rows[0].name, reused: true });
    }
    const deviceId = 'fids_' + require('crypto').randomUUID().replace(/-/g, '');
    const slaveName = group.rows[0].name + ' — Enlace esclavo';
    await pool.query(
      `INSERT INTO devices (device_id, name, user_id, fids_group_id, fids_role, status)
       VALUES ($1, $2, $3, $4, 'slave', 'offline')`,
      [deviceId, slaveName, req.user.id, groupId]
    );
    console.log(`fids.slave.created group=${groupId} device=${deviceId}`);
    res.json({ device_id: deviceId, name: slaveName });
  } catch (e) {
    console.error('fids.admin.slave.post:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/slaves/:deviceId — revocar enlace esclavo
app.delete('/api/admin/fids/slaves/:deviceId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM devices WHERE device_id = $1 AND fids_role = 'slave' RETURNING id",
      [req.params.deviceId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Esclavo no encontrado' });
    console.log(`fids.slave.deleted device=${req.params.deviceId}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('fids.admin.slave.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/admin/fids/devices — todos los dispositivos con info FIDS
app.get('/api/admin/fids/devices', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.device_id, d.name, d.status, d.last_seen, d.fids_group_id, d.fids_role,
             g.name AS group_name, g.airport, g.type AS group_type
      FROM devices d
      LEFT JOIN fids_groups g ON g.id = d.fids_group_id
      ORDER BY d.fids_group_id NULLS LAST, d.name
    `);
    res.json(result.rows);
  } catch (e) {
    console.error('fids.admin.devices.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /api/admin/fids/devices/:deviceId — asignar/desasignar dispositivo
app.put('/api/admin/fids/devices/:deviceId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { fids_group_id, fids_role } = req.body;
    const result = await pool.query(
      `UPDATE devices SET fids_group_id = $1, fids_role = $2 WHERE device_id = $3 RETURNING device_id, fids_group_id, fids_role`,
      [fids_group_id || null, fids_role || null, deviceId]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    console.log(`fids.device.assigned device=${deviceId} group=${fids_group_id} role=${fids_role}`);
    res.json({ success: true, device: result.rows[0] });
  } catch (e) {
    console.error('fids.admin.devices.put:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/admin/fids/cache — estado de fids_cache
app.get('/api/admin/fids/cache', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT airport, type, fetched_at,
             jsonb_array_length(data) AS flight_count,
             EXTRACT(EPOCH FROM (NOW() - fetched_at))::INTEGER AS age_sec
      FROM fids_cache
      ORDER BY airport, type
    `);
    res.json({
      mock_mode: process.env.FIDS_DEV_MOCK === 'true',
      entries: result.rows,
    });
  } catch (e) {
    console.error('fids.admin.cache.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/cache/:airport/:type — invalidar caché (forzar refresh en próximo cron)
app.delete('/api/admin/fids/cache/:airport/:type', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { airport, type } = req.params;
    await pool.query(`DELETE FROM fids_cache WHERE airport = $1 AND type = $2`, [airport.toUpperCase(), type]);
    console.log(`fids.cache.invalidated airport=${airport} type=${type}`);
    res.json({ success: true });
  } catch (e) {
    console.error('fids.admin.cache.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FIDS MEDIA LIBRARY — F2b: librería exclusiva FIDS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/fids/media
app.get('/api/admin/fids/media', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, filename, file_path, type, size_bytes, duration_ms, width, height, uploaded_at
       FROM fids_media WHERE user_id = $1 ORDER BY uploaded_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('fids.media.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/admin/fids/media — upload
app.post('/api/admin/fids/media', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!req.files || !req.files.file) return res.status(400).json({ error: 'No se recibio archivo' });
    const file = req.files.file;
    const ext  = file.name.split('.').pop().toLowerCase();
    const type = ['mp4','mov','avi','mkv','webm'].includes(ext) ? 'video' : 'image';
    const safeName = Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = require('path').join(__dirname, '../uploads', safeName);
    await file.mv(dest);
    const filePath = '/uploads/' + safeName;
    const result = await pool.query(
      `INSERT INTO fids_media (user_id, title, filename, file_path, type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, filename, file_path, type, size_bytes, duration_ms, uploaded_at`,
      [req.user.id, file.name, safeName, filePath, type, file.size]
    );
    console.log(`fids.media.uploaded id=${result.rows[0].id} type=${type}`);
    res.json(result.rows[0]);
  } catch (e) {
    console.error('fids.media.post:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/media/:id
app.delete('/api/admin/fids/media/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const row = await pool.query(
      `SELECT file_path FROM fids_media WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!row.rowCount) return res.status(404).json({ error: 'No encontrado' });
    const filePath = require('path').join(__dirname, '..', row.rows[0].file_path);
    require('fs').unlink(filePath, () => {});
    await pool.query(`DELETE FROM fids_media WHERE id = $1`, [id]);
    console.log(`fids.media.deleted id=${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('fids.media.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/admin/fids/playlists
app.get('/api/admin/fids/playlists', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.name, p.created_at, p.updated_at,
              COUNT(pi.id)::int AS item_count
       FROM fids_playlists p
       LEFT JOIN fids_playlist_items pi ON pi.playlist_id = p.id
       WHERE p.user_id = $1
       GROUP BY p.id ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('fids.playlists.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// POST /api/admin/fids/playlists
app.post('/api/admin/fids/playlists', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, items = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const pl = await pool.query(
      `INSERT INTO fids_playlists (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
      [req.user.id, name]
    );
    const plId = pl.rows[0].id;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await pool.query(
        `INSERT INTO fids_playlist_items (playlist_id, media_id, display_order, duration_override_ms)
         VALUES ($1, $2, $3, $4)`,
        [plId, it.media_id, it.display_order != null ? it.display_order : i + 1, it.duration_override_ms != null ? it.duration_override_ms : null]
      );
    }
    console.log(`fids.playlist.created id=${plId} items=${items.length}`);
    res.json({ id: plId, name, item_count: items.length });
  } catch (e) {
    console.error('fids.playlists.post:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /api/admin/fids/playlists/:id
app.put('/api/admin/fids/playlists/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, items } = req.body;
    const own = await pool.query(
      `SELECT id FROM fids_playlists WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'No encontrado' });
    if (name) {
      await pool.query(
        `UPDATE fids_playlists SET name = $1, updated_at = NOW() WHERE id = $2`,
        [name, id]
      );
    }
    if (items) {
      await pool.query(`DELETE FROM fids_playlist_items WHERE playlist_id = $1`, [id]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await pool.query(
          `INSERT INTO fids_playlist_items (playlist_id, media_id, display_order, duration_override_ms)
           VALUES ($1, $2, $3, $4)`,
          [id, it.media_id, it.display_order != null ? it.display_order : i + 1, it.duration_override_ms != null ? it.duration_override_ms : null]
        );
      }
    }
    console.log(`fids.playlist.updated id=${id}`);
    res.json({ success: true, id: parseInt(id) });
  } catch (e) {
    console.error('fids.playlists.put:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/playlists/:id
app.delete('/api/admin/fids/playlists/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const own = await pool.query(
      `SELECT id FROM fids_playlists WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'No encontrado' });
    await pool.query(`DELETE FROM fids_playlists WHERE id = $1`, [id]);
    console.log(`fids.playlist.deleted id=${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error('fids.playlists.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/admin/fids/playlists/:id/items
app.get('/api/admin/fids/playlists/:id/items', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const own = await pool.query(
      `SELECT id FROM fids_playlists WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'No encontrado' });
    const result = await pool.query(
      `SELECT pi.id, pi.media_id, pi.display_order, pi.duration_override_ms,
              m.title, m.type, m.file_path, m.size_bytes, m.duration_ms
       FROM fids_playlist_items pi
       JOIN fids_media m ON m.id = pi.media_id
       WHERE pi.playlist_id = $1
       ORDER BY pi.display_order`,
      [id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('fids.playlist.items.get:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// PUT /api/admin/fids/playlists/:id/items — full replace
app.put('/api/admin/fids/playlists/:id/items', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { items = [] } = req.body;
    const own = await pool.query(
      `SELECT id FROM fids_playlists WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'No encontrado' });
    await pool.query(`DELETE FROM fids_playlist_items WHERE playlist_id = $1`, [id]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await pool.query(
        `INSERT INTO fids_playlist_items (playlist_id, media_id, display_order, duration_override_ms)
         VALUES ($1, $2, $3, $4)`,
        [id, it.media_id, it.display_order != null ? it.display_order : i + 1, it.duration_override_ms != null ? it.duration_override_ms : null]
      );
    }
    await pool.query(`UPDATE fids_playlists SET updated_at = NOW() WHERE id = $1`, [id]);
    console.log(`fids.playlist.items.replaced id=${id} items=${items.length}`);
    res.json({ success: true });
  } catch (e) {
    console.error('fids.playlist.items.put:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

// DELETE /api/admin/fids/playlists/:id/items/:mediaId
app.delete('/api/admin/fids/playlists/:id/items/:mediaId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, mediaId } = req.params;
    const own = await pool.query(
      `SELECT id FROM fids_playlists WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!own.rowCount) return res.status(404).json({ error: 'No encontrado' });
    await pool.query(
      `DELETE FROM fids_playlist_items WHERE playlist_id = $1 AND media_id = $2`,
      [id, mediaId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('fids.playlist.items.delete:', e.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

const mailerRouter = require('./routes/mailer');
app.use(mailerRouter);

// ============================================================
// 📼 HEVC AUTO-WORKER — convierte videos pendientes cada 5 min
// ============================================================
let hevcWorkerRunning = false;
let hevcStartupRecoveryDone = false;

async function runHevcWorker() {
  if (hevcWorkerRunning) {
    console.log('📼 HEVC worker: ya hay una conversion en curso, saltando ciclo');
    return;
  }
  hevcWorkerRunning = true;
  try {
    // Recovery: una sola vez al arrancar, resetear items atascados en processing
    if (!hevcStartupRecoveryDone) {
      hevcStartupRecoveryDone = true;
      try {
        const stale = await pool.query(
          "UPDATE content SET hevc_status='pending', hevc_error='reset after stale processing' WHERE hevc_status='processing' RETURNING id"
        );
        if (stale.rowCount > 0) {
          console.log('📼 HEVC worker startup recovery: reset ' + stale.rowCount + ' item(s) atascado(s) en processing ->', stale.rows.map(r => r.id));
        }
      } catch (recoveryErr) {
        console.error('📼 HEVC worker recovery error:', recoveryErr.message);
      }
    }

    const pending = await pool.query(
      `SELECT c.id, c.file_path, c.filename, c.type,
              COALESCE(MAX(pi.duration_override_ms), c.duration_ms, 30000) AS duration_ms
       FROM content c
       LEFT JOIN playlist_items pi ON pi.content_id = c.id
       WHERE c.hevc_status = 'pending'
         AND c.type IN ('video', 'image')
       GROUP BY c.id
       LIMIT 1`
    );
    if (pending.rows.length === 0) {
      hevcWorkerRunning = false;
      return;
    }
    const item = pending.rows[0];

    // Marcar como processing ANTES de lanzar ffmpeg para evitar reentrada tras restart
    await pool.query("UPDATE content SET hevc_status='processing' WHERE id=$1", [item.id]);

    const srcPath = '/opt/sonoro-cms/backend' + item.file_path;
    console.log('📼 HEVC worker: procesando id=' + item.id + ' src=' + srcPath);

    if (!require('fs').existsSync(srcPath)) {
      await pool.query(
        "UPDATE content SET hevc_status='error', hevc_error=$1 WHERE id=$2",
        ['Archivo fuente no encontrado en disco: ' + srcPath, item.id]
      );
      console.error('📼 HEVC worker: archivo no existe, marcado error id=' + item.id);
      hevcWorkerRunning = false;
      return;
    }

    const baseName = item.filename.replace(/.[^.]+$/, '');
    const hevcFilename = baseName + '-hevc.mp4';
    const hevcPath = '/opt/sonoro-cms/backend/uploads/' + hevcFilename;
    const hevcFilePath = '/uploads/' + hevcFilename;

    // Detectar dimensiones del archivo fuente para determinar orientación
    const srcDims = await new Promise((res) => {
      const { spawn } = require('child_process');
      const probe = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0', srcPath
      ], { stdio: 'pipe' });
      let out = '';
      probe.stdout.on('data', d => { out += d.toString(); });
      probe.on('exit', () => {
        const parts = out.trim().split(',');
        const w = parseInt(parts[0]) || 1920;
        const h = parseInt(parts[1]) || 1080;
        res({ w, h });
      });
      probe.on('error', () => res({ w: 1920, h: 1080 }));
    });
    const isVertical = srcDims.h > srcDims.w;
    const TW = 1920;
    const TH = 1080;
    const orientation = isVertical ? 'vertical' : 'horizontal';
    const scaleFilter = `${isVertical?"transpose=2,":""}scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1`;
    console.log(`📼 HEVC worker: src=${srcDims.w}x${srcDims.h} → ${TW}x${TH} (${orientation})`);
    await pool.query("UPDATE content SET orientation=$1 WHERE id=$2", [orientation, item.id]);

    await new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      let args;
      if (item.type === 'image') {
        const durSec = Math.ceil((item.duration_ms || 30000) / 1000);
        args = [
          '-loop', '1',
          '-i', srcPath,
          '-t', String(durSec),
          '-vf', scaleFilter,
          '-r', '25',
          '-color_range', 'tv',
          '-c:v', 'libx265',
          '-preset', 'ultrafast',
          '-crf', '28',
          '-x265-params', 'repeat-headers=1',
          '-map_metadata', '-1',
          '-map_chapters', '-1',
          '-an',
          '-movflags', '+faststart',
          '-y',
          hevcPath
        ];
      } else {
        args = [
          '-y',
          '-i', srcPath,
          '-c:v', 'libx265',
          '-preset', 'fast',
          '-crf', '28',
          '-x265-params', 'repeat-headers=1',
          '-map', '0:v:0',
          '-map_metadata', '-1',
          '-map_chapters', '-1',
          '-vf', scaleFilter,
          '-r', '25',
          '-an',
          hevcPath
        ];
      }
      console.log('📼 HEVC worker: ffmpeg', args.join(' '));
      const proc = spawn('ffmpeg', args, { stdio: 'pipe' });
      let totalSec = item.type === 'image'
        ? Math.ceil((item.duration_ms || 30000) / 1000)
        : Math.max(1, (item.duration_ms || 30000) / 1000);
      let lastProgressEmit = 0;
      proc.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        const m = str.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) {
          const cur = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseFloat(m[3]);
          const pct = Math.min(99, Math.round(cur / totalSec * 100));
          const now = Date.now();
          if (now - lastProgressEmit > 1000) {
            lastProgressEmit = now;
            io.emit('hevc_progress', { content_id: item.id, percent: pct });
          }
        }
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg exit code ' + code));
      });
      proc.on('error', reject);
    });

    const hevcSize = require('fs').statSync(hevcPath).size;
    await pool.query(
      "UPDATE content SET hevc_status='ready', hevc_file_path=$1, hevc_size_bytes=$2, hevc_generated_at=NOW() WHERE id=$3",
      [hevcFilePath, hevcSize, item.id]
    );
    console.log('📼 HEVC worker: conversion OK id=' + item.id + ' -> ' + hevcFilename + ' (' + (hevcSize / 1024 / 1024).toFixed(1) + ' MB)');

    // Notificar al dashboard y refrescar dispositivos asignados
    io.emit('hevc_complete', { content_id: item.id, filename: hevcFilename });

    // S177: warning si orientación del contenido no coincide con la del dispositivo
    try {
      const contentOrientation = item.orientation || 'horizontal';
      const devicesWithMismatch = await pool.query(
        `SELECT DISTINCT d.device_id, d.name, d.orientation_hdmi0, d.orientation_hdmi1, d.user_id
         FROM devices d
         JOIN playlists pl ON d.hdmi0_playlist_id = pl.id OR d.hdmi1_playlist_id = pl.id
         JOIN playlist_items pi ON pi.playlist_id = pl.id
         WHERE pi.content_id = $1
           AND (
             (d.hdmi0_playlist_id IS NOT NULL AND d.orientation_hdmi0 != $2) OR
             (d.hdmi1_playlist_id IS NOT NULL AND d.orientation_hdmi1 != $2)
           )`,
        [item.id, contentOrientation]
      );
      for (const dev of devicesWithMismatch.rows) {
        const userSockets = io.sockets.adapter.rooms.get('user_' + dev.user_id);
        if (userSockets) {
          io.to('user_' + dev.user_id).emit('hevc_orientation_warning', {
            content_id: item.id,
            content_orientation: contentOrientation,
            device_name: dev.name,
            device_id: dev.device_id
          });
          console.log('⚠️ Orientacion mismatch: content=' + contentOrientation + ' device=' + dev.device_id);
        }
      }
    } catch (e) { console.error('⚠️ Error check orientacion:', e.message); }
    try {
      const affectedDevices = await pool.query(
        `SELECT DISTINCT d.device_id FROM devices d
         JOIN playlists pl ON d.hdmi0_playlist_id = pl.id OR d.hdmi1_playlist_id = pl.id
         JOIN playlist_items pi ON pi.playlist_id = pl.id
         WHERE pi.content_id = $1`,
        [item.id]
      );
      for (const dev of affectedDevices.rows) {
        io.to('device_' + dev.device_id).emit('cmd_refresh_playlist');
        console.log('📼 HEVC worker: cmd_refresh_playlist emitido a ' + dev.device_id);
      }
    } catch (e) { console.error('📼 HEVC worker: error emitiendo refresh:', e.message); }

  } catch (workerErr) {
    console.error('📼 HEVC worker error:', workerErr.message);
    try {
      const failedItem = await pool.query(
        "SELECT id FROM content WHERE hevc_status='pending' LIMIT 1"
      );
      if (failedItem.rows.length > 0) {
        await pool.query(
          "UPDATE content SET hevc_status='error', hevc_error=$1 WHERE id=$2",
          [workerErr.message, failedItem.rows[0].id]
        );
      }
    } catch (_) {}
  } finally {
    hevcWorkerRunning = false;
    // Si quedan pendientes, procesar el siguiente inmediatamente
    try {
      const next = await pool.query("SELECT id FROM content WHERE hevc_status='pending' LIMIT 1");
      if (next.rows.length > 0) setImmediate(runHevcWorker);
    } catch (_) {}
  }
}

setInterval(runHevcWorker, 5 * 60 * 1000);
setImmediate(runHevcWorker); // procesar pendientes al arrancar
console.log('📼 HEVC auto-worker iniciado (cada 5 min)');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CMS Backend v2.1 escuchando en puerto ${PORT}`);
  console.log(`✅ Autenticación JWT HABILITADA`);
  console.log(`✅ Conversión automática de videos HABILITADA`);
  console.log(`✅ Socket.io HABILITADO para barra de progreso`);
  console.log(`✅ Redis conectado para cola de trabajos`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📄 Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`\n⚙️ Endpoints de autenticación:`);
  console.log(`   POST /api/auth/register - Registrar usuario`);
  console.log(`   POST /api/auth/login - Login`);
  console.log(`\n⚙️ Codecs soportados:`);
  console.log(`   - H.264/AVC (sin conversión)`);
  console.log(`   - H.265/HEVC (convertirá a H.264)`);
  console.log(`   - VP9 (convertirá a H.264)`);
  console.log(`   - AV1 (convertirá a H.264)`);
  console.log(`\n`);
});