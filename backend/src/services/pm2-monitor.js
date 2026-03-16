/**
 * ============================================
 * PM2 MONITOR SERVICE
 * Integración de PM2 con Express + Socket.io
 * ============================================
 * 
 * Archivo: src/services/pm2-monitor.js
 * 
 * Este servicio:
 * 1. Se conecta al daemon de PM2
 * 2. Monitorea todos los procesos en tiempo real
 * 3. Expone endpoints REST para control
 * 4. Emite eventos Socket.io para el dashboard
 */

const pm2 = require('pm2');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class PM2Monitor {
  constructor() {
    this.processesData = {};
    this.connected = false;
    this.updateInterval = null;
  }

  /**
   * Inicializar conexión con PM2
   */
  async init() {
    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) {
          console.error('❌ Error conectando a PM2:', err);
          reject(err);
          return;
        }

        console.log('✅ Conectado a PM2 daemon');
        this.connected = true;
        this.startMonitoring();
        resolve();
      });
    });
  }

  /**
   * Iniciar monitoreo continuo de procesos
   */
  startMonitoring() {
    // Actualizar estado cada 3 segundos
    this.updateInterval = setInterval(() => {
      pm2.list((err, processes) => {
        if (err) {
          console.error('❌ Error obteniendo lista de procesos:', err);
          return;
        }

        // Procesar datos de procesos
        this.processesData = this.formatProcessesData(processes);

        // Emitir via Socket.io si está disponible
        if (global.io) {
          global.io.emit('pm2-update', this.processesData);
        }
      });
    }, 3000);  // Cada 3 segundos
  }

  /**
   * Formatear datos de procesos para el dashboard
   */
  formatProcessesData(processes) {
    return processes.map(p => {
      const pm2_env = p.pm2_env || {};
      const monit = p.monit || { cpu: 0, memory: 0 };
      
      return {
        // Info básica
        name: p.name,
        pid: p.pid,
        uid: p.uid,
        
        // Estado
        status: pm2_env.status || 'stopped',  // online, stopped, errored
        restarted: pm2_env.restart_time || 0,
        
        // Recursos
        cpu: monit.cpu || 0,                    // %
        memory: monit.memory || 0,             // bytes
        memoryMB: (monit.memory / 1024 / 1024).toFixed(2),  // MB
        
        // Tiempo
        uptime: this.getUptimeString(pm2_env.pm_uptime),
        uptimeMs: this.getUptimeMs(pm2_env.pm_uptime),
        created_at: pm2_env.created_at,
        
        // Instancias
        instances: pm2_env.instances || 1,
        instance_id: p.pm_id,
        
        // Logs
        logPath: pm2_env.pm_log_path,
        errorPath: pm2_env.pm_err_log_path,
        
        // Argumentos
        script: pm2_env.script,
        args: pm2_env.args,
        cwd: pm2_env.cwd,
        
        // Config
        restarts: pm2_env.restart_time,
        execMode: pm2_env.exec_mode,      // fork, cluster
        nodeArgs: pm2_env.node_args,
        
        // Estado adicional
        isRunning: pm2_env.status === 'online',
        isStopped: pm2_env.status === 'stopped',
        hasError: pm2_env.status === 'errored',
        
        // Health
        health: this.getHealth(monit.cpu, monit.memory)
      };
    });
  }

  /**
   * Obtener string de uptime legible
   */
  getUptimeString(uptimeMs) {
    if (!uptimeMs || uptimeMs === 0) return 'N/A';
    
    const now = Date.now();
    const uptime = now - uptimeMs;
    
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((uptime / (1000 * 60)) % 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  /**
   * Obtener uptime en milisegundos
   */
  getUptimeMs(uptimeMs) {
    if (!uptimeMs) return 0;
    return Date.now() - uptimeMs;
  }

  /**
   * Determinar estado de salud basado en CPU y memoria
   */
  getHealth(cpu, memory) {
    const maxMemory = os.totalmem();
    const memPercent = (memory / maxMemory) * 100;

    if (cpu > 80 || memPercent > 80) {
      return { status: 'critical', color: 'red', message: 'Recursos altos' };
    } else if (cpu > 60 || memPercent > 60) {
      return { status: 'warning', color: 'yellow', message: 'Recursos moderados' };
    } else {
      return { status: 'healthy', color: 'green', message: 'Recursos normales' };
    }
  }

  /**
   * Obtener estado actual
   */
  getStatus() {
    return this.processesData;
  }

  /**
   * Obtener un proceso específico
   */
  getProcess(processName) {
    return this.processesData.find(p => p.name === processName);
  }

  /**
   * Reiniciar un proceso
   */
  async restart(processName) {
    return new Promise((resolve, reject) => {
      pm2.restart(processName, (err, processes) => {
        if (err) reject(new Error(`Error reiniciando ${processName}: ${err.message}`));
        else resolve({ 
          message: `✅ ${processName} reiniciado`,
          process: this.formatProcessesData(processes)
        });
      });
    });
  }

  /**
   * Parar un proceso
   */
  async stop(processName) {
    return new Promise((resolve, reject) => {
      pm2.stop(processName, (err) => {
        if (err) reject(new Error(`Error parando ${processName}: ${err.message}`));
        else resolve({ message: `⏸️  ${processName} parado` });
      });
    });
  }

  /**
   * Iniciar un proceso
   */
  async start(processName) {
    return new Promise((resolve, reject) => {
      pm2.start(processName, (err) => {
        if (err) reject(new Error(`Error iniciando ${processName}: ${err.message}`));
        else resolve({ message: `✅ ${processName} iniciado` });
      });
    });
  }

  /**
   * Recargar un proceso (zero-downtime)
   */
  async reload(processName) {
    return new Promise((resolve, reject) => {
      pm2.reload(processName, (err) => {
        if (err) reject(new Error(`Error recargando ${processName}: ${err.message}`));
        else resolve({ message: `🔄 ${processName} recargado sin downtime` });
      });
    });
  }

  /**
   * Obtener logs de un proceso
   */
  async getLogs(processName, lines = 50) {
    return new Promise((resolve, reject) => {
      pm2.getLogs(processName, (err, data) => {
        if (err) {
          reject(new Error(`Error obteniendo logs: ${err.message}`));
          return;
        }

        // data es [stdout, stderr]
        const processData = this.getProcess(processName);
        if (!processData) {
          reject(new Error(`Proceso ${processName} no encontrado`));
          return;
        }

        // Leer últimas líneas del archivo de log
        try {
          const logFile = processData.logPath;
          if (fs.existsSync(logFile)) {
            const content = fs.readFileSync(logFile, 'utf8');
            const logLines = content.split('\n').slice(-lines);
            resolve({
              process: processName,
              lines: lines,
              logs: logLines,
              file: logFile
            });
          } else {
            resolve({
              process: processName,
              logs: ['No log file found'],
              file: logFile
            });
          }
        } catch (err) {
          reject(new Error(`Error leyendo archivo de log: ${err.message}`));
        }
      });
    });
  }

  /**
   * Obtener estadísticas del sistema
   */
  getSystemStats() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Calcular promedio de CPU (load average)
    const loadAvg = os.loadavg();
    const cpuUsagePercent = (loadAvg[0] / cpus.length) * 100;

    return {
      system: {
        platform: os.platform(),
        arch: os.arch(),
        uptime: `${(os.uptime() / 3600).toFixed(2)} hours`,
        uptimeSeconds: os.uptime()
      },
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model || 'Unknown',
        speed: cpus[0]?.speed || 0,
        usage: cpuUsagePercent.toFixed(2) + '%'
      },
      memory: {
        total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        totalBytes: totalMem,
        free: (freeMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        freeBytes: freeMem,
        used: (usedMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        usedBytes: usedMem,
        percentage: ((usedMem / totalMem) * 100).toFixed(2) + '%'
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Obtener información de un puerto específico
   */
  getPortInfo(port) {
    try {
      if (process.platform === 'win32') {
        const cmd = `netstat -ano | findstr :${port}`;
        const result = execSync(cmd, { windowsHide: true }).toString();
        return { port, status: 'in_use', details: result };
      } else {
        const cmd = `lsof -i :${port}`;
        const result = execSync(cmd, { windowsHide: true }).toString();
        return { port, status: 'in_use', details: result };
      }
    } catch (err) {
      return { port, status: 'free' };
    }
  }

  /**
   * Desconectar de PM2
   */
  disconnect() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    pm2.disconnect();
    this.connected = false;
    console.log('🔌 Desconectado de PM2');
  }

  /**
   * Destruir instancia (cleanup)
   */
  destroy() {
    this.disconnect();
  }
}

// Exportar instancia singleton
module.exports = new PM2Monitor();
