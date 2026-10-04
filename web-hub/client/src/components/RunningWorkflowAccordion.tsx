import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem, DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon, TerminalIcon } from './Icons';

interface RunningWorkflowAccordionProps {
  activeJobs: ActiveJobItem[];
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
}> = ({ job, devices, onCancelJob }) => {
  const [isParentOpen, setIsParentOpen] = useState<boolean>(true);
  const [isGlobalOpen, setIsGlobalOpen] = useState<boolean>(true);
  const [isAiWorkerOpen, setIsAiWorkerOpen] = useState<boolean>(false);
  const [isCtsOpen, setIsCtsOpen] = useState<boolean>(false);
  const [isGtsOpen, setIsGtsOpen] = useState<boolean>(false);
  const [isStsOpen, setIsStsOpen] = useState<boolean>(false);

  const [clearedLogs, setClearedLogs] = useState<Record<string, number>>({});
  const globalLogRef = useRef<HTMLPreElement>(null);
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

  // AI Worker Logs
  const aiWorkerLogs = useMemo(() => {
    return rawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return (
        lower.includes('[ai worker]') ||
        lower.includes('[runner]') ||
        lower.includes('[bridge]') ||
        lower.includes('[roxml]') ||
        lower.includes('[prepare]') ||
        lower.includes('[hub]')
      );
    });
  }, [rawLogs]);

  // CTS Logs
  const ctsLogs = useMemo(() => {
    return rawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[cts]') || lower.includes('cts-tradefed') || lower.includes('cts-smr') || lower.includes('cts-sku');
    });
  }, [rawLogs]);

  // GTS Logs
  const gtsLogs = useMemo(() => {
    return rawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[gts]') || lower.includes('gts-tradefed') || lower.includes('gts_main') || lower.includes('gtsmr');
    });
  }, [rawLogs]);

  // STS Logs
  const stsLogs = useMemo(() => {
    return rawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[sts]') || lower.includes('sts-tradefed') || lower.includes('sts-dynamic-plan');
    });
  }, [rawLogs]);

  // Auto-scroll
  useEffect(() => {
    if (globalLogRef.current) globalLogRef.current.scrollTop = globalLogRef.current.scrollHeight;
    if (aiWorkerLogRef.current) aiWorkerLogRef.current.scrollTop = aiWorkerLogRef.current.scrollHeight;
    if (ctsLogRef.current) ctsLogRef.current.scrollTop = ctsLogRef.current.scrollHeight;
    if (gtsLogRef.current) gtsLogRef.current.scrollTop = gtsLogRef.current.scrollHeight;
    if (stsLogRef.current) stsLogRef.current.scrollTop = stsLogRef.current.scrollHeight;
  }, [rawLogs.length]);

  const handleClearSection = (key: string, length: number) => {
    setClearedLogs((prev) => ({ ...prev, [key]: length }));
  };

  const renderConsoleScreen = (
    logs: string[],
    ref: React.RefObject<HTMLPreElement>,
    sectionKey: string,
    emptyMsg: string
  ) => {
    const offset = clearedLogs[sectionKey] || 0;
    const visibleLines = logs.slice(offset);

    return (
      <pre ref={ref} className="log-console-box">
        {visibleLines.length > 0 ? (
          visibleLines.map((line, idx) => {
            let color = '#f0f6fc';
            if (line.includes('ERROR') || line.includes('FAIL') || line.includes('Failed') || line.includes('Exception')) {
              color = '#ff7b72';
            } else if (line.includes('PASS') || line.includes('Passed') || line.includes('ready') || line.includes('Completed')) {
              color = '#7ee787';
            } else if (line.includes('WARN') || line.includes('Warning') || line.includes('[roxml]')) {
              color = '#e3b341';
            } else if (line.includes('[AI Worker]') || line.includes('[runner]') || line.includes('[Bridge]')) {
              color = '#79c0ff';
            } else if (line.includes('[CTS]') || line.includes('[GTS]') || line.includes('[STS]')) {
              color = '#d2a8ff';
            } else if (line.includes('[prepare]')) {
              color = '#56d364';
            }

            return (
              <div key={idx} className="log-line" style={{ color }}>
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

  return (
    <section className="laundry-table-card" style={{ marginBottom: '1rem', border: '1px solid var(--accent-primary)' }}>
      {/* Parent Accordion Header (Model + AP Version + Status) */}
      <div
        className="laundry-table-head"
        onClick={() => setIsParentOpen(!isParentOpen)}
        style={{ cursor: 'pointer', backgroundColor: 'var(--bg-subtle)', padding: '0.875rem 1rem' }}
      >
        <div className="laundry-table-head-left" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {isParentOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
          </span>
          <strong style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            WORKFLOW BERJALAN: {job.test_type || job.suite}
          </strong>
          <span className="badge badge-running badge-xs">{targetModel}</span>
          <span className="badge badge-pc badge-xs mono-cell">{apVersion}</span>
          <span className={`badge ${isUserdebug ? 'badge-userdebug' : 'badge-user'} badge-xs`}>
            {isUserdebug ? 'USERDEBUG' : 'USER'}
          </span>
          <span className="mono-cell" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            ({(job.devices || []).join(', ')} • {job.pcId})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }} onClick={(e) => e.stopPropagation()}>
          <span className="mono-cell" style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            ⏱ {formatDuration(job.elapsed_secs || 0)}
          </span>
          <button
            className="btn btn-danger btn-xs"
            onClick={() => onCancelJob(job.pcId, job.run_id)}
            title="Cancel Flow"
          >
            <StopIcon size={11} />
            <span>Cancel Flow</span>
          </button>
        </div>
      </div>

      {/* Parent Accordion Body */}
      {isParentOpen && (
        <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {/* 1. Global Terminal for this workflow */}
          <section className="running-log-card" style={{ marginBottom: 0 }}>
            <div className="running-log-head" onClick={() => setIsGlobalOpen(!isGlobalOpen)}>
              <div className="running-log-head-title">
                <TerminalIcon size={16} />
                <span>GLOBAL RUNNING LOG</span>
                <span className="badge badge-running badge-xs">{rawLogs.length} Lines</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }} onClick={(e) => e.stopPropagation()}>
                <button
                  className="log-clear-btn"
                  onClick={() => handleClearSection('global', rawLogs.length)}
                  title="Clear Log"
                >
                  Clear Log
                </button>
                <span style={{ color: 'var(--text-muted)' }}>
                  {isGlobalOpen ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                </span>
              </div>
            </div>

            {isGlobalOpen && (
              <div className="running-log-body">
                {renderConsoleScreen(rawLogs, globalLogRef, 'global', '⏳ Menunggu aliran log terminal...')}
              </div>
            )}
          </section>

          {/* 2. Individual Child Accordions Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {/* Child 1: AI Worker */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div className="running-log-head" style={{ backgroundColor: 'var(--bg-subtle)' }} onClick={() => setIsAiWorkerOpen(!isAiWorkerOpen)}>
                <div className="running-log-head-title">
                  <span>🤖 AI WORKER & ORCHESTRATION</span>
                  <span className="badge badge-pc badge-xs">{aiWorkerLogs.length} Lines</span>
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
                  {renderConsoleScreen(aiWorkerLogs, aiWorkerLogRef, 'ai_worker', 'Belum ada log dari AI Worker / Device Preparation.')}
                </div>
              )}
            </section>

            {/* Child 2: CTS */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div className="running-log-head" style={{ backgroundColor: 'var(--bg-subtle)' }} onClick={() => setIsCtsOpen(!isCtsOpen)}>
                <div className="running-log-head-title">
                  <span>🧪 CTS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{ctsLogs.length} Lines</span>
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
                  {renderConsoleScreen(ctsLogs, ctsLogRef, 'cts', 'Belum ada aktivitas eksekusi CTS suite.')}
                </div>
              )}
            </section>

            {/* Child 3: GTS */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div className="running-log-head" style={{ backgroundColor: 'var(--bg-subtle)' }} onClick={() => setIsGtsOpen(!isGtsOpen)}>
                <div className="running-log-head-title">
                  <span>⚡ GTS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{gtsLogs.length} Lines</span>
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
                  {renderConsoleScreen(gtsLogs, gtsLogRef, 'gts', 'Belum ada aktivitas eksekusi GTS suite.')}
                </div>
              )}
            </section>

            {/* Child 4: STS */}
            <section className="running-log-card" style={{ marginBottom: 0 }}>
              <div className="running-log-head" style={{ backgroundColor: 'var(--bg-subtle)' }} onClick={() => setIsStsOpen(!isStsOpen)}>
                <div className="running-log-head-title">
                  <span>🛡️ STS TRADEFED RUNNER</span>
                  <span className="badge badge-unit badge-xs">{stsLogs.length} Lines</span>
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
                  {renderConsoleScreen(stsLogs, stsLogRef, 'sts', 'Belum ada aktivitas eksekusi STS suite.')}
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
  devices,
  onCancelJob,
}) => {
  if (!activeJobs || activeJobs.length === 0) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginBottom: '1.25rem' }}>
      {activeJobs.map((job) => (
        <SingleWorkflowRunner
          key={job.run_id}
          job={job}
          devices={devices}
          onCancelJob={onCancelJob}
        />
      ))}
    </div>
  );
};

