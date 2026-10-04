import React, { useState } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { StopIcon } from './Icons';

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
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  if (activeJobs.length === 0) return null;

  return (
    <section className="card-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Active Test Suite Runs</span>
          <span className="badge badge-running">{activeJobs.length} Running</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem' }}>
        {activeJobs.map((job) => {
          const isExpanded = expandedJobId === job.run_id;
          return (
            <div
              key={job.run_id}
              style={{
                backgroundColor: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '0.875rem 1rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
                onClick={() => setExpandedJobId(isExpanded ? null : job.run_id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span className="badge badge-pc">{job.pcId}</span>
                  <span className="badge badge-running">{job.test_type}</span>
                  <strong>{job.suite || 'Running...'}</strong>
                  <span className="mono-cell" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    Devices: {job.devices.join(', ')}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span className="mono-cell" style={{ fontSize: '0.8125rem' }}>
                    ⏱ {formatDuration(job.elapsed_secs)}
                  </span>

                  <button
                    className="btn btn-danger"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCancelJob(job.pcId, job.run_id);
                    }}
                    title="Cancel Active Run"
                  >
                    <StopIcon size={12} />
                    <span>Cancel</span>
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div style={{ padding: '0 1rem 1rem 1rem' }}>
                  <div className="log-drawer">
                    {job.recentLogs && job.recentLogs.length > 0 ? (
                      job.recentLogs.map((line, idx) => (
                        <div key={idx} className="log-line">
                          {line}
                        </div>
                      ))
                    ) : (
                      <div style={{ color: 'var(--text-secondary)' }}>Waiting for log stream...</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
