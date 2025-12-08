const { spawn } = require('child_process');
const path = require('path');
const { SerialPort } = require('serialport');
const cobs = require('cobs');
const flatbuffers = require('flatbuffers');
const { Frame } = require('./futaba/frame');
const { FrameType } = require('./futaba/frame-type');
const fs = require('fs');

// --- CONFIGURATION ---
// Auto-detect default serial port based on OS
let defaultPort;
if (process.platform === 'win32') defaultPort = 'COM3';
else if (process.platform === 'darwin') defaultPort = '/dev/cu.usbserial-0001';
else defaultPort = '/dev/ttyUSB0'; // Linux

const SERIAL_PORT_PATH = process.env.SERIAL_PORT || defaultPort;
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || '230400', 10);

// Input Source
// Default to 'videoplayback.mp4' if no env var is set. 
const VIDEO_FILE = process.env.VIDEO || process.env.VIDEO_FILE || 'videoplayback.mp4';
const START_TIME = process.env.START_TIME || '00:00:00';

// Orientation: 'horizontal' (140x32) or 'vertical' (32x140)
// Auto-detect: if using camera, default to vertical (32x140 strip). If video file, default to horizontal.
const ORIENTATION = process.env.ORIENTATION || (VIDEO_FILE === 'videoplayback.mp4' ? 'horizontal' : 'vertical');

// Dimensions based on Orientation
// Note: VFD Buffer is always 32x140 (Column-Major).
// For Horizontal mode, we generate 140x32 and transpose it to 32x140.
let FRAME_WIDTH, FRAME_HEIGHT;
if (ORIENTATION === 'horizontal') {
    FRAME_WIDTH = 140;
    FRAME_HEIGHT = 32;
} else {
    FRAME_WIDTH = 32;
    FRAME_HEIGHT = 140;
}

const TOTAL_PIXELS = FRAME_WIDTH * FRAME_HEIGHT;
const FRAME_SIZE_BYTES = Math.ceil(TOTAL_PIXELS / 8);

// Dithering Modes
const MODES = {
  none: { contrast: '1.35', brightness: '0.1', algo: 'none' },
  bayer: { contrast: '0.9', brightness: '0.1', algo: 'bayer', opts: ':bayer_scale=2' },
  floyd_steinberg: { contrast: '1.4', brightness: '0.0', algo: 'floyd_steinberg' },
  sierra2: { contrast: '1.25', brightness: '0.0', algo: 'sierra2' },
  sierra2_4a: { contrast: '1.5', brightness: '0.0', algo: 'sierra2_4a' },
  heckbert: { contrast: '1.5', brightness: '0.0', algo: 'heckbert' }
};

const MODE_NAME = process.env.MODE || 'sierra2_4a'; 
const SETTINGS = MODES[MODE_NAME] || MODES.sierra2_4a;

const CONTRAST = process.env.CONTRAST || SETTINGS.contrast;
const BRIGHTNESS = process.env.BRIGHTNESS || SETTINGS.brightness;
const DITHER_ALGO = SETTINGS.algo;
const DITHER_OPTS = SETTINGS.opts || '';

// Compression
const COMPRESSION_ENABLED = process.env.COMPRESSION === 'true' || process.env.COMPRESSION === '1';
const KEYFRAME_INTERVAL = 30; 

// Transpose (for Horizontal Mode)
// 0 = 90CounterCLockwise and Vertical Flip (default) 
// 1 = 90Clockwise 
// 2 = 90CounterClockwise 
// 3 = 90Clockwise and Vertical Flip
// Using 0 to fix "Vertically Mirrored" issue (VFlip of 2)
const TRANSPOSE_MODE = process.env.TRANSPOSE || '0'; 

let serialPort;

try {
  serialPort = new SerialPort({
    path: SERIAL_PORT_PATH,
    baudRate: SERIAL_BAUD,
  });
  serialPort.on('error', (err) => {
    console.error('Serial Port Error:', err.message);
  });
  console.log(`Serial open on ${SERIAL_PORT_PATH} @ ${SERIAL_BAUD}`);
  console.log(`Source: ${VIDEO_FILE}`);
  console.log(`Orientation: ${ORIENTATION} (${FRAME_WIDTH}x${FRAME_HEIGHT})`);
  console.log(`Mode: ${MODE_NAME} | Algo: ${DITHER_ALGO} | Contrast: ${CONTRAST}`);
  console.log(`Compression: ${COMPRESSION_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  if (VIDEO_FILE) console.log(`Start Time: ${START_TIME}`);

} catch (e) {
  console.error('Failed to open serial port:', e.message);
}

let previousFrameBuffer = null;
let frameCount = 0;
let isMcuReady = false; 
let videoBuffer = Buffer.alloc(0);
let ackTimeout = null;

// --- CRC32 ---
const CRC_TABLE = new Int32Array(256);
(function() {
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[i] = c;
  }
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// --- PACKBITS ENCODER (RLE) ---
function packBits(buffer) {
    const result = [];
    let i = 0;
    while (i < buffer.length) {
        let runLen = 1;
        while (i + runLen < buffer.length && runLen < 128 && buffer[i] === buffer[i + runLen]) {
            runLen++;
        }

        if (runLen > 1) {
            result.push(257 - runLen);
            result.push(buffer[i]);
            i += runLen;
        } else {
            let litLen = 0;
            while (i + litLen < buffer.length && litLen < 128) {
                if (i + litLen + 2 < buffer.length && 
                    buffer[i + litLen] === buffer[i + litLen + 1] && 
                    buffer[i + litLen] === buffer[i + litLen + 2]) {
                    break;
                }
                litLen++;
            }
            result.push(litLen - 1);
            for (let k = 0; k < litLen; k++) result.push(buffer[i + k]);
            i += litLen;
        }
    }
    return new Uint8Array(result);
}

serialPort.on('data', (data) => {
  for (const byte of data) {
    if (byte === 0xA5) ackReceived();
    else if (byte === 0xE1) { console.error('MCU: Bad Packet (CRC Fail)'); ackReceived(); }
    else if (byte === 0xE2) { console.error('MCU: No Data'); ackReceived(); }
    else if (byte === 0xE3) { console.error('MCU: Error'); ackReceived(); }
  }
});

function ackReceived() {
  isMcuReady = true;
  if (ackTimeout) clearTimeout(ackTimeout);
  trySendNextFrame();
}

function trySendNextFrame() {
  if (!isMcuReady) return;
  if (videoBuffer.length < FRAME_SIZE_BYTES) return;

  const frameBuffer = videoBuffer.slice(0, FRAME_SIZE_BYTES);
  videoBuffer = videoBuffer.slice(FRAME_SIZE_BYTES);

  isMcuReady = false;
  if (ackTimeout) clearTimeout(ackTimeout);
  ackTimeout = setTimeout(() => { ackReceived(); }, 200);

  processFrame(frameBuffer);
}

function processFrame(frameBuffer) {
  frameCount++;
  let finalBuffer = frameBuffer;
  let type = FrameType.Full;

  if (COMPRESSION_ENABLED && previousFrameBuffer && (frameCount % KEYFRAME_INTERVAL !== 0)) {
      const deltaBuffer = Buffer.alloc(FRAME_SIZE_BYTES);
      let hasChanges = false;
      for (let i = 0; i < FRAME_SIZE_BYTES; i++) {
          deltaBuffer[i] = frameBuffer[i] ^ previousFrameBuffer[i];
          if (deltaBuffer[i] !== 0) hasChanges = true;
      }

      const compressedDelta = packBits(deltaBuffer);
      if (compressedDelta.length < FRAME_SIZE_BYTES) {
          finalBuffer = compressedDelta;
          type = FrameType.Delta;
      }
  }

  previousFrameBuffer = Buffer.from(frameBuffer);

  const builder = new flatbuffers.Builder(1024);
  const dataOffset = Frame.createDataVector(builder, finalBuffer);
  
  const crc = crc32(finalBuffer);

  Frame.startFrame(builder);
  Frame.addType(builder, type);
  Frame.addData(builder, dataOffset);
  Frame.addCrc32(builder, crc);
  const frameOffset = Frame.endFrame(builder);
  builder.finish(frameOffset);
  
  const serializedData = builder.asUint8Array();
  const packet = cobs.encode(Buffer.from(serializedData));

  if (serialPort && serialPort.isOpen) {
    serialPort.write(packet);
    serialPort.write(Buffer.from([0x00])); 
  }
}

// --- FFmpeg Setup ---
const ffmpegArgs = [];

// Check if VIDEO_FILE is a valid file path
if (VIDEO_FILE && fs.existsSync(path.resolve(__dirname, VIDEO_FILE))) {
    // File Input Mode
    const videoPath = path.resolve(__dirname, VIDEO_FILE);
    ffmpegArgs.push(
        '-stream_loop', '-1',
        '-re',
        '-ss', START_TIME,
        '-i', videoPath
    );
} else {
    // Camera Input Mode
    if (VIDEO_FILE && VIDEO_FILE !== 'videoplayback.mp4') {
        console.warn(`Warning: Video file '${VIDEO_FILE}' not found. Falling back to Camera.`);
    }

    // Platform-specific Camera Input
    if (process.platform === 'darwin') {
        ffmpegArgs.push('-f', 'avfoundation', '-framerate', '30', '-video_size', '640x480', '-i', '0');
    } else if (process.platform === 'win32') {
        ffmpegArgs.push('-f', 'dshow', '-i', 'video=Integrated Camera');
    } else {
        // Linux / Default
        ffmpegArgs.push('-f', 'v4l2', '-framerate', '30', '-video_size', '640x480', '-i', '/dev/video0');
    }
}

ffmpegArgs.push('-loglevel', 'error', '-r', '30');

// Filter Logic
let filterGraph = '';
const EQ = `eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS}`;

const SCALE_CROP = `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,crop=${FRAME_WIDTH}:${FRAME_HEIGHT}`;

if (ORIENTATION === 'horizontal') {
    if (DITHER_ALGO !== 'none') {
        const palettePath = path.join(__dirname, 'palette_256.png');
        if (!fs.existsSync(palettePath)) {
            console.error("Error: palette_256.png missing!");
            process.exit(1);
        }
        filterGraph = `[0:v]${SCALE_CROP},transpose=${TRANSPOSE_MODE},${EQ}[v];[v][1:v]paletteuse=dither=${DITHER_ALGO}${DITHER_OPTS}`;
        ffmpegArgs.push('-i', palettePath, '-filter_complex', filterGraph);
    } else {
        filterGraph = `${SCALE_CROP},transpose=${TRANSPOSE_MODE},${EQ},format=gray,format=monob`;
        ffmpegArgs.push('-vf', filterGraph);
    }
} else {
    if (DITHER_ALGO !== 'none') {
        const palettePath = path.join(__dirname, 'palette_256.png');
        filterGraph = `[0:v]${SCALE_CROP},${EQ}[v];[v][1:v]paletteuse=dither=${DITHER_ALGO}${DITHER_OPTS}`;
        ffmpegArgs.push('-i', palettePath, '-filter_complex', filterGraph);
    } else {
        filterGraph = `${SCALE_CROP},${EQ},format=gray,format=monob`;
        ffmpegArgs.push('-vf', filterGraph);
    }
}

ffmpegArgs.push('-f', 'rawvideo', '-pix_fmt', 'monob', '-');

function startStream() {
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
  
  ffmpeg.stdout.on('data', (chunk) => {
    videoBuffer = Buffer.concat([videoBuffer, chunk]);
    if (videoBuffer.length > FRAME_SIZE_BYTES * 5) videoBuffer = videoBuffer.slice(videoBuffer.length - FRAME_SIZE_BYTES);
    trySendNextFrame();
  });

  ffmpeg.on('close', (code) => console.log(`ffmpeg exited ${code}`));
  ffmpeg.on('error', (err) => { console.error('ffmpeg error:', err); process.exitCode = 1; });
  
  process.on('SIGINT', () => { 
      ffmpeg.kill('SIGINT'); 
      if (serialPort && serialPort.isOpen) serialPort.close(); 
  });
}

if (require.main === module) {
  if (serialPort) {
      serialPort.on('open', () => {
          console.log('Waiting for MCU...');
          const pingPacket = cobs.encode(Buffer.from([0xFF]));
          serialPort.write(pingPacket);
          serialPort.write(Buffer.from([0x00])); 
          
          startStream();
      });
  }
}

module.exports = { FRAME_WIDTH, FRAME_HEIGHT };
