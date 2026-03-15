import React, { useState, useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  removeToast: (id: number) => void;
}

export function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  return (
    <div className="fixed bottom-[30px] right-[30px] z-[9999] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-5 py-3 rounded-lg text-[13px] font-semibold bg-[#161b27] border shadow-[0_4px_20px_rgba(0,0,0,0.4)] animate-toastIn flex items-center gap-2.5 max-w-[320px] ${
            toast.type === 'success' ? 'border-[rgba(0,229,160,0.4)] text-[#00e5a0]' :
            toast.type === 'error' ? 'border-[rgba(255,77,109,0.4)] text-[#ff4d6d]' :
            'border-[rgba(0,212,255,0.4)] text-[#00d4ff]'
          }`}
        >
          <span>
            {toast.type === 'success' ? '✅' : toast.type === 'error' ? '❌' : 'ℹ️'}
          </span>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
