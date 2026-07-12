import importlib.util
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


PYSPARK_AVAILABLE = importlib.util.find_spec("pyspark") is not None
WINDOWS_HADOOP_FILE_IO_AVAILABLE = os.name != "nt" or bool(
    os.environ.get("HADOOP_HOME")
    and (Path(os.environ["HADOOP_HOME"]) / "bin" / "winutils.exe").exists()
)

if PYSPARK_AVAILABLE:
    from pyspark.sql import SparkSession

    from scripts.spark_job_run import read_sql_source


@unittest.skipUnless(
    PYSPARK_AVAILABLE and WINDOWS_HADOOP_FILE_IO_AVAILABLE,
    "pyspark or Windows Hadoop local file support is not available",
)
class SparkSqlJobSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_directory = TemporaryDirectory()
        root = Path(cls.temp_directory.name)
        os.environ.setdefault("SPARK_LOCAL_IP", "127.0.0.1")
        os.environ.setdefault("PYSPARK_PYTHON", sys.executable)
        cls.spark = (
            SparkSession.builder
            .master("local[1]")
            .appName("asklake-sql-job-source-test")
            .config("spark.sql.caseSensitive", "true")
            .config("spark.sql.shuffle.partitions", "1")
            .config("spark.ui.enabled", "false")
            .config("spark.sql.warehouse.dir", (root / "warehouse").as_uri())
            .getOrCreate()
        )
        cls.spark.sparkContext.setLogLevel("ERROR")

    @classmethod
    def tearDownClass(cls):
        cls.spark.stop()
        cls.temp_directory.cleanup()

    def test_saved_query_reads_all_catalog_segments_beyond_preview_size(self):
        root = Path(self.temp_directory.name)
        first_run = root / "reviews-run-1"
        second_run = root / "reviews-run-2"
        products_run = root / "products-run-1"
        first_run.mkdir()
        second_run.mkdir()
        products_run.mkdir()

        (first_run / "part-000.json").write_text(
            "\n".join(
                json.dumps({"id": value, "product_id": value % 3, "score": 5})
                for value in range(60)
            ),
            encoding="utf-8",
        )
        (second_run / "part-000.json").write_text(
            "\n".join(
                json.dumps({"id": value, "product_id": value % 3, "score": 5})
                for value in range(60, 120)
            ),
            encoding="utf-8",
        )
        (products_run / "part-000.json").write_text(
            "\n".join(
                json.dumps({"id": value, "product_name": name})
                for value, name in enumerate(["Phone", "Case", "Charger"])
            ),
            encoding="utf-8",
        )

        sql_execution = {
            "baseDatasetId": "ds_reviews",
            "datasets": [
                {
                    "datasetId": "ds_reviews",
                    "name": "reviews",
                    "storageSegments": [
                        {"format": "json", "location": first_run.as_uri()},
                        {"format": "json", "location": second_run.as_uri()},
                    ],
                },
                {
                    "datasetId": "ds_products",
                    "name": "products",
                    "storageSegments": [
                        {"format": "json", "location": products_run.as_uri()},
                    ],
                },
            ],
            "query": (
                "SELECT reviews.id, products.product_name "
                "FROM reviews JOIN products ON reviews.product_id = products.id "
                "WHERE reviews.score >= 4"
            ),
            "referenceDatasetIds": ["ds_products"],
            "sourceRunId": "sql-preview-only-two-rows",
            "validatedReadOnly": True,
            "version": 1,
        }

        result = read_sql_source(self.spark, sql_execution)

        self.assertEqual(result.count(), 120)
        self.assertEqual(result.agg({"id": "max"}).first()[0], 119)
        self.assertEqual(
            {row[0] for row in result.select("product_name").distinct().collect()},
            {"Phone", "Case", "Charger"},
        )


if __name__ == "__main__":
    unittest.main()
