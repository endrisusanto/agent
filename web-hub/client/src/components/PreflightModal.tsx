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

interface PreflightModalProps {
  isOpen: boolean;
  onClose: () => void;
  preflightReports: PreflightReport[];
  bridges: BridgeInfo[];
  onTriggerScan: (pcId?: string) => void;
}

interface FlattenedPreflightItem extends PreflightItem {
  pcId: string;
  autoRoot: string;
}

export const PreflightModal: React.FC<PreflightModalProps> = ({
  isOpen,
  onClose,
  preflightReports,
  bridges,
  onTriggerScan,
}) => {
  const [selectedNodeFilter, setSelectedNodeFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ISSUES' | 'OK'>('ALL');
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

  // Flatten items with node info
  const allItems: FlattenedPreflightItem[] = useMemo(() => {
    const list: FlattenedPreflightItem[] = [];
    preflightReports.forEach((rep) => {
      rep.items.forEach((item) => {
        list.push({
          ...item,
          pcId: rep.pc_id,
          autoRoot: rep.auto_root,
        });
      });
    });
    return list;
  }, [preflightReports]);

  // Filter items based on selected node, search query, and status
  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      if (selectedNodeFilter !== 'ALL' && item.pcId !== selectedNodeFilter) {
        return false;
      }
      if (statusFilter === 'ISSUES' && item.status === 'OK') {
        return false;
      }
      if (statusFilter === 'OK' && item.status !== 'OK') {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesCategory = item.category.toLowerCase().includes(q);
        const matchesItem = item.item.toLowerCase().includes(q);
        const matchesPath = item.path.toLowerCase().includes(q);
        const matchesDetails = (item.details || '').toLowerCase().includes(q);
        const matchesPcId = item.pcId.toLowerCase().includes(q);
        return matchesCategory || matchesItem || matchesPath || matchesDetails || matchesPcId;
      }
      return true;
    });
  }, [allItems, selectedNodeFilter, searchQuery, statusFilter]);

  // Summary counts
  const stats = useMemo(() => {
    const targetItems = selectedNodeFilter === 'ALL'
      ? allItems
      : allItems.filter((i) => i.pcId === selectedNodeFilter);
    const okCount = targetItems.filter((i) => i.status === 'OK').length;
    const warnCount = targetItems.filter((i) => i.status === 'WARN').length;
    const missingCount = targetItems.filter((i) => i.status === 'MISSING').length;
    return {
      total: targetItems.length,
      ok: okCount,
      warn: warnCount,
      missing: missingCount,
      issues: warnCount + missingCount,
    };
  }, [allItems, selectedNodeFilter]);

  if (!isOpen) return null;

  const handleRefresh = () => {
    setIsScanning(true);
    onTriggerScan(selectedNodeFilter === 'ALL' ? undefined : selectedNodeFilter);
    setTimeout(() => setIsScanning(false), 1200);
  };

  const currentReport = preflightReports.find((r) => r.pc_id === selectedNodeFilter) || preflightReports[0];

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
                  {currentReport?.auto_root || '/run/media/endri-pro/BINARY_HDD/AUTO'}
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
                Semua ({allItems.length})
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

          {/* Preflight Data Table */}
          <div className="table-responsive preflight-table-container">
            <table className="data-table preflight-table">
              <thead>
                <tr>
                  <th style={{ width: '48px', textAlign: 'center' }}>STATUS</th>
                  <th style={{ width: '100px' }}>CATEGORY</th>
                  <th>RESOURCE & PATH</th>
                  <th>DETAIL & ZIP STATUS</th>
                  <th style={{ width: '180px', minWidth: '160px', textAlign: 'center', whiteSpace: 'nowrap' }}>NODE</th>
                  <th style={{ width: '120px', textAlign: 'center' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length > 0 ? (
                  filteredItems.map((item, idx) => {
                    const isOk = item.status === 'OK';
                    const isWarn = item.status === 'WARN';
                    const isMissing = item.status === 'MISSING';

                    return (
                      <tr
                        key={`${item.pcId}-${item.category}-${item.item}-${idx}`}
                        className={`preflight-row ${isMissing ? 'row-missing' : isWarn ? 'row-warn' : ''}`}
                      >
                        {/* Status Icon */}
                        <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                          {isOk ? (
                            <CheckCircleIcon size={18} />
                          ) : isWarn ? (
                            <AlertCircleIcon size={18} />
                          ) : (
                            <XCircleIcon size={18} />
                          )}
                        </td>

                        {/* Category */}
                        <td style={{ verticalAlign: 'middle' }}>
                          <span
                            className={`badge badge-xs ${
                              item.category === 'CTS'
                                ? 'badge-pc'
                                : item.category === 'GTS'
                                ? 'badge-unit'
                                : item.category === 'STS'
                                ? 'badge-running'
                                : 'badge-neutral'
                            }`}
                            style={{ fontWeight: 600 }}
                          >
                            {item.category}
                          </span>
                        </td>

                        {/* Resource & Path */}
                        <td style={{ verticalAlign: 'middle' }}>
                          <div className="preflight-item-title font-medium">
                            {item.item}
                          </div>
                          <div className="preflight-item-sub mono" title={item.path}>
                            {item.path}
                          </div>
                        </td>

                        {/* Details & Zip Status */}
                        <td style={{ verticalAlign: 'middle' }}>
                          <div className="preflight-item-details">
                            {item.details || '-'}
                          </div>
                          {item.zip_available && (
                            <span className="badge badge-pass badge-xs" style={{ marginTop: '0.2rem', display: 'inline-block' }}>
                              📦 Zip Available
                            </span>
                          )}
                        </td>

                        {/* Node Badge (Right Column - Memanjang ke kanan) */}
                        <td style={{ textAlign: 'center', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                          <span
                            className="badge badge-pc badge-xs mono-cell"
                            style={{
                              whiteSpace: 'nowrap',
                              display: 'inline-block',
                              padding: '0.28rem 0.75rem',
                              fontSize: '0.75rem',
                              letterSpacing: '0.02em',
                            }}
                            title={`Workstation Node: ${item.pcId}`}
                          >
                            {item.pcId}
                          </span>
                        </td>

                        {/* Action / Sync Shortcut */}
                        <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                          {isMissing && item.can_sync ? (
                            <button
                              type="button"
                              className="btn btn-suite-primary btn-xs btn-sync-tool"
                              title={`Sinkronkan ${item.item} dari node donor / Hub cache`}
                              onClick={() => {
                                alert(`Memulai proses sinkronisasi untuk ${item.item} pada node ${item.pcId}...`);
                              }}
                            >
                              <DownloadCloudIcon size={12} />
                              <span>Sync Tool</span>
                            </button>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="empty-state-cell" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
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
                            <span>Node ini belum memiliki paket CTS / GTS / STS. Letakkan file zip suite di folder AUTO atau sinkronkan dari node donor.</span>
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
        <div className="modal-footer preflight-modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1.25rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Menampilkan {filteredItems.length} dari {allItems.length} item diagnostik across {availableNodes.length} node.
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
};
