import React, { useState, useMemo } from 'react';
import { DeviceItem } from '../hooks/useFleetWebSocket';
import { LampIcon, PlayIcon, RefreshIcon } from './Icons';

interface DeviceTableViewProps {
  devices: DeviceItem[];
  selectedSerials: string[];
  onToggleSelect: (serial: string) => void;
  onSelectAll: (serials: string[]) => void;
  onOpenRunModal: (serials: string[]) => void;
  onToggleLamp: (pcId: string, serial: string, brighten: boolean) => void;
  onResetBusy: (pcId: string) => void;
}

export const DeviceTableView: React.FC<DeviceTableViewProps> = ({
  devices,
  selectedSerials,
  onToggleSelect,
  onSelectAll,
  onOpenRunModal,
  onToggleLamp,
  onResetBusy,
}) => {
  const [filterType, setFilterType] = useState<'all' | 'user' | 'userdebug' | 'busy'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      if (filterType === 'user' && d.is_userdebug) return false;
      if (filterType === 'userdebug' && !d.is_userdebug) return false;
      if (filterType === 'busy' && !d.busy) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          d.model.toLowerCase().includes(q) ||
          d.serial.toLowerCase().includes(q) ||
          d.pcId.toLowerCase().includes(q) ||
          d.pda.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [devices, filterType, searchQuery]);

  const allFilteredSelected =
    filteredDevices.length > 0 &&
    filteredDevices.every((d) => selectedSerials.includes(d.serial));

  const handleSelectAllChange = () => {
    if (allFilteredSelected) {
      onSelectAll([]);
    } else {
      onSelectAll(filteredDevices.map((d) => d.serial));
    }
  };

  return (
    <section className="card-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span>Connected Fleet Devices</span>
          <span className="badge badge-ready">{devices.length} Total</span>
        </div>

        <div className="panel-controls">
          <input
            type="text"
            className="form-input"
            placeholder="Search model, serial, PC..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: '220px' }}
          />

          <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
            {(['all', 'user', 'userdebug', 'busy'] as const).map((type) => (
              <button
                key={type}
                className={`btn ${filterType === type ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '0.375rem 0.625rem', fontSize: '0.75rem', minHeight: '34px' }}
                onClick={() => setFilterType(type)}
              >
                {type.toUpperCase()}
              </button>
            ))}
          </div>

          {selectedSerials.length > 0 && (
            <button
              className="btn btn-primary"
              onClick={() => onOpenRunModal(selectedSerials)}
            >
              <PlayIcon size={14} />
              <span>Run Suite ({selectedSerials.length})</span>
            </button>
          )}
        </div>
      </div>

      {filteredDevices.length === 0 ? (
        <div className="state-empty">
          <p className="state-title">No Devices Detected</p>
          <p style={{ fontSize: '0.8125rem' }}>
            Ensure Android devices are connected via USB with ADB debugging enabled and the Agent Bridge is running on the workstation.
          </p>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={handleSelectAllChange}
                    aria-label="Select all visible devices"
                  />
                </th>
                <th>Node PC</th>
                <th>Model</th>
                <th>Serial</th>
                <th>Build Type</th>
                <th>OS / SPL</th>
                <th>PDA / CSC</th>
                <th>IP Address</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map((d) => {
                const isSelected = selectedSerials.includes(d.serial);
                return (
                  <tr key={d.serial} style={{ backgroundColor: isSelected ? 'var(--bg-active)' : undefined }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect(d.serial)}
                        aria-label={`Select device ${d.serial}`}
                      />
                    </td>
                    <td>
                      <span className="badge badge-pc">{d.pcId}</span>
                    </td>
                    <td>
                      <strong>{d.model || 'Unknown'}</strong>
                    </td>
                    <td className="mono-cell">{d.serial}</td>
                    <td>
                      <span className={`badge ${d.is_userdebug ? 'badge-fail' : 'badge-pass'}`}>
                        {d.is_userdebug ? 'USERDEBUG' : 'USER'}
                      </span>
                    </td>
                    <td>
                      <div>Android {d.android || '-'}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>SPL: {d.security_patch || '-'}</div>
                    </td>
                    <td className="mono-cell" style={{ fontSize: '0.725rem' }}>
                      <div>{d.pda || '-'}</div>
                      <div style={{ color: 'var(--text-secondary)' }}>{d.csc || '-'}</div>
                    </td>
                    <td className="mono-cell">{d.ip || 'USB'}</td>
                    <td>
                      {d.busy ? (
                        <span className="badge badge-busy" title={d.busy_reason || 'In active test run'}>
                          BUSY: {d.busy_reason || 'Running'}
                        </span>
                      ) : d.state === 'device' ? (
                        <span className="badge badge-ready">READY</span>
                      ) : (
                        <span className="badge badge-offline">{d.state.toUpperCase()}</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.375rem' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.5rem' }}
                          onClick={() => onToggleLamp(d.pcId, d.serial, true)}
                          title="Brighten screen lamp for physical identification"
                        >
                          <LampIcon size={13} />
                        </button>

                        {d.busy && (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '0.25rem 0.5rem' }}
                            onClick={() => onResetBusy(d.pcId)}
                            title="Reset busy state lock"
                          >
                            <RefreshIcon size={13} />
                          </button>
                        )}

                        <button
                          className="btn btn-primary"
                          style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
                          onClick={() => onOpenRunModal([d.serial])}
                          disabled={d.busy}
                        >
                          <PlayIcon size={12} />
                          <span>Run</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
