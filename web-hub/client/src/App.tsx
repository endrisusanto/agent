import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useFleetWebSocket, LaundryRow } from './hooks/useFleetWebSocket';
import { FleetHeader } from './components/FleetHeader';
import { FilterToolbarCard } from './components/FilterToolbarCard';
import { LaundryWorkflowSection } from './components/LaundryWorkflowSection';
import { StandbyDevicesAccordion } from './components/StandbyDevicesAccordion';
import { RunningWorkflowAccordion } from './components/RunningWorkflowAccordion';
import { ResultsExplorer } from './components/ResultsExplorer';
import { LaundrySelectModal } from './components/LaundrySelectModal';
import { TerminalLogsModal } from './components/TerminalLogsModal';
import { PreflightModal } from './components/PreflightModal';
import { FloatingTransferModal, ActiveTransferItem } from './components/FloatingTransferModal';
import { LaundryWorkflowState, isModelMatch, detectZipPlanKind } from './components/ModelLaundryWorkflow';

export const App: React.FC = () => {
  const {
    bridges,
    devices,
    activeJobs,
    jobHistory,
    workflows: serverWorkflows,
    syncWorkflows,
    uiState,
    updateUiState,
    transfers,
    startTransfer,
    pauseResumeTransfer,
    cancelTransfer,
    closeTransferModal,
    preflightReports,
    triggerPreflightCheck,
    laundryAnalysis,
    runSuite,
    cancelRun,
    resetBusy,
    setDeviceLamp,
    analyzeLaundry,
    deleteHistoryItem,
    clearHistory,
  } = useFleetWebSocket();

  const theme = uiState.theme || 'dark';

  const toggleTheme = () => {
    updateUiState({ theme: theme === 'dark' ? 'light' : 'dark' });
  };

  const isLaundryModalOpen = uiState.isLaundryModalOpen;
  const isTerminalModalOpen = uiState.isTerminalModalOpen;
  const isPreflightModalOpen = uiState.isPreflightModalOpen;
  const activeWorkflowIdForPicker = uiState.activeWorkflowIdForPicker;
  const pickerPcId = uiState.pickerPcId;
  const selectedStandbySerials = uiState.selectedStandbySerials || [];
  const searchQuery = uiState.searchQuery || '';
  const selectedPcFilter = uiState.selectedPcFilter || 'ALL';
  const selectedModeFilter = uiState.selectedModeFilter || 'all';
  const terminalSelectedRunId = uiState.terminalSelectedRunId || '';

  const runningSectionRef = useRef<HTMLDivElement>(null);

  // Collect all available zips across all connected bridges
  const allAvailableZips = useMemo(() => {
    return bridges.flatMap((b) => b.laundryZips || []);
  }, [bridges]);

  // Manage multiple laundry workflows (unified on server + synced across all devices)
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

  // When server broadcasts unified workflows, update local state
  useEffect(() => {
    if (serverWorkflows && serverWorkflows.length > 0) {
      setWorkflows(serverWorkflows);
      localStorage.setItem('gba_laundry_workflows', JSON.stringify(serverWorkflows));
    }
  }, [serverWorkflows]);

  // Persist workflows
  useEffect(() => {
    localStorage.setItem('gba_laundry_workflows', JSON.stringify(workflows));
  }, [workflows]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gba_theme', theme);
  }, [theme]);

  // Workflow Handlers
  const handleUpdateWorkflow = (updated: LaundryWorkflowState) => {
    const next = workflows.map((w) => (w.id === updated.id ? updated : w));
    setWorkflows(next);
    syncWorkflows(next);
  };

  const handleRemoveWorkflow = (id: string) => {
    const next = workflows.filter((w) => w.id !== id);
    setWorkflows(next);
    syncWorkflows(next);
  };

  const handleAddWorkflow = () => {
    const newWorkflow: LaundryWorkflowState = {
      id: `wf-${Date.now()}`,
      model: '',
      pda: '',
      selectedModules: [],
      selectedSerials: [],
    };
    const next = [...workflows, newWorkflow];
    setWorkflows(next);
    syncWorkflows(next);
  };

  const handleOpenLaundryPicker = (workflowId: string, pcId?: string) => {
    updateUiState({
      isLaundryModalOpen: true,
      activeWorkflowIdForPicker: workflowId,
      pickerPcId: pcId || (bridges[0]?.pcId ?? ''),
    });
  };

  const setTerminalSelectedRunId = (runId: string) => {
    updateUiState({ terminalSelectedRunId: runId });
  };

  // Standby Devices Handlers
  const handleToggleSelectStandbyDevice = (serial: string) => {
    const next = selectedStandbySerials.includes(serial)
      ? selectedStandbySerials.filter((s) => s !== serial)
      : [...selectedStandbySerials, serial];
    updateUiState({ selectedStandbySerials: next });
  };

  const handleSelectAllStandbyDevices = (serials: string[]) => {
    updateUiState({ selectedStandbySerials: serials });
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

      const runId = `run-${Date.now()}`;
      setTerminalSelectedRunId(runId);
      runSuite(pcId, {
        run_id: runId,
        test_type: testType,
        target_model: targetModel,
        user_devices: userDevices,
        userdebug_devices: userdebugDevices,
        retry_count: 5,
        timeout_secs: 86400,
      });
    });
    // Smoothly focus on running workflow section instead of opening popup modal
    if (runningSectionRef.current) {
      runningSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleRunLaundrySuite = (pcId: string, payload: any) => {
    const runId = payload.run_id || `run-${Date.now()}`;
    const finalPayload = { ...payload, run_id: runId };
    setTerminalSelectedRunId(runId);
    runSuite(pcId, finalPayload);
    // Smoothly focus on running workflow section instead of opening popup modal
    if (runningSectionRef.current) {
      runningSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const activePickerBridge = bridges.find((b) => b.pcId === pickerPcId) || bridges[0];
  const zipsForPicker = activePickerBridge?.laundryZips || allAvailableZips;

  const preflightIssueCount = useMemo(() => {
    return preflightReports.reduce((acc, rep) => {
      return acc + rep.items.filter((i) => i.status === 'MISSING' || i.status === 'WARN').length;
    }, 0);
  }, [preflightReports]);

  return (
    <div className="app-container">
      <FleetHeader
        onlineBridgesCount={bridges.length}
        devicesCount={devices.length}
        activeJobsCount={activeJobs.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenPreflight={() => updateUiState({ isPreflightModalOpen: true })}
        preflightIssueCount={preflightIssueCount}
      />
      <main className="main-content">
        {/* Standalone Filter Toolbar Card at Top */}
        <FilterToolbarCard
          searchQuery={searchQuery}
          onSearchChange={(q) => updateUiState({ searchQuery: q })}
          selectedPcId={selectedPcFilter}
          onPcIdChange={(pc) => updateUiState({ selectedPcFilter: pc })}
          selectedMode={selectedModeFilter}
          onModeChange={(m) => updateUiState({ selectedModeFilter: m })}
          bridges={bridges}
          activeJobsCount={activeJobs.length}
          onToggleTerminalLogs={() => updateUiState({ isTerminalModalOpen: true })}
        />

        {/* Active Running Test Suites & Live Logs */}
        <div ref={runningSectionRef}>
          <RunningWorkflowAccordion
            activeJobs={activeJobs}
            jobHistory={jobHistory}
            devices={devices}
            onCancelJob={cancelRun}
          />
        </div>

        {/* Top Section: Model Laundry Workflows (Octopus-style Accordion) */}
        <LaundryWorkflowSection
          workflows={workflows}
          devices={devices}
          availableZips={allAvailableZips}
          activeJobs={activeJobs}
          jobHistory={jobHistory}
          laundryAnalysis={laundryAnalysis}
          onUpdateWorkflow={handleUpdateWorkflow}
          onRemoveWorkflow={handleRemoveWorkflow}
          onAddWorkflow={handleAddWorkflow}
          onOpenLaundryPicker={handleOpenLaundryPicker}
          onRunSuite={handleRunLaundrySuite}
          onToggleLamp={setDeviceLamp}
        />

        {/* Bottom Section: Standby Devices with Direct Testplans & Model Pills */}
        <StandbyDevicesAccordion
          devices={devices}
          selectedSerials={selectedStandbySerials}
          isExpanded={uiState.standbyExpanded}
          onToggleExpand={() => updateUiState({ standbyExpanded: !uiState.standbyExpanded })}
          activeTestPlan={uiState.standbyTestPlan}
          onTestPlanChange={(plan) => updateUiState({ standbyTestPlan: plan })}
          selectedModelFilter={uiState.standbyModelFilter}
          onModelFilterChange={(model) => updateUiState({ standbyModelFilter: model })}
          onToggleSelect={handleToggleSelectStandbyDevice}
          onSelectAll={handleSelectAllStandbyDevices}
          onDirectRunSuite={handleDirectRunSuite}
          onToggleLamp={setDeviceLamp}
          onResetBusy={resetBusy}
          searchQuery={searchQuery}
          selectedPcFilter={selectedPcFilter}
          filterType={selectedModeFilter}
        />

        {/* Results History */}
        <ResultsExplorer
          history={jobHistory}
          isExpanded={uiState.resultsExpanded}
          onToggleExpand={() => updateUiState({ resultsExpanded: !uiState.resultsExpanded })}
          onDeleteHistoryItem={deleteHistoryItem}
          onClearAllHistory={clearHistory}
        />

        {/* Laundry Zip Modal Picker */}
        <LaundrySelectModal
          isOpen={isLaundryModalOpen}
          onClose={() => updateUiState({ isLaundryModalOpen: false })}
          pcId={pickerPcId || activePickerBridge?.pcId || 'LOCAL'}
          zips={zipsForPicker}
          devices={devices}
          laundryAnalysis={laundryAnalysis}
          onAnalyzeZip={analyzeLaundry}
          onConfirmSelection={(zipPath, rows) => {
            if (activeWorkflowIdForPicker) {
              const wf = workflows.find((w) => w.id === activeWorkflowIdForPicker);
              if (wf) {
                // 1. Extract model, AP version, and plan from XML rows or zip filename
                let detectedModel = rows.find((r) => r.model)?.model || '';
                const detectedAp = rows.find((r) => r.ap_version)?.ap_version || '';
                const detectedPlan = detectZipPlanKind(rows, zipPath, rows.find((r) => r.plan)?.plan);
                let detectedPda = detectedAp;

                if (!detectedModel) {
                  const filename = zipPath.split('/').pop() || '';
                  const base = filename.replace(/\.zip$/i, '');
                  const firstToken = base.split('_')[0] || '';
                  detectedPda = detectedPda || firstToken;

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

                // 2. Find online devices matching this detected model (with underscore/hyphen normalization)
                const matchingDevs = devices.filter((d) =>
                  detectedModel ? isModelMatch(d.model, detectedModel) : false
                );

                // Auto select all module rows and all matching devices
                const allModuleNames = rows.map((r) => r.testcase || r.suite);

                handleUpdateWorkflow({
                  ...wf,
                  model: detectedModel || '',
                  pda: detectedAp || detectedPda || (matchingDevs[0]?.pda ?? ''),
                  ap_version: detectedAp || detectedPda || (matchingDevs[0]?.pda ?? ''),
                  plan: detectedPlan,
                  selectedZip: zipPath,
                  cachedRows: rows,
                  selectedModules: allModuleNames,
                  selectedSerials: matchingDevs.map((d) => d.serial),
                });
                updateUiState({ isLaundryModalOpen: false });
              }
            }
          }}
        />

        {/* Terminal Logs Modal */}
        <TerminalLogsModal
          isOpen={isTerminalModalOpen}
          onClose={() => updateUiState({ isTerminalModalOpen: false })}
          activeJobs={activeJobs}
          jobHistory={jobHistory}
          selectedRunId={terminalSelectedRunId}
          onSelectRunId={(runId) => updateUiState({ terminalSelectedRunId: runId })}
          onCancelJob={cancelRun}
        />

        {/* Preflight Check Modal */}
        <PreflightModal
          isOpen={isPreflightModalOpen}
          onClose={() => updateUiState({ isPreflightModalOpen: false })}
          preflightReports={preflightReports}
          bridges={bridges}
          onTriggerScan={triggerPreflightCheck}
          onStartSync={startTransfer}
          selectedNodeFilter={uiState.preflightSelectedNode}
          onNodeFilterChange={(node) => updateUiState({ preflightSelectedNode: node })}
          searchQuery={uiState.preflightSearch}
          onSearchChange={(q) => updateUiState({ preflightSearch: q })}
          statusFilter={uiState.preflightStatusFilter}
          onStatusFilterChange={(s) => updateUiState({ preflightStatusFilter: s })}
        />

        {/* Floating Accordion Transfer Modal (Bottom-Left) */}
        {uiState.transferModalOpen && (
          <FloatingTransferModal
            transfers={transfers}
            isExpanded={uiState.transferModalExpanded}
            onToggleExpand={() =>
              updateUiState({ transferModalExpanded: !uiState.transferModalExpanded })
            }
            onPauseResume={pauseResumeTransfer}
            onCancel={cancelTransfer}
            onClose={closeTransferModal}
          />
        )}
      </main>
    </div>
  );
};
export default App;
