import React, { useState } from 'react';
import { CloseIcon, PlayIcon } from './Icons';
import { DeviceItem, LaundryRow } from '../hooks/useFleetWebSocket';

interface TestRunnerModalProps {
  isOpen: boolean;
  onClose: () => void;
  devices: DeviceItem[];
  selectedSerials: string[];
  onStartRun: (pcId: string, payload: any) => void;
  onOpenLaundryPicker: (pcId: string) => void;
  selectedLaundryZip: string;
  selectedLaundryRows: LaundryRow[];
}

export const TestRunnerModal: React.FC<TestRunnerModalProps> = ({
  isOpen,
  onClose,
  devices,
  selectedSerials,
  onStartRun,
  onOpenLaundryPicker,
  selectedLaundryZip,
  selectedLaundryRows,
}) => {
  const [testType, setTestType] = useState<string>('SMR');
  const [retryCount, setRetryCount] = useState<number>(3);
  const [wifiEnabled, setWifiEnabled] = useState<boolean>(false);
  const [wifiSsid, setWifiSsid] = useState<string>('RTT / IEEE 802.11');
  const [wifiPassword, setWifiPassword] = useState<string>('1234qwer');
  const [timeoutSecs, setTimeoutSecs] = useState<number>(86400);

  if (!isOpen) return null;

  const targetDevices = devices.filter((d) => selectedSerials.includes(d.serial));
  const userDevices = targetDevices.filter((d) => !d.is_userdebug).map((d) => d.serial);
  const userdebugDevices = targetDevices.filter((d) => d.is_userdebug).map((d) => d.serial);

  // Derive target PC from target devices (assuming same node for the run)
  const targetPcId = targetDevices[0]?.pcId || '';

  const handleStart = () => {
    if (!targetPcId) return;

    const payload = {
      test_type: testType,
      auto_root: '',
      user_devices: userDevices,
      userdebug_devices: userdebugDevices,
      retry_count: Number(retryCount),
      wifi_enabled: wifiEnabled,
      wifi_ssid: wifiSsid,
      wifi_password: wifiPassword,
      timeout_secs: Number(timeoutSecs),
      laundry_zip_path: testType === 'Cuci SMR' ? selectedLaundryZip : undefined,
      selected_laundry_results: testType === 'Cuci SMR' ? selectedLaundryRows.map((r) => r.id) : [],
      selected_laundry_rows: testType === 'Cuci SMR' ? selectedLaundryRows : [],
    };

    onStartRun(targetPcId, payload);
    onClose();
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-dialog">
        <div className="modal-header">
          <div>
            <h3 style={{ fontSize: '1.125rem', fontWeight: 700 }}>Run Test Suite Configuration</h3>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Target Node: <strong>{targetPcId || 'Unknown'}</strong> ({selectedSerials.length} devices)
            </p>
          </div>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.375rem' }}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Test Mode</label>
            <select
              className="form-select"
              value={testType}
              onChange={(e) => setTestType(e.target.value)}
            >
              <option value="SMR">SMR (Standard Maintenance Release CTS + GTS)</option>
              <option value="Cuci SMR">Cuci SMR (Selective Retry from Previous Zip)</option>
              <option value="MR">MR (Maintenance Release)</option>
              <option value="SKU">SKU (Full Validation)</option>
              <option value="STS">STS (Security Test Suite)</option>
            </select>
          </div>

          {testType === 'Cuci SMR' && (
            <div className="form-group" style={{ padding: '0.875rem', backgroundColor: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)' }}>
              <label className="form-label">Laundry Result Source</label>
              {selectedLaundryZip ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                  <span className="mono-cell" style={{ fontSize: '0.75rem' }}>
                    {selectedLaundryZip.split('/').pop()} ({selectedLaundryRows.length} modules selected)
                  </span>
                  <button className="btn btn-secondary" onClick={() => onOpenLaundryPicker(targetPcId)}>
                    Change Zip
                  </button>
                </div>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => onOpenLaundryPicker(targetPcId)}
                  style={{ width: '100%', marginTop: '0.25rem' }}
                >
                  Pick Result Zip from Node PC
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label">Retry Count</label>
              <input
                type="number"
                className="form-input"
                min={0}
                max={10}
                value={retryCount}
                onChange={(e) => setRetryCount(Number(e.target.value))}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Timeout (Seconds)</label>
              <input
                type="number"
                className="form-input"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wifiEnabled}
                onChange={(e) => setWifiEnabled(e.target.checked)}
              />
              <span className="form-label" style={{ marginBottom: 0 }}>Enable Wi-Fi Auto-Connect</span>
            </label>
          </div>

          {wifiEnabled && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">SSID</label>
                <input
                  type="text"
                  className="form-input"
                  value={wifiSsid}
                  onChange={(e) => setWifiSsid(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Password</label>
                <input
                  type="password"
                  className="form-input"
                  value={wifiPassword}
                  onChange={(e) => setWifiPassword(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Assigned Devices</label>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              <div>USER Devices ({userDevices.length}): {userDevices.join(', ') || 'None'}</div>
              <div>USERDEBUG Devices ({userdebugDevices.length}): {userdebugDevices.join(', ') || 'None'}</div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleStart}
            disabled={selectedSerials.length === 0 || (testType === 'Cuci SMR' && !selectedLaundryZip)}
          >
            <PlayIcon size={14} />
            <span>Launch Suite Run</span>
          </button>
        </div>
      </div>
    </div>
  );
};
