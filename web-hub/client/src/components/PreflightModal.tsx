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
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal-dialog preflight-modal-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="modal-header preflight-modal-header">
          <div className="preflight-header-left">
            <div className="preflight-title-wrap">
              <PreflightIcon size={20} className="preflight-modal-icon" />
              <div>
                <h2 className="modal-title" style={{ fontSize: '1.05rem', margin: 0 }}>
                  Preflight & Diagnostic Check
                </h2>
                <p className="modal-subtitle" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
                  Verifikasi kesiapan Tradefed Tools (CTS, GTS, STS) dan AUTO Root folder per node.
                </p>
              </div>
            </div>
          </div>

          <div className="preflight-header-actions">
            <button
              type="button"
              className={`btn btn-secondary btn-sm ${isScanning ? 'btn-scanning' : ''}`}
              onClick={handleRefresh}
              title="Pindai Ulang Status Preflight Real-time"
            >
              <RefreshIcon size={14} className={isScanning ? 'spin-anim' : ''} />
              <span>{isScanning ? 'Memindai...' : 'Rescan'}</span>
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

          {/* Overview Summary Banner */}
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
              <span className="badge badge-neutral mono-cell" title="Total Scanned Items">
                TOTAL: <strong>{stats.total}</strong>
              </span>
              <span className="badge badge-pass mono-cell" title="Items Ready">
                OK: <strong>{stats.ok}</strong>
              </span>
              {stats.warn > 0 && (
                <span className="badge badge-fail-zero mono-cell" title="Warnings">
                  WARN: <strong>{stats.warn}</strong>
                </span>
              )}
              {stats.missing > 0 && (
                <span className="badge badge-fail mono-cell" title="Missing Items">
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
                placeholder="Cari tools, suite (CTS/GTS/STS), versi, atau path..."
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

          {/* Preflight Data Table (Matrix matching image with Node columns) */}
          <div className="table-responsive preflight-table-container">
            <table className="data-table preflight-table">
              <thead>
                <tr>
                  <th style={{ width: '48px', textAlign: 'center' }}>STATUS</th>
                  <th style={{ width: '100px' }}>CATEGORY</th>
                  <th>RESOURCE & PATH</th>
                  <th>DETAIL & ZIP STATUS</th>
                  {availableNodes.map((nodeId) => (
                    <th
                      key={nodeId}
                      style={{
                        minWidth: '120px',
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
                {filteredRows.length > 0 ? (
                  filteredRows.map((row) => {
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
                        {/* Overall Status Icon */}
                        <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                          {allOk ? (
                            <CheckCircleIcon size={18} />
                          ) : hasMissing ? (
                            <XCircleIcon size={18} />
                          ) : (
                            <AlertCircleIcon size={18} />
                          )}
                        </td>

                        {/* Category */}
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

                        {/* Resource & Path */}
                        <td style={{ verticalAlign: 'middle' }}>
                          <div className="preflight-item-title font-medium" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            {row.zip_available && (
                              <span
                                className="zip-dot"
                                title="File ZIP mentah tersedia di workstation"
                              />
                            )}
                            <span>{row.item}</span>
                          </div>
                          <div className="preflight-item-sub mono" title={row.path}>
                            {row.path}
                          </div>
                        </td>

                        {/* Details & Zip Status */}
                        <td style={{ verticalAlign: 'middle' }}>
                          <div className="preflight-item-details">
                            {row.details || '-'}
                          </div>
                          {row.zip_available && (
                            <span
                              className="badge badge-pass badge-xs"
                              style={{ marginTop: '0.2rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                              title="File ZIP mentah tersedia di workstation"
                            >
                              <span className="zip-dot" style={{ width: '5px', height: '5px' }} />
                              <span>ZIP Mentah</span>
                            </span>
                          )}
                        </td>

                        {/* Node Specific Columns (e.g. Node 1, Node 2...) */}
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
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={4 + availableNodes.length}
                      className="empty-state-cell"
                      style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem' }}>
                        <AlertCircleIcon size={24} color="var(--status-warn-text, #f59e0b)" />
                        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                          {preflightReports.length === 0
                            ? '⏳ Menunggu data preflight dari node agent-bridge...'
                            : selectedNodeFilter === 'ALL'
                            ? 'Tidak ada item diagnostik yang sesuai dengan filter saat ini.'
                            : `Folder pada node "${selectedNodeFilter}" masih kosong atau belum terpasang test suite.`}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '440px', lineHeight: 1.4 }}>
                          {selectedNodeFilter !== 'ALL' && (
                            <span>
                              Node ini belum memiliki paket CTS / GTS / STS. Letakkan file zip suite di folder AUTO atau klik Sync untuk mengambil dari node donor.
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          style={{ marginTop: '0.35rem' }}
                          onClick={handleRefresh}
                        >
                          <RefreshIcon size={12} className={isScanning ? 'spin-anim' : ''} />
                          <span>{isScanning ? 'Memindai...' : 'Pindai Ulang Folder Node'}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modal Footer */}
        <div
          className="modal-footer preflight-modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.75rem 1.25rem',
          }}
        >
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Menampilkan {filteredRows.length} dari {matrixRows.length} item across{' '}
            {availableNodes.length} workstation node.
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};
