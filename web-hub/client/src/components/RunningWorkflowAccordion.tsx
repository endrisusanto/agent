import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem, DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon } from './Icons';

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
  const [isAiWorkerOpen, setIsAiWorkerOpen] = useState<boolean>(true);
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

  // CTS Logs (Filter strictly for CTS lines)
  const ctsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        return l.startsWith('[CTS]') || l.includes('cts-tradefed') || l.includes('cts-console') || l.includes('cts-smr') || l.includes('cts-sku');
      })
      .map((l) => (l.startsWith('[CTS] ') ? l.substring(6) : l.startsWith('[CTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // GTS Logs (Filter strictly for GTS lines)
  const gtsLogs = useMemo(() => {
    return rawLogs
      .filter((l) => {
        if (typeof l !== 'string') return false;
        return l.startsWith('[GTS]') || l.includes('gts-tradefed') || l.includes('gts-console') || l.includes('gts_main') || l.includes('gtsmr');
      })
      .map((l) => (l.startsWith('[GTS] ') ? l.substring(6) : l.startsWith('[GTS]') ? l.substring(5) : l));
  }, [rawLogs]);

  // STS Logs (Filter strictly for STS lines)
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

  return (
    <section className="laundry-table-card" style={{ marginBottom: '1rem', border: '1px solid var(--accent-primary)', borderRadius: '8px' }}>
      {/* Parent Accordion Header (Model + AP Version + Status) */}
      <div
        className="laundry-table-head"
        onClick={() => setIsParentOpen(!isParentOpen)}
        style={{ cursor: 'pointer', backgroundColor: 'var(--bg-subtle)', padding: '0.875rem 1rem', borderTopLeftRadius: '8px', borderTopRightRadius: '8px' }}
      >
        <div className="laundry-table-head-left" style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {isParentOpen ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
          </span>
          <strong style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            WORKFLOW: {job.test_type || job.suite}
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
          {/* 0. Ready Result ZIPs Download Banner */}
          {availableZips.length > 0 && (
            <div
              style={{
                backgroundColor: 'rgba(56, 139, 253, 0.1)',
                border: '1px solid rgba(56, 139, 253, 0.4)',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.625rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1.125rem' }}>📦</span>
                <div>
                  <strong style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                    Hasil Test Suite Siap Diunduh ({availableZips.length} ZIP):
                  </strong>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    File zip hasil retry Tradefed tersimpan di direktori Results
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                {availableZips.map((zipName) => (
                  <a
                    key={zipName}
                    href={`/api/results/download?run_id=${encodeURIComponent(job.run_id)}&file=${encodeURIComponent(zipName)}`}
                    download={zipName}
                    className="btn btn-success btn-xs"
                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}
                    title={`Download ${zipName}`}
                  >
                    <span>💾</span>
                    <span className="mono-cell">{zipName}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

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
                  {stsLogs.length > 0 && <span className="badge badge-running badge-xs">ACTIVE</span>}
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
                  {ctsLogs.length > 0 && <span className="badge badge-running badge-xs">ACTIVE</span>}
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
                  {gtsLogs.length > 0 && <span className="badge badge-running badge-xs">ACTIVE</span>}
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
