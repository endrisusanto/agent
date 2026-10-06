import React, { useEffect, useState } from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { TrashIcon, ChevronDownIcon, ChevronUpIcon } from './Icons';
import { formatDurationHms } from '../utils/formatters';

interface ServerZipItem {
  filename: string;
  path?: string;
  run_batch?: string;
  summary?: {
    total: number;
    passed: number;
    failed: number;
    run_time?: string;
  };
}

interface ResultsExplorerProps {
  history: ActiveJobItem[];
  onDeleteHistoryItem?: (run_id: string) => void;
  onClearAllHistory?: () => void;
}

export const ResultsExplorer: React.FC<ResultsExplorerProps> = ({
  history,
  onDeleteHistoryItem,
  onClearAllHistory,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [serverZips, setServerZips] = useState<ServerZipItem[]>([]);

  useEffect(() => {
    let isMounted = true;
    const fetchZips = async () => {
      try {
        const res = await fetch('/api/results/list');
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.zips) {
            setServerZips(data.zips);
          }
        }
      } catch (_) {}
    };

    fetchZips();
    const interval = setInterval(fetchZips, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  if (history.length === 0) return null;

  return (
    <section className="accordion-card history-accordion-card">
      <div
        className="accordion-header"
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <div className="accordion-header-top" style={{ width: '100%' }}>
          <div className="accordion-header-left">
            <button
              type="button"
              className="accordion-toggle-btn"
              aria-label="Toggle History Accordion"
            >
              {isExpanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
            </button>
            <div className="accordion-model-info">
              <span className="accordion-model-name">HISTORY</span>
            </div>
          </div>

          <div className="accordion-header-meta" onClick={(e) => e.stopPropagation()}>
            <span className="badge badge-ready history-count-badge" title={`${history.length} Selesai`}>
              {history.length}
            </span>
            {onClearAllHistory && (
              <button
                className="btn btn-secondary btn-xs btn-clear-history"
                onClick={() => {
                  if (window.confirm('Hapus semua riwayat pengujian?')) {
                    onClearAllHistory();
                  }
                }}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--status-fail-text, #ef4444)' }}
                title="Hapus semua riwayat pengujian"
                aria-label="Clear all execution history"
              >
                <TrashIcon size={13} />
              </button>
            )}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="accordion-body" style={{ padding: 0 }}>
          <div className="table-responsive history-table-container">
            <table className="data-table history-table">
              <thead>
                <tr>
                  <th>Node PC</th>
                  <th>Mode</th>
                  <th>Devices</th>
                  <th>Run Time</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Total</th>
                  <th>Status</th>
                  <th>Result Archive</th>
                  <th style={{ width: '60px', textAlign: 'center' }}>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {history.map((job) => {
                  const zipName = job.zip_file ? job.zip_file.split('/').pop() || '' : '';
                  const matchZip = serverZips.find(
                    (z) =>
                      (zipName && (z.filename === zipName || (z.path && z.path.includes(zipName)) || zipName.includes(z.filename))) ||
                      (job.run_id && z.run_batch && (z.run_batch.includes(job.run_id) || job.run_id.includes(z.run_batch))) ||
                      (job.zip_file && z.path && (z.path.includes(job.zip_file) || job.zip_file.includes(z.path)))
                  );

                  const hasRealJobSummary = job.summary && ((job.summary.total ?? 0) > 1 || (job.summary.passed ?? 0) > 1 || (job.summary.failed ?? 0) > 0);
                  const hasRealZipSummary = matchZip?.summary && ((matchZip.summary.total ?? 0) > 1 || (matchZip.summary.passed ?? 0) > 1 || (matchZip.summary.failed ?? 0) > 0);
                  const eff = hasRealJobSummary ? job.summary : (hasRealZipSummary ? matchZip?.summary : (job.summary || matchZip?.summary));

                  const passed = eff?.passed !== undefined ? eff.passed : (job.status === 'Finished' ? 1 : 0);
                  const failed = eff?.failed !== undefined ? eff.failed : (job.status === 'Failed' ? 1 : 0);
                  const total = eff?.total !== undefined ? eff.total : (passed + failed);
                  const rawRunTime = eff?.run_time || job.summary?.run_time || job.elapsed_secs;
                  const runTime = formatDurationHms(rawRunTime);
                  const isFinished = job.status === 'Finished' || job.status === 'Test Done';
                  // ponytail: finish status is always green (badge-ready) regardless of test results
                  const statusBadgeClass = isFinished
                    ? 'badge-ready'
                    : (job.status === 'Running' || job.status === 'Starting')
                    ? 'badge-running'
                    : 'badge-fail';
                  return (
                    <tr key={job.run_id} className="history-row">
                      <td className="history-cell-node">
                        <span className="badge badge-pc">{job.pcId}</span>
                      </td>
                      <td className="history-cell-mode">
                        <strong>{(job.test_type || job.suite || '-').replace(/^Laundry\s+/i, '')}</strong>
                      </td>
                      <td className="history-cell-devices">
                        <div className="history-devices-wrap">
                          {Array.isArray(job.devices) && job.devices.length > 0 ? (
                            job.devices.map((s) => (
                              <span key={s} className="device-serial-pill mono">
                                {s}
                              </span>
                            ))
                          ) : (
                            <span className="mono text-secondary text-xs">{job.devices || '-'}</span>
                          )}
                        </div>
                      </td>
                      <td className="history-cell-time">{runTime}</td>
                      <td className="history-cell-passed">
                        <span className="badge badge-ready badge-num-pill" title={`Passed: ${passed.toLocaleString()}`}>
                          <span className="mobile-metric-label">Pass </span>
                          {passed.toLocaleString()}
                        </span>
                      </td>
                      <td className="history-cell-failed">
                        <span
                          className={`badge ${failed > 0 ? 'badge-fail' : 'badge-fail-zero'} badge-num-pill`}
                          title={`Failed: ${failed.toLocaleString()}`}
                        >
                          <span className="mobile-metric-label">Fail </span>
                          {failed.toLocaleString()}
                        </span>
                      </td>
                      <td className="history-cell-total">
                        <span className="badge badge-neutral badge-num-pill" title={`Total: ${total.toLocaleString()}`}>
                          <span className="mobile-metric-label">Total </span>
                          {total.toLocaleString()}
                        </span>
                      </td>
                      <td className="history-cell-status">
                        <span className={`badge ${statusBadgeClass} badge-status-fixed`}>
                          {job.status ? job.status.toUpperCase() : 'FINISHED'}
                        </span>
                      </td>
                      <td className="history-cell-zip mono-cell" style={{ fontSize: '0.75rem' }}>
                        {job.zip_file ? (
                          <a
                            href={`/api/results/download?path=${encodeURIComponent(job.zip_file)}&file=${encodeURIComponent(job.zip_file.split('/').pop() || '')}&run_id=${encodeURIComponent(job.run_id)}`}
                            download={job.zip_file.split('/').pop()}
                            className="btn btn-secondary btn-xs history-zip-download-btn"
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.35rem',
                              textDecoration: 'none',
                              color: 'var(--text-primary)',
                              fontWeight: 600,
                              maxWidth: '220px',
                              borderRadius: 'var(--radius-full)',
                            }}
                            title={`Download ${job.zip_file.split('/').pop()}`}
                          >
                            <span style={{ flexShrink: 0 }}>📦</span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {job.zip_file.split('/').pop()}
                            </span>
                          </a>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>No Zip</span>
                        )}
                      </td>
                      <td className="history-cell-actions" style={{ textAlign: 'center' }}>
                        {onDeleteHistoryItem && (
                          <button
                            className="btn-icon-danger"
                            onClick={() => onDeleteHistoryItem(job.run_id)}
                            title="Hapus baris riwayat ini"
                            aria-label="Delete history item"
                          >
                            <TrashIcon size={12} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
      </div>
    </div>
    )}
  </section>
  );
};
