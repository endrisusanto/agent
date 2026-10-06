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

import fs from 'fs';
import child_process from 'child_process';

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
let serverWorkflows: LaundryWorkflowState[] = [];

const WORKFLOWS_FILE = process.env.WORKFLOWS_FILE || '/run/media/endri-pro/BINARY_HDD/AUTO/workflows_state.json';
const FALLBACK_WORKFLOWS_FILE = path.join(__dirname, '../workflows_state.json');

function loadWorkflowsFromDisk(): void {
  try {
    const file = fs.existsSync(WORKFLOWS_FILE) ? WORKFLOWS_FILE : (fs.existsSync(FALLBACK_WORKFLOWS_FILE) ? FALLBACK_WORKFLOWS_FILE : null);
    if (file) {
      const data = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        serverWorkflows = parsed;
        console.log(`[Hub] Loaded ${serverWorkflows.length} unified workflows from ${file}`);
        return;
      }
    }
  } catch (err) {
    console.error('[Hub] Failed to load workflows state:', err);
  }
  if (serverWorkflows.length === 0) {
    serverWorkflows = [{
      id: 'wf-initial',
      model: '',
      selectedModules: [],
      selectedSerials: [],
      pda: ''
    }];
  }
}

function saveWorkflowsToDisk(wfs: LaundryWorkflowState[]): void {
  try {
    const targetFile = fs.existsSync(path.dirname(WORKFLOWS_FILE)) ? WORKFLOWS_FILE : FALLBACK_WORKFLOWS_FILE;
    fs.writeFileSync(targetFile, JSON.stringify(wfs, null, 2), 'utf8');
  } catch (err) {
    console.error('[Hub] Failed to save workflows state to disk:', err);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

// REST: Workflows State API
app.get('/api/workflows', (_req, res) => {
  res.json({ workflows: serverWorkflows });
});

app.post('/api/workflows', (req, res) => {
  const { workflows } = req.body;
  if (Array.isArray(workflows)) {
    serverWorkflows = workflows;
    saveWorkflowsToDisk(serverWorkflows);
    broadcastFleetState();
    return res.json({ success: true, count: serverWorkflows.length });
  }
  return res.status(400).json({ error: 'Expected array of workflows' });
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
  const resultsDir = '/run/media/endri-pro/BINARY_HDD/AUTO/Results';
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
  const resultsDir = '/run/media/endri-pro/BINARY_HDD/AUTO/Results';
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
        const runId = runIdMatch ? runIdMatch[1] : entry.name;

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
  const resultsDir = '/run/media/endri-pro/BINARY_HDD/AUTO/Results';
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
  for (const job of jobHistory) {
    enrichJobSummary(job);
  }
  for (const job of activeJobs.values()) {
    enrichJobSummary(job);
  }
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
    jobHistory: jobHistory.slice(-50),
    workflows: serverWorkflows
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
  for (const job of jobHistory) {
    enrichJobSummary(job);
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
    workflows: serverWorkflows
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

        case 'SYNC_WORKFLOWS': {
          if (Array.isArray(msg.workflows)) {
            serverWorkflows = msg.workflows;
            saveWorkflowsToDisk(serverWorkflows);
            broadcastFleetState();
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
  if (activeJobs.size > 0) {
    const now = Date.now();
    let hasRunning = false;
    for (const job of activeJobs.values()) {
      if (job.status === 'Running' || job.status === 'Starting') {
        const currentElapsed = Math.max(0, Math.floor((now - (job.startedAt || now)) / 1000));
        if (job.elapsed_secs !== currentElapsed) {
          job.elapsed_secs = currentElapsed;
          hasRunning = true;
        }
      }
    }
    if (hasRunning) {
      broadcastFleetState();
    }
  }
}, 1000);

loadWorkflowsFromDisk();
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
