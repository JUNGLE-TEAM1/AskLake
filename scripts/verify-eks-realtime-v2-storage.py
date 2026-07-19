#!/usr/bin/env python3
"""Static fail-closed verification for the EKS Auto Mode V2 storage foundation."""

from pathlib import Path
import sys

import yaml


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "infra" / "eks" / "storage" / "realtime-v2-auto-mode.yaml"


def main() -> int:
    documents = list(yaml.safe_load_all(MANIFEST.read_text(encoding="utf-8")))
    errors: list[str] = []
    if [document.get("kind") for document in documents] != ["StorageClass", "VolumeSnapshotClass"]:
        errors.append("manifest must contain exactly StorageClass then VolumeSnapshotClass")
    else:
        storage, snapshot = documents
        if storage.get("metadata", {}).get("name") != "asklake-realtime-v2-gp3-encrypted":
            errors.append("storage class name drifted")
        if storage.get("provisioner") != "ebs.csi.eks.amazonaws.com":
            errors.append("storage class must use the EKS Auto Mode EBS provisioner")
        if storage.get("reclaimPolicy") != "Retain" or storage.get("volumeBindingMode") != "WaitForFirstConsumer":
            errors.append("storage class must retain volumes and bind only after scheduling")
        if storage.get("parameters") != {
            "type": "gp3",
            "encrypted": "true",
            "csi.storage.k8s.io/fstype": "ext4",
        }:
            errors.append("storage class must be encrypted gp3 ext4 without implicit parameters")
        topology = storage.get("allowedTopologies") or []
        if topology != [{"matchLabelExpressions": [{"key": "eks.amazonaws.com/compute-type", "values": ["auto"]}]}]:
            errors.append("storage class must stay on EKS Auto Mode compute")
        if snapshot.get("metadata", {}).get("name") != "asklake-realtime-v2-ebs-retain":
            errors.append("snapshot class name drifted")
        if snapshot.get("driver") != "ebs.csi.eks.amazonaws.com" or snapshot.get("deletionPolicy") != "Retain":
            errors.append("snapshot class must use Auto Mode EBS and retain recovery evidence")
    print(yaml.safe_dump({"errors": errors, "status": "pass" if not errors else "fail"}, sort_keys=True), end="")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
