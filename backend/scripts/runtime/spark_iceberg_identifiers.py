def required_iceberg_identifier(value, field):
    identifier = str(value or "").strip()
    forbidden = ('`', '"', "'", ";", "\x00")
    if (
        not identifier
        or len(identifier) > 255
        or any(character in identifier for character in forbidden)
    ):
        raise ValueError(f"ICEBERG_TARGET_INVALID {field}")
    return identifier


def quote_spark_identifier(value):
    return f"`{str(value).replace('`', '``')}`"


def spark_iceberg_source_identifier(value):
    raw = str(value or "").strip()
    lowered = raw.lower()
    if lowered.startswith("iceberg://"):
        parts = raw[len("iceberg://"):].split("/")
    elif lowered.startswith("iceberg:"):
        parts = raw[len("iceberg:"):].split(".")
    else:
        parts = raw.split(".")
    if len(parts) != 3 or any(not str(part).strip() for part in parts):
        raise ValueError(
            "ICEBERG_SOURCE_INVALID expected catalog.namespace.table"
        )
    names = (
        required_iceberg_identifier(parts[0], "source.catalog"),
        required_iceberg_identifier(parts[1], "source.namespace"),
        required_iceberg_identifier(parts[2], "source.table"),
    )
    return ".".join(quote_spark_identifier(name) for name in names)
