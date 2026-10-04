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
}

export function useFleetWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [bridges, setBridges] = useState<BridgeInfo[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJobItem[]>([]);
  const [jobHistory, setJobHistory] = useState<ActiveJobItem[]>([]);
  const [laundryAnalysis, setLaundryAnalysis] = useState<{
    pcId: string;
    zip_path: string;
    rows: LaundryRow[];
    error?: string;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

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
          case 'FLEET_STATE':
            setBridges(msg.bridges || []);
            setDevices(msg.devices || []);
            setActiveJobs(msg.activeJobs || []);
            setJobHistory(msg.jobHistory || []);
            break;

          case 'LOG_LINE':
            setActiveJobs((prev) =>
              prev.map((job) => {
                if (job.run_id === msg.run_id) {
                  const updatedLogs = [...job.recentLogs, msg.line];
                  if (updatedLogs.length > 500) updatedLogs.shift();
                  return { ...job, recentLogs: updatedLogs };
                }
                return job;
              })
            );
            break;

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
    return () => {
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const runSuite = useCallback((pcId: string, payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'EXEC_RUN_SUITE', pcId, payload }));
    }
  }, []);

  const cancelRun = useCallback((pcId: string, run_id: string) => {
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

  return {
    isConnected,
    bridges,
    devices,
    activeJobs,
    jobHistory,
    laundryAnalysis,
    setLaundryAnalysis,
    runSuite,
    cancelRun,
    resetBusy,
    setDeviceLamp,
    analyzeLaundry
  };
}
