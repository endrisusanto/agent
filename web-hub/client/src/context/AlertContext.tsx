import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { AlertModal, AlertType } from '../components/AlertModal';

export interface AlertOptions {
  title: string;
  message?: string;
  details?: string[];
  type?: AlertType;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface AlertContextValue {
  showAlert: (options: AlertOptions) => void;
  showConfirm: (options: AlertOptions) => void;
  closeAlert: () => void;
}

const AlertContext = createContext<AlertContextValue | null>(null);

export const AlertProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [modalState, setModalState] = useState<(AlertOptions & { isOpen: boolean }) | null>(null);

  const showAlert = useCallback((options: AlertOptions) => {
    setModalState({
      ...options,
      type: options.type || 'warning',
      isOpen: true,
    });
  }, []);

  const showConfirm = useCallback((options: AlertOptions) => {
    setModalState({
      ...options,
      type: options.type || 'confirm',
      isOpen: true,
    });
  }, []);

  const closeAlert = useCallback(() => {
    setModalState((prev) => (prev ? { ...prev, isOpen: false } : null));
  }, []);

  const handleConfirm = useCallback(() => {
    if (modalState?.onConfirm) {
      modalState.onConfirm();
    }
    closeAlert();
  }, [modalState, closeAlert]);

  const handleCancel = useCallback(() => {
    if (modalState?.onCancel) {
      modalState.onCancel();
    }
    closeAlert();
  }, [modalState, closeAlert]);

  return (
    <AlertContext.Provider value={{ showAlert, showConfirm, closeAlert }}>
      {children}
      {modalState && (
        <AlertModal
          isOpen={modalState.isOpen}
          type={modalState.type}
          title={modalState.title}
          message={modalState.message}
          details={modalState.details}
          confirmText={modalState.confirmText}
          cancelText={modalState.cancelText}
          onConfirm={handleConfirm}
          onCancel={modalState.type === 'confirm' || modalState.onCancel ? handleCancel : undefined}
        />
      )}
    </AlertContext.Provider>
  );
};

export const useAlertModal = (): AlertContextValue => {
  const context = useContext(AlertContext);
  if (!context) {
    throw new Error('useAlertModal must be used within an AlertProvider');
  }
  return context;
};
