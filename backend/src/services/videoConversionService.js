const FfmpegCommand = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const config = require('../config/video-conversion.config');

class VideoConversionService {
  static getFFmpegCommand() {
    // Asegúrate de que ffmpeg esté instalado en el PATH
    // Si no: descarga desde https://ffmpeg.org/download.html
    return FfmpegCommand;
  }

  static async convertVideo(inputPath, outputPath, preset = 'balanced', onProgressCallback = null) {
    return new Promise((resolve, reject) => {
      const presetConfig = config.video_optimization.presets[preset];
      
      if (!presetConfig) {
        return reject(new Error(`Preset no válido: ${preset}`));
      }

      const [width, height] = presetConfig.resolution.split('x').map(Number);
      const ffmpeg = this.getFFmpegCommand();

      console.log(`🎬 Iniciando conversión de video...`);
      console.log(`   Entrada: ${inputPath}`);
      console.log(`   Salida: ${outputPath}`);
      console.log(`   Preset: ${preset}`);
      console.log(`   Resolución: ${presetConfig.resolution}`);

      // Obtener duración del video primero para calcular progreso
      ffmpeg.ffprobe(inputPath, async (err, metadata) => {
        if (err) {
          return reject(new Error(`Error obteniendo metadata: ${err.message}`));
        }

        const duration = metadata.format.duration;
        console.log(`⏱️ Duración detectada: ${duration}s`);

        ffmpeg(inputPath)
          .videoCodec(config.video_optimization.codec_video)
          .audioCodec(config.video_optimization.codec_audio)
          .withVideoFilter(`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`)
          .videoBitrate(presetConfig.bitrate_video)
          .audioChannels(2)
          .audioBitrate(presetConfig.bitrate_audio)
          .audioFrequency(config.video_optimization.audio_sample_rate)
          .fps(config.video_optimization.fps)
          .on('start', (command) => {
            console.log('📹 FFmpeg comando iniciado');
          })
          .on('progress', (progress) => {
            const currentTime = progress.timemark.split(':').reduce((acc, time) => (60 * acc) + +time);
            const progressPercent = Math.min((currentTime / duration) * 100, 99);
            
            console.log(`⏳ Progreso: ${Math.round(progressPercent)}% (${progress.timemark})`);
            
            // Llamar callback si existe
            if (onProgressCallback && typeof onProgressCallback === 'function') {
              try {
                onProgressCallback(Math.round(progressPercent));
              } catch (e) {
                console.error(`⚠️ Error en callback de progreso: ${e.message}`);
              }
            }
          })
          .on('end', () => {
            console.log('✅ Conversión completada');
            
            // Obtener información del archivo
            const stats = fs.statSync(outputPath);
            const sizeOptimized = stats.size;
            
            resolve({
              success: true,
              output_path: outputPath,
              file_size: sizeOptimized,
              timestamp: new Date()
            });
          })
          .on('error', (error) => {
            console.error('❌ Error en conversión:', error.message);
            reject(error);
          })
          .output(outputPath)
          .run();
      });
    });
  }

  static getVideoInfo(inputPath) {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.getFFmpegCommand();

      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);
        
        const video = metadata.streams.find(s => s.codec_type === 'video');
        const audio = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          video: {
            width: video.width,
            height: video.height,
            codec: video.codec_name,
            bitrate: video.bit_rate
          },
          audio: {
            codec: audio ? audio.codec_name : 'none',
            bitrate: audio ? audio.bit_rate : 0
          },
          file_size: metadata.format.size
        });
      });
    });
  }
}

module.exports = VideoConversionService;
