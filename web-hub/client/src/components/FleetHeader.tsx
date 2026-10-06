import React from 'react';
import { ServerIcon, SmartphoneIcon, PlayIcon, SunIcon, MoonIcon, PreflightIcon } from './Icons';

interface FleetHeaderProps {
  onlineBridgesCount: number;
  devicesCount: number;
  activeJobsCount: number;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenPreflight: () => void;
  preflightIssueCount?: number;
}

export const FleetHeader: React.FC<FleetHeaderProps> = ({
  onlineBridgesCount,
  devicesCount,
  activeJobsCount,
  theme,
  onToggleTheme,
  onOpenPreflight,
  preflightIssueCount = 0,
}) => {
  return (
    <header className="header-bar">
      <div className="header-brand-wrap">
        <div className="header-brand">
          <div className="brand-icon">
            <img src="/logo.png" alt="GBA Logo" style={{ width: '28px', height: '28px', objectFit: 'contain' }} />
          </div>
          <div>
            <h1 className="brand-title">GBA Agentic Hub</h1>
            <p className="brand-subtitle">Distributed Android Test Suite Automation</p>
          </div>
        </div>
      </div>

      <div className="header-actions">
        <div className="header-actions-group">
          <div className="metric-chip" title="Active bridge nodes connected">
            <ServerIcon size={14} />
            <span>Nodes: <strong>{onlineBridgesCount}</strong></span>
          </div>

          <div className="metric-chip" title="Total ADB devices online">
            <SmartphoneIcon size={14} />
            <span>Devices: <strong>{devicesCount}</strong></span>
          </div>

          <div className="metric-chip" title="Active running test suites">
            <PlayIcon size={14} />
            <span>Jobs: <strong>{activeJobsCount}</strong></span>
          </div>

          <button
            className="btn btn-secondary btn-preflight-shortcut"
            onClick={onOpenPreflight}
            title="Buka Diagnostic & Preflight Check Modal"
            aria-label="Preflight Check"
            style={{ position: 'relative' }}
          >
            <PreflightIcon size={16} />
            <span className="btn-text-desktop">Preflight</span>
            {preflightIssueCount > 0 && (
              <span className="preflight-badge-dot" title={`${preflightIssueCount} issue(s) detected`} />
            )}
          </button>

          <button
            className="btn btn-secondary btn-theme-toggle"
            onClick={onToggleTheme}
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`}
            aria-label="Toggle visual theme"
          >
            {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>
        </div>
      </div>
    </header>
  );
};
