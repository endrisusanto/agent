import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, StopIcon } from './Icons';

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
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [selectedTabId, setSelectedTabId] = useState<string>('running-all');
  const [activeSubtab, setActiveSubtab] = useState<string>('ALL');
  const [closedTabIds, setClosedTabIds] = useState<string[]>([]);
  const [clearedRunLogs, setClearedRunLogs] = useState<Record<string, number>>({});
  const logBoxRef = useRef<HTMLPreElement>(null);

  // Filter visible tabs
  const visibleJobs = useMemo(() => {
    return activeJobs.filter((job) => !closedTabIds.includes(job.run_id));
  }, [activeJobs, closedTabIds]);

  // Sync selected tab if previous one disappeared or on initial load
  useEffect(() => {
    if (selectedTabId === 'running-all') return;
    if (!visibleJobs.some((j) => j.run_id === selectedTabId)) {
      if (visibleJobs.length > 0) {
        setSelectedTabId(visibleJobs[0].run_id);
      } else {
        setSelectedTabId('running-all');
      }
    }
  }, [visibleJobs, selectedTabId]);

  if (activeJobs.length === 0) return null;

  const currentJob = activeJobs.find((j) => j.run_id === selectedTabId);

  // Extract raw log lines for current view
  const rawLogs: string[] = useMemo(() => {
    if (selectedTabId === 'running-all') {
      const all: string[] = [];
      activeJobs.forEach((j) => {
        const offset = clearedRunLogs[j.run_id] || 0;
        const slice = (j.recentLogs || []).slice(offset);
        all.push(...slice);
      });
      return all;
    }
    if (currentJob) {
      const offset = clearedRunLogs[currentJob.run_id] || 0;
      return (currentJob.recentLogs || []).slice(offset);
    }
    return [];
  }, [selectedTabId, activeJobs, currentJob, clearedRunLogs]);

  // Extract available subtab tags (e.g. AI Worker, CTS, GTS, STS, prepare, roxml, etc.)
  const availableSubtabs = useMemo(() => {
    const tags = new Set<string>();
    tags.add('ALL');

    const knownTags = ['AI Worker', 'CTS', 'GTS', 'STS', 'prepare', 'roxml', 'runner', 'Bridge'];
    knownTags.forEach((t) => {
      if (rawLogs.some((l) => l.toLowerCase().includes(`[${t.toLowerCase()}]`))) {
        tags.add(t);
      }
    });

    // Also look for dynamic bracketed tags like [TAG]
    rawLogs.forEach((line) => {
      const match = line.match(/\[([A-Za-z0-9_-]{2,15})\]/);
      if (match && match[1]) {
        const tagName = match[1];
        if (!['time', 'date', 'log', 'stdout', 'stderr'].includes(tagName.toLowerCase())) {
          tags.add(tagName);
        }
      }
    });

    return Array.from(tags);
  }, [rawLogs]);

  // Filter logs by subtab
  const filteredLogs = useMemo(() => {
    if (activeSubtab === 'ALL') return rawLogs;
    const pattern = `[${activeSubtab.toLowerCase()}]`;
    return rawLogs.filter((l) => l.toLowerCase().includes(pattern));
  }, [rawLogs, activeSubtab]);

  // Auto-scroll to bottom of logBox
  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [filteredLogs.length]);

  const handleClearLog = () => {
    if (selectedTabId === 'running-all') {
      const nextClear: Record<string, number> = {};
      activeJobs.forEach((j) => {
        nextClear[j.run_id] = j.recentLogs?.length || 0;
      });
      setClearedRunLogs(nextClear);
    } else if (currentJob) {
      setClearedRunLogs((prev) => ({
        ...prev,
        [currentJob.run_id]: currentJob.recentLogs?.length || 0,
      }));
    }
  };

  const handleCloseTab = (e: React.MouseEvent, runId: string) => {
    e.stopPropagation();
    setClosedTabIds((prev) => [...prev, runId]);
    if (selectedTabId === runId) {
      const remaining = visibleJobs.filter((j) => j.run_id !== runId);
      setSelectedTabId(remaining.length > 0 ? remaining[0].run_id : 'running-all');
    }
  };

  return (
    <section className="running-log-card">
      {/* Header */}
      <div className="running-log-head" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="running-log-head-title">
          {isExpanded ? <ChevronDownIcon size={14} /> : <ChevronUpIcon size={14} />}
          <span>CONSOLE LOG</span>
          <span className="badge badge-running badge-xs">
            {activeJobs.length} Active Run{activeJobs.length > 1 ? 's' : ''}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }} onClick={(e) => e.stopPropagation()}>
          {currentJob && (
            <>
              <span className="mono-cell" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                ⏱ {formatDuration(currentJob.elapsed_secs)}
              </span>
              <button
                className="btn btn-danger btn-xs"
                onClick={() => onCancelJob(currentJob.pcId, currentJob.run_id)}
                title="Cancel Selected Run"
              >
                <StopIcon size={11} />
                <span>Cancel Flow</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Accordion Body */}
      {isExpanded && (
        <div className="running-log-body">
          <div className="log-tab-stack">
            {/* Row 1: Flow Tabs */}
            <div className="log-tabs-row">
              <div className="log-flow-tabs">
                {visibleJobs.map((job) => {
                  const isActive = selectedTabId === job.run_id;
                  const devText = Array.isArray(job.devices) ? job.devices.join(', ') : (job.devices || 'Auto');
                  const flowLabel = `${job.test_type || 'Suite'} | ${job.suite || 'Auto'} [${devText}]`;
                  return (
                    <div
                      key={job.run_id}
                      className={`log-tab-wrap ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedTabId(job.run_id)}
                      title={flowLabel}
                    >
                      <span className="log-tab-label">{flowLabel}</span>
                      <button
                        className="log-tab-close"
                        title="Close Tab"
                        onClick={(e) => handleCloseTab(e, job.run_id)}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}

                {/* Aggregate Running Tab */}
                <div
                  className={`log-tab-wrap ${selectedTabId === 'running-all' ? 'active' : ''}`}
                  onClick={() => setSelectedTabId('running-all')}
                  title="RUNNING LOG (All Flows)"
                >
                  <span className="log-tab-label">RUNNING LOG</span>
                  {activeJobs.length > 0 && (
                    <button
                      className="log-tab-close"
                      title="Reset tab filter"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedTabId(visibleJobs[0]?.run_id || 'running-all');
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Clear Log Button */}
              <button className="log-clear-btn" onClick={handleClearLog} title="Clear Log Output">
                Clear Log
              </button>
            </div>

            {/* Row 2: Subtab Category Pills */}
            <div className="log-subtabs-row">
              {availableSubtabs.map((tag) => (
                <button
                  key={tag}
                  className={`log-subtab-pill ${activeSubtab === tag ? 'active' : ''}`}
                  onClick={() => setActiveSubtab(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* Console Output Screen */}
          <pre ref={logBoxRef} id="logBox" className="log-console-box">
            {filteredLogs.length > 0 ? (
              filteredLogs.map((line, idx) => {
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
              <div style={{ color: '#8b949e', textAlign: 'center', padding: '2.5rem' }}>
                {activeJobs.length > 0
                  ? '⏳ Menunggu log stream dari Tradefed runner...'
                  : 'Belum ada active run log.'}
              </div>
            )}
          </pre>
        </div>
      )}
    </section>
  );
};
