from __future__ import annotations
import copy
import threading
import time


class HistoryStore:
    """Session-only prompt history. No image or prompt content reaches disk."""

    def __init__(self, root):
        del root
        self.path = None
        self._lock = threading.RLock()
        self._items = []
        self._next_id = 1

    def add(self,image_hash,prompt,settings,model,notes):
        with self._lock:
            self._items.append({
                "id": self._next_id,
                "created": time.time(),
                "image_hash": str(image_hash),
                "prompt": str(prompt.final_prompt),
                "negative_prompt": str(prompt.negative_prompt),
                "settings": copy.deepcopy(settings),
                "model": str(model),
                "notes": str(notes),
            })
            self._next_id += 1
            self._items = self._items[-100:]

    def list(self):
        with self._lock:
            return copy.deepcopy(list(reversed(self._items[-100:])))


class PresetStore:
    """Session-only UI presets; intentionally not persisted."""

    def __init__(self,root):
        del root
        self.path = None
        self._lock = threading.RLock()
        self._items = []

    def list(self):
        with self._lock:
            return copy.deepcopy(self._items)

    def save(self,name,controls):
        with self._lock:
            self._items = [item for item in self._items if item["name"].lower()!=name.lower()]
            self._items.append({"name":str(name),"controls":copy.deepcopy(controls)})
            return copy.deepcopy(self._items)
