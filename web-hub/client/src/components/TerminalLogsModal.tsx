import React, { useState, useEffect, useRef } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { CloseIcon, StopIcon, CopyIcon, AutoScrollIcon } from './Icons';
import { formatDurationHms } from '../utils/formatters';

interface TerminalLogsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeJobs: ActiveJobItem[];
  jobHistory: ActiveJobItem[];
  onCancelJob: (pcId: string, run_id: string) => void;
  selectedRunId?: string;
  onSelectRunId?: (runId: string) => void;
}

export const TerminalLogsModal: React.FC<TerminalLogsModalProps> = ({
  isOpen,
  onClose,
  activeJobs,
  jobHistory,
  onCancelJob,
  selectedRunId,
  onSelectRunId,
}) => {
  const allRuns = [...activeJobs, ...jobHistory];
  const [internalRunId, setInternalRunId] = useState<string>(
    selectedRunId || activeJobs[0]?.run_id || jobHistory[0]?.run_id || ''
  );
  const currentRunId = selectedRunId !== undefined && selectedRunId !== '' ? selectedRunId : internalRunId;
  const setRunId = (id: string) => {
    setInternalRunId(id);
    if (onSelectRunId) onSelectRunId(id);
  };
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Sync active run ID when new runs appear or when selectedRunId changes
  useEffect(() => {
    if (selectedRunId) {
      setInternalRunId(selectedRunId);
    } else if (activeJobs.length > 0 && !activeJobs.some((j) => j.run_id === currentRunId)) {
      setRunId(activeJobs[0].run_id);
    } else if (!currentRunId && allRuns.length > 0) {
      setRunId(allRuns[0].run_id);
    }
  }, [activeJobs, selectedRunId, allRuns.length]);

  const activeJob = allRuns.find((j) => j.run_id === currentRunId) || allRuns[0];
  const isRunning = activeJobs.some((j) => j.run_id === activeJob?.run_id);

  const [, setModalTick] = useState(0);
  useEffect(() => {
    if (!isOpen || !isRunning) return;
    const interval = setInterval(() => setModalTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isOpen, isRunning]);

  const activeElapsed = (isRunning && activeJob?.startedAt)
    ? Math.max(0, Math.floor((Date.now() - activeJob.startedAt) / 1000))
    : (activeJob?.elapsed_secs || 0);

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

  const devicesText = Array.isArray(activeJob?.devices)
    ? activeJob.devices.join(', ')
    : (activeJob?.devices || '');

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal-dialog"
        style={{ maxWidth: '980px', height: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Terminal Header */}
        <div className="modal-header terminal-modal-header">
          <div className="terminal-header-left">
            {allRuns.length > 0 && (
              <div className="terminal-select-wrap">
                <select
                  className="filter-select terminal-run-select"
                  value={currentRunId}
                  onChange={(e) => setRunId(e.target.value)}
                  aria-label="Pilih Sesi Log Terminal"
                >
                  {allRuns.map((run) => {
                    const isRunActive = activeJobs.some((j) => j.run_id === run.run_id);
                    const devStr = Array.isArray(run.devices) ? run.devices.join(', ') : (run.devices || '');
                    const label = `[${isRunActive ? 'RUNNING' : (run.status || 'FINISHED').toUpperCase()}] ${run.test_type || run.suite || 'Workflow'} · ${run.pcId || 'Node'} (${devStr || run.run_id})`;
                    return (
                      <option key={run.run_id} value={run.run_id}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {activeJob && (
              <div className="terminal-status-wrap">
                <span className={`badge ${isRunning ? 'badge-running' : activeJob.status === 'Finished' ? 'badge-pass' : 'badge-fail'} badge-xs`}>
                  {isRunning ? 'RUNNING' : activeJob.status.toUpperCase()}
                </span>
                <span className="mono-cell terminal-timer">
                  ⏱ {formatDurationHms(activeElapsed)}
                </span>
              </div>
            )}
          </div>

          <div className="terminal-header-actions">
            {activeJob && isRunning && (
              <button
                className="btn-icon-danger"
                onClick={() => onCancelJob(activeJob.pcId, activeJob.run_id)}
                title="Batalkan Eksekusi Suite"
                aria-label="Cancel Run"
              >
                <StopIcon size={13} />
              </button>
            )}

            <button
              className="btn-icon"
              onClick={handleCopyLogs}
              title="Copy All Logs"
              aria-label="Copy Logs"
            >
              <CopyIcon size={14} />
            </button>

            <button
              className={`btn-icon ${autoScroll ? 'btn-icon-active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
              aria-label="Toggle Auto Scroll"
            >
              <AutoScrollIcon size={14} />
            </button>

            <button
              className="btn-icon terminal-close-btn"
              onClick={onClose}
              title="Tutup"
              aria-label="Close"
            >
              <CloseIcon size={15} />
            </button>
          </div>
        </div>

        {/* Terminal Info Bar */}
        {activeJob && (
          <div className="terminal-info-bar">
            <div className="terminal-meta-chips">
              {activeJob.pcId && (
                <span className="badge badge-pc" title="PC Node">{activeJob.pcId}</span>
              )}
              {activeJob.test_type && (
                <span className="badge badge-unit" title="Suite">{activeJob.test_type}</span>
              )}
              {devicesText && (
                <span className="badge badge-pc mono-cell" title="Devices">{devicesText}</span>
              )}
            </div>

            {activeJob.summary && (
              <div className="terminal-stats-chips">
                <span className="badge badge-neutral mono-cell">
                  TOTAL: <strong>{activeJob.summary.total}</strong>
                </span>
                <span className="badge badge-pass mono-cell">
                  PASS: <strong>{activeJob.summary.passed}</strong>
                </span>
                <span className={`badge ${activeJob.summary.failed > 0 ? 'badge-fail' : 'badge-fail-zero'} mono-cell`}>
                  FAIL: <strong>{activeJob.summary.failed}</strong>
                </span>
              </div>
            )}
          </div>
        )}

        {/* Terminal Log Output Window */}
        <div
          ref={logContainerRef}
          className="log-console-box"
          style={{
            flex: 1,
            maxHeight: 'none',
            minHeight: '260px',
            fontSize: '0.6875rem',
            lineHeight: 1.4,
            padding: '0.75rem 1rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
          }}
        >
          {activeJob?.recentLogs && activeJob.recentLogs.length > 0 ? (
            activeJob.recentLogs.map((line, idx) => {
              let logClass = '';
              if (line.includes('ERROR') || line.includes('FAIL') || line.includes('Exception') || line.includes('Failed')) {
                logClass = 'log-fail';
              } else if (line.includes('PASS') || line.includes('Passed') || line.includes('Done') || line.includes('Finished')) {
                logClass = 'log-pass';
              } else if (line.includes('WARN') || line.includes('Warning')) {
                logClass = 'log-warn';
              } else if (line.includes('[Bridge]') || line.includes('[Hub]') || line.includes('[AI Worker]')) {
                logClass = 'log-info';
              }
              return (
                <div key={idx} className={`log-line ${logClass}`}>
                  {line}
                </div>
              );
            })
          ) : (
            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '3rem', fontSize: '0.75rem' }}>
              {isRunning ? '⏳ Menunggu stream log Tradefed dari bridge node...' : 'Belum ada log stream pada session ini.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
