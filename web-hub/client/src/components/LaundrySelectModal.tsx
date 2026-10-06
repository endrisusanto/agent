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

export function normalizeModelName(raw?: string): string {
  if (!raw) return 'UNKNOWN';
  let str = raw.replace(/^SM[-_]?/i, '').trim();
  if (str.toUpperCase().startsWith('LAUNDRY')) {
    // If it's a filename like Laundry_SMR_SM-A546E..., extract model token
    const m = str.match(/(?:SM[-_])?([A-Z][0-9]{3}[A-Z0-9]?)/i);
    if (m && m[1]) str = m[1].replace(/^SM[-_]?/i, '');
  }
  let modelPart = '';
  for (const ch of str) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      modelPart += ch;
      if (modelPart.length >= 5 && /[FBGEPNUWfbgepnuw]$/.test(modelPart)) {
        break;
      }
    } else {
      break;
    }
  }
  if (modelPart.length >= 4 && /^[ASFMXT]/i.test(modelPart)) {
    return modelPart.toUpperCase();
  }
  return str.toUpperCase();
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
      const cleanModel = normalizeModelName(z.model || z.filename);
      if (cleanModel !== 'UNKNOWN') {
        counts[cleanModel] = (counts[cleanModel] || 0) + 1;
      }
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [zips]);

  // Check if a model currently has connected devices
  const isModelDeviceConnected = (modelName: string): boolean => {
    if (!devices || devices.length === 0) return false;
    if (modelName === 'ALL') return devices.length > 0;
    const mClean = normalizeModelName(modelName).replace(/[^A-Z0-9]/g, '');
    return devices.some((d) => {
      const dModel = normalizeModelName(d.model || '').replace(/[^A-Z0-9]/g, '');
      return dModel === mClean || dModel.includes(mClean) || mClean.includes(dModel);
    });
  };

  // Filtered zips based on selected model chip
  const filteredZips = useMemo(() => {
    if (selectedModelFilter === 'ALL') return zips;
    return (zips || []).filter((z) => {
      const cleanModel = normalizeModelName(z.model || z.filename);
      return cleanModel === selectedModelFilter;
    });
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
      <div
        className="modal-dialog"
        style={{
          width: '95vw',
          maxWidth: '1360px',
          maxHeight: '92vh',
        }}
      >
        <div className="modal-header">
          <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>Pick Zip Laundry</h3>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.375rem' }}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Model Filter Chips */}
          <div className="form-group" style={{ marginBottom: '0.75rem' }}>
            <div
              className="model-pills-bar"
              style={{
                flexWrap: 'nowrap',
                overflowX: 'auto',
                paddingBottom: '0.375rem',
                scrollbarWidth: 'thin',
                WebkitOverflowScrolling: 'touch',
                width: '100%',
              }}
            >
              <button
                type="button"
                className={`model-pill ${selectedModelFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setSelectedModelFilter('ALL')}
                style={{ flexShrink: 0 }}
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
                    className={`model-pill ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedModelFilter(modelName)}
                    style={{
                      flexShrink: 0,
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
              Daftar Paket Laundry Fleet ({filteredZips.length} file)
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
                    <div style={{ minWidth: 0, flex: 1, marginRight: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                        {z.pcId && z.pcId.toLowerCase() !== 'syncmaster' && z.pcId !== 'Hub-Local' && (
                          <span
                            style={{
                              fontSize: '0.6875rem',
                              padding: '0.0625rem 0.375rem',
                              borderRadius: '4px',
                              backgroundColor: 'rgba(56, 139, 253, 0.15)',
                              color: '#58a6ff',
                              border: '1px solid rgba(56, 139, 253, 0.3)',
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                            title="Source Node"
                          >
                            {z.pcId}
                          </span>
                        )}
                        <strong
                          style={{
                            fontSize: '0.8125rem',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: '100%',
                          }}
                          title={z.filename}
                        >
                          {z.filename}
                        </strong>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {z.model ? `Model: ${z.model.replace(/^SM-/i, '').replace(/^SM/i, '')} • ` : ''}{formatBytes(z.sizeBytes)} • {new Date(z.modifiedAt).toLocaleString()}
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
                        {(laundryAnalysis.rows[0]?.model || '-').replace(/^SM-/i, '').replace(/^SM/i, '')}
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
                          ({laundryAnalysis.rows.length})
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Modules Data Table */}
                  <div className="table-responsive" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: '56px', textAlign: 'center' }}>SELECT</th>
                          <th style={{ minWidth: '240px' }}>TESTCASE</th>
                          <th style={{ minWidth: '320px' }}>SUBTESTCASES</th>
                          <th style={{ width: '100px', textAlign: 'center' }}>STATUS</th>
                          <th style={{ width: '90px', textAlign: 'center' }}>TIME</th>
                          <th style={{ minWidth: '160px' }}>RESULTS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {laundryAnalysis.rows.map((r) => {
                          const isChecked = selectedRowIds.includes(r.id);
                          const isFail = (r.failed || 0) > 0 || r.status?.toUpperCase() === 'FAIL';
                          const cleanRowModel = r.model ? r.model.replace(/^SM-/i, '').replace(/^SM/i, '') : '';
                          const subInfo = [r.suite_version, cleanRowModel, r.result_dir].filter(Boolean).join(' · ');
                          return (
                            <tr
                              key={r.id}
                              className={isChecked ? 'row-selected' : ''}
                              onClick={() => handleToggleRow(r.id)}
                              style={{ cursor: 'pointer' }}
                            >
                              <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                                <label className="switch-toggle" style={{ margin: '0 auto' }}>
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => handleToggleRow(r.id)}
                                  />
                                  <span className="switch-slider"></span>
                                </label>
                              </td>
                              <td>
                                <div className="mono font-semibold" style={{ fontSize: '0.8125rem' }}>
                                  {r.testcase || r.suite}
                                </div>
                                {subInfo && (
                                  <div className="text-secondary text-xs" style={{ marginTop: '0.125rem', opacity: 0.75 }}>
                                    {subInfo}
                                  </div>
                                )}
                              </td>
                              <td>
                                <div
                                  className="mono text-xs text-secondary"
                                  style={{
                                    maxWidth: '650px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={r.subtestcases || '-'}
                                >
                                  {r.subtestcases || '-'}
                                </div>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span className="badge badge-ready badge-status-fixed">
                                  {r.status || 'Test Done'}
                                </span>
                              </td>
                              <td className="mono text-xs text-secondary" style={{ textAlign: 'center' }}>
                                {r.time || '00:00:00'}
                              </td>
                              <td>
                                <div className="results-cell-group">
                                  <div className="results-cell-top">
                                    <span className="badge badge-neutral badge-chip-fixed" title={`Total: ${r.total ?? 0}`}>
                                      <span className="chip-label">Total</span>
                                      <span className="chip-circle-val">{r.total ?? 0}</span>
                                    </span>
                                  </div>
                                  <div className="results-cell-bottom">
                                    <span className="badge badge-ready badge-chip-fixed" title={`Pass: ${r.passed ?? 0}`}>
                                      <span className="chip-label">Pass</span>
                                      <span className="chip-circle-val">{r.passed ?? 0}</span>
                                    </span>
                                    <span
                                      className={`badge ${(r.failed || 0) > 0 ? 'badge-fail' : 'badge-fail-zero'} badge-chip-fixed`}
                                      title={`Fail: ${r.failed ?? 0}`}
                                    >
                                      <span className="chip-label">Fail</span>
                                      <span className="chip-circle-val">{r.failed ?? 0}</span>
                                    </span>
                                  </div>
                                </div>
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
            Confirm Selection ({selectedRowIds.length})
          </button>
        </div>
      </div>
    </div>
  );
};
