import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem, DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon, TrashIcon } from './Icons';

interface RunningWorkflowAccordionProps {
  activeJobs: ActiveJobItem[];
  jobHistory?: ActiveJobItem[];
  devices?: DeviceItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  const matchedDevice = useMemo(() => {
    return (devices || []).find((d) => (job.devices || []).includes(d.serial));
  }, [devices, job.devices]);

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

  // CTS Logs
  const ctsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        return l.startsWith('[CTS]') || l.includes('cts-tradefed') || l.includes('cts-console') || l.includes('cts-smr') || l.includes('cts-sku');
      })
      .map((l) => (l.startsWith('[CTS] ') ? l.substring(6) : l.startsWith('[CTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // GTS Logs
  const gtsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        return l.startsWith('[GTS]') || l.includes('gts-tradefed') || l.includes('gts-console') || l.includes('gts_main') || l.includes('gtsmr');
      })
      .map((l) => (l.startsWith('[GTS] ') ? l.substring(6) : l.startsWith('[GTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // STS Logs
  const stsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        return l.startsWith('[STS]') || l.includes('sts-tradefed') || l.includes('sts-console') || l.includes('sts-dynamic-plan');
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
            let color = '#f0f6fc';
            if (line.includes('ERROR') || line.includes('FAIL') || line.includes('Failed') || line.includes('Exception') || line.includes('error:')) {
              color = '#ff7b72';
            } else if (line.includes('PASS') || line.includes('Passed') || line.includes('ready') || line.includes('Completed') || line.includes('Test Done')) {
              color = '#7ee787';
            } else if (line.includes('WARN') || line.includes('Warning') || line.includes('[roxml]') || line.includes('waiting device reconnect')) {
              color = '#e3b341';
            } else if (line.includes('[AI Worker]') || line.includes('[runner]') || line.includes('[Bridge]')) {
              color = '#79c0ff';
            } else if (line.includes('[prepare]')) {
              color = '#56d364';
            }

            return (
              <div key={idx} className="log-line" style={{ color, fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
                {line}
              </div>
            );
          })
        ) : (
          <div style={{ color: '#8b949e', textAlign: 'center', padding: '1.5rem', fontSize: '0.8125rem' }}>
            {emptyMsg}
          </div>
        )}
      </pre>
    );
  };

  const statusBadgeClass = isRunning
    ? 'badge-running'
    : isFinished
    ? 'badge-ready'
    : isFailed
    ? 'badge-fail'
    : 'badge-busy';

  const glowClass = isRunning
    ? 'glow-outline-running'
    : isFinished
    ? 'glow-outline-finished'
    : isFailed
    ? 'glow-outline-failed'
    : 'glow-outline-idle';

  const getSuiteStatus = (suiteName: 'STS' | 'CTS' | 'GTS', logs: string[]) => {
    const currentSuite = (job.suite || '').toUpperCase();
    const hasLogs = logs.length > 0;
    const isFinishedLog = logs.some(
      (l) => l.includes('tradefed finished') || l.includes('End of Results') || l.includes('All done') || l.includes('Summary')
    );

    if (isFinished || (!isRunning && hasLogs)) {
      const hasFailed = logs.some((l) => l.includes('result: ERROR') || l.includes('FAILED') || l.includes('failed with code'));
      if (hasFailed) return { text: '✕ FAILED', cls: 'badge-fail' };
      return { text: '✓ COMPLETED', cls: 'badge-ready' };
    }

    if (isRunning) {
      if (currentSuite.includes(suiteName)) {
        return { text: '⚡ RUNNING', cls: 'badge-running' };
      }
      if (hasLogs && isFinishedLog) {
        return { text: '✓ COMPLETED', cls: 'badge-ready' };
      }
      if (hasLogs) {
        return { text: '⚡ RUNNING', cls: 'badge-running' };
      }
      return { text: '⏳ ANTRI', cls: 'badge-busy' };
    }

    return null;
  };

  const stsStatus = getSuiteStatus('STS', stsLogs);
  const ctsStatus = getSuiteStatus('CTS', ctsLogs);
  const gtsStatus = getSuiteStatus('GTS', gtsLogs);

  return (
    <section className={`laundry-table-card ${glowClass}`} style={{ marginBottom: 0, borderRadius: '10px', overflow: 'hidden', transition: 'all 0.25s ease' }}>
      {/* Testrun Child Accordion Header */}
      <div
        className="laundry-table-head"
        onClick={() => setIsParentOpen(!isParentOpen)}
        style={{
          cursor: 'pointer',
          backgroundColor: 'var(--bg-subtle)',
          padding: '0.875rem 1.125rem',
          borderRadius: isParentOpen ? '10px 10px 0 0' : '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: '280px' }}>
          {/* Main Title Row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-muted)' }}>
              {isParentOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
            </span>
            <span className={`badge ${statusBadgeClass} badge-xs`} style={{ fontWeight: 700 }}>
              {isRunning ? '⚡ RUNNING' : isFinished ? '✓ FINISHED' : isFailed ? '✕ FAILED' : job.status.toUpperCase()}
            </span>
            <strong style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              WORKFLOW: {job.test_type || job.suite}
            </strong>
            {job.pcId && <span className="badge badge-pc badge-xs">{job.pcId}</span>}
            {targetModel && <span className="badge badge-pc badge-xs">{targetModel}</span>}
            {apVersion && <span className="badge badge-pc badge-xs mono-cell">{apVersion}</span>}
          </div>

          {/* Subtitle / Newline Details */}
          <div style={{ paddingLeft: '1.625rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="mono-cell" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              ({(job.devices || []).join(', ')} • {job.pcId} • {job.run_id})
            </span>
          </div>
        </div>

        {/* Right Section: Timer, Action (Cancel Flow), and Delete/Dismiss Button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <span
            className="mono-cell"
            style={{
              fontSize: '0.8125rem',
              color: isRunning ? 'var(--accent-warning, #f59e0b)' : 'var(--text-secondary)',
              fontWeight: isRunning ? 700 : 400,
              backgroundColor: 'var(--bg-card, rgba(255,255,255,0.04))',
              padding: '0.2rem 0.5rem',
              borderRadius: '4px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.08))'
            }}
          >
            ⏱ {formatDuration(job.elapsed_secs || 0)}
          </span>
          {isRunning && (
            <button
              className="btn btn-danger btn-xs"
              onClick={() => onCancelJob(job.pcId, job.run_id)}
              title="Cancel Flow"
            >
              <StopIcon size={11} />
              <span>Cancel Flow</span>
            </button>
          )}
          <button
            className="btn-icon-danger"
            onClick={() => onDismiss(job.run_id)}
            title="Tutup / Dismiss Accordion Log Run ini"
            aria-label="Dismiss Run Accordion"
          >
            <TrashIcon size={14} />
          </button>
        </div>
      </div>

      {/* Testrun Child Accordion Body */}
      {isParentOpen && (
        <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {/* 1. AI Worker & Agentic Flow Summary (Top Section) */}
          <section className="running-log-card" style={{ marginBottom: 0 }}>
            <div
              className="running-log-head"
              style={{ backgroundColor: 'rgba(56, 139, 253, 0.08)', cursor: 'pointer' }}
              onClick={() => setIsAiWorkerOpen(!isAiWorkerOpen)}
            >
              <div className="running-log-head-title">
                <span>🤖 AI WORKER & AGENTIC FLOW SUMMARY</span>
                <span className="badge badge-pc badge-xs">{aiWorkerLogs.length} Events</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="log-clear-btn"
                  onClick={() => handleClearSection('ai_worker', aiWorkerLogs.length)}
                >
                  Clear
                </button>
                <span style={{ color: 'var(--text-muted)' }}>
                  {isAiWorkerOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                </span>
              </div>
            </div>
            {isAiWorkerOpen && (
              <div className="running-log-body">
                {renderConsoleScreen(aiWorkerLogs, aiWorkerLogRef, 'ai_worker', 'Menunggu tahapan AI Worker...')}
              </div>
            )}
          </section>

          {/* 2. Individual Suite Accordions Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            {/* Child 1: STS Tradefed Runner */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div
                className="running-log-head"
                style={{ backgroundColor: 'var(--bg-subtle)', cursor: 'pointer' }}
                onClick={() => setIsStsOpen(!isStsOpen)}
              >
                <div className="running-log-head-title">
                  <span>🛡️ STS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{stsLogs.length} Lines</span>
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
                  >
                    Clear
                  </button>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {isStsOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                  </span>
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
                  <span>🧪 CTS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{ctsLogs.length} Lines</span>
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
                  >
                    Clear
                  </button>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {isCtsOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                  </span>
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
                  <span>⚡ GTS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{gtsLogs.length} Lines</span>
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
                  >
                    Clear
                  </button>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {isGtsOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                  </span>
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

  const activeElapsed = useMemo(() => {
    const activeJobsList = displayRuns.filter((j) => j.status === 'Running' || j.status === 'Starting');
    if (activeJobsList.length === 0) return 0;
    return Math.max(...activeJobsList.map((j) => j.elapsed_secs || 0));
  }, [displayRuns]);

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
            <span style={{ fontSize: '1.2rem' }}>⚡</span>
            <span style={{ fontSize: '0.9375rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '0.01em' }}>
              WORKFLOW RUNS & LOGS
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
            {activeCount > 0 && (
              <span className="badge badge-running badge-xs" style={{ fontWeight: 700 }}>
                ⚡ {activeCount} Aktif Berjalan
              </span>
            )}
            {finishedCount > 0 && (
              <span className="badge badge-ready badge-xs">
                ✓ {finishedCount} Selesai
              </span>
            )}
            <span className="badge badge-neutral badge-xs">
              {displayRuns.length} Total Run
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }} onClick={(e) => e.stopPropagation()}>
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
              ⏱ {formatDuration(activeElapsed)}
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
          <span style={{ color: 'var(--text-muted)' }}>
            {isMasterOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
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


