"""Local-only integration fixture: real sync store + desktop SQLite, fake model."""
import json
import os
from pathlib import Path
import sys
import tempfile
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / "SYNC/sync_server"))
sys.path.insert(0, str(root / "MEMORY/memory_module"))
from store import SyncStore
storage = tempfile.TemporaryDirectory()
os.environ["OPENSTARRY_DATA_DIR"] = storage.name
os.environ["OPENSTARRY_INTEGRATED"] = "1"
from core.domain.mysql_server import MysqlService
memory = MysqlService(host="", port=0, user="", password="", database="")
memory._init_sqlite()
cloud = SyncStore(str(Path(storage.name) / "cloud"))
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Access-Control-Allow-Headers", "*"); self.end_headers()
    def send(self, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.send({"data": [{"id": "fixture-model"}, {"id": "second-model"}]})
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path == "/v1/sync": self.send(cloud.synchronize(data["userId"], data.get("cursor", 0), data.get("operations", [])))
        elif self.path == "/fixture/desktop-apply":
            memory.apply_sync_records("local-user", data["records"]); self.send(memory.export_sync_records("local-user"))
        elif self.path == "/v1/chat/completions":
            if data["model"] == "failure": self.send_error(503); return
            needs_question = data.get("tools") and any("QA 提问测试" in str(msg.get("content", "")) for msg in data["messages"])
            answered = any(msg.get("role") == "tool" for msg in data["messages"])
            if needs_question and not answered:
                arguments = json.dumps({"questions": [{"question": "这个项目优先支持哪个平台？", "options": ["手机与电脑（推荐）", "仅电脑"], "multiselection": False}, {"question": "还有什么需要补充？", "options": [], "multiselection": False, "optional": True}]}, ensure_ascii=False)
                call = {"id": "qa-question-call", "type": "function", "function": {"name": "request_user_input", "arguments": arguments}}
                if not data.get("stream"):
                    self.send({"id": "qa-question", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": "", "tool_calls": [call]}, "finish_reason": "tool_calls"}]}); return
                self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                chunk = {"id": "qa-question", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, **call}]}, "finish_reason": "tool_calls"}]}
                self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\ndata: [DONE]\n\n").encode()); return
            answer = "已收到你的选择，继续制作项目。" if needs_question and answered else "收到：" + str(data["messages"][-1].get("content", ""))
            if not data.get("stream"): self.send({"choices": [{"message": {"content": answer}}]}); return
            self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            for text in [answer[:2], answer[2:]]:
                self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}, ensure_ascii=False) + "\n\n").encode()); self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
        else: self.send_error(404)
if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv)>1 else 8766), Handler)
    print("fixture ready", flush=True)
    server.serve_forever()
