import json
import threading
import time
import uuid
from dataclasses import dataclass, field

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

app = Flask(__name__)

REQUEST_TIMEOUT = 300.0


@dataclass
class RequestEntry:
    request: dict
    stream: bool
    response_type: str = "text"
    response_text: str = ""
    response_tool_calls: list = field(default_factory=list)
    responded: bool = False
    event: threading.Event = field(default_factory=threading.Event)
    created: int = field(default_factory=lambda: int(time.time()))


state_lock = threading.Lock()
requests_state: dict[int, RequestEntry] = {}
next_request_id = 1
SERVER_INSTANCE_ID = uuid.uuid4().hex


def estimate_tokens(text) -> int:
    if not text:
        return 0
    return len(str(text).split())


def estimate_messages_tokens(messages) -> int:
    total = 0
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        content = m.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    total += estimate_tokens(part.get("text"))
        for tc in m.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function")
            if isinstance(fn, dict):
                total += estimate_tokens(fn.get("name"))
                total += estimate_tokens(fn.get("arguments"))
    return total


def normalize_tool_call_arguments(arguments) -> str:
    if isinstance(arguments, str):
        return arguments
    if isinstance(arguments, dict):
        return json.dumps(arguments)
    if arguments is None:
        return "{}"
    return json.dumps(arguments)


def build_message(response_type: str, response_text: str, response_tool_calls: list) -> dict:
    msg = {"role": "assistant"}
    if response_type == "tool_calls" and response_tool_calls:
        msg["tool_calls"] = []
        for tc in response_tool_calls:
            tc_id = tc.get("id")
            if not isinstance(tc_id, str) or not tc_id:
                tc_id = "call_" + uuid.uuid4().hex
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            msg["tool_calls"].append(
                {
                    "id": tc_id,
                    "type": "function",
                    "function": {
                        "name": str(fn.get("name", "")),
                        "arguments": normalize_tool_call_arguments(fn.get("arguments", "{}")),
                    },
                }
            )
        msg["content"] = None
    else:
        msg["content"] = response_text
    return msg


def build_finish_reason(response_type: str, response_tool_calls: list) -> str:
    if response_type == "tool_calls" and response_tool_calls:
        return "tool_calls"
    return "stop"


def completion_token_count(response_type: str, response_text: str, response_tool_calls: list) -> int:
    if response_type == "tool_calls":
        return sum(
            estimate_tokens(tc.get("function", {}).get("arguments")) for tc in response_tool_calls
        )
    return estimate_tokens(response_text)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status", methods=["GET"])
def get_status():
    with state_lock:
        items = [
            {"request_id": rid, "request": entry.request}
            for rid, entry in sorted(requests_state.items())
        ]
        return jsonify({"instance_id": SERVER_INSTANCE_ID, "requests": items})


@app.route("/api/respond", methods=["POST"])
def respond():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    request_id = data.get("request_id")
    if request_id is None:
        return jsonify({"error": "Missing request_id"}), 400

    response_type = data.get("response_type", "text")
    if response_type not in ("text", "tool_calls"):
        return jsonify({"error": "Invalid response_type; must be 'text' or 'tool_calls'"}), 400

    with state_lock:
        entry = requests_state.get(request_id)
        if entry is None:
            return jsonify({"error": "No pending request with id " + str(request_id)}), 400
        if entry.responded:
            return jsonify({"error": "Request already answered"}), 400
        entry.response_type = response_type
        if response_type == "tool_calls":
            tool_calls = data.get("tool_calls", [])
            if not isinstance(tool_calls, list):
                return jsonify({"error": "tool_calls must be a list"}), 400
            entry.response_tool_calls = tool_calls
            entry.response_text = ""
        else:
            response_text = data.get("response")
            entry.response_text = response_text if isinstance(response_text, str) else str(response_text or "")
            entry.response_tool_calls = []
        entry.responded = True
        event = entry.event
    event.set()
    return jsonify({"success": True})


@app.route("/v1/chat/completions", methods=["POST"])
def chat_completions():
    global next_request_id
    req_json = request.get_json(silent=True)
    if not isinstance(req_json, dict):
        return (
            jsonify({"error": {"message": "Request body must be a JSON object", "type": "invalid_request_error"}}),
            400,
        )

    with state_lock:
        request_id = next_request_id
        next_request_id += 1
        entry = RequestEntry(request=req_json, stream=req_json.get("stream", False))
        requests_state[request_id] = entry
        event = entry.event

    waited = event.wait(timeout=REQUEST_TIMEOUT)

    with state_lock:
        entry = requests_state.get(request_id)
        if entry is None:
            return jsonify({"error": {"message": "Request no longer available", "type": "server_error"}}), 500
        if not waited and not entry.responded:
            del requests_state[request_id]
            return (
                jsonify(
                    {
                        "error": {
                            "message": "Request timed out waiting for human response",
                            "type": "timeout",
                        }
                    }
                ),
                504,
            )
        model = req_json.get("model", "mock-model")
        response_type = entry.response_type
        response_text = entry.response_text
        response_tool_calls = entry.response_tool_calls
        stream = entry.stream
        del requests_state[request_id]

    completion_id = "chatcmpl-mock-" + str(int(time.time())) + "-" + str(request_id)
    created = int(time.time())
    message = build_message(response_type, response_text, response_tool_calls)
    finish_reason = build_finish_reason(response_type, response_tool_calls)

    if stream:

        def generate():
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": message.get("content"),
                            "tool_calls": message.get("tool_calls"),
                        },
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(chunk)}\n\n"

            end_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            }
            yield f"data: {json.dumps(end_chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return Response(stream_with_context(generate()), mimetype="text/event-stream")

    prompt_tokens = estimate_messages_tokens(req_json.get("messages"))
    completion_tokens = completion_token_count(response_type, response_text, response_tool_calls)
    response_payload = {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }

    return jsonify(response_payload)


if __name__ == "__main__":
    print("=" * 60)
    print("HumanAI Mock OpenAI API started!")
    print("1. Open http://localhost:5000 in your browser to act as the model.")
    print("2. Point your agent CLI base URL to: http://localhost:5000/v1")
    print("=" * 60)
    app.run(port=5000, threaded=True, debug=False)
