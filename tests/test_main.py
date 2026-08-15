import threading
import time

import pytest

import main


@pytest.fixture(autouse=True)
def reset_state():
    with main.state_lock:
        main.requests_state.clear()
        main.next_request_id = 1


@pytest.fixture()
def client():
    main.app.config.update(TESTING=True)
    with main.app.test_client() as c:
        yield c


def wait_for_request(client, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        items = client.get("/api/status").get_json()["requests"]
        if items:
            return items[0]["request_id"]
        time.sleep(0.02)
    raise AssertionError("no request appeared")


def make_pending_request(client, extra=None):
    result = {}
    body = {"model": "me", "messages": [{"role": "user", "content": "hi"}]}
    if extra:
        body.update(extra)

    def worker():
        with main.app.test_client() as c, c.post("/v1/chat/completions", json=body) as resp:
            result["status"] = resp.status_code
            result["body"] = resp.get_json()
            result["raw"] = resp.get_data(as_text=True)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    rid = wait_for_request(client)
    return thread, rid, result


def test_index_renders(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"HumanAI Model Interface" in resp.data


def test_status_includes_instance_id(client):
    body = client.get("/api/status").get_json()
    assert "instance_id" in body
    assert body["instance_id"] == main.SERVER_INSTANCE_ID
    assert body["requests"] == []


def test_text_roundtrip(client):
    thread, rid, result = make_pending_request(client)
    try:
        resp = client.post(
            "/api/respond", json={"request_id": rid, "response_type": "text", "response": "hello world"}
        )
        assert resp.status_code == 200
    finally:
        thread.join(timeout=5)

    assert result["status"] == 200
    body = result["body"]
    assert body["choices"][0]["message"]["content"] == "hello world"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert "tool_calls" not in body["choices"][0]["message"]
    assert body["usage"]["completion_tokens"] == 2
    assert body["usage"]["prompt_tokens"] == 1
    assert body["usage"]["total_tokens"] == 3


def test_tool_calls_roundtrip(client):
    thread, rid, result = make_pending_request(client)
    try:
        resp = client.post(
            "/api/respond",
            json={
                "request_id": rid,
                "response_type": "tool_calls",
                "tool_calls": [
                    {"id": "call_1", "function": {"name": "ping", "arguments": '{"x": 1}'}}
                ],
            },
        )
        assert resp.status_code == 200
    finally:
        thread.join(timeout=5)

    assert result["status"] == 200
    message = result["body"]["choices"][0]["message"]
    assert message["content"] is None
    assert message["tool_calls"][0]["function"]["name"] == "ping"
    assert result["body"]["choices"][0]["finish_reason"] == "tool_calls"


def test_streaming_roundtrip(client):
    thread, rid, result = make_pending_request(client, extra={"stream": True})
    try:
        resp = client.post(
            "/api/respond", json={"request_id": rid, "response_type": "text", "response": "hi"}
        )
        assert resp.status_code == 200
    finally:
        thread.join(timeout=5)

    assert result["status"] == 200
    assert "data: [DONE]" in result["raw"]
    assert "chat.completion.chunk" in result["raw"]


def test_bad_request_body_rejected(client):
    resp = client.post("/v1/chat/completions", json=["not", "an", "object"])
    assert resp.status_code == 400

    resp = client.post("/api/respond", json=["not", "an", "object"])
    assert resp.status_code == 400


def test_respond_missing_request_id(client):
    resp = client.post("/api/respond", json={"response_type": "text", "response": "hi"})
    assert resp.status_code == 400


def test_respond_unknown_request(client):
    resp = client.post("/api/respond", json={"request_id": 999, "response_type": "text", "response": "hi"})
    assert resp.status_code == 400


def test_respond_invalid_response_type(client):
    thread, rid, _ = make_pending_request(client)
    try:
        resp = client.post(
            "/api/respond", json={"request_id": rid, "response_type": "bogus", "response": "hi"}
        )
        assert resp.status_code == 400
        resp = client.post(
            "/api/respond",
            json={"request_id": rid, "response_type": "tool_calls", "tool_calls": "not-a-list"},
        )
        assert resp.status_code == 400
    finally:
        client.post(
            "/api/respond", json={"request_id": rid, "response_type": "text", "response": "cleanup"}
        )
        thread.join(timeout=5)


def test_double_respond_rejected(client):
    thread, rid, _ = make_pending_request(client)
    try:
        resp = client.post(
            "/api/respond", json={"request_id": rid, "response_type": "text", "response": "first"}
        )
        assert resp.status_code == 200
        resp = client.post(
            "/api/respond", json={"request_id": rid, "response_type": "text", "response": "second"}
        )
        assert resp.status_code == 400
        assert "already answered" in resp.get_json()["error"]
    finally:
        thread.join(timeout=5)


def test_timeout_returns_504(client, monkeypatch):
    monkeypatch.setattr(main, "REQUEST_TIMEOUT", 0.05)
    resp = client.post(
        "/v1/chat/completions", json={"model": "me", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert resp.status_code == 504
    assert resp.get_json()["error"]["type"] == "timeout"
    assert client.get("/api/status").get_json()["requests"] == []


def test_respond_wins_timeout_race(client, monkeypatch):
    monkeypatch.setattr(main, "REQUEST_TIMEOUT", 0.3)
    result = {}

    def worker():
        with main.app.test_client() as c, c.post(
            "/v1/chat/completions",
            json={"model": "me", "messages": [{"role": "user", "content": "hi"}]},
        ) as resp:
            result["status"] = resp.status_code
            result["body"] = resp.get_json()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    rid = wait_for_request(client)
    time.sleep(0.1)
    resp = client.post(
        "/api/respond", json={"request_id": rid, "response_type": "text", "response": "just in time"}
    )
    assert resp.status_code == 200
    thread.join(timeout=5)
    assert result["status"] == 200
    assert result["body"]["choices"][0]["message"]["content"] == "just in time"


def test_build_message_normalizes_tool_calls():
    msg = main.build_message(
        "tool_calls",
        "",
        [
            {"function": {"name": "ping", "arguments": None}},
            {"function": {"name": "pong", "arguments": {"x": 1}}},
            {"id": "fixed", "function": {"name": "pong", "arguments": "{}"}},
        ],
    )
    calls = msg["tool_calls"]
    assert calls[0]["function"]["arguments"] == "{}"
    assert calls[0]["id"].startswith("call_")
    assert calls[1]["function"]["arguments"] == '{"x": 1}'
    assert calls[2]["id"] == "fixed"
    assert msg["content"] is None


def test_build_message_text_omits_tool_calls():
    msg = main.build_message("text", "plain reply", [])
    assert msg == {"role": "assistant", "content": "plain reply"}
