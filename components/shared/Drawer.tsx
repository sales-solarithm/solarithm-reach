'use client';

import React from 'react';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
}

/**
 * Responsive Slide-Over Drawer / Full-Screen Mobile Sheet.
 * Occupies w-full h-full on mobile devices (<640px) and sm:w-full sm:max-w-md on tablet/desktop,
 * preventing clipped edges or hidden submit buttons behind mobile keyboard overlays.
 */
export function Drawer({
  isOpen,
  onClose,
  ariaLabel,
  testId = 'slide-over-drawer',
  maxWidthClass = 'sm:max-w-md',
  children,
}: DrawerProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      data-testid={testId}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-end bg-black/60 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full h-full sm:w-full ${maxWidthClass} bg-white dark:bg-[#11141B] sm:border-l border-slate-200 dark:border-white/10 p-4 sm:p-6 flex flex-col justify-between overflow-y-auto shadow-2xl`}
      >
        {children}
      </div>
    </div>
  );
}
