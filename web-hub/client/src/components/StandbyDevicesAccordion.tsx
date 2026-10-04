import React, { useState, useMemo } from 'react';
import { DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, LampIcon, PlayIcon, RefreshIcon } from './Icons';

interface StandbyDevicesAccordionProps {
  devices: DeviceItem[];
  selectedSerials: string[];
  onToggleSelect: (serial: string) => void;
  onSelectAll: (serials: string[]) => void;
  onDirectRunSuite: (testType: string, serials: string[]) => void;
  onToggleLamp: (pcId: string, serial: string, brighten: boolean) => void;
  onResetBusy: (pcId: string) => void;
}

export const StandbyDevicesAccordion: React.FC<StandbyDevicesAccordionProps> = ({
  devices,
  selectedSerials,
  onToggleSelect,
  onSelectAll,
  onDirectRunSuite,
  onToggleLamp,
  onResetBusy,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [filterType, setFilterType] = useState<'all' | 'user' | 'userdebug' | 'busy'>('all');
  const [selectedModelFilter, setSelectedModelFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [wifiModalOpen, setWifiModalOpen] = useState(false);
  const [wifiSsid, setWifiSsid] = useState('GBA-TEST-WIFI');
  const [wifiPassword, setWifiPassword] = useState('test12345');

  // Compute model counts for model pills
  const modelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    devices.forEach((d) => {
      const model = d.model || 'UNKNOWN';
      counts[model] = (counts[model] || 0) + 1;
    });
    return counts;
  }, [devices]);

  const sortedModels = useMemo(() => {
    return Object.keys(modelCounts).sort();
  }, [modelCounts]);

  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      if (filterType === 'user' && d.is_userdebug) return false;
      if (filterType === 'userdebug' && !d.is_userdebug) return false;
      if (filterType === 'busy' && !d.busy) return false;

      if (selectedModelFilter !== 'ALL' && d.model !== selectedModelFilter) {
        return false;
      }

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
  }, [devices, filterType, selectedModelFilter, searchQuery]);

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

  const handleDirectSuiteClick = (testType: string) => {
    if (selectedSerials.length === 0) {
      alert(`Pilih minimal 1 perangkat standby untuk menjalankan suite ${testType}.`);
      return;
    }
    onDirectRunSuite(testType, selectedSerials);
  };

  const handleWifiDirectClick = () => {
    if (selectedSerials.length === 0) {
      alert('Pilih minimal 1 perangkat untuk konfigurasi Wi-Fi.');
      return;
    }
    setWifiModalOpen(true);
  };

  const handleConfirmWifi = () => {
    onDirectRunSuite('WIFI', selectedSerials);
    setWifiModalOpen(false);
  };

  return (
    <section className="accordion-card standby-card">
      {/* Accordion Header */}
      <div className="accordion-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="accordion-header-left">
          <button
            type="button"
            className="accordion-toggle-btn"
            aria-label="Toggle standby devices accordion"
          >
            {isExpanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
          </button>
          <div className="accordion-model-info">
            <span className="accordion-model-name">DAFTAR PERANGKAT STANDBY</span>
            <span className="badge badge-ready badge-xs">{devices.length} Total</span>
          </div>
        </div>

        {/* Group Button Direct Suite (SMR, SKU, NORMAL, STS, WIFI) */}
        <div className="accordion-header-actions" onClick={(e) => e.stopPropagation()}>
          <div className="direct-suite-group">
            <button
              className="btn btn-suite-tag"
              onClick={() => handleDirectSuiteClick('SMR')}
              title="Jalankan SMR Test Suite"
              disabled={selectedSerials.length === 0}
            >
              SMR
            </button>
            <button
              className="btn btn-suite-tag"
              onClick={() => handleDirectSuiteClick('SKU')}
              title="Jalankan SKU Test Suite"
              disabled={selectedSerials.length === 0}
            >
              SKU
            </button>
            <button
              className="btn btn-suite-tag"
              onClick={() => handleDirectSuiteClick('NORMAL')}
              title="Jalankan Normal CTS/GTS Suite"
              disabled={selectedSerials.length === 0}
            >
              NORMAL
            </button>
            <button
              className="btn btn-suite-tag"
              onClick={() => handleDirectSuiteClick('STS')}
              title="Jalankan STS Security Suite"
              disabled={selectedSerials.length === 0}
            >
              STS
            </button>
            <button
              className="btn btn-suite-tag btn-suite-wifi"
              onClick={handleWifiDirectClick}
              title="Provision Wi-Fi ke perangkat terpilih"
              disabled={selectedSerials.length === 0}
            >
              WIFI
            </button>
          </div>

          <span className="badge badge-unit badge-xs">
            {selectedSerials.length} Terpilih
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="accordion-body">
          {/* Model Filter Pills & Search Controls */}
          <div className="standby-toolbar">
            <div className="model-pills-bar">
              <button
                className={`model-pill ${selectedModelFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setSelectedModelFilter('ALL')}
              >
                SEMUA <span className="pill-count">{devices.length}</span>
              </button>
              {sortedModels.map((model) => (
                <button
                  key={model}
                  className={`model-pill ${selectedModelFilter === model ? 'active' : ''}`}
                  onClick={() => setSelectedModelFilter(model)}
                >
                  {model} <span className="pill-count">{modelCounts[model]}</span>
                </button>
              ))}
            </div>

            <div className="standby-filter-actions">
              <input
                type="text"
                className="form-input"
                placeholder="Search model, serial, PC..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ width: '200px' }}
              />

              <div className="type-filter-group">
                {(['all', 'user', 'userdebug', 'busy'] as const).map((type) => (
                  <button
                    key={type}
                    className={`btn ${filterType === type ? 'btn-primary' : 'btn-secondary'} btn-xs`}
                    onClick={() => setFilterType(type)}
                  >
                    {type.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Standby Device Table */}
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      className="checkbox-custom"
                      checked={allFilteredSelected}
                      onChange={handleSelectAllChange}
                    />
                  </th>
                  <th>PC ID</th>
                  <th>Model & PDA</th>
                  <th>Serial Number</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Battery / Temp</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {filteredDevices.length > 0 ? (
                  filteredDevices.map((dev) => {
                    const isSelected = selectedSerials.includes(dev.serial);
                    return (
                      <tr
                        key={dev.serial}
                        className={isSelected ? 'row-selected' : ''}
                        onClick={() => onToggleSelect(dev.serial)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="checkbox-custom"
                            checked={isSelected}
                            onChange={() => onToggleSelect(dev.serial)}
                          />
                        </td>
                        <td className="mono font-medium">{dev.pcId}</td>
                        <td>
                          <div className="device-model-cell">
                            <strong>{dev.model}</strong>
                            <span
                              className={`badge badge-xs ${dev.is_userdebug ? 'badge-userdebug' : 'badge-user'}`}
                            >
                              {dev.is_userdebug ? 'USERDEBUG' : 'USER'}
                            </span>
                          </div>
                          <div className="device-pda-sub">{dev.pda || 'PDA: Auto Detect'}</div>
                        </td>
                        <td className="mono">{dev.serial}</td>
                        <td>
                          <span className="badge badge-neutral badge-xs">
                            {dev.state || 'ADB'}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge badge-xs ${dev.busy ? 'badge-busy' : 'badge-ready'}`}
                          >
                            {dev.busy ? dev.busy_reason || 'BUSY' : 'READY'}
                          </span>
                        </td>
                        <td>
                          <span className="badge badge-neutral badge-xs">
                            {dev.battery_level !== undefined ? `${dev.battery_level}%` : '100%'}
                          </span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <button
                              className="btn btn-icon-sm"
                              title="Ping / Lampu Layar"
                              onClick={() => onToggleLamp(dev.pcId, dev.serial, true)}
                            >
                              <LampIcon size={14} />
                            </button>
                            {dev.busy && (
                              <button
                                className="btn btn-icon-sm"
                                title="Reset Status Busy"
                                onClick={() => onResetBusy(dev.pcId)}
                              >
                                <RefreshIcon size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="empty-state-cell">
                      Tidak ada perangkat standby yang sesuai dengan filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick Wi-Fi Modal */}
      {wifiModalOpen && (
        <div className="modal-overlay" onClick={() => setWifiModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h2>Konfigurasi Wi-Fi Perangkat</h2>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Wi-Fi SSID</label>
                <input
                  type="text"
                  className="form-input"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Wi-Fi Password</label>
                <input
                  type="password"
                  className="form-input"
                  value={wifiPassword}
                  onChange={(e) => setWifiPassword(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setWifiModalOpen(false)}>
                Batal
              </button>
              <button className="btn btn-primary" onClick={handleConfirmWifi}>
                Connect Wi-Fi ({selectedSerials.length} Unit)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
