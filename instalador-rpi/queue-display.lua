local mp    = require 'mp'
local utils = require 'mp.utils'

local OVERLAY_PNG   = '/tmp/sonoro-overlay.png'
local QUEUE_FILE    = mp.get_opt("queue_file") or "/tmp/sonoro-queue.json"
local SHOW_DURATION = 10
local CHECK_INTERVAL = 0.5
local PIPER         = "/home/sonoro/piper/piper"
local PIPER_MODEL   = "/home/sonoro/piper-voices/es_MX-claude-high.onnx"
local APLAY_TARGET  = "alsa_output.platform-fef05700.hdmi.hdmi-stereo"
local TTS_WAV       = "/tmp/sonoro-tts.wav"

local last_token_id = ""
local hide_timer    = nil
local visible       = false
local processing    = false

local function get_mtime(file)
  local r = utils.subprocess({ args={"stat","-c","%Y",file}, cancellable=false })
  return r and r.stdout and r.stdout:gsub("%s+","") or ""
end

local function parse_field(raw, key)
  return raw:match('"'..key..'"[^:]*:[^"]*"([^"]*)"')
end

local function hide()
  visible = false
  mp.commandv("overlay-remove", "0")
end

local function show_overlay()
  local w = tonumber(mp.get_property("osd-width")) or 1920
  local h = tonumber(mp.get_property("osd-height")) or 1080
  local raw = '/tmp/sonoro-overlay.bgra'
  local r = utils.subprocess({
    args={"ffmpeg","-y","-i",OVERLAY_PNG,"-vf","scale="..w..":"..h,
          "-f","rawvideo","-pix_fmt","bgra",raw},
    cancellable=false
  })
  if r.status ~= 0 then return end
  mp.commandv("overlay-add","0","0","0",raw,"0","bgra",tostring(w),tostring(h),tostring(w*4))
  visible = true
  if hide_timer then mp.cancel_timer(hide_timer) end
  hide_timer = mp.add_timeout(SHOW_DURATION, hide)
end

local function tick()
  if processing then return end

  local f = io.open(OVERLAY_PNG,"r")
  if not f then return end
  f:close()

  -- Leer token_id del JSON para evitar repetir
  local jf = io.open(QUEUE_FILE,"r")
  local token_id = ""
  local tn, cn, ip = "", "", false
  if jf then
    local raw = jf:read("*all"); jf:close()
    token_id = parse_field(raw,"token_id") or ""
    tn = parse_field(raw,"token_number") or ""
    cn = parse_field(raw,"counter_name") or ""
    ip = raw:match('"is_priority"%s*:%s*true') ~= nil
  end

  if token_id == "" or token_id == last_token_id then return end
  last_token_id = token_id
  processing = true

  -- Borrar archivos INMEDIATAMENTE para evitar re-trigger
  os.remove(OVERLAY_PNG)
  os.remove(QUEUE_FILE)

  -- Generar TTS (síncrono)
  local text = "Turno "..tn..", "..cn
  if ip then text = text..". Turno prioritario." end
  os.execute('echo "'..text..'" | '..PIPER..
    ' --model '..PIPER_MODEL..' --length_scale 1.4 --output_file '..TTS_WAV)

  -- Mostrar overlay y reproducir audio
  show_overlay()
  local play = 'pw-cat --playback --target='..APLAY_TARGET..
               ' --rate=22050 --channels=1 --format=s16 '..TTS_WAV
  os.execute(play..' && sleep 1 && '..play..' &')

  processing = false
end

mp.add_periodic_timer(CHECK_INTERVAL, tick)
mp.msg.info("SONORO Queue Display v6.0 OK")
