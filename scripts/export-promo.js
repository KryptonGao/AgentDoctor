import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const PORT = 8099;
const CHROME_PORT = 9222;
const OUTPUT_FILE = path.resolve(rootDir, 'agentdoctor-promo-30s.webm');

console.log('🚀 AgentDoctor Promo Video Exporter Starting...');

// 1. Start local HTTP server
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let filePath = path.join(rootDir, parsedUrl.pathname === '/' ? 'promo.html' : parsedUrl.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`✓ Local server running on http://127.0.0.1:${PORT}`);

// 2. Launch Chrome headless with remote debugging
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const userDataDir = `/tmp/chrome-ad-export-${Date.now()}`;

const chromeProcess = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${CHROME_PORT}`,
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--allow-file-access-from-files',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1920,1080',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `http://127.0.0.1:${PORT}/promo.html?auto=1`
], {
  stdio: 'ignore'
});

console.log('✓ Chrome launched in headless mode, connecting to promo page...');

// 3. Find the actual page target in Chrome (filter out omnibox and extensions)
async function getWebSocketUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`);
      const list = await res.json();
      const pageTarget = list.find(t => t.type === 'page' && t.url && t.url.includes('promo.html'));
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl;
      }
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Failed to find promo page target in Chrome');
}

const wsUrl = await getWebSocketUrl();
const ws = new WebSocket(wsUrl);

let msgId = 1;
const pending = new Map();

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(data.error);
    else resolve(data.result);
  }
};

function sendCdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise(r => ws.onopen = r);
console.log('✓ Connected to Promo Page via Chrome DevTools Protocol');

// Enable Runtime
await sendCdp('Runtime.enable');

// 4. Poll for recording completion
console.log('🎬 Recording 30-second promo video and procedural audio...');
const startTime = Date.now();

let completed = false;
while (!completed) {
  await new Promise(r => setTimeout(r, 800));
  const elapsed = Math.floor((Date.now() - startTime) / 1000);

  const res = await sendCdp('Runtime.evaluate', {
    expression: 'Boolean(window.videoExportComplete)',
    returnByValue: true
  });

  if (res && res.result && res.result.value === true) {
    completed = true;
    console.log(`\n✓ Video recording completed at ${elapsed}s!`);
    break;
  }

  // Also query video time from DOM
  const timeRes = await sendCdp('Runtime.evaluate', {
    expression: 'document.getElementById("timeLabel")?.textContent || ""',
    returnByValue: true
  });
  const timeText = (timeRes && timeRes.result && timeRes.result.value) || `${elapsed}s`;

  process.stdout.write(`\rRecording progress: ${timeText} (${Math.min(100, Math.floor(elapsed / 31 * 100))}%)`);

  if (elapsed > 45) {
    console.error('\nTimeout waiting for export');
    break;
  }
}

// 5. Retrieve base64 video data and save to file
console.log('\n📦 Extracting video file buffer from browser...');
const result = await sendCdp('Runtime.evaluate', {
  expression: 'window.videoExportBase64',
  returnByValue: true
});

if (result && result.result && result.result.value) {
  const buffer = Buffer.from(result.result.value, 'base64');
  fs.writeFileSync(OUTPUT_FILE, buffer);
  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Success! Exported promo video saved to:`);
  console.log(`👉 ${OUTPUT_FILE} (${sizeMB} MB)`);
} else {
  console.error('Failed to retrieve video data');
}

// Clean up
try {
  ws.close();
  chromeProcess.kill('SIGKILL');
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  // ignore
}

console.log('Done!');
process.exit(0);
