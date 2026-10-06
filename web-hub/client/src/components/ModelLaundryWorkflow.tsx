import React, { useState, useMemo, useEffect } from 'react';
import { DeviceItem, LaundryRow, LaundryZipItem, ActiveJobItem } from '../hooks/useFleetWebSocket';
import { ChevronDownIcon, ChevronUpIcon, PlayIcon, TrashIcon, SmartphoneIcon, LampIcon } from './Icons';
import { useAlertModal } from '../context/AlertContext';

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
  fingerprint?: string;
  cachedRows?: LaundryRow[];
  isExpanded?: boolean;
  isLaundryExpanded?: boolean;
  isDevicesExpanded?: boolean;
  isResultsExpanded?: boolean;
}

import { formatDurationHms } from '../utils/formatters';

export function isModelMatch(m1?: string, m2?: string): boolean {
  if (!m1 || !m2) return false;
  const n1 = m1.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n2 = m2.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n1 === n2 || n1.endsWith(n2) || n2.endsWith(n1);
}

export function isDeviceFingerprintMatch(
  dev: DeviceItem,
  zipFingerprint?: string,
  zipAp?: string,
  zipPda?: string
): boolean {
  const targetFp = (zipFingerprint || '').trim().toLowerCase();
  const targetAp = (zipAp || zipPda || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const devFp = (dev.fingerprint || '').trim().toLowerCase();
  const devPda = (dev.pda || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (targetFp && devFp) {
    if (targetFp === devFp) return true;
    const normTarget = targetFp.replace(/:(user|userdebug)\//g, ':any/');
    const normDev = devFp.replace(/:(user|userdebug)\//g, ':any/');
    if (normTarget === normDev) return true;
    if (devFp.includes(targetFp) || targetFp.includes(devFp)) return true;
  }

  if (targetAp && devPda) {
    if (targetAp === devPda || targetAp.includes(devPda) || devPda.includes(targetAp)) {
      return true;
    }
  }

  if (targetAp && devFp) {
    if (devFp.toUpperCase().includes(targetAp)) {
      return true;
    }
  }

  if (!targetFp && !targetAp) {
    return true;
  }

  return false;
}

export const formatDuration = formatDurationHms;

export function detectZipPlanKind(rows?: LaundryRow[], zipPath?: string, existingPlan?: string): 'SKU' | 'SMR' | 'Normal' {
  const rowList = Array.isArray(rows) ? rows : [];
  const directRowPlan = rowList.find((r) => r.plan && ['SKU', 'SMR', 'Normal'].includes(r.plan))?.plan;
  if (directRowPlan && ['SKU', 'SMR', 'Normal'].includes(directRowPlan)) {
    return directRowPlan as 'SKU' | 'SMR' | 'Normal';
  }

  const zipLower = (zipPath || '').toLowerCase();
  if (zipLower.includes('ctssku') || zipLower.includes('cts_sku') || zipLower.includes('sku')) {
    return 'SKU';
  }
  if (zipLower.includes('ctssmr') || zipLower.includes('cts_smr') || zipLower.includes('gtsmr') || zipLower.includes('gtssmr') || zipLower.includes('smr') || zipLower.includes('sts')) {
    return 'SMR';
  }

  if (existingPlan && ['SKU', 'SMR', 'Normal'].includes(existingPlan)) {
    return existingPlan as 'SKU' | 'SMR' | 'Normal';
  }

  return 'Normal';
}

interface ModelLaundryWorkflowProps {
  workflow: LaundryWorkflowState;
  allDevices: DeviceItem[];
  availableZips: LaundryZipItem[];
  activeJobs?: ActiveJobItem[];
  jobHistory?: ActiveJobItem[];
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
  activeJobs = [],
  jobHistory = [],
  laundryAnalysis,
  onUpdateWorkflow,
  onRemoveWorkflow,
  onOpenLaundryPicker,
  onRunSuite,
  onToggleLamp,
}) => {
  const isExpanded = workflow.isExpanded !== undefined ? workflow.isExpanded : true;
  const isLaundryExpanded = workflow.isLaundryExpanded !== undefined ? workflow.isLaundryExpanded : true;
  const isDevicesExpanded = workflow.isDevicesExpanded !== undefined ? workflow.isDevicesExpanded : true;
  const isResultsExpanded = workflow.isResultsExpanded !== undefined ? workflow.isResultsExpanded : true;

  const toggleExpanded = () => onUpdateWorkflow({ ...workflow, isExpanded: !isExpanded });
  const toggleLaundryExpanded = () => onUpdateWorkflow({ ...workflow, isLaundryExpanded: !isLaundryExpanded });
  const toggleDevicesExpanded = () => onUpdateWorkflow({ ...workflow, isDevicesExpanded: !isDevicesExpanded });
  const toggleResultsExpanded = () => onUpdateWorkflow({ ...workflow, isResultsExpanded: !isResultsExpanded });

  const [, setLiveTick] = useState(0);
  useEffect(() => {
    const hasRunning = activeJobs.some((j) => j.status === 'Running' || j.status === 'Starting');
    if (!hasRunning) return;
    const interval = setInterval(() => setLiveTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeJobs]);

  // Auto-cache parsed analysis rows into workflow so they are permanently preserved across test runs
  useEffect(() => {
    if (
      laundryAnalysis &&
      laundryAnalysis.zip_path === workflow.selectedZip &&
      Array.isArray(laundryAnalysis.rows) &&
      laundryAnalysis.rows.length > 0
    ) {
      if (!workflow.cachedRows || workflow.cachedRows.length !== laundryAnalysis.rows.length) {
        onUpdateWorkflow({
          ...workflow,
          cachedRows: laundryAnalysis.rows,
        });
      }
    }
  }, [laundryAnalysis, workflow.selectedZip, workflow.cachedRows]);

  // Filter devices matching this workflow's model with flexible underscore/hyphen normalization
  const matchingDevices = useMemo(() => {
    if (!workflow.model) return [];
    return allDevices.filter((d) => isModelMatch(d.model, workflow.model));
  }, [allDevices, workflow.model]);

  // Combined execution results for this model
  const workflowResults = useMemo(() => {
    const allJobs = [...activeJobs, ...jobHistory];
    const serialSet = new Set(matchingDevices.map((d) => d.serial));
    return allJobs.filter((job) => {
      // Match by device serial
      if (Array.isArray(job.devices) && job.devices.some((s) => serialSet.has(s))) {
        return true;
      }
      // Match by model name
      if (workflow.model) {
        if (job.summary?.test_type && isModelMatch(job.summary.test_type, workflow.model)) return true;
        if (job.test_type && isModelMatch(job.test_type, workflow.model)) return true;
        if (job.suite && isModelMatch(job.suite, workflow.model)) return true;
      }
      return false;
    });
  }, [activeJobs, jobHistory, matchingDevices, workflow.model]);

  // Active test run job specifically for this workflow
  const activeJob = useMemo(() => {
    const serialSet = new Set(matchingDevices.map((d) => d.serial));
    return activeJobs.find((j) => {
      if (Array.isArray(j.devices) && j.devices.some((s) => serialSet.has(s))) return true;
      if (workflow.model) {
        if (j.summary?.test_type && isModelMatch(j.summary.test_type, workflow.model)) return true;
        if (j.test_type && isModelMatch(j.test_type, workflow.model)) return true;
        if (j.suite && isModelMatch(j.suite, workflow.model)) return true;
      }
      return false;
    });
  }, [activeJobs, matchingDevices, workflow.model]);

  const isWorkflowRunning = Boolean(activeJob);

  // Latest finished test run job specifically for this workflow
  const latestFinishedJob = useMemo(() => {
    const serialSet = new Set(matchingDevices.map((d) => d.serial));
    return jobHistory.find((j) => {
      if (Array.isArray(j.devices) && j.devices.some((s) => serialSet.has(s))) return true;
      if (workflow.model) {
        if (j.summary?.test_type && isModelMatch(j.summary.test_type, workflow.model)) return true;
        if (j.test_type && isModelMatch(j.test_type, workflow.model)) return true;
        if (j.suite && isModelMatch(j.suite, workflow.model)) return true;
      }
      return false;
    });
  }, [jobHistory, matchingDevices, workflow.model]);

  // Determine active analysis rows (uses live laundryAnalysis or fallback to cachedRows)
  const analysisRows: LaundryRow[] = useMemo(() => {
    if (laundryAnalysis && laundryAnalysis.zip_path === workflow.selectedZip && Array.isArray(laundryAnalysis.rows) && laundryAnalysis.rows.length > 0) {
      return laundryAnalysis.rows;
    }
    if (Array.isArray(workflow.cachedRows) && workflow.cachedRows.length > 0) {
      return workflow.cachedRows;
    }
    return [];
  }, [laundryAnalysis, workflow.selectedZip, workflow.cachedRows]);

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

  const { showAlert } = useAlertModal();

  const handleRunLaundryAutomation = () => {
    if (workflow.selectedSerials.length === 0) {
      showAlert({
        title: 'Perangkat Belum Dipilih',
        message: 'Pilih minimal 1 perangkat yang tersedia untuk menjalankan automasi Laundry.',
        type: 'warning',
      });
      return;
    }

    const targetDev = matchingDevices.find((d) => workflow.selectedSerials.includes(d.serial));
    const targetPcId = targetDev ? targetDev.pcId : workflow.pcId || (allDevices[0]?.pcId ?? 'LOCAL');

    const selectedRowsData = analysisRows.filter((r) =>
      workflow.selectedModules.includes(r.testcase || r.suite)
    );

    const userDevices = workflow.selectedSerials.filter((s) => {
      const dev = allDevices.find((d) => d.serial === s);
      return dev ? !dev.is_userdebug : false;
    });

    const userdebugDevices = workflow.selectedSerials.filter((s) => {
      const dev = allDevices.find((d) => d.serial === s);
      return dev ? dev.is_userdebug : false;
    });

    const detectedPlanName = detectZipPlanKind(analysisRows, workflow.selectedZip, workflow.plan);

    // 1. Laundry SMR Validation: Must have at least 1 USER and at least 1 USERDEBUG device
    if (detectedPlanName === 'SMR') {
      if (userDevices.length === 0 || userdebugDevices.length === 0) {
        showAlert({
          title: 'Ketentuan Perangkat SMR',
          message: 'Laundry SMR memerlukan minimal 1 perangkat build type USER untuk CTS/GTS dan minimal 1 perangkat USERDEBUG untuk STS.',
          details: [
            'CTS & GTS Retry: Memerlukan perangkat build type USER',
            'STS Retry: Memerlukan perangkat build type USERDEBUG',
          ],
          type: 'warning',
        });
        return;
      }
    }

    // 2. Fingerprint & Build Validation: Ensure devices (especially USER devices) match the zip fingerprint/PDA
    const targetFp = analysisRows.find((r) => r.fingerprint)?.fingerprint || workflow.fingerprint || '';
    const targetAp = workflow.ap_version || workflow.pda || analysisRows.find((r) => r.ap_version)?.ap_version || '';

    const mismatchedDevices: { serial: string; model: string; is_userdebug: boolean; pda: string }[] = [];
    workflow.selectedSerials.forEach((s) => {
      const dev = allDevices.find((d) => d.serial === s);
      if (dev && !isDeviceFingerprintMatch(dev, targetFp, targetAp, workflow.pda)) {
        mismatchedDevices.push({
          serial: dev.serial,
          model: dev.model,
          is_userdebug: dev.is_userdebug,
          pda: dev.pda || dev.fingerprint || '-',
        });
      }
    });

    if (mismatchedDevices.length > 0) {
      showAlert({
        title: 'Fingerprint Tidak Cocok',
        message: `Versi build perangkat tidak sesuai dengan target file zip ${targetAp || targetFp || workflow.model}. Pastikan fingerprint sama.`,
        details: mismatchedDevices.map(
          (d) => `${d.serial} (${d.is_userdebug ? 'USERDEBUG' : 'USER'}) — Build: ${d.pda}`
        ),
        type: 'error',
      });
      return;
    }

    const laundryTestType = `Laundry ${detectedPlanName}`;
    onRunSuite(targetPcId, {
      test_type: laundryTestType,
      target_model: workflow.model,
      laundry_zip_path: workflow.selectedZip,
      selected_laundry_results: workflow.selectedModules,
      selected_laundry_rows: selectedRowsData,
      user_devices: userDevices,
      userdebug_devices: userdebugDevices,
      retry_count: 5,
      timeout_secs: 86400,
    });

    onUpdateWorkflow({ ...workflow, isExpanded: false });
  };

  const planName = detectZipPlanKind(analysisRows, workflow.selectedZip, workflow.plan);
  const apVersion = workflow.ap_version || workflow.pda || (matchingDevices[0]?.pda ?? '');
  const isLoaded = Boolean(workflow.selectedZip);
  const titleText = isLoaded
    ? `Laundry ${planName}`
    : 'Pilih Zip Test';
  const hasUserdebug = matchingDevices.some((d) => d.is_userdebug);

  // Fetch and list available result ZIPs from server
  const [serverResultZips, setServerResultZips] = useState<Array<{
    filename: string;
    path: string;
    sizeBytes: number;
    modifiedAt: number;
    model?: string;
    plan?: string;
    suite?: string;
    test_type?: string;
    devsCount?: number;
    run_batch?: string;
    subFilesCount?: number;
    isIndividualSuite?: boolean;
    isMasterBatch?: boolean;
    summary?: { total: number; passed: number; failed: number; run_time?: string; completed_time?: string };
  }>>([]);

  useEffect(() => {
    let isMounted = true;
    fetch('/api/results/list')
      .then((res) => (res.ok ? res.json() : { zips: [] }))
      .then((data) => {
        if (isMounted && Array.isArray(data.zips)) {
          setServerResultZips(data.zips);
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [workflowResults.length, isResultsExpanded]);

  // Find the latest session run batch for this model
  const latestBatchName = useMemo(() => {
    if (!workflow.model) return undefined;
    const activeOrLatest = activeJob || latestFinishedJob;
    if (activeOrLatest?.run_id) {
      const match = serverResultZips.find(
        (z) => z.run_batch && (activeOrLatest.run_id.includes(z.run_batch) || z.run_batch.includes(activeOrLatest.run_id))
      );
      if (match?.run_batch) return match.run_batch;
    }

    const modelBatches = serverResultZips
      .filter((z) => isModelMatch(z.model, workflow.model) && z.run_batch)
      .map((z) => ({ batch: z.run_batch!, modifiedAt: z.modifiedAt || 0 }));
    modelBatches.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return modelBatches[0]?.batch;
  }, [workflow.model, activeJob, latestFinishedJob, serverResultZips]);

  // Filter ready-to-download ZIPs strictly for this workflow's model (Latest session run only)
  const readyDownloadZips = useMemo(() => {
    if (!workflow.model || !latestBatchName) {
      return [];
    }

    const list: Array<{
      filename: string;
      path?: string;
      sizeBytes?: number;
      modifiedAt?: number;
      plan?: string;
      suite?: string;
      test_type?: string;
      status?: string;
      run_id?: string;
      isIndividualSuite?: boolean;
      summary?: { total: number; passed: number; failed: number; run_time?: string; completed_time?: string };
    }> = [];

    const seenFilenames = new Set<string>();

    // 1. Get individual suite retry ZIPs strictly from the latest session run
    for (const sZip of serverResultZips) {
      if (sZip.isIndividualSuite && sZip.run_batch === latestBatchName && !seenFilenames.has(sZip.filename)) {
        if (sZip.model && isModelMatch(sZip.model, workflow.model)) {
          seenFilenames.add(sZip.filename);
          list.push({
            filename: sZip.filename,
            path: sZip.path,
            sizeBytes: sZip.sizeBytes,
            modifiedAt: sZip.modifiedAt,
            plan: sZip.plan || 'SMR',
            suite: sZip.suite || (sZip.filename.includes('CTS') ? 'CTS' : sZip.filename.includes('GTS') ? 'GTS' : 'STS'),
            test_type: `${sZip.plan || 'SMR'} / ${sZip.suite || (sZip.filename.includes('CTS') ? 'CTS' : sZip.filename.includes('GTS') ? 'GTS' : 'STS')}`,
            status: 'Finished',
            run_id: latestBatchName,
            isIndividualSuite: true,
            summary: sZip.summary,
          });
        }
      }
    }

    // 2. Active & Finished jobs individual suite ZIPs belonging to this session
    for (const job of workflowResults) {
      if (job.run_id && !latestBatchName.includes(job.run_id) && !job.run_id.includes(latestBatchName)) {
        continue;
      }
      const zips = Array.isArray(job.zip_files) ? [...job.zip_files] : [];
      if (job.zip_file && !zips.includes(job.zip_file)) zips.unshift(job.zip_file);

      for (const z of zips) {
        if (!z) continue;
        const fname = z.split('/').pop() || z;
        if (!seenFilenames.has(fname) && !fname.startsWith('Laundry_')) {
          const isJobMatching = isModelMatch(job.test_type, workflow.model) ||
                                isModelMatch(job.suite, workflow.model) ||
                                isModelMatch(job.summary?.test_type, workflow.model) ||
                                isModelMatch(fname, workflow.model);
          if (!isJobMatching) continue;

          seenFilenames.add(fname);
          let sName = 'CTS';
          if (fname.includes('GTS')) sName = 'GTS';
          else if (fname.includes('STS')) sName = 'STS';

          list.push({
            filename: fname,
            path: z,
            plan: 'SMR',
            suite: sName,
            test_type: `SMR / ${sName}`,
            status: job.status,
            run_id: job.run_id,
            modifiedAt: job.startedAt,
            isIndividualSuite: true,
            summary: job.summary ? { total: job.summary.total, passed: job.summary.passed, failed: job.summary.failed } : undefined,
          });
        }
      }
    }

    // Sort: newest first
    list.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    return list;
  }, [workflowResults, serverResultZips, workflow.model, latestBatchName]);

  return (
    <div className="accordion-card">
      {/* Root Accordion Header */}
      <div className="accordion-header" onClick={toggleExpanded}>
        <div className="accordion-header-top">
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
            </div>
          </div>

          <div className="accordion-header-meta" onClick={(e) => e.stopPropagation()}>
            {isLoaded && (
              <span className="badge badge-unit badge-xs">
                {workflow.selectedSerials.length}/{matchingDevices.length} Unit
              </span>
            )}
          </div>
        </div>

        <div className="accordion-header-actions" onClick={(e) => e.stopPropagation()}>
          {isLoaded && (
            <>
              <button
                className={`btn ${isWorkflowRunning ? 'btn-running' : 'btn-suite-primary'} btn-action-full`}
                title={isWorkflowRunning ? 'Automasi sedang berlangsung' : 'Jalankan Cuci SMR untuk modul terpilih'}
                onClick={handleRunLaundryAutomation}
                disabled={workflow.selectedSerials.length === 0 || isWorkflowRunning}
              >
                <PlayIcon size={13} />
                <span>{isWorkflowRunning ? 'Sedang Berjalan...' : 'Jalankan Automasi'}</span>
              </button>
              <button
                className="btn-icon-danger"
                title="Hapus Laundry Workflow"
                onClick={() => onRemoveWorkflow(workflow.id)}
                aria-label="Remove workflow"
              >
                <TrashIcon size={15} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Root Accordion Body */}
      {isExpanded && (
        <div className="accordion-body">
          {/* Sub-Accordion 1: Laundry Zip & Module Table */}
          <div className="sub-accordion">
            <div
              className="sub-accordion-header"
              onClick={toggleLaundryExpanded}
            >
              <div className="sub-accordion-title">
                {isLaundryExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>HASIL PENGUJIAN</span>
              </div>
              <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                {workflow.selectedZip && analysisRows.length > 0 && (
                  <button
                    className="btn btn-secondary btn-xs"
                    disabled={isWorkflowRunning}
                    onClick={() => {
                      const allNames = analysisRows.map((r) => r.testcase || r.suite);
                      const allSelected = allNames.every((n) => workflow.selectedModules.includes(n));
                      onUpdateWorkflow({
                        ...workflow,
                        selectedModules: allSelected ? [] : allNames,
                      });
                    }}
                    title={isWorkflowRunning ? 'Readonly saat automasi sedang berjalan' : undefined}
                  >
                    {analysisRows.length > 0 && analysisRows.every((r) => workflow.selectedModules.includes(r.testcase || r.suite)) ? 'Uncheck' : 'Check'}
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-xs"
                  disabled={isWorkflowRunning}
                  onClick={() => onOpenLaundryPicker(workflow.id, workflow.pcId)}
                  title={isWorkflowRunning ? 'Tidak dapat mengganti Zip saat automasi sedang berjalan' : undefined}
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
                      <div className="laundry-path-display" title={workflow.selectedZip}>
                        <strong className="laundry-path-label">Zip:</strong>{' '}
                        <code className="laundry-path-code">{workflow.selectedZip.split('/').pop() || workflow.selectedZip}</code>
                      </div>
                      <div className="laundry-stats-chips">
                        <div className="laundry-chips-group">
                          <span className="badge badge-neutral badge-xs">
                            {analysisRows.length} Modul
                          </span>
                          <span className="badge badge-fail badge-xs">
                            {failedRows.length} Fail
                          </span>
                          <span className="badge badge-ready badge-xs">
                            {workflow.selectedModules.length} Terpilih
                          </span>
                        </div>
                      </div>
                    </div>

                    {analysisRows.length > 0 ? (
                      <div className="table-responsive laundry-modules-container">
                        <table className="data-table laundry-modules-table">
                          <thead>
                            <tr>
                              <th style={{ width: '56px', textAlign: 'center' }}>SELECT</th>
                              <th style={{ minWidth: '220px' }}>TESTCASE</th>
                              <th style={{ minWidth: '260px' }}>SUBTESTCASES</th>
                              <th style={{ width: '100px', textAlign: 'center' }}>STATUS</th>
                              <th style={{ width: '150px', textAlign: 'center' }}>TIME</th>
                              <th style={{ minWidth: '150px' }}>RESULTS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysisRows.map((row) => {
                              const moduleName = row.testcase || row.suite;
                              const isChecked = workflow.selectedModules.includes(moduleName);
                              const subInfo = [row.suite_version, row.model, row.result_dir].filter(Boolean).join(' · ');
                              const subtestStr = (row.subtestcases || '').trim();
                              const hasSubtests = Boolean(subtestStr && subtestStr !== '-');

                              // Calculate dynamic actual testrun metrics
                              const rowUpper = ((row.suite || '') + ' ' + (row.testcase || '')).toUpperCase();
                              const isSts = rowUpper.includes('STS');
                              const isCts = rowUpper.includes('CTS');
                              const isGts = rowUpper.includes('GTS');
                              const suiteKey = isSts ? 'STS' : isCts ? 'CTS' : isGts ? 'GTS' : '';

                              // Find individual suite result from serverResultZips (strictly prioritizing latest session run)
                              const matchingSuiteZip = serverResultZips.find(
                                (z) => z.isIndividualSuite && z.suite === suiteKey && z.run_batch === latestBatchName && isModelMatch(z.model, workflow.model)
                              ) || serverResultZips.find(
                                (z) => z.isIndividualSuite && z.suite === suiteKey && isModelMatch(z.model, workflow.model)
                              );

                              let statusText = 'Standby';
                              let statusClass = 'badge-neutral';
                              let timeText = row.time || '-';
                              let totalCount = row.total ?? 0;
                              let passedCount = row.passed ?? 0;
                              let failedCount = row.failed ?? 0;
                              let isExecuting = false;

                              // Use individual suite metrics if available
                              if (matchingSuiteZip?.summary) {
                                totalCount = matchingSuiteZip.summary.total ?? totalCount;
                                passedCount = matchingSuiteZip.summary.passed ?? passedCount;
                                failedCount = matchingSuiteZip.summary.failed ?? failedCount;
                              }

                              const formatSuiteCompletedTime = (sZip: typeof matchingSuiteZip) => {
                                if (!sZip) return '-';
                                const dStr = sZip.summary?.run_time || '-';
                                if (sZip.summary?.completed_time) {
                                  const tOnly = sZip.summary.completed_time.split(' ').pop();
                                  return `${tOnly} (${dStr})`;
                                }
                                if (sZip.modifiedAt) {
                                  const tOnly = new Date(sZip.modifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                                  return `${tOnly} (${dStr})`;
                                }
                                return dStr;
                              };

                              if (activeJob) {
                                if (isChecked) {
                                  const activeSuite = (activeJob.suite || '').toUpperCase();
                                  const logs = Array.isArray(activeJob.recentLogs) ? activeJob.recentLogs : [];

                                  const isCurrentSuiteRunning =
                                    (isSts && activeSuite.includes('STS')) ||
                                    (isCts && activeSuite.includes('CTS')) ||
                                    (isGts && activeSuite.includes('GTS'));

                                  const hasSuiteLogs = logs.some((l) => {
                                    if (typeof l !== 'string') return false;
                                    if (l.startsWith('[preflight]') || l.startsWith('[AI Worker]') || l.startsWith('[prepare]') || l.startsWith('[Bridge]')) return false;
                                    if (isSts && (l.startsWith('[STS]') || l.includes('sts-tf >') || l.includes('sts-dynamic-plan'))) return true;
                                    if (isCts && (l.startsWith('[CTS]') || l.includes('cts-tf >') || l.includes('cts-console'))) return true;
                                    if (isGts && (l.startsWith('[GTS]') || l.includes('gts-tf >') || l.includes('gts-console') || l.includes('gts_main'))) return true;
                                    return false;
                                  });

                                  if (isCurrentSuiteRunning) {
                                    isExecuting = true;
                                    statusText = 'Running';
                                    statusClass = 'badge-running';
                                    const liveSecs = activeJob.startedAt ? Math.max(0, Math.floor((Date.now() - activeJob.startedAt) / 1000)) : (activeJob.elapsed_secs || 0);
                                    timeText = formatDurationHms(liveSecs);
                                  } else if (hasSuiteLogs || matchingSuiteZip) {
                                    statusText = 'Test Done';
                                    statusClass = 'badge-ready';
                                    timeText = formatSuiteCompletedTime(matchingSuiteZip);
                                  } else {
                                    statusText = 'Standby';
                                    statusClass = 'badge-busy';
                                    timeText = '-';
                                  }
                                } else {
                                  statusText = 'Standby';
                                  statusClass = 'badge-neutral';
                                  timeText = '-';
                                }
                              } else if (latestFinishedJob && isChecked) {
                                const logs = Array.isArray(latestFinishedJob.recentLogs) ? latestFinishedJob.recentLogs : [];
                                const hasExecuted = logs.some((l) => {
                                  if (typeof l !== 'string') return false;
                                  if (l.startsWith('[preflight]') || l.startsWith('[AI Worker]') || l.startsWith('[prepare]') || l.startsWith('[Bridge]')) return false;
                                  if (isSts && (l.startsWith('[STS]') || l.includes('sts-tf >') || l.includes('sts-dynamic-plan'))) return true;
                                  if (isCts && (l.startsWith('[CTS]') || l.includes('cts-tf >') || l.includes('cts-console'))) return true;
                                  if (isGts && (l.startsWith('[GTS]') || l.includes('gts-tf >') || l.includes('gts-console'))) return true;
                                  return false;
                                });

                                if (hasExecuted || matchingSuiteZip) {
                                  statusText = 'Test Done';
                                  statusClass = 'badge-ready';
                                  timeText = formatSuiteCompletedTime(matchingSuiteZip);
                                } else {
                                  statusText = 'Standby';
                                  statusClass = 'badge-neutral';
                                  timeText = '-';
                                }
                              } else if (matchingSuiteZip) {
                                statusText = 'Test Done';
                                statusClass = 'badge-ready';
                                timeText = formatSuiteCompletedTime(matchingSuiteZip);
                              }

                              return (
                                <tr
                                  key={row.id || moduleName}
                                  className={`laundry-module-row ${isChecked ? 'row-selected' : ''} ${isExecuting ? 'row-executing' : ''} ${isWorkflowRunning ? 'is-readonly' : ''}`}
                                  onClick={() => !isWorkflowRunning && handleToggleModule(moduleName)}
                                  style={{ cursor: isWorkflowRunning ? 'default' : 'pointer' }}
                                >
                                  <td className="laundry-cell-select" onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                                    <label className={`switch-toggle ${isWorkflowRunning ? 'is-readonly' : ''}`} style={{ margin: '0 auto' }}>
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        disabled={isWorkflowRunning}
                                        onChange={() => !isWorkflowRunning && handleToggleModule(moduleName)}
                                      />
                                      <span className="switch-slider"></span>
                                    </label>
                                  </td>
                                  <td className="laundry-cell-testcase">
                                    <div className="mono font-semibold laundry-module-name" style={{ fontSize: '0.8125rem' }}>
                                      {moduleName}
                                    </div>
                                    {subInfo && (
                                      <div className="text-secondary text-xs laundry-module-subinfo" style={{ marginTop: '0.125rem', opacity: 0.75 }}>
                                        {subInfo}
                                      </div>
                                    )}
                                  </td>
                                  <td className={`laundry-cell-subtests ${!hasSubtests ? 'is-empty' : ''}`}>
                                    <div
                                      className="mono text-xs text-secondary laundry-subtests-content"
                                      style={{
                                        maxWidth: '380px',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                      }}
                                      title={row.subtestcases || '-'}
                                    >
                                      {row.subtestcases || '-'}
                                    </div>
                                  </td>
                                  <td className="laundry-cell-status" style={{ textAlign: 'center' }}>
                                    <span className={`badge badge-status-fixed ${statusClass}`}>
                                      {isExecuting && <span className="spinner-dot" style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'currentColor' }}></span>}
                                      <span>{statusText}</span>
                                    </span>
                                  </td>
                                  <td className="mono text-xs text-secondary laundry-cell-time" style={{ textAlign: 'center', fontWeight: isExecuting ? 700 : 400, color: isExecuting ? 'var(--accent-warning, #f59e0b)' : undefined }}>
                                    <span className="laundry-time-text">{timeText}</span>
                                  </td>
                                  <td className="laundry-cell-results">
                                    <div className="results-cell-group">
                                      <div className="results-cell-top">
                                        <span className="badge badge-neutral badge-chip-fixed" title={`Total: ${totalCount}`}>
                                          <span className="chip-label">Total</span>
                                          <span className="chip-circle-val">{totalCount}</span>
                                        </span>
                                      </div>
                                      <div className="results-cell-bottom">
                                        <span className="badge badge-ready badge-chip-fixed" title={`Pass: ${passedCount}`}>
                                          <span className="chip-label">Pass</span>
                                          <span className="chip-circle-val">{passedCount}</span>
                                        </span>
                                        <span
                                          className={`badge ${failedCount > 0 ? 'badge-fail' : 'badge-fail-zero'} badge-chip-fixed`}
                                          title={`Fail: ${failedCount}`}
                                        >
                                          <span className="chip-label">Fail</span>
                                          <span className="chip-circle-val">{failedCount}</span>
                                        </span>
                                      </div>
                                    </div>
                                  </td>
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
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Sub-Accordion 2: Related Model Devices */}
          <div className="sub-accordion">
            <div
              className="sub-accordion-header"
              onClick={toggleDevicesExpanded}
            >
              <div className="sub-accordion-title">
                {isDevicesExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>DEVICES ({matchingDevices.length} Unit)</span>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-secondary btn-xs"
                  onClick={handleSelectAllDevices}
                  disabled={isWorkflowRunning || matchingDevices.length === 0}
                  title={isWorkflowRunning ? 'Readonly saat automasi sedang berjalan' : undefined}
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
                              disabled={isWorkflowRunning}
                              onChange={handleSelectAllDevices}
                            />
                          </th>
                          <th>PC ID</th>
                          <th>Model & Build</th>
                          <th>Serial Number</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matchingDevices.map((dev) => {
                          const isChecked = workflow.selectedSerials.includes(dev.serial);
                          const targetFp = analysisRows.find((r) => r.fingerprint)?.fingerprint || workflow.fingerprint;
                          const targetAp = workflow.ap_version || workflow.pda || analysisRows.find((r) => r.ap_version)?.ap_version;
                          const isFpMatch = isLoaded ? isDeviceFingerprintMatch(dev, targetFp, targetAp, workflow.pda) : true;
                          return (
                            <tr
                              key={dev.serial}
                              className={`${isChecked ? 'row-selected' : ''} ${isWorkflowRunning ? 'is-readonly' : ''}`}
                              onClick={() => !isWorkflowRunning && handleToggleDevice(dev.serial)}
                              style={{ cursor: isWorkflowRunning ? 'default' : 'pointer' }}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  className="checkbox-custom"
                                  checked={isChecked}
                                  disabled={isWorkflowRunning}
                                  onChange={() => !isWorkflowRunning && handleToggleDevice(dev.serial)}
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
                                  {isLoaded && (
                                    <span
                                      className={`badge badge-xs ${isFpMatch ? 'badge-ready' : 'badge-fail'}`}
                                      style={{ fontSize: '0.625rem', padding: '0.0625rem 0.3125rem' }}
                                      title={isFpMatch ? 'Fingerprint & PDA cocok dengan file zip' : 'Fingerprint / PDA berbeda dengan file zip'}
                                    >
                                      {isFpMatch ? 'FP MATCH' : 'FP MISMATCH'}
                                    </span>
                                  )}
                                </div>
                                <div className="device-pda-sub">{dev.pda || dev.fingerprint || 'PDA: -'}</div>
                              </td>
                              <td className="mono">{dev.serial}</td>
                              <td>
                                <span
                                  className={`badge badge-xs ${dev.busy ? 'badge-busy' : 'badge-ready'}`}
                                >
                                  {dev.busy ? dev.busy_reason || 'BUSY' : 'READY'}
                                </span>
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

          {/* Sub-Accordion 3: Execution Results & Downloadable ZIP List */}
          <div className="sub-accordion">
            <div
              className="sub-accordion-header"
              onClick={toggleResultsExpanded}
            >
              <div className="sub-accordion-title">
                {isResultsExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>RESULTS ({readyDownloadZips.length} ZIP)</span>
              </div>
              <div className="sub-accordion-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0, marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                {readyDownloadZips.length > 0 && (
                  <span className="badge badge-ready badge-xs">
                    📦 Siap Unduh
                  </span>
                )}
                {workflowResults.length > 0 && (
                  <span className="badge badge-neutral badge-xs">
                    {workflowResults.filter((j) => j.status === 'Finished' || j.status === 'Test Done').length} Selesai
                  </span>
                )}
              </div>
            </div>

            {isResultsExpanded && (
              <div className="sub-accordion-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Section A: Ready Overall Result ZIPs List */}
                <div>
                  {readyDownloadZips.length > 0 ? (
                    <div className="table-responsive laundry-results-table-container">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>TEST ZIP FILE</th>
                            <th>PLAN / TEST TYPE</th>
                            <th>SIZE</th>
                            <th>WAKTU PEMBUATAN</th>
                            <th style={{ textAlign: 'center' }}>SUMMARY</th>
                            <th style={{ textAlign: 'center', minWidth: '130px' }}>AKSI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {readyDownloadZips.map((item, idx) => {
                            const sizeText = item.sizeBytes
                              ? item.sizeBytes > 1024 * 1024
                                ? `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                : `${(item.sizeBytes / 1024).toFixed(0)} KB`
                              : '-';
                            const timeText = item.modifiedAt
                              ? new Date(item.modifiedAt).toLocaleString()
                              : '-';
                            const downloadUrl = `/api/results/download?path=${encodeURIComponent(item.path || '')}&file=${encodeURIComponent(item.filename)}&run_id=${encodeURIComponent(item.run_id || '')}`;

                            const sumTotal = item.summary ? item.summary.total : 0;
                            const sumPassed = item.summary ? item.summary.passed : 0;
                            const sumFailed = item.summary ? item.summary.failed : 0;

                            return (
                              <tr key={`${item.filename}-${idx}`}>
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                                    <span style={{ fontSize: '1rem', flexShrink: 0 }}>📦</span>
                                    <div style={{ minWidth: 0, overflow: 'hidden' }}>
                                      <div
                                        className="mono font-semibold"
                                        style={{
                                          fontSize: '0.78125rem',
                                          color: 'var(--text-primary)',
                                          maxWidth: '260px',
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                        title={item.filename}
                                      >
                                        {item.filename}
                                      </div>
                                      {item.run_id && (
                                        <div className="text-secondary mono text-xs" style={{ opacity: 0.7, fontSize: '0.7rem' }}>
                                          {item.run_id}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                                    <span className="badge badge-pc badge-xs font-semibold">
                                      {item.plan || 'SMR'}
                                    </span>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>/</span>
                                    <span className="badge badge-unit badge-xs font-semibold">
                                      {item.suite || 'TEST'}
                                    </span>
                                  </div>
                                </td>
                                <td className="mono text-xs text-secondary">
                                  {sizeText}
                                </td>
                                <td className="mono text-xs text-secondary">
                                  {timeText}
                                </td>
                                <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                                  <div className="results-cell-group" style={{ margin: '0 auto' }}>
                                    <div className="results-cell-top">
                                      <span className="badge badge-neutral badge-chip-fixed" title={`Total: ${sumTotal}`}>
                                        <span className="chip-label">Total</span>
                                        <span className="chip-circle-val">{sumTotal}</span>
                                      </span>
                                    </div>
                                    <div className="results-cell-bottom">
                                      <span className="badge badge-ready badge-chip-fixed" title={`Pass: ${sumPassed}`}>
                                        <span className="chip-label">Pass</span>
                                        <span className="chip-circle-val">{sumPassed}</span>
                                      </span>
                                      <span className={`badge ${sumFailed > 0 ? 'badge-fail' : 'badge-fail-zero'} badge-chip-fixed`} title={`Fail: ${sumFailed}`}>
                                        <span className="chip-label">Fail</span>
                                        <span className="chip-circle-val">{sumFailed}</span>
                                      </span>
                                    </div>
                                  </div>
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <a
                                    href={downloadUrl}
                                    download={item.filename}
                                    className="btn btn-success btn-xs"
                                    style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}
                                    title={`Download ${item.filename}`}
                                  >
                                    <span>💾</span>
                                    <span>Download ZIP</span>
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty-state-compact">
                      Belum ada file ZIP hasil test yang siap diunduh untuk model ini.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
