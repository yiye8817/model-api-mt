import gzip
import tempfile
import unittest
from unittest.mock import patch

from fusion_agent import web_fetch
from fusion_agent.contracts import ToolError


class WebFetchResilienceTests(unittest.TestCase):
    @staticmethod
    def _valid_url(url):
        return url, "example.com", 443

    def test_retries_transient_http_with_alternate_profile(self):
        with tempfile.TemporaryDirectory() as runtime:
            tool = web_fetch.WebFetchTools(runtime)
            profiles = []

            def fake_get(url, timeout, *, profile=0):
                profiles.append(profile)
                if len(profiles) == 1:
                    return 503, {"content-type": "text/html"}, b"busy", {"address": "1.2.3.4", "profile": profile}
                return 200, {"content-type": "text/html"}, b"<title>ready</title><p>ok</p>", {"address": "1.2.3.4", "profile": profile}

            with patch.object(web_fetch, "validate_url", side_effect=self._valid_url), \
                    patch.object(tool, "_get", side_effect=fake_get), \
                    patch.object(web_fetch.time, "sleep"):
                result = tool.fetch({"url": "https://example.com/", "timeout": 5})

            self.assertEqual(result["http_status"], 200)
            self.assertEqual(result["attempts"], 2)
            self.assertEqual(profiles, [0, 1])
            self.assertEqual(result["text"].splitlines()[-1], "ok")

    def test_retries_network_failure_within_one_timeout_budget(self):
        with tempfile.TemporaryDirectory() as runtime:
            tool = web_fetch.WebFetchTools(runtime)
            calls = []

            def fake_get(url, timeout, *, profile=0):
                calls.append(profile)
                if len(calls) < 3:
                    raise ToolError("page_fetch_failed", "temporary")
                return 200, {"content-type": "text/html", "content-encoding": "gzip"}, gzip.compress(b"<p>decoded</p>"), {"address": "1.2.3.4", "profile": profile}

            with patch.object(web_fetch, "validate_url", side_effect=self._valid_url), \
                    patch.object(tool, "_get", side_effect=fake_get), \
                    patch.object(web_fetch.time, "sleep"):
                result = tool.fetch({"url": "https://example.com/", "timeout": 5})

            self.assertEqual(calls, [0, 1, 2])
            self.assertEqual(result["text"], "decoded")

    def test_exhausted_http_retry_remains_an_explicit_failure(self):
        with tempfile.TemporaryDirectory() as runtime:
            tool = web_fetch.WebFetchTools(runtime)

            with patch.object(web_fetch, "validate_url", side_effect=self._valid_url), \
                    patch.object(tool, "_get", return_value=(403, {"content-type": "text/html"}, b"denied", {"address": "1.2.3.4", "profile": 0})), \
                    patch.object(web_fetch.time, "sleep"):
                with self.assertRaises(ToolError) as raised:
                    tool.fetch({"url": "https://example.com/", "timeout": 5})

            self.assertEqual(raised.exception.code, "page_http_error")
            self.assertEqual(raised.exception.details["http_status"], 403)

    def test_large_text_playlist_is_retained_and_read_in_pages(self):
        # Regression for IPTV M3U files larger than the historical 2 MiB cap.
        with tempfile.TemporaryDirectory() as runtime:
            tool = web_fetch.WebFetchTools(runtime)
            playlist = ("#EXTM3U\n" + "#EXTINF:-1,Example\nhttps://stream.example/live.m3u8\n") * 50000
            self.assertGreater(len(playlist.encode("utf-8")), 2 * 1024 * 1024)
            with patch.object(web_fetch, "validate_url", side_effect=self._valid_url), \
                    patch.object(tool, "_get", return_value=(200, {"content-type": "text/plain"}, playlist.encode(), {"address": "1.2.3.4", "profile": 0})):
                result = tool.fetch({"url": "https://example.com/playlist.m3u", "timeout": 5, "max_chars": 1000})

            self.assertTrue(result["truncated"])
            self.assertGreater(result["total_chars"], 2 * 1024 * 1024)
            following = tool.read({"page_id": result["page_id"], "offset": result["next_offset"], "max_chars": 1000})
            self.assertEqual(following["offset"], result["next_offset"])
            self.assertTrue(following["text"])

    def test_m3u_playlist_mime_type_is_treated_as_text(self):
        with tempfile.TemporaryDirectory() as runtime:
            tool = web_fetch.WebFetchTools(runtime)
            playlist = "#EXTM3U\n#EXTINF:-1,Example\nhttps://stream.example/live.m3u8\n"
            with patch.object(web_fetch, "validate_url", side_effect=self._valid_url), \
                    patch.object(tool, "_get", return_value=(200, {"content-type": "application/vnd.apple.mpegurl"}, playlist.encode(), {"address": "1.2.3.4", "profile": 0})):
                result = tool.fetch({"url": "https://example.com/playlist.m3u8", "timeout": 5})

            self.assertIn("#EXTM3U", result["text"])


if __name__ == "__main__":
    unittest.main()
