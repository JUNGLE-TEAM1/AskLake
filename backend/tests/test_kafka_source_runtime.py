import unittest

from scripts.runtime.kafka_source import configure_kafka_auth


class FakeReader:
    def __init__(self) -> None:
        self.options: dict[str, str] = {}

    def option(self, name: str, value: str):
        self.options[name] = value
        return self


class KafkaSourceRuntimeTests(unittest.TestCase):
    def test_msk_iam_applies_exact_sasl_options(self) -> None:
        reader = FakeReader()

        self.assertIs(configure_kafka_auth(reader, "iam"), reader)
        self.assertEqual(reader.options["kafka.security.protocol"], "SASL_SSL")
        self.assertEqual(reader.options["kafka.sasl.mechanism"], "AWS_MSK_IAM")
        self.assertEqual(
            reader.options["kafka.sasl.client.callback.handler.class"],
            "software.amazon.msk.auth.iam.IAMClientCallbackHandler",
        )

    def test_non_iam_reader_is_unchanged(self) -> None:
        reader = FakeReader()

        self.assertIs(configure_kafka_auth(reader, ""), reader)
        self.assertEqual(reader.options, {})


if __name__ == "__main__":
    unittest.main()
