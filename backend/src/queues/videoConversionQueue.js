const Queue = require('bull');
const VideoConversionService = require('../services/videoConversionService');
const fs = require('fs');
const path = require('path');
const config = require('../config/video-conversion.config');

// ============================================================================
// CREAR COLA CON CONFIGURACION OPTIMIZADA
// ============================================================================

const videoConversionQueue = new Queue('video-conversion', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,  // ⭐ IMPORTANTE: Evita el error "max retries"
    enableReadyCheck: false
  },
  defaultJobOptions: {
    attempts: 3,                 // Reintentar 3 veces si falla
    backoff: {
      type: 'exponential',
      delay: 2000                // Espera 2s, 4s, 8s entre reintentos
    },
    removeOnComplete: {
      age: 3600                  // Eliminar jobs completados después de 1 hora
    },
    removeOnFail: false           // Mantener jobs fallidos para debug
  },
  settings: {
    maxStalledCount: 2,          // Máximo de veces que puede quedarse "atrapado"
    lockDuration: 30000,         // Lock por 30 segundos
    lockRenewTime: 15000         // Renovar lock cada 15 segundos
  }
});

// ============================================================================
// PROCESAR JOBS DE CONVERSION
// ============================================================================

videoConversionQueue.process(1, async (job) => {
  const { contentId, originalPath, outputPath, preset, socketId } = job.data;

  try {
    console.log(`\n🎬 Procesando conversión para contenido ${contentId}`);
    console.log(`   Job ID: ${job.id}`);
    console.log(`   Socket ID: ${socketId}`);
    
    // Reportar progreso inicial
    await job.progress(5);
    console.log(`📊 Progreso reportado: 5%`);
    
    // Convertir video con callback de progreso
    const result = await VideoConversionService.convertVideo(
      originalPath,
      outputPath,
      preset,
      async (progressPercent) => {
        // Este callback se llama desde FFmpeg
        try {
          await job.progress(progressPercent);
          console.log(`📊 Job ${job.id} - Progreso: ${progressPercent}%`);
          
          // Emitir progreso a WebSocket si existe
          if (socketId && global.io) {
            global.io.to(socketId).emit('conversion-progress', {
              contentId,
              progress: progressPercent,
              jobId: job.id,
              status: 'processing'
            });
          }
        } catch (e) {
          console.error(`⚠️ Error reportando progreso: ${e.message}`);
        }
      }
    );

    // Progreso final
    await job.progress(100);
    console.log(`✅ Conversión exitosa para ${contentId}`);
    
    // Emitir completado a WebSocket
    if (socketId && global.io) {
      global.io.to(socketId).emit('conversion-completed', {
        contentId,
        progress: 100,
        jobId: job.id,
        status: 'completed',
        result
      });
    }
    
    return {
      success: true,
      contentId,
      ...result
    };

  } catch (error) {
    console.error(`❌ Error en conversión de ${contentId}:`, error.message);
    
    // Emitir error a WebSocket
    if (job.data.socketId && global.io) {
      global.io.to(job.data.socketId).emit('conversion-failed', {
        contentId: job.data.contentId,
        jobId: job.id,
        status: 'failed',
        error: error.message,
        attempt: job.attemptsMade
      });
    }
    
    throw error;
  }
});

// ============================================================================
// EVENT LISTENERS PARA MONITORING
// ============================================================================

videoConversionQueue.on('progress', (job, progress) => {
  console.log(`📊 Job ${job.id} - Progreso: ${progress}%`);
});

videoConversionQueue.on('completed', (job, result) => {
  console.log(`✅ Job ${job.id} completado`);
  console.log(`   Contenido: ${job.data.contentId}`);
  console.log(`   Tamaño: ${result.file_size} bytes`);
});

videoConversionQueue.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} falló (intento ${job.attemptsMade}/${job.opts.attempts})`);
  console.error(`   Error: ${err.message}`);
  console.error(`   Contenido: ${job.data.contentId}`);
  
  // Si ya agotó reintentos
  if (job.attemptsMade >= job.opts.attempts) {
    console.error(`   ⛔ JOB DESCARTADO DESPUES DE ${job.opts.attempts} INTENTOS`);
  }
});

videoConversionQueue.on('stalled', (job) => {
  console.warn(`⚠️ Job ${job.id} se quedó atrapado (stalled)`);
});

videoConversionQueue.on('error', (err) => {
  console.error(`❌ Error en cola:`, err.message);
});

// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================

/**
 * Encolar un nuevo trabajo de conversión
 * @param {Object} data - Datos del trabajo
 * @param {string} data.contentId - ID del contenido
 * @param {string} data.originalPath - Ruta del archivo original
 * @param {string} data.outputPath - Ruta donde guardar el convertido
 * @param {string} data.preset - Preset de conversión (balanced, high, low)
 * @param {string} data.socketId - Socket.io ID para enviar actualizaciones
 * @returns {Promise<Job>}
 */
async function addConversionJob(data) {
  try {
    const job = await videoConversionQueue.add(data, {
      jobId: `conversion-${data.contentId}-${Date.now()}`,
      priority: 1
    });
    
    console.log(`✅ Job encolado: ${job.id}`);
    console.log(`   Contenido: ${data.contentId}`);
    
    return job;
  } catch (error) {
    console.error(`❌ Error encolando job:`, error.message);
    throw error;
  }
}

/**
 * Obtener estado de un job
 * @param {string} jobId - ID del job
 * @returns {Promise<Object>}
 */
async function getJobStatus(jobId) {
  try {
    const job = await videoConversionQueue.getJob(jobId);
    
    if (!job) {
      return {
        found: false,
        message: `Job ${jobId} no encontrado`
      };
    }

    const state = await job.getState();
    const progress = job._progress;
    const attempts = job.attemptsMade;

    return {
      found: true,
      jobId: job.id,
      state,
      progress,
      attempts,
      data: job.data
    };
  } catch (error) {
    console.error(`❌ Error obteniendo status:`, error.message);
    throw error;
  }
}

/**
 * Limpiar jobs fallidos antiguos
 */
async function cleanupFailedJobs() {
  try {
    const failedJobs = await videoConversionQueue.getFailed(0, -1);
    const oldJobs = failedJobs.filter(job => {
      const age = Date.now() - job.finishedOn;
      return age > 86400000; // Más de 24 horas
    });

    for (const job of oldJobs) {
      await job.remove();
    }

    console.log(`🧹 Limpiados ${oldJobs.length} jobs antiguos`);
  } catch (error) {
    console.error(`❌ Error limpiando jobs:`, error.message);
  }
}

/**
 * Obtener estadísticas de la cola
 */
async function getQueueStats() {
  try {
    const counts = await videoConversionQueue.getJobCounts();
    const completed = await videoConversionQueue.getCompleted();
    const failed = await videoConversionQueue.getFailed();

    return {
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      recentlyCompleted: completed.length,
      recentlyFailed: failed.length
    };
  } catch (error) {
    console.error(`❌ Error obteniendo stats:`, error.message);
    throw error;
  }
}

// ============================================================================
// EXPORTAR
// ============================================================================

module.exports = {
  videoConversionQueue,
  addConversionJob,
  getJobStatus,
  cleanupFailedJobs,
  getQueueStats
};
