from __future__ import annotations
import ctypes, errno, json, os, secrets, tempfile, threading, time, uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
if os.name == "nt": import msvcrt
else: import fcntl

def alive(pid: int) -> bool | None:
    if pid == os.getpid(): return True
    if os.name == "nt":
        kernel32=ctypes.windll.kernel32
        handle=kernel32.OpenProcess(0x1000,False,pid)
        if not handle: return False if kernel32.GetLastError()==87 else None
        try:
            code=ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle,ctypes.byref(code)): return None
            return code.value==259
        finally: kernel32.CloseHandle(handle)
    try: os.kill(pid,0); return True
    except ProcessLookupError: return False
    except (PermissionError,OSError): return None

@dataclass(frozen=True, slots=True)
class QueueLease:
    """Per-slot proof accepted by Forge's held-handoff endpoint."""

    ticket_name: str
    nonce: str

class SharedGenerationQueue:
    """Exact ticket/file-lock protocol used by the current two Forge instances."""
    def __init__(self, instance, enabled=True, directory="", poll=0.25, stale=21600):
        self.instance,self.enabled=instance,enabled
        self.dir=Path(directory) if directory else Path(tempfile.gettempdir()) / "forge_shared_generation_queue"
        self.lock=self.dir/"generation.lock"; self.poll=max(.05,poll); self.stale=max(60,stale)
    @contextmanager
    def slot(self, status=None, cancel_check=None):
        if cancel_check: cancel_check()
        if not self.enabled: yield None; return
        self.dir.mkdir(parents=True,exist_ok=True); nonce=secrets.token_urlsafe(32); ticket=self._ticket(nonce); fd=None; started=time.monotonic(); last=0
        try:
            while True:
                if cancel_check: cancel_check()
                self._touch(ticket); self._clean(ticket); tickets=self._tickets(); position=tickets.index(ticket)+1 if ticket in tickets else 1
                if position == 1:
                    fd=self._try_lock()
                    if fd is not None:
                        if cancel_check: cancel_check()
                        if status: status("Shared Forge/Ollama GPU queue acquired")
                        yield QueueLease(ticket.name,nonce); return
                if status and time.monotonic()-last >= 1:
                    ahead=max(position-1,0); status(f"Waiting for shared GPU queue — {ahead} job{'s' if ahead != 1 else ''} ahead, {int(time.monotonic()-started)}s") ; last=time.monotonic()
                time.sleep(self.poll)
        finally:
            if fd is not None: self._unlock(fd)
            self._rm(ticket)
    def status(self):
        """Return a read-only, secret-free snapshot of the shared GPU FIFO."""
        if not self.enabled: return {"enabled":False,"count":0,"entries":[]}
        now=time.time(); records=[(item["worker"],item["created"]) for item in self.ticket_entries()]
        entries=[{
            "position":position,
            "worker":worker,
            "head":position==1,
            "age_seconds":max(0,int(now-created)),
        } for position,(worker,created) in enumerate(records,start=1)]
        return {"enabled":True,"count":len(entries),"entries":entries}

    def ticket_entries(self, *, exclude_ticket_name: str | None = None) -> list[dict]:
        """Return safe ticket metadata for scheduler coordination."""
        if not self.enabled: return []
        now=time.time(); records=[]
        for ticket in self._tickets():
            if ticket.name == exclude_ticket_name: continue
            try:
                stat=ticket.stat(); payload=json.loads(ticket.read_text(encoding="utf-8"))
                pid=int(payload.get("pid") or 0); created=float(payload.get("created") or stat.st_mtime)
                if now-stat.st_mtime>self.stale or (pid and alive(pid) is False): continue
                instance=str(payload.get("instance") or "")
                records.append({
                    "ticket_name":ticket.name,
                    "instance":instance,
                    "worker":self._public_worker_name(instance),
                    "created":created,
                })
            except (OSError,ValueError,TypeError,json.JSONDecodeError):
                # Status polling is strictly read-only. A partially written
                # ticket can be retried by the next dashboard refresh.
                continue
        return records

    def has_non_discord_ticket(self, *, exclude_ticket_name: str | None = None) -> bool:
        """Whether another shared worker is waiting while Discord is warm."""
        allowed=self.instance.strip().casefold()
        return any(
            item["instance"].strip().casefold() != allowed
            for item in self.ticket_entries(exclude_ticket_name=exclude_ticket_name)
        )
    @staticmethod
    def _public_worker_name(instance):
        normalized=instance.strip().lower()
        if "krea2-vision-studio" in normalized: return "KREA2 Vision Studio"
        if "krea2-vision" in normalized: return "Discord KREA2 Vision"
        if "babegen-prompt-assistant" in normalized: return "Prompt Assistant"
        if "kreaforge-7862" in normalized: return "Krea Forge 7862"
        if "kreaforge-7861" in normalized: return "BabeGen Forge 7861"
        if "sd-webui" in normalized or "forge" in normalized: return "BabeGen Forge 7861"
        return "Local GPU worker"
    def _ticket(self, nonce):
        path=self.dir/f"{time.time_ns()}_{os.getpid()}_{threading.get_ident()}_{uuid.uuid4().hex}_{self.instance}.ticket"
        path.write_text(json.dumps({"instance":self.instance,"pid":os.getpid(),"thread":threading.get_ident(),"created":time.time(),"handoff_nonce":nonce}),encoding="utf-8"); return path
    def _tickets(self): return sorted(self.dir.glob("*.ticket"),key=lambda item:item.name)
    def _clean(self, own):
        now=time.time()
        for item in self._tickets():
            if item==own: continue
            try:
                parts=item.name.split("_",4); pid=int(parts[1]) if len(parts)>1 else 0
                if now-item.stat().st_mtime>self.stale or (pid and alive(pid) is False): self._rm(item)
            except (OSError,ValueError): self._rm(item)
    @staticmethod
    def _touch(path):
        try: os.utime(path,None)
        except OSError: pass
    @staticmethod
    def _rm(path):
        try: path.unlink()
        except OSError: pass
    def _try_lock(self):
        fd=os.open(str(self.lock),os.O_CREAT|os.O_RDWR)
        try:
            os.lseek(fd,0,os.SEEK_SET); os.write(fd,b"0"); os.lseek(fd,0,os.SEEK_SET)
            if os.name=="nt": msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
            else: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return fd
        except OSError as exc:
            os.close(fd)
            if exc.errno in (errno.EACCES,errno.EAGAIN,errno.EDEADLK,13,11): return None
            raise
    @staticmethod
    def _unlock(fd):
        try:
            os.lseek(fd,0,os.SEEK_SET)
            if os.name=="nt": msvcrt.locking(fd,msvcrt.LK_UNLCK,1)
            else: fcntl.flock(fd,fcntl.LOCK_UN)
        finally: os.close(fd)
