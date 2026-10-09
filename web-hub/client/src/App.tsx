import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useFleetWebSocket, LaundryRow, LaundryZipItem } from './hooks/useFleetWebSocket';
import { FleetHeader } from './components/FleetHeader';
import { FilterToolbarCard } from './components/FilterToolbarCard';
import { LaundryWorkflowSection } from './components/LaundryWorkflowSection';
import { StandbyDevicesAccordion } from './components/StandbyDevicesAccordion';
import { RunningWorkflowAccordion } from './components/RunningWorkflowAccordion';
import { ResultsExplorer } from './components/ResultsExplorer';
import { LaundrySelectModal, normalizeModelName } from './components/LaundrySelectModal';
import { TerminalLogsModal } from './components/TerminalLogsModal';
import { PreflightModal } from './components/PreflightModal';
import { FloatingTransferModal, ActiveTransferItem } from './components/FloatingTransferModal';
import { LaundryWorkflowState, isModelMatch, isDeviceFingerprintMatch, detectZipPlanKind } from './components/ModelLaundryWorkflow';

export const App: React.FC = () => {
  const {
    bridges,
    devices,
    activeJobs,
    jobHistory,
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
    cancellingRunIds,
    resetBusy,
    setDeviceLamp,
    analyzeLaundry,
    deleteHistoryItem,
    clearHistory,
  } = useFleetWebSocket();

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('gba_theme') as 'dark' | 'light') || 'dark';
  });

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Local UI states (filters, search, modals visibility)
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPcFilter, setSelectedPcFilter] = useState('ALL');
  const [selectedModeFilter, setSelectedModeFilter] = useState<'all' | 'user' | 'userdebug' | 'busy'>('all');

  const [selectedStandbySerials, setSelectedStandbySerials] = useState<string[]>([]);
  const [standbyTestPlan, setStandbyTestPlan] = useState<'SMR' | 'SKU' | 'NORMAL' | 'STS'>('SMR');
  const [standbyModelFilter, setStandbyModelFilter] = useState('ALL');

  const [isLaundryModalOpen, setIsLaundryModalOpen] = useState(false);
  const [isTerminalModalOpen, setIsTerminalModalOpen] = useState(false);
  const [isPreflightModalOpen, setIsPreflightModalOpen] = useState(false);
  const [activeWorkflowIdForPicker, setActiveWorkflowIdForPicker] = useState('');
  const [pickerPcId, setPickerPcId] = useState('');
  const [terminalSelectedRunId, setTerminalSelectedRunId] = useState('');

  const [preflightSelectedNode, setPreflightSelectedNode] = useState('ALL');
  const [preflightSearch, setPreflightSearch] = useState('');
  const [preflightStatusFilter, setPreflightStatusFilter] = useState<'ALL' | 'ISSUES' | 'OK'>('ALL');

  const runningSectionRef = useRef<HTMLDivElement>(null);

  // Collect all available zips across all connected bridges with source pcId (strictly deduplicated by filename)
  const allAvailableZips = useMemo(() => {
    const map = new Map<string, LaundryZipItem>();
    bridges.forEach((b) => {
      const nodePcId = b.pcId || 'Node';
      (b.laundryZips || []).forEach((z) => {
        if (!map.has(z.filename)) {
          map.set(z.filename, {
            ...z,
            model: normalizeModelName(z.model || z.filename),
            pcId: z.pcId || nodePcId,
          });
        }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.modifiedAt - a.modifiedAt);
  }, [bridges]);

  // Manage multiple laundry workflows purely in client localStorage
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

  // Persist workflows to localStorage on any change
  useEffect(() => {
    localStorage.setItem('gba_laundry_workflows', JSON.stringify(workflows));
  }, [workflows]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gba_theme', theme);
  }, [theme]);

  // Workflow Handlers (strictly local state, no server race conditions)
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
    setPickerPcId(pcId || '');
    setIsLaundryModalOpen(true);
  };

  // Standby Devices Handlers
  const handleToggleSelectStandbyDevice = (serial: string) => {
    setSelectedStandbySerials((prev) =>
      prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]
    );
  };

  const handleSelectAllStandbyDevices = (serials: string[]) => {
    setSelectedStandbySerials(serials);
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
  const zipsForPicker = allAvailableZips;

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
        onOpenPreflight={() => setIsPreflightModalOpen(true)}
        preflightIssueCount={preflightIssueCount}
      />
      <main className="main-content">
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
          onToggleTerminalLogs={() => setIsTerminalModalOpen(true)}
        />

        {/* Active Running Test Suites & Live Logs */}
        <div ref={runningSectionRef}>
          <RunningWorkflowAccordion
            activeJobs={activeJobs}
            jobHistory={jobHistory}
            devices={devices}
            cancellingRunIds={cancellingRunIds}
            onCancelJob={cancelRun}
            onDeleteRun={deleteHistoryItem}
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
          activeTestPlan={standbyTestPlan}
          onTestPlanChange={setStandbyTestPlan}
          selectedModelFilter={standbyModelFilter}
          onModelFilterChange={setStandbyModelFilter}
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
          onClose={() => setIsLaundryModalOpen(false)}
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
                    detectedModel = firstToken.replace(/^SM-/i, '').toUpperCase();
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
                      detectedModel = modelPart.toUpperCase();
                    }
                  }
                }
                detectedModel = detectedModel.replace(/^SM-/i, '');

                const detectedFp = rows.find((r) => r.fingerprint)?.fingerprint || '';

                // 2. Find online devices matching this detected model AND matching fingerprint
                const matchingDevs = devices.filter((d) => {
                  if (!detectedModel || !isModelMatch(d.model, detectedModel)) return false;
                  return isDeviceFingerprintMatch(d, detectedFp, detectedAp, detectedPda);
                });

                // For Laundry SMR, ensure we select at least 1 USER and 1 USERDEBUG if available
                let initialSerials: string[] = [];
                if (detectedPlan === 'SMR') {
                  const userDevs = matchingDevs.filter((d) => !d.is_userdebug);
                  const userdebugDevs = matchingDevs.filter((d) => d.is_userdebug);
                  initialSerials = [...userDevs.map((d) => d.serial), ...userdebugDevs.map((d) => d.serial)];
                } else {
                  initialSerials = matchingDevs.map((d) => d.serial);
                }

                // Auto select all module rows and all matching devices
                const allModuleNames = rows.map((r) => r.testcase || r.suite);

                handleUpdateWorkflow({
                  ...wf,
                  model: detectedModel || '',
                  pda: detectedAp || detectedPda || (matchingDevs[0]?.pda ?? ''),
                  ap_version: detectedAp || detectedPda || (matchingDevs[0]?.pda ?? ''),
                  fingerprint: detectedFp,
                  plan: detectedPlan,
                  selectedZip: zipPath,
                  cachedRows: rows,
                  selectedModules: allModuleNames,
                  selectedSerials: initialSerials,
                });
                setIsLaundryModalOpen(false);
              }
            }
          }}
        />

        {/* Terminal Logs Modal */}
        <TerminalLogsModal
          isOpen={isTerminalModalOpen}
          onClose={() => setIsTerminalModalOpen(false)}
          activeJobs={activeJobs}
          jobHistory={jobHistory}
          selectedRunId={terminalSelectedRunId}
          onSelectRunId={setTerminalSelectedRunId}
          onCancelJob={cancelRun}
        />

        {/* Preflight Check Modal */}
        <PreflightModal
          isOpen={isPreflightModalOpen}
          onClose={() => setIsPreflightModalOpen(false)}
          preflightReports={preflightReports}
          bridges={bridges}
          onTriggerScan={triggerPreflightCheck}
          onStartSync={startTransfer}
          selectedNodeFilter={preflightSelectedNode}
          onNodeFilterChange={setPreflightSelectedNode}
          searchQuery={preflightSearch}
          onSearchChange={setPreflightSearch}
          statusFilter={preflightStatusFilter}
          onStatusFilterChange={setPreflightStatusFilter}
        />

        {/* Floating Accordion Transfer Modal (Bottom-Left) */}
        {(uiState.transferModalOpen || transfers.some((t) => t.status === 'running' || t.status === 'extracting')) && (
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
