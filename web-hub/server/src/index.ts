import http from 'http';
import fs from 'fs';
import path from 'path';
import child_process, { spawn } from 'child_process';
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
  pcId?: string;
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
  workflow_id?: string;
  laundry_zip_path?: string;
  summary?: SuiteSummary;
  zip_file?: string;
  zip_files?: string[];
  recentLogs: string[];
}

export interface LaundryWorkflowState {
  id: string;
  model: string;
  pcId?: string;
  selectedZip?: string;
  selectedModules: string[];
  selectedSerials: string[];
  pda?: string;
  ap_version?: string;
  plan?: string;
  cachedRows?: any[];
  isExpanded?: boolean;
  isLaundryExpanded?: boolean;
  isDevicesExpanded?: boolean;
  isResultsExpanded?: boolean;
}

export interface ActiveTransferItem {
  id: string;
  type: 'tools' | 'firmware';
  sourceNode: string;
  targetNode: string;
  filename: string;
  totalBytes: number;
  transferredBytes: number;
  speedMBps: number;
  status: 'running' | 'paused' | 'extracting' | 'completed' | 'cancelled' | 'failed';
  progress: number;
}

// ponytail: Unified server-side state simplified to accordions and transfer modal only
export interface UnifiedUiState {
  standbyExpanded: boolean;
  resultsExpanded: boolean;
  transferModalOpen: boolean;
  transferModalExpanded: boolean;
}

export function formatDurationHms(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '' || val === '-') return '-';

  if (typeof val === 'number') {
    const totalSecs = Math.max(0, Math.floor(val));
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  const str = String(val).trim();
  if (!str || str === '-') return '-';

  if (/^\d+h\s*\d+m\s*\d+s$/i.test(str) || /^\d+m\s*\d+s$/i.test(str)) {
    return str;
  }

  if (str.includes(':')) {
    const parts = str.split(':').map((p) => parseInt(p, 10));
    if (parts.length === 3 && !parts.some(isNaN)) {
      const [h, m, s] = parts;
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    } else if (parts.length === 2 && !parts.some(isNaN)) {
      const [m, s] = parts;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    }
  }

  const numMatch = str.match(/^(\d+)/);
  if (numMatch) {
    const totalSecs = parseInt(numMatch[1], 10);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const s = totalSecs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  return str;
}

function extractModelFromFilename(filename: string): string | undefined {
  const base = filename.replace(/\.zip$/i, '');
  const tokens = base.split(/[_/\-\s]+/);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^SM[-_]?/i, '');
    let modelPart = '';
    for (const ch of token) {
      if (/[a-zA-Z0-9]/.test(ch)) {
        modelPart += ch;
        if (modelPart.length >= 5 && /[FBGEPNUWfbgepnuw]$/.test(modelPart)) {
          break;
        }
      } else {
        break;
      }
    }
    if (modelPart.length >= 4 && /^[ASFMXT]/i.test(modelPart)) {
      return modelPart.toUpperCase();
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
                  pcId: process.env.PC_ID || 'Hub-Local'
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
const preflightReports = new Map<string, any>();

export function getAutoRoot(): string {
  const candidates = [
    process.env.AUTO_ROOT,
    '/auto',
    '/run/media/endri-pro/BINARY_HDD1/AUTO',
    '/run/media/endri-pro/BINARY_HDD/AUTO',
    '/home/gba/Desktop/GBA/AUTO',
  ].filter((r): r is string => Boolean(r));

  for (const r of candidates) {
    if (fs.existsSync(r) && (fs.existsSync(path.join(r, 'CTS')) || fs.existsSync(path.join(r, 'GTS')) || fs.existsSync(path.join(r, 'STS')))) {
      return r;
    }
  }
  for (const r of candidates) {
    if (fs.existsSync(r)) return r;
  }
  return '/auto';
}

export function getResultsDir(): string {
  const auto = getAutoRoot();
  const res = path.join(auto, 'Results');
  if (fs.existsSync(res)) return res;
  if (process.env.RESULTS_DIR && fs.existsSync(process.env.RESULTS_DIR)) return process.env.RESULTS_DIR;
  return res;
}

export function generateLocalPreflightReport(autoRootParam?: string, pcId = 'Endri Ubuntu') {
  const autoRoot = autoRootParam && fs.existsSync(autoRootParam) ? autoRootParam : getAutoRoot();

  const items: any[] = [];

  // 1. Core Dirs
  const coreDirs = ['CTS', 'GTS', 'STS', 'Results'];
  for (const d of coreDirs) {
    const p = path.join(autoRoot, d);
    const exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
    items.push({
      category: 'Core Dir',
      item: d,
      status: exists ? 'OK' : 'MISSING',
      details: exists ? 'Directory exists' : 'Directory not found',
      path: p,
      can_sync: false,
      zip_available: false,
      suite: d,
    });
  }

  // 3. Scan suites CTS, GTS, STS
  const suites = [
    { name: 'GTS', sub: 'android-gts', tool: 'tools/gts-tradefed' },
    { name: 'CTS', sub: 'android-cts', tool: 'tools/cts-tradefed' },
    { name: 'STS', sub: 'android-sts', tool: 'tools/sts-tradefed' },
  ];

  for (const s of suites) {
    const suiteDir = path.join(autoRoot, s.name);
    let foundAnyVersion = false;

    if (fs.existsSync(suiteDir) && fs.statSync(suiteDir).isDirectory()) {
      try {
        const candidateVDirs: { vName: string; vDir: string }[] = [];
        const entries = fs.readdirSync(suiteDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const name = e.name;
          if (name.startsWith('.') || name === 'subplans' || name === 'Results') continue;

          const p = path.join(suiteDir, name);
          const directAndroid = path.join(p, s.sub);
          const directTool = path.join(p, s.tool);
          if (fs.existsSync(directAndroid) || fs.existsSync(directTool)) {
            candidateVDirs.push({ vName: name, vDir: p });
          } else {
            // Check subdirectories (e.g. STS/08/15)
            try {
              const subEntries = fs.readdirSync(p, { withFileTypes: true });
              let hasSubs = false;
              for (const subE of subEntries) {
                if (subE.isDirectory() && !subE.name.startsWith('.') && subE.name !== 'subplans' && subE.name !== 'Results') {
                  candidateVDirs.push({ vName: `${name}/${subE.name}`, vDir: path.join(p, subE.name) });
                  hasSubs = true;
                }
              }
              if (!hasSubs) {
                candidateVDirs.push({ vName: name, vDir: p });
              }
            } catch (_) {
              candidateVDirs.push({ vName: name, vDir: p });
            }
          }
        }

        candidateVDirs.sort((a, b) => a.vName.localeCompare(b.vName));

        for (const { vName, vDir } of candidateVDirs) {
          foundAnyVersion = true;
          const innerAndroid = path.join(vDir, s.sub);
          const innerExists = fs.existsSync(innerAndroid) && fs.statSync(innerAndroid).isDirectory();

          const tool1 = path.join(vDir, s.tool);
          const tool2 = path.join(innerAndroid, s.tool);
          const toolFound =
            (fs.existsSync(tool1) && fs.statSync(tool1).isFile()) ||
            (fs.existsSync(tool2) && fs.statSync(tool2).isFile());
          const actualPath = innerExists ? innerAndroid : vDir;

          // Robust Zip Detection:
          let foundZip: string | undefined = undefined;

          // 1) Inside vDir
          try {
            const vFiles = fs.readdirSync(vDir);
            for (const f of vFiles) {
              const fullF = path.join(vDir, f);
              if (fs.statSync(fullF).isFile() && (f.toLowerCase().endsWith('.zip') || f.toLowerCase().includes('.zip.'))) {
                foundZip = fullF;
                break;
              }
            }
          } catch (_) {}

          // 2) In parent folder of vDir
          if (!foundZip) {
            try {
              const parentP = path.dirname(vDir);
              const pFiles = fs.readdirSync(parentP);
              for (const f of pFiles) {
                const fullF = path.join(parentP, f);
                if (fs.statSync(fullF).isFile() && (f.toLowerCase().endsWith('.zip') || f.toLowerCase().includes('.zip.'))) {
                  const baseV = vName.split('/').pop() || vName;
                  if (f.toLowerCase().includes(baseV.toLowerCase()) || f.toLowerCase().includes(s.sub)) {
                    foundZip = fullF;
                    break;
                  }
                }
              }
            } catch (_) {}
          }

          // 3) Fallback candidate names
          if (!foundZip) {
            const zips = [
              path.join(suiteDir, `${s.sub}-${vName}.zip`),
              path.join(suiteDir, `${vName}.zip`),
              path.join(autoRoot, `${s.name}_${vName}.zip`),
            ];
            foundZip = zips.find((z) => fs.existsSync(z) && fs.statSync(z).isFile());
          }

          const isReady = innerExists && toolFound;
          const detailsMsg = isReady
            ? (foundZip ? 'Package ready (Zip available & tradefed ready)' : 'Package ready (Extracted suite ready)')
            : (!innerExists ? `${s.sub} folder not found inside ${vName}` : 'tradefed binary missing or not executable');

          items.push({
            category: s.name,
            item: `${s.name}/${vName}/${s.sub}`,
            status: isReady ? 'OK' : (innerExists ? 'WARN' : 'MISSING'),
            details: detailsMsg,
            path: actualPath,
            can_sync: true,
            zip_available: Boolean(foundZip),
            zip_path: foundZip,
            version: vName,
            suite: s.name,
          });
        }
      } catch (_) {}
    }

    if (!foundAnyVersion) {
      items.push({
        category: s.name,
        item: `${s.name} (Belum ada versi)`,
        status: 'MISSING',
        details: `Folder ${s.name} masih kosong. Belum ada paket test suite terpasang.`,
        path: suiteDir,
        can_sync: true,
        zip_available: false,
        version: undefined,
        suite: s.name,
      });
    }
  }

  return {
    pc_id: pcId,
    auto_root: autoRoot,
    items,
    scanned_at: Math.floor(Date.now() / 1000),
  };
}

const UI_STATE_FILE = process.env.UI_STATE_FILE || '/tmp/gba_ui_state.json';
const TRANSFERS_FILE = process.env.TRANSFERS_FILE || '/tmp/gba_transfers.json';
const DELETED_RUNS_FILE = process.env.DELETED_RUNS_FILE || '/tmp/gba_deleted_runs.json';

let deletedRunIds = new Set<string>();

function loadDeletedRunsFromDisk(): void {
  try {
    if (fs.existsSync(DELETED_RUNS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DELETED_RUNS_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        deletedRunIds = new Set(parsed);
      }
    }
  } catch (err) {
    console.error('[Hub] Failed to load deleted runs:', err);
  }
}

function saveDeletedRunsToDisk(): void {
  try {
    fs.writeFileSync(DELETED_RUNS_FILE, JSON.stringify(Array.from(deletedRunIds), null, 2), 'utf8');
  } catch (err) {
    console.error('[Hub] Failed to save deleted runs:', err);
  }
}

function deleteRunCompletely(run_id: string): void {
  if (!run_id) return;
  deletedRunIds.add(run_id);

  // 1. If in activeJobs, cancel on bridge and delete
  const activeJob = activeJobs.get(run_id);
  if (activeJob) {
    activeJob.status = 'CANCELLED';
    if (activeJob.pcId) {
      sendToBridge(activeJob.pcId, { type: 'CMD_CANCEL_RUN', run_id });
    }
    activeJobs.delete(run_id);
  }

  // 2. If in jobHistory, remove and record zip basename
  const idx = jobHistory.findIndex((j) => j.run_id === run_id);
  if (idx !== -1) {
    const item = jobHistory[idx];
    if (item.zip_file) {
      const bname = path.basename(item.zip_file, '.zip');
      deletedRunIds.add(bname);
    }
    jobHistory.splice(idx, 1);
  }

  saveDeletedRunsToDisk();
  broadcastFleetState();
}

function clearAllHistoryCompletely(): void {
  for (const j of jobHistory) {
    deletedRunIds.add(j.run_id);
    if (j.zip_file) {
      deletedRunIds.add(path.basename(j.zip_file, '.zip'));
    }
  }
  for (const [id, j] of activeJobs.entries()) {
    deletedRunIds.add(id);
    if (j.pcId) {
      sendToBridge(j.pcId, { type: 'CMD_CANCEL_RUN', run_id: id });
    }
  }
  activeJobs.clear();
  jobHistory.length = 0;
  saveDeletedRunsToDisk();
  broadcastFleetState();
}

let serverUiState: UnifiedUiState = {
  standbyExpanded: false,
  resultsExpanded: true,
  transferModalOpen: false,
  transferModalExpanded: true,
};

let serverActiveTransfers: ActiveTransferItem[] = [];

function loadUiStateFromDisk(): void {
  loadDeletedRunsFromDisk();
  try {
    if (fs.existsSync(UI_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        serverUiState = { ...serverUiState, ...parsed };
      }
    }
    if (fs.existsSync(TRANSFERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TRANSFERS_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        serverActiveTransfers = parsed;
      }
    }
  } catch (err) {
    console.error('[Hub] Failed to load UI state from disk:', err);
  }
}

function saveUiStateToDisk(): void {
  try {
    fs.writeFileSync(UI_STATE_FILE, JSON.stringify(serverUiState, null, 2), 'utf8');
    fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(serverActiveTransfers, null, 2), 'utf8');
  } catch (err) {
    console.error('[Hub] Failed to save UI state to disk:', err);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// REST: Unified UI State API
app.get('/api/ui-state', (_req, res) => {
  res.json({ uiState: serverUiState, transfers: serverActiveTransfers });
});

app.post('/api/ui-state', (req, res) => {
  const { uiState } = req.body;
  if (uiState && typeof uiState === 'object') {
    serverUiState = { ...serverUiState, ...uiState };
    saveUiStateToDisk();
    broadcastFleetState();
    return res.json({ success: true, uiState: serverUiState });
  }
  return res.status(400).json({ error: 'Expected uiState object' });
});

app.get('/api/preflight/list', (_req, res) => {
  if (preflightReports.size === 0) {
    const autoRoot = getAutoRoot();
    const localRep = generateLocalPreflightReport(autoRoot, 'Endri Ubuntu');
    preflightReports.set('Endri Ubuntu', localRep);
  }
  res.json({ reports: Array.from(preflightReports.values()) });
});

app.get('/api/sync/file', (req, res) => {
  const reqPath = String(req.query.path || '').trim().replace(/^\/+/, '');
  if (!reqPath) {
    return res.status(400).send('Missing path parameter');
  }

  const autoRoot = getAutoRoot();

  // 1. Direct file match
  const fullTarget = path.join(autoRoot, reqPath);
  if (fs.existsSync(fullTarget) && fs.statSync(fullTarget).isFile()) {
    const filename = path.basename(fullTarget);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Filename', filename);
    return res.sendFile(fullTarget);
  }

  // 2. Search for matching .zip file in parent folder or directory
  const parentDir = path.dirname(fullTarget);
  const candidatesDirs = [parentDir, fullTarget].filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());

  for (const cDir of candidatesDirs) {
    try {
      const files = fs.readdirSync(cDir);
      const zipFiles = files.filter((f) => f.toLowerCase().endsWith('.zip'));
      if (zipFiles.length > 0) {
        const suitePrefix = path.basename(reqPath).toLowerCase().replace(/android-/, '');
        const bestZip = zipFiles.find((f) => f.toLowerCase().includes(suitePrefix)) || zipFiles[0];
        const zipFullPath = path.join(cDir, bestZip);
        res.setHeader('Content-Disposition', `attachment; filename="${bestZip}"`);
        res.setHeader('X-Filename', bestZip);
        res.setHeader('Content-Type', 'application/zip');
        return res.sendFile(zipFullPath);
      }
    } catch (_) {}
  }

  // 3. If directory exists without zip, stream tar.gz
  if (fs.existsSync(fullTarget) && fs.statSync(fullTarget).isDirectory()) {
    const baseName = path.basename(fullTarget);
    const tarName = `${baseName}.tar.gz`;
    res.setHeader('Content-Disposition', `attachment; filename="${tarName}"`);
    res.setHeader('X-Filename', tarName);
    res.setHeader('X-Archive-Type', 'tar.gz');
    res.setHeader('Content-Type', 'application/gzip');

    const tarProc = spawn('tar', ['-czf', '-', '-C', path.dirname(fullTarget), baseName]);
    tarProc.stdout.pipe(res);
    tarProc.stderr.on('data', (err) => console.error('[Sync tar error]', err.toString()));
    return;
  }

  return res.status(404).send(`Tool resource not found: ${reqPath}`);
});

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
  let suite = 'Normal';
  if (batchName.includes('_SMR_') || batchName.includes('SMR')) {
    plan = 'SMR';
    suite = 'SMR';
  } else if (batchName.includes('_SKU_') || batchName.includes('SKU')) {
    plan = 'SKU';
    suite = 'SKU';
  } else if (batchName.includes('STS')) {
    plan = 'STS';
    suite = 'STS';
  } else if (batchName.includes('GTS')) {
    plan = 'GTS';
    suite = 'GTS';
  }

  const devsMatch = batchName.match(/(\d+)devs/);
  const devsCount = devsMatch ? parseInt(devsMatch[1], 10) : 1;

  return { model, plan, suite, devsCount };
}

function parseSummaryFromLogContent(content: string): { total: number; passed: number; failed: number; run_time?: string; completed_time?: string } | undefined {
  let passed = 0;
  let failed = 0;
  let total = 0;
  let found = false;
  let run_time: string | undefined;
  let completed_time: string | undefined;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const passMatch = trimmed.match(/^PASSED\s*:\s*(\d+)/i);
    if (passMatch) {
      passed = parseInt(passMatch[1], 10);
      found = true;
    }
    const failMatch = trimmed.match(/^FAILED\s*:\s*(\d+)/i);
    if (failMatch) {
      failed = parseInt(failMatch[1], 10);
      found = true;
    }
    const totMatch = trimmed.match(/^Total Tests\s*:\s*(\d+)/i);
    if (totMatch) {
      total = parseInt(totMatch[1], 10);
      found = true;
    }
    const rtMatch = trimmed.match(/^Total Run time\s*:\s*([^\r\n]+)/i);
    if (rtMatch) {
      run_time = rtMatch[1].trim();
    }
    const timeMatch = trimmed.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
    if (timeMatch) {
      completed_time = timeMatch[1].trim();
    }
  }

  if (found) {
    if (total === 0) total = passed + failed;
    return { total, passed, failed, run_time, completed_time };
  }
  return undefined;
}

function scanSuiteSummary(subDir: string, suite: string): { total: number; passed: number; failed: number; run_time?: string; completed_time?: string } | undefined {
  const dirs = [path.join(subDir, 'Log'), path.join(subDir, 'logs'), subDir];
  const suiteLower = suite.toLowerCase();

  for (const d of dirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      try {
        const files = fs.readdirSync(d);
        // Pass 1: Prioritize retry log (e.g. laundry_retry_gts_1_1devs.log)
        for (const f of files) {
          const fl = f.toLowerCase();
          if (fl.endsWith('.log') && fl.includes(`retry_${suiteLower}`)) {
            const full = path.join(d, f);
            const content = fs.readFileSync(full, 'utf8');
            const parsed = parseSummaryFromLogContent(content);
            if (parsed) return parsed;
          }
        }
        // Pass 2: Fallback to any log matching suite
        for (const f of files) {
          const fl = f.toLowerCase();
          if (fl.endsWith('.log') && fl.includes(`_${suiteLower}_`)) {
            const full = path.join(d, f);
            const content = fs.readFileSync(full, 'utf8');
            const parsed = parseSummaryFromLogContent(content);
            if (parsed) return parsed;
          }
        }
      } catch (_) {}
    }
  }
  return undefined;
}

function scanBatchSummary(targetPath: string): { total: number; passed: number; failed: number; run_time?: string } | undefined {
  try {
    let dirPath = targetPath;
    if (!fs.existsSync(dirPath)) {
      if (dirPath.endsWith('.zip')) {
        const withoutZip = dirPath.replace(/\.zip$/i, '');
        if (fs.existsSync(withoutZip)) dirPath = withoutZip;
      }
    } else if (fs.statSync(dirPath).isFile() && dirPath.endsWith('.zip')) {
      const withoutZip = dirPath.replace(/\.zip$/i, '');
      if (fs.existsSync(withoutZip) && fs.statSync(withoutZip).isDirectory()) {
        dirPath = withoutZip;
      }
    }

    let aggPassed = 0;
    let aggFailed = 0;
    let aggTotal = 0;
    let foundAny = false;
    const processedLogs = new Set<string>();

    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const logDirs = [path.join(dirPath, 'Log'), path.join(dirPath, 'logs'), dirPath];

      for (const ld of logDirs) {
        if (fs.existsSync(ld) && fs.statSync(ld).isDirectory()) {
          const files = fs.readdirSync(ld);
          for (const f of files) {
            const fl = f.toLowerCase();
            if (fl.endsWith('.log') && !fl.includes('tradefed_global') && !fl.includes('invoc_complete') && !fl.includes('host_log')) {
              if (processedLogs.has(f)) continue;
              processedLogs.add(f);
              try {
                const content = fs.readFileSync(path.join(ld, f), 'utf8');
                const parsed = parseSummaryFromLogContent(content);
                if (parsed && (parsed.passed > 0 || parsed.failed > 0 || parsed.total > 0)) {
                  aggPassed += parsed.passed;
                  aggFailed += parsed.failed;
                  aggTotal += parsed.total;
                  foundAny = true;
                }
              } catch (_) {}
            }
          }
        }
      }
    } else if (fs.existsSync(targetPath) && targetPath.endsWith('.zip')) {
      // Direct ZIP reading via unzip -l and unzip -p
      try {
        const listOutput = child_process.execSync(`unzip -l "${targetPath}"`, { encoding: 'utf8', timeout: 3000 });
        const logMatches = listOutput.match(/[^\s]+\.log/g) || [];
        for (const logFile of logMatches) {
          if (!processedLogs.has(logFile) && !logFile.includes('tradefed_global') && !logFile.includes('invoc_complete') && !logFile.includes('host_log')) {
            processedLogs.add(logFile);
            try {
              const content = child_process.execSync(`unzip -p "${targetPath}" "${logFile}"`, { encoding: 'utf8', timeout: 3000 });
              const parsed = parseSummaryFromLogContent(content);
              if (parsed && (parsed.passed > 0 || parsed.failed > 0 || parsed.total > 0)) {
                aggPassed += parsed.passed;
                aggFailed += parsed.failed;
                aggTotal += parsed.total;
                foundAny = true;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    if (foundAny) {
      if (aggTotal === 0) aggTotal = aggPassed + aggFailed;
      return { total: aggTotal, passed: aggPassed, failed: aggFailed };
    }
  } catch (_) {}
  return undefined;
}

function enrichJobSummary(job: ActiveJob): void {
  const resultsDir = getResultsDir();
  try {
    if (!fs.existsSync(resultsDir)) return;

    // Check if summary is missing or dummy (total <= 1)
    const isDummy = !job.summary || (job.summary.total <= 1 && job.summary.passed <= 1);
    if (!isDummy) return;

    const zipFile = job.zip_file || (job.zip_files && job.zip_files[0]);
    let targetDir: string | undefined;

    if (zipFile) {
      const base = path.basename(zipFile).replace(/\.zip$/i, '');
      const direct = path.join(resultsDir, base);
      if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
        targetDir = direct;
      }
    }

    if (!targetDir) {
      const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const matchRunId = job.run_id && (entry.name.includes(job.run_id) || job.run_id.includes(entry.name));
          const matchZip = zipFile && (zipFile.includes(entry.name) || entry.name.includes(path.basename(zipFile, '.zip')));
          if (matchRunId || matchZip) {
            targetDir = path.join(resultsDir, entry.name);
            break;
          }
        }
      }
    }

    if (targetDir) {
      const diskSummary = scanBatchSummary(targetDir);
      if (diskSummary && (diskSummary.total > 0 || diskSummary.passed > 0 || diskSummary.failed > 0)) {
        job.summary = {
          run_id: job.run_id,
          test_type: job.test_type,
          suite: job.suite,
          devices: Array.isArray(job.devices) ? job.devices.join(', ') : (job.devices || ''),
          run_time: formatDurationHms(diskSummary.run_time || job.summary?.run_time || job.elapsed_secs),
          modules: job.summary?.modules || '',
          total: diskSummary.total,
          passed: diskSummary.passed,
          failed: diskSummary.failed,
        };
      }
    }
  } catch (err) {
    console.error('[Hub] enrichJobSummary error:', err);
  }
}

function initJobHistoryFromDisk(): void {
  const resultsDir = getResultsDir();
  try {
    if (!fs.existsSync(resultsDir)) return;
    const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && (entry.name.startsWith('Laundry_') || entry.name.includes('_run-'))) {
        const fullDir = path.join(resultsDir, entry.name);
        const meta = parseRunBatchMetadata(entry.name);
        const summary = scanBatchSummary(fullDir);
        const zStat = fs.statSync(fullDir);
        const zipFile = path.join(resultsDir, `${entry.name}.zip`);
        const hasZip = fs.existsSync(zipFile);

        const runIdMatch = entry.name.match(/run-([0-9]+)/) || entry.name.match(/_([0-9]{10})_/);
        const runId = runIdMatch ? (runIdMatch[0].startsWith('_') ? runIdMatch[1] : runIdMatch[0]) : entry.name;

        if (deletedRunIds.has(runId) || deletedRunIds.has(entry.name) || deletedRunIds.has(`${entry.name}.zip`)) {
          continue;
        }

        if (jobHistory.some(j => j.run_id === runId || (j.zip_file && j.zip_file.includes(entry.name)))) {
          continue;
        }

        let devSerials: string[] = [];
        try {
          const files = fs.readdirSync(fullDir);
          for (const f of files) {
            const dMatch = f.match(/DeviceInfo_([A-Za-z0-9]+)_/);
            if (dMatch && !devSerials.includes(dMatch[1])) devSerials.push(dMatch[1]);
            const zMatch = f.match(/(?:CTS|GTS|STS|VTS)_retry\d+_[^_]+_[^_]+_([A-Za-z0-9]+)_/i);
            if (zMatch && !devSerials.includes(zMatch[1])) devSerials.push(zMatch[1]);
          }
        } catch (_) {}

        jobHistory.push({
          run_id: runId,
          pcId: 'Endri Ubuntu',
          test_type: meta.plan || 'SMR',
          status: 'Finished',
          suite: meta.suite || meta.plan || 'SMR',
          startedAt: zStat.birthtimeMs || zStat.mtimeMs,
          devices: devSerials.length > 0 ? devSerials : (meta.model ? [meta.model] : []),
          elapsed_secs: summary?.run_time ? parseInt(summary.run_time, 10) || 600 : 600,
          summary: summary ? {
            run_id: runId,
            test_type: meta.plan || 'SMR',
            suite: meta.suite || meta.plan || 'SMR',
            devices: devSerials.join(', ') || meta.model || '',
            run_time: formatDurationHms(summary.run_time || 600),
            modules: '',
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
          } : undefined,
          zip_file: hasZip ? zipFile : `${fullDir}.zip`,
          zip_files: hasZip ? [zipFile] : [`${fullDir}.zip`],
          recentLogs: []
        });
      }
    }
    jobHistory.sort((a, b) => b.startedAt - a.startedAt);
  } catch (err) {
    console.error('[Hub] initJobHistoryFromDisk error:', err);
  }
}

// REST: Result ZIP List Endpoint (Individual Suite ZIPs & Grouped Master Batches)
app.get('/api/results/list', (_req, res) => {
  const resultsDir = getResultsDir();
  const zips: Array<{
    filename: string;
    path: string;
    sizeBytes: number;
    modifiedAt: number;
    model?: string;
    plan?: string;
    suite?: string;
    test_type?: string;
    devsCount?: number;
    run_batch: string;
    subFilesCount?: number;
    isIndividualSuite?: boolean;
    isMasterBatch?: boolean;
    summary?: { total: number; passed: number; failed: number; run_time?: string; completed_time?: string };
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
          const meta = parseRunBatchMetadata(batchName);

          try {
            const subFiles = fs.readdirSync(subDir);
            subFilesCount = subFiles.length;
            const dStat = fs.statSync(subDir);
            modifiedAt = dStat.mtimeMs;

            for (const f of subFiles) {
              const fullFPath = path.join(subDir, f);
              try {
                const fStat = fs.statSync(fullFPath);
                sizeBytes += fStat.size;
                if (fStat.mtimeMs > modifiedAt) modifiedAt = fStat.mtimeMs;

                // 1. Scan and add individual suite ZIP files directly!
                if (f.toLowerCase().endsWith('.zip') && !f.startsWith('Laundry_')) {
                  let suite = 'CTS';
                  const fUp = f.toUpperCase();
                  if (fUp.startsWith('GTS') || fUp.includes('_GTS_')) suite = 'GTS';
                  else if (fUp.startsWith('STS') || fUp.includes('_STS_')) suite = 'STS';
                  else if (fUp.startsWith('CTS') || fUp.includes('_CTS_')) suite = 'CTS';

                  const suiteSummary = scanSuiteSummary(subDir, suite);
                  zips.push({
                    filename: f,
                    path: fullFPath,
                    sizeBytes: fStat.size,
                    modifiedAt: fStat.mtimeMs,
                    model: extractModelFromFilename(f) || meta.model,
                    plan: meta.plan,
                    suite,
                    test_type: `${meta.plan} / ${suite}`,
                    devsCount: meta.devsCount,
                    run_batch: batchName,
                    isIndividualSuite: true,
                    summary: suiteSummary || { total: 0, passed: 0, failed: 0 }
                  });
                }
              } catch (_) {}
            }
          } catch (_) {}

          if (fs.existsSync(zipCandidate) && fs.statSync(zipCandidate).isFile()) {
            const zStat = fs.statSync(zipCandidate);
            sizeBytes = zStat.size;
            if (zStat.mtimeMs > modifiedAt) modifiedAt = zStat.mtimeMs;
          }

          const effectivePath = fs.existsSync(zipCandidate) ? zipCandidate : subDir;
          const batchSummary = scanBatchSummary(subDir);
          zips.push({
            filename: `${batchName}.zip`,
            path: effectivePath,
            sizeBytes,
            modifiedAt,
            model: meta.model,
            plan: meta.plan,
            suite: meta.plan,
            test_type: meta.plan,
            devsCount: meta.devsCount,
            run_batch: batchName,
            subFilesCount,
            isMasterBatch: true,
            summary: batchSummary
          });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
          const baseName = entry.name.replace(/\.zip$/i, '');
          if (!seenBatches.has(baseName)) {
            seenBatches.add(baseName);
            const fullPath = path.join(resultsDir, entry.name);
            const stat = fs.statSync(fullPath);
            const meta = parseRunBatchMetadata(entry.name);
            const matchingDir = path.join(resultsDir, baseName);
            const summary = fs.existsSync(matchingDir) ? scanBatchSummary(matchingDir) : scanBatchSummary(fullPath);
            zips.push({
              filename: entry.name,
              path: fullPath,
              sizeBytes: stat.size,
              modifiedAt: stat.mtimeMs,
              model: meta.model,
              plan: meta.plan,
              suite: meta.plan,
              test_type: meta.plan,
              devsCount: meta.devsCount,
              run_batch: baseName,
              isMasterBatch: true,
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
  deleteRunCompletely(run_id);
  return res.json({ success: true, deleted: run_id });
});

// REST: Clear All Execution History
app.delete('/api/history', (_req, res) => {
  clearAllHistoryCompletely();
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
  const resultsDir = getResultsDir();
  const possiblePaths = [
    directPath,
    file,
    run_id ? path.join(resultsDir, run_id, filename) : '',
    path.join(resultsDir, filename),
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
  for (const job of jobHistory) {
    enrichJobSummary(job);
  }
  for (const job of activeJobs.values()) {
    enrichJobSummary(job);
  }
  const localZips = scanLocalCucianZips();

  const bridgeList = Array.from(bridges.values()).map(b => {
    return {
      pcId: b.pcId,
      os: b.os,
      ip: b.ip,
      autoRoot: b.autoRoot,
      connectedAt: b.connectedAt,
      laundryZips: b.laundryZips || []
    };
  });

  // If no bridges are connected, supply a default server entry so UI can still browse zips
  if (bridgeList.length === 0 && localZips.length > 0) {
    bridgeList.push({
      pcId: process.env.PC_ID || 'Hub-Local',
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
    jobHistory: jobHistory.slice(-50),
    preflightReports: Array.from(preflightReports.values()),
    uiState: serverUiState,
    transfers: serverActiveTransfers
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

        case 'PREFLIGHT_REPORT': {
          const pcId = msg.pcId || registeredPcId;
          if (msg.report) {
            preflightReports.set(pcId, msg.report);
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
          const { run_id, suite, status, elapsed_secs, devices: devList, test_type, workflow_id, laundry_zip_path } = msg;
          if (!run_id || deletedRunIds.has(run_id)) break;

          const hist = jobHistory.find(j => j.run_id === run_id);
          if (hist && (hist.status === 'CANCELLED' || hist.status === 'Finished' || hist.status === 'Failed' || hist.status === 'Test Done')) {
            break;
          }

          let job = activeJobs.get(run_id);
          if (!job) {
            job = {
              run_id,
              pcId: registeredPcId,
              workflow_id,
              laundry_zip_path,
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
            if (workflow_id) job.workflow_id = workflow_id;
            if (laundry_zip_path) job.laundry_zip_path = laundry_zip_path;
          }
          broadcastFleetState();
          break;
        }

        case 'RUN_FINISHED': {
          const { run_id, summary, zip_file, zip_files, exit_code } = msg;
          if (!run_id) break;
          let job = activeJobs.get(run_id);
          if (!job) {
            job = jobHistory.find(j => j.run_id === run_id);
          }
          if (job) {
            if (job.status !== 'CANCELLED') {
              job.status = exit_code === 0 ? 'Finished' : 'Failed';
            }
            job.summary = summary;
            if (zip_files && Array.isArray(zip_files)) {
              job.zip_files = zip_files;
            }
            job.zip_file = zip_file || (job.zip_files && job.zip_files[0]);
            enrichJobSummary(job);
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
          const targetPcId = msg.targetPcId || msg.pcId || registeredPcId;
          broadcastToUi({
            type: 'LAUNDRY_ANALYSIS_RESULT',
            pcId: targetPcId,
            zip_path: msg.zip_path,
            rows: msg.rows || [],
            error: msg.error
          });
          break;
        }

        case 'SYNC_PROGRESS': {
          const { id, transferredBytes, totalBytes, speedMBps, status, progress } = msg;
          if (id) {
            serverActiveTransfers = serverActiveTransfers.map((t) => {
              if (t.id === id) {
                return {
                  ...t,
                  transferredBytes: transferredBytes ?? t.transferredBytes,
                  totalBytes: totalBytes && totalBytes > 0 ? totalBytes : t.totalBytes,
                  speedMBps: speedMBps ?? t.speedMBps,
                  status: status || t.status,
                  progress: progress ?? t.progress,
                };
              }
              return t;
            });
            saveUiStateToDisk();
            broadcastFleetState();
          }
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
  for (const job of jobHistory) {
    enrichJobSummary(job);
  }
  if (preflightReports.size === 0) {
    const autoRoot = getAutoRoot();
    const localRep = generateLocalPreflightReport(autoRoot, 'Endri Ubuntu');
    preflightReports.set('Endri Ubuntu', localRep);
  }
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
    jobHistory: jobHistory.slice(-50),
    preflightReports: Array.from(preflightReports.values()),
    uiState: serverUiState,
    transfers: serverActiveTransfers
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
                workflow_id: payload.workflow_id,
                laundry_zip_path: payload.laundry_zip_path,
                test_type: payload.test_type || 'SMR',
                status: 'Starting',
                suite: payload.test_type || 'SMR',
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
              activeJobs.delete(run_id);
              const existingIdx = jobHistory.findIndex(j => j.run_id === run_id);
              if (existingIdx >= 0) {
                jobHistory[existingIdx] = { ...job, recentLogs: [...job.recentLogs] };
              } else {
                jobHistory.unshift({ ...job, recentLogs: [...job.recentLogs] });
              }
            } else {
              const hist = jobHistory.find(j => j.run_id === run_id);
              if (hist) {
                hist.status = 'CANCELLED';
              }
            }
            broadcastFleetState();
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
          const fname = path.basename(zip_path || '');
          // ponytail: Prioritize bridge that actually hosts this zip file (Endri Ubuntu / owner bridge)
          const ownerBridge = Array.from(bridges.values()).find((b) =>
            (b.laundryZips || []).some((z) => z.path === zip_path || z.filename === fname)
          );
          const candidateNodes = [
            ownerBridge?.pcId,
            'Endri Ubuntu',
            pcId,
            ...Array.from(bridges.keys())
          ].filter((id): id is string => Boolean(id) && bridges.has(id));

          const targetNode = candidateNodes[0];
          if (targetNode) {
            sendToBridge(targetNode, { type: 'CMD_ANALYZE_LAUNDRY', zip_path, targetPcId: pcId });
            console.log(`[Hub] Dispatched CMD_ANALYZE_LAUNDRY to ${targetNode} for ${zip_path} (for UI target: ${pcId})`);
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
          clearAllHistoryCompletely();
          break;
        }

        case 'EXEC_DELETE_RUN':
        case 'EXEC_DELETE_HISTORY_ITEM': {
          const { run_id } = msg;
          if (run_id) {
            deleteRunCompletely(run_id);
          }
          break;
        }

        case 'SYNC_UI_STATE': {
          if (msg.uiState && typeof msg.uiState === 'object') {
            serverUiState = { ...serverUiState, ...msg.uiState };
            saveUiStateToDisk();
            broadcastFleetState();
          }
          break;
        }

        case 'START_TRANSFER': {
          if (msg.transfer) {
            serverActiveTransfers = [
              msg.transfer,
              ...serverActiveTransfers.filter((t) => t.id !== msg.transfer.id),
            ];
            serverUiState.transferModalOpen = true;
            saveUiStateToDisk();
            broadcastFleetState();

            const { id, targetNode, filename } = msg.transfer;
            const targetRelDir = filename.replace(/\/android-(cts|gts|sts)$/, '');
            sendToBridge(targetNode, {
              type: 'CMD_SYNC_TOOL',
              id,
              resource: filename,
              target_rel_dir: targetRelDir,
            });
            console.log(`[Hub] Dispatched CMD_SYNC_TOOL to ${targetNode} for ${filename}`);
          }
          break;
        }

        case 'PAUSE_RESUME_TRANSFER': {
          if (msg.id) {
            serverActiveTransfers = serverActiveTransfers.map((t) =>
              t.id === msg.id
                ? { ...t, status: t.status === 'running' ? 'paused' : 'running' }
                : t
            );
            saveUiStateToDisk();
            broadcastFleetState();
          }
          break;
        }

        case 'CANCEL_TRANSFER': {
          if (msg.id) {
            serverActiveTransfers = serverActiveTransfers.filter((t) => t.id !== msg.id);
            saveUiStateToDisk();
            broadcastFleetState();
          }
          break;
        }

        case 'CLEAR_COMPLETED_TRANSFERS': {
          serverActiveTransfers = serverActiveTransfers.filter(
            (t) => t.status !== 'completed' && t.status !== 'cancelled'
          );
          saveUiStateToDisk();
          broadcastFleetState();
          break;
        }

        case 'CMD_TRIGGER_PREFLIGHT': {
          const targetPcId = msg.pcId;
          if (targetPcId) {
            sendToBridge(targetPcId, { type: 'CMD_TRIGGER_PREFLIGHT' });
          } else {
            for (const pcId of bridges.keys()) {
              sendToBridge(pcId, { type: 'CMD_TRIGGER_PREFLIGHT' });
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

// Realtime 1-second server ticker for active runs
setInterval(() => {
  let needsBroadcast = false;

  if (activeJobs.size > 0) {
    const now = Date.now();
    for (const job of activeJobs.values()) {
      if (job.status === 'Running' || job.status === 'Starting') {
        const currentElapsed = Math.max(0, Math.floor((now - (job.startedAt || now)) / 1000));
        if (job.elapsed_secs !== currentElapsed) {
          job.elapsed_secs = currentElapsed;
          needsBroadcast = true;
        }
      }
    }
  }

  if (needsBroadcast) {
    broadcastFleetState();
  }
}, 1000);

loadUiStateFromDisk();
initJobHistoryFromDisk();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` GBA Agentic Auto Fleet Web Hub Server Started`);
  console.log(` Listening on http://0.0.0.0:${PORT}`);
  console.log(` WebSocket Bridge: ws://0.0.0.0:${PORT}/ws/bridge`);
  console.log(` WebSocket UI:     ws://0.0.0.0:${PORT}/ws/ui`);
  console.log(`====================================================`);
});
