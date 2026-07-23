import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy.exc import OperationalError

from app.core.database import get_db


class DatabaseSessionLifecycleTests(unittest.TestCase):
    def test_request_session_rolls_back_open_transaction_before_close(self) -> None:
        session = MagicMock()
        session.in_transaction.return_value = True

        with patch("app.core.database.SessionLocal", return_value=session):
            dependency = get_db()
            self.assertIs(next(dependency), session)
            with self.assertRaises(StopIteration):
                next(dependency)

        session.rollback.assert_called_once_with()
        session.close.assert_called_once_with()

    def test_request_session_closes_even_when_rollback_fails(self) -> None:
        session = MagicMock()
        session.in_transaction.return_value = True
        session.rollback.side_effect = OperationalError("rollback", {}, RuntimeError("connection lost"))

        with patch("app.core.database.SessionLocal", return_value=session):
            dependency = get_db()
            self.assertIs(next(dependency), session)
            with self.assertRaises(StopIteration):
                next(dependency)

        session.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
