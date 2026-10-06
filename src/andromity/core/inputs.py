"""Session-local input scheduling shared by the daemon and terminal UI."""
import asyncio
import copy
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass
class PendingInput:
    id: str
    payload: dict[str, Any]
    delivery: str = "queue"
    order: int = 0
    status: str = "pending"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "delivery": self.delivery, "status": self.status,
                "prompt": self.payload.get("prompt", ""),
                "image_uris": self.payload.get("image_uris", []),
                "image_count": len(self.payload.get("images") or self.payload.get("image_uris") or [])}


class InputQueue:
    """All mutations run synchronously on the owning runtime's event loop."""

    def __init__(self, session_id: str, on_change: Optional[Callable] = None):
        self.session_id = session_id
        self.epoch = str(uuid.uuid4())
        self.items: list[PendingInput] = []
        self.requests: dict[str, PendingInput] = {}
        self.revision = 0
        self.paused = False
        self.on_change = on_change
        self.steering = asyncio.Event()

    def snapshot(self) -> dict[str, Any]:
        return {"session_id": self.session_id, "epoch": self.epoch, "revision": self.revision,
                "paused": self.paused, "items": [item.to_dict() for item in self.items]}

    def changed(self) -> None:
        self.revision += 1
        if any(item.delivery == "steer" for item in self.items) and not self.paused:
            self.steering.set()
        else:
            self.steering.clear()
        if self.on_change:
            self.on_change(self.snapshot())

    def submit(self, payload: dict[str, Any], delivery: str = "queue",
               request_id: Optional[str] = None) -> PendingInput:
        if delivery not in ("queue", "steer"):
            raise ValueError("Delivery must be queue or steer")
        request_id = request_id or str(uuid.uuid4())
        if request_id in self.requests:
            return self.requests[request_id]
        if not str(payload.get("prompt", "")).strip() and not (payload.get("images") or payload.get("image_uris")):
            raise ValueError("Enter a message or attach an image")
        if len(self.items) >= 10:
            raise ValueError("Queue is full (max 10). Remove a message or wait for delivery.")
        item = PendingInput(request_id, copy.deepcopy(payload), delivery, self.revision + 1)
        self.requests[request_id] = item
        self.items.append(item)
        self.changed()
        return item

    def promote(self, input_id: str) -> None:
        item = self.requests.get(input_id)
        if item is None:
            raise ValueError("Queued message was not found")
        if item not in self.items or item.delivery == "steer":
            return
        item.delivery = "steer"
        item.order = self.revision + 1
        self.changed()

    def remove(self, input_id: str) -> None:
        item = self.requests.get(input_id)
        if item in self.items:
            self.items.remove(item)
            item.status = "removed"
            item.payload = {}
            self.changed()

    def pause(self) -> None:
        self.paused = True
        self.changed()

    def resume(self) -> None:
        self.paused = False
        self.changed()

    def peek(self, steering_only: bool = False) -> Optional[PendingInput]:
        if self.paused:
            return None
        steers = sorted((i for i in self.items if i.delivery == "steer"), key=lambda i: i.order)
        return (steers or ([] if steering_only else self.items) or [None])[0]

    def applied(self, item: PendingInput) -> None:
        if item in self.items:
            self.items.remove(item)
        item.status = "applied"
        # Keep deduplication records, but release potentially large images/context.
        item.payload = {}
        self.changed()

    async def interaction(self, awaitable: Any, superseded: Any) -> Any:
        """Steering dismisses an unanswered interaction; it never approves it."""
        task = asyncio.ensure_future(awaitable)
        signal = asyncio.create_task(self.steering.wait())
        try:
            done, _ = await asyncio.wait({task, signal}, return_when=asyncio.FIRST_COMPLETED)
            # An immediate approval/answer needs no dismissal, even if a steer
            # was received during the preceding model response.
            if task in done:
                return task.result()
            return superseded
        finally:
            for pending in (task, signal):
                if not pending.done():
                    pending.cancel()
            await asyncio.gather(task, signal, return_exceptions=True)
