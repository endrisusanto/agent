import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

export interface DeviceInfo {
  serial: string;
  pcId: string;
  state: string;
  is_userdebug: boolean;
  fingerprint: string;
  security_patch: string;
  android: string;
  sdk: string;
  sales_code: string;
  model: string;
  pda: string;
  cp: string;
  csc: string;
  ip: string;
  busy: boolean;
  busy_reason: string;
  run_id?: string;
  result_dir?: string;
  battery_level?: number;
  last_seen: number;
}

export interface LaundryZipItem {
  filename: string;
  path: string;
  sizeBytes: number;
  modifiedAt: number;
  model?: string;
  pcId: string;
}

export interface BridgeNode {
  pcId: string;
  os: string;
  ip: string;
  autoRoot: string;
  toolsVersion?: Record<string, string>;
  connectedAt: number;
  ws?: WebSocket;
  laundryZips: LaundryZipItem[];
}

export interface SuiteStatus {
  run_id: string;
  test_type: string;
  suite: string;
  status: string;
  devices: string;
  elapsed_secs: number;
  log_file: string;
  pcId: string;
}

export interface SuiteSummary {
  run_id: string;
  test_type: string;
  suite: string;
  devices: string;
  run_time: string;
  modules: string;
  total: number;
  passed: number;
  failed: number;
  pcId: string;
}

export interface ActiveJob {
  run_id: string;
  pcId: string;
  test_type: string;
  status: string;
  suite: string;
  startedAt: number;
  devices: string[];
  elapsed_secs: number;
  summary?: SuiteSummary;
  zip_file?: string;
  zip_files?: string[];
  recentLogs: string[];
}

import fs from 'fs';

function extractModelFromFilename(filename: string): string | undefined {
  const smMatch = filename.match(/\b(SM-[A-Za-z0-9]+)\b/i) || filename.match(/(SM-[A-Za-z0-9]+)/i);
  if (smMatch && smMatch[1]) {
    return smMatch[1].toUpperCase();
  }
  const base = filename.replace(/\.zip$/i, '');
  const tokens = base.split(/[_/\-\s]+/);
  for (const token of tokens) {
    if (/^[A-Za-z0-9]{4,}$/.test(token)) {
      const raw = token.toUpperCase();
      if (/^[ASFMXT][0-9]{3}[A-Z0-9]*$/.test(raw)) {
        return `SM-${raw}`;
      }
    }
  }
  return undefined;
}

export function scanLocalCucianZips(): LaundryZipItem[] {
  const dirs = [
    process.env.CUCIAN_DIR,
    '/cucian',
    '/home/endri-pro/Downloads/CUCIAN',
    process.env.HOME ? path.join(process.env.HOME, 'Downloads/CUCIAN') : undefined,
    '/tmp/CUCIAN'
  ].filter((d): d is string => Boolean(d));

  const zips: LaundryZipItem[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.toLowerCase().endsWith('.zip')) {
            const fullPath = path.join(dir, file);
            if (!seen.has(fullPath)) {
              seen.add(fullPath);
              try {
                const stat = fs.statSync(fullPath);
                zips.push({
                  filename: file,
                  path: fullPath,
                  sizeBytes: stat.size,
                  modifiedAt: stat.mtimeMs,
                  model: extractModelFromFilename(file),
                  pcId: 'syncmaster'
                });
              } catch (_) {}
            }
          }
        }
      }
    } catch (_) {}
  }

  zips.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return zips;
}

// In-Memory Fleet State
const bridges = new Map<string, BridgeNode>();
const devices = new Map<string, DeviceInfo>();
const activeJobs = new Map<string, ActiveJob>();
const jobHistory: ActiveJob[] = [];

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files if built with no-cache headers for HTML
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// REST: Fleet Diagnostics & Status
app.get('/api/fleet/status', (_req, res) => {
  const localZips = scanLocalCucianZips();
  res.json({
    onlineBridges: Array.from(bridges.values()).map(b => ({
      pcId: b.pcId,
      os: b.os,
      ip: b.ip,
      autoRoot: b.autoRoot,
      connectedAt: b.connectedAt,
      zipCount: (b.laundryZips && b.laundryZips.length > 0) ? b.laundryZips.length : localZips.length
    })),
    totalDevices: devices.size,
    activeJobsCount: activeJobs.size
  });
});

function parseRunBatchMetadata(batchName: string) {
  const model = extractModelFromFilename(batchName);
  let plan = 'Normal';
  if (batchName.includes('_SMR_') || batchName.includes('SMR')) plan = 'SMR';
  else if (batchName.includes('_SKU_') || batchName.includes('SKU')) plan = 'SKU';
  else if (batchName.includes('STS')) plan = 'STS';
  else if (batchName.includes('GTS')) plan = 'GTS';

  const devsMatch = batchName.match(/(\d+)devs/);
  const devsCount = devsMatch ? parseInt(devsMatch[1], 10) : 1;

  return { model, plan, devsCount };
}

function scanBatchSummary(targetPath: string): { total: number; passed: number; failed: number } | undefined {
  try {
    if (fs.existsSync(targetPath)) {
      if (fs.statSync(targetPath).isDirectory()) {
        const findXml = (dir: string): string | null => {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const full = path.join(dir, f);
            if (f === 'test_result.xml') return full;
            if (fs.statSync(full).isDirectory()) {
              const nested = findXml(full);
              if (nested) return nested;
            }
          }
          return null;
        };
        const xmlFile = findXml(targetPath);
        if (xmlFile && fs.existsSync(xmlFile)) {
          const content = fs.readFileSync(xmlFile, 'utf8');
          const passMatch = content.match(/pass="(\d+)"/i) || content.match(/passed="(\d+)"/i);
          const failMatch = content.match(/failed="(\d+)"/i) || content.match(/fail="(\d+)"/i);
          const totalMatch = content.match(/total="(\d+)"/i) || content.match(/tests="(\d+)"/i);
          if (passMatch || failMatch) {
            const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
            const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
            const total = totalMatch ? parseInt(totalMatch[1], 10) : (passed + failed);
            return { total, passed, failed };
          }
        }
      }
    }
  } catch (_) {}
  return undefined;
}

// REST: Result ZIP List Endpoint (Grouped by Overall Run Batch)
app.get('/api/results/list', (_req, res) => {
  const resultsDir = '/run/media/endri-pro/BINARY_HDD/AUTO/Results';
  const zips: Array<{
    filename: string;
    path: string;
    sizeBytes: number;
    modifiedAt: number;
    model?: string;
    plan?: string;
    devsCount?: number;
    run_batch: string;
    subFilesCount?: number;
    summary?: { total: number; passed: number; failed: number };
  }> = [];

  try {
    if (fs.existsSync(resultsDir)) {
      const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
      const seenBatches = new Set<string>();

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const batchName = entry.name;
          if (seenBatches.has(batchName)) continue;
          seenBatches.add(batchName);

          const subDir = path.join(resultsDir, batchName);
          const zipCandidate = path.join(resultsDir, `${batchName}.zip`);
          let sizeBytes = 0;
          let modifiedAt = 0;
          let subFilesCount = 0;

          if (fs.existsSync(zipCandidate) && fs.statSync(zipCandidate).isFile()) {
            const zStat = fs.statSync(zipCandidate);
            sizeBytes = zStat.size;
            modifiedAt = zStat.mtimeMs;
          } else {
            try {
              const subFiles = fs.readdirSync(subDir);
              subFilesCount = subFiles.length;
              const dStat = fs.statSync(subDir);
              modifiedAt = dStat.mtimeMs;
              for (const f of subFiles) {
                try {
                  const fStat = fs.statSync(path.join(subDir, f));
                  sizeBytes += fStat.size;
                  if (fStat.mtimeMs > modifiedAt) modifiedAt = fStat.mtimeMs;
                } catch (_) {}
              }
            } catch (_) {}
          }

          const meta = parseRunBatchMetadata(batchName);
          const effectivePath = fs.existsSync(zipCandidate) ? zipCandidate : subDir;
          const summary = scanBatchSummary(subDir);
          zips.push({
            filename: `${batchName}.zip`,
            path: effectivePath,
            sizeBytes,
            modifiedAt,
            model: meta.model,
            plan: meta.plan,
            devsCount: meta.devsCount,
            run_batch: batchName,
            subFilesCount,
            summary
          });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
          const baseName = entry.name.replace(/\.zip$/i, '');
          if (!seenBatches.has(baseName)) {
            seenBatches.add(baseName);
            const fullPath = path.join(resultsDir, entry.name);
            const stat = fs.statSync(fullPath);
            const meta = parseRunBatchMetadata(entry.name);
            const matchingDir = path.join(resultsDir, baseName);
            const summary = fs.existsSync(matchingDir) ? scanBatchSummary(matchingDir) : undefined;
            zips.push({
              filename: entry.name,
              path: fullPath,
              sizeBytes: stat.size,
              modifiedAt: stat.mtimeMs,
              model: meta.model,
              plan: meta.plan,
              devsCount: meta.devsCount,
              run_batch: baseName,
              summary
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[Hub] Error scanning Results directory:', err);
  }

  zips.sort((a, b) => b.modifiedAt - a.modifiedAt);
  res.json({ zips });
});

// REST: Delete Single Execution History Item
app.delete('/api/history/:run_id', (req, res) => {
  const { run_id } = req.params;
  const idx = jobHistory.findIndex((j) => j.run_id === run_id);
  if (idx !== -1) {
    jobHistory.splice(idx, 1);
    broadcastFleetState();
    return res.json({ success: true, deleted: run_id });
  }
  return res.status(404).json({ error: 'Run ID not found' });
});

// REST: Clear All Execution History
app.delete('/api/history', (_req, res) => {
  jobHistory.length = 0;
  broadcastFleetState();
  return res.json({ success: true, message: 'Execution history cleared' });
});

// REST: Result ZIP Download Endpoint
app.get('/api/results/download', (req, res) => {
  const directPath = (req.query.path as string) || '';
  const file = (req.query.file as string) || '';
  const run_id = (req.query.run_id as string) || '';

  if (directPath && fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(directPath)}"`);
    return res.download(directPath, path.basename(directPath));
  }

  if (!file && !directPath) return res.status(400).send('File parameter required');

  const filename = path.basename(file || directPath);
  const possiblePaths = [
    directPath,
    file,
    run_id ? path.join('/run/media/endri-pro/BINARY_HDD/AUTO/Results', run_id, filename) : '',
    path.join('/run/media/endri-pro/BINARY_HDD/AUTO/Results', filename),
    path.join('/cucian', filename),
    path.join('/home/endri-pro/Downloads/CUCIAN', filename)
  ].filter(Boolean);

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
        return res.download(p, path.basename(p));
      }
    } catch (_) {}
  }

  // Recursive search in Results folder if not found directly
  const resultsDir = '/run/media/endri-pro/BINARY_HDD/AUTO/Results';
  try {
    if (fs.existsSync(resultsDir)) {
      const subDirs = fs.readdirSync(resultsDir, { withFileTypes: true });
      for (const d of subDirs) {
        if (d.isDirectory()) {
          const candidate = path.join(resultsDir, d.name, filename);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.download(candidate, filename);
          }
        }
      }
    }
  } catch (_) {}

  return res.status(404).send('Result file not found');
});

const server = http.createServer(app);
const wssBridge = new WebSocketServer({ noServer: true });
const wssUi = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);

  if (pathname === '/ws/bridge') {
    wssBridge.handleUpgrade(request, socket, head, (ws) => {
      wssBridge.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/ui') {
    wssUi.handleUpgrade(request, socket, head, (ws) => {
      wssUi.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Broadcast full fleet state to all connected Web UI clients
function broadcastFleetState() {
  const localZips = scanLocalCucianZips();

  const bridgeList = Array.from(bridges.values()).map(b => {
    // If bridge reported no zips or fewer zips, enrich with local scanned zips
    const finalZips = (b.laundryZips && b.laundryZips.length > 0) ? b.laundryZips : localZips;
    return {
      pcId: b.pcId,
      os: b.os,
      ip: b.ip,
      autoRoot: b.autoRoot,
      connectedAt: b.connectedAt,
      laundryZips: finalZips
    };
  });

  // If no bridges are connected, supply a default server entry so UI can still browse zips
  if (bridgeList.length === 0 && localZips.length > 0) {
    bridgeList.push({
      pcId: 'syncmaster',
      os: 'linux',
      ip: '127.0.0.1',
      autoRoot: '/cucian',
      connectedAt: Date.now(),
      laundryZips: localZips
    });
  }

  const payload = JSON.stringify({
    type: 'FLEET_STATE',
    timestamp: Date.now(),
    bridges: bridgeList,
    devices: Array.from(devices.values()),
    activeJobs: Array.from(activeJobs.values()),
    jobHistory: jobHistory.slice(-50)
  });

  for (const client of wssUi.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Broadcast event to UI
function broadcastToUi(data: object) {
  const payload = JSON.stringify(data);
  for (const client of wssUi.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// Send command to specific Bridge PC
function sendToBridge(pcId: string, message: object): boolean {
  let bridge = bridges.get(pcId);
  if (!bridge && bridges.size > 0) {
    bridge = Array.from(bridges.values())[0];
  }
  if (bridge && bridge.ws && bridge.ws.readyState === WebSocket.OPEN) {
    bridge.ws.send(JSON.stringify(message));
    return true;
  }
  console.warn(`[Hub] Unable to send message to bridge. Target: ${pcId}, Online bridges: ${Array.from(bridges.keys()).join(', ') || 'none'}`);
  return false;
}

// Handle Agent Bridge Connections
wssBridge.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  let registeredPcId = '';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'REGISTER_NODE': {
          registeredPcId = msg.pcId || `NODE-${Date.now()}`;
          bridges.set(registeredPcId, {
            pcId: registeredPcId,
            os: msg.os || 'linux',
            ip: clientIp,
            autoRoot: msg.autoRoot || '',
            toolsVersion: msg.toolsVersion || {},
            connectedAt: Date.now(),
            ws,
            laundryZips: msg.laundryZips || []
          });
          console.log(`[Hub] Node connected and registered: ${registeredPcId} (${clientIp})`);
          broadcastFleetState();
          break;
        }

        case 'DEVICE_LIST_UPDATE': {
          const pcId = msg.pcId || registeredPcId;
          // Clear previous devices from this PC
          for (const [serial, dev] of devices.entries()) {
            if (dev.pcId === pcId) {
              devices.delete(serial);
            }
          }
          // Insert updated devices
          if (Array.isArray(msg.devices)) {
            for (const dev of msg.devices) {
              devices.set(dev.serial, {
                ...dev,
                pcId,
                last_seen: Date.now()
              });
            }
          }
          broadcastFleetState();
          break;
        }

        case 'LAUNDRY_ZIP_LIST': {
          const pcId = msg.pcId || registeredPcId;
          const bridge = bridges.get(pcId);
          if (bridge) {
            bridge.laundryZips = msg.zips || [];
            broadcastFleetState();
          }
          break;
        }

        case 'LOG_STREAM': {
          const { run_id, line } = msg;
          if (run_id && line) {
            const job = activeJobs.get(run_id);
            if (job) {
              job.recentLogs.push(line);
              if (job.recentLogs.length > 500) job.recentLogs.shift();

              if (line.includes('Result ZIP preserved:') || line.includes('Preserved retry result ZIP:') || line.includes('result ready:') || line.includes('Result zips:')) {
                const parts = line.split(/Preserved retry result ZIP:|Result ZIP preserved:|result ready:/i);
                if (parts[1]) {
                  const rawPath = parts[1].trim();
                  const filename = path.basename(rawPath);
                  if (filename && filename.endsWith('.zip')) {
                    if (!job.zip_files) job.zip_files = [];
                    if (!job.zip_files.includes(filename)) {
                      job.zip_files.push(filename);
                      job.zip_file = job.zip_files[0];
                      broadcastFleetState();
                    }
                  }
                }
              }
            }
            broadcastToUi({
              type: 'LOG_LINE',
              run_id,
              pcId: registeredPcId,
              line,
              timestamp: Date.now()
            });
          }
          break;
        }

        case 'SUITE_STATUS_UPDATE': {
          const { run_id, suite, status, elapsed_secs, devices: devList, test_type } = msg;
          let job = activeJobs.get(run_id);
          if (!job) {
            const hist = jobHistory.find(j => j.run_id === run_id);
            if (hist && (hist.status === 'CANCELLED' || hist.status === 'Finished' || hist.status === 'Failed')) {
              break;
            }
            job = {
              run_id,
              pcId: registeredPcId,
              test_type: test_type || 'CTS',
              status: status || 'Running',
              suite: suite || 'CTS',
              startedAt: Date.now(),
              devices: devList ? devList.split(',') : [],
              elapsed_secs: elapsed_secs || 0,
              recentLogs: [],
              zip_files: []
            };
            activeJobs.set(run_id, job);
          } else {
            if (job.status === 'CANCELLED') break;
            job.suite = suite;
            job.status = status;
            job.elapsed_secs = elapsed_secs || job.elapsed_secs;
          }
          broadcastFleetState();
          break;
        }

        case 'RUN_FINISHED': {
          const { run_id, summary, zip_file, zip_files, exit_code } = msg;
          const job = activeJobs.get(run_id);
          if (job) {
            if (job.status !== 'CANCELLED') {
              job.status = exit_code === 0 ? 'Finished' : 'Failed';
            }
            job.summary = summary;
            if (zip_files && Array.isArray(zip_files)) {
              job.zip_files = zip_files;
            }
            job.zip_file = zip_file || (job.zip_files && job.zip_files[0]);
            const existingIdx = jobHistory.findIndex(j => j.run_id === run_id);
            if (existingIdx >= 0) {
              jobHistory[existingIdx] = { ...job, recentLogs: [...job.recentLogs] };
            } else {
              jobHistory.unshift({ ...job, recentLogs: [...job.recentLogs] });
            }
            activeJobs.delete(run_id);
          }
          broadcastFleetState();
          break;
        }

        case 'LAUNDRY_ANALYSIS_RESULT': {
          broadcastToUi({
            type: 'LAUNDRY_ANALYSIS_RESULT',
            pcId: registeredPcId,
            zip_path: msg.zip_path,
            rows: msg.rows || [],
            error: msg.error
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[Hub] Invalid JSON from bridge:', err);
    }
  });

  ws.on('close', () => {
    if (registeredPcId) {
      console.log(`[Hub] Node disconnected: ${registeredPcId}`);
      bridges.delete(registeredPcId);
      // Mark devices offline
      for (const [serial, dev] of devices.entries()) {
        if (dev.pcId === registeredPcId) {
          devices.delete(serial);
        }
      }
      broadcastFleetState();
    }
  });
});

// Handle Web UI Connections
wssUi.on('connection', (ws) => {
  // Send immediate fleet snapshot on connect
  ws.send(JSON.stringify({
    type: 'FLEET_STATE',
    timestamp: Date.now(),
    bridges: Array.from(bridges.values()).map(b => ({
      pcId: b.pcId,
      os: b.os,
      ip: b.ip,
      autoRoot: b.autoRoot,
      connectedAt: b.connectedAt,
      laundryZips: b.laundryZips
    })),
    devices: Array.from(devices.values()),
    activeJobs: Array.from(activeJobs.values()),
    jobHistory: jobHistory.slice(-50)
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'EXEC_RUN_SUITE': {
          const { pcId, payload } = msg;
          if (payload) {
            if (!payload.run_id) {
              payload.run_id = `run-${Date.now()}`;
            }
            const run_id = payload.run_id;
            const targetDevs = [...(payload.user_devices || []), ...(payload.userdebug_devices || [])];
            const targetPcId = pcId || Array.from(bridges.keys())[0] || 'LOCAL';

            let job = activeJobs.get(run_id);
            if (!job) {
              job = {
                run_id,
                pcId: targetPcId,
                test_type: payload.test_type || 'Laundry',
                status: 'Starting',
                suite: payload.test_type || 'Laundry',
                startedAt: Date.now(),
                devices: targetDevs,
                elapsed_secs: 0,
                recentLogs: [`[Hub] Initializing run ${run_id} (${payload.test_type || 'Test'}) for ${targetDevs.join(', ') || 'devices'}...`]
              };
              activeJobs.set(run_id, job);
              broadcastFleetState();
            }

            if (sendToBridge(targetPcId, { type: 'CMD_RUN_SUITE', payload })) {
              console.log(`[Hub] Dispatched CMD_RUN_SUITE (${run_id}) to ${targetPcId}`);
            }
          }
          break;
        }

        case 'EXEC_CANCEL_RUN': {
          const { pcId, run_id } = msg;
          if (pcId && sendToBridge(pcId, { type: 'CMD_CANCEL_RUN', run_id })) {
            console.log(`[Hub] Dispatched CMD_CANCEL_RUN to ${pcId} for ${run_id}`);
          }
          if (run_id) {
            const job = activeJobs.get(run_id);
            if (job) {
              job.status = 'CANCELLED';
              job.recentLogs.push(`[Hub] Flow run ${run_id} cancelled by user.`);
              broadcastFleetState();
              setTimeout(() => {
                activeJobs.delete(run_id);
                const existingIdx = jobHistory.findIndex(j => j.run_id === run_id);
                if (existingIdx >= 0) {
                  jobHistory[existingIdx] = { ...job, recentLogs: [...job.recentLogs] };
                } else {
                  jobHistory.unshift({ ...job, recentLogs: [...job.recentLogs] });
                }
                broadcastFleetState();
              }, 1200);
            }
          }
          break;
        }

        case 'EXEC_RESET_BUSY': {
          const { pcId } = msg;
          if (pcId && sendToBridge(pcId, { type: 'CMD_RESET_BUSY' })) {
            console.log(`[Hub] Dispatched CMD_RESET_BUSY to ${pcId}`);
          }
          break;
        }

        case 'EXEC_SET_LAMP': {
          const { pcId, serial, brighten } = msg;
          if (pcId && sendToBridge(pcId, { type: 'CMD_SET_LAMP', serial, brighten })) {
            console.log(`[Hub] Dispatched CMD_SET_LAMP to ${pcId} for ${serial}`);
          }
          break;
        }

        case 'EXEC_ANALYZE_LAUNDRY': {
          const { pcId, zip_path } = msg;
          if (pcId && sendToBridge(pcId, { type: 'CMD_ANALYZE_LAUNDRY', zip_path })) {
            console.log(`[Hub] Dispatched CMD_ANALYZE_LAUNDRY to ${pcId} for ${zip_path}`);
          }
          break;
        }

        case 'GET_RUN_LOGS': {
          const { run_id } = msg;
          const job = activeJobs.get(run_id) || jobHistory.find(j => j.run_id === run_id);
          if (job) {
            ws.send(JSON.stringify({
              type: 'RUN_LOGS_RESPONSE',
              run_id,
              logs: job.recentLogs
            }));
          }
          break;
        }

        case 'EXEC_CLEAR_HISTORY': {
          jobHistory.length = 0;
          broadcastFleetState();
          break;
        }

        case 'EXEC_DELETE_HISTORY_ITEM': {
          const { run_id } = msg;
          if (run_id) {
            const idx = jobHistory.findIndex(j => j.run_id === run_id);
            if (idx !== -1) {
              jobHistory.splice(idx, 1);
              broadcastFleetState();
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[Hub] Invalid JSON from UI client:', err);
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` GBA Agentic Auto Fleet Web Hub Server Started`);
  console.log(` Listening on http://0.0.0.0:${PORT}`);
  console.log(` WebSocket Bridge: ws://0.0.0.0:${PORT}/ws/bridge`);
  console.log(` WebSocket UI:     ws://0.0.0.0:${PORT}/ws/ui`);
  console.log(`====================================================`);
});
