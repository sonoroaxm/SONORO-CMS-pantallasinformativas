
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
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const emailService = require('./services/email');


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



const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6
});

// ⭐ GUARDAR IO EN GLOBAL PARA QUE LA COLA PUEDA EMITIR EVENTOS
global.io = io;

// Mapa de callbacks pendientes de screenshot por device_id
const screenshotCallbacks = new Map();

// Mapa de callbacks pendientes de TV control por device_id
const tvCallbacks = new Map();

// Funcion TV control via Socket.io + HTTP result
async function doTV(deviceId, action) {
  console.log(`📺 TV ${action} -> ${deviceId} via Socket.io`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      tvCallbacks.delete(deviceId);
      reject(new Error(`TV timeout — RPi no respondio en 45s`));
    }, 45000);
    tvCallbacks.set(deviceId, { resolve, reject, timeout, action });
    io.to(`device_${deviceId}`).emit('tv_request', { device_id: deviceId, action });
  });
}

// ========================================
// MIDDLEWARE
// ========================================
app.use(cors());
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

console.log('✅ Dashboard: http://localhost:5000/dashboard.html');
console.log('✅ Uploads: http://localhost:5000/uploads/');

// ========================================
// DATABASE (CON POOL - CONEXIONES MÚLTIPLES)
// ========================================
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'cms_signage',
  password: process.env.DB_PASSWORD || 'postgres123',
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
  .then(() => console.log('✅ Migraciones OK (counters + tv_schedules + content + playlist_items + playlists + devices)'))
  .catch(err => console.error('❌ Error PostgreSQL:', err));
emailService.verifyConnection();


// GUARDAR POOL EN GLOBAL PARA ADMIN ROUTES (NUEVO)
global.pool = pool;

// ========================================
// CONFIGURACIÓN JWT
// ========================================
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
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

// ========================================
// FUNCIONES DE UTILIDAD
// ========================================

async function getVideoCodec(filepath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filepath}"`,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error('No se pudo detectar codec'));
          return;
        }
        resolve(stdout.trim().toLowerCase());
      }
    );
  });
}

async function getVideoDimensions(filepath) {
  return new Promise((resolve) => {
    exec(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filepath}"`,
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ width: 1920, height: 1080 });
          return;
        }
        const parts = stdout.trim().split('x');
        resolve({ width: parseInt(parts[0]) || 1920, height: parseInt(parts[1]) || 1080 });
      }
    );
  });
}

async function getVideoDuration(filepath) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filepath}"`,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error('No se pudo obtener duración'));
          return;
        }
        const duration = parseFloat(stdout) * 1000;
        resolve(Math.round(duration));
      }
    );
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
    const ffmpegCmd = `C:\\ffmpeg\\bin\\ffmpeg.exe -i "${inputPath}" -c:v libx264 -preset fast -profile:v baseline -level 4.1 -vf "${scaleFilter}" -b:v 4000k -maxrate 4000k -bufsize 8000k -c:a aac -b:a 128k -movflags +faststart -y "${outputPath}"`;

    const child = exec(ffmpegCmd, { windowsHide: true }, (error, stdout, stderr) => {
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
  return new Promise((resolve, reject) => {
    const ffmpegCmd = `ffmpeg -i "${videoPath}" -ss 1 -vframes 1 -vf "scale=320:180" -q:v 5 -y "${thumbnailPath}"`;

    exec(ffmpegCmd, { windowsHide: true }, (error) => {
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

app.post('/api/auth/register', async (req, res) => {
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

    // Insertar usuario
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hashedPassword, name || email]
    );

    const user = result.rows[0];

    // Generar JWT
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`✅ Usuario registrado: ${email}`);

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' });
    }

    // Buscar usuario
    const result = await pool.query('SELECT id, email, password, name FROM users WHERE email = $1', [email]);

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
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    console.log(`✅ Login exitoso: ${email}`);

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: err.message });
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
    const allowedMimes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'image/jpeg', 'image/png'];

    if (!allowedMimes.some(mime => file.mimetype.includes(mime.split('/')[0]))) {
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
    res.status(500).json({ error: err.message });
  }
});

async function handleImageUpload(tempPath, fileId, originalName, userId) {
  try {
    const filename = `${Date.now()}-${originalName}`;
    const finalPath = path.join(process.cwd(), 'uploads', filename);

    fs.renameSync(tempPath, finalPath);

    const result = await pool.query(
      `INSERT INTO content (user_id, title, type, filename, file_path, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, originalName, 'image', filename, `/uploads/${filename}`, fs.statSync(finalPath).size]
    );

    console.log('✅ Imagen procesada:', result.rows[0].id);
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

    let finalPath = tempPath;
    let finalFilename = `${Date.now()}-${originalName}`;

    if (needsConversion(codec)) {
      console.log(`⚠️ Video necesita conversión (${codec} → H.264)`);

      finalFilename = `converted-${fileId}.mp4`;
      const convertedPath = path.join(process.cwd(), 'uploads', finalFilename);

      await convertVideoToH264(tempPath, convertedPath);

      // ⚠️ Cola RPi4 deshabilitada (Redis no disponible)
      console.log('⚠️  Video guardado sin optimización RPi4 (Redis no instalado)');

      finalPath = convertedPath;

    } else {
      console.log('✅ Video ya está en H.264, copiando...');
      finalPath = path.join(process.cwd(), 'uploads', finalFilename);
      fs.renameSync(tempPath, finalPath);

      // ⚠️ Cola RPi4 deshabilitada (Redis no disponible)
      console.log('⚠️  Video guardado sin optimización RPi4 (Redis no instalado)');
    }

    // Generar thumbnail
    const thumbnailPath = path.join(process.cwd(), 'uploads', `thumb-${fileId}.jpg`);
    await generateThumbnail(finalPath, thumbnailPath);

    // ✅ GUARDAR EN BASE DE DATOS (UNA SOLA VEZ)
    const result = await pool.query(
      `INSERT INTO content (user_id, title, type, filename, file_path, size_bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        userId,
        originalName,
        'video',
        finalFilename,
        `/uploads/${finalFilename}`,
        fs.statSync(finalPath).size,
        duration
      ]
    );

    console.log('✅ Video guardado en BD:', result.rows[0].id);

    io.emit('upload_complete', {
      success: true,
      content: result.rows[0],
      fileId,
      codec: codec,
      duration: duration,
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
      'SELECT id, title, type, filename, file_path, size_bytes, duration_ms, uploaded_at FROM content WHERE user_id = $1 ORDER BY uploaded_at DESC',
      [req.user.id] // ✅ Filtrar por usuario autenticado
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get content error:', err);
    res.status(500).json({ error: err.message });
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
      'SELECT filename FROM content WHERE id = $1 AND user_id = $2',
      [id, userId] // ✅ Verificar que sea propietario
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    const filename = result.rows[0].filename;
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const filepath = path.join(uploadsDir, filename);

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

    res.json({ success: true, message: 'Archivo eliminado' });
  } catch (err) {
    console.error('❌ Delete error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// POST - Agregar contenido a una playlist
app.post('/api/playlists/:playlistId/items', authenticateToken, async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { content_id, duration_override_ms } = req.body;
    const userId = req.user.id;

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist no encontrada' });
    }

    const contentCheck = await pool.query(
      'SELECT id FROM content WHERE id = $1 AND user_id = $2',
      [content_id, userId]
    );

    if (contentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Contenido no encontrado' });
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
    res.status(500).json({ error: err.message });
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
      `UPDATE playlist_items
       SET display_order = ROW_NUMBER() OVER (ORDER BY display_order)
       WHERE playlist_id = $1`,
      [playlistId]
    );

    res.json({ success: true, message: 'Contenido eliminado de la playlist' });
    console.log(`✅ Contenido eliminado de playlist: ${playlistId}`);
  } catch (err) {
    console.error('❌ Error eliminando contenido de playlist:', err);
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
    res.status(500).json({ error: err.message });
  }
});

// ADMIN ROUTES (NUEVO)
// ========================================
// ========================================
// DEVICE API - RPi4 Management
// ========================================

// POST - Registrar o actualizar dispositivo (sin JWT - llamado desde RPi4)
app.post('/api/devices/register', async (req, res) => {
  try {
    const { device_id, name, ip_address, display_mode, hdmi0_playlist_id, hdmi1_playlist_id } = req.body;

    if (!device_id) {
      return res.status(400).json({ error: 'device_id requerido' });
    }

    const result = await pool.query(
      `INSERT INTO devices (device_id, name, ip_address, display_mode, hdmi0_playlist_id, hdmi1_playlist_id, status, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, 'online', CURRENT_TIMESTAMP)
       ON CONFLICT (device_id) DO UPDATE SET
         name = COALESCE($2, devices.name),
         ip_address = $3,
         status = 'online',
         last_seen = CURRENT_TIMESTAMP
       RETURNING *`,
      [device_id, name || device_id, ip_address, display_mode || 'mirror', hdmi0_playlist_id || null, hdmi1_playlist_id || null]
    );

    res.json({ success: true, device: result.rows[0] });
    console.log(`✅ Dispositivo registrado: ${device_id} (${ip_address})`);
  } catch (err) {
    console.error('❌ Error registrando dispositivo:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET - Obtener configuración de un dispositivo (sin JWT - llamado desde RPi4)
app.get('/api/devices/:device_id/config', async (req, res) => {
  try {
    const { device_id } = req.params;

    const result = await pool.query(
      `SELECT d.*,
              p0.name as hdmi0_playlist_name,
              p1.name as hdmi1_playlist_name,
              (SELECT id FROM branches WHERE user_id = d.user_id LIMIT 1) as branch_id
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
    res.status(500).json({ error: err.message });
  }
});

// POST - Reboot dispositivo via SSH
app.post('/api/devices/reboot', authenticateToken, async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });
  const { exec } = require('child_process');
  exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 sonoro@${ip} "sudo reboot"`, { windowsHide: true }, (error) => {
    if (error) {
      console.warn(`⚠️ Reboot enviado a ${ip} (puede ser normal si SSH cierra):`, error.message);
    }
  });
  console.log(`🔄 Reboot enviado a: ${ip}`);
  res.json({ success: true, message: `Reboot enviado a ${ip}` });
});

// POST - Reboot por device_id
app.post('/api/devices/:device_id/reboot', authenticateToken, async (req, res) => {
  const { device_id } = req.params;
  try {
    const result = await pool.query('SELECT ip_address FROM devices WHERE device_id = $1', [device_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    const ip = result.rows[0].ip_address;
    const { exec } = require('child_process');
    exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes sonoro@${ip} "sudo reboot"`, { windowsHide: true }, (error) => {
      if (error && !error.message.includes('closed') && !error.message.includes('exit')) {
        console.warn(`⚠️ SSH reboot ${ip}:`, error.message);
      }
    });
    console.log(`🔄 Reboot enviado a ${device_id} (${ip})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reboot error:', err.message);
    res.status(500).json({ error: err.message });
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


// ── CONTROL TV CEC ────────────────────────────────────────────
// POST /api/devices/:device_id/tv/:action — via Socket.io (no SSH)
app.post('/api/devices/:device_id/tv/:action', authenticateToken, async (req, res) => {
  const { device_id, action } = req.params;
  const valid = ['on','off','status','hdmi1','hdmi2','hdmi3','mute','unmute'];
  if (!valid.includes(action))
    return res.status(400).json({ success: false, error: 'Accion invalida. Usar: ' + valid.join(' | ') });
  try {
    const result = await pool.query(
      'SELECT name FROM devices WHERE device_id = $1 AND user_id = $2',
      [device_id, req.user.id]
    );
    if (!result.rows.length)
      return res.status(404).json({ success: false, error: 'Dispositivo no encontrado' });
    const output = await doTV(device_id, action);
    res.json({ success: true, device_id, device_name: result.rows[0].name, action, output });
  } catch (err) {
    console.error('TV control error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/rpi/tv — via Socket.io (no SSH)
app.post('/api/admin/rpi/tv', authenticateToken, async (req, res) => {
  const { device_id, action } = req.body;
  const valid = ['on','off','status','hdmi1','hdmi2','hdmi3','mute','unmute'];
  if (!valid.includes(action))
    return res.status(400).json({ success: false, error: 'Accion invalida' });
  if (!device_id)
    return res.status(400).json({ success: false, error: 'device_id requerido' });
  try {
    const output = await doTV(device_id, action);
    res.json({ success: true, device_id, action, output });
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
  console.log(`📺 TV result recibido — device: ${device_id} action: ${action} output: ${output}`);
  // Guardar estado HDMI activo en BD
  if (action && action.startsWith('hdmi') && !error) {
    pool.query('UPDATE devices SET tv_status = $1 WHERE device_id = $2', [action, device_id]).catch(() => {});
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

// POST /api/devices/:device_id/logs-result — RPi envia logs via HTTP
app.post('/api/devices/:device_id/logs-result', async (req, res) => {
  const { device_id } = req.params;
  const { logs, error } = req.body;
  const cb = global.logsCallbacks && global.logsCallbacks.get(device_id);
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
    const result = await pool.query(
      `SELECT d.*,
              p0.name as hdmi0_playlist_name,
              p1.name as hdmi1_playlist_name
       FROM devices d
       LEFT JOIN playlists p0 ON d.hdmi0_playlist_id = p0.id
       LEFT JOIN playlists p1 ON d.hdmi1_playlist_id = p1.id
       ORDER BY d.created_at DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error listando dispositivos:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT - Actualizar configuración de dispositivo (protegido - desde el dashboard)
app.put('/api/devices/:device_id', authenticateToken, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { name, display_mode, hdmi0_playlist_id, hdmi1_playlist_id,
            orientation_hdmi0, orientation_hdmi1,
            videowall_position, videowall_cols, videowall_rows } = req.body;

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
         updated_at = CURRENT_TIMESTAMP
       WHERE device_id = $10
       RETURNING *`,
      [name, display_mode, hdmi0_playlist_id || null, hdmi1_playlist_id || null,
       orientation_hdmi0, orientation_hdmi1,
       videowall_position || null, videowall_cols || null, videowall_rows || null,
       device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    // Notificar al dispositivo via Socket.io
    io.emit(`device-config-update-${device_id}`, result.rows[0]);

    res.json({ success: true, device: result.rows[0] });
    console.log(`✅ Dispositivo actualizado: ${device_id}`);
  } catch (err) {
    console.error('❌ Error actualizando dispositivo:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET - Endpoint público para obtener playlist completa (sin JWT - para RPi4 player)
app.get('/api/player/playlist/:playlistId', async (req, res) => {
  try {
    const { playlistId } = req.params;

    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.shuffle_enabled, p.repeat_enabled,
              pi.id as item_id, pi.content_id, pi.display_order, pi.duration_override_ms,
              c.title, c.type, c.file_path, c.duration_ms
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
        .map(row => ({
          item_id: row.item_id,
          content_id: row.content_id,
          display_order: row.display_order,
          title: row.title,
          type: row.type,
          file_path: row.file_path,
          duration_ms: row.duration_override_ms || row.duration_ms || 15000
        }))
    };

    res.json(playlist);
  } catch (err) {
    console.error('❌ Error obteniendo playlist para player:', err);
    res.status(500).json({ error: err.message });
  }
});
const adminRoutes = require('./routes/admin');
app.set('io', io);
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
app.post('/api/queue/print', async (req, res) => {
  try {
    const { branch_id, token_number, service_name, wait_minutes, position, token_id } = req.body;
    // TODO: implementar con librería escpos cuando haya impresora configurada
    console.log(`🖨️  Imprimir tiquete: ${token_number} — ${service_name}`);
    res.json({ success: true, printed: false, message: 'Sin impresora configurada' });
  } catch(err) {
    res.status(500).json({ error: err.message });
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

    const result = await pool.query(
      `INSERT INTO activation_codes (code, user_id, device_name)
       VALUES ($1, $2, $3)
       RETURNING id, code, device_name, expires_at`,
      [code, userId, device_name || null]
    );

    console.log(`✅ Código de activación generado: ${code} para usuario ${userId}`);
    res.json({ success: true, ...result.rows[0] });
  } catch (err) {
    console.error('❌ Error generando código:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── VALIDAR CÓDIGO (sin JWT — llamado desde RPi) ─────────────
app.post('/api/activate', async (req, res) => {
  try {
    const { code, device_id, ip_address, display_mode } = req.body;

    if (!code || !device_id) {
      return res.status(400).json({ error: 'code y device_id son requeridos' });
    }

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
      `INSERT INTO devices (device_id, name, ip_address, display_mode, user_id, status, last_seen)
       VALUES ($1, $2, $3, $4, $5, 'online', CURRENT_TIMESTAMP)
       ON CONFLICT (device_id) DO UPDATE SET
         name         = COALESCE($2, devices.name),
         ip_address   = $3,
         user_id      = $5,
         status       = 'online',
         last_seen    = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        device_id,
        activation.device_name || device_id,
        ip_address,
        display_mode || 'mirror',
        activation.user_id
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
    res.status(500).json({ error: err.message });
  }
});

// ── OBTENER CONFIG (proteger por user_id) ────────────────────
// Reemplaza el GET /api/devices/:device_id/config existente
// para que solo devuelva config si el dispositivo está activado
app.get('/api/devices/:device_id/config/v2', async (req, res) => {
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    next(); // Si falla la verificación, no bloquear
  }
}

// ── MIDDLEWARE DE ADMIN ──────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows.length || result.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Acceso restringido a administradores' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── GET: Estado de licencia del usuario actual ───────────────
app.get('/api/license/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role, license_type, license_status, license_start, license_end
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
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Listar todos los usuarios con licencia ────────────
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.name, u.role,
        u.license_type, u.license_status, u.license_start, u.license_end,
        u.created_at,
        COUNT(DISTINCT d.id) as device_count,
        COUNT(DISTINCT c.id) as content_count,
        COUNT(DISTINCT p.id) as playlist_count
      FROM users u
      LEFT JOIN devices d ON d.user_id = u.id
      LEFT JOIN content c ON c.user_id = u.id
      LEFT JOIN playlists p ON p.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    const now = new Date();
    const users = result.rows.map(u => ({
      ...u,
      days_left: u.license_end ? Math.ceil((new Date(u.license_end) - now) / (1000 * 60 * 60 * 24)) : null,
      is_expired: u.license_end ? new Date(u.license_end) < now : false,
    }));

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Ver dispositivos de un usuario específico ─────────
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
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Todos los dispositivos de todos los usuarios ───────
app.get('/api/admin/all-devices', authenticateToken, requireAdmin, async (req, res) => {
  try {
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
      ORDER BY u.name ASC, d.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Renovar licencia ──────────────────────────────────
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

    // Enviar email de confirmación
    try {
      await emailService.sendLicenseRenewedEmail(
        { email: user.email, name: user.name },
        { months, new_end: newEnd, license_type: updateResult.rows[0].license_type }
      );
    } catch(e) { console.warn('⚠️ Error enviando email de renovación:', e.message); }

    console.log(`✅ Licencia renovada: ${user.email} +${months} meses → ${newEnd.toLocaleDateString()}`);
    res.json({ success: true, user: updateResult.rows[0], new_end: newEnd });
  } catch (err) {
    console.error('❌ Error renovando licencia:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: Eliminar usuario ──────────────────────────────────
app.delete('/api/admin/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    res.status(500).json({ error: err.message });
  }
});

// ── RPi: Verificar licencia del dispositivo ──────────────────
// Llamado desde sync-app.js al arrancar
app.get('/api/devices/:device_id/license', async (req, res) => {
  try {
    const { device_id } = req.params;
    const result = await pool.query(`
      SELECT u.license_status, u.license_end, u.license_type
      FROM devices d
      JOIN users u ON d.user_id = u.id
      WHERE d.device_id = $1
    `, [device_id]);

    if (!result.rows.length) {
      return res.json({ status: 'unknown', needs_activation: true });
    }

    const { license_status, license_end, license_type } = result.rows[0];
    const now = new Date();
    const isExpired = license_end && new Date(license_end) < now;
    const daysLeft = license_end ? Math.ceil((new Date(license_end) - now) / (1000 * 60 * 60 * 24)) : null;

    res.json({
      status: isExpired ? 'expired' : license_status,
      license_end,
      license_type,
      days_left: daysLeft,
      active: !isExpired && license_status === 'active'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/queue/services/:id', authenticateToken, async (req, res) => {
  try {
    const { name, description, color, icon, priority_level, avg_attention_min, max_queue_size, active } = req.body;
    const result = await pool.query(
      `UPDATE services SET
        name = COALESCE($1, name), description = COALESCE($2, description),
        color = COALESCE($3, color), icon = COALESCE($4, icon),
        priority_level = COALESCE($5, priority_level),
        avg_attention_min = COALESCE($6, avg_attention_min),
        max_queue_size = COALESCE($7, max_queue_size),
        active = COALESCE($8, active)
       WHERE id = $9 RETURNING *`,
      [name, description, color, icon, priority_level, avg_attention_min, max_queue_size, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({ success: true, service: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/queue/services/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE services SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE — Eliminar ventanilla
app.delete('/api/queue/counters/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM counter_services WHERE counter_id = $1', [req.params.id]);
    await pool.query('DELETE FROM counters WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE — Eliminar agente
app.delete('/api/queue/agents/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM agents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Ventanillas activas de una sucursal (público)
app.get('/api/queue/public/branches/:branchId/counters', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, display_name, rating_enabled FROM counters WHERE branch_id = $1 AND active = true ORDER BY name ASC',
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET — Agentes activos de una sucursal (público, solo nombre e id)
app.get('/api/queue/public/branches/:branchId/agents', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, avatar_color FROM agents WHERE branch_id = $1 AND active = true ORDER BY name ASC',
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — Login del agente con PIN → devuelve JWT
app.post('/api/queue/agent/login', async (req, res) => {
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

    if (String(agent.pin) !== String(pin)) {
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        (SELECT active FROM agent_sessions WHERE agent_id = a.id AND active = true LIMIT 1) as is_online
       FROM agents a
       WHERE a.branch_id = $1
       ORDER BY a.name ASC`,
      [req.params.branchId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      [userResult.rows[0].id, req.params.branchId, name, pin, avatar_color || '#FF1B8D']
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/queue/agents/:id', authenticateToken, async (req, res) => {
  try {
    const { name, pin, avatar_color, active } = req.body;
    const result = await pool.query(
      `UPDATE agents SET
        name = COALESCE($1, name), pin = COALESCE($2, pin),
        avatar_color = COALESCE($3, avatar_color), active = COALESCE($4, active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [name, pin, avatar_color, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Agente no encontrado' });
    res.json({ success: true, agent: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// OPERACIÓN — GENERAR TURNO (desde kiosco/QR)
// ══════════════════════════════════════════════════════════════

app.post('/api/queue/token', async (req, res) => {
  try {
    const { branch_id, service_id, is_priority, client_name, client_phone, channel } = req.body;
    if (!branch_id || !service_id) return res.status(400).json({ error: 'branch_id y service_id requeridos' });

    // Obtener servicio y validar
    const serviceResult = await pool.query(
      'SELECT * FROM services WHERE id = $1 AND active = true', [service_id]
    );
    if (!serviceResult.rows.length) return res.status(404).json({ error: 'Servicio no encontrado' });
    const service = serviceResult.rows[0];

    // Verificar límite de cola
    const waitingCount = await pool.query(
      `SELECT COUNT(*) FROM queue_tokens WHERE branch_id = $1 AND service_id = $2
       AND status = 'waiting' AND date_key = CURRENT_DATE`,
      [branch_id, service_id]
    );
    if (parseInt(waitingCount.rows[0].count) >= service.max_queue_size) {
      return res.status(429).json({ error: 'Cola llena para este servicio' });
    }

    // Generar número correlativo del día
    const lastToken = await pool.query(
      `SELECT token_number FROM queue_tokens
       WHERE branch_id = $1 AND service_id = $2 AND date_key = CURRENT_DATE
       ORDER BY created_at DESC LIMIT 1`,
      [branch_id, service_id]
    );

    let nextNum = 1;
    if (lastToken.rows.length) {
      const lastNum = parseInt(lastToken.rows[0].token_number.replace(/\D/g, ''));
      nextNum = lastNum + 1;
    }

    const tokenNumber  = `${service.prefix}${String(nextNum).padStart(3, '0')}`;
    const displayNumber = tokenNumber;

    // Calcular tiempo estimado de espera
    const waiting = await pool.query(
      `SELECT COUNT(*) FROM queue_tokens
       WHERE branch_id = $1 AND service_id = $2 AND status = 'waiting' AND date_key = CURRENT_DATE`,
      [branch_id, service_id]
    );
    const estimatedWait = parseInt(waiting.rows[0].count) * service.avg_attention_min;

    // Insertar turno
    const result = await pool.query(
      `INSERT INTO queue_tokens
        (branch_id, service_id, token_number, display_number, is_priority, channel, client_name, client_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [branch_id, service_id, tokenNumber, displayNumber,
       is_priority || false, channel || 'kiosk', client_name || null, client_phone || null]
    );

    const token = result.rows[0];

    // Registrar evento
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, metadata)
       VALUES ($1, 'created', $2)`,
      [token.id, JSON.stringify({ channel: channel || 'kiosk', is_priority })]
    );

    // Notificar via Socket.io a la pantalla y al panel del agente
    io.to(`branch_${branch_id}`).emit('new_token', {
      token, service_name: service.name, service_color: service.color,
      waiting_count: parseInt(waiting.rows[0].count) + 1,
      estimated_wait: estimatedWait
    });

    console.log(`🎫 Turno generado: ${tokenNumber} — ${service.name}`);
    res.json({
      success: true,
      token_number: tokenNumber,
      display_number: displayNumber,
      service_name: service.name,
      service_color: service.color,
      estimated_wait_minutes: estimatedWait,
      position_in_queue: parseInt(waiting.rows[0].count) + 1,
      token_id: token.id
    });
  } catch (err) {
    console.error('❌ Error generando turno:', err);
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

    // Buscar siguiente turno (prioridad primero, luego FIFO)
    const tokenResult = await pool.query(
      `SELECT qt.*, s.name as service_name, s.color as service_color
       FROM queue_tokens qt
       JOIN services s ON s.id = qt.service_id
       WHERE qt.branch_id = $1
         AND qt.status = 'waiting'
         AND qt.service_id = ANY($2::uuid[])
         AND qt.date_key = CURRENT_DATE
       ORDER BY qt.is_priority DESC, qt.created_at ASC
       LIMIT 1`,
      [branch_id, serviceIds]
    );

    if (!tokenResult.rows.length) return res.json({ success: true, token: null, message: 'No hay turnos en espera' });

    const token = tokenResult.rows[0];

    // Actualizar turno
    await pool.query(
      `UPDATE queue_tokens SET
        status = 'called', counter_id = $1, agent_id = $2,
        agent_session_id = $3, called_at = CURRENT_TIMESTAMP,
        wait_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) / 60
       WHERE id = $4`,
      [counter_id, session.agent_id, session_id, token.id]
    );

    // Registrar evento
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id, to_counter_id)
       VALUES ($1, 'called', $2, $3)`,
      [token.id, session.agent_id, counter_id]
    );

    // Obtener nombre del agente y ventanilla para mostrar en pantalla
    const agentResult = await pool.query('SELECT name FROM agents WHERE id = $1', [session.agent_id]);
    const counterResult = await pool.query('SELECT display_name FROM counters WHERE id = $1', [counter_id]);

    const callData = {
      token_id: token.id,
      token_number: token.display_number,
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
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — Finalizar turno
app.post('/api/queue/tokens/:tokenId/finish', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id } = req.body;
    const result = await pool.query(
      `UPDATE queue_tokens SET
        status = 'finished', finished_at = CURRENT_TIMESTAMP,
        attention_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(attended_at, called_at))) / 60
       WHERE id = $1 RETURNING *`,
      [req.params.tokenId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });

    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id) VALUES ($1, 'finished', $2)`,
      [req.params.tokenId, agent_id]
    );

    // Actualizar estadísticas de la sesión
    await pool.query(
      `UPDATE agent_sessions SET
        tokens_attended = tokens_attended + 1,
        avg_attention_min = (
          SELECT AVG(attention_minutes) FROM queue_tokens
          WHERE agent_session_id = $1 AND status = 'finished'
        )
       WHERE id = $1`,
      [session_id]
    );

    // Emitir para actualizar pantalla y panel
    io.to(`branch_${branch_id}`).emit('token_finished', {
      token_id: req.params.tokenId,
      counter_id: result.rows[0].counter_id
    });

    // Mostrar calificación si la ventanilla lo tiene habilitado
    if (result.rows[0].rating_enabled !== false) {
      io.to(`counter_${result.rows[0].counter_id}`).emit('show_rating', {
        token_id: req.params.tokenId,
        token_number: result.rows[0].display_number
      });
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — Marcar como no presentado
app.post('/api/queue/tokens/:tokenId/no-show', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id } = req.body;
    await pool.query(
      `UPDATE queue_tokens SET status = 'no_show', finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [req.params.tokenId]
    );
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id) VALUES ($1, 'no_show', $2)`,
      [req.params.tokenId, agent_id]
    );
    await pool.query(
      `UPDATE agent_sessions SET tokens_no_show = tokens_no_show + 1 WHERE id = $1`,
      [session_id]
    );
    io.to(`branch_${branch_id}`).emit('token_no_show', { token_id: req.params.tokenId });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST — Transferir turno a otra ventanilla/servicio
app.post('/api/queue/tokens/:tokenId/transfer', authenticateAgentOrUser, async (req, res) => {
  try {
    const { agent_id, session_id, branch_id, to_counter_id, to_service_id, note } = req.body;
    const current = await pool.query('SELECT * FROM queue_tokens WHERE id = $1', [req.params.tokenId]);
    if (!current.rows.length) return res.status(404).json({ error: 'Turno no encontrado' });

    await pool.query(
      `UPDATE queue_tokens SET
        status = 'waiting', counter_id = $1,
        service_id = COALESCE($2, service_id),
        agent_id = NULL, agent_session_id = NULL,
        called_at = NULL, attended_at = NULL
       WHERE id = $3`,
      [to_counter_id || null, to_service_id || null, req.params.tokenId]
    );
    await pool.query(
      `INSERT INTO token_events (token_id, event_type, agent_id, from_counter_id, to_counter_id, note)
       VALUES ($1, 'transferred', $2, $3, $4, $5)`,
      [req.params.tokenId, agent_id, current.rows[0].counter_id, to_counter_id, note]
    );
    await pool.query(
      `UPDATE agent_sessions SET tokens_transferred = tokens_transferred + 1 WHERE id = $1`,
      [session_id]
    );
    io.to(`branch_${branch_id}`).emit('token_transferred', {
      token_id: req.params.tokenId,
      to_counter_id, to_service_id
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
      `SELECT b.*, p.name as playlist_name FROM branches b
       LEFT JOIN playlists p ON p.id = b.display_playlist_id
       WHERE b.id = $1`,
      [branchId]
    );

    res.json({
      called_tokens: called.rows,
      stats: stats.rows[0],
      branch: branch.rows[0] || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// SOCKET.IO — Sala por sucursal
// ══════════════════════════════════════════════════════════════
// Agregar en el handler io.on('connection'):
// socket.on('join_branch', (branchId) => { socket.join(`branch_${branchId}`); });
// socket.on('join_counter', (counterId) => { socket.join(`counter_${counterId}`); });


// SOCKET.IO - EVENTOS EN TIEMPO REAL
// ========================================

io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado:', socket.id);
  // DEBUG — capturar todos los eventos
  const originalEmit = socket.onevent.bind(socket);
  socket.onevent = function(packet) {
    if (packet.data[0] === 'screenshot_result') {
      console.log(`🔍 [DEBUG] Evento recibido: ${packet.data[0]} de socket ${socket.id}`);
    }
    originalEmit(packet);
  };
  // Auto-join: si el cliente envía su device_id al conectar, unirlo a su sala
  socket.on('device_register', ({ device_id }) => {
    socket.join(`device_${device_id}`);
    console.log(`📱 ${device_id} unido a sala device_${device_id} (socket: ${socket.id})`);
  });


  socket.on('screenshot_result', ({ device_id, success, image, error }) => {
    console.log(`📸 [RECV] screenshot_result — socket: ${socket.id} device: ${device_id} success: ${success} size: ${image?.length}`);
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
    try {
      socket.join(`device_${device_id}`);
      if (temp !== undefined && temp !== null) {
        await pool.query(`UPDATE devices SET status = $1, last_seen = NOW(), cpu_temp = $3 WHERE device_id = $2`, [status || 'online', device_id, temp]);
      } else {
        await pool.query(`UPDATE devices SET status = $1, last_seen = NOW() WHERE device_id = $2`, [status || 'online', device_id]);
      }
    } catch(e) { console.warn('heartbeat error:', e.message); }
  });

  // ⭐ EVENTO: Reinicio remoto de dispositivo RPi
  socket.on('reboot_device', async ({ device_id }) => {
    try {
      const result = await pool.query('SELECT ip_address FROM devices WHERE device_id = $1', [device_id]);
      if (!result.rows.length) return socket.emit('reboot_result', { success: false, error: 'Dispositivo no encontrado' });
      const ip = result.rows[0].ip_address;
      console.log(`🔄 Reiniciando dispositivo ${device_id} en ${ip}`);
      exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes sonoro@${ip} "sudo reboot"`, { timeout: 15000, windowsHide: true }, (error) => {
        if (error && error.code !== null && error.signal !== 'SIGTERM') {
          console.error('❌ Reboot error:', error.message);
          socket.emit('reboot_result', { success: false, error: error.message });
        } else {
          console.log(`✅ Reboot enviado a ${ip}`);
          socket.emit('reboot_result', { success: true });
        }
      });
    } catch (err) {
      socket.emit('reboot_result', { success: false, error: err.message });
    }
  });

  // ⭐ EVENTO: Iniciar conversión via Socket.io
  socket.on('start-video-conversion', async (data) => {
    try {
      const { contentId, originalPath, outputPath, preset = 'balanced' } = data;

      console.log(`\n📺 [${socket.id}] Solicitud de conversión`);
      console.log(`   Contenido: ${contentId}`);
      console.log(`   Archivo: ${originalPath}`);

      // Validar datos
      if (!contentId || !originalPath || !outputPath) {
        return socket.emit('conversion-error', {
          error: 'Faltan parámetros requeridos (contentId, originalPath, outputPath)',
          received: { contentId, originalPath, outputPath }
        });
      }

      // Encolar el trabajo de conversión
      const job = await addConversionJob({
        contentId,
        originalPath,
        outputPath,
        preset,
        socketId: socket.id  // ⭐ IMPORTANTE: Pasamos el socket ID
      });

      // Responder al cliente
      socket.emit('conversion-queued', {
        jobId: job.id,
        contentId,
        message: 'Video encolado para conversión',
        timestamp: new Date()
      });

    } catch (error) {
      console.error(`❌ Error iniciando conversión:`, error.message);
      socket.emit('conversion-error', {
        error: error.message,
        timestamp: new Date()
      });
    }
  });

  // ⭐ EVENTO: Obtener estado de un job
  socket.on('get-job-status', async (jobId) => {
    try {
      const status = await getJobStatus(jobId);
      socket.emit('job-status', status);
    } catch (error) {
      socket.emit('status-error', {
        error: error.message
      });
    }
  });

  // ⭐ EVENTO: Obtener estadísticas de la cola
  socket.on('get-queue-stats', async () => {
    try {
      const stats = await getQueueStats();
      socket.emit('queue-stats', stats);
    } catch (error) {
      socket.emit('stats-error', {
        error: error.message
      });
    }
  });

  // Queue — unirse a sala de sucursal
  socket.on('join_branch', (branchId) => {
    socket.join(`branch_${branchId}`);
    console.log(`📺 Socket unido a sala branch_${branchId}`);
  });
  socket.on('join_counter', (counterId) => {
    socket.join(`counter_${counterId}`);
  });

  socket.on('disconnect', () => {
    console.log('🔴 Cliente desconectado:', socket.id);
  });
});

// ========================================
// INICIAR SERVIDOR
// ========================================

const PORT = process.env.PORT || 3000;

console.log('🎬 Servicio de conversión de videos inicializado');

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