import React from 'react';
import { DeviceItem, LaundryRow, LaundryZipItem, ActiveJobItem } from '../hooks/useFleetWebSocket';
import { ModelLaundryWorkflow, LaundryWorkflowState } from './ModelLaundryWorkflow';
import { PlusIcon } from './Icons';

interface LaundryWorkflowSectionProps {
  workflows: LaundryWorkflowState[];
  devices: DeviceItem[];
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
  onAddWorkflow: () => void;
  onOpenLaundryPicker: (workflowId: string, pcId?: string) => void;
  onRunSuite: (pcId: string, payload: any) => void;
  onToggleLamp: (pcId: string, serial: string, brighten: boolean) => void;
}

export const LaundryWorkflowSection: React.FC<LaundryWorkflowSectionProps> = ({
  workflows,
  devices,
  availableZips,
  activeJobs = [],
  jobHistory = [],
  laundryAnalysis,
  onUpdateWorkflow,
  onRemoveWorkflow,
  onAddWorkflow,
  onOpenLaundryPicker,
  onRunSuite,
  onToggleLamp,
}) => {
  return (
    <section className="workflow-section">
      {workflows.map((wf) => (
        <ModelLaundryWorkflow
          key={wf.id}
          workflow={wf}
          allDevices={devices}
          availableZips={availableZips}
          activeJobs={activeJobs}
          jobHistory={jobHistory}
          laundryAnalysis={laundryAnalysis}
          onUpdateWorkflow={onUpdateWorkflow}
          onRemoveWorkflow={onRemoveWorkflow}
          onOpenLaundryPicker={onOpenLaundryPicker}
          onRunSuite={onRunSuite}
          onToggleLamp={onToggleLamp}
        />
      ))}

      <div className="add-workflow-container">
        <button
          type="button"
          className="btn btn-add-workflow"
          onClick={onAddWorkflow}
        >
          <PlusIcon size={16} />
          <span>Tambah Laundry Workflow</span>
        </button>
      </div>
    </section>
  );
};
