"""Authenticated, single-owner project runner. Put behind HTTPS; Docker is required."""
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IMAGES = {"python": "python:3.12-alpine", "node": "node:22-alpine", "java": "eclipse-temurin:21-jdk"}
JOBS = {}
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(2)


def validate_files(files):
    if not isinstance(files, dict) or len(files) > 1000:
        raise ValueError("Expected up to 1000 text files")
    total = 0
    seen = set()
    for name, content in files.items():
        parts = name.split("/")
        if not name or len(name) > 240 or "\\" in name or ":" in name or any(part in ("", ".", "..") for part in parts) or any(ord(c) < 32 for c in name):
            raise ValueError("Invalid project path")
        if not isinstance(content, str) or "\0" in content:
            raise ValueError("Only text files are supported")
        size = len(content.encode("utf-8"))
        if size > 1024 * 1024:
            raise ValueError("File exceeds 1 MB")
        total += size
        if total > 12 * 1024 * 1024 or name.lower() in seen:
            raise ValueError("Project size or path collision")
        seen.add(name.lower())
    for name in files:
        if any(str(parent).lower() in seen for parent in PurePosixPath(name).parents if str(parent) != "."):
            raise ValueError("File and directory collision")


def docker_command(job_id, folder, image, command):
    return ["docker", "run", "--rm", "--name", "openstarry-ide-" + job_id, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1", "--user=65534:65534", "--tmpfs", "/tmp:rw,nosuid,size=128m", "--mount", f"type=bind,src={folder},dst=/workspace", "--workdir=/workspace", "--env=HOME=/tmp", "--env=PYTHONDONTWRITEBYTECODE=1", IMAGES[image], "sh", "-lc", command]


def stop_job(job_id):
    with LOCK:
        job = JOBS.get(job_id)
        if not job or job["done"]:
            return
        job["cancelled"] = True
        process = job.get("process")
    subprocess.run(["docker", "rm", "-f", "openstarry-ide-" + job_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    if process and process.poll() is None:
        process.kill()


def execute(job_id, files, image, command):
    folder = tempfile.mkdtemp(prefix="openstarry-ide-")
    timer = None
    try:
        os.chmod(folder, 0o777)
        for name, content in files.items():
            target = Path(folder, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            for parent in target.parents:
                if parent == Path(folder).parent:
                    break
                os.chmod(parent, 0o777)
            target.write_text(content, encoding="utf-8")
            os.chmod(target, 0o666)
        with LOCK:
            if JOBS[job_id]["cancelled"]:
                return
            process = subprocess.Popen(docker_command(job_id, folder, image, command), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            JOBS[job_id]["process"] = process
        timer = threading.Timer(60, stop_job, [job_id]); timer.start()
        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            data = process.stdout.read1(4096)
            if not data:
                break
            with LOCK:
                JOBS[job_id]["output"] = (JOBS[job_id]["output"] + decoder.decode(data))[-100000:]
        with LOCK:
            JOBS[job_id]["exitCode"] = process.wait()
    except Exception as error:
        with LOCK:
            JOBS[job_id]["output"] += "\nExecution error: " + str(error)
            JOBS[job_id]["exitCode"] = -1
    finally:
        if timer: timer.cancel()
        with LOCK:
            JOBS[job_id]["done"] = True
            JOBS[job_id]["finished"] = time.time()
            if JOBS[job_id]["cancelled"]:
                JOBS[job_id]["output"] += "\nExecution stopped (cancelled or 60-second limit)."
                JOBS[job_id]["exitCode"] = -1
        shutil.rmtree(folder, ignore_errors=True)
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def authorized(self):
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.origins:
            self.reply(403, {"error": "Origin not allowed"}); return False
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            self.reply(401, {"error": "Authentication required"}); return False
        return True

    def do_OPTIONS(self):
        self.reply(200, {})

    def do_GET(self):
        if self.path == "/health": return self.reply(200, {"service": "openstarry-ide", "version": 1})
        if not self.authorized(): return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9-]{36})", self.path)
        with LOCK:
            job = JOBS.get(match[1]) if match else None
            value = {key: job[key] for key in ["id", "done", "output", "exitCode"]} if job else None
        self.reply(200 if value else 404, value or {"error": "Job not found"})

    def do_POST(self):
        if not self.authorized(): return
        if self.path != "/v1/jobs": return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16 * 1024 * 1024: return self.reply(413, {"error": "Project too large"})
            self.connection.settimeout(20)
            payload = json.loads(self.rfile.read(length))
            files = payload.get("files"); validate_files(files)
            image, command = payload.get("image"), payload.get("command")
            if image not in IMAGES or not isinstance(command, str) or not command.strip() or len(command) > 4000: raise ValueError("Invalid runtime or command")
        except (ValueError, TypeError, AttributeError, TimeoutError) as error:
            return self.reply(400, {"error": str(error)})
        if not SLOTS.acquire(blocking=False): return self.reply(429, {"error": "Two jobs already running"})
        job_id = str(uuid.uuid4())
        with LOCK:
            for key in list(JOBS):
                if JOBS[key].get("finished", float("inf")) < time.time() - 600: del JOBS[key]
            JOBS[job_id] = {"id": job_id, "done": False, "cancelled": False, "output": "", "exitCode": None}
        threading.Thread(target=execute, args=(job_id, files, image, command), daemon=True).start()
        self.reply(202, {"id": job_id})

    def do_DELETE(self):
        if not self.authorized(): return
        match = re.fullmatch(r"/v1/jobs/([a-f0-9-]{36})", self.path)
        if not match: return self.reply(404, {"error": "Not found"})
        stop_job(match[1]); self.reply(200, {"stopped": True})


def main():
    token = os.environ.get("OPENSTARRY_IDE_TOKEN", "")
    if len(token) < 32: raise SystemExit("Set OPENSTARRY_IDE_TOKEN to a random token of at least 32 characters")
    server = ThreadingHTTPServer((os.environ.get("OPENSTARRY_IDE_HOST", "127.0.0.1"), int(os.environ.get("OPENSTARRY_IDE_PORT", "5096"))), Handler)
    server.token = token
    server.origins = set(os.environ.get("OPENSTARRY_IDE_ORIGINS", "https://localhost,http://localhost,capacitor://localhost").split(","))
    server.serve_forever()


if __name__ == "__main__": main()
