import React, { useState, useMemo } from 'react';
import { DeviceItem, LaundryRow, LaundryZipItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, PlayIcon, TrashIcon, SmartphoneIcon, LampIcon } from './Icons';

export interface LaundryWorkflowState {
  id: string;
  model: string;
  pcId?: string;
  selectedZip?: string;
  selectedModules: string[];
  selectedSerials: string[];
  pda?: string;
  ap_version?: string;
  plan?: string;
}

export function isModelMatch(m1?: string, m2?: string): boolean {
  if (!m1 || !m2) return false;
  const n1 = m1.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n2 = m2.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n1 === n2 || n1.endsWith(n2) || n2.endsWith(n1);
}

interface ModelLaundryWorkflowProps {
  workflow: LaundryWorkflowState;
  allDevices: DeviceItem[];
  availableZips: LaundryZipItem[];
  laundryAnalysis: {
    pcId: string;
    zip_path: string;
    rows: LaundryRow[];
    error?: string;
  } | null;
  onUpdateWorkflow: (updated: LaundryWorkflowState) => void;
  onRemoveWorkflow: (id: string) => void;
  onOpenLaundryPicker: (workflowId: string, pcId?: string) => void;
  onRunSuite: (pcId: string, payload: any) => void;
  onToggleLamp: (pcId: string, serial: string, brighten: boolean) => void;
}

export const ModelLaundryWorkflow: React.FC<ModelLaundryWorkflowProps> = ({
  workflow,
  allDevices,
  availableZips,
  laundryAnalysis,
  onUpdateWorkflow,
  onRemoveWorkflow,
  onOpenLaundryPicker,
  onRunSuite,
  onToggleLamp,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLaundryExpanded, setIsLaundryExpanded] = useState(true);
  const [isDevicesExpanded, setIsDevicesExpanded] = useState(true);

  // Filter devices matching this workflow's model with flexible underscore/hyphen normalization
  const matchingDevices = useMemo(() => {
    if (!workflow.model) return [];
    return allDevices.filter((d) => isModelMatch(d.model, workflow.model));
  }, [allDevices, workflow.model]);

  // Determine current active analysis rows for this workflow's selected zip
  const analysisRows: LaundryRow[] = useMemo(() => {
    if (laundryAnalysis && laundryAnalysis.zip_path === workflow.selectedZip) {
      return laundryAnalysis.rows || [];
    }
    return [];
  }, [laundryAnalysis, workflow.selectedZip]);

  const failedRows = useMemo(() => {
    return analysisRows.filter((r) => r.failed > 0 || r.status.toUpperCase() === 'FAIL');
  }, [analysisRows]);

  const handleToggleModule = (moduleName: string) => {
    const exists = workflow.selectedModules.includes(moduleName);
    const updated = exists
      ? workflow.selectedModules.filter((m) => m !== moduleName)
      : [...workflow.selectedModules, moduleName];
    onUpdateWorkflow({ ...workflow, selectedModules: updated });
  };

  const handleSelectAllFailedModules = () => {
    const allFailedNames = failedRows.map((r) => r.testcase || r.suite);
    const allSelected = allFailedNames.every((name) => workflow.selectedModules.includes(name));
    onUpdateWorkflow({
      ...workflow,
      selectedModules: allSelected ? [] : allFailedNames,
    });
  };

  const handleToggleDevice = (serial: string) => {
    const exists = workflow.selectedSerials.includes(serial);
    const updated = exists
      ? workflow.selectedSerials.filter((s) => s !== serial)
      : [...workflow.selectedSerials, serial];
    onUpdateWorkflow({ ...workflow, selectedSerials: updated });
  };

  const handleSelectAllDevices = () => {
    const allSerials = matchingDevices.map((d) => d.serial);
    const allSelected = allSerials.every((s) => workflow.selectedSerials.includes(s));
    onUpdateWorkflow({
      ...workflow,
      selectedSerials: allSelected ? [] : allSerials,
    });
  };

  const handleRunLaundryAutomation = () => {
    if (workflow.selectedSerials.length === 0) {
      alert('Pilih minimal 1 perangkat untuk menjalankan automasi Cuci SMR.');
      return;
    }

    const targetDev = matchingDevices.find((d) => workflow.selectedSerials.includes(d.serial));
    const targetPcId = targetDev ? targetDev.pcId : workflow.pcId || (allDevices[0]?.pcId ?? 'LOCAL');

    const selectedRowsData = analysisRows.filter((r) =>
      workflow.selectedModules.includes(r.testcase || r.suite)
    );

    const userDevices = workflow.selectedSerials.filter((s) => {
      const dev = allDevices.find((d) => d.serial === s);
      return dev ? !dev.is_userdebug : true;
    });

    const userdebugDevices = workflow.selectedSerials.filter((s) => {
      const dev = allDevices.find((d) => d.serial === s);
      return dev ? dev.is_userdebug : false;
    });

    onRunSuite(targetPcId, {
      test_type: 'Cuci SMR',
      laundry_zip_path: workflow.selectedZip,
      selected_laundry_results: workflow.selectedModules,
      selected_laundry_rows: selectedRowsData,
      user_devices: userDevices,
      userdebug_devices: userdebugDevices,
      retry_count: 5,
      timeout_secs: 86400,
    });
  };

  const planName = workflow.plan ? workflow.plan.toUpperCase() : 'SMR';
  const apVersion = workflow.ap_version || workflow.pda || (matchingDevices[0]?.pda ?? '');
  const isLoaded = Boolean(workflow.selectedZip || workflow.model || workflow.ap_version);
  const titleText = isLoaded
    ? `Laundry ${planName} ${apVersion || workflow.model}`.trim()
    : 'LAUNDRY WORKFLOW (Pilih Zip Hasil Test)';
  const hasUserdebug = matchingDevices.some((d) => d.is_userdebug);

  return (
    <div className="accordion-card">
      {/* Root Accordion Header */}
      <div className="accordion-header" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="accordion-header-left">
          <button
            type="button"
            className="accordion-toggle-btn"
            aria-label="Toggle workflow accordion"
          >
            {isExpanded ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
          </button>
          <div className="accordion-model-info">
            <span
              className="accordion-model-name"
              style={{ color: isLoaded ? 'var(--text-primary)' : 'var(--text-secondary)' }}
            >
              {titleText}
            </span>
            {isLoaded && workflow.model && (
              <span className="badge badge-pc badge-xs">{workflow.model}</span>
            )}
            {isLoaded && (
              <span className={`badge badge-xs ${hasUserdebug ? 'badge-userdebug' : 'badge-user'}`}>
                {hasUserdebug ? 'USERDEBUG' : 'USER'}
              </span>
            )}
          </div>
        </div>

        <div className="accordion-header-actions" onClick={(e) => e.stopPropagation()}>
          {isLoaded && (
            <>
              <button
                className="btn btn-suite-primary"
                title="Jalankan Cuci SMR untuk modul terpilih"
                onClick={handleRunLaundryAutomation}
                disabled={workflow.selectedSerials.length === 0}
              >
                <PlayIcon size={13} />
                <span>Jalankan Automasi</span>
              </button>

              <span className="badge badge-unit badge-xs">
                {workflow.selectedSerials.length}/{matchingDevices.length} Unit
              </span>
            </>
          )}

          <button
            className="btn-icon-danger"
            title="Hapus Laundry Workflow"
            onClick={() => onRemoveWorkflow(workflow.id)}
            aria-label="Remove workflow"
          >
            <TrashIcon size={15} />
          </button>
        </div>
      </div>

      {/* Root Accordion Body */}
      {isExpanded && (
        <div className="accordion-body">
          {/* Sub-Accordion 1: Laundry Zip & Module Table */}
          <div className="sub-accordion">
            <div
              className="sub-accordion-header"
              onClick={() => setIsLaundryExpanded(!isLaundryExpanded)}
            >
              <div className="sub-accordion-title">
                {isLaundryExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>LAUNDRY ZIP / HASIL PENGUJIAN</span>
                {workflow.selectedZip && (
                  <span className="sub-accordion-meta">
                    {workflow.selectedZip.split('/').pop()}
                  </span>
                )}
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onOpenLaundryPicker(workflow.id, workflow.pcId)}
                >
                  {workflow.selectedZip ? 'Ganti Zip' : 'Pilih Zip'}
                </button>
              </div>
            </div>

            {isLaundryExpanded && (
              <div className="sub-accordion-body">
                {workflow.selectedZip ? (
                  <div>
                    <div className="laundry-summary-bar">
                      <div className="laundry-path-display">
                        <strong>Path:</strong> <code>{workflow.selectedZip}</code>
                      </div>
                      <div className="laundry-stats-chips">
                        <span className="badge badge-neutral badge-xs">
                          {analysisRows.length} Total Modul
                        </span>
                        <span className="badge badge-busy badge-xs">
                          {failedRows.length} Gagal / Fail
                        </span>
                        <span className="badge badge-ready badge-xs">
                          {workflow.selectedModules.length} Dipilih untuk Retry
                        </span>
                        {failedRows.length > 0 && (
                          <button
                            className="btn btn-link btn-xs"
                            onClick={handleSelectAllFailedModules}
                          >
                            Pilih Semua Gagal
                          </button>
                        )}
                      </div>
                    </div>

                    {analysisRows.length > 0 ? (
                      <div className="table-responsive" style={{ maxHeight: '240px' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th style={{ width: '40px' }}>Pilih</th>
                              <th>Modul / Test Suite</th>
                              <th>Status</th>
                              <th>Passed</th>
                              <th>Failed</th>
                              <th>Total</th>
                              <th>Durasi</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysisRows.map((row) => {
                              const moduleName = row.testcase || row.suite;
                              const isChecked = workflow.selectedModules.includes(moduleName);
                              const isFail = row.failed > 0 || row.status.toUpperCase() === 'FAIL';
                              return (
                                <tr
                                  key={row.id || moduleName}
                                  className={isChecked ? 'row-selected' : ''}
                                  onClick={() => handleToggleModule(moduleName)}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <td onClick={(e) => e.stopPropagation()}>
                                    <input
                                      type="checkbox"
                                      className="checkbox-custom"
                                      checked={isChecked}
                                      onChange={() => handleToggleModule(moduleName)}
                                    />
                                  </td>
                                  <td>
                                    <strong className="mono">{moduleName}</strong>
                                    {row.subtestcases && (
                                      <div className="text-secondary text-xs">{row.subtestcases}</div>
                                    )}
                                  </td>
                                  <td>
                                    <span
                                      className={`badge badge-xs ${isFail ? 'badge-busy' : 'badge-ready'}`}
                                    >
                                      {row.status || (isFail ? 'FAIL' : 'PASS')}
                                    </span>
                                  </td>
                                  <td className="mono">{row.passed}</td>
                                  <td className={`mono ${isFail ? 'text-danger' : ''}`}>
                                    {row.failed}
                                  </td>
                                  <td className="mono">{row.total}</td>
                                  <td className="mono text-secondary">{row.time || '-'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="empty-state-compact">
                        Sedang mem-parsing test_result.xml atau belum ada data modul.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="empty-state-box">
                    <p>Belum ada Zip hasil test Tradefed yang dipilih.</p>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onOpenLaundryPicker(workflow.id, workflow.pcId)}
                    >
                      Pilih Zip dari Node PC
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sub-Accordion 2: Related Model Devices */}
          <div className="sub-accordion">
            <div
              className="sub-accordion-header"
              onClick={() => setIsDevicesExpanded(!isDevicesExpanded)}
            >
              <div className="sub-accordion-title">
                {isDevicesExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>DEVICES ({matchingDevices.length} Unit Terhubung)</span>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={handleSelectAllDevices}
                  disabled={matchingDevices.length === 0}
                >
                  {matchingDevices.length > 0 &&
                  matchingDevices.every((d) => workflow.selectedSerials.includes(d.serial))
                    ? 'Deselect All'
                    : 'Select All'}
                </button>
              </div>
            </div>

            {isDevicesExpanded && (
              <div className="sub-accordion-body">
                {matchingDevices.length > 0 ? (
                  <div className="table-responsive">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: '40px' }}>
                            <input
                              type="checkbox"
                              className="checkbox-custom"
                              checked={
                                matchingDevices.length > 0 &&
                                matchingDevices.every((d) =>
                                  workflow.selectedSerials.includes(d.serial)
                                )
                              }
                              onChange={handleSelectAllDevices}
                            />
                          </th>
                          <th>PC ID</th>
                          <th>Model & Build</th>
                          <th>Serial Number</th>
                          <th>Mode</th>
                          <th>Status</th>
                          <th>Battery / Temp</th>
                          <th>Aksi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matchingDevices.map((dev) => {
                          const isChecked = workflow.selectedSerials.includes(dev.serial);
                          return (
                            <tr
                              key={dev.serial}
                              className={isChecked ? 'row-selected' : ''}
                              onClick={() => handleToggleDevice(dev.serial)}
                              style={{ cursor: 'pointer' }}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  className="checkbox-custom"
                                  checked={isChecked}
                                  onChange={() => handleToggleDevice(dev.serial)}
                                />
                              </td>
                              <td className="mono">{dev.pcId}</td>
                              <td>
                                <div className="device-model-cell">
                                  <strong>{dev.model}</strong>
                                  <span
                                    className={`badge badge-xs ${dev.is_userdebug ? 'badge-userdebug' : 'badge-user'}`}
                                  >
                                    {dev.is_userdebug ? 'USERDEBUG' : 'USER'}
                                  </span>
                                </div>
                                <div className="device-pda-sub">{dev.pda || 'PDA: -'}</div>
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
                                <button
                                  className="btn btn-icon-sm"
                                  title="Ping / Lampu Layar"
                                  onClick={() => onToggleLamp(dev.pcId, dev.serial, true)}
                                >
                                  <LampIcon size={14} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : !workflow.model ? (
                  <div className="empty-state-compact">
                    Pilih file Zip hasil test di atas terlebih dahulu untuk mendeteksi model dan menghubungkan perangkat.
                  </div>
                ) : (
                  <div className="empty-state-compact">
                    Tidak ada perangkat online dengan model <strong>{workflow.model}</strong>.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
