import React, { useState, useEffect } from 'react';
import { useFleetWebSocket, LaundryRow } from './hooks/useFleetWebSocket';
import { FleetHeader } from './components/FleetHeader';
import { DeviceTableView } from './components/DeviceTableView';
import { RunningWorkflowAccordion } from './components/RunningWorkflowAccordion';
import { ResultsExplorer } from './components/ResultsExplorer';
import { TestRunnerModal } from './components/TestRunnerModal';
import { LaundrySelectModal } from './components/LaundrySelectModal';

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

  const [selectedSerials, setSelectedSerials] = useState<string[]>([]);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [isLaundryModalOpen, setIsLaundryModalOpen] = useState(false);
  const [activeLaundryPcId, setActiveLaundryPcId] = useState('');
  const [selectedLaundryZip, setSelectedLaundryZip] = useState('');
  const [selectedLaundryRows, setSelectedLaundryRows] = useState<LaundryRow[]>([]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('gba_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleToggleSelectDevice = (serial: string) => {
    setSelectedSerials((prev) =>
      prev.includes(serial) ? prev.filter((s) => s !== serial) : [...prev, serial]
    );
  };

  const handleOpenRunModal = (serials: string[]) => {
    setSelectedSerials(serials);
    setIsRunModalOpen(true);
  };

  const handleOpenLaundryPicker = (pcId: string) => {
    setActiveLaundryPcId(pcId);
    setIsLaundryModalOpen(true);
  };

  const activeBridgeNode = bridges.find((b) => b.pcId === activeLaundryPcId);

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

        <RunningWorkflowAccordion
          activeJobs={activeJobs}
          onCancelJob={cancelRun}
        />

        <DeviceTableView
          devices={devices}
          selectedSerials={selectedSerials}
          onToggleSelect={handleToggleSelectDevice}
          onSelectAll={setSelectedSerials}
          onOpenRunModal={handleOpenRunModal}
          onToggleLamp={setDeviceLamp}
          onResetBusy={resetBusy}
        />

        <ResultsExplorer history={jobHistory} />

        <TestRunnerModal
          isOpen={isRunModalOpen}
          onClose={() => setIsRunModalOpen(false)}
          devices={devices}
          selectedSerials={selectedSerials}
          onStartRun={runSuite}
          onOpenLaundryPicker={handleOpenLaundryPicker}
          selectedLaundryZip={selectedLaundryZip}
          selectedLaundryRows={selectedLaundryRows}
        />

        <LaundrySelectModal
          isOpen={isLaundryModalOpen}
          onClose={() => setIsLaundryModalOpen(false)}
          pcId={activeLaundryPcId}
          zips={activeBridgeNode?.laundryZips || []}
          laundryAnalysis={laundryAnalysis}
          onAnalyzeZip={analyzeLaundry}
          onConfirmSelection={(zipPath, rows) => {
            setSelectedLaundryZip(zipPath);
            setSelectedLaundryRows(rows);
          }}
        />
      </main>
    </div>
  );
};
export default App;
