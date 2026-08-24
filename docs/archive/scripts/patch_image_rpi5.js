const fs = require('fs');
const file = '/home/sonoro/sonoro-player/sync-app.js';
const src = fs.readFileSync(file, 'utf8');
const OLD = "      localItems.push({ ...item, local_path: localPath, duration_ms: item.duration_ms || IMAGE_DURATION });";
const NEW = `      let finalPath = localPath;
      if (item.type === 'image') {
        const mp4Path = require('path').join(require('path').dirname(localPath), item.content_id + '.mp4');
        if (!fs.existsSync(mp4Path)) {
          try {
            const { execSync } = require('child_process');
            const dur = Math.ceil((item.duration_ms || 30000) / 1000);
            execSync('ffmpeg -y -loop 1 -i "' + localPath + '" -t ' + dur + ' -vcodec libx264 -preset ultrafast -crf 28 -an "' + mp4Path + '"', { timeout: 60000 });
            console.log('Imagen convertida: ' + require('path').basename(mp4Path));
          } catch(e) { console.error('Error convirtiendo:', e.message); }
        }
        if (fs.existsSync(mp4Path)) finalPath = mp4Path;
      }
      localItems.push({ ...item, local_path: finalPath, duration_ms: item.duration_ms || IMAGE_DURATION });`;
if (!src.includes(OLD)) { console.error('ANCHOR NO ENCONTRADO'); process.exit(1); }
fs.writeFileSync(file + '.bak-image-patch', src);
fs.writeFileSync(file, src.replace(OLD, NEW));
console.log('OK - patch aplicado');
