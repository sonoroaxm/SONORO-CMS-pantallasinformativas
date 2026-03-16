/**
 * ============================================
 * SONORO AV - ADMIN ROUTES
 * backend/src/routes/admin.js
 * ============================================
 */

const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// ── AUTH MIDDLEWARE LOCAL ────────────────────────────
function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

// ── HELPERS ──────────────────────────────────────────

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

async function getPM2Processes() {
  return new Promise((resolve) => {
    exec('pm2 jlist', { windowsHide: true }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const procs = JSON.parse(stdout);
        resolve(procs.map(p => ({
          name:      p.name,
          pid:       p.pid,
          isRunning: p.pm2_env?.status === 'online',
          status:    p.pm2_env?.status,
          cpu:       p.monit?.cpu ?? 0,
          memoryMB:  p.monit?.memory ? Math.round(p.monit.memory / 1048576) : 0,
          uptime:    p.pm2_env?.pm_uptime ? formatUptime(Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000)) : '—',
          restarts:  p.pm2_env?.restart_time ?? 0,
        })));
      } catch(e) { resolve([]); }
    });
  });
}

function getCPUUsage() {
  return new Promise((resolve) => {
    const cpus = os.cpus();
    const start = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
    setTimeout(() => {
      const end = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
      const avg = start.reduce((sum, s, i) => {
        const dIdle  = end[i].idle  - s.idle;
        const dTotal = end[i].total - s.total;
        return sum + (1 - dIdle / dTotal);
      }, 0) / start.length;
      resolve((avg * 100).toFixed(1) + '%');
    }, 200);
  });
}

// ── OVERVIEW ─────────────────────────────────────────
router.get('/overview', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const [processes, cpuUsage] = await Promise.all([getPM2Processes(), getCPUUsage()]);

    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const memPct   = ((usedMem / totalMem) * 100).toFixed(1);

    // DB stats
    let dbStats = { content_count: 0, playlists_count: 0, users_count: 0, size_mb: '—', connections: { active: 0, max: 20 } };
    try {
      const [cnt, sz, conn] = await Promise.all([
        pool.query('SELECT (SELECT COUNT(*) FROM content) as c, (SELECT COUNT(*) FROM playlists) as p, (SELECT COUNT(*) FROM users) as u'),
        pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size"),
        pool.query("SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'")
      ]);
      dbStats.content_count   = parseInt(cnt.rows[0].c);
      dbStats.playlists_count = parseInt(cnt.rows[0].p);
      dbStats.users_count     = parseInt(cnt.rows[0].u);
      dbStats.size_mb         = sz.rows[0].size;
      dbStats.connections     = { active: parseInt(conn.rows[0].active), max: 20 };
    } catch(e) {}

    const running = processes.filter(p => p.isRunning).length;
    const stopped = processes.length - running;
    const alerts  = [];
    if (stopped > 0) alerts.push({ level: 'error', message: `${stopped} proceso(s) PM2 detenido(s)` });
    if (parseFloat(memPct) > 85) alerts.push({ level: 'warning', message: `Uso de memoria alto: ${memPct}%` });

    res.json({
      overview: {
        status: stopped > 0 || parseFloat(memPct) > 85 ? 'warning' : 'healthy',
        processes: { running, stopped, total: processes.length },
        system: {
          cpu_usage:   cpuUsage,
          cpu_cores:   os.cpus().length,
          memory_used:  formatBytes(usedMem),
          memory_total: formatBytes(totalMem),
          memory_usage: memPct + '%',
          memory_available: formatBytes(freeMem),
          uptime: formatUptime(os.uptime()),
        },
        database: {
          content_count:   dbStats.content_count,
          playlists_count: dbStats.playlists_count,
          users_count:     dbStats.users_count,
          size_mb:         dbStats.size_mb,
        },
        connections: dbStats.connections,
        alerts,
      }
    });
  } catch(err) {
    console.error('❌ Admin overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PROCESSES ─────────────────────────────────────────
router.get('/processes', auth, async (req, res) => {
  try {
    const processes = await getPM2Processes();
    res.json({ processes });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/process/:name/restart', auth, (req, res) => {
  const { name } = req.params;
  exec(`pm2 restart ${name}`, { windowsHide: true }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `${name} reiniciado` });
  });
});

router.post('/process/:name/stop', auth, (req, res) => {
  const { name } = req.params;
  exec(`pm2 stop ${name}`, { windowsHide: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `${name} detenido` });
  });
});

router.post('/process/:name/start', auth, (req, res) => {
  const { name } = req.params;
  exec(`pm2 start ${name}`, { windowsHide: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `${name} iniciado` });
  });
});

router.get('/process/:name/logs', auth, (req, res) => {
  const { name } = req.params;
  const lines = parseInt(req.query.lines) || 100;
  const logsDir = path.join(process.cwd(), 'logs');

  // Intentar leer archivo de log de PM2
  const candidates = [
    path.join(logsDir, `${name}-out.log`),
    path.join(logsDir, `sonoro-${name}-out-0.log`),
    path.join(logsDir, `${name}-out-0.log`),
  ];

  for (const logFile of candidates) {
    if (fs.existsSync(logFile)) {
      exec(process.platform === 'win32' ? `powershell -Command "Get-Content \"${logFile}\" -Tail ${lines}"` : `tail -n ${lines} "${logFile}"`, { windowsHide: true }, (err, stdout) => {
        if (err) return res.json({ logs: [`Error leyendo log: ${err.message}`] });
        res.json({ logs: stdout.split('\n').filter(Boolean) });
      });
      return;
    }
  }

  // Fallback: pm2 logs
  exec(`pm2 logs ${name} --lines ${lines} --nostream 2>&1`, { windowsHide: true }, (err, stdout) => {
    const raw = (stdout || '').split('\n').filter(l => l.trim());
    res.json({ logs: raw.length ? raw : [`No se encontraron logs para ${name}`] });
  });
});

// ── SYSTEM ────────────────────────────────────────────
router.get('/system', auth, async (req, res) => {
  try {
    const cpus = os.cpus();
    res.json({
      platform:     os.platform(),
      arch:         os.arch(),
      node_version: process.version,
      system: {
        platform: `${os.type()} ${os.release()}`,
        uptime:   formatUptime(os.uptime()),
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model,
        speed: cpus[0]?.speed,
      },
      memory: {
        total:     formatBytes(os.totalmem()),
        free:      formatBytes(os.freemem()),
        used:      formatBytes(os.totalmem() - os.freemem()),
        usage_pct: ((( os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1) + '%',
      }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/system/port/:port', auth, (req, res) => {
  const port = parseInt(req.params.port);
  exec(process.platform === 'win32' ? `netstat -ano | findstr :${port}` : `netstat -tuln 2>/dev/null | grep :${port} || ss -tuln | grep :${port}`, { windowsHide: true }, (err, stdout) => {
    const open = !err && stdout.includes(':' + port);
    res.json({ port, status: open ? 'open' : 'closed' });
  });
});

// ── DATABASE ──────────────────────────────────────────
router.get('/database/stats', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const [counts, size, conn] = await Promise.all([
      pool.query('SELECT (SELECT COUNT(*) FROM content) as content, (SELECT COUNT(*) FROM playlists) as playlists, (SELECT COUNT(*) FROM users) as users, (SELECT COUNT(*) FROM devices) as devices'),
      pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as db_size, pg_database_size(current_database()) as raw_size"),
      pool.query("SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'")
    ]);
    res.json({
      database: {
        host:    process.env.DB_HOST || 'localhost',
        port:    process.env.DB_PORT || 5432,
        name:    process.env.DB_NAME || 'cms_signage',
        size_mb: size.rows[0].db_size,
      },
      tables: {
        content:   parseInt(counts.rows[0].content),
        playlists: parseInt(counts.rows[0].playlists),
        users:     parseInt(counts.rows[0].users),
        devices:   parseInt(counts.rows[0].devices),
      },
      connections: { active: parseInt(conn.rows[0].active), max: 20 }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/database/tables', auth, async (req, res) => {
  try {
    const pool = global.pool;
    const result = await pool.query(`
      SELECT
        relname AS tablename,
        pg_size_pretty(pg_total_relation_size(relid)) AS size,
        n_live_tup AS row_count
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
    `);
    res.json({ tables: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RPi CONTROL ───────────────────────────────────────

// GET logs de RPi via SSH
router.post('/rpi/logs', auth, (req, res) => {
  const { device_id, ip, lines = 100 } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });

  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes sonoro@${ip} "sudo journalctl -u sonoro-player -n ${lines} --no-pager 2>&1"`;
  exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
    if (err && !stdout) {
      return res.json({ success: false, error: `No se pudo conectar a ${ip}: ${err.message}` });
    }
    res.json({ success: true, logs: stdout || stderr || '' });
  });
});

// POST screenshot via SSH + grim (Wayland screenshot)
router.post('/rpi/screenshot', auth, (req, res) => {
  const { device_id, ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });

  const screenshotFile = `/tmp/screenshot_${device_id}_${Date.now()}.png`;
  const remoteFile = `/tmp/cms_screenshot.png`;
  const publicDir = path.join(process.cwd(), 'uploads');

  // Tomar screenshot en RPi via SSH usando grim (Wayland) o scrot (X11 fallback)
  const captureCmd = `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 grim ${remoteFile} 2>/dev/null || DISPLAY=:0 scrot ${remoteFile} 2>/dev/null`;
  const sshCapture = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes sonoro@${ip} "${captureCmd}"`;

  exec(sshCapture, { timeout: 15000, windowsHide: true }, (err) => {
    if (err) {
      return res.json({ success: false, error: `No se pudo capturar pantalla en ${ip}. Verifica que grim esté instalado (sudo apt install grim).` });
    }

    // Copiar el PNG de RPi al servidor via SCP
    const localFilename = `screenshot-${device_id}-${Date.now()}.png`;
    const localPath = path.join(publicDir, localFilename);
    const scpCmd = `scp -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes sonoro@${ip}:${remoteFile} "${localPath}"`;

    exec(scpCmd, { timeout: 20000, windowsHide: true }, (scpErr) => {
      if (scpErr) {
        return res.json({ success: false, error: `Error copiando screenshot: ${scpErr.message}` });
      }
      res.json({ success: true, screenshot_url: `/uploads/${localFilename}` });
    });
  });
});

// POST actualizar sync-app.js en RPi
router.post('/rpi/update', auth, (req, res) => {
  const { device_id, ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });

  const cmsUrl = process.env.CMS_URL_INTERNAL || `http://${process.env.HOST || '192.168.1.4'}:${process.env.PORT || 5000}`;
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes sonoro@${ip} "wget -q -O /home/sonoro/sonoro-player/sync-app.js ${cmsUrl}/sync-app.js && sudo systemctl restart sonoro-player && echo OK"`;

  exec(cmd, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
    if (err && !stdout.includes('OK')) {
      return res.json({ success: false, error: `Error actualizando ${ip}: ${err.message}` });
    }
    console.log(`✅ sync-app.js actualizado en ${device_id} (${ip})`);
    res.json({ success: true, message: `sync-app.js actualizado en ${device_id}` });
  });
});

// ── RPi STATS (temperatura + ventilador) ─────────────
router.post('/rpi/stats', auth, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP requerida' });

  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=6 -o BatchMode=yes sonoro@${ip} "vcgencmd measure_temp 2>/dev/null; cat /sys/class/thermal/cooling_device0/cur_state 2>/dev/null || echo 'fan:n/a'"`;

  exec(cmd, { timeout: 10000, windowsHide: true }, (err, stdout) => {
    if (err && !stdout) {
      return res.json({ success: false, error: 'No se pudo conectar' });
    }

    const lines = stdout.trim().split('\n');
    let temp = null;
    let fanState = null;

    for (const line of lines) {
      // temp=52.1'C
      const tempMatch = line.match(/temp=([\d.]+)/);
      if (tempMatch) temp = parseFloat(tempMatch[1]);

      // 0, 1, 2, 3
      const fanMatch = line.match(/^([0-3])$/);
      if (fanMatch) fanState = parseInt(fanMatch[1]);

      if (line === 'fan:n/a') fanState = -1;
    }

    const fanLabels = { '-1': 'N/A', 0: 'Apagado', 1: 'Bajo', 2: 'Medio', 3: 'Máximo' };
    const tempStatus = temp === null ? 'unknown'
                     : temp >= 80 ? 'critical'
                     : temp >= 65 ? 'warn'
                     : 'ok';

    res.json({
      success: true,
      temp,
      temp_status: tempStatus,
      fan_state: fanState,
      fan_label: fanLabels[String(fanState)] || 'N/A',
    });
  });
});

// ── REDIS (legacy - comentado pero disponible) ────────
router.get('/redis/stats', auth, (req, res) => {
  res.json({ redis: { status: 'disabled', total_keys: 0, note: 'Redis deshabilitado en esta instalación' } });
});

router.get('/redis/queue', auth, (req, res) => {
  res.json({ queue: { total_items: 0, items: [] } });
});

module.exports = router;
