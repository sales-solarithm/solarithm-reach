'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import LoginPage from '@/app/login/page';
import DashboardPage from '@/app/dashboard/page';

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0E0F11] text-neutral-400 flex items-center justify-center text-xs font-mono">
        Loading workspace...
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <DashboardPage />;
}
