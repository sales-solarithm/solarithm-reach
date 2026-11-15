'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, PhoneForwarded, ShieldAlert, Loader2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace('/dashboard');
    }
  }, [loading, user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(email);
      router.replace('/dashboard');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Access Denied: Unregistered organization email.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      data-testid="login-modal-screen"
      className="min-h-screen w-full bg-[#0E0F11] text-slate-100 flex flex-col items-center justify-center px-4 py-12"
    >
      <div className="w-full max-w-[400px] bg-[#18191B] border border-neutral-800 rounded-2xl p-8 shadow-2xl">
        {/* 1. Centered Squircle Icon Badge */}
        <div className="flex justify-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-400/10 border border-neutral-800 flex items-center justify-center">
            <PhoneForwarded className="w-5 h-5 text-amber-400" />
          </div>
        </div>

        {/* 2. Header: Title, Subtitle, Instruction */}
        <div className="text-center mb-2">
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Solarithm <span className="text-amber-400">Reach</span>
          </h1>
          <p className="text-xs font-medium text-neutral-400 mt-1">
            Enterprise Solar Outreach Console
          </p>
        </div>

        <p className="text-center text-sm text-neutral-400 leading-relaxed mb-7">
          Please enter your work email to claim your profile and continue.
        </p>

        {/* 3. Single Work Email Input & 4. Action Button */}
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div>
            <label
              htmlFor="work-email-input"
              className="block text-[11px] font-semibold tracking-wider text-neutral-400 uppercase mb-2"
            >
              WORK EMAIL
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-neutral-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="work-email-input"
                data-testid="login-email-input"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                placeholder="name@solarithmdesign.com"
                autoComplete="email"
                required
                className="w-full pl-10 pr-4 py-2.5 bg-[#0E0F11] border border-neutral-800 rounded-xl text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
              />
            </div>
          </div>

          {error && (
            <div
              role="alert"
              data-testid="login-error-alert"
              className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-red-950/50 border border-red-500/30 text-red-400 text-xs font-medium"
            >
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            data-testid="login-submit-btn"
            disabled={isSubmitting}
            className="w-full py-2.5 px-4 rounded-xl bg-[#7C6328] hover:bg-[#8F722E] active:bg-[#6B5522] text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-amber-300" />
                <span>Verifying...</span>
              </>
            ) : (
              <span>Lock & Access →</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
