import React, { useState, useMemo } from 'react';
import { DeviceItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, LampIcon, PlayIcon, RefreshIcon } from './Icons';

export type TestPlanType = 'SMR' | 'SKU' | 'NORMAL' | 'STS';

interface StandbyDevicesAccordionProps {
  devices: DeviceItem[];
  selectedSerials: string[];
  onToggleSelect: (serial: string) => void;
  onSelectAll: (serials: string[]) => void;
  onDirectRunSuite: (testType: TestPlanType, targetModel: string, serials: string[]) => void;
  onToggleLamp: (pcId: string, serial: string, brighten: boolean) => void;
  onResetBusy: (pcId: string) => void;
  searchQuery?: string;
  selectedPcFilter?: string;
  filterType?: 'all' | 'user' | 'userdebug' | 'busy';
}

export const StandbyDevicesAccordion: React.FC<StandbyDevicesAccordionProps> = ({
  devices,
  selectedSerials,
  onToggleSelect,
  onSelectAll,
  onDirectRunSuite,
  onToggleLamp,
  onResetBusy,
  searchQuery = '',
  selectedPcFilter = 'ALL',
  filterType = 'all',
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [activeTestPlan, setActiveTestPlan] = useState<TestPlanType>('SMR');
  const [selectedModelFilter, setSelectedModelFilter] = useState<string>('ALL');

  // Compute model counts for model filter pills
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
    const activeFilterType = filterType;
    const activeSearch = searchQuery.trim().toLowerCase();
    const activePc = selectedPcFilter;

    return devices.filter((d) => {
      if (activePc !== 'ALL' && d.pcId !== activePc) {
        return false;
      }
      if (activeFilterType === 'user' && d.is_userdebug) return false;
      if (activeFilterType === 'userdebug' && !d.is_userdebug) return false;
      if (activeFilterType === 'busy' && !d.busy) return false;

      if (selectedModelFilter !== 'ALL' && d.model !== selectedModelFilter) {
        return false;
      }

      if (activeSearch) {
        return (
          d.model.toLowerCase().includes(activeSearch) ||
          d.serial.toLowerCase().includes(activeSearch) ||
          d.pcId.toLowerCase().includes(activeSearch) ||
          d.pda.toLowerCase().includes(activeSearch) ||
          (d.csc && d.csc.toLowerCase().includes(activeSearch)) ||
          (d.sales_code && d.sales_code.toLowerCase().includes(activeSearch))
        );
      }
      return true;
    });
  }, [devices, filterType, selectedPcFilter, selectedModelFilter, searchQuery]);

  // Selected devices objects
  const selectedDeviceObjs = useMemo(() => {
    return devices.filter((d) => selectedSerials.includes(d.serial));
  }, [devices, selectedSerials]);

  // Active locked model based on current selection
  const activeSelectedModel = useMemo(() => {
    return selectedDeviceObjs.length > 0 ? selectedDeviceObjs[0].model : null;
  }, [selectedDeviceObjs]);

  // Determine the primary target model for execution (1 model at once enforcement)
  const targetExecutionModel = useMemo(() => {
    if (activeSelectedModel) {
      return activeSelectedModel;
    }
    if (selectedModelFilter !== 'ALL') {
      return selectedModelFilter;
    }
    return '';
  }, [activeSelectedModel, selectedModelFilter]);

  // Devices that are eligible for selection in the current view
  const selectableDevices = useMemo(() => {
    if (activeSelectedModel) {
      return filteredDevices.filter((d) => d.model === activeSelectedModel);
    }
    if (selectedModelFilter !== 'ALL') {
      return filteredDevices.filter((d) => d.model === selectedModelFilter);
    }
    return filteredDevices;
  }, [filteredDevices, activeSelectedModel, selectedModelFilter]);

  const allFilteredSelected =
    selectableDevices.length > 0 &&
    selectableDevices.every((d) => selectedSerials.includes(d.serial));

  const handleSelectAllChange = () => {
    if (allFilteredSelected) {
      const selectableSerials = new Set(selectableDevices.map((d) => d.serial));
      onSelectAll(selectedSerials.filter((s) => !selectableSerials.has(s)));
    } else {
      const targetModel = activeSelectedModel || selectableDevices[0]?.model;
      if (targetModel) {
        const matchingSerials = filteredDevices
          .filter((d) => d.model === targetModel)
          .map((d) => d.serial);
        onSelectAll(matchingSerials);
      }
    }
  };

  const handleDeviceRowClick = (dev: DeviceItem) => {
    if (activeSelectedModel && dev.model !== activeSelectedModel) {
      return; // Blocked: different model
    }
    onToggleSelect(dev.serial);
  };

  const handleTriggerRun = () => {
    if (selectedSerials.length === 0 || !targetExecutionModel) {
      alert('Pilih minimal 1 perangkat standby untuk menjalankan pengujian.');
      return;
    }
    onDirectRunSuite(activeTestPlan, targetExecutionModel, selectedSerials);
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

        {/* Switch Button Suite Testplan (1 Model, 1 Testplan at once) */}
        <div className="accordion-header-actions" onClick={(e) => e.stopPropagation()}>
          <div className="segmented-switch-container">
            {(['SMR', 'SKU', 'NORMAL', 'STS'] as const).map((plan) => (
              <button
                key={plan}
                type="button"
                className={`switch-option ${activeTestPlan === plan ? 'active' : ''}`}
                onClick={() => setActiveTestPlan(plan)}
                title={`Pilih Testplan ${plan}`}
              >
                {plan}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-suite-primary"
            onClick={handleTriggerRun}
            disabled={selectedSerials.length === 0}
            title={`Jalankan ${activeTestPlan} untuk model ${targetExecutionModel || 'Pilih Perangkat'}`}
          >
            <PlayIcon size={13} />
            <span>
              {selectedSerials.length > 0
                ? `Jalankan ${activeTestPlan} (${targetExecutionModel} • ${selectedSerials.length} Unit)`
                : `Jalankan ${activeTestPlan}`}
            </span>
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="accordion-body">
          {/* Active Model Lock Notice */}
          {activeSelectedModel && (
            <div className="notice-banner">
              🔒 <strong>Model Terkunci:</strong> Anda sedang memilih perangkat dengan model <strong>{activeSelectedModel}</strong> ({selectedSerials.length} unit terpilih). Checkbox model lain diblokir untuk memastikan 1 model per eksekusi.
            </div>
          )}

          {/* Model Filter Pills */}
          <div className="standby-toolbar">
            <div className="model-pills-bar" style={{ width: '100%' }}>
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
                    const isBlocked = activeSelectedModel !== null && dev.model !== activeSelectedModel;

                    return (
                      <tr
                        key={dev.serial}
                        className={isBlocked ? 'row-blocked' : (isSelected ? 'row-selected' : '')}
                        onClick={() => handleDeviceRowClick(dev)}
                        style={{ cursor: isBlocked ? 'not-allowed' : 'pointer' }}
                        title={isBlocked ? `Terkunci: Hanya 1 model yang dapat dipilih (Model aktif: ${activeSelectedModel})` : undefined}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="checkbox-custom"
                            checked={isSelected}
                            disabled={isBlocked}
                            onChange={() => handleDeviceRowClick(dev)}
                            title={isBlocked ? `Terkunci: Hanya 1 model yang dapat dipilih (Model aktif: ${activeSelectedModel})` : undefined}
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
    </section>
  );
};
