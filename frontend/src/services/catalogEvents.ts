export const CATALOG_DATASET_DELETED_EVENT = "asklake:catalog-dataset-deleted";

type CatalogDatasetDeletedDetail = {
  datasetId: string;
};

export function notifyCatalogDatasetDeleted(datasetId: string) {
  if (typeof window === "undefined") return;

  window.dispatchEvent(new CustomEvent<CatalogDatasetDeletedDetail>(CATALOG_DATASET_DELETED_EVENT, {
    detail: { datasetId },
  }));
}

export function onCatalogDatasetDeleted(listener: (datasetId: string) => void) {
  if (typeof window === "undefined") return () => undefined;

  const handleEvent = (event: Event) => {
    const datasetId = (event as CustomEvent<Partial<CatalogDatasetDeletedDetail>>).detail?.datasetId;
    if (typeof datasetId === "string" && datasetId) listener(datasetId);
  };

  window.addEventListener(CATALOG_DATASET_DELETED_EVENT, handleEvent);
  return () => window.removeEventListener(CATALOG_DATASET_DELETED_EVENT, handleEvent);
}
