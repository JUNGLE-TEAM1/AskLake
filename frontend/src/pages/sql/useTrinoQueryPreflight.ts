import { useCallback, useEffect, useMemo, useReducer } from "react";

import { apiConfig } from "../../services/apiClient";
import { estimateSqlQueryRun, validateSqlQueryRun } from "../../services/sqlQueryApi";
import type { CatalogDataset, TrinoQueryEstimate } from "../../types";
import {
  describeSqlValidationFailure,
  type SqlValidationFailureKind,
} from "./sqlPreflightErrors";

type QueryPreflightState = {
  estimate: TrinoQueryEstimate | null;
  estimateDialogOpen: boolean;
  estimateError: string | null;
  estimateKey: string | null;
  estimatePending: boolean;
  validationError: string | null;
  validationFailureKind: SqlValidationFailureKind | null;
  validationKey: string | null;
  validationPending: boolean;
};

type QueryPreflightAction =
  | { type: "patch"; value: Partial<QueryPreflightState> }
  | { type: "reset" };

const INITIAL_QUERY_PREFLIGHT_STATE: QueryPreflightState = {
  estimate: null,
  estimateDialogOpen: false,
  estimateError: null,
  estimateKey: null,
  estimatePending: false,
  validationError: null,
  validationFailureKind: null,
  validationKey: null,
  validationPending: false,
};

function queryPreflightReducer(state: QueryPreflightState, action: QueryPreflightAction): QueryPreflightState {
  return action.type === "reset" ? INITIAL_QUERY_PREFLIGHT_STATE : { ...state, ...action.value };
}

function useTrinoValidation({
  baseDataset,
  enabled,
  localCanExecute,
  query,
  queryValidationKey,
  referenceDatasetIds,
}: {
  baseDataset: CatalogDataset | null;
  enabled: boolean;
  localCanExecute: boolean;
  query: string;
  queryValidationKey: string;
  referenceDatasetIds: string[];
}, dispatch: (action: QueryPreflightAction) => void) {
  useEffect(() => {
    if (!enabled || !baseDataset || !localCanExecute) {
      dispatch({ type: "patch", value: {
        validationError: null,
        validationFailureKind: null,
        validationKey: null,
        validationPending: false,
      } });
      return;
    }
    let disposed = false;
    const timeoutId = window.setTimeout(() => {
      dispatch({ type: "patch", value: {
        validationError: null,
        validationFailureKind: null,
        validationPending: true,
      } });
      void validateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort())
        .then(() => {
          if (!disposed) dispatch({ type: "patch", value: { validationKey: queryValidationKey } });
        })
        .catch((error) => {
          if (disposed) return;
          const failure = describeSqlValidationFailure(error);
          dispatch({ type: "patch", value: {
            validationError: failure.message,
            validationFailureKind: failure.kind,
            validationKey: null,
          } });
        })
        .finally(() => {
          if (!disposed) dispatch({ type: "patch", value: { validationPending: false } });
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [baseDataset, dispatch, enabled, localCanExecute, query, queryValidationKey, referenceDatasetIds]);
}

function useTrinoEstimate({
  baseDataset,
  canRunPreview,
  enabled,
  query,
  queryValidationKey,
  referenceDatasetIds,
}: {
  baseDataset: CatalogDataset | null;
  canRunPreview: boolean;
  enabled: boolean;
  query: string;
  queryValidationKey: string;
  referenceDatasetIds: string[];
}, dispatch: (action: QueryPreflightAction) => void) {
  useEffect(() => {
    if (!enabled || !baseDataset || !canRunPreview) {
      dispatch({ type: "patch", value: { estimatePending: false } });
      return;
    }
    let disposed = false;
    const timeoutId = window.setTimeout(() => {
      dispatch({ type: "patch", value: { estimateError: null, estimatePending: true } });
      void estimateSqlQueryRun(baseDataset, query, [...referenceDatasetIds].sort())
        .then((estimate) => {
          if (!disposed) dispatch({ type: "patch", value: { estimate, estimateKey: queryValidationKey } });
        })
        .catch((error) => {
          if (disposed) return;
          dispatch({ type: "patch", value: {
            estimateError: error instanceof Error ? error.message : "실행 평가를 완료하지 못했습니다.",
            estimateKey: queryValidationKey,
          } });
        })
        .finally(() => {
          if (!disposed) dispatch({ type: "patch", value: { estimatePending: false } });
        });
    }, 500);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [baseDataset, canRunPreview, dispatch, enabled, query, queryValidationKey, referenceDatasetIds]);
}

export function useTrinoQueryPreflight({
  baseDataset,
  localCanExecute,
  query,
  queryValidationKey,
  referenceDatasetIds,
  usesTrinoRuntime,
}: {
  baseDataset: CatalogDataset | null;
  localCanExecute: boolean;
  query: string;
  queryValidationKey: string;
  referenceDatasetIds: string[];
  usesTrinoRuntime: boolean;
}) {
  const [state, dispatch] = useReducer(queryPreflightReducer, INITIAL_QUERY_PREFLIGHT_STATE);
  const enabled = usesTrinoRuntime && !apiConfig.useMock;
  useTrinoValidation({ baseDataset, enabled, localCanExecute, query, queryValidationKey, referenceDatasetIds }, dispatch);
  const canRunPreview = localCanExecute && (!enabled || state.validationKey === queryValidationKey);
  useTrinoEstimate({ baseDataset, canRunPreview, enabled, query, queryValidationKey, referenceDatasetIds }, dispatch);
  const activeEstimate = useMemo(
    () => state.estimateKey === queryValidationKey ? state.estimate : null,
    [queryValidationKey, state.estimate, state.estimateKey],
  );
  const closeEstimateDialog = useCallback(() => {
    dispatch({ type: "patch", value: { estimateDialogOpen: false } });
  }, []);
  const openEstimateDialog = useCallback(() => {
    dispatch({ type: "patch", value: { estimateDialogOpen: true } });
  }, []);
  const recordEstimate = useCallback((estimate: TrinoQueryEstimate, estimateKey: string) => {
    dispatch({ type: "patch", value: { estimate, estimateError: null, estimateKey } });
  }, []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return {
    activeEstimate,
    canRunPreview,
    closeEstimateDialog,
    estimateDialogOpen: state.estimateDialogOpen,
    estimateError: state.estimateError,
    estimatePending: state.estimatePending,
    openEstimateDialog,
    recordEstimate,
    reset,
    setEstimateDialogOpen: (open: boolean) => dispatch({ type: "patch", value: { estimateDialogOpen: open } }),
    validationError: state.validationError,
    validationFailureKind: state.validationFailureKind,
    validationPending: state.validationPending,
  };
}
