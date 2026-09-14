import tempfile
import unittest

from store import SyncStore


def operation(op_id, title, modified_at, device_id, record_id="conversation:one"):
    return {
        "opId": op_id,
        "modifiedAt": modified_at,
        "deviceId": device_id,
        "record": {
            "id": record_id,
            "kind": "conversation",
            "deleted": False,
            "payload": {"conversation_uid": "one", "title": title},
        },
    }


class SyncStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = SyncStore(self.temporary.name)

    def tearDown(self):
        self.store._connection.close()
        self.temporary.cleanup()

    def test_newest_change_wins_and_stale_operation_is_acknowledged(self):
        first = self.store.synchronize(
            "user",
            0,
            [operation("first", "new", 20, "desktop")],
        )
        stale = self.store.synchronize(
            "user",
            first["cursor"],
            [operation("stale", "old", 10, "android")],
        )
        self.assertEqual(stale["acknowledgedIds"], ["stale"])
        snapshot = self.store.synchronize("user", 0, [])
        self.assertEqual(snapshot["records"][0]["payload"]["title"], "new")

    def test_device_id_breaks_equal_timestamp_ties(self):
        self.store.synchronize(
            "user",
            0,
            [operation("a", "desktop", 20, "a")],
        )
        self.store.synchronize(
            "user",
            0,
            [operation("b", "android", 20, "z")],
        )
        snapshot = self.store.synchronize("user", 0, [])
        self.assertEqual(snapshot["records"][0]["payload"]["title"], "android")

    def test_pagination_and_user_isolation(self):
        first_page = self.store.synchronize(
            "user",
            0,
            [
                operation("one", "first", 10, "desktop", "conversation:one"),
                operation("two", "second", 20, "desktop", "conversation:two"),
            ],
            limit=1,
        )
        self.assertTrue(first_page["hasMore"])
        self.assertEqual(len(first_page["records"]), 1)
        second_page = self.store.synchronize(
            "user",
            first_page["cursor"],
            [],
            limit=1,
        )
        self.assertFalse(second_page["hasMore"])
        self.assertEqual(second_page["records"][0]["id"], "conversation:two")
        other_user = self.store.synchronize("other", 0, [])
        self.assertEqual(other_user["records"], [])


if __name__ == "__main__":
    unittest.main()
