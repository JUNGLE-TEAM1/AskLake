import { useEffect, useRef } from "react";
import {
  createResourceQueryKey,
  LatestRequestGate,
  type ResourceQueryKeyInput,
} from "../../../state/requestOwnership";

export function useDashboardAssistantRequestGate(
  invalidationKey: string,
  onInvalidate?: () => void,
) {
  const requests = useRef(new LatestRequestGate());
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;

  useEffect(() => {
    requests.current.invalidate();
    onInvalidateRef.current?.();
    return () => requests.current.invalidate();
  }, [invalidationKey]);

  return requests;
}

export function beginDashboardAssistantRequest(
  requests: LatestRequestGate,
  input: ResourceQueryKeyInput,
) {
  return requests.begin(createResourceQueryKey(input));
}
