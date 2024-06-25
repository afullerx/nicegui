from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import TYPE_CHECKING, Any, Deque, Dict, Optional, Tuple

from pympler import asizeof

from . import background_tasks, core

if TYPE_CHECKING:
    from .client import Client
    from .element import Element

ClientId = str
ElementId = int
MessageType = str
Message = Tuple[ClientId, MessageType, Any]


class Outbox:

    def __init__(self, client: Client) -> None:
        self.client = client
        self.updates: Dict[ElementId, Optional[Element]] = {}
        self.messages: Deque[Message] = deque()
        self._should_stop = False
        self._enqueue_event: Optional[asyncio.Event] = None
        self._history: Deque[Tuple[int, float, Tuple[MessageType, Any, ClientId]]] = deque()
        self._message_count: int = 0
        self._retransmit_count: int = 0
        self._stats = {"appendTime": 0, "count": 0, "min": 9999999999999999, "max": 0}
        self._history_duration: Optional[float] = None
        self._history_max_length: int = 0

        if core.app.is_started:
            background_tasks.create(self.loop(), name=f'outbox loop {client.id}')
        else:
            core.app.on_startup(self.loop)

    @property
    def message_count(self) -> int:
        """Total number of messages sent."""
        return self._message_count

    def _set_enqueue_event(self) -> None:
        """Set the enqueue event while accounting for lazy initialization."""
        if self._enqueue_event:
            self._enqueue_event.set()

    def enqueue_update(self, element: Element) -> None:
        """Enqueue an update for the given element."""
        self.client.check_existence()
        self.updates[element.id] = element
        self._set_enqueue_event()

    def enqueue_delete(self, element: Element) -> None:
        """Enqueue a deletion for the given element."""
        self.client.check_existence()
        self.updates[element.id] = None
        self._set_enqueue_event()

    def enqueue_message(self, message_type: MessageType, data: Any, target_id: ClientId) -> None:
        """Enqueue a message for the given client."""
        self.client.check_existence()
        self.messages.append((target_id, message_type, data))
        self._set_enqueue_event()

    def _append_history(self, message_type: MessageType, data: Any, target: ClientId) -> None:
        if self._history_duration is None:
            if self.client.shared:
                self._history_duration = 30
            else:
                dt = core.sio.eio.ping_interval + core.sio.eio.ping_timeout + self.client.page.resolve_reconnect_timeout()
                print(f'dt: {dt}')
                self._history_duration = dt
            self._history_max_length = core.app.config.message_history_max
            print(f'_history_duration: {self._history_duration}')
            print(f'_history_max_len {self._history_max_length}')

        self._message_count += 1
        timestamp = time.time()
        while self._history and (self._history[0][1] < timestamp - self._history_duration or
                                 len(self._history) > self._history_max_length):
            self._history.popleft()
        self._history.append((self._message_count, timestamp, (message_type, data, target)))
        if len(self._history) % 1000 == 0:
            print(f'len(self._history): {len(self._history)}', asizeof.asizeof(self._history))

    def synchronize(self, last_message_id: int, retransmit_id: str) -> bool:
        """Synchronize the state of a connecting client by resending missed messages, if possible."""
        print(len(self._history), len(self.messages), len(self.updates))
        print(f'lmi: {last_message_id}')

        messages = []
        if self._history:
            next_id = last_message_id + 1
            oldest_id = self._history[0][0]
            if oldest_id > next_id:
                return False

            start = next_id - oldest_id
            st = time.perf_counter()
            for i in range(start, len(self._history)):
                messages.append(self._history[i][2])

            dur = time.perf_counter()-st
            print(f'msg block: {(dur)*1000:.3f}', len(messages))
            if messages:
                print(f't/msg: {(dur)*1000000/len(messages)}')
            print(f'app avg: {(self._stats["appendTime"]/self._stats["count"]*1_000_000): .2f}')
            print(f'mix: {self._stats["min"]*1_000_000:.2f}', f'max: {self._stats["max"]*1_000_000:.2f}')

        elif last_message_id != self._message_count:
            return False

        self.enqueue_message('syncronize',
                             {
                                 'starting_message_id': self._message_count,
                                 'messages': messages,
                                 'retransmit_id': retransmit_id
                             },
                             self.client.id)
        return True

    async def loop(self) -> None:
        """Send updates and messages to all clients in an endless loop."""
        self._enqueue_event = asyncio.Event()
        self._enqueue_event.set()

        while not self._should_stop:
            try:
                if not self._enqueue_event.is_set():
                    try:
                        await asyncio.wait_for(self._enqueue_event.wait(), timeout=1.0)
                    except (TimeoutError, asyncio.TimeoutError):
                        continue

                if not self.client.has_socket_connection:
                    await asyncio.sleep(0.1)
                    continue

                self._enqueue_event.clear()

                coros = []
                if self.updates:
                    data = {
                        element_id: None if element is None else element._to_dict()  # pylint: disable=protected-access
                        for element_id, element in self.updates.items()
                    }
                    coros.append(self._emit('update', data, self.client.id))
                    self.updates.clear()

                if self.messages:
                    for target_id, message_type, data in self.messages:
                        coros.append(self._emit(message_type, data, target_id))
                    self.messages.clear()

                for coro in coros:
                    try:
                        await coro
                    except Exception as e:
                        core.app.handle_exception(e)

            except Exception as e:
                core.app.handle_exception(e)
                await asyncio.sleep(0.1)

    async def _emit(self, message_type: MessageType, data: Any, target_id: ClientId) -> None:
        if message_type != 'syncronize':
            st = time.perf_counter()
            if self._history_duration != 0:
                self._append_history(message_type, data, target_id)
                t = time.perf_counter()-st
                self._stats["appendTime"] += t
                self._stats["count"] += 1
                if (t < self._stats["min"]):
                    self._stats["min"] = t
                if (t > self._stats["max"]):
                    self._stats["max"] = t

            data['message_id'] = self._message_count
        else:
            # message_type, data, target_id = data
            print('ssssssssssssssss')
            pass
        # print(asizeof.asizeof(self._history))
        # print(f'=============================== {message_type} ==========================================')
        # print(data)
        # if 'message_id' not in data:
        #     print(f'out: {data}')
        await core.sio.emit(message_type, data, room=target_id)
        if core.air is not None and core.air.is_air_target(target_id):
            await core.air.emit(message_type, data, room=target_id)

    def stop(self) -> None:
        """Stop the outbox loop."""
        self._should_stop = True
