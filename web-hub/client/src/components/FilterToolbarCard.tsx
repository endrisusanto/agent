import React from 'react';
import { SearchIcon } from './Icons';
import { BridgeInfo } from '../hooks/useFleetWebSocket';

export interface FilterToolbarCardProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  selectedPcId: string;
  onPcIdChange: (pcId: string) => void;
  selectedMode: 'all' | 'user' | 'userdebug' | 'busy';
  onModeChange: (mode: 'all' | 'user' | 'userdebug' | 'busy') => void;
  bridges: BridgeInfo[];
  activeJobsCount: number;
  onToggleTerminalLogs?: () => void;
}

export const FilterToolbarCard: React.FC<FilterToolbarCardProps> = ({
  searchQuery,
  onSearchChange,
  selectedPcId,
  onPcIdChange,
  selectedMode,
  onModeChange,
  bridges,
  activeJobsCount,
  onToggleTerminalLogs,
}) => {
  return (
    <div className="filter-card-bar">
      {/* Search Input Box */}
      <div className="filter-search-wrap">
        <SearchIcon size={15} className="filter-search-icon" />
        <input
          type="text"
          className="filter-search-input"
          placeholder="Cari serial, model, PC ID..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="filter-clear-btn"
            onClick={() => onSearchChange('')}
            title="Bersihkan pencarian"
          >
            ✕
          </button>
        )}
      </div>

      {/* Workstation PC Dropdown */}
      <div className="filter-select-wrap">
        <select
          className="filter-select"
          value={selectedPcId}
          onChange={(e) => onPcIdChange(e.target.value)}
        >
          <option value="ALL">
            Workstation ({bridges.length > 0 ? bridges.length : 1})
          </option>
          {bridges.map((b) => (
            <option key={b.pcId} value={b.pcId}>
              {b.pcId}
            </option>
          ))}
        </select>
      </div>

      {/* Mode Dropdown */}
      <div className="filter-select-wrap">
        <select
          className="filter-select"
          value={selectedMode}
          onChange={(e) => onModeChange(e.target.value as 'all' | 'user' | 'userdebug' | 'busy')}
        >
          <option value="all">Device Mode</option>
          <option value="user">User</option>
          <option value="userdebug">Userdebug</option>
          <option value="busy">Busy</option>
        </select>
      </div>

      {/* Terminal Logs Action Button */}
      <button
        type="button"
        className="filter-terminal-btn"
        onClick={onToggleTerminalLogs}
        title="Buka Live Terminal Logs"
      >
        <span className="terminal-prompt">&gt;_</span>
        <span>Terminal Logs</span>
        {activeJobsCount > 0 && (
          <span className="badge badge-running badge-xs">{activeJobsCount}</span>
        )}
      </button>
    </div>
  );
};
