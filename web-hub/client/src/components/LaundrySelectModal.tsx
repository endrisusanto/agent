import React, { useState, useEffect, useMemo } from 'react';
import { CloseIcon, CheckIcon } from './Icons';
import { LaundryZipItem, LaundryRow, DeviceItem } from '../hooks/useFleetWebSocket';

interface LaundrySelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  pcId: string;
  zips: LaundryZipItem[];
  devices?: DeviceItem[];
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
  devices,
  laundryAnalysis,
  onAnalyzeZip,
  onConfirmSelection,
}) => {
  const [selectedZipPath, setSelectedZipPath] = useState<string>('');
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [selectedModelFilter, setSelectedModelFilter] = useState<string>('ALL');

  useEffect(() => {
    if (laundryAnalysis && laundryAnalysis.rows) {
      // By default select all failed/not-executed modules
      const failed = laundryAnalysis.rows
        .filter((r) => r.failed > 0 || r.status !== 'pass')
        .map((r) => r.id);
      setSelectedRowIds(failed.length > 0 ? failed : laundryAnalysis.rows.map((r) => r.id));
    }
  }, [laundryAnalysis]);

  // Extract unique models with counts from all available laundry zips
  const modelChips = useMemo(() => {
    const counts: Record<string, number> = {};
    (zips || []).forEach((z) => {
      const m = z.model || 'UNKNOWN';
      counts[m] = (counts[m] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [zips]);

  // Check if a model currently has connected devices
  const isModelDeviceConnected = (modelName: string): boolean => {
    if (!devices || devices.length === 0) return false;
    if (modelName === 'ALL') return devices.length > 0;
    const mClean = modelName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return devices.some((d) => {
      const dModel = (d.model || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      return dModel === mClean || dModel.includes(mClean) || mClean.includes(dModel);
    });
  };

  // Filtered zips based on selected model chip
  const filteredZips = useMemo(() => {
    if (selectedModelFilter === 'ALL') return zips;
    return (zips || []).filter((z) => (z.model || 'UNKNOWN') === selectedModelFilter);
  }, [zips, selectedModelFilter]);

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
      <div className="modal-dialog" style={{ maxWidth: '840px' }}>
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
          {/* Model Filter Chips */}
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Filter by Target Model</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                🟢 Dot hijau menandakan perangkat terhubung
              </span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
              <button
                type="button"
                className={`filter-pill ${selectedModelFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setSelectedModelFilter('ALL')}
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.625rem' }}
              >
                <span>SEMUA</span>
                <span className="pill-count">{zips.length}</span>
              </button>

              {modelChips.map(([modelName, count]) => {
                const connected = isModelDeviceConnected(modelName);
                const isSelected = selectedModelFilter === modelName;
                return (
                  <button
                    key={modelName}
                    type="button"
                    className={`filter-pill ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedModelFilter(modelName)}
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.625rem',
                      border: connected ? '1px solid var(--accent-primary)' : undefined,
                      boxShadow: connected ? '0 0 8px rgba(86, 211, 100, 0.25)' : undefined,
                    }}
                    title={connected ? `${modelName} (Perangkat Tersambung)` : modelName}
                  >
                    {connected && (
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          backgroundColor: '#56d364',
                          display: 'inline-block',
                          boxShadow: '0 0 6px #56d364',
                        }}
                      />
                    )}
                    <span>{modelName}</span>
                    <span className="pill-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">
              Available Result Zips on {pcId} ({filteredZips.length} files)
            </label>
            {filteredZips.length === 0 ? (
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', padding: '0.5rem 0' }}>
                Tidak ada file zip hasil pengujian yang cocok dengan filter model "{selectedModelFilter}".
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', maxHeight: '180px', overflowY: 'auto' }}>
                {filteredZips.map((z) => (
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
              <label className="form-label">Module Analysis & Test Run Details</label>
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
                <>
                  {/* Summary Header for Selected Zip (Plan, AP Version, Model, Modules) */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                      gap: '0.625rem',
                      padding: '0.75rem 0.875rem',
                      backgroundColor: 'var(--bg-subtle)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border-subtle)',
                      marginBottom: '0.75rem',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Test Run (Plan)
                      </div>
                      <div style={{ marginTop: '0.25rem' }}>
                        <span
                          className={`badge ${
                            laundryAnalysis.rows[0]?.plan === 'SMR'
                              ? 'badge-unit'
                              : laundryAnalysis.rows[0]?.plan === 'SKU'
                              ? 'badge-running'
                              : 'badge-pc'
                          }`}
                          style={{ fontWeight: 700, fontSize: '0.75rem' }}
                        >
                          {laundryAnalysis.rows[0]?.plan || 'Normal'}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        AP Version
                      </div>
                      <div className="mono-cell" style={{ fontSize: '0.8125rem', fontWeight: 600, marginTop: '0.25rem', color: 'var(--text-primary)' }}>
                        {laundryAnalysis.rows[0]?.ap_version || '-'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Target Model
                      </div>
                      <div className="mono-cell" style={{ fontSize: '0.8125rem', fontWeight: 600, marginTop: '0.25rem', color: 'var(--text-primary)' }}>
                        {laundryAnalysis.rows[0]?.model || '-'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Execution Result
                      </div>
                      <div style={{ fontSize: '0.8125rem', marginTop: '0.25rem' }}>
                        <span style={{ color: 'var(--status-ready-text)', fontWeight: 600 }}>
                          {laundryAnalysis.rows.reduce((acc, r) => acc + (r.passed || 0), 0)} Pass
                        </span>
                        {laundryAnalysis.rows.reduce((acc, r) => acc + (r.failed || 0), 0) > 0 && (
                          <span style={{ color: 'var(--status-fail-text)', fontWeight: 600, marginLeft: '0.5rem' }}>
                            {laundryAnalysis.rows.reduce((acc, r) => acc + (r.failed || 0), 0)} Fail
                          </span>
                        )}
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.375rem' }}>
                          ({laundryAnalysis.rows.length} modules)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Modules Data Table */}
                  <div className="table-responsive" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: '40px' }}>Select</th>
                          <th>Suite</th>
                          <th>Plan</th>
                          <th>AP Version</th>
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
                              <td>
                                <span
                                  className={`badge ${
                                    r.plan === 'SMR'
                                      ? 'badge-unit'
                                      : r.plan === 'SKU'
                                      ? 'badge-running'
                                      : 'badge-pc'
                                  }`}
                                  style={{ fontSize: '0.6875rem' }}
                                >
                                  {r.plan || 'Normal'}
                                </span>
                              </td>
                              <td className="mono-cell" style={{ fontSize: '0.75rem' }}>
                                {r.ap_version || '-'}
                              </td>
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
                </>
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
