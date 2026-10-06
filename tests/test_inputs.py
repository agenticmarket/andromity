import pytest

from andromity.core.inputs import InputQueue


def test_queue_promotes_any_message_and_keeps_ordinary_queue_order():
    queue = InputQueue("session")
    first = queue.submit({"prompt": "first"}, "queue", "first")
    second = queue.submit({"prompt": "second"}, "queue", "second")
    queue.promote(second.id)
    assert queue.peek(steering_only=True) is second
    queue.applied(second)
    assert queue.peek(steering_only=True) is None
    assert queue.peek() is first


def test_submission_is_idempotent_and_does_not_retain_large_delivered_payloads():
    queue = InputQueue("session")
    payload = {"prompt": "one", "image_uris": ["image"]}
    item = queue.submit(payload, "queue", "id")
    payload["image_uris"].append("changed")
    assert item.payload["image_uris"] == ["image"]
    assert queue.submit({"prompt": "retry"}, "queue", "id") is item
    queue.applied(item)
    assert item.payload == {}
    assert queue.submit({"prompt": "retry"}, "queue", "id") is item
    assert queue.items == []


def test_pause_prevents_delivery_until_resume_and_removal_does_not_affect_other_sessions():
    queue, other = InputQueue("a"), InputQueue("b")
    first = queue.submit({"prompt": "first"}, "steer", "id")
    second = other.submit({"prompt": "other"}, "queue", "id")
    queue.pause()
    assert queue.peek() is None
    queue.resume()
    assert queue.peek() is first
    queue.remove(first.id)
    assert queue.peek() is None
    assert other.peek() is second


def test_full_queue_rejects_without_losing_existing_messages():
    queue = InputQueue("a")
    for index in range(10):
        queue.submit({"prompt": str(index)}, "queue", str(index))
    with pytest.raises(ValueError, match="Queue is full"):
        queue.submit({"prompt": "overflow"}, "queue", "extra")
    assert len(queue.items) == 10
    assert "extra" not in queue.requests
