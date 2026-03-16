module.exports = {
  video_optimization: {
    enabled: true,
    preset: "balanced",
    
    presets: {
      compatible: {
        resolution: "1280x720",
        bitrate_video: "800k",
        bitrate_audio: "128k",
        description: "Máxima compatibilidad RPi4"
      },
      balanced: {
        resolution: "1280x720",
        bitrate_video: "1000k",
        bitrate_audio: "128k",
        description: "Balance calidad-tamaño"
      },
      quality: {
        resolution: "1920x1080",
        bitrate_video: "1500k",
        bitrate_audio: "128k",
        description: "Máxima calidad"
      }
    },
    
    codec_video: "libx264",
    codec_audio: "aac",
    preset_ffmpeg: "medium",
    fps: 30,
    audio_sample_rate: 48000,
    
    max_retries: 3,
    timeout_seconds: 600,
    keep_original: true,
    delete_optimized_on_delete_original: true,
    
    paths: {
      original: "./media/original/",
      optimized: "./media/optimized/",
      logs: "./logs/video-conversion/"
    }
  }
};