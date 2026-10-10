from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import main
from api.frontend import mount_frontend


def built_app(tmp_path):
    (tmp_path / "index.html").write_text("<app-root></app-root>")
    (tmp_path / "main-abc.js").write_text("console.log(1)")
    app = FastAPI()

    @app.get("/api/ping")
    def ping():
        return {"pong": True}

    @app.post("/api/echo")
    def echo(body: dict):
        return body

    assert mount_frontend(app, tmp_path)
    return TestClient(app)


def test_serves_the_angular_build_and_its_routes(tmp_path):
    client = built_app(tmp_path)

    assert client.get("/").text == "<app-root></app-root>"
    assert client.get("/main-abc.js").text == "console.log(1)"
    # A reload on a client-side route gets the app, not a 404.
    assert client.get("/results").text == "<app-root></app-root>"


def test_api_routes_win_and_unknown_api_paths_stay_404(tmp_path):
    client = built_app(tmp_path)

    assert client.get("/api/ping").json() == {"pong": True}
    assert client.post("/api/echo", json={"a": 1}).json() == {"a": 1}
    assert client.get("/api/nope").status_code == 404


def test_nothing_is_mounted_without_a_build(tmp_path):
    assert not mount_frontend(FastAPI(), tmp_path)


def test_health():
    assert TestClient(main.app).get("/api/health").json() == {"status": "ok"}
