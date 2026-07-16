from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import settings
from app.models.base import Base
from app import models  # noqa: F401 - registers all metadata tables

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
if config.config_file_name:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=settings.database_url, target_metadata=target_metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        # Alembic creates this table with VARCHAR(32) by default.  Our
        # descriptive revision ids are longer than that, so an upgrade can
        # fail after applying the actual schema changes.  Widen the version
        # column before recording any revision; this is idempotent and also
        # repairs databases created by older AskLake releases.
        if connection.dialect.name == "postgresql":
            connection.exec_driver_sql(
                """
                DO $$
                BEGIN
                    IF to_regclass('public.alembic_version') IS NOT NULL THEN
                        ALTER TABLE public.alembic_version
                        ALTER COLUMN version_num TYPE VARCHAR(255);
                    END IF;
                END
                $$;
                """
            )
            connection.exec_driver_sql(
                """
                CREATE TABLE IF NOT EXISTS public.alembic_version (
                    version_num VARCHAR(255) NOT NULL
                );
                """
            )
            # The DDL above starts an implicit SQLAlchemy transaction. Commit
            # it before Alembic opens its migration transaction; otherwise a
            # connection close can roll back both the version table repair
            # and every migration operation while still printing upgrade
            # messages.
            connection.commit()
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
