import React, { useState, useEffect } from 'react';
import {
  RefreshIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  CloseIcon,
} from './Icons';

export interface ActiveTransferItem {
  id: string;
  type: 'tools' | 'firmware';
  sourceNode: string;
  targetNode: string;
  filename: string;
  totalBytes: number;
  transferredBytes: number;
  speedMBps: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  progress: number; // 0 to 100
}

interface FloatingTransferModalProps {
  transfers: ActiveTransferItem[];
  onPauseResume?: (id: string) => void;
  onCancel?: (id: string) => void;
  onClose?: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export const FloatingTransferModal: React.FC<FloatingTransferModalProps> = ({
  transfers,
  onPauseResume,
  onCancel,
  onClose,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  if (!transfers || transfers.length === 0) {
    return null;
  }

  const activeCount = transfers.filter((t) => t.status === 'running' || t.status === 'paused').length;
  const avgProgress =
    transfers.length > 0
      ? Math.round(transfers.reduce((acc, t) => acc + t.progress, 0) / transfers.length)
      : 0;

  const firstTransfer = transfers[0];
  const isFirmware = firstTransfer?.type === 'firmware' || firstTransfer?.filename.includes('.zip') || firstTransfer?.filename.includes('OXM');

  return (
    <div className="floating-transfer-container">
      {/* Accordion Header */}
      <div
        className="floating-transfer-header"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
      >
        <div className="floating-transfer-header-left">
          <RefreshIcon size={15} className={activeCount > 0 ? 'spin-anim' : ''} />
          <span className="floating-transfer-title">
            {isFirmware ? 'Transfer Firmware' : 'Transfer Tools'}
          </span>
          <span className="floating-transfer-count-badge">
            {activeCount} proses ({avgProgress}%)
          </span>
        </div>

        <div className="floating-transfer-header-right" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn-icon btn-xs"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
          </button>
          {onClose && (
            <button
              type="button"
              className="btn-icon btn-xs"
              onClick={onClose}
              title="Close Transfer Panel"
            >
              <CloseIcon size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Accordion Body */}
      {isExpanded && (
        <div className="floating-transfer-body">
          {transfers.map((item) => {
            const isPaused = item.status === 'paused';
            return (
              <div key={item.id} className="transfer-card">
                {/* Node Source -> Target & Action Buttons */}
                <div className="transfer-card-top">
                  <div className="transfer-nodes-flow">
                    <span className="transfer-node-pill">{item.sourceNode || 'Endri'}</span>
                    <span className="transfer-flow-arrow">→</span>
                    <span className="transfer-node-pill transfer-node-target">
                      {item.targetNode || 'ubuntu-gba-pro'}
                    </span>
                  </div>

                  <div className="transfer-card-controls">
                    <span className="transfer-pct-label">{Math.round(item.progress)}%</span>
                    {onPauseResume && (
                      <button
                        type="button"
                        className="transfer-ctrl-btn"
                        onClick={() => onPauseResume(item.id)}
                        title={isPaused ? 'Resume Transfer' : 'Pause Transfer'}
                      >
                        {isPaused ? <PlayIcon size={12} /> : <PauseIcon size={12} />}
                      </button>
                    )}
                    {onCancel && (
                      <button
                        type="button"
                        className="transfer-ctrl-btn"
                        onClick={() => onCancel(item.id)}
                        title="Cancel Transfer"
                      >
                        <SquareIcon size={11} />
                      </button>
                    )}
                  </div>
                </div>

                {/* File Information */}
                <div className="transfer-file-row">
                  <FileIcon size={13} className="transfer-file-icon" />
                  <span className="transfer-filename" title={item.filename}>
                    {item.filename}
                  </span>
                </div>

                {/* Progress Bar */}
                <div className="transfer-progress-track">
                  <div
                    className="transfer-progress-bar"
                    style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                  />
                </div>

                {/* Speed and Size Metrics */}
                <div className="transfer-metrics-row">
                  <span className="transfer-speed">
                    {isPaused ? 'Paused' : `${item.speedMBps.toFixed(1)} MB/s`}
                  </span>
                  <span className="transfer-sizes">
                    {formatBytes(item.transferredBytes)} / {formatBytes(item.totalBytes)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
