import { useCallback, useEffect, useRef } from 'react';

const stableStringify = (value: unknown) =>
  JSON.stringify(value, (_key, val) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val;
    const raw = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    Object.keys(raw)
      .sort()
      .forEach((key) => {
        sorted[key] = raw[key];
      });
    return sorted;
  });

type DebouncedSyncOptions<T> = {
  enabled: boolean;
  payload: T | null;
  delay?: number;
  retryDelay?: number;
  getPayloadKey?: (payload: T) => string;
  isBlocked?: () => boolean;
  onSync: (payload: T) => void | Promise<void>;
};

export const useDebouncedSync = <T>({
  enabled,
  payload,
  delay = 300,
  retryDelay = 200,
  getPayloadKey = stableStringify,
  isBlocked,
  onSync,
}: DebouncedSyncOptions<T>) => {
  const timerRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string>('');

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    lastKeyRef.current = '';
  }, [clearTimer]);

  const markSynced = useCallback(
    (nextPayload: T) => {
      lastKeyRef.current = getPayloadKey(nextPayload);
    },
    [getPayloadKey],
  );

  useEffect(() => {
    if (!enabled) {
      reset();
    }
  }, [enabled, reset]);

  useEffect(() => {
    if (!enabled || payload == null) return;
    const payloadKey = getPayloadKey(payload);
    if (payloadKey === lastKeyRef.current) return;
    lastKeyRef.current = payloadKey;

    const schedule = (delayMs: number) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!enabled) return;
        if (isBlocked?.()) {
          schedule(retryDelay);
          return;
        }
        void onSync(payload);
      }, delayMs);
    };

    schedule(delay);
    return clearTimer;
  }, [
    enabled,
    payload,
    delay,
    retryDelay,
    getPayloadKey,
    onSync,
    isBlocked,
    clearTimer,
  ]);

  useEffect(() => reset, [reset]);

  return { markSynced, reset };
};

type InputGuardOptions = {
  isEditing?: () => boolean;
  idleMs?: number;
};

export const useInputGuard = ({ isEditing, idleMs }: InputGuardOptions = {}) => {
  const dirtyRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const clearDirty = useCallback(() => {
    dirtyRef.current = false;
    clearIdleTimer();
  }, [clearIdleTimer]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    if (typeof idleMs === 'number') {
      clearIdleTimer();
      idleTimerRef.current = window.setTimeout(() => {
        dirtyRef.current = false;
        idleTimerRef.current = null;
      }, idleMs);
    }
  }, [idleMs, clearIdleTimer]);

  const shouldPreserve = useCallback(
    (incoming?: unknown, current?: unknown) => {
      if (isEditing?.()) return true;
      if (!dirtyRef.current) return false;
      if (incoming !== undefined && current !== undefined) {
        return incoming !== current;
      }
      return true;
    },
    [isEditing],
  );

  useEffect(() => clearIdleTimer, [clearIdleTimer]);

  return { markDirty, clearDirty, shouldPreserve };
};
