import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon, TerminalIcon } from './Icons';

interface RunningWorkflowAccordionProps {
  activeJobs: ActiveJobItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const RunningWorkflowAccordion: React.FC<RunningWorkflowAccordionProps> = ({
  activeJobs,
  onCancelJob,
}) => {
  // Accordion open/close states
  const [isGlobalOpen, setIsGlobalOpen] = useState<boolean>(true);
  const [isAiWorkerOpen, setIsAiWorkerOpen] = useState<boolean>(true);
  const [isCtsOpen, setIsCtsOpen] = useState<boolean>(false);
  const [isGtsOpen, setIsGtsOpen] = useState<boolean>(false);
  const [isStsOpen, setIsStsOpen] = useState<boolean>(false);

  const [clearedLogs, setClearedLogs] = useState<Record<string, number>>({});
  const globalLogRef = useRef<HTMLPreElement>(null);
  const aiWorkerLogRef = useRef<HTMLPreElement>(null);
  const ctsLogRef = useRef<HTMLPreElement>(null);
  const gtsLogRef = useRef<HTMLPreElement>(null);
  const stsLogRef = useRef<HTMLPreElement>(null);

  // Collect all raw log lines from all active jobs
  const allRawLogs: string[] = useMemo(() => {
    const list: string[] = [];
    (activeJobs || []).forEach((j) => {
      if (Array.isArray(j.recentLogs)) {
        list.push(...j.recentLogs);
      }
    });
    return list;
  }, [activeJobs]);

  // AI Worker Logs
  const aiWorkerLogs = useMemo(() => {
    return allRawLogs.filter((l) => {
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
  }, [allRawLogs]);

  // CTS Logs
  const ctsLogs = useMemo(() => {
    return allRawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[cts]') || lower.includes('cts-tradefed') || lower.includes('cts-smr') || lower.includes('cts-sku');
    });
  }, [allRawLogs]);

  // GTS Logs
  const gtsLogs = useMemo(() => {
    return allRawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[gts]') || lower.includes('gts-tradefed') || lower.includes('gts_main') || lower.includes('gtsmr');
    });
  }, [allRawLogs]);

  // STS Logs
  const stsLogs = useMemo(() => {
    return allRawLogs.filter((l) => {
      if (typeof l !== 'string') return false;
      const lower = l.toLowerCase();
      return lower.includes('[sts]') || lower.includes('sts-tradefed') || lower.includes('sts-dynamic-plan');
    });
  }, [allRawLogs]);

  // Auto-scroll effect
  useEffect(() => {
    if (globalLogRef.current) globalLogRef.current.scrollTop = globalLogRef.current.scrollHeight;
    if (aiWorkerLogRef.current) aiWorkerLogRef.current.scrollTop = aiWorkerLogRef.current.scrollHeight;
    if (ctsLogRef.current) ctsLogRef.current.scrollTop = ctsLogRef.current.scrollHeight;
    if (gtsLogRef.current) gtsLogRef.current.scrollTop = gtsLogRef.current.scrollHeight;
    if (stsLogRef.current) stsLogRef.current.scrollTop = stsLogRef.current.scrollHeight;
  }, [allRawLogs.length]);

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
          <div style={{ color: '#8b949e', textAlign: 'center', padding: '2rem' }}>
            {emptyMsg}
          </div>
        )}
      </pre>
    );
  };

  // Do not render anything if no active jobs
  if (!activeJobs || activeJobs.length === 0) {
    return null;
  }

  const primaryJob = activeJobs[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginBottom: '1.25rem' }}>
      {/* 1. Global Terminal (RUNNING LOG) */}
      <section className="running-log-card">
        <div className="running-log-head" onClick={() => setIsGlobalOpen(!isGlobalOpen)}>
          <div className="running-log-head-title">
            <TerminalIcon size={16} />
            <span>GLOBAL RUNNING LOG</span>
            <span className="badge badge-running badge-xs">
              {activeJobs.length} Active Run{activeJobs.length > 1 ? 's' : ''}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }} onClick={(e) => e.stopPropagation()}>
            {primaryJob && (
              <>
                <span className="mono-cell" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  ⏱ {formatDuration(primaryJob.elapsed_secs || 0)}
                </span>
                <button
                  className="btn btn-danger btn-xs"
                  onClick={() => onCancelJob(primaryJob.pcId, primaryJob.run_id)}
                  title="Cancel Run"
                >
                  <StopIcon size={11} />
                  <span>Cancel Flow</span>
                </button>
              </>
            )}
            <button
              className="log-clear-btn"
              onClick={() => handleClearSection('global', allRawLogs.length)}
              title="Clear Global Log"
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
            {renderConsoleScreen(allRawLogs, globalLogRef, 'global', '⏳ Menunggu aliran log terminal...')}
          </div>
        )}
      </section>

      {/* 2. Individual Child Accordions Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
        {/* Child Accordion 1: AI Worker */}
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

        {/* Child Accordion 2: CTS */}
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

        {/* Child Accordion 3: GTS */}
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

        {/* Child Accordion 4: STS */}
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
  );
};
