// Compatibility façade: App is the only remaining consumer. Import domain hooks directly in new features.
export { useAskLakeWorkspace as useAskLakeData } from "../state/asklake/useAskLakeWorkspace";
