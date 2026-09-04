'use client';

import { signOutAction } from '@/lib/actions/auth';
import { getCountdown, isExpired, isWarning } from '@/lib/auth/idle-utils';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';

const ACTIVITY_EVENTS = [
  'mousemove',
  'keydown',
  'click',
  'scroll',
  'touchstart',
  'visibilitychange',
] as const;

const THROTTLE_MS = 10_000;

type IdleTimeoutProps = {
  timeoutMs: number;
  warningMs: number;
};

export function IdleTimeout({ timeoutMs, warningMs }: IdleTimeoutProps) {
  const t = useTranslations('settings');
  const signOut = useAction(signOutAction);
  const lastActivityRef = useRef(Date.now());
  const throttleRef = useRef(0);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  const [showWarning, setShowWarning] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const resetActivity = useCallback(() => {
    const now = Date.now();
    if (now - throttleRef.current < THROTTLE_MS) return;
    throttleRef.current = now;
    lastActivityRef.current = now;
    setShowWarning(false);
  }, []);

  // Focus the stay-connected button when warning appears
  useEffect(() => {
    if (showWarning) {
      stayButtonRef.current?.focus();
    }
  }, [showWarning]);

  useEffect(() => {
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetActivity, { passive: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetActivity);
      }
    };
  }, [resetActivity]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const last = lastActivityRef.current;

      if (isExpired(last, now, timeoutMs)) {
        clearInterval(interval);
        signOut.execute();
        // Redirect is handled by signOutAction (redirect('/'))
        // but we also set the reason param via window.location for the idle message
        window.location.href = '/connexion?reason=idle';
        return;
      }

      if (isWarning(last, now, timeoutMs, warningMs)) {
        setShowWarning(true);
        setCountdown(getCountdown(last, now, timeoutMs));
      } else {
        setShowWarning(false);
      }
    }, 1_000);

    return () => clearInterval(interval);
  }, [timeoutMs, warningMs, signOut]);

  if (!showWarning) return null;

  function handleStayConnected() {
    lastActivityRef.current = Date.now();
    throttleRef.current = 0;
    setShowWarning(false);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      handleStayConnected();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <dialog
        aria-modal="true"
        className="m-0 w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        onKeyDown={handleKeyDown}
        open
      >
        <h2 className="text-lg font-semibold">{t('idle.warningTitle')}</h2>
        <p className="text-sm text-muted">{t('idle.warningBody', { seconds: countdown })}</p>
        <button
          className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-accent px-5 font-medium text-accent-ink transition hover:bg-accent-hover active:scale-[0.97]"
          onClick={handleStayConnected}
          ref={stayButtonRef}
          type="button"
        >
          {t('idle.stayConnected')}
        </button>
      </dialog>
    </div>
  );
}
