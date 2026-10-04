import React, { useState, useEffect, useMemo } from 'react';
import { useFleetWebSocket, LaundryRow } from './hooks/useFleetWebSocket';
import { FleetHeader } from './components/FleetHeader';
import { LaundryWorkflowSection } from './components/LaundryWorkflowSection';
import { StandbyDevicesAccordion } from './components/StandbyDevicesAccordion';
import { RunningWorkflowAccordion } from './components/RunningWorkflowAccordion';
import { ResultsExplorer } from './components/ResultsExplorer';
import { LaundrySelectModal } from './components/LaundrySelectModal';
import { LaundryWorkflowState } from './components/ModelLaundryWorkflow';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('gba_theme') as 'dark' | 'light') || 'dark';
  });

  const {
    bridges,
    devices,
    activeJobs,
    jobHistory,
    laundryAnalysis,
    runSuite,
    cancelRun,
    resetBusy,
    setDeviceLamp,
    analyzeLaundry,
  } = useFleetWebSocket();

  const [selectedStandbySerials, setSelectedStandbySerials] = useState<string[]>([]);
  const [isLaundryModalOpen, setIsLaundryModalOpen] = useState(false);
  const [activeWorkflowIdForPicker, setActiveWorkflowIdForPicker] = useState<string>('');
  const [pickerPcId, setPickerPcId] = useState<string>('');

  // Collect all available zips across all connected bridges
  const allAvailableZips = useMemo(() => {
    return bridges.flatMap((b) => b.laundryZips || []);
  }, [bridges]);

  // Manage multiple laundry workflows (persisted to localStorage)
  const [workflows, setWorkflows] = useState<LaundryWorkflowState[]>(() => {
    const saved = localStorage.getItem('gba_laundry_workflows');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved workflows:', e);
      }
    }
    return [
      {
        id: 'wf-initial',
        model: 'SM-A055F',
        selectedModules: [],
        selectedSerials: [],
        pda: '',
      },
    ];
  });

  // Auto-sync workflow model with connected devices if initial is empty
  useEffect(() => {
    if (devices.length > 0 && workflows.length === 1 && workflows[0].id === 'wf-initial' && !workflows[0].pda) {
      const topDevice = devices[0];
      setWorkflows([
        {
          id: 'wf-1',
          model: topDevice.model || 'SM-A055F',
          pda: topDevice.pda,
          selectedModules: [],
          selectedSerials: [topDevice.serial],
          pcId: topDevice.pcId,
        },
      ]);
    }
  }, [devices]);

  // Persist workflows
  useEffect(() => {
    localStorage.setItem('gba_laundry_workflows', JSON.stringify(workflows));
  }, [workflows]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gba_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Workflow Handlers
  const handleUpdateWorkflow = (updated: LaundryWorkflowState) => {
    setWorkflows((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
  };

  const handleRemoveWorkflow = (id: string) => {
    setWorkflows((prev) => prev.filter((w) => w.id !== id));
  };

  const handleAddWorkflow = () => {
    // Find next model from devices that doesn't have a workflow yet
    const existingModels = new Set(workflows.map((w) => w.model.toLowerCase()));
    const nextDev = devices.find((d) => !existingModels.has(d.model.toLowerCase())) || devices[0];

    const newWorkflow: LaundryWorkflowState = {
      id: `wf-${Date.now()}`,
      model: nextDev ? nextDev.model : 'NEW-MODEL',
      pda: nextDev?.pda || '',
      pcId: nextDev?.pcId,
      selectedModules: [],
      selectedSerials: nextDev ? [nextDev.serial] : [],
    };
    setWorkflows((prev) => [...prev, newWorkflow]);
  };

  const handleOpenLaundryPicker = (workflowId: string, pcId?: string) => {
    setActiveWorkflowIdForPicker(workflowId);
    setPickerPcId(pcId || (bridges[0]?.pcId ?? ''));
    setIsLaundryModalOpen(true);
  };

  // Standby Devices Handlers
  const handleToggleSelectStandbyDevice = (serial: string) => {
    setSelectedStandbySerials((prev) =>
      prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]
    );
  };

  // Direct suite execution (SMR, SKU, NORMAL, STS, WIFI)
  const handleDirectRunSuite = (testType: string, serials: string[]) => {
    if (serials.length === 0) return;

    // Group serials by node PC
    const devMap = new Map<string, string[]>();
    serials.forEach((s) => {
      const dev = devices.find((d) => d.serial === s);
      const pcId = dev ? dev.pcId : (bridges[0]?.pcId ?? 'LOCAL');
      if (!devMap.has(pcId)) devMap.set(pcId, []);
      devMap.get(pcId)!.push(s);
    });

    devMap.forEach((nodeSerials, pcId) => {
      const userDevices = nodeSerials.filter((s) => {
        const dev = devices.find((d) => d.serial === s);
        return dev ? !dev.is_userdebug : true;
      });
      const userdebugDevices = nodeSerials.filter((s) => {
        const dev = devices.find((d) => d.serial === s);
        return dev ? dev.is_userdebug : false;
      });

      runSuite(pcId, {
        test_type: testType,
        user_devices: userDevices,
        userdebug_devices: userdebugDevices,
        retry_count: 1,
        timeout_secs: 7200,
        wifi_enabled: testType === 'WIFI',
        wifi_ssid: 'GBA-TEST-WIFI',
        wifi_password: 'testpassword123',
      });
    });
  };

  const activePickerBridge = bridges.find((b) => b.pcId === pickerPcId) || bridges[0];
  const zipsForPicker = activePickerBridge?.laundryZips || allAvailableZips;

  return (
    <div className="app-container">
      <main className="main-content">
        <FleetHeader
          onlineBridgesCount={bridges.length}
          devicesCount={devices.length}
          activeJobsCount={activeJobs.length}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {/* Active Running Test Suites & Live Logs */}
        <RunningWorkflowAccordion
          activeJobs={activeJobs}
          onCancelJob={cancelRun}
        />

        {/* Top Section: Model Laundry Workflows (Octopus-style Accordion) */}
        <LaundryWorkflowSection
          workflows={workflows}
          devices={devices}
          availableZips={allAvailableZips}
          laundryAnalysis={laundryAnalysis}
          onUpdateWorkflow={handleUpdateWorkflow}
          onRemoveWorkflow={handleRemoveWorkflow}
          onAddWorkflow={handleAddWorkflow}
          onOpenLaundryPicker={handleOpenLaundryPicker}
          onRunSuite={runSuite}
          onToggleLamp={setDeviceLamp}
        />

        {/* Bottom Section: Standby Devices with Direct Testplans & Model Pills */}
        <StandbyDevicesAccordion
          devices={devices}
          selectedSerials={selectedStandbySerials}
          onToggleSelect={handleToggleSelectStandbyDevice}
          onSelectAll={setSelectedStandbySerials}
          onDirectRunSuite={handleDirectRunSuite}
          onToggleLamp={setDeviceLamp}
          onResetBusy={resetBusy}
        />

        {/* Results History */}
        <ResultsExplorer history={jobHistory} />

        {/* Laundry Zip Modal Picker */}
        <LaundrySelectModal
          isOpen={isLaundryModalOpen}
          onClose={() => setIsLaundryModalOpen(false)}
          pcId={pickerPcId || activePickerBridge?.pcId || 'LOCAL'}
          zips={zipsForPicker}
          laundryAnalysis={laundryAnalysis}
          onAnalyzeZip={analyzeLaundry}
          onConfirmSelection={(zipPath, rows) => {
            if (activeWorkflowIdForPicker) {
              const wf = workflows.find((w) => w.id === activeWorkflowIdForPicker);
              if (wf) {
                const failedModules = rows
                  .filter((r) => r.failed > 0 || r.status.toUpperCase() === 'FAIL')
                  .map((r) => r.testcase || r.suite);
                handleUpdateWorkflow({
                  ...wf,
                  selectedZip: zipPath,
                  selectedModules: failedModules.length > 0 ? failedModules : rows.map((r) => r.testcase || r.suite),
                });
              }
            }
          }}
        />
      </main>
    </div>
  );
};
export default App;
