import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Get current directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const YTDLP_PATH = 'C:/Users/AashiQ/AppData/Roaming/Python/Python313/Scripts/yt-dlp.exe';

const app = express();
const PORT = 4000;

// Enhanced CORS configuration
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://project-onkxo0gnz-ashiq1923s-projects.vercel.app' // Allow Vercel frontend
  ], 
  credentials: true,
  exposedHeaders: ['Content-Disposition', 'Content-Type', 'Content-Length']
}));

app.use(express.json({ limit: '10mb' }));

// Helper: Validate supported platforms
const SUPPORTED_PLATFORMS = [
  'youtube.com', 'youtu.be',
  'facebook.com', 'fb.watch',
  'instagram.com',
  'tiktok.com'
];

function isSupportedUrl(url) {
  try {
    const u = new URL(url);
    return SUPPORTED_PLATFORMS.some(domain => u.hostname.includes(domain));
  } catch {
    return false;
  }
}

function createSafeFilename(title) {
  return title
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .substring(0, 50)
    .trim();
}

// Test yt-dlp with direct execution
async function testYtDlp() {
  return new Promise((resolve, reject) => {
    console.log('Testing yt-dlp path:', YTDLP_PATH);
    console.log('yt-dlp exists:', existsSync(YTDLP_PATH));
    
    const ytdlpCommand = existsSync(YTDLP_PATH) ? YTDLP_PATH : 'yt-dlp';
    const testProcess = spawn(ytdlpCommand, ['--version']);
    
    let stdout = '';
    let stderr = '';
    
    testProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    testProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    testProcess.on('close', (code) => {
      if (code === 0 && stdout) {
        console.log('yt-dlp version:', stdout.trim());
        resolve(!existsSync(YTDLP_PATH)); // Return true if using system PATH
      } else {
        console.error('yt-dlp test failed:', stderr);
        reject(new Error('yt-dlp not accessible'));
      }
    });
    
    testProcess.on('error', (error) => {
      console.error('yt-dlp spawn error:', error);
      reject(error);
    });
  });
}

// Global variable to track yt-dlp setup
let useSystemPath = true;

// Execute yt-dlp command directly
function executeYtDlp(url, args = [], abortSignal = null) {
  return new Promise((resolve, reject) => {
    const ytdlpCommand = useSystemPath ? 'yt-dlp' : YTDLP_PATH;
    
    const process = spawn(ytdlpCommand, [url, ...args]);
    
    let stdout = '';
    let stderr = '';
    
    // Handle abort signal
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        console.log('Download cancelled by user');
        process.kill('SIGTERM');
        reject(new Error('Download cancelled'));
      });
    }
    
    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });
    
    process.on('error', (error) => {
      reject(error);
    });
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Backend is running',
    ytdlpPath: YTDLP_PATH,
    useSystemPath: useSystemPath,
    timestamp: new Date().toISOString()
  });
});

// Video info endpoint - FIXED VERSION
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }
  
  if (!isSupportedUrl(url)) {
    return res.status(400).json({ 
      error: 'Unsupported platform. We support YouTube, Facebook, Instagram, and TikTok.' 
    });
  }

  console.log('Info request for:', url);

  try {
    const args = [
      '--dump-single-json',
      '--no-playlist'
    ];

    console.log('Fetching video info...');
    
    const result = await executeYtDlp(url, args);
    
    if (!result.stdout) {
      console.error('No video info received');
      return res.status(500).json({ error: 'Could not fetch video information.' });
    }

    const info = JSON.parse(result.stdout);

    console.log('Video info fetched successfully:', {
      title: info.title,
      duration: info.duration,
      uploader: info.uploader
    });

    const responseData = {
      title: info.title || info.fulltitle || 'Unknown Title',
      duration: info.duration || null,
      uploader: info.uploader || info.channel || 'Unknown',
      thumbnail: info.thumbnail || null,
      description: info.description ? info.description.substring(0, 200) + '...' : null,
      formats: info.formats ? info.formats.length : 0
    };

    res.json(responseData);

  } catch (err) {
    console.error('Info fetch error:', err);
    res.status(500).json({ 
      error: 'Failed to fetch video information.',
      details: err.message 
    });
  }
});

// Download endpoint - FIXED VERSION
app.post('/api/download', async (req, res) => {
  const { url, format = 'best', platform } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }
  
  if (!isSupportedUrl(url)) {
    return res.status(400).json({ 
      error: 'Unsupported platform. We support YouTube, Facebook, Instagram, and TikTok.' 
    });
  }

  console.log('Download request for:', url);
  console.log('Requested format:', format);

  // Create AbortController for this request
  const abortController = new AbortController();
  
  // Handle client disconnect
  req.on('close', () => {
    console.log('Client disconnected, cancelling download');
    abortController.abort();
  });

  try {
    // First get basic info for filename
    const infoArgs = ['--dump-single-json', '--no-playlist'];
    
    // Add TikTok-specific info arguments
    if (url.includes('tiktok.com')) {
      infoArgs.push(
        '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com',
        '--force-generic-extractor'
      );
    }
    
    const infoResult = await executeYtDlp(url, infoArgs, abortController.signal);
    
    if (!infoResult) {
      return res.status(500).json({ error: 'Could not fetch video information for download.' });
    }

    const info = JSON.parse(infoResult);
    const safeTitle = createSafeFilename(info.title);
    const filename = `${safeTitle}.mp4`;

    console.log('Starting download for:', info.title);
    console.log('Filename will be:', filename);

    // Set response headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    // Determine format string based on request
    let formatString = 'best[height<=1080]/best[height<=720]/best';
    
    // Special handling for TikTok videos
    const isTikTok = url.includes('tiktok.com');
    
    if (isTikTok) {
      // TikTok specific format selection - force video with audio
      if (format.includes('mp3') || format.includes('audio')) {
        formatString = 'bestaudio[ext=mp3]/bestaudio/best';
      } else if (format.includes('1080') || format.includes('4k')) {
        formatString = 'best[height<=1080][ext=mp4]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]';
      } else if (format.includes('720')) {
        formatString = 'best[height<=720][ext=mp4]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]';
      } else if (format.includes('480')) {
        formatString = 'best[height<=480][ext=mp4]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]';
      } else if (format.includes('360')) {
        formatString = 'best[height<=360][ext=mp4]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=240][ext=mp4]';
      } else if (format.includes('240')) {
        formatString = 'best[height<=240][ext=mp4]/bestvideo[height<=240][ext=mp4]+bestaudio[ext=m4a]/worst[ext=mp4]';
      } else {
        // Default TikTok format - force video with audio
        formatString = 'best[ext=mp4]/best[height<=720][ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]';
      }
    } else {
      // Regular format selection for other platforms
      if (format.includes('1080') || format.includes('4k')) {
        formatString = 'best[height<=1080]/best[height<=720]/best';
      } else if (format.includes('720')) {
        formatString = 'best[height<=720]/best[height<=480]/best';
      } else if (format.includes('480')) {
        formatString = 'best[height<=480]/best[height<=360]/best';
      } else if (format.includes('360')) {
        formatString = 'best[height<=360]/best[height<=240]/best';
      } else if (format.includes('240')) {
        formatString = 'best[height<=240]/worst';
      } else if (format.includes('mp3') || format.includes('audio')) {
        formatString = 'bestaudio[ext=mp3]/bestaudio/best';
      } else if (format.includes('aac')) {
        formatString = 'bestaudio[ext=aac]/bestaudio/best';
      } else if (format.includes('m4a')) {
        formatString = 'bestaudio[ext=m4a]/bestaudio/best';
      } else if (format.includes('ogg')) {
        formatString = 'bestaudio[ext=ogg]/bestaudio/best';
      } else if (format.includes('wav')) {
        formatString = 'bestaudio[ext=wav]/bestaudio/best';
      } else if (format.includes('flac')) {
        formatString = 'bestaudio[ext=flac]/bestaudio/best';
      } else if (format.includes('avi')) {
        formatString = 'best[ext=avi]/best';
      } else if (format.includes('mov')) {
        formatString = 'best[ext=mov]/best';
      } else if (format.includes('mkv')) {
        formatString = 'best[ext=mkv]/best';
      } else if (format.includes('webm')) {
        formatString = 'best[ext=webm]/best';
      } else if (format.includes('flv')) {
        formatString = 'best[ext=flv]/best';
      } else if (format.includes('wmv')) {
        formatString = 'best[ext=wmv]/best';
      } else if (format.includes('worst')) {
        formatString = 'worst';
      } else if (format.includes('audio-only')) {
        formatString = 'bestaudio/best';
      } else if (format.includes('video-only')) {
        formatString = 'bestvideo/best';
      } else if (format.includes('best')) {
        formatString = 'best';
      } else {
        // Default: Try to get best quality available
        formatString = 'best[height<=1080]/best[height<=720]/best[height<=480]/best';
      }
    }

    // Download arguments
    const downloadArgs = [
      '--format', formatString,
      '--output', '-',
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--prefer-free-formats',
      '--add-header', 'referer:youtube.com',
      '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    ];

    // Add TikTok-specific arguments
    if (isTikTok) {
      downloadArgs.push(
        '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com',
        '--force-generic-extractor',
        '--no-part',
        '--merge-output-format', 'mp4',
        '--postprocessors', 'merge',
        '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--add-header', 'referer:https://www.tiktok.com/',
        '--add-header', 'accept:video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5'
      );
    }

    console.log('Download args:', downloadArgs);

    // Execute download with abort signal
    const downloadProcess = await executeYtDlp(url, downloadArgs, abortController.signal);
    
    // Stream the download to client
    res.send(downloadProcess);
    
  } catch (error) {
    if (error.message === 'Download cancelled') {
      console.log('Download was cancelled by user');
      res.status(499).json({ error: 'Download cancelled by user' });
    } else {
      console.error('Download error:', error);
      res.status(500).json({ 
        error: 'Download failed.',
        details: error.message 
      });
    }
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  
  try {
    useSystemPath = await testYtDlp();
    console.log('Using system PATH for yt-dlp:', useSystemPath);
    console.log('yt-dlp setup completed successfully!');
  } catch (error) {
    console.error('yt-dlp setup failed:', error.message);
    console.log('Downloads may not work properly');
    useSystemPath = true; // Fallback to system PATH
  }
});