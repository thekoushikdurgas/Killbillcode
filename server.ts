import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import ffmpegPath from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { createCanvas, loadImage } from 'canvas';

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  fs.mkdirSync(path.join(process.cwd(), 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'frames'), { recursive: true });

  const upload = multer({ dest: 'uploads/' });

  app.use(express.json());

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

      const buffer = fs.readFileSync(req.file.path);
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(buffer.length, 0);
      
      const fullBuffer = Buffer.concat([lengthBuffer, buffer]);
      
      const BLOCK_SIZE = 8;
      const BLOCKS_X = Math.floor(WIDTH / BLOCK_SIZE);
      const BLOCKS_Y = Math.floor(HEIGHT / BLOCK_SIZE);
      const BITS_PER_FRAME = BLOCKS_X * BLOCKS_Y;
      const BYTES_PER_FRAME = Math.floor(BITS_PER_FRAME / 8);
      
      const numFrames = Math.ceil(fullBuffer.length / BYTES_PER_FRAME);
      
      const framesDir = path.join(process.cwd(), 'frames', Date.now().toString());
      fs.mkdirSync(framesDir, { recursive: true });
      
      for (let i = 0; i < numFrames; i++) {
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        
        let bitIndex = 0;
        for (let j = 0; j < BYTES_PER_FRAME; j++) {
          const byteIndex = i * BYTES_PER_FRAME + j;
          if (byteIndex < fullBuffer.length) {
            const byte = fullBuffer[byteIndex];
            for (let b = 7; b >= 0; b--) {
              const bit = (byte >> b) & 1;
              const bx = bitIndex % BLOCKS_X;
              const by = Math.floor(bitIndex / BLOCKS_X);
              ctx.fillStyle = bit === 1 ? 'white' : 'black';
              ctx.fillRect(bx * BLOCK_SIZE, by * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
              bitIndex++;
            }
          }
        }
        
        const out = fs.createWriteStream(path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`));
        const stream = canvas.createPNGStream();
        stream.pipe(out);
        await new Promise((resolve) => out.on('finish', resolve));
      }
      
      const outputName = `${Date.now()}.mp4`;
      const outputPath = path.join(process.cwd(), 'uploads', outputName);
      
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg()
          .input(path.join(framesDir, 'frame-%04d.png'))
          .inputFPS(fps)
          .output(outputPath)
          .videoCodec('libx264');

        let outOpts = ['-pix_fmt yuv420p'];
        if (bitrate === 'lossless') {
           outOpts.push('-crf', '0');
        } else {
           outOpts.push('-b:v', bitrate);
        }

        cmd.outputOptions(outOpts)
          .on('end', resolve)
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
      const framesDir = path.join(process.cwd(), 'frames', req.file.filename);
      fs.mkdirSync(framesDir, { recursive: true });
      
      await new Promise((resolve, reject) => {
        ffmpeg(req.file!.path)
          .output(path.join(framesDir, 'frame-%04d.png'))
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      const files = fs.readdirSync(framesDir).sort();
      if (files.length === 0) throw new Error("No frames could be extracted from video");
      
      const firstImg = await loadImage(path.join(framesDir, files[0]));
      
      const BLOCK_SIZE = 8;
      const WIDTH = firstImg.width;
      const HEIGHT = firstImg.height;
      const BLOCKS_X = Math.floor(WIDTH / BLOCK_SIZE);
      const BLOCKS_Y = Math.floor(HEIGHT / BLOCK_SIZE);
      const BYTES_PER_FRAME = Math.floor((BLOCKS_X * BLOCKS_Y) / 8);
      
      const canvas = createCanvas(WIDTH, HEIGHT);
      const ctx = canvas.getContext('2d');
      const chunks: Buffer[] = [];
      
      for (const file of files) {
        const img = await loadImage(path.join(framesDir, file));
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        ctx.drawImage(img, 0, 0);
        
        let bits = [];
        const actualWidth = Math.min(img.width, WIDTH);
        const actualHeight = Math.min(img.height, HEIGHT);
        const bx_count = Math.floor(actualWidth / BLOCK_SIZE);
        const by_count = Math.floor(actualHeight / BLOCK_SIZE);
        
        const imageData = ctx.getImageData(0, 0, actualWidth, actualHeight).data;
        const frameBuffer = Buffer.alloc(BYTES_PER_FRAME);
        let byteIndex = 0;
        
        for (let y = 0; y < by_count; y++) {
          for (let x = 0; x < bx_count; x++) {
            if (byteIndex >= BYTES_PER_FRAME) break;
            
            const px = x * BLOCK_SIZE + Math.floor(BLOCK_SIZE / 2);
            const py = y * BLOCK_SIZE + Math.floor(BLOCK_SIZE / 2);
            const i = (py * actualWidth + px) * 4;
            
            const luminance = (imageData[i] * 0.299 + imageData[i+1] * 0.587 + imageData[i+2] * 0.114);
            bits.push(luminance > 128 ? 1 : 0);
            
            if (bits.length === 8) {
              const byte = bits.reduce((acc, bit, idx) => acc | (bit << (7 - idx)), 0);
              frameBuffer[byteIndex++] = byte;
              bits = [];
            }
          }
        }
        chunks.push(frameBuffer);
      }
      
      const fullBuffer = Buffer.concat(chunks);
      
      // Reconstruct
      if (fullBuffer.length < 4) {
        throw new Error("Could not decode enough data. The video file might be malformed or not generated by this tool.");
      }
      const dataLen = fullBuffer.readUInt32BE(0);
      if (dataLen === 0 || dataLen > 1536 * 1024 * 1024) {
        throw new Error("Invalid embedded data length detected. Ensure the video was created by this tool without compression artifacts.");
      }
      
      const data = fullBuffer.subarray(4, 4 + dataLen).toString('utf-8');
      
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
