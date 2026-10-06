import React, { useState, useMemo, useEffect } from 'react';
import { PreflightReport, PreflightItem, BridgeInfo } from '../hooks/useFleetWebSocket';
import {
  CloseIcon,
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  XCircleIcon,
  SearchIcon,
  DownloadCloudIcon,
  PreflightIcon,
  ServerIcon,
} from './Icons';

interface MatrixPreflightRow {
  key: string;
  category: string;
  item: string;
  path: string;
  details: string;
  zip_available: boolean;
  can_sync: boolean;
  nodeStatuses: Record<string, {
    status: 'OK' | 'MISSING' | 'WARN';
    details?: string;
    can_sync?: boolean;
    path?: string;
  }>;
}

interface PreflightModalProps {
  isOpen: boolean;
  onClose: () => void;
  preflightReports: PreflightReport[];
  bridges: BridgeInfo[];
  onTriggerScan: (pcId?: string) => void;
  onStartSync: (sourceNode: string, targetNode: string, resourceName: string) => void;
  selectedNodeFilter?: string;
  onNodeFilterChange?: (node: string) => void;
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  statusFilter?: 'ALL' | 'ISSUES' | 'OK';
  onStatusFilterChange?: (s: 'ALL' | 'ISSUES' | 'OK') => void;
}

export const PreflightModal: React.FC<PreflightModalProps> = ({
  isOpen,
  onClose,
  preflightReports,
  bridges,
  onTriggerScan,
  onStartSync,
  selectedNodeFilter: controlledNodeFilter,
  onNodeFilterChange,
  searchQuery: controlledSearch,
  onSearchChange,
  statusFilter: controlledStatusFilter,
  onStatusFilterChange,
}) => {
  const [internalNodeFilter, setInternalNodeFilter] = useState<string>('ALL');
  const selectedNodeFilter = controlledNodeFilter !== undefined ? controlledNodeFilter : internalNodeFilter;
  const setSelectedNodeFilter = onNodeFilterChange || setInternalNodeFilter;

  const [internalSearch, setInternalSearch] = useState<string>('');
  const searchQuery = controlledSearch !== undefined ? controlledSearch : internalSearch;
  const setSearchQuery = onSearchChange || setInternalSearch;

  const [internalStatusFilter, setInternalStatusFilter] = useState<'ALL' | 'ISSUES' | 'OK'>('ALL');
  const statusFilter = controlledStatusFilter !== undefined ? controlledStatusFilter : internalStatusFilter;
  const setStatusFilter = onStatusFilterChange || setInternalStatusFilter;

  const [isScanning, setIsScanning] = useState<boolean>(false);

  // Trigger diagnostic scan immediately when modal opens
  useEffect(() => {
    if (isOpen) {
      onTriggerScan();
    }
  }, [isOpen, onTriggerScan]);

  // Collect all available node PC IDs
  const availableNodes = useMemo(() => {
    const fromReports = preflightReports.map((r) => r.pc_id);
    const fromBridges = bridges.map((b) => b.pcId);
    const set = new Set([...fromReports, ...fromBridges]);
    if (set.size === 0) {
      set.add('Endri Ubuntu');
    }
    return Array.from(set).filter(Boolean);
  }, [preflightReports, bridges]);

  // Build matrix rows indexed by category + item
  const matrixRows = useMemo(() => {
    const rowMap = new Map<string, MatrixPreflightRow>();

    preflightReports.forEach((rep) => {
      rep.items.forEach((item) => {
        const key = `${item.category}::${item.item}`;
        if (!rowMap.has(key)) {
          rowMap.set(key, {
            key,
            category: item.category,
            item: item.item,
            path: item.path,
            details: item.details || '',
            zip_available: item.zip_available,
            can_sync: item.can_sync,
            nodeStatuses: {},
          });
        }
        const row = rowMap.get(key)!;
        row.nodeStatuses[rep.pc_id] = {
          status: item.status as 'OK' | 'MISSING' | 'WARN',
          details: item.details,
          can_sync: item.can_sync,
          path: item.path,
        };
        if (item.zip_available) row.zip_available = true;
        if (item.can_sync) row.can_sync = true;
      });
    });

    return Array.from(rowMap.values());
  }, [preflightReports]);

  // Filter matrix rows based on selected node, search query, and status
  const filteredRows = useMemo(() => {
    return matrixRows.filter((row) => {
      // Node filter
      if (selectedNodeFilter !== 'ALL') {
        const nodeStatus = row.nodeStatuses[selectedNodeFilter];
        if (!nodeStatus) return false;
        if (statusFilter === 'ISSUES' && nodeStatus.status === 'OK') return false;
        if (statusFilter === 'OK' && nodeStatus.status !== 'OK') return false;
      } else {
        // Across all nodes
        const statuses = Object.values(row.nodeStatuses).map((s) => s.status);
        const hasIssue = statuses.some((s) => s === 'MISSING' || s === 'WARN');
        const allOk = statuses.length > 0 && statuses.every((s) => s === 'OK');
        if (statusFilter === 'ISSUES' && !hasIssue) return false;
        if (statusFilter === 'OK' && !allOk) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchCat = row.category.toLowerCase().includes(q);
        const matchItem = row.item.toLowerCase().includes(q);
        const matchPath = row.path.toLowerCase().includes(q);
        const matchDetails = row.details.toLowerCase().includes(q);
        return matchCat || matchItem || matchPath || matchDetails;
      }

      return true;
    });
  }, [matrixRows, selectedNodeFilter, searchQuery, statusFilter]);

  // Summary counts
  const stats = useMemo(() => {
    let total = 0;
    let ok = 0;
    let warn = 0;
    let missing = 0;

    matrixRows.forEach((row) => {
      total++;
      if (selectedNodeFilter === 'ALL') {
        const statuses = Object.values(row.nodeStatuses).map((s) => s.status);
        if (statuses.every((s) => s === 'OK')) ok++;
        else if (statuses.some((s) => s === 'MISSING')) missing++;
        else warn++;
      } else {
        const s = row.nodeStatuses[selectedNodeFilter]?.status;
        if (s === 'OK') ok++;
        else if (s === 'MISSING') missing++;
        else if (s === 'WARN') warn++;
      }
    });

    return {
      total,
      ok,
      warn,
      missing,
      issues: warn + missing,
    };
  }, [matrixRows, selectedNodeFilter]);

  if (!isOpen) return null;

  const handleRefresh = () => {
    setIsScanning(true);
    onTriggerScan(selectedNodeFilter === 'ALL' ? undefined : selectedNodeFilter);
    setTimeout(() => setIsScanning(false), 1200);
  };

  const handleSyncNodeTool = (targetNode: string, row: MatrixPreflightRow) => {
    // Find donor node that has this tool OK
    const donorNode =
      availableNodes.find(
        (n) => n !== targetNode && row.nodeStatuses[n]?.status === 'OK'
      ) || 'Endri';

    if (onStartSync) {
      onStartSync(donorNode, targetNode, row.item);
    }
  };

  const currentReport =
    preflightReports.find((r) => r.pc_id === selectedNodeFilter) ||
    preflightReports[0];

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-dialog preflight-modal-dialog">
        {/* Modal Header: Streamlined, minimal text, icon-only buttons */}
        <div className="modal-header preflight-modal-header">
          <div className="preflight-header-left">
            <div className="preflight-title-wrap">
              <PreflightIcon size={18} className="preflight-modal-icon" />
              <h2 className="modal-title" style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0 }}>
                Preflight Diagnostics
              </h2>
            </div>
          </div>

          <div className="preflight-header-actions">
            <button
              type="button"
              className="btn-icon preflight-rescan-btn"
              onClick={handleRefresh}
              title="Pindai Ulang Status Preflight"
              aria-label="Rescan"
            >
              <RefreshIcon size={16} className={isScanning ? 'spin-anim' : ''} />
            </button>
            <button
              type="button"
              className="btn-icon preflight-close-btn"
              onClick={onClose}
              title="Tutup"
              aria-label="Close"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="modal-body preflight-modal-body">
          {/* Node Filter Tabs Bar */}
          <div className="preflight-node-tabs-bar">
            <div className="preflight-node-tabs">
              <button
                type="button"
                className={`node-tab-btn ${selectedNodeFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setSelectedNodeFilter('ALL')}
              >
                <ServerIcon size={13} />
                <span>SEMUA NODE ({availableNodes.length})</span>
              </button>
              {availableNodes.map((nodeId) => (
                <button
                  key={nodeId}
                  type="button"
                  className={`node-tab-btn ${selectedNodeFilter === nodeId ? 'active' : ''}`}
                  onClick={() => setSelectedNodeFilter(nodeId)}
                >
                  <span className="node-tab-dot" />
                  <span>{nodeId}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Compact Overview Summary Banner */}
          <div className="preflight-summary-banner">
            <div className="preflight-summary-left">
              <div className="preflight-path-box">
                <span className="preflight-path-label">AUTO Root:</span>
                <code className="preflight-path-val">
                  {currentReport?.auto_root || '/auto'}
                </code>
              </div>
            </div>

            <div className="preflight-summary-stats">
              <span className="badge badge-neutral mono-cell">
                TOTAL: <strong>{stats.total}</strong>
              </span>
              <span className="badge badge-pass mono-cell">
                OK: <strong>{stats.ok}</strong>
              </span>
              {stats.warn > 0 && (
                <span className="badge badge-fail-zero mono-cell">
                  WARN: <strong>{stats.warn}</strong>
                </span>
              )}
              {stats.missing > 0 && (
                <span className="badge badge-fail mono-cell">
                  MISSING: <strong>{stats.missing}</strong>
                </span>
              )}
            </div>
          </div>

          {/* Search & Status Filters Bar */}
          <div className="preflight-filter-bar">
            <div className="preflight-search-wrap">
              <SearchIcon size={14} className="preflight-search-icon" />
              <input
                type="text"
                className="filter-input preflight-search-input"
                placeholder="Cari tools, suite, atau path..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="preflight-clear-search"
                  onClick={() => setSearchQuery('')}
                  title="Clear Search"
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>

            <div className="preflight-status-filter-pills">
              <button
                type="button"
                className={`filter-pill ${statusFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setStatusFilter('ALL')}
              >
                Semua ({matrixRows.length})
              </button>
              <button
                type="button"
                className={`filter-pill filter-pill-issues ${statusFilter === 'ISSUES' ? 'active' : ''}`}
                onClick={() => setStatusFilter('ISSUES')}
              >
                Issues ({stats.issues})
              </button>
              <button
                type="button"
                className={`filter-pill ${statusFilter === 'OK' ? 'active' : ''}`}
                onClick={() => setStatusFilter('OK')}
              >
                OK ({stats.ok})
              </button>
            </div>
          </div>

          {/* Main Content Area: Desktop Matrix Table & Mobile Reflowed Card List */}
          <div className="preflight-content-scroll">
            {filteredRows.length > 0 ? (
              <>
                {/* Desktop Matrix Table View (hidden on <= 768px) */}
                <div className="table-responsive preflight-table-container preflight-desktop-only">
                  <table className="data-table preflight-table">
                    <thead>
                      <tr>
                        <th style={{ width: '48px', textAlign: 'center' }}>STATUS</th>
                        <th style={{ width: '90px' }}>CATEGORY</th>
                        <th>RESOURCE & PATH</th>
                        <th>DETAIL & ZIP</th>
                        {availableNodes.map((nodeId) => (
                          <th
                            key={nodeId}
                            style={{
                              minWidth: '110px',
                              textAlign: 'center',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {nodeId}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row) => {
                        const statuses = Object.values(row.nodeStatuses).map((s) => s.status);
                        const allOk = statuses.length > 0 && statuses.every((s) => s === 'OK');
                        const hasMissing = statuses.some((s) => s === 'MISSING');
                        const hasWarn = statuses.some((s) => s === 'WARN');

                        return (
                          <tr
                            key={row.key}
                            className={`preflight-row ${
                              hasMissing ? 'row-missing' : hasWarn ? 'row-warn' : ''
                            }`}
                          >
                            <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                              {allOk ? (
                                <CheckCircleIcon size={18} />
                              ) : hasMissing ? (
                                <XCircleIcon size={18} />
                              ) : (
                                <AlertCircleIcon size={18} />
                              )}
                            </td>

                            <td style={{ verticalAlign: 'middle' }}>
                              <span
                                className={`badge badge-xs ${
                                  row.category === 'CTS'
                                    ? 'badge-pc'
                                    : row.category === 'GTS'
                                    ? 'badge-unit'
                                    : row.category === 'STS'
                                    ? 'badge-running'
                                    : 'badge-neutral'
                                }`}
                                style={{ fontWeight: 600 }}
                              >
                                {row.category}
                              </span>
                            </td>

                            <td style={{ verticalAlign: 'middle' }}>
                              <div className="preflight-item-title font-medium" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {row.zip_available && (
                                  <span
                                    className="zip-dot"
                                    title="File ZIP mentah tersedia"
                                  />
                                )}
                                <span>{row.item}</span>
                              </div>
                              <div className="preflight-item-sub mono" title={row.path}>
                                {row.path}
                              </div>
                            </td>

                            <td style={{ verticalAlign: 'middle' }}>
                              <div className="preflight-item-details">
                                {row.details || '-'}
                              </div>
                              {row.zip_available && (
                                <span
                                  className="badge badge-pass badge-xs"
                                  style={{ marginTop: '0.2rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                >
                                  <span className="zip-dot" style={{ width: '5px', height: '5px' }} />
                                  <span>ZIP Mentah</span>
                                </span>
                              )}
                            </td>

                            {availableNodes.map((nodeId) => {
                              const nStatus = row.nodeStatuses[nodeId];
                              const isNodeOk = nStatus?.status === 'OK';
                              const isNodeMissing = !nStatus || nStatus.status === 'MISSING' || nStatus.status === 'WARN';

                              return (
                                <td
                                  key={nodeId}
                                  style={{
                                    textAlign: 'center',
                                    verticalAlign: 'middle',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {isNodeOk ? (
                                    <CheckCircleIcon size={16} />
                                  ) : isNodeMissing && row.can_sync ? (
                                    <button
                                      type="button"
                                      className="btn btn-suite-primary btn-xs btn-sync-tool"
                                      title={`Sinkronkan ${row.item} ke ${nodeId}`}
                                      onClick={() => handleSyncNodeTool(nodeId, row)}
                                    >
                                      <DownloadCloudIcon size={12} />
                                      <span>Sync</span>
                                    </button>
                                  ) : (
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                      -
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List View (Clean reflowed cards, visible only on <= 768px) */}
                <div className="preflight-mobile-list">
                  {filteredRows.map((row) => {
                    const statuses = Object.values(row.nodeStatuses).map((s) => s.status);
                    const allOk = statuses.length > 0 && statuses.every((s) => s === 'OK');
                    const hasMissing = statuses.some((s) => s === 'MISSING');
                    const hasWarn = statuses.some((s) => s === 'WARN');

                    return (
                      <div
                        key={row.key}
                        className={`preflight-mobile-card ${
                          hasMissing ? 'card-missing' : hasWarn ? 'card-warn' : 'card-ok'
                        }`}
                      >
                        <div className="preflight-mcard-header">
                          <div className="preflight-mcard-identity">
                            <span className="preflight-mcard-icon">
                              {allOk ? (
                                <CheckCircleIcon size={16} />
                              ) : hasMissing ? (
                                <XCircleIcon size={16} />
                              ) : (
                                <AlertCircleIcon size={16} />
                              )}
                            </span>
                            <span
                              className={`badge badge-xs ${
                                row.category === 'CTS'
                                  ? 'badge-pc'
                                  : row.category === 'GTS'
                                  ? 'badge-unit'
                                  : row.category === 'STS'
                                  ? 'badge-running'
                                  : 'badge-neutral'
                              }`}
                            >
                              {row.category}
                            </span>
                            <span className="preflight-mcard-title">
                              {row.zip_available && <span className="zip-dot" title="ZIP Mentah" />}
                              {row.item}
                            </span>
                          </div>

                          {row.zip_available && (
                            <span className="badge badge-pass badge-xs preflight-zip-pill">
                              ZIP
                            </span>
                          )}
                        </div>

                        {row.details && (
                          <div className="preflight-mcard-sub">{row.details}</div>
                        )}

                        {/* Node Status Row */}
                        <div className="preflight-mcard-nodes">
                          {availableNodes.map((nodeId) => {
                            const nStatus = row.nodeStatuses[nodeId];
                            const isNodeOk = nStatus?.status === 'OK';
                            const isNodeMissing = !nStatus || nStatus.status === 'MISSING' || nStatus.status === 'WARN';

                            return (
                              <div key={nodeId} className="preflight-mnode-chip">
                                <span className="preflight-mnode-name">{nodeId}</span>
                                {isNodeOk ? (
                                  <span className="badge badge-pass badge-xs">
                                    <CheckCircleIcon size={11} /> OK
                                  </span>
                                ) : isNodeMissing && row.can_sync ? (
                                  <button
                                    type="button"
                                    className="btn btn-suite-primary btn-xs preflight-msync-btn"
                                    onClick={() => handleSyncNodeTool(nodeId, row)}
                                  >
                                    <DownloadCloudIcon size={12} />
                                    <span>Sync</span>
                                  </button>
                                ) : (
                                  <span className="badge badge-fail badge-xs">
                                    <XCircleIcon size={11} /> Missing
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="preflight-empty-box">
                <AlertCircleIcon size={24} color="var(--status-warn-text, #f59e0b)" />
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                  {preflightReports.length === 0
                    ? 'Menunggu data preflight dari node...'
                    : 'Tidak ada item yang sesuai dengan filter saat ini.'}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  onClick={handleRefresh}
                >
                  <RefreshIcon size={12} className={isScanning ? 'spin-anim' : ''} />
                  <span>Pindai Ulang</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer: Streamlined, clean, single close button */}
        <div className="modal-footer preflight-modal-footer">
          <button type="button" className="btn btn-secondary btn-sm preflight-footer-close" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};
