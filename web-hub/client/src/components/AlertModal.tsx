import React, { useEffect, useRef } from 'react';
import { AlertCircleIcon, XCircleIcon, CheckCircleIcon } from './Icons';

export type AlertType = 'warning' | 'error' | 'info' | 'success' | 'confirm';

export interface AlertModalProps {
  isOpen: boolean;
  type?: AlertType;
  title: string;
  message?: string;
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export const AlertModal: React.FC<AlertModalProps> = ({
  isOpen,
  type = 'warning',
  title,
  message,
  details,
  confirmText = 'Mengerti',
  cancelText = 'Batal',
  onConfirm,
  onCancel,
}) => {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      confirmBtnRef.current?.focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onCancel) onCancel();
        else onConfirm();
      } else if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'BUTTON') {
        e.preventDefault();
        onConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onConfirm, onCancel]);

  if (!isOpen) return null;

  const isConfirm = type === 'confirm' || Boolean(onCancel);

  // Status configuration adapted to light & dark theme tokens
  const typeConfig = {
    warning: {
      icon: <AlertCircleIcon size={22} color="var(--status-running-text, #d97706)" />,
      badgeBg: 'var(--status-running-bg, rgba(245, 158, 11, 0.14))',
      badgeBorder: 'var(--status-running-border, rgba(245, 158, 11, 0.3))',
      badgeText: 'var(--status-running-text, #d97706)',
      btnBg: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)',
      btnShadow: '0 4px 14px rgba(217, 119, 6, 0.3)',
      dotColor: 'var(--status-running-text, #f59e0b)',
    },
    error: {
      icon: <XCircleIcon size={22} color="var(--status-fail-text, #dc2626)" />,
      badgeBg: 'var(--status-fail-bg, rgba(239, 68, 68, 0.14))',
      badgeBorder: 'var(--status-fail-border, rgba(239, 68, 68, 0.3))',
      badgeText: 'var(--status-fail-text, #dc2626)',
      btnBg: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
      btnShadow: '0 4px 14px rgba(220, 38, 38, 0.3)',
      dotColor: 'var(--status-fail-text, #ef4444)',
    },
    confirm: {
      icon: <AlertCircleIcon size={22} color="var(--accent-primary, #4f46e5)" />,
      badgeBg: 'var(--accent-subtle, rgba(99, 102, 241, 0.14))',
      badgeBorder: 'var(--accent-border, rgba(99, 102, 241, 0.3))',
      badgeText: 'var(--accent-primary, #4f46e5)',
      btnBg: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)',
      btnShadow: '0 4px 14px rgba(79, 70, 229, 0.3)',
      dotColor: 'var(--accent-primary, #6366f1)',
    },
    success: {
      icon: <CheckCircleIcon size={22} color="var(--status-ready-text, #059669)" />,
      badgeBg: 'var(--status-ready-bg, rgba(16, 185, 129, 0.14))',
      badgeBorder: 'var(--status-ready-border, rgba(16, 185, 129, 0.3))',
      badgeText: 'var(--status-ready-text, #059669)',
      btnBg: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
      btnShadow: '0 4px 14px rgba(5, 150, 105, 0.3)',
      dotColor: 'var(--status-ready-text, #10b981)',
    },
    info: {
      icon: <AlertCircleIcon size={22} color="var(--accent-primary, #0284c7)" />,
      badgeBg: 'var(--accent-subtle, rgba(2, 132, 199, 0.14))',
      badgeBorder: 'var(--accent-border, rgba(2, 132, 199, 0.3))',
      badgeText: 'var(--accent-primary, #0284c7)',
      btnBg: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
      btnShadow: '0 4px 14px rgba(2, 132, 199, 0.3)',
      dotColor: 'var(--accent-primary, #0ea5e9)',
    },
  }[type];

  const messageLines = message ? message.split('\n').filter((l) => l.trim().length > 0) : [];
  const hasBullets = messageLines.some((l) => l.trim().startsWith('•') || l.trim().startsWith('-'));

  return (
    <div
      className="alert-modal-backdrop"
      role="alertdialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (onCancel) onCancel();
          else onConfirm();
        }
      }}
    >
      <div className="alert-modal-card">
        {/* Ambient Top Glow */}
        <div
          className="alert-ambient-glow"
          style={{ background: typeConfig.badgeBg }}
        />

        {/* Content Body */}
        <div className="alert-body">
          <div className="alert-header-row">
            {/* Icon Bubble */}
            <div
              className="alert-icon-wrap"
              style={{
                backgroundColor: typeConfig.badgeBg,
                borderColor: typeConfig.badgeBorder,
              }}
            >
              {typeConfig.icon}
            </div>

            {/* Title & Tag */}
            <div className="alert-title-wrap">
              <h3 className="alert-title">{title}</h3>
              <span
                className="alert-type-badge"
                style={{
                  color: typeConfig.badgeText,
                  backgroundColor: typeConfig.badgeBg,
                  borderColor: typeConfig.badgeBorder,
                }}
              >
                {type.toUpperCase()} NOTICE
              </span>
            </div>
          </div>

          {/* Formatted Message */}
          {message && !hasBullets && (
            <p className="alert-message">{message}</p>
          )}

          {/* Render List items cleanly if formatted */}
          {hasBullets && (
            <div className="alert-details-list">
              {messageLines.map((line, idx) => {
                const isBullet = line.trim().startsWith('•') || line.trim().startsWith('-');
                const cleanLine = isBullet ? line.replace(/^[•\-]\s*/, '') : line;
                if (!isBullet) {
                  return (
                    <p key={idx} className="alert-message" style={{ margin: 0 }}>
                      {cleanLine}
                    </p>
                  );
                }
                return (
                  <div key={idx} className="alert-detail-pill">
                    <span
                      className="alert-bullet-dot"
                      style={{ backgroundColor: typeConfig.dotColor }}
                    />
                    <span>{cleanLine}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Details list if provided explicitly */}
          {details && details.length > 0 && (
            <div className="alert-details-list">
              {details.map((d, i) => (
                <div key={i} className="alert-detail-pill">
                  <span
                    className="alert-bullet-dot"
                    style={{ backgroundColor: typeConfig.dotColor }}
                  />
                  <span>{d}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="alert-footer">
          {isConfirm && (
            <button
              type="button"
              onClick={onCancel}
              className="alert-btn-cancel"
            >
              {cancelText}
            </button>
          )}

          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className="alert-btn-confirm"
            style={{
              background: typeConfig.btnBg,
              boxShadow: typeConfig.btnShadow,
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>

      <style>{`
        .alert-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 99999;
          display: flex;
          align-items: center;
          justify-content: center;
          background-color: rgba(3, 7, 18, 0.65);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          padding: 16px;
          animation: alertFadeIn var(--duration-fast, 180ms) var(--ease-spring, cubic-bezier(0.16, 1, 0.3, 1)) forwards;
        }

        [data-theme="light"] .alert-modal-backdrop {
          background-color: rgba(15, 23, 42, 0.45);
        }

        .alert-modal-card {
          position: relative;
          width: 100%;
          max-width: 520px;
          background-color: var(--bg-surface, #161b22);
          border-radius: var(--radius-xl, 18px);
          border: 1px solid var(--border-subtle, #30363d);
          box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.08);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          color: var(--text-primary, #f0f6fc);
          animation: alertZoomIn var(--duration-normal, 220ms) var(--ease-spring, cubic-bezier(0.16, 1, 0.3, 1)) forwards;
        }

        [data-theme="light"] .alert-modal-card {
          background-color: #ffffff;
          border: 1px solid var(--border-subtle, #d0d7de);
          box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.08);
          color: #1f2328;
        }

        .alert-ambient-glow {
          position: absolute;
          top: -45px;
          left: 50%;
          transform: translateX(-50%);
          width: 280px;
          height: 90px;
          filter: blur(40px);
          border-radius: 50%;
          pointer-events: none;
          opacity: 0.85;
        }

        .alert-body {
          padding: 22px 24px 18px 24px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          position: relative;
          z-index: 1;
        }

        .alert-header-row {
          display: flex;
          align-items: flex-start;
          gap: 14px;
        }

        .alert-icon-wrap {
          width: 44px;
          height: 44px;
          border-radius: var(--radius-lg, 12px);
          border: 1px solid;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }

        .alert-title-wrap {
          display: flex;
          flex-direction: column;
          gap: 3px;
          flex: 1;
        }

        .alert-title {
          margin: 0;
          font-size: 16.5px;
          font-weight: 700;
          letter-spacing: -0.015em;
          color: var(--text-primary, #ffffff);
          line-height: 1.35;
        }

        [data-theme="light"] .alert-title {
          color: #1f2328;
        }

        .alert-type-badge {
          display: inline-block;
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 2px 8px;
          border-radius: var(--radius-sm, 6px);
          border: 1px solid;
          width: fit-content;
        }

        .alert-message {
          margin: 0;
          font-size: 13.5px;
          line-height: 1.6;
          color: var(--text-secondary, #8b949e);
          white-space: normal;
          font-weight: 400;
        }

        [data-theme="light"] .alert-message {
          color: #57606a;
        }

        .alert-details-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 220px;
          overflow-y: auto;
          margin-top: 2px;
        }

        .alert-detail-pill {
          padding: 8px 12px;
          border-radius: var(--radius-md, 10px);
          background-color: var(--bg-subtle, rgba(255, 255, 255, 0.04));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
          font-size: 12.5px;
          font-family: var(--font-mono, monospace);
          color: var(--text-primary, #f0f6fc);
          display: flex;
          align-items: center;
          gap: 8px;
          word-break: break-word;
        }

        [data-theme="light"] .alert-detail-pill {
          background-color: var(--bg-subtle, #f6f8fa);
          border: 1px solid var(--border-subtle, #d0d7de);
          color: #1f2328;
        }

        .alert-bullet-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }

        .alert-footer {
          padding: 12px 24px;
          background-color: var(--bg-subtle, rgba(0, 0, 0, 0.2));
          border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
        }

        [data-theme="light"] .alert-footer {
          background-color: #f6f8fa;
          border-top: 1px solid var(--border-subtle, #d0d7de);
        }

        .alert-btn-cancel {
          padding: 8px 18px;
          border-radius: var(--radius-md, 10px);
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary, #8b949e);
          background-color: transparent;
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
          cursor: pointer;
          min-height: 38px;
          transition: all var(--duration-fast, 120ms) var(--ease-spring, ease);
        }

        .alert-btn-cancel:hover {
          background-color: var(--bg-hover, rgba(255, 255, 255, 0.08));
          color: var(--text-primary, #ffffff);
        }

        .alert-btn-confirm {
          padding: 8px 22px;
          border-radius: var(--radius-md, 10px);
          font-size: 13px;
          font-weight: 600;
          color: #ffffff;
          border: none;
          cursor: pointer;
          min-height: 38px;
          transition: all var(--duration-fast, 120ms) var(--ease-spring, ease);
        }

        .alert-btn-confirm:hover {
          transform: translateY(-1px);
          filter: brightness(1.1);
        }

        .alert-btn-confirm:active, .alert-btn-cancel:active {
          transform: scale(0.98);
        }

        @keyframes alertFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes alertZoomIn {
          from { opacity: 0; transform: scale(0.96) translateY(4px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }

        @media (max-width: 480px) {
          .alert-modal-card {
            max-width: 100%;
            border-radius: var(--radius-lg, 14px);
          }
          .alert-body {
            padding: 16px 16px 14px 16px;
          }
          .alert-footer {
            padding: 10px 16px;
            flex-direction: column-reverse;
            gap: 8px;
          }
          .alert-btn-cancel, .alert-btn-confirm {
            width: 100%;
            justify-content: center;
          }
        }
      `}</style>
    </div>
  );
};
