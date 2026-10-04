import React from 'react';
import { ActiveJobItem } from '../hooks/useFleetWebSocket';
import { CheckIcon, DownloadIcon } from './Icons';

interface ResultsExplorerProps {
  history: ActiveJobItem[];
}

export const ResultsExplorer: React.FC<ResultsExplorerProps> = ({ history }) => {
  if (history.length === 0) return null;

  return (
    <section className="card-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Recent Execution History & Results</span>
          <span className="badge badge-pass">{history.length} Completed</span>
        </div>
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
            </tr>
          </thead>
          <tbody>
            {history.map((job) => {
              const summary = job.summary;
              const isPass = job.status === 'Finished' && (!summary || summary.failed === 0);
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
                    {summary ? summary.passed : '-'}
                  </td>
                  <td style={{ color: summary && summary.failed > 0 ? 'var(--status-fail-text)' : 'inherit', fontWeight: 600 }}>
                    {summary ? summary.failed : '-'}
                  </td>
                  <td>{summary ? summary.total : '-'}</td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
