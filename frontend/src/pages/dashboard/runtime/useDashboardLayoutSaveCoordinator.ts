import { useEffect, useRef, useState } from "react";

export function useDashboardLayoutSaveCoordinator(dashboardId: string) {
  const queueRef = useRef(new Map<string, Promise<void>>());
  const failureKeysRef = useRef(new Set<string>());
  const [pendingCount, setPendingCount] = useState(0);
  const [hasFailure, setHasFailure] = useState(false);

  useEffect(() => {
    failureKeysRef.current.clear();
    setHasFailure(false);
  }, [dashboardId]);

  const enqueue = <Result,>(key: string, save: () => Promise<Result>) => {
    const previousSave = queueRef.current.get(key) ?? Promise.resolve();
    setPendingCount((count) => count + 1);
    const queuedSave = previousSave.catch(() => undefined).then(save);
    const settledSave = queuedSave.then(() => undefined, () => undefined);
    queueRef.current.set(key, settledSave);
    void settledSave.finally(() => {
      setPendingCount((count) => Math.max(0, count - 1));
      if (queueRef.current.get(key) === settledSave) queueRef.current.delete(key);
    });
    return queuedSave;
  };

  const markSaved = (key: string) => {
    failureKeysRef.current.delete(key);
    setHasFailure(failureKeysRef.current.size > 0);
  };
  const markFailed = (key: string) => {
    failureKeysRef.current.add(key);
    setHasFailure(true);
  };
  const resetFailure = () => {
    failureKeysRef.current.clear();
    setHasFailure(false);
  };
  const waitForPending = async () => {
    await Promise.all([...queueRef.current.values()]);
    return failureKeysRef.current.size === 0;
  };

  return {
    enqueue,
    hasFailure,
    isPending: pendingCount > 0,
    markFailed,
    markSaved,
    resetFailure,
    waitForPending,
  };
}
