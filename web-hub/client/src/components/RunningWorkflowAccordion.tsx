import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem, DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon, TrashIcon, ResetIcon } from './Icons';
import { formatDurationHms } from '../utils/formatters';

interface RunningWorkflowAccordionProps {
  activeJobs: ActiveJobItem[];
  jobHistory?: ActiveJobItem[];
  devices?: DeviceItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
}

const SingleWorkflowRunner: React.FC<{
  job: ActiveJobItem;
  devices?: DeviceItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
  onDismiss: (run_id: string) => void;
}> = ({ job, devices, onCancelJob, onDismiss }) => {
  const isRunning = job.status === 'Running' || job.status === 'Starting';
  const isFinished = job.status === 'Finished' || job.status === 'Test Done';
  const isFailed = job.status === 'Failed';

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  const currentElapsed = isRunning && job.startedAt
    ? Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000))
    : (job.elapsed_secs || 0);

  // Active runs default collapsed to keep dashboard clean and avoid visual overwhelm
  const [isParentOpen, setIsParentOpen] = useState<boolean>(false);
  const [isAiWorkerOpen, setIsAiWorkerOpen] = useState<boolean>(false);
  const [isCtsOpen, setIsCtsOpen] = useState<boolean>(false);
  const [isGtsOpen, setIsGtsOpen] = useState<boolean>(false);
  const [isStsOpen, setIsStsOpen] = useState<boolean>(false);

  const [clearedLogs, setClearedLogs] = useState<Record<string, number>>({});
  const aiWorkerLogRef = useRef<HTMLPreElement>(null);
  const ctsLogRef = useRef<HTMLPreElement>(null);
  const gtsLogRef = useRef<HTMLPreElement>(null);
  const stsLogRef = useRef<HTMLPreElement>(null);

  // Extract model & AP Version from target devices
  const devicesList: string[] = useMemo(() => {
    const devs = job.devices as unknown;
    if (Array.isArray(devs)) return devs;
    if (typeof devs === 'string' && devs.trim().length > 0) {
      return devs.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    return [];
  }, [job.devices]);

  const matchedDevice = useMemo(() => {
    return (devices || []).find((d) => devicesList.includes(d.serial));
  }, [devices, devicesList]);

  const targetModel = matchedDevice?.model || 'SM-DEVICE';
  const apVersion = matchedDevice?.pda || matchedDevice?.security_patch || '-';
  const isUserdebug = matchedDevice?.is_userdebug ?? false;

  const rawLogs: string[] = useMemo(() => {
    return Array.isArray(job.recentLogs) ? job.recentLogs : [];
  }, [job.recentLogs]);

  // AI Worker Summary Logs
  const aiWorkerLogs = useMemo(() => {
    return rawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return (
        lower.includes('[ai worker]') ||
        lower.includes('[runner]') ||
        lower.includes('[roxml]') ||
        lower.includes('[prepare]') ||
        lower.includes('[preflight]') ||
        lower.includes('[bridge]') ||
        lower.includes('[hub]')
      );
    });
  }, [rawLogs]);

  // CTS Logs (only genuine CTS tradefed console output)
  const ctsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        if (l.startsWith('[preflight]') || l.startsWith('[AI Worker]') || l.startsWith('[prepare]') || l.startsWith('[Bridge]')) return false;
        return l.startsWith('[CTS]') || l.includes('cts-tf >') || l.includes('cts-console') || l.includes('cts-smr') || l.includes('cts-sku');
      })
      .map((l) => (l.startsWith('[CTS] ') ? l.substring(6) : l.startsWith('[CTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // GTS Logs (only genuine GTS tradefed console output)
  const gtsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        if (l.startsWith('[preflight]') || l.startsWith('[AI Worker]') || l.startsWith('[prepare]') || l.startsWith('[Bridge]')) return false;
        return l.startsWith('[GTS]') || l.includes('gts-tf >') || l.includes('gts-console') || l.includes('gts_main') || l.includes('gtsmr');
      })
      .map((l) => (l.startsWith('[GTS] ') ? l.substring(6) : l.startsWith('[GTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // STS Logs (only genuine STS tradefed console output)
  const stsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        if (l.startsWith('[preflight]') || l.startsWith('[AI Worker]') || l.startsWith('[prepare]') || l.startsWith('[Bridge]')) return false;
        return l.startsWith('[STS]') || l.includes('sts-tf >') || l.includes('sts-console') || l.includes('sts-dynamic-plan');
      })
      .map((l) => (l.startsWith('[STS] ') ? l.substring(6) : l.startsWith('[STS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // Auto-open child accordion based on active suite or log arrival
  useEffect(() => {
    const currentSuite = (job.suite || '').toUpperCase();
    if (currentSuite.includes('STS') && stsLogs.length > 0 && !isStsOpen) {
      setIsStsOpen(true);
    }
    if (currentSuite.includes('CTS') && ctsLogs.length > 0 && !isCtsOpen) {
      setIsCtsOpen(true);
    }
    if (currentSuite.includes('GTS') && gtsLogs.length > 0 && !isGtsOpen) {
      setIsGtsOpen(true);
    }
  }, [job.suite, stsLogs.length, ctsLogs.length, gtsLogs.length]);

  // Auto-scroll
  useEffect(() => {
    if (aiWorkerLogRef.current) aiWorkerLogRef.current.scrollTop = aiWorkerLogRef.current.scrollHeight;
    if (ctsLogRef.current) ctsLogRef.current.scrollTop = ctsLogRef.current.scrollHeight;
    if (gtsLogRef.current) gtsLogRef.current.scrollTop = gtsLogRef.current.scrollHeight;
    if (stsLogRef.current) stsLogRef.current.scrollTop = stsLogRef.current.scrollHeight;
  }, [aiWorkerLogs.length, ctsLogs.length, gtsLogs.length, stsLogs.length]);

  const handleClearSection = (key: string, length: number) => {
    setClearedLogs((prev) => ({ ...prev, [key]: length }));
  };

  // Ready result ZIPs
  const availableZips = useMemo(() => {
    const zips: string[] = [];
    if (Array.isArray(job.zip_files)) {
      for (const z of job.zip_files) {
        if (z && !zips.includes(z)) zips.push(z);
      }
    }
    if (job.zip_file && !zips.includes(job.zip_file)) {
      zips.push(job.zip_file);
    }
    return zips;
  }, [job.zip_files, job.zip_file]);

  const renderConsoleScreen = (
    logs: string[],
    ref: React.RefObject<HTMLPreElement>,
    sectionKey: string,
    emptyMsg: string
  ) => {
    const offset = clearedLogs[sectionKey] || 0;
    const visibleLines = logs.slice(offset);

    return (
      <pre ref={ref} className="log-console-box" style={{ maxHeight: '240px', overflowY: 'auto' }}>
        {visibleLines.length > 0 ? (
          visibleLines.map((line, idx) => {
            let logClass = '';
            if (line.includes('ERROR') || line.includes('FAIL') || line.includes('Exception') || line.includes('Failed')) {
              logClass = 'log-fail';
            } else if (line.includes('PASS') || line.includes('Passed') || line.includes('ready') || line.includes('Completed') || line.includes('Test Done')) {
              logClass = 'log-pass';
            } else if (line.includes('WARN') || line.includes('Warning')) {
              logClass = 'log-warn';
            } else if (line.includes('[AI Worker]') || line.includes('[runner]') || line.includes('[Bridge]') || line.includes('[prepare]')) {
              logClass = 'log-info';
            }

            return (
              <div key={idx} className={`log-line ${logClass}`}>
                {line}
              </div>
            );
          })
        ) : (
          <div style={{ color: 'var(--log-text-muted, var(--text-muted))', textAlign: 'center', padding: '1.5rem', fontSize: '0.8125rem' }}>
            {emptyMsg}
          </div>
        )}
      </pre>
    );
  };

  const isCancelled = job.status === 'Cancelled';
  const statusBadgeClass = isRunning
    ? 'badge-running'
    : isCancelled
    ? 'badge-busy'
    : 'badge-ready';

  const glowClass = isRunning
    ? 'glow-outline-running'
    : 'glow-outline-idle';

  const getSuiteStatus = (suiteName: 'STS' | 'CTS' | 'GTS', logs: string[]) => {
    const currentSuite = (job.suite || '').toUpperCase();
    const isCurrentlyExecuting = isRunning && currentSuite.includes(suiteName);
    const hasConsoleLogs = logs.length > 0;
    const isFinishedLog = logs.some(
      (l) => l.includes('tradefed finished') || l.includes('End of Results') || l.includes('All done') || l.includes('Summary') || l.includes('Saved test result to')
    );

    if (isRunning) {
      if (isCurrentlyExecuting) {
        return { text: 'RUNNING', cls: 'badge-running' };
      }
      if (hasConsoleLogs && isFinishedLog) {
        return { text: 'COMPLETED', cls: 'badge-ready' };
      }
      return { text: 'STANDBY', cls: 'badge-busy' };
    }

    if (hasConsoleLogs) {
      return { text: 'COMPLETED', cls: 'badge-ready' };
    }

    return { text: 'STANDBY', cls: 'badge-neutral' };
  };

  const stsStatus = getSuiteStatus('STS', stsLogs);
  const ctsStatus = getSuiteStatus('CTS', ctsLogs);
  const gtsStatus = getSuiteStatus('GTS', gtsLogs);

  return (
    <section className={`laundry-table-card ${glowClass}`} style={{ marginBottom: 0, borderRadius: '10px', overflow: 'hidden', transition: 'all 0.25s ease' }}>
      {/* Testrun Child Accordion Header */}
      <div
        className="workflow-run-head"
        onClick={() => setIsParentOpen(!isParentOpen)}
        style={{
          cursor: 'pointer',
          borderRadius: isParentOpen ? '10px 10px 0 0' : '10px',
        }}
      >
        {/* Top Right Dismiss/Delete Button */}
        <button
          className="btn-icon-danger workflow-run-dismiss-top"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(job.run_id);
          }}
          title="Tutup / Dismiss Accordion Log Run ini"
          aria-label="Dismiss Run Accordion"
        >
          <TrashIcon size={13} />
        </button>

        {/* Main Content Area */}
        <div className="workflow-run-main">
          {/* Top Row: Chevron, Title, Status, Model, AP, Workstation */}
          <div className="workflow-run-row-primary">
            <div className="workflow-run-title-group">
              <span className="workflow-run-chevron" style={{ color: 'var(--text-muted)' }}>
                {isParentOpen ? <ChevronUpIcon size={18} /> : <ChevronDownIcon size={18} />}
              </span>
              <strong className="workflow-run-title">
                WORKFLOW: {(job.test_type || job.suite || '').replace(/^Laundry\s+/i, '')}
              </strong>
            </div>

            {/* Status, Model & Firmware Badges, PC ID */}
            <div className="workflow-run-meta-badges">
              <span className={`badge ${statusBadgeClass}`} style={{ fontWeight: 700, fontSize: '0.725rem' }}>
                {isRunning ? 'RUNNING' : isCancelled ? 'CANCELLED' : 'FINISHED'}
              </span>
              {targetModel && <span className="badge badge-pc">{targetModel}</span>}
              {apVersion && apVersion !== '-' && <span className="badge badge-pc mono-cell">{apVersion}</span>}
              {job.pcId && <span className="badge badge-pc">{job.pcId}</span>}
            </div>
          </div>

          {/* Bottom Row: Devices Serials List Strip */}
          {devicesList.length > 0 && (
            <div className="workflow-run-row-secondary">
              <span className="workflow-serials-label">
                DEVICES ({devicesList.length}):
              </span>
              <div className="workflow-serials-scroll hide-scrollbar">
                {devicesList.map((serial) => (
                  <span key={serial} className="badge badge-pc mono-cell" style={{ flexShrink: 0 }}>
                    {serial}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Action Area: Timer and Action (Cancel Flow) */}
        <div className="workflow-run-actions" onClick={(e) => e.stopPropagation()}>
          <span
            className="mono-cell workflow-run-timer"
            style={{
              fontSize: '0.8125rem',
              color: isRunning ? 'var(--accent-warning, #f59e0b)' : 'var(--text-secondary)',
              fontWeight: isRunning ? 700 : 600,
              backgroundColor: 'var(--bg-card, rgba(255,255,255,0.04))',
              padding: '0.25rem 0.65rem',
              borderRadius: 'var(--radius-full)',
              border: '1px solid var(--border-subtle)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              height: '28px'
            }}
          >
            ⏱ {formatDurationHms(currentElapsed)}
          </span>
          {isRunning && (
            <button
              className="btn btn-danger btn-xs btn-cancel-flow"
              onClick={() => onCancelJob(job.pcId, job.run_id)}
              title="Cancel Flow"
            >
              <StopIcon size={12} />
              <span>Cancel Flow</span>
            </button>
          )}
        </div>
      </div>

      {/* Testrun Child Accordion Body */}
      {isParentOpen && (
        <div style={{ padding: '0.5rem 0.65rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {/* 1. AI Worker & Agentic Flow Summary (Top Section) */}
          <section className="running-log-card" style={{ marginBottom: 0 }}>
            <div
              className="running-log-head"
              style={{ backgroundColor: 'rgba(56, 139, 253, 0.08)', cursor: 'pointer' }}
              onClick={() => setIsAiWorkerOpen(!isAiWorkerOpen)}
            >
              <div className="running-log-head-title">
                <span>Summary</span>
                <span className="badge badge-pc badge-count-pill">{aiWorkerLogs.length}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="log-clear-btn"
                  onClick={() => handleClearSection('ai_worker', aiWorkerLogs.length)}
                  title="Clear log"
                  aria-label="Clear log"
                >
                  <ResetIcon size={13} />
                </button>
              </div>
            </div>
            {isAiWorkerOpen && (
              <div className="running-log-body">
                {renderConsoleScreen(aiWorkerLogs, aiWorkerLogRef, 'ai_worker', 'Menunggu tahapan AI Worker...')}
              </div>
            )}
          </section>

          {/* 2. Individual Suite Accordions Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {/* Child 1: STS Tradefed Runner */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div
                className="running-log-head"
                style={{ backgroundColor: 'var(--bg-subtle)', cursor: 'pointer' }}
                onClick={() => setIsStsOpen(!isStsOpen)}
              >
                <div className="running-log-head-title">
                  <span>STS</span>
                  <span className="badge badge-unit badge-count-pill">{stsLogs.length}</span>
                  {stsStatus && (
                    <span className={`badge ${stsStatus.cls} badge-xs`} style={{ fontWeight: 700 }}>
                      {stsStatus.text}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="log-clear-btn"
                    onClick={() => handleClearSection('sts', stsLogs.length)}
                    title="Clear log"
                    aria-label="Clear log"
                  >
                    <ResetIcon size={13} />
                  </button>
                </div>
              </div>
              {isStsOpen && (
                <div className="running-log-body">
                  {renderConsoleScreen(stsLogs, stsLogRef, 'sts', 'Belum ada output log konsol STS Tradefed.')}
                </div>
              )}
            </section>

            {/* Child 2: CTS Tradefed Runner */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div
                className="running-log-head"
                style={{ backgroundColor: 'var(--bg-subtle)', cursor: 'pointer' }}
                onClick={() => setIsCtsOpen(!isCtsOpen)}
              >
                <div className="running-log-head-title">
                  <span>CTS</span>
                  <span className="badge badge-unit badge-count-pill">{ctsLogs.length}</span>
                  {ctsStatus && (
                    <span className={`badge ${ctsStatus.cls} badge-xs`} style={{ fontWeight: 700 }}>
                      {ctsStatus.text}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="log-clear-btn"
                    onClick={() => handleClearSection('cts', ctsLogs.length)}
                    title="Clear log"
                    aria-label="Clear log"
                  >
                    <ResetIcon size={13} />
                  </button>
                </div>
              </div>
              {isCtsOpen && (
                <div className="running-log-body">
                  {renderConsoleScreen(ctsLogs, ctsLogRef, 'cts', 'Belum ada output log konsol CTS Tradefed.')}
                </div>
              )}
            </section>

            {/* Child 3: GTS Tradefed Runner */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div
                className="running-log-head"
                style={{ backgroundColor: 'var(--bg-subtle)', cursor: 'pointer' }}
                onClick={() => setIsGtsOpen(!isGtsOpen)}
              >
                <div className="running-log-head-title">
                  <span>GTS</span>
                  <span className="badge badge-unit badge-count-pill">{gtsLogs.length}</span>
                  {gtsStatus && (
                    <span className={`badge ${gtsStatus.cls} badge-xs`} style={{ fontWeight: 700 }}>
                      {gtsStatus.text}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="log-clear-btn"
                    onClick={() => handleClearSection('gts', gtsLogs.length)}
                    title="Clear log"
                    aria-label="Clear log"
                  >
                    <ResetIcon size={13} />
                  </button>
                </div>
              </div>
              {isGtsOpen && (
                <div className="running-log-body">
                  {renderConsoleScreen(gtsLogs, gtsLogRef, 'gts', 'Belum ada output log konsol GTS Tradefed.')}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
};

export const RunningWorkflowAccordion: React.FC<RunningWorkflowAccordionProps> = ({
  activeJobs,
  jobHistory = [],
  devices,
  onCancelJob,
}) => {
  const [isMasterOpen, setIsMasterOpen] = useState<boolean>(false);
  const [dismissedRunIds, setDismissedRunIds] = useState<string[]>([]);

  // Maintain list of all runs: active runs + finished runs (newest first)
  const displayRuns = useMemo(() => {
    const runMap = new Map<string, ActiveJobItem>();

    // First add history jobs
    for (const j of jobHistory) {
      if (j && j.run_id) {
        runMap.set(j.run_id, j);
      }
    }

    // Active jobs override or add
    for (const j of activeJobs) {
      if (j && j.run_id) {
        runMap.set(j.run_id, j);
      }
    }

    const all = Array.from(runMap.values());
    all.sort((a, b) => {
      const aRunning = a.status === 'Running' || a.status === 'Starting';
      const bRunning = b.status === 'Running' || b.status === 'Starting';
      if (aRunning && !bRunning) return -1;
      if (!aRunning && bRunning) return 1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
    // Filter out dismissed runs
    return all.filter((j) => !dismissedRunIds.includes(j.run_id));
  }, [activeJobs, jobHistory, dismissedRunIds]);

  const activeCount = useMemo(() => {
    return displayRuns.filter((j) => j.status === 'Running' || j.status === 'Starting').length;
  }, [displayRuns]);

  const finishedCount = useMemo(() => {
    return displayRuns.filter((j) => j.status === 'Finished' || j.status === 'Test Done').length;
  }, [displayRuns]);

  const [masterTick, setMasterTick] = useState(0);
  useEffect(() => {
    if (activeCount === 0) return;
    const interval = setInterval(() => setMasterTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeCount]);

  const activeElapsed = useMemo(() => {
    const activeJobsList = displayRuns.filter((j) => j.status === 'Running' || j.status === 'Starting');
    if (activeJobsList.length === 0) return 0;
    return Math.max(...activeJobsList.map((j) => (j.startedAt ? Math.max(0, Math.floor((Date.now() - j.startedAt) / 1000)) : (j.elapsed_secs || 0))));
  }, [displayRuns, masterTick]);

  const handleDismiss = (run_id: string) => {
    setDismissedRunIds((prev) => [...prev, run_id]);
  };

  if (displayRuns.length === 0) {
    return null;
  }

  const hasActiveRuns = activeCount > 0;

  return (
    <div className={`workflow-master-card ${hasActiveRuns ? 'glow-master-parent' : ''}`}>
      {/* Master Parent Accordion Header */}
      <div
        className="workflow-master-header"
        onClick={() => setIsMasterOpen(!isMasterOpen)}
        style={{
          borderBottom: isMasterOpen ? '1px solid var(--border-subtle)' : 'none',
          borderRadius: isMasterOpen ? 'var(--radius-lg) var(--radius-lg) 0 0' : 'var(--radius-lg)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="accordion-toggle-btn"
            aria-label="Toggle master workflow runs"
          >
            {isMasterOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.01em' }}>
              RUNS & LOGS
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
          {activeCount > 0 && (
            <span
              className="mono-cell"
              style={{
                fontSize: '0.8125rem',
                color: 'var(--accent-warning, #f59e0b)',
                fontWeight: 700,
                backgroundColor: 'var(--bg-card, rgba(255,255,255,0.04))',
                padding: '0.2rem 0.55rem',
                borderRadius: '4px',
                border: '1px solid var(--border-color, rgba(255,255,255,0.08))'
              }}
            >
              ⏱ {formatDurationHms(activeElapsed)}
            </span>
          )}
          {dismissedRunIds.length > 0 && (
            <button
              className="btn btn-secondary btn-xs"
              onClick={() => setDismissedRunIds([])}
              title="Tampilkan kembali semua run yang ditutup"
            >
              Restore Closed Runs
            </button>
          )}
          <span
            className="workflow-count-badge"
            title={`${finishedCount} Selesai / ${displayRuns.length} Total Run`}
          >
            {finishedCount}/{displayRuns.length}
          </span>
        </div>
      </div>

      {/* Master Parent Accordion Body (contains individual Testrun Accordions) */}
      {isMasterOpen && (
        <div className="workflow-master-body">
          {displayRuns.map((job) => (
            <SingleWorkflowRunner
              key={job.run_id}
              job={job}
              devices={devices}
              onCancelJob={onCancelJob}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
};


