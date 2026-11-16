import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRepName(fullName: string | null | undefined): string {
  if (!fullName) return '—';
  const cleaned = String(fullName).split(' (')[0].trim();
  if (!cleaned) return '—';
  const parts = cleaned.split(/\s+/);
  // Keep only the first and middle names (first 2 words), drop the surname/last name
  return parts.slice(0, 2).join(' ');
}

