import React, { useState } from 'react';
import {
  RefreshIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileIcon,
  PauseIcon,
  PlayIcon,
  SquareIcon,
  CloseIcon,
  CheckCircleIcon,
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
  status: 'running' | 'paused' | 'extracting' | 'completed' | 'cancelled' | 'failed';
  progress: number; // 0 to 100
}

interface FloatingTransferModalProps {
  transfers: ActiveTransferItem[];
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onPauseResume?: (id: string) => void;
  onCancel?: (id: string) => void;
  onClose?: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const STEPS = [
  { key: 'init', label: 'Inisiasi' },
  { key: 'download', label: 'Unduh ZIP' },
  { key: 'extract', label: 'Ekstraksi' },
  { key: 'ready', label: 'Selesai' },
];

function getStepIndex(item: ActiveTransferItem): number {
  if (item.status === 'completed') return 3;
  if (item.status === 'extracting' || (item.status === 'running' && item.progress >= 99)) return 2;
  if (item.status === 'running' && (item.transferredBytes > 0 || item.progress > 0.5)) return 1;
  return 0;
}

export const FloatingTransferModal: React.FC<FloatingTransferModalProps> = ({
  transfers,
  isExpanded: controlledExpanded,
  onToggleExpand,
  onPauseResume,
  onCancel,
  onClose,
}) => {
  const [internalExpanded, setInternalExpanded] = useState<boolean>(true);
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const handleToggle = onToggleExpand || (() => setInternalExpanded(!internalExpanded));

  if (!transfers || transfers.length === 0) {
    return null;
  }

  const activeCount = transfers.filter((t) => t.status === 'running' || t.status === 'paused' || t.status === 'extracting').length;
  const avgProgress =
    transfers.length > 0
      ? Math.round(transfers.reduce((acc, t) => acc + t.progress, 0) / transfers.length)
      : 0;

  const firstTransfer = transfers[0];
  const isFirmware = firstTransfer?.type === 'firmware' || firstTransfer?.filename.includes('OXM');

  return (
    <div className="floating-transfer-container">
      {/* Accordion Header */}
      <div
        className="floating-transfer-header"
        onClick={handleToggle}
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
            onClick={handleToggle}
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
            const isCompleted = item.status === 'completed';
            const isFailed = item.status === 'failed';
            const currentStepIdx = getStepIndex(item);

            return (
              <div key={item.id} className={`transfer-card ${isCompleted ? 'transfer-card-completed' : ''}`}>
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
                    <span className={`transfer-pct-label ${isCompleted ? 'text-pass' : ''}`}>
                      {isCompleted ? '100%' : `${Math.round(item.progress)}%`}
                    </span>
                    {!isCompleted && onPauseResume && (
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
                        title={isCompleted ? 'Remove from list' : 'Cancel Transfer'}
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

                {/* Stepper Breadcrumb */}
                <div className="transfer-stepper-row">
                  {STEPS.map((step, idx) => {
                    const isStepDone = currentStepIdx > idx || isCompleted;
                    const isStepActive = currentStepIdx === idx && !isCompleted && !isFailed;
                    return (
                      <React.Fragment key={step.key}>
                        <div
                          className={`transfer-step-item ${
                            isStepDone
                              ? 'step-done'
                              : isStepActive
                              ? 'step-active'
                              : 'step-pending'
                          }`}
                        >
                          <span className="step-bullet">
                            {isStepDone ? '✓' : idx + 1}
                          </span>
                          <span className="step-label">{step.label}</span>
                        </div>
                        {idx < STEPS.length - 1 && (
                          <div
                            className={`transfer-step-connector ${
                              currentStepIdx > idx ? 'connector-done' : ''
                            }`}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>

                {/* Progress Bar */}
                <div className="transfer-progress-track">
                  <div
                    className={`transfer-progress-bar ${isCompleted ? 'bar-completed' : isPaused ? 'bar-paused' : ''}`}
                    style={{ width: `${Math.min(100, Math.max(0, item.progress))}%` }}
                  />
                </div>

                {/* Speed and Size Metrics */}
                <div className="transfer-metrics-row">
                  <span className="transfer-speed">
                    {isCompleted
                      ? '✓ Terpasang & Siap'
                      : isPaused
                      ? 'Paused'
                      : item.status === 'extracting'
                      ? 'Ekstraksi archive...'
                      : `${item.speedMBps > 0 ? item.speedMBps.toFixed(1) : '0.0'} MB/s`}
                  </span>
                  <span className="transfer-sizes">
                    {formatBytes(item.transferredBytes)} / {item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'Menghitung...'}
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
