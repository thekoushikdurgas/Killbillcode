import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { createCanvas, loadImage } from 'canvas';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const encodeProgressMap = new Map<string, { status: string, progress: number, timestamp: number }>();
const decodeProgressMap = new Map<string, { status: string, progress: number, timestamp: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of encodeProgressMap.entries()) {
    if (now - job.timestamp > 3600000) encodeProgressMap.delete(jobId);
  }
  for (const [jobId, job] of decodeProgressMap.entries()) {
    if (now - job.timestamp > 3600000) decodeProgressMap.delete(jobId);
  }
}, 60000);

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  fs.mkdirSync(path.join(process.cwd(), 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'frames'), { recursive: true });

  const upload = multer({ dest: 'uploads/' });

  app.use(express.json());

  app.get('/api/progress/encode/:jobId', (req, res) => {
    const job = encodeProgressMap.get(req.params.jobId);
    if (!job) return res.json({ progress: 0, status: 'unknown' });
    res.json(job);
  });

  app.get('/api/progress/decode/:jobId', (req, res) => {
    const job = decodeProgressMap.get(req.params.jobId);
    if (!job) return res.json({ progress: 0, status: 'unknown' });
    res.json(job);
  });

  // API to encode text to mp4
  app.post('/api/encode', upload.single('csv'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No CSV provided' });
      
      let WIDTH = parseInt(req.body.width, 10);
      let HEIGHT = parseInt(req.body.height, 10);
      if (isNaN(WIDTH)) WIDTH = 1280;
      if (isNaN(HEIGHT)) HEIGHT = 720;
      const fps = parseInt(req.body.fps, 10) || 1;
      const bitrate = req.body.bitrate || 'lossless';
      const jobId = req.body.jobId;

      const updateProgress = (status: string, progress: number) => {
        if (jobId) {
          encodeProgressMap.set(jobId, { status, progress, timestamp: Date.now() });
        }
      };

      updateProgress('generating_frames', 0);

      let rawData = fs.readFileSync(req.file.path);
      const manualKeyString = req.body.encryptionKey || "DEFAULT_KEY";
      
      const BLOCK_SIZE = 8;
      const BLOCKS_X = Math.floor(WIDTH / BLOCK_SIZE);
      const BLOCKS_Y = Math.floor(HEIGHT / BLOCK_SIZE);
      const TOTAL_BLOCKS = BLOCKS_X * BLOCKS_Y;
      const CORNER_BLOCKS = 144; // 12x12
      const DATA_BLOCKS = TOTAL_BLOCKS - CORNER_BLOCKS;
      
      if (DATA_BLOCKS < 100) throw new Error("Video resolution too small");

      const MAX_ENCRYPTED_BYTES = Math.floor((DATA_BLOCKS * 3) / 8); 
      const MAX_RAW_PER_FRAME = MAX_ENCRYPTED_BYTES - 2; 

      const numFrames = Math.max(1, Math.ceil(rawData.length / MAX_RAW_PER_FRAME));
      
      const framesDir = path.join(process.cwd(), 'frames', Date.now().toString());
      fs.mkdirSync(framesDir, { recursive: true });
      
      const actualWidth = BLOCKS_X * BLOCK_SIZE;
      const actualHeight = BLOCKS_Y * BLOCK_SIZE;
      
      const manualKeyHash = crypto.createHash('sha256').update(String(manualKeyString)).digest();
      const isCorner = (bx: number, by: number) => bx < 12 && by < 12;

      for (let i = 0; i < numFrames; i++) {
        const startRaw = i * MAX_RAW_PER_FRAME;
        const endRaw = Math.min(startRaw + MAX_RAW_PER_FRAME, rawData.length);
        const rawChunk = rawData.subarray(startRaw, endRaw);

        const chunkWithLen = Buffer.alloc(rawChunk.length + 2);
        chunkWithLen.writeUInt16BE(rawChunk.length, 0);
        rawChunk.copy(chunkWithLen, 2);

        const frameKey = crypto.randomBytes(32);
        const frameIV = crypto.randomBytes(16);

        const keyCipher = crypto.createCipheriv('aes-256-ctr', manualKeyHash, frameIV);
        const encryptedFrameKey = Buffer.concat([keyCipher.update(frameKey), keyCipher.final()]);

        const dataCipher = crypto.createCipheriv('aes-256-ctr', frameKey, frameIV);
        const encryptedChunk = Buffer.concat([dataCipher.update(chunkWithLen), dataCipher.final()]);

        const cornerData = Buffer.concat([frameIV, encryptedFrameKey]);
        const cornerBits: number[] = [];
        for (let b = 0; b < cornerData.length; b++) {
          const byte = cornerData[b];
          for (let bit = 7; bit >= 0; bit--) cornerBits.push((byte >> bit) & 1);
        }

        const dataBits: number[] = [];
        for (let b = 0; b < encryptedChunk.length; b++) {
          const byte = encryptedChunk[b];
          for (let bit = 7; bit >= 0; bit--) dataBits.push((byte >> bit) & 1);
        }

        const canvas = createCanvas(actualWidth, actualHeight);
        const ctx = canvas.getContext('2d')!;
        
        const imageData = ctx.createImageData(actualWidth, actualHeight);
        const pixels = imageData.data;
        
        let cornerBitIdx = 0;
        let dataBitIdx = 0;

        for (let by = 0; by < BLOCKS_Y; by++) {
          for (let bx = 0; bx < BLOCKS_X; bx++) {
            const px = bx * BLOCK_SIZE;
            const py = by * BLOCK_SIZE;
            
            let targetR = 192, targetG = 192, targetB = 192;
            let tileStyle = 0; // 0=unrevealed, 1=flag, 2=empty, 3=1, 4=2, 5=3, 6=4

            const zone = Math.sin(bx * 0.2 + 1) * Math.cos(by * 0.2) + Math.sin((bx + by) * 0.05);
            const rand = Math.abs(Math.sin(bx * 12.9898 + by * 78.233)) * 43758.5453;
            const frac = rand - Math.floor(rand);

            if (zone > 0.5) {
                tileStyle = 0;
                if (frac < 0.05) tileStyle = 1;
            } else if (zone > 0.0) {
                if (frac < 0.15) tileStyle = 1;
                else if (frac < 0.4) tileStyle = 3; // 1
                else if (frac < 0.6) tileStyle = 4; // 2
                else if (frac < 0.7) tileStyle = 5; // 3
                else if (frac < 0.75) tileStyle = 6; // 4
                else tileStyle = 0;
            } else {
                if (frac < 0.1) tileStyle = 3;
                else if (frac < 0.15) tileStyle = 4;
                else tileStyle = 2; // empty
            }

            if (isCorner(bx, by)) {
               tileStyle = 0;
            }

            if (tileStyle === 1) { targetR = 255; targetG = 0; targetB = 0; }
            else if (tileStyle === 3) { targetR = 0; targetG = 0; targetB = 255; }
            else if (tileStyle === 4) { targetR = 0; targetG = 128; targetB = 0; }
            else if (tileStyle === 5) { targetR = 255; targetG = 0; targetB = 0; }
            else if (tileStyle === 6) { targetR = 0; targetG = 0; targetB = 128; }
            else { targetR = 192; targetG = 192; targetB = 192; }

            let bitR = 0, bitG = 0, bitB = 0;
            
            if (isCorner(bx, by)) {
              if (cornerBitIdx < 384) {
                 bitR = cornerBits[cornerBitIdx++];
                 bitG = cornerBits[cornerBitIdx++];
                 bitB = cornerBits[cornerBitIdx++];
              }
            } else {
              bitR = dataBitIdx < dataBits.length ? dataBits[dataBitIdx++] : 0;
              bitG = dataBitIdx < dataBits.length ? dataBits[dataBitIdx++] : 0;
              bitB = dataBitIdx < dataBits.length ? dataBits[dataBitIdx++] : 0;
            }

            let finR = (Math.floor(targetR / 64) * 64) + 16 + (bitR * 32);
            let finG = (Math.floor(targetG / 64) * 64) + 16 + (bitG * 32);
            let finB = (Math.floor(targetB / 64) * 64) + 16 + (bitB * 32);
            
            finR = Math.min(255, Math.max(0, finR));
            finG = Math.min(255, Math.max(0, finG));
            finB = Math.min(255, Math.max(0, finB));

            for (let y = 0; y < BLOCK_SIZE; y++) {
              for (let x = 0; x < BLOCK_SIZE; x++) {
                const pIdx = ((py + y) * actualWidth + (px + x)) * 4;
                let pR = 192, pG = 192, pB = 192;
                
                if (tileStyle === 0 || tileStyle === 1) {
                    if (x === 0 || y === 0) { pR = 240; pG = 240; pB = 240; }
                    else if (x === 7 || y === 7) { pR = 100; pG = 100; pB = 100; }
                    else if (x >= 2 && x <= 5 && y >= 2 && y <= 5) { pR = finR; pG = finG; pB = finB; }
                    else { pR = 192; pG = 192; pB = 192; }
                } else {
                    if (x === 0 || y === 0) { pR = 100; pG = 100; pB = 100; }
                    else if (x >= 2 && x <= 5 && y >= 2 && y <= 5) { pR = finR; pG = finG; pB = finB; }
                    else { pR = 192; pG = 192; pB = 192; }
                }

                pixels[pIdx] = pR;
                pixels[pIdx+1] = pG;
                pixels[pIdx+2] = pB;
                pixels[pIdx+3] = 255;
              }
            }
          }
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        const out = fs.createWriteStream(path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`));
        const stream = canvas.createPNGStream();
        stream.pipe(out);
        await new Promise<void>((resolve) => out.on('finish', () => resolve()));

        if (i % 10 === 0) {
          updateProgress('generating_frames', Math.round((i / numFrames) * 100));
        }
      }
      
      updateProgress('encoding_video', 0);

      const outputName = `${Date.now()}.mp4`;
      const outputPath = path.join(process.cwd(), 'uploads', outputName);
      
      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg()
          .input(path.join(framesDir, 'frame-%04d.png'))
          .inputFPS(fps)
          .output(outputPath)
          .videoCodec('libx264');

        let outOpts = ['-pix_fmt yuv420p'];
        if (bitrate === 'lossless') {
           outOpts.push('-crf', '2'); // Using 2 instead of 0 because 0 creates High 4:4:4 Predictive profile which browsers cannot play.
        } else {
           outOpts.push('-b:v', bitrate);
        }

        cmd.outputOptions(outOpts)
          .on('progress', (progress) => {
             if (progress.frames) {
               updateProgress('encoding_video', Math.round((progress.frames / numFrames) * 100));
             }
          })
          .on('end', () => {
             updateProgress('done', 100);
             resolve();
          })
          .on('error', reject)
          .run();
      });
      
      // cleanup frames
      fs.rmSync(framesDir, { recursive: true, force: true });
      fs.unlinkSync(req.file.path);
      
      res.json({ 
        url: `/api/video/${outputName}`,
        downloadUrl: `/api/download/${outputName}` 
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  // API to decode mp4 to text
  app.post('/api/decode', upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No video provided' });
    
    try {
      const jobId = req.body.jobId;
      const updateProgress = (status: string, progress: number) => {
        if (jobId) {
          decodeProgressMap.set(jobId, { status, progress, timestamp: Date.now() });
        }
      };

      const framesDir = path.join(process.cwd(), 'frames', req.file.filename);
      fs.mkdirSync(framesDir, { recursive: true });
      
      updateProgress('extracting_frames', 0);

      await new Promise((resolve, reject) => {
        ffmpeg(req.file!.path)
          .output(path.join(framesDir, 'frame-%04d.png'))
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const files = fs.readdirSync(framesDir).sort();
      if (files.length === 0) throw new Error("No frames could be extracted from video");
      
      updateProgress('reading_frames', 0);

      const firstImg = await loadImage(path.join(framesDir, files[0]));
      
      const BLOCK_SIZE = 8;
      const WIDTH = firstImg.width;
      const HEIGHT = firstImg.height;
      const BLOCKS_X = Math.floor(WIDTH / BLOCK_SIZE);
      const BLOCKS_Y = Math.floor(HEIGHT / BLOCK_SIZE);
      const actualWidth = BLOCKS_X * BLOCK_SIZE;
      const actualHeight = BLOCKS_Y * BLOCK_SIZE;
      const TOTAL_BLOCKS = BLOCKS_X * BLOCKS_Y;
      const CORNER_BLOCKS = 144;
      const DATA_BLOCKS = TOTAL_BLOCKS - CORNER_BLOCKS;
      const MAX_ENCRYPTED_BYTES = Math.floor((DATA_BLOCKS * 3) / 8); 
      
      const canvas = createCanvas(actualWidth, actualHeight);
      const ctx = canvas.getContext('2d')!;
      const chunkBuffers: Buffer[] = [];
      
      const manualKeyString = req.body.decryptionKey || "DEFAULT_KEY";
      const manualKeyHash = crypto.createHash('sha256').update(String(manualKeyString)).digest();
      const isCorner = (bx: number, by: number) => bx < 12 && by < 12;
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const img = await loadImage(path.join(framesDir, file));
        ctx.clearRect(0, 0, actualWidth, actualHeight);
        ctx.drawImage(img, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, actualWidth, actualHeight).data;
        const cornerBits: number[] = [];
        const dataBits: number[] = [];

        for (let by = 0; by < BLOCKS_Y; by++) {
          for (let bx = 0; bx < BLOCKS_X; bx++) {
             const px = bx * BLOCK_SIZE + Math.floor(BLOCK_SIZE / 2);
             const py = by * BLOCK_SIZE + Math.floor(BLOCK_SIZE / 2);
             const pIdx = (py * actualWidth + px) * 4;
             
             const r = imageData[pIdx];
             const g = imageData[pIdx+1];
             const b = imageData[pIdx+2];

             if(isCorner(bx, by)) {
                if(cornerBits.length < 384) {
                   cornerBits.push((r % 64) > 32 ? 1 : 0);
                   cornerBits.push((g % 64) > 32 ? 1 : 0);
                   cornerBits.push((b % 64) > 32 ? 1 : 0);
                }
             } else {
                dataBits.push((r % 64) > 32 ? 1 : 0);
                dataBits.push((g % 64) > 32 ? 1 : 0);
                dataBits.push((b % 64) > 32 ? 1 : 0);
             }
          }
        }
           
        const cornerData = Buffer.alloc(48);
        for (let b = 0; b < 48; b++) {
           let byte = 0;
           for (let bit = 0; bit < 8; bit++) {
              if (cornerBits[b*8 + bit]) byte |= (1 << (7 - bit));
           }
           cornerData[b] = byte;
        }

        const frameIV = cornerData.subarray(0, 16);
        const encryptedFrameKey = cornerData.subarray(16, 48);

         let frameKey;
         try {
           const keyDecipher = crypto.createDecipheriv('aes-256-ctr', manualKeyHash, frameIV);
           frameKey = Buffer.concat([keyDecipher.update(encryptedFrameKey), keyDecipher.final()]);
         } catch(e) {
           throw new Error("Failed to decrypt FrameKey. Is the manual key correct?");
         }

        const maxEncData = Buffer.alloc(MAX_ENCRYPTED_BYTES);
        for (let b = 0; b < MAX_ENCRYPTED_BYTES; b++) {
           let byte = 0;
           for(let bit = 0; bit < 8; bit++) {
              if (dataBits[b*8 + bit]) byte |= (1 << (7 - bit));
           }
           maxEncData[b] = byte;
        }

         let decryptedChunk;
         try {
           const dataDecipher = crypto.createDecipheriv('aes-256-ctr', frameKey, frameIV);
           decryptedChunk = Buffer.concat([dataDecipher.update(maxEncData), dataDecipher.final()]);
         } catch(e) {
           console.error("Frame chunk decrypt failed");
           continue; 
         }

        const validLen = decryptedChunk.readUInt16BE(0);
        if (validLen > decryptedChunk.length - 2) {
           console.warn(`Frame ${i}: Valid length ${validLen} out of bounds. Corruption?`);
        } else {
           chunkBuffers.push(decryptedChunk.subarray(2, 2 + validLen));
        }

        if (i % 10 === 0) {
           updateProgress('reading_frames', Math.round((i / files.length) * 100));
        }
      }
      
      const fullBuffer = Buffer.concat(chunkBuffers);
      const data = fullBuffer.toString('utf-8');

      updateProgress('done', 100);
      
      // cleanup
      fs.rmSync(framesDir, { recursive: true, force: true });
      fs.unlinkSync(req.file!.path);
      
      res.json({ data });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/download/:file', (req, res) => {
    const file = req.params.file;
    const filePath = path.join(process.cwd(), 'uploads', file);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found");
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="data-encoded.mp4"');
    
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
    
    fileStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).send('Error reading file');
      }
    });
  });

  app.get('/api/video/:file', (req, res) => {
    const file = req.params.file;
    res.sendFile(path.join(process.cwd(), 'uploads', file));
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
