# encoding:utf-8
"""
Unit tests for the web_search tool, focused on the AnySearch, Serply and
Keenable backends.

Covers key resolution (config file + environment fallback), the canonical
provider fallback order, result normalization into the unified output shape,
the AnySearch-specific count clamp (the shared tool schema allows 1-50 while
the API accepts 1-10), HTTP and business-level error mapping, and the
anonymous mode contract (no Authorization header without a key), and the
keyless contract of Keenable (always configured; public endpoint plus the
``X-Keenable-Title`` header without a key, ``X-API-Key`` with one).

No real network is used: ``requests.post`` / ``requests.get`` are stubbed
throughout.
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent.tools.web_search import WebSearch
from agent.tools.web_search import web_search as web_search_module


def _fake_response(status_code=200, payload=None):
    """Build a minimal stand-in for a requests Response."""
    resp = MagicMock()
    resp.status_code = status_code
    body = payload if payload is not None else {}
    resp.json = lambda: body
    resp.text = json.dumps(body)
    return resp


def _anysearch_payload(results, total=None, code=0, message="success"):
    """Build an AnySearch /v1/search response body in the documented shape."""
    return {
        "code": code,
        "message": message,
        "request_id": "req-test",
        "data": {
            "results": results,
            "metadata": {"total_results": total if total is not None else len(results)},
        },
    }


class TestAnySearchKeyResolution(unittest.TestCase):
    """The anysearch key lives under tools.web_search, falling back to env."""

    def setUp(self):
        self._prev_env = os.environ.get("ANYSEARCH_API_KEY")
        os.environ.pop("ANYSEARCH_API_KEY", None)

    def tearDown(self):
        if self._prev_env is None:
            os.environ.pop("ANYSEARCH_API_KEY", None)
        else:
            os.environ["ANYSEARCH_API_KEY"] = self._prev_env

    def test_anysearch_key_from_tools_config(self):
        """tools.web_search.anysearch_api_key is resolved, and wins over env."""
        cfg = {"tools": {"web_search": {"anysearch_api_key": "test-key-123"}}}
        with patch.object(web_search_module, "conf", lambda: cfg):
            self.assertEqual(web_search_module._get_api_key("anysearch"), "test-key-123")
            with patch.dict(os.environ, {"ANYSEARCH_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("anysearch"), "test-key-123")

    def test_anysearch_key_env_fallback(self):
        """Without a config value, ANYSEARCH_API_KEY is used; both empty -> ''."""
        with patch.object(web_search_module, "conf", lambda: {}):
            with patch.dict(os.environ, {"ANYSEARCH_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("anysearch"), "env-key-456")
            self.assertEqual(web_search_module._get_api_key("anysearch"), "")


class TestProviderOrder(unittest.TestCase):
    """New providers are appended after the four originals, leaving existing
    routing untouched: anysearch, then serply, then keenable (keyless, so it
    must come after every provider the user may have paid for)."""

    def test_provider_order_appends_new_providers_last(self):
        self.assertEqual(
            web_search_module.PROVIDER_ORDER,
            ("bocha", "qianfan", "zhipu", "linkai", "anysearch", "serply", "keenable"),
        )
        self.assertEqual(web_search_module.KEYLESS_PROVIDERS, ("keenable",))

    def test_web_console_provider_list_stays_in_sync(self):
        """The web console keeps its own copy of the provider order plus the
        set of providers that hold a dedicated key under tools.web_search.
        Both must track the tool module so a new backend shows up in the
        Search panel with the right credential editor."""
        from channel.web.web_channel import ModelsHandler

        self.assertEqual(ModelsHandler._SEARCH_PROVIDERS, web_search_module.PROVIDER_ORDER)
        for pid in web_search_module.PROVIDER_ORDER:
            self.assertIn(pid, ModelsHandler._SEARCH_PROVIDER_LABELS)

        cfg = {"tools": {"web_search": {"serply_api_key": "console-key"}}}
        self.assertEqual(ModelsHandler._search_provider_key("serply", cfg), "console-key")
        with patch.dict(os.environ, {"SERPLY_API_KEY": "env-key"}):
            self.assertEqual(ModelsHandler._search_provider_key("serply", {}), "env-key")
        with patch.dict(os.environ, {"SERPLY_API_KEY": ""}):
            self.assertEqual(ModelsHandler._search_provider_key("serply", {}), "")

        self.assertEqual(ModelsHandler._KEYLESS_SEARCH_PROVIDERS, web_search_module.KEYLESS_PROVIDERS)
        cfg = {"tools": {"web_search": {"keenable_api_key": "console-key"}}}
        self.assertEqual(ModelsHandler._search_provider_key("keenable", cfg), "console-key")
        with patch.dict(os.environ, {"KEENABLE_API_KEY": "env-key"}):
            self.assertEqual(ModelsHandler._search_provider_key("keenable", {}), "env-key")

    def test_web_console_marks_keyless_provider_configured(self):
        """With no credential anywhere the Search panel still shows keenable
        as configured (and as the active backend), so the console agrees
        with the tool about what a fresh install can do."""
        from channel.web.web_channel import ModelsHandler

        env = {k: "" for k in _ALL_SEARCH_ENV}
        with patch.dict(os.environ, env):
            cap = ModelsHandler._search_capability({})
        by_id = {p["id"]: p for p in cap["providers"]}
        self.assertTrue(by_id["keenable"]["configured"])
        self.assertTrue(by_id["keenable"]["needs_dedicated_key"])
        self.assertEqual(by_id["keenable"]["api_key_masked"], "")
        self.assertFalse(by_id["serply"]["configured"])
        self.assertEqual(cap["current_provider"], "keenable")


_ALL_SEARCH_ENV = (
    "BOCHA_API_KEY", "ZHIPUAI_API_KEY", "QIANFAN_API_KEY", "LINKAI_API_KEY",
    "ANYSEARCH_API_KEY", "SERPLY_API_KEY", "KEENABLE_API_KEY",
)


class TestKeylessAvailability(unittest.TestCase):
    """Keenable needs no key, so the tool is registered on a fresh install and
    keenable is what a keyless install resolves to. A configured provider
    still wins because keenable sits last in PROVIDER_ORDER."""

    def test_no_keys_still_configures_keenable(self):
        with patch.object(web_search_module, "conf", lambda: {}), \
                patch.dict(os.environ, {k: "" for k in _ALL_SEARCH_ENV}):
            self.assertEqual(web_search_module.configured_providers(), ["keenable"])
            self.assertTrue(web_search_module.WebSearch.is_available())
            self.assertEqual(web_search_module.WebSearch()._resolve_provider(None), "keenable")

    def test_keyed_provider_wins_over_keenable(self):
        cfg = {"tools": {"web_search": {"serply_api_key": "k"}}}
        with patch.object(web_search_module, "conf", lambda: cfg), \
                patch.dict(os.environ, {k: "" for k in _ALL_SEARCH_ENV}):
            self.assertEqual(web_search_module.configured_providers(), ["serply", "keenable"])
            self.assertEqual(web_search_module.WebSearch()._resolve_provider(None), "serply")
            self.assertEqual(web_search_module.WebSearch()._resolve_provider("keenable"), "keenable")


class TestAnySearchBackend(unittest.TestCase):
    """Behaviour of WebSearch._search_anysearch with a stubbed HTTP layer."""

    def setUp(self):
        self.tool = WebSearch()

    def test_search_anysearch_maps_results(self):
        """Results under data.results map to the unified output shape.

        `total` comes from metadata.total_results; a missing snippet falls
        back to content, truncated to 200 chars. With a key configured, the
        Authorization header is sent.
        """
        long_content = "x" * 300
        payload = _anysearch_payload(
            [
                {"title": "T1", "url": "https://a.example/1", "snippet": "s1", "content": "c1"},
                {"title": "T2", "url": "https://a.example/2", "content": long_content},
            ],
            total=123,
        )
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, payload)) as mock_post:
            result = self.tool._search_anysearch("cowagent", 10)

        self.assertEqual(result.status, "success")
        self.assertEqual(result.result["backend"], "anysearch")
        self.assertEqual(result.result["total"], 123)
        self.assertEqual(result.result["count"], 2)
        first, second = result.result["results"]
        self.assertEqual(first, {"title": "T1", "url": "https://a.example/1", "snippet": "s1"})
        self.assertEqual(second["snippet"], long_content[:200])
        headers = mock_post.call_args[1]["headers"]
        self.assertEqual(headers.get("Authorization"), "Bearer test-key-123")

    def test_search_anysearch_clamps_count(self):
        """count is clamped into AnySearch's documented 1-10 range.

        A falsy count falls back to the default of 10, matching the
        `count or 10` idiom used by the zhipu/qianfan backends (execute()
        already normalizes out-of-range values to 10 before dispatch).
        """
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _anysearch_payload([]))) as mock_post:
            for count, expected in ((50, 10), (0, 10), (None, 10), (10, 10)):
                with self.subTest(count=count):
                    self.tool._search_anysearch("q", count)
                    self.assertEqual(mock_post.call_args[1]["json"]["max_results"], expected)

    def test_search_anysearch_error_status_mapping(self):
        """401/402/429 map to specific messages; other statuses are generic."""
        cases = {
            401: "Invalid AnySearch API key",
            402: "quota exhausted",
            429: "rate limit reached",
            500: "HTTP 500",
        }
        for status_code, fragment in cases.items():
            with self.subTest(status_code=status_code):
                with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                        patch.object(web_search_module.requests, "post",
                                     return_value=_fake_response(status_code)):
                    result = self.tool._search_anysearch("q", 10)
                self.assertEqual(result.status, "error")
                self.assertIn(fragment, result.result)

    def test_search_anysearch_business_error(self):
        """HTTP 200 with a non-zero business code is surfaced as an error."""
        payload = {"code": 40001, "message": "invalid api key", "request_id": "req-test"}
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, payload)):
            result = self.tool._search_anysearch("q", 10)
        self.assertEqual(result.status, "error")
        self.assertIn("code=40001", result.result)
        self.assertIn("invalid api key", result.result)

    def test_search_anysearch_omits_auth_header_without_key(self):
        """Anonymous mode: without a key, no Authorization header is sent."""
        with patch.object(web_search_module, "_get_api_key", return_value=""), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _anysearch_payload([]))) as mock_post:
            result = self.tool._search_anysearch("q", 10)
        self.assertEqual(result.status, "success")
        headers = mock_post.call_args[1]["headers"]
        self.assertNotIn("Authorization", headers)

    def test_search_anysearch_ignores_freshness_with_warning(self):
        """freshness='oneWeek' logs a warning and is not sent in the payload."""
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module, "logger") as mock_logger, \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _anysearch_payload([]))) as mock_post:
            result = self.tool._search_anysearch("q", 10, freshness="oneWeek")

        self.assertEqual(result.status, "success")
        mock_logger.warning.assert_called_once_with(
            "[WebSearch] anysearch does not support freshness ('oneWeek'); ignoring"
        )
        sent = mock_post.call_args[1]["json"]
        self.assertNotIn("freshness", sent)
        self.assertEqual(sent, {"query": "q", "max_results": 10, "format": "json"})

    def test_search_anysearch_ignores_summary_with_warning(self):
        """summary=True logs a warning; the request payload keeps its plain shape."""
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module, "logger") as mock_logger, \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _anysearch_payload([]))) as mock_post:
            result = self.tool._search_anysearch("q", 10, summary=True)

        self.assertEqual(result.status, "success")
        mock_logger.warning.assert_called_once_with(
            "[WebSearch] anysearch does not support summary; ignoring"
        )
        self.assertNotIn("summary", mock_post.call_args[1]["json"])


def _serply_payload(results):
    """Build a Serply /v1/search response body in the documented shape."""
    return {"results": results, "ads": [], "related_questions": []}


class TestSerplyKeyResolution(unittest.TestCase):
    """The serply key lives under tools.web_search, falling back to env."""

    def setUp(self):
        self._prev_env = os.environ.get("SERPLY_API_KEY")
        os.environ.pop("SERPLY_API_KEY", None)

    def tearDown(self):
        if self._prev_env is None:
            os.environ.pop("SERPLY_API_KEY", None)
        else:
            os.environ["SERPLY_API_KEY"] = self._prev_env

    def test_serply_key_from_tools_config(self):
        """tools.web_search.serply_api_key is resolved, and wins over env."""
        cfg = {"tools": {"web_search": {"serply_api_key": "test-key-123"}}}
        with patch.object(web_search_module, "conf", lambda: cfg):
            self.assertEqual(web_search_module._get_api_key("serply"), "test-key-123")
            with patch.dict(os.environ, {"SERPLY_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("serply"), "test-key-123")

    def test_serply_key_env_fallback(self):
        """Without a config value, SERPLY_API_KEY is used; both empty -> ''."""
        with patch.object(web_search_module, "conf", lambda: {}):
            with patch.dict(os.environ, {"SERPLY_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("serply"), "env-key-456")
            self.assertEqual(web_search_module._get_api_key("serply"), "")


class TestSerplyBackend(unittest.TestCase):
    """Behaviour of WebSearch._search_serply with a stubbed HTTP layer."""

    def setUp(self):
        self.tool = web_search_module.WebSearch()

    def test_search_serply_maps_results(self):
        """Serply's title/link/description map to title/url/snippet, and the
        key travels in the X-Api-Key header alongside an explicit User-Agent."""
        payload = _serply_payload([
            {"title": "T1", "link": "https://a.example/1", "description": "s1"},
            {"title": "T2", "link": "https://a.example/2"},
        ])
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "get",
                             return_value=_fake_response(200, payload)) as mock_get:
            result = self.tool._search_serply("cowagent", 10)

        self.assertEqual(result.status, "success")
        self.assertEqual(result.result["backend"], "serply")
        self.assertEqual(result.result["total"], 2)
        self.assertEqual(result.result["count"], 2)
        first, second = result.result["results"]
        self.assertEqual(first, {"title": "T1", "url": "https://a.example/1", "snippet": "s1"})
        self.assertEqual(second, {"title": "T2", "url": "https://a.example/2", "snippet": ""})
        headers = mock_get.call_args[1]["headers"]
        self.assertEqual(headers.get("X-Api-Key"), "test-key-123")
        self.assertTrue(headers.get("User-Agent"))

    def test_search_serply_clamps_count(self):
        """count is clamped into 1-50 and sent as the `num` query parameter;
        a falsy count falls back to the default of 10."""
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "get",
                             return_value=_fake_response(200, _serply_payload([]))) as mock_get:
            for count, expected in ((50, 50), (99, 50), (0, 10), (None, 10), (10, 10)):
                with self.subTest(count=count):
                    self.tool._search_serply("q", count)
                    url = mock_get.call_args[0][0]
                    self.assertIn(f"num={expected}", url)
                    self.assertIn("q=q", url)

    def test_search_serply_error_status_mapping(self):
        """401/429 map to specific messages; other statuses are generic."""
        cases = {
            401: "Invalid Serply API key",
            429: "rate limit reached",
            500: "HTTP 500",
        }
        for status_code, fragment in cases.items():
            with self.subTest(status_code=status_code):
                with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                        patch.object(web_search_module.requests, "get",
                                     return_value=_fake_response(status_code)):
                    result = self.tool._search_serply("q", 10)
                self.assertEqual(result.status, "error")
                self.assertIn(fragment, result.result)


def _keenable_payload(results):
    """Build a Keenable /v1/search response body in the documented shape."""
    return {"query": "q", "results": results}


class TestKeenableKeyResolution(unittest.TestCase):
    """The keenable key lives under tools.web_search, falling back to env."""

    def setUp(self):
        self._prev_env = os.environ.get("KEENABLE_API_KEY")
        os.environ.pop("KEENABLE_API_KEY", None)

    def tearDown(self):
        if self._prev_env is None:
            os.environ.pop("KEENABLE_API_KEY", None)
        else:
            os.environ["KEENABLE_API_KEY"] = self._prev_env

    def test_keenable_key_from_tools_config(self):
        """tools.web_search.keenable_api_key is resolved, and wins over env."""
        cfg = {"tools": {"web_search": {"keenable_api_key": "test-key-123"}}}
        with patch.object(web_search_module, "conf", lambda: cfg):
            self.assertEqual(web_search_module._get_api_key("keenable"), "test-key-123")
            with patch.dict(os.environ, {"KEENABLE_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("keenable"), "test-key-123")

    def test_keenable_key_env_fallback(self):
        """Without a config value, KEENABLE_API_KEY is used; both empty -> ''."""
        with patch.object(web_search_module, "conf", lambda: {}):
            with patch.dict(os.environ, {"KEENABLE_API_KEY": "env-key-456"}):
                self.assertEqual(web_search_module._get_api_key("keenable"), "env-key-456")
            self.assertEqual(web_search_module._get_api_key("keenable"), "")


class TestKeenableBackend(unittest.TestCase):
    """Behaviour of WebSearch._search_keenable with a stubbed HTTP layer."""

    def setUp(self):
        self.tool = web_search_module.WebSearch()

    def test_search_keenable_keyless_uses_public_endpoint(self):
        """Without a key the public endpoint is called with the app title
        header and no X-API-Key; `snippet` maps to snippet, falling back to
        `description`, and `published_at` to datePublished."""
        payload = _keenable_payload([
            {"title": "T1", "url": "https://a.example/1", "snippet": "s1", "description": "",
             "published_at": "2026-08-07T09:56:16Z"},
            {"title": "T2", "url": "https://a.example/2", "snippet": "", "description": "d2"},
        ])
        with patch.object(web_search_module, "_get_api_key", return_value=""), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, payload)) as mock_post:
            result = self.tool._search_keenable("cowagent", 10, "noLimit", False)

        self.assertEqual(result.status, "success")
        self.assertEqual(result.result["backend"], "keenable")
        self.assertEqual(result.result["total"], 2)
        self.assertEqual(result.result["count"], 2)
        first, second = result.result["results"]
        self.assertEqual(first, {"title": "T1", "url": "https://a.example/1", "snippet": "s1",
                                 "datePublished": "2026-08-07T09:56:16Z"})
        self.assertEqual(second["snippet"], "d2")
        self.assertEqual(second["datePublished"], "")

        self.assertEqual(mock_post.call_args[0][0], "https://api.keenable.ai/v1/search/public")
        headers = mock_post.call_args[1]["headers"]
        self.assertEqual(headers.get("X-Keenable-Title"), "cowagent")
        self.assertNotIn("X-API-Key", headers)
        body = mock_post.call_args[1]["json"]
        self.assertEqual(body["query"], "cowagent")
        self.assertEqual(body["max_results"], 10)
        self.assertEqual(body["snippet_max_length"], 300)
        self.assertNotIn("published_after", body)

    def test_search_keenable_keyed_uses_authenticated_endpoint(self):
        """With a key the authenticated endpoint is called with X-API-Key; the
        app title header is still sent. summary=True asks for longer snippets."""
        with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _keenable_payload([]))) as mock_post:
            result = self.tool._search_keenable("q", 10, "noLimit", True)

        self.assertEqual(result.status, "success")
        self.assertEqual(mock_post.call_args[0][0], "https://api.keenable.ai/v1/search")
        headers = mock_post.call_args[1]["headers"]
        self.assertEqual(headers.get("X-API-Key"), "test-key-123")
        self.assertEqual(headers.get("X-Keenable-Title"), "cowagent")
        self.assertEqual(mock_post.call_args[1]["json"]["snippet_max_length"], 1000)

    def test_search_keenable_clamps_count(self):
        """count is clamped into 1-50 and sent as max_results; a falsy count
        falls back to the default of 10."""
        with patch.object(web_search_module, "_get_api_key", return_value=""), \
                patch.object(web_search_module.requests, "post",
                             return_value=_fake_response(200, _keenable_payload([]))) as mock_post:
            for count, expected in ((50, 50), (99, 50), (0, 10), (None, 10), (10, 10)):
                with self.subTest(count=count):
                    self.tool._search_keenable("q", count, "noLimit", False)
                    self.assertEqual(mock_post.call_args[1]["json"]["max_results"], expected)

    def test_search_keenable_freshness_filter(self):
        """Named tokens become published_after; a date range becomes
        published_after + published_before; anything else sends no filter."""
        build = web_search_module.WebSearch._keenable_build_freshness_filter
        self.assertEqual(build("noLimit"), {})
        self.assertEqual(build(""), {})
        self.assertEqual(build("someday"), {})
        self.assertEqual(
            build("2025-01-01..2025-02-01"),
            {"published_after": "2025-01-01", "published_before": "2025-02-01"},
        )
        week = build("oneWeek")
        self.assertEqual(list(week), ["published_after"])
        from datetime import datetime, timedelta
        self.assertEqual(week["published_after"], (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d"))

    def test_search_keenable_error_status_mapping(self):
        """401/429 map to specific messages; other statuses are generic. A
        keyless 429 points at the optional key, a keyed one does not."""
        cases = {
            401: "Invalid Keenable API key",
            429: "rate limit reached",
            500: "HTTP 500",
        }
        for status_code, fragment in cases.items():
            with self.subTest(status_code=status_code):
                with patch.object(web_search_module, "_get_api_key", return_value="test-key-123"), \
                        patch.object(web_search_module.requests, "post",
                                     return_value=_fake_response(status_code)):
                    result = self.tool._search_keenable("q", 10, "noLimit", False)
                self.assertEqual(result.status, "error")
                self.assertIn(fragment, result.result)
                self.assertNotIn("KEENABLE_API_KEY", result.result)

        with patch.object(web_search_module, "_get_api_key", return_value=""), \
                patch.object(web_search_module.requests, "post", return_value=_fake_response(429)):
            result = self.tool._search_keenable("q", 10, "noLimit", False)
        self.assertEqual(result.status, "error")
        self.assertIn("rate limit reached", result.result)
        self.assertIn("KEENABLE_API_KEY", result.result)


if __name__ == "__main__":
    unittest.main()
