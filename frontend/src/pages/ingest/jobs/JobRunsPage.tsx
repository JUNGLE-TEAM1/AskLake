

import { ContinuousJobRunsPage } from "./ContinuousJobRunsPage";
import { JobRunsPageProps } from "./jobRunsModel";
import { SnapshotJobRunsPage } from "./SnapshotJobRunsPage";

export function JobRunsPage(props: JobRunsPageProps) {
  if (props.job.executionMode === "continuous") {
    return <ContinuousJobRunsPage {...props} />;
  }
  return <SnapshotJobRunsPage {...props} />;
}
