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
  recentLogs: string[];
}

// In-Memory Fleet State
const bridges = new Map<string, BridgeNode>();
const devices = new Map<string, DeviceInfo>();
const activeJobs = new Map<string, ActiveJob>();
const jobHistory: ActiveJob[] = [];

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files if built
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));

// REST: Fleet Diagnostics & Status
app.get('/api/fleet/status', (_req, res) => {
  res.json({
    onlineBridges: Array.from(bridges.values()).map(b => ({
      pcId: b.pcId,
      os: b.os,
      ip: b.ip,
      autoRoot: b.autoRoot,
      connectedAt: b.connectedAt,
      zipCount: b.laundryZips.length
    })),
    totalDevices: devices.size,
    activeJobsCount: activeJobs.size
  });
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
  const payload = JSON.stringify({
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
  const bridge = bridges.get(pcId);
  if (bridge && bridge.ws && bridge.ws.readyState === WebSocket.OPEN) {
    bridge.ws.send(JSON.stringify(message));
    return true;
  }
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
            job = {
              run_id,
              pcId: registeredPcId,
              test_type: test_type || 'CTS',
              status: status || 'Running',
              suite: suite || 'CTS',
              startedAt: Date.now(),
              devices: devList ? devList.split(',') : [],
              elapsed_secs: elapsed_secs || 0,
              recentLogs: []
            };
            activeJobs.set(run_id, job);
          } else {
            job.suite = suite;
            job.status = status;
            job.elapsed_secs = elapsed_secs || job.elapsed_secs;
          }
          broadcastFleetState();
          break;
        }

        case 'RUN_FINISHED': {
          const { run_id, summary, zip_file, exit_code } = msg;
          const job = activeJobs.get(run_id);
          if (job) {
            job.status = exit_code === 0 ? 'Finished' : 'Failed';
            job.summary = summary;
            job.zip_file = zip_file;
            jobHistory.push({ ...job });
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
          if (pcId && sendToBridge(pcId, { type: 'CMD_RUN_SUITE', payload })) {
            console.log(`[Hub] Dispatched CMD_RUN_SUITE to ${pcId}`);
          }
          break;
        }

        case 'EXEC_CANCEL_RUN': {
          const { pcId, run_id } = msg;
          if (pcId && sendToBridge(pcId, { type: 'CMD_CANCEL_RUN', run_id })) {
            console.log(`[Hub] Dispatched CMD_CANCEL_RUN to ${pcId}`);
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
