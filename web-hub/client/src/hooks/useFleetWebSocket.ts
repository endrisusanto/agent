import { useState, useEffect, useRef, useCallback } from 'react';

export interface DeviceItem {
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

export interface BridgeInfo {
  pcId: string;
  os: string;
  ip: string;
  autoRoot: string;
  connectedAt: number;
  laundryZips: LaundryZipItem[];
}

export interface ActiveJobItem {
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
  summary?: {
    run_id: string;
    test_type: string;
    suite: string;
    devices: string;
    run_time: string;
    modules: string;
    total: number;
    passed: number;
    failed: number;
  };
  zip_file?: string;
  zip_files?: string[];
  recentLogs: string[];
}

export interface LaundryRow {
  id: string;
  suite: string;
  testcase: string;
  subtestcases: string;
  status: string;
  time: string;
  total: number;
  passed: number;
  failed: number;
  suite_version: string;
  result_dir: string;
  model: string;
  ap_version?: string;
  plan?: string;
  fingerprint?: string;
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
  fingerprint?: string;
  cachedRows?: LaundryRow[];
  lastRunId?: string;
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

export interface PreflightItem {
  category: string;
  item: string;
  status: 'OK' | 'MISSING' | 'WARN';
  details?: string;
  path: string;
  can_sync: boolean;
  zip_available: boolean;
  zip_path?: string;
  version?: string;
  suite?: string;
}

export interface PreflightReport {
  pc_id: string;
  auto_root: string;
  items: PreflightItem[];
  scanned_at: number;
}

export function useFleetWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJobItem[]>([]);
  const [jobHistory, setJobHistory] = useState<ActiveJobItem[]>([]);
  const [workflows, setWorkflows] = useState<LaundryWorkflowState[]>([]);
  const [preflightReports, setPreflightReports] = useState<PreflightReport[]>([]);
  const [uiState, setUiState] = useState<UnifiedUiState>({
    standbyExpanded: false,
    resultsExpanded: true,
    transferModalOpen: false,
    transferModalExpanded: true,
  });
  const [transfers, setTransfers] = useState<ActiveTransferItem[]>([]);
  const [cancellingRunIds, setCancellingRunIds] = useState<string[]>([]);
  const [laundryAnalysis, setLaundryAnalysis] = useState<{
    pcId: string;
    zip_path: string;
    rows: LaundryRow[];
    error?: string;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const logsByRunIdRef = useRef<Map<string, string[]>>(new Map());
  const lastLocalUiUpdateRef = useRef<number>(0);
  const lastLocalWorkflowsUpdateRef = useRef<number>(0);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/ui`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      console.log('[UI] Connected to Web Hub WebSocket');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'FLEET_STATE': {
            setBridges(msg.bridges || []);
            setDevices(msg.devices || []);
            
            // Guard against stale broadcast overwriting recent local workflow updates
            if (Date.now() - lastLocalWorkflowsUpdateRef.current > 800) {
              if (Array.isArray(msg.workflows) && msg.workflows.length > 0) {
                setWorkflows(msg.workflows);
              }
            }

            if (Array.isArray(msg.preflightReports)) {
              setPreflightReports(msg.preflightReports);
            }

            // Guard against stale broadcast overwriting recent local UI state interactions
            if (Date.now() - lastLocalUiUpdateRef.current > 600) {
              if (msg.uiState && typeof msg.uiState === 'object') {
                setUiState((prev) => ({ ...prev, ...msg.uiState }));
              }
            }

            if (Array.isArray(msg.transfers)) {
              setTransfers(msg.transfers);
            }

            const enrichedActive: ActiveJobItem[] = (msg.activeJobs || []).map((j: ActiveJobItem) => {
              const cached = logsByRunIdRef.current.get(j.run_id) || [];
              const raw = Array.isArray(j.recentLogs) ? j.recentLogs : [];
              const merged = cached.length > raw.length ? cached : raw;
              logsByRunIdRef.current.set(j.run_id, merged);
              return { ...j, recentLogs: merged };
            });

            const enrichedHistory: ActiveJobItem[] = (msg.jobHistory || []).map((j: ActiveJobItem) => {
              const cached = logsByRunIdRef.current.get(j.run_id) || [];
              const raw = Array.isArray(j.recentLogs) ? j.recentLogs : [];
              const merged = cached.length > raw.length ? cached : raw;
              logsByRunIdRef.current.set(j.run_id, merged);
              return { ...j, recentLogs: merged };
            });

            setActiveJobs(enrichedActive);
            setJobHistory(enrichedHistory);
            // Clear out any cancellingRunIds that are no longer active or have completed
            setCancellingRunIds((prev) =>
              prev.filter((id) =>
                enrichedActive.some((j) => j.run_id === id && j.status !== 'Cancelled' && j.status !== 'Finished' && j.status !== 'Failed')
              )
            );
            break;
          }

          case 'PREFLIGHT_UPDATE':
            if (msg.report) {
              setPreflightReports((prev) => {
                const filtered = prev.filter((r) => r.pc_id !== msg.pcId);
                return [...filtered, msg.report];
              });
            }
            break;

          case 'LOG_LINE': {
            const { run_id, line } = msg;
            if (run_id && line) {
              const existing = logsByRunIdRef.current.get(run_id) || [];
              existing.push(line);
              if (existing.length > 2000) existing.shift();
              logsByRunIdRef.current.set(run_id, existing);

              setActiveJobs((prev) =>
                prev.map((job) => {
                  if (job.run_id === run_id) {
                    return { ...job, recentLogs: [...existing] };
                  }
                  return job;
                })
              );

              setJobHistory((prev) =>
                prev.map((job) => {
                  if (job.run_id === run_id) {
                    return { ...job, recentLogs: [...existing] };
                  }
                  return job;
                })
              );
            }
            break;
          }

          case 'LAUNDRY_ANALYSIS_RESULT':
            setLaundryAnalysis({
              pcId: msg.pcId,
              zip_path: msg.zip_path,
              rows: msg.rows || [],
              error: msg.error
            });
            break;

          default:
            break;
        }
      } catch (e) {
        console.error('[UI] WebSocket parse error:', e);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      console.log('[UI] Disconnected from Web Hub. Reconnecting in 3s...');
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error('[UI] WebSocket error:', err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    // Also fetch initial preflight list via HTTP
    fetch('/api/preflight/list')
      .then((r) => r.ok ? r.json() : { reports: [] })
      .then((data) => {
        if (Array.isArray(data.reports) && data.reports.length > 0) {
          setPreflightReports(data.reports);
        }
      })
      .catch(() => {});

    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const triggerPreflightCheck = useCallback((pcId?: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'CMD_TRIGGER_PREFLIGHT', pcId }));
    }
  }, []);

  const runSuite = useCallback((pcId: string, payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_RUN_SUITE', pcId, payload }));
    }
  }, []);

  const cancelRun = useCallback((pcId: string, run_id: string) => {
    setCancellingRunIds((prev) => (prev.includes(run_id) ? prev : [...prev, run_id]));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_CANCEL_RUN', pcId, run_id }));
    }
  }, []);

  const resetBusy = useCallback((pcId: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_RESET_BUSY', pcId }));
    }
  }, []);

  const setDeviceLamp = useCallback((pcId: string, serial: string, brighten: boolean) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_SET_LAMP', pcId, serial, brighten }));
    }
  }, []);

  const analyzeLaundry = useCallback((pcId: string, zip_path: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_ANALYZE_LAUNDRY', pcId, zip_path }));
    }
  }, []);

  const deleteHistoryItem = useCallback((run_id: string) => {
    setJobHistory((prev) => prev.filter((j) => j.run_id !== run_id));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_DELETE_HISTORY_ITEM', run_id }));
    }
    fetch(`/api/history/${encodeURIComponent(run_id)}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const clearHistory = useCallback(() => {
    setJobHistory([]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_CLEAR_HISTORY' }));
    }
    fetch('/api/history', { method: 'DELETE' }).catch(() => {});
  }, []);

  const syncWorkflows = useCallback((newWorkflows: LaundryWorkflowState[]) => {
    lastLocalWorkflowsUpdateRef.current = Date.now();
    setWorkflows(newWorkflows);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'SYNC_WORKFLOWS', workflows: newWorkflows }));
    }
  }, []);

  const updateUiState = useCallback((partial: Partial<UnifiedUiState>) => {
    lastLocalUiUpdateRef.current = Date.now();
    setUiState((prev) => ({ ...prev, ...partial }));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'SYNC_UI_STATE', uiState: partial }));
    }
  }, []);

  const startTransfer = useCallback(
    (sourceNode: string, targetNode: string, resourceName: string) => {
      const isZip = resourceName.endsWith('.zip') || resourceName.includes('OXM');
      const totalBytes = isZip ? 16.34 * 1024 * 1024 * 1024 : 1.2 * 1024 * 1024 * 1024;
      const newTransfer: ActiveTransferItem = {
        id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: isZip ? 'firmware' : 'tools',
        sourceNode: sourceNode || 'Endri',
        targetNode: targetNode || 'ubuntu-gba-pro',
        filename:
          resourceName.startsWith('CTS') ||
          resourceName.startsWith('GTS') ||
          resourceName.startsWith('STS')
            ? resourceName
            : `ALL_OXM_${resourceName}_S911BXXUAGZIF_S911B01.zip`,
        totalBytes,
        transferredBytes: totalBytes * 0.002,
        speedMBps: 6.2 + Math.random() * 2.5,
        status: 'running',
        progress: 0.2,
      };

      setTransfers((prev) => [newTransfer, ...prev]);
      updateUiState({ transferModalOpen: true });

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'START_TRANSFER', transfer: newTransfer }));
      }
    },
    [updateUiState]
  );

  const pauseResumeTransfer = useCallback((id: string) => {
    setTransfers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status: t.status === 'running' ? 'paused' : 'running' } : t))
    );
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'PAUSE_RESUME_TRANSFER', id }));
    }
  }, []);

  const cancelTransfer = useCallback((id: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== id));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'CANCEL_TRANSFER', id }));
    }
  }, []);

  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) => prev.filter((t) => t.status !== 'completed' && t.status !== 'cancelled'));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'CLEAR_COMPLETED_TRANSFERS' }));
    }
  }, []);

  const closeTransferModal = useCallback(() => {
    updateUiState({ transferModalOpen: false });
  }, [updateUiState]);

  return {
    isConnected,
    bridges,
    devices,
    activeJobs,
    jobHistory,
    workflows,
    setWorkflows,
    syncWorkflows,
    uiState,
    updateUiState,
    transfers,
    startTransfer,
    pauseResumeTransfer,
    cancelTransfer,
    clearCompletedTransfers,
    closeTransferModal,
    preflightReports,
    triggerPreflightCheck,
    laundryAnalysis,
    setLaundryAnalysis,
    runSuite,
    cancelRun,
    cancellingRunIds,
    resetBusy,
    setDeviceLamp,
    analyzeLaundry,
    deleteHistoryItem,
    clearHistory,
  };
}
