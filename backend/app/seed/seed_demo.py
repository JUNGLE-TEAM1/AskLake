from app.core.database import engine
import app.models  # noqa: F401
from app.models.base import Base


def seed_demo() -> None:
    Base.metadata.create_all(bind=engine)
    print("AskLake FastAPI demo schema initialized.")


if __name__ == "__main__":
    seed_demo()
