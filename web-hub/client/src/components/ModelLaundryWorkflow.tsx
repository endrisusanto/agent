import React, { useState, useMemo, useEffect } from 'react';
import { DeviceItem, LaundryRow, LaundryZipItem, ActiveJobItem } from '../hooks/useFleetWebSocket';
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
  cachedRows?: LaundryRow[];
}

export function isModelMatch(m1?: string, m2?: string): boolean {
  if (!m1 || !m2) return false;
  const n1 = m1.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const n2 = m2.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n1 === n2 || n1.endsWith(n2) || n2.endsWith(n1);
}

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

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
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLaundryExpanded, setIsLaundryExpanded] = useState(true);
  const [isDevicesExpanded, setIsDevicesExpanded] = useState(true);
  const [isResultsExpanded, setIsResultsExpanded] = useState(true);

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

    const detectedPlanName = detectZipPlanKind(analysisRows, workflow.selectedZip, workflow.plan);
    onRunSuite(targetPcId, {
      test_type: `Laundry ${detectedPlanName}`,
      laundry_zip_path: workflow.selectedZip,
      selected_laundry_results: workflow.selectedModules,
      selected_laundry_rows: selectedRowsData,
      user_devices: userDevices,
      userdebug_devices: userdebugDevices,
      retry_count: 5,
      timeout_secs: 86400,
    });
  };

  const planName = detectZipPlanKind(analysisRows, workflow.selectedZip, workflow.plan);
  const apVersion = workflow.ap_version || workflow.pda || (matchingDevices[0]?.pda ?? '');
  const isLoaded = Boolean(workflow.selectedZip || workflow.model || workflow.ap_version);
  const titleText = isLoaded
    ? `Laundry ${planName} ${apVersion || workflow.model}`.trim()
    : 'LAUNDRY WORKFLOW (Pilih Zip Hasil Test)';
  const hasUserdebug = matchingDevices.some((d) => d.is_userdebug);

  // Fetch and list available result ZIPs from server
  const [serverResultZips, setServerResultZips] = useState<Array<{
    filename: string;
    path: string;
    sizeBytes: number;
    modifiedAt: number;
    model?: string;
    run_dir?: string;
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

  // Filter ready-to-download ZIPs strictly for this workflow's model (Overall Run Master ZIPs)
  const readyDownloadZips = useMemo(() => {
    if (!workflow.model) {
      return [];
    }

    const list: Array<{
      filename: string;
      path?: string;
      sizeBytes?: number;
      modifiedAt?: number;
      test_type?: string;
      suite?: string;
      status?: string;
      run_id?: string;
      summary?: { total: number; passed: number; failed: number };
    }> = [];

    const seenFilenames = new Set<string>();

    // 1. Prioritize Server-scanned Consolidated Run Batch ZIPs strictly matching this model
    for (const sZip of serverResultZips) {
      if (!seenFilenames.has(sZip.filename)) {
        if (sZip.model && isModelMatch(sZip.model, workflow.model)) {
          seenFilenames.add(sZip.filename);
          list.push({
            filename: sZip.filename,
            path: sZip.path,
            sizeBytes: sZip.sizeBytes,
            modifiedAt: sZip.modifiedAt,
            test_type: sZip.filename.includes('STS') ? 'STS' : sZip.filename.includes('GTS') ? 'GTS' : sZip.filename.includes('Normal') ? 'Normal' : sZip.filename.includes('SKU') ? 'SKU' : 'SMR',
            suite: sZip.filename.includes('SMR') ? 'SMR' : sZip.filename.includes('SKU') ? 'SKU' : 'Tradefed',
            status: 'Finished',
          });
        }
      }
    }

    // 2. Active & Finished jobs strictly matching this model
    for (const job of workflowResults) {
      const zips = Array.isArray(job.zip_files) ? [...job.zip_files] : [];
      if (job.zip_file && !zips.includes(job.zip_file)) zips.unshift(job.zip_file);

      for (const z of zips) {
        if (!z) continue;
        const fname = z.split('/').pop() || z;
        if (!seenFilenames.has(fname)) {
          const isJobMatching = isModelMatch(job.test_type, workflow.model) ||
                                isModelMatch(job.suite, workflow.model) ||
                                isModelMatch(job.summary?.test_type, workflow.model) ||
                                isModelMatch(fname, workflow.model);
          if (!isJobMatching) continue;

          seenFilenames.add(fname);
          list.push({
            filename: fname,
            path: z,
            test_type: job.test_type,
            suite: job.suite,
            status: job.status,
            run_id: job.run_id,
            modifiedAt: job.startedAt,
            summary: job.summary ? { total: job.summary.total, passed: job.summary.passed, failed: job.summary.failed } : undefined,
          });
        }
      }
    }

    // Sort newest first
    list.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    return list;
  }, [workflowResults, serverResultZips, workflow.model]);

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
                      <div className="table-responsive" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th style={{ width: '56px', textAlign: 'center' }}>SELECT</th>
                              <th style={{ minWidth: '220px' }}>TESTCASE</th>
                              <th style={{ minWidth: '260px' }}>SUBTESTCASES</th>
                              <th style={{ width: '100px', textAlign: 'center' }}>STATUS</th>
                              <th style={{ width: '90px', textAlign: 'center' }}>TIME</th>
                              <th style={{ minWidth: '150px' }}>RESULTS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {analysisRows.map((row) => {
                              const moduleName = row.testcase || row.suite;
                              const isChecked = workflow.selectedModules.includes(moduleName);
                              const subInfo = [row.suite_version, row.model, row.result_dir].filter(Boolean).join(' · ');

                              // Calculate dynamic actual testrun metrics
                              const rowUpper = ((row.suite || '') + ' ' + (row.testcase || '')).toUpperCase();
                              const isSts = rowUpper.includes('STS');
                              const isCts = rowUpper.includes('CTS');
                              const isGts = rowUpper.includes('GTS');

                              let statusText = row.status || 'Test Done';
                              let statusClass = ((row.failed || 0) > 0 || row.status?.toUpperCase() === 'FAIL') ? 'badge-fail' : 'badge-ready';
                              let timeText = row.time || '00:00:00';
                              let totalCount = row.total ?? 0;
                              let passedCount = row.passed ?? 0;
                              let failedCount = row.failed ?? 0;
                              let isExecuting = false;

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
                                    if (isSts && (l.startsWith('[STS]') || l.includes('sts-tradefed') || l.includes('sts-dynamic-plan'))) return true;
                                    if (isCts && (l.startsWith('[CTS]') || l.includes('cts-tradefed') || l.includes('cts-console'))) return true;
                                    if (isGts && (l.startsWith('[GTS]') || l.includes('gts-tradefed') || l.includes('gts-console'))) return true;
                                    return false;
                                  });

                                  if (isCurrentSuiteRunning) {
                                    isExecuting = true;
                                    statusText = 'Running';
                                    statusClass = 'badge-running';
                                    timeText = formatDuration(activeJob.elapsed_secs || 0);
                                    if (activeJob.summary) {
                                      totalCount = activeJob.summary.total ?? totalCount;
                                      passedCount = activeJob.summary.passed ?? passedCount;
                                      failedCount = activeJob.summary.failed ?? failedCount;
                                    }
                                  } else if (hasSuiteLogs) {
                                    statusText = 'Completed';
                                    statusClass = 'badge-ready';
                                    timeText = '-';
                                  } else {
                                    statusText = 'Antri';
                                    statusClass = 'badge-busy';
                                    timeText = '-';
                                  }
                                } else {
                                  statusText = 'Standby';
                                  statusClass = 'badge-neutral';
                                }
                              } else if (latestFinishedJob && isChecked) {
                                if (latestFinishedJob.summary) {
                                  failedCount = latestFinishedJob.summary.failed ?? 0;
                                  passedCount = latestFinishedJob.summary.passed ?? 0;
                                  totalCount = latestFinishedJob.summary.total ?? totalCount;
                                  timeText = latestFinishedJob.summary.run_time || formatDuration(latestFinishedJob.elapsed_secs || 0) || timeText;
                                  statusText = failedCount > 0 ? 'FAIL' : 'PASS';
                                  statusClass = failedCount > 0 ? 'badge-fail' : 'badge-ready';
                                } else {
                                  statusText = latestFinishedJob.status === 'Failed' ? 'FAIL' : 'PASS';
                                  statusClass = latestFinishedJob.status === 'Failed' ? 'badge-fail' : 'badge-ready';
                                  timeText = formatDuration(latestFinishedJob.elapsed_secs || 0) || timeText;
                                }
                              }

                              return (
                                <tr
                                  key={row.id || moduleName}
                                  className={`${isChecked ? 'row-selected' : ''} ${isExecuting ? 'row-executing' : ''}`}
                                  onClick={() => handleToggleModule(moduleName)}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'center' }}>
                                    <label className="switch-toggle" style={{ margin: '0 auto' }}>
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => handleToggleModule(moduleName)}
                                      />
                                      <span className="switch-slider"></span>
                                    </label>
                                  </td>
                                  <td>
                                    <div className="mono font-semibold" style={{ fontSize: '0.8125rem' }}>
                                      {moduleName}
                                    </div>
                                    {subInfo && (
                                      <div className="text-secondary text-xs" style={{ marginTop: '0.125rem', opacity: 0.75 }}>
                                        {subInfo}
                                      </div>
                                    )}
                                  </td>
                                  <td>
                                    <div
                                      className="mono text-xs text-secondary"
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
                                  <td style={{ textAlign: 'center' }}>
                                    <span
                                      className={`badge badge-xs ${statusClass}`}
                                      style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                                    >
                                      {isExecuting && <span className="spinner-dot" style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'currentColor' }}></span>}
                                      <span>{statusText}</span>
                                    </span>
                                  </td>
                                  <td className="mono text-xs text-secondary" style={{ textAlign: 'center', fontWeight: isExecuting ? 700 : 400, color: isExecuting ? 'var(--accent-warning, #f59e0b)' : undefined }}>
                                    {timeText}
                                  </td>
                                  <td>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                      <div className="text-xs text-secondary" style={{ fontSize: '0.7rem' }}>
                                        Total {totalCount}
                                      </div>
                                      <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                                        <span className="badge badge-ready badge-xs" style={{ padding: '0.15rem 0.4rem', fontSize: '0.6875rem' }}>
                                          Pass {passedCount}
                                        </span>
                                        <span
                                          className={`badge ${failedCount > 0 ? 'badge-fail' : 'badge-busy'} badge-xs`}
                                          style={{ padding: '0.15rem 0.4rem', fontSize: '0.6875rem' }}
                                        >
                                          Fail {failedCount}
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
                          <th>Status</th>
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
                                <div className="device-pda-sub">{dev.pda || 'PDA: -'}</div>
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
              onClick={() => setIsResultsExpanded(!isResultsExpanded)}
            >
              <div className="sub-accordion-title">
                {isResultsExpanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                <span>RESULTS ({readyDownloadZips.length} Master ZIP Siap Download • {workflowResults.length} Riwayat Run)</span>
              </div>
              <div className="laundry-stats-chips" onClick={(e) => e.stopPropagation()}>
                {readyDownloadZips.length > 0 && (
                  <span className="badge badge-ready badge-xs">
                    📦 {readyDownloadZips.length} ZIP Siap Unduh
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
                  <div style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <span>📦</span>
                    <span>OVERALL ZIP HASIL TEST SIAP DOWNLOAD</span>
                  </div>

                  {readyDownloadZips.length > 0 ? (
                    <div className="table-responsive" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>MASTER ZIP FILE</th>
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

                            const sumTotal = item.summary ? item.summary.total : (analysisRows.reduce((acc, r) => acc + (r.total || 0), 0) || 1);
                            const sumPassed = item.summary ? item.summary.passed : (analysisRows.reduce((acc, r) => acc + (r.passed || 0), 0) || 1);
                            const sumFailed = item.summary ? item.summary.failed : analysisRows.reduce((acc, r) => acc + (r.failed || 0), 0);

                            return (
                              <tr key={`${item.filename}-${idx}`}>
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{ fontSize: '1.125rem' }}>📦</span>
                                    <div>
                                      <div className="mono font-semibold" style={{ fontSize: '0.8125rem', color: 'var(--text-primary)' }}>
                                        {item.filename}
                                      </div>
                                      {item.run_id && (
                                        <div className="text-secondary mono text-xs" style={{ opacity: 0.7 }}>
                                          {item.run_id}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                                    <span className="badge badge-pc badge-xs font-semibold">
                                      {item.test_type || 'TEST'}
                                    </span>
                                    {item.suite && (
                                      <span className="badge badge-unit badge-xs">
                                        {item.suite}
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="mono text-xs text-secondary">
                                  {sizeText}
                                </td>
                                <td className="mono text-xs text-secondary">
                                  {timeText}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'center' }}>
                                    <div className="text-xs text-secondary mono" style={{ fontSize: '0.7rem' }}>
                                      Total {sumTotal}
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.375rem', justifyContent: 'center' }}>
                                      <span className="badge badge-ready badge-xs" style={{ padding: '0.15rem 0.4rem', fontSize: '0.6875rem' }}>
                                        Pass {sumPassed}
                                      </span>
                                      <span
                                        className={`badge ${sumFailed > 0 ? 'badge-fail' : 'badge-busy'} badge-xs`}
                                        style={{ padding: '0.15rem 0.4rem', fontSize: '0.6875rem' }}
                                      >
                                        Fail {sumFailed}
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

                {/* Section B: Run Execution Parsing History Table */}
                {workflowResults.length > 0 && (
                  <div>
                    <div style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <span>📊</span>
                      <span>RIWAYAT RUN & PARSING EKSEKUSI</span>
                    </div>

                    <div className="table-responsive" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>PC ID</th>
                            <th>TEST TYPE / PLAN</th>
                            <th>SUITE</th>
                            <th>DEVICES</th>
                            <th>DURATION</th>
                            <th>PASSED</th>
                            <th>FAILED</th>
                            <th>TOTAL</th>
                            <th style={{ textAlign: 'center' }}>STATUS</th>
                          </tr>
                        </thead>
                        <tbody>
                          {workflowResults.map((job) => {
                            const summary = job.summary;
                            const isRunning = job.status === 'Running' || job.status === 'Starting';
                            const isPass = job.status === 'Finished' || job.status === 'Test Done';
                            const isFail = job.status === 'Failed' || (summary && summary.failed > 0);
                            const displayDevices = Array.isArray(job.devices) ? job.devices.join(', ') : (job.devices || '-');
                            const durationText = summary?.run_time || (job.elapsed_secs ? `${job.elapsed_secs}s` : '-');

                            return (
                              <tr key={job.run_id}>
                                <td>
                                  <span className="badge badge-pc badge-xs">{job.pcId}</span>
                                </td>
                                <td>
                                  <strong>{job.test_type}</strong>
                                </td>
                                <td>
                                  <span className="mono text-xs">{job.suite || '-'}</span>
                                </td>
                                <td
                                  className="mono text-xs"
                                  style={{ maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  title={displayDevices}
                                >
                                  {displayDevices}
                                </td>
                                <td className="mono text-xs text-secondary">
                                  {durationText}
                                </td>
                                <td style={{ color: 'var(--status-ready-text)', fontWeight: 600 }}>
                                  {summary ? summary.passed : '-'}
                                </td>
                                <td style={{ color: summary && summary.failed > 0 ? 'var(--status-fail-text)' : 'inherit', fontWeight: 600 }}>
                                  {summary ? summary.failed : '-'}
                                </td>
                                <td>
                                  {summary ? summary.total : '-'}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  <span className={`badge badge-xs ${isRunning ? 'badge-busy' : isPass && !isFail ? 'badge-ready' : 'badge-fail'}`}>
                                    {job.status.toUpperCase()}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
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
