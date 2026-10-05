import React from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { TrashIcon } from './Icons';

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
  if (history.length === 0) return null;

  return (
    <section className="card-panel">
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div className="panel-title">
          <span>Recent Execution History & Results</span>
          <span className="badge badge-pass">{history.length} Completed</span>
        </div>

        {onClearAllHistory && (
          <button
            className="btn btn-secondary btn-xs"
            onClick={() => {
              if (window.confirm('Hapus semua riwayat eksekusi test?')) {
                onClearAllHistory();
              }
            }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', color: 'var(--status-fail-text, #ef4444)' }}
            title="Clear all execution history"
          >
            <TrashIcon size={12} />
            <span>Clear All</span>
          </button>
        )}
      </div>

      <div className="table-responsive">
        <table className="data-table">
          <thead>
            <tr>
              <th>Node PC</th>
              <th>Test Mode</th>
              <th>Suite</th>
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
              const summary = job.summary;
              const passed = summary?.passed !== undefined ? summary.passed : (job.status === 'Finished' ? 1 : 0);
              const failed = summary?.failed !== undefined ? summary.failed : (job.status === 'Failed' ? 1 : 0);
              const total = summary?.total !== undefined ? summary.total : (passed + failed);
              const isPass = (job.status === 'Finished' || job.status === 'Test Done') && failed === 0;
              return (
                <tr key={job.run_id}>
                  <td>
                    <span className="badge badge-pc">{job.pcId}</span>
                  </td>
                  <td>
                    <strong>{job.test_type}</strong>
                  </td>
                  <td>{job.suite}</td>
                  <td className="mono-cell" style={{ fontSize: '0.75rem' }}>
                    {Array.isArray(job.devices) ? job.devices.join(', ') : (job.devices || 'N/A')}
                  </td>
                  <td>{summary?.run_time || `${job.elapsed_secs}s`}</td>
                  <td style={{ color: 'var(--status-ready-text)', fontWeight: 600 }}>
                    {passed}
                  </td>
                  <td style={{ color: failed > 0 ? 'var(--status-fail-text)' : 'inherit', fontWeight: 600 }}>
                    {failed}
                  </td>
                  <td>{total}</td>
                  <td>
                    <span className={`badge ${isPass ? 'badge-pass' : 'badge-fail'}`}>
                      {job.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="mono-cell" style={{ fontSize: '0.75rem' }}>
                    {job.zip_file ? (
                      <span title={job.zip_file}>
                        📦 {job.zip_file.split('/').pop()}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-secondary)' }}>No Zip</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }}>
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
    </section>
  );
};
