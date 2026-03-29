import time
import hashlib

class AuditLog:
    def __init__(self):
        self.chain = []

    def log(self, data):
        prev_hash = self.chain[-1]["hash"] if self.chain else "GENESIS"
        ts = time.time()
        raw = f"{prev_hash}{data}{ts}".encode()
        h = hashlib.sha256(raw).hexdigest()
        block = {"prev": prev_hash, "data": data, "ts": ts, "hash": h}
        self.chain.append(block)
        return block
