import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, List


logger = logging.getLogger("storage.writer")


@dataclass(frozen=True)
class WriteItem:
    kind: str
    payload: dict
    high_priority: bool = False


class BatchWriter:
    """Bounded batch writer used by the upcoming normalized market-event pipeline."""

    def __init__(
        self,
        handler: Callable[[List[WriteItem]], None],
        max_queue: int = 20_000,
        max_batch: int = 500,
        flush_interval: float = 0.25,
    ):
        self.handler = handler
        self.max_batch = max_batch
        self.flush_interval = flush_interval
        self.queue: queue.Queue[WriteItem] = queue.Queue(maxsize=max_queue)
        self.dropped_low_priority = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="market-event-writer", daemon=True)

    def start(self):
        if not self._thread.is_alive():
            self._thread.start()

    def submit(self, item: WriteItem) -> bool:
        try:
            self.queue.put_nowait(item)
            return True
        except queue.Full:
            if not item.high_priority:
                self.dropped_low_priority += 1
                return False
            self.queue.put(item, timeout=5)
            return True

    def _run(self):
        batch: List[WriteItem] = []
        deadline = time.monotonic() + self.flush_interval
        while not self._stop.is_set() or not self.queue.empty() or batch:
            timeout = max(0.0, deadline - time.monotonic())
            try:
                batch.append(self.queue.get(timeout=timeout))
            except queue.Empty:
                pass
            if batch and (len(batch) >= self.max_batch or time.monotonic() >= deadline):
                try:
                    self.handler(batch)
                except Exception:
                    logger.exception("Batch persistence failed")
                finally:
                    for _ in batch:
                        self.queue.task_done()
                    batch = []
                deadline = time.monotonic() + self.flush_interval

    def close(self, timeout: float = 5.0):
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout)
