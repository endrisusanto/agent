import React, { useState, useEffect, useRef } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { CloseIcon, StopIcon, TerminalIcon, RefreshIcon } from './Icons';

interface TerminalLogsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeJobs: ActiveJobItem[];
  jobHistory: ActiveJobItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
  selectedRunId?: string;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const TerminalLogsModal: React.FC<TerminalLogsModalProps> = ({
  isOpen,
  onClose,
  activeJobs,
  jobHistory,
  onCancelJob,
  selectedRunId,
}) => {
  const allRuns = [...activeJobs, ...jobHistory];
  const [currentRunId, setCurrentRunId] = useState<string>(
    selectedRunId || activeJobs[0]?.run_id || jobHistory[0]?.run_id || ''
  );
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Sync active run ID when new runs appear or when selectedRunId changes
  useEffect(() => {
    if (selectedRunId) {
      setCurrentRunId(selectedRunId);
    } else if (activeJobs.length > 0 && !activeJobs.some((j) => j.run_id === currentRunId)) {
      setCurrentRunId(activeJobs[0].run_id);
    } else if (!currentRunId && allRuns.length > 0) {
      setCurrentRunId(allRuns[0].run_id);
    }
  }, [activeJobs, selectedRunId, allRuns.length]);

  const activeJob = allRuns.find((j) => j.run_id === currentRunId) || allRuns[0];
  const isRunning = activeJobs.some((j) => j.run_id === activeJob?.run_id);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [activeJob?.recentLogs?.length, autoScroll]);

  if (!isOpen) return null;

  const handleCopyLogs = () => {
    if (Array.isArray(activeJob?.recentLogs) && activeJob.recentLogs.length > 0) {
      navigator.clipboard.writeText(activeJob.recentLogs.join('\n'));
      alert('Logs disalin ke clipboard.');
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal-dialog"
        style={{ maxWidth: '980px', height: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Terminal Header */}
        <div className="modal-header" style={{ padding: '0.875rem 1.25rem', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 700, fontSize: '1rem' }}>
              <TerminalIcon size={18} />
              <span>Live Terminal Runs</span>
            </div>

            {allRuns.length > 1 && (
              <select
                className="filter-select"
                style={{ height: '32px', fontSize: '0.75rem', padding: '0 1.75rem 0 0.6rem' }}
                value={activeJob?.run_id || ''}
                onChange={(e) => setCurrentRunId(e.target.value)}
              >
                {allRuns.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    [{r.pcId}] {r.test_type} - {r.suite || r.run_id} ({activeJobs.some((j) => j.run_id === r.run_id) ? 'Running' : r.status})
                  </option>
                ))}
              </select>
            )}

            {activeJob && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span className={`badge ${isRunning ? 'badge-running' : activeJob.status === 'Finished' ? 'badge-pass' : 'badge-fail'} badge-xs`}>
                  {isRunning ? 'RUNNING' : activeJob.status.toUpperCase()}
                </span>
                <span className="mono-cell" style={{ fontSize: '0.75rem' }}>
                  ⏱ {formatDuration(activeJob.elapsed_secs || 0)}
                </span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {activeJob && isRunning && (
              <button
                className="btn btn-danger btn-xs"
                onClick={() => onCancelJob(activeJob.pcId, activeJob.run_id)}
                title="Batalkan Eksekusi Suite"
              >
                <StopIcon size={12} />
                <span>Cancel Run</span>
              </button>
            )}

            <button
              className="btn btn-secondary btn-xs"
              onClick={handleCopyLogs}
              title="Copy All Logs"
            >
              Copy Logs
            </button>

            <button
              className="btn btn-secondary btn-xs"
              onClick={() => setAutoScroll(!autoScroll)}
              style={{ color: autoScroll ? 'var(--status-ready-text)' : 'var(--text-muted)' }}
              title="Toggle Auto-Scroll"
            >
              {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
            </button>

            <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.3rem' }} title="Tutup">
              <CloseIcon size={16} />
            </button>
          </div>
        </div>

        {/* Terminal Info Bar */}
        {activeJob && (
          <div
            style={{
              padding: '0.5rem 1.25rem',
              backgroundColor: 'var(--bg-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: '0.75rem',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.5rem',
            }}
          >
            <div>
              <strong>Node PC:</strong> <span className="mono">{activeJob.pcId}</span> • <strong>Suite:</strong> {activeJob.test_type} ({activeJob.suite}) • <strong>Devices:</strong> <span className="mono">{Array.isArray(activeJob.devices) ? activeJob.devices.join(', ') : (activeJob.devices || 'Auto')}</span>
            </div>
            {activeJob.summary && (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <span>Total: <strong>{activeJob.summary.total}</strong></span>
                <span style={{ color: 'var(--status-ready-text)' }}>Passed: <strong>{activeJob.summary.passed}</strong></span>
                <span style={{ color: activeJob.summary.failed > 0 ? 'var(--status-fail-text)' : 'inherit' }}>Failed: <strong>{activeJob.summary.failed}</strong></span>
              </div>
            )}
          </div>
        )}

        {/* Terminal Log Output Window */}
        <div
          ref={logContainerRef}
          style={{
            flex: 1,
            backgroundColor: '#0d1117',
            color: '#e6edf3',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8125rem',
            lineHeight: 1.6,
            padding: '1rem 1.25rem',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {activeJob?.recentLogs && activeJob.recentLogs.length > 0 ? (
            activeJob.recentLogs.map((line, idx) => {
              let color = '#c9d1d9';
              if (line.includes('ERROR') || line.includes('FAIL') || line.includes('Exception') || line.includes('Failed')) {
                color = '#ff7b72';
              } else if (line.includes('PASS') || line.includes('Passed') || line.includes('Done') || line.includes('Finished')) {
                color = '#7ee787';
              } else if (line.includes('WARN') || line.includes('Warning')) {
                color = '#d29922';
              } else if (line.includes('[Bridge]') || line.includes('[Hub]')) {
                color = '#79c0ff';
              }
              return (
                <div key={idx} style={{ color }}>
                  {line}
                </div>
              );
            })
          ) : (
            <div style={{ color: '#8b949e', textAlign: 'center', padding: '3rem' }}>
              {isRunning ? '⏳ Menunggu stream log Tradefed dari bridge node...' : 'Belum ada log stream pada session ini.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
