import type { LineageGraph, LineageGraphDataset, LineageGraphEdge } from "../../types";

function edgeIdentity(edge: LineageGraphEdge) {
  return `${edge.fromDatasetId}::${edge.fromColumnId}->${edge.toDatasetId}::${edge.toColumnId}`;
}

function processColumnName(dataset: LineageGraphDataset, columnId: string) {
  return dataset.columns.find((column) => column.id === columnId)?.name.trim().toLowerCase() ?? null;
}

function canBridgeProcessColumn(
  dataset: LineageGraphDataset,
  incoming: LineageGraphEdge,
  outgoing: LineageGraphEdge,
) {
  if (incoming.toColumnId === outgoing.fromColumnId) return true;

  const incomingName = processColumnName(dataset, incoming.toColumnId);
  const outgoingName = processColumnName(dataset, outgoing.fromColumnId);
  return Boolean(incomingName && outgoingName && incomingName === outgoingName);
}

function dedupeEdges(edges: LineageGraphEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const identity = edgeIdentity(edge);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function collapseProcessLineageGraph(graph: LineageGraph): LineageGraph {
  const processDatasets = graph.datasets.filter((dataset) => dataset.layer === "PROCESS");
  if (processDatasets.length === 0) return graph;

  let edges = graph.edges.map((edge) => ({ ...edge }));

  processDatasets.forEach((processDataset) => {
    const incomingEdges = edges.filter((edge) => edge.toDatasetId === processDataset.id);
    const outgoingEdges = edges.filter((edge) => edge.fromDatasetId === processDataset.id);
    const bridgedEdges: LineageGraphEdge[] = [];

    incomingEdges.forEach((incoming) => {
      outgoingEdges.forEach((outgoing) => {
        if (!canBridgeProcessColumn(processDataset, incoming, outgoing)) return;
        bridgedEdges.push({
          fromColumnId: incoming.fromColumnId,
          fromDatasetId: incoming.fromDatasetId,
          toColumnId: outgoing.toColumnId,
          toDatasetId: outgoing.toDatasetId,
        });
      });
    });

    edges = dedupeEdges([
      ...edges.filter((edge) => edge.fromDatasetId !== processDataset.id && edge.toDatasetId !== processDataset.id),
      ...bridgedEdges,
    ]);
  });

  return {
    ...graph,
    datasets: graph.datasets.filter((dataset) => dataset.layer !== "PROCESS"),
    edges,
  };
}
