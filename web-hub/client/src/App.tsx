import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useFleetWebSocket, LaundryRow } from './hooks/useFleetWebSocket';
import { FleetHeader } from './components/FleetHeader';
import { FilterToolbarCard } from './components/FilterToolbarCard';
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

  // Top Card Filter States
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPcFilter, setSelectedPcFilter] = useState<string>('ALL');
  const [selectedModeFilter, setSelectedModeFilter] = useState<'all' | 'user' | 'userdebug' | 'busy'>('all');

  const runningSectionRef = useRef<HTMLDivElement>(null);

  // Collect all available zips across all connected bridges
  const allAvailableZips = useMemo(() => {
    return bridges.flatMap((b) => b.laundryZips || []);
  }, [bridges]);

  // Manage multiple laundry workflows (persisted to localStorage)
  const [workflows, setWorkflows] = useState<LaundryWorkflowState[]>(() => {
    const saved = localStorage.getItem('gba_laundry_workflows');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch (e) {
        console.error('Failed to parse saved workflows:', e);
      }
    }
    return [
      {
        id: 'wf-initial',
        model: '',
        selectedModules: [],
        selectedSerials: [],
        pda: '',
      },
    ];
  });

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
    const newWorkflow: LaundryWorkflowState = {
      id: `wf-${Date.now()}`,
      model: '',
      pda: '',
      selectedModules: [],
      selectedSerials: [],
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

  // Direct suite execution (1 Model, 1 Testplan: SMR, SKU, NORMAL, STS)
  const handleDirectRunSuite = (testType: 'SMR' | 'SKU' | 'NORMAL' | 'STS', targetModel: string, serials: string[]) => {
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
        target_model: targetModel,
        user_devices: userDevices,
        userdebug_devices: userdebugDevices,
        retry_count: 5,
        timeout_secs: 86400,
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

        {/* Standalone Filter Toolbar Card at Top */}
        <FilterToolbarCard
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedPcId={selectedPcFilter}
          onPcIdChange={setSelectedPcFilter}
          selectedMode={selectedModeFilter}
          onModeChange={setSelectedModeFilter}
          bridges={bridges}
          activeJobsCount={activeJobs.length}
          onToggleTerminalLogs={() => {
            if (runningSectionRef.current) {
              runningSectionRef.current.scrollIntoView({ behavior: 'smooth' });
            }
          }}
        />

        {/* Active Running Test Suites & Live Logs */}
        <div ref={runningSectionRef}>
          <RunningWorkflowAccordion
            activeJobs={activeJobs}
            onCancelJob={cancelRun}
          />
        </div>

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
          searchQuery={searchQuery}
          selectedPcFilter={selectedPcFilter}
          filterType={selectedModeFilter}
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
                // 1. Extract model from XML rows or zip filename
                let detectedModel = rows.find((r) => r.model)?.model || '';
                let detectedPda = '';

                if (!detectedModel) {
                  const filename = zipPath.split('/').pop() || '';
                  const base = filename.replace(/\.zip$/i, '');
                  const firstToken = base.split('_')[0] || '';
                  detectedPda = firstToken;

                  if (firstToken.startsWith('SM-') || firstToken.startsWith('sm-')) {
                    detectedModel = firstToken.toUpperCase();
                  } else {
                    let modelPart = '';
                    for (const ch of firstToken) {
                      if (/[a-zA-Z0-9]/.test(ch)) {
                        modelPart += ch;
                        if (modelPart.length >= 5 && /[FBGEPNUWfbgepnuw]$/.test(modelPart)) {
                          break;
                        }
                      } else {
                        break;
                      }
                    }
                    if (modelPart.length >= 4) {
                      detectedModel = `SM-${modelPart.toUpperCase()}`;
                    }
                  }
                }

                // 2. Find online devices matching this detected model
                const matchingDevs = devices.filter((d) =>
                  detectedModel ? d.model.toLowerCase() === detectedModel.toLowerCase() : false
                );

                const failedModules = rows
                  .filter((r) => r.failed > 0 || r.status.toUpperCase() === 'FAIL')
                  .map((r) => r.testcase || r.suite);

                handleUpdateWorkflow({
                  ...wf,
                  model: detectedModel || '',
                  pda: detectedPda || (matchingDevs[0]?.pda ?? ''),
                  selectedZip: zipPath,
                  selectedModules: failedModules.length > 0 ? failedModules : rows.map((r) => r.testcase || r.suite),
                  selectedSerials: matchingDevs.map((d) => d.serial),
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
