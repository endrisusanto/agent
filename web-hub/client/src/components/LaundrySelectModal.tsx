import React, { useState, useEffect } from 'react';
import { CloseIcon, CheckIcon, RefreshIcon } from './Icons';
import { LaundryZipItem, LaundryRow } from '../hooks/useFleetWebSocket';

interface LaundrySelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  pcId: string;
  zips: LaundryZipItem[];
  laundryAnalysis: {
    pcId: string;
    zip_path: string;
    rows: LaundryRow[];
    error?: string;
  } | null;
  onAnalyzeZip: (pcId: string, zip_path: string) => void;
  onConfirmSelection: (zipPath: string, selectedRows: LaundryRow[]) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export const LaundrySelectModal: React.FC<LaundrySelectModalProps> = ({
  isOpen,
  onClose,
  pcId,
  zips,
  laundryAnalysis,
  onAnalyzeZip,
  onConfirmSelection,
}) => {
  const [selectedZipPath, setSelectedZipPath] = useState<string>('');
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);

  useEffect(() => {
    if (laundryAnalysis && laundryAnalysis.rows) {
      // By default select all failed/not-executed modules
      const failed = laundryAnalysis.rows
        .filter((r) => r.failed > 0 || r.status !== 'pass')
        .map((r) => r.id);
      setSelectedRowIds(failed.length > 0 ? failed : laundryAnalysis.rows.map((r) => r.id));
    }
  }, [laundryAnalysis]);

  if (!isOpen) return null;

  const handleSelectZip = (path: string) => {
    setSelectedZipPath(path);
    onAnalyzeZip(pcId, path);
  };

  const handleToggleRow = (id: string) => {
    setSelectedRowIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleConfirm = () => {
    if (!selectedZipPath) return;
    const selectedRows = (laundryAnalysis?.rows || []).filter((r) =>
      selectedRowIds.includes(r.id)
    );
    onConfirmSelection(selectedZipPath, selectedRows);
    onClose();
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-dialog" style={{ maxWidth: '820px' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>Select Laundry Result Zip ({pcId})</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Pick a previous test result from the node disk to run selective retries
            </p>
          </div>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.375rem' }}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Available Result Zips on {pcId}</label>
            {zips.length === 0 ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                No result zip files found on {pcId} Results directory.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', maxHeight: '180px', overflowY: 'auto' }}>
                {zips.map((z) => (
                  <div
                    key={z.path}
                    onClick={() => handleSelectZip(z.path)}
                    style={{
                      padding: '0.625rem 0.875rem',
                      borderRadius: 'var(--radius-md)',
                      border: `1px solid ${selectedZipPath === z.path ? 'var(--accent-border)' : 'var(--border-subtle)'}`,
                      backgroundColor: selectedZipPath === z.path ? 'var(--accent-subtle)' : 'var(--bg-subtle)',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: '0.8125rem' }}>{z.filename}</strong>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        {z.model ? `Model: ${z.model} • ` : ''}{formatBytes(z.sizeBytes)} • {new Date(z.modifiedAt).toLocaleString()}
                      </div>
                    </div>
                    {selectedZipPath === z.path && <CheckIcon size={16} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedZipPath && (
            <div className="form-group">
              <label className="form-label">Module Analysis Preview</label>
              {!laundryAnalysis ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                  Analyzing test_result.xml on node...
                </div>
              ) : laundryAnalysis.error ? (
                <div className="badge badge-fail" style={{ padding: '0.5rem', width: '100%' }}>
                  {laundryAnalysis.error}
                </div>
              ) : laundryAnalysis.rows.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                  No modules found in this result.
                </div>
              ) : (
                <div className="table-responsive" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '40px' }}>Select</th>
                        <th>Suite</th>
                        <th>Testcase / Module</th>
                        <th>Total</th>
                        <th>Passed</th>
                        <th>Failed</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {laundryAnalysis.rows.map((r) => {
                        const isChecked = selectedRowIds.includes(r.id);
                        return (
                          <tr key={r.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => handleToggleRow(r.id)}
                              />
                            </td>
                            <td><span className="badge badge-pc">{r.suite}</span></td>
                            <td className="mono-cell" style={{ fontSize: '0.75rem' }}>{r.testcase}</td>
                            <td>{r.total}</td>
                            <td style={{ color: 'var(--status-ready-text)' }}>{r.passed}</td>
                            <td style={{ color: r.failed > 0 ? 'var(--status-fail-text)' : 'inherit' }}>{r.failed}</td>
                            <td>
                              <span className={`badge ${r.failed > 0 ? 'badge-fail' : 'badge-pass'}`}>
                                {r.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!selectedZipPath || selectedRowIds.length === 0}
          >
            Confirm Laundry Selection ({selectedRowIds.length})
          </button>
        </div>
      </div>
    </div>
  );
};
